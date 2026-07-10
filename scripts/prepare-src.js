#!/usr/bin/env node
/**
 * Pre-build: Repack patched ASAR, install the official Codex runtime, assemble for forge.
 *
 * Flow:
 *   1. Repack _asar/ -> app.asar (with patches applied)
 *   2. Install every official Codex runtime asset
 *   3. Copy everything to src/ for forge (app.asar + unpacked + resources)
 *
 * For Linux: strip macOS-only resources and add the official Linux runtime
 *
 * Usage:
 *   node scripts/prepare-src.js --platform mac-arm64
 *   node scripts/prepare-src.js --platform linux-x64
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  getPinnedCodexVersion,
  resolveCodexRuntime,
  installCodexRuntime,
  verifyCodexBinary,
} = require("./codex-vendor");
const {
  WINDOWS_SHORT_UNPACKED_NATIVE_FILES,
  toNativePath,
} = require("./windows-native-relocation");

const SRC = path.join(__dirname, "..", "src");
const PROJECT_ROOT = path.join(__dirname, "..");

// macOS-only resources to strip for Linux
const MACOS_STRIP = new Set([
  "codex_chronicle", "node", "node_repl",
  "electron.icns", "Assets.car",
  "codexTemplate.png", "codexTemplate@2x.png",
]);
const MACOS_STRIP_DIRS = new Set(["native"]);
const WINDOWS_ASAR_UNPACK_DIRS = [
  "node_modules/better-sqlite3",
  "node_modules/node-pty",
];

function copyRecursive(src, dest, skipFiles, skipDirs) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipDirs?.has(e.name)) continue;
    if (skipFiles?.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d, skipFiles, skipDirs); }
    else if (e.isSymbolicLink()) { /* skip */ }
    else { fs.copyFileSync(s, d); count++; }
  }
  return count;
}

function ensureWindowsExtraResources(sourceDir) {
  const requiredUnpacked = path.join(sourceDir, "app.asar.unpacked");
  if (fs.existsSync(requiredUnpacked)) return;

  const cachedResources = path.join(require("os").tmpdir(), "codex-sync", "win-extract", "app", "resources");
  if (fs.existsSync(cachedResources)) {
    let restored = 0;
    for (const entry of fs.readdirSync(cachedResources, { withFileTypes: true })) {
      if (entry.name === "app.asar" || entry.name.endsWith(".lproj")) continue;
      const srcPath = path.join(cachedResources, entry.name);
      const destPath = path.join(sourceDir, entry.name);
      if (fs.existsSync(destPath)) continue;
      if (entry.isDirectory()) restored += copyRecursive(srcPath, destPath);
      else if (!entry.isSymbolicLink()) {
        fs.copyFileSync(srcPath, destPath);
        restored++;
      }
    }
    if (restored > 0) {
      console.log(`   [win] restored ${restored} missing resource files from MSIX cache`);
    }
  }

  if (!fs.existsSync(requiredUnpacked)) {
    console.error("[x] Windows resources are incomplete. Run sync-upstream.js --force --skip-mac before building the installer.");
    process.exit(1);
  }
}

function decodedUnpackedSegment(name) {
  return name.replace(/%40/gi, "@");
}

function copyUnpackedFilesIntoAsarSource(sourceDir, asarContentDir) {
  const unpackedDir = path.join(sourceDir, "app.asar.unpacked");
  if (!fs.existsSync(unpackedDir)) return 0;

  let copied = 0;
  const visit = (srcDir, relativeDir = "") => {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, entry.name);
      const decodedName = decodedUnpackedSegment(entry.name);
      const relativePath = relativeDir ? path.join(relativeDir, decodedName) : decodedName;
      const destPath = path.join(asarContentDir, relativePath);

      if (entry.isDirectory()) {
        visit(srcPath, relativePath);
      } else if (!entry.isSymbolicLink()) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
        copied++;
      }
    }
  };

  visit(unpackedDir);
  return copied;
}

function copyWindowsShortUnpackedNativeFiles(asarContentDir, unpackedDir) {
  let copied = 0;
  for (const entry of WINDOWS_SHORT_UNPACKED_NATIVE_FILES) {
    const source = path.join(asarContentDir, toNativePath(entry.source));
    if (!fs.existsSync(source)) {
      console.log(`   [win] optional native file not found for short unpack: ${entry.source}`);
      continue;
    }

    const dest = path.join(unpackedDir, toNativePath(entry.dest));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    copied++;
  }
  return copied;
}

function packAsar(asarContentDir, repackedAsar, platform) {
  const asarCli = path.join(PROJECT_ROOT, "node_modules", "@electron", "asar", "bin", "asar.mjs");
  const args = [asarCli, "pack"];
  let unpackedDir = null;

  if (platform === "win") {
    unpackedDir = path.join(path.dirname(repackedAsar), "app.asar.unpacked");
    const copied = copyUnpackedFilesIntoAsarSource(path.dirname(repackedAsar), asarContentDir);
    if (fs.existsSync(unpackedDir)) fs.rmSync(unpackedDir, { recursive: true, force: true });
    if (copied > 0) console.log(`   [win] merged ${copied} unpacked native files into ASAR source`);
    args.push("--unpack-dir", `{${WINDOWS_ASAR_UNPACK_DIRS.join(",")}}`);
  }

  args.push(asarContentDir, repackedAsar);
  execFileSync(process.execPath, args, { cwd: PROJECT_ROOT, stdio: "inherit" });

  if (platform === "win" && unpackedDir) {
    const copied = copyWindowsShortUnpackedNativeFiles(asarContentDir, unpackedDir);
    if (copied > 0) console.log(`   [win] relocated ${copied} native file(s) to short unpack paths`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const platIdx = args.indexOf("--platform");
  const platform = platIdx !== -1 ? args[platIdx + 1] : null;

  const VALID = ["mac-arm64", "mac-x64", "win", "linux-x64", "linux-arm64"];
  if (!platform || !VALID.includes(platform)) {
    console.error(`[x] Usage: prepare-src.js --platform <${VALID.join("|")}>`);
    process.exit(1);
  }

  const isLinux = platform.startsWith("linux");
  const isWin = platform === "win";
  const sourceDir = isLinux
    ? path.join(SRC, platform === "linux-arm64" ? "mac-arm64" : "mac-x64")
    : path.join(SRC, platform);

  if (!fs.existsSync(sourceDir)) {
    console.error(`[x] Source not found: ${path.relative(PROJECT_ROOT, sourceDir)}/`);
    process.exit(1);
  }

  const asarContentDir = path.join(sourceDir, "_asar");
  if (!fs.existsSync(asarContentDir)) {
    console.error(`[x] _asar/ not found in ${path.relative(PROJECT_ROOT, sourceDir)}/`);
    process.exit(1);
  }

  console.log(`-- prepare-src: ${platform}`);
  console.log(`   source: ${path.relative(PROJECT_ROOT, sourceDir)}/`);

  // 1. Repack _asar/ -> app.asar
  const repackedAsar = path.join(sourceDir, "app.asar");
  console.log("   [repack] _asar/ -> app.asar");
  packAsar(asarContentDir, repackedAsar, platform);
  const asarSize = (fs.statSync(repackedAsar).size / 1048576).toFixed(1);
  console.log(`   [ok] app.asar: ${asarSize} MB`);

  // 2. Install every official runtime asset into the platform source directory.
  const expectedVersion = getPinnedCodexVersion(PROJECT_ROOT);
  const runtime = resolveCodexRuntime(PROJECT_ROOT, platform);
  const installedAssets = installCodexRuntime(runtime, sourceDir);
  const installedEntrypoint = path.join(sourceDir, path.basename(runtime.entrypoint));
  verifyCodexBinary(installedEntrypoint, expectedVersion);
  console.log(`   [codex] installed @openai/codex ${expectedVersion} (${installedAssets.length} assets)`);

  if (isWin) {
    ensureWindowsExtraResources(sourceDir);
  }

  // 3. For Linux: copy _asar/ content to flat src/ (forge packs ASAR from src/)
  //    Skip node_modules/ — upstream has macOS .node binaries.
  //    Native modules are rebuilt by electron-rebuild and synced separately.
  if (isLinux) {
    // Clear flat src/ dirs
    for (const d of [".vite", "webview", "skills", "native-menu-locales", "node_modules"]) {
      const p = path.join(SRC, d);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
    }
    for (const f of fs.readdirSync(SRC)) {
      const p = path.join(SRC, f);
      if (fs.statSync(p).isFile()) fs.unlinkSync(p);
    }
    const skipDirs = new Set(["node_modules"]);
    const count = copyRecursive(asarContentDir, SRC, null, skipDirs);
    console.log(`   [linux] _asar/ -> src/ (${count} files, skipped node_modules/)`);
  }

  // 4. Sync version to root package.json
  const upstreamPkg = path.join(asarContentDir, "package.json");
  if (fs.existsSync(upstreamPkg)) {
    const upstream = JSON.parse(fs.readFileSync(upstreamPkg, "utf-8"));
    const rootPkgPath = path.join(PROJECT_ROOT, "package.json");
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
    const oldVer = rootPkg.version;
    rootPkg.version = upstream.version || rootPkg.version;
    rootPkg.main = "src/.vite/build/bootstrap.js";
    for (const key of [
      "codexBuildNumber", "codexBuildFlavor",
      "codexSparkleFeedUrl", "codexSparklePublicKey",
      "codexWindowsUpdateUrl", "codexWindowsPackageIdentity",
      "codexWindowsPackagePublisher",
    ]) {
      if (upstream[key]) rootPkg[key] = upstream[key];
    }
    fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
    console.log(`   version: ${oldVer} -> ${rootPkg.version}`);
  }

  // For mac/win: create stub main entry so forge validation passes.
  // The real code is in app.asar which we copy in packageAfterCopy.
  if (!isLinux) {
    const stubDir = path.join(SRC, ".vite", "build");
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(path.join(stubDir, "bootstrap.js"), "// stub - real code in app.asar\n");
    // Also need package.json in src/ for forge
    const asarPkg = path.join(asarContentDir, "package.json");
    if (fs.existsSync(asarPkg)) {
      fs.copyFileSync(asarPkg, path.join(SRC, "package.json"));
    }
  }

  // Write build mode marker for forge.config.js
  const marker = path.join(SRC, ".build-mode");
  fs.writeFileSync(marker, isLinux ? "linux" : "upstream-asar");
  console.log(`   [mode] ${isLinux ? "linux (forge packs ASAR)" : "upstream-asar (pre-built)"}`);

  console.log(`   [ok] src/ ready for ${platform} build`);
}

main();

#!/usr/bin/env node
/**
 * Build the Windows Squirrel installer with a short temp path.
 *
 * electron-winstaller stages files under os.tmpdir(). The upstream Codex
 * resources include long native-module paths, so the default user temp
 * directory can exceed Windows' legacy 260-character limit while packing the
 * NuGet package. Use a short root-level temp directory for this make step.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { createWindowsInstaller } = require("electron-winstaller");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const INITIAL_TMPDIR = os.tmpdir();

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    ...options,
  });
}

function copyRecursive(src, dest, options = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (options.skipNames?.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyRecursive(srcPath, destPath, options);
    else if (!entry.isSymbolicLink()) fs.copyFileSync(srcPath, destPath);
  }
}

function clearDirectoryContents(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(entryPath);
    } else {
      fs.rmSync(entryPath, { recursive: true, force: true });
    }
  }
}

function resetShortWorkspace(root) {
  const shortWorkspace = process.env.CODEX_REBUILD_SHORT_WORKSPACE || path.join(root, "w");
  const marker = path.join(shortWorkspace, ".codex-rebuild-short-workspace");
  if (fs.existsSync(shortWorkspace)) {
    if (!fs.existsSync(marker)) {
      throw new Error(
        `${shortWorkspace} already exists and was not created by this script. ` +
          "Set CODEX_REBUILD_SHORT_WORKSPACE to a different short path.",
      );
    }
    clearDirectoryContents(shortWorkspace);
  }

  fs.mkdirSync(shortWorkspace, { recursive: true });
  fs.writeFileSync(marker, "CodexDesktop-Rebuild Windows installer staging\n", "utf-8");
  return shortWorkspace;
}

function resetMarkedDirectory(dir, markerName) {
  const marker = path.join(dir, markerName);
  if (fs.existsSync(dir)) {
    if (!fs.existsSync(marker)) {
      throw new Error(`${dir} already exists and was not created by this script.`);
    }
    clearDirectoryContents(dir);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(marker, "CodexDesktop-Rebuild Windows installer output\n", "utf-8");
}

function normalizeEscapedScopeDirs(rootDir) {
  if (!fs.existsSync(rootDir)) return 0;
  let renamed = 0;

  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const oldPath = path.join(dir, entry.name);
      let nextPath = oldPath;
      if (entry.name.startsWith("%40")) {
        nextPath = path.join(dir, `@${entry.name.slice(3)}`);
        if (!fs.existsSync(nextPath)) {
          fs.renameSync(oldPath, nextPath);
          renamed++;
        }
      }
      visit(nextPath);
    }
  };

  visit(rootDir);
  return renamed;
}

function findCachedMsix() {
  const cacheDirs = [...new Set([INITIAL_TMPDIR, os.tmpdir()].map((dir) => path.join(dir, "codex-sync")))];
  const candidates = [];

  for (const cacheDir of cacheDirs) {
    if (!fs.existsSync(cacheDir)) continue;
    for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^OpenAI\.Codex_.*_x64__.*\.msix$/i.test(entry.name)) continue;
      const fullPath = path.join(cacheDir, entry.name);
      candidates.push({ fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates[0]?.fullPath || null;
}

function computeAsarHeaderHash(asarPath) {
  const crypto = require("crypto");
  const buf = fs.readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(12);
  const header = buf.slice(16, 16 + headerSize);
  return crypto.createHash("sha256").update(header).digest("hex");
}

function patchExeHash(exePath, oldHash, newHash) {
  const buf = fs.readFileSync(exePath);
  const oldBuf = Buffer.from(oldHash, "ascii");
  const idx = buf.indexOf(oldBuf);
  if (idx < 0) {
    console.log("   [!] old ASAR integrity hash not found in Codex.exe");
    return;
  }

  Buffer.from(newHash, "ascii").copy(buf, idx);
  fs.writeFileSync(exePath, buf);
  console.log(`   [integrity] Codex.exe hash patched at offset ${idx}`);
}

function stageUpstreamApp(shortWorkspace) {
  const msixPath = process.env.CODEX_REBUILD_WIN_MSIX || findCachedMsix();
  if (!msixPath || !fs.existsSync(msixPath)) {
    throw new Error(
      "Windows MSIX cache not found. Run `node scripts/sync-upstream.js --force --skip-mac` first.",
    );
  }

  const extractDir = path.join(shortWorkspace, "msix");
  fs.mkdirSync(extractDir, { recursive: true });
  console.log(`-- extracting upstream MSIX: ${path.basename(msixPath)}`);
  run("tar", ["-xf", msixPath, "-C", extractDir]);

  const appDirectory = path.join(extractDir, "app");
  const exePath = path.join(appDirectory, "Codex.exe");
  const chromeDll = path.join(appDirectory, "chrome.dll");
  const resourcesDir = path.join(appDirectory, "resources");
  if (!fs.existsSync(exePath) || !fs.existsSync(chromeDll) || !fs.existsSync(resourcesDir)) {
    throw new Error(`Incomplete Windows app extracted from MSIX: ${appDirectory}`);
  }
  const licensePath = path.join(appDirectory, "LICENSE");
  if (!fs.existsSync(licensePath)) {
    fs.writeFileSync(
      licensePath,
      "Codex Desktop App installer package.\nSee upstream OpenAI Codex and bundled dependency licenses.\n",
      "utf-8",
    );
  }

  return appDirectory;
}

function applyPatchedResources(appDirectory) {
  const resourcesDir = path.join(appDirectory, "resources");
  const sourceWinDir = path.join(PROJECT_ROOT, "src", "win");
  const sourceAsar = path.join(sourceWinDir, "app.asar");
  const sourceUnpacked = path.join(sourceWinDir, "app.asar.unpacked");
  const destAsar = path.join(resourcesDir, "app.asar");
  const destUnpacked = path.join(resourcesDir, "app.asar.unpacked");
  const exePath = path.join(appDirectory, "Codex.exe");

  if (!fs.existsSync(sourceAsar) || !fs.existsSync(sourceUnpacked)) {
    throw new Error("Patched Windows app.asar/app.asar.unpacked not found.");
  }

  const oldHash = computeAsarHeaderHash(destAsar);
  fs.copyFileSync(sourceAsar, destAsar);
  fs.rmSync(destUnpacked, { recursive: true, force: true });
  copyRecursive(sourceUnpacked, destUnpacked);

  for (const fileName of ["codex.exe", "rg.exe"]) {
    const sourceFile = path.join(sourceWinDir, fileName);
    if (fs.existsSync(sourceFile)) {
      fs.copyFileSync(sourceFile, path.join(resourcesDir, fileName));
    }
  }

  const normalizedScopes = normalizeEscapedScopeDirs(destUnpacked);
  if (normalizedScopes > 0) {
    console.log(`-- normalized ${normalizedScopes} escaped scope directories in app.asar.unpacked`);
  }

  const newHash = computeAsarHeaderHash(destAsar);
  if (oldHash !== newHash) patchExeHash(exePath, oldHash, newHash);

  console.log("   [ok] patched upstream app resources");
}

async function main() {
  const rootPackageJson = path.join(PROJECT_ROOT, "package.json");
  const originalRootPackageJson = fs.readFileSync(rootPackageJson, "utf-8");
  try {
    run(process.execPath, [path.join(__dirname, "prepare-src.js"), "--platform", "win"]);
  } catch (error) {
    fs.writeFileSync(rootPackageJson, originalRootPackageJson, "utf-8");
    throw error;
  }

  const root = path.parse(PROJECT_ROOT).root;
  const shortTemp = process.env.CODEX_REBUILD_SQUIRREL_TEMP || path.join(root, "t");
  const shortWorkspace = resetShortWorkspace(root);
  fs.writeFileSync(rootPackageJson, originalRootPackageJson, "utf-8");
  const shortInstallerOut =
    process.env.CODEX_REBUILD_SQUIRREL_OUT || path.join(root, "o");
  fs.mkdirSync(shortTemp, { recursive: true });
  resetMarkedDirectory(shortInstallerOut, ".codex-rebuild-squirrel-output");

  process.env.TEMP = shortTemp;
  process.env.TMP = shortTemp;
  process.env.TMPDIR = shortTemp;

  const appDirectory = stageUpstreamApp(shortWorkspace);
  applyPatchedResources(appDirectory);

  await createWindowsInstaller({
    appDirectory,
    outputDirectory: shortInstallerOut,
    name: "Codex",
    title: "Codex",
    authors: "OpenAI, Cometix Space",
    owners: "OpenAI, Cometix Space",
    description: "Codex Desktop App",
    exe: "Codex.exe",
    setupExe: "CodexSetup.exe",
    noMsi: true,
    skipUpdateIcon: true,
    setupIcon: path.join(PROJECT_ROOT, "resources", "electron.ico"),
    iconUrl: "https://raw.githubusercontent.com/Gaq152/CodexDesktop-Rebuild/master/resources/electron.ico",
    remoteReleases: process.env.CODEX_REBUILD_REMOTE_RELEASES || undefined,
  });

  const projectSquirrelDir = path.join(PROJECT_ROOT, "out", "make", "squirrel.windows", "x64");
  fs.rmSync(projectSquirrelDir, { recursive: true, force: true });
  copyRecursive(shortInstallerOut, projectSquirrelDir, {
    skipNames: new Set([".codex-rebuild-squirrel-output"]),
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

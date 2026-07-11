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
const {
  assertWindowsMsixVersion,
  findCachedWindowsMsix,
  getExpectedWindowsMsixVersion,
  resolvePrimaryExecutableNameFromManifest,
} = require("./windows-app-entry");

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
    console.log(`   [!] old ASAR integrity hash not found in ${path.basename(exePath)}`);
    return;
  }

  Buffer.from(newHash, "ascii").copy(buf, idx);
  fs.writeFileSync(exePath, buf);
  console.log(`   [integrity] ${path.basename(exePath)} hash patched at offset ${idx}`);
}

function stageUpstreamApp(shortWorkspace) {
  const cacheDirs = [INITIAL_TMPDIR, os.tmpdir()].map((dir) => path.join(dir, "codex-sync"));
  const expectedVersion = getExpectedWindowsMsixVersion();
  const msixPath = process.env.CODEX_REBUILD_WIN_MSIX
    ? assertWindowsMsixVersion(process.env.CODEX_REBUILD_WIN_MSIX, expectedVersion)
    : findCachedWindowsMsix(cacheDirs, expectedVersion);
  if (!fs.existsSync(msixPath)) {
    throw new Error(
      "Windows MSIX cache not found. Run `node scripts/sync-upstream.js --force --skip-mac` first.",
    );
  }

  const extractDir = path.join(shortWorkspace, "msix");
  fs.mkdirSync(extractDir, { recursive: true });
  console.log(`-- extracting upstream MSIX: ${path.basename(msixPath)}`);
  run("tar", ["-xf", msixPath, "-C", extractDir]);

  const manifestPath = path.join(extractDir, "AppxManifest.xml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`AppxManifest.xml was not found in extracted MSIX: ${extractDir}`);
  }
  const primaryExe = resolvePrimaryExecutableNameFromManifest(fs.readFileSync(manifestPath, "utf-8"));
  const appDirectory = path.join(extractDir, "app");
  const exePath = path.join(appDirectory, primaryExe);
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

  console.log(`   [entry] Appx primary executable: ${primaryExe}`);
  return { appDirectory, primaryExe };
}

function applyPatchedResources(appDirectory, primaryExe) {
  const resourcesDir = path.join(appDirectory, "resources");
  const sourceWinDir = path.join(PROJECT_ROOT, "src", "win");
  const sourceAsar = path.join(sourceWinDir, "app.asar");
  const sourceUnpacked = path.join(sourceWinDir, "app.asar.unpacked");
  const destAsar = path.join(resourcesDir, "app.asar");
  const destUnpacked = path.join(resourcesDir, "app.asar.unpacked");
  const exePath = path.join(appDirectory, primaryExe);

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripExternalAssemblyManifestDependencies(appDirectory, exeName) {
  const manifestAssemblyNames = fs
    .readdirSync(appDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".manifest"))
    .map((entry) => entry.name.slice(0, -".manifest".length));
  if (manifestAssemblyNames.length === 0) return;

  const ResEdit = require("resedit");
  const exePath = path.join(appDirectory, exeName);
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(exe);
  let changed = false;

  for (const entry of resources.entries.filter((resource) => resource.type === 24)) {
    let manifest = Buffer.from(entry.bin).toString("utf-8");
    const original = manifest;

    for (const assemblyName of manifestAssemblyNames) {
      const quotedName = escapeRegExp(assemblyName);
      const dependencyPattern = new RegExp(
        `<dependency><dependentAssembly><assemblyIdentity\\s+type="win32"\\s+name="${quotedName}"\\s+version="${quotedName}"\\s+language="\\*"\\s*/></dependentAssembly></dependency>`,
        "g",
      );
      manifest = manifest.replace(dependencyPattern, "");
    }

    if (manifest !== original) {
      entry.bin = Buffer.from(manifest, "utf-8");
      changed = true;
    }
  }

  if (!changed) return;
  resources.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`   [ok] stripped root-stub-breaking manifest dependency from ${exeName}`);
}

function createLegacyExecutableAlias(appDirectory, primaryExe, legacyExe = "Codex.exe") {
  if (primaryExe.toLowerCase() === legacyExe.toLowerCase()) return false;
  const primaryPath = path.join(appDirectory, primaryExe);
  if (!fs.existsSync(primaryPath)) {
    throw new Error(`Primary executable ${primaryPath} was not found; cannot create legacy alias.`);
  }
  fs.copyFileSync(primaryPath, path.join(appDirectory, legacyExe));
  console.log(`   [ok] legacy ${legacyExe} compatibility alias -> ${primaryExe}`);
  return true;
}

function isCoveredByDefaultNuspec(entryName, exeName) {
  const lower = entryName.toLowerCase();
  if (lower === "locales" || lower === "resources") return true;
  if (lower === exeName.toLowerCase()) return true;
  if (lower === "squirrel.exe" || lower === "license" || lower === "icudtl.dat") return true;
  if (lower === "vk_swiftshader_icd.json") return true;
  if (lower.endsWith(".bin") || lower.endsWith(".dll") || lower.endsWith(".pak")) return true;
  if (lower.endsWith(".exe.config") || lower.endsWith(".exe.sig")) return true;
  return false;
}

function collectAdditionalFiles(appDirectory, exeName) {
  const additionalFiles = [];
  for (const entry of fs.readdirSync(appDirectory, { withFileTypes: true })) {
    if (isCoveredByDefaultNuspec(entry.name, exeName)) continue;

    if (entry.isDirectory()) {
      additionalFiles.push({
        src: `${entry.name}\\**`,
        target: `lib\\net45\\${entry.name}`,
      });
    } else if (!entry.isSymbolicLink()) {
      additionalFiles.push({
        src: entry.name,
        target: "lib\\net45",
      });
    }
  }

  return additionalFiles;
}

function markSquirrelAware(appDirectory, exeName) {
  const exePath = path.join(appDirectory, exeName);
  if (!fs.existsSync(exePath)) {
    throw new Error(`Packaged executable ${exePath} was not found; cannot mark it Squirrel-aware.`);
  }

  const ResEdit = require("resedit");
  const executable = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(executable);
  let versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);

  if (versions.length === 0) {
    const version = ResEdit.Resource.VersionInfo.createEmpty();
    version.lang = 1033;
    versions = [version];
  }

  for (const version of versions) {
    const languages = version.getAllLanguagesForStringValues();
    const targets = languages.length > 0
      ? languages
      : [{ lang: typeof version.lang === "number" ? version.lang : 1033, codepage: 1200 }];
    for (const language of targets) {
      version.setStringValue(language, "SquirrelAwareVersion", "1");
    }
    version.outputToResourceEntries(resources.entries);
  }

  resources.outputResource(executable);
  fs.writeFileSync(exePath, Buffer.from(executable.generate()));
  console.log(`   [ok] marked ${exeName} as Squirrel-aware`);
}

function resolveSquirrelReleaseOptions(env) {
  const raw = env.CODEX_REBUILD_NO_DELTA;
  if (raw !== undefined && raw !== "" && raw !== "1") {
    throw new Error("CODEX_REBUILD_NO_DELTA expected 1 when set");
  }
  const noDelta = raw === "1";
  return {
    noDelta,
    remoteReleases: noDelta ? undefined : env.CODEX_REBUILD_REMOTE_RELEASES || undefined,
  };
}

function getPatchedAppVersion() {
  const packageJsonPath = path.join(PROJECT_ROOT, "src", "win", "_asar", "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  return packageJson.version;
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

  const { createWindowsInstaller } = require("electron-winstaller");

  const { appDirectory, primaryExe } = stageUpstreamApp(shortWorkspace);
  applyPatchedResources(appDirectory, primaryExe);
  stripExternalAssemblyManifestDependencies(appDirectory, primaryExe);
  createLegacyExecutableAlias(appDirectory, primaryExe);
  markSquirrelAware(appDirectory, primaryExe);
  const additionalFiles = collectAdditionalFiles(appDirectory, primaryExe);
  console.log(`-- additional root runtime entries: ${additionalFiles.length}`);
  const installerVersion = process.env.CODEX_REBUILD_INSTALLER_VERSION || getPatchedAppVersion();
  console.log(`-- installer version: ${installerVersion}`);
  const squirrelReleaseOptions = resolveSquirrelReleaseOptions(process.env);

  await createWindowsInstaller({
    appDirectory,
    outputDirectory: shortInstallerOut,
    name: "Codex",
    title: "Codex",
    authors: "OpenAI, Cometix Space",
    owners: "OpenAI, Cometix Space",
    description: "Codex Desktop App",
    version: installerVersion,
    exe: primaryExe,
    additionalFiles,
    setupExe: "CodexSetup.exe",
    noMsi: true,
    skipUpdateIcon: true,
    setupIcon: path.join(PROJECT_ROOT, "resources", "electron.ico"),
    iconUrl: "https://raw.githubusercontent.com/Gaq152/CodexDesktop-Rebuild/master/resources/electron.ico",
    noDelta: squirrelReleaseOptions.noDelta,
    remoteReleases: squirrelReleaseOptions.remoteReleases,
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

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
const path = require("path");
const { execFileSync } = require("child_process");
const { createWindowsInstaller } = require("electron-winstaller");

const PROJECT_ROOT = path.resolve(__dirname, "..");

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
  fs.copyFileSync(path.join(PROJECT_ROOT, "package.json"), path.join(shortWorkspace, "package.json"));
  fs.copyFileSync(path.join(PROJECT_ROOT, "forge.config.js"), path.join(shortWorkspace, "forge.config.js"));

  const packageLock = path.join(PROJECT_ROOT, "package-lock.json");
  if (fs.existsSync(packageLock)) fs.copyFileSync(packageLock, path.join(shortWorkspace, "package-lock.json"));

  copyRecursive(path.join(PROJECT_ROOT, "resources"), path.join(shortWorkspace, "resources"));
  copyRecursive(path.join(PROJECT_ROOT, "src", ".vite"), path.join(shortWorkspace, "src", ".vite"));
  fs.copyFileSync(path.join(PROJECT_ROOT, "src", ".build-mode"), path.join(shortWorkspace, "src", ".build-mode"));
  fs.copyFileSync(path.join(PROJECT_ROOT, "src", "package.json"), path.join(shortWorkspace, "src", "package.json"));
  copyRecursive(path.join(PROJECT_ROOT, "src", "win"), path.join(shortWorkspace, "src", "win"), {
    skipNames: new Set(["_asar"]),
  });

  fs.symlinkSync(path.join(PROJECT_ROOT, "node_modules"), path.join(shortWorkspace, "node_modules"), "junction");
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

  const env = {
    ...process.env,
    TEMP: shortTemp,
    TMP: shortTemp,
    TMPDIR: shortTemp,
  };

  const forgeCli = path.join(
    shortWorkspace,
    "node_modules",
    "@electron-forge",
    "cli",
    "dist",
    "electron-forge.js",
  );
  run(process.execPath, [forgeCli, "package", "--platform=win32", "--arch=x64"], {
    cwd: shortWorkspace,
    env,
  });

  const appDirectory = path.join(shortWorkspace, "out", "Codex-win32-x64");
  const normalizedScopes = normalizeEscapedScopeDirs(
    path.join(appDirectory, "resources", "app.asar.unpacked"),
  );
  if (normalizedScopes > 0) {
    console.log(`-- normalized ${normalizedScopes} escaped scope directories in app.asar.unpacked`);
  }

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
    setupIcon: path.join(shortWorkspace, "resources", "electron.ico"),
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

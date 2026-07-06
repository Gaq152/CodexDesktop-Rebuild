#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (!entry.isSymbolicLink()) files.push(fullPath);
    }
  };
  visit(root);
  return files;
}

function firstVersion(files, pattern) {
  for (const file of files) {
    const match = path.basename(file).match(pattern);
    if (match) return match[1];
  }
  return "";
}

function collectReleaseArtifactMetadata(root) {
  const files = walkFiles(root).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const macArm64Version = firstVersion(files, /^Codex-mac-arm64-(.+)\.dmg$/);
  const macX64Version = firstVersion(files, /^Codex-mac-x64-(.+)\.dmg$/);
  const windowsPortableVersion = firstVersion(files, /^Codex-win-x64-(.+)\.zip$/);
  const windowsInstallerVersion =
    firstVersion(files, /^Codex-(.+)-full\.nupkg$/) ||
    firstVersion(files, /^CodexSetup-win-x64-(.+)\.exe$/);
  const releaseVersion = macArm64Version || macX64Version || windowsPortableVersion || windowsInstallerVersion;

  return {
    releaseVersion,
    macArm64Version,
    macX64Version,
    windowsPortableVersion,
    windowsInstallerVersion,
  };
}

function renameWindowsSetup(root, version) {
  if (!version) return [];
  const renamed = [];
  for (const file of walkFiles(root)) {
    if (path.basename(file) !== "CodexSetup.exe") continue;
    const next = path.join(path.dirname(file), `CodexSetup-win-x64-${version}.exe`);
    if (fs.existsSync(next)) fs.rmSync(next, { force: true });
    fs.renameSync(file, next);
    renamed.push({ from: file, to: next });
  }
  return renamed;
}

function toOutputPairs(metadata) {
  return {
    release_version: metadata.releaseVersion,
    mac_arm64_version: metadata.macArm64Version,
    mac_x64_version: metadata.macX64Version,
    windows_portable_version: metadata.windowsPortableVersion,
    windows_installer_version: metadata.windowsInstallerVersion,
  };
}

function writeGithubOutput(metadata, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  const lines = [];
  for (const [key, value] of Object.entries(toOutputPairs(metadata))) {
    lines.push(`${key}=${String(value || "").replace(/[\r\n]/g, "")}`);
  }
  fs.appendFileSync(outputPath, `${lines.join(os.EOL)}${os.EOL}`);
}

function parseArgs(argv) {
  const options = { root: ".", renameWindowsSetup: false, githubOutput: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") options.root = argv[++i];
    else if (arg === "--rename-windows-setup") options.renameWindowsSetup = true;
    else if (arg === "--github-output") options.githubOutput = true;
    else if (arg === "--json") options.json = true;
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.root);
  let metadata = collectReleaseArtifactMetadata(root);
  if (options.renameWindowsSetup) {
    renameWindowsSetup(root, metadata.windowsInstallerVersion);
    metadata = collectReleaseArtifactMetadata(root);
  }
  if (options.githubOutput) writeGithubOutput(metadata);
  if (options.json || !options.githubOutput) {
    console.log(JSON.stringify(metadata, null, 2));
  }
}

module.exports = {
  collectReleaseArtifactMetadata,
  renameWindowsSetup,
  toOutputPairs,
  writeGithubOutput,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[x] ${error.message}`);
    process.exit(1);
  }
}

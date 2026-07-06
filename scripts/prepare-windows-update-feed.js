#!/usr/bin/env node
/**
 * Prepare a compact Squirrel.Windows update feed.
 *
 * Electron Forge may keep remote release packages in the Squirrel output
 * directory so it can generate delta packages. Those old full packages are
 * useful during build, but should not be redeployed to GitHub Pages because
 * Pages has a 1 GB artifact limit. This script keeps only the newest version's
 * RELEASES entries and matching nupkg files.
 *
 * Usage:
 *   node scripts/prepare-windows-update-feed.js --source <dir> --dest <dir>
 */
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source" || arg === "--dest") {
      args[arg.slice(2)] = argv[++i];
    }
  }
  if (!args.source || !args.dest) {
    console.error("[x] Usage: prepare-windows-update-feed.js --source <dir> --dest <dir>");
    process.exit(1);
  }
  return {
    source: path.resolve(args.source),
    dest: path.resolve(args.dest),
  };
}

function walkFiles(dir) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile()) files.push(filePath);
    }
  };
  visit(dir);
  return files;
}

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function parseReleaseLine(line) {
  const match = line.trim().match(/^([A-Fa-f0-9]+)\s+(\S+)\s+(\d+)$/);
  if (!match) return null;

  const filename = match[2];
  const packageMatch = filename.match(/^Codex-(\d+\.\d+\.\d+)-(full|delta)\.nupkg$/);
  if (!packageMatch) return null;

  return {
    filename,
    line: line.trim(),
    version: packageMatch[1],
    kind: packageMatch[2],
  };
}

function main() {
  const { source, dest } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(source)) {
    console.error(`[x] Source directory does not exist: ${source}`);
    process.exit(1);
  }

  const files = walkFiles(source);
  const packageFiles = new Map(
    files.filter((file) => file.endsWith(".nupkg")).map((file) => [path.basename(file), file])
  );
  const releaseFiles = files.filter((file) => path.basename(file) === "RELEASES");

  const entriesByFilename = new Map();
  for (const releaseFile of releaseFiles) {
    const lines = fs.readFileSync(releaseFile, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const entry = parseReleaseLine(line);
      if (entry) entriesByFilename.set(entry.filename, entry);
    }
  }

  const entries = Array.from(entriesByFilename.values());
  if (entries.length === 0) {
    console.error(`[x] No Squirrel release entries found in ${source}`);
    process.exit(1);
  }

  const latestVersion = entries
    .map((entry) => entry.version)
    .sort(compareVersions)
    .at(-1);
  const latestEntries = entries
    .filter((entry) => entry.version === latestVersion)
    .sort((a, b) => a.kind.localeCompare(b.kind));

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "RELEASES"), latestEntries.map((entry) => entry.line).join("\n") + "\n");

  let totalBytes = 0;
  for (const entry of latestEntries) {
    const sourceFile = packageFiles.get(entry.filename);
    if (!sourceFile) {
      console.error(`[x] RELEASES references missing package: ${entry.filename}`);
      process.exit(1);
    }
    const destFile = path.join(dest, entry.filename);
    fs.copyFileSync(sourceFile, destFile);
    totalBytes += fs.statSync(destFile).size;
  }

  console.log(`Prepared Windows update feed ${latestVersion}:`);
  for (const entry of latestEntries) {
    console.log(`  ${entry.filename}`);
  }
  console.log(`Total package size: ${(totalBytes / 1048576).toFixed(1)} MB`);
}

main();

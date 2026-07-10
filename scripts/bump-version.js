#!/usr/bin/env node
/**
 * Read upstream version from extracted ASAR and update root package.json.
 *
 * Upstream package.json contains:
 *   "version": "26.325.21211"
 *   "codexBuildNumber": "1255"
 *
 * This script copies those into the root package.json and prints the version
 * to stdout for CI capture.
 *
 * Usage:
 *   node scripts/bump-version.js           # Update package.json and print version
 *   node scripts/bump-version.js --dry-run # Print version without modifying
 */
const fs = require("fs");
const path = require("path");

const ROOT_PKG = path.join(__dirname, "..", "package.json");
const SRC_DIR = path.join(__dirname, "..", "src");

function findUpstreamPkg() {
  const windowsAsarPackage = path.join(SRC_DIR, "win", "_asar", "package.json");
  if (fs.existsSync(windowsAsarPackage)) return windowsAsarPackage;

  for (const plat of ["unix", "win"]) {
    const p = path.join(SRC_DIR, plat, "package.json");
    if (fs.existsSync(p)) return p;
  }
  // Legacy fallback
  const legacy = path.join(SRC_DIR, "package.json");
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

function main() {
  const dryRun = process.argv.includes("--dry-run");

  const upstreamPath = findUpstreamPkg();
  if (!upstreamPath) {
    console.error("[x] No upstream package.json found in src/win/_asar or src/{unix,win}/");
    process.exit(1);
  }

  const upstream = JSON.parse(fs.readFileSync(upstreamPath, "utf-8"));
  const version = upstream.version;
  const buildNumber = upstream.codexBuildNumber || "";

  if (!version) {
    console.error("[x] No version field in upstream package.json");
    process.exit(1);
  }

  console.log(`   upstream: ${path.relative(path.join(__dirname, ".."), upstreamPath)}`);
  console.log(`   version:  ${version}`);
  console.log(`   build:    ${buildNumber}`);

  if (dryRun) {
    // Print just the version for CI capture
    process.stdout.write(version);
    return;
  }

  const rootPkg = JSON.parse(fs.readFileSync(ROOT_PKG, "utf-8"));
  const oldVersion = rootPkg.version;

  rootPkg.version = version;
  if (buildNumber) {
    rootPkg.codexBuildNumber = buildNumber;
  }

  fs.writeFileSync(ROOT_PKG, JSON.stringify(rootPkg, null, 2) + "\n");

  console.log(`   ${oldVersion} -> ${version}`);
  console.log("   [ok] package.json updated");

  // Print version to stdout (last line) for CI
  process.stdout.write(version);
}

main();

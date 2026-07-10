#!/usr/bin/env node
/**
 * Run all patch scripts in sequence.
 *
 * Usage:
 *   node scripts/patch-all.js              # Patch both platforms
 *   node scripts/patch-all.js unix         # Patch unix only
 *   node scripts/patch-all.js win          # Patch win only
 *   node scripts/patch-all.js --check      # Dry-run all
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { verifyPatchedApp } = require("./verify-patched-app");

const PROJECT_ROOT = path.join(__dirname, "..");

const PATCHES = [
  "patch-i18n.js",
  "patch-native-menu-i18n.js",
  "patch-copyright.js",
  "patch-devtools.js",
  "patch-fast-mode.js",
  "patch-plugin-auth.js",
  "patch-windows-native-paths.js",
  "patch-updater.js",
  "patch-local-updater.js",
  "patch-archive-delete.js",
  "patch-sidebar-delete.js",
  "patch-show-all-local-sessions.js",
];

function readExtractedVersion(projectRoot) {
  const packagePath = path.join(
    projectRoot,
    "src",
    "win",
    "_asar",
    "package.json",
  );
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read extracted Windows package version at ${packagePath}: ${error.message}`,
    );
  }
  if (
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    throw new Error(`Extracted Windows package has no version at ${packagePath}`);
  }
  return packageJson.version;
}

function targetsWindows(platform, extra, projectRoot) {
  if (extra.includes("--check")) return false;
  if (platform === "win") return true;
  return (
    platform == null &&
    fs.existsSync(path.join(projectRoot, "src", "win", "_asar"))
  );
}

function runPatchAll(args, dependencies = {}) {
  const runScript = dependencies.execFileSync ?? execFileSync;
  const logger = dependencies.logger ?? console;
  const projectRoot = dependencies.projectRoot ?? PROJECT_ROOT;
  const verifier = dependencies.verifyPatchedApp ?? verifyPatchedApp;
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win", "unix"].includes(a),
  );
  const extra = args.filter((a) => a.startsWith("--"));
  const passArgs = [...(platform ? [platform] : []), ...extra];

  let failed = 0;
  let total = PATCHES.length;

  for (const script of PATCHES) {
    const scriptPath = path.join(__dirname, script);
    const label = script.replace(".js", "");
    logger.log(`\n== ${label} ==`);

    try {
      runScript("node", [scriptPath, ...passArgs], { stdio: "inherit" });
    } catch (e) {
      logger.error(`[x] ${label} failed (exit ${e.status})`);
      failed++;
    }
  }

  if (targetsWindows(platform, extra, projectRoot)) {
    total++;
    logger.log("\n== verify-patched-app ==");
    try {
      const expectedVersion = readExtractedVersion(projectRoot);
      const result = verifier(projectRoot, "win", expectedVersion);
      logger.log(`  [ok] package-version: ${expectedVersion}`);
      for (const [contract, evidenceFiles] of Object.entries(result.contracts)) {
        logger.log(`  [ok] ${contract}: ${evidenceFiles.join(", ")}`);
      }
    } catch (error) {
      logger.error(`[x] verify-patched-app failed\n${error.message}`);
      failed++;
    }
  }

  logger.log(`\n== Summary: ${total - failed}/${total} succeeded ==`);
  return { failed, total };
}

function main() {
  const result = runPatchAll(process.argv.slice(2));
  if (result.failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { runPatchAll };

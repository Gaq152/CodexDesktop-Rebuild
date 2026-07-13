#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getPreparedWindowsMsixVersion } = require("./windows-app-entry");

function validateWindowsUpstreamVersion(upstreamVersion) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(String(upstreamVersion || ""))) {
    throw new Error(`Windows MSIX version must be numeric X.Y.Z.W: ${upstreamVersion || "missing"}`);
  }
  return String(upstreamVersion);
}

function compareNumericVersions(left, right) {
  const leftParts = String(left).split(".").map(Number);
  const rightParts = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function resolveWindowsReleaseVersion(upstreamVersion, currentReleaseVersion, previousUpstreamVersion) {
  validateWindowsUpstreamVersion(upstreamVersion);
  const match = String(currentReleaseVersion || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(
      `Current Windows release version must be numeric X.Y.Z: ${currentReleaseVersion || "missing"}`,
    );
  }
  if (previousUpstreamVersion) {
    validateWindowsUpstreamVersion(previousUpstreamVersion);
    const comparison = compareNumericVersions(upstreamVersion, previousUpstreamVersion);
    if (comparison < 0) {
      throw new Error(
        `Refusing Windows MSIX rollback from ${previousUpstreamVersion} to ${upstreamVersion}`,
      );
    }
    if (comparison === 0) return currentReleaseVersion;
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function readJson(file, fallback = {}) {
  if (!file || !fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function updatePackageVersion(file, releaseVersion) {
  const packageJson = readJson(file);
  if (!packageJson.name) throw new Error(`Package metadata is missing or invalid: ${file}`);
  packageJson.version = releaseVersion;
  writeJson(file, packageJson);
}

function updateTrackedWindowsVersion(file, upstreamVersion, date = new Date()) {
  const tracked = readJson(file, {});
  tracked.updatedAt = date.toISOString();
  tracked.platforms = tracked.platforms || {};
  tracked.platforms.Windows = { version: upstreamVersion, build: "" };
  writeJson(file, tracked);
}

function writeGithubOutput(metadata, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  fs.appendFileSync(
    outputPath,
    [
      `windows_upstream_version=${metadata.upstreamVersion}`,
      `windows_release_version=${metadata.releaseVersion}`,
    ].join(os.EOL) + os.EOL,
  );
}

function parseArgs(argv) {
  const options = {
    upstreamVersion: "",
    releaseVersion: "",
    previous: "",
    basePackage: "",
    cacheDirs: [],
    writePackages: [],
    writeTracked: "",
    githubOutput: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--upstream-version") options.upstreamVersion = argv[++index];
    else if (arg === "--release-version") options.releaseVersion = argv[++index];
    else if (arg === "--previous") options.previous = argv[++index];
    else if (arg === "--base-package") options.basePackage = argv[++index];
    else if (arg === "--cache-dir") options.cacheDirs.push(argv[++index]);
    else if (arg === "--write-package") options.writePackages.push(argv[++index]);
    else if (arg === "--write-tracked") options.writeTracked = argv[++index];
    else if (arg === "--github-output") options.githubOutput = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const cacheDirs = options.cacheDirs.length > 0
    ? options.cacheDirs.map((entry) => path.resolve(entry))
    : [path.join(os.tmpdir(), "codex-sync")];
  const upstreamVersion = options.upstreamVersion || getPreparedWindowsMsixVersion(cacheDirs);
  validateWindowsUpstreamVersion(upstreamVersion);

  const basePackageFile = path.resolve(options.basePackage || options.writePackages[0] || "package.json");
  const currentReleaseVersion = readJson(basePackageFile).version;
  const previous = readJson(options.previous ? path.resolve(options.previous) : "", {});
  const previousUpstreamVersion = previous?.platforms?.Windows?.version || "";
  const releaseVersion = options.releaseVersion || resolveWindowsReleaseVersion(
    upstreamVersion,
    currentReleaseVersion,
    previousUpstreamVersion,
  );
  if (!/^\d+\.\d+\.\d+$/.test(releaseVersion)) {
    throw new Error(`Windows release version must be numeric X.Y.Z: ${releaseVersion}`);
  }
  const metadata = { upstreamVersion, releaseVersion };

  for (const packageFile of options.writePackages) {
    updatePackageVersion(path.resolve(packageFile), releaseVersion);
  }
  if (options.writeTracked) {
    updateTrackedWindowsVersion(path.resolve(options.writeTracked), upstreamVersion);
  }
  if (options.githubOutput) writeGithubOutput(metadata);
  if (options.json || !options.githubOutput) console.log(JSON.stringify(metadata, null, 2));
}

module.exports = {
  compareNumericVersions,
  resolveWindowsReleaseVersion,
  updatePackageVersion,
  updateTrackedWindowsVersion,
  validateWindowsUpstreamVersion,
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

#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAC_KEYS = ["macOS-arm64", "macOS-x64"];
const WINDOWS_KEY = "Windows";
const TRACKED_KEYS = [...MAC_KEYS, WINDOWS_KEY];

function readJson(file, fallback = {}) {
  if (!file || !fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function platformsOf(data) {
  return data?.platforms || data || {};
}

function versionRecord(info) {
  if (!info) return null;
  return {
    version: String(info.version || ""),
    build: String(info.build || ""),
  };
}

function sameVersion(a, b) {
  const left = versionRecord(a);
  const right = versionRecord(b);
  return !!left && !!right && left.version === right.version && left.build === right.build;
}

function platformChanged(key, upstreamPlatforms, previousPlatforms, force) {
  if (!upstreamPlatforms[key]) return false;
  return !!force || !sameVersion(upstreamPlatforms[key], previousPlatforms[key]);
}

function createSyncPlan(upstream, previous = {}, options = {}) {
  const upstreamPlatforms = platformsOf(upstream);
  const previousPlatforms = platformsOf(previous);
  const force = !!options.force;

  const macChanged = MAC_KEYS.some((key) =>
    platformChanged(key, upstreamPlatforms, previousPlatforms, force),
  );
  const windowsChanged = platformChanged(WINDOWS_KEY, upstreamPlatforms, previousPlatforms, force);

  return {
    hasUpdate: macChanged || windowsChanged,
    macChanged,
    windowsChanged,
    macArm64Version: upstreamPlatforms["macOS-arm64"]?.version || "",
    macX64Version: upstreamPlatforms["macOS-x64"]?.version || "",
    windowsVersion: upstreamPlatforms.Windows?.version || "",
  };
}

function buildTrackedVersions(upstream, date = new Date()) {
  const upstreamPlatforms = platformsOf(upstream);
  const platforms = {};
  for (const key of TRACKED_KEYS) {
    const record = versionRecord(upstreamPlatforms[key]);
    if (record?.version) platforms[key] = record;
  }
  return {
    updatedAt: date.toISOString(),
    platforms,
  };
}

function toOutputPairs(plan) {
  return {
    has_update: plan.hasUpdate ? "true" : "false",
    mac_changed: plan.macChanged ? "true" : "false",
    windows_changed: plan.windowsChanged ? "true" : "false",
    mac_arm64_version: plan.macArm64Version || "",
    mac_x64_version: plan.macX64Version || "",
    windows_version: plan.windowsVersion || "",
  };
}

function writeGithubOutput(plan, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  const lines = Object.entries(toOutputPairs(plan)).map(
    ([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, "")}`,
  );
  fs.appendFileSync(outputPath, `${lines.join(os.EOL)}${os.EOL}`);
}

function parseArgs(argv) {
  const options = {
    upstream: "",
    previous: "",
    writeCurrent: "",
    force: false,
    githubOutput: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--upstream") options.upstream = argv[++i];
    else if (arg === "--previous") options.previous = argv[++i];
    else if (arg === "--write-current") options.writeCurrent = argv[++i];
    else if (arg === "--force") options.force = true;
    else if (arg === "--github-output") options.githubOutput = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.upstream) throw new Error("Missing --upstream <file>");
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const upstream = readJson(path.resolve(options.upstream));
  const previous = readJson(options.previous ? path.resolve(options.previous) : "", {});
  const plan = createSyncPlan(upstream, previous, { force: options.force });

  if (options.writeCurrent) {
    const out = path.resolve(options.writeCurrent);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(buildTrackedVersions(upstream), null, 2) + "\n");
  }
  if (options.githubOutput) writeGithubOutput(plan);
  if (options.json || !options.githubOutput) console.log(JSON.stringify(plan, null, 2));
}

module.exports = {
  buildTrackedVersions,
  createSyncPlan,
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

#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getPreparedWindowsMsixVersion } = require("./windows-app-entry");
const {
  validateWindowsInternalAppVersion,
} = require("./windows-msix-internal-version");

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

function parseWindowsReleaseVersion(version) {
  const match = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)(?:-r(\d+))?$/);
  if (!match) {
    throw new Error(
      `Windows release version must be X.Y.Z or X.Y.Z-rN: ${version || "missing"}`,
    );
  }
  const officialVersion = `${match[1]}.${match[2]}.${match[3]}`;
  const revision = match[4] ? Number(match[4]) : 0;
  if (!Number.isSafeInteger(revision) || (match[4] && revision < 1)) {
    throw new Error(`Windows rebuild revision is invalid: ${match[4]}`);
  }
  return { officialVersion, revision, releaseVersion: String(version) };
}

function formatWindowsReleaseVersion(officialVersion, revision) {
  validateWindowsInternalAppVersion(officialVersion);
  const value = Number(revision);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Windows rebuild revision must be a positive integer: ${revision}`);
  }
  return `${officialVersion}-r${value}`;
}

function formatWindowsPackageVersion(officialVersion, revision) {
  validateWindowsInternalAppVersion(officialVersion);
  const value = Number(revision);
  if (!Number.isSafeInteger(value) || value < 1 || value > 9999) {
    throw new Error(`Windows rebuild revision must be between 1 and 9999: ${revision}`);
  }
  return `${officialVersion}-r${String(value).padStart(4, "0")}`;
}

function compareWindowsReleaseVersions(left, right) {
  const a = parseWindowsReleaseVersion(left);
  const b = parseWindowsReleaseVersion(right);
  const officialComparison = compareNumericVersions(a.officialVersion, b.officialVersion);
  return officialComparison || a.revision - b.revision;
}

function resolveWindowsReleaseVersion({
  upstreamVersion,
  internalAppVersion,
  currentReleaseVersion,
  previousUpstreamVersion,
  requestedRevision,
}) {
  validateWindowsUpstreamVersion(upstreamVersion);
  validateWindowsInternalAppVersion(internalAppVersion);
  const current = parseWindowsReleaseVersion(currentReleaseVersion);
  if (previousUpstreamVersion) {
    validateWindowsUpstreamVersion(previousUpstreamVersion);
    const comparison = compareNumericVersions(upstreamVersion, previousUpstreamVersion);
    if (comparison < 0) {
      throw new Error(
        `Refusing Windows MSIX rollback from ${previousUpstreamVersion} to ${upstreamVersion}`,
      );
    }
  }

  const officialComparison = compareNumericVersions(internalAppVersion, current.officialVersion);
  if (officialComparison < 0) {
    throw new Error(
      `Refusing Windows internal app rollback from ${current.officialVersion} to ${internalAppVersion}`,
    );
  }

  const explicitRevision = requestedRevision == null || requestedRevision === ""
    ? null
    : Number(requestedRevision);
  if (explicitRevision != null && (!Number.isSafeInteger(explicitRevision) || explicitRevision < 1)) {
    throw new Error(`Windows rebuild revision must be a positive integer: ${requestedRevision}`);
  }

  if (officialComparison > 0) {
    if (explicitRevision == null) {
      return internalAppVersion;
    }
    if (explicitRevision !== 1) {
      throw new Error(`A new official Windows version must start at r1, not r${explicitRevision}`);
    }
    return formatWindowsReleaseVersion(internalAppVersion, 1);
  }

  if (explicitRevision != null) {
    if (explicitRevision < Math.max(1, current.revision)) {
      throw new Error(
        `Refusing Windows rebuild revision rollback from r${current.revision} to r${explicitRevision}`,
      );
    }
    return formatWindowsReleaseVersion(internalAppVersion, explicitRevision);
  }

  const upstreamChanged = previousUpstreamVersion &&
    compareNumericVersions(upstreamVersion, previousUpstreamVersion) > 0;
  if (upstreamChanged) {
    return formatWindowsReleaseVersion(internalAppVersion, Math.max(1, current.revision + 1));
  }
  return current.revision > 0
    ? formatWindowsReleaseVersion(current.officialVersion, current.revision)
    : currentReleaseVersion;
}

function readJson(file, fallback = {}) {
  if (!file || !fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function updatePackageVersion(file, metadata) {
  const packageJson = readJson(file);
  if (!packageJson.name) throw new Error(`Package metadata is missing or invalid: ${file}`);
  packageJson.version = metadata.releaseVersion;
  packageJson.codexRebuildOfficialVersion = metadata.internalAppVersion;
  packageJson.codexRebuildRevision = metadata.revision;
  packageJson.codexRebuildReleaseVersion = metadata.releaseVersion;
  packageJson.codexRebuildPackageVersion = metadata.packageVersion;
  packageJson.codexRebuildWindowsMsixVersion = metadata.upstreamVersion;
  writeJson(file, packageJson);
}

function updateTrackedWindowsVersion(file, metadata, date = new Date()) {
  const tracked = readJson(file, {});
  tracked.updatedAt = date.toISOString();
  tracked.platforms = tracked.platforms || {};
  tracked.platforms.Windows = {
    version: metadata.internalAppVersion,
    internalAppVersion: metadata.internalAppVersion,
    msixVersion: metadata.upstreamVersion,
    rebuildRevision: metadata.revision,
    releaseVersion: metadata.releaseVersion,
    packageVersion: metadata.packageVersion,
    build: "",
  };
  writeJson(file, tracked);
}

function writeGithubOutput(metadata, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  fs.appendFileSync(
    outputPath,
    [
      `windows_upstream_version=${metadata.upstreamVersion}`,
      `windows_msix_version=${metadata.upstreamVersion}`,
      `windows_internal_app_version=${metadata.internalAppVersion}`,
      `windows_rebuild_revision=${metadata.revision}`,
      `windows_package_version=${metadata.packageVersion}`,
      `windows_release_version=${metadata.releaseVersion}`,
    ].join(os.EOL) + os.EOL,
  );
}

function parseArgs(argv) {
  const options = {
    upstreamVersion: "",
    internalVersion: "",
    releaseVersion: "",
    rebuildRevision: "",
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
    else if (arg === "--internal-version") options.internalVersion = argv[++index];
    else if (arg === "--release-version") options.releaseVersion = argv[++index];
    else if (arg === "--rebuild-revision") options.rebuildRevision = argv[++index];
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
  const extractedPackageFile = options.writePackages.find((file) =>
    path.normalize(file).endsWith(path.normalize("src/win/_asar/package.json")),
  );
  const internalAppVersion = validateWindowsInternalAppVersion(
    options.internalVersion || readJson(extractedPackageFile ? path.resolve(extractedPackageFile) : "").version,
  );
  const previous = readJson(options.previous ? path.resolve(options.previous) : "", {});
  const previousWindows = previous?.platforms?.Windows || {};
  const previousUpstreamVersion = previousWindows.msixVersion ||
    (/^\d+\.\d+\.\d+\.\d+$/.test(previousWindows.version || "") ? previousWindows.version : "");
  let releaseVersion;
  if (options.releaseVersion) {
    const requested = parseWindowsReleaseVersion(options.releaseVersion);
    if (requested.revision > 0 && requested.officialVersion !== internalAppVersion) {
      throw new Error(
        `Requested release ${options.releaseVersion} does not match Windows internal app ${internalAppVersion}`,
      );
    }
    if (
      requested.revision === 0 &&
      requested.officialVersion !== internalAppVersion &&
      options.releaseVersion !== currentReleaseVersion
    ) {
      throw new Error(
        "A bare Windows release must match the official internal version or an existing legacy release",
      );
    }
    releaseVersion = options.releaseVersion;
  } else {
    releaseVersion = resolveWindowsReleaseVersion({
      upstreamVersion,
      internalAppVersion,
      currentReleaseVersion,
      previousUpstreamVersion,
      requestedRevision: options.rebuildRevision,
    });
  }
  const parsedRelease = parseWindowsReleaseVersion(releaseVersion);
  const metadata = {
    upstreamVersion,
    internalAppVersion,
    revision: parsedRelease.revision,
    releaseVersion: parsedRelease.revision > 0
      ? formatWindowsReleaseVersion(parsedRelease.officialVersion, parsedRelease.revision)
      : releaseVersion,
    packageVersion: parsedRelease.revision > 0
      ? formatWindowsPackageVersion(parsedRelease.officialVersion, parsedRelease.revision)
      : releaseVersion,
  };

  for (const packageFile of options.writePackages) {
    updatePackageVersion(path.resolve(packageFile), metadata);
  }
  if (options.writeTracked) {
    updateTrackedWindowsVersion(path.resolve(options.writeTracked), metadata);
  }
  if (options.githubOutput) writeGithubOutput(metadata);
  if (options.json || !options.githubOutput) console.log(JSON.stringify(metadata, null, 2));
}

module.exports = {
  compareNumericVersions,
  compareWindowsReleaseVersions,
  formatWindowsPackageVersion,
  formatWindowsReleaseVersion,
  parseWindowsReleaseVersion,
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

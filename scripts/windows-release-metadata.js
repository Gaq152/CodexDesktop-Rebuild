#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  compareNumericVersions,
  compareWindowsReleaseVersions,
  formatWindowsPackageVersion,
  formatWindowsReleaseVersion,
  parseWindowsReleaseVersion,
  validateWindowsUpstreamVersion,
} = require("./configure-windows-release-version");
const { validateWindowsInternalAppVersion } = require("./windows-msix-internal-version");

const SCHEMA_VERSION = 2;

function validateReleaseVersion(version) {
  const parsed = parseWindowsReleaseVersion(version);
  return parsed.revision > 0
    ? formatWindowsReleaseVersion(parsed.officialVersion, parsed.revision)
    : parsed.releaseVersion;
}

function validateSourceSha(sourceSha) {
  if (!/^[0-9a-f]{40}$/i.test(String(sourceSha || ""))) {
    throw new Error(`Source SHA must be a 40-character Git commit: ${sourceSha || "missing"}`);
  }
  return String(sourceSha).toLowerCase();
}

function createMetadata({
  upstreamVersion,
  internalAppVersion,
  releaseVersion,
  sourceSha,
  allowLegacyRelease = false,
}) {
  const officialVersion = validateWindowsInternalAppVersion(internalAppVersion);
  const release = parseWindowsReleaseVersion(releaseVersion);
  const officialBaseRelease = release.revision === 0 &&
    release.officialVersion === officialVersion;
  const legacyRelease = release.revision === 0 && !officialBaseRelease;
  if (legacyRelease && !allowLegacyRelease) {
    throw new Error(
      `Windows release ${releaseVersion} must include rN unless legacy replacement is explicit`,
    );
  }
  if (release.revision > 0 && release.officialVersion !== officialVersion) {
    throw new Error(
      `Windows release ${releaseVersion} must match internal app ${officialVersion} and include rN`,
    );
  }
  const metadata = {
    schemaVersion: SCHEMA_VERSION,
    upstreamVersion: validateWindowsUpstreamVersion(upstreamVersion),
    internalAppVersion: officialVersion,
    rebuildRevision: release.revision,
    releaseVersion: validateReleaseVersion(releaseVersion),
    packageVersion: release.revision === 0
      ? release.releaseVersion
      : formatWindowsPackageVersion(officialVersion, release.revision),
    sourceSha: validateSourceSha(sourceSha),
  };
  if (legacyRelease) metadata.legacyRelease = true;
  return metadata;
}

function readMetadata(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported Windows release metadata schema: ${value?.schemaVersion}`);
  }
  return createMetadata({
    ...value,
    allowLegacyRelease: value.legacyRelease === true,
  });
}

function releaseVersionsFromReleases(text) {
  const versions = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const match = parts[1]?.match(/^Codex-(\d+\.\d+\.\d+(?:-r\d+)?)-(?:full|delta)\.nupkg$/i);
    if (match) {
      const parsed = parseWindowsReleaseVersion(match[1]);
      versions.add(parsed.revision > 0
        ? formatWindowsReleaseVersion(parsed.officialVersion, parsed.revision)
        : parsed.releaseVersion);
    }
  }
  return [...versions].sort(compareWindowsReleaseVersions);
}

function normalizedReleaseLines(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
}

function validatePromotionState({
  metadata,
  expectedReleaseVersion,
  currentReleaseVersion,
  trackedUpstreamVersion,
  localReleases,
  remoteReleases,
  allowSameVersionReplacement = false,
}) {
  const expected = validateReleaseVersion(expectedReleaseVersion);
  const current = validateReleaseVersion(currentReleaseVersion);
  if (metadata.releaseVersion !== expected) {
    throw new Error(`Metadata release ${metadata.releaseVersion} does not match requested ${expected}`);
  }
  if (compareWindowsReleaseVersions(expected, current) < 0) {
    throw new Error(`Refusing release rollback from master ${current} to ${expected}`);
  }
  if (trackedUpstreamVersion) {
    validateWindowsUpstreamVersion(trackedUpstreamVersion);
    if (compareNumericVersions(metadata.upstreamVersion, trackedUpstreamVersion) < 0) {
      throw new Error(
        `Refusing MSIX rollback from tracked ${trackedUpstreamVersion} to ${metadata.upstreamVersion}`,
      );
    }
  }

  const remoteVersions = releaseVersionsFromReleases(remoteReleases);
  const remoteVersion = remoteVersions.at(-1) || "";
  if (allowSameVersionReplacement) {
    if (!remoteVersion) {
      throw new Error(`Cannot replace release ${expected}: the update feed is empty`);
    }
    if (expected !== current) {
      throw new Error(`Replacement release ${expected} must equal master version ${current}`);
    }
    if (expected !== remoteVersion) {
      throw new Error(`Replacement release ${expected} must equal update feed version ${remoteVersion}`);
    }
    if (!trackedUpstreamVersion || metadata.upstreamVersion !== trackedUpstreamVersion) {
      throw new Error(
        `Replacement release ${expected} must use tracked MSIX ${trackedUpstreamVersion || "missing"}, ` +
        `not ${metadata.upstreamVersion}; publish a new rN revision instead`,
      );
    }
  }
  if (remoteVersion && compareWindowsReleaseVersions(expected, remoteVersion) < 0) {
    throw new Error(`Refusing update feed rollback from ${remoteVersion} to ${expected}`);
  }
  if (remoteVersion && compareWindowsReleaseVersions(expected, remoteVersion) === 0) {
    const localLines = normalizedReleaseLines(localReleases);
    const remoteLines = normalizedReleaseLines(remoteReleases);
    if (!allowSameVersionReplacement && JSON.stringify(localLines) !== JSON.stringify(remoteLines)) {
      throw new Error(`Release ${expected} already exists in the update feed with different hashes`);
    }
  }
  return metadata;
}

function writeGithubOutput(metadata, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  fs.appendFileSync(
    outputPath,
    [
      `windows_upstream_version=${metadata.upstreamVersion}`,
      `windows_msix_version=${metadata.upstreamVersion}`,
      `windows_internal_app_version=${metadata.internalAppVersion}`,
      `windows_rebuild_revision=${metadata.rebuildRevision}`,
      `windows_release_version=${metadata.releaseVersion}`,
      `windows_package_version=${metadata.packageVersion}`,
      `source_sha=${metadata.sourceSha}`,
    ].join(os.EOL) + os.EOL,
  );
}

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? "" : argv[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  const writeFile = valueAfter(args, "--write");
  const metadataFile = valueAfter(args, "--metadata");
  let metadata;
  if (writeFile) {
    metadata = createMetadata({
      upstreamVersion: valueAfter(args, "--upstream-version"),
      internalAppVersion: valueAfter(args, "--internal-version"),
      releaseVersion: valueAfter(args, "--release-version"),
      sourceSha: valueAfter(args, "--source-sha"),
      allowLegacyRelease: args.includes("--allow-legacy-release"),
    });
    const target = path.resolve(writeFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(metadata, null, 2)}\n`);
  } else if (metadataFile) {
    metadata = readMetadata(path.resolve(metadataFile));
  } else {
    throw new Error("Expected --write <file> or --metadata <file>");
  }

  if (args.includes("--validate-promotion")) {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(valueAfter(args, "--package")), "utf8"));
    const tracked = JSON.parse(fs.readFileSync(path.resolve(valueAfter(args, "--tracked")), "utf8"));
    validatePromotionState({
      metadata,
      expectedReleaseVersion: valueAfter(args, "--expected-release-version"),
      currentReleaseVersion: packageJson.version,
      trackedUpstreamVersion: tracked?.platforms?.Windows?.msixVersion ||
        (/^\d+\.\d+\.\d+\.\d+$/.test(tracked?.platforms?.Windows?.version || "")
          ? tracked.platforms.Windows.version
          : ""),
      localReleases: fs.readFileSync(path.resolve(valueAfter(args, "--local-releases")), "utf8"),
      remoteReleases: fs.readFileSync(path.resolve(valueAfter(args, "--remote-releases")), "utf8"),
      allowSameVersionReplacement: args.includes("--allow-same-version-replacement"),
    });
  }
  if (args.includes("--github-output")) writeGithubOutput(metadata);
  if (!args.includes("--github-output")) console.log(JSON.stringify(metadata, null, 2));
}

module.exports = {
  createMetadata,
  readMetadata,
  releaseVersionsFromReleases,
  validatePromotionState,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[x] ${error.message}`);
    process.exit(1);
  }
}

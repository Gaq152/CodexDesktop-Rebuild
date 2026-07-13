#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  compareNumericVersions,
  validateWindowsUpstreamVersion,
} = require("./configure-windows-release-version");

const SCHEMA_VERSION = 1;

function validateReleaseVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ""))) {
    throw new Error(`Windows release version must be numeric X.Y.Z: ${version || "missing"}`);
  }
  return String(version);
}

function validateSourceSha(sourceSha) {
  if (!/^[0-9a-f]{40}$/i.test(String(sourceSha || ""))) {
    throw new Error(`Source SHA must be a 40-character Git commit: ${sourceSha || "missing"}`);
  }
  return String(sourceSha).toLowerCase();
}

function createMetadata({ upstreamVersion, releaseVersion, sourceSha }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    upstreamVersion: validateWindowsUpstreamVersion(upstreamVersion),
    releaseVersion: validateReleaseVersion(releaseVersion),
    sourceSha: validateSourceSha(sourceSha),
  };
}

function readMetadata(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported Windows release metadata schema: ${value?.schemaVersion}`);
  }
  return createMetadata(value);
}

function releaseVersionsFromReleases(text) {
  const versions = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const match = parts[1]?.match(/^Codex-(\d+\.\d+\.\d+)-(?:full|delta)\.nupkg$/i);
    if (match) versions.add(match[1]);
  }
  return [...versions].sort(compareNumericVersions);
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
  if (compareNumericVersions(expected, current) < 0) {
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
  }
  if (remoteVersion && compareNumericVersions(expected, remoteVersion) < 0) {
    throw new Error(`Refusing update feed rollback from ${remoteVersion} to ${expected}`);
  }
  if (remoteVersion && compareNumericVersions(expected, remoteVersion) === 0) {
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
      `windows_release_version=${metadata.releaseVersion}`,
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
      releaseVersion: valueAfter(args, "--release-version"),
      sourceSha: valueAfter(args, "--source-sha"),
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
      trackedUpstreamVersion: tracked?.platforms?.Windows?.version || "",
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

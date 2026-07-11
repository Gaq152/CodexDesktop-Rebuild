#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const TARGET_RELEASE_VERSION = "26.707.41301";

function expectedAssets(version) {
  return [
    `arm64/Codex-mac-arm64-${version}.dmg`,
    `x64/Codex-mac-x64-${version}.dmg`,
  ];
}

function collectAssetEntries(root) {
  const absoluteRoot = path.resolve(root);
  if (!fs.existsSync(absoluteRoot)) {
    throw new Error(`macOS promotion artifact root does not exist: ${absoluteRoot}`);
  }
  if (!fs.lstatSync(absoluteRoot).isDirectory()) {
    throw new Error(`macOS promotion artifact root is not a directory: ${absoluteRoot}`);
  }

  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      const relativePath = path.relative(absoluteRoot, filePath).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        entries.push({ path: relativePath, type: "symlink", size: 0 });
      } else if (entry.isDirectory()) {
        visit(filePath);
      } else if (entry.isFile()) {
        const size = fs.statSync(filePath).size;
        let trailerMagic = "";
        if (size >= 512) {
          const descriptor = fs.openSync(filePath, "r");
          try {
            const magic = Buffer.alloc(4);
            fs.readSync(descriptor, magic, 0, magic.length, size - 512);
            trailerMagic = magic.toString("ascii");
          } finally {
            fs.closeSync(descriptor);
          }
        }
        entries.push({ path: relativePath, type: "file", size, trailerMagic });
      } else {
        entries.push({ path: relativePath, type: "other", size: 0 });
      }
    }
  };
  visit(absoluteRoot);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function validateMacosAssetEntries(entries, expectedVersion) {
  if (expectedVersion !== TARGET_RELEASE_VERSION) {
    throw new Error(
      `macOS promotion release version expected ${TARGET_RELEASE_VERSION}, found ${expectedVersion || "missing"}`,
    );
  }

  const symlink = entries.find((entry) => entry.type === "symlink");
  if (symlink) throw new Error(`macOS promotion asset must not be a symbolic link: ${symlink.path}`);
  const nonFile = entries.find((entry) => entry.type !== "file");
  if (nonFile) throw new Error(`macOS promotion asset is not a regular file: ${nonFile.path}`);

  const expected = expectedAssets(expectedVersion);
  const expectedSet = new Set(expected);
  const unexpected = entries.filter((entry) => !expectedSet.has(entry.path));
  if (unexpected.length > 0) {
    throw new Error(
      `unexpected macOS promotion asset(s): ${unexpected.map((entry) => entry.path).join(", ")}`,
    );
  }

  const paths = entries.map((entry) => entry.path);
  const missing = expected.filter((asset) => !paths.includes(asset));
  if (missing.length > 0 || entries.length !== expected.length) {
    throw new Error(
      `expected exactly two macOS promotion assets; missing: ${missing.join(", ") || "none"}`,
    );
  }

  for (const asset of entries) {
    if (asset.size <= 0) throw new Error(`macOS promotion DMG must be non-empty: ${asset.path}`);
    if (asset.size < 512 || asset.trailerMagic !== "koly") {
      throw new Error(
        `macOS promotion DMG must contain a UDIF koly trailer in its final 512 bytes: ${asset.path}`,
      );
    }
  }

  return {
    version: expectedVersion,
    assets: expected.map((asset) => path.posix.basename(asset)),
  };
}

function validateMacosReleaseArtifacts(root, expectedVersion) {
  return validateMacosAssetEntries(collectAssetEntries(root), expectedVersion);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root" || arg === "--version") {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.root || !options.version) {
    throw new Error("Usage: validate-macos-release-artifacts.js --root <dir> --version <version>");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = validateMacosReleaseArtifacts(options.root, options.version);
  console.log(`Validated macOS-only release ${result.version}: ${result.assets.join(", ")}`);
}

module.exports = {
  TARGET_RELEASE_VERSION,
  collectAssetEntries,
  validateMacosAssetEntries,
  validateMacosReleaseArtifacts,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[x] ${error.message}`);
    process.exit(1);
  }
}

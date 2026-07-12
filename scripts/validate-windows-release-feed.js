#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root" || argument === "--version") {
      options[argument.slice(2)] = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.root || !options.version) {
    throw new Error("Usage: validate-windows-release-feed.js --root <dir> --version <version>");
  }
  return options;
}

async function sha1File(filePath) {
  const hash = crypto.createHash("sha1");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function validateWindowsReleaseFeed({ root, version }) {
  const resolvedRoot = path.resolve(root);
  const releasesPath = path.join(resolvedRoot, "RELEASES");
  if (!fs.existsSync(releasesPath) || !fs.statSync(releasesPath).isFile()) {
    throw new Error(`RELEASES file is missing: ${releasesPath}`);
  }

  const lines = fs.readFileSync(releasesPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 1 || lines.length > 2) {
    throw new Error(`RELEASES must contain one or two non-empty lines, found ${lines.length}`);
  }

  const expectedNames = {
    full: `Codex-${version}-full.nupkg`,
    delta: `Codex-${version}-delta.nupkg`,
  };
  const declaredPackages = {};
  for (const line of lines) {
    const match = line.match(/^([A-Fa-f0-9]{40}) ([^\s]+) ([0-9]+)$/);
    if (!match) {
      throw new Error("Each RELEASES line must contain a 40-hex SHA1, package filename, and byte size");
    }
    const [, declaredSha1, fileName, declaredSizeText] = match;
    const kind = Object.keys(expectedNames).find((candidate) => expectedNames[candidate] === fileName);
    if (!kind) {
      throw new Error(
        `RELEASES must reference only the exact package names ${expectedNames.full} and optional ${expectedNames.delta}, found ${fileName}`,
      );
    }
    if (declaredPackages[kind]) {
      throw new Error(`RELEASES contains a duplicate ${kind} package entry: ${fileName}`);
    }
    declaredPackages[kind] = { declaredSha1, declaredSizeText, fileName };
  }

  if (!declaredPackages.full) {
    throw new Error(`RELEASES is missing required full package ${expectedNames.full}`);
  }

  const referencedNames = new Set(Object.values(declaredPackages).map(({ fileName }) => fileName));
  const unreferencedPackages = fs.readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".nupkg"))
    .map((entry) => entry.name)
    .filter((fileName) => !referencedNames.has(fileName))
    .sort();
  if (unreferencedPackages.length > 0) {
    throw new Error(`Update feed contains unreferenced nupkg package(s): ${unreferencedPackages.join(", ")}`);
  }

  const validatePackage = async (kind) => {
    const declaration = declaredPackages[kind];
    if (!declaration) return null;
    const { declaredSha1, declaredSizeText, fileName } = declaration;
    const packagePath = path.join(resolvedRoot, fileName);
    if (!fs.existsSync(packagePath) || !fs.statSync(packagePath).isFile()) {
      throw new Error(`RELEASES ${kind} package is missing: ${packagePath}`);
    }
    const actualSize = fs.statSync(packagePath).size;
    const declaredSize = Number(declaredSizeText);
    if (!Number.isSafeInteger(declaredSize) || declaredSize !== actualSize) {
      throw new Error(
        `RELEASES ${kind} package size mismatch: declared ${declaredSizeText}, actual ${actualSize}`,
      );
    }

    const actualSha1 = await sha1File(packagePath);
    if (declaredSha1.toLowerCase() !== actualSha1) {
      throw new Error(
        `RELEASES ${kind} package SHA1 mismatch: declared ${declaredSha1}, actual ${actualSha1}`,
      );
    }
    return { fileName, sha1: actualSha1, size: actualSize };
  };

  return {
    full: await validatePackage("full"),
    delta: await validatePackage("delta"),
  };
}

function formatValidationResult(result) {
  const delta = result.delta ? result.delta.fileName : "none";
  return `full=${result.full.fileName}; delta=${delta}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await validateWindowsReleaseFeed(options);
  console.log(`[ok] validated Windows release feed: ${formatValidationResult(result)}`);
}

module.exports = { validateWindowsReleaseFeed };

if (require.main === module) {
  main().catch((error) => {
    console.error(`[x] ${error.message}`);
    process.exitCode = 1;
  });
}

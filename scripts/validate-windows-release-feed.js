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
  if (lines.length !== 1) {
    throw new Error(`RELEASES must contain exactly one non-empty line, found ${lines.length}`);
  }

  const match = lines[0].match(/^([A-Fa-f0-9]{40}) ([^\s]+) ([0-9]+)$/);
  if (!match) {
    throw new Error("RELEASES line must contain a 40-hex SHA1, package filename, and byte size");
  }
  const [, declaredSha1, fileName, declaredSizeText] = match;
  const expectedFileName = `Codex-${version}-full.nupkg`;
  if (fileName !== expectedFileName) {
    throw new Error(`RELEASES must reference exact full package version ${expectedFileName}, found ${fileName}`);
  }

  const packagePath = path.join(resolvedRoot, expectedFileName);
  if (!fs.existsSync(packagePath) || !fs.statSync(packagePath).isFile()) {
    throw new Error(`RELEASES full package is missing: ${packagePath}`);
  }
  const actualSize = fs.statSync(packagePath).size;
  const declaredSize = Number(declaredSizeText);
  if (!Number.isSafeInteger(declaredSize) || declaredSize !== actualSize) {
    throw new Error(`RELEASES size mismatch: declared ${declaredSizeText}, actual ${actualSize}`);
  }

  const actualSha1 = await sha1File(packagePath);
  if (declaredSha1.toLowerCase() !== actualSha1) {
    throw new Error(`RELEASES SHA1 mismatch: declared ${declaredSha1}, actual ${actualSha1}`);
  }
  return { fileName, sha1: actualSha1, size: actualSize };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await validateWindowsReleaseFeed(options);
  console.log(`[ok] validated Windows release feed: ${result.fileName}`);
}

module.exports = { validateWindowsReleaseFeed };

if (require.main === module) {
  main().catch((error) => {
    console.error(`[x] ${error.message}`);
    process.exitCode = 1;
  });
}

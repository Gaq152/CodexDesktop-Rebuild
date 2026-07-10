#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PLATFORM = {
  win: { suffix: "win32-x64", target: "x86_64-pc-windows-msvc" },
  "mac-arm64": { suffix: "darwin-arm64", target: "aarch64-apple-darwin" },
  "mac-x64": { suffix: "darwin-x64", target: "x86_64-apple-darwin" },
  "linux-arm64": { suffix: "linux-arm64", target: "aarch64-unknown-linux-musl" },
  "linux-x64": { suffix: "linux-x64", target: "x86_64-unknown-linux-musl" },
};

const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function describe(value) {
  return value === undefined ? "missing" : JSON.stringify(value);
}

function lstat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

function readJsonFile(file, label) {
  const stat = lstat(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${file}`);
  }

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${label} at ${file}: ${error.message}`);
  }
}

function requireDirectory(directory, label) {
  const stat = lstat(directory);
  if (!stat) {
    throw new Error(`${label} must be a directory: ${directory}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${directory}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory: ${directory}`);
  }
  return fs.realpathSync(directory);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function requireInside(root, candidate, label) {
  if (!isInside(root, candidate)) {
    throw new Error(`${label} is outside runtime target ${root}: ${candidate}`);
  }
}

function getPinnedCodexVersion(projectRoot) {
  const packageFile = path.join(projectRoot, "package.json");
  let packageJson;
  try {
    packageJson = readJsonFile(packageFile, "project package.json");
  } catch (error) {
    throw new Error(`@openai/codex must have an exact version in ${packageFile}: ${error.message}`);
  }

  const pinnedVersion = packageJson.optionalDependencies?.["@openai/codex"];
  if (typeof pinnedVersion !== "string" || !EXACT_SEMVER.test(pinnedVersion)) {
    throw new Error(
      `@openai/codex must have an exact version in optionalDependencies; received ${describe(pinnedVersion)}`,
    );
  }
  return pinnedVersion;
}

function resolveManifestPath(targetRoot, value, field, type) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`codex-package.json ${field} must be a non-empty relative path`);
  }
  if (path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`codex-package.json ${field} must be a relative path; received ${JSON.stringify(value)}`);
  }

  const segments = value.split(/[\\/]+/);
  if (segments.includes("..")) {
    throw new Error(`codex-package.json ${field} escapes the runtime target: ${JSON.stringify(value)}`);
  }

  const candidate = path.resolve(targetRoot, value);
  requireInside(targetRoot, candidate, `codex-package.json ${field}`);
  const stat = lstat(candidate);
  if (!stat) {
    throw new Error(`codex-package.json ${field} must reference a ${type}: ${candidate}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`codex-package.json ${field} must not be a symlink: ${candidate}`);
  }
  if (type === "regular file" ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(`codex-package.json ${field} must reference a ${type}: ${candidate}`);
  }

  const real = fs.realpathSync(candidate);
  requireInside(targetRoot, real, `codex-package.json ${field}`);
  return real;
}

function collectRegularFiles(directory, targetRoot, label, assets) {
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink instead of a regular file: ${candidate}`);
    }

    const real = fs.realpathSync(candidate);
    requireInside(targetRoot, real, `${label} asset`);
    if (stat.isDirectory()) {
      collectRegularFiles(real, targetRoot, label, assets);
    } else if (stat.isFile()) {
      assets.add(real);
    } else {
      throw new Error(`${label} contains a non-regular file: ${candidate}`);
    }
  }
}

function resolveCodexRuntime(projectRoot, platform) {
  const platformDefinition = PLATFORM[platform];
  if (!platformDefinition) {
    throw new Error(`unsupported platform ${JSON.stringify(platform)} for official Codex runtime`);
  }

  const version = getPinnedCodexVersion(projectRoot);
  const basePackageFile = path.join(
    projectRoot,
    "node_modules",
    "@openai",
    "codex",
    "package.json",
  );
  const basePackage = readJsonFile(basePackageFile, "installed @openai/codex package.json");
  if (basePackage.version !== version) {
    throw new Error(
      `installed @openai/codex at ${basePackageFile} has version ${describe(basePackage.version)}; expected ${version}`,
    );
  }

  const aliasName = `codex-${platformDefinition.suffix}`;
  const nested = path.join(
    projectRoot,
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    aliasName,
  );
  const hoisted = path.join(projectRoot, "node_modules", "@openai", aliasName);
  const candidates = [nested, hoisted];
  const aliasRoot = candidates.find((candidate) => lstat(candidate));
  if (!aliasRoot) {
    throw new Error(
      `official Codex runtime is missing for platform ${platform} at pin ${version}; searched:\n${candidates.join("\n")}`,
    );
  }

  requireDirectory(aliasRoot, `official platform package @openai/${aliasName}`);
  const aliasPackageFile = path.join(aliasRoot, "package.json");
  const aliasPackage = readJsonFile(aliasPackageFile, "official platform package.json");
  const expectedAliasVersion = `${version}-${platformDefinition.suffix}`;
  if (aliasPackage.version !== expectedAliasVersion) {
    throw new Error(
      `official platform package at ${aliasRoot} has version ${describe(aliasPackage.version)}; expected ${expectedAliasVersion}`,
    );
  }

  const targetRoot = requireDirectory(
    path.join(aliasRoot, "vendor", platformDefinition.target),
    "official runtime target",
  );
  const manifestFile = path.join(targetRoot, "codex-package.json");
  const manifest = readJsonFile(manifestFile, "codex-package.json");
  if (manifest.layoutVersion !== 1) {
    throw new Error(
      `codex-package.json layoutVersion at ${manifestFile} is ${describe(manifest.layoutVersion)}; expected 1`,
    );
  }
  if (manifest.version !== version) {
    throw new Error(
      `codex-package.json version at ${manifestFile} is ${describe(manifest.version)}; expected ${version}`,
    );
  }
  if (manifest.target !== platformDefinition.target) {
    throw new Error(
      `codex-package.json target at ${manifestFile} is ${describe(manifest.target)}; expected ${platformDefinition.target}`,
    );
  }
  if (manifest.variant !== "codex") {
    throw new Error(
      `codex-package.json variant at ${manifestFile} is ${describe(manifest.variant)}; expected codex`,
    );
  }

  const entrypoint = resolveManifestPath(targetRoot, manifest.entrypoint, "entrypoint", "regular file");
  const entrypointDir = requireDirectory(path.dirname(entrypoint), "entrypoint directory");
  const pathDir = resolveManifestPath(targetRoot, manifest.pathDir, "pathDir", "directory");
  const resourcesDir = resolveManifestPath(
    targetRoot,
    manifest.resourcesDir,
    "resourcesDir",
    "directory",
  );

  const assets = new Set();
  for (const [directory, label] of [
    [entrypointDir, "entrypoint directory"],
    [pathDir, "pathDir"],
    [resourcesDir, "resourcesDir"],
  ]) {
    collectRegularFiles(directory, targetRoot, label, assets);
  }
  if (!assets.has(entrypoint)) {
    throw new Error(`entrypoint was not collected as a regular runtime asset: ${entrypoint}`);
  }

  return {
    version,
    target: platformDefinition.target,
    entrypoint,
    assets: [...assets].sort(),
    targetRoot,
  };
}

function installCodexRuntime(runtime, resourcesDir) {
  if (!runtime || !Array.isArray(runtime.assets) || typeof runtime.targetRoot !== "string") {
    throw new Error("invalid resolved Codex runtime");
  }

  const targetRoot = requireDirectory(runtime.targetRoot, "resolved runtime target");
  const outputRoot = path.resolve(resourcesDir);
  const names = new Map();
  const plan = runtime.assets.map((source) => {
    if (typeof source !== "string" || !path.isAbsolute(source)) {
      throw new Error(`runtime asset must be an absolute regular-file path: ${describe(source)}`);
    }
    const stat = lstat(source);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`runtime asset must still be a regular file: ${source}`);
    }
    const realSource = fs.realpathSync(source);
    requireInside(targetRoot, realSource, "runtime asset");

    const basename = path.basename(realSource);
    const collisionKey = process.platform === "win32" ? basename.toLowerCase() : basename;
    const previous = names.get(collisionKey);
    if (previous) {
      throw new Error(`duplicate basename ${JSON.stringify(basename)} from ${previous} and ${realSource}`);
    }
    names.set(collisionKey, realSource);

    return {
      source: realSource,
      destination: path.join(outputRoot, basename),
      mode: stat.mode & 0o777,
    };
  });
  plan.sort((left, right) => left.destination.localeCompare(right.destination));

  fs.mkdirSync(outputRoot, { recursive: true });
  for (const item of plan) {
    fs.copyFileSync(item.source, item.destination);
    fs.chmodSync(item.destination, item.mode);
  }
  return plan.map((item) => item.destination);
}

function verifyCodexBinary(
  binaryPath,
  expectedVersion,
  execFileSyncImpl = childProcess.execFileSync,
) {
  let output;
  try {
    output = execFileSyncImpl(binaryPath, ["--version"], { encoding: "utf8" });
  } catch (error) {
    throw new Error(
      `Codex binary ${binaryPath} failed verification; expected ${expectedVersion}; execution failed: ${error.message}`,
    );
  }

  const text = typeof output === "string" ? output : String(output);
  const match = /^codex-cli\s+(\S+)\s*$/.exec(text);
  const actual = match ? match[1] : `unparseable output ${JSON.stringify(text)}`;
  if (!match || actual !== expectedVersion) {
    throw new Error(`Codex binary ${binaryPath} has ${actual}; expected ${expectedVersion}`);
  }
}

module.exports = {
  PLATFORM,
  getPinnedCodexVersion,
  installCodexRuntime,
  resolveCodexRuntime,
  verifyCodexBinary,
};

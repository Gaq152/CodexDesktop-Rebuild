const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");
const { parseWindowsPackageName } = require("./windows-package-utils");
const upstreamVersions = require("./upstream-versions.json");

function resolvePrimaryExecutableNameFromManifest(manifestSource) {
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" }).parse(manifestSource);
  const applicationValue = parsed?.Package?.Applications?.Application;
  const applications = Array.isArray(applicationValue) ? applicationValue : [applicationValue].filter(Boolean);
  const application = applications.find((entry) => entry.EntryPoint === "Windows.FullTrustApplication") || applications[0];
  const executable = application?.Executable;
  if (typeof executable !== "string" || executable.length === 0) {
    throw new Error("AppxManifest.xml does not declare a primary executable");
  }

  const normalized = executable.replaceAll("/", "\\");
  if (path.win32.dirname(normalized).toLowerCase() !== "app") {
    throw new Error(`Appx primary executable must be directly under app/: ${executable}`);
  }
  const exeName = path.win32.basename(normalized);
  if (!exeName.toLowerCase().endsWith(".exe")) {
    throw new Error(`Appx primary executable is not an EXE: ${executable}`);
  }
  return exeName;
}

function resolveWindowsMsixVersionFromManifest(manifestSource) {
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" }).parse(manifestSource);
  const version = parsed?.Package?.Identity?.Version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("AppxManifest.xml does not declare a valid package identity version");
  }
  return version;
}

function getExpectedWindowsMsixVersion() {
  const version = upstreamVersions?.platforms?.Windows?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("upstream-versions.json does not declare a Windows version");
  }
  return version;
}

function getPreparedWindowsMsixVersion(cacheDirs) {
  const versions = new Set();
  for (const cacheDir of [...new Set(cacheDirs)]) {
    const manifestPath = path.join(cacheDir, "win-extract", "AppxManifest.xml");
    if (!fs.existsSync(manifestPath)) continue;
    versions.add(resolveWindowsMsixVersionFromManifest(fs.readFileSync(manifestPath, "utf8")));
  }
  if (versions.size > 1) {
    throw new Error(
      `Prepared Windows MSIX manifests disagree on version: ${[...versions].join(", ")}`,
    );
  }
  return versions.size === 1 ? [...versions][0] : getExpectedWindowsMsixVersion();
}

function assertWindowsMsixVersion(msixPath, expectedVersion = getExpectedWindowsMsixVersion()) {
  const parsed = parseWindowsPackageName(path.basename(msixPath));
  if (parsed?.arch !== "x64" || parsed.version !== expectedVersion) {
    throw new Error(
      `Windows MSIX must be x64 version ${expectedVersion}: ${path.basename(msixPath)}`,
    );
  }
  return msixPath;
}

function findCachedWindowsMsix(cacheDirs, expectedVersion = getExpectedWindowsMsixVersion()) {
  const candidates = new Map();
  for (const cacheDir of [...new Set(cacheDirs)]) {
    if (!fs.existsSync(cacheDir)) continue;
    for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const parsed = parseWindowsPackageName(entry.name);
      if (parsed?.arch !== "x64" || parsed.version !== expectedVersion) continue;
      const fullPath = path.join(cacheDir, entry.name);
      candidates.set(path.resolve(fullPath).toLowerCase(), fullPath);
    }
  }
  const matches = [...candidates.values()];
  if (matches.length === 0) {
    throw new Error(`Expected Windows x64 MSIX version ${expectedVersion} was not found`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple Windows x64 MSIX packages match version ${expectedVersion}: ${matches.join(", ")}`,
    );
  }
  return matches[0];
}

module.exports = {
  assertWindowsMsixVersion,
  findCachedWindowsMsix,
  getExpectedWindowsMsixVersion,
  getPreparedWindowsMsixVersion,
  resolvePrimaryExecutableNameFromManifest,
  resolveWindowsMsixVersionFromManifest,
};

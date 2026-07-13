#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  compareNumericVersions,
  resolveWindowsReleaseVersion,
  updatePackageVersion,
  updateTrackedWindowsVersion,
  validateWindowsUpstreamVersion,
  writeGithubOutput,
} = require("./configure-windows-release-version");

test("validates the exact four-part MSIX identity", () => {
  assert.equal(validateWindowsUpstreamVersion("26.707.8479.0"), "26.707.8479.0");
  assert.equal(validateWindowsUpstreamVersion("26.707.8479.1"), "26.707.8479.1");
  assert.throws(() => validateWindowsUpstreamVersion("26.707.8479"), /numeric X\.Y\.Z\.W/);
});

test("increments the independent Windows release version only for a new MSIX", () => {
  assert.equal(
    resolveWindowsReleaseVersion("26.707.8479.0", "26.707.62119", "26.707.8168.0"),
    "26.707.62120",
  );
  assert.equal(
    resolveWindowsReleaseVersion("26.707.8479.0", "26.707.62120", "26.707.8479.0"),
    "26.707.62120",
  );
  assert.ok(compareNumericVersions("26.707.8480.0", "26.707.8479.9") > 0);
  assert.throws(
    () => resolveWindowsReleaseVersion("26.707.8168.0", "26.707.62120", "26.707.8479.0"),
    /refusing Windows MSIX rollback/i,
  );
});

test("updates package and only the tracked Windows record", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-win-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageFile = path.join(root, "package.json");
  const trackedFile = path.join(root, "upstream-versions.json");
  fs.writeFileSync(packageFile, JSON.stringify({ name: "codex-rebuild", version: "1.0.0" }));
  fs.writeFileSync(trackedFile, JSON.stringify({
    updatedAt: "2026-01-01T00:00:00.000Z",
    platforms: { "macOS-arm64": { version: "legacy", build: "1" } },
  }));

  updatePackageVersion(packageFile, "26.707.62120");
  updateTrackedWindowsVersion(
    trackedFile,
    "26.707.8479.0",
    new Date("2026-07-13T08:28:30.000Z"),
  );

  assert.equal(JSON.parse(fs.readFileSync(packageFile)).version, "26.707.62120");
  assert.deepEqual(JSON.parse(fs.readFileSync(trackedFile)), {
    updatedAt: "2026-07-13T08:28:30.000Z",
    platforms: {
      "macOS-arm64": { version: "legacy", build: "1" },
      Windows: { version: "26.707.8479.0", build: "" },
    },
  });
});

test("writes stable GitHub output names", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-win-output-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "output.txt");
  writeGithubOutput({ upstreamVersion: "26.707.8479.0", releaseVersion: "26.707.62120" }, output);
  const text = fs.readFileSync(output, "utf8");
  assert.match(text, /^windows_upstream_version=26\.707\.8479\.0/m);
  assert.match(text, /^windows_release_version=26\.707\.62120/m);
});

test("the CLI updates both root and extracted Windows package metadata", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-win-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rootPackage = path.join(root, "package.json");
  const extractedPackage = path.join(root, "src", "win", "_asar", "package.json");
  fs.mkdirSync(path.dirname(extractedPackage), { recursive: true });
  for (const file of [rootPackage, extractedPackage]) {
    fs.writeFileSync(file, JSON.stringify({ name: "codex", version: "1.0.0" }));
  }

  const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "configure-windows-release-version.js"),
    "--upstream-version", "26.707.8479.0",
    "--release-version", "26.707.62120",
    "--write-package", rootPackage,
    "--write-package", extractedPackage,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(rootPackage)).version, "26.707.62120");
  assert.equal(JSON.parse(fs.readFileSync(extractedPackage)).version, "26.707.62120");
});

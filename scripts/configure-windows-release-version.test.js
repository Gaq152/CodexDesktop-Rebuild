#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
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
} = require("./configure-windows-release-version");

const CURRENT_MSIX = "26.707.8479.0";
const NEXT_MSIX = "26.707.9981.0";
const OFFICIAL_VERSION = "26.707.72221";

test("validates the exact four-part MSIX identity", () => {
  assert.equal(validateWindowsUpstreamVersion(CURRENT_MSIX), CURRENT_MSIX);
  assert.equal(validateWindowsUpstreamVersion("26.707.8479.1"), "26.707.8479.1");
  assert.throws(() => validateWindowsUpstreamVersion("26.707.8479"), /numeric X\.Y\.Z\.W/);
});

test("parses and compares official+rN release versions numerically", () => {
  assert.deepEqual(parseWindowsReleaseVersion(`${OFFICIAL_VERSION}-r2`), {
    officialVersion: OFFICIAL_VERSION,
    revision: 2,
    releaseVersion: `${OFFICIAL_VERSION}-r2`,
  });
  assert.equal(formatWindowsReleaseVersion(OFFICIAL_VERSION, 10), `${OFFICIAL_VERSION}-r10`);
  assert.equal(formatWindowsPackageVersion(OFFICIAL_VERSION, 10), `${OFFICIAL_VERSION}-r0010`);
  assert.equal(parseWindowsReleaseVersion(`${OFFICIAL_VERSION}-r0010`).revision, 10);
  assert.ok(compareWindowsReleaseVersions(`${OFFICIAL_VERSION}-r10`, `${OFFICIAL_VERSION}-r2`) > 0);
  assert.ok(compareWindowsReleaseVersions(`${OFFICIAL_VERSION}-r1`, "26.707.62121") > 0);
  assert.ok(compareNumericVersions(NEXT_MSIX, CURRENT_MSIX) > 0);
});

test("new official internal versions use the bare official version", () => {
  assert.equal(
    resolveWindowsReleaseVersion({
      upstreamVersion: NEXT_MSIX,
      internalAppVersion: OFFICIAL_VERSION,
      currentReleaseVersion: "26.707.62121",
      previousUpstreamVersion: CURRENT_MSIX,
    }),
    OFFICIAL_VERSION,
  );
  assert.equal(
    resolveWindowsReleaseVersion({
      upstreamVersion: NEXT_MSIX,
      internalAppVersion: OFFICIAL_VERSION,
      currentReleaseVersion: "26.707.62121",
      previousUpstreamVersion: CURRENT_MSIX,
      requestedRevision: 1,
    }),
    `${OFFICIAL_VERSION}-r1`,
    "an explicit same-base rebuild starts the custom revision line at r1",
  );
  assert.throws(
    () => resolveWindowsReleaseVersion({
      upstreamVersion: NEXT_MSIX,
      internalAppVersion: OFFICIAL_VERSION,
      currentReleaseVersion: "26.707.62121",
      previousUpstreamVersion: CURRENT_MSIX,
      requestedRevision: 2,
    }),
    /new official.*r1/i,
  );
});

test("same official version uses numeric revisions without changing the official base", () => {
  assert.equal(
    resolveWindowsReleaseVersion({
      upstreamVersion: NEXT_MSIX,
      internalAppVersion: OFFICIAL_VERSION,
      currentReleaseVersion: OFFICIAL_VERSION,
      previousUpstreamVersion: NEXT_MSIX,
    }),
    OFFICIAL_VERSION,
    "a repeated official build stays on the bare official version",
  );
  assert.equal(
    resolveWindowsReleaseVersion({
      upstreamVersion: NEXT_MSIX,
      internalAppVersion: OFFICIAL_VERSION,
      currentReleaseVersion: OFFICIAL_VERSION,
      previousUpstreamVersion: NEXT_MSIX,
      requestedRevision: 1,
    }),
    `${OFFICIAL_VERSION}-r1`,
    "the first custom fix on an official base starts at r1",
  );
  assert.equal(
    resolveWindowsReleaseVersion({
      upstreamVersion: "26.707.9990.0",
      internalAppVersion: OFFICIAL_VERSION,
      currentReleaseVersion: `${OFFICIAL_VERSION}-r1`,
      previousUpstreamVersion: NEXT_MSIX,
    }),
    `${OFFICIAL_VERSION}-r2`,
    "a newer MSIX with the same internal app version still needs an installable rebuild",
  );
  assert.equal(
    resolveWindowsReleaseVersion({
      upstreamVersion: NEXT_MSIX,
      internalAppVersion: OFFICIAL_VERSION,
      currentReleaseVersion: `${OFFICIAL_VERSION}-r1`,
      previousUpstreamVersion: NEXT_MSIX,
    }),
    `${OFFICIAL_VERSION}-r1`,
    "a repeated build does not invent another revision",
  );
  assert.equal(
    resolveWindowsReleaseVersion({
      upstreamVersion: NEXT_MSIX,
      internalAppVersion: OFFICIAL_VERSION,
      currentReleaseVersion: `${OFFICIAL_VERSION}-r1`,
      previousUpstreamVersion: NEXT_MSIX,
      requestedRevision: 2,
    }),
    `${OFFICIAL_VERSION}-r2`,
  );
});

test("refuses MSIX, internal app, and rebuild revision rollbacks", () => {
  assert.throws(
    () => resolveWindowsReleaseVersion({
      upstreamVersion: CURRENT_MSIX,
      internalAppVersion: OFFICIAL_VERSION,
      currentReleaseVersion: `${OFFICIAL_VERSION}-r1`,
      previousUpstreamVersion: NEXT_MSIX,
    }),
    /MSIX rollback/i,
  );
  assert.throws(
    () => resolveWindowsReleaseVersion({
      upstreamVersion: NEXT_MSIX,
      internalAppVersion: "26.707.62119",
      currentReleaseVersion: `${OFFICIAL_VERSION}-r1`,
      previousUpstreamVersion: NEXT_MSIX,
    }),
    /internal app rollback/i,
  );
  assert.throws(
    () => resolveWindowsReleaseVersion({
      upstreamVersion: NEXT_MSIX,
      internalAppVersion: OFFICIAL_VERSION,
      currentReleaseVersion: `${OFFICIAL_VERSION}-r2`,
      previousUpstreamVersion: NEXT_MSIX,
      requestedRevision: 1,
    }),
    /revision rollback/i,
  );
});

test("writes release metadata to packages and tracks Windows versions separately", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-win-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageFile = path.join(root, "package.json");
  const trackedFile = path.join(root, "upstream-versions.json");
  fs.writeFileSync(packageFile, JSON.stringify({ name: "codex-rebuild", version: "1.0.0" }));
  fs.writeFileSync(trackedFile, JSON.stringify({ platforms: {} }));
  const metadata = {
    upstreamVersion: NEXT_MSIX,
    internalAppVersion: OFFICIAL_VERSION,
    revision: 1,
    releaseVersion: `${OFFICIAL_VERSION}-r1`,
    packageVersion: `${OFFICIAL_VERSION}-r0001`,
  };

  updatePackageVersion(packageFile, metadata);
  updateTrackedWindowsVersion(trackedFile, metadata, new Date("2026-07-15T00:00:00.000Z"));

  assert.deepEqual(JSON.parse(fs.readFileSync(packageFile)), {
    name: "codex-rebuild",
    version: `${OFFICIAL_VERSION}-r1`,
    codexRebuildOfficialVersion: OFFICIAL_VERSION,
    codexRebuildRevision: 1,
    codexRebuildReleaseVersion: `${OFFICIAL_VERSION}-r1`,
    codexRebuildPackageVersion: `${OFFICIAL_VERSION}-r0001`,
    codexRebuildWindowsMsixVersion: NEXT_MSIX,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(trackedFile)).platforms.Windows, {
    version: OFFICIAL_VERSION,
    internalAppVersion: OFFICIAL_VERSION,
    msixVersion: NEXT_MSIX,
    rebuildRevision: 1,
    releaseVersion: `${OFFICIAL_VERSION}-r1`,
    packageVersion: `${OFFICIAL_VERSION}-r0001`,
    build: "",
  });
});

test("writes explicit GitHub outputs for official, MSIX, revision, and release versions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-win-output-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "output.txt");
  writeGithubOutput({
    upstreamVersion: NEXT_MSIX,
    internalAppVersion: OFFICIAL_VERSION,
    revision: 1,
    releaseVersion: `${OFFICIAL_VERSION}-r1`,
    packageVersion: `${OFFICIAL_VERSION}-r0001`,
  }, output);
  const text = fs.readFileSync(output, "utf8");
  assert.match(text, new RegExp(`windows_msix_version=${NEXT_MSIX.replaceAll(".", "\\.")}`));
  assert.match(text, new RegExp(`windows_internal_app_version=${OFFICIAL_VERSION.replaceAll(".", "\\.")}`));
  assert.match(text, /windows_rebuild_revision=1/);
  assert.match(text, new RegExp(`windows_release_version=${OFFICIAL_VERSION.replaceAll(".", "\\.")}-r1`));
  assert.match(text, new RegExp(`windows_package_version=${OFFICIAL_VERSION.replaceAll(".", "\\.")}-r0001`));
});

test("CLI reads the extracted Windows internal version before overwriting package metadata", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-win-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rootPackage = path.join(root, "package.json");
  const extractedPackage = path.join(root, "src", "win", "_asar", "package.json");
  const tracked = path.join(root, "upstream-versions.json");
  fs.mkdirSync(path.dirname(extractedPackage), { recursive: true });
  fs.writeFileSync(rootPackage, JSON.stringify({ name: "codex", version: "26.707.62121" }));
  fs.writeFileSync(extractedPackage, JSON.stringify({ name: "codex", version: OFFICIAL_VERSION }));
  fs.writeFileSync(tracked, JSON.stringify({
    platforms: { Windows: { version: CURRENT_MSIX, build: "" } },
  }));

  const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "configure-windows-release-version.js"),
    "--upstream-version", NEXT_MSIX,
    "--previous", tracked,
    "--write-package", rootPackage,
    "--write-package", extractedPackage,
    "--json",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(rootPackage)).version, OFFICIAL_VERSION);
  assert.equal(JSON.parse(fs.readFileSync(extractedPackage)).version, OFFICIAL_VERSION);
  assert.equal(JSON.parse(result.stdout).internalAppVersion, OFFICIAL_VERSION);
});

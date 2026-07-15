#!/usr/bin/env node
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createMetadata,
  releaseVersionsFromReleases,
  validatePromotionState,
} = require("./windows-release-metadata");

const OFFICIAL = "26.707.72221";
const RELEASE = `${OFFICIAL}-r1`;
const metadata = createMetadata({
  upstreamVersion: "26.707.9981.0",
  internalAppVersion: OFFICIAL,
  releaseVersion: RELEASE,
  sourceSha: "a".repeat(40),
});
const PACKAGE_VERSION = `${OFFICIAL}-r0001`;
const local = "A".repeat(40) + ` Codex-${PACKAGE_VERSION}-full.nupkg 100\n`;
const officialMetadata = createMetadata({
  upstreamVersion: "26.707.9981.0",
  internalAppVersion: OFFICIAL,
  releaseVersion: OFFICIAL,
  sourceSha: "c".repeat(40),
});
const officialLocal = "C".repeat(40) + ` Codex-${OFFICIAL}-full.nupkg 100\n`;

test("creates strict build metadata and parses legacy plus official+rN feed versions", () => {
  assert.deepEqual(metadata, {
    schemaVersion: 2,
    upstreamVersion: "26.707.9981.0",
    internalAppVersion: OFFICIAL,
    rebuildRevision: 1,
    releaseVersion: RELEASE,
    packageVersion: PACKAGE_VERSION,
    sourceSha: "a".repeat(40),
  });
  assert.deepEqual(
    releaseVersionsFromReleases(
      "A Codex-26.707.62121-full.nupkg 1\n" +
      `B Codex-${OFFICIAL}-r10-delta.nupkg 2\n` +
      `C Codex-${OFFICIAL}-r2-full.nupkg 3\n`,
    ),
    ["26.707.62121", `${OFFICIAL}-r2`, `${OFFICIAL}-r10`],
  );
});

test("official base metadata keeps the exact official version without an r suffix", () => {
  assert.deepEqual(officialMetadata, {
    schemaVersion: 2,
    upstreamVersion: "26.707.9981.0",
    internalAppVersion: OFFICIAL,
    rebuildRevision: 0,
    releaseVersion: OFFICIAL,
    packageVersion: OFFICIAL,
    sourceSha: "c".repeat(40),
  });
});

test("legacy numeric metadata requires an explicit replacement compatibility flag", () => {
  const input = {
    upstreamVersion: "26.707.8479.0",
    internalAppVersion: "26.707.62119",
    releaseVersion: "26.707.62121",
    sourceSha: "b".repeat(40),
  };
  assert.throws(() => createMetadata(input), /legacy replacement is explicit/i);
  assert.deepEqual(createMetadata({ ...input, allowLegacyRelease: true }), {
    schemaVersion: 2,
    upstreamVersion: "26.707.8479.0",
    internalAppVersion: "26.707.62119",
    rebuildRevision: 0,
    releaseVersion: "26.707.62121",
    packageVersion: "26.707.62121",
    sourceSha: "b".repeat(40),
    legacyRelease: true,
  });
});

test("promotion accepts a newer official release and an identical same-version retry", () => {
  const base = {
    metadata: officialMetadata,
    expectedReleaseVersion: OFFICIAL,
    currentReleaseVersion: "26.707.62121",
    trackedUpstreamVersion: "26.707.8479.0",
    localReleases: officialLocal,
  };
  assert.equal(validatePromotionState({ ...base, remoteReleases: "" }), officialMetadata);
  assert.equal(
    validatePromotionState({ ...base, remoteReleases: officialLocal }),
    officialMetadata,
  );
});

test("promotion allows an explicit same-version replacement without allowing revision changes", () => {
  const base = {
    metadata,
    expectedReleaseVersion: RELEASE,
    currentReleaseVersion: RELEASE,
    trackedUpstreamVersion: "26.707.9981.0",
    localReleases: local,
    remoteReleases: "B".repeat(40) + ` Codex-${PACKAGE_VERSION}-full.nupkg 100\n`,
    allowSameVersionReplacement: true,
  };
  assert.equal(validatePromotionState(base), metadata);
  assert.throws(
    () => validatePromotionState({
      ...base,
      expectedReleaseVersion: `${OFFICIAL}-r2`,
      currentReleaseVersion: `${OFFICIAL}-r2`,
      metadata: { ...metadata, releaseVersion: `${OFFICIAL}-r2`, rebuildRevision: 2 },
    }),
    /must equal update feed version/i,
  );
  assert.throws(
    () => validatePromotionState({ ...base, remoteReleases: "" }),
    /update feed is empty/i,
  );
  assert.throws(
    () => validatePromotionState({ ...base, currentReleaseVersion: "26.707.62121" }),
    /must equal master version/i,
  );
  assert.throws(
    () => validatePromotionState({
      ...base,
      metadata: { ...metadata, upstreamVersion: "26.707.9999.0" },
    }),
    /publish a new rN revision/i,
  );
});

test("promotion fails closed on release, feed, MSIX, and same-version hash rollback", () => {
  const base = {
    metadata,
    expectedReleaseVersion: RELEASE,
    currentReleaseVersion: "26.707.62121",
    trackedUpstreamVersion: "26.707.8479.0",
    localReleases: local,
    remoteReleases: "",
  };
  assert.throws(
    () => validatePromotionState({ ...base, currentReleaseVersion: `${OFFICIAL}-r2` }),
    /release rollback/i,
  );
  assert.throws(
    () => validatePromotionState({
      ...base,
      remoteReleases: "B".repeat(40) + ` Codex-${OFFICIAL}-r2-full.nupkg 100\n`,
    }),
    /feed rollback/i,
  );
  assert.throws(
    () => validatePromotionState({
      ...base,
      remoteReleases: "B".repeat(40) + ` Codex-${PACKAGE_VERSION}-full.nupkg 100\n`,
    }),
    /different hashes/i,
  );
  assert.throws(
    () => validatePromotionState({
      ...base,
      metadata: { ...metadata, upstreamVersion: "26.707.8000.0" },
    }),
    /MSIX rollback/i,
  );
});

test("metadata rejects release labels that do not match the official internal version", () => {
  assert.throws(
    () => createMetadata({
      upstreamVersion: "26.707.9981.0",
      internalAppVersion: OFFICIAL,
      releaseVersion: "26.707.72222-r1",
      sourceSha: "a".repeat(40),
    }),
    /must match internal app/i,
  );
});

#!/usr/bin/env node
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createMetadata,
  releaseVersionsFromReleases,
  validatePromotionState,
} = require("./windows-release-metadata");

const metadata = createMetadata({
  upstreamVersion: "26.707.8479.0",
  releaseVersion: "26.707.62120",
  sourceSha: "a".repeat(40),
});
const local = "A".repeat(40) + " Codex-26.707.62120-full.nupkg 100\n";

test("creates strict build metadata and parses feed versions", () => {
  assert.deepEqual(metadata, {
    schemaVersion: 1,
    upstreamVersion: "26.707.8479.0",
    releaseVersion: "26.707.62120",
    sourceSha: "a".repeat(40),
  });
  assert.deepEqual(
    releaseVersionsFromReleases(
      "A Codex-26.707.62119-full.nupkg 1\nB Codex-26.707.62120-delta.nupkg 2\n",
    ),
    ["26.707.62119", "26.707.62120"],
  );
});

test("promotion accepts a newer release and an identical same-version retry", () => {
  const base = {
    metadata,
    expectedReleaseVersion: "26.707.62120",
    currentReleaseVersion: "26.707.62119",
    trackedUpstreamVersion: "26.707.8168.0",
    localReleases: local,
  };
  assert.equal(validatePromotionState({ ...base, remoteReleases: "" }), metadata);
  assert.equal(validatePromotionState({ ...base, remoteReleases: local }), metadata);
});

test("promotion fails closed on release, feed, MSIX, and same-version hash rollback", () => {
  const base = {
    metadata,
    expectedReleaseVersion: "26.707.62120",
    currentReleaseVersion: "26.707.62119",
    trackedUpstreamVersion: "26.707.8168.0",
    localReleases: local,
    remoteReleases: "",
  };
  assert.throws(
    () => validatePromotionState({ ...base, currentReleaseVersion: "26.707.62121" }),
    /release rollback/i,
  );
  assert.throws(
    () => validatePromotionState({
      ...base,
      remoteReleases: "B".repeat(40) + " Codex-26.707.62121-full.nupkg 100\n",
    }),
    /feed rollback/i,
  );
  assert.throws(
    () => validatePromotionState({
      ...base,
      remoteReleases: "B".repeat(40) + " Codex-26.707.62120-full.nupkg 100\n",
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

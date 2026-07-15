#!/usr/bin/env node
const assert = require("assert");
const {
  buildTrackedVersions,
  createSyncPlan,
  toOutputPairs,
} = require("./resolve-sync-plan");

const upstream = {
  platforms: {
    "macOS-arm64": { version: "26.623.141536", build: "141536" },
    "macOS-x64": { version: "26.623.141536", build: "141536" },
    Windows: {
      version: "26.623.141536",
      internalAppVersion: "26.623.141536",
      msixVersion: "26.623.19656.0",
      build: "",
    },
  },
};

assert.deepStrictEqual(
  createSyncPlan(upstream, {
    platforms: {
      "macOS-arm64": { version: "26.623.141536", build: "141536" },
      "macOS-x64": { version: "26.623.141536", build: "141536" },
      Windows: {
        version: "26.623.101652",
        internalAppVersion: "26.623.101652",
        msixVersion: "26.623.11225.0",
        build: "",
      },
    },
  }),
  {
    hasUpdate: true,
    macChanged: false,
    windowsChanged: true,
    macArm64Version: "26.623.141536",
    macX64Version: "26.623.141536",
    windowsVersion: "26.623.141536",
    windowsInternalAppVersion: "26.623.141536",
    windowsMsixVersion: "26.623.19656.0",
  },
);

assert.equal(
  createSyncPlan(upstream, {
    platforms: {
      Windows: {
        ...upstream.platforms.Windows,
        version: "26.623.101652",
        internalAppVersion: "26.623.101652",
      },
    },
  }).windowsChanged,
  true,
  "a changed internal app version must not be hidden by an unchanged MSIX identity",
);

assert.deepStrictEqual(
  createSyncPlan(upstream, {
    platforms: {
      "macOS-arm64": { version: "26.623.101652", build: "101652" },
      "macOS-x64": { version: "26.623.101652", build: "101652" },
      Windows: upstream.platforms.Windows,
    },
  }),
  {
    hasUpdate: true,
    macChanged: true,
    windowsChanged: false,
    macArm64Version: "26.623.141536",
    macX64Version: "26.623.141536",
    windowsVersion: "26.623.141536",
    windowsInternalAppVersion: "26.623.141536",
    windowsMsixVersion: "26.623.19656.0",
  },
);

assert.deepStrictEqual(
  createSyncPlan(
    upstream,
    {
      platforms: {
        "macOS-arm64": { version: "26.623.141536", build: "141536" },
        "macOS-x64": { version: "26.623.141536", build: "141536" },
        Windows: upstream.platforms.Windows,
      },
    },
    { force: true },
  ),
  {
    hasUpdate: true,
    macChanged: true,
    windowsChanged: true,
    macArm64Version: "26.623.141536",
    macX64Version: "26.623.141536",
    windowsVersion: "26.623.141536",
    windowsInternalAppVersion: "26.623.141536",
    windowsMsixVersion: "26.623.19656.0",
  },
);

assert.deepStrictEqual(toOutputPairs(createSyncPlan(upstream, {}, { force: false })), {
  has_update: "true",
  mac_changed: "true",
  windows_changed: "true",
  mac_arm64_version: "26.623.141536",
  mac_x64_version: "26.623.141536",
  windows_version: "26.623.141536",
  windows_internal_app_version: "26.623.141536",
  windows_msix_version: "26.623.19656.0",
});

assert.deepStrictEqual(buildTrackedVersions(upstream).platforms, upstream.platforms);

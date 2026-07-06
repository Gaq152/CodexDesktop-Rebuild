#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  collectReleaseArtifactMetadata,
  renameWindowsSetup,
  toOutputPairs,
} = require("./resolve-release-artifacts");

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-artifacts-"));
try {
  touch(path.join(tmp, "Codex-mac-arm64-26.623.101652.dmg"));
  touch(path.join(tmp, "Codex-mac-x64-26.623.101652.dmg"));
  touch(path.join(tmp, "nested", "Codex-win-x64-26.623.101652.zip"));
  touch(path.join(tmp, "nested", "Codex-26.623.101657-full.nupkg"));
  touch(path.join(tmp, "nested", "CodexSetup.exe"));

  const metadata = collectReleaseArtifactMetadata(tmp);
  assert.deepStrictEqual(metadata, {
    releaseVersion: "26.623.101652",
    macArm64Version: "26.623.101652",
    macX64Version: "26.623.101652",
    windowsPortableVersion: "26.623.101652",
    windowsInstallerVersion: "26.623.101657",
  });

  const renamed = renameWindowsSetup(tmp, metadata.windowsInstallerVersion);
  assert.strictEqual(renamed.length, 1);
  assert.strictEqual(fs.existsSync(path.join(tmp, "nested", "CodexSetup.exe")), false);
  assert.strictEqual(fs.existsSync(path.join(tmp, "nested", "CodexSetup-win-x64-26.623.101657.exe")), true);

  const afterRename = collectReleaseArtifactMetadata(tmp);
  assert.strictEqual(afterRename.windowsInstallerVersion, "26.623.101657");
  assert.deepStrictEqual(toOutputPairs(afterRename), {
    release_version: "26.623.101652",
    mac_arm64_version: "26.623.101652",
    mac_x64_version: "26.623.101652",
    windows_portable_version: "26.623.101652",
    windows_installer_version: "26.623.101657",
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  collectReleaseArtifactMetadata,
  renameWindowsPublicArtifacts,
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
  touch(path.join(tmp, "nested", "Codex-26.623.101658-full.nupkg"));
  touch(path.join(tmp, "nested", "CodexSetup.exe"));

  const metadata = collectReleaseArtifactMetadata(tmp);
  assert.deepStrictEqual(metadata, {
    releaseVersion: "26.623.101652",
    macArm64Version: "26.623.101652",
    macX64Version: "26.623.101652",
    windowsPortableVersion: "26.623.101652",
    windowsInstallerVersion: "26.623.101658",
    windowsPackageVersion: "26.623.101658",
  });

  const renamed = renameWindowsSetup(tmp, metadata.windowsInstallerVersion);
  assert.strictEqual(renamed.length, 1);
  assert.strictEqual(fs.existsSync(path.join(tmp, "nested", "CodexSetup.exe")), false);
  assert.strictEqual(fs.existsSync(path.join(tmp, "nested", "CodexSetup-win-x64-26.623.101658.exe")), true);

  const afterRename = collectReleaseArtifactMetadata(tmp);
  assert.strictEqual(afterRename.windowsInstallerVersion, "26.623.101658");
  assert.deepStrictEqual(toOutputPairs(afterRename), {
    release_version: "26.623.101652",
    mac_arm64_version: "26.623.101652",
    mac_x64_version: "26.623.101652",
    windows_portable_version: "26.623.101652",
    windows_installer_version: "26.623.101658",
    windows_package_version: "26.623.101658",
  });

  touch(path.join(tmp, "installer", "CodexSetup-win-x64-26.707.72221-r2.zip"));
  touch(path.join(tmp, "installer", "CodexSetup-win-x64-26.707.72221-r10.zip"));
  assert.strictEqual(
    collectReleaseArtifactMetadata(tmp).windowsInstallerVersion,
    "26.707.72221-r10",
  );

  const packageVersion = "26.707.72221-r0001";
  const releaseVersion = "26.707.72221-r1";
  touch(path.join(tmp, "public", `Codex-win-x64-${packageVersion}.zip`));
  touch(path.join(tmp, "public", `CodexSetup-win-x64-${packageVersion}.exe`));
  assert.equal(renameWindowsPublicArtifacts(tmp, packageVersion, releaseVersion).length, 2);
  assert.ok(fs.existsSync(path.join(tmp, "public", `Codex-win-x64-${releaseVersion}.zip`)));
  assert.ok(fs.existsSync(path.join(tmp, "public", `CodexSetup-win-x64-${releaseVersion}.exe`)));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

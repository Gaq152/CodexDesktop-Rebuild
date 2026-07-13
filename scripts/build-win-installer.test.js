#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const test = require("node:test");
const ResEdit = require("resedit");
const {
  findCachedWindowsMsix,
  getPreparedWindowsMsixVersion,
  resolveWindowsMsixVersionFromManifest,
} = require("./windows-app-entry");

const source = fs.readFileSync(path.join(__dirname, "build-win-installer.js"), "utf-8");
const tempAssignmentIndex = source.indexOf("process.env.TEMP = shortTemp");
const winstallerRequireIndex = source.search(/require\(["']electron-winstaller["']\)/);

assert.ok(tempAssignmentIndex !== -1, "build-win-installer should configure a short TEMP path");
assert.ok(winstallerRequireIndex !== -1, "build-win-installer should load electron-winstaller");
assert.ok(
  winstallerRequireIndex > tempAssignmentIndex,
  "electron-winstaller must be required after TEMP/TMP/TMPDIR are set so it uses the short Squirrel temp path",
);

function loadInstallerInternals() {
  const filename = path.join(__dirname, "build-win-installer.js");
  const isolatedSource = source.replace(
    /main\(\)\.catch\(\(error\) => \{[\s\S]*?\n\}\);\s*$/,
    "module.exports = { createLegacyExecutableAlias, markSquirrelAware, resolvePrimaryExecutableNameFromManifest, resolveSquirrelReleaseOptions };\n",
  );
  const module = { exports: {} };
  vm.runInNewContext(isolatedSource, {
    Buffer,
    __dirname,
    console,
    module,
    process,
    require: createRequire(filename),
  }, { filename });
  return module.exports;
}

test("resolves the official primary executable from current and legacy Appx manifests", () => {
  const { resolvePrimaryExecutableNameFromManifest } = loadInstallerInternals();
  const current = `<?xml version="1.0"?><Package><Applications><Application
    Id="App" Executable="app/ChatGPT.exe" EntryPoint="Windows.FullTrustApplication" />
  </Applications></Package>`;
  const legacy = `<?xml version="1.0"?><Package><Applications><Application
    Id="App" Executable="app\\Codex.exe" EntryPoint="Windows.FullTrustApplication" />
  </Applications></Package>`;

  assert.equal(resolvePrimaryExecutableNameFromManifest(current), "ChatGPT.exe");
  assert.equal(resolvePrimaryExecutableNameFromManifest(legacy), "Codex.exe");
});

test("rejects Appx primary executables outside the app directory", () => {
  const { resolvePrimaryExecutableNameFromManifest } = loadInstallerInternals();
  assert.throws(
    () => resolvePrimaryExecutableNameFromManifest(
      `<Package><Applications><Application Executable="tools/ChatGPT.exe" /></Applications></Package>`,
    ),
    /primary executable.*app/i,
  );
});

test("resolves the exact freshly synced Windows MSIX identity version", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-msix-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestDir = path.join(root, "win-extract");
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifest =
    `<Package><Identity Name="OpenAI.Codex" Version="26.707.8479.0" />` +
    `<Applications /></Package>`;
  fs.writeFileSync(path.join(manifestDir, "AppxManifest.xml"), manifest);

  assert.equal(resolveWindowsMsixVersionFromManifest(manifest), "26.707.8479.0");
  assert.equal(getPreparedWindowsMsixVersion([root]), "26.707.8479.0");
});

test("rejects malformed or conflicting freshly synced Windows versions", (t) => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "codex-msix-manifest-first-"));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "codex-msix-manifest-second-"));
  t.after(() => {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });
  for (const [root, version] of [
    [first, "26.707.8479.0"],
    [second, "26.707.8480.0"],
  ]) {
    const dir = path.join(root, "win-extract");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "AppxManifest.xml"),
      `<Package><Identity Version="${version}" /></Package>`,
    );
  }

  assert.throws(
    () => resolveWindowsMsixVersionFromManifest(
      `<Package><Identity Version="26.707.bad.0" /></Package>`,
    ),
    /valid package identity version/i,
  );
  assert.throws(
    () => getPreparedWindowsMsixVersion([first, second]),
    /manifests disagree.*26\.707\.8479\.0.*26\.707\.8480\.0/i,
  );
});

test("selects the expected cached Windows MSIX regardless of mtime", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-msix-cache-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const older = path.join(root, "OpenAI.Codex_26.623.1.0_x64__test.msix");
  const newer = path.join(root, "OpenAI.Codex_26.707.1.0_x64__test.msix");
  fs.writeFileSync(older, "old");
  fs.writeFileSync(newer, "new");
  fs.utimesSync(older, new Date(2_000), new Date(2_000));
  fs.utimesSync(newer, new Date(1_000), new Date(1_000));
  assert.equal(findCachedWindowsMsix([root], "26.707.1.0"), newer);
});

test("fails closed when the expected Windows MSIX is absent or ambiguous", (t) => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "codex-msix-first-"));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "codex-msix-second-"));
  t.after(() => {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(first, "OpenAI.Codex_26.623.1.0_x64__test.msix"), "old");
  assert.throws(
    () => findCachedWindowsMsix([first], "26.707.1.0"),
    /expected Windows x64 MSIX.*26\.707\.1\.0.*not found/i,
  );

  const expectedName = "OpenAI.Codex_26.707.1.0_x64__test.msix";
  fs.writeFileSync(path.join(first, expectedName), "first");
  fs.writeFileSync(path.join(second, expectedName), "second");
  assert.throws(
    () => findCachedWindowsMsix([first, second], "26.707.1.0"),
    /multiple Windows x64 MSIX.*26\.707\.1\.0/i,
  );
});

test("resolveSquirrelReleaseOptions uses remote releases for delta builds", () => {
  const { resolveSquirrelReleaseOptions } = loadInstallerInternals();
  assert.deepEqual(resolveSquirrelReleaseOptions({
    CODEX_REBUILD_REMOTE_RELEASES: "https://example.test/feed",
  }), {
    noDelta: false,
    remoteReleases: "https://example.test/feed",
  });
});

test("resolveSquirrelReleaseOptions disables remote releases for full-only builds", () => {
  const { resolveSquirrelReleaseOptions } = loadInstallerInternals();
  assert.deepEqual(resolveSquirrelReleaseOptions({
    CODEX_REBUILD_NO_DELTA: "1",
    CODEX_REBUILD_REMOTE_RELEASES: "https://example.test/feed",
  }), {
    noDelta: true,
    remoteReleases: undefined,
  });
});

test("resolveSquirrelReleaseOptions rejects invalid no-delta values", () => {
  const { resolveSquirrelReleaseOptions } = loadInstallerInternals();
  assert.throws(
    () => resolveSquirrelReleaseOptions({ CODEX_REBUILD_NO_DELTA: "true" }),
    /CODEX_REBUILD_NO_DELTA.*expected 1/,
  );
});

function namedWorkflowStep(workflow, name) {
  const normalized = workflow.replace(/\r\n/g, "\n");
  return normalized.match(
    new RegExp(`      - name: ${name}\\n(?<body>[\\s\\S]*?)(?=\\n      - (?:name:|uses:)|$)`),
  )?.groups.body;
}

function assertFullFirstWindowsInstallerWorkflow(workflow, { supportsSkip }) {
  const configure = namedWorkflowStep(workflow, "Configure Windows update feed");
  const full = namedWorkflowStep(workflow, "Build guaranteed full Windows installer");
  const backup = namedWorkflowStep(workflow, "Back up guaranteed full Windows installer");
  const delta = namedWorkflowStep(workflow, "Attempt Windows delta package");
  const finalize = namedWorkflowStep(workflow, "Finalize Windows installer output");

  assert.ok(configure, "Windows update feed configuration step should exist");
  assert.match(configure, /CODEX_REBUILD_UPDATE_URL=\$feed/);
  assert.match(configure, /CODEX_REBUILD_REMOTE_RELEASES=\$feed/);
  assert.doesNotMatch(configure, /CODEX_REBUILD_NO_DELTA/);

  assert.ok(full, "guaranteed full installer step should exist");
  assert.match(full, /id: windows_full/);
  assert.match(full, /timeout-minutes: 30/);
  assert.match(full, /CODEX_REBUILD_NO_DELTA: "1"/);
  assert.match(full, /npm run build:win-installer/);

  assert.ok(backup, "full installer backup step should exist");
  assert.match(backup, /out[\\/]make[\\/]squirrel\.windows[\\/]x64/);
  assert.match(backup, /out[\\/]full-only-squirrel/);
  assert.match(backup, /Move-Item/);

  assert.ok(delta, "bounded delta attempt step should exist");
  assert.match(delta, /id: windows_delta/);
  assert.match(delta, /continue-on-error: true/);
  assert.match(delta, /timeout-minutes: 10/);
  assert.match(delta, /npm run build:win-installer/);
  assert.doesNotMatch(delta, /CODEX_REBUILD_NO_DELTA/);
  if (supportsSkip) {
    assert.match(delta, /if: inputs\.skip_windows_delta != true/);
  } else {
    assert.doesNotMatch(delta, /skip_windows_delta/);
  }

  assert.ok(finalize, "installer fallback finalization step should exist");
  assert.match(finalize, /if: always\(\) && steps\.windows_full\.outcome == 'success'/);
  assert.match(finalize, /DELTA_OUTCOME: \$\{\{ steps\.windows_delta\.outcome \}\}/);
  assert.match(finalize, /\$env:DELTA_OUTCOME -ne "success"/);
  assert.match(finalize, /Move-Item/);
  assert.match(finalize, /Remove-Item/);

  const fullIndex = workflow.indexOf("name: Build guaranteed full Windows installer");
  const backupIndex = workflow.indexOf("name: Back up guaranteed full Windows installer");
  const deltaIndex = workflow.indexOf("name: Attempt Windows delta package");
  const finalizeIndex = workflow.indexOf("name: Finalize Windows installer output");
  const resolveIndex = workflow.indexOf("name: Resolve Windows artifact versions");
  assert.ok(fullIndex < backupIndex && backupIndex < deltaIndex && deltaIndex < finalizeIndex);
  assert.ok(finalizeIndex < resolveIndex, "fallback must finish before artifacts are resolved");
}

test("Windows workflows guarantee full installers and bound optional delta generation", () => {
  const buildWorkflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "build.yml"),
    "utf-8",
  );
  const syncWorkflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "sync.yml"),
    "utf-8",
  );

  assert.match(
    buildWorkflow,
    /skip_windows_delta:\s*\n(?:\s+.*\n)*?\s+default: false\s*\n\s+type: boolean/,
  );
  assertFullFirstWindowsInstallerWorkflow(buildWorkflow, { supportsSkip: true });
  assertFullFirstWindowsInstallerWorkflow(syncWorkflow, { supportsSkip: false });
});

function writePeWithoutVersionInfo(file) {
  const executable = ResEdit.NtExecutable.createEmpty(false, false);
  const resources = ResEdit.NtExecutableResource.from(executable);
  resources.entries.push({
    type: 24,
    id: 1,
    lang: 1033,
    codepage: 0,
    bin: Buffer.from("<assembly manifestVersion=\"1.0\"></assembly>", "utf8"),
  });
  resources.outputResource(executable);
  fs.writeFileSync(file, Buffer.from(executable.generate()));
}

function writePeWithVersionInfo(file) {
  const executable = ResEdit.NtExecutable.createEmpty(false, false);
  const resources = ResEdit.NtExecutableResource.from(executable);
  const version = ResEdit.Resource.VersionInfo.createEmpty();
  version.lang = 1033;
  version.setStringValues(
    { lang: 1033, codepage: 1200 },
    { CompanyName: "Preserve Me", SquirrelAwareVersion: "0" },
  );
  version.outputToResourceEntries(resources.entries);
  resources.outputResource(executable);
  fs.writeFileSync(file, Buffer.from(executable.generate()));
}

test("markSquirrelAware creates VERSIONINFO when the writable PE has none", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-squirrel-aware-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exePath = path.join(root, "Codex.exe");
  writePeWithoutVersionInfo(exePath);

  const { markSquirrelAware } = loadInstallerInternals();
  markSquirrelAware(root, "Codex.exe");

  const executable = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(executable);
  const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  assert.equal(versions.length, 1);
  assert.equal(
    versions[0].getStringValues({ lang: 1033, codepage: 1200 }).SquirrelAwareVersion,
    "1",
  );
});

test("markSquirrelAware preserves existing VERSIONINFO strings", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-squirrel-aware-existing-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exePath = path.join(root, "Codex.exe");
  writePeWithVersionInfo(exePath);

  const { markSquirrelAware } = loadInstallerInternals();
  markSquirrelAware(root, "Codex.exe");

  const executable = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(executable);
  const [version] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  assert.deepEqual(
    version.getStringValues({ lang: 1033, codepage: 1200 }),
    { CompanyName: "Preserve Me", SquirrelAwareVersion: "1" },
  );
});

test("markSquirrelAware fails when the packaged executable is missing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-squirrel-aware-missing-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { markSquirrelAware } = loadInstallerInternals();
  assert.throws(
    () => markSquirrelAware(root, "Codex.exe"),
    /packaged executable.*Codex\.exe.*not found/i,
  );
});

test("legacy Codex alias launches the primary binary without becoming Squirrel-aware", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-legacy-alias-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primaryPath = path.join(root, "ChatGPT.exe");
  const legacyPath = path.join(root, "Codex.exe");
  writePeWithoutVersionInfo(primaryPath);
  fs.writeFileSync(legacyPath, "upstream trampoline");

  const { createLegacyExecutableAlias, markSquirrelAware } = loadInstallerInternals();
  createLegacyExecutableAlias(root, "ChatGPT.exe", "Codex.exe");
  assert.deepEqual(fs.readFileSync(legacyPath), fs.readFileSync(primaryPath));

  markSquirrelAware(root, "ChatGPT.exe");
  const readSquirrelAware = (file) => {
    const executable = ResEdit.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true });
    const resources = ResEdit.NtExecutableResource.from(executable);
    const [version] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
    return version?.getStringValues({ lang: 1033, codepage: 1200 }).SquirrelAwareVersion;
  };
  assert.equal(readSquirrelAware(primaryPath), "1");
  assert.equal(readSquirrelAware(legacyPath), undefined);
});

#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const test = require("node:test");
const ResEdit = require("resedit");
const { findCachedWindowsMsix } = require("./windows-app-entry");

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

function assertWindowsUpdateFeedBranches(workflow) {
  const normalized = workflow.replace(/\r\n/g, "\n");
  const stepMatch = normalized.match(
    /      - name: Configure Windows update feed\n(?<step>[\s\S]*?)(?=\n      - name:)/,
  );
  assert.ok(stepMatch, "Configure Windows update feed step should exist");
  const runMatch = stepMatch.groups.step.match(/        run: \|\n(?<runBlock>[\s\S]*)$/);
  assert.ok(runMatch, "Configure Windows update feed should have a PowerShell run block");
  const branches = runMatch.groups.runBlock.match(
    /^(?<before>[\s\S]*?)          if \(\"\$\{\{ inputs\.skip_windows_delta \}\}\" -eq \"true\"\) \{\n(?<trueBranch>[\s\S]*?)          \} else \{\n(?<falseBranch>[\s\S]*?)          \}\n?$/,
  );
  assert.ok(branches, "update feed run block should contain the skip_windows_delta if/else");

  const { before, trueBranch, falseBranch } = branches.groups;
  assert.match(before, /CODEX_REBUILD_UPDATE_URL=\$feed/);
  assert.doesNotMatch(`${trueBranch}${falseBranch}`, /CODEX_REBUILD_UPDATE_URL/);
  assert.match(trueBranch, /CODEX_REBUILD_NO_DELTA=1/);
  assert.doesNotMatch(trueBranch, /CODEX_REBUILD_REMOTE_RELEASES/);
  assert.match(falseBranch, /CODEX_REBUILD_REMOTE_RELEASES=\$feed/);
  assert.doesNotMatch(falseBranch, /CODEX_REBUILD_NO_DELTA/);
}

test("Windows workflow configures mutually exclusive delta modes", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "build.yml"), "utf-8");
  assert.match(workflow, /skip_windows_delta:\s*\n(?:\s+.*\n)*?\s+default: false\s*\n\s+type: boolean/);
  assertWindowsUpdateFeedBranches(workflow);

  const remoteInTrueBranch = workflow.replace(
    "CODEX_REBUILD_NO_DELTA=1",
    "CODEX_REBUILD_REMOTE_RELEASES=$feed",
  );
  assert.throws(() => assertWindowsUpdateFeedBranches(remoteInTrueBranch));

  const noDeltaInFalseBranch = workflow.replace(
    "CODEX_REBUILD_REMOTE_RELEASES=$feed",
    "CODEX_REBUILD_NO_DELTA=1",
  );
  assert.throws(() => assertWindowsUpdateFeedBranches(noDeltaInFalseBranch));
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

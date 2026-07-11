#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const test = require("node:test");
const ResEdit = require("resedit");

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
    "module.exports = { markSquirrelAware };\n",
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

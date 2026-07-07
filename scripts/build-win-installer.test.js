#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "build-win-installer.js"), "utf-8");
const tempAssignmentIndex = source.indexOf("process.env.TEMP = shortTemp");
const winstallerRequireIndex = source.search(/require\(["']electron-winstaller["']\)/);

assert.ok(tempAssignmentIndex !== -1, "build-win-installer should configure a short TEMP path");
assert.ok(winstallerRequireIndex !== -1, "build-win-installer should load electron-winstaller");
assert.ok(
  winstallerRequireIndex > tempAssignmentIndex,
  "electron-winstaller must be required after TEMP/TMP/TMPDIR are set so it uses the short Squirrel temp path",
);

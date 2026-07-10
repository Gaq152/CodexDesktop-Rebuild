#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const SCRIPTS_DIR = __dirname;
const ENTRY_SCRIPTS = [
  "start-dev.js",
  "build-from-upstream.js",
  "prepare-src.js",
];
const CODEX_VENDOR_EXPORTS = [
  "getPinnedCodexVersion",
  "resolveCodexRuntime",
  "installCodexRuntime",
  "verifyCodexBinary",
];

function readScript(name) {
  return fs.readFileSync(path.join(SCRIPTS_DIR, name), "utf8");
}

for (const scriptName of ENTRY_SCRIPTS) {
  test(`${scriptName} installs the shared official Codex runtime`, () => {
    const source = readScript(scriptName);

    assert.match(source, /require\(["']\.\/codex-vendor["']\)/);
    for (const exportName of CODEX_VENDOR_EXPORTS) {
      assert.match(source, new RegExp(`\\b${exportName}\\b`));
    }
    assert.match(source, /\binstallCodexRuntime\s*\(/);
    assert.doesNotMatch(source, /@cometix\/codex/i);
    assert.doesNotMatch(source, /\bnpm\s+(?:view|pack)\b/i);
  });
}

test("bump-version.js prefers the extracted Windows ASAR package", () => {
  const source = readScript("bump-version.js");
  const windowsAsarPackage = source.indexOf(
    'path.join(SRC_DIR, "win", "_asar", "package.json")',
  );
  const platformFallback = source.indexOf(
    'path.join(SRC_DIR, plat, "package.json")',
  );

  assert.notEqual(windowsAsarPackage, -1);
  assert.ok(platformFallback === -1 || windowsAsarPackage < platformFallback);
});

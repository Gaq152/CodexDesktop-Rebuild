#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveMacAppBundle } = require("./mac-app-bundle");

function writeBundle(root, name, { bundleId, version = "26.707.41301", asar = true }) {
  const app = path.join(root, name);
  const contents = path.join(app, "Contents");
  const resources = path.join(contents, "Resources");
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>\n`);
  if (asar) fs.writeFileSync(path.join(resources, "app.asar"), "fixture");
  return app;
}

function expectError(fn, pattern) {
  assert.throws(fn, pattern);
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mac-app-bundle-"));
  try {
    const current = path.join(tmp, "current");
    const currentApp = writeBundle(current, "ChatGPT.app", { bundleId: "com.openai.codex" });
    assert.strictEqual(resolveMacAppBundle(current, { expectedVersion: "26.707.41301" }), currentApp);

    const legacy = path.join(tmp, "legacy", "archive-root");
    const legacyApp = writeBundle(legacy, "Codex.app", {
      bundleId: "com.openai.codex",
      version: "26.623.141536",
    });
    assert.strictEqual(
      resolveMacAppBundle(path.dirname(legacy), { expectedVersion: "26.623.141536" }),
      legacyApp,
    );

    const withDecoy = path.join(tmp, "with-decoy");
    const ownedApp = writeBundle(withDecoy, "ChatGPT.app", { bundleId: "com.openai.codex" });
    writeBundle(path.join(withDecoy, "nested"), "Other.app", { bundleId: "com.openai.chat" });
    assert.strictEqual(resolveMacAppBundle(withDecoy, { expectedVersion: "26.707.41301" }), ownedApp);

    const duplicate = path.join(tmp, "duplicate");
    writeBundle(duplicate, "ChatGPT.app", { bundleId: "com.openai.codex" });
    writeBundle(path.join(duplicate, "nested"), "Codex.app", { bundleId: "com.openai.codex" });
    expectError(
      () => resolveMacAppBundle(duplicate, { expectedVersion: "26.707.41301" }),
      /expected exactly 1 upstream macOS app bundle, found 2/,
    );

    const malformed = path.join(tmp, "malformed");
    writeBundle(malformed, "ChatGPT.app", { bundleId: "com.openai.codex", asar: false });
    expectError(
      () => resolveMacAppBundle(malformed, { expectedVersion: "26.707.41301" }),
      /owned macOS app bundle is incomplete.*app\.asar/,
    );

    const wrongVersion = path.join(tmp, "wrong-version");
    writeBundle(wrongVersion, "ChatGPT.app", {
      bundleId: "com.openai.codex",
      version: "26.707.99999",
    });
    expectError(
      () => resolveMacAppBundle(wrongVersion, { expectedVersion: "26.707.41301" }),
      /version 26\.707\.99999 does not match expected 26\.707\.41301/,
    );

    const missing = path.join(tmp, "missing");
    fs.mkdirSync(missing, { recursive: true });
    expectError(
      () => resolveMacAppBundle(missing, { expectedVersion: "26.707.41301" }),
      /expected exactly 1 upstream macOS app bundle, found 0/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();

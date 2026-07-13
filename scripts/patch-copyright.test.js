#!/usr/bin/env node
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  OLD_COPYRIGHT_HTML,
  NEW_COPYRIGHT_HTML,
  patchCopyrightSource,
} = require("./patch-copyright");

test("patches the newer inline About-window copyright exactly once", () => {
  const source = `const html=\`<section>${OLD_COPYRIGHT_HTML}</section>\`;`;
  const first = patchCopyrightSource(source);
  assert.equal(first.status, "patched");
  assert.equal(first.patches.length, 1);
  assert.ok(first.code.includes(NEW_COPYRIGHT_HTML));
  assert.equal(patchCopyrightSource(first.code).status, "already");
});

test("keeps the legacy copyright property target", () => {
  const source = "app.setAboutPanelOptions({copyright:`© OpenAI`})";
  const result = patchCopyrightSource(source);
  assert.equal(result.status, "patched");
  assert.match(result.code, /copyright:`© OpenAI · Cometix Space`/);
});

test("fails closed for missing or ambiguous copyright targets", () => {
  assert.throws(() => patchCopyrightSource("const unrelated='OpenAI'"), /exactly 1.*found 0/i);
  assert.throws(
    () => patchCopyrightSource(`const a=\`${OLD_COPYRIGHT_HTML}\`,b=\`${OLD_COPYRIGHT_HTML}\``),
    /exactly 1.*found 2/i,
  );
});

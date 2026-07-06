#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadPatchSource() {
  const filePath = path.join(__dirname, "patch-native-menu-i18n.js");
  const source = fs
    .readFileSync(filePath, "utf8")
    .replace(/\nmain\(\);\s*$/, "\nmodule.exports = { patchSource };\n");
  const sandbox = {
    __dirname,
    console,
    module: { exports: {} },
    process: { argv: ["node", filePath] },
    require,
  };
  vm.runInNewContext(source, sandbox, { filename: filePath });
  return sandbox.module.exports.patchSource;
}

const patchSource = loadPatchSource();

{
  const source = "let menu=[{role:`editMenu`,id:t.fo.edit},{label:`View`,submenu:[]}];";
  const { code, replacements } = patchSource(source);

  assert.ok(replacements.some((item) => item.key === "roleMenu" && item.from === "editMenu"));
  assert.ok(code.includes("label:`编辑`"));
  assert.ok(code.includes("label:`撤销`,role:`undo`"));
  assert.ok(code.includes("label:`全选`,role:`selectAll`"));
  assert.ok(!code.includes("role:`editMenu`"));
}

{
  const source = "S&&items.push({role:`copy`,enabled:state.canCopy});";
  const { code, replacements } = patchSource(source);

  assert.ok(replacements.some((item) => item.key === "role" && item.from === "copy"));
  assert.ok(code.includes("{label:`复制`,role:`copy`,enabled:state.canCopy}"));
}

{
  const source = "items.push({label:`复制`,role:`copy`,enabled:state.canCopy});";
  const { code, replacements } = patchSource(source);

  assert.strictEqual(replacements.filter((item) => item.key === "role").length, 0);
  assert.strictEqual((code.match(/label:/g) ?? []).length, 1);
}

{
  const source = "items.push({label:`Copy`,menuTitle:`Search Files…`});";
  const { code } = patchSource(source);

  assert.ok(code.includes("label:`复制`"));
  assert.ok(code.includes("menuTitle:`搜索文件...`"));
}

#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadPatchHelpers() {
  const filePath = path.join(__dirname, "patch-local-updater.js");
  const source = fs
    .readFileSync(filePath, "utf8")
    .replace(/\nmain\(\);\s*$/, "\nmodule.exports = { makeBootstrapPrefix, makePreloadPatch };\n");
  const sandbox = {
    __dirname,
    console,
    module: { exports: {} },
    process: { argv: ["node", filePath], env: {} },
    require,
  };
  vm.runInNewContext(source, sandbox, { filename: filePath });
  return sandbox.module.exports;
}

const { makeBootstrapPrefix, makePreloadPatch } = loadPatchHelpers();

{
  const bootstrap = makeBootstrapPrefix();

  assert.ok(bootstrap.includes("let isDownloadComplete=(done,total)=>"));
  assert.ok(
    bootstrap.includes(
      "setStatus(isDownloadComplete(downloadedBytes,activeDownloadSize)?'preparing':'downloading'",
    ),
  );
  assert.ok(bootstrap.includes("setStatus('ready',{error:null,downloadedBytes:state.activeDownloadSize"));
}

{
  const preload = makePreloadPatch();

  assert.ok(preload.includes("preparing:'正在准备更新...'"));
  assert.ok(preload.includes("tooltipPreparing:'下载完成，正在准备更新'"));
  assert.ok(preload.includes("titlePreparing:'正在准备更新'"));
  assert.ok(preload.includes("preparingBody:'下载已完成，正在合并差分包并准备安装。'"));
  assert.ok(preload.includes("status==='preparing'"));
}

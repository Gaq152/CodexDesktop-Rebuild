#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const WORKFLOWS = ["build.yml", "sync.yml"];

for (const workflowName of WORKFLOWS) {
  test(`${workflowName} builds each macOS architecture on a matching runner`, () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, "..", ".github", "workflows", workflowName),
      "utf8",
    );
    const buildMacJob = /^  build-mac:\s*$([\s\S]*?)(?=^  [\w-]+:\s*$)/m.exec(workflow)?.[1];

    assert.ok(buildMacJob, "build-mac job must exist");
    assert.match(buildMacJob, /runs-on: \$\{\{ matrix\.runner \}\}/);
    assert.match(
      buildMacJob,
      /include:\s*\n\s*- arch: x64\s*\n\s*runner: macos-15-intel\s*\n\s*- arch: arm64\s*\n\s*runner: macos-26/,
    );
  });
}

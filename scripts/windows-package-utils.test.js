#!/usr/bin/env node
const assert = require("assert");
const { selectWindowsMsixPackage } = require("./windows-package-utils");

const packages = [
  {
    name: "OpenAI.Codex_26.623.13972.0_arm64__2p2nqsd0c76g0.msix",
    size: "670130284",
  },
  {
    name: "OpenAI.Codex_26.623.11225.0_x64__2p2nqsd0c76g0.msix",
    size: "650000000",
  },
  {
    name: "OpenAI.Codex_26.623.13972.0_x64__2p2nqsd0c76g0.msix",
    size: "680000000",
  },
];

const selected = selectWindowsMsixPackage(packages);
assert.strictEqual(selected.name, "OpenAI.Codex_26.623.13972.0_x64__2p2nqsd0c76g0.msix");

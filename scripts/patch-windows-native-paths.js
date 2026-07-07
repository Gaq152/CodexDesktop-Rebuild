#!/usr/bin/env node
/**
 * Patch Windows-only native module loading paths that are too deep for
 * Squirrel.Windows' legacy release-package extraction.
 */
const fs = require("fs");
const path = require("path");
const { SRC_DIR, relPath } = require("./patch-util");
const {
  SERIALPORT_LOAD_BINDINGS_REL,
  patchSerialportLoadBindings,
  toNativePath,
} = require("./windows-native-relocation");

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win", "unix"].includes(arg));
  if (platform && platform !== "win") {
    console.log("  [ok] Windows native path patch only applies to Windows");
    return;
  }

  const target = path.join(SRC_DIR, "win", "_asar", toNativePath(SERIALPORT_LOAD_BINDINGS_REL));
  if (!fs.existsSync(target)) {
    console.log(`  [ok] No Windows serialport binding loader found at ${relPath(target)}`);
    return;
  }

  const source = fs.readFileSync(target, "utf-8");
  const patched = patchSerialportLoadBindings(source);
  if (patched === source) {
    console.log(`  [ok] ${relPath(target)} already patched or no matching loader`);
    return;
  }

  fs.writeFileSync(target, patched, "utf-8");
  console.log(`  [ok] ${relPath(target)}: added short native binding fallback`);
}

main();

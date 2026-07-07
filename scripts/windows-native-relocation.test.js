#!/usr/bin/env node
const assert = require("assert");

const {
  patchSerialportLoadBindings,
  WINDOWS_SHORT_UNPACKED_NATIVE_FILES,
} = require("./windows-native-relocation");

const source =
  '"use strict";\n' +
  'Object.defineProperty(exports, "__esModule", { value: true });\n' +
  'const node_gyp_build_1 = __importDefault(require("node-gyp-build"));\n' +
  'const util_1 = require("util");\n' +
  'const path_1 = require("path");\n' +
  'const binding = (0, node_gyp_build_1.default)((0, path_1.join)(__dirname, \'../\'));\n' +
  "exports.asyncClose = binding.close ? (0, util_1.promisify)(binding.close) : async () => {};\n";

const patched = patchSerialportLoadBindings(source);

assert.notStrictEqual(patched, source);
assert.ok(patched.includes("app.asar.unpacked"));
assert.ok(patched.includes("codex-native"));
assert.ok(patched.includes("serialport.node"));
assert.ok(patched.includes("node_gyp_build_1.default"));
assert.strictEqual(patchSerialportLoadBindings(patched), patched);

const serialportRelocation = WINDOWS_SHORT_UNPACKED_NATIVE_FILES.find((entry) =>
  entry.source.endsWith("serialport.node"),
);
assert.ok(serialportRelocation, "serialport native binding should be relocated");
assert.strictEqual(serialportRelocation.dest, "codex-native/serialport.node");

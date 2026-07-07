const path = require("path");

const SERIALPORT_LOAD_BINDINGS_REL =
  "node_modules/@worklouder/device-kit-oai/node_modules/@worklouder/wl-device-kit/node_modules/serialport/node_modules/@serialport/bindings-cpp/dist/load-bindings.js";

const WINDOWS_SHORT_UNPACKED_NATIVE_FILES = [
  {
    source:
      "node_modules/@worklouder/device-kit-oai/node_modules/@worklouder/wl-device-kit/node_modules/serialport/node_modules/@serialport/bindings-cpp/build/Release/serialport.node",
    dest: "codex-native/serialport.node",
  },
];

const SHORT_BINDING_MARKER = "CodexDesktop-Rebuild short native binding";

function toNativePath(...parts) {
  return path.join(...parts.map((part) => part.replaceAll("/", path.sep)));
}

function patchSerialportLoadBindings(source) {
  if (source.includes(SHORT_BINDING_MARKER)) return source;

  const needle =
    "const binding = (0, node_gyp_build_1.default)((0, path_1.join)(__dirname, '../'));";
  if (!source.includes(needle)) return source;

  const replacement = `let binding;\nif (process.platform === 'win32' && process.resourcesPath) {\n    try {\n        // ${SHORT_BINDING_MARKER}: avoid Squirrel's legacy 260-char path limit.\n        binding = require((0, path_1.join)(process.resourcesPath, 'app.asar.unpacked', 'codex-native', 'serialport.node'));\n    }\n    catch (_error) { }\n}\nif (!binding) {\n    binding = (0, node_gyp_build_1.default)((0, path_1.join)(__dirname, '../'));\n}`;

  return source.replace(needle, replacement);
}

module.exports = {
  SERIALPORT_LOAD_BINDINGS_REL,
  WINDOWS_SHORT_UNPACKED_NATIVE_FILES,
  patchSerialportLoadBindings,
  toNativePath,
};

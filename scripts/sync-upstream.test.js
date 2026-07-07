#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { extractAsarForPatching } = require("./sync-upstream");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sync-upstream-"));

  try {
    const input = path.join(tmp, "input");
    const output = path.join(tmp, "output");
    const archive = path.join(tmp, "app.asar");
    const packedFile = path.join(input, "src", "main.js");
    const nativeFile = path.join(input, "node_modules", "optional-native", "build", "Release", "native.node");

    fs.mkdirSync(path.dirname(packedFile), { recursive: true });
    fs.writeFileSync(packedFile, "console.log('patch target');\n");
    fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
    fs.writeFileSync(nativeFile, "native");

    execFileSync(
      process.execPath,
      [
        path.join(__dirname, "..", "node_modules", "@electron", "asar", "bin", "asar.mjs"),
        "pack",
        input,
        archive,
        "--unpack",
        "*.node",
      ],
      { stdio: "pipe" },
    );

    fs.rmSync(`${archive}.unpacked`, { recursive: true, force: true });

    const result = await extractAsarForPatching(archive, output);

    assert.strictEqual(fs.readFileSync(path.join(output, "src", "main.js"), "utf8"), "console.log('patch target');\n");
    assert.strictEqual(fs.existsSync(path.join(output, "node_modules", "optional-native", "build", "Release", "native.node")), false);
    assert.ok(result.missingUnpackedFiles.includes("/node_modules/optional-native/build/Release/native.node"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

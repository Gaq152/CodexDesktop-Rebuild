#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function makeReleaseLine(hash, filename, size) {
  return `${hash} ${filename} ${size}`;
}

function writePackage(file, contents = "package") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-feed-"));
try {
  const source = path.join(tmp, "source");
  const dest = path.join(tmp, "dest");
  fs.mkdirSync(source, { recursive: true });

  writePackage(path.join(source, "Codex-26.707.72221-r0010-full.nupkg"));
  writePackage(path.join(source, "Codex-26.707.72221-r0010-delta.nupkg"));
  fs.writeFileSync(
    path.join(source, "RELEASES"),
    [
      makeReleaseLine("ABCD", "Codex-26.707.72221-r0002-full.nupkg", 100),
      makeReleaseLine("BCDE", "Codex-26.707.72221-r0010-delta.nupkg", 10),
      makeReleaseLine("CDEF", "Codex-26.707.72221-r0010-full.nupkg", 200),
      "",
    ].join("\n"),
  );

  execFileSync(
    process.execPath,
    [
      path.join(__dirname, "prepare-windows-update-feed.js"),
      "--source",
      source,
      "--dest",
      dest,
    ],
    { stdio: "pipe" },
  );

  const releases = fs.readFileSync(path.join(dest, "RELEASES"), "utf8");
  assert.ok(releases.includes("Codex-26.707.72221-r0010-full.nupkg"));
  assert.ok(releases.includes("Codex-26.707.72221-r0010-delta.nupkg"));
  assert.ok(!releases.includes("Codex-26.707.72221-r0002-full.nupkg"));
  assert.ok(fs.existsSync(path.join(dest, "Codex-26.707.72221-r0010-full.nupkg")));
  assert.ok(fs.existsSync(path.join(dest, "Codex-26.707.72221-r0010-delta.nupkg")));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

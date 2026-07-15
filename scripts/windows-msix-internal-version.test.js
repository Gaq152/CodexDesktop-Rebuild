#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const crc32 = require("buffer-crc32");
const asar = require("@electron/asar");
const {
  readInternalAppVersionFromAsarStream,
  readWindowsInternalAppVersionFromMsix,
  readWindowsInternalAppVersionFromRemoteMsix,
  validateWindowsInternalAppVersion,
} = require("./windows-msix-internal-version");

function makeSingleFileZip(fileName, contents) {
  const name = Buffer.from(fileName);
  const compressed = zlib.deflateRawSync(contents);
  const crc = crc32.unsigned(contents);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(name.length, 28);

  const centralOffset = local.length + name.length + compressed.length;
  const centralDirectory = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, compressed, centralDirectory, eocd]);
}

async function createFixture(t, version = "26.707.72221") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-msix-internal-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  fs.mkdirSync(app);
  fs.writeFileSync(
    path.join(app, "package.json"),
    JSON.stringify({ name: "openai-codex-electron", productName: "Codex", version }),
  );
  fs.writeFileSync(path.join(app, "bootstrap.js"), "module.exports = true;\n");
  const asarPath = path.join(root, "app.asar");
  await asar.createPackage(app, asarPath);
  const asarBuffer = fs.readFileSync(asarPath);
  const msixBuffer = makeSingleFileZip("app/resources/app.asar", asarBuffer);
  const msixPath = path.join(root, "OpenAI.Codex_test_x64.msix");
  fs.writeFileSync(msixPath, msixBuffer);
  return { asarPath, msixBuffer, msixPath, version };
}

function rangeFetch(buffer) {
  return async (_url, options = {}) => {
    const match = String(options.headers?.Range || options.headers?.range || "")
      .match(/^bytes=(\d+)-(\d+)$/);
    if (!match) return new Response(null, { status: 400 });
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start < 0 || end < start || end >= buffer.length) {
      return new Response(null, { status: 416 });
    }
    return new Response(buffer.subarray(start, end + 1), {
      status: 206,
      headers: {
        "content-range": `bytes ${start}-${end}/${buffer.length}`,
      },
    });
  };
}

test("reads the official internal version directly from app.asar", async (t) => {
  const fixture = await createFixture(t);
  assert.equal(
    await readInternalAppVersionFromAsarStream(fs.createReadStream(fixture.asarPath)),
    fixture.version,
  );
});

test("reads the official internal version from a downloaded Windows MSIX", async (t) => {
  const fixture = await createFixture(t);
  assert.equal(await readWindowsInternalAppVersionFromMsix(fixture.msixPath), fixture.version);
});

test("reads the official internal version from remote MSIX byte ranges", async (t) => {
  const fixture = await createFixture(t);
  assert.equal(
    await readWindowsInternalAppVersionFromRemoteMsix({
      url: "https://example.test/Codex.msix",
      size: fixture.msixBuffer.length,
      fetchImpl: rangeFetch(fixture.msixBuffer),
    }),
    fixture.version,
  );
});

test("rejects non-official internal version formats", () => {
  assert.throws(() => validateWindowsInternalAppVersion("26.707.72221.0"), /numeric X\.Y\.Z/);
  assert.throws(() => validateWindowsInternalAppVersion("26.707.72221-r1"), /numeric X\.Y\.Z/);
});

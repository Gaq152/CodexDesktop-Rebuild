#!/usr/bin/env node
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const validatorPath = path.join(__dirname, "validate-windows-release-feed.js");
const VERSION = "26.707.72221-r0001";

function loadValidator() {
  assert.ok(fs.existsSync(validatorPath), "Windows release feed validator should exist");
  return require(validatorPath).validateWindowsReleaseFeed;
}

function createFeed(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-feed-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root };
}

function addPackage(feed, kind, contents = `exact ${kind} package contents`, version = VERSION) {
  const fileName = `Codex-${version}-${kind}.nupkg`;
  const packagePath = path.join(feed.root, fileName);
  const buffer = Buffer.from(contents);
  fs.writeFileSync(packagePath, buffer);
  return {
    fileName,
    packagePath,
    sha1: crypto.createHash("sha1").update(buffer).digest("hex"),
    size: buffer.length,
  };
}

function releaseLine(pkg, overrides = {}) {
  return `${overrides.sha1 ?? pkg.sha1} ${overrides.fileName ?? pkg.fileName} ${overrides.size ?? pkg.size}`;
}

function writeReleases(feed, lines) {
  fs.writeFileSync(path.join(feed.root, "RELEASES"), `${lines.join("\n")}\n`);
}

test("accepts one exact full package with matching SHA1 and size", async (t) => {
  const validateWindowsReleaseFeed = loadValidator();
  const feed = createFeed(t);
  const full = addPackage(feed, "full");
  writeReleases(feed, [releaseLine(full, { sha1: full.sha1.toUpperCase() })]);

  assert.deepEqual(await validateWindowsReleaseFeed({ root: feed.root, version: VERSION }), {
    full: { fileName: full.fileName, sha1: full.sha1, size: full.size },
    delta: null,
  });
});

test("accepts one exact full package plus one exact optional delta", async (t) => {
  const validateWindowsReleaseFeed = loadValidator();
  const feed = createFeed(t);
  const full = addPackage(feed, "full");
  const delta = addPackage(feed, "delta");
  writeReleases(feed, [releaseLine(delta), releaseLine(full)]);

  assert.deepEqual(await validateWindowsReleaseFeed({ root: feed.root, version: VERSION }), {
    full: { fileName: full.fileName, sha1: full.sha1, size: full.size },
    delta: { fileName: delta.fileName, sha1: delta.sha1, size: delta.size },
  });
});

test("rejects missing full duplicate wrong-version and malformed RELEASES entries", async (t) => {
  const validateWindowsReleaseFeed = loadValidator();

  await t.test("empty", async (t) => {
    const feed = createFeed(t);
    fs.writeFileSync(path.join(feed.root, "RELEASES"), "\n");
    await assert.rejects(
      () => validateWindowsReleaseFeed({ root: feed.root, version: VERSION }),
      /one or two|full package/i,
    );
  });

  await t.test("delta only", async (t) => {
    const feed = createFeed(t);
    const delta = addPackage(feed, "delta");
    writeReleases(feed, [releaseLine(delta)]);
    await assert.rejects(
      () => validateWindowsReleaseFeed({ root: feed.root, version: VERSION }),
      /required full package/i,
    );
  });

  await t.test("duplicate full", async (t) => {
    const feed = createFeed(t);
    const full = addPackage(feed, "full");
    writeReleases(feed, [releaseLine(full), releaseLine(full)]);
    await assert.rejects(
      () => validateWindowsReleaseFeed({ root: feed.root, version: VERSION }),
      /duplicate.*full/i,
    );
  });

  await t.test("other version", async (t) => {
    const feed = createFeed(t);
    const other = addPackage(feed, "full", "old package", "26.707.72221-r0002");
    writeReleases(feed, [releaseLine(other)]);
    await assert.rejects(
      () => validateWindowsReleaseFeed({ root: feed.root, version: VERSION }),
      /exact.*package|version/i,
    );
  });

  await t.test("malformed SHA1", async (t) => {
    const feed = createFeed(t);
    const full = addPackage(feed, "full");
    writeReleases(feed, [releaseLine(full, { sha1: full.sha1.slice(1) })]);
    await assert.rejects(
      () => validateWindowsReleaseFeed({ root: feed.root, version: VERSION }),
      /40-hex SHA1/i,
    );
  });
});

test("rejects hashes and sizes that do not match either referenced package", async (t) => {
  const validateWindowsReleaseFeed = loadValidator();
  const feed = createFeed(t);
  const full = addPackage(feed, "full");
  const delta = addPackage(feed, "delta");

  writeReleases(feed, [releaseLine(full, { sha1: "0".repeat(40) }), releaseLine(delta)]);
  await assert.rejects(
    () => validateWindowsReleaseFeed({ root: feed.root, version: VERSION }),
    /full.*SHA1 mismatch/i,
  );

  writeReleases(feed, [releaseLine(full), releaseLine(delta, { size: delta.size + 1 })]);
  await assert.rejects(
    () => validateWindowsReleaseFeed({ root: feed.root, version: VERSION }),
    /delta.*size mismatch/i,
  );
});

test("rejects unreferenced nupkg files beside the declared feed", async (t) => {
  const validateWindowsReleaseFeed = loadValidator();
  const feed = createFeed(t);
  const full = addPackage(feed, "full");
  addPackage(feed, "delta");
  writeReleases(feed, [releaseLine(full)]);

  await assert.rejects(
    () => validateWindowsReleaseFeed({ root: feed.root, version: VERSION }),
    /unreferenced.*delta\.nupkg/i,
  );
});

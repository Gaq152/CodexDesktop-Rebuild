#!/usr/bin/env node
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const validatorPath = path.join(__dirname, "validate-windows-release-feed.js");
const VERSION = "26.707.31428";

function loadValidator() {
  assert.ok(fs.existsSync(validatorPath), "Windows release feed validator should exist");
  return require(validatorPath).validateWindowsReleaseFeed;
}

function createFeed(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-feed-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fileName = `Codex-${VERSION}-full.nupkg`;
  const packagePath = path.join(root, fileName);
  const contents = Buffer.from("exact full package contents");
  fs.writeFileSync(packagePath, contents);
  const sha1 = crypto.createHash("sha1").update(contents).digest("hex");
  return { root, fileName, packagePath, size: contents.length, sha1 };
}

test("accepts one exact full-package RELEASES entry with matching SHA1 and size", async (t) => {
  const validateWindowsReleaseFeed = loadValidator();
  const feed = createFeed(t);
  fs.writeFileSync(
    path.join(feed.root, "RELEASES"),
    `${feed.sha1.toUpperCase()} ${feed.fileName} ${feed.size}\n`,
  );

  assert.deepEqual(await validateWindowsReleaseFeed({ root: feed.root, version: VERSION }), {
    fileName: feed.fileName,
    sha1: feed.sha1,
    size: feed.size,
  });
});

test("rejects empty multiple delta other-version and malformed RELEASES entries", async (t) => {
  const validateWindowsReleaseFeed = loadValidator();
  const feed = createFeed(t);
  const exactLine = `${feed.sha1} ${feed.fileName} ${feed.size}`;
  const cases = {
    empty: "\n",
    multiple: `${exactLine}\n${exactLine}\n`,
    delta: `${feed.sha1} Codex-${VERSION}-delta.nupkg ${feed.size}\n`,
    "other version": `${feed.sha1} Codex-26.707.31427-full.nupkg ${feed.size}\n`,
    "malformed SHA1": `${feed.sha1.slice(1)} ${feed.fileName} ${feed.size}\n`,
  };

  for (const [name, releases] of Object.entries(cases)) {
    await t.test(name, async () => {
      fs.writeFileSync(path.join(feed.root, "RELEASES"), releases);
      await assert.rejects(
        () => validateWindowsReleaseFeed({ root: feed.root, version: VERSION }),
        /RELEASES|exactly one|full package|SHA1|version/i,
      );
    });
  }
});

test("rejects RELEASES hashes and sizes that do not match the full package", async (t) => {
  const validateWindowsReleaseFeed = loadValidator();
  const feed = createFeed(t);
  const releasesPath = path.join(feed.root, "RELEASES");

  fs.writeFileSync(releasesPath, `${"0".repeat(40)} ${feed.fileName} ${feed.size}\n`);
  await assert.rejects(
    () => validateWindowsReleaseFeed({ root: feed.root, version: VERSION }),
    /SHA1.*mismatch/i,
  );

  fs.writeFileSync(releasesPath, `${feed.sha1} ${feed.fileName} ${feed.size + 1}\n`);
  await assert.rejects(
    () => validateWindowsReleaseFeed({ root: feed.root, version: VERSION }),
    /size.*mismatch/i,
  );
});

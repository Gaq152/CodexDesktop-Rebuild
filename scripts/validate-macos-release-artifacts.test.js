#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  validateReleaseVersion,
  validateMacosAssetEntries,
  validateMacosReleaseArtifacts,
} = require("./validate-macos-release-artifacts");

const EXPECTED_VERSION = "26.707.51957";

function writeFile(root, relativePath, contents = "dmg") {
  const filePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeMinimalDmg(root, relativePath) {
  const contents = Buffer.alloc(512);
  contents.write("koly", 0, "ascii");
  writeFile(root, relativePath, contents);
}

function createExactFixture(root, version = EXPECTED_VERSION) {
  writeMinimalDmg(root, `arm64/Codex-mac-arm64-${version}.dmg`);
  writeMinimalDmg(root, `x64/Codex-mac-x64-${version}.dmg`);
}

function withTempDir(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-macos-promotion-"));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("accepts exactly the two non-empty architecture DMGs", () => {
  withTempDir((root) => {
    createExactFixture(root);
    assert.deepEqual(validateMacosReleaseArtifacts(root, EXPECTED_VERSION), {
      version: EXPECTED_VERSION,
      assets: [
        `Codex-mac-arm64-${EXPECTED_VERSION}.dmg`,
        `Codex-mac-x64-${EXPECTED_VERSION}.dmg`,
      ],
    });
  });
});

test("accepts any strictly numeric three-part release version", () => {
  for (const version of ["26.707.41301", "1.2.3"]) {
    withTempDir((root) => {
      createExactFixture(root, version);
      assert.equal(validateReleaseVersion(version), version);
      assert.deepEqual(validateMacosReleaseArtifacts(root, version), {
        version,
        assets: [
          `Codex-mac-arm64-${version}.dmg`,
          `Codex-mac-x64-${version}.dmg`,
        ],
      });
    });
  }
});

test("rejects a missing architecture DMG", () => {
  withTempDir((root) => {
    writeFile(root, `arm64/Codex-mac-arm64-${EXPECTED_VERSION}.dmg`);
    assert.throws(
      () => validateMacosReleaseArtifacts(root, EXPECTED_VERSION),
      /missing.*x64|expected exactly/i,
    );
  });
});

test("rejects wrong versions, swapped architectures, duplicates, and extra assets", async (t) => {
  const cases = [
    {
      name: "wrong version",
      mutate(root) {
        fs.renameSync(
          path.join(root, "arm64", `Codex-mac-arm64-${EXPECTED_VERSION}.dmg`),
          path.join(root, "arm64", "Codex-mac-arm64-26.707.31428.dmg"),
        );
      },
    },
    {
      name: "swapped architecture",
      mutate(root) {
        fs.renameSync(
          path.join(root, "arm64", `Codex-mac-arm64-${EXPECTED_VERSION}.dmg`),
          path.join(root, "arm64", `Codex-mac-x64-${EXPECTED_VERSION}.dmg`),
        );
      },
    },
    {
      name: "nested duplicate",
      mutate(root) {
        writeFile(root, `arm64/nested/Codex-mac-arm64-${EXPECTED_VERSION}.dmg`);
      },
    },
    {
      name: "third dmg",
      mutate(root) {
        writeFile(root, `arm64/Codex-mac-universal-${EXPECTED_VERSION}.dmg`);
      },
    },
    {
      name: "Windows archive",
      mutate(root) {
        writeFile(root, `Codex-win-x64-${EXPECTED_VERSION}.zip`);
      },
    },
    {
      name: "update feed",
      mutate(root) {
        writeFile(root, "RELEASES");
      },
    },
    {
      name: "arbitrary text",
      mutate(root) {
        writeFile(root, "notes.txt");
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => withTempDir((root) => {
      createExactFixture(root);
      fixture.mutate(root);
      assert.throws(
        () => validateMacosReleaseArtifacts(root, EXPECTED_VERSION),
        /unexpected|missing|expected exactly/i,
      );
    }));
  }
});

test("rejects an empty expected DMG", () => {
  withTempDir((root) => {
    createExactFixture(root);
    fs.writeFileSync(path.join(root, "x64", `Codex-mac-x64-${EXPECTED_VERSION}.dmg`), "");
    assert.throws(
      () => validateMacosReleaseArtifacts(root, EXPECTED_VERSION),
      /non-empty|empty/i,
    );
  });
});

test("rejects non-UDIF payloads and misplaced koly magic", async (t) => {
  const cases = [
    {
      name: "plain text padded to the minimum size",
      contents: Buffer.alloc(512, "x"),
    },
    {
      name: "koly at the start but not at the final 512-byte trailer",
      contents: Buffer.concat([Buffer.from("koly"), Buffer.alloc(1020)]),
    },
    {
      name: "koly at the end instead of the start of the trailer",
      contents: Buffer.concat([Buffer.alloc(508), Buffer.from("koly")]),
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => withTempDir((root) => {
      createExactFixture(root);
      fs.writeFileSync(
        path.join(root, "arm64", `Codex-mac-arm64-${EXPECTED_VERSION}.dmg`),
        fixture.contents,
      );
      assert.throws(
        () => validateMacosReleaseArtifacts(root, EXPECTED_VERSION),
        /UDIF|koly|trailer/i,
      );
    }));
  }
});

test("rejects symbolic-link entries without following them", () => {
  assert.throws(
    () => validateMacosAssetEntries([
      {
        path: `arm64/Codex-mac-arm64-${EXPECTED_VERSION}.dmg`,
        type: "symlink",
        size: 9,
      },
      {
        path: `x64/Codex-mac-x64-${EXPECTED_VERSION}.dmg`,
        type: "file",
        size: 512,
        trailerMagic: "koly",
      },
    ], EXPECTED_VERSION),
    /symbolic link|symlink/i,
  );
});

test("rejects malformed release versions before inspecting artifacts", async (t) => {
  const invalidVersions = [
    undefined,
    "",
    "26.707",
    "26.707.51957.1",
    "v26.707.51957",
    "26.beta.51957",
    "26.707.51957-beta",
    " 26.707.51957",
    "26.707.51957 ",
    "26/707/51957",
    "26\\707\\51957",
  ];
  for (const version of invalidVersions) {
    await t.test(String(version), () => {
      assert.throws(
        () => validateMacosAssetEntries([], version),
        /release version.*numeric X\.Y\.Z|invalid.*version/i,
      );
    });
  }
});

test("rejects a missing artifact root", () => {
  assert.throws(
    () =>
      validateMacosReleaseArtifacts(
        path.join(os.tmpdir(), "codex-missing-promotion-root"),
        EXPECTED_VERSION,
      ),
    /does not exist/i,
  );
});

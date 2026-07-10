#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  getPinnedCodexVersion,
  installCodexRuntime,
  resolveCodexRuntime,
  verifyCodexBinary,
} = require("./codex-vendor");

const FIXTURES = {
  win: {
    suffix: "win32-x64",
    target: "x86_64-pc-windows-msvc",
    entrypoint: "bin/codex.exe",
    files: [
      "bin/codex-code-mode-host.exe",
      "bin/codex.exe",
      "codex-path/rg.exe",
      "codex-resources/codex-command-runner.exe",
      "codex-resources/codex-windows-sandbox-setup.exe",
    ],
  },
  "linux-x64": {
    suffix: "linux-x64",
    target: "x86_64-unknown-linux-musl",
    entrypoint: "bin/codex",
    files: [
      "bin/codex",
      "bin/codex-code-mode-host",
      "codex-path/rg",
      "codex-resources/codex-command-runner",
    ],
  },
};

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function createProject(t, pin = "0.144.1") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-vendor-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeJson(path.join(root, "package.json"), {
    optionalDependencies: { "@openai/codex": pin },
  });
  writeJson(path.join(root, "node_modules", "@openai", "codex", "package.json"), {
    name: "@openai/codex",
    version: pin,
  });

  return { root, output: path.join(root, "resources") };
}

function aliasRootFor(projectRoot, fixture, layout) {
  const base = path.join(projectRoot, "node_modules", "@openai");
  return layout === "nested"
    ? path.join(base, "codex", "node_modules", "@openai", `codex-${fixture.suffix}`)
    : path.join(base, `codex-${fixture.suffix}`);
}

function createOfficialLayout(project, options = {}) {
  const platform = options.platform || "win";
  const layout = options.layout || "hoisted";
  const fixture = FIXTURES[platform];
  const aliasRoot = aliasRootFor(project.root, fixture, layout);
  const targetRoot = path.join(aliasRoot, "vendor", fixture.target);
  const manifestPath = path.join(targetRoot, "codex-package.json");
  const version = options.version || "0.144.1";

  writeJson(path.join(aliasRoot, "package.json"), {
    // The real platform package deliberately uses the base package name.
    name: "@openai/codex",
    version: options.aliasVersion || `${version}-${fixture.suffix}`,
  });
  writeJson(manifestPath, {
    layoutVersion: 1,
    version,
    target: fixture.target,
    variant: "codex",
    entrypoint: fixture.entrypoint,
    pathDir: "codex-path",
    resourcesDir: "codex-resources",
    ...options.manifest,
  });

  const contents = new Map();
  for (const relativeFile of fixture.files) {
    const file = path.join(targetRoot, relativeFile);
    const content = `${layout}:${platform}:${relativeFile}:${version}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    contents.set(path.basename(file), content);
  }

  return {
    aliasRoot,
    codexExe: path.join(targetRoot, fixture.entrypoint),
    contents,
    manifestPath,
    targetRoot,
  };
}

function mutateManifest(runtimeFixture, changes) {
  writeJson(runtimeFixture.manifestPath, {
    ...readJson(runtimeFixture.manifestPath),
    ...changes,
  });
}

test("accepts a bare exact official Codex version", (t) => {
  const project = createProject(t);
  assert.equal(getPinnedCodexVersion(project.root), "0.144.1");
});

for (const [name, pin] of [
  ["missing", undefined],
  ["range", "^0.144.1"],
  ["tag", "latest"],
  ["protocol", "npm:@openai/codex@0.144.1"],
  ["leading whitespace", " 0.144.1"],
  ["trailing whitespace", "0.144.1 "],
]) {
  test(`rejects a ${name} official Codex version`, (t) => {
    const project = createProject(t);
    const packageJson = readJson(path.join(project.root, "package.json"));
    if (pin === undefined) {
      delete packageJson.optionalDependencies["@openai/codex"];
    } else {
      packageJson.optionalDependencies["@openai/codex"] = pin;
    }
    writeJson(path.join(project.root, "package.json"), packageJson);

    assert.throws(() => getPinnedCodexVersion(project.root), /exact version/);
  });
}

test("rejects a stale installed base package", (t) => {
  const project = createProject(t);
  writeJson(path.join(project.root, "node_modules", "@openai", "codex", "package.json"), {
    name: "@openai/codex",
    version: "0.143.0",
  });
  createOfficialLayout(project);

  assert.throws(
    () => resolveCodexRuntime(project.root, "win"),
    /installed @openai\/codex.*expected 0\.144\.1/,
  );
});

for (const layout of ["nested", "hoisted"]) {
  test(`resolves the ${layout} official platform package`, (t) => {
    const project = createProject(t);
    const fixture = createOfficialLayout(project, { layout });

    const runtime = resolveCodexRuntime(project.root, "win");

    assert.equal(runtime.version, "0.144.1");
    assert.equal(runtime.target, FIXTURES.win.target);
    assert.equal(runtime.entrypoint, fixture.codexExe);
  });
}

test("prefers the nested platform package over a hoisted package", (t) => {
  const project = createProject(t);
  createOfficialLayout(project, { layout: "hoisted" });
  const nested = createOfficialLayout(project, { layout: "nested" });

  assert.equal(resolveCodexRuntime(project.root, "win").entrypoint, nested.codexExe);
});

test("does not hide a corrupt nested package with a valid hoisted package", (t) => {
  const project = createProject(t);
  createOfficialLayout(project, { layout: "hoisted" });
  const nested = createOfficialLayout(project, {
    aliasVersion: "0.143.0-win32-x64",
    layout: "nested",
  });

  assert.throws(
    () => resolveCodexRuntime(project.root, "win"),
    (error) =>
      /platform package.*expected 0\.144\.1-win32-x64/.test(error.message) &&
      error.message.includes(nested.aliasRoot),
  );
});

test("reports both searched paths when the platform package is missing", (t) => {
  const project = createProject(t);
  const nested = aliasRootFor(project.root, FIXTURES.win, "nested");
  const hoisted = aliasRootFor(project.root, FIXTURES.win, "hoisted");

  assert.throws(
    () => resolveCodexRuntime(project.root, "win"),
    (error) =>
      error.message.includes("win") &&
      error.message.includes("0.144.1") &&
      error.message.includes(nested) &&
      error.message.includes(hoisted),
  );
});

test("rejects an unsupported platform", (t) => {
  const project = createProject(t);
  assert.throws(() => resolveCodexRuntime(project.root, "plan9-x64"), /unsupported platform/);
});

test("rejects a mismatched platform package version", (t) => {
  const project = createProject(t);
  createOfficialLayout(project, { aliasVersion: "0.143.0-win32-x64" });

  assert.throws(
    () => resolveCodexRuntime(project.root, "win"),
    /expected 0\.144\.1-win32-x64/,
  );
});

for (const [name, manifest, expectedError] of [
  ["manifest version", { version: "0.143.0" }, /expected 0\.144\.1/],
  ["target", { target: "wrong-target" }, /expected x86_64-pc-windows-msvc/],
  ["layout version", { layoutVersion: 2 }, /layoutVersion.*expected 1/],
  ["variant", { variant: "shell" }, /variant.*expected codex/],
]) {
  test(`rejects a mismatched ${name}`, (t) => {
    const project = createProject(t);
    createOfficialLayout(project, { manifest });
    assert.throws(() => resolveCodexRuntime(project.root, "win"), expectedError);
  });
}

test("rejects absolute and escaping manifest paths", async (t) => {
  for (const [field, value] of [
    ["entrypoint", path.resolve(os.tmpdir(), "outside-codex.exe")],
    ["pathDir", "../outside-path"],
    ["resourcesDir", "codex-resources/../../outside-resources"],
  ]) {
    await t.test(field, (t) => {
      const project = createProject(t);
      createOfficialLayout(project, { manifest: { [field]: value } });
      assert.throws(
        () => resolveCodexRuntime(project.root, "win"),
        new RegExp(`${field}.*relative path|${field}.*escapes`),
      );
    });
  }
});

test("rejects missing or incorrectly typed runtime files", async (t) => {
  for (const mutation of [
    {
      name: "missing entrypoint",
      apply(fixture) {
        fs.rmSync(fixture.codexExe);
      },
      error: /entrypoint.*regular file/,
    },
    {
      name: "entrypoint directory",
      apply(fixture) {
        fs.rmSync(fixture.codexExe);
        fs.mkdirSync(fixture.codexExe);
      },
      error: /entrypoint.*regular file/,
    },
    {
      name: "pathDir file",
      apply(fixture) {
        const dir = path.join(fixture.targetRoot, "codex-path");
        fs.rmSync(dir, { recursive: true });
        fs.writeFileSync(dir, "not a directory");
      },
      error: /pathDir.*directory/,
    },
    {
      name: "missing resourcesDir",
      apply(fixture) {
        fs.rmSync(path.join(fixture.targetRoot, "codex-resources"), { recursive: true });
      },
      error: /resourcesDir.*directory/,
    },
  ]) {
    await t.test(mutation.name, (t) => {
      const project = createProject(t);
      const fixture = createOfficialLayout(project);
      mutation.apply(fixture);
      assert.throws(() => resolveCodexRuntime(project.root, "win"), mutation.error);
    });
  }
});

test("rejects a symlinked manifest directory", (t) => {
  const project = createProject(t);
  const fixture = createOfficialLayout(project);
  const pathDir = path.join(fixture.targetRoot, "codex-path");
  const outside = path.join(project.root, "outside-path");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "rg.exe"), "outside");
  fs.rmSync(pathDir, { recursive: true });
  try {
    fs.symlinkSync(outside, pathDir, "junction");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  assert.throws(() => resolveCodexRuntime(project.root, "win"), /pathDir.*symlink/);
});

test("collects the official Windows asset set once in stable order", (t) => {
  const project = createProject(t);
  createOfficialLayout(project);

  const assets = resolveCodexRuntime(project.root, "win").assets;

  assert.deepEqual(assets, [...assets].sort());
  assert.equal(new Set(assets).size, assets.length);
  assert.deepEqual(
    assets.map((file) => path.basename(file)).sort(),
    [
      "codex-code-mode-host.exe",
      "codex-command-runner.exe",
      "codex-windows-sandbox-setup.exe",
      "codex.exe",
      "rg.exe",
    ],
  );
});

test("copies assets flat and overwrites stale destination files", (t) => {
  const project = createProject(t);
  const fixture = createOfficialLayout(project);
  const runtime = resolveCodexRuntime(project.root, "win");
  fs.mkdirSync(project.output, { recursive: true });
  for (const name of fixture.contents.keys()) {
    fs.writeFileSync(path.join(project.output, name), "stale-0.142.5");
  }

  const copied = installCodexRuntime(runtime, project.output);

  assert.deepEqual(copied, [...copied].sort());
  assert.deepEqual(
    copied.map((file) => path.basename(file)).sort(),
    [...fixture.contents.keys()].sort(),
  );
  for (const destination of copied) {
    assert.equal(fs.readFileSync(destination, "utf8"), fixture.contents.get(path.basename(destination)));
  }
});

test("detects duplicate flattened basenames before writing", (t) => {
  const project = createProject(t);
  const fixture = createOfficialLayout(project);
  fs.writeFileSync(path.join(fixture.targetRoot, "codex-resources", "rg.exe"), "collision");
  const runtime = resolveCodexRuntime(project.root, "win");
  fs.mkdirSync(project.output, { recursive: true });
  const staleRg = path.join(project.output, "rg.exe");
  fs.writeFileSync(staleRg, "must remain unchanged");

  assert.throws(() => installCodexRuntime(runtime, project.output), /duplicate basename.*rg\.exe/);
  assert.equal(fs.readFileSync(staleRg, "utf8"), "must remain unchanged");
  assert.equal(fs.existsSync(path.join(project.output, "codex.exe")), false);
});

test("revalidates source containment before copying", (t) => {
  const project = createProject(t);
  createOfficialLayout(project);
  const runtime = resolveCodexRuntime(project.root, "win");
  const outside = path.join(project.root, "outside.exe");
  fs.writeFileSync(outside, "outside");
  runtime.assets = [outside];

  assert.throws(() => installCodexRuntime(runtime, project.output), /outside runtime target/);
  assert.equal(fs.existsSync(project.output), false);
});

test(
  "preserves POSIX executable bits",
  { skip: process.platform === "win32" ? "POSIX mode bits are not meaningful on Windows" : false },
  (t) => {
    const project = createProject(t);
    createOfficialLayout(project, { platform: "linux-x64" });
    const runtime = resolveCodexRuntime(project.root, "linux-x64");

    const copied = installCodexRuntime(runtime, project.output);

    for (const destination of copied) {
      assert.equal(fs.statSync(destination).mode & 0o111, 0o111, path.basename(destination));
    }
  },
);

test("verifies the exact Codex CLI version without a shell", (t) => {
  const project = createProject(t);
  const binary = path.join(project.root, "codex.exe");
  const calls = [];
  const runner = (...args) => {
    calls.push(args);
    return "codex-cli 0.144.1\n";
  };

  assert.equal(verifyCodexBinary(binary, "0.144.1", runner), undefined);
  assert.deepEqual(calls, [[binary, ["--version"], { encoding: "utf8" }]]);
});

for (const [name, output] of [
  ["older version", "codex-cli 0.143.0"],
  ["prefix-matching newer version", "codex-cli 0.144.10"],
  ["extra output", "codex-cli 0.144.1 extra"],
  ["malformed output", "Codex CLI version 0.144.1"],
]) {
  test(`rejects ${name} from Codex --version`, (t) => {
    const project = createProject(t);
    assert.throws(
      () => verifyCodexBinary(path.join(project.root, "codex.exe"), "0.144.1", () => output),
      /expected 0\.144\.1/,
    );
  });
}

test("reports binary execution failures with path and expected version", (t) => {
  const project = createProject(t);
  const binary = path.join(project.root, "codex.exe");

  assert.throws(
    () =>
      verifyCodexBinary(binary, "0.144.1", () => {
        throw new Error("spawn failed");
      }),
    (error) =>
      error.message.includes(binary) &&
      error.message.includes("0.144.1") &&
      error.message.includes("spawn failed"),
  );
});

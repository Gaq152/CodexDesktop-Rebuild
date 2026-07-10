#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { verifyPatchedApp } = require("./verify-patched-app");

const EXPECTED_VERSION = "26.707.31428";
const CONTRACT_IDS = [
  "fast",
  "plugin",
  "archive-delete",
  "sidebar-delete",
  "updater",
];

const MARKERS = [
  {
    id: "fast-mode",
    contract: "fast",
    file: "webview/assets/fast-mode.js",
    text: "const selectedTier = `fast_mode`;",
  },
  {
    id: "fast-api-key-authorization",
    contract: "fast",
    file: "webview/assets/fast-mode.js",
    text: "const fastAllowed = authMethod === `chatgpt` || authMethod === `apikey`;",
  },
  {
    id: "browser-availability",
    contract: "plugin",
    file: ".vite/build/main-features.js",
    text: "const desktopFeatures = { inAppBrowserUse:!0 };",
  },
  {
    id: "computer-availability",
    contract: "plugin",
    file: ".vite/build/main-features.js",
    text: "const computerFeatures = { computerUse:!0 };",
  },
  {
    id: "plugin-availability",
    contract: "plugin",
    file: ".vite/build/main-features.js",
    text: [
      "function setupBundledPlugins(features) {",
      "  const selectBundledPlugins = current => bundledPlugins.filter(()=>!0);",
      "  const reconcile = () => {",
      "    const descriptors = selectBundledPlugins(features);",
      "    logger.info(`bundled_plugins_reconcile_started`);",
      "    return install({ marketplacePluginDescriptors:descriptors });",
      "  };",
      "  return reconcile;",
      "}",
    ].join("\n"),
  },
  {
    id: "delete-route",
    contract: "archive-delete",
    file: "webview/assets/app-main.js",
    text: "routes[`delete-conversation`] = deleteConversation;",
  },
  {
    id: "delete-protocol",
    contract: "archive-delete",
    file: "webview/assets/app-main.js",
    text: "manager.sendRequest(`thread/delete`, { threadId });",
  },
  {
    id: "sidebar-delete",
    contract: "sidebar-delete",
    file: "webview/assets/sidebar.js",
    text: "const deleteItem = { id:`delete-thread` };",
  },
  {
    id: "sidebar-inline-confirmation",
    contract: "sidebar-delete",
    file: "webview/assets/sidebar.js",
    text: "const confirmItem = { id:`thread-delete-confirm-action` };",
  },
  {
    id: "updater-bootstrap",
    contract: "updater",
    file: ".vite/build/bootstrap.js",
    text: "/* CodexRebuildLocalUpdater:start */",
  },
  {
    id: "updater-preload-bridge",
    contract: "updater",
    file: ".vite/build/preload.js",
    text: "contextBridge.exposeInMainWorld(`codexRebuildUpdater`, updaterApi);",
  },
  {
    id: "updater-titlebar",
    contract: "updater",
    file: "webview/assets/windows-titlebar.js",
    text: "const updaterMenu = { id:`codex-rebuild-updater-top` };",
  },
];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function writeText(filePath, text, append = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (append) fs.appendFileSync(filePath, `\n${text}\n`);
  else fs.writeFileSync(filePath, `${text}\n`);
}

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-patched-app-"));
  const asarRoot = path.join(root, "src", "win", "_asar");
  fs.mkdirSync(asarRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  if (!options.omitPackage) {
    const packageJson = options.packageText ?? JSON.stringify({
      name: "openai-codex-electron",
      version: options.version ?? EXPECTED_VERSION,
    });
    writeText(path.join(asarRoot, "package.json"), packageJson);
  }

  const omitted = new Set(options.omitMarkers ?? []);
  const includedMarkers = new Set(
    MARKERS.filter((marker) => !omitted.has(marker.id)).map((marker) => marker.id),
  );
  const fixture = { root, asarRoot, includedMarkers };
  for (const file of new Set(MARKERS.map((marker) => marker.file))) {
    writeMarkerFile(fixture, file);
  }

  return fixture;
}

function addMarker(fixture, marker) {
  fixture.includedMarkers.add(marker.id);
  writeMarkerFile(fixture, marker.file);
}

function writeMarkerFile(fixture, relativeFile) {
  const markers = MARKERS.filter(
    (marker) =>
      marker.file === relativeFile && fixture.includedMarkers.has(marker.id),
  );
  if (markers.length === 0) return;

  let source = markers.map((marker) => marker.text).join("\n");
  if (relativeFile === "webview/assets/fast-mode.js") {
    source = `function fastSettings(authMethod, requirements) {\n${source}\n}`;
  } else if (relativeFile === ".vite/build/main-features.js") {
    const browserValue = fixture.includedMarkers.has("browser-availability")
      ? "!0"
      : "!1";
    const computerValue = fixture.includedMarkers.has("computer-availability")
      ? "!0"
      : "!1";
    const pluginMarker = MARKERS.find(
      (marker) => marker.id === "plugin-availability",
    );
    source = [
      `const desktopFeatures = { browserPane:${browserValue}, inAppBrowserUse:${browserValue}, inAppBrowserUseAllowed:${browserValue}, externalBrowserUse:${browserValue}, externalBrowserUseAllowed:${browserValue}, computerUse:${computerValue}, computerUseNodeRepl:${computerValue}, control:!0, multiWindow:!0 };`,
      "const desktopFeatureKeys = Object.keys(desktopFeatures);",
      fixture.includedMarkers.has(pluginMarker.id) ? pluginMarker.text : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  writeText(path.join(fixture.asarRoot, relativeFile), source);
}

for (const marker of MARKERS) {
  test(`${marker.contract} fails closed without ${marker.id}`, (t) => {
    const fixture = createFixture(t, { omitMarkers: [marker.id] });

    assert.throws(
      () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
      (error) => error.message.includes(marker.contract),
    );

    addMarker(fixture, marker);
    const result = verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION);
    const expectedFile = toPosix(path.join("src", "win", "_asar", marker.file));
    assert.ok(result.contracts[marker.contract].includes(expectedFile));
  });
}

for (const [contract, markerIds] of [
  ["fast", ["fast-mode", "fast-api-key-authorization"]],
  ["archive-delete", ["delete-route", "delete-protocol"]],
  ["sidebar-delete", ["sidebar-delete", "sidebar-inline-confirmation"]],
]) {
  test(`${contract} requires its markers in the same bundle`, (t) => {
    const fixture = createFixture(t, { omitMarkers: markerIds });
    markerIds.forEach((markerId, index) => {
      const marker = MARKERS.find((candidate) => candidate.id === markerId);
      writeText(
        path.join(fixture.asarRoot, "split", `${contract}-${index}.js`),
        marker.text,
      );
    });

    assert.throws(
      () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
      (error) => error.message.includes(contract),
    );
  });
}

test("fast rejects unrelated same-bundle authorization evidence", (t) => {
  const fixture = createFixture(t, {
    omitMarkers: ["fast-mode", "fast-api-key-authorization"],
  });
  writeText(
    path.join(fixture.asarRoot, "webview", "assets", "fast-decoy.js"),
    [
      "function fastSettings(authMethod, requirements) {",
      "  const allowed = authMethod === `chatgpt`;",
      "  return requirements.fast_mode && allowed;",
      "}",
      "function unrelated(otherAuth) { return otherAuth === `apikey`; }",
    ].join("\n"),
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("fast"),
  );
});

test("plugin rejects unrelated availability decoys", (t) => {
  const fixture = createFixture(t, {
    omitMarkers: ["browser-availability", "computer-availability"],
  });
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "main-features.js"),
    [
      "const defaults = { browserPane:!1, inAppBrowserUse:!1, inAppBrowserUseAllowed:!1, externalBrowserUse:!1, externalBrowserUseAllowed:!1, computerUse:!1, computerUseNodeRepl:!1, control:!1, multiWindow:!1 };",
      "const windowsOverride = { ...defaults, inAppBrowserUse:!0, computerUse:!0, computerUseNodeRepl:!0 };",
      "const browser = { featureName:`browser_use`, available:!0, isLoading:!1 };",
      "const computer = { featureName:`computer_use`, available:!0, isLoading:!1 };",
    ].join("\n"),
    true,
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("plugin requires browser and computer defaults in the same object", (t) => {
  const fixture = createFixture(t, {
    omitMarkers: ["browser-availability", "computer-availability"],
  });
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "main-features.js"),
    [
      "const browserOverride = { browserPane:!0, inAppBrowserUse:!0, inAppBrowserUseAllowed:!0, externalBrowserUse:!0, externalBrowserUseAllowed:!0, computerUse:!1, computerUseNodeRepl:!1, control:!0, multiWindow:!0 };",
      "const computerOverride = { browserPane:!1, inAppBrowserUse:!1, inAppBrowserUseAllowed:!1, externalBrowserUse:!1, externalBrowserUseAllowed:!1, computerUse:!0, computerUseNodeRepl:!0, control:!0, multiWindow:!0 };",
    ].join("\n"),
    true,
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("plugin rejects unrelated always-true filter decoys", (t) => {
  const fixture = createFixture(t, { omitMarkers: ["plugin-availability"] });
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "main-features.js"),
    [
      "const filterNote = `.filter(()=>!0)`;",
      "/* bundledPlugins.filter(()=>!0) */",
      "const unrelated = values.filter(()=>!0);",
    ].join("\n"),
    true,
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("plugin filter context does not cross a shadowed selector binding", (t) => {
  const fixture = createFixture(t, { omitMarkers: ["plugin-availability"] });
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "main-features.js"),
    [
      "function decoySetup(features) {",
      "  const selectBundledPlugins = current => bundledPlugins.filter(()=>!0);",
      "  function unrelated(selectBundledPlugins) {",
      "    const descriptors = selectBundledPlugins(features);",
      "    logger.info(`bundled_plugins_reconcile_started`);",
      "    return install({ marketplacePluginDescriptors:descriptors });",
      "  }",
      "  return unrelated;",
      "}",
    ].join("\n"),
    true,
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("updater requires the titlebar marker in webview assets", (t) => {
  const fixture = createFixture(t, { omitMarkers: ["updater-titlebar"] });
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "main-updater.js"),
    "const updaterMenu = { id:`codex-rebuild-updater-top` };",
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("updater"),
  );
});

test("reports recursive evidence files for every satisfied contract", (t) => {
  const fixture = createFixture(t);

  const result = verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION);

  assert.deepEqual(Object.keys(result.contracts), CONTRACT_IDS);
  for (const [contract, evidenceFiles] of Object.entries(result.contracts)) {
    assert.ok(evidenceFiles.length > 0, `${contract} should report evidence`);
    assert.deepEqual(evidenceFiles, [...evidenceFiles].sort());
    assert.ok(evidenceFiles.every((file) => !path.isAbsolute(file)));
  }
  assert.deepEqual(result.contracts.updater, [
    "src/win/_asar/.vite/build/bootstrap.js",
    "src/win/_asar/.vite/build/preload.js",
    "src/win/_asar/webview/assets/windows-titlebar.js",
  ]);
});

test("combines package mismatch with every unsatisfied contract", (t) => {
  const fixture = createFixture(t, {
    version: "26.707.00000",
    omitMarkers: MARKERS.map((marker) => marker.id),
  });

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => {
      assert.match(error.message, /package-version/);
      assert.match(error.message, /26\.707\.00000/);
      assert.match(error.message, /26\.707\.31428/);
      for (const contract of CONTRACT_IDS) assert.ok(error.message.includes(contract));
      return true;
    },
  );
});

test("rejects a missing or malformed extracted package manifest", async (t) => {
  await t.test("missing", (t) => {
    const fixture = createFixture(t, { omitPackage: true });
    assert.throws(
      () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
      /package-json.*missing/i,
    );
  });

  await t.test("malformed", (t) => {
    const fixture = createFixture(t, { packageText: "{not-json" });
    assert.throws(
      () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
      /package-json.*invalid/i,
    );
  });

  await t.test("version missing", (t) => {
    const fixture = createFixture(t, {
      packageText: JSON.stringify({ name: "openai-codex-electron" }),
    });
    assert.throws(
      () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
      /package-version.*missing/i,
    );
  });
});

test("supports the Windows verification CLI and prints evidence files", (t) => {
  const fixture = createFixture(t);
  const script = path.join(__dirname, "verify-patched-app.js");

  const result = spawnSync(
    process.execPath,
    [
      script,
      "--root",
      fixture.root,
      "--platform",
      "win",
      "--expected-version",
      EXPECTED_VERSION,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  for (const contract of CONTRACT_IDS) assert.match(result.stdout, new RegExp(contract));
  assert.match(result.stdout, /windows-titlebar\.js/);
});

test("patch-all passes the extracted Windows version to the verifier", (t) => {
  const patchAllPath = path.join(__dirname, "patch-all.js");
  const patchAllSource = fs.readFileSync(patchAllPath, "utf8");
  assert.match(
    patchAllSource,
    /if\s*\(require\.main\s*===\s*module\)/,
    "patch-all must be safe to import for integration testing",
  );

  const { runPatchAll } = require("./patch-all");
  const fixture = createFixture(t);
  const patchCalls = [];
  const verificationCalls = [];
  const logger = { error() {}, log() {} };

  const result = runPatchAll(["win"], {
    execFileSync(command, args, options) {
      patchCalls.push({ command, args, options });
    },
    logger,
    projectRoot: fixture.root,
    verifyPatchedApp(...args) {
      verificationCalls.push(args);
      return { contracts: {} };
    },
  });

  assert.ok(patchCalls.length > 0);
  assert.ok(patchCalls.every((call) => call.args.at(-1) === "win"));
  assert.deepEqual(verificationCalls, [
    [fixture.root, "win", EXPECTED_VERSION],
  ]);
  assert.equal(result.failed, 0);
});

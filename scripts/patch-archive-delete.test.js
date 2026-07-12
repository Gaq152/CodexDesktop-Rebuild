#!/usr/bin/env node
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  patchAppMainSource,
  patchDataControlsSource,
  patchArchiveContracts,
  planArchivePlatform,
  executeArchivePlatforms,
  formatArchiveSummary,
  mayContainArchiveRouteContract,
  mayContainArchiveDataControlsContract,
} = require("./patch-archive-delete");

function withLiveRouter(routeEntries) {
  return `let routes={${routeEntries}};bridge.setMessageHandler((key,payload)=>routes[key](manager,payload))`;
}

const LATEST_NATIVE_APP_MAIN =
  withLiveRouter(
    '"archive-conversation":K7(async(e,{conversationId:t,cleanupWorktree:n,source:r})=>{await e.archiveConversation(t,{cleanupWorktree:n,source:r})}),' +
      '"delete-archived-conversation":q7((e,{conversationId:t})=>e.deleteArchivedConversation(t))',
  );
const ACTIVE_ROUTE =
  '"delete-conversation":K7(async(e,{conversationId:t})=>{await e.sendRequest("thread/delete",{threadId:t})})';
const LATEST_COMBINED_APP_MAIN = withLiveRouter(
  '"delete-archived-conversation":q7((e,{conversationId:t})=>e.deleteArchivedConversation(t)),' +
    ACTIVE_ROUTE,
);
const WINDOWS_COMBINED_APP_MAIN =
  withLiveRouter(
    '"archive-conversation":K7(async(e,{conversationId:t,cleanupWorktree:n,source:r})=>{await e.archiveConversation(t,{cleanupWorktree:n,source:r})}),' +
      '"delete-archived-conversation":q7((e,{conversationId:t})=>e.deleteArchivedConversation(t)),' +
      ACTIVE_ROUTE,
  ) + ';const archiveAction="archive-conversation"';
const LATEST_NATIVE_DATA_CONTROLS =
  "let messages={delete:{id:`settings.dataControls.archivedChats.delete`}};async function D(e,t){await e(`delete-archived-conversation`,{conversationId:t});await e(`delete-archived-conversation`,{conversationId:t});return classify(e,`thread/delete`)}export{D as DataControlsSettings}";
const LEGACY_DATA_CONTROLS =
  "function legacy(event,send,conversationId,hostId){if(event.currentTarget.dataset.codexConfirmDelete!==`true`)return;send(`delete-conversation`,{conversationId,hostId})}export{legacy as DataControlsSettings}";
const UNUSED_NATIVE_APP_MAIN =
  "let unusedRoutes={\"delete-archived-conversation\":q7((e,{conversationId:t})=>e.deleteArchivedConversation(t))}";
const DEAD_NATIVE_DATA_CONTROLS =
  "let messages={delete:{id:`settings.dataControls.archivedChats.delete`}};function Controls(){let neverCalled=(e,t)=>{e(`delete-archived-conversation`,{conversationId:t});e(`delete-archived-conversation`,{conversationId:t});return classify(e,`thread/delete`)};return null}";
const DEAD_NATIVE_ROUTER =
  "function dead(){let routes={\"delete-archived-conversation\":q7((e,{conversationId:t})=>e.deleteArchivedConversation(t))};bridge.setMessageHandler((key,payload)=>routes[key](manager,payload))}";
const DEAD_DECLARATION_DATA_CONTROLS =
  "let messages={delete:{id:`settings.dataControls.archivedChats.delete`}};function Controls(){function neverCalled(e,t){e(`delete-archived-conversation`,{conversationId:t});e(`delete-archived-conversation`,{conversationId:t});return classify(e,`thread/delete`)}return null}";
const UNUSED_TOP_LEVEL_DATA_CONTROLS =
  "let messages={delete:{id:`settings.dataControls.archivedChats.delete`}};function Unused(e,t){e(`delete-archived-conversation`,{conversationId:t});e(`delete-archived-conversation`,{conversationId:t});return classify(e,`thread/delete`)}function Live(){return null}export{Live as DataControlsSettings}";

const LATEST_MAC_NATIVE_APP_MAIN = [
  "var routes;(()=>{routes={",
  '"archive-conversation":P9(async(e,{conversationId:t,cleanupWorktree:n,source:r})=>{await e.archiveConversation(t,{cleanupWorktree:n,source:r})}),',
  '"delete-archived-conversation":F9((e,{conversationId:t})=>e.deleteArchivedConversation(t))',
  "}})();",
  "bridge.setMessageHandler((key,payload)=>routes[key](manager,payload));",
  "handoff(`archive-conversation`,{conversationId:id});",
].join("");

const LATEST_DOLLAR_WRAPPER_APP_MAIN = withLiveRouter(
  '"archive-conversation":$7(async($e,{conversationId:$t,cleanupWorktree:$n,source:$r})=>{await $e.archiveConversation($t,{cleanupWorktree:$n,source:$r})}),' +
    '"delete-archived-conversation":e9((e,{conversationId:t})=>e.deleteArchivedConversation(t))',
);

test("keeps native archive deletion and injects an independent active delete route", () => {
  assert.equal(
    typeof patchArchiveContracts,
    "function",
    "latest native archive-delete shape needs an exported pure contract helper",
  );

  const first = patchArchiveContracts({
    appMainSource: LATEST_NATIVE_APP_MAIN,
    dataControlsSource: LATEST_NATIVE_DATA_CONTROLS,
  });
  assert.equal(first.status, "patched");
  assert.deepEqual(first.counts, {
    route: { patchable: 1, already: 0, native: 1, total: 2 },
    button: { patchable: 0, already: 0, native: 1, total: 1 },
  });
  assert.match(first.appMain.code, /"delete-archived-conversation"/);
  assert.match(first.appMain.code, /"delete-conversation"/);
  assert.match(first.appMain.code, /sendRequest\("thread\/delete",\{threadId:t\}\)/);
  assert.equal(first.dataControls.code, LATEST_NATIVE_DATA_CONTROLS);

  const second = patchArchiveContracts({
    appMainSource: first.appMain.code,
    dataControlsSource: first.dataControls.code,
  });
  assert.equal(second.status, "already");
  assert.equal(second.appMain.code, first.appMain.code);
  assert.equal(second.dataControls.code, first.dataControls.code);
});

test("keeps the unambiguous legacy custom route patch idempotent", () => {
  assert.equal(typeof patchAppMainSource, "function");
  const source = withLiveRouter(
    '"archive-conversation":K7(async(e,{conversationId:t,cleanupWorktree:n,source:r})=>{await e.archiveConversation(t,{cleanupWorktree:n,source:r})})',
  );
  const first = patchAppMainSource(source);
  assert.equal(first.status, "patched");
  assert.deepEqual(first.counts, {
    patchable: 1,
    already: 0,
    native: 0,
    total: 1,
  });
  assert.match(first.code, /[\"`]delete-conversation[\"`]/);
  assert.match(first.code, /sendRequest\([\"`]thread\/delete[\"`]/);

  const second = patchAppMainSource(first.code);
  assert.equal(second.status, "already");
  assert.equal(second.code, first.code);
});

test("patches a live archive route whose compressed identifiers start with dollars", () => {
  const first = patchArchiveContracts({
    appMainSource: LATEST_DOLLAR_WRAPPER_APP_MAIN,
    dataControlsSource: LATEST_NATIVE_DATA_CONTROLS,
  });
  assert.equal(first.status, "patched");
  assert.match(
    first.appMain.code,
    /"delete-conversation":\$7\(async\(\$e,\{conversationId:\$t\}\)/,
  );
  assert.match(first.appMain.code, /sendRequest\("thread\/delete",\{threadId:\$t\}\)/);

  const second = patchArchiveContracts({
    appMainSource: first.appMain.code,
    dataControlsSource: first.dataControls.code,
  });
  assert.equal(second.status, "already");
  assert.equal(second.appMain.code, first.appMain.code);
});

test("patches a missing legacy route when the matching legacy UI is already present", () => {
  const appMainSource = withLiveRouter(
    '"archive-conversation":K7(async(e,{conversationId:t,cleanupWorktree:n,source:r})=>{await e.archiveConversation(t,{cleanupWorktree:n,source:r})})',
  );
  const result = patchArchiveContracts({
    appMainSource,
    dataControlsSource: LEGACY_DATA_CONTROLS,
  });

  assert.equal(result.status, "patched");
  assert.equal(result.appMain.status, "patched");
  assert.equal(result.dataControls.status, "already");
  assert.match(result.appMain.code, /delete-conversation/);
});

test("rejects malformed native, zero, and ambiguous archive route anchors", () => {
  assert.equal(typeof patchAppMainSource, "function");
  assert.throws(
    () =>
      patchAppMainSource(
        withLiveRouter(
          '"delete-archived-conversation":q7((e,{conversationId:t})=>e.archiveConversation(t))',
        ),
      ),
    /native archive route.*(?:malformed|expected exactly 1.*found 0)/i,
  );
  assert.throws(
    () => patchAppMainSource(withLiveRouter("")),
    /route.*expected exactly 1.*found 0/i,
  );
  const route =
    "\"archive-conversation\":K7(async(e,{conversationId:t,cleanupWorktree:n,source:r})=>{await e.archiveConversation(t,{cleanupWorktree:n,source:r})})";
  assert.throws(
    () => patchAppMainSource(withLiveRouter(`${route},${route}`)),
    /route.*expected exactly 1.*found 2/i,
  );
  const nativeRoute =
    "\"delete-archived-conversation\":q7((e,{conversationId:t})=>e.deleteArchivedConversation(t))";
  assert.throws(
    () => patchAppMainSource(withLiveRouter(`${nativeRoute},${nativeRoute}`)),
    /native archive route.*expected exactly 1.*found 2/i,
  );
  assert.equal(typeof patchDataControlsSource, "function");
  assert.throws(
    () =>
      patchDataControlsSource(
        `${LATEST_NATIVE_DATA_CONTROLS};e(\`delete-archived-conversation\`,{conversationId:t})`,
      ),
    /native archive-delete UI.*(?:malformed|expected exactly 2.*found 3)/i,
  );
  const legacyRoute =
    "\"delete-conversation\":K7(async(e,{conversationId:t})=>{await e.sendRequest(\"thread/delete\",{threadId:t})})";
  assert.throws(
    () => patchAppMainSource(withLiveRouter(`${legacyRoute},${legacyRoute}`)),
    /legacy archive route.*expected exactly 1.*found 2/i,
  );
  assert.throws(
    () =>
      patchArchiveContracts({
        appMainSource: LATEST_NATIVE_APP_MAIN,
        dataControlsSource: LEGACY_DATA_CONTROLS,
      }),
    /archive route\/UI mode mismatch/i,
  );
});

test("accepts exactly one live native route and one live active route", () => {
  const result = patchArchiveContracts({
    appMainSource: LATEST_COMBINED_APP_MAIN,
    dataControlsSource: LATEST_NATIVE_DATA_CONTROLS,
  });
  assert.equal(result.status, "already");
  assert.deepEqual(result.counts.route, {
    patchable: 0,
    already: 1,
    native: 1,
    total: 2,
  });
  assert.equal(result.appMain.code, LATEST_COMBINED_APP_MAIN);
});

test("rejects detached native archive UI tokens", () => {
  const detachedUi = [
    "const label=`settings.dataControls.archivedChats.delete`;",
    "const one=`delete-archived-conversation`;",
    "const two=`delete-archived-conversation`;",
    "const protocol=`thread/delete`;",
  ].join("");
  assert.throws(
    () => patchDataControlsSource(detachedUi),
    /native|UI|structural|attached|archive/i,
  );
});

test("rejects a native archive route in an unused route object", () => {
  assert.throws(
    () => patchAppMainSource(UNUSED_NATIVE_APP_MAIN),
    /native archive route.*(?:live|router|detached|malformed)/i,
  );
});

test("rejects native archive UI calls inside an uninvoked nested function", () => {
  assert.throws(
    () => patchDataControlsSource(DEAD_NATIVE_DATA_CONTROLS),
    /native archive-delete UI.*(?:live|return|detached|malformed)/i,
  );
});

test("rejects a native router wholly owned by an uninvoked function", () => {
  const routeBody = "let routes={\"delete-archived-conversation\":q7((e,{conversationId:t})=>e.deleteArchivedConversation(t))};bridge.setMessageHandler((key,payload)=>routes[key](manager,payload))";
  for (const source of [
    DEAD_NATIVE_ROUTER,
    `const dead=function(){${routeBody}}`,
    `const dead=()=>{${routeBody}}`,
  ]) {
    assert.throws(
      () => patchAppMainSource(source),
      /native archive route.*(?:live|router|owner|detached|malformed)/i,
    );
  }
});

test("rejects native archive UI inside an uninvoked function declaration", () => {
  assert.throws(
    () => patchDataControlsSource(DEAD_DECLARATION_DATA_CONTROLS),
    /native archive-delete UI.*(?:live|return|owner|detached|malformed)/i,
  );
});

test("rejects native archive UI in an unused top-level function", () => {
  const body = "e(`delete-archived-conversation`,{conversationId:t});e(`delete-archived-conversation`,{conversationId:t});return classify(e,`thread/delete`)";
  const label = "let messages={delete:{id:`settings.dataControls.archivedChats.delete`}};";
  for (const source of [
    UNUSED_TOP_LEVEL_DATA_CONTROLS,
    `${label}const Unused=function(e,t){${body}};function Live(){return null}export{Live as DataControlsSettings}`,
    `${label}const Unused=(e,t)=>{${body}};function Live(){return null}export{Live as DataControlsSettings}`,
  ]) {
    assert.throws(
      () => patchDataControlsSource(source),
      /native archive-delete UI.*(?:live|return|owner|detached|malformed)/i,
    );
  }
});

test("Windows archive planning keeps exact target count checks", () => {
  const targets = {
    appMainTargets: [{ fileName: "app-main-mac.js", source: "const routes={}" }],
    dataControlsTargets: [{ fileName: "data-controls-mac.js", source: "const controls={}" }],
  };
  assert.throws(
    () => planArchivePlatform({ platform: "win", ...targets }),
    /route.*expected exactly 1.*found 0/i,
  );
  assert.throws(
    () => planArchivePlatform({
      platform: "win",
      appMainTargets: [
        { fileName: "app-main-a.js", source: LATEST_NATIVE_APP_MAIN },
        { fileName: "app-main-b.js", source: LATEST_NATIVE_APP_MAIN },
      ],
      dataControlsTargets: [{ fileName: "data-controls.js", source: LATEST_NATIVE_DATA_CONTROLS }],
    }),
    /app-main.*expected exactly 1.*found 2/i,
  );
});

test("Windows archive planning bypasses macOS absence analysis for a valid combined contract", () => {
  const appMain = { fileName: "app-main-BEs0GGm0.js", source: WINDOWS_COMBINED_APP_MAIN };
  const dataControls = { fileName: "data-controls-C3wlrF7v.js", source: LATEST_NATIVE_DATA_CONTROLS };

  const result = planArchivePlatform({
    platform: "win",
    appMainTargets: [appMain],
    dataControlsTargets: [dataControls],
  });

  assert.equal(result.status, "ready");
  assert.equal(result.writes[0].result.status, "already");
  assert.equal(result.writes[0].result.appMain.code, WINDOWS_COMBINED_APP_MAIN);
});

test("accepts the latest macOS route table when live business code also archives", () => {
  const result = planArchivePlatform({
    platform: "mac-arm64",
    candidates: [
      {
        fileName: "app-initial~app-main~page-latest.js",
        filePath: "webview/assets/app-initial~app-main~page-latest.js",
        source: LATEST_MAC_NATIVE_APP_MAIN,
      },
      {
        fileName: "data-controls-latest.js",
        filePath: "webview/assets/data-controls-latest.js",
        source: LATEST_NATIVE_DATA_CONTROLS,
      },
    ],
  });
  assert.equal(result.writes[0].result.status, "patched");
  assert.match(result.writes[0].result.appMain.code, /["`]delete-conversation["`]/);
});

test("cheap archive contract prefilters exclude token-free bundles", () => {
  assert.equal(typeof mayContainArchiveRouteContract, "function");
  assert.equal(typeof mayContainArchiveDataControlsContract, "function");
  assert.equal(mayContainArchiveRouteContract("const unrelated = 1"), false);
  assert.equal(mayContainArchiveRouteContract(LATEST_MAC_NATIVE_APP_MAIN), true);
  assert.equal(mayContainArchiveDataControlsContract("const unrelated = 1"), false);
  assert.equal(mayContainArchiveDataControlsContract(LATEST_NATIVE_DATA_CONTROLS), true);
  assert.equal(mayContainArchiveDataControlsContract(LEGACY_DATA_CONTROLS), true);
});

function validMacArchiveCandidates(prefix) {
  return [
    {
      fileName: `app-main-${prefix}-bootstrap.js`,
      filePath: `webview/assets/app-main-${prefix}-bootstrap.js`,
      source:
        "import`./archive-conversation.js`;const label=`archive-conversation`;const shell={load:()=>import(`./page.js`)}",
    },
    {
      fileName: `app-initial~app-main~page-${prefix}.js`,
      filePath: `webview/assets/app-initial~app-main~page-${prefix}.js`,
      source: LATEST_NATIVE_APP_MAIN,
    },
    {
      fileName: `controls-consolidated-${prefix}.js`,
      filePath: `webview/assets/controls-consolidated-${prefix}.js`,
      source: LATEST_NATIVE_DATA_CONTROLS,
    },
    {
      fileName: `outside-root-${prefix}.js`,
      filePath: `.vite/build/outside-root-${prefix}.js`,
      source: `${LATEST_NATIVE_APP_MAIN};${LATEST_NATIVE_DATA_CONTROLS}`,
    },
  ];
}

function validWindowsArchiveInput() {
  return {
    platform: "win",
    appMainTargets: [{
      fileName: "app-main-Windows.js",
      filePath: "webview/assets/app-main-Windows.js",
      source: WINDOWS_COMBINED_APP_MAIN,
    }],
    dataControlsTargets: [{
      fileName: "data-controls-Windows.js",
      filePath: "webview/assets/data-controls-Windows.js",
      source: LATEST_NATIVE_DATA_CONTROLS,
    }],
  };
}

test("macOS matrix locates structural archive route and data-controls roles", () => {
  for (const platform of ["mac-arm64", "mac-x64"]) {
    const result = planArchivePlatform({
      platform,
      candidates: validMacArchiveCandidates(platform),
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(
      result.writes[0].matches.route.map(({ fileName }) => fileName),
      [`app-initial~app-main~page-${platform}.js`],
    );
    assert.deepEqual(
      result.writes[0].matches.dataControls.map(({ fileName }) => fileName),
      [`controls-consolidated-${platform}.js`],
    );
    assert.equal(result.writes[0].result.status, "patched");
  }
});

test("macOS archive structural roles accept already-patched contracts", () => {
  const candidates = validMacArchiveCandidates("already").map((candidate) => {
    if (candidate.fileName.includes("app-initial")) {
      return { ...candidate, source: LATEST_COMBINED_APP_MAIN };
    }
    return candidate;
  });
  const result = planArchivePlatform({ platform: "mac-arm64", candidates });
  assert.equal(result.writes[0].result.status, "already");
  assert.equal(result.writes[0].result.appMain.status, "already");
  assert.equal(result.writes[0].result.dataControls.status, "native");
});

test("macOS route ownership follows the live router consumer chain", () => {
  const unusedPreciseRoute = {
    fileName: "unused-precise-route.js",
    filePath: "webview/assets/unused-precise-route.js",
    source:
      'let unusedRoutes={"archive-conversation":K7(async(e,{conversationId:t,cleanupWorktree:n,source:r})=>{await e.archiveConversation(t,{cleanupWorktree:n,source:r})})}',
  };
  const result = planArchivePlatform({
    platform: "mac-arm64",
    candidates: [...validMacArchiveCandidates("live-route"), unusedPreciseRoute],
  });
  assert.deepEqual(
    result.writes[0].matches.route.map(({ fileName }) => fileName),
    ["app-initial~app-main~page-live-route.js"],
  );

  const liveMalformedRoute = {
    fileName: "live-malformed-route.js",
    filePath: "webview/assets/live-malformed-route.js",
    source: withLiveRouter(
      '"archive-conversation":K7(async(e,{conversationId:t})=>{await e.archiveConversation(t)})',
    ),
  };
  assert.throws(
    () =>
      planArchivePlatform({
        platform: "mac-x64",
        candidates: [...validMacArchiveCandidates("malformed-live"), liveMalformedRoute],
      }),
    /archive-route|live-malformed-route|owned-malformed|archive route.*found 0/i,
  );
});

test("macOS data-controls ownership follows exported native behavior", () => {
  const deadDecoys = [
    {
      fileName: "isolated-native-calls.js",
      filePath: "webview/assets/isolated-native-calls.js",
      source:
        "send(`delete-archived-conversation`,{conversationId:id});send(`delete-archived-conversation`,{conversationId:id});classify(send,`thread/delete`)",
    },
    {
      fileName: "unexported-native-function.js",
      filePath: "webview/assets/unexported-native-function.js",
      source: DEAD_NATIVE_DATA_CONTROLS,
    },
  ];
  const result = planArchivePlatform({
    platform: "mac-arm64",
    candidates: [...validMacArchiveCandidates("dead-controls"), ...deadDecoys],
  });
  assert.deepEqual(
    result.writes[0].matches.dataControls.map(({ fileName }) => fileName),
    ["controls-consolidated-dead-controls.js"],
  );

  const exportedBehaviorWithoutLabel = {
    fileName: "exported-native-without-label.js",
    filePath: "webview/assets/exported-native-without-label.js",
    source: LATEST_NATIVE_DATA_CONTROLS.replace(
      "let messages={delete:{id:`settings.dataControls.archivedChats.delete`}};",
      "",
    ),
  };
  assert.throws(
    () =>
      planArchivePlatform({
        platform: "mac-x64",
        candidates: [
          ...validMacArchiveCandidates("missing-label"),
          exportedBehaviorWithoutLabel,
        ],
      }),
    /archive-data-controls|exported-native-without-label|owned-malformed|UI|label/i,
  );
});

test("macOS archive structural roles fail closed for malformed and duplicate owners", async (t) => {
  const cases = [
    [
      "owned malformed route",
      (platform) => [
        ...validMacArchiveCandidates(platform),
        {
          fileName: `malformed-route-${platform}.js`,
          filePath: `webview/assets/malformed-route-${platform}.js`,
          source: `${LATEST_NATIVE_APP_MAIN};const detached=\`archive-conversation\``,
        },
      ],
      /archive-route|malformed-route|owned-malformed|detached|route/i,
    ],
    [
      "owned malformed data-controls",
      (platform) => [
        ...validMacArchiveCandidates(platform),
        {
          fileName: `malformed-controls-${platform}.js`,
          filePath: `webview/assets/malformed-controls-${platform}.js`,
          source: LATEST_NATIVE_DATA_CONTROLS.replace(
            "let messages={delete:{id:`settings.dataControls.archivedChats.delete`}};",
            "",
          ),
        },
      ],
      /archive-data-controls|malformed-controls|owned-malformed|UI|structural/i,
    ],
    [
      "duplicate route",
      (platform) => [
        ...validMacArchiveCandidates(platform),
        {
          fileName: `duplicate-route-${platform}.js`,
          filePath: `webview/assets/duplicate-route-${platform}.js`,
          source: LATEST_NATIVE_APP_MAIN,
        },
      ],
      /archive-route|exact candidates: 2|duplicate-route/i,
    ],
    [
      "duplicate data-controls",
      (platform) => [
        ...validMacArchiveCandidates(platform),
        {
          fileName: `duplicate-controls-${platform}.js`,
          filePath: `webview/assets/duplicate-controls-${platform}.js`,
          source: LATEST_NATIVE_DATA_CONTROLS,
        },
      ],
      /archive-data-controls|exact candidates: 2|duplicate-controls/i,
    ],
  ];
  for (const platform of ["mac-arm64", "mac-x64"]) {
    for (const [name, makeCandidates, expected] of cases) {
      await t.test(`${platform}: ${name}`, () => {
        assert.throws(
          () => planArchivePlatform({ platform, candidates: makeCandidates(platform) }),
          expected,
        );
      });
    }
  }
});

test("archive orchestrator plans every platform before committing through the writer", async (t) => {
  await t.test("a later invalid platform produces zero writes", () => {
    const writes = [];
    const invalidX64 = [
      ...validMacArchiveCandidates("x64"),
      {
        fileName: "duplicate-route-x64.js",
        filePath: "webview/assets/duplicate-route-x64.js",
        source: LATEST_NATIVE_APP_MAIN,
      },
    ];
    assert.throws(
      () =>
        executeArchivePlatforms({
          platformInputs: [
            validWindowsArchiveInput(),
            { platform: "mac-arm64", candidates: validMacArchiveCandidates("arm64") },
            { platform: "mac-x64", candidates: invalidX64 },
          ],
          writeFile: (...args) => writes.push(args),
        }),
      /mac-x64|archive-route|exact candidates: 2/i,
    );
    assert.equal(writes.length, 0);
  });

  await t.test("successful macOS writes use the validated commit phase", () => {
    const writes = [];
    const result = executeArchivePlatforms({
      platformInputs: [
        { platform: "mac-arm64", candidates: validMacArchiveCandidates("arm64") },
        { platform: "mac-x64", candidates: validMacArchiveCandidates("x64") },
        validWindowsArchiveInput(),
      ],
      writeFile: (...args) => writes.push(args),
    });
    assert.equal(result.platformPlans.length, 3);
    assert.equal(writes.length, 2);
    assert.deepEqual(
      writes.map(([filePath]) => filePath),
      [
        "webview/assets/app-initial~app-main~page-arm64.js",
        "webview/assets/app-initial~app-main~page-x64.js",
      ],
    );
  });
});

test("archive summary reports both macOS architectures ready", () => {
  const summary = formatArchiveSummary([
    { platform: "mac-arm64", status: "ready" },
    { platform: "mac-x64", status: "ready" },
    { platform: "win", status: "ready" },
  ]);
  assert.match(summary, /skipped=\[\]/);
  assert.match(summary, /ready=\[mac-arm64,mac-x64,win\]/);
  assert.doesNotMatch(summary, /\bok\b|contracts satisfied/i);
});

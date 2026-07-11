#!/usr/bin/env node
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  patchAppMainSource,
  patchDataControlsSource,
  patchArchiveContracts,
  planArchivePlatform,
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

test("platform matrix skips only an absent macOS archive route layer", () => {
  const targets = {
    appMainTargets: [{ fileName: "app-main-mac.js", source: "const routes={}" }],
    dataControlsTargets: [{ fileName: "data-controls-mac.js", source: "const controls={}" }],
  };
  for (const platform of ["mac-arm64", "mac-x64"]) {
    const warnings = [];
    const result = planArchivePlatform({
      platform,
      ...targets,
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(result, { status: "skipped", writes: [] });
    assert.deepEqual(warnings, [
      `[skip] archive-delete: unsupported target layout on ${platform}`,
    ]);
  }
  assert.throws(
    () => planArchivePlatform({ platform: "win", ...targets }),
    /route.*expected exactly 1.*found 0/i,
  );
  assert.throws(
    () => planArchivePlatform({
      platform: "mac-arm64",
      appMainTargets: [{ fileName: "app-main-mac.js", source: 'const route="archive-conversation"' }],
      dataControlsTargets: targets.dataControlsTargets,
    }),
    /route|router|incomplete|expected exactly 1/i,
  );
  assert.throws(
    () => planArchivePlatform({
      platform: "mac-x64",
      appMainTargets: [
        { fileName: "app-main-a.js", source: LATEST_NATIVE_APP_MAIN },
        { fileName: "app-main-b.js", source: LATEST_NATIVE_APP_MAIN },
      ],
      dataControlsTargets: [{ fileName: "data-controls.js", source: LATEST_NATIVE_DATA_CONTROLS }],
    }),
    /app-main.*expected exactly 1.*found 2/i,
  );
});

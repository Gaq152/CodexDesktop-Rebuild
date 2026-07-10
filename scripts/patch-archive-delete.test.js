#!/usr/bin/env node
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  patchAppMainSource,
  patchDataControlsSource,
  patchArchiveContracts,
} = require("./patch-archive-delete");

const LATEST_NATIVE_APP_MAIN =
  "let routes={\"delete-archived-conversation\":q7((e,{conversationId:t})=>e.deleteArchivedConversation(t))}";
const LATEST_NATIVE_DATA_CONTROLS =
  "let label={id:`settings.dataControls.archivedChats.delete`};async function D(e,t){await e(`delete-archived-conversation`,{conversationId:t});await e(`delete-archived-conversation`,{conversationId:t});return e(`thread/delete`,{threadId:t})}";
const LEGACY_DATA_CONTROLS =
  "let button={route:`delete-conversation`,codexConfirmDelete:`true`}";

test("recognizes the latest native archive-delete path without injecting a redundant route", () => {
  assert.equal(
    typeof patchArchiveContracts,
    "function",
    "latest native archive-delete shape needs an exported pure contract helper",
  );

  const first = patchArchiveContracts({
    appMainSource: LATEST_NATIVE_APP_MAIN,
    dataControlsSource: LATEST_NATIVE_DATA_CONTROLS,
  });
  assert.equal(first.status, "native");
  assert.deepEqual(first.counts, {
    route: { patchable: 0, already: 0, native: 1, total: 1 },
    button: { patchable: 0, already: 0, native: 1, total: 1 },
  });
  assert.equal(first.appMain.code, LATEST_NATIVE_APP_MAIN);
  assert.equal(first.dataControls.code, LATEST_NATIVE_DATA_CONTROLS);
  assert.doesNotMatch(first.appMain.code, /[\"`]delete-conversation[\"`]/);

  const second = patchArchiveContracts({
    appMainSource: first.appMain.code,
    dataControlsSource: first.dataControls.code,
  });
  assert.equal(second.status, "native");
  assert.equal(second.appMain.code, first.appMain.code);
  assert.equal(second.dataControls.code, first.dataControls.code);
});

test("keeps the unambiguous legacy custom route patch idempotent", () => {
  assert.equal(typeof patchAppMainSource, "function");
  const source =
    "let routes={\"archive-conversation\":K7(async(e,{conversationId:t,cleanupWorktree:n,source:r})=>{await e.archiveConversation(t,{cleanupWorktree:n,source:r})})}";
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
  const appMainSource =
    "let routes={\"archive-conversation\":K7(async(e,{conversationId:t,cleanupWorktree:n,source:r})=>{await e.archiveConversation(t,{cleanupWorktree:n,source:r})})}";
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
        "let routes={\"delete-archived-conversation\":q7((e,{conversationId:t})=>e.archiveConversation(t))}",
      ),
    /route.*expected exactly 1.*found 0/i,
  );
  assert.throws(
    () => patchAppMainSource("let routes={}"),
    /route.*expected exactly 1.*found 0/i,
  );
  const route =
    "\"archive-conversation\":K7(async(e,{conversationId:t,cleanupWorktree:n,source:r})=>{await e.archiveConversation(t,{cleanupWorktree:n,source:r})})";
  assert.throws(
    () => patchAppMainSource(`let routes={${route},${route}}`),
    /route.*expected exactly 1.*found 2/i,
  );
  const nativeRoute =
    "\"delete-archived-conversation\":q7((e,{conversationId:t})=>e.deleteArchivedConversation(t))";
  assert.throws(
    () => patchAppMainSource(`let routes={${nativeRoute},${nativeRoute}}`),
    /native archive route.*expected exactly 1.*found 2/i,
  );
  assert.equal(typeof patchDataControlsSource, "function");
  assert.throws(
    () =>
      patchDataControlsSource(
        `${LATEST_NATIVE_DATA_CONTROLS};e(\`delete-archived-conversation\`,{conversationId:t})`,
      ),
    /native archive-delete UI route.*expected exactly 2.*found 3/i,
  );
  const legacyRoute =
    "\"delete-conversation\":K7(async(e,{conversationId:t})=>{await e.sendRequest(\"thread/delete\",{threadId:t})})";
  assert.throws(
    () => patchAppMainSource(`let routes={${legacyRoute},${legacyRoute}}`),
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

#!/usr/bin/env node
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  LOCAL_HOST_MARKER,
  ROOT_HOST_MARKER,
  patchProjectGroupSource,
} = require("./patch-show-all-local-sessions");

const SOURCE =
  "function group(e,u,c,l){let d=e.hostId==null||l(e.hostId)?c:e.hostId,p=u?.threadProjectAssignments?.[e.conversationId];return d+p}" +
  "function roots(n,t,a,l){let e=n.hostId==null||l(n.hostId)?t:n.hostId,r=n.cwd;if(!r||e!==t&&!a.has(e))continue;}";

test("patches structural local-session targets and remains idempotent", () => {
  const first = patchProjectGroupSource(SOURCE);
  assert.equal(first.status, "patched");
  assert.ok(first.code.includes(LOCAL_HOST_MARKER));
  assert.ok(first.code.includes(ROOT_HOST_MARKER));
  assert.match(first.code, /enabledRemoteHostIds\?\.has\(e\.hostId\)/);
  assert.match(first.code, /remoteProjects\?\.some\(t=>t\.hostId===e\.hostId\)/);
  assert.match(first.code, /!a\.has\(n\.hostId\)/);
  const second = patchProjectGroupSource(first.code);
  assert.equal(second.status, "already");
  assert.equal(second.code, first.code);
});

test("fails closed when either structural role is missing or duplicated", () => {
  assert.throws(() => patchProjectGroupSource(SOURCE.split("function roots")[0]), /workspace root.*found 0/i);
  assert.throws(() => patchProjectGroupSource(`${SOURCE}${SOURCE}`), /local session.*found 2/i);
});

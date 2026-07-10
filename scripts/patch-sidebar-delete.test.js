#!/usr/bin/env node
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  patchThreadActionsSource,
  patchSidebarSource,
  patchSidebarContracts,
} = require("./patch-sidebar-delete");

const LATEST_THREAD_ACTIONS = [
  "let $=g({archiveThread:{id:`sidebarElectron.archiveThread`,defaultMessage:`Archive task`,description:`Menu item to archive a local task`}})",
  "function ne(){let e=(0,Q.c)(17),t=n(o),r=h(),i;i=e=>{let{conversationId:n,hostId:a,source:o,onArchiveStart:s,onArchiveSuccess:c,onArchiveError:l}=e;s?.(),v(`archive-conversation`,{conversationId:n,hostId:a,source:o}).then(()=>c?.()).catch(()=>{l?.(),t.get(y).danger(r.formatMessage($.archiveThreadError))})};let a=e=>{};let s=e=>{},c=e=>{},l=e=>{};let u;return u={archiveThread:i,interruptThread:a,renameThread:s,copyWorkingDirectory:c,copyConversationMarkdown:l},u}",
].join(";");

const LATEST_SIDEBAR = [
  "function Ac(e){let t=(0,Nc.c)(8),{archive:n,pinAction:r}=e,i=L();if(n==null&&r==null)return null;let a;t[0]===r?a=t[1]:(a=r==null?[]:[{id:`thread-pin-action`,ariaLabel:r.ariaLabel,onClick:r.onClick}],t[0]=r,t[1]=a);let o;t[2]!==n||t[3]!==i?(o=n==null?[]:[{id:`thread-primary-action`,ariaLabel:i.formatMessage(Sr.archiveThread),icon:(0,Fc.jsx)(Aa,{}),onClick:n}],t[2]=n,t[3]=i,t[4]=o):o=t[4];let s;return t[5]!==a||t[6]!==o?(s=(0,Fc.jsx)(oc,{actions:[...a,...o],className:Pa}),t[5]=a,t[6]=o,t[7]=s):s=t[7],s}",
  "function jc({conversationId:e,showPinActionOnHover:a=!1,canPin:i=!0,threadSummary:_=null}){let b=o(m),[S,C]=(0,Pc.useState)(!1),w=L(),{archiveThread:F,markThreadAsRead:R}=wr(),{beginArchive:ne,handleArchiveSuccess:re,handleArchiveError:ie}=Na({}),we=()=>{ne(),F({conversationId:e,hostId:_?.hostId,source:`sidebar_context_menu`,onArchiveSuccess:re,onArchiveError:ie})},Te=le(()=>{we()}),je=le(()=>[{id:`archive-thread`,message:Sr.archiveThread,onSelect:Te}]),Me=a&&i,Ne=(0,Pc.useCallback)(({archive:t})=>(0,Fc.jsx)(Ac,{archive:t,pinAction:Me?{ariaLabel:w.formatMessage(Eo),isPinned:!1,onClick:()=>{}}:void 0}),[Te,w,e,b,Me]);let Pe=(0,Fc.jsx)(Ma,{additionalHoverActionCount:Me?1:0,renderActions:Ne});return(0,Fc.jsx)(me,{getItems:je,children:Pe})}",
].join(";");

const PENDING_TASK_DECOY =
  "function Sd(e){let i=()=>[{id:`archive-thread`,message:Sr.archiveThread,onSelect:()=>{}}],p=l&&B;return(0,Ad.jsx)(Ua,{additionalHoverActionCount:p?1:0,renderActions:q?Ed:e=>{let{archive:n,requestArchive:r}=e;return(0,Ad.jsx)(Dd,{archive:n,requestArchive:r})}})}";

test("patches task-worded thread actions with the native delete route idempotently", () => {
  assert.equal(typeof patchThreadActionsSource, "function");
  const first = patchThreadActionsSource(LATEST_THREAD_ACTIONS);
  assert.equal(first.status, "patched");
  assert.deepEqual(first.counts, {
    messages: { patchable: 1, already: 0, total: 1 },
    action: { patchable: 1, already: 0, total: 1 },
  });
  assert.match(first.code, /sidebarElectron\.deleteThread/);
  assert.match(first.code, /deleteThread:CodexSidebarDeleteAction/);
  assert.match(first.code, /delete-archived-conversation/);
  const second = patchThreadActionsSource(first.code);
  assert.equal(second.status, "already");
  assert.equal(second.code, first.code);
  assert.throws(
    () =>
      patchThreadActionsSource(
        `${first.code};/* CodexSidebarDeleteAction */`,
      ),
    /sidebar action.*expected exactly 1.*found 2/i,
  );
});

test("adds delete and inline-confirmation actions to the latest sidebar aliases idempotently", () => {
  assert.equal(typeof patchSidebarSource, "function");
  const first = patchSidebarSource(LATEST_SIDEBAR);
  assert.equal(first.status, "patched");
  assert.deepEqual(first.counts, {
    hover: { patchable: 1, already: 0, total: 1 },
    row: { patchable: 1, already: 0, total: 1 },
  });
  assert.match(first.code, /id:`thread-delete-action`/);
  assert.match(first.code, /id:`thread-delete-confirm-action`/);
  assert.match(first.code, /id:`delete-thread`/);
  assert.match(first.code, /deleteAction:\{confirming:CodexDeleteConfirm/);
  assert.match(first.code, /additionalHoverActionCount:\(Me\?1:0\)\+1/);
  const second = patchSidebarSource(first.code);
  assert.equal(second.status, "already");
  assert.equal(second.code, first.code);
  assert.throws(
    () =>
      patchSidebarSource(
        `${first.code};/* CodexSidebarDeleteHover */`,
      ),
    /sidebar hover.*expected exactly 1.*found 2/i,
  );
});

test("selects the real thread row when the latest pending-task decoy shares broad markers", () => {
  const source = `${LATEST_SIDEBAR};${PENDING_TASK_DECOY}`;
  const first = patchSidebarSource(source);
  assert.equal(first.status, "patched");
  assert.match(first.code, /function jc\([^]*CodexSidebarDeleteRow/);
  assert.doesNotMatch(first.code, /function Sd\([^]*CodexSidebarDeleteRow/);
  const second = patchSidebarSource(first.code);
  assert.equal(second.status, "already");
  assert.equal(second.code, first.code);
});

test("rejects missing, ambiguous, and half-present sidebar contracts", () => {
  assert.equal(typeof patchSidebarContracts, "function");
  assert.throws(() => patchSidebarContracts({ threadActionsSource: LATEST_THREAD_ACTIONS }), /sidebar.*required/i);
  assert.throws(() => patchThreadActionsSource("let value=1"), /messages.*found 0/i);
  assert.throws(
    () =>
      patchSidebarSource(
        `${LATEST_SIDEBAR};${LATEST_SIDEBAR.replaceAll("Ac", "Bc").replaceAll("jc", "kc")}`,
      ),
    /hover.*found 2/i,
  );
});

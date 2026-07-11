#!/usr/bin/env node
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  patchThreadActionsSource,
  patchSidebarSource,
  patchSidebarContracts,
  planSidebarPlatform,
  executeSidebarPlatforms,
  formatSidebarSummary,
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

test("patches task-worded thread actions with the active delete route idempotently", () => {
  assert.equal(typeof patchThreadActionsSource, "function");
  const first = patchThreadActionsSource(LATEST_THREAD_ACTIONS);
  assert.equal(first.status, "patched");
  assert.deepEqual(first.counts, {
    messages: { patchable: 1, already: 0, total: 1 },
    action: { patchable: 1, already: 0, total: 1 },
  });
  assert.match(first.code, /sidebarElectron\.deleteThread/);
  assert.match(first.code, /deleteThread:CodexSidebarDeleteAction/);
  assert.match(first.code, /delete-conversation/);
  assert.doesNotMatch(first.code, /delete-archived-conversation/);
  const second = patchThreadActionsSource(first.code);
  assert.equal(second.status, "already");
  assert.equal(second.code, first.code);
  assert.throws(
    () =>
      patchThreadActionsSource(
        `${first.code};/* CodexSidebarDeleteAction */`,
      ),
    /sidebar thread-actions marker postcondition is malformed|sidebar action.*expected exactly 1.*found 2/i,
  );
});

test("migrates the previously injected archived route to the active route", () => {
  const current = patchThreadActionsSource(LATEST_THREAD_ACTIONS).code;
  const oldInjection = current.replace(
    "`delete-conversation`",
    "`delete-archived-conversation`",
  );
  const migrated = patchThreadActionsSource(oldInjection);
  assert.equal(migrated.status, "patched");
  assert.match(migrated.code, /delete-conversation/);
  assert.doesNotMatch(migrated.code, /delete-archived-conversation/);
  assert.equal(patchThreadActionsSource(migrated.code).status, "already");
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
    /sidebar hover\/row marker postcondition is malformed|sidebar hover.*expected exactly 1.*found 2/i,
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

test("rejects an inert thread-actions marker and token shell", () => {
  assert.throws(
    () =>
      patchThreadActionsSource(
        "const messages={deleteThread:1,deleteThreadConfirmAction:1,deleteThreadError:1};" +
          "/* CodexSidebarDeleteAction */const CodexSidebarDeleteAction=1;" +
          "const route=`delete-archived-conversation`;",
      ),
    /thread-actions|messages|action|structural|postcondition/i,
  );
});

test("rejects an inert sidebar hover and row marker shell", () => {
  assert.throws(
    () =>
      patchSidebarSource(
        "/* CodexSidebarDeleteHover *//* CodexSidebarDeleteRow */" +
          "const confirm=`thread-delete-confirm-action`,item={id:`delete-thread`};",
      ),
    /sidebar|hover|row|structural|postcondition/i,
  );
});

test("rejects a delete action whose route and returned binding are inert", () => {
  const inert = [
    "let $=g({archiveThread:{id:`sidebarElectron.archiveThread`},deleteThread:{id:`sidebarElectron.deleteThread`},deleteThreadConfirmAction:{id:`sidebarElectron.deleteThreadConfirmAction`},deleteThreadError:{id:`sidebarElectron.deleteThreadError`}})",
    "function ne(){",
    "/* CodexSidebarDeleteAction */let CodexSidebarDeleteAction=e=>{function dead(){let{conversationId:n,hostId:i}=e;v(`delete-archived-conversation`,{conversationId:n,hostId:i})}};",
    "const unused={deleteThread:CodexSidebarDeleteAction};",
    "return {archiveThread:()=>{},copyConversationMarkdown:()=>{}}",
    "}",
  ].join(";");

  assert.throws(
    () => patchThreadActionsSource(inert),
    /thread-actions|delete parameters|delete route|returned|binding|postcondition/i,
  );
});

function validMacSidebarCandidates(prefix) {
  return [
    {
      fileName: `thread-shell-${prefix}.js`,
      filePath: `webview/assets/thread-shell-${prefix}.js`,
      source:
        "const tokens=[`sidebarElectron.archiveThread`,`archive-conversation`,`copyConversationMarkdown`]",
    },
    {
      fileName: `thread-app-shell-chrome~${prefix}.js`,
      filePath: `webview/assets/thread-app-shell-chrome~${prefix}.js`,
      source: LATEST_THREAD_ACTIONS,
    },
    {
      fileName: `remote-conversation-page-${prefix}.js`,
      filePath: `webview/assets/remote-conversation-page-${prefix}.js`,
      source: LATEST_SIDEBAR,
    },
    {
      fileName: `ui-token-shell-${prefix}.js`,
      filePath: `webview/assets/ui-token-shell-${prefix}.js`,
      source:
        "const ids=[`thread-primary-action`,`archive-thread`,`additionalHoverActionCount`]",
    },
    {
      fileName: `outside-root-${prefix}.js`,
      filePath: `.vite/build/outside-root-${prefix}.js`,
      source: `${LATEST_THREAD_ACTIONS};${LATEST_SIDEBAR}`,
    },
  ];
}

function validWindowsSidebarInput() {
  return {
    platform: "win",
    threadActionTargets: [{
      fileName: "thread-actions-Windows.js",
      filePath: "webview/assets/thread-actions-Windows.js",
      source: LATEST_THREAD_ACTIONS,
    }],
    sidebarTargets: [{
      fileName: "sidebar-flat-sections-Windows.js",
      filePath: "webview/assets/sidebar-flat-sections-Windows.js",
      source: LATEST_SIDEBAR,
    }],
  };
}

test("macOS matrix locates associated consolidated sidebar roles", () => {
  for (const platform of ["mac-arm64", "mac-x64"]) {
    const result = planSidebarPlatform({
      platform,
      candidates: validMacSidebarCandidates(platform),
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(
      result.writes[0].matches.threadActions.map(({ fileName }) => fileName),
      [`thread-app-shell-chrome~${platform}.js`],
    );
    assert.deepEqual(
      result.writes[0].matches.sidebar.map(({ fileName }) => fileName),
      [`remote-conversation-page-${platform}.js`],
    );
    assert.equal(result.writes[0].result.status, "patched");
  }
});

test("macOS sidebar structural roles accept already-patched contracts", () => {
  const candidates = validMacSidebarCandidates("already").map((candidate) => {
    if (candidate.fileName.startsWith("thread-app-shell")) {
      return { ...candidate, source: patchThreadActionsSource(candidate.source).code };
    }
    if (candidate.fileName.startsWith("remote-conversation")) {
      return { ...candidate, source: patchSidebarSource(candidate.source).code };
    }
    return candidate;
  });
  const result = planSidebarPlatform({ platform: "mac-arm64", candidates });
  assert.equal(result.writes[0].result.status, "already");
});

test("macOS sidebar ownership ignores nested dead structural families", () => {
  const deadThreadFamily = {
    fileName: "dead-thread-family.js",
    filePath: "webview/assets/dead-thread-family.js",
    source: [
      "let messages={archiveThread:{id:`sidebarElectron.archiveThread`}}",
      "function outer(){function dead(){let archive=e=>bridge(`archive-conversation`,e);return{archiveThread:archive,copyConversationMarkdown:()=>{}}}}",
    ].join(";"),
  };
  const deadUiFamily = {
    fileName: "dead-sidebar-family.js",
    filePath: "webview/assets/dead-sidebar-family.js",
    source: `function outer(){${LATEST_SIDEBAR}}`,
  };
  const result = planSidebarPlatform({
    platform: "mac-arm64",
    candidates: [
      ...validMacSidebarCandidates("dead-families"),
      deadThreadFamily,
      deadUiFamily,
    ],
  });
  assert.deepEqual(
    result.writes[0].matches.threadActions.map(({ fileName }) => fileName),
    ["thread-app-shell-chrome~dead-families.js"],
  );
  assert.deepEqual(
    result.writes[0].matches.sidebar.map(({ fileName }) => fileName),
    ["remote-conversation-page-dead-families.js"],
  );
});

test("macOS missing sidebar roles fail closed instead of skipping", () => {
  assert.throws(
    () =>
      planSidebarPlatform({
        platform: "mac-x64",
        candidates: [{
          fileName: "tokens-only.js",
          filePath: "webview/assets/tokens-only.js",
          source:
            "const tokens=[`sidebarElectron.archiveThread`,`copyConversationMarkdown`,`archive-conversation`,`thread-primary-action`,`archive-thread`,`additionalHoverActionCount`]",
        }],
      }),
    /mac-x64|sidebar-thread-actions|sidebar-ui|exact candidates: 0|found 0/i,
  );
});

test("macOS live thread ownership survives a missing returned copy action", () => {
  const malformedThread = {
    fileName: "live-thread-missing-copy.js",
    filePath: "webview/assets/live-thread-missing-copy.js",
    source: LATEST_THREAD_ACTIONS.replace(
      ",copyConversationMarkdown:l",
      "",
    ),
  };
  assert.throws(
    () =>
      planSidebarPlatform({
        platform: "mac-arm64",
        candidates: [
          ...validMacSidebarCandidates("valid-thread"),
          malformedThread,
        ],
      }),
    /sidebar-thread-actions|live-thread-missing-copy|owned-malformed|copyConversationMarkdown|action.*found 0/i,
  );
});

test("macOS live UI ownership survives a missing hover-count field", () => {
  const malformedSidebar = {
    fileName: "live-sidebar-missing-hover-count.js",
    filePath: "webview/assets/live-sidebar-missing-hover-count.js",
    source: LATEST_SIDEBAR.replace(
      "additionalHoverActionCount:Me?1:0,",
      "",
    ),
  };
  assert.throws(
    () =>
      planSidebarPlatform({
        platform: "mac-x64",
        candidates: [
          ...validMacSidebarCandidates("valid-sidebar"),
          malformedSidebar,
        ],
      }),
    /sidebar-ui|live-sidebar-missing-hover-count|owned-malformed|row.*found 0|hover.*count/i,
  );
});

test("macOS sidebar roles fail closed for malformed and duplicate structural owners", async (t) => {
  const malformedThread = LATEST_THREAD_ACTIONS.replace(
    "let a=e=>{};",
    "v(`archive-conversation`,{});let a=e=>{};",
  );
  const malformedSidebar = LATEST_SIDEBAR.replace(
    "[S,C]=(0,Pc.useState)(!1)",
    "[S,C]=null",
  );
  const cases = [
    [
      "owned malformed thread-actions",
      (platform) => [
        ...validMacSidebarCandidates(platform),
        {
          fileName: `malformed-thread-${platform}.js`,
          filePath: `webview/assets/malformed-thread-${platform}.js`,
          source: malformedThread,
        },
      ],
      /sidebar-thread-actions|malformed-thread|owned-malformed|archive|structure/i,
    ],
    [
      "owned malformed sidebar UI",
      (platform) => [
        ...validMacSidebarCandidates(platform),
        {
          fileName: `malformed-sidebar-${platform}.js`,
          filePath: `webview/assets/malformed-sidebar-${platform}.js`,
          source: malformedSidebar,
        },
      ],
      /sidebar-ui|malformed-sidebar|owned-malformed|row|state|structure/i,
    ],
    [
      "duplicate thread-actions",
      (platform) => [
        ...validMacSidebarCandidates(platform),
        {
          fileName: `duplicate-thread-${platform}.js`,
          filePath: `webview/assets/duplicate-thread-${platform}.js`,
          source: LATEST_THREAD_ACTIONS,
        },
      ],
      /sidebar-thread-actions|exact candidates: 2|duplicate-thread/i,
    ],
    [
      "duplicate sidebar UI",
      (platform) => [
        ...validMacSidebarCandidates(platform),
        {
          fileName: `duplicate-sidebar-${platform}.js`,
          filePath: `webview/assets/duplicate-sidebar-${platform}.js`,
          source: LATEST_SIDEBAR,
        },
      ],
      /sidebar-ui|exact candidates: 2|duplicate-sidebar/i,
    ],
  ];
  for (const platform of ["mac-arm64", "mac-x64"]) {
    for (const [name, makeCandidates, expected] of cases) {
      await t.test(`${platform}: ${name}`, () => {
        assert.throws(
          () => planSidebarPlatform({ platform, candidates: makeCandidates(platform) }),
          expected,
        );
      });
    }
  }
});

test("sidebar orchestrator plans all platforms before actual writer calls", async (t) => {
  await t.test("later invalid platform leaves every target untouched", () => {
    const writes = [];
    const invalidX64 = [
      ...validMacSidebarCandidates("x64"),
      {
        fileName: "duplicate-sidebar-x64.js",
        filePath: "webview/assets/duplicate-sidebar-x64.js",
        source: LATEST_SIDEBAR,
      },
    ];
    assert.throws(
      () =>
        executeSidebarPlatforms({
          platformInputs: [
            validWindowsSidebarInput(),
            { platform: "mac-arm64", candidates: validMacSidebarCandidates("arm64") },
            { platform: "mac-x64", candidates: invalidX64 },
          ],
          writeFile: (...args) => writes.push(args),
        }),
      /mac-x64|sidebar-ui|exact candidates: 2/i,
    );
    assert.equal(writes.length, 0);
  });

  await t.test("successful platforms commit only through the actual writer", () => {
    const writes = [];
    const result = executeSidebarPlatforms({
      platformInputs: [
        { platform: "mac-arm64", candidates: validMacSidebarCandidates("arm64") },
        { platform: "mac-x64", candidates: validMacSidebarCandidates("x64") },
        validWindowsSidebarInput(),
      ],
      writeFile: (...args) => writes.push(args),
    });
    assert.equal(result.platformPlans.length, 3);
    assert.equal(writes.length, 6);
  });
});

test("Windows sidebar planning keeps exact paths and target counts", () => {
  const targets = {
    threadActionTargets: [{ fileName: "thread-actions-mac.js", source: "const actions={}" }],
    sidebarTargets: [{ fileName: "sidebar-flat-sections-mac.js", source: "const sections={}" }],
  };
  assert.throws(
    () => planSidebarPlatform({ platform: "win", ...targets }),
    /messages.*found 0/i,
  );
  assert.throws(
    () => planSidebarPlatform({
      platform: "win",
      threadActionTargets: [
        { fileName: "thread-actions-a.js", source: LATEST_THREAD_ACTIONS },
        { fileName: "thread-actions-b.js", source: LATEST_THREAD_ACTIONS },
      ],
      sidebarTargets: targets.sidebarTargets,
    }),
    /thread-actions.*expected exactly 1.*found 2/i,
  );
  const valid = planSidebarPlatform(validWindowsSidebarInput());
  assert.equal(valid.status, "ready");
  assert.equal(valid.writes[0].result.status, "patched");
});

test("sidebar summary reports both macOS architectures ready", () => {
  const summary = formatSidebarSummary([
    { platform: "mac-arm64", status: "ready" },
    { platform: "mac-x64", status: "ready" },
    { platform: "win", status: "ready" },
  ]);
  assert.match(summary, /skipped=\[\]/);
  assert.match(summary, /ready=\[mac-arm64,mac-x64,win\]/);
  assert.doesNotMatch(summary, /\bok\b|contracts satisfied/i);
});

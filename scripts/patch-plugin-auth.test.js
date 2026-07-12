#!/usr/bin/env node
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  patchPluginMainSource,
  patchPluginWebviewSource,
  patchPluginContracts,
  classifyPluginTarget,
  planPluginPlatform,
  executePluginPlatforms,
  formatPluginSummary,
} = require("./patch-plugin-auth");

const LATEST_WEBVIEW_FIXTURE = [
  "function F(e){let{enabled:n,hostId:r}=e,s=v(`1506311413`),c={featureName:`computer_use`,hostId:r},l=j(c),p=I({enabled:n}),y=l.enabled&&p.enabled&&s,b=l.isFetching,x=l.isLoading,_=y?l.reason:`statsig-disabled`;return{available:y,isFetching:b,isLoading:x,reason:_}}",
  "function I(e){let t=(0,z.c)(21),{enabled:n}=e,r=(0,B.useContext)(x)?.authMethod===`chatgpt`;return{enabled:n&&r}}",
  "function H(e){let{hostId:n}=e,a=v(`410065390`),o={featureName:`browser_use_external`,hostId:n},s=j(o),l=a?s.enabled:`statsig-disabled`,u=l===`available`,d=l===`available`,f=l===`loading`;return{allowed:u,available:d,isLoading:f,reason:l}}",
  "function K(e){let{hostId:n}=e,a=v(`410262010`),o={featureName:`browser_use`,hostId:n},s=j(o),l=a?s.enabled:`statsig-disabled`,h=l===`available`,_=l===`available`,y=l===`loading`;return{allowed:h,available:_,isLoading:y,reason:l}}",
  "export{F as c,K as i,H as o}",
].join(";");

const LATEST_MAIN_FIXTURE = [
  "let He={browserPane:!1,inAppBrowserUse:!1,inAppBrowserUseAllowed:!1,externalBrowserUse:!1,externalBrowserUseAllowed:!1,computerUse:!1,computerUseNodeRepl:!1,control:!1,multiWindow:!1}",
  "let featureKeys=Object.keys(He)",
  "let fr={\"features.js_repl\":!1}",
  "let bs=[{isAvailable:({features:e})=>e.sites},{isAvailable:({features:e})=>e.inAppBrowserUseAllowed}],w=n=>bs.filter(r=>r.isAvailable({buildFlavor:i,features:n,platform:p}));function reconcile(n){let i=w(n);logger.info(`bundled_plugins_reconcile_started`);return install({marketplacePluginDescriptors:i})}",
  "function Ud(){let e=i.a.readFromPackageMetadata(),t=e!=null&&i.a.shouldIncludeBrowserUsePeerAuthorization(e,process.platform),n=!t&&Bd(process.env);if(!t&&!n)return()=>({authorized:!0})}",
].join(";");

test("patches and counts every latest use-is-plugins-enabled contract idempotently", () => {
  assert.equal(
    typeof patchPluginWebviewSource,
    "function",
    "latest use-is-plugins-enabled shape needs an exported pure patch helper",
  );

  const first = patchPluginWebviewSource(LATEST_WEBVIEW_FIXTURE);
  assert.equal(first.status, "patched");
  assert.deepEqual(first.counts, {
    auth: { patchable: 1, already: 0, total: 1 },
    availability: { patchable: 5, already: 0, total: 5 },
    statsig: { patchable: 3, already: 0, total: 3 },
  });
  assert.match(
    first.code,
    /authMethod===`chatgpt`\|\|\(0,B\.useContext\)\(x\)\?\.authMethod===`apikey`/,
  );
  assert.match(first.code, /a=!0/);
  assert.match(first.code, /\{allowed:!0,available:!0,isLoading:f,reason:l\}/);

  const second = patchPluginWebviewSource(first.code);
  assert.equal(second.status, "already");
  assert.deepEqual(second.counts, {
    auth: { patchable: 0, already: 1, total: 1 },
    availability: { patchable: 0, already: 5, total: 5 },
    statsig: { patchable: 0, already: 3, total: 3 },
  });
  assert.equal(second.code, first.code);
});

test("patches and counts main defaults, bundled filter, and peer auth independently", () => {
  assert.equal(
    typeof patchPluginMainSource,
    "function",
    "main plugin contracts need an exported pure patch helper",
  );

  const first = patchPluginMainSource(LATEST_MAIN_FIXTURE);
  assert.equal(first.status, "patched");
  assert.deepEqual(first.counts, {
    defaults: { patchable: 10, already: 0, total: 10 },
    filter: { patchable: 1, already: 0, total: 1 },
    peer: { patchable: 1, already: 0, total: 1 },
  });
  assert.equal((first.code.match(/(?:^|[:,])!0/g) ?? []).length >= 11, true);
  assert.match(first.code, /bs\.filter\(\(\)=>!0\)/);
  assert.match(first.code, /if\(!0\)return\(\)=>\(\{authorized:!0\}\)/);

  const second = patchPluginMainSource(first.code);
  assert.equal(second.status, "already");
  assert.deepEqual(second.counts, {
    defaults: { patchable: 0, already: 10, total: 10 },
    filter: { patchable: 0, already: 1, total: 1 },
    peer: { patchable: 0, already: 1, total: 1 },
  });
  assert.equal(second.code, first.code);
});

test("requires every desktop feature default exactly once in one object", () => {
  const duplicatedDefault = LATEST_MAIN_FIXTURE.replace(
    "control:!1,multiWindow:!1",
    "control:!1,browserPane:!1",
  );
  assert.throws(
    () => patchPluginMainSource(duplicatedDefault),
    /defaults|multiWindow|browserPane|duplicate|exact/i,
  );

  const detachedDefault = LATEST_MAIN_FIXTURE.replace(
    "Object.keys(He)",
    "Object.keys({})",
  );
  assert.throws(
    () => patchPluginMainSource(detachedDefault),
    /defaults|live|Object\.keys|binding/i,
  );
});

test("rejects a lexically shadowed filter decoy that never reaches reconcile", () => {
  const deceptiveFilter = LATEST_MAIN_FIXTURE.replace(
    "let bs=[{isAvailable:({features:e})=>e.sites},{isAvailable:({features:e})=>e.inAppBrowserUseAllowed}],w=n=>bs.filter(r=>r.isAvailable({buildFlavor:i,features:n,platform:p}))",
    "function decoy(){let bs=[];return bs.filter(()=>!0)/* CodexRebuildPluginFilter */};let bs=[{isAvailable:({features:e})=>e.sites},{isAvailable:({features:e})=>e.inAppBrowserUseAllowed}],w=n=>bs",
  );
  assert.throws(
    () => patchPluginMainSource(deceptiveFilter),
    /filter|marketplace|reconcile|consumer|lexical/i,
  );
});

test("rejects dead webview evidence outside exported hook return paths", () => {
  const deadWebviewEvidence = [
    "const auth=e.authMethod===`chatgpt`||e.authMethod===`apikey`",
    "function computer(){const featureName=`computer_use`;if(false)!0/* CodexRebuildPluginStatsig */;return{available:!0,isFetching:!1,isLoading:!1}}",
    "function external(){const featureName=`browser_use_external`;if(false)!0/* CodexRebuildPluginStatsig */;return{allowed:!0,available:!0,isLoading:!1}}",
    "function browser(){const featureName=`browser_use`;if(false)!0/* CodexRebuildPluginStatsig */;return{allowed:!0,available:!0,isLoading:!1}}",
  ].join(";");
  assert.throws(
    () => patchPluginWebviewSource(deadWebviewEvidence),
    /hook|export|return|auth|availability|statsig/i,
  );
});

test("rejects main-only, missing, and ambiguous plugin contracts", () => {
  assert.equal(typeof patchPluginContracts, "function");
  assert.throws(
    () => patchPluginContracts({ mainSource: LATEST_MAIN_FIXTURE }),
    /webview.*required/i,
  );
  assert.throws(
    () =>
      patchPluginWebviewSource(
        LATEST_WEBVIEW_FIXTURE.replace("a=v(`410065390`)", "a=!1"),
      ),
    /statsig.*browser_use_external.*expected exactly 1 gate.*found 0/i,
  );
  assert.throws(
    () =>
      patchPluginWebviewSource(
        LATEST_WEBVIEW_FIXTURE.replace(
          "r=(0,B.useContext)(x)?.authMethod===`chatgpt`;return{enabled:n&&r}",
          "r=(0,B.useContext)(x)?.authMethod===`chatgpt`,q=e.authMethod===`chatgpt`;return{enabled:n&&r&&q}",
        ),
      ),
    /auth.*expected exactly 1.*found 2/i,
  );
});

test("ignores unrelated auth comparisons outside exported plugin hook return flow", () => {
  const detachedFastMode =
    "function fastSettings(e,r){let allowed=e.authMethod===`chatgpt`;return allowed&&r.requirements.featureRequirements.fast_mode}";
  const detachedAccount =
    "function unrelatedAccount(e){return e.authMethod===`chatgpt`&&e.accountId}";
  const source = `${LATEST_WEBVIEW_FIXTURE};${detachedFastMode};${detachedAccount}`;

  const first = patchPluginWebviewSource(source);
  assert.equal(first.status, "patched");
  assert.deepEqual(first.counts.auth, { patchable: 1, already: 0, total: 1 });
  assert.ok(first.code.includes(detachedFastMode));
  assert.ok(first.code.includes(detachedAccount));
  assert.equal(
    (first.code.match(/authMethod===`apikey`/g) ?? []).length,
    1,
    "only the plugin hook auth comparison should gain the API-key alternative",
  );

  const second = patchPluginWebviewSource(first.code);
  assert.equal(second.status, "already");
  assert.deepEqual(second.counts.auth, { patchable: 0, already: 1, total: 1 });
  assert.equal(second.code, first.code);
});

test("rejects an unused auth helper called from the computer-use hook", () => {
  const source =
    LATEST_WEBVIEW_FIXTURE
      .replace("function F(e){let", "function F(e){Q();let")
      .replace("r=(0,B.useContext)(x)?.authMethod===`chatgpt`", "r=!0") +
    ";function Q(){return{enabled:y.authMethod===`chatgpt`}}";

  assert.throws(
    () => patchPluginWebviewSource(source),
    /auth.*expected exactly 1.*found 0/i,
  );
});

test("requires plugin auth to feed the computer-use helper enabled property", () => {
  const wrongProperty = LATEST_WEBVIEW_FIXTURE.replace(
    "return{enabled:n&&r}",
    "return{enabled:n,accountAllowed:n&&r}",
  );
  assert.throws(
    () => patchPluginWebviewSource(wrongProperty),
    /auth.*detached.*enabled|auth.*detached.*return/i,
  );

  const browserOnly =
    LATEST_WEBVIEW_FIXTURE
      .replace("r=(0,B.useContext)(x)?.authMethod===`chatgpt`", "r=!0")
      .replace(
        "function H(e){let{hostId:n}=e",
        "function H(e){let q=Q(),{hostId:n}=e",
      )
      .replace("return{allowed:u,available:d", "return{allowed:u&&q.enabled,available:d") +
    ";function Q(){let r=y.authMethod===`chatgpt`;return{enabled:r}}";
  assert.throws(
    () => patchPluginWebviewSource(browserOnly),
    /auth.*expected exactly 1.*found 0/i,
  );
});

test("rejects detached plugin Statsig markers", () => {
  const patched = patchPluginWebviewSource(LATEST_WEBVIEW_FIXTURE).code;
  const detached =
    patched.replaceAll("/* CodexRebuildPluginStatsig */", "") +
    ";const decoyA=!0/* CodexRebuildPluginStatsig */,decoyB=!0/* CodexRebuildPluginStatsig */,decoyC=!0/* CodexRebuildPluginStatsig */";
  assert.throws(
    () => patchPluginWebviewSource(detached),
    /statsig.*browser_use.*expected exactly 1 gate.*found 0/i,
  );
});

test("rejects a plugin filter marker detached from the intended filter", () => {
  const main = patchPluginMainSource(LATEST_MAIN_FIXTURE).code;
  const detachedFilter =
    main.replace("/* CodexRebuildPluginFilter */", "") +
    ";const filterDecoy=!0/* CodexRebuildPluginFilter */";
  assert.throws(
    () => patchPluginMainSource(detachedFilter),
    /filter|marker|attached|postcondition/i,
  );
});

test("rejects duplicate plugin Statsig marker evidence", () => {
  const webview =
    patchPluginWebviewSource(LATEST_WEBVIEW_FIXTURE).code +
    ";const statsigDecoy=!0/* CodexRebuildPluginStatsig */";
  assert.throws(
    () => patchPluginWebviewSource(webview),
    /statsig|marker|attached|postcondition/i,
  );
});

test("requires the exact availability map for every feature context", () => {
  const patched = patchPluginWebviewSource(LATEST_WEBVIEW_FIXTURE).code;
  const misplacedAvailability = patched
    .replace("return{available:!0,isFetching", "return{allowed:!0,available:!0,isFetching")
    .replace("return{allowed:!0,available:!0,isLoading:f", "return{available:!0,isLoading:f");
  assert.throws(
    () => patchPluginWebviewSource(misplacedAvailability),
    /availability|computer_use|browser_use_external|postcondition/i,
  );
});

test("requires exactly one attached Statsig gate per feature context", () => {
  const patched = patchPluginWebviewSource(LATEST_WEBVIEW_FIXTURE).code;
  const marker = "/* CodexRebuildPluginStatsig */";
  const misplacedStatsig = patched
    .replaceAll(marker, "")
    .replace(
      "return{available:!0,isFetching:b,isLoading:x,reason:_}",
      `let A=!0${marker},B=!0${marker},C=!0${marker};return{available:!0,isFetching:b,isLoading:x,reason:_}`,
    );
  assert.throws(
    () => patchPluginWebviewSource(misplacedStatsig),
    /statsig|computer_use|browser_use|postcondition/i,
  );
});

test("rejects a third plugin webview auth alternative", () => {
  const patched = patchPluginWebviewSource(LATEST_WEBVIEW_FIXTURE).code;
  const thirdAlternative = patched.replace(
    "?.authMethod===`apikey`",
    "?.authMethod===`apikey`||(0,B.useContext)(x)?.authMethod===`amazonBedrock`",
  );
  assert.throws(
    () => patchPluginWebviewSource(thirdAlternative),
    /auth|alternative|postcondition|exact/i,
  );
});

test("classifies the latest main and use-is-plugins-enabled bundles as required targets", () => {
  assert.equal(typeof classifyPluginTarget, "function");
  assert.equal(classifyPluginTarget("main-CZpDUN17.js", LATEST_MAIN_FIXTURE), "main");
  assert.equal(
    classifyPluginTarget("use-is-plugins-enabled-D8AJYG6G.js", LATEST_WEBVIEW_FIXTURE),
    "webview",
  );
  assert.equal(classifyPluginTarget("unrelated.js", "const value = 1"), null);
});

test("Windows plugin planning ignores a webview main bootstrap decoy", () => {
  const realMain = {
    fileName: "main-CZpDUN17.js",
    filePath: ".vite/build/main-CZpDUN17.js",
    source: LATEST_MAIN_FIXTURE,
  };
  const bootstrapDecoy = {
    fileName: "main-CK8yaEB6.js",
    filePath: "webview/assets/main-CK8yaEB6.js",
    source: "import{bootstrap}from`./bootstrap.js`;bootstrap();",
  };
  const webview = {
    fileName: "use-is-plugins-enabled-D8AJYG6G.js",
    filePath: "webview/assets/use-is-plugins-enabled-D8AJYG6G.js",
    source: LATEST_WEBVIEW_FIXTURE,
  };

  const result = planPluginPlatform({
    platform: "win",
    candidates: [realMain, bootstrapDecoy, webview],
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(result.writes[0].matches.main, [realMain]);
  assert.deepEqual(result.writes[0].matches.webview, [webview]);
});

function validMacPluginCandidates(prefix) {
  return [
    {
      fileName: `main-${prefix}.js`,
      filePath: `.vite/build/main-${prefix}.js`,
      source: LATEST_MAIN_FIXTURE,
    },
    {
      fileName: `main-${prefix}-bootstrap.js`,
      filePath: `webview/assets/main-${prefix}-bootstrap.js`,
      source: "import{bootstrap}from`./bootstrap.js`;bootstrap();",
    },
    {
      fileName: `chatgpt~gwqc41kz-${prefix}.js`,
      filePath: `webview/assets/chatgpt~gwqc41kz-${prefix}.js`,
      source: LATEST_WEBVIEW_FIXTURE,
    },
    {
      fileName: `statsig-token-decoy-${prefix}.js`,
      filePath: `webview/assets/statsig-token-decoy-${prefix}.js`,
      source:
        "const tokens=[`chatgpt`,`authMethod`,`browser_use`,`computer_use`,`410262010`,`Statsig`];",
    },
  ];
}

test("macOS matrix locates structural main and consolidated webview roles", () => {
  for (const platform of ["mac-arm64", "mac-x64"]) {
    const result = planPluginPlatform({
      platform,
      candidates: validMacPluginCandidates(platform),
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(
      result.writes[0].matches.main.map(({ fileName }) => fileName),
      [`main-${platform}.js`],
    );
    assert.deepEqual(
      result.writes[0].matches.webview.map(({ fileName }) => fileName),
      [`chatgpt~gwqc41kz-${platform}.js`],
    );
    assert.deepEqual(result.writes[0].result.main.counts, {
      defaults: { patchable: 10, already: 0, total: 10 },
      filter: { patchable: 1, already: 0, total: 1 },
      peer: { patchable: 1, already: 0, total: 1 },
    });
    assert.deepEqual(result.writes[0].result.webview.counts, {
      auth: { patchable: 1, already: 0, total: 1 },
      availability: { patchable: 5, already: 0, total: 5 },
      statsig: { patchable: 3, already: 0, total: 3 },
    });
  }
});

test("macOS structural roles accept already-patched main and webview contracts", () => {
  const candidates = validMacPluginCandidates("already").map((candidate) => {
    if (candidate.filePath.startsWith(".vite/build/")) {
      return { ...candidate, source: patchPluginMainSource(candidate.source).code };
    }
    if (candidate.fileName.startsWith("chatgpt~")) {
      return { ...candidate, source: patchPluginWebviewSource(candidate.source).code };
    }
    return candidate;
  });
  const result = planPluginPlatform({ platform: "mac-arm64", candidates });
  assert.equal(result.writes[0].result.main.status, "already");
  assert.equal(result.writes[0].result.webview.status, "already");
});

test("macOS plugin roles are isolated to their resource roots", () => {
  const candidates = [
    ...validMacPluginCandidates("scoped"),
    {
      fileName: "webview-main-shaped.js",
      filePath: "webview/assets/webview-main-shaped.js",
      source: LATEST_MAIN_FIXTURE,
    },
    {
      fileName: "build-webview-shaped.js",
      filePath: ".vite/build/build-webview-shaped.js",
      source: LATEST_WEBVIEW_FIXTURE,
    },
  ];

  const result = planPluginPlatform({ platform: "mac-arm64", candidates });
  assert.deepEqual(
    result.writes[0].matches.main.map(({ fileName }) => fileName),
    ["main-scoped.js"],
  );
  assert.deepEqual(
    result.writes[0].matches.webview.map(({ fileName }) => fileName),
    ["chatgpt~gwqc41kz-scoped.js"],
  );
});

test("macOS main ownership ignores detached partial-family token collections", () => {
  const partialDecoy = {
    fileName: "partial-main-decoy.js",
    filePath: ".vite/build/partial-main-decoy.js",
    source: [
      "const partial={browserPane:!1,inAppBrowserUse:!1,computerUse:!1}",
      "const detached={\"features.js_repl\":!1}",
      "const unrelated={shouldIncludeBrowserUsePeerAuthorization:()=>!1}",
    ].join(";"),
  };
  const result = planPluginPlatform({
    platform: "mac-arm64",
    candidates: [...validMacPluginCandidates("partial"), partialDecoy],
  });
  assert.deepEqual(
    result.writes[0].matches.main.map(({ fileName }) => fileName),
    ["main-partial.js"],
  );
});

test("macOS webview ownership ignores detached auth and unexported availability", () => {
  const detachedDecoy = {
    fileName: "detached-webview-decoy.js",
    filePath: "webview/assets/detached-webview-decoy.js",
    source: [
      "const detached=session.authMethod===`chatgpt`",
      "function hidden(){let gate=v(`410262010`),config={featureName:`browser_use`};return{allowed:gate,available:gate,isLoading:!1}}",
      "export const unrelated=1",
    ].join(";"),
  };
  const result = planPluginPlatform({
    platform: "mac-x64",
    candidates: [...validMacPluginCandidates("detached"), detachedDecoy],
  });
  assert.deepEqual(
    result.writes[0].matches.webview.map(({ fileName }) => fileName),
    ["chatgpt~gwqc41kz-detached.js"],
  );
});

test("macOS complete desktop defaults without filter and peer are owned malformed", () => {
  const malformedDefaults = {
    fileName: "owned-main-missing-contracts.js",
    filePath: ".vite/build/owned-main-missing-contracts.js",
    source: [
      "let He={browserPane:!1,inAppBrowserUse:!1,inAppBrowserUseAllowed:!1,externalBrowserUse:!1,externalBrowserUseAllowed:!1,computerUse:!1,computerUseNodeRepl:!1,control:!1,multiWindow:!1}",
      "let featureKeys=Object.keys(He)",
      "let fr={\"features.js_repl\":!1}",
    ].join(";"),
  };
  assert.throws(
    () =>
      planPluginPlatform({
        platform: "mac-arm64",
        candidates: [...validMacPluginCandidates("valid-main"), malformedDefaults],
      }),
    /plugin-main|owned-main-missing-contracts|owned-malformed|filter|peer/i,
  );
});

test("macOS complete exported availability and Statsig family without auth is owned malformed", () => {
  const malformedWebview = {
    fileName: "owned-webview-missing-auth.js",
    filePath: "webview/assets/owned-webview-missing-auth.js",
    source: LATEST_WEBVIEW_FIXTURE.replace(
      "function I(e){let t=(0,z.c)(21),{enabled:n}=e,r=(0,B.useContext)(x)?.authMethod===`chatgpt`;return{enabled:n&&r}}",
      "function I(e){let{enabled:n}=e;return{enabled:n}}",
    ),
  };
  assert.throws(
    () =>
      planPluginPlatform({
        platform: "mac-x64",
        candidates: [...validMacPluginCandidates("valid-webview"), malformedWebview],
      }),
    /plugin-webview|owned-webview-missing-auth|owned-malformed|auth/i,
  );
});

test("macOS malformed and duplicate structural roles fail closed", async (t) => {
  const cases = [
    [
      "owned malformed webview",
      (platform) =>
        validMacPluginCandidates(platform).map((candidate) =>
          candidate.fileName.startsWith("chatgpt~")
            ? {
                ...candidate,
                fileName: `chatgpt~malformed-${platform}.js`,
                filePath: `webview/assets/chatgpt~malformed-${platform}.js`,
                source: candidate.source.replace("a=v(`410065390`)", "a=!1"),
              }
            : candidate,
        ),
      /plugin-webview|malformed|owned-malformed|statsig/i,
    ],
    [
      "owned malformed main",
      (platform) =>
        validMacPluginCandidates(platform).map((candidate) =>
          candidate.filePath.startsWith(".vite/build/")
            ? {
                ...candidate,
                fileName: `main-malformed-${platform}.js`,
                filePath: `.vite/build/main-malformed-${platform}.js`,
                source: candidate.source.replace("multiWindow:!1", "multiWindow:unknown"),
              }
            : candidate,
        ),
      /plugin-main|main-malformed|owned-malformed|defaults/i,
    ],
    [
      "duplicate main",
      (platform) => [
        ...validMacPluginCandidates(platform),
        {
          fileName: `other-main-${platform}.js`,
          filePath: `.vite/build/other-main-${platform}.js`,
          source: LATEST_MAIN_FIXTURE,
        },
      ],
      /plugin-main|main-.*\.js|exact candidates: 2/i,
    ],
    [
      "duplicate webview",
      (platform) => [
        ...validMacPluginCandidates(platform),
        {
          fileName: `other-consolidated-${platform}.js`,
          filePath: `webview/assets/other-consolidated-${platform}.js`,
          source: LATEST_WEBVIEW_FIXTURE,
        },
      ],
      /plugin-webview|chatgpt~|other-consolidated|exact candidates: 2/i,
    ],
  ];
  for (const platform of ["mac-arm64", "mac-x64"]) {
    for (const [name, makeCandidates, expected] of cases) {
      await t.test(`${platform}: ${name}`, () => {
        assert.throws(
          () => planPluginPlatform({ platform, candidates: makeCandidates(platform) }),
          expected,
        );
      });
    }
  }
});

test("plugin orchestrator plans all platforms before commit writes", async (t) => {
  await t.test("later platform failure produces zero writes", () => {
    const writes = [];
    const invalidX64 = [
      ...validMacPluginCandidates("x64"),
      {
        fileName: "duplicate-webview.js",
        filePath: "webview/assets/duplicate-webview.js",
        source: LATEST_WEBVIEW_FIXTURE,
      },
    ];
    assert.throws(
      () =>
        executePluginPlatforms({
          platformInputs: [
            { platform: "mac-arm64", candidates: validMacPluginCandidates("arm64") },
            { platform: "mac-x64", candidates: invalidX64 },
          ],
          writeFile: (...args) => writes.push(args),
        }),
      /mac-x64|plugin-webview|exact candidates: 2/i,
    );
    assert.equal(writes.length, 0);
  });

  await t.test("successful writes run through the unified commit phase", () => {
    const writes = [];
    const result = executePluginPlatforms({
      platformInputs: [
        { platform: "mac-arm64", candidates: validMacPluginCandidates("arm64") },
        { platform: "mac-x64", candidates: validMacPluginCandidates("x64") },
      ],
      writeFile: (...args) => writes.push(args),
    });
    assert.equal(result.platformPlans.length, 2);
    assert.equal(writes.length, 4);
    assert.deepEqual(
      writes.map(([filePath]) => filePath),
      [
        ".vite/build/main-arm64.js",
        "webview/assets/chatgpt~gwqc41kz-arm64.js",
        ".vite/build/main-x64.js",
        "webview/assets/chatgpt~gwqc41kz-x64.js",
      ],
    );
  });
});

test("plugin summary reports both macOS architectures ready", () => {
  const summary = formatPluginSummary([
    { platform: "mac-arm64", status: "ready" },
    { platform: "mac-x64", status: "ready" },
    { platform: "win", status: "ready" },
  ]);
  assert.match(summary, /skipped=\[\]/);
  assert.match(summary, /ready=\[mac-arm64,mac-x64,win\]/);
  assert.doesNotMatch(summary, /\bok\b|contracts satisfied/i);
});

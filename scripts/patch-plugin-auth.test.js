#!/usr/bin/env node
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  patchPluginMainSource,
  patchPluginWebviewSource,
  patchPluginContracts,
  classifyPluginTarget,
} = require("./patch-plugin-auth");

const LATEST_WEBVIEW_FIXTURE = [
  "function F(e){let{enabled:n,hostId:r}=e,s=v(`1506311413`),c={featureName:`computer_use`,hostId:r},l=j(c),p=I({enabled:n}),y=l.enabled&&p.enabled&&s,b=l.isFetching,x=l.isLoading,_=s?l.reason:`statsig-disabled`;return{available:y,isFetching:b,isLoading:x,reason:_}}",
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
        `${LATEST_WEBVIEW_FIXTURE};function Q(){return y.authMethod===\`chatgpt\`}`,
      ),
    /auth.*expected exactly 1.*found 2/i,
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

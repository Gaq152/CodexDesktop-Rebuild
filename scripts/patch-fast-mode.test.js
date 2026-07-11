#!/usr/bin/env node
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  patchFastModeSource,
  planFastModeTargets,
  planFastModePlatform,
} = require("./patch-fast-mode");

const LATEST_FAST_MODE_FIXTURE =
  "function J(e){let t=(0,Y.c)(6),n=i(h),r=e?.hostId??n,a=I(r),o=a?.authMethod===`chatgpt`,c=a?.authMethod??null,l;t[0]!==r||t[1]!==c?(l={authMethod:c,hostId:r},t[0]=r,t[1]=c,t[2]=l):l=t[2];let{data:u,isPending:d}=s(j,l),f=!!a?.isLoading||o&&d,p=o&&!f&&u!=null&&u?.requirements?.featureRequirements?.fast_mode!==!1,m;return t[3]!==f||t[4]!==p?(m={isServiceTierAllowed:p,isLoading:f},t[3]=f,t[4]=p,t[5]=m):m=t[5],m}";
const LATEST_FAST_REQUEST_FIXTURE =
  "async function T(e,t){let n=await x(e,t);if(n!==`chatgpt`)return!1;let r=await v(t,{priority:`critical`});return e.query.setData(g,{authMethod:n,hostId:t},r),r.requirements?.featureRequirements?.fast_mode!==!1}";

test("patches the latest fast_mode API-key auth gate exactly once and is idempotent", () => {
  assert.equal(
    typeof patchFastModeSource,
    "function",
    "latest fast_mode shape needs an exported pure patch helper",
  );

  const first = patchFastModeSource(LATEST_FAST_MODE_FIXTURE);
  assert.equal(first.status, "patched");
  assert.deepEqual(first.counts, { patchable: 1, already: 0, total: 1 });
  assert.match(
    first.code,
    /\(a\?\.authMethod===`chatgpt`\|\|a\?\.authMethod===`apikey`\)/,
  );

  const second = patchFastModeSource(first.code);
  assert.equal(second.status, "already");
  assert.deepEqual(second.counts, { patchable: 0, already: 1, total: 1 });
  assert.equal(second.code, first.code);
});

test("patches the latest request-time fast_mode auth gate and remains idempotent", () => {
  const first = patchFastModeSource(LATEST_FAST_REQUEST_FIXTURE);
  assert.equal(first.status, "patched");
  assert.deepEqual(first.counts, { patchable: 1, already: 0, total: 1 });
  assert.match(
    first.code,
    /if\(\(n!==`chatgpt`&&n!==`apikey`\)\/\* CodexRebuildFastModeRequestAuth \*\/\)return!1/,
  );

  const second = patchFastModeSource(first.code);
  assert.equal(second.status, "already");
  assert.deepEqual(second.counts, { patchable: 0, already: 1, total: 1 });
  assert.equal(second.code, first.code);
});

test("request-time fast_mode authorization still rejects non-OpenAI auth kinds", () => {
  const source =
    "function T(n){if(n!==`chatgpt`)return!1;return `fast_mode`}";
  const { code } = patchFastModeSource(source);
  const requestFastMode = Function(`${code};return T`)();

  assert.equal(requestFastMode("chatgpt"), "fast_mode");
  assert.equal(requestFastMode("apikey"), "fast_mode");
  assert.equal(requestFastMode("amazonBedrock"), false);
  assert.equal(requestFastMode("copilot"), false);
  assert.equal(requestFastMode(null), false);
});

test("rejects a third settings auth alternative", () => {
  assert.throws(
    () =>
      patchFastModeSource(
        "function settings(auth,requirements){return requirements.fast_mode&&(auth===`chatgpt`||auth===`apikey`||auth===`amazonBedrock`)}",
      ),
    /fast_mode|auth gate|postcondition|exact/i,
  );
});

test("rejects duplicate request markers in already evidence", () => {
  assert.throws(
    () =>
      patchFastModeSource(
        "function read(auth,requirements){if((auth!==`chatgpt`&&auth!==`apikey`)/* CodexRebuildFastModeRequestAuth *//* CodexRebuildFastModeRequestAuth */)return!1;return requirements.fast_mode}",
      ),
    /fast_mode|auth gate|marker|postcondition|exact/i,
  );
});

test("rejects a marked request gate whose consequent does not reject", () => {
  assert.throws(
    () =>
      patchFastModeSource(
        "function read(auth,requirements){if((auth!==`chatgpt`&&auth!==`apikey`)/* CodexRebuildFastModeRequestAuth */){return!0}return requirements.fast_mode}",
      ),
    /fast_mode|auth gate|consequent|postcondition|exact/i,
  );
});

test("rejects parse failures and zero or ambiguous fast_mode anchors", () => {
  assert.equal(typeof patchFastModeSource, "function");
  assert.throws(() => patchFastModeSource("function {"), /parse failed/i);
  assert.throws(
    () => patchFastModeSource("function J(){return `fast_mode chatgpt`}"),
    /expected exactly 1.*found 0/i,
  );
  assert.throws(
    () =>
      patchFastModeSource(
        "function J(a,b){return `fast_mode`&&(a.authMethod===`chatgpt`||b.authMethod===`chatgpt`)}",
      ),
    /expected exactly 1.*found 2/i,
  );
});

test("ignores token-only decoy bundles and plans both semantic fast_mode targets", () => {
  assert.equal(
    typeof planFastModeTargets,
    "function",
    "bundle planning must distinguish both semantic gates from token-only chunks",
  );

  const plans = planFastModeTargets(
    [
      {
        fileName: "app-main-BEs0GGm0.js",
        source: "function A(){return `fast_mode chatgpt`}",
      },
      {
        fileName: "app-server-manager-signals-6h9KdwyQ.js",
        source: "function B(){return `fast_mode chatgpt`}",
      },
      {
        fileName: "read-service-tier-for-request-D2fynmwS.js",
        source: "function C(){return `fast_mode chatgpt`}",
      },
      {
        fileName: "use-service-tier-settings-uyaJ6nX6.js",
        source: LATEST_FAST_MODE_FIXTURE,
      },
      {
        fileName: "read-service-tier-for-request-D2fynmwS.js",
        source: LATEST_FAST_REQUEST_FIXTURE,
      },
      {
        fileName: "app-main-decoy.js",
        source:
          "function D(mode){if(mode!==`chatgpt`)return!1;return `fast_mode`}",
      },
    ],
    "win",
  );

  assert.deepEqual(
    plans.map((plan) => plan.fileName),
    [
      "use-service-tier-settings-uyaJ6nX6.js",
      "read-service-tier-for-request-D2fynmwS.js",
    ],
  );
  for (const plan of plans) {
    assert.deepEqual(plan.result.counts, {
      patchable: 1,
      already: 0,
      total: 1,
    });
  }
});

test("platform matrix skips only an absent macOS fast-mode settings layer", () => {
  const request = {
    fileName: "read-service-tier-for-request-mac.js",
    source: LATEST_FAST_REQUEST_FIXTURE,
  };
  for (const platform of ["mac-arm64", "mac-x64"]) {
    const warnings = [];
    const result = planFastModePlatform({
      platform,
      candidates: [request],
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(result, { status: "skipped", writes: [] });
    assert.deepEqual(warnings, [
      `[skip] fast-mode: unsupported target layout on ${platform}`,
    ]);
  }
  assert.throws(
    () => planFastModePlatform({ platform: "win", candidates: [request] }),
    /settings.*expected exactly 1.*found 0/i,
  );

  const incomplete = {
    fileName: "use-service-tier-settings-incomplete.js",
    source: "function settings(){return `fast_mode`}",
  };
  assert.throws(
    () => planFastModePlatform({ platform: "mac-arm64", candidates: [request, incomplete] }),
    /settings|incomplete|expected exactly 1/i,
  );
  assert.throws(
    () => planFastModePlatform({
      platform: "mac-x64",
      candidates: [
        request,
        { fileName: "use-service-tier-settings-a.js", source: LATEST_FAST_MODE_FIXTURE },
        { fileName: "use-service-tier-settings-b.js", source: LATEST_FAST_MODE_FIXTURE },
      ],
    }),
    /settings.*expected exactly 1.*found 2/i,
  );
});

#!/usr/bin/env node
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  patchFastModeSource,
  planFastModeTargets,
  planFastModePlatform,
  executeFastModePlatforms,
  formatFastModeSummary,
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
        fileName: "request-token-decoy-D2fynmwS.js",
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

test("macOS matrix locates consolidated structural roles and ignores token decoys", () => {
  for (const platform of ["mac-arm64", "mac-x64"]) {
    const visited = [];
    const result = planFastModePlatform({
      platform,
      candidates: [
        {
          path: "webview/assets/main-bootstrap.js",
          fileName: "main-bootstrap.js",
          source:
            "import './fast_mode.js';const token=`fast_mode chatgpt`;" +
            "function unrelated(auth){const label=`fast_mode`;return auth===`chatgpt`}",
        },
        {
          path: "webview/assets/broken-token-decoy.js",
          fileName: "broken-token-decoy.js",
          source:
            "function broken(auth,r){return r.featureRequirements.fast_mode&&auth===`chatgpt`",
        },
        {
          path: "webview/assets/app-initial~app-main~onboarding-page-D4eTO0KG.js",
          fileName: "app-initial~app-main~onboarding-page-D4eTO0KG.js",
          source: LATEST_FAST_MODE_FIXTURE,
        },
        {
          path: "webview/assets/chatgpt~gwqc41kz-Bj9ubaFn.js",
          fileName: "chatgpt~gwqc41kz-Bj9ubaFn.js",
          source: LATEST_FAST_REQUEST_FIXTURE,
        },
      ],
    });
    assert.equal(result.status, "ready");
    visited.push(...result.writes.map((selected) => selected.role));
    assert.deepEqual(visited, ["fast-settings", "fast-request"]);
    assert.deepEqual(
      result.writes.map((selected) => selected.fileName),
      [
        "app-initial~app-main~onboarding-page-D4eTO0KG.js",
        "chatgpt~gwqc41kz-Bj9ubaFn.js",
      ],
    );
  }
});

test("macOS supports settings and request roles consolidated into one bundle", () => {
  const source = `${LATEST_FAST_MODE_FIXTURE};${LATEST_FAST_REQUEST_FIXTURE}`;
  const candidate = {
    path: "webview/assets/app-initial~app-main~chatgpt-consolidated.js",
    fileName: "app-initial~app-main~chatgpt-consolidated.js",
    source,
  };
  const writes = [];
  const execution = executeFastModePlatforms({
    platformInputs: [{ platform: "mac-x64", candidates: [candidate] }],
    writeFile: (...args) => writes.push(args),
  });

  assert.deepEqual(
    execution.platformPlans[0].writes.map(({ role }) => role),
    ["fast-settings", "fast-request"],
  );
  assert.equal(writes.length, 1, "a consolidated bundle must be committed only once");
  const patched = writes[0][1];
  assert.match(patched, /authMethod===`chatgpt`\|\|a\?\.authMethod===`apikey`/);
  assert.match(patched, /n!==`chatgpt`&&n!==`apikey`/);

  const idempotentWrites = [];
  const second = executeFastModePlatforms({
    platformInputs: [{
      platform: "mac-x64",
      candidates: [{ ...candidate, source: patched }],
    }],
    writeFile: (...args) => idempotentWrites.push(args),
  });
  assert.deepEqual(
    second.platformPlans[0].writes.map(({ result }) => result.status),
    ["already", "already"],
  );
  assert.equal(idempotentWrites.length, 0);
});

test("macOS accepts already-patched structural settings and request roles", () => {
  const settings = patchFastModeSource(LATEST_FAST_MODE_FIXTURE).code;
  const request = patchFastModeSource(LATEST_FAST_REQUEST_FIXTURE).code;
  const result = planFastModePlatform({
    platform: "mac-arm64",
    candidates: [
      {
        path: "webview/assets/consolidated-settings.js",
        fileName: "consolidated-settings.js",
        source: settings,
      },
      {
        path: "webview/assets/consolidated-request.js",
        fileName: "consolidated-request.js",
        source: request,
      },
    ],
  });
  assert.deepEqual(
    result.writes.map(({ result: writeResult }) => writeResult.status),
    ["already", "already"],
  );
});

test("macOS malformed and duplicate role plans fail before any writer", async (t) => {
  const cases = [
    [
      "owned malformed settings",
      [
        {
          path: "webview/assets/settings-malformed.js",
          fileName: "settings-malformed.js",
          source:
            "function settings(auth,r){return r.featureRequirements.fast_mode&&(auth===`chatgpt`||auth===`apikey`||auth===`amazonBedrock`)}",
        },
        {
          path: "webview/assets/request.js",
          fileName: "request.js",
          source: LATEST_FAST_REQUEST_FIXTURE,
        },
      ],
      /fast-settings|settings-malformed|owned-malformed|extra alternatives/i,
    ],
    [
      "duplicate exact settings",
      [
        {
          path: "webview/assets/settings-one.js",
          fileName: "settings-one.js",
          source: LATEST_FAST_MODE_FIXTURE,
        },
        {
          path: "webview/assets/settings-two.js",
          fileName: "settings-two.js",
          source: LATEST_FAST_MODE_FIXTURE,
        },
        {
          path: "webview/assets/request.js",
          fileName: "request.js",
          source: LATEST_FAST_REQUEST_FIXTURE,
        },
      ],
      /fast-settings|settings-one|settings-two|exact candidates: 2/i,
    ],
    [
      "duplicate settings inside a consolidated bundle",
      [
        {
          path: "webview/assets/consolidated-duplicate-settings.js",
          fileName: "consolidated-duplicate-settings.js",
          source:
            `${LATEST_FAST_MODE_FIXTURE};${LATEST_FAST_MODE_FIXTURE};` +
            LATEST_FAST_REQUEST_FIXTURE,
        },
      ],
      /fast-settings|consolidated-duplicate-settings|owned-malformed|role=2|target/i,
    ],
    [
      "owned malformed request",
      [
        {
          path: "webview/assets/settings.js",
          fileName: "settings.js",
          source: LATEST_FAST_MODE_FIXTURE,
        },
        {
          path: "webview/assets/request-malformed.js",
          fileName: "request-malformed.js",
          source:
            "function request(auth,r){if((auth!==`chatgpt`&&auth!==`apikey`)/* CodexRebuildFastModeRequestAuth */){return!0}return r.featureRequirements.fast_mode}",
        },
      ],
      /fast-request|request-malformed|owned-malformed|strict mismatch/i,
    ],
    [
      "duplicate exact request",
      [
        {
          path: "webview/assets/settings.js",
          fileName: "settings.js",
          source: LATEST_FAST_MODE_FIXTURE,
        },
        {
          path: "webview/assets/request-one.js",
          fileName: "request-one.js",
          source: LATEST_FAST_REQUEST_FIXTURE,
        },
        {
          path: "webview/assets/request-two.js",
          fileName: "request-two.js",
          source: LATEST_FAST_REQUEST_FIXTURE,
        },
      ],
      /fast-request|request-one|request-two|exact candidates: 2/i,
    ],
  ];

  for (const platform of ["mac-arm64", "mac-x64"]) {
    for (const [name, candidates, expected] of cases) {
      await t.test(`${platform}: ${name}`, () => {
        assert.throws(
          () =>
            planFastModePlatform({
              platform,
              candidates,
            }),
          expected,
        );
      });
    }
  }
});

function validMacCandidates(prefix) {
  return [
    {
      path: `webview/assets/${prefix}-settings.js`,
      fileName: `${prefix}-settings.js`,
      source: LATEST_FAST_MODE_FIXTURE,
    },
    {
      path: `webview/assets/${prefix}-request.js`,
      fileName: `${prefix}-request.js`,
      source: LATEST_FAST_REQUEST_FIXTURE,
    },
  ];
}

test("platform orchestrator plans every platform before commit writes", async (t) => {
  await t.test("a later invalid platform leaves every file untouched", () => {
    const writes = [];
    assert.throws(
      () =>
        executeFastModePlatforms({
          platformInputs: [
            { platform: "mac-arm64", candidates: validMacCandidates("arm") },
            {
              platform: "mac-x64",
              candidates: [
                ...validMacCandidates("x64"),
                {
                  path: "webview/assets/x64-settings-duplicate.js",
                  fileName: "x64-settings-duplicate.js",
                  source: LATEST_FAST_MODE_FIXTURE,
                },
              ],
            },
          ],
          writeFile: (...args) => writes.push(args),
        }),
      /mac-x64|fast-settings|exact candidates: 2/i,
    );
    assert.equal(writes.length, 0);
  });

  await t.test("conflicting consolidated paths fail before every write", () => {
    const writes = [];
    assert.throws(
      () =>
        executeFastModePlatforms({
          platformInputs: [{
            platform: "mac-x64",
            candidates: [
              {
                path: "webview/assets/shared.js",
                fileName: "shared-settings.js",
                source: LATEST_FAST_MODE_FIXTURE,
              },
              {
                path: "webview/assets/shared.js",
                fileName: "shared-request.js",
                source: LATEST_FAST_REQUEST_FIXTURE,
              },
            ],
          }],
          writeFile: (...args) => writes.push(args),
        }),
      /consolidated roles produced conflicting writes.*shared\.js/i,
    );
    assert.equal(writes.length, 0);
  });

  await t.test("successful writes occur in the unified commit phase", () => {
    const writes = [];
    const result = executeFastModePlatforms({
      platformInputs: [
        { platform: "mac-arm64", candidates: validMacCandidates("arm") },
        { platform: "mac-x64", candidates: validMacCandidates("x64") },
      ],
      writeFile: (...args) => writes.push(args),
    });
    assert.equal(result.platformPlans.length, 2);
    assert.equal(writes.length, 4);
    assert.deepEqual(
      writes.map(([filePath]) => filePath),
      [
        "webview/assets/arm-settings.js",
        "webview/assets/arm-request.js",
        "webview/assets/x64-settings.js",
        "webview/assets/x64-request.js",
      ],
    );
  });
});

test("Windows keeps filename-exact target selection", () => {
  assert.throws(
    () =>
      planFastModePlatform({
        platform: "win",
        candidates: [
          {
            fileName: "consolidated-settings.js",
            source: LATEST_FAST_MODE_FIXTURE,
          },
          {
            fileName: "read-service-tier-for-request-win.js",
            source: LATEST_FAST_REQUEST_FIXTURE,
          },
        ],
      }),
    /settings.*expected exactly 1.*found 0/i,
  );
});

test("fast-mode summary reports both macOS architectures ready", () => {
  const summary = formatFastModeSummary([
    { platform: "mac-arm64", status: "ready" },
    { platform: "mac-x64", status: "ready" },
    { platform: "win", status: "ready" },
  ]);
  assert.match(summary, /skipped=\[\]/);
  assert.match(summary, /ready=\[mac-arm64,mac-x64,win\]/);
  assert.doesNotMatch(summary, /\bok\b|contracts satisfied/i);
});

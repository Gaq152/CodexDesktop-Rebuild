#!/usr/bin/env node
const assert = require("assert");
const test = require("node:test");

const {
  probeCandidates,
  reduceRequiredRole,
  planRequiredRoles,
  commitValidatedPlan,
} = require("./mac-contract-locator");

function candidate(path, source = `source:${path}`) {
  return {
    path,
    fileName: path.split("/").at(-1),
    source,
  };
}

function probe(state, evidence, options = {}) {
  return {
    state,
    evidence,
    ...(options.result === undefined ? {} : { result: options.result }),
    ...(options.error === undefined ? {} : { error: options.error }),
  };
}

function assertDiagnostic(error, { platform, role, path, mismatch }) {
  assert.match(error.message, new RegExp(platform));
  assert.match(error.message, new RegExp(role));
  assert.match(error.message, new RegExp(`path: ${path}`));
  assert.match(error.message, /evidence:/);
  assert.match(error.message, /strict mismatch:/);
  if (mismatch) assert.match(error.message, mismatch);
  return true;
}

test("reduces one exact candidate while retaining irrelevant probes", () => {
  const candidates = [candidate("assets/decoy.js"), candidate("assets/contract.js")];
  const probes = probeCandidates({
    platform: "mac-arm64",
    role: "fast-settings",
    candidates,
    probe: (item) =>
      item.path.endsWith("contract.js")
        ? probe("exact", ["settings marker", "strict count=1"], { result: { count: 1 } })
        : probe("irrelevant", []),
  });

  assert.equal(probes.length, 2);
  assert.equal(probes[0].candidate, candidates[0]);
  assert.equal(probes[1].candidate, candidates[1]);
  assert.deepEqual(
    reduceRequiredRole({ platform: "mac-arm64", role: "fast-settings", probes }),
    {
      platform: "mac-arm64",
      role: "fast-settings",
      candidate: candidates[1],
      result: { count: 1 },
    },
  );
});

test("rejects a required role with zero exact candidates", () => {
  const probes = probeCandidates({
    platform: "mac-x64",
    role: "plugin-main",
    candidates: [candidate("assets/one.js"), candidate("assets/two.js")],
    probe: () => probe("irrelevant", []),
  });

  assert.throws(
    () => reduceRequiredRole({ platform: "mac-x64", role: "plugin-main", probes }),
    (error) => {
      assert.match(error.message, /mac-x64/);
      assert.match(error.message, /plugin-main/);
      assert.match(error.message, /exact candidates: 0/);
      return true;
    },
  );
});

test("empty candidate reduction uses the complete diagnostic contract", () => {
  assert.throws(
    () => reduceRequiredRole({ platform: "mac-arm64", role: "fast-settings", probes: [] }),
    (error) =>
      assertDiagnostic(error, {
        platform: "mac-arm64",
        role: "fast-settings",
        path: "<no candidates>",
        mismatch: /expected exactly one exact candidate/i,
      }),
  );
});

test("rejects two exact candidates and lists both paths and evidence", () => {
  const probes = probeCandidates({
    platform: "mac-arm64",
    role: "archive-route",
    candidates: [candidate("assets/first.js"), candidate("assets/second.js")],
    probe: (item) => probe("exact", [`route anchor in ${item.fileName}`], { result: {} }),
  });

  assert.throws(
    () => reduceRequiredRole({ platform: "mac-arm64", role: "archive-route", probes }),
    (error) => {
      assert.match(error.message, /exact candidates: 2/);
      assert.match(error.message, /assets\/first\.js/);
      assert.match(error.message, /route anchor in first\.js/);
      assert.match(error.message, /assets\/second\.js/);
      assert.match(error.message, /route anchor in second\.js/);
      return true;
    },
  );
});

test("rejects an exact candidate when any owned candidate is malformed", () => {
  const probes = probeCandidates({
    platform: "mac-x64",
    role: "sidebar-ui",
    candidates: [candidate("assets/exact.js"), candidate("assets/malformed.js")],
    probe: (item) =>
      item.path.endsWith("exact.js")
        ? probe("exact", ["row ownership", "strict count=1"], { result: { count: 1 } })
        : probe("owned-malformed", ["row ownership", "additionalHoverActionCount"], {
            error: new Error("strict mismatch: expected one row contract, found 0"),
          }),
  });

  assert.throws(
    () => reduceRequiredRole({ platform: "mac-x64", role: "sidebar-ui", probes }),
    (error) => {
      assert.match(error.message, /mac-x64/);
      assert.match(error.message, /sidebar-ui/);
      assert.match(error.message, /assets\/malformed\.js/);
      assert.match(error.message, /additionalHoverActionCount/);
      assert.match(error.message, /strict mismatch: expected one row contract, found 0/);
      return true;
    },
  );
});

test("probes every candidate through a read-only candidate view", () => {
  const visited = [];
  const candidates = [candidate("assets/exact.js"), candidate("assets/later.js")];

  const probes = probeCandidates({
    platform: "mac-arm64",
    role: "plugin-webview",
    candidates,
    probe: (item) => {
      assert.equal(Object.isFrozen(item), true);
      assert.deepEqual(Object.keys(item).sort(), ["fileName", "path", "source"]);
      visited.push(item.path);
      return item.path.endsWith("exact.js")
        ? probe("exact", ["auth marker"], { result: { patched: true } })
        : probe("irrelevant", []);
    },
  });

  assert.deepEqual(visited, candidates.map((item) => item.path));
  assert.equal(probes.length, candidates.length);
});

test("wraps probe exceptions after probing all candidates with role context", () => {
  const visited = [];
  const candidates = [candidate("assets/broken.js"), candidate("assets/later.js")];

  assert.throws(
    () =>
      probeCandidates({
        platform: "mac-x64",
        role: "fast-request",
        candidates,
        probe: (item) => {
          visited.push(item.path);
          if (item.path.endsWith("broken.js")) throw new Error("parser exploded");
          return probe("irrelevant", []);
        },
      }),
    (error) => {
      return assertDiagnostic(error, {
        platform: "mac-x64",
        role: "fast-request",
        path: "assets/broken.js",
        mismatch: /parser exploded/,
      });
    },
  );
  assert.deepEqual(visited, candidates.map((item) => item.path));
});

test("candidate validation failures use the complete diagnostic contract", () => {
  assert.throws(
    () =>
      probeCandidates({
        platform: "mac-arm64",
        role: "archive-route",
        candidates: [{ fileName: "broken.js", source: "source" }],
        probe: () => probe("irrelevant", []),
      }),
    (error) =>
      assertDiagnostic(error, {
        platform: "mac-arm64",
        role: "archive-route",
        path: "<candidate 0>",
        mismatch: /path must be a non-empty string/,
      }),
  );
});

test("probe output validation failures use the complete diagnostic contract", () => {
  assert.throws(
    () =>
      probeCandidates({
        platform: "mac-x64",
        role: "plugin-main",
        candidates: [candidate("assets/main.js")],
        probe: () => ({ state: "exact", evidence: "not-an-array" }),
      }),
    (error) =>
      assertDiagnostic(error, {
        platform: "mac-x64",
        role: "plugin-main",
        path: "assets/main.js",
        mismatch: /evidence must be an array/,
      }),
  );
});

test("reducer rejects malformed and cross-context probe records", async (t) => {
  const base = {
    platform: "mac-arm64",
    role: "sidebar-ui",
    candidate: candidate("assets/sidebar.js"),
    state: "exact",
    evidence: ["row ownership"],
    result: { count: 1 },
  };
  const cases = [
    ["non-object probe", null, /probe 0 must be an object/],
    ["missing platform", { ...base, platform: undefined }, /platform must be a non-empty string/],
    ["missing role", { ...base, role: undefined }, /role must be a non-empty string/],
    ["unsupported state", { ...base, state: "complete" }, /unsupported state/],
    ["invalid evidence", { ...base, evidence: "row ownership" }, /evidence must be an array/],
    ["invalid candidate", { ...base, candidate: { path: "assets/sidebar.js" } }, /fileName/],
    ["invalid result", { ...base, result: "not-an-object" }, /result must be an object/],
    ["invalid error", { ...base, error: "not-an-error" }, /error must be an Error/],
    ["cross-platform", { ...base, platform: "mac-x64" }, /probe platform.*mac-x64/],
    ["cross-role", { ...base, role: "sidebar-thread-actions" }, /probe role.*sidebar-thread-actions/],
  ];

  for (const [name, record, mismatch] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => reduceRequiredRole({ platform: "mac-arm64", role: "sidebar-ui", probes: [record] }),
        (error) =>
          assertDiagnostic(error, {
            platform: "mac-arm64",
            role: "sidebar-ui",
            path: record?.candidate?.path || "<probe 0>",
            mismatch,
          }),
      );
    });
  }
});

function role(roleName, paths, classify) {
  return {
    role: roleName,
    candidates: paths.map((item) => candidate(item)),
    probe: classify,
  };
}

test("plans every required role before the validated commit calls writers", () => {
  const visited = [];
  const roles = [
    role("fast-settings", ["assets/settings.js", "assets/settings-decoy.js"], (item) => {
      visited.push(`fast-settings:${item.path}`);
      return item.path.endsWith("settings.js")
        ? probe("exact", ["settings marker"], { result: { code: "settings" } })
        : probe("irrelevant", []);
    }),
    role("fast-request", ["assets/request.js", "assets/request-decoy.js"], (item) => {
      visited.push(`fast-request:${item.path}`);
      return item.path.endsWith("request.js")
        ? probe("exact", ["request marker"], { result: { code: "request" } })
        : probe("irrelevant", []);
    }),
  ];

  const plan = planRequiredRoles({ platform: "mac-arm64", roles });
  const writes = [];
  commitValidatedPlan({
    plan,
    writer: (reduced) => {
      assert.equal(visited.length, 4, "all probes must finish before the first write");
      writes.push(`${reduced.role}:${reduced.result.code}`);
    },
  });

  assert.deepEqual(writes, ["fast-settings:settings", "fast-request:request"]);
});

test("validated plans retain an immutable candidate snapshot until commit", () => {
  const inputCandidate = candidate("assets/settings.js");
  const plan = planRequiredRoles({
    platform: "mac-arm64",
    roles: [
      {
        role: "fast-settings",
        candidates: [inputCandidate],
        probe: () => probe("exact", ["settings marker"], { result: { code: "settings" } }),
      },
    ],
  });

  inputCandidate.path = "assets/retargeted.js";
  plan.roles[0].role = "retargeted-role";
  plan.roles[0].candidate.path = "assets/also-retargeted.js";

  const writes = commitValidatedPlan({
    plan,
    writer: ({ role: roleName, candidate: selected }) => `${roleName}:${selected.path}`,
  });
  assert.deepEqual(writes, ["fast-settings:assets/settings.js"]);
});

test("validated plans isolate nested results from external mutation", () => {
  const originalResult = {
    patch: { source: "original", counts: [1, 2] },
  };
  const plan = planRequiredRoles({
    platform: "mac-arm64",
    roles: [
      role("fast-settings", ["assets/settings.js"], () =>
        probe("exact", ["settings marker"], { result: originalResult }),
      ),
    ],
  });

  originalResult.patch.source = "externally-retargeted";
  originalResult.patch.counts.push(3);
  plan.roles[0].result.patch.source = "plan-retargeted";

  const writes = commitValidatedPlan({
    plan,
    writer: ({ result }) => ({ source: result.patch.source, counts: [...result.patch.counts] }),
  });
  assert.deepEqual(writes, [{ source: "original", counts: [1, 2] }]);
});

test("one writer cannot mutate a later role result", () => {
  const plan = planRequiredRoles({
    platform: "mac-x64",
    roles: [
      role("fast-settings", ["assets/settings.js"], () =>
        probe("exact", ["settings marker"], { result: { patch: { source: "settings" } } }),
      ),
      role("fast-request", ["assets/request.js"], () =>
        probe("exact", ["request marker"], { result: { patch: { source: "request" } } }),
      ),
    ],
  });

  let writerIndex = 0;
  const writes = commitValidatedPlan({
    plan,
    writer: (selected) => {
      if (writerIndex++ === 0) plan.roles[1].result.patch.source = "writer-retargeted";
      return selected.result.patch.source;
    },
  });
  assert.deepEqual(writes, ["settings", "request"]);
});

test("malformed ambiguous and throwing role plans call no writer", async (t) => {
  const invalidRoles = [
    [
      "owned malformed",
      role("fast-settings", ["assets/malformed.js"], () =>
        probe("owned-malformed", ["settings marker"], {
          error: new Error("strict mismatch: gate count 0"),
        }),
      ),
    ],
    [
      "ambiguous",
      role("fast-settings", ["assets/one.js", "assets/two.js"], () =>
        probe("exact", ["settings marker"], { result: {} }),
      ),
    ],
    [
      "probe exception",
      role("fast-settings", ["assets/explodes.js"], () => {
        throw new Error("parser exploded");
      }),
    ],
  ];

  for (const [name, invalidRole] of invalidRoles) {
    await t.test(name, () => {
      let writerCalls = 0;
      assert.throws(() => {
        const plan = planRequiredRoles({
          platform: "mac-x64",
          roles: [
            invalidRole,
            role("fast-request", ["assets/request.js"], () =>
              probe("exact", ["request marker"], { result: {} }),
            ),
          ],
        });
        commitValidatedPlan({ plan, writer: () => writerCalls++ });
      }, /mac-x64|validated plan/);
      assert.equal(writerCalls, 0);
    });
  }
});

test("commit boundary rejects a forged plan without calling the writer", () => {
  let writerCalls = 0;
  assert.throws(
    () =>
      commitValidatedPlan({
        plan: {
          platform: "mac-arm64",
          roles: [{ role: "fast-settings", result: { code: "forged" } }],
        },
        writer: () => writerCalls++,
      }),
    /validated plan/i,
  );
  assert.equal(writerCalls, 0);
});

test("commit boundary rejects a forged plan carrying symbols copied from a valid plan", () => {
  const validPlan = planRequiredRoles({
    platform: "mac-arm64",
    roles: [
      role("fast-settings", ["assets/settings.js"], () =>
        probe("exact", ["settings marker"], { result: { code: "settings" } }),
      ),
    ],
  });
  const forgedPlan = {
    platform: validPlan.platform,
    roles: validPlan.roles,
  };
  for (const symbol of Object.getOwnPropertySymbols(validPlan)) {
    forgedPlan[symbol] = validPlan[symbol];
  }

  let writerCalls = 0;
  assert.throws(
    () => commitValidatedPlan({ plan: forgedPlan, writer: () => writerCalls++ }),
    /validated plan/i,
  );
  assert.equal(writerCalls, 0);
});

test("planning rejects result values that cannot be safely snapshotted", () => {
  assert.throws(
    () =>
      planRequiredRoles({
        platform: "mac-arm64",
        roles: [
          role("fast-settings", ["assets/settings.js"], () =>
            probe("exact", ["settings marker"], { result: { unsafe: new Map() } }),
          ),
        ],
      }),
    (error) =>
      assertDiagnostic(error, {
        platform: "mac-arm64",
        role: "fast-settings",
        path: "assets/settings.js",
        mismatch: /cannot safely snapshot/i,
      }),
  );
});

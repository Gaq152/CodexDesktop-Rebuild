#!/usr/bin/env node
/**
 * Post-build patch: Remove plugin auth gate + force browser-use available
 *
 * Rule 1 — Plugin auth gate (gradient-*.js or similar):
 *   AST match: function(X) { return X !== `chatgpt` }
 *   Replace expression with !1 (always allow non-chatgpt auth)
 *
 * Rule 2 — Browser-use availability (use-in-app-browser-use-availability-*.js):
 *   AST match: function containing featureName:`browser_use` that returns
 *   {allowed:X, available:Y, isLoading:Z}
 *   Replace allowed/available values with !0
 *
 * Rule 3 — Statsig gate bypass (any chunk):
 *   AST match: CallExpression `identifier(numericStringLiteral)` where the call
 *   appears inside a function that also references featureName strings like
 *   `browser_use`, `computer_use`, `browser_use_external`
 *   Replace the call with !0
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child)
        if (item && typeof item === "object" && item.type) walk(item, visitor);
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

function walkWithParent(node, visitor, parent = null) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) {
          walkWithParent(item, visitor, node);
        }
      }
    } else if (child && typeof child === "object" && child.type) {
      walkWithParent(child, visitor, node);
    }
  }
}

function getLiteralValue(node) {
  if (!node) return null;
  if (node.type === "Literal") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  )
    return node.quasis[0].value.cooked;
  return null;
}

function nodeContainsString(node, source, str) {
  return source.slice(node.start, node.end).includes(str);
}

// ── Rule 1: Plugin auth — function(e){return e!==`chatgpt`} → !1 ──

function findPluginAuthPatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression")
      return;
    const body = node.body;
    if (!body || body.type !== "BlockStatement" || body.body.length !== 1) return;
    const ret = body.body[0];
    if (ret.type !== "ReturnStatement" || !ret.argument) return;
    const arg = ret.argument;
    if (arg.type !== "BinaryExpression" || arg.operator !== "!==") return;
    if (
      getLiteralValue(arg.left) !== "chatgpt" &&
      getLiteralValue(arg.right) !== "chatgpt"
    )
      return;
    const expr = source.slice(arg.start, arg.end);
    if (expr === "!1") return;
    patches.push({
      id: "plugin_auth_gate",
      start: arg.start,
      end: arg.end,
      replacement: "!1",
      original: expr,
    });
  });
  return patches;
}

// ── Rule 6: Force /goal slash command available ──
// The goal feature is gated by: gate(ID) && config.goals === true && mode !== 'cloud'
// AST match: LogicalExpression chain containing `goals` string AND a gate call,
// replace with just the mode check (X !== `cloud`).

function findGoalGatePatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "LogicalExpression" || node.operator !== "&&") return;
    const slice = source.slice(node.start, node.end);
    // Must contain `goals` config check and `cloud` mode check
    if (!slice.includes("`goals`") && !slice.includes('"goals"')) return;
    if (!slice.includes("`cloud`") && !slice.includes('"cloud"')) return;
    // Must contain a gate call (identifier with numeric string arg)
    let hasGateCall = false;
    walk(node, (inner) => {
      if (inner.type !== "CallExpression") return;
      if (inner.callee?.type !== "Identifier") return;
      if (inner.arguments?.length !== 1) return;
      const val = getLiteralValue(inner.arguments[0]);
      if (val && /^\d{6,}$/.test(val)) hasGateCall = true;
    });
    if (!hasGateCall) return;
    // The rightmost operand is the mode check (X !== `cloud`).
    // In A && B && C, node.right is C.
    const right = node.right;
    const rightSrc = source.slice(right.start, right.end);
    if (!rightSrc.includes("cloud")) return;
    const fullSrc = source.slice(node.start, node.end);
    if (fullSrc === rightSrc) return;
    patches.push({
      id: "goal_gate_bypass",
      start: node.start,
      end: node.end,
      replacement: rightSrc,
      original: fullSrc.slice(0, 50) + "...",
    });
  });
  return patches;
}

// ── Rule 2: Force browser-use availability ──
// Find functions that return {allowed:X, available:Y, isLoading:Z}
// and contain featureName:`browser_use` (not browser_use_external).

function findBrowserAvailPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression")
      return;
    const slice = source.slice(node.start, node.end);
    // Must contain a use-availability featureName
    if (
      !slice.includes("`browser_use`") &&
      !slice.includes("`browser_use_external`") &&
      !slice.includes("`computer_use`")
    ) return;

    // Find return objects containing {available:X, ...} with isLoading
    // Matches both {allowed,available,isLoading} and {available,isFetching,isLoading}
    walk(node, (inner) => {
      if (inner.type !== "ObjectExpression") return;
      const props = inner.properties;
      if (!props || props.length < 3) return;
      const keys = props.map((p) => p.key?.name || p.key?.value);
      if (!keys.includes("available") || !keys.includes("isLoading")) return;

      for (const prop of props) {
        const name = prop.key?.name || prop.key?.value;
        if (name === "allowed" || name === "available") {
          const val = source.slice(prop.value.start, prop.value.end);
          if (val === "!0") continue;
          patches.push({
            id: `browser_use_${name}`,
            start: prop.value.start,
            end: prop.value.end,
            replacement: "!0",
            original: val,
          });
        }
      }
    });
  });

  return patches;
}

// ── Rule 3: Statsig gate bypass ──
// Match: identifier(`numericString`) inside a function that also contains
// a known feature name like browser_use, computer_use, etc.
// This catches gate calls regardless of their numeric ID.

const FEATURE_CONTEXTS = new Set([
  "browser_use",
  "computer_use",
  "browser_use_external",
]);

function findStatsigGatePatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression")
      return;
    const slice = source.slice(node.start, node.end);
    // Must contain a known feature context
    let hasFeatureContext = false;
    for (const feat of FEATURE_CONTEXTS) {
      if (slice.includes(`\`${feat}\``) || slice.includes(`"${feat}"`)) {
        hasFeatureContext = true;
        break;
      }
    }
    if (!hasFeatureContext) return;

    // Find CallExpression: identifier(`numericString`)
    walk(node, (inner) => {
      if (inner.type !== "CallExpression") return;
      if (inner.callee?.type !== "Identifier") return;
      if (inner.arguments?.length !== 1) return;
      const argVal = getLiteralValue(inner.arguments[0]);
      if (!argVal || !/^\d{6,}$/.test(argVal)) return;

      const expr = source.slice(inner.start, inner.end);
      if (expr === "!0") return;

      patches.push({
        id: `statsig_gate_${argVal}`,
        start: inner.start,
        end: inner.end,
        replacement: "!0",
        original: expr,
      });
    });
  });

  return patches;
}

// ── Rule 4: Force default desktop feature availability to true ──
// The main process has a default features object with all values false.
// This prevents bundled plugins from being installed during early startup.
// AST match: ObjectExpression with properties like inAppBrowserUse:!1, externalBrowserUseAllowed:!1, etc.

const FEATURE_KEYS = [
  "browserPane", "inAppBrowserUse", "inAppBrowserUseAllowed",
  "externalBrowserUse", "externalBrowserUseAllowed",
  "computerUse", "computerUseNodeRepl", "control", "multiWindow",
];

function findFeatureDefaultPatches(ast, source) {
  const patches = [];

  // Part A: Force default feature values from !1 to !0
  walk(ast, (node) => {
    if (node.type !== "ObjectExpression") return;
    const props = node.properties;
    if (!props || props.length < 5) return;
    const keys = props.map((p) => p.key?.name || p.key?.value);
    let matchCount = 0;
    for (const k of FEATURE_KEYS) if (keys.includes(k)) matchCount++;
    if (matchCount < 3) return;

    for (const prop of props) {
      const name = prop.key?.name || prop.key?.value;
      if (!FEATURE_KEYS.includes(name)) continue;
      const val = source.slice(prop.value.start, prop.value.end);
      if (val !== "!1") continue;
      patches.push({
        id: `feature_default_${name}`,
        start: prop.value.start,
        end: prop.value.end,
        replacement: "!0",
        original: val,
      });
    }
  });

  // Part A2: Force features.js_repl to true.
  // This is a separate object {"features.js_repl":!1} that controls whether
  // the Node.js REPL (Chrome browser control) is exposed to the model.
  walk(ast, (node) => {
    if (node.type !== "ObjectExpression") return;
    const props = node.properties;
    if (!props || props.length !== 1) return;
    const prop = props[0];
    const key = prop.key?.value;
    if (key !== "features.js_repl") return;
    const val = source.slice(prop.value.start, prop.value.end);
    if (val !== "!1") return;
    patches.push({
      id: "feature_js_repl",
      start: prop.value.start,
      end: prop.value.end,
      replacement: "!0",
      original: val,
    });
  });

  // Part B: Bypass the isAvailable filter in bundled plugins descriptor.
  // Pattern: X.filter(Y => Y.isAvailable({buildFlavor:..., features:..., platform:...}))
  // The filter callback checks features like externalBrowserUseAllowed which may be
  // false at startup. Replace the callback with ()=>!0 so all plugins are included.
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee?.type !== "MemberExpression") return;
    if (node.callee.property?.name !== "filter") return;
    if (node.arguments?.length !== 1) return;
    const cb = node.arguments[0];
    if (cb.type !== "ArrowFunctionExpression") return;
    const cbSrc = source.slice(cb.start, cb.end);
    if (!cbSrc.includes("isAvailable")) return;
    if (!cbSrc.includes("features")) return;
    if (cbSrc === "()=>!0") return;
    patches.push({
      id: "bundled_plugins_filter_bypass",
      start: cb.start,
      end: cb.end,
      replacement: "()=>!0",
      original: cbSrc.slice(0, 40) + "...",
    });
  });

  // Part C: Bypass browser-use native pipe peer authorization.
  // The BM() function checks code signing identity via a native module.
  // Ad-hoc signed builds fail because teamId !== "2DC432GLL2" (OpenAI).
  // AST match: function containing literal "browser-use-peer-authorization.node",
  // find the IfStatement whose consequent returns ()=>({authorized:!0}) —
  // that's the bypass path — force its condition to !0.
  walk(ast, (node) => {
    if (
      node.type !== "FunctionDeclaration" &&
      node.type !== "FunctionExpression"
    ) return;
    const slice = source.slice(node.start, node.end);
    if (!slice.includes("shouldIncludeBrowserUsePeerAuthorization")) return;

    // Find if(...) return ()=>({authorized:!0}) — the bypass return.
    // There are multiple returns; we want the one right before the native module load.
    // It's the IfStatement whose consequent returns an ArrowFunction with authorized:!0.
    walk(node, (inner) => {
      if (inner.type !== "IfStatement") return;
      const cons = inner.consequent;
      if (!cons) return;
      // consequent is ReturnStatement returning ArrowFunctionExpression
      const ret = cons.type === "ReturnStatement" ? cons : null;
      if (!ret || !ret.argument) return;
      if (ret.argument.type !== "ArrowFunctionExpression") return;
      // The arrow body must be an ObjectExpression with authorized:!0
      const body = ret.argument.body;
      if (!body || body.type !== "ObjectExpression") return;
      // Check for {authorized:!0} with no "reason" property
      const props = body.properties;
      const authProp = props?.find((p) => (p.key?.name || p.key?.value) === "authorized");
      const reasonProp = props?.find((p) => (p.key?.name || p.key?.value) === "reason");
      if (!authProp) return;
      const authVal = source.slice(authProp.value.start, authProp.value.end);
      if (authVal !== "!0") return;
      // Must NOT have a reason property (to distinguish from error returns)
      if (reasonProp) return;

      // Force the if-condition to !0 — but skip platform checks
      const test = inner.test;
      const testSrc = source.slice(test.start, test.end);
      if (testSrc === "!0") return;
      if (testSrc.includes("platform")) return;
      patches.push({
        id: "peer_auth_bypass",
        start: test.start,
        end: test.end,
        replacement: "!0",
        original: testSrc,
      });
    });
  });

  return patches;
}

const PLUGIN_FILTER_MARKER = "/* CodexRebuildPluginFilter */";
const PLUGIN_STATSIG_MARKER = "/* CodexRebuildPluginStatsig */";
const WEBVIEW_AVAILABILITY_TARGETS = 5;
const WEBVIEW_STATSIG_TARGETS = 3;

function parsePluginSource(source, label) {
  try {
    return parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    throw new Error(`${label} parse failed: ${error.message}`);
  }
}

function dedupePatches(patches) {
  const byRange = new Map();
  for (const patch of patches) byRange.set(`${patch.start}:${patch.end}`, patch);
  return [...byRange.values()];
}

function applyPatches(source, patches) {
  let code = source;
  for (const patch of [...patches].sort((left, right) => right.start - left.start)) {
    code = code.slice(0, patch.start) + patch.replacement + code.slice(patch.end);
  }
  return code;
}

function makeCount(patchable, already, expected, label) {
  const total = patchable + already;
  if (total !== expected) {
    throw new Error(`${label} expected exactly ${expected} target(s), found ${total}`);
  }
  return { patchable, already, total };
}

function expressionForChatGptSide(binary, source) {
  if (getLiteralValue(binary.right) === "chatgpt") return source.slice(binary.left.start, binary.left.end);
  if (getLiteralValue(binary.left) === "chatgpt") return source.slice(binary.right.start, binary.right.end);
  return null;
}

function logicalExpressionHasApiKey(node, source, operand) {
  let found = false;
  walk(node, (child) => {
    if (child.type !== "BinaryExpression" || child.operator !== "===") return;
    const left = source.slice(child.left.start, child.left.end);
    const right = source.slice(child.right.start, child.right.end);
    if (
      (left === operand && getLiteralValue(child.right) === "apikey") ||
      (right === operand && getLiteralValue(child.left) === "apikey")
    ) {
      found = true;
    }
  });
  return found;
}

function collectWebviewAuth(source, ast) {
  const patches = [];
  const already = [];
  walkWithParent(ast, (node, parent) => {
    if (node.type !== "BinaryExpression" || node.operator !== "===") return;
    const operand = expressionForChatGptSide(node, source);
    if (operand == null || !source.slice(node.start, node.end).includes("authMethod")) return;
    if (
      parent?.type === "LogicalExpression" &&
      parent.operator === "||" &&
      logicalExpressionHasApiKey(parent, source, operand)
    ) {
      already.push(node.start);
      return;
    }
    const original = source.slice(node.start, node.end);
    patches.push({
      id: "plugin_webview_auth",
      start: node.start,
      end: node.end,
      original,
      replacement: `(${original}||${operand}===\`apikey\`)`,
    });
  });
  return { patches: dedupePatches(patches), already: new Set(already).size };
}

function collectAvailability(source, ast) {
  const patches = [];
  const already = [];
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression") return;
    const functionSource = source.slice(node.start, node.end);
    if (![...FEATURE_CONTEXTS].some((feature) => functionSource.includes(feature))) return;
    walk(node, (inner) => {
      if (inner.type !== "ObjectExpression") return;
      const names = inner.properties.map((property) => property.key?.name ?? property.key?.value);
      if (!names.includes("available") || !names.includes("isLoading")) return;
      for (const property of inner.properties) {
        const name = property.key?.name ?? property.key?.value;
        if (name !== "allowed" && name !== "available") continue;
        const value = source.slice(property.value.start, property.value.end);
        if (value === "!0") already.push(property.value.start);
        else {
          patches.push({
            id: `plugin_webview_${name}`,
            start: property.value.start,
            end: property.value.end,
            original: value,
            replacement: "!0",
          });
        }
      }
    });
  });
  return { patches: dedupePatches(patches), already: new Set(already).size };
}

function collectStatsig(source, ast) {
  const raw = dedupePatches(findStatsigGatePatches(ast, source));
  const patches = raw.map((patch) => ({
    ...patch,
    replacement: `!0${PLUGIN_STATSIG_MARKER}`,
  }));
  const attached = new Set();
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression") {
      return;
    }
    const functionSource = source.slice(node.start, node.end);
    if (![...FEATURE_CONTEXTS].some((feature) => functionSource.includes(feature))) {
      return;
    }
    walk(node, (inner) => {
      if (
        source.slice(inner.start, inner.end) === "!0" &&
        source.slice(inner.end, inner.end + PLUGIN_STATSIG_MARKER.length) ===
          PLUGIN_STATSIG_MARKER
      ) {
        attached.add(inner.start);
      }
    });
  });
  const already = attached.size;
  return { patches, already };
}

function patchPluginWebviewSource(source) {
  const ast = parsePluginSource(source, "plugin webview");
  const auth = collectWebviewAuth(source, ast);
  const availability = collectAvailability(source, ast);
  const statsig = collectStatsig(source, ast);
  const counts = {
    auth: makeCount(auth.patches.length, auth.already, 1, "plugin webview auth"),
    availability: makeCount(
      availability.patches.length,
      availability.already,
      WEBVIEW_AVAILABILITY_TARGETS,
      "plugin webview availability",
    ),
    statsig: makeCount(
      statsig.patches.length,
      statsig.already,
      WEBVIEW_STATSIG_TARGETS,
      "plugin webview statsig",
    ),
  };
  const patches = [...auth.patches, ...availability.patches, ...statsig.patches];
  return {
    code: applyPatches(source, patches),
    status: patches.length > 0 ? "patched" : "already",
    counts,
    patches,
  };
}

function collectMainDefaults(source, ast) {
  const patches = [];
  const already = [];
  const targets = [];
  walk(ast, (node) => {
    if (node.type !== "ObjectExpression") return;
    const keys = node.properties.map((property) => property.key?.name ?? property.key?.value);
    const featureMatches = FEATURE_KEYS.filter((key) => keys.includes(key));
    if (featureMatches.length >= 3) {
      for (const property of node.properties) {
        const name = property.key?.name ?? property.key?.value;
        if (!FEATURE_KEYS.includes(name)) continue;
        targets.push(property.value.start);
        const value = source.slice(property.value.start, property.value.end);
        if (value === "!1") {
          patches.push({
            id: `feature_default_${name}`,
            start: property.value.start,
            end: property.value.end,
            original: value,
            replacement: "!0",
          });
        } else if (value === "!0") already.push(property.value.start);
      }
    }
    if (node.properties.length === 1) {
      const property = node.properties[0];
      const name = property.key?.name ?? property.key?.value;
      if (name !== "features.js_repl") return;
      targets.push(property.value.start);
      const value = source.slice(property.value.start, property.value.end);
      if (value === "!1") {
        patches.push({
          id: "feature_js_repl",
          start: property.value.start,
          end: property.value.end,
          original: value,
          replacement: "!0",
        });
      } else if (value === "!0") already.push(property.value.start);
    }
  });
  return {
    patches: dedupePatches(patches),
    already: new Set(already).size,
    targets: new Set(targets).size,
  };
}

function collectMainFilter(source, ast) {
  const patches = [];
  walk(ast, (node) => {
    if (
      node.type !== "CallExpression" ||
      node.callee?.type !== "MemberExpression" ||
      node.callee.property?.name !== "filter" ||
      node.arguments.length !== 1 ||
      node.arguments[0].type !== "ArrowFunctionExpression"
    ) return;
    const callback = node.arguments[0];
    const callbackSource = source.slice(callback.start, callback.end);
    if (!callbackSource.includes("isAvailable") || !callbackSource.includes("features")) return;
    patches.push({
      id: "bundled_plugins_filter_bypass",
      start: node.start,
      end: node.end,
      original: source.slice(node.start, node.end),
      replacement: `${source.slice(node.start, callback.start)}()=>!0)${PLUGIN_FILTER_MARKER}`,
    });
  });
  return {
    patches: dedupePatches(patches),
    already: (source.match(/\/\* CodexRebuildPluginFilter \*\//g) ?? []).length,
  };
}

function collectMainPeer(source, ast) {
  const patches = [];
  const already = [];
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression") return;
    if (!source.slice(node.start, node.end).includes("shouldIncludeBrowserUsePeerAuthorization")) return;
    walk(node, (inner) => {
      if (inner.type !== "IfStatement" || inner.consequent?.type !== "ReturnStatement") return;
      const returned = inner.consequent.argument;
      if (returned?.type !== "ArrowFunctionExpression" || returned.body?.type !== "ObjectExpression") return;
      const authorized = returned.body.properties.find(
        (property) => (property.key?.name ?? property.key?.value) === "authorized",
      );
      if (!authorized || source.slice(authorized.value.start, authorized.value.end) !== "!0") return;
      const testSource = source.slice(inner.test.start, inner.test.end);
      if (testSource === "!0") already.push(inner.test.start);
      else if (!testSource.includes("platform")) {
        patches.push({
          id: "peer_auth_bypass",
          start: inner.test.start,
          end: inner.test.end,
          original: testSource,
          replacement: "!0",
        });
      }
    });
  });
  return { patches: dedupePatches(patches), already: new Set(already).size };
}

function patchPluginMainSource(source) {
  const ast = parsePluginSource(source, "plugin main");
  const defaults = collectMainDefaults(source, ast);
  const filter = collectMainFilter(source, ast);
  const peer = collectMainPeer(source, ast);
  const counts = {
    defaults: makeCount(defaults.patches.length, defaults.already, FEATURE_KEYS.length + 1, "plugin defaults"),
    filter: makeCount(filter.patches.length, filter.already, 1, "plugin bundled filter"),
    peer: makeCount(peer.patches.length, peer.already, 1, "plugin peer auth"),
  };
  const patches = [...defaults.patches, ...filter.patches, ...peer.patches];
  return {
    code: applyPatches(source, patches),
    status: patches.length > 0 ? "patched" : "already",
    counts,
    patches,
  };
}

function patchPluginContracts({ mainSource, webviewSource }) {
  if (typeof mainSource !== "string") throw new Error("plugin main source is required");
  if (typeof webviewSource !== "string") throw new Error("plugin webview source is required");
  const main = patchPluginMainSource(mainSource);
  const webview = patchPluginWebviewSource(webviewSource);
  return {
    status: main.status === "already" && webview.status === "already" ? "already" : "patched",
    main,
    webview,
  };
}

function classifyPluginTarget(fileName, source) {
  if (
    /^main-.*\.js$/.test(fileName) &&
    source.includes("externalBrowserUseAllowed") &&
    source.includes("computerUse")
  ) {
    return "main";
  }
  if (
    /^use-is-plugins-enabled-.*\.js$/.test(fileName) &&
    source.includes("authMethod") &&
    source.includes("browser_use_external")
  ) {
    return "webview";
  }
  return null;
}

// ── Target location ──

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );

  const targets = [];

  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;

    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");

      let dominated = false;

      // Rule 1: plugin auth — small file with chatgpt + !==
      if (src.includes("chatgpt") && src.includes("!==") && src.length < 5000) {
        targets.push({ platform: plat, path: fp, rules: ["auth"] });
        dominated = true;
      }

      // Rule 2+3: browser/computer use availability
      if (
        f.startsWith("use-in-app-browser-use-availability-") ||
        f.startsWith("use-browser-agent-availability-")
      ) {
        targets.push({ platform: plat, path: fp, rules: ["avail", "gate"] });
        dominated = true;
      }

      // Rule 6: composer — goal gate bypass
      if (f.startsWith("composer-") && src.includes("goalSlashCommand")) {
        targets.push({ platform: plat, path: fp, rules: ["goal"] });
      }

      // Rule 1 fallback: other files with authMethod chatgpt patterns
      if (
        !dominated &&
        src.length < 10000 &&
        src.includes("chatgpt") &&
        (src.includes("authMethod") || src.includes("!=="))
      ) {
        targets.push({ platform: plat, path: fp, rules: ["auth"] });
      }
    }

    // Rule 4: main process — force default features
    const buildDir = path.join(SRC_DIR, plat, "_asar", ".vite", "build");
    if (fs.existsSync(buildDir)) {
      for (const f of fs.readdirSync(buildDir)) {
        if (!f.startsWith("main-") || !f.endsWith(".js")) continue;
        const fp = path.join(buildDir, f);
        const src = fs.readFileSync(fp, "utf-8");
        if (src.includes("externalBrowserUseAllowed") && src.includes("computerUse")) {
          targets.push({ platform: plat, path: fp, rules: ["features"] });
        }
      }
    }
  }

  return targets;
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((name) =>
        fs.existsSync(path.join(SRC_DIR, name, "_asar")),
      );
  if (platforms.length === 0) throw new Error("plugin patch expected at least one platform");

  const plans = [];
  for (const platformName of platforms) {
    const roots = [
      path.join(SRC_DIR, platformName, "_asar", ".vite", "build"),
      path.join(SRC_DIR, platformName, "_asar", "webview", "assets"),
    ];
    const matches = { main: [], webview: [] };
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const fileName of fs.readdirSync(root)) {
        if (!fileName.endsWith(".js")) continue;
        const filePath = path.join(root, fileName);
        const source = fs.readFileSync(filePath, "utf-8");
        const kind = classifyPluginTarget(fileName, source);
        if (kind) matches[kind].push({ filePath, source });
      }
    }
    for (const kind of ["main", "webview"]) {
      if (matches[kind].length !== 1) {
        throw new Error(
          `plugin ${kind} expected exactly 1 target for ${platformName}, found ${matches[kind].length}`,
        );
      }
    }
    const result = patchPluginContracts({
      mainSource: matches.main[0].source,
      webviewSource: matches.webview[0].source,
    });
    plans.push({ platform: platformName, matches, result });
  }

  for (const plan of plans) {
    console.log(`\n-- [${plan.platform}] plugin main: ${relPath(plan.matches.main[0].filePath)}`);
    console.log(`   [${isCheck ? "check" : plan.result.main.status}] ${JSON.stringify(plan.result.main.counts)}`);
    console.log(`-- [${plan.platform}] plugin webview: ${relPath(plan.matches.webview[0].filePath)}`);
    console.log(`   [${isCheck ? "check" : plan.result.webview.status}] ${JSON.stringify(plan.result.webview.counts)}`);
  }
  if (!isCheck) {
    for (const plan of plans) {
      const mainTarget = plan.matches.main[0];
      const webviewTarget = plan.matches.webview[0];
      if (plan.result.main.code !== mainTarget.source) {
        fs.writeFileSync(mainTarget.filePath, plan.result.main.code, "utf-8");
      }
      if (plan.result.webview.code !== webviewTarget.source) {
        fs.writeFileSync(webviewTarget.filePath, plan.result.webview.code, "utf-8");
      }
    }
  }
  console.log(`  [ok] plugin contracts satisfied for ${plans.length} platform(s)`);
}

if (require.main === module) main();

module.exports = {
  patchPluginMainSource,
  patchPluginWebviewSource,
  patchPluginContracts,
  classifyPluginTarget,
};

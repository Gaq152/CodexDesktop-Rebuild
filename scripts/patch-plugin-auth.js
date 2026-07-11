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

function parsePluginDocument(source, label) {
  const comments = [];
  let ast;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      onComment: comments,
    });
  } catch (error) {
    throw new Error(`${label} parse failed: ${error.message}`);
  }
  return { ast, comments };
}

function walkOwnFunction(root, visitor) {
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node !== root && (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression")) return;
    if (node.type) visitor(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else {
        visit(child);
      }
    }
  }
  visit(root);
}

function isPluginFunctionNode(node) {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}

function pluginPropertyName(node) {
  const key = node?.type === "MemberExpression" ? node.property : node?.key;
  if (!key) return null;
  if (key.type === "Identifier" && !node.computed) return key.name;
  return getLiteralValue(key);
}

function bindingIdentifiers(pattern, identifiers = []) {
  if (!pattern) return identifiers;
  if (pattern.type === "Identifier") identifiers.push(pattern);
  else if (pattern.type === "AssignmentPattern") {
    bindingIdentifiers(pattern.left, identifiers);
  } else if (pattern.type === "RestElement") {
    bindingIdentifiers(pattern.argument, identifiers);
  } else if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements) bindingIdentifiers(element, identifiers);
  } else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) {
      bindingIdentifiers(
        property.type === "RestElement" ? property.argument : property.value,
        identifiers,
      );
    }
  }
  return identifiers;
}

// A deliberately small lexical model for the minified bundle contracts. It
// resolves block/function shadowing without attempting whole-program JS flow.
function buildPluginLexicalModel(ast) {
  const scopeByNode = new WeakMap();
  const bindingByDeclaration = new WeakMap();

  function makeScope(kind, node, parent) {
    return { kind, node, parent, bindings: new Map() };
  }

  const programScope = makeScope("program", ast, null);

  function declarePattern(pattern, scope) {
    for (const identifier of bindingIdentifiers(pattern)) {
      let binding = scope.bindings.get(identifier.name);
      if (!binding) {
        binding = { name: identifier.name, scope };
        scope.bindings.set(identifier.name, binding);
      }
      bindingByDeclaration.set(identifier, binding);
      scopeByNode.set(identifier, scope);
    }
  }

  function nearestVarScope(scope) {
    let current = scope;
    while (current.kind === "block") current = current.parent;
    return current;
  }

  function visitChildren(node, scope) {
    for (const [key, child] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item, scope);
      } else {
        visit(child, scope);
      }
    }
  }

  function visitFunction(node, parentScope) {
    if (node.type === "FunctionDeclaration" && node.id) {
      declarePattern(node.id, parentScope);
    }
    const functionScope = makeScope("function", node, parentScope);
    scopeByNode.set(node, functionScope);
    if (node.type === "FunctionExpression" && node.id) {
      declarePattern(node.id, functionScope);
    }
    for (const parameter of node.params) declarePattern(parameter, functionScope);
    if (node.body?.type === "BlockStatement") {
      scopeByNode.set(node.body, functionScope);
      for (const statement of node.body.body) visit(statement, functionScope);
    } else {
      visit(node.body, functionScope);
    }
  }

  function visit(node, scope) {
    if (!node || typeof node !== "object") return;
    scopeByNode.set(node, scope);
    if (isPluginFunctionNode(node)) {
      visitFunction(node, scope);
      return;
    }
    if (node.type === "BlockStatement") {
      const blockScope = makeScope("block", node, scope);
      scopeByNode.set(node, blockScope);
      for (const statement of node.body) visit(statement, blockScope);
      return;
    }
    if (node.type === "VariableDeclaration") {
      const declarationScope = node.kind === "var" ? nearestVarScope(scope) : scope;
      for (const declaration of node.declarations) {
        scopeByNode.set(declaration, scope);
        declarePattern(declaration.id, declarationScope);
        visit(declaration.init, scope);
      }
      return;
    }
    visitChildren(node, scope);
  }

  scopeByNode.set(ast, programScope);
  for (const statement of ast.body) visit(statement, programScope);

  function resolve(identifier) {
    if (identifier?.type !== "Identifier") return null;
    let scope = scopeByNode.get(identifier);
    while (scope) {
      const binding = scope.bindings.get(identifier.name);
      if (binding) return binding;
      scope = scope.parent;
    }
    return null;
  }

  function nearestFunctionScope(node) {
    let scope = scopeByNode.get(node);
    while (scope?.kind === "block") scope = scope.parent;
    return scope ?? null;
  }

  return {
    bindingForDeclaration: (identifier) =>
      bindingByDeclaration.get(identifier) ?? null,
    nearestFunctionScope,
    resolve,
  };
}

function nodeContainsNode(container, target) {
  return (
    container != null &&
    target != null &&
    container.start <= target.start &&
    target.end <= container.end
  );
}

function functionReturnsNode(functionNode, target) {
  if (
    functionNode.type === "ArrowFunctionExpression" &&
    functionNode.body.type !== "BlockStatement"
  ) {
    return nodeContainsNode(functionNode.body, target);
  }
  let found = false;
  walkOwnFunction(functionNode, (node) => {
    if (
      node.type === "ReturnStatement" &&
      nodeContainsNode(node.argument, target)
    ) {
      found = true;
    }
  });
  return found;
}

function collectFunctionBindings(ast, model) {
  const bindingsByFunction = new Map();
  const functionsByBinding = new Map();
  walk(ast, (node) => {
    let functionNode = null;
    let binding = null;
    if (node.type === "FunctionDeclaration" && node.id) {
      functionNode = node;
      binding = model.bindingForDeclaration(node.id);
    } else if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      isPluginFunctionNode(node.init)
    ) {
      functionNode = node.init;
      binding = model.bindingForDeclaration(node.id);
    }
    if (!functionNode || !binding) return;
    bindingsByFunction.set(functionNode, binding);
    functionsByBinding.set(binding, functionNode);
  });
  return { bindingsByFunction, functionsByBinding };
}

function walkExpression(node, visitor, parent = null) {
  if (!node || typeof node !== "object") return;
  if (isPluginFunctionNode(node)) return;
  if (node.type) visitor(node, parent);
  for (const [key, child] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(child)) {
      for (const item of child) walkExpression(item, visitor, node);
    } else {
      walkExpression(child, visitor, node);
    }
  }
}

function isReferenceIdentifier(node, parent) {
  if (node?.type !== "Identifier") return false;
  if (!parent) return true;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) {
    return false;
  }
  if (
    (parent.type === "Property" || parent.type === "MethodDefinition") &&
    parent.key === node &&
    !parent.computed &&
    !(parent.type === "Property" && parent.shorthand && parent.value === node)
  ) {
    return false;
  }
  if (
    (parent.type === "VariableDeclarator" && parent.id === node) ||
    (isPluginFunctionNode(parent) &&
      (parent.id === node || parent.params.includes(node))) ||
    (parent.type === "LabeledStatement" && parent.label === node) ||
    ((parent.type === "BreakStatement" || parent.type === "ContinueStatement") &&
      parent.label === node)
  ) {
    return false;
  }
  return true;
}

function createFunctionReturnFlow(functionNode, model) {
  const definitions = new Map();
  const returnExpressions = [];

  function addDefinition(binding, expression) {
    if (!binding || !expression) return;
    const expressions = definitions.get(binding) ?? [];
    expressions.push(expression);
    definitions.set(binding, expressions);
  }

  walkOwnFunction(functionNode, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init
    ) {
      addDefinition(model.bindingForDeclaration(node.id), node.init);
    } else if (
      node.type === "AssignmentExpression" &&
      node.left.type === "Identifier"
    ) {
      addDefinition(model.resolve(node.left), node.right);
    } else if (node.type === "ReturnStatement" && node.argument) {
      returnExpressions.push(node.argument);
    }
  });
  if (
    functionNode.type === "ArrowFunctionExpression" &&
    functionNode.body.type !== "BlockStatement"
  ) {
    returnExpressions.push(functionNode.body);
  }

  const liveExpressions = new Set();
  const liveBindings = new Set();
  const pendingBindings = [];

  function addLiveExpression(expression) {
    if (!expression || liveExpressions.has(expression)) return;
    liveExpressions.add(expression);
    walkExpression(expression, (node, parent) => {
      if (!isReferenceIdentifier(node, parent)) return;
      const binding = model.resolve(node);
      if (!binding || liveBindings.has(binding)) return;
      liveBindings.add(binding);
      pendingBindings.push(binding);
    });
  }

  for (const expression of returnExpressions) addLiveExpression(expression);
  while (pendingBindings.length > 0) {
    const binding = pendingBindings.shift();
    for (const expression of definitions.get(binding) ?? []) {
      addLiveExpression(expression);
    }
  }

  return {
    feedsReturn: (target) =>
      [...liveExpressions].some((expression) => nodeContainsNode(expression, target)),
  };
}

function collectWebviewHookTopology(ast) {
  const model = buildPluginLexicalModel(ast);
  const { functionsByBinding } = collectFunctionBindings(ast, model);
  const exportedFunctions = new Set();

  walk(ast, (node) => {
    if (node.type !== "ExportNamedDeclaration" && node.type !== "ExportDefaultDeclaration") {
      return;
    }
    if (isPluginFunctionNode(node.declaration)) {
      exportedFunctions.add(node.declaration);
    }
    if (node.declaration?.type === "VariableDeclaration") {
      for (const declaration of node.declaration.declarations) {
        if (declaration.id.type !== "Identifier") continue;
        const functionNode = functionsByBinding.get(
          model.bindingForDeclaration(declaration.id),
        );
        if (functionNode) exportedFunctions.add(functionNode);
      }
    }
    for (const specifier of node.specifiers ?? []) {
      if (specifier.local?.type !== "Identifier") continue;
      const functionNode = functionsByBinding.get(model.resolve(specifier.local));
      if (functionNode) exportedFunctions.add(functionNode);
    }
  });

  const hooksByContext = new Map(
    [...FEATURE_CONTEXTS].map((context) => [context, []]),
  );
  walk(ast, (node) => {
    if (!isPluginFunctionNode(node)) return;
    const contexts = featureContextsInFunction(node);
    if (contexts.length === 0) return;
    if (contexts.length !== 1) {
      throw new Error("plugin webview hook has ambiguous feature context");
    }
    hooksByContext.get(contexts[0]).push(node);
  });

  const hooks = new Map();
  for (const context of FEATURE_CONTEXTS) {
    const candidates = hooksByContext.get(context);
    if (candidates.length !== 1) {
      throw new Error(
        `plugin webview hook ${context} expected exactly 1 function, found ${candidates.length}`,
      );
    }
    const hook = candidates[0];
    if (!exportedFunctions.has(hook)) {
      throw new Error(`plugin webview hook ${context} is not exported`);
    }
    hooks.set(context, hook);
  }

  const flows = new Map();
  function flowFor(functionNode) {
    let flow = flows.get(functionNode);
    if (!flow) {
      flow = createFunctionReturnFlow(functionNode, model);
      flows.set(functionNode, flow);
    }
    return flow;
  }

  const reachableFunctions = new Set(hooks.values());
  const pending = [...hooks.values()].map((functionNode) => ({ functionNode, depth: 0 }));
  // Current bundles call the auth helper directly from an exported hook. Two
  // direct identifier-call hops leave adaptation room while keeping analysis bounded.
  const MAX_HELPER_CALL_DEPTH = 2;
  while (pending.length > 0) {
    const { functionNode, depth } = pending.shift();
    if (depth >= MAX_HELPER_CALL_DEPTH) continue;
    walkOwnFunction(functionNode, (node) => {
      if (node.type !== "CallExpression" || node.callee?.type !== "Identifier") return;
      const called = functionsByBinding.get(model.resolve(node.callee));
      if (!called || reachableFunctions.has(called)) return;
      reachableFunctions.add(called);
      pending.push({ functionNode: called, depth: depth + 1 });
    });
  }

  return { hooks, model, reachableFunctions, flowFor };
}

function flattenLogical(node, operator, terms = []) {
  if (node?.type === "LogicalExpression" && node.operator === operator) {
    flattenLogical(node.left, operator, terms);
    flattenLogical(node.right, operator, terms);
  } else {
    terms.push(node);
  }
  return terms;
}

function exactMarkerComments(comments, markerText) {
  const markerBody = markerText.slice(2, -2).trim();
  return comments.filter(
    (comment) => comment.type === "Block" && comment.value.trim() === markerBody,
  );
}

function isAlwaysTrueExpression(node) {
  return (
    (node?.type === "Literal" && node.value === true) ||
    (node?.type === "UnaryExpression" &&
      node.operator === "!" &&
      node.argument?.type === "Literal" &&
      node.argument.value === 0)
  );
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

function collectWebviewAuth(source, ast, topology) {
  const patches = [];
  const already = [];
  const evidence = [];

  function evidenceFunction(node) {
    const functionNode = topology.model.nearestFunctionScope(node)?.node;
    if (!isPluginFunctionNode(functionNode)) return null;
    return functionNode;
  }

  function isHookReturnEvidence(node) {
    const functionNode = evidenceFunction(node);
    return (
      functionNode != null &&
      topology.reachableFunctions.has(functionNode) &&
      topology.flowFor(functionNode).feedsReturn(node)
    );
  }

  walkWithParent(ast, (node, parent) => {
    if (
      node.type === "LogicalExpression" &&
      node.operator === "||" &&
      !(parent?.type === "LogicalExpression" && parent.operator === "||")
    ) {
      const terms = flattenLogical(node, "||");
      const chatTerms = terms
        .map((term) => ({ term, operand: expressionForChatGptSide(term, source) }))
        .filter(({ operand }) => operand?.includes("authMethod"));
      const apiTerms = terms
        .map((term) => {
          if (term?.type !== "BinaryExpression" || term.operator !== "===") return null;
          if (getLiteralValue(term.right) === "apikey") return source.slice(term.left.start, term.left.end);
          if (getLiteralValue(term.left) === "apikey") return source.slice(term.right.start, term.right.end);
          return null;
        })
        .filter(Boolean);
      if (chatTerms.length === 0 || apiTerms.length === 0) return;
      const operand = chatTerms[0].operand;
      if (terms.length !== 2 || chatTerms.length !== 1 || apiTerms.length !== 1 || apiTerms[0] !== operand) {
        throw new Error("plugin webview auth postcondition has extra or mismatched alternatives");
      }
      const live = isHookReturnEvidence(node);
      evidence.push({ node, live });
      if (live) already.push(node.start);
      return;
    }
    if (node.type !== "BinaryExpression" || node.operator !== "===") return;
    const operand = expressionForChatGptSide(node, source);
    if (operand == null || !operand.includes("authMethod")) return;
    if (parent?.type === "LogicalExpression" && parent.operator === "||") return;
    const live = isHookReturnEvidence(node);
    evidence.push({ node, live });
    if (!live) return;
    const original = source.slice(node.start, node.end);
    patches.push({
      id: "plugin_webview_auth",
      start: node.start,
      end: node.end,
      original,
      replacement: `(${original}||${operand}===\`apikey\`)`,
    });
  });
  const detached = evidence.filter((candidate) => !candidate.live);
  if (detached.length > 0) {
    if (evidence.length !== 1) {
      throw new Error(
        `plugin webview auth expected exactly 1 hook return target, found ${evidence.length}`,
      );
    }
    throw new Error("plugin webview auth evidence is detached from an exported hook return path");
  }
  return { patches: dedupePatches(patches), already: new Set(already).size };
}

const AVAILABILITY_PROPERTIES_BY_CONTEXT = new Map([
  ["computer_use", ["available"]],
  ["browser_use_external", ["allowed", "available"]],
  ["browser_use", ["allowed", "available"]],
]);

function featureContextsInFunction(node) {
  const contexts = new Set();
  walkOwnFunction(node, (inner) => {
    const value = getLiteralValue(inner);
    if (FEATURE_CONTEXTS.has(value)) contexts.add(value);
  });
  return [...contexts];
}

function collectAvailability(source, ast, topology) {
  const patches = [];
  const already = [];
  for (const [context, expectedNames] of AVAILABILITY_PROPERTIES_BY_CONTEXT) {
    const hook = topology.hooks.get(context);
    const objects = [];
    walkOwnFunction(hook, (inner) => {
      if (inner.type !== "ObjectExpression") return;
      const names = inner.properties.map((property) => pluginPropertyName(property));
      if (names.includes("available") && names.includes("isLoading")) objects.push(inner);
    });
    if (objects.length !== 1) {
      throw new Error(
        `plugin webview availability ${context} expected exactly 1 object, found ${objects.length}`,
      );
    }
    const object = objects[0];
    if (!topology.flowFor(hook).feedsReturn(object)) {
      throw new Error(
        `plugin webview availability ${context} is detached from the exported hook return path`,
      );
    }
    const properties = object.properties.filter((property) => property.type === "Property");
    const availabilityProperties = properties.filter((property) =>
      ["allowed", "available"].includes(pluginPropertyName(property)),
    );
    const names = availabilityProperties.map(
      (property) => pluginPropertyName(property),
    );
    if (
      names.length !== expectedNames.length ||
      expectedNames.some((name) => names.filter((candidate) => candidate === name).length !== 1)
    ) {
      throw new Error(
        `plugin webview availability ${context} expected exact properties ${expectedNames.join(",")}`,
      );
    }
    for (const property of availabilityProperties) {
      const name = pluginPropertyName(property);
      const value = source.slice(property.value.start, property.value.end);
      if (value === "!0") already.push(property.value.start);
      else {
        patches.push({
          id: `plugin_webview_${context}_${name}`,
          start: property.value.start,
          end: property.value.end,
          original: value,
          replacement: "!0",
        });
      }
    }
  }
  return { patches: dedupePatches(patches), already: new Set(already).size };
}

function collectStatsig(source, ast, comments, topology) {
  const markerComments = exactMarkerComments(comments, PLUGIN_STATSIG_MARKER);
  const markerBody = PLUGIN_STATSIG_MARKER.slice(2, -2).trim();
  if (
    comments.some(
      (comment) =>
        comment.value.includes("CodexRebuildPluginStatsig") &&
        (comment.type !== "Block" || comment.value.trim() !== markerBody),
    )
  ) {
    throw new Error("plugin webview statsig marker is malformed");
  }
  const patches = [];
  const attached = [];
  for (const context of FEATURE_CONTEXTS) {
    const hook = topology.hooks.get(context);
    const targets = [];
    const detached = [];
    walkOwnFunction(hook, (inner) => {
      let target = null;
      if (
        inner.type === "CallExpression" &&
        inner.callee?.type === "Identifier" &&
        inner.arguments?.length === 1 &&
        /^\d{6,}$/.test(String(getLiteralValue(inner.arguments[0]) ?? ""))
      ) {
        target = { kind: "patch", node: inner };
      }
      if (
        isAlwaysTrueExpression(inner) &&
        markerComments.some((comment) => comment.start === inner.end)
      ) {
        target = { kind: "already", node: inner };
      }
      if (!target) return;
      if (topology.flowFor(hook).feedsReturn(inner)) {
        targets.push(target);
      } else {
        detached.push(target);
      }
    });
    if (detached.length > 0) {
      throw new Error(
        `plugin webview statsig ${context} gate is detached from the exported hook return path`,
      );
    }
    if (targets.length !== 1) {
      throw new Error(
        `plugin webview statsig ${context} expected exactly 1 gate, found ${targets.length}`,
      );
    }
    const target = targets[0];
    if (target.kind === "already") attached.push(target.node.start);
    else {
      patches.push({
        id: `statsig_gate_${context}`,
        start: target.node.start,
        end: target.node.end,
        replacement: `!0${PLUGIN_STATSIG_MARKER}`,
        original: source.slice(target.node.start, target.node.end),
      });
    }
  }
  if (markerComments.length !== attached.length) {
    throw new Error(
      `plugin webview statsig attached markers expected ${attached.length}, found ${markerComments.length}`,
    );
  }
  return { patches: dedupePatches(patches), already: new Set(attached).size };
}

function patchPluginWebviewSource(source) {
  const { ast, comments } = parsePluginDocument(source, "plugin webview");
  const topology = collectWebviewHookTopology(ast);
  const auth = collectWebviewAuth(source, ast, topology);
  const availability = collectAvailability(source, ast, topology);
  const statsig = collectStatsig(source, ast, comments, topology);
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

function collectMainDefaults(source, ast, model) {
  const patches = [];
  const already = [];
  const featureObjects = [];
  const jsReplObjects = [];
  walk(ast, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "ObjectExpression"
    ) {
      const properties = node.init.properties.filter(
        (property) => property.type === "Property",
      );
      const featureProperties = properties.filter((property) =>
        FEATURE_KEYS.includes(property.key?.name ?? property.key?.value),
      );
      const booleanFeatureProperties = featureProperties.filter((property) =>
        ["!0", "!1"].includes(source.slice(property.value.start, property.value.end)),
      );
      if (
        new Set(
          featureProperties.map(
            (property) => property.key?.name ?? property.key?.value,
          ),
        ).size >= 3 &&
        booleanFeatureProperties.length === featureProperties.length
      ) {
        featureObjects.push({
          binding: model.bindingForDeclaration(node.id),
          node: node.init,
          properties: featureProperties,
        });
      }
    }
    if (node.type !== "ObjectExpression") return;
    const properties = node.properties.filter((property) => property.type === "Property");
    if (
      properties.some(
        (property) =>
          (property.key?.name ?? property.key?.value) === "features.js_repl",
      )
    ) {
      jsReplObjects.push({ node, properties });
    }
  });

  const objectKeysBindings = new Set();
  walk(ast, (node) => {
    if (
      node.type !== "CallExpression" ||
      node.callee?.type !== "MemberExpression" ||
      node.callee.object?.type !== "Identifier" ||
      node.callee.object.name !== "Object" ||
      pluginPropertyName(node.callee) !== "keys" ||
      node.arguments.length !== 1 ||
      node.arguments[0].type !== "Identifier"
    ) {
      return;
    }
    const binding = model.resolve(node.arguments[0]);
    if (binding) objectKeysBindings.add(binding);
  });

  if (featureObjects.length !== 1) {
    throw new Error(
      `plugin defaults expected exactly 1 desktop feature object, found ${featureObjects.length}`,
    );
  }
  const featureObject = featureObjects[0];
  if (!featureObject.binding || !objectKeysBindings.has(featureObject.binding)) {
    throw new Error(
      "plugin defaults desktop feature object binding must be live through Object.keys",
    );
  }
  for (const key of FEATURE_KEYS) {
    const matches = featureObject.properties.filter(
      (property) => (property.key?.name ?? property.key?.value) === key,
    );
    if (matches.length !== 1) {
      throw new Error(
        `plugin defaults expected ${key} exactly once, found ${matches.length}`,
      );
    }
    const property = matches[0];
    const value = source.slice(property.value.start, property.value.end);
    if (value === "!1") {
      patches.push({
        id: `feature_default_${key}`,
        start: property.value.start,
        end: property.value.end,
        original: value,
        replacement: "!0",
      });
    } else if (value === "!0") {
      already.push(property.value.start);
    }
  }

  if (jsReplObjects.length !== 1) {
    throw new Error(
      `plugin defaults features.js_repl expected exactly 1 object, found ${jsReplObjects.length}`,
    );
  }
  const jsReplObject = jsReplObjects[0];
  const jsReplProperties = jsReplObject.properties.filter(
    (property) =>
      (property.key?.name ?? property.key?.value) === "features.js_repl",
  );
  if (
    jsReplObject.node.properties.length !== 1 ||
    jsReplProperties.length !== 1
  ) {
    throw new Error("plugin defaults features.js_repl expected an exact singleton object");
  }
  const jsRepl = jsReplProperties[0];
  const jsReplValue = source.slice(jsRepl.value.start, jsRepl.value.end);
  if (jsReplValue === "!1") {
    patches.push({
      id: "feature_js_repl",
      start: jsRepl.value.start,
      end: jsRepl.value.end,
      original: jsReplValue,
      replacement: "!0",
    });
  } else if (jsReplValue === "!0") {
    already.push(jsRepl.value.start);
  } else {
    throw new Error("plugin defaults features.js_repl expected exactly !1 or !0");
  }

  return { patches: dedupePatches(patches), already: new Set(already).size };
}

function collectMainFilter(source, ast, comments, model) {
  const patches = [];
  const already = [];
  const { bindingsByFunction } = collectFunctionBindings(ast, model);
  const initializersByBinding = new Map();
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
      const binding = model.bindingForDeclaration(node.id);
      if (!binding) return;
      const initializers = initializersByBinding.get(binding) ?? [];
      initializers.push(node.init);
      initializersByBinding.set(binding, initializers);
    }
  });
  const markerComments = exactMarkerComments(comments, PLUGIN_FILTER_MARKER);
  const markerBody = PLUGIN_FILTER_MARKER.slice(2, -2).trim();
  if (
    comments.some(
      (comment) =>
        comment.value.includes("CodexRebuildPluginFilter") &&
        (comment.type !== "Block" || comment.value.trim() !== markerBody),
    )
  ) {
    throw new Error("plugin bundled filter marker is malformed");
  }

  const reconcileScopes = new Set();
  walk(ast, (node) => {
    if (
      node.type === "CallExpression" &&
      pluginPropertyName(node.callee) === "info" &&
      getLiteralValue(node.arguments[0]) === "bundled_plugins_reconcile_started"
    ) {
      reconcileScopes.add(model.nearestFunctionScope(node));
    }
  });

  function isDescriptorCollection(binding) {
    const initializers = initializersByBinding.get(binding) ?? [];
    return initializers.some(
      (initializer) =>
        initializer.type === "ArrayExpression" &&
        initializer.elements.some(
          (element) =>
            element?.type === "ObjectExpression" &&
            element.properties.some(
              (property) => pluginPropertyName(property) === "isAvailable",
            ),
        ),
    );
  }

  function reachesMarketplaceConsumer(filterCall) {
    const functionScope = model.nearestFunctionScope(filterCall);
    const selectorFunction = functionScope?.node;
    if (
      !isPluginFunctionNode(selectorFunction) ||
      !functionReturnsNode(selectorFunction, filterCall)
    ) {
      return false;
    }
    const selectorBinding = bindingsByFunction.get(selectorFunction);
    if (!selectorBinding) return false;

    const resultBindings = new Set();
    walk(ast, (node) => {
      if (
        node.type !== "VariableDeclarator" ||
        node.id.type !== "Identifier" ||
        node.init?.type !== "CallExpression" ||
        node.init.callee?.type !== "Identifier" ||
        model.resolve(node.init.callee) !== selectorBinding
      ) {
        return;
      }
      const binding = model.bindingForDeclaration(node.id);
      if (binding) resultBindings.add(binding);
    });

    let reachesConsumer = false;
    walk(ast, (node) => {
      if (
        node.type === "Property" &&
        pluginPropertyName(node) === "marketplacePluginDescriptors" &&
        node.value?.type === "Identifier" &&
        resultBindings.has(model.resolve(node.value)) &&
        reconcileScopes.has(model.nearestFunctionScope(node))
      ) {
        reachesConsumer = true;
      }
    });
    return reachesConsumer;
  }

  walk(ast, (node) => {
    if (
      node.type !== "CallExpression" ||
      node.callee?.type !== "MemberExpression" ||
      pluginPropertyName(node.callee) !== "filter" ||
      node.arguments.length !== 1 ||
      node.arguments[0].type !== "ArrowFunctionExpression"
    ) return;
    if (node.callee.object.type !== "Identifier") return;
    const collectionBinding = model.resolve(node.callee.object);
    if (!collectionBinding || !isDescriptorCollection(collectionBinding)) return;
    if (!reachesMarketplaceConsumer(node)) return;
    const callback = node.arguments[0];
    const callbackSource = source.slice(callback.start, callback.end);
    if (callbackSource.includes("isAvailable") && callbackSource.includes("features")) {
      patches.push({
        id: "bundled_plugins_filter_bypass",
        start: node.start,
        end: node.end,
        original: source.slice(node.start, node.end),
        replacement: `${source.slice(node.start, callback.start)}()=>!0)${PLUGIN_FILTER_MARKER}`,
      });
      return;
    }
    if (
      callback.params.length === 0 &&
      isAlwaysTrueExpression(callback.body) &&
      markerComments.some((comment) => comment.start === node.end)
    ) {
      already.push(node.start);
    }
  });
  if (markerComments.length !== already.length) {
    throw new Error(
      `plugin bundled filter attached markers expected ${already.length}, found ${markerComments.length}`,
    );
  }
  return {
    patches: dedupePatches(patches),
    already: new Set(already).size,
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
  const { ast, comments } = parsePluginDocument(source, "plugin main");
  const model = buildPluginLexicalModel(ast);
  const defaults = collectMainDefaults(source, ast, model);
  const filter = collectMainFilter(source, ast, comments, model);
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

function planPluginPlatform({ platform, candidates, warn = console.warn }) {
  const named = {
    main: candidates.filter((candidate) => /^main-.*\.js$/.test(candidate.fileName)),
    webview: candidates.filter((candidate) =>
      /^use-is-plugins-enabled-.*\.js$/.test(candidate.fileName),
    ),
  };
  if (named.main.length !== 1) {
    throw new Error(
      `plugin main expected exactly 1 target for ${platform}, found ${named.main.length}`,
    );
  }
  const main = patchPluginMainSource(named.main[0].source);
  if (platform.startsWith("mac-") && named.webview.length === 0) {
    warn(`[skip] plugin-auth: unsupported target layout on ${platform}`);
    return { status: "skipped", writes: [] };
  }
  if (named.webview.length !== 1) {
    throw new Error(
      `plugin webview expected exactly 1 target for ${platform}, found ${named.webview.length}`,
    );
  }
  const webview = patchPluginWebviewSource(named.webview[0].source);
  const matches = { main: named.main, webview: named.webview };
  const result = {
    status: main.status === "already" && webview.status === "already" ? "already" : "patched",
    main,
    webview,
  };
  return {
    status: "ready",
    writes: [{ matches, result }],
  };
}

function formatPluginSummary(outcomes) {
  const ready = outcomes.filter((outcome) => outcome.status === "ready").map((outcome) => outcome.platform);
  const skipped = outcomes.filter((outcome) => outcome.status === "skipped").map((outcome) => outcome.platform);
  return `[summary] plugin-auth: ready=[${ready.join(",")}] skipped=[${skipped.join(",")}]`;
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
  const outcomes = [];
  for (const platformName of platforms) {
    const roots = [
      path.join(SRC_DIR, platformName, "_asar", ".vite", "build"),
      path.join(SRC_DIR, platformName, "_asar", "webview", "assets"),
    ];
    const candidates = [];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const fileName of fs.readdirSync(root)) {
        if (!fileName.endsWith(".js")) continue;
        const filePath = path.join(root, fileName);
        const source = fs.readFileSync(filePath, "utf-8");
        candidates.push({ fileName, filePath, source });
      }
    }
    const platformPlan = planPluginPlatform({ platform: platformName, candidates });
    outcomes.push({ platform: platformName, status: platformPlan.status });
    for (const write of platformPlan.writes) {
      plans.push({ platform: platformName, ...write });
    }
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
  console.log(formatPluginSummary(outcomes));
}

if (require.main === module) main();

module.exports = {
  patchPluginMainSource,
  patchPluginWebviewSource,
  patchPluginContracts,
  classifyPluginTarget,
  planPluginPlatform,
  formatPluginSummary,
};

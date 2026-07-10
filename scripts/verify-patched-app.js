#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { planFastModeTargets } = require("./patch-fast-mode");
const {
  classifyPluginTarget,
  patchPluginContracts,
} = require("./patch-plugin-auth");
const { patchArchiveContracts } = require("./patch-archive-delete");
const { patchSidebarContracts } = require("./patch-sidebar-delete");
const { validateLocalUpdaterSources } = require("./patch-local-updater");

const PROJECT_ROOT = path.join(__dirname, "..");
const TEXT_BUNDLE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".htm",
  ".html",
  ".js",
  ".json",
  ".mjs",
]);
const FEATURE_DEFAULT_KEYS = new Set([
  "browserPane",
  "computerUse",
  "computerUseNodeRepl",
  "control",
  "externalBrowserUse",
  "externalBrowserUseAllowed",
  "inAppBrowserUse",
  "inAppBrowserUseAllowed",
  "multiWindow",
]);

function walk(node, visitor, rootFunction = null) {
  if (!node || typeof node !== "object") return;
  if (rootFunction && node !== rootFunction && isFunctionNode(node)) return;
  if (node.type) visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visitor, rootFunction);
    } else if (child && typeof child === "object") {
      walk(child, visitor, rootFunction);
    }
  }
}

function isFunctionNode(node) {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression"
  );
}

function stringValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function comparisonOperand(node, expectedValue, source, operator = "===") {
  if (node?.type !== "BinaryExpression" || node.operator !== operator) return null;
  if (stringValue(node.right) === expectedValue) {
    return source.slice(node.left.start, node.left.end);
  }
  if (stringValue(node.left) === expectedValue) {
    return source.slice(node.right.start, node.right.end);
  }
  return null;
}

function flattenLogicalOr(node, terms = []) {
  if (node?.type === "LogicalExpression" && node.operator === "||") {
    flattenLogicalOr(node.left, terms);
    flattenLogicalOr(node.right, terms);
  } else {
    terms.push(node);
  }
  return terms;
}

function flattenLogicalAnd(node, terms = []) {
  if (node?.type === "LogicalExpression" && node.operator === "&&") {
    flattenLogicalAnd(node.left, terms);
    flattenLogicalAnd(node.right, terms);
  } else {
    terms.push(node);
  }
  return terms;
}

function functionHasFastMode(functionNode) {
  let found = false;
  walk(
    functionNode,
    (node) => {
      if (
        (node.type === "Identifier" && node.name === "fast_mode") ||
        stringValue(node) === "fast_mode"
      ) {
        found = true;
      }
    },
    functionNode,
  );
  return found;
}

function functionHasPatchedFastAuth(functionNode, source) {
  let found = false;
  walk(
    functionNode,
    (node) => {
      if (found || node.type !== "LogicalExpression" || node.operator !== "||") {
        return;
      }
      const terms = flattenLogicalOr(node);
      const chatGptOperands = new Set(
        terms
          .map((term) => comparisonOperand(term, "chatgpt", source))
          .filter(Boolean),
      );
      const apiKeyOperands = terms
        .map((term) => comparisonOperand(term, "apikey", source))
        .filter(Boolean);
      found = apiKeyOperands.some((operand) => chatGptOperands.has(operand));
    },
    functionNode,
  );
  return found;
}

function hasPatchedFastModeAuthorization(source) {
  if (!source.includes("fast_mode") || !source.includes("apikey")) return false;

  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return false;
  }

  let found = false;
  walk(ast, (node) => {
    if (
      !found &&
      isFunctionNode(node) &&
      functionHasFastMode(node) &&
      functionHasPatchedFastAuth(node, source)
    ) {
      found = true;
    }
  });
  return found;
}

function functionHasPatchedFastRequestAuthorization(functionNode, source) {
  let found = false;
  walk(
    functionNode,
    (node) => {
      if (
        found ||
        node.type !== "IfStatement" ||
        node.test?.type !== "LogicalExpression" ||
        node.test.operator !== "&&" ||
        !source
          .slice(node.test.end, node.consequent.start)
          .includes("CodexRebuildFastModeRequestAuth")
      ) {
        return;
      }
      const terms = flattenLogicalAnd(node.test);
      const chatGptOperands = new Set(
        terms
          .map((term) => comparisonOperand(term, "chatgpt", source, "!=="))
          .filter(Boolean),
      );
      const apiKeyOperands = terms
        .map((term) => comparisonOperand(term, "apikey", source, "!=="))
        .filter(Boolean);
      found = apiKeyOperands.some((operand) => chatGptOperands.has(operand));
    },
    functionNode,
  );
  return found;
}

function hasPatchedFastModeRequestAuthorization(source) {
  if (
    !source.includes("fast_mode") ||
    !source.includes("CodexRebuildFastModeRequestAuth")
  ) {
    return false;
  }
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return false;
  }
  let found = false;
  walk(ast, (node) => {
    if (
      !found &&
      isFunctionNode(node) &&
      functionHasFastMode(node) &&
      functionHasPatchedFastRequestAuthorization(node, source)
    ) {
      found = true;
    }
  });
  return found;
}

function propertyName(property) {
  if (property?.type !== "Property") return null;
  if (!property.computed && property.key?.type === "Identifier") {
    return property.key.name;
  }
  return stringValue(property.key);
}

function isAlwaysTrue(node) {
  return (
    (node?.type === "Literal" && node.value === true) ||
    (node?.type === "UnaryExpression" &&
      node.operator === "!" &&
      node.argument?.type === "Literal" &&
      node.argument.value === 0)
  );
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

function buildLexicalModel(ast) {
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
    if (isFunctionNode(node)) {
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
      const declarationScope =
        node.kind === "var" ? nearestVarScope(scope) : scope;
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

function objectKeysArgument(node) {
  if (
    node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "Object" &&
    node.callee.property?.type === "Identifier" &&
    node.callee.property.name === "keys" &&
    node.arguments.length === 1 &&
    node.arguments[0]?.type === "Identifier"
  ) {
    return node.arguments[0];
  }
  return null;
}

function hasPatchedDesktopFeatureDefaults(source) {
  if (
    !source.includes("browserPane") ||
    !source.includes("computerUse") ||
    !source.includes("Object.keys")
  ) {
    return false;
  }

  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return false;
  }

  const model = buildLexicalModel(ast);
  const candidates = new Set();
  const keyUses = [];
  walk(ast, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      node.init?.type === "ObjectExpression"
    ) {
      const properties = new Map();
      for (const property of node.init.properties) {
        const name = propertyName(property);
        if (name) properties.set(name, property.value);
      }
      if (
        [...FEATURE_DEFAULT_KEYS].every((name) =>
          isAlwaysTrue(properties.get(name)),
        )
      ) {
        candidates.add(model.bindingForDeclaration(node.id));
      }
    }
    const argument = objectKeysArgument(node);
    if (argument) keyUses.push(argument);
  });
  candidates.delete(null);
  return keyUses.some((identifier) => candidates.has(model.resolve(identifier)));
}

function memberPropertyName(member) {
  if (member?.type !== "MemberExpression") return null;
  if (!member.computed && member.property?.type === "Identifier") {
    return member.property.name;
  }
  return stringValue(member.property);
}

function isAlwaysTrueFilterCall(node) {
  if (
    node?.type !== "CallExpression" ||
    memberPropertyName(node.callee) !== "filter" ||
    node.arguments.length !== 1
  ) {
    return false;
  }
  const callback = node.arguments[0];
  return (
    callback?.type === "ArrowFunctionExpression" &&
    callback.params.length === 0 &&
    isAlwaysTrue(callback.body)
  );
}

function isBundledReconcileStartCall(node) {
  return (
    node?.type === "CallExpression" &&
    memberPropertyName(node.callee) === "info" &&
    stringValue(node.arguments[0]) === "bundled_plugins_reconcile_started"
  );
}

function hasPatchedBundledPluginFilter(source) {
  if (
    !source.includes("bundled_plugins_reconcile_started") ||
    !source.includes("marketplacePluginDescriptors") ||
    !source.includes(".filter")
  ) {
    return false;
  }

  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return false;
  }

  const model = buildLexicalModel(ast);
  const selectorBindings = new Set();
  const resultBindings = new Set();
  const reconcileScopes = new Set();

  walk(ast, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      node.init?.type === "ArrowFunctionExpression" &&
      isAlwaysTrueFilterCall(node.init.body)
    ) {
      selectorBindings.add(model.bindingForDeclaration(node.id));
    }
    if (isBundledReconcileStartCall(node)) {
      reconcileScopes.add(model.nearestFunctionScope(node));
    }
  });
  selectorBindings.delete(null);

  walk(ast, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      node.init?.type === "CallExpression" &&
      node.init.callee?.type === "Identifier" &&
      selectorBindings.has(model.resolve(node.init.callee))
    ) {
      resultBindings.add(model.bindingForDeclaration(node.id));
    }
  });
  resultBindings.delete(null);

  let found = false;
  walk(ast, (node) => {
    if (
      node.type === "Property" &&
      propertyName(node) === "marketplacePluginDescriptors" &&
      node.value?.type === "Identifier" &&
      resultBindings.has(model.resolve(node.value)) &&
      reconcileScopes.has(model.nearestFunctionScope(node))
    ) {
      found = true;
    }
  });
  return found;
}

function isBuildFile(file, basename) {
  return file === `src/win/_asar/.vite/build/${basename}`;
}

function isWebviewAsset(file) {
  return file.startsWith("src/win/_asar/webview/assets/");
}

function isPluginWebviewAsset(file) {
  return /^src\/win\/_asar\/webview\/assets\/use-is-plugins-enabled-.*\.js$/.test(file);
}

function parseBundle(source) {
  try {
    return parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return null;
  }
}

function hasNativeArchiveRoute(source, file) {
  if (!/^src\/win\/_asar\/webview\/assets\/app-main-.*\.js$/.test(file)) {
    return false;
  }
  const ast = parseBundle(source);
  if (!ast) return false;
  let matches = 0;
  walk(ast, (node) => {
    if (node.type !== "Property" || propertyName(node) !== "delete-archived-conversation") {
      return;
    }
    let routeMatches = 0;
    walk(node.value, (inner) => {
      if (
        inner.type !== "ArrowFunctionExpression" ||
        inner.params.length !== 2 ||
        inner.params[0].type !== "Identifier" ||
        inner.params[1].type !== "ObjectPattern"
      ) {
        return;
      }
      const conversationId = inner.params[1].properties.find(
        (property) => propertyName(property) === "conversationId",
      )?.value;
      const body = inner.body;
      if (
        conversationId?.type === "Identifier" &&
        body?.type === "CallExpression" &&
        body.callee?.type === "MemberExpression" &&
        !body.callee.computed &&
        body.callee.object?.type === "Identifier" &&
        body.callee.object.name === inner.params[0].name &&
        body.callee.property?.name === "deleteArchivedConversation" &&
        body.arguments.length === 1 &&
        body.arguments[0]?.type === "Identifier" &&
        body.arguments[0].name === conversationId.name
      ) {
        routeMatches += 1;
      }
    });
    if (routeMatches === 1) matches += 1;
  });
  return matches === 1;
}

function hasNativeArchiveUi(source, file) {
  if (!/^src\/win\/_asar\/webview\/assets\/data-controls-.*\.js$/.test(file)) {
    return false;
  }
  if (!source.includes("settings.dataControls.archivedChats.delete")) return false;
  const ast = parseBundle(source);
  if (!ast) return false;
  let found = false;
  walk(ast, (node) => {
    if (
      found ||
      node.type !== "CallExpression" ||
      stringValue(node.arguments[0]) !== "delete-archived-conversation" ||
      node.arguments[1]?.type !== "ObjectExpression"
    ) {
      return;
    }
    found = node.arguments[1].properties.some(
      (property) => propertyName(property) === "conversationId",
    );
  });
  return found;
}

function hasLegacyArchiveDelete(source, file) {
  if (!isWebviewAsset(file)) return false;
  const ast = parseBundle(source);
  if (!ast) return false;
  let matches = 0;
  walk(ast, (node) => {
    if (node.type !== "Property" || propertyName(node) !== "delete-conversation") {
      return;
    }
    let protocolCalls = 0;
    walk(node.value, (inner) => {
      if (
        inner.type !== "CallExpression" ||
        inner.callee?.type !== "MemberExpression" ||
        inner.callee.property?.name !== "sendRequest" ||
        stringValue(inner.arguments[0]) !== "thread/delete" ||
        inner.arguments[1]?.type !== "ObjectExpression"
      ) {
        return;
      }
      if (
        inner.arguments[1].properties.some(
          (property) => propertyName(property) === "threadId",
        )
      ) {
        protocolCalls += 1;
      }
    });
    if (protocolCalls === 1) matches += 1;
  });
  return matches === 1;
}

function inspectArchiveDelete(sources) {
  const nativeRoutes = sources.filter(({ source, file }) =>
    hasNativeArchiveRoute(source, file),
  );
  const nativeUis = sources.filter(({ source, file }) =>
    hasNativeArchiveUi(source, file),
  );
  if (nativeRoutes.length === 1 && nativeUis.length === 1) {
    return {
      files: [...new Set([nativeRoutes[0].file, nativeUis[0].file])].sort(),
    };
  }
  const legacyRoutes = sources.filter(({ source, file }) =>
    hasLegacyArchiveDelete(source, file),
  );
  if (legacyRoutes.length === 1) return { files: [legacyRoutes[0].file] };
  return {
    detail:
      `native route/UI expected exactly 1/1, found ${nativeRoutes.length}/${nativeUis.length}; ` +
      `legacy route expected exactly 1, found ${legacyRoutes.length}`,
  };
}

function hasPatchedPluginWebviewAuth(source) {
  if (!source.includes("authMethod") || !source.includes("chatgpt") || !source.includes("apikey")) {
    return false;
  }
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return false;
  }
  let found = false;
  walk(ast, (node) => {
    if (found || node.type !== "LogicalExpression" || node.operator !== "||") return;
    const terms = flattenLogicalOr(node);
    const chatGptOperands = new Set(
      terms
        .map((term) => comparisonOperand(term, "chatgpt", source))
        .filter((operand) => operand?.includes("authMethod")),
    );
    found = terms
      .map((term) => comparisonOperand(term, "apikey", source))
      .some((operand) => chatGptOperands.has(operand));
  });
  return found;
}

function hasPatchedPluginStatsig(source) {
  const marker = "/* CodexRebuildPluginStatsig */";
  if (!source.includes(marker)) return false;
  const ast = parseBundle(source);
  if (!ast) return false;
  const contexts = ["browser_use", "browser_use_external", "computer_use"];
  const attached = new Set();
  walk(ast, (node) => {
    if (!isFunctionNode(node)) return;
    const functionSource = source.slice(node.start, node.end);
    if (!contexts.some((context) => functionSource.includes(context))) return;
    walk(
      node,
      (inner) => {
        if (
          isAlwaysTrue(inner) &&
          source.slice(inner.end, inner.end + marker.length) === marker
        ) {
          attached.add(inner.start);
        }
      },
      node,
    );
  });
  return attached.size === 3;
}

function hasPatchedPluginWebviewAvailability(source) {
  if (!source.includes("browser_use_external") || !source.includes("isLoading")) return false;
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return false;
  }
  let found = false;
  walk(ast, (node) => {
    if (found || !isFunctionNode(node)) return;
    const functionSource = source.slice(node.start, node.end);
    if (!functionSource.includes("browser_use_external")) return;
    walk(
      node,
      (inner) => {
        if (found || inner.type !== "ObjectExpression") return;
        const properties = new Map(inner.properties.map((property) => [propertyName(property), property]));
        found =
          isAlwaysTrue(properties.get("allowed")?.value) &&
          isAlwaysTrue(properties.get("available")?.value) &&
          properties.has("isLoading");
      },
      node,
    );
  });
  return found;
}

function inspectionFailure(error) {
  return { detail: error instanceof Error ? error.message : String(error) };
}

function requireExactlyOneSource(sources, pattern, label) {
  const matches = sources.filter(({ file }) => pattern.test(file));
  if (matches.length !== 1) {
    throw new Error(`${label} expected exactly 1 bundle, found ${matches.length}`);
  }
  return matches[0];
}

function inspectFastContract(sources) {
  try {
    const candidates = sources
      .filter(({ file }) =>
        /\/use-service-tier-settings-[^/]+\.js$/.test(file) ||
        /\/read-service-tier-for-request-[^/]+\.js$/.test(file),
      )
      .map(({ file, source }) => ({
        file,
        fileName: path.posix.basename(file),
        source,
      }));
    const plans = planFastModeTargets(candidates, "win verifier");
    if (
      plans.some(
        (plan) =>
          plan.result.status !== "already" ||
          plan.result.counts.patchable !== 0 ||
          plan.result.counts.already !== 1,
      )
    ) throw new Error("Fast mode targets are patchable instead of fully patched");
    return { files: plans.map((plan) => plan.file).sort() };
  } catch (error) {
    return inspectionFailure(error);
  }
}

function inspectPluginContract(sources) {
  try {
    const candidates = sources.filter(({ source, file }) => {
      const relative = file.replace(/^src\/win\/_asar\//, "");
      if (!/^(?:\.vite\/build|webview\/assets)\//.test(relative)) return false;
      return classifyPluginTarget(path.posix.basename(file), source) != null;
    });
    const main = candidates.filter(
      ({ source, file }) => classifyPluginTarget(path.posix.basename(file), source) === "main",
    );
    const webview = candidates.filter(
      ({ source, file }) => classifyPluginTarget(path.posix.basename(file), source) === "webview",
    );
    if (main.length !== 1 || webview.length !== 1) {
      throw new Error(
        `plugin main/webview expected exactly 1/1 bundle, found ${main.length}/${webview.length}`,
      );
    }
    const result = patchPluginContracts({
      mainSource: main[0].source,
      webviewSource: webview[0].source,
    });
    if (
      result.status !== "already" ||
      result.main.status !== "already" ||
      result.webview.status !== "already"
    ) throw new Error("plugin targets are patchable instead of fully patched");
    return { files: [main[0].file, webview[0].file].sort() };
  } catch (error) {
    return inspectionFailure(error);
  }
}

function inspectSharedArchiveContract(sources) {
  try {
    const appMain = requireExactlyOneSource(
      sources,
      /\/webview\/assets\/app-main-[^/]+\.js$/,
      "archive app-main",
    );
    const dataControls = requireExactlyOneSource(
      sources,
      /\/webview\/assets\/data-controls-[^/]+\.js$/,
      "archive data-controls",
    );
    const result = patchArchiveContracts({
      appMainSource: appMain.source,
      dataControlsSource: dataControls.source,
    });
    if (!['native', 'already'].includes(result.status)) {
      throw new Error("archive-delete targets are patchable instead of complete");
    }
    return { files: [appMain.file, dataControls.file].sort() };
  } catch (error) {
    return inspectionFailure(error);
  }
}

function inspectSidebarContract(sources) {
  try {
    const threadActions = requireExactlyOneSource(
      sources,
      /\/webview\/assets\/thread-actions-[^/]+\.js$/,
      "sidebar thread-actions",
    );
    const sidebar = requireExactlyOneSource(
      sources,
      /\/webview\/assets\/sidebar-flat-sections-[^/]+\.js$/,
      "sidebar-flat-sections",
    );
    const result = patchSidebarContracts({
      threadActionsSource: threadActions.source,
      sidebarSource: sidebar.source,
    });
    if (result.status !== "already") {
      throw new Error("sidebar-delete targets are patchable instead of fully patched");
    }
    return { files: [threadActions.file, sidebar.file].sort() };
  } catch (error) {
    return inspectionFailure(error);
  }
}

function inspectLocalUpdaterContract(sources) {
  try {
    const prefix = "src/win/_asar/";
    const packageEntry = requireExactlyOneSource(
      sources,
      /^src\/win\/_asar\/package\.json$/,
      "updater package metadata",
    );
    const files = Object.fromEntries(
      sources
        .filter(({ file }) => file.startsWith(prefix))
        .map(({ file, source }) => [file.slice(prefix.length), source]),
    );
    const validation = validateLocalUpdaterSources({
      packageSource: packageEntry.source,
      files,
    });
    return {
      files: validation.evidence
        .map(({ path: relative }) => `${prefix}${relative}`)
        .sort(),
    };
  } catch (error) {
    return inspectionFailure(error);
  }
}

const CONTRACT_DEFINITIONS = [
  {
    id: "fast",
    inspect: inspectFastContract,
  },
  {
    id: "plugin",
    inspect: inspectPluginContract,
  },
  {
    id: "archive-delete",
    inspect: inspectSharedArchiveContract,
  },
  {
    id: "sidebar-delete",
    inspect: inspectSidebarContract,
  },
  {
    id: "updater",
    inspect: inspectLocalUpdaterContract,
  },
];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function relativeEvidencePath(root, filePath) {
  return toPosix(path.relative(root, filePath));
}

function listBundleFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  const files = [];
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listBundleFiles(entryPath));
    } else if (
      entry.isFile() &&
      TEXT_BUNDLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      files.push(entryPath);
    }
  }

  return files;
}

function inspectPackage(packagePath, expectedVersion) {
  if (!fs.existsSync(packagePath)) {
    return {
      failure: {
        id: "package-json",
        detail: `missing extracted package manifest at ${packagePath}`,
      },
    };
  }

  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    return {
      failure: {
        id: "package-json",
        detail: `invalid extracted package manifest at ${packagePath}: ${error.message}`,
      },
    };
  }

  if (
    packageJson == null ||
    typeof packageJson !== "object" ||
    Array.isArray(packageJson) ||
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    return {
      failure: {
        id: "package-version",
        detail: `missing version in extracted package manifest at ${packagePath}`,
      },
    };
  }

  if (packageJson.version !== expectedVersion) {
    return {
      failure: {
        id: "package-version",
        detail: `expected ${expectedVersion}, found ${packageJson.version} at ${packagePath}`,
      },
    };
  }

  return { packageJson };
}

function verifyPatchedApp(root, platform, expectedVersion) {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("verifyPatchedApp requires a project root");
  }
  if (platform !== "win") {
    throw new Error(`unsupported patch-contract platform: ${platform}; expected win`);
  }
  if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
    throw new TypeError("verifyPatchedApp requires an expected version");
  }

  const resolvedRoot = path.resolve(root);
  const asarRoot = path.join(resolvedRoot, "src", platform, "_asar");
  const packagePath = path.join(asarRoot, "package.json");
  const failures = [];
  const packageInspection = inspectPackage(packagePath, expectedVersion);
  if (packageInspection.failure) failures.push(packageInspection.failure);

  const sources = [];
  try {
    for (const filePath of listBundleFiles(asarRoot)) {
      sources.push({
        file: relativeEvidencePath(resolvedRoot, filePath),
        source: fs.readFileSync(filePath, "utf8"),
      });
    }
  } catch (error) {
    failures.push({
      id: "bundle-scan",
      detail: `could not recursively scan ${asarRoot}: ${error.message}`,
    });
  }

  const context = { packageJson: packageInspection.packageJson };
  const contracts = {};
  for (const definition of CONTRACT_DEFINITIONS) {
    if (definition.inspect) {
      const inspection = definition.inspect(sources, context);
      if (inspection.detail) {
        failures.push({ id: definition.id, detail: inspection.detail });
      } else {
        contracts[definition.id] = inspection.files;
      }
      continue;
    }
    if (definition.groups) {
      const evidenceFiles = new Set();
      const missingGroups = [];
      for (const group of definition.groups) {
        const matchingFiles = sources
          .filter(({ source, file }) =>
            group.markers.every((marker) => marker.matches(source, file, context)),
          )
          .map(({ file }) => file)
          .sort();
        if (matchingFiles.length === 0) {
          const missingMarkers = group.markers
            .filter(
              (marker) =>
                !sources.some(({ source, file }) => marker.matches(source, file, context)),
            )
            .map((marker) => marker.label);
          missingGroups.push(
            missingMarkers.length > 0
              ? `${group.label}: missing ${missingMarkers.join(", ")}`
              : `${group.label}: markers are not co-located`,
          );
        } else {
          for (const file of matchingFiles) evidenceFiles.add(file);
        }
      }
      if (missingGroups.length > 0) {
        failures.push({ id: definition.id, detail: missingGroups.join("; ") });
      } else {
        contracts[definition.id] = [...evidenceFiles].sort();
      }
      continue;
    }
    if (definition.sameBundle) {
      const matchingFiles = sources
        .filter(({ source, file }) =>
          definition.markers.every((marker) => marker.matches(source, file, context)),
        )
        .map(({ file }) => file)
        .sort();
      if (matchingFiles.length > 0) {
        contracts[definition.id] = matchingFiles;
        continue;
      }

      const missingMarkers = definition.markers
        .filter(
          (marker) =>
            !sources.some(({ source, file }) => marker.matches(source, file, context)),
        )
        .map((marker) => marker.label);
      failures.push({
        id: definition.id,
        detail:
          missingMarkers.length > 0
            ? `missing ${missingMarkers.join(", ")}`
            : `markers are not co-located in one bundle: ${definition.markers
                .map((marker) => marker.label)
                .join(", ")}`,
      });
      continue;
    }

    const evidenceFiles = new Set();
    const missingMarkers = [];

    for (const marker of definition.markers) {
      const matchingFiles = sources
        .filter(({ source, file }) => marker.matches(source, file, context))
        .map(({ file }) => file);
      if (matchingFiles.length === 0) missingMarkers.push(marker.label);
      for (const file of matchingFiles) evidenceFiles.add(file);
    }

    if (missingMarkers.length > 0) {
      failures.push({
        id: definition.id,
        detail: `missing ${missingMarkers.join(", ")}`,
      });
    } else {
      contracts[definition.id] = [...evidenceFiles].sort();
    }
  }

  if (failures.length > 0) {
    const error = new Error(
      [
        `Patched app verification failed for ${platform}:`,
        ...failures.map((failure) => `- ${failure.id}: ${failure.detail}`),
      ].join("\n"),
    );
    error.code = "PATCH_CONTRACTS_UNSATISFIED";
    error.failures = failures;
    throw error;
  }

  return { contracts };
}

function parseCliArgs(argv) {
  const options = { root: PROJECT_ROOT };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    let value = equals === -1 ? undefined : argument.slice(equals + 1);
    if (["--root", "--platform", "--expected-version"].includes(name)) {
      if (value === undefined) {
        index++;
        value = argv[index];
      }
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${name} requires a value`);
      }
      if (name === "--root") options.root = value;
      if (name === "--platform") options.platform = value;
      if (name === "--expected-version") options.expectedVersion = value;
      continue;
    }

    throw new Error(`unknown argument: ${argument}`);
  }

  return options;
}

function usage() {
  return [
    "Usage: node scripts/verify-patched-app.js --platform win --expected-version <version>",
    "       [--root <project-root>]",
  ].join("\n");
}

function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    if (!options.platform || !options.expectedVersion) {
      throw new Error(`--platform and --expected-version are required\n${usage()}`);
    }

    const result = verifyPatchedApp(
      options.root,
      options.platform,
      options.expectedVersion,
    );
    console.log(`[ok] package-version: ${options.expectedVersion}`);
    for (const [contract, evidenceFiles] of Object.entries(result.contracts)) {
      console.log(`[ok] ${contract}: ${evidenceFiles.join(", ")}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { verifyPatchedApp };

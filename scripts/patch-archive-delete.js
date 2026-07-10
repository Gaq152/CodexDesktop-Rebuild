#!/usr/bin/env node
/**
 * patch-archive-delete.js — Add "Delete" button to archived conversations list.
 *
 * Two-layer patch:
 *   1. app-main chunk: inject "delete-conversation" route into the message router
 *   2. data-controls chunk: inject a red "Delete" button next to "Unarchive"
 *      with inline two-step confirmation, not a native confirm() dialog
 *
 * The delete button calls the app-server "thread/delete" protocol via the
 * message router, which permanently removes the thread (DB + rollout file).
 *
 * Requires the bundled official Codex CLI to support thread/delete.
 */
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

// ─── Layer 1: app-main route injection ──────────────────────────

function patchAppMain(bundles) {
  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    if (code.includes("delete-conversation")) {
      console.log(`  [ok] ${relPath(bundle.path)}: route already patched`);
      continue;
    }

    // Dynamically find the archive-conversation route and reuse its wrapper.
    // The archive route uses the conversation-aware wrapper, so delete can work
    // with either a conversationId alone or an explicit hostId.
    const routeRe = /(["`])archive-conversation\1:(\w+)\(async\((\w+),\{conversationId:(\w+),cleanupWorktree:(\w+),source:(\w+)\}\)=>\{\s*await \3\.archiveConversation\(\4,\{cleanupWorktree:\5,source:\6\}\)\s*\}\)/;
    const routeMatch = code.match(routeRe);
    if (!routeMatch) {
      console.log(`  [!] ${relPath(bundle.path)}: archive-conversation route not found`);
      continue;
    }

    const q = routeMatch[1]; // quote style
    const wrapperFn = routeMatch[2]; // e.g. XE
    const mgrVar = routeMatch[3]; // e.g. e (the app server manager)
    const cidVar = routeMatch[4]; // e.g. t (conversationId param)
    const anchorEnd = routeMatch.index + routeMatch[0].length;

    const inject = `,${q}delete-conversation${q}:${wrapperFn}(async(${mgrVar},{conversationId:${cidVar}})=>{await ${mgrVar}.sendRequest(${q}thread/delete${q},{threadId:${cidVar}})})`;
    const newCode = code.slice(0, anchorEnd) + inject + code.slice(anchorEnd);
    fs.writeFileSync(bundle.path, newCode);
    console.log(`  [ok] ${relPath(bundle.path)}: injected delete-conversation route (wrapper=${wrapperFn})`);
    patched++;
  }
  return patched;
}

// ─── Layer 2: data-controls delete button injection ─────────────

function patchDataControls(bundles) {
  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    if (
      code.includes("delete-archived-conversation") ||
      code.includes("settings.dataControls.archivedChats.delete")
    ) {
      console.log(`  [ok] ${relPath(bundle.path)}: archived delete is native upstream`);
      continue;
    }

    if (code.includes("delete-conversation")) {
      const legacyConfirm =
        "onClick:async()=>{if(!confirm(`Permanently delete this conversation?`))return;try{";
      if (!code.includes(legacyConfirm)) {
        console.log(`  [ok] ${relPath(bundle.path)}: delete button already patched`);
        continue;
      }

      const inlineConfirm =
        "onClick:async e=>{let t=e.currentTarget;if(t.dataset.codexConfirmDelete!==`true`){t.dataset.codexConfirmDelete=`true`,t.textContent=`确认删除`,t.style.boxShadow=`inset 0 0 0 1px color-mix(in srgb, #ef4444 45%, transparent)`,clearTimeout(t.__codexDeleteTimer),t.__codexDeleteTimer=setTimeout(()=>{t.isConnected&&t.dataset.codexConfirmDelete===`true`&&(delete t.dataset.codexConfirmDelete,t.textContent=`删除`,t.style.boxShadow=``)},5e3);return}clearTimeout(t.__codexDeleteTimer);try{";
      fs.writeFileSync(bundle.path, code.replace(legacyConfirm, inlineConfirm));
      console.log(`  [ok] ${relPath(bundle.path)}: migrated delete button to inline confirmation`);
      patched++;
      continue;
    }

    let ast;
    try {
      ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
    } catch (e) {
      console.log(`  [!] ${relPath(bundle.path)}: parse failed: ${e.message}`);
      continue;
    }

    // ── Step 1: Extract import variable names via AST ImportDeclarations ──

    let msgFnName = null;
    let btnComponent = null;
    let jsxFactory = null; // import from jsx-runtime (factory function, NOT the runtime)

    for (const node of ast.body) {
      if (node.type !== "ImportDeclaration") continue;
      const src = node.source.value;
      const specs = node.specifiers.filter((s) => s.type === "ImportSpecifier");

      if (src.includes("app-server-manager-signals") && specs.length >= 2) {
        // Second specifier is the messaging function (sendRequest wrapper).
        msgFnName = specs[1].local.name;
      }
      if (src.includes("button-") && specs.length >= 1) {
        btnComponent = specs[0].local.name;
      }
      if (src.includes("jsx-runtime") && specs.length >= 1) {
        jsxFactory = specs[0].local.name;
      }
    }

    const ROW_CLASS =
      "flex w-full items-center justify-between gap-3 px-4 py-3 hover:bg-token-list-hover-background";

    let threadVar = null;
    let hostIdVar = null;
    let queryClientVar = null;
    let contentVar = null;
    let unarchiveBtnVar = null;
    let childrenArrayStart = -1;
    let childrenArrayEnd = -1;

    // Recursive AST walker.
    function walk(node, visitors) {
      if (!node || typeof node !== "object") return;
      if (node.type) {
        for (const v of visitors) v(node);
      }
      for (const key of Object.keys(node)) {
        if (key === "type" || key === "start" || key === "end") continue;
        const val = node[key];
        if (Array.isArray(val)) val.forEach((n) => walk(n, visitors));
        else if (val && typeof val === "object" && val.type) walk(val, visitors);
      }
    }

    // Resolve the actual jsx runtime instance: `var E = r()` where r is jsxFactory.
    // The import is a factory function; calling it returns the runtime with .jsx/.jsxs.
    let jsxRuntime = null;
    if (jsxFactory) {
      walk(ast, [
        (node) => {
          if (
            node.type === "VariableDeclarator" &&
            node.id?.type === "Identifier" &&
            node.init?.type === "CallExpression" &&
            node.init.callee?.type === "Identifier" &&
            node.init.callee.name === jsxFactory &&
            node.init.arguments.length === 0
          ) {
            jsxRuntime = node.id.name;
          }
        },
      ]);
    }

    // Find the FunctionDeclaration containing the ROW_CLASS literal.
    let rowFunc = null;
    walk(ast, [
      (node) => {
        if (node.type !== "FunctionDeclaration") return;
        const slice = code.slice(node.start, node.end);
        if (slice.includes(ROW_CLASS)) rowFunc = node;
      },
    ]);

    if (!rowFunc) {
      console.log(`  [!] ${relPath(bundle.path)}: row function not found`);
      continue;
    }

    // Inside the row function, find:
    //   a) ObjectPattern destructuring with key "archivedThread" → threadVar, hostIdVar
    //   b) MemberExpression .cancelQueries() → queryClientVar
    //   c) CallExpression jsxs("div", {className: ROW_CLASS, children: [X, Y]}) → contentVar, unarchiveBtnVar
    walk(rowFunc, [
      (node) => {
        // (a) ObjectPattern: {archivedThread:X, conversationId:Y, hostId:Z, ...} = e
        if (node.type === "ObjectPattern") {
          for (const prop of node.properties) {
            if (prop.type !== "Property" || prop.key?.type !== "Identifier") continue;
            if (prop.key.name === "archivedThread" && prop.value?.type === "Identifier") {
              threadVar = prop.value.name;
            }
            if (prop.key.name === "hostId" && prop.value?.type === "Identifier") {
              hostIdVar = prop.value.name;
            }
          }
        }

        // (b) MemberExpression: X.cancelQueries(...)
        if (
          node.type === "CallExpression" &&
          node.callee?.type === "MemberExpression" &&
          node.callee.property?.name === "cancelQueries" &&
          node.callee.object?.type === "Identifier"
        ) {
          queryClientVar = node.callee.object.name;
        }

        // (c) jsxs("div", {className: ROW_CLASS, children: [X, Y]})
        if (
          node.type === "CallExpression" &&
          node.arguments?.length >= 2 &&
          node.arguments[1]?.type === "ObjectExpression"
        ) {
          const props = node.arguments[1].properties;
          const clsProp = props?.find(
            (p) =>
              p.key?.name === "className" &&
              p.value?.type === "TemplateLiteral" &&
              p.value.quasis?.[0]?.value?.raw === ROW_CLASS,
          );
          if (!clsProp) return;
          const childProp = props?.find(
            (p) => p.key?.name === "children" && p.value?.type === "ArrayExpression",
          );
          if (!childProp || childProp.value.elements.length !== 2) return;
          const [el0, el1] = childProp.value.elements;
          if (el0?.type === "Identifier") contentVar = el0.name;
          if (el1?.type === "Identifier") unarchiveBtnVar = el1.name;
          childrenArrayStart = childProp.value.start;
          childrenArrayEnd = childProp.value.end;
        }
      },
    ]);

    // ── Step 3: Validate all variables resolved ──

    if (
      !msgFnName || !btnComponent || !jsxRuntime ||
      !threadVar || !hostIdVar || !queryClientVar ||
      !contentVar || !unarchiveBtnVar || childrenArrayStart < 0
    ) {
      console.log(`  [!] ${relPath(bundle.path)}: could not resolve all variables`);
      console.log(
        `      msgFn=${msgFnName} btn=${btnComponent} jsx=${jsxRuntime}` +
        ` thread=${threadVar} host=${hostIdVar} qc=${queryClientVar}` +
        ` content=${contentVar} unarchiveBtn=${unarchiveBtnVar}`,
      );
      continue;
    }

    // ── Step 4: Build delete button and splice into children array ──

    const deleteBtn = [
      `(0,${jsxRuntime}.jsx)(${btnComponent},{`,
        `className:\`shrink-0\`,`,
        `color:\`secondary\`,`,
        `size:\`toolbar\`,`,
        `style:{color:\`#ef4444\`},`,
        `onClick:async e=>{`,
          `let t=e.currentTarget;`,
          `if(t.dataset.codexConfirmDelete!==\`true\`){`,
            `t.dataset.codexConfirmDelete=\`true\`,t.textContent=\`确认删除\`,`,
            `t.style.boxShadow=\`inset 0 0 0 1px color-mix(in srgb, #ef4444 45%, transparent)\`,`,
            `clearTimeout(t.__codexDeleteTimer),`,
            `t.__codexDeleteTimer=setTimeout(()=>{`,
              `t.isConnected&&t.dataset.codexConfirmDelete===\`true\`&&`,
              `(delete t.dataset.codexConfirmDelete,t.textContent=\`删除\`,t.style.boxShadow=\`\`)`,
            `},5e3);`,
            `return`,
          `}`,
          `clearTimeout(t.__codexDeleteTimer);`,
          `try{`,
            `${queryClientVar}.setQueryData([\`archived-threads\`,${hostIdVar}],`,
              `(${queryClientVar}.getQueryData([\`archived-threads\`,${hostIdVar}])??[])`,
              `.filter(e=>e.id!==${threadVar}.id));`,
            `await ${msgFnName}(\`delete-conversation\`,{conversationId:${threadVar}.id,hostId:${hostIdVar}})`,
          `}catch(e){`,
            `${queryClientVar}.invalidateQueries({queryKey:[\`archived-threads\`,${hostIdVar}]})`,
          `}`,
        `},`,
        `children:\`删除\``,
      `})`,
    ].join("");

    // Replace [contentVar, unarchiveBtnVar] with [contentVar, deleteBtn, unarchiveBtnVar]
    const newArray = `[${contentVar},${deleteBtn},${unarchiveBtnVar}]`;
    const newCode = code.slice(0, childrenArrayStart) + newArray + code.slice(childrenArrayEnd);

    fs.writeFileSync(bundle.path, newCode);
    console.log(
      `  [ok] ${relPath(bundle.path)}: injected delete button` +
      ` (thread=${threadVar} host=${hostIdVar} qc=${queryClientVar} btn=${btnComponent})`,
    );
    patched++;
  }
  return patched;
}

function archiveCount(patchable, already, native, label) {
  const total = patchable + already + native;
  if (total !== 1) {
    throw new Error(`${label} expected exactly 1 target, found ${total}`);
  }
  return { patchable, already, native, total };
}

function walkArchive(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(child)) {
      for (const item of child) walkArchive(item, visitor);
    } else {
      walkArchive(child, visitor);
    }
  }
}

function archiveLiteral(node) {
  if (node?.type === "Literal") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function archivePropertyName(node) {
  if (node?.type !== "Property") return null;
  if (!node.computed && node.key.type === "Identifier") return node.key.name;
  return archiveLiteral(node.key);
}

function parseArchiveSource(source, label) {
  try {
    return acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    throw new Error(`${label} parse failed: ${error.message}`);
  }
}

function objectPatternBinding(pattern, name) {
  if (pattern?.type !== "ObjectPattern") return null;
  const property = pattern.properties.find(
    (item) => item.type === "Property" && archivePropertyName(item) === name,
  );
  return property?.value?.type === "Identifier" ? property.value.name : null;
}

function callbackForWrappedRoute(property) {
  const value = property?.value;
  if (value?.type !== "CallExpression" || value.arguments.length !== 1) return null;
  const callback = value.arguments[0];
  if (
    callback?.type !== "ArrowFunctionExpression" &&
    callback?.type !== "FunctionExpression"
  ) return null;
  return callback;
}

function directCallbackCalls(callback) {
  const calls = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node !== callback && ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type)) return;
    if (node.type === "CallExpression") calls.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  visit(callback.body);
  return calls;
}

function inspectArchiveAppMainSource(source) {
  const ast = parseArchiveSource(source, "archive app-main");
  const properties = { native: [], legacy: [] };
  const tokens = { native: 0, legacy: 0 };
  walkArchive(ast, (node) => {
    const value = archiveLiteral(node);
    if (value === "delete-archived-conversation") tokens.native += 1;
    if (value === "delete-conversation") tokens.legacy += 1;
    if (node.type !== "Property") return;
    const name = archivePropertyName(node);
    if (name === "delete-archived-conversation") properties.native.push(node);
    if (name === "delete-conversation") properties.legacy.push(node);
  });
  const native = properties.native.filter((property) => {
    const callback = callbackForWrappedRoute(property);
    if (!callback || callback.params.length !== 2 || callback.params[0].type !== "Identifier") return false;
    const manager = callback.params[0].name;
    const conversationId = objectPatternBinding(callback.params[1], "conversationId");
    if (!conversationId) return false;
    const calls = directCallbackCalls(callback).filter(
      (call) =>
        call.callee?.type === "MemberExpression" &&
        !call.callee.computed &&
        call.callee.object?.type === "Identifier" &&
        call.callee.object.name === manager &&
        call.callee.property?.name === "deleteArchivedConversation" &&
        call.arguments.length === 1 &&
        call.arguments[0]?.type === "Identifier" &&
        call.arguments[0].name === conversationId,
    );
    return calls.length === 1;
  });
  const legacy = properties.legacy.filter((property) => {
    const callback = callbackForWrappedRoute(property);
    if (!callback || callback.params.length !== 2 || callback.params[0].type !== "Identifier") return false;
    const manager = callback.params[0].name;
    const conversationId = objectPatternBinding(callback.params[1], "conversationId");
    if (!conversationId) return false;
    const calls = directCallbackCalls(callback).filter((call) => {
      if (
        call.callee?.type !== "MemberExpression" ||
        call.callee.object?.type !== "Identifier" ||
        call.callee.object.name !== manager ||
        call.callee.property?.name !== "sendRequest" ||
        archiveLiteral(call.arguments[0]) !== "thread/delete" ||
        call.arguments[1]?.type !== "ObjectExpression"
      ) return false;
      const threadId = call.arguments[1].properties.find(
        (item) => archivePropertyName(item) === "threadId",
      )?.value;
      return threadId?.type === "Identifier" && threadId.name === conversationId;
    });
    return calls.length === 1;
  });
  if (properties.native.length !== native.length || tokens.native !== properties.native.length) {
    if (properties.native.length > 0 || tokens.native > 0) {
      throw new Error("native archive route evidence is detached or structurally malformed");
    }
  }
  if (properties.legacy.length !== legacy.length || tokens.legacy !== properties.legacy.length) {
    if (properties.legacy.length > 0 || tokens.legacy > 0) {
      throw new Error("legacy archive route evidence is detached or structurally malformed");
    }
  }
  if (native.length > 0 && legacy.length > 0) {
    throw new Error("archive native and legacy route modes are mutually exclusive");
  }
  if (native.length > 0) {
    if (native.length !== 1) throw new Error(`native archive route expected exactly 1 target, found ${native.length}`);
    return { mode: "native", status: "native" };
  }
  if (legacy.length > 0) {
    if (legacy.length !== 1) throw new Error(`legacy archive route expected exactly 1 target, found ${legacy.length}`);
    return { mode: "legacy", status: "already" };
  }
  return null;
}

function patchAppMainSource(source) {
  const inspection = inspectArchiveAppMainSource(source);
  if (inspection) {
    return {
      code: source,
      status: inspection.status,
      mode: inspection.mode,
      counts:
        inspection.mode === "native"
          ? archiveCount(0, 0, 1, "archive route")
          : archiveCount(0, 1, 0, "archive route"),
    };
  }

  const routeRe = /(["`])archive-conversation\1:(\w+)\(async\((\w+),\{conversationId:(\w+),cleanupWorktree:(\w+),source:(\w+)\}\)=>\{\s*await \3\.archiveConversation\(\4,\{cleanupWorktree:\5,source:\6\}\)\s*\}\)/g;
  const matches = [...source.matchAll(routeRe)];
  if (matches.length !== 1) {
    throw new Error(`archive route expected exactly 1 target, found ${matches.length}`);
  }
  const match = matches[0];
  const quote = match[1];
  const wrapper = match[2];
  const manager = match[3];
  const conversationId = match[4];
  const end = match.index + match[0].length;
  const injection = `,${quote}delete-conversation${quote}:${wrapper}(async(${manager},{conversationId:${conversationId}})=>{await ${manager}.sendRequest(${quote}thread/delete${quote},{threadId:${conversationId}})})`;
  const code = source.slice(0, end) + injection + source.slice(end);
  const patchedInspection = inspectArchiveAppMainSource(code);
  if (patchedInspection?.mode !== "legacy") {
    throw new Error("legacy archive route postcondition was not established");
  }
  return {
    code,
    status: "patched",
    mode: "legacy",
    counts: archiveCount(1, 0, 0, "archive route"),
  };
}

function inspectArchiveDataControlsSource(source) {
  const ast = parseArchiveSource(source, "archive data-controls");
  const tokenCounts = new Map([
    ["delete-archived-conversation", 0],
    ["settings.dataControls.archivedChats.delete", 0],
    ["thread/delete", 0],
    ["delete-conversation", 0],
  ]);
  walkArchive(ast, (node) => {
    const value = archiveLiteral(node);
    if (tokenCounts.has(value)) tokenCounts.set(value, tokenCounts.get(value) + 1);
  });
  const labelProperties = [];
  walkArchive(ast, (node) => {
    if (node.type !== "Property" || archivePropertyName(node) !== "delete") return;
    const id = node.value?.type === "ObjectExpression"
      ? node.value.properties.find((item) => archivePropertyName(item) === "id")
      : null;
    if (archiveLiteral(id?.value) === "settings.dataControls.archivedChats.delete") {
      labelProperties.push(node);
    }
  });
  const nativeFunctions = [];
  const legacyFunctions = [];
  walkArchive(ast, (node) => {
    if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression") return;
    const nativeCalls = [];
    const threadDeleteCalls = [];
    const legacyCalls = [];
    let confirmMembers = 0;
    walkArchive(node.body, (inner) => {
      if (inner.type === "MemberExpression" && (inner.property?.name ?? archiveLiteral(inner.property)) === "codexConfirmDelete") {
        confirmMembers += 1;
      }
      if (inner.type !== "CallExpression") return;
      if (
        archiveLiteral(inner.arguments[0]) === "delete-archived-conversation" &&
        inner.arguments[1]?.type === "ObjectExpression" &&
        inner.arguments[1].properties.some((item) => archivePropertyName(item) === "conversationId")
      ) nativeCalls.push(inner);
      if (inner.arguments.some((argument) => archiveLiteral(argument) === "thread/delete")) {
        threadDeleteCalls.push(inner);
      }
      if (
        archiveLiteral(inner.arguments[0]) === "delete-conversation" &&
        inner.arguments[1]?.type === "ObjectExpression" &&
        ["conversationId", "hostId"].every((name) =>
          inner.arguments[1].properties.some((item) => archivePropertyName(item) === name),
        )
      ) legacyCalls.push(inner);
    });
    if (nativeCalls.length === 2 && threadDeleteCalls.length === 1) nativeFunctions.push(node);
    if (legacyCalls.length === 1 && confirmMembers > 0) legacyFunctions.push(node);
  });
  const nativeEvidence =
    labelProperties.length === 1 &&
    nativeFunctions.length === 1 &&
    tokenCounts.get("delete-archived-conversation") === 2 &&
    tokenCounts.get("settings.dataControls.archivedChats.delete") === 1 &&
    tokenCounts.get("thread/delete") === 1;
  const legacyEvidence =
    legacyFunctions.length === 1 && tokenCounts.get("delete-conversation") === 1;
  const anyNativeToken =
    tokenCounts.get("delete-archived-conversation") > 0 ||
    tokenCounts.get("settings.dataControls.archivedChats.delete") > 0 ||
    tokenCounts.get("thread/delete") > 0;
  const anyLegacyToken = tokenCounts.get("delete-conversation") > 0;
  if (nativeEvidence && legacyEvidence) {
    throw new Error("archive native and legacy UI modes are mutually exclusive");
  }
  if (nativeEvidence) return { mode: "native", status: "native" };
  if (legacyEvidence) return { mode: "legacy", status: "already" };
  if (anyNativeToken) throw new Error("native archive-delete UI evidence is detached or structurally malformed");
  if (anyLegacyToken) throw new Error("legacy archive-delete UI evidence is detached or structurally malformed");
  return null;
}

function patchDataControlsSource(source) {
  const inspection = inspectArchiveDataControlsSource(source);
  if (inspection?.mode === "native") {
    return {
      code: source,
      status: "native",
      mode: "native",
      counts: archiveCount(0, 0, 1, "archive button"),
    };
  }
  if (inspection?.mode === "legacy") {
    return {
      code: source,
      status: "already",
      mode: "legacy",
      counts: archiveCount(0, 1, 0, "archive button"),
    };
  }
  throw new Error("archive button expected exactly 1 target, found 0");
}

function patchArchiveContracts({ appMainSource, dataControlsSource }) {
  if (typeof appMainSource !== "string") throw new Error("archive app-main source is required");
  if (typeof dataControlsSource !== "string") throw new Error("archive data-controls source is required");
  const appMain = patchAppMainSource(appMainSource);
  const dataControls = patchDataControlsSource(dataControlsSource);
  if (appMain.mode !== dataControls.mode) {
    throw new Error(
      `archive route/UI mode mismatch: app-main=${appMain.mode}, data-controls=${dataControls.mode}`,
    );
  }
  const status =
    appMain.status === "native" && dataControls.status === "native"
      ? "native"
      : appMain.status === "already" && dataControls.status === "already"
        ? "already"
        : "patched";
  return {
    status,
    appMain,
    dataControls,
    counts: { route: appMain.counts, button: dataControls.counts },
  };
}

function findExactAsset(platform, pattern, label) {
  const directory = path.join(SRC_DIR, platform, "_asar", "webview", "assets");
  if (!fs.existsSync(directory)) throw new Error(`${label} asset directory is missing for ${platform}`);
  const matches = fs.readdirSync(directory).filter((fileName) => pattern.test(fileName));
  if (matches.length !== 1) {
    throw new Error(`${label} expected exactly 1 bundle for ${platform}, found ${matches.length}`);
  }
  return path.join(directory, matches[0]);
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((name) =>
        fs.existsSync(path.join(SRC_DIR, name, "_asar")),
      );
  if (platforms.length === 0) throw new Error("archive-delete expected at least one platform");
  const plans = platforms.map((platformName) => {
    const appMainPath = findExactAsset(platformName, /^app-main-.*\.js$/, "archive app-main");
    const dataControlsPath = findExactAsset(
      platformName,
      /^data-controls-.*\.js$/,
      "archive data-controls",
    );
    const appMainSource = fs.readFileSync(appMainPath, "utf-8");
    const dataControlsSource = fs.readFileSync(dataControlsPath, "utf-8");
    return {
      platform: platformName,
      appMainPath,
      dataControlsPath,
      appMainSource,
      dataControlsSource,
      result: patchArchiveContracts({ appMainSource, dataControlsSource }),
    };
  });
  for (const plan of plans) {
    console.log(`  [${plan.platform}] ${isCheck ? "check" : plan.result.status}: ${JSON.stringify(plan.result.counts)}`);
  }
  if (!isCheck) {
    for (const plan of plans) {
      if (plan.result.appMain.code !== plan.appMainSource) {
        fs.writeFileSync(plan.appMainPath, plan.result.appMain.code, "utf-8");
      }
      if (plan.result.dataControls.code !== plan.dataControlsSource) {
        fs.writeFileSync(plan.dataControlsPath, plan.result.dataControls.code, "utf-8");
      }
    }
  }
  console.log(`  [done] archive-delete contracts satisfied for ${plans.length} platform(s)`);
}

if (require.main === module) main();

module.exports = {
  inspectArchiveAppMainSource,
  inspectArchiveDataControlsSource,
  patchAppMainSource,
  patchDataControlsSource,
  patchArchiveContracts,
};

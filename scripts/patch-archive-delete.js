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
const { relPath, SRC_DIR } = require("./patch-util");
const {
  planRequiredRoles,
  commitValidatedPlan,
} = require("./mac-contract-locator");

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

function combinedArchiveRouteCount(patchable, already) {
  const native = 1;
  const total = patchable + already + native;
  if (patchable + already !== 1) {
    throw new Error(`active archive route expected exactly 1 target, found ${patchable + already}`);
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

function isArchiveFunction(node) {
  return ["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"].includes(
    node?.type,
  );
}

function walkArchiveWithAncestors(node, visitor, ancestors = []) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, ancestors);
  const nextAncestors = node.type ? [...ancestors, node] : ancestors;
  for (const [key, child] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(child)) {
      for (const item of child) walkArchiveWithAncestors(item, visitor, nextAncestors);
    } else {
      walkArchiveWithAncestors(child, visitor, nextAncestors);
    }
  }
}

function walkOwnArchiveFunction(root, visitor) {
  function visit(node, ancestors) {
    if (!node || typeof node !== "object") return;
    if (node !== root && isArchiveFunction(node)) return;
    if (node.type) visitor(node, ancestors);
    const nextAncestors = node.type ? [...ancestors, node] : ancestors;
    for (const [key, child] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item, nextAncestors);
      } else {
        visit(child, nextAncestors);
      }
    }
  }
  visit(root, []);
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
  if (
    value?.type !== "CallExpression" ||
    value.callee.type !== "Identifier" ||
    value.arguments.length !== 1
  ) return null;
  const callback = value.arguments[0];
  if (
    callback?.type !== "ArrowFunctionExpression" &&
    callback?.type !== "FunctionExpression"
  ) return null;
  return callback;
}

function directCallbackCalls(callback) {
  const expressions = [];
  if (callback.body.type === "BlockStatement") {
    for (const statement of callback.body.body) {
      if (statement.type === "ExpressionStatement") expressions.push(statement.expression);
      if (statement.type === "ReturnStatement" && statement.argument) expressions.push(statement.argument);
    }
  } else {
    expressions.push(callback.body);
  }
  return expressions
    .map((expression) => {
      let current = expression;
      while (["AwaitExpression", "ChainExpression"].includes(current?.type)) {
        current = current.argument ?? current.expression;
      }
      return current?.type === "CallExpression" ? current : null;
    })
    .filter(Boolean);
}

function assignedArchiveIdentifier(node, ancestors) {
  const parent = ancestors.at(-1);
  if (parent?.type === "VariableDeclarator" && parent.init === node && parent.id.type === "Identifier") {
    return parent.id.name;
  }
  if (
    parent?.type === "AssignmentExpression" &&
    parent.operator === "=" &&
    parent.right === node &&
    parent.left.type === "Identifier"
  ) {
    return parent.left.name;
  }
  return null;
}

function archiveExecutionOwner(ast, ancestors) {
  return [...ancestors].reverse().find(isArchiveFunction) ?? ast;
}

function archiveCalledMemberName(call) {
  let callee = call?.callee;
  if (callee?.type === "SequenceExpression") callee = callee.expressions.at(-1);
  if (callee?.type !== "MemberExpression") return null;
  return callee.property?.name ?? archiveLiteral(callee.property);
}

function createArchiveReachability(ast) {
  const bindings = new Map();
  const ownerParents = new Map([[ast, null]]);
  const addBinding = (owner, name, fn) => {
    if (!name || !isArchiveFunction(fn)) return;
    let ownerBindings = bindings.get(owner);
    if (!ownerBindings) bindings.set(owner, (ownerBindings = new Map()));
    const values = ownerBindings.get(name) ?? [];
    if (!values.includes(fn)) values.push(fn);
    ownerBindings.set(name, values);
  };
  walkArchiveWithAncestors(ast, (node, ancestors) => {
    if (!isArchiveFunction(node)) return;
    const owner = archiveExecutionOwner(ast, ancestors);
    ownerParents.set(node, owner);
    const parent = ancestors.at(-1);
    if (node.type === "FunctionDeclaration") addBinding(owner, node.id?.name, node);
    if (parent?.type === "VariableDeclarator" && parent.init === node) {
      addBinding(owner, parent.id?.type === "Identifier" ? parent.id.name : null, node);
    }
    if (parent?.type === "AssignmentExpression" && parent.operator === "=" && parent.right === node) {
      addBinding(owner, parent.left?.type === "Identifier" ? parent.left.name : null, node);
    }
    const call = parent?.type === "CallExpression" && parent.arguments.includes(node) ? parent : null;
    const declarator = call && ancestors.at(-2)?.type === "VariableDeclarator"
      ? ancestors.at(-2)
      : null;
    const declaration = declarator && ancestors.at(-3)?.type === "VariableDeclaration"
      ? ancestors.at(-3)
      : null;
    if (
      owner === ast &&
      call &&
      declarator?.init === call &&
      declarator.id.type === "Identifier" &&
      declaration &&
      ast.body.includes(declaration) &&
      call.arguments.filter(isArchiveFunction).length === 1
    ) addBinding(ast, declarator.id.name, node);
  });

  const resolve = (owner, name) => {
    for (let current = owner; current; current = ownerParents.get(current)) {
      const values = bindings.get(current)?.get(name) ?? [];
      if (values.length === 1) return values[0];
      if (values.length > 1) return null;
    }
    return null;
  };
  const reachable = new Set([ast]);
  const queue = [ast];
  const enqueue = (fn) => {
    if (!isArchiveFunction(fn) || reachable.has(fn)) return;
    reachable.add(fn);
    queue.push(fn);
  };

  for (const statement of ast.body) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (statement.declaration?.type === "FunctionDeclaration") enqueue(statement.declaration);
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.local?.type === "Identifier") enqueue(resolve(ast, specifier.local.name));
    }
  }
  function walkExecutableOwner(node, owner, parent = null) {
    if (!node || typeof node !== "object") return;
    if (node !== owner && isArchiveFunction(node)) {
      if (parent?.type === "CallExpression" && parent.callee === node) enqueue(node);
      return;
    }
    if (node.type === "CallExpression") {
      let callee = node.callee;
      if (callee.type === "SequenceExpression") callee = callee.expressions.at(-1);
      if (callee?.type === "Identifier") enqueue(resolve(owner, callee.name));
      if (callee?.type === "CallExpression") {
        for (const argument of callee.arguments) {
          if (isArchiveFunction(argument)) enqueue(argument);
        }
      }
      const memberName = archiveCalledMemberName(node);
      if (["jsx", "jsxs", "createElement"].includes(memberName)) {
        const component = node.arguments[0];
        if (component?.type === "Identifier") enqueue(resolve(owner, component.name));
      }
      if (["setMessageHandler", "useEffect", "useLayoutEffect"].includes(memberName)) {
        for (const argument of node.arguments) {
          if (isArchiveFunction(argument)) enqueue(argument);
          if (argument?.type === "Identifier") enqueue(resolve(owner, argument.name));
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      if (Array.isArray(child)) {
        for (const item of child) walkExecutableOwner(item, owner, node);
      } else {
        walkExecutableOwner(child, owner, node);
      }
    }
  }

  while (queue.length > 0) {
    const owner = queue.shift();
    walkExecutableOwner(owner, owner);
  }
  return {
    isReachable(owner) {
      return reachable.has(owner);
    },
  };
}

function isLiveArchiveRouter(ast, ancestors, reachability) {
  const routeObject = ancestors.at(-1);
  if (routeObject?.type !== "ObjectExpression") return false;
  const binding = assignedArchiveIdentifier(routeObject, ancestors.slice(0, -1));
  if (!binding) return false;
  const routeOwner = archiveExecutionOwner(ast, ancestors);
  if (!reachability.isReachable(routeOwner)) return false;
  const consumers = [];
  walkArchiveWithAncestors(ast, (node, callAncestors) => {
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "MemberExpression" ||
      (node.callee.property?.name ?? archiveLiteral(node.callee.property)) !== "setMessageHandler" ||
      node.arguments.length !== 1 ||
      !isArchiveFunction(node.arguments[0])
    ) return;
    const callOwner = archiveExecutionOwner(ast, callAncestors);
    if (!reachability.isReachable(callOwner)) return;
    const handler = node.arguments[0];
    const routeKey = handler.params[0]?.type === "Identifier" ? handler.params[0].name : null;
    if (!routeKey || handler.params.some((param) => param.type === "Identifier" && param.name === binding)) {
      return;
    }
    const dispatches = [];
    let shadowed = false;
    walkOwnArchiveFunction(handler, (inner) => {
      if (
        inner.type === "VariableDeclarator" &&
        inner.id.type === "Identifier" &&
        inner.id.name === binding
      ) shadowed = true;
      if (
        inner.type === "CallExpression" &&
        inner.callee.type === "MemberExpression" &&
        inner.callee.computed &&
        inner.callee.object.type === "Identifier" &&
        inner.callee.object.name === binding &&
        inner.callee.property.type === "Identifier" &&
        inner.callee.property.name === routeKey
      ) dispatches.push(inner);
    });
    if (!shadowed && dispatches.length === 1) consumers.push(node);
  });
  return consumers.length === 1;
}

function inspectArchiveAppMainSource(source) {
  const ast = parseArchiveSource(source, "archive app-main");
  const reachability = createArchiveReachability(ast);
  const properties = { native: [], legacy: [] };
  const tokens = { native: 0, legacy: 0 };
  walkArchiveWithAncestors(ast, (node, ancestors) => {
    const value = archiveLiteral(node);
    if (value === "delete-archived-conversation") tokens.native += 1;
    if (value === "delete-conversation") tokens.legacy += 1;
    if (node.type !== "Property") return;
    const name = archivePropertyName(node);
    if (name === "delete-archived-conversation") properties.native.push({ property: node, ancestors });
    if (name === "delete-conversation") properties.legacy.push({ property: node, ancestors });
  });
  const native = properties.native.filter(({ property, ancestors }) => {
    const callback = callbackForWrappedRoute(property);
    if (!callback || callback.params.length !== 2 || callback.params[0].type !== "Identifier") return false;
    if (!isLiveArchiveRouter(ast, ancestors, reachability)) return false;
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
  const legacy = properties.legacy.filter(({ property, ancestors }) => {
    const callback = callbackForWrappedRoute(property);
    if (!callback || callback.params.length !== 2 || callback.params[0].type !== "Identifier") return false;
    if (!isLiveArchiveRouter(ast, ancestors, reachability)) return false;
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
    if (native.length !== 1 || legacy.length !== 1) {
      throw new Error(
        `combined archive routes expected exactly 1/1 target, found ${native.length}/${legacy.length}`,
      );
    }
    return { mode: "combined", status: "already" };
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

function analyzeArchiveAppMainLayer(source) {
  const inspection = inspectArchiveAppMainSource(source);
  const routeRe = /(["`])archive-conversation\1:(\w+)\(async\((\w+),\{conversationId:(\w+),cleanupWorktree:(\w+),source:(\w+)\}\)=>\{\s*await \3\.archiveConversation\(\4,\{cleanupWorktree:\5,source:\6\}\)\s*\}\)/g;
  const patchableRoutes = [...source.matchAll(routeRe)];
  const ast = parseArchiveSource(source, "archive app-main");
  let archiveConversationEvidence = 0;
  walkArchive(ast, (node) => {
    if (archiveLiteral(node) === "archive-conversation") archiveConversationEvidence += 1;
  });
  if (archiveConversationEvidence !== patchableRoutes.length) {
    throw new Error("archive route evidence is detached or structurally malformed");
  }
  if (patchableRoutes.length > 1) {
    throw new Error(`archive route expected exactly 1 target, found ${patchableRoutes.length}`);
  }
  return {
    state: inspection || patchableRoutes.length === 1 ? "recognized" : "absent",
    inspection,
    patchableRoutes,
  };
}

function patchAppMainSource(source) {
  const inspection = inspectArchiveAppMainSource(source);
  if (inspection && inspection.mode !== "native") {
    return {
      code: source,
      status: inspection.status,
      mode: inspection.mode,
      counts:
        inspection.mode === "combined"
          ? combinedArchiveRouteCount(0, 1)
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
  const expectedMode = inspection?.mode === "native" ? "combined" : "legacy";
  if (patchedInspection?.mode !== expectedMode) {
    throw new Error(`${expectedMode} archive route postcondition was not established`);
  }
  return {
    code,
    status: "patched",
    mode: expectedMode,
    counts:
      expectedMode === "combined"
        ? combinedArchiveRouteCount(1, 0)
        : archiveCount(1, 0, 0, "archive route"),
  };
}

function archiveObjectProperty(object, name) {
  if (object?.type !== "ObjectExpression") return null;
  return object.properties.find(
    (property) => property.type === "Property" && archivePropertyName(property) === name,
  );
}

function archiveStaticBoolean(node) {
  if (node?.type === "Literal" && typeof node.value === "boolean") return node.value;
  if (
    node?.type === "UnaryExpression" &&
    node.operator === "!" &&
    node.argument?.type === "Literal"
  ) return !node.argument.value;
  return null;
}

function walkExecutableArchiveFunction(root, visitor) {
  function visit(node, owner, parent, ancestors) {
    if (!node || typeof node !== "object") return;
    let activeOwner = owner;
    if (node !== root && isArchiveFunction(node)) {
      const isMappedCallback =
        parent?.type === "CallExpression" &&
        parent.arguments.includes(node) &&
        parent.callee.type === "MemberExpression" &&
        (parent.callee.property?.name ?? archiveLiteral(parent.callee.property)) === "map";
      if (!isMappedCallback) return;
      activeOwner = node;
    }
    if (node.type) visitor(node, activeOwner, ancestors);
    const nextAncestors = node.type ? [...ancestors, node] : ancestors;
    if (node.type === "IfStatement") {
      const value = archiveStaticBoolean(node.test);
      visit(node.test, activeOwner, node, nextAncestors);
      if (value !== false) visit(node.consequent, activeOwner, node, nextAncestors);
      if (value !== true) visit(node.alternate, activeOwner, node, nextAncestors);
      return;
    }
    if (node.type === "ConditionalExpression") {
      const value = archiveStaticBoolean(node.test);
      visit(node.test, activeOwner, node, nextAncestors);
      if (value !== false) visit(node.consequent, activeOwner, node, nextAncestors);
      if (value !== true) visit(node.alternate, activeOwner, node, nextAncestors);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item, activeOwner, node, nextAncestors);
      } else {
        visit(child, activeOwner, node, nextAncestors);
      }
    }
  }
  visit(root, root, null, []);
}

function archiveFunctionParameterNames(fn) {
  return new Set(
    fn.params.filter((param) => param.type === "Identifier").map((param) => param.name),
  );
}

function archiveExpressionReferencesParameter(expression, fn) {
  const parameters = archiveFunctionParameterNames(fn);
  let found = false;
  walkArchive(expression, (node) => {
    if (node.type === "Identifier" && parameters.has(node.name)) found = true;
  });
  return found;
}

function collectExecutableArchiveEvidence(fn) {
  const calls = [];
  const confirmMembers = [];
  const returns = [];
  walkExecutableArchiveFunction(fn, (node, owner) => {
    if (node.type === "CallExpression") calls.push({ call: node, owner });
    if (
      node.type === "MemberExpression" &&
      (node.property?.name ?? archiveLiteral(node.property)) === "codexConfirmDelete"
    ) confirmMembers.push(node);
    if (node.type === "ReturnStatement") returns.push(node);
  });
  return { calls, confirmMembers, returns };
}

function nativeArchiveRouteDetail(entry) {
  const { call, owner } = entry;
  if (
    call.callee.type !== "Identifier" ||
    archiveLiteral(call.arguments[0]) !== "delete-archived-conversation" ||
    call.arguments[1]?.type !== "ObjectExpression"
  ) return null;
  const conversationId = archiveObjectProperty(call.arguments[1], "conversationId")?.value;
  if (!conversationId || !archiveExpressionReferencesParameter(conversationId, owner)) return null;
  return { ...entry, callee: call.callee.name, conversationId };
}

function nativeArchiveThreadDetail(entry) {
  const { call, owner } = entry;
  if (!call.arguments.some((argument) => archiveLiteral(argument) === "thread/delete")) {
    return null;
  }
  if (!call.arguments.some((argument) => archiveExpressionReferencesParameter(argument, owner))) {
    return null;
  }
  return entry;
}

function isDirectNativeArchiveFunction(fn) {
  const evidence = collectExecutableArchiveEvidence(fn);
  const routes = evidence.calls.map(nativeArchiveRouteDetail).filter(Boolean);
  const threadDeletes = evidence.calls.map(nativeArchiveThreadDetail).filter(Boolean);
  if (routes.length !== 2 || threadDeletes.length !== 1) return false;
  const callee = routes[0].callee;
  const parameters = archiveFunctionParameterNames(fn);
  if (!parameters.has(callee) || routes.some((route) => route.callee !== callee)) return false;
  if (
    routes.some((route) => route.conversationId.type !== "Identifier") ||
    new Set(routes.map((route) => route.conversationId.name)).size !== 1
  ) return false;
  const threadDelete = threadDeletes[0].call;
  if (
    !threadDelete.arguments.some(
      (argument) => argument.type === "Identifier" && argument.name === callee,
    )
  ) return false;
  return evidence.returns.some(
    (statement) =>
      statement.argument &&
      statement.argument.start <= threadDelete.start &&
      statement.argument.end >= threadDelete.end,
  );
}

function collectArchiveFunctionBindings(fn) {
  const bindings = new Map();
  const add = (name, value) => {
    if (!isArchiveFunction(value)) return;
    const values = bindings.get(name) ?? [];
    values.push(value);
    bindings.set(name, values);
  };
  walkExecutableArchiveFunction(fn, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      add(node.id.name, node.init);
    }
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "Identifier"
    ) add(node.left.name, node.right);
  });
  return bindings;
}

function isLiveNativeArchiveMutation(fn) {
  const functionBindings = collectArchiveFunctionBindings(fn);
  const options = [];
  const calls = [];
  walkExecutableArchiveFunction(fn, (node, _owner, ancestors) => {
    if (node.type === "CallExpression") calls.push(node);
    if (node.type !== "ObjectExpression") return;
    const mutationFn = archiveObjectProperty(node, "mutationFn")?.value;
    const onError = archiveObjectProperty(node, "onError")?.value;
    if (mutationFn?.type !== "Identifier" || onError?.type !== "Identifier") return;
    const mutationFunctions = functionBindings.get(mutationFn.name) ?? [];
    const errorFunctions = functionBindings.get(onError.name) ?? [];
    const binding = assignedArchiveIdentifier(node, ancestors);
    if (binding && mutationFunctions.length === 1 && errorFunctions.length === 1) {
      options.push({
        binding,
        mutationFunction: mutationFunctions[0],
        errorFunction: errorFunctions[0],
      });
    }
  });
  const liveOptions = options.filter(({ binding, mutationFunction, errorFunction }) => {
    const consumed = calls.filter((call) =>
      call.arguments.some(
        (argument) => argument.type === "Identifier" && argument.name === binding,
      ),
    );
    if (consumed.length !== 1) return false;
    const mutationEvidence = collectExecutableArchiveEvidence(mutationFunction);
    const routes = mutationEvidence.calls.map(nativeArchiveRouteDetail).filter(Boolean);
    if (
      routes.length !== 2 ||
      routes.some((route) => route.callee !== routes[0].callee)
    ) return false;
    const errorEvidence = collectExecutableArchiveEvidence(errorFunction);
    const threadDeletes = errorEvidence.calls.map(nativeArchiveThreadDetail).filter(Boolean);
    return threadDeletes.length === 1;
  });
  return liveOptions.length === 1;
}

function inspectArchiveDataControlsSource(source) {
  const ast = parseArchiveSource(source, "archive data-controls");
  const reachability = createArchiveReachability(ast);
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
  walkArchiveWithAncestors(ast, (node, ancestors) => {
    if (!isArchiveFunction(node)) return;
    if (!reachability.isReachable(node)) return;
    const functionSource = source.slice(node.start, node.end);
    const hasNativeContext =
      functionSource.includes("delete-archived-conversation") ||
      functionSource.includes("thread/delete");
    if (
      hasNativeContext &&
      (isDirectNativeArchiveFunction(node) || isLiveNativeArchiveMutation(node))
    ) {
      nativeFunctions.push(node);
    }
    if (!functionSource.includes("delete-conversation")) return;
    const evidence = collectExecutableArchiveEvidence(node);
    const legacyCalls = [];
    for (const { call } of evidence.calls) {
      if (
        archiveLiteral(call.arguments[0]) === "delete-conversation" &&
        call.arguments[1]?.type === "ObjectExpression" &&
        ["conversationId", "hostId"].every((name) =>
          call.arguments[1].properties.some((item) => archivePropertyName(item) === name),
        )
      ) legacyCalls.push(call);
    }
    if (legacyCalls.length === 1 && evidence.confirmMembers.length > 0) {
      legacyFunctions.push(node);
    }
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
  const compatible =
    (appMain.mode === "combined" && dataControls.mode === "native") ||
    (appMain.mode === "legacy" && dataControls.mode === "legacy");
  if (!compatible) {
    throw new Error(
      `archive route/UI mode mismatch: app-main=${appMain.mode}, data-controls=${dataControls.mode}`,
    );
  }
  const status = appMain.status === "already" ? "already" : "patched";
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

function normalizeArchiveCandidate(candidate) {
  return {
    path: candidate.filePath ?? candidate.path ?? candidate.fileName,
    fileName:
      candidate.fileName ?? path.basename(candidate.filePath ?? candidate.path ?? ""),
    source: candidate.source,
  };
}

function isArchiveWebviewAsset(candidate) {
  const normalizedPath = candidate.path.replaceAll("\\", "/");
  const inAssets =
    normalizedPath.startsWith("webview/assets/") ||
    normalizedPath.includes("/webview/assets/");
  return inAssets && candidate.fileName.endsWith(".js");
}

function archiveRouteOwnershipEvidence(source) {
  let ast;
  try {
    ast = parseArchiveSource(source, "archive route ownership");
  } catch {
    return [];
  }
  const reachability = createArchiveReachability(ast);
  const liveRouteNames = new Set();
  walkArchiveWithAncestors(ast, (node, ancestors) => {
    if (node.type !== "Property") return;
    const name = archivePropertyName(node);
    if (
      ![
        "archive-conversation",
        "delete-archived-conversation",
        "delete-conversation",
      ].includes(name)
    ) {
      return;
    }
    if (isLiveArchiveRouter(ast, ancestors, reachability)) {
      liveRouteNames.add(name);
    }
  });
  const evidence = [];
  if (liveRouteNames.has("archive-conversation")) {
    evidence.push("archive-conversation property reaches live router consumer");
  }
  if (liveRouteNames.has("delete-archived-conversation")) {
    evidence.push("native archive route property reaches live router consumer");
  }
  if (liveRouteNames.has("delete-conversation")) {
    evidence.push("legacy archive route property reaches live router consumer");
  }
  return evidence;
}

function probeArchiveRoute(candidate) {
  const evidence = archiveRouteOwnershipEvidence(candidate.source);
  if (evidence.length === 0) return { state: "irrelevant", evidence: [] };
  try {
    analyzeArchiveAppMainLayer(candidate.source);
    return {
      state: "exact",
      evidence: [...evidence, "strict archive route helper satisfied"],
      result: patchAppMainSource(candidate.source),
    };
  } catch (error) {
    return { state: "owned-malformed", evidence, error };
  }
}

function archiveDataControlsOwnershipEvidence(source) {
  let ast;
  try {
    ast = parseArchiveSource(source, "archive data-controls ownership");
  } catch {
    return [];
  }
  const reachability = createArchiveReachability(ast);
  let nativeBehaviorFamily = false;
  let legacyBehaviorFamily = false;
  walkArchive(ast, (node) => {
    if (!isArchiveFunction(node)) return;
    if (!reachability.isReachable(node)) return;
    if (isDirectNativeArchiveFunction(node) || isLiveNativeArchiveMutation(node)) {
      nativeBehaviorFamily = true;
    }
    const functionSource = source.slice(node.start, node.end);
    if (
      functionSource.includes("delete-conversation") &&
      functionSource.includes("codexConfirmDelete")
    ) {
      legacyBehaviorFamily = true;
    }
  });
  const evidence = [];
  if (nativeBehaviorFamily) {
    evidence.push("exported live native archive data-controls behavior family");
  }
  if (legacyBehaviorFamily) {
    evidence.push("exported live legacy archive data-controls behavior family");
  }
  return evidence;
}

function probeArchiveDataControls(candidate) {
  const evidence = archiveDataControlsOwnershipEvidence(candidate.source);
  try {
    const inspection = inspectArchiveDataControlsSource(candidate.source);
    if (!inspection) return { state: "irrelevant", evidence: [] };
    return {
      state: "exact",
      evidence: [
        ...evidence,
        `recognized ${inspection.mode} archive data-controls mode`,
        "strict archive data-controls helper satisfied",
      ],
      result: patchDataControlsSource(candidate.source),
    };
  } catch (error) {
    return evidence.length > 0
      ? { state: "owned-malformed", evidence, error }
      : { state: "irrelevant", evidence: [] };
  }
}

function buildArchivePlan({ platform, route, dataControls, result }) {
  return planRequiredRoles({
    platform,
    roles: [
      {
        role: "archive-route",
        candidates: [normalizeArchiveCandidate(route)],
        probe: () => ({
          state: "exact",
          evidence: ["Windows exact filename and strict archive route helper"],
          result: result.appMain,
        }),
      },
      {
        role: "archive-data-controls",
        candidates: [normalizeArchiveCandidate(dataControls)],
        probe: () => ({
          state: "exact",
          evidence: ["Windows exact filename and strict archive data-controls helper"],
          result: result.dataControls,
        }),
      },
    ],
  });
}

function archiveMatchFromRole(selected) {
  return {
    fileName: selected.candidate.fileName,
    filePath: selected.candidate.path,
    path: selected.candidate.path,
    source: selected.candidate.source,
  };
}

function previewArchivePlan(plan) {
  const route = plan.roles.find((selected) => selected.role === "archive-route");
  const dataControls = plan.roles.find(
    (selected) => selected.role === "archive-data-controls",
  );
  const appMain = archiveMatchFromRole(route);
  const controls = archiveMatchFromRole(dataControls);
  return {
    appMain,
    dataControls: controls,
    matches: { route: [appMain], dataControls: [controls] },
    result: patchArchiveContracts({
      appMainSource: appMain.source,
      dataControlsSource: controls.source,
    }),
  };
}

function planMacArchivePlatform({ platform, candidates }) {
  const scoped = candidates
    .map(normalizeArchiveCandidate)
    .filter(isArchiveWebviewAsset);
  const plan = planRequiredRoles({
    platform,
    roles: [
      { role: "archive-route", candidates: scoped, probe: probeArchiveRoute },
      {
        role: "archive-data-controls",
        candidates: scoped,
        probe: probeArchiveDataControls,
      },
    ],
  });
  return { status: "ready", plan, writes: [previewArchivePlan(plan)] };
}

function planArchivePlatform({
  platform,
  appMainTargets,
  dataControlsTargets,
  candidates,
}) {
  if (platform !== "win") {
    return planMacArchivePlatform({ platform, candidates: candidates ?? [] });
  }
  if (appMainTargets.length !== 1) {
    throw new Error(
      `archive app-main expected exactly 1 bundle for ${platform}, found ${appMainTargets.length}`,
    );
  }
  if (dataControlsTargets.length !== 1) {
    throw new Error(
      `archive data-controls expected exactly 1 bundle for ${platform}, found ${dataControlsTargets.length}`,
    );
  }
  const appMain = appMainTargets[0];
  const dataControls = dataControlsTargets[0];
  const result = patchArchiveContracts({
    appMainSource: appMain.source,
    dataControlsSource: dataControls.source,
  });
  const plan = buildArchivePlan({
    platform,
    route: appMain,
    dataControls,
    result,
  });
  return {
    status: "ready",
    plan,
    writes: [{ appMain, dataControls, result }],
  };
}

function selectedArchiveWrite(selected) {
  return {
    role: selected.role,
    path: selected.candidate.path,
    fileName: selected.candidate.fileName,
    source: selected.candidate.source,
    result: selected.result,
  };
}

function commitArchivePlatforms({
  platformPlans,
  isCheck = false,
  writeFile = fs.writeFileSync,
}) {
  return platformPlans.flatMap(({ plan }) =>
    commitValidatedPlan({
      plan,
      writer: (selected) => {
        const write = selectedArchiveWrite(selected);
        if (!isCheck && write.result.code !== write.source) {
          writeFile(write.path, write.result.code, "utf-8");
        }
        return write;
      },
    }),
  );
}

function executeArchivePlatforms({
  platformInputs,
  isCheck = false,
  writeFile = fs.writeFileSync,
}) {
  const platformPlans = platformInputs.map((input) => ({
    platform: input.platform,
    ...planArchivePlatform(input),
  }));
  const writes = commitArchivePlatforms({ platformPlans, isCheck, writeFile });
  return { platformPlans, writes };
}

function formatArchiveSummary(outcomes) {
  const ready = outcomes.filter((outcome) => outcome.status === "ready").map((outcome) => outcome.platform);
  const skipped = outcomes.filter((outcome) => outcome.status === "skipped").map((outcome) => outcome.platform);
  return `[summary] archive-delete: ready=[${ready.join(",")}] skipped=[${skipped.join(",")}]`;
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
  const platformInputs = platforms.map((platformName) => {
    if (platformName === "win") {
      const appMainPath = findExactAsset(platformName, /^app-main-.*\.js$/, "archive app-main");
      const dataControlsPath = findExactAsset(
        platformName,
        /^data-controls-.*\.js$/,
        "archive data-controls",
      );
      return {
        platform: platformName,
        appMainTargets: [{
          fileName: path.basename(appMainPath),
          path: appMainPath,
          source: fs.readFileSync(appMainPath, "utf-8"),
        }],
        dataControlsTargets: [{
          fileName: path.basename(dataControlsPath),
          path: dataControlsPath,
          source: fs.readFileSync(dataControlsPath, "utf-8"),
        }],
      };
    }
    const directory = path.join(SRC_DIR, platformName, "_asar", "webview", "assets");
    if (!fs.existsSync(directory)) {
      throw new Error(`archive asset directory is missing for ${platformName}`);
    }
    return {
      platform: platformName,
      candidates: fs.readdirSync(directory)
        .filter((fileName) => fileName.endsWith(".js"))
        .map((fileName) => {
          const filePath = path.join(directory, fileName);
          return { fileName, filePath, source: fs.readFileSync(filePath, "utf-8") };
        }),
    };
  });
  const execution = executeArchivePlatforms({ platformInputs, isCheck });
  const outcomes = execution.platformPlans.map(({ platform: name, status }) => ({
    platform: name,
    status,
  }));
  for (const platformPlan of execution.platformPlans) {
    const preview = platformPlan.writes[0];
    console.log(
      `  [${platformPlan.platform}] ${isCheck ? "check" : preview.result.status}: ${JSON.stringify(preview.result.counts)}`,
    );
  }
  console.log(formatArchiveSummary(outcomes));
}

if (require.main === module) main();

module.exports = {
  inspectArchiveAppMainSource,
  inspectArchiveDataControlsSource,
  patchAppMainSource,
  patchDataControlsSource,
  patchArchiveContracts,
  planArchivePlatform,
  executeArchivePlatforms,
  formatArchiveSummary,
};

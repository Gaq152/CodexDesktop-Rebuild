#!/usr/bin/env node
/**
 * Post-build patch: Force-enable Fast mode (speed selector)
 *
 * The speed selector and request-time service_tier plumbing are gated by
 * authMethod === "chatgpt" checks. API-key users never see/use it because
 * their auth method differs.
 *
 * This patch handles the old negative gate:
 *   X.authMethod !== "chatgpt"
 * inside functions that also reference "fast_mode", and replaces
 * the comparison with !1 (always false).
 *
 * It also handles the newer positive gate:
 *   X.authMethod === "chatgpt"
 *   authMethod === "chatgpt"
 * inside fast_mode functions, and expands it to also allow "apikey".
 *
 * Target: chunks containing "fast_mode" + "chatgpt".
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { relPath, SRC_DIR } = require("./patch-util");

const CHATGPT_AUTH = "chatgpt";
const APIKEY_AUTH = "apikey";
const ALWAYS_FALSE = "!1";

function walk(node, visitor, parent = null) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type)
          walk(item, visitor, node);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor, node);
    }
  }
}

function sourceFor(source, node) {
  return source.slice(node.start, node.end);
}

function isFunctionNode(node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function isStringLiteral(node, value) {
  return (
    (node.type === "Literal" && node.value === value) ||
    (node.type === "TemplateLiteral" &&
      node.expressions.length === 0 &&
      node.quasis.length === 1 &&
      node.quasis[0].value.cooked === value)
  );
}

function expressionSourceForChatGptSide(binary, source) {
  if (isStringLiteral(binary.right, CHATGPT_AUTH))
    return sourceFor(source, binary.left);
  if (isStringLiteral(binary.left, CHATGPT_AUTH))
    return sourceFor(source, binary.right);
  return null;
}

function hasApiKeyAlternative(node, source, operand) {
  let found = false;

  walk(node, (child) => {
    if (found || child.type !== "BinaryExpression" || child.operator !== "===")
      return;

    const left = sourceFor(source, child.left);
    const right = sourceFor(source, child.right);
    found =
      (left === operand && isStringLiteral(child.right, APIKEY_AUTH)) ||
      (right === operand && isStringLiteral(child.left, APIKEY_AUTH));
  });

  return found;
}

function isAlreadyExpandedToApiKey(parent, source, operand) {
  return (
    parent?.type === "LogicalExpression" &&
    parent.operator === "||" &&
    hasApiKeyAlternative(parent, source, operand)
  );
}

function addPatch(patches, patch) {
  if (patches.some((p) => p.start === patch.start)) return;
  patches.push(patch);
}

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // Match function bodies containing Fast mode auth logic.
    if (!isFunctionNode(node)) return;

    const fnSrc = sourceFor(source, node);
    if (!fnSrc.includes("fast_mode") || !fnSrc.includes(CHATGPT_AUTH)) return;

    walk(node, (child, parent) => {
      if (child.type !== "BinaryExpression") return;

      const childSrc = sourceFor(source, child);

      // Old shape: X.authMethod !== "chatgpt" gates the selector.
      if (child.operator === "!==") {
        if (!childSrc.includes("authMethod") || !childSrc.includes(CHATGPT_AUTH))
          return;
        if (childSrc === ALWAYS_FALSE) return;

        addPatch(patches, {
          id: "fast_mode_legacy_auth_gate",
          start: child.start,
          end: child.end,
          replacement: ALWAYS_FALSE,
          original: childSrc,
        });
        return;
      }

      // New shape: authMethod === "chatgpt" or authKind === "chatgpt".
      // Expand it to allow API-key auth as well.
      if (child.operator === "===") {
        const operand = expressionSourceForChatGptSide(child, source);
        if (operand == null) return;
        if (isAlreadyExpandedToApiKey(parent, source, operand)) return;

        addPatch(patches, {
          id: "fast_mode_api_key_auth_gate",
          start: child.start,
          end: child.end,
          replacement: `(${childSrc}||${operand}===\`${APIKEY_AUTH}\`)`,
          original: childSrc,
        });
      }
    });
  });

  return patches;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

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
      if (src.includes("chatgpt") && src.includes("fast_mode")) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }

  if (targets.length === 0) {
    console.log("  [skip] No chunk contains fast_mode gate logic");
    return;
  }

  let totalPatched = 0;
  let totalFound = 0;

  for (const bundle of targets) {
    const source = fs.readFileSync(bundle.path, "utf-8");

    const t0 = Date.now();
    let ast;
    try {
      ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    } catch {
      continue;
    }

    const patches = collectPatches(ast, source);

    if (patches.length === 0) continue;
    totalFound += patches.length;

    console.log(
      `  [${bundle.platform}] ${relPath(bundle.path)} (parse ${Date.now() - t0}ms)`,
    );

    if (isCheck) {
      for (const p of patches) {
        console.log(`    [?] offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`    * ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    totalPatched += patches.length;
  }

  if (totalPatched > 0) {
    console.log(`  [ok] ${totalPatched} auth gate(s) patched`);
  } else if (isCheck && totalFound > 0) {
    console.log(`  [check] ${totalFound} auth gate(s) would be patched`);
  } else {
    console.log("  [ok] fast_mode auth gates already patched or absent");
  }
}

if (require.main === module) {
  main();
}

module.exports = { collectPatches };

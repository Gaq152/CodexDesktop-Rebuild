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
const REQUEST_AUTH_MARKER = "/* CodexRebuildFastModeRequestAuth */";
const FAST_MODE_CONTRACT_IDS = [
  "fast_mode_settings_auth_gate",
  "fast_mode_request_auth_gate",
];
const FAST_MODE_FILE_PATTERNS = new Map([
  ["fast_mode_settings_auth_gate", /^use-service-tier-settings-.*\.js$/],
  ["fast_mode_request_auth_gate", /^read-service-tier-for-request-.*\.js$/],
]);

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

function hasApiKeyRejection(node, source, operand) {
  if (node?.type !== "LogicalExpression" || node.operator !== "&&") return false;
  let found = false;
  walk(node, (child) => {
    if (found || child.type !== "BinaryExpression" || child.operator !== "!==") {
      return;
    }
    const left = sourceFor(source, child.left);
    const right = sourceFor(source, child.right);
    found =
      (left === operand && isStringLiteral(child.right, APIKEY_AUTH)) ||
      (right === operand && isStringLiteral(child.left, APIKEY_AUTH));
  });
  return found;
}

function isPatchedRequestAuthGate(node, source) {
  if (node?.type !== "LogicalExpression" || node.operator !== "&&") return false;
  let chatGptOperand = null;
  walk(node, (child) => {
    if (
      chatGptOperand == null &&
      child.type === "BinaryExpression" &&
      child.operator === "!=="
    ) {
      chatGptOperand = expressionSourceForChatGptSide(child, source);
    }
  });
  return (
    chatGptOperand != null && hasApiKeyRejection(node, source, chatGptOperand)
  );
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
        if (isPatchedRequestAuthGate(parent, source)) return;
        const operand = expressionSourceForChatGptSide(child, source);
        if (operand == null) return;

        addPatch(patches, {
          id: "fast_mode_request_auth_gate",
          start: child.start,
          end: child.end,
          replacement:
            `(${childSrc}&&${operand}!==\`${APIKEY_AUTH}\`)${REQUEST_AUTH_MARKER}`,
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
          id: "fast_mode_settings_auth_gate",
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

function collectAlreadyPatchedGates(ast, source) {
  const already = [];
  walk(ast, (node) => {
    if (!isFunctionNode(node)) return;
    const fnSrc = sourceFor(source, node);
    if (!fnSrc.includes("fast_mode")) return;
    walk(node, (child, parent) => {
      if (child.type === "BinaryExpression" && child.operator === "===") {
        const operand = expressionSourceForChatGptSide(child, source);
        if (operand == null || !isAlreadyExpandedToApiKey(parent, source, operand)) return;
        addPatch(already, {
          id: "fast_mode_settings_auth_gate",
          start: child.start,
        });
        return;
      }
      if (
        child.type === "IfStatement" &&
        isPatchedRequestAuthGate(child.test, source) &&
        source.slice(child.test.end, child.consequent.start).includes(REQUEST_AUTH_MARKER)
      ) {
        addPatch(already, {
          id: "fast_mode_request_auth_gate",
          start: child.test.start,
        });
      }
    });
  });
  return already;
}

function analyzeFastModeSource(source) {
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    throw new Error(`fast_mode parse failed: ${error.message}`);
  }
  const patches = collectPatches(ast, source);
  const already = collectAlreadyPatchedGates(ast, source);
  const total = patches.length + already.length;

  let code = source;
  for (const patch of [...patches].sort((left, right) => right.start - left.start)) {
    code = code.slice(0, patch.start) + patch.replacement + code.slice(patch.end);
  }
  return {
    code,
    status: patches.length === 1 ? "patched" : "already",
    counts: { patchable: patches.length, already: already.length, total },
    patches,
    targetIds: [...new Set([...patches, ...already].map((target) => target.id))],
  };
}

function patchFastModeSource(source) {
  const result = analyzeFastModeSource(source);
  if (result.counts.total !== 1) {
    throw new Error(
      `fast_mode auth gate expected exactly 1 target, found ${result.counts.total}`,
    );
  }
  return result;
}

function planFastModeTargets(candidates, platform = "platform") {
  const matches = new Map(FAST_MODE_CONTRACT_IDS.map((id) => [id, []]));
  for (const candidate of candidates) {
    const result = analyzeFastModeSource(candidate.source);
    if (result.counts.total > 1) {
      throw new Error(
        `fast_mode candidate ${candidate.fileName ?? candidate.path ?? "<unknown>"} ` +
          `expected at most 1 auth gate, found ${result.counts.total}`,
      );
    }
    if (result.counts.total === 0) continue;
    const [targetId] = result.targetIds;
    if (!matches.has(targetId)) {
      throw new Error(
        `fast_mode candidate ${candidate.fileName ?? candidate.path ?? "<unknown>"} ` +
          `matched unexpected contract ${targetId}`,
      );
    }
    const fileName = candidate.fileName ?? path.basename(candidate.path ?? "");
    if (!FAST_MODE_FILE_PATTERNS.get(targetId).test(fileName)) continue;
    matches.get(targetId).push({ ...candidate, result });
  }
  for (const targetId of FAST_MODE_CONTRACT_IDS) {
    const contractMatches = matches.get(targetId);
    if (contractMatches.length !== 1) {
      throw new Error(
        `fast_mode ${targetId} expected exactly 1 target bundle for ${platform}, ` +
          `found ${contractMatches.length}`,
      );
    }
  }
  return FAST_MODE_CONTRACT_IDS.map((targetId) => matches.get(targetId)[0]);
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

  const candidates = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (![...FAST_MODE_FILE_PATTERNS.values()].some((pattern) => pattern.test(f))) {
        continue;
      }
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (src.includes("fast_mode")) {
        candidates.push({ platform: plat, path: fp, fileName: f, source: src });
      }
    }
  }

  const plans = platforms.flatMap((platformName) => {
    const platformCandidates = candidates.filter(
      (candidate) => candidate.platform === platformName,
    );
    const t0 = Date.now();
    const platformPlans = planFastModeTargets(platformCandidates, platformName);
    for (const plan of platformPlans) {
      console.log(
        `  [${platformName}] ${relPath(plan.path)} (parse ${Date.now() - t0}ms)`,
      );
      console.log(
        `    [${isCheck ? "check" : plan.result.status}] patchable=${plan.result.counts.patchable} already=${plan.result.counts.already} expected=1`,
      );
      for (const patch of plan.result.patches) {
        console.log(`    ${isCheck ? "?" : "*"} ${patch.original} -> ${patch.replacement}`);
      }
    }
    return platformPlans;
  });
  if (!isCheck) {
    for (const plan of plans) {
      if (plan.result.code !== plan.source) {
        fs.writeFileSync(plan.path, plan.result.code, "utf-8");
      }
    }
  }
  const patched = plans.reduce((sum, plan) => sum + plan.result.counts.patchable, 0);
  const already = plans.reduce((sum, plan) => sum + plan.result.counts.already, 0);
  console.log(`  [ok] fast_mode patchable=${patched} already=${already} expected=${plans.length}`);
}

if (require.main === module) {
  main();
}

module.exports = { collectPatches, patchFastModeSource, planFastModeTargets };

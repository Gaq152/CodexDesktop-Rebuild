#!/usr/bin/env node
/**
 * Post-build patch: expose Fast mode according to the selected model.
 *
 * API-key auth is accepted alongside ChatGPT auth, while the remote
 * featureRequirements.fast_mode flag (derived from requires_openai_auth) is
 * removed as an authorization gate. The existing built-in model/service-tier
 * options remain responsible for whether Fast is shown for a selected model.
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { relPath, SRC_DIR } = require("./patch-util");
const {
  planRequiredRoles,
  commitValidatedPlan,
} = require("./mac-contract-locator");

const CHATGPT_AUTH = "chatgpt";
const APIKEY_AUTH = "apikey";
const REQUEST_AUTH_MARKER = "/* CodexRebuildFastModeRequestAuth */";
const MODEL_CAPABILITY_MARKER = "/* CodexRebuildFastModeModelCapabilityOnly */";
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

function flattenLogical(node, operator, terms = []) {
  if (node?.type === "LogicalExpression" && node.operator === operator) {
    flattenLogical(node.left, operator, terms);
    flattenLogical(node.right, operator, terms);
  } else {
    terms.push(node);
  }
  return terms;
}

function authComparisonOperand(node, source, operator, value) {
  if (node?.type !== "BinaryExpression" || node.operator !== operator) return null;
  if (isStringLiteral(node.right, value)) return sourceFor(source, node.left);
  if (isStringLiteral(node.left, value)) return sourceFor(source, node.right);
  return null;
}

function exactAuthPair(node, source, logicalOperator, comparisonOperator) {
  if (node?.type !== "LogicalExpression" || node.operator !== logicalOperator) return null;
  const terms = flattenLogical(node, logicalOperator);
  if (terms.length !== 2) return null;
  const chat = terms
    .map((term) => authComparisonOperand(term, source, comparisonOperator, CHATGPT_AUTH))
    .find(Boolean);
  const apiKey = terms
    .map((term) => authComparisonOperand(term, source, comparisonOperator, APIKEY_AUTH))
    .find(Boolean);
  return chat != null && chat === apiKey ? chat : null;
}

function isRejectingConsequent(node) {
  const statement =
    node?.type === "BlockStatement" && node.body.length === 1 ? node.body[0] : node;
  return (
    statement?.type === "ReturnStatement" &&
    statement.argument?.type === "UnaryExpression" &&
    statement.argument.operator === "!" &&
    statement.argument.argument?.type === "Literal" &&
    statement.argument.argument.value === 1
  );
}

function exactRequestMarkerAfter(node, source, comments) {
  return comments.filter(
    (comment) =>
      comment.type === "Block" &&
      (comment.start === node.end ||
        (comment.start === node.end + 1 && source[node.end] === ")")) &&
      comment.value.trim() === "CodexRebuildFastModeRequestAuth",
  ).length === 1;
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
    const patchStartIndex = patches.length;

    let roleId = null;
    walk(node, (child, parent) => {
      if (child.type !== "BinaryExpression") return;

      const childSrc = sourceFor(source, child);

      // Old shape: X.authMethod !== "chatgpt" gates the selector.
      if (child.operator === "!==") {
        if (isPatchedRequestAuthGate(parent, source)) return;
        const operand = expressionSourceForChatGptSide(child, source);
        if (operand == null) return;
        roleId = "fast_mode_request_auth_gate";

        addPatch(patches, {
          id: roleId,
          targetStart: node.start,
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
        roleId = "fast_mode_settings_auth_gate";
        if (isAlreadyExpandedToApiKey(parent, source, operand)) return;

        addPatch(patches, {
          id: roleId,
          targetStart: node.start,
          start: child.start,
          end: child.end,
          replacement: `(${childSrc}||${operand}===\`${APIKEY_AUTH}\`)`,
          original: childSrc,
        });
      }
    });

    if (roleId == null) {
      // A first-generation patch may already have expanded the auth pair while
      // leaving the remote featureRequirements.fast_mode gate intact.
      walkFunctionContract(node, (child) => {
        if (
          child.type === "LogicalExpression" &&
          exactAuthPair(child, source, "||", "===") != null
        ) roleId = "fast_mode_settings_auth_gate";
        if (
          child.type === "IfStatement" &&
          exactAuthPair(child.test, source, "&&", "!==") != null &&
          isRejectingConsequent(child.consequent)
        ) roleId = "fast_mode_request_auth_gate";
      });
    }
    if (roleId == null) return;

    const authPatches = patches
      .slice(patchStartIndex)
      .filter((patch) => patch.id === roleId);
    if (authPatches.length > 1) {
      throw new Error(
        `fast_mode ${roleId} auth gate expected exactly 1 target, found ${authPatches.length}`,
      );
    }

    const featureGates = [];
    walkFunctionContract(node, (child) => {
      if (child.type !== "BinaryExpression" || !sourceFor(source, child).includes("fast_mode")) return;
      let hasFeatureAccess = false;
      walk(child, (nested) => {
        if (isFastModeFeatureAccess(nested)) hasFeatureAccess = true;
      });
      if (hasFeatureAccess) featureGates.push(child);
    });
    if (featureGates.length === 0) {
      patches.splice(patchStartIndex);
      return;
    }
    if (featureGates.length !== 1) {
      throw new Error(
        `fast_mode ${roleId} capability gate expected exactly 1 target, found ${featureGates.length}`,
      );
    }
    const featureGate = featureGates[0];
    addPatch(patches, {
      id: roleId,
      targetStart: node.start,
      start: featureGate.start,
      end: featureGate.end,
      replacement: `!0${MODEL_CAPABILITY_MARKER}`,
      original: sourceFor(source, featureGate),
    });
  });

  return patches;
}

function collectAlreadyPatchedGates(ast, source, comments) {
  const already = [];
  walk(ast, (node, parent) => {
    if (!isFunctionNode(node)) return;
    const fnSrc = sourceFor(source, node);
    if (!fnSrc.includes("CodexRebuildFastModeModelCapabilityOnly")) return;
    const capabilityComments = comments.filter(
      (comment) =>
        comment.start >= node.start &&
        comment.end <= node.end &&
        comment.type === "Block" &&
        comment.value.trim() === "CodexRebuildFastModeModelCapabilityOnly",
    );
    let hasFeatureAccess = false;
    walkFunctionContract(node, (child) => {
      if (isFastModeFeatureAccess(child)) hasFeatureAccess = true;
    });
    if (capabilityComments.length !== 1 || hasFeatureAccess) return;
    walk(node, (child, childParent) => {
      if (
        child.type === "LogicalExpression" &&
        child.operator === "||" &&
        !(childParent?.type === "LogicalExpression" && childParent.operator === "||")
      ) {
        if (exactAuthPair(child, source, "||", "===") == null) return;
        addPatch(already, {
          id: "fast_mode_settings_auth_gate",
          targetStart: node.start,
          start: child.start,
        });
        return;
      }
      if (
        child.type === "IfStatement" &&
        exactAuthPair(child.test, source, "&&", "!==") != null &&
        exactRequestMarkerAfter(child.test, source, comments) &&
        isRejectingConsequent(child.consequent)
      ) {
        addPatch(already, {
          id: "fast_mode_request_auth_gate",
          targetStart: node.start,
          start: child.test.start,
        });
      }
    });
  });
  return already;
}

function analyzeFastModeSource(source) {
  let ast;
  const comments = [];
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      onComment: comments,
    });
  } catch (error) {
    throw new Error(`fast_mode parse failed: ${error.message}`);
  }
  const patches = collectPatches(ast, source);
  const already = collectAlreadyPatchedGates(ast, source, comments);
  const requestComments = comments.filter((comment) =>
    comment.value.includes("CodexRebuildFastModeRequestAuth"),
  );
  const exactRequestComments = requestComments.filter(
    (comment) =>
      comment.type === "Block" &&
      comment.value.trim() === "CodexRebuildFastModeRequestAuth",
  );
  if (
    requestComments.length !== exactRequestComments.length ||
    exactRequestComments.length > 1
  ) {
    throw new Error("fast_mode request auth marker postcondition is malformed");
  }
  const capabilityComments = comments.filter((comment) =>
    comment.value.includes("CodexRebuildFastModeModelCapabilityOnly"),
  );
  const exactCapabilityComments = capabilityComments.filter(
    (comment) =>
      comment.type === "Block" &&
      comment.value.trim() === "CodexRebuildFastModeModelCapabilityOnly",
  );
  if (
    capabilityComments.length !== exactCapabilityComments.length ||
    exactCapabilityComments.length > FAST_MODE_CONTRACT_IDS.length
  ) {
    throw new Error("fast_mode model capability marker postcondition is malformed");
  }
  let malformedAuthAlternative = false;
  walk(ast, (node, parent) => {
    if (!isFunctionNode(node) || !sourceFor(source, node).includes("fast_mode")) return;
    walk(node, (child, childParent) => {
      if (
        malformedAuthAlternative ||
        child.type !== "LogicalExpression" ||
        child.operator !== "||" ||
        (childParent?.type === "LogicalExpression" && childParent.operator === "||")
      ) return;
      const terms = flattenLogical(child, "||");
      const operands = new Map();
      for (const term of terms) {
        for (const value of [CHATGPT_AUTH, APIKEY_AUTH]) {
          const operand = authComparisonOperand(term, source, "===", value);
          if (operand != null) operands.set(value, operand);
        }
      }
      if (
        operands.get(CHATGPT_AUTH) != null &&
        operands.get(CHATGPT_AUTH) === operands.get(APIKEY_AUTH) &&
        terms.length !== 2
      ) malformedAuthAlternative = true;
    });
  });
  if (malformedAuthAlternative) {
    throw new Error("fast_mode settings auth postcondition has extra alternatives");
  }
  const patchTargets = new Map(
    patches.map((target) => [`${target.id}:${target.targetStart}`, target]),
  );
  const alreadyTargets = new Map(
    already.map((target) => [`${target.id}:${target.targetStart}`, target]),
  );
  const targets = [...patchTargets.values(), ...alreadyTargets.values()];
  const total = targets.length;

  let code = source;
  for (const patch of [...patches].sort((left, right) => right.start - left.start)) {
    code = code.slice(0, patch.start) + patch.replacement + code.slice(patch.end);
  }
  const targetCounts = Object.fromEntries(
    FAST_MODE_CONTRACT_IDS.map((id) => [
      id,
      targets.filter((target) => target.id === id).length,
    ]),
  );
  return {
    code,
    status: patches.length > 0 ? "patched" : "already",
    counts: { patchable: patchTargets.size, already: alreadyTargets.size, total },
    patches,
    targetIds: [...new Set(targets.map((target) => target.id))],
    targetCounts,
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

function collectFastModeTargetMatches(candidates) {
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
  return matches;
}

function planFastModeTargets(candidates, platform = "platform") {
  const matches = collectFastModeTargetMatches(candidates);
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

function memberPropertyName(node) {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (node.computed && node.property.type === "Literal") {
    return node.property.value;
  }
  return null;
}

function isFastModeFeatureAccess(node) {
  if (memberPropertyName(node) !== "fast_mode") return false;
  const owner = node.object?.type === "ChainExpression" ? node.object.expression : node.object;
  return memberPropertyName(owner) === "featureRequirements";
}

function walkFunctionContract(root, visitor) {
  function visit(node, parent = null) {
    if (!node || typeof node !== "object") return;
    if (node !== root && isFunctionNode(node)) return;
    if (node.type) visitor(node, parent);
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) visit(item, node);
      } else {
        visit(child, node);
      }
    }
  }
  visit(root);
}

function roleMarkerEvidence(source, targetId) {
  const operator =
    targetId === "fast_mode_settings_auth_gate" ? "===" : "!==";
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return [];
  }

  let markerCount = 0;
  walk(ast, (node) => {
    if (!isFunctionNode(node)) return;
    let hasFastModeFeatureAccess = false;
    let hasRoleAuthGate = false;
    walkFunctionContract(node, (child) => {
      if (isFastModeFeatureAccess(child)) hasFastModeFeatureAccess = true;
      if (
        child.type === "BinaryExpression" &&
        child.operator === operator &&
        expressionSourceForChatGptSide(child, source) != null
      ) {
        hasRoleAuthGate = true;
      }
    });
    const hasCapabilityMarker = sourceFor(source, node).includes(
      "CodexRebuildFastModeModelCapabilityOnly",
    );
    if ((hasFastModeFeatureAccess || hasCapabilityMarker) && hasRoleAuthGate) markerCount += 1;
  });
  return markerCount > 0
    ? [`${targetId}: exact marker count=${markerCount}`]
    : [];
}

function probeMacFastModeRole(candidate, targetId) {
  const evidence = roleMarkerEvidence(candidate.source, targetId);
  if (evidence.length === 0) return { state: "irrelevant", evidence: [] };

  let result;
  try {
    result = analyzeFastModeSource(candidate.source);
  } catch (error) {
    return { state: "owned-malformed", evidence, error };
  }

  const roleTargets = result.targetCounts[targetId] ?? 0;
  const duplicateContracts = Object.entries(result.targetCounts)
    .filter(([, count]) => count > 1)
    .map(([id, count]) => `${id}=${count}`);
  if (
    roleTargets !== 1 ||
    duplicateContracts.length > 0 ||
    result.counts.total > FAST_MODE_CONTRACT_IDS.length
  ) {
    return {
      state: "owned-malformed",
      evidence,
      error: new Error(
        `${targetId} strict analyzer expected exactly 1 role target and at most 1 ` +
          `target per known contract, found role=${roleTargets} total=${result.counts.total}` +
          (duplicateContracts.length > 0
            ? ` duplicates=${duplicateContracts.join(",")}`
            : ""),
      ),
    };
  }
  return {
    state: "exact",
    evidence: [
      ...evidence,
      `strict analyzer role target count=1 bundle target total=${result.counts.total}`,
    ],
    result,
  };
}

function selectedFastModeWrite(selected) {
  return {
    role: selected.role,
    ...selected.candidate,
    result: selected.result,
  };
}

function planMacFastModePlatform({ platform, candidates }) {
  const plan = planRequiredRoles({
    platform,
    roles: [
      {
        role: "fast-settings",
        candidates,
        probe: (candidate) =>
          probeMacFastModeRole(candidate, "fast_mode_settings_auth_gate"),
      },
      {
        role: "fast-request",
        candidates,
        probe: (candidate) =>
          probeMacFastModeRole(candidate, "fast_mode_request_auth_gate"),
      },
    ],
  });
  return {
    status: "ready",
    plan,
    writes: plan.roles.map(selectedFastModeWrite),
  };
}

function planFastModePlatform({
  platform,
  candidates,
  warn = console.warn,
}) {
  if (platform.startsWith("mac-")) {
    return planMacFastModePlatform({ platform, candidates });
  }
  const matches = collectFastModeTargetMatches(candidates);
  const namedCandidates = new Map(
    FAST_MODE_CONTRACT_IDS.map((targetId) => [
      targetId,
      candidates.filter((candidate) =>
        FAST_MODE_FILE_PATTERNS.get(targetId).test(
          candidate.fileName ?? path.basename(candidate.path ?? ""),
        ),
      ),
    ]),
  );
  for (const targetId of FAST_MODE_CONTRACT_IDS) {
    if (namedCandidates.get(targetId).length !== matches.get(targetId).length) {
      throw new Error(`fast_mode ${targetId} target set is incomplete for ${platform}`);
    }
  }
  const plans = planFastModeTargets(candidates, platform);
  const plan = planRequiredRoles({
    platform,
    roles: plans.map((selected, index) => ({
      role: index === 0 ? "fast-settings" : "fast-request",
      candidates: [
        {
          path: selected.path ?? selected.fileName,
          fileName: selected.fileName ?? path.basename(selected.path ?? ""),
          source: selected.source,
        },
      ],
      probe: () => ({
        state: "exact",
        evidence: ["Windows exact filename and strict analyzer target"],
        result: selected.result,
      }),
    })),
  });
  return {
    status: "ready",
    plan,
    writes: plan.roles.map(selectedFastModeWrite),
  };
}

function commitFastModePlatforms({
  platformPlans,
  isCheck = false,
  writeFile = fs.writeFileSync,
}) {
  const selectedWrites = platformPlans.flatMap(({ plan }) =>
    commitValidatedPlan({
      plan,
      writer: selectedFastModeWrite,
    }),
  );
  const writesByPath = new Map();
  for (const write of selectedWrites) {
    const existing = writesByPath.get(write.path);
    if (existing) {
      if (
        existing.source !== write.source ||
        existing.result.code !== write.result.code
      ) {
        throw new Error(
          `fast_mode consolidated roles produced conflicting writes for ${write.path}`,
        );
      }
      continue;
    }
    writesByPath.set(write.path, write);
  }
  const writes = [...writesByPath.values()];
  if (!isCheck) {
    for (const write of writes) {
      if (write.result.code !== write.source) {
        writeFile(write.path, write.result.code, "utf-8");
      }
    }
  }
  return writes;
}

function executeFastModePlatforms({
  platformInputs,
  isCheck = false,
  writeFile = fs.writeFileSync,
}) {
  const platformPlans = platformInputs.map(({ platform, candidates }) => ({
    platform,
    ...planFastModePlatform({ platform, candidates }),
  }));
  const writes = commitFastModePlatforms({ platformPlans, isCheck, writeFile });
  return { platformPlans, writes };
}

function formatFastModeSummary(outcomes) {
  const ready = outcomes.filter((outcome) => outcome.status === "ready").map((outcome) => outcome.platform);
  const skipped = outcomes.filter((outcome) => outcome.status === "skipped").map((outcome) => outcome.platform);
  return `[summary] fast-mode: ready=[${ready.join(",")}] skipped=[${skipped.join(",")}]`;
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
      const isJavaScript = f.endsWith(".js");
      const isNamedWindowsTarget = [...FAST_MODE_FILE_PATTERNS.values()].some(
        (pattern) => pattern.test(f),
      );
      if (!isJavaScript || (plat === "win" && !isNamedWindowsTarget)) {
        continue;
      }
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      candidates.push({ platform: plat, path: fp, fileName: f, source: src });
    }
  }

  const startedAt = Date.now();
  const execution = executeFastModePlatforms({
    platformInputs: platforms.map((platformName) => ({
      platform: platformName,
      candidates: candidates.filter(
        (candidate) => candidate.platform === platformName,
      ),
    })),
    isCheck,
  });
  const outcomes = execution.platformPlans.map(({ platform: platformName, status }) => ({
    platform: platformName,
    status,
  }));
  for (const platformPlan of execution.platformPlans) {
    for (const plan of platformPlan.writes) {
      console.log(
        `  [${platformPlan.platform}] ${relPath(plan.path)} (parse ${Date.now() - startedAt}ms)`,
      );
      console.log(
        `    [${isCheck ? "check" : plan.result.status}] patchable=${plan.result.counts.patchable} already=${plan.result.counts.already} expected=${plan.result.targetIds.length}`,
      );
      for (const patch of plan.result.patches) {
        console.log(`    ${isCheck ? "?" : "*"} ${patch.original} -> ${patch.replacement}`);
      }
    }
  }
  console.log(formatFastModeSummary(outcomes));
}

if (require.main === module) {
  main();
}

module.exports = {
  collectPatches,
  analyzeFastModeSource,
  patchFastModeSource,
  planFastModeTargets,
  planFastModePlatform,
  executeFastModePlatforms,
  formatFastModeSummary,
};

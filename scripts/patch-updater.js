#!/usr/bin/env node
/**
 * patch-updater.js — Disable Sparkle (macOS) and Windows auto-updater
 *
 * AST match: in the file containing shouldIncludeSparkle / shouldIncludeUpdater,
 * find these method definitions and replace their bodies to return false.
 *
 * Specifically targets:
 *   shouldIncludeSparkle(e,t,n){return ...}  → return !1
 *   shouldIncludeWindowsUpdater(e,t,n){return ...}  → return !1
 *   shouldIncludeUpdater(e,t,n){return ...}  → return !1
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

const UPDATER_METHODS = new Set([
  "shouldIncludeSparkle",
  "shouldIncludeWindowsUpdater",
  "shouldIncludeWindowsMsixUpdater",
  "shouldIncludeUpdater",
]);

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

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // Match: Property with key being an updater method name and value being a FunctionExpression
    if (node.type !== "Property") return;
    const keyName = node.key?.name || node.key?.value;
    if (!UPDATER_METHODS.has(keyName)) return;

    const fn = node.value;
    if (fn?.type !== "FunctionExpression") return;
    const body = fn.body;
    if (!body || body.type !== "BlockStatement") return;
    if (body.body.length !== 1) return;
    const ret = body.body[0];
    if (ret.type !== "ReturnStatement" || !ret.argument) return;

    const retSrc = source.slice(ret.argument.start, ret.argument.end);
    if (retSrc === "!1") return;

    patches.push({
      id: keyName,
      start: ret.argument.start,
      end: ret.argument.end,
      replacement: "!1",
      original: retSrc.length > 50 ? retSrc.slice(0, 47) + "..." : retSrc,
    });
  });

  return patches;
}

function patchUpdaterSource(source) {
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    throw new Error(`updater parse failed: ${error.message}`);
  }
  const targets = new Map([...UPDATER_METHODS].map((method) => [method, []]));
  walk(ast, (node) => {
    if (node.type !== "Property") return;
    const method = node.key?.name ?? node.key?.value;
    if (!targets.has(method)) return;
    const body = node.value?.type === "FunctionExpression" ? node.value.body : null;
    if (body?.type !== "BlockStatement" || body.body.length !== 1) return;
    const returned = body.body[0];
    if (returned.type !== "ReturnStatement" || !returned.argument) return;
    targets.get(method).push(returned.argument);
  });

  const patches = [];
  const methods = {};
  let already = 0;
  for (const method of UPDATER_METHODS) {
    const matches = targets.get(method);
    if (matches.length !== 1) {
      throw new Error(`${method} expected exactly 1 target, found ${matches.length}`);
    }
    const argument = matches[0];
    const original = source.slice(argument.start, argument.end);
    const isAlready = original === "!1";
    if (isAlready) already += 1;
    else {
      patches.push({
        id: method,
        start: argument.start,
        end: argument.end,
        original,
        replacement: "!1",
      });
    }
    methods[method] = { patchable: isAlready ? 0 : 1, already: isAlready ? 1 : 0, total: 1 };
  }
  let code = source;
  for (const patch of [...patches].sort((left, right) => right.start - left.start)) {
    code = code.slice(0, patch.start) + patch.replacement + code.slice(patch.end);
  }
  return {
    code,
    status: patches.length > 0 ? "patched" : "already",
    patches,
    counts: {
      patchable: patches.length,
      already,
      total: patches.length + already,
      methods,
    },
  };
}

function patchUpdaterContracts({ loggerSource, workerSource }) {
  if (typeof loggerSource !== "string") throw new Error("updater logger source is required");
  if (typeof workerSource !== "string") throw new Error("updater worker source is required");
  const logger = patchUpdaterSource(loggerSource);
  const worker = patchUpdaterSource(workerSource);
  return {
    status: logger.status === "already" && worker.status === "already" ? "already" : "patched",
    logger,
    worker,
    counts: {
      patchable: logger.counts.patchable + worker.counts.patchable,
      already: logger.counts.already + worker.counts.already,
      total: logger.counts.total + worker.counts.total,
    },
  };
}

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", ".vite", "build")),
      );

  const targets = [];
  for (const plat of platforms) {
    const buildDir = path.join(SRC_DIR, plat, "_asar", ".vite", "build");
    if (!fs.existsSync(buildDir)) continue;
    for (const f of fs.readdirSync(buildDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(buildDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (
        src.includes("shouldIncludeSparkle") &&
        src.includes("shouldIncludeUpdater")
      ) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((name) =>
        fs.existsSync(path.join(SRC_DIR, name, "_asar", ".vite", "build")),
      );
  if (platforms.length === 0) throw new Error("updater expected at least one platform");
  const plans = platforms.map((platformName) => {
    const buildDir = path.join(SRC_DIR, platformName, "_asar", ".vite", "build");
    const files = fs.readdirSync(buildDir);
    const loggerNames = files.filter((name) => /^file-based-logger-.*\.js$/.test(name));
    const workerNames = files.filter((name) => name === "worker.js");
    if (loggerNames.length !== 1) {
      throw new Error(`updater logger expected exactly 1 target for ${platformName}, found ${loggerNames.length}`);
    }
    if (workerNames.length !== 1) {
      throw new Error(`updater worker expected exactly 1 target for ${platformName}, found ${workerNames.length}`);
    }
    const loggerPath = path.join(buildDir, loggerNames[0]);
    const workerPath = path.join(buildDir, workerNames[0]);
    const loggerSource = fs.readFileSync(loggerPath, "utf-8");
    const workerSource = fs.readFileSync(workerPath, "utf-8");
    return {
      platform: platformName,
      loggerPath,
      workerPath,
      loggerSource,
      workerSource,
      result: patchUpdaterContracts({ loggerSource, workerSource }),
    };
  });
  for (const plan of plans) {
    console.log(`  [${plan.platform}] ${isCheck ? "check" : plan.result.status}: patchable=${plan.result.counts.patchable} already=${plan.result.counts.already} expected=8`);
  }
  if (!isCheck) {
    for (const plan of plans) {
      if (plan.result.logger.code !== plan.loggerSource) {
        fs.writeFileSync(plan.loggerPath, plan.result.logger.code, "utf-8");
      }
      if (plan.result.worker.code !== plan.workerSource) {
        fs.writeFileSync(plan.workerPath, plan.result.worker.code, "utf-8");
      }
    }
  }
  console.log(`  [ok] updater contracts satisfied for ${plans.length} platform(s)`);
}

if (require.main === module) main();

module.exports = { collectPatches, patchUpdaterSource, patchUpdaterContracts };

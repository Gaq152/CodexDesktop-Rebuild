/**
 * Post-build patch: Update copyright text
 *
 * Uses AST to locate `setAboutPanelOptions({ copyright: "(c) OpenAI" })`
 * and replace the copyright string with a custom value.
 *
 * Usage:
 *   node scripts/patch-copyright.js [platform]   # Apply patch (unix/win/omit=both)
 *   node scripts/patch-copyright.js --check       # Dry-run: report matches
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

// ──────────────────────────────────────────────
//  Config
// ──────────────────────────────────────────────

const OLD_COPYRIGHT = "\u00A9 OpenAI"; // (c) OpenAI
const NEW_COPYRIGHT = "\u00A9 OpenAI \u00B7 Cometix Space"; // (c) OpenAI . Cometix Space
const OLD_COPYRIGHT_HTML = `<div class="copyright">${OLD_COPYRIGHT}</div>`;
const NEW_COPYRIGHT_HTML = `<div class="copyright">${NEW_COPYRIGHT}</div>`;

// ──────────────────────────────────────────────
//  AST walker
// ──────────────────────────────────────────────

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") walk(item, visitor);
      }
    } else if (child && typeof child.type === "string") {
      walk(child, visitor);
    }
  }
}

// ──────────────────────────────────────────────
//  Patch rule
// ──────────────────────────────────────────────

function collectPatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "Property") return;
    const keyName =
      node.key.type === "Identifier"
        ? node.key.name
        : node.key.type === "Literal"
          ? node.key.value
          : null;
    if (keyName !== "copyright") return;

    const val = node.value;

    // Case 1: Literal string  copyright: "..."
    if (val.type === "Literal" && val.value === OLD_COPYRIGHT) {
      patches.push({
        start: val.start,
        end: val.end,
        replacement: JSON.stringify(NEW_COPYRIGHT),
        original: source.slice(val.start, val.end),
      });
      return;
    }

    // Case 2: Template literal  copyright: `...`  (no expressions, single quasi)
    if (
      val.type === "TemplateLiteral" &&
      val.expressions.length === 0 &&
      val.quasis.length === 1 &&
      val.quasis[0].value.cooked === OLD_COPYRIGHT
    ) {
      patches.push({
        start: val.start,
        end: val.end,
        replacement: "`" + NEW_COPYRIGHT + "`",
        original: source.slice(val.start, val.end),
      });
      return;
    }
  });

  // Newer desktop builds render the About window from an inline HTML template
  // instead of setAboutPanelOptions({ copyright: ... }). Keep this target exact
  // so unrelated OpenAI strings are never rewritten.
  let htmlOffset = source.indexOf(OLD_COPYRIGHT_HTML);
  while (htmlOffset !== -1) {
    patches.push({
      start: htmlOffset,
      end: htmlOffset + OLD_COPYRIGHT_HTML.length,
      replacement: NEW_COPYRIGHT_HTML,
      original: OLD_COPYRIGHT_HTML,
    });
    htmlOffset = source.indexOf(OLD_COPYRIGHT_HTML, htmlOffset + OLD_COPYRIGHT_HTML.length);
  }
  return patches;
}

function countPropertyValues(ast, expected) {
  let count = 0;
  walk(ast, (node) => {
    if (node.type !== "Property") return;
    const keyName =
      node.key.type === "Identifier"
        ? node.key.name
        : node.key.type === "Literal"
          ? node.key.value
          : null;
    if (keyName !== "copyright") return;
    if (node.value.type === "Literal" && node.value.value === expected) count += 1;
    if (
      node.value.type === "TemplateLiteral" &&
      node.value.expressions.length === 0 &&
      node.value.quasis.length === 1 &&
      node.value.quasis[0].value.cooked === expected
    ) count += 1;
  });
  return count;
}

function patchCopyrightSource(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const patches = collectPatches(ast, source);
  const alreadyCount =
    countPropertyValues(ast, NEW_COPYRIGHT) +
    (source.split(NEW_COPYRIGHT_HTML).length - 1);
  if (patches.length + alreadyCount !== 1) {
    throw new Error(
      `copyright expected exactly 1 recognized target, found ${patches.length + alreadyCount}`,
    );
  }
  let code = source;
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
    code = code.slice(0, patch.start) + patch.replacement + code.slice(patch.end);
  }
  return {
    code,
    status: patches.length === 1 ? "patched" : "already",
    patches,
  };
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const bundles = locateBundles({
    dir: "build",
    pattern: /^main(-[^.]+)?\.js$/,
    platform,
  });

  if (bundles.length === 0) {
    console.error("[x] No main bundle found");
    process.exit(1);
  }

  for (const bundle of bundles) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

    const t0 = Date.now();
    const result = patchCopyrightSource(source);
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = result.patches;

    if (result.status === "already") {
      console.log("   [ok] Already patched");
      continue;
    }

    if (isCheck) {
      console.log(`   [?] Matches: ${patches.length}`);
      for (const p of patches) {
        console.log(`     > offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      continue;
    }

    for (const p of patches) {
      console.log(`   * offset ${p.start}: ${p.original} -> ${p.replacement}`);
    }

    fs.writeFileSync(bundle.path, result.code, "utf-8");
    console.log(`   [ok] Copyright updated: ${patches.length} replacements`);
  }
}

if (require.main === module) main();

module.exports = {
  OLD_COPYRIGHT,
  NEW_COPYRIGHT,
  OLD_COPYRIGHT_HTML,
  NEW_COPYRIGHT_HTML,
  collectPatches,
  patchCopyrightSource,
};

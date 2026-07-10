#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");

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
const BROWSER_DEFAULT_KEYS = [
  "browserPane",
  "externalBrowserUse",
  "externalBrowserUseAllowed",
  "inAppBrowserUse",
  "inAppBrowserUseAllowed",
];
const COMPUTER_DEFAULT_KEYS = ["computerUse", "computerUseNodeRepl"];

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

function comparisonOperand(node, expectedValue, source) {
  if (node?.type !== "BinaryExpression" || node.operator !== "===") return null;
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

function hasPatchedFeatureDefaults(source, requiredKeys) {
  if (
    !source.includes("browserPane") ||
    !source.includes("computerUse") ||
    !source.includes("!0")
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
    if (found || node.type !== "ObjectExpression" || node.properties.length < 5) {
      return;
    }
    const properties = new Map();
    for (const property of node.properties) {
      const name = propertyName(property);
      if (name) properties.set(name, property.value);
    }
    const featureKeyCount = [...properties.keys()].filter((name) =>
      FEATURE_DEFAULT_KEYS.has(name),
    ).length;
    if (featureKeyCount < 5) return;
    found = requiredKeys.every((name) => isAlwaysTrue(properties.get(name)));
  });
  return found;
}

function isBuildFile(file, basename) {
  return file === `src/win/_asar/.vite/build/${basename}`;
}

function isWebviewAsset(file) {
  return file.startsWith("src/win/_asar/webview/assets/");
}

const CONTRACT_DEFINITIONS = [
  {
    id: "fast",
    sameBundle: true,
    markers: [
      {
        label: "fast_mode",
        matches: (source) => source.includes("fast_mode"),
      },
      {
        label: "API-key authorization postcondition",
        matches: hasPatchedFastModeAuthorization,
      },
    ],
  },
  {
    id: "plugin",
    sameBundle: true,
    markers: [
      {
        label: "browser availability postcondition",
        matches: (source) =>
          hasPatchedFeatureDefaults(source, BROWSER_DEFAULT_KEYS),
      },
      {
        label: "computer availability postcondition",
        matches: (source) =>
          hasPatchedFeatureDefaults(source, COMPUTER_DEFAULT_KEYS),
      },
      {
        label: "bundled plugin availability postcondition",
        matches: (source) => /\.filter\(\s*\(\s*\)\s*=>\s*!0\s*\)/.test(source),
      },
    ],
  },
  {
    id: "archive-delete",
    sameBundle: true,
    markers: [
      {
        label: "delete-conversation",
        matches: (source) => source.includes("delete-conversation"),
      },
      {
        label: "thread/delete",
        matches: (source) => source.includes("thread/delete"),
      },
    ],
  },
  {
    id: "sidebar-delete",
    sameBundle: true,
    markers: [
      {
        label: "delete-thread",
        matches: (source) => source.includes("delete-thread"),
      },
      {
        label: "inline confirmation action",
        matches: (source) =>
          source.includes("thread-delete-confirm-action") ||
          source.includes("deleteThreadConfirmAction"),
      },
    ],
  },
  {
    id: "updater",
    markers: [
      {
        label: "CodexRebuildLocalUpdater",
        matches: (source, file) =>
          isBuildFile(file, "bootstrap.js") &&
          source.includes("CodexRebuildLocalUpdater"),
      },
      {
        label: "codexRebuildUpdater preload bridge",
        matches: (source, file) =>
          isBuildFile(file, "preload.js") &&
          /exposeInMainWorld\(\s*["'`]codexRebuildUpdater["'`]/.test(source),
      },
      {
        label: "codex-rebuild-updater-top",
        matches: (source, file) =>
          isWebviewAsset(file) && source.includes("codex-rebuild-updater-top"),
      },
    ],
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

  const contracts = {};
  for (const definition of CONTRACT_DEFINITIONS) {
    if (definition.sameBundle) {
      const matchingFiles = sources
        .filter(({ source, file }) =>
          definition.markers.every((marker) => marker.matches(source, file)),
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
            !sources.some(({ source, file }) => marker.matches(source, file)),
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
        .filter(({ source, file }) => marker.matches(source, file))
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

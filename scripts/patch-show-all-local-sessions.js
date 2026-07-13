#!/usr/bin/env node
/**
 * Keep local history visible across auth/provider changes.
 *
 * Upstream can classify a local thread from an older host as remote/foreign.
 * Normalize unknown host ids back to the current local host while preserving
 * explicitly enabled remote hosts/projects.
 */
const fs = require("fs");
const path = require("path");
const { relPath, SRC_DIR } = require("./patch-util");

const LOCAL_HOST_MARKER = "/* CodexRebuildLocalSessionHost */";
const ROOT_HOST_MARKER = "/* CodexRebuildWorkspaceRootHost */";

const LOCAL_HOST_PATTERN =
  /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.hostId==null\|\|([A-Za-z_$][\w$]*)\(\2\.hostId\)\?([A-Za-z_$][\w$]*):\2\.hostId,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\?\.threadProjectAssignments\?\.\[\2\.conversationId\]/g;
const ROOT_HOST_PATTERN =
  /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.hostId==null\|\|([A-Za-z_$][\w$]*)\(\2\.hostId\)\?([A-Za-z_$][\w$]*):\2\.hostId,([A-Za-z_$][\w$]*)=\2\.cwd;if\(!\5\|\|\1!==\4&&!([A-Za-z_$][\w$]*)\.has\(\1\)\)continue;/g;

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function patchProjectGroupSource(source) {
  const localMatches = [...source.matchAll(LOCAL_HOST_PATTERN)];
  const rootMatches = [...source.matchAll(ROOT_HOST_PATTERN)];
  const localAlready = countOccurrences(source, LOCAL_HOST_MARKER);
  const rootAlready = countOccurrences(source, ROOT_HOST_MARKER);
  if (localMatches.length + localAlready !== 1) {
    throw new Error(
      `local session host normalization expected exactly 1 target, found ${localMatches.length + localAlready}`,
    );
  }
  if (rootMatches.length + rootAlready !== 1) {
    throw new Error(
      `workspace root host normalization expected exactly 1 target, found ${rootMatches.length + rootAlready}`,
    );
  }

  let code = source;
  if (localMatches.length === 1) {
    code = code.replace(LOCAL_HOST_PATTERN, (_match, host, thread, isLocal, primary, assignment, options) =>
      `let ${host}=${thread}.hostId==null||${isLocal}(${thread}.hostId)||!(${options}?.enabledRemoteHostIds?.has(${thread}.hostId)||${options}?.remoteProjects?.some(t=>t.hostId===${thread}.hostId))${LOCAL_HOST_MARKER}?${primary}:${thread}.hostId,${assignment}=${options}?.threadProjectAssignments?.[${thread}.conversationId]`,
    );
  }
  if (rootMatches.length === 1) {
    code = code.replace(ROOT_HOST_PATTERN, (_match, host, thread, isLocal, primary, cwd, remoteHosts) =>
      `let ${host}=${thread}.hostId==null||${isLocal}(${thread}.hostId)||!${remoteHosts}.has(${thread}.hostId)${ROOT_HOST_MARKER}?${primary}:${thread}.hostId,${cwd}=${thread}.cwd;if(!${cwd}||${host}!==${primary}&&!${remoteHosts}.has(${host}))continue;`,
    );
  }
  return {
    code,
    status: localMatches.length + rootMatches.length > 0 ? "patched" : "already",
    counts: {
      local: localMatches.length + localAlready,
      root: rootMatches.length + rootAlready,
    },
  };
}

function locatePlatformCandidates(platform) {
  const assetsDir = path.join(SRC_DIR, platform, "_asar", "webview", "assets");
  if (!fs.existsSync(assetsDir)) return [];
  const candidates = [];
  for (const fileName of fs.readdirSync(assetsDir)) {
    if (!fileName.endsWith(".js")) continue;
    const filePath = path.join(assetsDir, fileName);
    const source = fs.readFileSync(filePath, "utf8");
    if (
      source.includes("threadProjectAssignments") &&
      (source.includes("enabledRemoteHostIds") || source.includes(LOCAL_HOST_MARKER)) &&
      (ROOT_HOST_PATTERN.test(source) || source.includes(ROOT_HOST_MARKER))
    ) {
      ROOT_HOST_PATTERN.lastIndex = 0;
      candidates.push({ platform, path: filePath, source });
    }
    ROOT_HOST_PATTERN.lastIndex = 0;
  }
  return candidates;
}

function planPlatforms(platforms) {
  const plans = [];
  for (const platform of platforms) {
    const candidates = locatePlatformCandidates(platform);
    if (candidates.length !== 1) {
      throw new Error(
        `local session visibility expected exactly 1 structural bundle for ${platform}, found ${candidates.length}`,
      );
    }
    const candidate = candidates[0];
    plans.push({ ...candidate, result: patchProjectGroupSource(candidate.source) });
  }
  return plans;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const selected = args.find((arg) => ["mac-arm64", "mac-x64", "win"].includes(arg));
  const platforms = selected
    ? [selected]
    : ["mac-arm64", "mac-x64", "win"].filter((platform) =>
        fs.existsSync(path.join(SRC_DIR, platform, "_asar", "webview", "assets")),
      );
  const plans = planPlatforms(platforms);
  for (const plan of plans) {
    if (!isCheck && plan.result.code !== plan.source) {
      fs.writeFileSync(plan.path, plan.result.code, "utf8");
    }
    console.log(
      `  [${isCheck ? "check" : plan.result.status}] ${relPath(plan.path)}: local session visibility`,
    );
  }
  console.log(`  [done] project group bundles: ${plans.length}`);
}

if (require.main === module) main();

module.exports = {
  LOCAL_HOST_MARKER,
  ROOT_HOST_MARKER,
  patchProjectGroupSource,
  locatePlatformCandidates,
  planPlatforms,
};

#!/usr/bin/env node
/**
 * patch-show-all-local-sessions.js - Keep local history visible across auth/provider changes.
 *
 * Upstream treats local threads whose hostId no longer matches the current
 * primary host as remote/foreign, then hides them unless that host is an
 * enabled remote project. For local desktop rebuilds, those are still local
 * unarchived sessions, so unknown non-primary hostIds are folded back into the
 * primary local host for sidebar grouping.
 */
const fs = require("fs");
const { locateBundles, relPath } = require("./patch-util");

function patchProjectGroups(bundles) {
  let patched = 0;

  for (const bundle of bundles) {
    let code = fs.readFileSync(bundle.path, "utf-8");
    let changed = false;

    const oldLocalHost =
      "let d=e.hostId==null||l(e.hostId)?c:e.hostId,p=u?.threadProjectAssignments?.[e.conversationId]";
    const newLocalHost =
      "let d=e.hostId==null||l(e.hostId)||!(u?.enabledRemoteHostIds?.has(e.hostId)||u?.remoteProjects?.some(t=>t.hostId===e.hostId))?c:e.hostId,p=u?.threadProjectAssignments?.[e.conversationId]";

    if (code.includes(oldLocalHost)) {
      code = code.replace(oldLocalHost, newLocalHost);
      changed = true;
    } else if (!code.includes(newLocalHost)) {
      console.log(`  [!] ${relPath(bundle.path)}: local thread host normalization not found`);
      continue;
    }

    const oldRootHost =
      "let e=n.hostId==null||l(n.hostId)?t:n.hostId,r=n.cwd;if(!r||e!==t&&!a.has(e))continue;";
    const newRootHost =
      "let e=n.hostId==null||l(n.hostId)||!a.has(n.hostId)?t:n.hostId,r=n.cwd;if(!r||e!==t&&!a.has(e))continue;";

    if (code.includes(oldRootHost)) {
      code = code.replace(oldRootHost, newRootHost);
      changed = true;
    } else if (!code.includes(newRootHost)) {
      console.log(`  [!] ${relPath(bundle.path)}: workspace root host normalization not found`);
      continue;
    }

    if (changed) {
      fs.writeFileSync(bundle.path, code);
      console.log(`  [ok] ${relPath(bundle.path)}: patched local session visibility`);
      patched++;
    } else {
      console.log(`  [ok] ${relPath(bundle.path)}: local session visibility already patched`);
    }
  }

  return patched;
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win"].includes(arg));

  const bundles = locateBundles({
    dir: "assets",
    pattern: /^sidebar-project-groups-.*\.js$/,
    ...(platform ? { platform } : {}),
  });
  const count = patchProjectGroups(bundles);
  console.log(`  [done] project group bundles: ${count}`);
}

main();

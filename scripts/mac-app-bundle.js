const fs = require("fs");
const path = require("path");

const UPSTREAM_BUNDLE_IDS = new Set([
  "com.openai.codex",
]);

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function readPlistString(xml, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`));
  return match ? decodeXml(match[1].trim()) : "";
}

function findAppDirectories(root) {
  const results = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.name.endsWith(".app")) {
        results.push(fullPath);
        continue;
      }
      visit(fullPath);
    }
  };
  visit(root);
  return results;
}

function resolveMacAppBundle(extractDir, { expectedVersion = "" } = {}) {
  if (!fs.existsSync(extractDir)) {
    throw new Error(`macOS extract cache not found: ${extractDir}`);
  }

  const owned = [];
  for (const appPath of findAppDirectories(extractDir)) {
    const infoPlist = path.join(appPath, "Contents", "Info.plist");
    if (!fs.existsSync(infoPlist)) continue;

    const plist = fs.readFileSync(infoPlist, "utf8");
    const bundleId = readPlistString(plist, "CFBundleIdentifier");
    if (!UPSTREAM_BUNDLE_IDS.has(bundleId)) continue;

    const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
    if (!fs.existsSync(asarPath)) {
      throw new Error(`owned macOS app bundle is incomplete (${appPath}): Contents/Resources/app.asar not found`);
    }

    const version = readPlistString(plist, "CFBundleShortVersionString");
    if (expectedVersion && version !== expectedVersion) {
      throw new Error(`owned macOS app bundle version ${version || "<missing>"} does not match expected ${expectedVersion}: ${appPath}`);
    }
    owned.push(appPath);
  }

  if (owned.length !== 1) {
    throw new Error(`expected exactly 1 upstream macOS app bundle, found ${owned.length} in ${extractDir}`);
  }
  return owned[0];
}

module.exports = { resolveMacAppBundle };

#!/usr/bin/env node
/**
 * check-update.js — Codex 版本检测工具
 *
 * 检查 macOS (Sparkle appcast) 和 Windows (MS Store) 的最新版本
 * 与本地记录对比，仅在有更新时输出
 *
 * 用法:
 *   node scripts/check-update.js              # 检查并对比
 *   node scripts/check-update.js --force      # 强制输出（即使无更新）
 *   node scripts/check-update.js --json       # JSON 输出
 *   node scripts/check-update.js --windows-only # 仅检查 Windows（Windows CI 使用）
 *   node scripts/check-update.js --save       # 更新本地版本记录
 */

const https = require("https");
const tls = require("tls");
const { XMLParser } = require("fast-xml-parser");
const fs = require("fs");
const path = require("path");
const { selectWindowsMsixPackage } = require("./windows-package-utils");
const {
  readWindowsInternalAppVersionFromRemoteMsix,
} = require("./windows-msix-internal-version");

// ─── 证书注入（复用 fetch-msstore 的 CA 补丁）─────────────────────
const certsDir = path.join(__dirname, "certs");
const extraCAs = [...tls.rootCertificates];
for (const f of ["ms-root-ca.pem", "ms-update-ca.pem"]) {
  const p = path.join(certsDir, f);
  if (fs.existsSync(p)) extraCAs.push(fs.readFileSync(p, "utf-8"));
}
https.globalAgent.options.ca = extraCAs;

// ─── 常量 ────────────────────────────────────────────────────────
const APPCAST_ARM64 = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";
const APPCAST_X64 = "https://persistent.oaistatic.com/codex-app-prod/appcast-x64.xml";
const MS_STORE_PRODUCT_ID = "9plm9xgg6vks";
const VERSION_FILE = path.join(__dirname, ".versions.json");

// ─── HTTP 辅助 ───────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return httpsGet(res.headers.location).then(resolve, reject);
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf-8"),
          })
        );
      })
      .on("error", reject);
  });
}

// ─── macOS: Sparkle appcast ──────────────────────────────────────
async function checkMacArm64Version() { return checkAppcast(APPCAST_ARM64, "macOS-arm64"); }
async function checkMacX64Version() { return checkAppcast(APPCAST_X64, "macOS-x64"); }

async function checkAppcast(url, platformLabel) {
  const res = await httpsGet(url);
  if (res.status !== 200) {
    throw new Error(`appcast.xml 请求失败: HTTP ${res.status}`);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
  });
  const parsed = parser.parse(res.body);

  // 取第一个 item（最新版本）
  const items = parsed.rss?.channel?.item;
  const latest = Array.isArray(items) ? items[0] : items;

  if (!latest) throw new Error(`${platformLabel}: no version in appcast`);

  let enclosure = latest.enclosure;
  if (Array.isArray(enclosure)) enclosure = enclosure[0];

  return {
    platform: platformLabel,
    version: latest.shortVersionString || latest.title,
    build: String(latest.version || ""),
    pubDate: latest.pubDate || "",
    downloadUrl: enclosure?.["@_url"] || "",
    size: Number(enclosure?.["@_length"] || 0),
    minimumSystemVersion: latest.minimumSystemVersion || "",
  };
}

// ─── Windows: MS Store ───────────────────────────────────────────
async function checkWindowsVersion() {
  // 动态加载 fetch-msstore 的模块 API
  const msstore = require("./fetch-msstore");

  const cookie = await msstore.getCookie();
  const appInfo = await msstore.getAppInfo(MS_STORE_PRODUCT_ID, "US");

  if (!appInfo.categoryId) {
    throw new Error("无法获取 MS Store CategoryID");
  }

  const packages = await msstore.getFileList(
    cookie,
    appInfo.categoryId,
    "Retail"
  );

  if (packages.length === 0) {
    throw new Error("MS Store 未返回任何包");
  }

  // 从包名提取版本: OpenAI.Codex_26.325.2171.0_x64__xxx.msix
  const pkg = selectWindowsMsixPackage(packages, "x64");
  const versionMatch = pkg.name.match(/_(\d+\.\d+\.\d+(?:\.\d+)?)_/);
  const msixVersion = versionMatch ? versionMatch[1] : "unknown";

  // 获取下载链接
  const url = await msstore.getDownloadUrl(
    pkg.updateID,
    pkg.revisionNumber,
    "Retail",
    pkg.digest
  );
  const size = Number(pkg.size || 0);
  const internalAppVersion = await readWindowsInternalAppVersionFromRemoteMsix({
    url,
    size,
  });

  return {
    platform: "Windows",
    version: internalAppVersion,
    internalAppVersion,
    msixVersion,
    build: "",
    pubDate: "",
    downloadUrl: url,
    size,
    packageName: pkg.name,
  };
}

function sameRecordedVersion(saved, info) {
  if (!saved) return false;
  if (info.platform === "Windows") {
    const savedMsixVersion = saved.msixVersion || (/^\d+\.\d+\.\d+\.\d+$/.test(saved.version || "") ? saved.version : "");
    return savedMsixVersion === info.msixVersion &&
      (saved.internalAppVersion || saved.version || "") === info.internalAppVersion;
  }
  return saved.version === info.version && saved.build === info.build;
}

// ─── 版本记录读写 ────────────────────────────────────────────────
function loadVersions() {
  try {
    return JSON.parse(fs.readFileSync(VERSION_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveVersions(versions) {
  fs.writeFileSync(VERSION_FILE, JSON.stringify(versions, null, 2) + "\n");
}

function formatSize(bytes) {
  if (!bytes) return "Unknown";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

// ─── 主流程 ──────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const jsonOutput = args.includes("--json");
  const doSave = args.includes("--save");
  const windowsOnly = args.includes("--windows-only");
  const quiet = jsonOutput || args.includes("--quiet") || args.includes("-q");

  const saved = loadVersions();
  const results = [];
  const updates = [];

  const checks = await Promise.allSettled(windowsOnly
    ? [checkWindowsVersion()]
    : [checkMacArm64Version(), checkMacX64Version(), checkWindowsVersion()]);
  const failures = [];

  for (const r of checks) {
    if (r.status === "fulfilled") {
      const info = r.value;
      results.push(info);
      const key = info.platform;
      const isNew = !sameRecordedVersion(saved[key], info);
      if (isNew) updates.push(info);
    } else {
      failures.push(r.reason);
      if (!quiet) console.error(`  [!] ${r.reason.message}`);
    }
  }

  if (windowsOnly && failures.length > 0) {
    throw new Error(`Windows version check failed: ${failures[0].message}`);
  }

  // JSON 输出模式
  if (jsonOutput) {
    const output = {
      timestamp: new Date().toISOString(),
      hasUpdates: updates.length > 0,
      platforms: Object.fromEntries(results.map((r) => [r.platform, r])),
      previous: saved,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    // 人类可读输出
    const toShow = force ? results : updates;

    if (toShow.length === 0 && !force) {
      if (!quiet) console.log("✅ 没有新版本。");
    } else {
      for (const info of toShow) {
        const isUpdate = updates.includes(info);
        const prevVersion = saved[info.platform]?.version || "无记录";
        const tag = isUpdate ? "🆕 新版本" : "📌 当前版本";

        console.log(`${tag} [${info.platform}]`);
        console.log(`  版本: ${info.version}${info.build ? ` (build ${info.build})` : ""}`);
        if (info.msixVersion) console.log(`  MSIX: ${info.msixVersion}`);
        if (isUpdate && prevVersion !== "无记录") {
          console.log(`  旧版: ${prevVersion}${saved[info.platform]?.build ? ` (build ${saved[info.platform].build})` : ""}`);
        }
        if (info.pubDate) console.log(`  发布: ${info.pubDate}`);
        console.log(`  大小: ${formatSize(info.size)}`);
        if (info.packageName) console.log(`  包名: ${info.packageName}`);
        if (info.downloadUrl) {
          console.log(`  链接: ${info.downloadUrl.slice(0, 100)}${info.downloadUrl.length > 100 ? "..." : ""}`);
        }
        console.log();
      }
    }
  }

  // 保存版本记录
  if (doSave && results.length > 0) {
    const newSaved = { ...saved };
    for (const r of results) {
      newSaved[r.platform] = {
        version: r.version,
        internalAppVersion: r.internalAppVersion || undefined,
        msixVersion: r.msixVersion || undefined,
        build: r.build || undefined,
        checkedAt: new Date().toISOString(),
      };
    }
    saveVersions(newSaved);
    if (!quiet) console.log(`💾 版本记录已保存到 ${VERSION_FILE}`);
  }

  // 退出码: 0=有更新, 1=无更新（方便 CI 使用）
  if (!force && updates.length === 0) process.exitCode = 1;

  return { results, updates };
}

module.exports = { checkMacArm64Version, checkMacX64Version, checkWindowsVersion };

if (require.main === module) {
  main().catch((e) => {
    console.error(`\n❌ 错误: ${e.message}`);
    process.exit(2);
  });
}

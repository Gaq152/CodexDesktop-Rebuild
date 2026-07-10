#!/usr/bin/env node
/**
 * Smart development startup script
 * Automatically detects system architecture and sets correct CLI path
 */

const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const {
  getPinnedCodexVersion,
  resolveCodexRuntime,
  installCodexRuntime,
  verifyCodexBinary,
} = require("./codex-vendor");

const PROJECT_ROOT = path.resolve(__dirname, "..");

// Detect platform and architecture
const platform = process.platform;
const arch = os.arch();

// Map to CLI binary paths
const platformMap = {
  darwin: {
    x64: "mac-x64",
    arm64: "mac-arm64",
  },
  linux: {
    x64: "linux-x64",
    arm64: "linux-arm64",
  },
  win32: {
    x64: "win",
  },
};

const srcPlatform = platformMap[platform]?.[arch];
if (!srcPlatform) {
  console.error(`Unsupported platform/arch: ${platform}/${arch}`);
  process.exit(1);
}

const resourcesDir = path.join(PROJECT_ROOT, "src", srcPlatform);
const codexVersion = getPinnedCodexVersion(PROJECT_ROOT);
const codexRuntime = resolveCodexRuntime(PROJECT_ROOT, srcPlatform);
installCodexRuntime(codexRuntime, resourcesDir);
const cliPath = path.join(resourcesDir, path.basename(codexRuntime.entrypoint));
verifyCodexBinary(cliPath, codexVersion);

// Resolve app entry: prefer platform-specific _asar/ (has its own package.json)
const appRoot = path.join(resourcesDir, "_asar");
const appEntry = fs.existsSync(appRoot) ? appRoot : PROJECT_ROOT;

console.log(`[start-dev] Platform: ${platform}, Arch: ${arch}`);
console.log(`[start-dev] Codex CLI: ${cliPath} (${codexVersion})`);
console.log(`[start-dev] App Root: ${appEntry}`);

// Launch Electron with CLI path
const electronBin = require('electron');
const child = spawn(electronBin, [appEntry], {
  cwd: PROJECT_ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    CODEX_CLI_PATH: cliPath,
    BUILD_FLAVOR: process.env.BUILD_FLAVOR || "dev",
    ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL || "app://-/index.html",
    CODEX_ELECTRON_RESOURCES_PATH: resourcesDir,
    CODEX_ELECTRON_BUNDLED_PLUGINS_RESOURCES_PATH: resourcesDir,
    CODEX_NODE_REPL_PATH: path.join(resourcesDir, "node_repl"),
    CODEX_BROWSER_USE_NODE_PATH: path.join(resourcesDir, "node"),
  },
});

child.on("close", (code) => {
  process.exit(code);
});

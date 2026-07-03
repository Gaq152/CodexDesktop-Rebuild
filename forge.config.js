const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const path = require("path");
const fs = require("fs");

const WINDOWS_REMOTE_RELEASES = process.env.CODEX_REBUILD_REMOTE_RELEASES || "";

module.exports = {
  packagerConfig: {
    name: "Codex",
    executableName: "Codex",
    appBundleId: "com.openai.codex",
    icon: "./resources/electron",
    // Build mode is set by prepare-src.js via src/.build-mode marker file.
    // "upstream-asar": mac/win — we provide pre-built app.asar, forge skips ASAR packing.
    // "linux": forge packs ASAR from src/ content (needs electron-rebuild).
    asar: (() => {
      try {
        return fs.readFileSync(path.join(__dirname, "src", ".build-mode"), "utf-8").trim() === "upstream-asar"
          ? false
          : { unpack: "{**/*.node,**/node-pty/build/Release/spawn-helper,**/node-pty/prebuilds/*/spawn-helper}" };
      } catch { return false; }
    })(),
    ignore: (() => {
      let mode = "upstream-asar";
      try { mode = fs.readFileSync(path.join(__dirname, "src", ".build-mode"), "utf-8").trim(); } catch {}
      return mode === "upstream-asar"
        ? (filePath) => {
            // Allow only package.json + stub main entry (forge validates it)
            if (filePath === "") return false;
            if (filePath === "/package.json") return false;
            if (filePath === "/src" || filePath.startsWith("/src/.vite")) return false;
            return true;
          }
        : (filePath) => {
            if (filePath === "") return false;
            if (filePath === "/package.json") return false;
            const allowed = ["/src/.vite/build", "/src/webview", "/src/skills", "/src/native-menu-locales", "/src/node_modules"];
            for (const p of allowed) {
              if (p.startsWith(filePath) || filePath.startsWith(p)) return false;
            }
            return true;
          };
    })(),
    osxSign: process.env.SKIP_SIGN ? undefined : {
      identity: process.env.APPLE_IDENTITY,
      identityValidation: false,
    },
    osxNotarize: process.env.SKIP_NOTARIZE ? undefined : {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    },
    win32metadata: {
      CompanyName: "OpenAI",
      ProductName: "Codex",
    },
  },
  rebuildConfig: {},
  makers: [
    { name: "@electron-forge/maker-dmg", config: { format: "ULFO", icon: "./resources/electron.icns" } },
    { name: "@electron-forge/maker-zip", platforms: ["darwin"] },
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "Codex",
        authors: "OpenAI, Cometix Space",
        description: "Codex Desktop App",
        setupExe: "CodexSetup.exe",
        noMsi: true,
        setupIcon: "./resources/electron.ico",
        iconUrl: "https://raw.githubusercontent.com/Gaq152/CodexDesktop-Rebuild/master/resources/electron.ico",
        remoteReleases: WINDOWS_REMOTE_RELEASES || undefined,
      },
    },
    { name: "@electron-forge/maker-zip", platforms: ["win32"] },
    {
      name: "@electron-forge/maker-deb",
      config: { options: { name: "codex", productName: "Codex", genericName: "AI Coding Assistant", categories: ["Development", "Utility"], bin: "Codex", maintainer: "Cometix Space", homepage: "https://github.com/Haleclipse/CodexDesktop-Rebuild", icon: "./resources/electron.png" } },
    },
    {
      name: "@electron-forge/maker-rpm",
      config: { options: { name: "codex", productName: "Codex", genericName: "AI Coding Assistant", categories: ["Development", "Utility"], bin: "Codex", license: "Apache-2.0", homepage: "https://github.com/Haleclipse/CodexDesktop-Rebuild", icon: "./resources/electron.png" } },
    },
    { name: "@electron-forge/maker-zip", platforms: ["linux"] },
  ],
  plugins: [
    // No auto-unpack-natives — we provide upstream app.asar.unpacked directly
    {
      name: "@electron-forge/plugin-fuses",
      config: {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: true,
        [FuseV1Options.EnableCookieEncryption]: false,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: true,
        [FuseV1Options.EnableNodeCliInspectArguments]: true,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
        [FuseV1Options.OnlyLoadAppFromAsar]: false,
      },
    },
  ],
  hooks: {
    // Copy everything from the platform dir to the app's Resources:
    // - app.asar (repacked by prepare-src with patches applied)
    // - app.asar.unpacked/ (upstream native modules, untouched)
    // - All other resources (codex CLI, rg, plugins, native, etc.)
    //
    // Forge's own ASAR packing is disabled (asar: false).
    // buildPath points to the app dir — we put app.asar alongside it.
    packageAfterCopy: async (config, buildPath, electronVersion, platform, arch) => {
      console.log(`\n-- packageAfterCopy: ${platform}-${arch}`);

      const resourcesPath = path.dirname(buildPath);
      const isLinux = platform === "linux";
      const platformKey = platform === "win32" ? "win" : `mac-${arch}`;

      const platformDir = path.join(__dirname, "src", platformKey);
      if (!fs.existsSync(platformDir)) {
        console.log(`   [!] src/${platformKey}/ not found`);
        return;
      }

      // Skip _asar (already repacked into app.asar or packed by forge for Linux).
      // For Linux: also skip macOS-only binaries and app.asar (forge packs its own).
      const skip = new Set(["_asar"]);
      const MACOS_ONLY_FILES = new Set([
        "node", "node_repl",
        "electron.icns", "Assets.car",
        "codexTemplate.png", "codexTemplate@2x.png",
        "app.asar", "codex-notification.wav",
      ]);
      const MACOS_ONLY_DIRS = new Set(["native", "app.asar.unpacked"]);
      if (isLinux) {
        for (const f of MACOS_ONLY_FILES) skip.add(f);
        for (const d of MACOS_ONLY_DIRS) skip.add(d);
      }
      let copied = 0;
      let skipped = 0;
      const linuxSkyBinary = isLinux ? `sky_linux_${arch === "arm64" ? "arm64" : "x64"}` : null;
      const shouldSkipLinuxResource = (filePath, fileName) => {
        if (!isLinux) return false;
        const normalized = filePath.split(path.sep).join("/");
        return normalized.includes("/@oai/sky/bin/linux/") && fileName !== linuxSkyBinary;
      };

      const copyDir = (s, d) => {
        fs.mkdirSync(d, { recursive: true });
        for (const e of fs.readdirSync(s, { withFileTypes: true })) {
          const sp = path.join(s, e.name), dp = path.join(d, e.name);
          if (e.isDirectory()) copyDir(sp, dp);
          else if (!e.isSymbolicLink()) {
            if (shouldSkipLinuxResource(sp, e.name)) { skipped++; continue; }
            fs.copyFileSync(sp, dp);
            copied++;
          }
        }
      };

      for (const entry of fs.readdirSync(platformDir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        if (entry.name.endsWith(".lproj")) continue;

        const srcPath = path.join(platformDir, entry.name);
        const destPath = path.join(resourcesPath, entry.name);

        if (entry.isDirectory()) {
          copyDir(srcPath, destPath);
        } else if (!entry.isSymbolicLink()) {
          if (shouldSkipLinuxResource(srcPath, entry.name)) { skipped++; continue; }
          fs.copyFileSync(srcPath, destPath);
          try { fs.chmodSync(destPath, 0o755); } catch {}
          copied++;
        }
      }

      if (skipped) console.log(`   [linux] skipped ${skipped} non-target helper files`);
      console.log(`   [ok] ${copied} files (app.asar + unpacked + resources)`);
    },
  },
};

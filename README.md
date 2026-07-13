# Codex Desktop Rebuild

Cross-platform Electron build for OpenAI Codex Desktop App.

## Supported Platforms

| Platform | Architecture | Status |
|----------|--------------|--------|
| macOS    | x64, arm64   | ✅     |
| Windows  | x64          | ✅     |
| Linux    | x64, arm64   | ✅     |

## Build

```bash
# Install dependencies
npm install

# Build for current platform
npm run build

# Build for specific platform
npm run build:mac-x64
npm run build:mac-arm64
npm run build:win-x64
npm run build:linux-x64
npm run build:linux-arm64

# Build all platforms
npm run build:all
```

## Development

```bash
npm run dev
```

## Windows updater

Windows full-package downloads are written to `update-cache/<file>.partial`
beside Squirrel's managed `packages` directory and resume with HTTP Range after
a network failure or app restart. Existing partial downloads from the former
`packages` location are migrated automatically. The completed package is
checked against the size and SHA1 from `RELEASES` before Squirrel is allowed to
install it. The verified package is then served to Squirrel from a tokenized
loopback-only feed, so the native updater does not download the same GitHub
asset a second time even if Squirrel recreates its `packages` directory.

The update popup also provides an optional acceleration-prefix field. Values
entered there are saved locally, may contain multiple HTTP(S) prefixes separated
by commas or semicolons, and are tried before the direct GitHub URL for that
download. Leave the field empty to use the automatic GitHub-direct-then-proxy
strategy below.

Environment overrides remain available for deployment:

```powershell
# Use a trusted mirror as the complete update feed
$env:CODEX_REBUILD_UPDATE_URL = "https://mirror.example/windows-update-feed"

# Override proxy prefixes; use an empty value to disable proxy fallback
$env:CODEX_REBUILD_UPDATE_PROXY_PREFIXES = "https://ghfast.top/;https://gh-proxy.com/"

# Try configured proxies before the direct GitHub URL
$env:CODEX_REBUILD_UPDATE_PROXY_FIRST = "1"
```

Proxy downloads are never trusted by transport alone: package size and SHA1
must still match the direct `RELEASES` manifest.

## Project Structure

```
├── src/
│   ├── .vite/build/     # Main process (Electron)
│   └── webview/         # Renderer (Frontend)
├── resources/
│   ├── electron.icns    # App icon
│   └── notification.wav # Sound
├── scripts/
│   └── patch-copyright.js
├── forge.config.js      # Electron Forge config
└── package.json
```

## CI/CD

GitHub Actions automatically builds on:
- Push to `master`
- Tag `v*` → Creates draft release

## Credits

**© OpenAI · Cometix Space**

- [OpenAI Codex](https://github.com/openai/codex) - Original Codex CLI (Apache-2.0)
- [Cometix Space](https://github.com/Haleclipse) - Cross-platform rebuild & [@cometix/codex](https://www.npmjs.com/package/@cometix/codex) binaries
- [Electron Forge](https://www.electronforge.io/) - Build toolchain

## License

This project rebuilds the Codex Desktop app for cross-platform distribution.
Original Codex CLI by OpenAI is licensed under Apache-2.0.

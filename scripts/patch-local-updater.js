#!/usr/bin/env node
/**
 * patch-local-updater.js - Enable the CodexDesktop-Rebuild Windows updater.
 *
 * Upstream updater support is intentionally disabled by patch-updater.js so the
 * rebuilt app never updates itself back to the official OpenAI/MS Store build.
 * This patch adds a small Windows-only Squirrel updater bootstrap that points to
 * this project's own release feed.
 */
const fs = require("fs");
const path = require("path");
const { relPath, SRC_DIR } = require("./patch-util");

const DEFAULT_WINDOWS_UPDATE_URL =
  "https://gaq152.github.io/CodexDesktop-Rebuild/updates/win32/x64";
const START_MARKER = "/* CodexRebuildLocalUpdater:start */";
const END_MARKER = "/* CodexRebuildLocalUpdater:end */";
const FILE_END_MARKER = "/* CodexRebuildLocalUpdater:file-end */";

function updatePackageMetadata() {
  const pkgPath = path.join(SRC_DIR, "win", "_asar", "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.log("  [ok] Windows ASAR package metadata not found");
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  if (pkg.codexRebuildWindowsUpdateUrl === DEFAULT_WINDOWS_UPDATE_URL) {
    console.log(`  [ok] ${relPath(pkgPath)}: update URL already present`);
    return;
  }

  pkg.codexRebuildWindowsUpdateUrl = DEFAULT_WINDOWS_UPDATE_URL;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  console.log(`  [ok] ${relPath(pkgPath)}: added update URL metadata`);
}

function makeBootstrapPrefix() {
  return `${START_MARKER}
function CodexRebuildWindowsBootstrap(){
  if(process.platform!==\`win32\`)return!1;
  let electron,path,childProcess;
  try{
    electron=require(\`electron\`);
    path=require(\`node:path\`);
    childProcess=require(\`node:child_process\`);
  }catch{
    return!1;
  }
  let {app,autoUpdater,dialog}=electron;
  let squirrelEvent=process.argv.find(arg=>arg===\`--squirrel-install\`||arg===\`--squirrel-updated\`||arg===\`--squirrel-uninstall\`||arg===\`--squirrel-obsolete\`);
  let isSquirrelEvent=squirrelEvent===\`--squirrel-install\`||squirrelEvent===\`--squirrel-updated\`||squirrelEvent===\`--squirrel-uninstall\`||squirrelEvent===\`--squirrel-obsolete\`;
  if(isSquirrelEvent){
    try{
      let appFolder=path.resolve(process.execPath,\`..\`);
      let rootFolder=path.resolve(appFolder,\`..\`);
      let updateExe=path.resolve(path.join(rootFolder,\`Update.exe\`));
      let exeName=path.basename(process.execPath);
      if(squirrelEvent===\`--squirrel-install\`||squirrelEvent===\`--squirrel-updated\`){
        try{
          let fs=require(\`node:fs\`);
          for(let name of fs.readdirSync(appFolder)){
            if(name.toLowerCase().endsWith(\`.manifest\`)){
              fs.copyFileSync(path.join(appFolder,name),path.join(rootFolder,name));
            }
          }
        }catch{}
        childProcess.spawn(updateExe,[\`--createShortcut\`,exeName],{detached:!0,stdio:\`ignore\`}).unref();
      }else if(squirrelEvent===\`--squirrel-uninstall\`){
        childProcess.spawn(updateExe,[\`--removeShortcut\`,exeName],{detached:!0,stdio:\`ignore\`}).unref();
      }
    }catch{}
    setTimeout(()=>app.quit(),1000);
    return!0;
  }
  app.whenReady().then(()=>CodexRebuildSetupLocalUpdater(app,autoUpdater,dialog)).catch(()=>{});
  return!1;
}
function CodexRebuildSetupLocalUpdater(app,autoUpdater,dialog){
  if(process.platform!==\`win32\`||!app.isPackaged)return;
  if(process.env.CODEX_REBUILD_DISABLE_UPDATES===\`1\`)return;
  let fs,path;
  try{fs=require(\`node:fs\`),path=require(\`node:path\`)}catch{return}
  let updateExe=path.resolve(path.join(path.dirname(process.execPath),\`..\`,\`Update.exe\`));
  if(!fs.existsSync(updateExe))return;
  let metadata={};
  try{metadata=require(\`../../package.json\`)}catch{}
  let updateUrl=(process.env.CODEX_REBUILD_UPDATE_URL||metadata.codexRebuildWindowsUpdateUrl||\`${DEFAULT_WINDOWS_UPDATE_URL}\`).trim();
  if(!updateUrl)return;
  let locale=(app.getLocale?.()||\`\`).toLowerCase();
  let zh=locale.startsWith(\`zh\`);
  let strings=zh?{
    readyTitle:\`Codex 更新已就绪\`,
    readyMessage:\`新版本已经下载完成。\`,
    readyDetail:\`重启 Codex 后会自动完成安装。\`,
    restart:\`重启并安装\`,
    later:\`稍后\`,
  }:{
    readyTitle:\`Codex update ready\`,
    readyMessage:\`A new version has been downloaded.\`,
    readyDetail:\`Restart Codex to finish installing it.\`,
    restart:\`Restart and install\`,
    later:\`Later\`,
  };
  let checking=!1,downloaded=!1;
  let reset=()=>{checking=!1};
  autoUpdater.on(\`update-available\`,()=>{checking=!1});
  autoUpdater.on(\`update-not-available\`,reset);
  autoUpdater.on(\`error\`,e=>{checking=!1;console.warn(\`[CodexRebuildUpdater] update check failed\`,e&&e.message?e.message:e)});
  autoUpdater.on(\`update-downloaded\`,()=>{
    checking=!1;
    if(downloaded)return;
    downloaded=!0;
    dialog.showMessageBox({
      type:\`info\`,
      buttons:[strings.restart,strings.later],
      defaultId:0,
      cancelId:1,
      noLink:!0,
      title:strings.readyTitle,
      message:strings.readyMessage,
      detail:strings.readyDetail,
    }).then(({response})=>{if(response===0)autoUpdater.quitAndInstall()}).catch(()=>{});
  });
  try{autoUpdater.setFeedURL({url:updateUrl})}catch(e){console.warn(\`[CodexRebuildUpdater] invalid update feed\`,e&&e.message?e.message:e);return}
  let check=()=>{
    if(checking||downloaded)return;
    checking=!0;
    try{autoUpdater.checkForUpdates()}catch(e){checking=!1;console.warn(\`[CodexRebuildUpdater] checkForUpdates failed\`,e&&e.message?e.message:e)}
  };
  let firstDelay=process.argv.includes(\`--squirrel-firstrun\`)?30000:10000;
  let firstTimer=setTimeout(check,firstDelay);
  let interval=setInterval(check,21600000);
  firstTimer.unref?.();
  interval.unref?.();
}
${END_MARKER}
if(!CodexRebuildWindowsBootstrap()){
`;
}

function unwrapPatchedBootstrap(code) {
  const prefixAnchor = `${END_MARKER}\nif(!CodexRebuildWindowsBootstrap()){\n`;
  const prefixEnd = code.indexOf(prefixAnchor);
  const suffixAnchor = `\n}\n${FILE_END_MARKER}`;
  const suffixStart = code.lastIndexOf(suffixAnchor);
  if (!code.startsWith(START_MARKER) || prefixEnd === -1 || suffixStart === -1) {
    return null;
  }
  return code.slice(prefixEnd + prefixAnchor.length, suffixStart);
}

function patchBootstrap() {
  const bootstrapPath = path.join(SRC_DIR, "win", "_asar", ".vite", "build", "bootstrap.js");
  if (!fs.existsSync(bootstrapPath)) {
    console.log("  [ok] Windows bootstrap not found");
    return;
  }

  const code = fs.readFileSync(bootstrapPath, "utf-8");
  if (code.includes(START_MARKER)) {
    const original = unwrapPatchedBootstrap(code);
    if (original == null) {
      console.log(`  [ok] ${relPath(bootstrapPath)}: local updater already patched`);
      return;
    }
    const patched = `${makeBootstrapPrefix()}${original}
}
${FILE_END_MARKER}
`;
    if (patched === code) {
      console.log(`  [ok] ${relPath(bootstrapPath)}: local updater already patched`);
      return;
    }
    fs.writeFileSync(bootstrapPath, patched, "utf-8");
    console.log(`  [ok] ${relPath(bootstrapPath)}: refreshed local Windows updater`);
    return;
  }

  const patched = `${makeBootstrapPrefix()}${code}
}
${FILE_END_MARKER}
`;
  fs.writeFileSync(bootstrapPath, patched, "utf-8");
  console.log(`  [ok] ${relPath(bootstrapPath)}: added local Windows updater`);
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win", "unix"].includes(a));
  if (platform && platform !== "win") {
    console.log("  [ok] Local updater patch only applies to Windows");
    return;
  }

  updatePackageMetadata();
  patchBootstrap();
}

main();

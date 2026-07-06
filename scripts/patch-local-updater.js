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
const PRELOAD_START_MARKER = "/* CodexRebuildUpdaterPreload:start */";
const PRELOAD_END_MARKER = "/* CodexRebuildUpdaterPreload:end */";

function updatePackageMetadata() {
  const pkgPath = path.join(SRC_DIR, "win", "_asar", "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.log("  [ok] Windows ASAR package metadata not found");
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const updateUrl = (process.env.CODEX_REBUILD_UPDATE_URL || DEFAULT_WINDOWS_UPDATE_URL).trim();
  if (pkg.codexRebuildWindowsUpdateUrl === updateUrl) {
    console.log(`  [ok] ${relPath(pkgPath)}: update URL already present`);
    return;
  }

  pkg.codexRebuildWindowsUpdateUrl = updateUrl;
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
  let {app,autoUpdater,dialog,ipcMain,BrowserWindow}=electron;
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
  app.whenReady().then(()=>CodexRebuildSetupLocalUpdater(app,autoUpdater,dialog,ipcMain,BrowserWindow)).catch(()=>{});
  return!1;
}
function CodexRebuildSetupLocalUpdater(app,autoUpdater,dialog,ipcMain,BrowserWindow){
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
    checking:\`正在检查更新...\`,
    alreadyReady:\`更新已下载完成，重启 Codex 后会自动安装。\`,
  }:{
    readyTitle:\`Codex update ready\`,
    readyMessage:\`A new version has been downloaded.\`,
    readyDetail:\`Restart Codex to finish installing it.\`,
    restart:\`Restart and install\`,
    later:\`Later\`,
    checking:\`Checking for updates...\`,
    alreadyReady:\`The update has already been downloaded. Restart Codex to install it.\`,
  };
  let checking=!1,downloading=!1,downloaded=!1,manualCheck=!1,transientTimer=null;
  let state={
    status:\`idle\`,
    feedUrl:updateUrl,
    version:app.getVersion?.()||null,
    updateVersion:null,
    lastCheckedAt:null,
    error:null,
  };
  let emit=()=>{
    let payload={...state};
    try{
      for(let win of BrowserWindow?.getAllWindows?.()??[]){
        if(!win.isDestroyed?.())win.webContents?.send?.(\`codex_rebuild:update-state\`,payload);
      }
    }catch{}
    return payload;
  };
  let setStatus=(status,extra={},transientMs=0)=>{
    if(transientTimer!=null){clearTimeout(transientTimer);transientTimer=null}
    state={...state,status,...extra};
    emit();
    if(transientMs>0){
      transientTimer=setTimeout(()=>{
        transientTimer=null;
        if(state.status===status)setStatus(\`idle\`,{error:null});
      },transientMs);
      transientTimer.unref?.();
    }
  };
  let check=manual=>{
    if(downloaded){
      setStatus(\`ready\`);
      if(manual)dialog.showMessageBox({
        type:\`info\`,
        buttons:[strings.restart,strings.later],
        defaultId:0,
        cancelId:1,
        noLink:!0,
        title:strings.readyTitle,
        message:strings.readyMessage,
        detail:strings.alreadyReady,
      }).then(({response})=>{if(response===0)autoUpdater.quitAndInstall()}).catch(()=>{});
      return emit();
    }
    if(checking||downloading){
      if(manual){
        if(checking)manualCheck=!0;
        setStatus(checking?\`checking\`:\`downloading\`,{error:null});
      }
      return emit();
    }
    checking=!0;
    manualCheck=manual===!0;
    setStatus(\`checking\`,{error:null});
    try{autoUpdater.checkForUpdates()}catch(e){
      checking=!1;
      downloading=!1;
      let message=e&&e.message?e.message:String(e);
      console.warn(\`[CodexRebuildUpdater] checkForUpdates failed\`,message);
      setStatus(manualCheck?\`error\`:\`idle\`,{error:message,lastCheckedAt:Date.now()},manualCheck?8000:0);
      manualCheck=!1;
    }
    return emit();
  };
  let reset=()=>{
    checking=!1;
    downloading=!1;
    let manual=manualCheck;
    manualCheck=!1;
    setStatus(manual?\`no-update\`:\`idle\`,{error:null,lastCheckedAt:Date.now()},manual?6000:0);
  };
  try{
    if(ipcMain&&!globalThis.__CodexRebuildUpdaterIpcRegistered){
      globalThis.__CodexRebuildUpdaterIpcRegistered=!0;
      ipcMain.handle(\`codex_rebuild:update-command\`,async(_event,request)=>{
        let command=typeof request===\`string\`?request:request?.command;
        if(command===\`get-state\`)return emit();
        if(command===\`check\`)return check(!0);
        if(command===\`install\`){
          if(downloaded){autoUpdater.quitAndInstall();return emit()}
          return check(!0);
        }
        return emit();
      });
    }
  }catch(e){console.warn(\`[CodexRebuildUpdater] ipc setup failed\`,e&&e.message?e.message:e)}
  autoUpdater.on(\`checking-for-update\`,()=>{checking=!0;setStatus(\`checking\`,{error:null})});
  autoUpdater.on(\`update-available\`,info=>{checking=!1;downloading=!0;setStatus(\`downloading\`,{error:null,updateVersion:info?.version||null})});
  autoUpdater.on(\`update-not-available\`,reset);
  autoUpdater.on(\`error\`,e=>{checking=!1;downloading=!1;let message=e&&e.message?e.message:String(e);console.warn(\`[CodexRebuildUpdater] update check failed\`,message);let manual=manualCheck;manualCheck=!1;setStatus(manual?\`error\`:\`idle\`,{error:message,lastCheckedAt:Date.now()},manual?8000:0)});
  autoUpdater.on(\`update-downloaded\`,()=>{
    checking=!1;
    downloading=!1;
    if(downloaded)return;
    downloaded=!0;
    setStatus(\`ready\`,{error:null,lastCheckedAt:Date.now()});
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
  let firstDelay=process.argv.includes(\`--squirrel-firstrun\`)?30000:10000;
  let firstTimer=setTimeout(()=>check(!1),firstDelay);
  let interval=setInterval(()=>check(!1),21600000);
  firstTimer.unref?.();
  interval.unref?.();
}
${END_MARKER}
if(!CodexRebuildWindowsBootstrap()){
`;
}

function makePreloadPatch() {
  return `${PRELOAD_START_MARKER}
;(()=>{try{
  const channelState='codex_rebuild:update-state';
  const channelCommand='codex_rebuild:update-command';
  const listeners=new Set;
  const updaterApi={
    getState:()=>e.ipcRenderer.invoke(channelCommand,{command:'get-state'}),
    checkForUpdates:()=>e.ipcRenderer.invoke(channelCommand,{command:'check'}),
    installUpdate:()=>e.ipcRenderer.invoke(channelCommand,{command:'install'}),
    onState:t=>{if(typeof t!=='function')return()=>{};listeners.add(t);return()=>listeners.delete(t)}
  };
  e.ipcRenderer.on(channelState,(_event,state)=>{for(const listener of listeners){try{listener(state)}catch{}}});
  try{e.contextBridge.exposeInMainWorld('codexRebuildUpdater',updaterApi)}catch{}
  const ready=t=>{document.readyState==='loading'?window.addEventListener('DOMContentLoaded',t,{once:true}):t()};
  ready(()=>{
    if(window.__codexRebuildUpdaterUiInstalled)return;
    window.__codexRebuildUpdaterUiInstalled=true;
    const zh=((navigator.language||'zh').toLowerCase()).startsWith('zh');
    const text=zh?{
      idle:'检查更新',
      checking:'检查中...',
      downloading:'正在下载更新...',
      ready:'重启安装',
      noUpdate:'已是最新版本',
      error:'检查失败',
      tooltipIdle:'检查 Codex 更新',
      tooltipChecking:'正在检查更新',
      tooltipDownloading:'发现新版本，正在后台下载',
      tooltipReady:'更新已就绪，点击重启并安装',
      tooltipNoUpdate:'当前已经是最新版本',
      tooltipError:'更新检查失败，点击重试'
    }:{
      idle:'Check updates',
      checking:'Checking...',
      downloading:'Downloading update...',
      ready:'Restart to update',
      noUpdate:'Up to date',
      error:'Update failed',
      tooltipIdle:'Check for Codex updates',
      tooltipChecking:'Checking for updates',
      tooltipDownloading:'A new version is downloading in the background',
      tooltipReady:'Update ready. Click to restart and install',
      tooltipNoUpdate:'Codex is up to date',
      tooltipError:'Update check failed. Click to retry'
    };
    const host=document.createElement('div');
    host.id='codex-rebuild-updater';
    const root=host.attachShadow?host.attachShadow({mode:'open'}):host;
    const style=document.createElement('style');
    style.textContent=[
      ':host{position:fixed;top:8px;right:138px;z-index:2147483647;pointer-events:none;-webkit-app-region:no-drag;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      'button{-webkit-app-region:no-drag;user-select:none;pointer-events:auto;height:28px;max-width:min(260px,calc(100vw - 180px));display:inline-flex;align-items:center;gap:7px;border-radius:7px;border:1px solid color-mix(in srgb,var(--color-token-border-default,#4b5563) 70%,transparent);background:color-mix(in srgb,var(--color-token-main-surface-primary,#111827) 86%,transparent);color:var(--color-token-text-secondary,#c4c7c5);box-shadow:0 8px 24px rgba(0,0,0,.18);backdrop-filter:blur(10px);font-size:12px;font-weight:500;line-height:1;padding:0 10px;opacity:.62;transition:opacity .16s ease,background .16s ease,border-color .16s ease,color .16s ease,transform .16s ease;white-space:nowrap;overflow:hidden;cursor:pointer}',
      'button:hover{opacity:1;background:color-mix(in srgb,var(--color-token-main-surface-primary,#111827) 96%,white 4%);transform:translateY(1px)}',
      '.mark{width:7px;height:7px;border-radius:999px;background:currentColor;opacity:.75;flex:0 0 auto}',
      '.label{overflow:hidden;text-overflow:ellipsis}',
      '.checking,.downloading{color:var(--color-token-text-primary,#f3f4f6);opacity:.9}',
      '.checking .mark,.downloading .mark{width:10px;height:10px;border:2px solid currentColor;border-top-color:transparent;background:transparent;animation:codex-rebuild-spin .8s linear infinite}',
      '.ready{color:#10b981;border-color:color-mix(in srgb,#10b981 55%,transparent);background:color-mix(in srgb,#10b981 14%,var(--color-token-main-surface-primary,#111827));opacity:1}',
      '.no-update{color:#60a5fa;border-color:color-mix(in srgb,#60a5fa 45%,transparent);opacity:1}',
      '.error{color:#ef4444;border-color:color-mix(in srgb,#ef4444 55%,transparent);background:color-mix(in srgb,#ef4444 12%,var(--color-token-main-surface-primary,#111827));opacity:1}',
      '@keyframes codex-rebuild-spin{to{transform:rotate(360deg)}}',
      '@media(max-width:720px){:host{right:96px}.label{display:none}button{width:28px;padding:0;justify-content:center}}'
    ].join('\\n');
    const button=document.createElement('button');
    button.type='button';
    button.innerHTML='<span class="mark" aria-hidden="true"></span><span class="label"></span>';
    root.append(style,button);
    document.documentElement.appendChild(host);
    const label=button.querySelector('.label');
    let current={status:'idle'};
    const render=state=>{
      current=state||current||{status:'idle'};
      const status=current.status||'idle';
      button.className=status;
      label.textContent=text[status]||text.idle;
      button.title=current.error&&status==='error'?text.tooltipError+': '+current.error:(text['tooltip'+status.charAt(0).toUpperCase()+status.slice(1)]||text.tooltipIdle);
      button.setAttribute('aria-label',button.title);
    };
    button.addEventListener('click',()=>{
      if((current?.status)==='ready')updaterApi.installUpdate().catch(()=>{});
      else updaterApi.checkForUpdates().catch(()=>{});
    });
    updaterApi.onState(render);
    let attempts=0;
    const requestInitialState=()=>updaterApi.getState().then(render).catch(()=>{
      attempts+=1;
      if(attempts<20)setTimeout(requestInitialState,250);
      else host.remove();
    });
    requestInitialState();
  });
}catch{}})();
${PRELOAD_END_MARKER}`;
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

function patchPreload() {
  const preloadPath = path.join(SRC_DIR, "win", "_asar", ".vite", "build", "preload.js");
  if (!fs.existsSync(preloadPath)) {
    console.log("  [ok] Windows preload not found");
    return;
  }

  const patch = makePreloadPatch();
  const code = fs.readFileSync(preloadPath, "utf-8");
  if (code.includes(PRELOAD_START_MARKER)) {
    const start = code.indexOf(PRELOAD_START_MARKER);
    const end = code.indexOf(PRELOAD_END_MARKER, start);
    if (end === -1) {
      console.log(`  [ok] ${relPath(preloadPath)}: updater UI already patched`);
      return;
    }
    const next = code.slice(0, start) + patch + code.slice(end + PRELOAD_END_MARKER.length);
    if (next === code) {
      console.log(`  [ok] ${relPath(preloadPath)}: updater UI already patched`);
      return;
    }
    fs.writeFileSync(preloadPath, next, "utf-8");
    console.log(`  [ok] ${relPath(preloadPath)}: refreshed updater UI bridge`);
    return;
  }

  const sourceMap = "\n//# sourceMappingURL=preload.js.map";
  const next = code.includes(sourceMap)
    ? code.replace(sourceMap, `\n${patch}${sourceMap}`)
    : `${code}\n${patch}\n`;
  fs.writeFileSync(preloadPath, next, "utf-8");
  console.log(`  [ok] ${relPath(preloadPath)}: added updater UI bridge`);
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
  patchPreload();
}

main();

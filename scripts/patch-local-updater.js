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
const acorn = require("acorn");
const { SRC_DIR } = require("./patch-util");

const DEFAULT_WINDOWS_UPDATE_URL =
  "https://github.com/Gaq152/CodexDesktop-Rebuild/releases/download/windows-update-feed";
const LOCAL_UPDATER_CONTRACT_VERSION = 1;
const START_MARKER = "/* CodexRebuildLocalUpdater:start */";
const END_MARKER = "/* CodexRebuildLocalUpdater:end */";
const FILE_END_MARKER = "/* CodexRebuildLocalUpdater:file-end */";
const PRELOAD_START_MARKER = "/* CodexRebuildUpdaterPreload:start */";
const PRELOAD_END_MARKER = "/* CodexRebuildUpdaterPreload:end */";
const MAIN_MENU_START_MARKER = "/* CodexRebuildUpdaterMainMenu:start */";
const MAIN_MENU_END_MARKER = "/* CodexRebuildUpdaterMainMenu:end */";
const WEBVIEW_COMPONENT_START_MARKER =
  "/* CodexRebuildUpdaterTitlebar:component:start */";
const WEBVIEW_COMPONENT_END_MARKER =
  "/* CodexRebuildUpdaterTitlebar:component:end */";
const WEBVIEW_DESCRIPTOR_START_MARKER =
  "/* CodexRebuildUpdaterTitlebar:descriptor:start */";
const WEBVIEW_DESCRIPTOR_END_MARKER =
  "/* CodexRebuildUpdaterTitlebar:descriptor:end */";
const WEBVIEW_UPDATER_MENU_ID = "codex-rebuild-updater-top";
const WEBVIEW_MENU_BAR_MESSAGE =
  "{id:`windowsMenuBar.checkUpdates`,defaultMessage:`检查更新`,description:`Label for the update menu in the desktop application menu bar`}";
const WEBVIEW_MENU_BAR_ITEM =
  `{id:'codex-rebuild-updater-top',message:${WEBVIEW_MENU_BAR_MESSAGE}}`;

function layerVersionMarker(layer, version = LOCAL_UPDATER_CONTRACT_VERSION) {
  return `/* CodexRebuildLocalUpdater:${layer}:v${version} */`;
}

function makeSquirrelLifecycleBlock(
  legacyV1 = false,
  detachedV1 = false,
  unboundedV1 = false,
) {
  if (legacyV1) {
    return `  let squirrelEvent=process.argv.find(arg=>arg===\`--squirrel-install\`||arg===\`--squirrel-updated\`||arg===\`--squirrel-uninstall\`||arg===\`--squirrel-obsolete\`);
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
  }`;
  }
  if (detachedV1) {
    return `  let squirrelEvent=process.argv.find(arg=>arg===\`--squirrel-install\`||arg===\`--squirrel-updated\`||arg===\`--squirrel-uninstall\`||arg===\`--squirrel-obsolete\`);
  let isSquirrelEvent=squirrelEvent===\`--squirrel-install\`||squirrelEvent===\`--squirrel-updated\`||squirrelEvent===\`--squirrel-uninstall\`||squirrelEvent===\`--squirrel-obsolete\`;
  if(isSquirrelEvent){
    try{
      let appFolder=path.resolve(process.execPath,\`..\`);
      let rootFolder=path.resolve(appFolder,\`..\`);
      let updateExe=path.resolve(path.join(rootFolder,\`Update.exe\`));
      let exeName=path.basename(process.execPath);
      let legacyExeName=\`Codex.exe\`;
      if(squirrelEvent===\`--squirrel-install\`||squirrelEvent===\`--squirrel-updated\`){
        try{
          let fs=require(\`node:fs\`);
          let currentManifests=fs.readdirSync(appFolder).filter(name=>/^\\d+(?:\\.\\d+)+\\.manifest$/i.test(name));
          for(let name of fs.readdirSync(rootFolder)){
            if(/^\\d+(?:\\.\\d+)+\\.manifest$/i.test(name)&&!currentManifests.some(currentManifest=>name.toLowerCase()===currentManifest.toLowerCase())){
              fs.rmSync(path.join(rootFolder,name),{force:!0});
            }
          }
          for(let currentManifest of currentManifests){
            fs.copyFileSync(path.join(appFolder,currentManifest),path.join(rootFolder,currentManifest));
          }
        }catch{}
        if(exeName.toLowerCase()!==legacyExeName.toLowerCase()){
          childProcess.spawn(updateExe,[\`--removeShortcut\`,legacyExeName],{detached:!0,stdio:\`ignore\`}).unref();
        }
        childProcess.spawn(updateExe,[\`--createShortcut\`,exeName],{detached:!0,stdio:\`ignore\`}).unref();
      }else if(squirrelEvent===\`--squirrel-uninstall\`){
        childProcess.spawn(updateExe,[\`--removeShortcut\`,exeName],{detached:!0,stdio:\`ignore\`}).unref();
        if(exeName.toLowerCase()!==legacyExeName.toLowerCase()){
          childProcess.spawn(updateExe,[\`--removeShortcut\`,legacyExeName],{detached:!0,stdio:\`ignore\`}).unref();
        }
      }
    }catch{}
    setTimeout(()=>app.quit(),1000);
    return!0;
  }`;
  }
  const shortcutCommandRunner = unboundedV1
    ? `      let runShortcutCommand=args=>new Promise((resolve,reject)=>{
        let child=childProcess.spawn(updateExe,args,{windowsHide:!0,stdio:\`ignore\`});
        child.once(\`error\`,reject);
        child.once(\`exit\`,code=>code===0?resolve():reject(new Error(\`Update.exe exited with code \${code}\`)));
      });`
    : `      let runShortcutCommand=args=>new Promise((resolve,reject)=>{
        let child=childProcess.spawn(updateExe,args,{windowsHide:!0,stdio:\`ignore\`});
        let settled=!1;
        let finish=error=>{
          if(settled)return;
          settled=!0;
          clearTimeout(timer);
          child.removeListener(\`error\`,onError);
          child.removeListener(\`exit\`,onExit);
          error?reject(error):resolve();
        };
        let onError=error=>finish(error);
        let onExit=code=>code===0?finish():finish(new Error(\`Update.exe exited with code \${code}\`));
        let timer=setTimeout(()=>{
          try{child.kill()}catch{}
          finish(new Error(\`Shortcut command timed out: \${args.join(\` \`)}\`));
        },15000);
        child.once(\`error\`,onError);
        child.once(\`exit\`,onExit);
      });`;
  return `  let squirrelEvent=process.argv.find(arg=>arg===\`--squirrel-install\`||arg===\`--squirrel-updated\`||arg===\`--squirrel-uninstall\`||arg===\`--squirrel-obsolete\`);
  let isSquirrelEvent=squirrelEvent===\`--squirrel-install\`||squirrelEvent===\`--squirrel-updated\`||squirrelEvent===\`--squirrel-uninstall\`||squirrelEvent===\`--squirrel-obsolete\`;
  if(isSquirrelEvent){
    try{
      let appFolder=path.resolve(process.execPath,\`..\`);
      let rootFolder=path.resolve(appFolder,\`..\`);
      let updateExe=path.resolve(path.join(rootFolder,\`Update.exe\`));
      let exeName=path.basename(process.execPath);
      let legacyExeName=\`Codex.exe\`;
      if(squirrelEvent===\`--squirrel-install\`||squirrelEvent===\`--squirrel-updated\`){
        try{
          let fs=require(\`node:fs\`);
          let currentManifests=fs.readdirSync(appFolder).filter(name=>/^\\d+(?:\\.\\d+)+\\.manifest$/i.test(name));
          for(let name of fs.readdirSync(rootFolder)){
            if(/^\\d+(?:\\.\\d+)+\\.manifest$/i.test(name)&&!currentManifests.some(currentManifest=>name.toLowerCase()===currentManifest.toLowerCase())){
              fs.rmSync(path.join(rootFolder,name),{force:!0});
            }
          }
          for(let currentManifest of currentManifests){
            fs.copyFileSync(path.join(appFolder,currentManifest),path.join(rootFolder,currentManifest));
          }
        }catch{}
      }
${shortcutCommandRunner}
      (async()=>{
        if(squirrelEvent===\`--squirrel-install\`||squirrelEvent===\`--squirrel-updated\`){
          if(exeName.toLowerCase()!==legacyExeName.toLowerCase()){
            await runShortcutCommand([\`--removeShortcut\`,legacyExeName]);
          }
          await runShortcutCommand([\`--createShortcut\`,exeName]);
        }else if(squirrelEvent===\`--squirrel-uninstall\`){
          await runShortcutCommand([\`--removeShortcut\`,exeName]);
          if(exeName.toLowerCase()!==legacyExeName.toLowerCase()){
            await runShortcutCommand([\`--removeShortcut\`,legacyExeName]);
          }
        }
      })().catch(e=>{try{console.warn('[CodexRebuildUpdater] shortcut lifecycle failed',e&&e.message?e.message:e)}catch{}}).finally(()=>app.quit());
    }catch(e){
      try{console.warn('[CodexRebuildUpdater] shortcut lifecycle failed',e&&e.message?e.message:e)}catch{}
      app.quit();
    }
    return!0;
  }`;
}

function makeBootstrapPrefix(
  version = LOCAL_UPDATER_CONTRACT_VERSION,
  { legacyLifecycle = false, detachedLifecycle = false, unboundedLifecycle = false } = {},
) {
  const versionLine = version == null ? "" : `${layerVersionMarker("backend", version)}\n`;
  return `${START_MARKER}
${versionLine}function CodexRebuildWindowsBootstrap(){
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
${makeSquirrelLifecycleBlock(legacyLifecycle, detachedLifecycle, unboundedLifecycle)}
  app.whenReady().then(()=>CodexRebuildSetupLocalUpdater(app,autoUpdater,dialog,ipcMain,BrowserWindow)).catch(e=>{try{console.warn('[CodexRebuildUpdater] setup failed',e&&e.message?e.message:e)}catch{}});
  return!1;
}
function CodexRebuildSetupLocalUpdater(app,autoUpdater,dialog,ipcMain,BrowserWindow){
  if(process.platform!==\`win32\`||!app.isPackaged)return;
  if(process.env.CODEX_REBUILD_DISABLE_UPDATES===\`1\`)return;
  let fs,path,http,https,urlMod;
  try{fs=require('node:fs'),path=require('node:path'),http=require('node:http'),https=require('node:https'),urlMod=require('node:url')}catch{return}
  let appDir=path.dirname(process.execPath);
  let rootDir=path.resolve(appDir,'..');
  let packagesDir=path.join(rootDir,'packages');
  let updateExe=path.resolve(path.join(rootDir,'Update.exe'));
  if(!fs.existsSync(updateExe))return;
  let metadata={};
  try{metadata=require('../../package.json')}catch{}
  let updateUrl=(process.env.CODEX_REBUILD_UPDATE_URL||metadata.codexRebuildWindowsUpdateUrl||'${DEFAULT_WINDOWS_UPDATE_URL}').trim();
  if(!updateUrl)return;
  let getInstalledVersion=()=>path.basename(appDir).match(/^app-(.+)$/)?.[1]||app.getVersion?.()||null;
  let compareVersions=(a,b)=>{
    let aa=String(a||'').split(/[^0-9]+/).filter(Boolean).map(Number);
    let bb=String(b||'').split(/[^0-9]+/).filter(Boolean).map(Number);
    for(let i=0;i<Math.max(aa.length,bb.length);i++){
      let x=aa[i]||0,y=bb[i]||0;
      if(x!==y)return x-y;
    }
    return 0;
  };
  let parseReleaseVersion=name=>name?.match(/^Codex-(.+?)-(?:full|delta)\\.nupkg$/i)?.[1]||null;
  let parseReleases=text=>{
    let byVersion=new Map();
    for(let line of String(text||'').split(/\\r?\\n/)){
      let parts=line.trim().split(/\\s+/);
      if(parts.length<3)continue;
      let fileName=parts[1],size=Number(parts[2]);
      let kind=/-delta\\.nupkg$/i.test(fileName)?'delta':/-full\\.nupkg$/i.test(fileName)?'full':null;
      if(!kind)continue;
      let version=parseReleaseVersion(fileName);
      if(!version||!Number.isFinite(size))continue;
      let release=byVersion.get(version)||{version,fileName:null,size:null,files:[]};
      let item={fileName,size,kind};
      release.files.push(item);
      if(kind==='full'){
        release.fileName=fileName;
        release.size=size;
      }
      byVersion.set(version,release);
    }
    let best=null;
    for(let release of byVersion.values()){
      if(!release.fileName)continue;
      if(best==null||compareVersions(release.version,best.version)>0)best=release;
    }
    return best;
  };
  let fetchText=(target,redirects=0)=>new Promise((resolve,reject)=>{
    let client=target.startsWith('http:')?http:https;
    let req=client.get(target,res=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location&&redirects<5){
        res.resume();
        let next=new urlMod.URL(res.headers.location,target).toString();
        fetchText(next,redirects+1).then(resolve,reject);
        return;
      }
      if(res.statusCode<200||res.statusCode>=300){
        res.resume();
        reject(Error('HTTP '+res.statusCode));
        return;
      }
      let chunks=[],size=0;
      res.on('data',chunk=>{
        size+=chunk.length;
        if(size>5*1024*1024){req.destroy(Error('RELEASES too large'));return}
        chunks.push(chunk);
      });
      res.on('end',()=>{
        let text=Buffer.concat(chunks).toString('utf8');
        if(text.charCodeAt(0)===65279)text=text.slice(1);
        resolve(text);
      });
    });
    req.setTimeout(30000,()=>req.destroy(Error('timeout')));
    req.on('error',reject);
  });
  let releasesUrl=()=>{
    let base=updateUrl.replace(/\\/+$/,'')+'/RELEASES';
    let u=new urlMod.URL(base);
    u.searchParams.set('id','Codex');
    u.searchParams.set('localVersion',getInstalledVersion()||'');
    u.searchParams.set('arch',process.arch==='x64'?'amd64':process.arch);
    u.searchParams.set('t',String(Date.now()));
    return u.toString();
  };
  let checking=!1,downloading=!1,downloaded=!1,downloadRequested=!1,transientTimer=null,progressTimer=null;
  let state={
    status:'idle',
    feedUrl:updateUrl,
    version:getInstalledVersion(),
    appVersion:app.getVersion?.()||null,
    updateVersion:null,
    updateFile:null,
    updateFiles:null,
    updateSize:null,
    activeDownloadFile:null,
    activeDownloadSize:null,
    downloadedBytes:null,
    downloadStartedAt:null,
    elapsedMs:null,
    lastCheckedAt:null,
    error:null,
  };
  let emit=()=>{
    let payload={...state};
    try{globalThis.__CodexRebuildUpdaterLastState=payload;globalThis.__CodexRebuildUpdaterMenuSetState?.(payload)}catch{}
    try{
      for(let win of BrowserWindow?.getAllWindows?.()??[]){
        if(!win.isDestroyed?.())win.webContents?.send?.('codex_rebuild:update-state',payload);
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
        if(state.status===status)setStatus('idle',{error:null});
      },transientMs);
      transientTimer.unref?.();
    }
  };
  let isDownloadComplete=(done,total)=>{
    let d=Number(done),t=Number(total);
    return Number.isFinite(d)&&Number.isFinite(t)&&t>0&&d>=t;
  };
  let updateProgress=()=>{
    if(!downloading)return;
    let file=state.activeDownloadFile||state.updateFile||(state.updateVersion?('Codex-'+state.updateVersion+'-full.nupkg'):null);
    let activeDownloadSize=state.activeDownloadSize||state.updateSize||null;
    let downloadedBytes=state.downloadedBytes||0;
    if(file){
      try{
        let p=path.join(packagesDir,file);
        if(fs.existsSync(p)){
          downloadedBytes=fs.statSync(p).size;
          let known=state.updateFiles?.find?.(item=>item.fileName===file)?.size;
          if(Number.isFinite(known))activeDownloadSize=known;
        }else if(state.updateVersion&&fs.existsSync(packagesDir)){
          let prefix='Codex-'+state.updateVersion+'-';
          let match=fs.readdirSync(packagesDir).filter(name=>name.startsWith(prefix)&&/\\.nupkg$/i.test(name)).sort((a,b)=>{
            try{return fs.statSync(path.join(packagesDir,b)).mtimeMs-fs.statSync(path.join(packagesDir,a)).mtimeMs}catch{return 0}
          })[0];
          if(match){
            file=match;
            downloadedBytes=fs.statSync(path.join(packagesDir,match)).size;
            let known=state.updateFiles?.find?.(item=>item.fileName===match)?.size;
            if(Number.isFinite(known))activeDownloadSize=known;
          }
        }
      }catch{}
    }
    let elapsedMs=state.downloadStartedAt?Date.now()-state.downloadStartedAt:null;
    setStatus(isDownloadComplete(downloadedBytes,activeDownloadSize)?'preparing':'downloading',{downloadedBytes,elapsedMs,activeDownloadFile:file,activeDownloadSize});
  };
  let startProgress=()=>{
    if(progressTimer!=null)clearInterval(progressTimer);
    updateProgress();
    progressTimer=setInterval(updateProgress,1000);
    progressTimer.unref?.();
  };
  let stopProgress=()=>{
    if(progressTimer!=null){clearInterval(progressTimer);progressTimer=null}
  };
  let checkOnly=async manual=>{
    if(downloaded){setStatus('ready');return emit()}
    if(checking||downloading)return emit();
    checking=!0;
    setStatus('checking',{error:null,version:getInstalledVersion()});
    try{
      let release=parseReleases(await fetchText(releasesUrl()));
      checking=!1;
      let current=getInstalledVersion();
      if(release&&compareVersions(release.version,current)>0){
        setStatus('available',{
          error:null,
          version:current,
          updateVersion:release.version,
          updateFile:release.fileName,
          updateFiles:release.files||null,
          updateSize:release.size,
          activeDownloadFile:null,
          activeDownloadSize:null,
          downloadedBytes:null,
          downloadStartedAt:null,
          elapsedMs:null,
          lastCheckedAt:Date.now(),
        });
      }else{
        setStatus(manual?'no-update':'idle',{
          error:null,
          version:current,
          updateVersion:null,
          updateFile:null,
          updateFiles:null,
          updateSize:null,
          activeDownloadFile:null,
          activeDownloadSize:null,
          downloadedBytes:null,
          downloadStartedAt:null,
          elapsedMs:null,
          lastCheckedAt:Date.now(),
        },manual?6000:0);
      }
    }catch(e){
      checking=!1;
      let message=e&&e.message?e.message:String(e);
      console.warn('[CodexRebuildUpdater] update check failed',message);
      setStatus(manual?'error':'idle',{error:message,lastCheckedAt:Date.now()});
    }
    return emit();
  };
  let startDownload=()=>{
    if(downloaded){setStatus('ready');return emit()}
    if(downloading)return emit();
    downloadRequested=!0;
    checking=!1;
    downloading=!0;
    let started=Date.now();
    setStatus('downloading',{error:null,downloadStartedAt:started,downloadedBytes:0,elapsedMs:0,version:getInstalledVersion()});
    startProgress();
    try{autoUpdater.checkForUpdates()}catch(e){
      downloading=!1;
      downloadRequested=!1;
      stopProgress();
      let message=e&&e.message?e.message:String(e);
      console.warn('[CodexRebuildUpdater] update download failed',message);
      setStatus('error',{error:message,lastCheckedAt:Date.now()});
    }
    return emit();
  };
  let installUpdate=()=>{
    if(downloaded){autoUpdater.quitAndInstall();return emit()}
    return startDownload();
  };
  let clearStatus=()=>{
    checking=!1;
    downloading=!1;
    downloadRequested=!1;
    stopProgress();
    setStatus('idle',{error:null,updateVersion:null,updateFile:null,updateFiles:null,updateSize:null,activeDownloadFile:null,activeDownloadSize:null,downloadedBytes:null,downloadStartedAt:null,elapsedMs:null});
    return emit();
  };
  globalThis.__CodexRebuildUpdaterCommand={check:()=>checkOnly(!0),download:startDownload,install:installUpdate,clear:clearStatus};
  try{
    if(ipcMain&&!globalThis.__CodexRebuildUpdaterIpcRegistered){
      globalThis.__CodexRebuildUpdaterIpcRegistered=!0;
      ipcMain.handle('codex_rebuild:update-command',async(_event,request)=>{
        let command=typeof request==='string'?request:request?.command;
        if(command==='get-state')return emit();
        if(command==='check')return checkOnly(!0);
        if(command==='download')return startDownload();
        if(command==='clear')return clearStatus();
        if(command==='install'){
          return installUpdate();
        }
        return emit();
      });
    }
  }catch(e){console.warn('[CodexRebuildUpdater] ipc setup failed',e&&e.message?e.message:e)}
  autoUpdater.on('checking-for-update',()=>{if(downloadRequested)setStatus('downloading',{error:null});else setStatus('checking',{error:null})});
  autoUpdater.on('update-available',info=>{
    checking=!1;
    downloading=!0;
    downloadRequested=!0;
    setStatus('downloading',{error:null,updateVersion:state.updateVersion||info?.version||null,downloadStartedAt:state.downloadStartedAt||Date.now()});
    startProgress();
  });
  autoUpdater.on('update-not-available',()=>{
    checking=!1;
    downloading=!1;
    downloadRequested=!1;
    stopProgress();
    setStatus('no-update',{error:null,lastCheckedAt:Date.now()},6000);
  });
  autoUpdater.on('error',e=>{
    checking=!1;
    downloading=!1;
    downloadRequested=!1;
    stopProgress();
    let message=e&&e.message?e.message:String(e);
    console.warn('[CodexRebuildUpdater] update failed',message);
    setStatus('error',{error:message,lastCheckedAt:Date.now()});
  });
  autoUpdater.on('update-downloaded',()=>{
    checking=!1;
    downloading=!1;
    downloadRequested=!1;
    stopProgress();
    if(downloaded)return;
    downloaded=!0;
    setStatus('ready',{error:null,downloadedBytes:state.activeDownloadSize??state.updateSize??state.downloadedBytes,lastCheckedAt:Date.now()});
  });
  try{autoUpdater.setFeedURL({url:updateUrl})}catch(e){console.warn(\`[CodexRebuildUpdater] invalid update feed\`,e&&e.message?e.message:e);return}
  let firstDelay=process.argv.includes(\`--squirrel-firstrun\`)?30000:10000;
  let firstTimer=setTimeout(()=>checkOnly(!1),firstDelay);
  let interval=setInterval(()=>checkOnly(!1),21600000);
  firstTimer.unref?.();
  interval.unref?.();
}
${END_MARKER}
if(!CodexRebuildWindowsBootstrap()){
`;
}

function makePreloadPatch(
  electronAlias = "e",
  version = LOCAL_UPDATER_CONTRACT_VERSION,
) {
  const versionLine = version == null ? "" : `${layerVersionMarker("preload", version)}\n`;
  return `${PRELOAD_START_MARKER}
${versionLine};(()=>{try{
  const channelState='codex_rebuild:update-state';
  const channelCommand='codex_rebuild:update-command';
  const listeners=new Set;
  const invoke=command=>${electronAlias}.ipcRenderer.invoke(channelCommand,{command});
  const updaterApi={
    getState:()=>invoke('get-state'),
    checkForUpdates:()=>invoke('check'),
    downloadUpdate:()=>invoke('download'),
    installUpdate:()=>invoke('install'),
    clearUpdateState:()=>invoke('clear'),
    onState:t=>{if(typeof t!=='function')return()=>{};listeners.add(t);return()=>listeners.delete(t)}
  };
  ${electronAlias}.ipcRenderer.on(channelState,(_event,state)=>{for(const listener of listeners){try{listener(state)}catch{}}});
  try{${electronAlias}.contextBridge.exposeInMainWorld('codexRebuildUpdater',updaterApi)}catch{}
}catch{}})();
${PRELOAD_END_MARKER}`;
}

function makeMainMenuPatch(
  electronAlias = "a",
  version = LOCAL_UPDATER_CONTRACT_VERSION,
) {
  const versionLine = version == null ? "" : `${layerVersionMarker("main-menu", version)}\n`;
  const patch = `${MAIN_MENU_START_MARKER}
${versionLine}(()=>{
  let codexRebuildUpdaterIds={
    top:'codex-rebuild-updater-top',
    status:'codex-rebuild-updater-status',
    current:'codex-rebuild-updater-current-version',
    next:'codex-rebuild-updater-next-version',
    size:'codex-rebuild-updater-package-size',
    progress:'codex-rebuild-updater-progress',
    downloaded:'codex-rebuild-updater-downloaded',
    elapsed:'codex-rebuild-updater-elapsed',
    error:'codex-rebuild-updater-error',
    check:'codex-rebuild-updater-action-check',
    download:'codex-rebuild-updater-action-download',
    install:'codex-rebuild-updater-action-install',
    retry:'codex-rebuild-updater-action-retry',
    clear:'codex-rebuild-updater-action-clear'
  };
  let codexRebuildUpdaterState=globalThis.__CodexRebuildUpdaterLastState||{status:'idle'};
  let codexRebuildUpdaterUnknown='-';
  let codexRebuildUpdaterFormatVersion=value=>value?String(value):codexRebuildUpdaterUnknown;
  let codexRebuildUpdaterFormatBytes=value=>{
    let n=Number(value);
    if(!Number.isFinite(n)||n<=0)return codexRebuildUpdaterUnknown;
    let units=['B','KB','MB','GB'],size=n,index=0;
    while(size>=1024&&index<units.length-1){size/=1024;index+=1}
    let digits=index===0?0:size>=100?0:size>=10?1:2;
    return size.toFixed(digits)+' '+units[index];
  };
  let codexRebuildUpdaterFormatElapsed=value=>{
    let ms=Number(value);
    if(!Number.isFinite(ms)||ms<0)return codexRebuildUpdaterUnknown;
    let total=Math.floor(ms/1000),minutes=Math.floor(total/60),seconds=total%60;
    return minutes>0?minutes+'分'+String(seconds).padStart(2,'0')+'秒':seconds+'秒';
  };
  let codexRebuildUpdaterProgress=state=>{
    let total=Number(state.activeDownloadSize||state.updateSize),done=Number(state.downloadedBytes);
    if(!Number.isFinite(total)||total<=0||!Number.isFinite(done)||done<0)return null;
    return Math.max(0,Math.min(100,done/total*100));
  };
  let codexRebuildUpdaterLabel=state=>{
    let status=state.status||'idle';
    if(status==='checking')return '检查中...';
    if(status==='available')return '有新版本';
    if(status==='downloading'){
      let pct=codexRebuildUpdaterProgress(state);
      return pct==null?'下载中':'下载中 '+Math.floor(pct)+'%';
    }
    if(status==='preparing')return '准备中';
    if(status==='ready')return '重启安装';
    if(status==='no-update')return '已是最新';
    if(status==='error')return '检查失败';
    return '检查更新';
  };
  let codexRebuildUpdaterStatusText=state=>{
    let status=state.status||'idle';
    if(status==='checking')return '正在检查更新';
    if(status==='available')return '发现新版本，确认后开始下载';
    if(status==='downloading')return '正在下载更新';
    if(status==='preparing')return '下载完成，正在准备安装';
    if(status==='ready')return '更新已下载，可以重启安装';
    if(status==='no-update')return '当前已是最新版本';
    if(status==='error')return '检查更新失败';
    return '未检查更新';
  };
  let codexRebuildUpdaterMenuItem=id=>{
    try{return a.Menu.getApplicationMenu?.()?.getMenuItemById?.(id)||null}catch{return null}
  };
  let codexRebuildUpdaterSetMenuItem=(id,props)=>{
    let item=codexRebuildUpdaterMenuItem(id);
    if(!item)return;
    for(let [key,value] of Object.entries(props)){
      try{item[key]=value}catch{}
    }
  };
  let codexRebuildUpdaterSetRow=(id,visible,label)=>{
    codexRebuildUpdaterSetMenuItem(id,{visible,enabled:false,label});
  };
  let codexRebuildUpdaterApplyState=state=>{
    codexRebuildUpdaterState={...codexRebuildUpdaterState,...(state||{})};
    let s=codexRebuildUpdaterState,status=s.status||'idle';
    globalThis.__CodexRebuildUpdaterLastState=s;
    let pct=codexRebuildUpdaterProgress(s);
    let showVersion=status==='available'||status==='downloading'||status==='preparing'||status==='ready'||status==='checking';
    let showDownload=status==='downloading'||status==='preparing';
    codexRebuildUpdaterSetMenuItem(codexRebuildUpdaterIds.top,{label:codexRebuildUpdaterLabel(s)});
    codexRebuildUpdaterSetMenuItem(codexRebuildUpdaterIds.status,{label:codexRebuildUpdaterStatusText(s)});
    codexRebuildUpdaterSetRow(codexRebuildUpdaterIds.current,showVersion,'当前版本: '+codexRebuildUpdaterFormatVersion(s.version||s.appVersion));
    codexRebuildUpdaterSetRow(codexRebuildUpdaterIds.next,!!s.updateVersion,'新版本: '+codexRebuildUpdaterFormatVersion(s.updateVersion));
    codexRebuildUpdaterSetRow(codexRebuildUpdaterIds.size,!!(s.updateSize||s.activeDownloadSize),'更新包: '+codexRebuildUpdaterFormatBytes(s.updateSize||s.activeDownloadSize));
    codexRebuildUpdaterSetRow(codexRebuildUpdaterIds.progress,showDownload,'进度: '+(pct==null?codexRebuildUpdaterUnknown:Math.floor(pct)+'%'));
    codexRebuildUpdaterSetRow(codexRebuildUpdaterIds.downloaded,showDownload,'已下载: '+codexRebuildUpdaterFormatBytes(s.downloadedBytes)+' / '+codexRebuildUpdaterFormatBytes(s.activeDownloadSize||s.updateSize));
    codexRebuildUpdaterSetRow(codexRebuildUpdaterIds.elapsed,showDownload,'耗时: '+codexRebuildUpdaterFormatElapsed(s.elapsedMs));
    codexRebuildUpdaterSetRow(codexRebuildUpdaterIds.error,status==='error','错误信息: '+(s.error||'未知错误'));
    codexRebuildUpdaterSetMenuItem(codexRebuildUpdaterIds.check,{visible:status==='idle'||status==='no-update',enabled:status!=='checking'});
    codexRebuildUpdaterSetMenuItem(codexRebuildUpdaterIds.download,{visible:status==='available',enabled:status==='available'});
    codexRebuildUpdaterSetMenuItem(codexRebuildUpdaterIds.install,{visible:status==='ready',enabled:status==='ready'});
    codexRebuildUpdaterSetMenuItem(codexRebuildUpdaterIds.retry,{visible:status==='error',enabled:status==='error'});
    codexRebuildUpdaterSetMenuItem(codexRebuildUpdaterIds.clear,{visible:status==='error',enabled:status==='error'});
    return s;
  };
  globalThis.__CodexRebuildUpdaterMenuSetState=codexRebuildUpdaterApplyState;
  let codexRebuildSendUpdaterFallback=(status,extra={})=>{
    let payload={status,feedUrl:null,version:null,appVersion:null,updateVersion:null,updateFile:null,updateFiles:null,updateSize:null,activeDownloadFile:null,activeDownloadSize:null,downloadedBytes:null,downloadStartedAt:null,elapsedMs:null,lastCheckedAt:Date.now(),error:null,...extra};
    codexRebuildUpdaterApplyState(payload);
    try{for(let win of a.BrowserWindow.getAllWindows()){if(!win.isDestroyed?.())win.webContents?.send?.(\`codex_rebuild:update-state\`,payload)}}catch{}
    return payload;
  };
  let codexRebuildRunUpdaterCommand=(name,checkingStatus)=>{
    if(checkingStatus)codexRebuildSendUpdaterFallback(checkingStatus);
    try{
      let command=globalThis.__CodexRebuildUpdaterCommand?.[name];
      let result=command?.();
      if(result){result.then?.(codexRebuildUpdaterApplyState)?.catch?.(e=>codexRebuildSendUpdaterFallback('error',{error:e&&e.message?e.message:String(e)}));return}
    }catch(e){
      codexRebuildSendUpdaterFallback('error',{error:e&&e.message?e.message:String(e)});
      return;
    }
    codexRebuildSendUpdaterFallback('error',{error:'更新组件尚未初始化，请重启应用后再试'});
  };
  setTimeout(()=>{try{codexRebuildUpdaterApplyState(codexRebuildUpdaterState)}catch{}},0);
  return {
    helpItems:[],
    topItems:[
      {id:'codex-rebuild-updater-top',label:'检查更新',submenu:[
        {id:'codex-rebuild-updater-status',label:'未检查更新',enabled:false},
        {type:'separator'},
        {id:'codex-rebuild-updater-current-version',label:'当前版本: -',enabled:false,visible:false},
        {id:'codex-rebuild-updater-next-version',label:'新版本: -',enabled:false,visible:false},
        {id:'codex-rebuild-updater-package-size',label:'更新包: -',enabled:false,visible:false},
        {id:'codex-rebuild-updater-progress',label:'进度: -',enabled:false,visible:false},
        {id:'codex-rebuild-updater-downloaded',label:'已下载: -',enabled:false,visible:false},
        {id:'codex-rebuild-updater-elapsed',label:'耗时: -',enabled:false,visible:false},
        {id:'codex-rebuild-updater-error',label:'错误信息: -',enabled:false,visible:false},
        {type:'separator'},
        {id:'codex-rebuild-updater-action-check',label:'立即检查更新',click:()=>{codexRebuildRunUpdaterCommand('check','checking')}},
        {id:'codex-rebuild-updater-action-download',label:'下载更新',visible:false,click:()=>{codexRebuildRunUpdaterCommand('download','downloading')}},
        {id:'codex-rebuild-updater-action-install',label:'重启安装',visible:false,click:()=>{codexRebuildRunUpdaterCommand('install',null)}},
        {id:'codex-rebuild-updater-action-retry',label:'重试',visible:false,click:()=>{codexRebuildRunUpdaterCommand('check','checking')}},
        {id:'codex-rebuild-updater-action-clear',label:'取消',visible:false,click:()=>{codexRebuildRunUpdaterCommand('clear','idle')}}
      ]}
    ]
  }
})()
${MAIN_MENU_END_MARKER}`;
  return patch.replace(/\ba\.(Menu|BrowserWindow)\b/g, `${electronAlias}.$1`);
}

function walkAst(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "type") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit);
    } else {
      walkAst(value, visit);
    }
  }
}

function walkAstWithAncestors(node, visit, ancestors = []) {
  if (!node || typeof node.type !== "string") return;
  visit(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "type") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkAstWithAncestors(child, visit, nextAncestors);
    } else {
      walkAstWithAncestors(value, visit, nextAncestors);
    }
  }
}

function nearestLexicalScope(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const node = ancestors[index];
    if (
      node.type === "Program" ||
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      return node;
    }
  }
  return null;
}

function propertyName(node) {
  if (!node || node.type !== "Property") return null;
  if (!node.computed && node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "Literal") return String(node.key.value);
  return null;
}

function literalValue(node) {
  if (!node) return null;
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function analyzeMainMenuCode(code) {
  const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "script" });
  const declarations = new Map();
  const buildCalls = [];
  walkAst(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      declarations.set(node.id.name, node);
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "buildFromTemplate" &&
      node.callee.object.type === "MemberExpression" &&
      !node.callee.object.computed &&
      node.callee.object.property.type === "Identifier" &&
      node.callee.object.property.name === "Menu" &&
      node.callee.object.object.type === "Identifier" &&
      node.arguments.length === 1 &&
      node.arguments[0].type === "Identifier"
    ) {
      buildCalls.push(node);
    }
  });

  const shapes = [];
  for (const buildCall of buildCalls) {
    const template = declarations.get(buildCall.arguments[0].name);
    if (!template || template.init?.type !== "ArrayExpression") continue;
    const helpObjects = template.init.elements.filter((element) => {
      if (element?.type !== "ObjectExpression") return false;
      return element.properties.some(
        (property) => propertyName(property) === "role" && literalValue(property.value) === "help",
      );
    });
    for (const helpObject of helpObjects) {
      const submenu = helpObject.properties.find(
        (property) => propertyName(property) === "submenu" && property.value.type === "ArrayExpression",
      )?.value;
      if (!submenu) continue;
      const extensionSpreads = submenu.elements.filter((element) => {
        if (element?.type !== "SpreadElement" || element.argument.type !== "Identifier") return false;
        const declaration = declarations.get(element.argument.name);
        return declaration?.init?.type === "ArrayExpression" && declaration.init.elements.length === 0;
      });
      if (extensionSpreads.length !== 1) continue;
      const extensionSpread = extensionSpreads[0];
      shapes.push({
        electronAlias: buildCall.callee.object.object.name,
        extensionName: extensionSpread.argument.name,
        extensionInit: declarations.get(extensionSpread.argument.name).init,
        extensionSpread,
        templateArray: template.init,
      });
    }
  }
  if (shapes.length !== 1) {
    throw new Error(`expected one Windows main menu shape, found ${shapes.length}`);
  }
  return shapes[0];
}

function applyReplacements(code, replacements) {
  let next = code;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    next = next.slice(0, replacement.start) + replacement.text + next.slice(replacement.end);
  }
  return next;
}

function firstDifferenceIndex(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? -1 : length;
}

function countOccurrences(source, token) {
  return source.split(token).length - 1;
}

function memberProperty(node) {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return literalValue(node.property);
}

function isMemberOf(node, objectName, property) {
  return (
    node?.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === objectName &&
    memberProperty(node) === property
  );
}

function hasMainMenuSignature(code) {
  return [
    MAIN_MENU_START_MARKER,
    MAIN_MENU_END_MARKER,
    layerVersionMarker("main-menu"),
    "codex-rebuild-updater-top",
    "__CodexRebuildUpdaterMenuSetState",
  ].some((signature) => code.includes(signature));
}

function inspectUpdaterMainMenuSource(code, { allowLegacy = false } = {}) {
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error("Windows main menu source is empty");
  }
  const range = markerRange(
    code,
    MAIN_MENU_START_MARKER,
    MAIN_MENU_END_MARKER,
    "Windows main menu",
  );
  const ast = parseJavaScript(code, "Windows main menu", "script");
  const declarations = [];
  walkAstWithAncestors(ast, (node, ancestors) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      declarations.push({ declaration: node, scope: nearestLexicalScope(ancestors) });
    }
  });
  const extensionDeclarations = declarations.filter(
    ({ declaration, scope }) =>
      declaration.init &&
      declaration.init.start >= range.start &&
      declaration.init.end <= range.end &&
      !(scope && scope.start >= range.start && scope.end <= range.end),
  );
  if (extensionDeclarations.length !== 1) {
    throw new Error(
      `Windows main menu canonical block expected one executable binding, found ${extensionDeclarations.length}`,
    );
  }
  const { declaration: extension, scope: extensionScope } = extensionDeclarations[0];
  const extensionName = extension.id.name;
  const attachments = [];
  walkAstWithAncestors(ast, (node, ancestors) => {
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "MemberExpression" ||
      memberProperty(node.callee) !== "buildFromTemplate" ||
      node.callee.object.type !== "MemberExpression" ||
      memberProperty(node.callee.object) !== "Menu" ||
      node.callee.object.object.type !== "Identifier" ||
      node.arguments.length !== 1 ||
      node.arguments[0].type !== "Identifier"
    ) {
      return;
    }
    const callScope = nearestLexicalScope(ancestors);
    if (callScope !== extensionScope) return;
    const templates = declarations.filter(
      ({ declaration, scope }) =>
        scope === extensionScope &&
        declaration.id.name === node.arguments[0].name &&
        declaration.init?.type === "ArrayExpression",
    );
    for (const { declaration: template } of templates) {
      const topSpreads = template.init.elements.filter(
        (element) =>
          element?.type === "SpreadElement" &&
          isMemberOf(element.argument, extensionName, "topItems"),
      );
      const helpSpreads = [];
      for (const element of template.init.elements) {
        if (element?.type !== "ObjectExpression") continue;
        const isHelp = element.properties.some(
          (property) =>
            propertyName(property) === "role" && literalValue(property.value) === "help",
        );
        if (!isHelp) continue;
        const submenu = element.properties.find(
          (property) => propertyName(property) === "submenu",
        )?.value;
        if (submenu?.type !== "ArrayExpression") continue;
        helpSpreads.push(
          ...submenu.elements.filter(
            (item) =>
              item?.type === "SpreadElement" &&
              isMemberOf(item.argument, extensionName, "helpItems"),
          ),
        );
      }
      if (topSpreads.length === 1 && helpSpreads.length === 1) {
        attachments.push({
          electronAlias: node.callee.object.object.name,
          templateName: template.id.name,
        });
      }
    }
  });
  if (attachments.length !== 1) {
    throw new Error(
      `Windows main menu canonical block is not attached to exactly one live template (found ${attachments.length})`,
    );
  }
  const electronAlias = attachments[0].electronAlias;
  const candidates = [
    {
      dialect: "current",
      version: LOCAL_UPDATER_CONTRACT_VERSION,
      block: makeMainMenuPatch(electronAlias),
      versionMarker: layerVersionMarker("main-menu"),
    },
  ];
  if (allowLegacy) {
    candidates.push(
      {
        dialect: "v0",
        version: 0,
        block: makeMainMenuPatch(electronAlias, 0),
        versionMarker: layerVersionMarker("main-menu", 0),
      },
      {
        dialect: "versionless",
        version: null,
        block: makeMainMenuPatch(electronAlias, null),
      },
    );
  }
  const candidate = candidates.find((item) => item.block === range.code);
  if (!candidate) {
    throw new Error("Windows main menu canonical block bytes or version do not match");
  }
  const versions = updaterVersionSignatures(code);
  const expectedVersions = candidate.versionMarker ? [candidate.versionMarker] : [];
  if (
    versions.length !== expectedVersions.length ||
    versions.some((version, index) => version !== expectedVersions[index])
  ) {
    throw new Error("Windows main menu canonical block version is stale or mismatched");
  }
  const canonicalBlock = makeMainMenuPatch(electronAlias);
  return {
    layer: "mainMenu",
    version: candidate.version,
    dialect: candidate.dialect,
    electronAlias,
    extensionName,
    canonicalSource:
      code.slice(0, range.start) + canonicalBlock + code.slice(range.end),
  };
}

function validateUpdaterMainMenuSource(code) {
  return inspectUpdaterMainMenuSource(code);
}

function patchMainMenuCode(code) {
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error("Windows main menu source is empty");
  }
  if (hasMainMenuSignature(code)) {
    const inspection = inspectUpdaterMainMenuSource(code, { allowLegacy: true });
    if (inspection.dialect === "current") return code;
    validateUpdaterMainMenuSource(inspection.canonicalSource);
    return inspection.canonicalSource;
  }
  const shape = analyzeMainMenuCode(code);
  const patch = makeMainMenuPatch(shape.electronAlias);
  const next = applyReplacements(code, [
    { start: shape.extensionInit.start, end: shape.extensionInit.end, text: patch },
    {
      start: shape.extensionSpread.start,
      end: shape.extensionSpread.end,
      text: `...${shape.extensionName}.helpItems`,
    },
    {
      start: shape.templateArray.end - 1,
      end: shape.templateArray.end - 1,
      text: `,...${shape.extensionName}.topItems`,
    },
  ]);
  validateUpdaterMainMenuSource(next);
  return next;
}

function makeWebviewMenuBarFunctionBody() {
  return `function codexRebuildUpdaterEnsureTitlebarStyle(){let e='codex-rebuild-updater-titlebar-style';if(document.getElementById(e))return;let t=document.createElement('style');t.id=e,t.textContent=[
'.cru-anchor{--cru-success:var(--color-token-charts-green,#22c55e);--cru-error:var(--color-token-error-foreground,#ef4444);position:relative;display:inline-flex;align-items:center;-webkit-app-region:no-drag}',
'.cru-trigger{-webkit-app-region:no-drag;height:24px;min-width:72px;max-width:154px;display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--color-token-text-tertiary);padding:0 9px;font:500 12px/1 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden;cursor:pointer;transition:background .16s ease,border-color .16s ease,color .16s ease,box-shadow .16s ease,transform .12s ease}',
'.cru-trigger:hover,.cru-trigger.open{background:color-mix(in srgb,var(--color-token-foreground) 7%,transparent);color:var(--color-token-description-foreground)}',
'.cru-trigger:active{transform:translateY(1px)}',
'.cru-trigger:focus-visible{outline:2px solid color-mix(in srgb,var(--color-token-text-primary) 36%,transparent);outline-offset:2px}',
'.cru-trigger.available{border-color:color-mix(in srgb,var(--cru-success) 50%,transparent);background:color-mix(in srgb,var(--cru-success) 11%,transparent);color:var(--cru-success)}',
'.cru-trigger.ready{border-color:color-mix(in srgb,var(--cru-success) 58%,transparent);background:color-mix(in srgb,var(--cru-success) 14%,transparent);color:var(--cru-success)}',
'.cru-trigger.error{border-color:color-mix(in srgb,var(--cru-error) 55%,transparent);background:color-mix(in srgb,var(--cru-error) 12%,transparent);color:var(--cru-error)}',
'.cru-trigger.checking,.cru-trigger.downloading,.cru-trigger.preparing{border-color:color-mix(in srgb,var(--color-token-border-default) 70%,transparent);background:color-mix(in srgb,var(--color-token-foreground) 6%,transparent);color:var(--color-token-text-primary)}',
'.cru-trigger.downloading::after{content:"";position:absolute;left:8px;right:auto;bottom:1px;width:var(--cru-progress,0%);max-width:calc(100% - 16px);height:2px;border-radius:999px;background:var(--cru-success);transition:width .18s ease}',
'.cru-mark{position:relative;width:7px;height:7px;flex:0 0 7px;border-radius:999px;background:currentColor;opacity:.82}',
'.cru-trigger.checking .cru-mark,.cru-trigger.downloading .cru-mark,.cru-trigger.preparing .cru-mark{width:10px;height:10px;flex-basis:10px;border:2px solid currentColor;border-top-color:transparent;background:transparent;animation:cru-spin .85s linear infinite}',
'.cru-label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
'.cru-popover{-webkit-app-region:no-drag;position:absolute;top:31px;left:0;z-index:60;width:min(328px,calc(100vw - 24px));border:1px solid color-mix(in srgb,var(--color-token-border-default) 78%,transparent);border-radius:10px;background:color-mix(in srgb,var(--color-token-main-surface-primary) 96%,black 4%);color:var(--color-token-text-primary);box-shadow:0 18px 48px rgb(0 0 0 / .28);padding:12px;box-sizing:border-box;backdrop-filter:blur(18px);animation:cru-pop .14s ease-out;cursor:default}',
'.cru-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}',
'.cru-badge{display:flex;width:22px;height:22px;align-items:center;justify-content:center;border-radius:8px;background:color-mix(in srgb,var(--color-token-foreground) 7%,transparent);color:var(--color-token-text-secondary);flex:0 0 22px}',
'.cru-popover.available .cru-badge,.cru-popover.ready .cru-badge{background:color-mix(in srgb,var(--cru-success) 14%,transparent);color:var(--cru-success)}',
'.cru-popover.error .cru-badge{background:color-mix(in srgb,var(--cru-error) 14%,transparent);color:var(--cru-error)}',
'.cru-title{font-size:13px;font-weight:650;line-height:1.25;margin:0 0 3px}',
'.cru-body{font-size:12px;line-height:1.45;color:var(--color-token-text-secondary);margin:0}',
'.cru-grid{display:grid;gap:6px;margin-top:8px}',
'.cru-row{display:flex;min-height:22px;align-items:center;justify-content:space-between;gap:14px;color:var(--color-token-text-secondary);font-size:12px}',
'.cru-row strong{min-width:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:var(--color-token-text-primary);font-weight:550}',
'.cru-meter{height:6px;border-radius:999px;background:color-mix(in srgb,var(--color-token-border-default) 46%,transparent);overflow:hidden;margin:10px 0 4px}',
'.cru-meter span{display:block;height:100%;width:0;border-radius:inherit;background:var(--cru-success);transition:width .18s ease}',
'.cru-error{margin-top:8px;border:1px solid color-mix(in srgb,var(--cru-error) 42%,transparent);border-radius:8px;background:color-mix(in srgb,var(--cru-error) 9%,transparent);padding:8px;color:var(--color-token-text-primary);font-size:12px;line-height:1.45;word-break:break-word}',
'.cru-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}',
'.cru-action{-webkit-app-region:no-drag;height:28px;border:0;border-radius:7px;padding:0 11px;background:color-mix(in srgb,var(--color-token-foreground) 8%,transparent);color:var(--color-token-text-primary);font-size:12px;font-weight:560;cursor:pointer;transition:background .14s ease,transform .12s ease}',
'.cru-action:hover{background:color-mix(in srgb,var(--color-token-foreground) 13%,transparent)}',
'.cru-action:active{transform:translateY(1px)}',
'.cru-action.primary{background:var(--color-token-button-background,#15803d);color:var(--color-token-button-foreground,#fff)}.cru-action.primary:hover{background:var(--vscode-button-hoverBackground,#16a34a)}',
'.cru-action.danger{background:color-mix(in srgb,var(--cru-error) 18%,transparent);color:var(--cru-error)}.cru-action.danger:hover{background:color-mix(in srgb,var(--cru-error) 25%,transparent)}',
'.cru-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
'@keyframes cru-spin{to{transform:rotate(360deg)}}',
'@keyframes cru-pop{from{opacity:0;transform:translateY(-3px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}',
'@media (max-width:600px){.cru-popover{position:fixed;top:42px;left:12px;right:12px;width:auto;max-height:calc(100vh - 54px);overflow:auto}}',
'@media (prefers-reduced-motion: reduce){.cru-trigger,.cru-action,.cru-meter span,.cru-popover{transition:none;animation:none}.cru-trigger.checking .cru-mark,.cru-trigger.downloading .cru-mark,.cru-trigger.preparing .cru-mark{animation:none}}'
].join('\\n'),document.head.appendChild(t)}
function codexRebuildUpdaterFormatVersion(e){return e?String(e):'-'}
function codexRebuildUpdaterFormatBytes(e){let t=Number(e);if(!Number.isFinite(t)||t<=0)return'-';let n=['B','KB','MB','GB'],r=t,i=0;for(;r>=1024&&i<n.length-1;)r/=1024,i+=1;let a=i===0?0:r>=100?0:r>=10?1:2;return r.toFixed(a)+' '+n[i]}
function codexRebuildUpdaterFormatElapsed(e){let t=Number(e);if(!Number.isFinite(t)||t<0)return'-';let n=Math.floor(t/1000),r=Math.floor(n/60),i=n%60;return r>0?r+'分'+String(i).padStart(2,'0')+'秒':i+'秒'}
function codexRebuildUpdaterMenuBarProgress(e){let t=Number(e?.activeDownloadSize||e?.updateSize),n=Number(e?.downloadedBytes);return!Number.isFinite(t)||t<=0||!Number.isFinite(n)||n<0?null:Math.max(0,Math.min(100,n/t*100))}
function codexRebuildUpdaterMenuBarLabel(e){let t=e?.status||'idle';if(t==='checking')return'检查中...';if(t==='available')return'有新版本';if(t==='downloading'){let n=codexRebuildUpdaterMenuBarProgress(e);return n==null?'下载中':'下载中 '+Math.floor(n)+'%'}if(t==='preparing')return'准备中';if(t==='ready')return'重启安装';if(t==='no-update')return'已是最新';if(t==='error')return'检查失败';return'检查更新'}
function codexRebuildUpdaterStatusText(e){let t=e?.status||'idle';if(t==='checking')return'正在检查更新';if(t==='available')return'发现新版本';if(t==='downloading')return'正在下载更新';if(t==='preparing')return'正在准备安装';if(t==='ready')return'更新已下载';if(t==='no-update')return'当前已是最新版本';if(t==='error')return'检查更新失败';return'检查更新'}
function codexRebuildUpdaterDescription(e){let t=e?.status||'idle';if(t==='checking')return'正在连接更新源，请稍候。';if(t==='available')return'确认后开始下载，下载完成后可重启安装。';if(t==='downloading')return'下载会在后台继续，点击按钮可随时查看进度。';if(t==='preparing')return'下载已完成，正在准备安装包。';if(t==='ready')return'重启 Codex 后会自动完成安装。';if(t==='no-update')return'当前安装版本已经是最新。';if(t==='error')return'请重试，或取消后稍后再检查。';return'点击后立即检查是否有新版本。'}
function codexRebuildUpdaterBuildPanel(e,t){let n=e||{status:'idle'},r=n.status||'idle',i=codexRebuildUpdaterMenuBarProgress(n),a=i==null?0:Math.floor(i),o=codexRebuildUpdaterStatusText(n),s=codexRebuildUpdaterDescription(n),c=(e,t)=>(0,Zr.jsxs)('div',{className:'cru-row',children:[(0,Zr.jsx)('span',{children:e}),(0,Zr.jsx)('strong',{children:t})]}),l=(e,n,r='')=>(0,Zr.jsx)('button',{type:'button',className:'cru-action '+r,onClick:e=>{e.stopPropagation(),t(n)},children:e}),u=[c('当前版本',codexRebuildUpdaterFormatVersion(n.version||n.appVersion))];n.updateVersion&&u.push(c('新版本',codexRebuildUpdaterFormatVersion(n.updateVersion)));(n.updateSize||n.activeDownloadSize)&&u.push(c('更新包',codexRebuildUpdaterFormatBytes(n.updateSize||n.activeDownloadSize)));(r==='downloading'||r==='preparing')&&u.push(c('已下载',codexRebuildUpdaterFormatBytes(n.downloadedBytes)+' / '+codexRebuildUpdaterFormatBytes(n.activeDownloadSize||n.updateSize)));(r==='downloading'||r==='preparing')&&u.push(c('耗时',codexRebuildUpdaterFormatElapsed(n.elapsedMs)));let d=[];r==='idle'&&d.push(l('立即检查','check','primary'));r==='available'&&d.push(l('下载更新','download','primary'),l('稍后','close'));r==='ready'&&d.push(l('重启安装','install','primary'),l('稍后','close'));r==='error'&&d.push(l('重试','retry','primary'),l('取消','clear','danger'));(r==='checking'||r==='downloading'||r==='preparing'||r==='no-update')&&d.push(l('收起','close'));let f=(0,Zr.jsx)('span',{className:'cru-mark','aria-hidden':'true'});return(0,Zr.jsxs)('div',{className:'cru-popover '+r,role:'dialog','aria-label':'更新状态',onPointerDown:e=>e.stopPropagation(),children:[(0,Zr.jsx)('div',{className:'cru-live','aria-live':'polite',children:o}),(0,Zr.jsxs)('div',{className:'cru-head',children:[(0,Zr.jsx)('div',{className:'cru-badge','aria-hidden':'true',children:f}),(0,Zr.jsxs)('div',{children:[(0,Zr.jsx)('div',{className:'cru-title',children:o}),(0,Zr.jsx)('p',{className:'cru-body',children:s})]})]}),(r==='downloading'||r==='preparing')&&(0,Zr.jsx)('div',{className:'cru-meter','aria-label':'下载进度 '+a+'%',children:(0,Zr.jsx)('span',{style:{width:a+'%'}})}),(0,Zr.jsx)('div',{className:'cru-grid',children:u}),r==='error'&&(0,Zr.jsx)('div',{className:'cru-error',role:'alert',children:n.error||'未知错误'}),(0,Zr.jsx)('div',{className:'cru-actions',children:d})]})}
function Yr(){let e=D(),[t,n]=(0,Xr.useState)(null),[r,i]=(0,Xr.useState)({status:'idle'}),[a,o]=(0,Xr.useState)(false),s=(0,Xr.useRef)(0),c=(0,Xr.useRef)(null);(0,Xr.useEffect)(()=>{codexRebuildUpdaterEnsureTitlebarStyle();let e=window.codexRebuildUpdater;if(!e)return;let t=e=>{i(e||{status:'idle'})};e.getState?.().then(t).catch(()=>{});let n=e.onState?.(t);return typeof n==='function'?n:void 0},[]),(0,Xr.useEffect)(()=>{if(!a)return;let e=e=>{c.current?.contains?.(e.target)||o(!1)},t=e=>{e.key==='Escape'&&o(!1)};return document.addEventListener('pointerdown',e,!0),document.addEventListener('keydown',t,!0),()=>{document.removeEventListener('pointerdown',e,!0),document.removeEventListener('keydown',t,!0)}},[a]);if(!qr())return null;let l=async(e,t)=>{let r=window.electronBridge?.showApplicationMenu;if(!r)return;let i=s.current+1;s.current=i,n(e);let a=t.currentTarget.getBoundingClientRect();try{await r(e,Math.round(a.left),Math.round(a.bottom))}finally{s.current===i&&n(null)}},u=(e,t={})=>i(n=>({...n,...t,status:e})),d=e=>{let t=window.codexRebuildUpdater;if(e==='close'){o(!1);return}if(e==='clear'){o(!1),t?.clearUpdateState?.().then(i).catch(()=>{});return}if(e==='check'||e==='retry'){o(!0),u('checking',{error:null}),t?.checkForUpdates?.().then(i).catch(e=>u('error',{error:e&&e.message?e.message:String(e)}));return}if(e==='download'){o(!0),u('downloading',{error:null,downloadedBytes:0,elapsedMs:0}),t?.downloadUpdate?.().then(i).catch(e=>u('error',{error:e&&e.message?e.message:String(e)}));return}if(e==='install'){t?.installUpdate?.().catch(e=>u('error',{error:e&&e.message?e.message:String(e)}))}},f=e=>{let t=r?.status||'idle';if(t==='idle'){d('check');return}o(e=>!e)},p=codexRebuildUpdaterMenuBarLabel(r),m=codexRebuildUpdaterMenuBarProgress(r),h=m==null?0:Math.floor(m);return(0,Zr.jsx)('div',{className:'flex items-center gap-0.5 pr-2 pl-1',children:$r.map(({id:s,message:u})=>{if(s==='${WEBVIEW_UPDATER_MENU_ID}')return(0,Zr.jsxs)('div',{ref:c,className:'cru-anchor',children:[(0,Zr.jsxs)('button',{type:'button','aria-expanded':a,'aria-haspopup':'dialog','aria-label':p,className:'cru-trigger '+(r?.status||'idle')+(a?' open':''),style:{'--cru-progress':h+'%'},onClick:f,children:[(0,Zr.jsx)('span',{className:'cru-mark','aria-hidden':'true'}),(0,Zr.jsx)('span',{className:'cru-label',children:p})]}),a&&codexRebuildUpdaterBuildPanel(r,d)]},s);return(0,Zr.jsx)('button',{type:'button','aria-expanded':t===s,'aria-haspopup':'menu','aria-label':e.formatMessage(u),className:M('no-drag rounded-md border border-transparent px-2.5 py-1 text-base font-normal leading-none outline-none transition-colors',t===s?'bg-[var(--color-token-menubar-selection-background)] text-[var(--color-token-menubar-selection-foreground)]':'text-token-text-tertiary hover:bg-token-foreground/5 hover:text-token-description-foreground focus-visible:bg-token-foreground/5 focus-visible:text-token-description-foreground'),onClick:e=>{l(s,e)},children:(0,Zr.jsx)(w,{...u})},s)})})}`;
}

function makeWebviewMenuBarFunctionPatch(version = LOCAL_UPDATER_CONTRACT_VERSION) {
  const body = makeWebviewMenuBarFunctionBody();
  if (version == null) return body;
  return `${WEBVIEW_COMPONENT_START_MARKER}\n${layerVersionMarker(
    "titlebar-component",
    version,
  )}\n${body}\n${WEBVIEW_COMPONENT_END_MARKER}`;
}

function makeWebviewMenuDescriptorPatch(version = LOCAL_UPDATER_CONTRACT_VERSION) {
  if (version == null) return WEBVIEW_MENU_BAR_ITEM;
  return `{id:'${WEBVIEW_UPDATER_MENU_ID}',message:${makeWebviewMenuDescriptorBlock(version)}}`;
}

function makeWebviewMenuDescriptorBlock(version = LOCAL_UPDATER_CONTRACT_VERSION) {
  return `${WEBVIEW_DESCRIPTOR_START_MARKER}\n${layerVersionMarker(
    "titlebar-descriptor",
    version,
  )}\n${WEBVIEW_MENU_BAR_MESSAGE}\n${WEBVIEW_DESCRIPTOR_END_MARKER}`;
}

function sequenceMember(node, property) {
  if (node?.type !== "CallExpression" || node.callee.type !== "SequenceExpression") return null;
  const member = node.callee.expressions.at(-1);
  if (
    member?.type !== "MemberExpression" ||
    member.computed ||
    member.object.type !== "Identifier" ||
    member.property.type !== "Identifier" ||
    member.property.name !== property
  ) {
    return null;
  }
  return member.object.name;
}

function onlyValue(values, label) {
  const unique = [...new Set(values)];
  if (unique.length !== 1) throw new Error(`expected one ${label}, found ${unique.length}`);
  return unique[0];
}

function analyzeWebviewMenuBarCode(code) {
  const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
  const initializers = new Map();
  const candidates = [];
  walkAst(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
      initializers.set(node.id.name, node.init);
    }
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "Identifier"
    ) {
      initializers.set(node.left.name, node.right);
    }
    if (node.type === "FunctionDeclaration") {
      const source = code.slice(node.start, node.end);
      if (
        source.includes("showApplicationMenu") &&
        source.includes("formatMessage") &&
        source.includes("no-drag")
      ) {
        candidates.push(node);
      }
    }
  });
  if (candidates.length !== 1) {
    throw new Error(`expected one Windows webview menu-bar function, found ${candidates.length}`);
  }

  const menuFunction = candidates[0];
  const source = code.slice(menuFunction.start, menuFunction.end);
  const header = source.match(
    /^function\s+([A-Za-z_$][\w$]*)\(\)\{let\s+[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\(\),/,
  );
  const availability = source.match(/if\(!([A-Za-z_$][\w$]*)\(\)\)return null/);
  const classNames = source.match(/className:([A-Za-z_$][\w$]*)\(\s*[`'"]no-drag/);
  if (!header || !availability || !classNames) {
    throw new Error("Windows webview menu-bar structure is incomplete");
  }

  const reactAliases = [];
  const jsxAliases = [];
  const menuArrays = [];
  const iconAliases = [];
  walkAst(menuFunction, (node) => {
    const reactAlias = sequenceMember(node, "useState");
    if (reactAlias) reactAliases.push(reactAlias);
    const jsxAlias = sequenceMember(node, "jsx");
    if (jsxAlias) {
      jsxAliases.push(jsxAlias);
      if (
        node.arguments[0]?.type === "Identifier" &&
        node.arguments[1]?.type === "ObjectExpression" &&
        node.arguments[1].properties.some((property) => property.type === "SpreadElement")
      ) {
        iconAliases.push(node.arguments[0].name);
      }
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.object.type === "Identifier" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "map"
    ) {
      menuArrays.push(node.callee.object.name);
    }
  });

  const menuArrayName = onlyValue(menuArrays, "webview menu descriptor array");
  const menuArray = initializers.get(menuArrayName);
  if (menuArray?.type !== "ArrayExpression" || menuArray.elements.length < 4) {
    throw new Error("Windows webview menu descriptor array is missing");
  }
  return {
    functionName: header[1],
    intlHook: header[2],
    reactAlias: onlyValue(reactAliases, "React binding"),
    jsxAlias: onlyValue(jsxAliases, "JSX binding"),
    availabilityFunction: availability[1],
    classNamesFunction: classNames[1],
    iconAlias: onlyValue(iconAliases, "webview menu icon binding"),
    menuArrayName,
    menuArray,
    menuFunction,
  };
}

function bindWebviewMenuBarPatch(patch, shape) {
  let next = patch
    .replace("function Yr(){let e=D()", `function ${shape.functionName}(){let e=${shape.intlHook}()`)
    .replaceAll("Xr.", `${shape.reactAlias}.`)
    .replaceAll("Zr.", `${shape.jsxAlias}.`)
    .replace("if(!qr())", `if(!${shape.availabilityFunction}())`)
    .replace("children:$r.map", `children:${shape.menuArrayName}.map`)
    .replaceAll("className:M(", `className:${shape.classNamesFunction}(`);
  next = next.replace(
    `(0,${shape.jsxAlias}.jsx)(w,{...u})`,
    `(0,${shape.jsxAlias}.jsx)(${shape.iconAlias},{...u})`,
  );
  return next;
}

function hasTitlebarSignature(code) {
  return [
    WEBVIEW_COMPONENT_START_MARKER,
    WEBVIEW_COMPONENT_END_MARKER,
    WEBVIEW_DESCRIPTOR_START_MARKER,
    WEBVIEW_DESCRIPTOR_END_MARKER,
    "CodexRebuildLocalUpdater:titlebar-",
    "function codexRebuildUpdaterEnsureTitlebarStyle",
    "{id:'codex-rebuild-updater-top',message:",
  ].some((signature) => code.includes(signature));
}

function updaterDescriptorElements(menuArray) {
  return menuArray.elements.filter((element) => {
    if (element?.type !== "ObjectExpression") return false;
    return element.properties.some(
      (property) =>
        propertyName(property) === "id" &&
        literalValue(property.value) === WEBVIEW_UPDATER_MENU_ID,
    );
  });
}

function assertRenderedTitlebarComponent(ast, shape) {
  const programFunctions = new Map();
  for (const statement of ast.body) {
    if (statement.type !== "FunctionDeclaration" || statement.id?.type !== "Identifier") continue;
    const matches = programFunctions.get(statement.id.name) ?? [];
    matches.push(statement);
    programFunctions.set(statement.id.name, matches);
  }
  const programBindings = (name) => {
    const bindings = [];
    for (const statement of ast.body) {
      if (statement.type === "FunctionDeclaration" && statement.id?.name === name) {
        bindings.push(statement);
      } else if (statement.type === "VariableDeclaration") {
        bindings.push(
          ...statement.declarations.filter(
            (declaration) =>
              declaration.id.type === "Identifier" && declaration.id.name === name,
          ),
        );
      } else if (statement.type === "ImportDeclaration") {
        bindings.push(
          ...statement.specifiers.filter(
            (specifier) => specifier.local?.type === "Identifier" && specifier.local.name === name,
          ),
        );
      }
    }
    return bindings;
  };
  const menuFunctions = programFunctions.get(shape.functionName) ?? [];
  if (
    menuFunctions.length !== 1 ||
    menuFunctions[0].start !== shape.menuFunction.start ||
    menuFunctions[0].end !== shape.menuFunction.end ||
    programBindings(shape.functionName).length !== 1 ||
    programBindings(shape.jsxAlias).length !== 1
  ) {
    throw new Error(
      "Windows webview updater titlebar component is not an unambiguous Program binding",
    );
  }

  const exportedBindings = new Set();
  for (const statement of ast.body) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.local?.type === "Identifier") exportedBindings.add(specifier.local.name);
    }
  }
  const roots = new Set();
  const renderEdges = new Map();
  const targetCalls = [];
  const addEdge = (owner, child) => {
    const children = renderEdges.get(owner) ?? new Set();
    children.add(child);
    renderEdges.set(owner, children);
  };
  const isDirectProgramExpression = (ancestors) => {
    const statementIndex = ancestors.findIndex(
      (ancestor) => ancestor.type === "ExpressionStatement" && ast.body.includes(ancestor),
    );
    return (
      statementIndex >= 0 &&
      ancestors.slice(statementIndex + 1).every((ancestor) => ancestor.type === "SequenceExpression")
    );
  };

  walkAstWithAncestors(ast, (node, ancestors) => {
    if (node.type !== "CallExpression") return;
    const jsxAlias = sequenceMember(node, "jsx") || sequenceMember(node, "jsxs");
    const child = node.arguments[0]?.type === "Identifier" ? node.arguments[0].name : null;
    if (
      jsxAlias &&
      child &&
      node.arguments[1]?.type === "ObjectExpression" &&
      (programFunctions.get(child)?.length ?? 0) === 1 &&
      programBindings(jsxAlias).length === 1
    ) {
      const owner = [...ancestors]
        .reverse()
        .find((ancestor) =>
          ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
            ancestor.type,
          ),
        );
      if (owner?.type === "FunctionDeclaration" && ast.body.includes(owner)) {
        addEdge(owner.id.name, child);
      } else if (!owner && isDirectProgramExpression(ancestors)) {
        roots.add(child);
      }
      if (child === shape.functionName) targetCalls.push(node);
    }

    const memoAlias = sequenceMember(node, "memo");
    const rootFunction = node.arguments[0]?.type === "Identifier" ? node.arguments[0].name : null;
    if (
      !memoAlias ||
      !rootFunction ||
      (programFunctions.get(rootFunction)?.length ?? 0) !== 1 ||
      programBindings(memoAlias).length !== 1
    ) return;
    const rootProperty = [...ancestors]
      .reverse()
      .find(
        (ancestor) =>
          ancestor.type === "Property" &&
          propertyName(ancestor) === "Root" &&
          node.start >= ancestor.value.start &&
          node.end <= ancestor.value.end,
      );
    const rootObject = rootProperty
      ? [...ancestors]
          .reverse()
          .find(
            (ancestor) =>
              ancestor.type === "ObjectExpression" &&
              rootProperty.start >= ancestor.start &&
              rootProperty.end <= ancestor.end,
          )
      : null;
    const exportAssignment = rootObject
      ? [...ancestors]
          .reverse()
          .find(
            (ancestor) =>
              ancestor.type === "AssignmentExpression" &&
              ancestor.operator === "=" &&
              ancestor.left.type === "Identifier" &&
              ancestor.right === rootObject &&
              exportedBindings.has(ancestor.left.name),
          )
      : null;
    if (!exportAssignment) return;
    const callback = [...ancestors]
      .reverse()
      .find((ancestor) => ancestor.type === "ArrowFunctionExpression");
    const callbackIndex = callback ? ancestors.indexOf(callback) : -1;
    const callbackCall = callbackIndex > 0 ? ancestors[callbackIndex - 1] : null;
    const programDeclarator = callbackCall
      ? ancestors
          .slice(0, callbackIndex - 1)
          .reverse()
          .find((ancestor) => ancestor.type === "VariableDeclarator")
      : null;
    const programInitializer = programDeclarator && ast.body.some(
      (statement) =>
        statement.type === "VariableDeclaration" &&
        statement.declarations.includes(programDeclarator),
    );
    if (
      callbackCall?.type === "CallExpression" &&
      callbackCall.arguments.includes(callback) &&
      programInitializer
    ) roots.add(rootFunction);
  });

  const reachable = new Set(roots);
  const pending = [...roots];
  while (pending.length > 0) {
    const owner = pending.pop();
    for (const child of renderEdges.get(owner) ?? []) {
      if (reachable.has(child)) continue;
      reachable.add(child);
      pending.push(child);
    }
  }
  if (targetCalls.length !== 1 || !reachable.has(shape.functionName)) {
    throw new Error(
      `Windows webview updater titlebar component expected exactly one live rendered JSX attachment, found ${
        reachable.has(shape.functionName) ? targetCalls.length : 0
      }`,
    );
  }
}

function inspectUpdaterTitlebarSource(code, { allowLegacy = false } = {}) {
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error("Windows webview updater titlebar source is empty");
  }
  const functionCount = countOccurrences(
    code,
    "function codexRebuildUpdaterEnsureTitlebarStyle",
  );
  const itemCount = countOccurrences(code, "{id:'codex-rebuild-updater-top',message:");
  if (functionCount !== 1) {
    throw new Error(
      `Windows webview updater function expected exactly 1 target, found ${functionCount}`,
    );
  }
  if (itemCount !== 1) {
    throw new Error(`Windows webview updater item expected exactly 1 target, found ${itemCount}`);
  }

  const ast = parseJavaScript(code, "Windows webview updater titlebar", "module");
  const shape = analyzeWebviewMenuBarCode(code);
  const updaterDescriptors = [];
  walkAst(ast, (node) => {
    if (
      node.type === "ObjectExpression" &&
      node.properties.some(
        (property) =>
          propertyName(property) === "id" &&
          literalValue(property.value) === WEBVIEW_UPDATER_MENU_ID,
      )
    ) {
      updaterDescriptors.push(node);
    }
  });
  if (updaterDescriptors.length !== 1) {
    throw new Error(
      `Windows webview updater descriptor expected exactly 1 AST target, found ${updaterDescriptors.length}`,
    );
  }
  const descriptorElements = updaterDescriptorElements(shape.menuArray);
  if (descriptorElements.length !== 1) {
    throw new Error(
      `Windows webview updater descriptor expected one attached menu item, found ${descriptorElements.length}`,
    );
  }
  const descriptorElement = descriptorElements[0];
  assertRenderedTitlebarComponent(ast, shape);

  const hasBoundaries = [
    WEBVIEW_COMPONENT_START_MARKER,
    WEBVIEW_COMPONENT_END_MARKER,
    WEBVIEW_DESCRIPTOR_START_MARKER,
    WEBVIEW_DESCRIPTOR_END_MARKER,
  ].some((marker) => code.includes(marker));
  let componentRange;
  let descriptorRange;
  let candidates;
  if (hasBoundaries) {
    componentRange = markerRange(
      code,
      WEBVIEW_COMPONENT_START_MARKER,
      WEBVIEW_COMPONENT_END_MARKER,
      "Windows webview updater component",
    );
    descriptorRange = markerRange(
      code,
      WEBVIEW_DESCRIPTOR_START_MARKER,
      WEBVIEW_DESCRIPTOR_END_MARKER,
      "Windows webview updater descriptor",
    );
    candidates = [
      {
        dialect: "current",
        version: LOCAL_UPDATER_CONTRACT_VERSION,
        component: bindWebviewMenuBarPatch(makeWebviewMenuBarFunctionPatch(), shape),
        descriptor: makeWebviewMenuDescriptorBlock(),
        descriptorItem: makeWebviewMenuDescriptorPatch(),
        versionMarkers: [
          layerVersionMarker("titlebar-component"),
          layerVersionMarker("titlebar-descriptor"),
        ],
      },
    ];
    if (allowLegacy) {
      candidates.push({
        dialect: "v0",
        version: 0,
        component: bindWebviewMenuBarPatch(makeWebviewMenuBarFunctionPatch(0), shape),
        descriptor: makeWebviewMenuDescriptorBlock(0),
        descriptorItem: makeWebviewMenuDescriptorPatch(0),
        versionMarkers: [
          layerVersionMarker("titlebar-component", 0),
          layerVersionMarker("titlebar-descriptor", 0),
        ],
      });
    }
  } else {
    if (!allowLegacy) {
      throw new Error("Windows webview updater titlebar canonical version markers are missing");
    }
    const legacyComponentStart = code.indexOf(
      "function codexRebuildUpdaterEnsureTitlebarStyle",
    );
    if (legacyComponentStart < 0 || legacyComponentStart >= shape.menuFunction.start) {
      throw new Error("Windows webview updater legacy component block is detached");
    }
    componentRange = {
      start: legacyComponentStart,
      end: shape.menuFunction.end,
      code: code.slice(legacyComponentStart, shape.menuFunction.end),
    };
    descriptorRange = {
      start: descriptorElement.start,
      end: descriptorElement.end,
      code: code.slice(descriptorElement.start, descriptorElement.end),
    };
    candidates = [
      {
        dialect: "versionless",
        version: null,
        component: bindWebviewMenuBarPatch(makeWebviewMenuBarFunctionPatch(null), shape),
        descriptor: makeWebviewMenuDescriptorPatch(null),
        descriptorItem: makeWebviewMenuDescriptorPatch(null),
        versionMarkers: [],
      },
    ];
  }

  if (
    shape.menuFunction.start < componentRange.start ||
    shape.menuFunction.end > componentRange.end
  ) {
    throw new Error("Windows webview updater component canonical block is detached");
  }
  if (
    descriptorRange.start < descriptorElement.start ||
    descriptorRange.end > descriptorElement.end
  ) {
    throw new Error("Windows webview updater descriptor canonical block is detached");
  }
  const candidate = candidates.find(
    (item) =>
      item.component === componentRange.code &&
      item.descriptor === descriptorRange.code &&
      item.descriptorItem === code.slice(descriptorElement.start, descriptorElement.end),
  );
  if (!candidate) {
    const expected = candidates[0];
    throw new Error(
      "Windows webview updater titlebar canonical bytes or version do not match " +
        `(component diff ${firstDifferenceIndex(componentRange.code, expected.component)}, ` +
        `descriptor diff ${firstDifferenceIndex(descriptorRange.code, expected.descriptor)})`,
    );
  }
  const versions = updaterVersionSignatures(code);
  const sortedVersions = [...versions].sort();
  const sortedExpectedVersions = [...candidate.versionMarkers].sort();
  if (
    sortedVersions.length !== sortedExpectedVersions.length ||
    sortedVersions.some((version, index) => version !== sortedExpectedVersions[index])
  ) {
    throw new Error("Windows webview updater titlebar version is stale or mismatched");
  }

  const canonicalComponent = bindWebviewMenuBarPatch(
    makeWebviewMenuBarFunctionPatch(),
    shape,
  );
  const canonicalDescriptor = hasBoundaries
    ? makeWebviewMenuDescriptorBlock()
    : makeWebviewMenuDescriptorPatch();
  const canonicalSource = applyReplacements(code, [
    {
      start: componentRange.start,
      end: componentRange.end,
      text: canonicalComponent,
    },
    {
      start: descriptorRange.start,
      end: descriptorRange.end,
      text: canonicalDescriptor,
    },
  ]);
  return {
    layer: "titlebar",
    version: candidate.version,
    dialect: candidate.dialect,
    functionName: shape.functionName,
    menuArrayName: shape.menuArrayName,
    canonicalSource,
  };
}

function validateUpdaterTitlebarSource(code) {
  return inspectUpdaterTitlebarSource(code);
}

function patchWebviewMenuBarCode(code) {
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error("Windows webview updater titlebar source is empty");
  }
  if (hasTitlebarSignature(code)) {
    const inspection = inspectUpdaterTitlebarSource(code, { allowLegacy: true });
    if (inspection.dialect === "current") return code;
    validateUpdaterTitlebarSource(inspection.canonicalSource);
    return inspection.canonicalSource;
  }
  const shape = analyzeWebviewMenuBarCode(code);
  const next = applyReplacements(code, [
    {
      start: shape.menuArray.end - 1,
      end: shape.menuArray.end - 1,
      text: `,${makeWebviewMenuDescriptorPatch()}`,
    },
    {
      start: shape.menuFunction.start,
      end: shape.menuFunction.end,
      text: bindWebviewMenuBarPatch(makeWebviewMenuBarFunctionPatch(), shape),
    },
  ]);
  validateUpdaterTitlebarSource(next);
  return next;
}

function normalizeAsarPath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Windows package main entry is missing");
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/").replace(/^\.\//, ""));
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Windows package entry escapes the ASAR root: ${value}`);
  }
  return normalized;
}

function parseJavaScript(code, label, sourceType = "script") {
  try {
    return acorn.parse(code, { ecmaVersion: "latest", sourceType });
  } catch (error) {
    throw new Error(`${label} parse failed: ${error.message}`);
  }
}

function flattenTopLevelSequence(node, output = []) {
  if (node?.type === "SequenceExpression") {
    for (const expression of node.expressions) flattenTopLevelSequence(expression, output);
  } else if (node) {
    output.push(node);
  }
  return output;
}

function bootstrapRequireTarget(node) {
  if (
    node?.type !== "CallExpression" ||
    node.callee.type !== "Identifier" ||
    node.callee.name !== "require" ||
    node.arguments.length !== 1
  ) {
    return null;
  }
  const target = literalValue(node.arguments[0]);
  return typeof target === "string" && /^\.\/bootstrap(?:-[A-Za-z0-9_$-]+)?\.js$/.test(target)
    ? target
    : null;
}

function promisedBootstrapRequireTarget(node) {
  if (
    node?.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression" ||
    node.callee.computed ||
    node.callee.property.type !== "Identifier" ||
    node.callee.property.name !== "then" ||
    node.arguments.length !== 1 ||
    node.arguments[0].type !== "ArrowFunctionExpression" ||
    node.arguments[0].async ||
    node.arguments[0].generator ||
    node.arguments[0].params.length !== 0 ||
    node.arguments[0].body.type === "BlockStatement"
  ) {
    return null;
  }
  const resolved = node.callee.object;
  if (
    resolved.type !== "CallExpression" ||
    resolved.arguments.length !== 0 ||
    resolved.callee.type !== "MemberExpression" ||
    resolved.callee.computed ||
    resolved.callee.object.type !== "Identifier" ||
    resolved.callee.object.name !== "Promise" ||
    resolved.callee.property.type !== "Identifier" ||
    resolved.callee.property.name !== "resolve"
  ) {
    return null;
  }
  return bootstrapRequireTarget(node.arguments[0].body);
}

function liveRuntimeBootstrapTargets(entrySource) {
  const ast = parseJavaScript(entrySource, "Windows early bootstrap", "script");
  const targets = [];
  for (const statement of ast.body) {
    if (statement.type !== "ExpressionStatement") continue;
    for (const expression of flattenTopLevelSequence(statement.expression)) {
      const target = bootstrapRequireTarget(expression) || promisedBootstrapRequireTarget(expression);
      if (target) targets.push(target);
    }
  }
  return targets;
}

function resolveRuntimeBootstrap(packageSource, readSource) {
  let metadata;
  try {
    metadata = typeof packageSource === "string" ? JSON.parse(packageSource) : packageSource;
  } catch (error) {
    throw new Error(`Windows package metadata parse failed: ${error.message}`);
  }
  const entryPath = normalizeAsarPath(metadata?.main);
  const entryName = path.posix.basename(entryPath);
  let runtimePath = entryPath;
  let viaEarlyBootstrap = false;
  if (entryName === "early-bootstrap.js") {
    viaEarlyBootstrap = true;
    const entrySource = readSource(entryPath);
    if (typeof entrySource !== "string") {
      throw new Error(`Windows early bootstrap is missing: ${entryPath}`);
    }
    const targets = liveRuntimeBootstrapTargets(entrySource);
    if (targets.length !== 1) {
      throw new Error(`runtime bootstrap expected exactly 1 target, found ${targets.length}`);
    }
    runtimePath = normalizeAsarPath(path.posix.join(path.posix.dirname(entryPath), targets[0]));
  } else if (!/^bootstrap(?:-[A-Za-z0-9_$-]+)?\.js$/.test(entryName)) {
    throw new Error(`unsupported Windows runtime bootstrap entry: ${entryPath}`);
  }
  if (runtimePath === entryPath && entryName === "early-bootstrap.js") {
    throw new Error("early-bootstrap.js cannot satisfy the runtime backend contract");
  }
  if (typeof readSource(runtimePath) !== "string") {
    throw new Error(`resolved Windows runtime bootstrap is missing: ${runtimePath}`);
  }
  return { entryPath, runtimePath, viaEarlyBootstrap };
}

function localLayerCount(status) {
  return {
    patchable: status === "patched" ? 1 : 0,
    already: status === "already" ? 1 : 0,
    total: 1,
  };
}

function markerRange(code, startMarker, endMarker, label) {
  const startCount = countOccurrences(code, startMarker);
  const endCount = countOccurrences(code, endMarker);
  if (startCount !== 1) {
    throw new Error(`${label} start marker expected exactly 1 target, found ${startCount}`);
  }
  if (endCount !== 1) {
    throw new Error(`${label} end marker expected exactly 1 target, found ${endCount}`);
  }
  const start = code.indexOf(startMarker);
  const endMarkerStart = code.indexOf(endMarker);
  if (endMarkerStart < start) throw new Error(`${label} canonical marker order is invalid`);
  const end = endMarkerStart + endMarker.length;
  return { start, end, code: code.slice(start, end) };
}

function updaterVersionSignatures(code) {
  return [
    ...code.matchAll(/\/\*\s*CodexRebuildLocalUpdater:[^*\r\n]*v\d+[^*\r\n]*\*\//g),
  ].map((match) => match[0]);
}

function hasBackendSignature(code) {
  return [
    START_MARKER,
    END_MARKER,
    FILE_END_MARKER,
    "CodexRebuildWindowsBootstrap",
    "CodexRebuildSetupLocalUpdater",
    "codex_rebuild:update-command",
    "CodexRebuildLocalUpdater:v",
  ].some((signature) => code.includes(signature));
}

function assertBackendProgramAttachment(code) {
  const ast = parseJavaScript(code, "Windows runtime bootstrap", "script");
  const [bootstrap, setup, guardedRuntime, ...rest] = ast.body;
  const attached =
    rest.length === 0 &&
    bootstrap?.type === "FunctionDeclaration" &&
    bootstrap.id?.name === "CodexRebuildWindowsBootstrap" &&
    setup?.type === "FunctionDeclaration" &&
    setup.id?.name === "CodexRebuildSetupLocalUpdater" &&
    guardedRuntime?.type === "IfStatement" &&
    guardedRuntime.alternate == null &&
    guardedRuntime.test.type === "UnaryExpression" &&
    guardedRuntime.test.operator === "!" &&
    guardedRuntime.test.argument.type === "CallExpression" &&
    guardedRuntime.test.argument.callee.type === "Identifier" &&
    guardedRuntime.test.argument.callee.name === "CodexRebuildWindowsBootstrap" &&
    guardedRuntime.test.argument.arguments.length === 0 &&
    guardedRuntime.consequent.type === "BlockStatement" &&
    guardedRuntime.consequent.body.length > 0;
  if (!attached) {
    throw new Error(
      "Windows runtime bootstrap canonical backend is not attached to the live Program guard",
    );
  }
}

function inspectUpdaterBackendSource(code, { allowLegacy = false } = {}) {
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error("resolved Windows runtime bootstrap is empty");
  }
  markerRange(code, START_MARKER, END_MARKER, "Windows runtime bootstrap");
  const fileEndCount = countOccurrences(code, FILE_END_MARKER);
  if (fileEndCount !== 1) {
    throw new Error(
      `Windows runtime bootstrap file-end marker expected exactly 1 target, found ${fileEndCount}`,
    );
  }

  const suffix = `\n}\n${FILE_END_MARKER}\n`;
  const candidates = [
    {
      dialect: "current",
      version: LOCAL_UPDATER_CONTRACT_VERSION,
      prefix: makeBootstrapPrefix(),
      versionMarker: layerVersionMarker("backend"),
    },
  ];
  if (allowLegacy) {
    candidates.push(
      {
        dialect: "unbounded-v1",
        version: 1,
        prefix: makeBootstrapPrefix(1, { unboundedLifecycle: true }),
        versionMarker: layerVersionMarker("backend", 1),
      },
      {
        dialect: "detached-v1",
        version: 1,
        prefix: makeBootstrapPrefix(1, { detachedLifecycle: true }),
        versionMarker: layerVersionMarker("backend", 1),
      },
      {
        dialect: "legacy-v1",
        version: 1,
        prefix: makeBootstrapPrefix(1, { legacyLifecycle: true }),
        versionMarker: layerVersionMarker("backend", 1),
      },
      {
        dialect: "v0",
        version: 0,
        prefix: makeBootstrapPrefix(0, { legacyLifecycle: true }),
        versionMarker: layerVersionMarker("backend", 0),
      },
      {
        dialect: "versionless",
        version: null,
        prefix: makeBootstrapPrefix(null, { legacyLifecycle: true }),
      },
    );
  }

  for (const candidate of candidates) {
    if (!code.startsWith(candidate.prefix) || !code.endsWith(suffix)) continue;
    const versions = updaterVersionSignatures(code);
    const expectedVersions = candidate.versionMarker ? [candidate.versionMarker] : [];
    if (
      versions.length !== expectedVersions.length ||
      versions.some((version, index) => version !== expectedVersions[index])
    ) {
      throw new Error("Windows runtime bootstrap canonical backend version is stale or mismatched");
    }
    assertBackendProgramAttachment(code);
    const originalSource = code.slice(candidate.prefix.length, -suffix.length);
    return {
      layer: "backend",
      version: candidate.version,
      dialect: candidate.dialect,
      originalSource,
      canonicalSource: `${makeBootstrapPrefix()}${originalSource}${suffix}`,
    };
  }
  throw new Error("Windows runtime bootstrap canonical backend postcondition failed");
}

function validateUpdaterBackendSource(code) {
  return inspectUpdaterBackendSource(code);
}

function patchBootstrapCode(code) {
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error("resolved Windows runtime bootstrap is empty");
  }
  if (hasBackendSignature(code)) {
    const inspection = inspectUpdaterBackendSource(code, { allowLegacy: true });
    if (inspection.dialect === "current") {
      return { code, status: "already", counts: localLayerCount("already") };
    }
    validateUpdaterBackendSource(inspection.canonicalSource);
    return {
      code: inspection.canonicalSource,
      status: "patched",
      counts: localLayerCount("patched"),
    };
  }
  const next = `${makeBootstrapPrefix()}${code}\n}\n${FILE_END_MARKER}\n`;
  validateUpdaterBackendSource(next);
  return { code: next, status: "patched", counts: localLayerCount("patched") };
}

function findElectronBinding(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "script" });
  } catch (error) {
    throw new Error(`Windows preload parse failed: ${error.message}`);
  }
  const bindings = [];
  for (const statement of ast.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (
        declaration.id.type === "Identifier" &&
        declaration.init?.type === "CallExpression" &&
        declaration.init.callee.type === "Identifier" &&
        declaration.init.callee.name === "require" &&
        declaration.init.arguments.length === 1 &&
        literalValue(declaration.init.arguments[0]) === "electron"
      ) {
        bindings.push(declaration.id.name);
      }
    }
  }
  if (bindings.length !== 1) {
    throw new Error(
      `program-scope preload electron binding expected exactly 1 target, found ${bindings.length}`,
    );
  }
  return bindings[0];
}

function hasPreloadSignature(code) {
  return [
    PRELOAD_START_MARKER,
    PRELOAD_END_MARKER,
    layerVersionMarker("preload"),
    "codexRebuildUpdater",
    "codex_rebuild:update-state",
    "codex_rebuild:update-command",
  ].some((signature) => code.includes(signature));
}

function makePatchedPreloadSource(baseSource, electronAlias, version) {
  const patch = makePreloadPatch(electronAlias, version);
  const sourceMap = "\n//# sourceMappingURL=preload.js.map";
  return baseSource.includes(sourceMap)
    ? baseSource.replace(sourceMap, `\n${patch}${sourceMap}`)
    : `${baseSource}\n${patch}\n`;
}

function preloadBaseSource(code, range) {
  if (range.start === 0 || code[range.start - 1] !== "\n") {
    throw new Error("Windows preload canonical block is not attached at Program scope");
  }
  const suffix = code.slice(range.end);
  if (suffix.startsWith("\n//# sourceMappingURL=preload.js.map")) {
    return code.slice(0, range.start - 1) + suffix;
  }
  if (suffix === "\n") return code.slice(0, range.start - 1);
  throw new Error("Windows preload canonical block placement postcondition failed");
}

function assertPreloadProgramAttachment(code, range, electronAlias) {
  const ast = parseJavaScript(code, "Windows preload", "script");
  const enclosed = ast.body.filter(
    (statement) => statement.start >= range.start && statement.end <= range.end,
  );
  const statements = enclosed.filter((statement) => statement.type !== "EmptyStatement");
  if (
    enclosed.some(
      (statement) =>
        statement.type !== "EmptyStatement" && statement.type !== "ExpressionStatement",
    ) ||
    statements.length !== 1 ||
    statements[0].type !== "ExpressionStatement" ||
    !code
      .slice(statements[0].start, statements[0].end)
      .includes(`${electronAlias}.contextBridge.exposeInMainWorld('codexRebuildUpdater'`)
  ) {
    throw new Error(
      "Windows preload canonical bridge has no executable Program-scope exposure",
    );
  }
}

function inspectUpdaterPreloadSource(code, { allowLegacy = false } = {}) {
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error("Windows preload source is empty");
  }
  const range = markerRange(
    code,
    PRELOAD_START_MARKER,
    PRELOAD_END_MARKER,
    "Windows preload updater",
  );
  const baseSource = preloadBaseSource(code, range);
  const electronAlias = findElectronBinding(baseSource);
  const candidates = [
    {
      dialect: "current",
      version: LOCAL_UPDATER_CONTRACT_VERSION,
      block: makePreloadPatch(electronAlias),
      versionMarker: layerVersionMarker("preload"),
    },
  ];
  if (allowLegacy) {
    candidates.push(
      {
        dialect: "v0",
        version: 0,
        block: makePreloadPatch(electronAlias, 0),
        versionMarker: layerVersionMarker("preload", 0),
      },
      {
        dialect: "versionless",
        version: null,
        block: makePreloadPatch(electronAlias, null),
      },
    );
  }
  const candidate = candidates.find((item) => item.block === range.code);
  if (!candidate) {
    throw new Error("Windows preload canonical bridge bytes or version do not match");
  }
  const versions = updaterVersionSignatures(code);
  const expectedVersions = candidate.versionMarker ? [candidate.versionMarker] : [];
  if (
    versions.length !== expectedVersions.length ||
    versions.some((version, index) => version !== expectedVersions[index])
  ) {
    throw new Error("Windows preload canonical bridge version is stale or mismatched");
  }
  if (code !== makePatchedPreloadSource(baseSource, electronAlias, candidate.version)) {
    throw new Error("Windows preload canonical bridge placement postcondition failed");
  }
  assertPreloadProgramAttachment(code, range, electronAlias);
  return {
    layer: "preload",
    version: candidate.version,
    dialect: candidate.dialect,
    electronAlias,
    baseSource,
    canonicalSource: makePatchedPreloadSource(
      baseSource,
      electronAlias,
      LOCAL_UPDATER_CONTRACT_VERSION,
    ),
  };
}

function validateUpdaterPreloadSource(code) {
  return inspectUpdaterPreloadSource(code);
}

function patchPreloadCode(code) {
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error("Windows preload source is empty");
  }
  if (hasPreloadSignature(code)) {
    const inspection = inspectUpdaterPreloadSource(code, { allowLegacy: true });
    if (inspection.dialect === "current") {
      return { code, status: "already", counts: localLayerCount("already") };
    }
    validateUpdaterPreloadSource(inspection.canonicalSource);
    return {
      code: inspection.canonicalSource,
      status: "patched",
      counts: localLayerCount("patched"),
    };
  }
  const electronAlias = findElectronBinding(code);
  const next = makePatchedPreloadSource(code, electronAlias, LOCAL_UPDATER_CONTRACT_VERSION);
  validateUpdaterPreloadSource(next);
  return { code: next, status: "patched", counts: localLayerCount("patched") };
}

function patchPackageMetadataSource(packageSource, updateUrl = DEFAULT_WINDOWS_UPDATE_URL) {
  let metadata;
  try {
    metadata = JSON.parse(packageSource);
  } catch (error) {
    throw new Error(`Windows package metadata parse failed: ${error.message}`);
  }
  const normalizedUrl = String(updateUrl || "").trim();
  if (!normalizedUrl) throw new Error("Windows update URL is empty");
  if (metadata.codexRebuildWindowsUpdateUrl === normalizedUrl) {
    return { code: packageSource, status: "already", counts: localLayerCount("already") };
  }
  metadata.codexRebuildWindowsUpdateUrl = normalizedUrl;
  return {
    code: JSON.stringify(metadata, null, 2) + "\n",
    status: "patched",
    counts: localLayerCount("patched"),
  };
}

function inspectUpdaterMetadataSource(packageSource, expectedUpdateUrl) {
  let metadata;
  try {
    metadata = JSON.parse(packageSource);
  } catch (error) {
    throw new Error(`Windows package metadata parse failed: ${error.message}`);
  }
  const updateUrl = String(metadata?.codexRebuildWindowsUpdateUrl || "").trim();
  if (!updateUrl) throw new Error("Windows package metadata updater URL is missing");
  if (
    expectedUpdateUrl !== undefined &&
    updateUrl !== String(expectedUpdateUrl || "").trim()
  ) {
    throw new Error("Windows package metadata updater URL does not match the planned URL");
  }
  return { layer: "metadata", version: LOCAL_UPDATER_CONTRACT_VERSION, updateUrl };
}

function normalizeUpdaterFiles(files) {
  if (!files || typeof files !== "object") throw new Error("Windows ASAR sources are required");
  const normalizedFiles = {};
  for (const [fileName, source] of Object.entries(files)) {
    const normalized = normalizeAsarPath(fileName);
    if (Object.hasOwn(normalizedFiles, normalized)) {
      throw new Error(`Windows ASAR source path is duplicated after normalization: ${normalized}`);
    }
    normalizedFiles[normalized] = source;
  }
  return normalizedFiles;
}

function exactlyOneEvidence(evidence, label) {
  if (evidence.length !== 1) {
    throw new Error(`${label} expected exactly 1 canonical target, found ${evidence.length}`);
  }
  return evidence[0];
}

function makeUpdaterEvidence(pathName, inspection) {
  const {
    canonicalSource: _canonicalSource,
    originalSource: _originalSource,
    baseSource: _baseSource,
    ...evidence
  } = inspection;
  return { ...evidence, path: pathName };
}

function validateLocalUpdaterSources({ packageSource, files, expectedUpdateUrl } = {}) {
  if (typeof packageSource !== "string") throw new Error("Windows package metadata is required");
  const normalizedFiles = normalizeUpdaterFiles(files);
  const metadata = inspectUpdaterMetadataSource(packageSource, expectedUpdateUrl);
  const resolved = resolveRuntimeBootstrap(packageSource, (fileName) => normalizedFiles[fileName]);

  const backendEvidence = [];
  for (const [fileName, source] of Object.entries(normalizedFiles)) {
    if (!/^\.vite\/build\/bootstrap(?:-[A-Za-z0-9_$-]+)?\.js$/.test(fileName)) continue;
    if (fileName !== resolved.runtimePath && !hasBackendSignature(String(source || ""))) continue;
    let inspection;
    try {
      inspection = validateUpdaterBackendSource(source);
    } catch (error) {
      throw new Error(`Windows updater backend ${fileName}: ${error.message}`);
    }
    backendEvidence.push(makeUpdaterEvidence(fileName, inspection));
  }
  const backend = exactlyOneEvidence(backendEvidence, "Windows updater backend");
  if (backend.path !== resolved.runtimePath) {
    throw new Error("Windows updater backend canonical target is not the live runtime bootstrap");
  }

  const preloadPath = ".vite/build/preload.js";
  if (typeof normalizedFiles[preloadPath] !== "string") {
    throw new Error("Windows preload expected exactly 1 target, found 0");
  }
  let preloadInspection;
  try {
    preloadInspection = validateUpdaterPreloadSource(normalizedFiles[preloadPath]);
  } catch (error) {
    throw new Error(`Windows updater preload ${preloadPath}: ${error.message}`);
  }
  const preload = makeUpdaterEvidence(preloadPath, preloadInspection);

  const mainMenuEvidence = [];
  for (const [fileName, source] of Object.entries(normalizedFiles)) {
    if (!/^\.vite\/build\/main-.*\.js$/.test(fileName)) continue;
    if (!hasMainMenuSignature(String(source || ""))) continue;
    let inspection;
    try {
      inspection = validateUpdaterMainMenuSource(source);
    } catch (error) {
      throw new Error(`Windows updater main menu ${fileName}: ${error.message}`);
    }
    mainMenuEvidence.push(makeUpdaterEvidence(fileName, inspection));
  }
  const mainMenu = exactlyOneEvidence(mainMenuEvidence, "Windows updater main menu");

  const titlebarEvidence = [];
  for (const [fileName, source] of Object.entries(normalizedFiles)) {
    if (!/^webview\/assets\/app-shell-.*\.js$/.test(fileName)) continue;
    if (!hasTitlebarSignature(String(source || ""))) continue;
    let inspection;
    try {
      inspection = validateUpdaterTitlebarSource(source);
    } catch (error) {
      throw new Error(`Windows updater titlebar ${fileName}: ${error.message}`);
    }
    titlebarEvidence.push(makeUpdaterEvidence(fileName, inspection));
  }
  const titlebar = exactlyOneEvidence(titlebarEvidence, "Windows updater titlebar");

  const evidence = [
    { ...metadata, path: "package.json" },
    backend,
    preload,
    mainMenu,
    titlebar,
  ];
  const uniquePaths = new Set(evidence.map((item) => item.path));
  if (evidence.length !== 5 || uniquePaths.size !== 5) {
    throw new Error(
      `Windows local updater evidence expected exactly 5 unique paths, found ${uniquePaths.size}`,
    );
  }
  return {
    version: LOCAL_UPDATER_CONTRACT_VERSION,
    paths: {
      metadata: "package.json",
      entry: resolved.entryPath,
      backend: backend.path,
      preload: preload.path,
      mainMenu: mainMenu.path,
      titlebar: titlebar.path,
    },
    evidence,
  };
}

function selectMainMenuTarget(normalizedFiles) {
  const candidates = [];
  for (const [fileName, source] of Object.entries(normalizedFiles)) {
    if (!/^\.vite\/build\/main-.*\.js$/.test(fileName)) continue;
    if (hasMainMenuSignature(String(source || ""))) {
      try {
        candidates.push({ path: fileName, code: patchMainMenuCode(source) });
      } catch (error) {
        throw new Error(`Windows main menu ${fileName}: ${error.message}`);
      }
      continue;
    }
    try {
      analyzeMainMenuCode(source);
      candidates.push({ path: fileName, code: patchMainMenuCode(source) });
    } catch {
      // Non-menu main chunks are not updater targets.
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`Windows main menu expected exactly 1 target, found ${candidates.length}`);
  }
  return candidates[0];
}

function selectTitlebarTarget(normalizedFiles) {
  const candidates = [];
  for (const [fileName, source] of Object.entries(normalizedFiles)) {
    if (!/^webview\/assets\/app-shell-.*\.js$/.test(fileName)) continue;
    if (hasTitlebarSignature(String(source || ""))) {
      try {
        candidates.push({ path: fileName, code: patchWebviewMenuBarCode(source) });
      } catch (error) {
        throw new Error(`Windows webview titlebar ${fileName}: ${error.message}`);
      }
      continue;
    }
    if (!source.includes("windowsMenuBar.help") || !source.includes("showApplicationMenu")) continue;
    try {
      analyzeWebviewMenuBarCode(source);
      candidates.push({ path: fileName, code: patchWebviewMenuBarCode(source) });
    } catch {
      // Other app-shell chunks may mention menu messages without rendering the titlebar.
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`Windows webview titlebar expected exactly 1 target, found ${candidates.length}`);
  }
  return candidates[0];
}

function makePlannedLayer(pathName, result) {
  return { path: pathName, status: result.status, counts: result.counts };
}

function planLocalUpdaterSources({ packageSource, files, updateUrl = DEFAULT_WINDOWS_UPDATE_URL }) {
  if (typeof packageSource !== "string") throw new Error("Windows package metadata is required");
  const normalizedFiles = normalizeUpdaterFiles(files);
  const resolved = resolveRuntimeBootstrap(packageSource, (fileName) => normalizedFiles[fileName]);
  const preloadPath = ".vite/build/preload.js";
  if (typeof normalizedFiles[preloadPath] !== "string") {
    throw new Error("Windows preload expected exactly 1 target, found 0");
  }

  const metadata = patchPackageMetadataSource(packageSource, updateUrl);
  const backend = patchBootstrapCode(normalizedFiles[resolved.runtimePath]);
  const preload = patchPreloadCode(normalizedFiles[preloadPath]);
  const selectedMainMenu = selectMainMenuTarget(normalizedFiles);
  const selectedTitlebar = selectTitlebarTarget(normalizedFiles);
  const mainCode = selectedMainMenu.code;
  const webviewCode = selectedTitlebar.code;
  const mainMenu = {
    code: mainCode,
    status: mainCode === normalizedFiles[selectedMainMenu.path] ? "already" : "patched",
  };
  mainMenu.counts = localLayerCount(mainMenu.status);
  const webview = {
    code: webviewCode,
    status: webviewCode === normalizedFiles[selectedTitlebar.path] ? "already" : "patched",
  };
  webview.counts = localLayerCount(webview.status);

  const outputs = [
    { path: "package.json", source: packageSource, result: metadata },
    { path: resolved.runtimePath, source: normalizedFiles[resolved.runtimePath], result: backend },
    { path: preloadPath, source: normalizedFiles[preloadPath], result: preload },
    {
      path: selectedMainMenu.path,
      source: normalizedFiles[selectedMainMenu.path],
      result: mainMenu,
    },
    {
      path: selectedTitlebar.path,
      source: normalizedFiles[selectedTitlebar.path],
      result: webview,
    },
  ];
  const outputPaths = new Set(outputs.map((output) => output.path));
  if (outputs.length !== 5 || outputPaths.size !== 5) {
    throw new Error(
      `Windows local updater plan expected exactly 5 unique paths, found ${outputPaths.size}`,
    );
  }
  const plannedFiles = { ...normalizedFiles };
  for (const output of outputs) {
    if (output.path !== "package.json") plannedFiles[output.path] = output.result.code;
  }
  const validation = validateLocalUpdaterSources({
    packageSource: metadata.code,
    files: plannedFiles,
    expectedUpdateUrl: updateUrl,
  });
  if (
    validation.paths.backend !== resolved.runtimePath ||
    validation.paths.preload !== preloadPath ||
    validation.paths.mainMenu !== selectedMainMenu.path ||
    validation.paths.titlebar !== selectedTitlebar.path
  ) {
    throw new Error("Windows local updater planned-output canonical postcondition failed");
  }
  const changes = outputs
    .filter((output) => output.result.code !== output.source)
    .map((output) => ({ path: output.path, original: output.source, code: output.result.code }));
  return {
    status: changes.length === 0 ? "already" : "patched",
    changes,
    layers: {
      metadata: makePlannedLayer("package.json", metadata),
      entry: {
        path: resolved.entryPath,
        status: resolved.viaEarlyBootstrap ? "native" : "direct",
        counts: { native: 1, total: 1 },
      },
      backend: makePlannedLayer(resolved.runtimePath, backend),
      preload: makePlannedLayer(preloadPath, preload),
      mainMenu: makePlannedLayer(selectedMainMenu.path, mainMenu),
      webview: makePlannedLayer(selectedTitlebar.path, webview),
    },
    validation,
  };
}

function collectLocalUpdaterSources(asarRoot) {
  const packagePath = path.join(asarRoot, "package.json");
  if (!fs.existsSync(packagePath)) throw new Error("Windows package metadata is missing");
  const packageSource = fs.readFileSync(packagePath, "utf-8");
  const buildDir = path.join(asarRoot, ".vite", "build");
  const assetsDir = path.join(asarRoot, "webview", "assets");
  if (!fs.existsSync(buildDir)) throw new Error("Windows build directory is missing");
  if (!fs.existsSync(assetsDir)) throw new Error("Windows webview assets directory is missing");
  const files = {};
  for (const fileName of fs.readdirSync(buildDir)) {
    if (
      fileName === "early-bootstrap.js" ||
      fileName === "preload.js" ||
      /^bootstrap(?:-[A-Za-z0-9_$-]+)?\.js$/.test(fileName) ||
      /^main-.*\.js$/.test(fileName)
    ) {
      files[`.vite/build/${fileName}`] = fs.readFileSync(path.join(buildDir, fileName), "utf-8");
    }
  }
  for (const fileName of fs.readdirSync(assetsDir)) {
    if (/^app-shell-.*\.js$/.test(fileName)) {
      files[`webview/assets/${fileName}`] = fs.readFileSync(path.join(assetsDir, fileName), "utf-8");
    }
  }
  return { packageSource, files };
}

function executeLocalUpdater({
  asarRoot = path.join(SRC_DIR, "win", "_asar"),
  check = false,
  updateUrl = (process.env.CODEX_REBUILD_UPDATE_URL || DEFAULT_WINDOWS_UPDATE_URL).trim(),
  writeFileSync = fs.writeFileSync,
} = {}) {
  const sources = collectLocalUpdaterSources(asarRoot);
  const plan = planLocalUpdaterSources({ ...sources, updateUrl });
  if (check) return plan;
  const applied = [];
  try {
    for (const change of plan.changes) {
      const filePath = path.join(asarRoot, ...change.path.split("/"));
      applied.push({ filePath, original: change.original });
      writeFileSync(filePath, change.code, "utf-8");
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const item of applied.reverse()) {
      try {
        writeFileSync(item.filePath, item.original, "utf-8");
      } catch (rollbackError) {
        rollbackFailures.push(
          `${path.relative(asarRoot, item.filePath)}: ${rollbackError.message}`,
        );
      }
    }
    if (rollbackFailures.length > 0) {
      throw new Error(
        `local updater write failed; rollback incomplete (${rollbackFailures.join("; ")}): ` +
          error.message,
      );
    }
    throw new Error(`local updater write failed and was rolled back: ${error.message}`);
  }
  return plan;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win", "unix"].includes(a));
  if (platform && platform !== "win") {
    console.log("  [ok] Local updater patch only applies to Windows");
    return;
  }

  const result = executeLocalUpdater({ check: isCheck });
  for (const [name, layer] of Object.entries(result.layers)) {
    const counts = layer.counts ? ` ${JSON.stringify(layer.counts)}` : "";
    console.log(`  [${isCheck ? "check" : layer.status}] ${name}: ${layer.path}${counts}`);
  }
  console.log(
    `  [ok] local updater status=${result.status} writes=${isCheck ? 0 : result.changes.length} planned=${result.changes.length}`,
  );
}

if (require.main === module) main();

module.exports = {
  LOCAL_UPDATER_CONTRACT_VERSION,
  makeBootstrapPrefix,
  makePreloadPatch,
  makeMainMenuPatch,
  patchMainMenuCode,
  patchWebviewMenuBarCode,
  resolveRuntimeBootstrap,
  inspectUpdaterBackendSource,
  inspectUpdaterPreloadSource,
  inspectUpdaterMainMenuSource,
  inspectUpdaterTitlebarSource,
  validateUpdaterBackendSource,
  validateUpdaterPreloadSource,
  validateUpdaterMainMenuSource,
  validateUpdaterTitlebarSource,
  validateLocalUpdaterSources,
  patchBootstrapCode,
  patchPreloadCode,
  patchPackageMetadataSource,
  planLocalUpdaterSources,
  executeLocalUpdater,
};

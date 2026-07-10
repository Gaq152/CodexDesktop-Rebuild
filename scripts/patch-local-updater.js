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
const { relPath, SRC_DIR } = require("./patch-util");

const DEFAULT_WINDOWS_UPDATE_URL =
  "https://github.com/Gaq152/CodexDesktop-Rebuild/releases/download/windows-update-feed";
const START_MARKER = "/* CodexRebuildLocalUpdater:start */";
const END_MARKER = "/* CodexRebuildLocalUpdater:end */";
const FILE_END_MARKER = "/* CodexRebuildLocalUpdater:file-end */";
const PRELOAD_START_MARKER = "/* CodexRebuildUpdaterPreload:start */";
const PRELOAD_END_MARKER = "/* CodexRebuildUpdaterPreload:end */";
const MAIN_MENU_START_MARKER = "/* CodexRebuildUpdaterMainMenu:start */";
const MAIN_MENU_END_MARKER = "/* CodexRebuildUpdaterMainMenu:end */";
const WEBVIEW_UPDATER_MENU_ID = "codex-rebuild-updater-top";
const WEBVIEW_MENU_BAR_ITEM =
  "{id:'codex-rebuild-updater-top',message:{id:`windowsMenuBar.checkUpdates`,defaultMessage:`检查更新`,description:`Label for the update menu in the desktop application menu bar`}}";

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

function makePreloadPatch(electronAlias = "e") {
  return `${PRELOAD_START_MARKER}
;(()=>{try{
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
  return `${PRELOAD_START_MARKER}
;(()=>{try{
  const channelState='codex_rebuild:update-state';
  const channelCommand='codex_rebuild:update-command';
  const listeners=new Set;
  const invoke=command=>e.ipcRenderer.invoke(channelCommand,{command});
  const updaterApi={
    getState:()=>invoke('get-state'),
    checkForUpdates:()=>invoke('check'),
    downloadUpdate:()=>invoke('download'),
    installUpdate:()=>invoke('install'),
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
      available:'有新版本',
      downloading:'正在下载更新...',
      preparing:'正在准备更新...',
      ready:'重启安装',
      noUpdate:'已是最新版本',
      error:'检查失败',
      tooltipIdle:'检查 Codex 更新',
      tooltipChecking:'正在检查更新',
      tooltipAvailable:'发现新版本，点击查看',
      tooltipDownloading:'正在下载更新，点击查看进度',
      tooltipPreparing:'下载完成，正在准备更新',
      tooltipReady:'更新已就绪，点击查看',
      tooltipNoUpdate:'当前已经是最新版本',
      tooltipError:'更新检查失败，点击查看',
      titleChecking:'正在检查更新',
      titleAvailable:'发现新版本',
      titleDownloading:'正在下载更新',
      titlePreparing:'正在准备更新',
      titleReady:'更新已下载',
      titleError:'检查更新失败',
      currentVersion:'当前版本',
      newVersion:'新版本',
      packageSize:'更新包',
      progress:'进度',
      downloaded:'已下载',
      elapsed:'耗时',
      update:'更新',
      cancel:'取消',
      close:'收起',
      retry:'重试',
      install:'重启安装',
      later:'稍后',
      unknown:'-',
      availableBody:'确认后开始下载，下载完成后再重启安装。',
      preparingBody:'下载已完成，正在合并差分包并准备安装。',
      readyBody:'重启 Codex 后会自动完成安装。'
    }:{
      idle:'Check updates',
      checking:'Checking...',
      available:'Update available',
      downloading:'Downloading update...',
      preparing:'Preparing update...',
      ready:'Restart to update',
      noUpdate:'Up to date',
      error:'Update failed',
      tooltipIdle:'Check for Codex updates',
      tooltipChecking:'Checking for updates',
      tooltipAvailable:'Update available. Click for details',
      tooltipDownloading:'Downloading update. Click for progress',
      tooltipPreparing:'Download complete. Preparing update',
      tooltipReady:'Update ready. Click for details',
      tooltipNoUpdate:'Codex is up to date',
      tooltipError:'Update check failed. Click for details',
      titleChecking:'Checking for updates',
      titleAvailable:'Update available',
      titleDownloading:'Downloading update',
      titlePreparing:'Preparing update',
      titleReady:'Update downloaded',
      titleError:'Update check failed',
      currentVersion:'Current version',
      newVersion:'New version',
      packageSize:'Package',
      progress:'Progress',
      downloaded:'Downloaded',
      elapsed:'Elapsed',
      update:'Update',
      cancel:'Cancel',
      close:'Close',
      retry:'Retry',
      install:'Restart to update',
      later:'Later',
      unknown:'-',
      availableBody:'Download starts only after you confirm. Restart after the download finishes.',
      preparingBody:'Download complete. Preparing the update package.',
      readyBody:'Restart Codex to finish installing the update.'
    };
    const escapeHtml=value=>String(value==null?text.unknown:value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const formatVersion=value=>value?String(value):text.unknown;
    const formatBytes=value=>{
      const n=Number(value);
      if(!Number.isFinite(n)||n<=0)return text.unknown;
      const units=['B','KB','MB','GB'];
      let size=n,index=0;
      while(size>=1024&&index<units.length-1){size/=1024;index+=1}
      const digits=index===0?0:size>=100?0:size>=10?1:2;
      return size.toFixed(digits)+' '+units[index];
    };
    const formatElapsed=value=>{
      const ms=Number(value);
      if(!Number.isFinite(ms)||ms<0)return text.unknown;
      const total=Math.floor(ms/1000);
      const minutes=Math.floor(total/60);
      const seconds=total%60;
      if(zh)return minutes>0?minutes+'分'+String(seconds).padStart(2,'0')+'秒':seconds+'秒';
      return minutes>0?minutes+'m '+String(seconds).padStart(2,'0')+'s':seconds+'s';
    };
    const progressOf=state=>{
      const total=Number(state.activeDownloadSize||state.updateSize);
      const done=Number(state.downloadedBytes);
      if(!Number.isFinite(total)||total<=0||!Number.isFinite(done)||done<0)return null;
      return Math.max(0,Math.min(100,done/total*100));
    };
    const row=(label,value)=>'<div class="row"><span>'+escapeHtml(label)+'</span><strong>'+escapeHtml(value)+'</strong></div>';
    const action=(kind,label,variant)=>'<button class="action '+(variant||'')+'" type="button" data-action="'+kind+'">'+escapeHtml(label)+'</button>';
    const host=document.createElement('div');
    host.id='codex-rebuild-updater';
    const root=host.attachShadow?host.attachShadow({mode:'open'}):host;
    const style=document.createElement('style');
    style.textContent=[
      ':host([hidden]){display:none!important}',
      ':host{position:fixed;right:20px;bottom:20px;z-index:2147483647;pointer-events:none;-webkit-app-region:no-drag;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;width:min(220px,calc(100vw - 40px));}',
      '.trigger{-webkit-app-region:no-drag;user-select:none;pointer-events:auto;height:30px;width:100%;display:inline-flex;align-items:center;justify-content:flex-start;gap:8px;border-radius:7px;border:1px solid color-mix(in srgb,var(--color-token-border-default,#4b5563) 70%,transparent);background:color-mix(in srgb,var(--color-token-main-surface-primary,#111827) 86%,transparent);color:var(--color-token-text-secondary,#c4c7c5);box-shadow:0 8px 24px rgba(0,0,0,.18);backdrop-filter:blur(10px);font-size:12px;font-weight:500;line-height:1;padding:0 10px;opacity:.72;transition:opacity .16s ease,background .16s ease,border-color .16s ease,color .16s ease;overflow:hidden;cursor:pointer}',
      '.trigger:hover,.trigger.open{opacity:1;background:color-mix(in srgb,var(--color-token-main-surface-primary,#111827) 96%,white 4%)}',
      '.mark{width:7px;height:7px;border-radius:999px;background:currentColor;opacity:.75;flex:0 0 auto}',
      '.label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.checking,.downloading,.preparing{color:var(--color-token-text-primary,#f3f4f6);opacity:.9}',
      '.checking .mark,.downloading .mark,.preparing .mark{width:10px;height:10px;border:2px solid currentColor;border-top-color:transparent;background:transparent;animation:codex-rebuild-spin .8s linear infinite}',
      '.available{color:#f59e0b;border-color:color-mix(in srgb,#f59e0b 55%,transparent);background:color-mix(in srgb,#f59e0b 12%,var(--color-token-main-surface-primary,#111827));opacity:1}',
      '.ready{color:#10b981;border-color:color-mix(in srgb,#10b981 55%,transparent);background:color-mix(in srgb,#10b981 14%,var(--color-token-main-surface-primary,#111827));opacity:1}',
      '.no-update{color:#60a5fa;border-color:color-mix(in srgb,#60a5fa 45%,transparent);opacity:1}',
      '.error{color:#ef4444;border-color:color-mix(in srgb,#ef4444 55%,transparent);background:color-mix(in srgb,#ef4444 12%,var(--color-token-main-surface-primary,#111827));opacity:1}',
      '.panel{position:absolute;bottom:38px;right:0;width:min(324px,calc(100vw - 40px));max-height:calc(100vh - 128px);overflow:auto;pointer-events:auto;border:1px solid color-mix(in srgb,var(--color-token-border-default,#4b5563) 76%,transparent);border-radius:8px;background:color-mix(in srgb,var(--color-token-main-surface-primary,#111827) 96%,black 4%);color:var(--color-token-text-primary,#f3f4f6);box-shadow:0 18px 48px rgba(0,0,0,.34);padding:12px;box-sizing:border-box;opacity:0;visibility:hidden;transform:translateY(4px);transition:opacity .14s ease,visibility .14s ease,transform .14s ease;backdrop-filter:blur(14px)}',
      '.panel.open{opacity:1;visibility:visible;transform:translateY(0)}',
      '.title{font-size:13px;font-weight:650;line-height:1.3;margin:0 0 8px;color:var(--color-token-text-primary,#f3f4f6)}',
      '.body{font-size:12px;line-height:1.45;margin:0 0 10px;color:var(--color-token-text-secondary,#c4c7c5)}',
      '.row{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:22px;font-size:12px;color:var(--color-token-text-secondary,#c4c7c5)}',
      '.row strong{min-width:0;max-width:176px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:var(--color-token-text-primary,#f3f4f6);font-weight:550}',
      '.meter{height:6px;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--color-token-border-default,#4b5563) 48%,transparent);margin:9px 0 8px}',
      '.meter span{display:block;height:100%;width:0;background:#10b981;transition:width .18s ease}',
      '.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}',
      '.action{-webkit-app-region:no-drag;border:0;border-radius:7px;height:28px;padding:0 11px;font-size:12px;font-weight:550;background:color-mix(in srgb,var(--color-token-main-surface-secondary,#1f2937) 86%,white 8%);color:var(--color-token-text-primary,#f3f4f6);cursor:pointer}',
      '.action:hover{background:color-mix(in srgb,var(--color-token-main-surface-secondary,#1f2937) 76%,white 16%)}',
      '.action.primary{background:#0f766e;color:white}.action.primary:hover{background:#0d9488}',
      '.action.subtle{color:var(--color-token-text-secondary,#c4c7c5)}',
      '@keyframes codex-rebuild-spin{to{transform:rotate(360deg)}}',
      '@media(max-width:720px){:host{right:10px;bottom:10px;width:min(220px,calc(100vw - 20px))}.panel{right:0;width:min(324px,calc(100vw - 20px))}}'
    ].join('\\n');
    const button=document.createElement('button');
    button.type='button';
    button.className='trigger';
    button.innerHTML='<span class="mark" aria-hidden="true"></span><span class="label"></span>';
    button.setAttribute('aria-haspopup','dialog');
    const panel=document.createElement('div');
    panel.className='panel';
    panel.setAttribute('role','dialog');
    host.hidden=true;
    root.append(style,button,panel);
    document.documentElement.appendChild(host);
    const label=button.querySelector('.label');
    let open=false;
    let current={status:'idle'};
    const visibleStatuses=new Set(['checking','available','downloading','preparing','ready','no-update','error']);
    const buildPanel=state=>{
      const status=state.status||'idle';
      const currentVersion=formatVersion(state.version||state.appVersion);
      const updateVersion=formatVersion(state.updateVersion);
      const total=state.activeDownloadSize||state.updateSize;
      if(status==='available'){
        return '<div class="title">'+escapeHtml(text.titleAvailable)+'</div><p class="body">'+escapeHtml(text.availableBody)+'</p>'+row(text.currentVersion,currentVersion)+row(text.newVersion,updateVersion)+row(text.packageSize,formatBytes(state.updateSize))+'<div class="actions">'+action('close',text.cancel,'subtle')+action('download',text.update,'primary')+'</div>';
      }
      if(status==='downloading'||status==='preparing'){
        const pct=progressOf(state);
        const pctText=pct==null?text.unknown:Math.floor(pct)+'%';
        const width=pct==null?8:pct;
        const preparing=status==='preparing';
        return '<div class="title">'+escapeHtml(preparing?text.titlePreparing:text.titleDownloading)+'</div>'+(preparing?'<p class="body">'+escapeHtml(text.preparingBody)+'</p>':'')+row(text.currentVersion,currentVersion)+row(text.newVersion,updateVersion)+row(text.progress,pctText)+'<div class="meter" aria-hidden="true"><span style="width:'+Math.max(3,Math.min(100,width))+'%"></span></div>'+row(text.downloaded,formatBytes(state.downloadedBytes)+' / '+formatBytes(total))+row(text.elapsed,formatElapsed(state.elapsedMs))+'<div class="actions">'+action('close',text.close,'subtle')+'</div>';
      }
      if(status==='ready'){
        return '<div class="title">'+escapeHtml(text.titleReady)+'</div><p class="body">'+escapeHtml(text.readyBody)+'</p>'+row(text.currentVersion,currentVersion)+row(text.newVersion,updateVersion)+'<div class="actions">'+action('close',text.later,'subtle')+action('install',text.install,'primary')+'</div>';
      }
      if(status==='error'){
        return '<div class="title">'+escapeHtml(text.titleError)+'</div><p class="body">'+escapeHtml(state.error||text.tooltipError)+'</p><div class="actions">'+action('close',text.cancel,'subtle')+action('retry',text.retry,'primary')+'</div>';
      }
      if(status==='checking'){
        return '<div class="title">'+escapeHtml(text.titleChecking)+'</div>'+row(text.currentVersion,currentVersion)+'<div class="actions">'+action('close',text.close,'subtle')+'</div>';
      }
      return '';
    };
    const render=state=>{
      current=state||current||{status:'idle'};
      const status=current.status||'idle';
      const visible=visibleStatuses.has(status);
      host.toggleAttribute('hidden',!visible);
      if(!visible){open=false;panel.innerHTML=''}
      const canOpen=status==='available'||status==='downloading'||status==='preparing'||status==='ready'||status==='error'||status==='checking';
      if(!canOpen)open=false;
      button.className='trigger '+status+(open?' open':'');
      const statusLabel=status==='no-update'?text.noUpdate:text[status]||text.idle;
      const tooltipByStatus={idle:text.tooltipIdle,checking:text.tooltipChecking,available:text.tooltipAvailable,downloading:text.tooltipDownloading,preparing:text.tooltipPreparing,ready:text.tooltipReady,'no-update':text.tooltipNoUpdate,error:text.tooltipError};
      label.textContent=statusLabel;
      button.title=current.error&&status==='error'?text.tooltipError+': '+current.error:(tooltipByStatus[status]||text.tooltipIdle);
      button.setAttribute('aria-label',button.title);
      button.setAttribute('aria-expanded',open?'true':'false');
      panel.className='panel '+(open&&canOpen?'open':'');
      panel.innerHTML=open&&canOpen?buildPanel(current):'';
    };
    button.addEventListener('click',()=>{
      const status=current?.status||'idle';
      if(status==='available'||status==='downloading'||status==='preparing'||status==='ready'||status==='error'||status==='checking'){
        open=!open;
        render(current);
        return;
      }
      updaterApi.checkForUpdates().catch(()=>{});
    });
    panel.addEventListener('click',event=>{
      const target=event.target&&event.target.closest?event.target.closest('[data-action]'):null;
      const command=target?.getAttribute?.('data-action');
      if(!command)return;
      if(command==='close'){
        open=false;
        render(current);
      }else if(command==='download'){
        open=true;
        updaterApi.downloadUpdate().then(render).catch(()=>{});
      }else if(command==='install'){
        updaterApi.installUpdate().catch(()=>{});
      }else if(command==='retry'){
        open=false;
        render(current);
        updaterApi.checkForUpdates().then(render).catch(()=>{});
      }
    });
    document.addEventListener('pointerdown',event=>{
      if(!open)return;
      const path=event.composedPath?event.composedPath():[];
      if(path.includes(host))return;
      open=false;
      render(current);
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

function makeMainMenuPatch(electronAlias = "a") {
  const patch = `${MAIN_MENU_START_MARKER}
(()=>{
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

function countOccurrences(source, token) {
  return source.split(token).length - 1;
}

function patchMainMenuCode(code) {
  const startCount = countOccurrences(code, MAIN_MENU_START_MARKER);
  const endCount = countOccurrences(code, MAIN_MENU_END_MARKER);
  if (startCount > 0 || endCount > 0) {
    if (startCount !== 1) {
      throw new Error(
        `Windows main menu start marker expected exactly 1 target, found ${startCount}`,
      );
    }
    if (endCount !== 1) {
      throw new Error(
        `Windows main menu end marker expected exactly 1 target, found ${endCount}`,
      );
    }
    return code;
  }
  const shape = analyzeMainMenuCode(code);
  const patch = makeMainMenuPatch(shape.electronAlias);
  return applyReplacements(code, [
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
}

function makeWebviewMenuBarFunctionPatch() {
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

function patchWebviewMenuBarCode(code) {
  const functionCount = countOccurrences(
    code,
    "function codexRebuildUpdaterEnsureTitlebarStyle",
  );
  const itemCount = countOccurrences(
    code,
    "{id:'codex-rebuild-updater-top',message:",
  );
  if (functionCount > 0 || itemCount > 0) {
    if (functionCount !== 1) {
      throw new Error(
        `Windows webview updater function expected exactly 1 target, found ${functionCount}`,
      );
    }
    if (itemCount !== 1) {
      throw new Error(
        `Windows webview updater item expected exactly 1 target, found ${itemCount}`,
      );
    }
    return code;
  }
  const shape = analyzeWebviewMenuBarCode(code);
  return applyReplacements(code, [
    {
      start: shape.menuArray.end - 1,
      end: shape.menuArray.end - 1,
      text: `,${WEBVIEW_MENU_BAR_ITEM}`,
    },
    {
      start: shape.menuFunction.start,
      end: shape.menuFunction.end,
      text: bindWebviewMenuBarPatch(makeWebviewMenuBarFunctionPatch(), shape),
    },
  ]);
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
    const matches = [
      ...entrySource.matchAll(
        /require\(\s*(["'`])(\.\/bootstrap(?:-[A-Za-z0-9_$-]+)?\.js)\1\s*\)/g,
      ),
    ];
    const targets = [...new Set(matches.map((match) => match[2]))];
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

function patchBootstrapCode(code) {
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error("resolved Windows runtime bootstrap is empty");
  }
  const markerCounts = [START_MARKER, END_MARKER, FILE_END_MARKER].map((marker) =>
    countOccurrences(code, marker),
  );
  if (markerCounts.some((count) => count > 0)) {
    for (const [index, label] of ["start", "end", "file-end"].entries()) {
      if (markerCounts[index] !== 1) {
        throw new Error(
          `Windows runtime bootstrap ${label} marker expected exactly 1 target, ` +
            `found ${markerCounts[index]}`,
        );
      }
    }
    if (!code.includes("codex_rebuild:update-command")) {
      throw new Error("Windows runtime bootstrap updater command is incomplete");
    }
    return { code, status: "already", counts: localLayerCount("already") };
  }
  return {
    code: `${makeBootstrapPrefix()}${code}\n}\n${FILE_END_MARKER}\n`,
    status: "patched",
    counts: localLayerCount("patched"),
  };
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

function patchPreloadCode(code) {
  const startCount = countOccurrences(code, PRELOAD_START_MARKER);
  const endCount = countOccurrences(code, PRELOAD_END_MARKER);
  if (startCount > 0 || endCount > 0) {
    if (startCount !== 1) {
      throw new Error(
        `Windows preload updater start marker expected exactly 1 target, found ${startCount}`,
      );
    }
    if (endCount !== 1) {
      throw new Error(
        `Windows preload updater end marker expected exactly 1 target, found ${endCount}`,
      );
    }
    if (!/exposeInMainWorld\(\s*["'`]codexRebuildUpdater["'`]/.test(code)) {
      throw new Error("Windows preload updater bridge is incomplete");
    }
    return { code, status: "already", counts: localLayerCount("already") };
  }
  const electronAlias = findElectronBinding(code);
  const patch = makePreloadPatch(electronAlias);
  const sourceMap = "\n//# sourceMappingURL=preload.js.map";
  const next = code.includes(sourceMap)
    ? code.replace(sourceMap, `\n${patch}${sourceMap}`)
    : `${code}\n${patch}\n`;
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

function makePlannedLayer(pathName, result) {
  return { path: pathName, status: result.status, counts: result.counts };
}

function planLocalUpdaterSources({ packageSource, files, updateUrl = DEFAULT_WINDOWS_UPDATE_URL }) {
  if (typeof packageSource !== "string") throw new Error("Windows package metadata is required");
  if (!files || typeof files !== "object") throw new Error("Windows ASAR sources are required");
  const normalizedFiles = {};
  for (const [fileName, source] of Object.entries(files)) {
    normalizedFiles[normalizeAsarPath(fileName)] = source;
  }
  const resolved = resolveRuntimeBootstrap(packageSource, (fileName) => normalizedFiles[fileName]);
  const mainNames = Object.keys(normalizedFiles).filter((fileName) =>
    /^\.vite\/build\/main-.*\.js$/.test(fileName),
  );
  const webviewNames = Object.keys(normalizedFiles).filter((fileName) => {
    if (!/^webview\/assets\/app-shell-.*\.js$/.test(fileName)) return false;
    const source = normalizedFiles[fileName];
    return (
      source.includes("function codexRebuildUpdaterEnsureTitlebarStyle") ||
      (source.includes("windowsMenuBar.help") && source.includes("showApplicationMenu"))
    );
  });
  if (mainNames.length !== 1) {
    throw new Error(`Windows main menu expected exactly 1 target, found ${mainNames.length}`);
  }
  if (webviewNames.length !== 1) {
    throw new Error(`Windows webview titlebar expected exactly 1 target, found ${webviewNames.length}`);
  }
  const preloadPath = ".vite/build/preload.js";
  if (typeof normalizedFiles[preloadPath] !== "string") {
    throw new Error("Windows preload expected exactly 1 target, found 0");
  }

  const metadata = patchPackageMetadataSource(packageSource, updateUrl);
  const backend = patchBootstrapCode(normalizedFiles[resolved.runtimePath]);
  const preload = patchPreloadCode(normalizedFiles[preloadPath]);
  const mainCode = patchMainMenuCode(normalizedFiles[mainNames[0]]);
  const webviewCode = patchWebviewMenuBarCode(normalizedFiles[webviewNames[0]]);
  const mainMenu = {
    code: mainCode,
    status: mainCode === normalizedFiles[mainNames[0]] ? "already" : "patched",
  };
  mainMenu.counts = localLayerCount(mainMenu.status);
  const webview = {
    code: webviewCode,
    status: webviewCode === normalizedFiles[webviewNames[0]] ? "already" : "patched",
  };
  webview.counts = localLayerCount(webview.status);

  const outputs = [
    { path: "package.json", source: packageSource, result: metadata },
    { path: resolved.runtimePath, source: normalizedFiles[resolved.runtimePath], result: backend },
    { path: preloadPath, source: normalizedFiles[preloadPath], result: preload },
    { path: mainNames[0], source: normalizedFiles[mainNames[0]], result: mainMenu },
    { path: webviewNames[0], source: normalizedFiles[webviewNames[0]], result: webview },
  ];
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
      mainMenu: makePlannedLayer(mainNames[0], mainMenu),
      webview: makePlannedLayer(webviewNames[0], webview),
    },
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

function patchMainMenu() {
  const buildDir = path.join(SRC_DIR, "win", "_asar", ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    console.log("  [ok] Windows main bundle directory not found");
    return;
  }

  const candidates = fs
    .readdirSync(buildDir)
    .filter((name) => /^main-.*\.js$/.test(name))
    .map((name) => path.join(buildDir, name));
  const mainPath = candidates.find((candidate) => {
    const code = fs.readFileSync(candidate, "utf-8");
    return code.includes(MAIN_MENU_START_MARKER) || code.includes("let _t=[]");
  });
  if (!mainPath) {
    console.log("  [ok] Windows main menu extension point not found");
    return;
  }

  const code = fs.readFileSync(mainPath, "utf-8");
  const next = patchMainMenuCode(code);
  if (next === code) {
    console.log(`  [ok] ${relPath(mainPath)}: updater menu already patched`);
    return;
  }

  fs.writeFileSync(mainPath, next, "utf-8");
  console.log(`  [ok] ${relPath(mainPath)}: added updater menu entries`);
}

function patchWebviewMenuBar() {
  const assetsDir = path.join(SRC_DIR, "win", "_asar", "webview", "assets");
  if (!fs.existsSync(assetsDir)) {
    console.log("  [ok] Windows webview assets directory not found");
    return;
  }

  const candidates = fs
    .readdirSync(assetsDir)
    .filter((name) => /^app-shell-.*\.js$/.test(name))
    .map((name) => path.join(assetsDir, name));
  const menuBarPath = candidates.find((candidate) => {
    const code = fs.readFileSync(candidate, "utf-8");
    return code.includes("windowsMenuBar.help") && code.includes("$r=[{id:_.file");
  });
  if (!menuBarPath) {
    console.log("  [ok] Windows webview menu bar extension point not found");
    return;
  }

  const code = fs.readFileSync(menuBarPath, "utf-8");
  const next = patchWebviewMenuBarCode(code);
  if (next === code) {
    console.log(`  [ok] ${relPath(menuBarPath)}: updater titlebar menu already patched`);
    return;
  }

  fs.writeFileSync(menuBarPath, next, "utf-8");
  console.log(`  [ok] ${relPath(menuBarPath)}: added updater titlebar menu`);
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
  makeBootstrapPrefix,
  makePreloadPatch,
  makeMainMenuPatch,
  patchMainMenuCode,
  patchWebviewMenuBarCode,
  resolveRuntimeBootstrap,
  patchBootstrapCode,
  patchPreloadCode,
  patchPackageMetadataSource,
  planLocalUpdaterSources,
  executeLocalUpdater,
};

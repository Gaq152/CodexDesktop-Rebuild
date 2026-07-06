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
  "https://github.com/Gaq152/CodexDesktop-Rebuild/releases/download/windows-update-feed";
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
    setStatus('downloading',{downloadedBytes,elapsedMs,activeDownloadFile:file,activeDownloadSize});
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
      setStatus(manual?'error':'idle',{error:message,lastCheckedAt:Date.now()},manual?8000:0);
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
      setStatus('error',{error:message,lastCheckedAt:Date.now()},8000);
    }
    return emit();
  };
  try{
    if(ipcMain&&!globalThis.__CodexRebuildUpdaterIpcRegistered){
      globalThis.__CodexRebuildUpdaterIpcRegistered=!0;
      ipcMain.handle('codex_rebuild:update-command',async(_event,request)=>{
        let command=typeof request==='string'?request:request?.command;
        if(command==='get-state')return emit();
        if(command==='check')return checkOnly(!0);
        if(command==='download')return startDownload();
        if(command==='install'){
          if(downloaded){autoUpdater.quitAndInstall();return emit()}
          return startDownload();
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
    setStatus('error',{error:message,lastCheckedAt:Date.now()},8000);
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

function makePreloadPatch() {
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
      ready:'重启安装',
      noUpdate:'已是最新版本',
      error:'检查失败',
      tooltipIdle:'检查 Codex 更新',
      tooltipChecking:'正在检查更新',
      tooltipAvailable:'发现新版本，点击查看',
      tooltipDownloading:'正在下载更新，点击查看进度',
      tooltipReady:'更新已就绪，点击查看',
      tooltipNoUpdate:'当前已经是最新版本',
      tooltipError:'更新检查失败，点击查看',
      titleChecking:'正在检查更新',
      titleAvailable:'发现新版本',
      titleDownloading:'正在下载更新',
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
      readyBody:'重启 Codex 后会自动完成安装。'
    }:{
      idle:'Check updates',
      checking:'Checking...',
      available:'Update available',
      downloading:'Downloading update...',
      ready:'Restart to update',
      noUpdate:'Up to date',
      error:'Update failed',
      tooltipIdle:'Check for Codex updates',
      tooltipChecking:'Checking for updates',
      tooltipAvailable:'Update available. Click for details',
      tooltipDownloading:'Downloading update. Click for progress',
      tooltipReady:'Update ready. Click for details',
      tooltipNoUpdate:'Codex is up to date',
      tooltipError:'Update check failed. Click for details',
      titleChecking:'Checking for updates',
      titleAvailable:'Update available',
      titleDownloading:'Downloading update',
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
      ':host{position:fixed;top:8px;right:138px;z-index:2147483647;pointer-events:none;-webkit-app-region:no-drag;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.trigger{-webkit-app-region:no-drag;user-select:none;pointer-events:auto;height:28px;max-width:min(260px,calc(100vw - 180px));display:inline-flex;align-items:center;gap:7px;border-radius:7px;border:1px solid color-mix(in srgb,var(--color-token-border-default,#4b5563) 70%,transparent);background:color-mix(in srgb,var(--color-token-main-surface-primary,#111827) 86%,transparent);color:var(--color-token-text-secondary,#c4c7c5);box-shadow:0 8px 24px rgba(0,0,0,.18);backdrop-filter:blur(10px);font-size:12px;font-weight:500;line-height:1;padding:0 10px;opacity:.62;transition:opacity .16s ease,background .16s ease,border-color .16s ease,color .16s ease,transform .16s ease;white-space:nowrap;overflow:hidden;cursor:pointer}',
      '.trigger:hover,.trigger.open{opacity:1;background:color-mix(in srgb,var(--color-token-main-surface-primary,#111827) 96%,white 4%);transform:translateY(1px)}',
      '.mark{width:7px;height:7px;border-radius:999px;background:currentColor;opacity:.75;flex:0 0 auto}',
      '.label{overflow:hidden;text-overflow:ellipsis}',
      '.checking,.downloading{color:var(--color-token-text-primary,#f3f4f6);opacity:.9}',
      '.checking .mark,.downloading .mark{width:10px;height:10px;border:2px solid currentColor;border-top-color:transparent;background:transparent;animation:codex-rebuild-spin .8s linear infinite}',
      '.available{color:#f59e0b;border-color:color-mix(in srgb,#f59e0b 55%,transparent);background:color-mix(in srgb,#f59e0b 12%,var(--color-token-main-surface-primary,#111827));opacity:1}',
      '.ready{color:#10b981;border-color:color-mix(in srgb,#10b981 55%,transparent);background:color-mix(in srgb,#10b981 14%,var(--color-token-main-surface-primary,#111827));opacity:1}',
      '.no-update{color:#60a5fa;border-color:color-mix(in srgb,#60a5fa 45%,transparent);opacity:1}',
      '.error{color:#ef4444;border-color:color-mix(in srgb,#ef4444 55%,transparent);background:color-mix(in srgb,#ef4444 12%,var(--color-token-main-surface-primary,#111827));opacity:1}',
      '.panel{position:absolute;top:36px;right:0;width:min(324px,calc(100vw - 24px));pointer-events:auto;border:1px solid color-mix(in srgb,var(--color-token-border-default,#4b5563) 76%,transparent);border-radius:8px;background:color-mix(in srgb,var(--color-token-main-surface-primary,#111827) 96%,black 4%);color:var(--color-token-text-primary,#f3f4f6);box-shadow:0 18px 48px rgba(0,0,0,.34);padding:12px;box-sizing:border-box;opacity:0;visibility:hidden;transform:translateY(-4px);transition:opacity .14s ease,visibility .14s ease,transform .14s ease;backdrop-filter:blur(14px)}',
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
      '@media(max-width:720px){:host{right:96px}.label{display:none}.trigger{width:28px;padding:0;justify-content:center}.panel{right:-72px}}'
    ].join('\\n');
    const button=document.createElement('button');
    button.type='button';
    button.className='trigger';
    button.innerHTML='<span class="mark" aria-hidden="true"></span><span class="label"></span>';
    button.setAttribute('aria-haspopup','dialog');
    const panel=document.createElement('div');
    panel.className='panel';
    panel.setAttribute('role','dialog');
    root.append(style,button,panel);
    document.documentElement.appendChild(host);
    const label=button.querySelector('.label');
    let open=false;
    let current={status:'idle'};
    const buildPanel=state=>{
      const status=state.status||'idle';
      const currentVersion=formatVersion(state.version||state.appVersion);
      const updateVersion=formatVersion(state.updateVersion);
      const total=state.activeDownloadSize||state.updateSize;
      if(status==='available'){
        return '<div class="title">'+escapeHtml(text.titleAvailable)+'</div><p class="body">'+escapeHtml(text.availableBody)+'</p>'+row(text.currentVersion,currentVersion)+row(text.newVersion,updateVersion)+row(text.packageSize,formatBytes(state.updateSize))+'<div class="actions">'+action('close',text.cancel,'subtle')+action('download',text.update,'primary')+'</div>';
      }
      if(status==='downloading'){
        const pct=progressOf(state);
        const pctText=pct==null?text.unknown:Math.floor(pct)+'%';
        const width=pct==null?8:pct;
        return '<div class="title">'+escapeHtml(text.titleDownloading)+'</div>'+row(text.currentVersion,currentVersion)+row(text.newVersion,updateVersion)+row(text.progress,pctText)+'<div class="meter" aria-hidden="true"><span style="width:'+Math.max(3,Math.min(100,width))+'%"></span></div>'+row(text.downloaded,formatBytes(state.downloadedBytes)+' / '+formatBytes(total))+row(text.elapsed,formatElapsed(state.elapsedMs))+'<div class="actions">'+action('close',text.close,'subtle')+'</div>';
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
      const canOpen=status==='available'||status==='downloading'||status==='ready'||status==='error'||status==='checking';
      if(!canOpen)open=false;
      button.className='trigger '+status+(open?' open':'');
      label.textContent=text[status]||text.idle;
      button.title=current.error&&status==='error'?text.tooltipError+': '+current.error:(text['tooltip'+status.charAt(0).toUpperCase()+status.slice(1)]||text.tooltipIdle);
      button.setAttribute('aria-label',button.title);
      button.setAttribute('aria-expanded',open?'true':'false');
      panel.className='panel '+(open&&canOpen?'open':'');
      panel.innerHTML=open&&canOpen?buildPanel(current):'';
    };
    button.addEventListener('click',()=>{
      const status=current?.status||'idle';
      if(status==='available'||status==='downloading'||status==='ready'||status==='error'||status==='checking'){
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

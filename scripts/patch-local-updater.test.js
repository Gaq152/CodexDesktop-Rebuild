#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadPatchHelpers() {
  const filePath = path.join(__dirname, "patch-local-updater.js");
  const source = fs
    .readFileSync(filePath, "utf8")
    .replace(
      /\nmain\(\);\s*$/,
      "\nmodule.exports = { makeBootstrapPrefix, makePreloadPatch, makeMainMenuPatch, patchMainMenuCode, patchWebviewMenuBarCode };\n",
    );
  const sandbox = {
    __dirname,
    console,
    module: { exports: {} },
    process: { argv: ["node", filePath], env: {} },
    require,
  };
  vm.runInNewContext(source, sandbox, { filename: filePath });
  return sandbox.module.exports;
}

const {
  makeBootstrapPrefix,
  makePreloadPatch,
  makeMainMenuPatch,
  patchMainMenuCode,
  patchWebviewMenuBarCode,
} =
  loadPatchHelpers();

{
  const bootstrap = makeBootstrapPrefix();

  assert.ok(bootstrap.includes("let {app,autoUpdater,dialog,ipcMain,BrowserWindow}=electron;"));
  assert.ok(
    bootstrap.includes(
      "CodexRebuildSetupLocalUpdater(app,autoUpdater,dialog,ipcMain,BrowserWindow)",
    ),
  );
  assert.ok(
    bootstrap.includes(
      "function CodexRebuildSetupLocalUpdater(app,autoUpdater,dialog,ipcMain,BrowserWindow){",
    ),
  );
  assert.ok(!bootstrap.includes("function CodexRebuildInstallUpdateMenu"));
  assert.ok(!bootstrap.includes("Menu.buildFromTemplate=function"));
  assert.ok(!bootstrap.includes("Menu.setApplicationMenu=function"));
  assert.ok(!bootstrap.includes("Menu.getApplicationMenu?.()"));
  assert.ok(bootstrap.includes("let isDownloadComplete=(done,total)=>"));
  assert.ok(
    bootstrap.includes(
      "setStatus(isDownloadComplete(downloadedBytes,activeDownloadSize)?'preparing':'downloading'",
    ),
  );
  assert.ok(bootstrap.includes("globalThis.__CodexRebuildUpdaterLastState=payload"));
  assert.ok(bootstrap.includes("globalThis.__CodexRebuildUpdaterMenuSetState?.(payload)"));
  assert.ok(bootstrap.includes("setStatus('ready',{error:null,downloadedBytes:state.activeDownloadSize"));
  assert.ok(!bootstrap.includes("let preview=kind=>{"));
  assert.ok(
    bootstrap.includes(
      "globalThis.__CodexRebuildUpdaterCommand={check:()=>checkOnly(!0),download:startDownload,install:installUpdate,clear:clearStatus};",
    ),
  );
  assert.ok(!bootstrap.includes("if(command==='preview')"));
  assert.ok(bootstrap.includes("if(command==='clear')return clearStatus();"));
  assert.ok(!bootstrap.includes("99.999.999999"));
}

{
  const preload = makePreloadPatch();

  assert.ok(preload.includes("downloadUpdate:()=>invoke('download')"));
  assert.ok(preload.includes("clearUpdateState:()=>invoke('clear')"));
  assert.ok(preload.includes("e.contextBridge.exposeInMainWorld('codexRebuildUpdater',updaterApi)"));
  assert.ok(!preload.includes("document.createElement('div')"));
  assert.ok(!preload.includes("codex-rebuild-updater"));
  assert.ok(!preload.includes("position:fixed"));
  assert.ok(!preload.includes("z-index:2147483647"));
  assert.ok(!preload.includes("attachShadow"));
}

{
  const mainMenu = makeMainMenuPatch();

  assert.ok(mainMenu.includes("/* CodexRebuildUpdaterMainMenu:start */"));
  assert.ok(mainMenu.includes("/* CodexRebuildUpdaterMainMenu:end */"));
  assert.ok(mainMenu.includes("helpItems:[]"));
  assert.ok(mainMenu.includes("topItems:["));
  assert.ok(mainMenu.includes("id:'codex-rebuild-updater-top'"));
  assert.ok(mainMenu.includes("label:'检查更新'"));
  assert.ok(mainMenu.includes("id:'codex-rebuild-updater-action-check'"));
  assert.ok(!mainMenu.includes("id:'codex-rebuild-check-for-updates'"));
  assert.ok(!mainMenu.includes("label:'检查更新...'"));
  assert.ok(mainMenu.includes("let command=globalThis.__CodexRebuildUpdaterCommand?.[name];"));
  assert.ok(mainMenu.includes("codexRebuildRunUpdaterCommand('check','checking')"));
  assert.ok(mainMenu.includes("codexRebuildRunUpdaterCommand('download','downloading')"));
  assert.ok(mainMenu.includes("codexRebuildRunUpdaterCommand('clear','idle')"));
  assert.ok(mainMenu.includes("codexRebuildUpdaterLabel"));
  assert.ok(mainMenu.includes("下载中 "));
  assert.ok(mainMenu.includes("codexRebuildUpdaterFormatBytes"));
  assert.ok(mainMenu.includes("globalThis.__CodexRebuildUpdaterLastState||{status:'idle'}"));
  assert.ok(mainMenu.includes("globalThis.__CodexRebuildUpdaterLastState=s"));
  assert.ok(mainMenu.includes("codexRebuildSendUpdaterFallback"));
  assert.ok(mainMenu.includes("if(checkingStatus)codexRebuildSendUpdaterFallback(checkingStatus);"));
  assert.ok(mainMenu.includes("codexRebuildSendUpdaterFallback('error'"));
  assert.ok(mainMenu.includes("更新组件尚未初始化"));
  assert.ok(!mainMenu.includes("codex-rebuild-update-preview"));
  assert.ok(!mainMenu.includes("更新 UI 预览"));
  assert.ok(!mainMenu.includes("CODEX_REBUILD_UPDATE_PREVIEW_MENU"));
  assert.ok(!mainMenu.includes("codexRebuildPreviewUpdaterState"));
  assert.ok(!mainMenu.includes("99.999.999999"));
  new vm.Script(`let _t=${mainMenu};`);

  const source =
    "let before=1;let _t=[];let vt=[{role:`help`,id:t.fo.help,submenu:[Ue,..._t,{type:`separator`},ye]}],yt=a.Menu.buildFromTemplate(vt);let after=2;";
  const patched = patchMainMenuCode(source);
  assert.ok(patched.includes("let _t="));
  assert.ok(patched.includes("/* CodexRebuildUpdaterMainMenu:start */"));
  assert.ok(patched.includes("..._t.helpItems,{type:`separator`}"));
  assert.ok(patched.includes("]},..._t.topItems],yt=a.Menu.buildFromTemplate(vt)"));
  assert.ok(!patched.includes("..._t,{type:`separator`}"));
  assert.ok(!patched.includes("let _t=[]"));
  assert.strictEqual(patchMainMenuCode(patched), patched);
}

{
  const source =
    "function Yr(){let e=D(),[t,n]=(0,Xr.useState)(null),r=(0,Xr.useRef)(0);if(!qr())return null;let i=async(e,t)=>{let i=window.electronBridge?.showApplicationMenu;if(!i)return;let a=r.current+1;r.current=a,n(e);let o=t.currentTarget.getBoundingClientRect();try{await i(e,Math.round(o.left),Math.round(o.bottom))}finally{r.current===a&&n(null)}};return(0,Zr.jsx)(`div`,{className:`flex items-center gap-0.5 pr-2 pl-1`,children:$r.map(({id:n,message:r})=>(0,Zr.jsx)(`button`,{type:`button`,`aria-expanded`:t===n,`aria-haspopup`:`menu`,`aria-label`:e.formatMessage(r),className:M(`no-drag rounded-md border border-transparent px-2.5 py-1 text-base font-normal leading-none outline-none transition-colors`,t===n?`bg-[var(--color-token-menubar-selection-background)] text-[var(--color-token-menubar-selection-foreground)]`:`text-token-text-tertiary hover:bg-token-foreground/5 hover:text-token-description-foreground focus-visible:bg-token-foreground/5 focus-visible:text-token-description-foreground`),onClick:e=>{i(n,e)},children:(0,Zr.jsx)(w,{...r})},n))})}var Xr,Zr,Qr,$r,ei=e((()=>{j(),v(),Xr=t(n(),1),C(),Jr(),Zr=r(),Qr=T({file:{id:`windowsMenuBar.file`,defaultMessage:`File`,description:`Label for the File menu in the desktop application menu bar`},edit:{id:`windowsMenuBar.edit`,defaultMessage:`Edit`,description:`Label for the Edit menu in the desktop application menu bar`},view:{id:`windowsMenuBar.view`,defaultMessage:`View`,description:`Label for the View menu in the desktop application menu bar`},help:{id:`windowsMenuBar.help`,defaultMessage:`Help`,description:`Label for the Help menu in the desktop application menu bar`}}),$r=[{id:_.file,message:Qr.file},{id:_.edit,message:Qr.edit},{id:_.view,message:Qr.view},{id:_.help,message:Qr.help}]}));";
  const patched = patchWebviewMenuBarCode(source);

  assert.ok(patched.includes("id:'codex-rebuild-updater-top'"));
  assert.ok(patched.includes("defaultMessage:`检查更新`"));
  assert.ok(patched.includes("function codexRebuildUpdaterMenuBarLabel"));
  assert.ok(patched.includes("function codexRebuildUpdaterEnsureTitlebarStyle"));
  assert.ok(patched.includes("function codexRebuildUpdaterBuildPanel"));
  assert.ok(patched.includes("window.codexRebuildUpdater"));
  assert.ok(patched.includes("下载中 "));
  assert.ok(patched.includes("cru-popover"));
  assert.ok(patched.includes("role:'dialog'"));
  assert.ok(patched.includes("'aria-live':'polite'"));
  assert.ok(patched.includes("downloadUpdate"));
  assert.ok(patched.includes("clearUpdateState"));
  assert.ok(patched.includes("if(s==='codex-rebuild-updater-top')"));
  assert.ok(
    patched.includes(
      "{id:_.help,message:Qr.help},{id:'codex-rebuild-updater-top'",
    ),
  );
  assert.strictEqual(patchWebviewMenuBarCode(patched), patched);
}

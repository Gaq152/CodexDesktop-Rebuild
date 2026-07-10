#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const vm = require("vm");

function withRealQuotedKeys(source) {
  return source
    .replaceAll("`aria-expanded`", "'aria-expanded'")
    .replaceAll("`aria-haspopup`", "'aria-haspopup'")
    .replaceAll("`aria-label`", "'aria-label'");
}

const {
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
} = require("./patch-local-updater");

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
  assert.throws(
    () =>
      patchMainMenuCode(
        `${patched}\n/* CodexRebuildUpdaterMainMenu:start */`,
      ),
    /main menu.*expected exactly 1.*found 2/i,
  );
}

{
  const source =
    "function Yr(){let e=D(),[t,n]=(0,Xr.useState)(null),r=(0,Xr.useRef)(0);if(!qr())return null;let i=async(e,t)=>{let i=window.electronBridge?.showApplicationMenu;if(!i)return;let a=r.current+1;r.current=a,n(e);let o=t.currentTarget.getBoundingClientRect();try{await i(e,Math.round(o.left),Math.round(o.bottom))}finally{r.current===a&&n(null)}};return(0,Zr.jsx)(`div`,{className:`flex items-center gap-0.5 pr-2 pl-1`,children:$r.map(({id:n,message:r})=>(0,Zr.jsx)(`button`,{type:`button`,`aria-expanded`:t===n,`aria-haspopup`:`menu`,`aria-label`:e.formatMessage(r),className:M(`no-drag rounded-md border border-transparent px-2.5 py-1 text-base font-normal leading-none outline-none transition-colors`,t===n?`bg-[var(--color-token-menubar-selection-background)] text-[var(--color-token-menubar-selection-foreground)]`:`text-token-text-tertiary hover:bg-token-foreground/5 hover:text-token-description-foreground focus-visible:bg-token-foreground/5 focus-visible:text-token-description-foreground`),onClick:e=>{i(n,e)},children:(0,Zr.jsx)(w,{...r})},n))})}var Xr,Zr,Qr,$r,ei=e((()=>{j(),v(),Xr=t(n(),1),C(),Jr(),Zr=r(),Qr=T({file:{id:`windowsMenuBar.file`,defaultMessage:`File`,description:`Label for the File menu in the desktop application menu bar`},edit:{id:`windowsMenuBar.edit`,defaultMessage:`Edit`,description:`Label for the Edit menu in the desktop application menu bar`},view:{id:`windowsMenuBar.view`,defaultMessage:`View`,description:`Label for the View menu in the desktop application menu bar`},help:{id:`windowsMenuBar.help`,defaultMessage:`Help`,description:`Label for the Help menu in the desktop application menu bar`}}),$r=[{id:_.file,message:Qr.file},{id:_.edit,message:Qr.edit},{id:_.view,message:Qr.view},{id:_.help,message:Qr.help}]}));";
  const patched = patchWebviewMenuBarCode(withRealQuotedKeys(source));

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
  assert.throws(
    () =>
      patchWebviewMenuBarCode(
        `${patched}\nfunction codexRebuildUpdaterEnsureTitlebarStyle(){}`,
      ),
    /webview updater.*expected exactly 1.*found 2/i,
  );
}

test("patchMainMenuCode adapts the latest menu aliases structurally", () => {
  const source =
    "let before=1;let Rt=[],zt=[{label:`File`},{role:`help`,id:n.To.help,submenu:[ot,...Rt,...t?[]:[{type:`separator`},je]]}],Bt=c.Menu.buildFromTemplate(zt);let after=2;";

  const patched = patchMainMenuCode(source);

  assert.match(patched, /CodexRebuildUpdaterMainMenu:start/);
  assert.match(patched, /c\.Menu\.getApplicationMenu/);
  assert.match(patched, /\.\.\.Rt\.helpItems/);
  assert.match(patched, /\.\.\.Rt\.topItems/);
  assert.strictEqual(patchMainMenuCode(patched), patched);
});

test("patchWebviewMenuBarCode adapts the latest titlebar aliases structurally", () => {
  const source =
    "import{a as dep}from\"./dep.js\";function Ti(){let e=S(),[t,n]=(0,Ei.useState)(null),r=(0,Ei.useRef)(0);if(!Ci())return null;let i=async(e,t)=>{let i=window.electronBridge?.showApplicationMenu;if(!i)return;let a=r.current+1;r.current=a,n(e);let o=t.currentTarget.getBoundingClientRect();try{await i(e,Math.round(o.left),Math.round(o.bottom))}finally{r.current===a&&n(null)}};return(0,Di.jsx)(`div`,{className:`flex items-center gap-0.5 pr-2 pl-1`,children:ki.map(({id:n,message:r})=>(0,Di.jsx)(`button`,{type:`button`,`aria-expanded`:t===n,`aria-haspopup`:`menu`,`aria-label`:e.formatMessage(r),className:M(`no-drag`,t===n?`selected`:`idle`),onClick:e=>{i(n,e)},children:(0,Di.jsx)(T,{...r})},n))})}var Ei,Di,Oi,ki,Ai=e((()=>{Ei=t(n(),1),Di=g(),Oi=C({file:{id:`windowsMenuBar.file`},edit:{id:`windowsMenuBar.edit`},view:{id:`windowsMenuBar.view`},help:{id:`windowsMenuBar.help`}}),ki=[{id:_.file,message:Oi.file},{id:_.edit,message:Oi.edit},{id:_.view,message:Oi.view},{id:_.help,message:Oi.help}]}));";

  const patched = patchWebviewMenuBarCode(withRealQuotedKeys(source));

  assert.match(patched, /id:'codex-rebuild-updater-top'/);
  assert.match(patched, /function Ti\(\)/);
  assert.match(patched, /\(0,Ei\.useState\)/);
  assert.match(patched, /\(0,Di\.jsx\)/);
  assert.match(patched, /if\(!Ci\(\)\)return null/);
  assert.match(patched, /children:ki\.map/);
  assert.match(patched, /\(0,Di\.jsx\)\(T,/);
  assert.strictEqual(patchWebviewMenuBarCode(patched), patched);
});

test("resolves early-bootstrap to the hashed runtime and patches that backend idempotently", () => {
  assert.equal(typeof resolveRuntimeBootstrap, "function");
  assert.equal(typeof patchBootstrapCode, "function");
  const packageSource = JSON.stringify({ main: ".vite/build/early-bootstrap.js" });
  const files = {
    ".vite/build/early-bootstrap.js":
      "require(`./src-BZqs_tzA.js`),Promise.resolve().then(()=>require(`./bootstrap-BXjiq4qE.js`));",
    ".vite/build/bootstrap-BXjiq4qE.js": "require(`./src-BZqs_tzA.js`);",
  };
  const resolved = resolveRuntimeBootstrap(packageSource, (file) => files[file]);
  assert.deepEqual(resolved, {
    entryPath: ".vite/build/early-bootstrap.js",
    runtimePath: ".vite/build/bootstrap-BXjiq4qE.js",
    viaEarlyBootstrap: true,
  });
  const first = patchBootstrapCode(files[resolved.runtimePath]);
  assert.equal(first.status, "patched");
  assert.match(first.code, /CodexRebuildLocalUpdater:start/);
  const second = patchBootstrapCode(first.code);
  assert.equal(second.status, "already");
  assert.equal(second.code, first.code);
  assert.throws(
    () =>
      patchBootstrapCode(
        `${first.code}\n/* CodexRebuildLocalUpdater:start */`,
      ),
    /runtime bootstrap.*expected exactly 1.*found 2/i,
  );
  assert.throws(
    () =>
      resolveRuntimeBootstrap(packageSource, (file) =>
        file.endsWith("early-bootstrap.js") ? "require(`./src-only.js`)" : undefined,
      ),
    /runtime bootstrap.*found 0/i,
  );
});

test("patches the latest preload electron binding without a hard-coded alias", () => {
  assert.equal(typeof patchPreloadCode, "function");
  const source = "let q=require(`electron`);\n//# sourceMappingURL=preload.js.map";
  const first = patchPreloadCode(source);
  assert.equal(first.status, "patched");
  assert.match(first.code, /q\.ipcRenderer\.invoke/);
  assert.match(first.code, /q\.contextBridge\.exposeInMainWorld/);
  const second = patchPreloadCode(first.code);
  assert.equal(second.status, "already");
  assert.equal(second.code, first.code);
  assert.throws(
    () =>
      patchPreloadCode(
        `${first.code}\n/* CodexRebuildUpdaterPreload:start */`,
      ),
    /preload updater.*expected exactly 1.*found 2/i,
  );
  assert.throws(() => patchPreloadCode("let value=1"), /electron binding.*found 0/i);
  assert.throws(
    () => patchPreloadCode("function hidden(){let q=require(`electron`)}"),
    /program-scope preload electron binding.*found 0/i,
  );
  assert.throws(
    () => patchPreloadCode("var q=require(`electron`);var q=require(`electron`)"),
    /program-scope preload electron binding.*found 2/i,
  );
});

test("plans all five updater layers before writing and keeps failed plans at zero writes", (t) => {
  assert.equal(typeof patchPackageMetadataSource, "function");
  assert.equal(typeof planLocalUpdaterSources, "function");
  assert.equal(typeof executeLocalUpdater, "function");
  const asarRoot = fs.mkdtempSync(path.join(os.tmpdir(), "patch-local-updater-"));
  t.after(() => fs.rmSync(asarRoot, { recursive: true, force: true }));
  const write = (relative, text) => {
    const file = path.join(asarRoot, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const packageSource = JSON.stringify({
    name: "openai-codex-electron",
    main: ".vite/build/early-bootstrap.js",
  });
  const earlySource = "Promise.resolve().then(()=>require(`./bootstrap-BXjiq4qE.js`));";
  const bootstrapSource = "require(`./src-BZqs_tzA.js`);";
  const preloadSource = "let q=require(`electron`);\n//# sourceMappingURL=preload.js.map";
  const mainSource =
    "let Rt=[],zt=[{label:`File`},{role:`help`,id:n.To.help,submenu:[ot,...Rt,...t?[]:[{type:`separator`},je]]}],Bt=c.Menu.buildFromTemplate(zt);";
  const webviewSource = withRealQuotedKeys(
    "function Ti(){let e=S(),[t,n]=(0,Ei.useState)(null),r=(0,Ei.useRef)(0);if(!Ci())return null;let i=async(e,t)=>{let i=window.electronBridge?.showApplicationMenu;if(!i)return;let a=r.current+1;r.current=a,n(e);let o=t.currentTarget.getBoundingClientRect();try{await i(e,Math.round(o.left),Math.round(o.bottom))}finally{r.current===a&&n(null)}};return(0,Di.jsx)(`div`,{className:`flex items-center gap-0.5 pr-2 pl-1`,children:ki.map(({id:n,message:r})=>(0,Di.jsx)(`button`,{type:`button`,`aria-expanded`:t===n,`aria-haspopup`:`menu`,`aria-label`:e.formatMessage(r),className:M(`no-drag`,t===n?`selected`:`idle`),onClick:e=>{i(n,e)},children:(0,Di.jsx)(T,{...r})},n))})}var Ei,Di,Oi,ki,Ai=e((()=>{Ei=t(n(),1),Di=g(),Oi=C({file:{id:`windowsMenuBar.file`},edit:{id:`windowsMenuBar.edit`},view:{id:`windowsMenuBar.view`},help:{id:`windowsMenuBar.help`}}),ki=[{id:_.file,message:Oi.file},{id:_.edit,message:Oi.edit},{id:_.view,message:Oi.view},{id:_.help,message:Oi.help}]}));",
  );
  write("package.json", packageSource);
  write(".vite/build/early-bootstrap.js", earlySource);
  write(".vite/build/bootstrap-BXjiq4qE.js", bootstrapSource);
  write(".vite/build/preload.js", preloadSource);
  write(".vite/build/main-CZpDUN17.js", mainSource);
  fs.mkdirSync(path.join(asarRoot, "webview", "assets"), { recursive: true });

  assert.throws(() => executeLocalUpdater({ asarRoot }), /webview.*expected exactly 1.*found 0/i);
  assert.equal(fs.readFileSync(path.join(asarRoot, "package.json"), "utf8"), packageSource);
  assert.equal(
    fs.readFileSync(path.join(asarRoot, ".vite", "build", "preload.js"), "utf8"),
    preloadSource,
  );

  write("webview/assets/app-shell-CVVppk_a.js", webviewSource);
  write("webview/assets/app-shell-ref-BQ-lb9Hp.js", "export const appShellRef={current:null};");
  write("webview/assets/app-shell-state-16Itmyrv.js", "export const state={ready:true};");
  write("webview/assets/app-shell-tab-controller-DuSW58a4.js", "export function tabs(){return []}");
  const beforeCheck = fs.readFileSync(path.join(asarRoot, "package.json"), "utf8");
  const check = executeLocalUpdater({ asarRoot, check: true });
  assert.equal(check.status, "patched");
  assert.equal(check.changes.length, 5);
  assert.equal(fs.readFileSync(path.join(asarRoot, "package.json"), "utf8"), beforeCheck);

  const originals = new Map(
    check.changes.map((change) => [
      change.path,
      fs.readFileSync(path.join(asarRoot, ...change.path.split("/")), "utf8"),
    ]),
  );
  let writeCount = 0;
  assert.throws(
    () =>
      executeLocalUpdater({
        asarRoot,
        writeFileSync(filePath, code, encoding) {
          writeCount += 1;
          fs.writeFileSync(filePath, writeCount === 3 ? "PARTIAL" : code, encoding);
          if (writeCount === 3) throw new Error("simulated partial write");
        },
      }),
    /write failed and was rolled back.*simulated partial write/i,
  );
  for (const [relative, original] of originals) {
    assert.equal(
      fs.readFileSync(path.join(asarRoot, ...relative.split("/")), "utf8"),
      original,
      `${relative} should be restored after a partial write failure`,
    );
  }

  const first = executeLocalUpdater({ asarRoot });
  assert.equal(first.changes.length, 5);
  assert.equal(first.layers.backend.path, ".vite/build/bootstrap-BXjiq4qE.js");
  assert.equal(first.layers.entry.path, ".vite/build/early-bootstrap.js");
  assert.equal(first.layers.entry.status, "native");
  const second = executeLocalUpdater({ asarRoot, check: true });
  assert.equal(second.status, "already");
  assert.equal(second.changes.length, 0);
});

#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const vm = require("vm");
const { EventEmitter } = require("events");
const crypto = require("crypto");
const http = require("http");

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
  DEFAULT_WINDOWS_UPDATE_PROXY_PREFIXES,
  normalizeUpdateProxyPrefixes,
  validateUpdateProxyPrefixes,
  buildPackageDownloadUrls,
  parseReleaseManifestEntries,
} = require("./patch-local-updater");

const LATEST_LOCAL_MAIN_SOURCE =
  "let Rt=[],zt=[{label:`File`},{role:`help`,id:n.To.help,submenu:[ot,...Rt,...t?[]:[{type:`separator`},je]]}],Bt=c.Menu.buildFromTemplate(zt);";
const LATEST_LOCAL_WEBVIEW_SOURCE = withRealQuotedKeys(
  "function Ti(){let e=S(),[t,n]=(0,Ei.useState)(null),r=(0,Ei.useRef)(0);if(!Ci())return null;let i=async(e,t)=>{let i=window.electronBridge?.showApplicationMenu;if(!i)return;let a=r.current+1;r.current=a,n(e);let o=t.currentTarget.getBoundingClientRect();try{await i(e,Math.round(o.left),Math.round(o.bottom))}finally{r.current===a&&n(null)}};return(0,Di.jsx)(`div`,{className:`flex items-center gap-0.5 pr-2 pl-1`,children:ki.map(({id:n,message:r})=>(0,Di.jsx)(`button`,{type:`button`,`aria-expanded`:t===n,`aria-haspopup`:`menu`,`aria-label`:e.formatMessage(r),className:M(`no-drag`,t===n?`selected`:`idle`),onClick:e=>{i(n,e)},children:(0,Di.jsx)(T,{...r})},n))})}var Ei,Di,Oi,ki,Ai=e((()=>{Ei=t(n(),1),Di=g(),Oi=C({file:{id:`windowsMenuBar.file`},edit:{id:`windowsMenuBar.edit`},view:{id:`windowsMenuBar.view`},help:{id:`windowsMenuBar.help`}}),ki=[{id:_.file,message:Oi.file},{id:_.edit,message:Oi.edit},{id:_.view,message:Oi.view},{id:_.help,message:Oi.help}]}));(0,Di.jsx)(Ti,{});",
);

function makeCleanLocalUpdaterSources() {
  return {
    packageSource: JSON.stringify({
      name: "openai-codex-electron",
      main: ".vite/build/early-bootstrap.js",
    }),
    files: {
      ".vite/build/early-bootstrap.js":
        "require(`./src-BZqs_tzA.js`),Promise.resolve().then(()=>require(`./bootstrap-BXjiq4qE.js`));",
      ".vite/build/bootstrap-BXjiq4qE.js": "require(`./src-BZqs_tzA.js`);",
      ".vite/build/preload.js":
        "let q=require(`electron`);\n//# sourceMappingURL=preload.js.map",
      ".vite/build/main-CZpDUN17.js": LATEST_LOCAL_MAIN_SOURCE,
      "webview/assets/app-shell-CVVppk_a.js": LATEST_LOCAL_WEBVIEW_SOURCE,
      "webview/assets/app-shell-ref-BQ-lb9Hp.js":
        "export const appShellRef={current:null};",
      "webview/assets/app-shell-state-16Itmyrv.js":
        "export const state={ready:true};",
    },
  };
}

function applyLocalUpdaterPlan(sources) {
  const plan = planLocalUpdaterSources(sources);
  const next = {
    packageSource: sources.packageSource,
    files: { ...sources.files },
  };
  for (const change of plan.changes) {
    if (change.path === "package.json") next.packageSource = change.code;
    else next.files[change.path] = change.code;
  }
  return { ...next, plan };
}

function writeLocalUpdaterSources(asarRoot, sources) {
  const write = (relative, text) => {
    const file = path.join(asarRoot, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write("package.json", sources.packageSource);
  for (const [relative, source] of Object.entries(sources.files)) write(relative, source);
}

function snapshotLocalUpdaterTargets(asarRoot, relativePaths) {
  return new Map(
    relativePaths.map((relative) => [
      relative,
      fs.readFileSync(path.join(asarRoot, ...relative.split("/")), "utf8"),
    ]),
  );
}

{
  const bootstrap = makeBootstrapPrefix();

  assert.ok(bootstrap.includes("let {app,autoUpdater,dialog,ipcMain,BrowserWindow}=electron;"));
  assert.ok(bootstrap.includes("let legacyExeName=`Codex.exe`;"));
  assert.ok(bootstrap.includes("currentManifests.some(currentManifest=>name.toLowerCase()===currentManifest.toLowerCase())"));
  assert.ok(bootstrap.includes("[`--removeShortcut`,legacyExeName]"));
  assert.ok(bootstrap.includes("[`--createShortcut`,exeName]"));
  assert.ok(bootstrap.includes("if(exeName.toLowerCase()!==legacyExeName.toLowerCase())"));
  assert.ok(bootstrap.includes("await runShortcutCommand([`--removeShortcut`,legacyExeName])"));
  assert.ok(bootstrap.includes("await runShortcutCommand([`--createShortcut`,exeName])"));
  assert.ok(bootstrap.includes(".catch(e=>{try{console.warn('[CodexRebuildUpdater] shortcut lifecycle failed'"));
  assert.ok(bootstrap.includes(".finally(()=>app.quit())"));
  assert.ok(bootstrap.includes("Shortcut command timed out"));
  assert.ok(bootstrap.includes("child.kill()"));
  assert.ok(!bootstrap.includes("detached:!0"));
  assert.ok(!bootstrap.includes(".unref()"));
  assert.ok(!bootstrap.includes("setTimeout(()=>app.quit(),1000)"));
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
      "globalThis.__CodexRebuildUpdaterCommand={check:()=>checkOnly(!0),download:startDownload,retry:options=>",
    ),
  );
  assert.ok(!bootstrap.includes("if(command==='preview')"));
  assert.ok(bootstrap.includes("if(command==='clear')return clearStatus();"));
  assert.ok(bootstrap.includes("Range:'bytes='+offset+'-'"));
  assert.ok(bootstrap.includes("package size or SHA1 mismatch"));
  assert.ok(bootstrap.includes("bytes retained for resume"));
  assert.ok(bootstrap.includes("CODEX_REBUILD_UPDATE_PROXY_PREFIXES"));
  assert.ok(!bootstrap.includes("99.999.999999"));
}

{
  const preload = makePreloadPatch();

  assert.ok(preload.includes("const invoke=(command,options={})=>"));
  assert.ok(preload.includes("{command,...options}"));
  assert.ok(preload.includes("downloadUpdate:options=>invoke('download',options)"));
  assert.ok(preload.includes("retryUpdate:options=>invoke('retry',options)"));
  assert.ok(preload.includes("clearUpdateState:()=>invoke('clear')"));
  assert.ok(preload.includes("e.contextBridge.exposeInMainWorld('codexRebuildUpdater',updaterApi)"));
  assert.ok(!preload.includes("document.createElement('div')"));
  assert.ok(!preload.includes("codex-rebuild-updater"));
  assert.ok(!preload.includes("position:fixed"));
  assert.ok(!preload.includes("z-index:2147483647"));
  assert.ok(!preload.includes("attachShadow"));
}

test("builds direct and configurable proxy package URLs deterministically", () => {
  assert.deepEqual(normalizeUpdateProxyPrefixes(" https://a/ ;https://b/\nhttps://a/ "), [
    "https://a/",
    "https://b/",
  ]);
  const urls = buildPackageDownloadUrls(
    "https://github.com/org/repo/releases/download/feed",
    "Codex-2.0.0-full.nupkg",
    ["https://ghfast.top/", "https://mirror.invalid/?target={url}"],
  );
  assert.equal(
    urls[0],
    "https://github.com/org/repo/releases/download/feed/Codex-2.0.0-full.nupkg",
  );
  assert.equal(urls[1], `https://ghfast.top/${urls[0]}`);
  assert.equal(urls[2], `https://mirror.invalid/?target=${urls[0]}`);
  assert.deepEqual(
    buildPackageDownloadUrls(
      "https://github.com/org/repo/releases/download/feed",
      "Codex-2.0.0-full.nupkg",
      ["https://custom.invalid/"],
      true,
    ),
    ["https://custom.invalid/" + urls[0], urls[0]],
  );
  assert.deepEqual(
    validateUpdateProxyPrefixes("https://one.invalid/; http://two.invalid/"),
    ["https://one.invalid/", "http://two.invalid/"],
  );
  assert.throws(
    () => validateUpdateProxyPrefixes("file:///tmp/releases/"),
    /invalid update proxy prefix/i,
  );
  assert.ok(DEFAULT_WINDOWS_UPDATE_PROXY_PREFIXES.length >= 2);
});

test("preload forwards popup download options to updater IPC", async () => {
  const requests = [];
  const context = {
    e: {
      contextBridge: {
        exposeInMainWorld(name, value) {
          context[name] = value;
        },
      },
      ipcRenderer: {
        invoke(_channel, request) {
          requests.push(request);
          return Promise.resolve(request);
        },
        on() {},
      },
    },
  };
  vm.runInNewContext(makePreloadPatch("e"), context);
  await context.codexRebuildUpdater.downloadUpdate({
    proxyPrefix: "https://custom.invalid/",
  });
  await context.codexRebuildUpdater.retryUpdate({
    proxyPrefixes: ["https://one.invalid/", "https://two.invalid/"],
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(requests)),
    [
      { command: "download", proxyPrefix: "https://custom.invalid/" },
      {
        command: "retry",
        proxyPrefixes: ["https://one.invalid/", "https://two.invalid/"],
      },
    ],
  );
});

test("retains RELEASES SHA1 and size for package verification", () => {
  const sha1 = "a".repeat(40);
  assert.deepEqual(
    parseReleaseManifestEntries(`${sha1} Codex-2.0.0-full.nupkg 629145600`),
    [{ sha1, fileName: "Codex-2.0.0-full.nupkg", size: 629145600 }],
  );
  assert.deepEqual(parseReleaseManifestEntries("not-a-sha package.nupkg 12"), []);
});

test("runtime downloader resumes a partial package with Range and verifies SHA1", async (t) => {
  const body = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
  const sha1 = crypto.createHash("sha1").update(body).digest("hex");
  const fileName = "Codex-2.0.0-full.nupkg";
  const ranges = [];
  const packageRequests = [];
  const server = http.createServer((request, response) => {
    if (request.url.startsWith("/RELEASES")) {
      response.end(`${sha1} ${fileName} ${body.length}\n`);
      return;
    }
    if (request.url.startsWith("/proxy/http://")) {
      packageRequests.push(request.url);
      response.writeHead(503);
      response.end("proxy unavailable");
      return;
    }
    if (request.url === `/${fileName}`) {
      packageRequests.push(request.url);
      const range = request.headers.range;
      ranges.push(range ?? null);
      if (range) {
        const offset = Number(range.match(/^bytes=(\d+)-$/)?.[1]);
        response.writeHead(206, {
          "Content-Range": `bytes ${offset}-${body.length - 1}/${body.length}`,
          "Content-Length": body.length - offset,
        });
        response.end(body.subarray(offset));
      } else {
        response.writeHead(200, { "Content-Length": body.length });
        response.end(body);
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const updateUrl = `http://127.0.0.1:${server.address().port}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "updater-resume-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDir = path.join(root, "app-1.0.0");
  const packagesDir = path.join(root, "packages");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(packagesDir, { recursive: true });
  fs.writeFileSync(path.join(root, "Update.exe"), "fixture");
  fs.writeFileSync(path.join(packagesDir, `${fileName}.partial`), body.subarray(0, 9));

  const autoUpdater = new EventEmitter();
  let updaterChecks = 0;
  autoUpdater.setFeedURL = () => {};
  autoUpdater.checkForUpdates = () => { updaterChecks += 1; };
  autoUpdater.quitAndInstall = () => {};
  const context = {
    Buffer,
    URL,
    clearInterval,
    clearTimeout,
    console,
    globalThis: null,
    process: {
      platform: "win32",
      arch: "x64",
      argv: ["Codex.exe"],
      execPath: path.join(appDir, "Codex.exe"),
      env: {
        CODEX_REBUILD_UPDATE_URL: updateUrl,
        CODEX_REBUILD_UPDATE_PROXY_PREFIXES: "",
      },
    },
    require(id) {
      if (id === "electron") {
        return {
          app: {
            isPackaged: true,
            getVersion: () => "1.0.0",
            whenReady: () => Promise.resolve(),
          },
          autoUpdater,
          dialog: {},
          ipcMain: { handle() {} },
          BrowserWindow: { getAllWindows: () => [] },
        };
      }
      if (id === "../../package.json") return { codexRebuildWindowsUpdateUrl: updateUrl };
      return require(id);
    },
    setInterval,
    setTimeout,
  };
  context.globalThis = context;
  vm.runInNewContext(`${makeBootstrapPrefix()}void 0;\n}\n`, context);
  await new Promise((resolve) => setImmediate(resolve));
  await context.__CodexRebuildUpdaterCommand.check();
  await context.__CodexRebuildUpdaterCommand.download({
    proxyPrefix: "file:///not-allowed/",
  });
  assert.match(context.__CodexRebuildUpdaterLastState.error, /invalid update proxy prefix/i);
  assert.deepEqual(packageRequests, []);
  await context.__CodexRebuildUpdaterCommand.retry({
    proxyPrefix: updateUrl + "/proxy/",
  });

  assert.deepEqual(ranges, ["bytes=9-"]);
  assert.equal(packageRequests.length, 2);
  assert.match(packageRequests[0], /^\/proxy\/http:\/\//);
  assert.equal(packageRequests[1], `/${fileName}`);
  assert.deepEqual(fs.readFileSync(path.join(packagesDir, fileName)), body);
  assert.equal(fs.existsSync(path.join(packagesDir, `${fileName}.partial`)), false);
  assert.equal(updaterChecks, 1);
  assert.equal(context.__CodexRebuildUpdaterLastState.status, "preparing");
  assert.equal(context.__CodexRebuildUpdaterLastState.resumedBytes, 9);
});

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
  const patched = patchWebviewMenuBarCode(
    withRealQuotedKeys(`${source}(0,Zr.jsx)(Yr,{});`),
  );

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
  assert.ok(patched.includes("codexRebuildUpdateProxyPrefix"));
  assert.ok(patched.includes("加速地址前缀（可选）"));
  assert.ok(patched.includes("proxyPrefix:p()"));
  assert.ok(patched.includes("cru-proxy-input"));
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

  const patched = patchWebviewMenuBarCode(
    withRealQuotedKeys(`${source}(0,Di.jsx)(Ti,{});`),
  );

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

test("rejects a marker-complete but inert backend shell", () => {
  const patched = applyLocalUpdaterPlan(makeCleanLocalUpdaterSources());
  patched.files[".vite/build/bootstrap-BXjiq4qE.js"] = [
    "/* CodexRebuildLocalUpdater:start */",
    "const channel=`codex_rebuild:update-command`;",
    "/* CodexRebuildLocalUpdater:end */",
    "if(!CodexRebuildWindowsBootstrap()){require(`./src-BZqs_tzA.js`)}",
    "/* CodexRebuildLocalUpdater:file-end */",
  ].join("\n");

  assert.throws(
    () => planLocalUpdaterSources(patched),
    /backend|bootstrap|canonical|postcondition/i,
  );
});

test("rejects a marker-complete main-menu block that is not attached to the live template", () => {
  const patched = applyLocalUpdaterPlan(makeCleanLocalUpdaterSources());
  patched.files[".vite/build/main-CZpDUN17.js"] =
    `${LATEST_LOCAL_MAIN_SOURCE};const detachedUpdater=${makeMainMenuPatch("c")};`;

  assert.throws(
    () => planLocalUpdaterSources(patched),
    /main menu|canonical|attached|postcondition/i,
  );
});

test("rejects empty and unrendered titlebar helper and descriptor shells", () => {
  const patched = applyLocalUpdaterPlan(makeCleanLocalUpdaterSources());
  patched.files["webview/assets/app-shell-CVVppk_a.js"] =
    `${LATEST_LOCAL_WEBVIEW_SOURCE};function codexRebuildUpdaterEnsureTitlebarStyle(){}` +
    ";const detached=[{id:'codex-rebuild-updater-top',message:{}}];";

  assert.throws(
    () => planLocalUpdaterSources(patched),
    /titlebar|webview|canonical|rendered|postcondition/i,
  );
});

test("rejects a canonical titlebar rendered only inside a dead function", () => {
  const patched = applyLocalUpdaterPlan(makeCleanLocalUpdaterSources());
  const file = "webview/assets/app-shell-CVVppk_a.js";
  patched.files[file] = patched.files[file].replace(
    "(0,Di.jsx)(Ti,{});",
    "function deadRender(){(0,Di.jsx)(Ti,{})}",
  );

  assert.throws(
    () => planLocalUpdaterSources(patched),
    /titlebar|rendered JSX attachment|Program|postcondition/i,
  );
});

test("accepts a canonical titlebar through a live Program component chain", () => {
  const patched = applyLocalUpdaterPlan(makeCleanLocalUpdaterSources());
  const file = "webview/assets/app-shell-CVVppk_a.js";
  patched.files[file] = patched.files[file].replace(
    "(0,Di.jsx)(Ti,{});",
    "function LiveTitlebar(){return (0,Di.jsx)(Ti,{})};(0,Di.jsx)(LiveTitlebar,{});",
  );

  const plan = planLocalUpdaterSources(patched);
  assert.equal(plan.status, "already");
  assert.equal(plan.changes.length, 0);
});

test("rejects stale or mismatched canonical updater block versions", () => {
  const patched = applyLocalUpdaterPlan(makeCleanLocalUpdaterSources());
  patched.files[".vite/build/bootstrap-BXjiq4qE.js"] +=
    "\n/* CodexRebuildLocalUpdater:v0:start */\n";

  assert.throws(
    () => planLocalUpdaterSources(patched),
    /backend|bootstrap|canonical|version|postcondition/i,
  );
});

test("migrates the exact v1 updater backend to the current shortcut lifecycle", () => {
  const original = "require(`./src-BZqs_tzA.js`);";
  const legacy = `${makeBootstrapPrefix(1, { legacyLifecycle: true })}${original}\n}\n/* CodexRebuildLocalUpdater:file-end */\n`;
  assert.ok(legacy.includes("for(let name of fs.readdirSync(appFolder))"));
  assert.ok(!legacy.includes("legacyExeName"));

  const migrated = patchBootstrapCode(legacy);
  assert.equal(migrated.status, "patched");
  assert.ok(migrated.code.includes("let legacyExeName=`Codex.exe`;"));
  assert.ok(migrated.code.includes(original));
  assert.equal(patchBootstrapCode(migrated.code).status, "already");
});

test("migrates the detached ChatGPT shortcut v1 backend to the serial lifecycle", () => {
  const original = "require(`./src-BZqs_tzA.js`);";
  const detached = `${makeBootstrapPrefix(1, { detachedLifecycle: true })}${original}\n}\n/* CodexRebuildLocalUpdater:file-end */\n`;
  assert.ok(detached.includes("detached:!0"));
  assert.ok(detached.includes("[`--removeShortcut`,legacyExeName]"));

  const migrated = patchBootstrapCode(detached);
  assert.equal(migrated.status, "patched");
  assert.ok(!migrated.code.includes("detached:!0"));
  assert.ok(migrated.code.includes("await runShortcutCommand"));
  assert.equal(patchBootstrapCode(migrated.code).status, "already");
});

test("migrates the unbounded serial v1 backend to the bounded lifecycle", () => {
  const original = "require(`./src-BZqs_tzA.js`);";
  const unbounded = `${makeBootstrapPrefix(1, { unboundedLifecycle: true })}${original}\n}\n/* CodexRebuildLocalUpdater:file-end */\n`;
  assert.ok(unbounded.includes("await runShortcutCommand"));
  assert.ok(!unbounded.includes("Shortcut command timed out"));

  const migrated = patchBootstrapCode(unbounded);
  assert.equal(migrated.status, "patched");
  assert.ok(migrated.code.includes("Shortcut command timed out"));
});

test("migrates historical v0 and versionless backends with their detached lifecycle", () => {
  const original = "require(`./src-BZqs_tzA.js`);";
  for (const version of [0, null]) {
    const legacy = `${makeBootstrapPrefix(version, { legacyLifecycle: true })}${original}\n}\n/* CodexRebuildLocalUpdater:file-end */\n`;
    assert.ok(legacy.includes("detached:!0"));
    const migrated = patchBootstrapCode(legacy);
    assert.equal(migrated.status, "patched");
    assert.ok(migrated.code.includes("await runShortcutCommand"));
  }
});

test("runs Squirrel shortcut migration sequentially before quitting", async () => {
  const children = [];
  const calls = [];
  let quitCount = 0;
  const app = {
    quit() { quitCount += 1; },
    whenReady() { throw new Error("Squirrel lifecycle must return before app readiness"); },
  };
  const childProcess = {
    spawn(_file, args, options) {
      calls.push({ args, options });
      const child = new EventEmitter();
      children.push(child);
      return child;
    },
  };
  const electron = { app, autoUpdater: {}, dialog: {}, ipcMain: {}, BrowserWindow: {} };
  const source = `${makeBootstrapPrefix()}void 0;\n}\n`;
  vm.runInNewContext(source, {
    clearTimeout,
    console,
    process: {
      platform: "win32",
      argv: ["ChatGPT.exe", "--squirrel-updated"],
      execPath: "C:\\Codex\\app-26.707.31428\\ChatGPT.exe",
    },
    require(id) {
      if (id === "electron") return electron;
      if (id === "node:path") return path.win32;
      if (id === "node:child_process") return childProcess;
      if (id === "node:fs") {
        return {
          readdirSync() { return []; },
          rmSync() {},
          copyFileSync() {},
        };
      }
      throw new Error(`Unexpected require: ${id}`);
    },
    setTimeout,
  });

  assert.deepEqual(calls.map((call) => call.args), [["--removeShortcut", "Codex.exe"]]);
  assert.equal(calls[0].options.detached, undefined);
  assert.equal(quitCount, 0);

  children[0].emit("exit", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((call) => call.args), [
    ["--removeShortcut", "Codex.exe"],
    ["--createShortcut", "ChatGPT.exe"],
  ]);
  assert.equal(quitCount, 0);

  children[1].emit("exit", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quitCount, 1);
});

test("bounds a stuck Squirrel shortcut command and still quits", async () => {
  let timeoutCallback;
  let killed = 0;
  let quitCount = 0;
  const warnings = [];
  const child = new EventEmitter();
  child.kill = () => { killed += 1; };
  const source = `${makeBootstrapPrefix()}void 0;\n}\n`;
  vm.runInNewContext(source, {
    clearTimeout() {},
    console: { warn(...args) { warnings.push(args.join(" ")); } },
    process: {
      platform: "win32",
      argv: ["ChatGPT.exe", "--squirrel-updated"],
      execPath: "C:\\Codex\\app-26.707.31428\\ChatGPT.exe",
    },
    require(id) {
      if (id === "electron") {
        return {
          app: {
            quit() { quitCount += 1; },
            whenReady() { throw new Error("unexpected readiness"); },
          },
          autoUpdater: {},
          dialog: {},
          ipcMain: {},
          BrowserWindow: {},
        };
      }
      if (id === "node:path") return path.win32;
      if (id === "node:child_process") return { spawn() { return child; } };
      if (id === "node:fs") {
        return { readdirSync() { return []; }, rmSync() {}, copyFileSync() {} };
      }
      throw new Error(`Unexpected require: ${id}`);
    },
    setTimeout(callback) {
      timeoutCallback = callback;
      return 1;
    },
  });

  assert.equal(typeof timeoutCallback, "function");
  assert.equal(quitCount, 0);
  timeoutCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(killed, 1);
  assert.equal(quitCount, 1);
  assert.ok(warnings.some((warning) => warning.includes("Shortcut command timed out")));
});

test("rejects a preload bridge detached from executable Program-scope exposure", () => {
  const patched = applyLocalUpdaterPlan(makeCleanLocalUpdaterSources());
  const canonical = makePreloadPatch("q").split("\n");
  patched.files[".vite/build/preload.js"] = [
    "let q=require(`electron`);",
    canonical[0],
    "function hidden(){q.contextBridge.exposeInMainWorld('codexRebuildUpdater',{})}",
    canonical.at(-1),
    "//# sourceMappingURL=preload.js.map",
  ].join("\n");

  assert.throws(
    () => planLocalUpdaterSources(patched),
    /preload|canonical|Program|exposure|postcondition/i,
  );
});

test("resolves only the live top-level early-bootstrap target", () => {
  const packageSource = JSON.stringify({ main: ".vite/build/early-bootstrap.js" });
  const files = {
    ".vite/build/early-bootstrap.js": [
      "// require(`./bootstrap-COMMENT.js`)",
      "const text='require(`./bootstrap-STRING.js`)'",
      "function dead(){require(`./bootstrap-DEAD.js`)}",
      "Promise.resolve().then(()=>require(`./bootstrap-LIVE.js`));",
    ].join("\n"),
    ".vite/build/bootstrap-LIVE.js": "require(`./src.js`);",
  };

  assert.deepEqual(
    resolveRuntimeBootstrap(packageSource, (file) => files[file]),
    {
      entryPath: ".vite/build/early-bootstrap.js",
      runtimePath: ".vite/build/bootstrap-LIVE.js",
      viaEarlyBootstrap: true,
    },
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
  const renderedWebviewSource = `${webviewSource}(0,Di.jsx)(Ti,{});`;
  write("package.json", packageSource);
  write(".vite/build/early-bootstrap.js", earlySource);
  write(".vite/build/bootstrap-BXjiq4qE.js", bootstrapSource);
  write(".vite/build/preload.js", preloadSource);
  write(".vite/build/main-CZpDUN17.js", mainSource);
  fs.mkdirSync(path.join(asarRoot, "webview", "assets"), { recursive: true });

  let planningFailureWrites = 0;
  assert.throws(
    () =>
      executeLocalUpdater({
        asarRoot,
        writeFileSync() {
          planningFailureWrites += 1;
        },
      }),
    /webview.*expected exactly 1.*found 0/i,
  );
  assert.equal(planningFailureWrites, 0, "planning failure must attempt zero writes");
  assert.equal(fs.readFileSync(path.join(asarRoot, "package.json"), "utf8"), packageSource);
  assert.equal(
    fs.readFileSync(path.join(asarRoot, ".vite", "build", "preload.js"), "utf8"),
    preloadSource,
  );

  write("webview/assets/app-shell-CVVppk_a.js", renderedWebviewSource);
  write("webview/assets/app-shell-ref-BQ-lb9Hp.js", "export const appShellRef={current:null};");
  write("webview/assets/app-shell-state-16Itmyrv.js", "export const state={ready:true};");
  write("webview/assets/app-shell-tab-controller-DuSW58a4.js", "export function tabs(){return []}");
  const beforeCheck = fs.readFileSync(path.join(asarRoot, "package.json"), "utf8");
  let checkWrites = 0;
  const check = executeLocalUpdater({
    asarRoot,
    check: true,
    writeFileSync() {
      checkWrites += 1;
    },
  });
  assert.equal(check.status, "patched");
  assert.equal(check.changes.length, 5);
  assert.equal(checkWrites, 0, "--check must invoke no writer");
  assert.deepEqual(
    check.changes.map((change) => change.path),
    [
      "package.json",
      ".vite/build/bootstrap-BXjiq4qE.js",
      ".vite/build/preload.js",
      ".vite/build/main-CZpDUN17.js",
      "webview/assets/app-shell-CVVppk_a.js",
    ],
  );
  assert.deepEqual(
    [
      check.layers.metadata.path,
      check.layers.backend.path,
      check.layers.preload.path,
      check.layers.mainMenu.path,
      check.layers.webview.path,
    ],
    check.changes.map((change) => change.path),
    "the five planned layers must map to exactly the five write targets",
  );
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
  const targetPaths = first.changes.map((change) => change.path);
  const beforeSecond = snapshotLocalUpdaterTargets(asarRoot, targetPaths);
  let secondWrites = 0;
  const second = executeLocalUpdater({
    asarRoot,
    writeFileSync() {
      secondWrites += 1;
    },
  });
  assert.equal(second.status, "already");
  assert.equal(second.changes.length, 0);
  assert.equal(secondWrites, 0, "normal second pass must invoke no writer");
  assert.deepEqual(snapshotLocalUpdaterTargets(asarRoot, targetPaths), beforeSecond);
});

test("restores current and prior files for first, middle, and last write failures", async (t) => {
  for (const failAt of [1, 3, 5]) {
    await t.test(`write ${failAt}`, (t) => {
      const asarRoot = fs.mkdtempSync(path.join(os.tmpdir(), "patch-local-updater-write-"));
      t.after(() => fs.rmSync(asarRoot, { recursive: true, force: true }));
      writeLocalUpdaterSources(asarRoot, makeCleanLocalUpdaterSources());
      const plan = executeLocalUpdater({ asarRoot, check: true });
      const targets = plan.changes.map((change) => change.path);
      const before = snapshotLocalUpdaterTargets(asarRoot, targets);
      let forwardAttempts = 0;
      let failed = false;

      assert.throws(
        () =>
          executeLocalUpdater({
            asarRoot,
            writeFileSync(filePath, code, encoding) {
              if (!failed) {
                forwardAttempts += 1;
                fs.writeFileSync(filePath, code, encoding);
                if (forwardAttempts === failAt) {
                  failed = true;
                  throw new Error(`forward write ${failAt}`);
                }
                return;
              }
              fs.writeFileSync(filePath, code, encoding);
            },
          }),
        /write failed and was rolled back/i,
      );
      assert.equal(forwardAttempts, failAt);
      assert.deepEqual(snapshotLocalUpdaterTargets(asarRoot, targets), before);
    });
  }
});

test("surfaces every affected path when rollback is incomplete", (t) => {
  const asarRoot = fs.mkdtempSync(path.join(os.tmpdir(), "patch-local-updater-rollback-"));
  t.after(() => fs.rmSync(asarRoot, { recursive: true, force: true }));
  writeLocalUpdaterSources(asarRoot, makeCleanLocalUpdaterSources());
  let forwardAttempts = 0;
  let rollingBack = false;
  const rollbackFailures = new Set([
    "package.json",
    ".vite/build/preload.js",
  ]);

  assert.throws(
    () =>
      executeLocalUpdater({
        asarRoot,
        writeFileSync(filePath, code, encoding) {
          const relative = path.relative(asarRoot, filePath).split(path.sep).join("/");
          if (!rollingBack) {
            forwardAttempts += 1;
            fs.writeFileSync(filePath, code, encoding);
            if (forwardAttempts === 3) {
              rollingBack = true;
              throw new Error("forward write failed");
            }
            return;
          }
          if (rollbackFailures.has(relative)) throw new Error(`rollback blocked ${relative}`);
          fs.writeFileSync(filePath, code, encoding);
        },
      }),
    (error) => {
      assert.match(error.message, /rollback incomplete/i);
      assert.match(error.message, /package\.json/);
      assert.match(error.message, /\.vite[\\/]build[\\/]preload\.js/);
      return true;
    },
  );
});

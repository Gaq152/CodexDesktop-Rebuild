#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { verifyPatchedApp } = require("./verify-patched-app");
const {
  makeMainMenuPatch,
  makePreloadPatch,
  planLocalUpdaterSources,
} = require("./patch-local-updater");
const {
  patchPluginMainSource,
  patchPluginWebviewSource,
} = require("./patch-plugin-auth");
const {
  patchThreadActionsSource,
  patchSidebarSource,
} = require("./patch-sidebar-delete");

const EXPECTED_VERSION = "26.707.31428";
const UPDATER_BACKEND_FIXTURE = [
  "/* CodexRebuildLocalUpdater:start */",
  "const updateChannel=`codex_rebuild:update-command`;",
  "/* CodexRebuildLocalUpdater:end */",
  "if(!CodexRebuildWindowsBootstrap()){",
  "  const backend=true;",
  "}",
  "/* CodexRebuildLocalUpdater:file-end */",
].join("\n");
const CONTRACT_IDS = [
  "fast",
  "plugin",
  "archive-delete",
  "sidebar-delete",
  "updater",
];

const MARKERS = [
  {
    id: "fast-mode",
    contract: "fast",
    file: "webview/assets/use-service-tier-settings-fixture.js",
    text: "const selectedTier = `fast_mode`;",
  },
  {
    id: "fast-api-key-authorization",
    contract: "fast",
    file: "webview/assets/use-service-tier-settings-fixture.js",
    text: "const fastAllowed = authMethod === `chatgpt` || authMethod === `apikey`;",
  },
  {
    id: "fast-request-api-key-authorization",
    contract: "fast",
    file: "webview/assets/read-service-tier-for-request-fixture.js",
    text: "async function readFast(authMethod, requirements) { if(authMethod !== `chatgpt` && authMethod !== `apikey`/* CodexRebuildFastModeRequestAuth */) return !1; return requirements.featureRequirements.fast_mode !== !1; }",
  },
  {
    id: "browser-availability",
    contract: "plugin",
    file: ".vite/build/main-features.js",
    text: "const desktopFeatures = { inAppBrowserUse:!0 };",
  },
  {
    id: "computer-availability",
    contract: "plugin",
    file: ".vite/build/main-features.js",
    text: "const computerFeatures = { computerUse:!0 };",
  },
  {
    id: "plugin-availability",
    contract: "plugin",
    file: ".vite/build/main-features.js",
    text: [
      "function setupBundledPlugins(features) {",
      "  const selectBundledPlugins = current => bundledPlugins.filter(()=>!0);",
      "  const reconcile = () => {",
      "    const descriptors = selectBundledPlugins(features);",
      "    logger.info(`bundled_plugins_reconcile_started`);",
      "    return install({ marketplacePluginDescriptors:descriptors });",
      "  };",
      "  return reconcile;",
      "}",
    ].join("\n"),
  },
  {
    id: "plugin-webview-auth",
    contract: "plugin",
    file: "webview/assets/use-is-plugins-enabled-fixture.js",
    text: "function pluginAuth(auth){return auth.authMethod===`chatgpt`||auth.authMethod===`apikey`}",
  },
  {
    id: "plugin-webview-availability",
    contract: "plugin",
    file: "webview/assets/use-is-plugins-enabled-fixture.js",
    text: "function pluginAvailability(){const featureName=`browser_use_external`;return{allowed:!0,available:!0,isLoading:!1}}",
  },
  {
    id: "plugin-webview-statsig",
    contract: "plugin",
    file: "webview/assets/use-is-plugins-enabled-fixture.js",
    text: [
      "function computerGate(){const featureName=`computer_use`;return !0/* CodexRebuildPluginStatsig */}",
      "function externalBrowserGate(){const featureName=`browser_use_external`;return !0/* CodexRebuildPluginStatsig */}",
      "function browserGate(){const featureName=`browser_use`;return !0/* CodexRebuildPluginStatsig */}",
    ].join("\n"),
  },
  {
    id: "delete-route",
    contract: "archive-delete",
    file: "webview/assets/app-main-fixture.js",
    text: withLiveArchiveRouter(
      '"delete-archived-conversation":q7((manager,{conversationId:id})=>manager.deleteArchivedConversation(id))',
    ),
  },
  {
    id: "active-delete-route",
    contract: "archive-delete",
    file: "webview/assets/app-main-fixture.js",
    text: '"delete-conversation":K7(async(manager,{conversationId:id})=>{await manager.sendRequest(`thread/delete`,{threadId:id})})',
  },
  {
    id: "delete-protocol",
    contract: "archive-delete",
    file: "webview/assets/data-controls-fixture.js",
    text: "const labels={delete:{id:`settings.dataControls.archivedChats.delete`}};function remove(send,conversationId){send(`delete-archived-conversation`,{conversationId});send(`delete-archived-conversation`,{conversationId});return classify(send,`thread/delete`)}export{remove as DataControlsSettings}",
  },
  {
    id: "sidebar-thread-actions",
    contract: "sidebar-delete",
    file: "webview/assets/thread-actions-fixture.js",
    text: "structural thread actions",
  },
  {
    id: "sidebar-delete",
    contract: "sidebar-delete",
    file: "webview/assets/sidebar-flat-sections-fixture.js",
    text: "const deleteItem = { id:`delete-thread` };",
  },
  {
    id: "sidebar-inline-confirmation",
    contract: "sidebar-delete",
    file: "webview/assets/sidebar-flat-sections-fixture.js",
    text: "const confirmItem = { id:`thread-delete-confirm-action` };",
  },
  {
    id: "updater-bootstrap",
    contract: "updater",
    file: ".vite/build/bootstrap-BXjiq4qE.js",
    text: UPDATER_BACKEND_FIXTURE,
  },
  {
    id: "updater-preload-bridge",
    contract: "updater",
    file: ".vite/build/preload.js",
    text: "/* CodexRebuildUpdaterPreload:start */ contextBridge.exposeInMainWorld(`codexRebuildUpdater`, updaterApi); /* CodexRebuildUpdaterPreload:end */",
  },
  {
    id: "updater-main-menu",
    contract: "updater",
    file: ".vite/build/main-CZpDUN17.js",
    text: "/* CodexRebuildUpdaterMainMenu:start */ const updaterMenu={id:`codex-rebuild-updater-top`}; /* CodexRebuildUpdaterMainMenu:end */",
  },
  {
    id: "updater-titlebar",
    contract: "updater",
    file: "webview/assets/app-shell-CVVppk_a.js",
    text: "function codexRebuildUpdaterEnsureTitlebarStyle(){};const updaterItems=[{id:'codex-rebuild-updater-top',message:{id:`windowsMenuBar.checkUpdates`}}];",
  },
];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function writeText(filePath, text, append = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (append) fs.appendFileSync(filePath, `\n${text}\n`);
  else fs.writeFileSync(filePath, `${text}\n`);
}

function writeExact(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function withLiveArchiveRouter(routeEntries) {
  return `let routes={${routeEntries}};bridge.setMessageHandler((key,payload)=>routes[key](manager,payload))`;
}

function withRealQuotedKeys(source) {
  return source
    .replaceAll("`aria-expanded`", "'aria-expanded'")
    .replaceAll("`aria-haspopup`", "'aria-haspopup'")
    .replaceAll("`aria-label`", "'aria-label'");
}

const LOCAL_UPDATER_MAIN_SOURCE =
  "let Rt=[],zt=[{label:`File`},{role:`help`,id:n.To.help,submenu:[ot,...Rt,...t?[]:[{type:`separator`},je]]}],Bt=c.Menu.buildFromTemplate(zt);";
const LOCAL_UPDATER_WEBVIEW_SOURCE = withRealQuotedKeys(
  "function Ti(){let e=S(),[t,n]=(0,Ei.useState)(null),r=(0,Ei.useRef)(0);if(!Ci())return null;let i=async(e,t)=>{let i=window.electronBridge?.showApplicationMenu;if(!i)return;let a=r.current+1;r.current=a,n(e);let o=t.currentTarget.getBoundingClientRect();try{await i(e,Math.round(o.left),Math.round(o.bottom))}finally{r.current===a&&n(null)}};return(0,Di.jsx)(`div`,{className:`flex items-center gap-0.5 pr-2 pl-1`,children:ki.map(({id:n,message:r})=>(0,Di.jsx)(`button`,{type:`button`,`aria-expanded`:t===n,`aria-haspopup`:`menu`,`aria-label`:e.formatMessage(r),className:M(`no-drag`,t===n?`selected`:`idle`),onClick:e=>{i(n,e)},children:(0,Di.jsx)(T,{...r})},n))})}var Ei,Di,Oi,ki,Ai=e((()=>{Ei=t(n(),1),Di=g(),Oi=C({file:{id:`windowsMenuBar.file`},edit:{id:`windowsMenuBar.edit`},view:{id:`windowsMenuBar.view`},help:{id:`windowsMenuBar.help`}}),ki=[{id:_.file,message:Oi.file},{id:_.edit,message:Oi.edit},{id:_.view,message:Oi.view},{id:_.help,message:Oi.help}]}));(0,Di.jsx)(Ti,{});",
);

function installCanonicalUpdater(fixture) {
  const sources = {
    packageSource: JSON.stringify({
      name: "openai-codex-electron",
      version: EXPECTED_VERSION,
      main: ".vite/build/early-bootstrap.js",
    }),
    files: {
      ".vite/build/early-bootstrap.js":
        "Promise.resolve().then(()=>require(`./bootstrap-BXjiq4qE.js`));",
      ".vite/build/bootstrap-BXjiq4qE.js": "require(`./src-BZqs_tzA.js`);",
      ".vite/build/preload.js":
        "let q=require(`electron`);\n//# sourceMappingURL=preload.js.map",
      ".vite/build/main-CZpDUN17.js": LOCAL_UPDATER_MAIN_SOURCE,
      "webview/assets/app-shell-CVVppk_a.js": LOCAL_UPDATER_WEBVIEW_SOURCE,
    },
  };
  const plan = planLocalUpdaterSources(sources);
  const installed = {
    packageSource: sources.packageSource,
    files: { ...sources.files },
  };
  for (const change of plan.changes) {
    if (change.path === "package.json") installed.packageSource = change.code;
    else installed.files[change.path] = change.code;
  }
  for (const stale of [
    ".vite/build/bootstrap.js",
    ".vite/build/main-updater.js",
    "webview/assets/app-shell-fixture.js",
  ]) {
    fs.rmSync(path.join(fixture.asarRoot, ...stale.split("/")), { force: true });
  }
  writeExact(path.join(fixture.asarRoot, "package.json"), installed.packageSource);
  for (const [relative, source] of Object.entries(installed.files)) {
    writeExact(path.join(fixture.asarRoot, ...relative.split("/")), source);
  }
  return installed;
}

function installCanonicalUpdaterWhenComplete(fixture) {
  const hasEveryLayer = MARKERS.filter(({ contract }) => contract === "updater")
    .every(({ id }) => fixture.includedMarkers.has(id));
  if (!hasEveryLayer) return;
  try {
    const metadata = JSON.parse(
      fs.readFileSync(path.join(fixture.asarRoot, "package.json"), "utf8"),
    );
    if (metadata.version !== EXPECTED_VERSION) return;
  } catch {
    return;
  }
  installCanonicalUpdater(fixture);
}

const STRUCTURAL_PLUGIN_MAIN = [
  "let He={browserPane:!1,inAppBrowserUse:!1,inAppBrowserUseAllowed:!1,externalBrowserUse:!1,externalBrowserUseAllowed:!1,computerUse:!1,computerUseNodeRepl:!1,control:!1,multiWindow:!1}",
  "let featureKeys=Object.keys(He)",
  "let fr={\"features.js_repl\":!1}",
  "let bs=[{isAvailable:({features:e})=>e.sites},{isAvailable:({features:e})=>e.inAppBrowserUseAllowed}],w=n=>bs.filter(r=>r.isAvailable({buildFlavor:i,features:n,platform:p}));function reconcile(n){let i=w(n);logger.info(`bundled_plugins_reconcile_started`);return install({marketplacePluginDescriptors:i})}",
  "function Ud(){let e=i.a.readFromPackageMetadata(),t=e!=null&&i.a.shouldIncludeBrowserUsePeerAuthorization(e,process.platform),n=!t&&Bd(process.env);if(!t&&!n)return()=>({authorized:!0})}",
].join(";");
const STRUCTURAL_PLUGIN_WEBVIEW = [
  "function F(e){let{enabled:n,hostId:r}=e,s=v(`1506311413`),c={featureName:`computer_use`,hostId:r},l=j(c),p=I({enabled:n}),y=l.enabled&&p.enabled&&s,b=l.isFetching,x=l.isLoading,_=y?l.reason:`statsig-disabled`;return{available:y,isFetching:b,isLoading:x,reason:_}}",
  "function I(e){let t=(0,z.c)(21),{enabled:n}=e,r=(0,B.useContext)(x)?.authMethod===`chatgpt`;return{enabled:n&&r}}",
  "function H(e){let{hostId:n}=e,a=v(`410065390`),o={featureName:`browser_use_external`,hostId:n},s=j(o),l=a?s.enabled:`statsig-disabled`,u=l===`available`,d=l===`available`,f=l===`loading`;return{allowed:u,available:d,isLoading:f,reason:l}}",
  "function K(e){let{hostId:n}=e,a=v(`410262010`),o={featureName:`browser_use`,hostId:n},s=j(o),l=a?s.enabled:`statsig-disabled`,h=l===`available`,_=l===`available`,y=l===`loading`;return{allowed:h,available:_,isLoading:y,reason:l}}",
  "export{F as c,K as i,H as o}",
].join(";");
const STRUCTURAL_THREAD_ACTIONS = [
  "let $=g({archiveThread:{id:`sidebarElectron.archiveThread`,defaultMessage:`Archive task`,description:`Menu item to archive a local task`}})",
  "function ne(){let e=(0,Q.c)(17),t=n(o),r=h(),i;i=e=>{let{conversationId:n,hostId:a,source:o,onArchiveStart:s,onArchiveSuccess:c,onArchiveError:l}=e;s?.(),v(`archive-conversation`,{conversationId:n,hostId:a,source:o}).then(()=>c?.()).catch(()=>{l?.(),t.get(y).danger(r.formatMessage($.archiveThreadError))})};let a=e=>{};let s=e=>{},c=e=>{},l=e=>{};let u;return u={archiveThread:i,interruptThread:a,renameThread:s,copyWorkingDirectory:c,copyConversationMarkdown:l},u}",
].join(";");
const STRUCTURAL_SIDEBAR = [
  "function Ac(e){let t=(0,Nc.c)(8),{archive:n,pinAction:r}=e,i=L();if(n==null&&r==null)return null;let a;t[0]===r?a=t[1]:(a=r==null?[]:[{id:`thread-pin-action`,ariaLabel:r.ariaLabel,onClick:r.onClick}],t[0]=r,t[1]=a);let o;t[2]!==n||t[3]!==i?(o=n==null?[]:[{id:`thread-primary-action`,ariaLabel:i.formatMessage(Sr.archiveThread),icon:(0,Fc.jsx)(Aa,{}),onClick:n}],t[2]=n,t[3]=i,t[4]=o):o=t[4];let s;return t[5]!==a||t[6]!==o?(s=(0,Fc.jsx)(oc,{actions:[...a,...o],className:Pa}),t[5]=a,t[6]=o,t[7]=s):s=t[7],s}",
  "function jc({conversationId:e,showPinActionOnHover:a=!1,canPin:i=!0,threadSummary:_=null}){let b=o(m),[S,C]=(0,Pc.useState)(!1),w=L(),{archiveThread:F,markThreadAsRead:R}=wr(),{beginArchive:ne,handleArchiveSuccess:re,handleArchiveError:ie}=Na({}),we=()=>{ne(),F({conversationId:e,hostId:_?.hostId,source:`sidebar_context_menu`,onArchiveSuccess:re,onArchiveError:ie})},Te=le(()=>{we()}),je=le(()=>[{id:`archive-thread`,message:Sr.archiveThread,onSelect:Te}]),Me=a&&i,Ne=(0,Pc.useCallback)(({archive:t})=>(0,Fc.jsx)(Ac,{archive:t,pinAction:Me?{ariaLabel:w.formatMessage(Eo),isPinned:!1,onClick:()=>{}}:void 0}),[Te,w,e,b,Me]);let Pe=(0,Fc.jsx)(Ma,{additionalHoverActionCount:Me?1:0,renderActions:Ne});return(0,Fc.jsx)(me,{getItems:je,children:Pe})}",
].join(";");

function installStructuralFeatureFixtures(fixture) {
  let pluginMain = patchPluginMainSource(STRUCTURAL_PLUGIN_MAIN).code;
  if (!fixture.includedMarkers.has("browser-availability")) {
    for (const key of [
      "browserPane",
      "inAppBrowserUse",
      "inAppBrowserUseAllowed",
      "externalBrowserUse",
      "externalBrowserUseAllowed",
    ]) pluginMain = pluginMain.replace(`${key}:!0`, `${key}:!1`);
  }
  if (!fixture.includedMarkers.has("computer-availability")) {
    for (const key of ["computerUse", "computerUseNodeRepl"]) {
      pluginMain = pluginMain.replace(`${key}:!0`, `${key}:!1`);
    }
  }
  if (!fixture.includedMarkers.has("plugin-availability")) {
    pluginMain = pluginMain.replace("/* CodexRebuildPluginFilter */", "");
  }
  writeText(path.join(fixture.asarRoot, ".vite", "build", "main-features.js"), pluginMain);

  let pluginWebview = patchPluginWebviewSource(STRUCTURAL_PLUGIN_WEBVIEW).code;
  if (!fixture.includedMarkers.has("plugin-webview-auth")) {
    pluginWebview = pluginWebview.replace(
      "||(0,B.useContext)(x)?.authMethod===`apikey`",
      "",
    );
  }
  if (!fixture.includedMarkers.has("plugin-webview-availability")) {
    pluginWebview = pluginWebview.replace(
      "return{available:!0,isFetching:b",
      "return{available:y,isFetching:b",
    );
  }
  if (!fixture.includedMarkers.has("plugin-webview-statsig")) {
    pluginWebview = pluginWebview.replaceAll("/* CodexRebuildPluginStatsig */", "");
  }
  writeText(
    path.join(
      fixture.asarRoot,
      "webview",
      "assets",
      "use-is-plugins-enabled-fixture.js",
    ),
    pluginWebview,
  );

  const archiveRoutes = [];
  if (fixture.includedMarkers.has("delete-route")) {
    archiveRoutes.push(
      '"delete-archived-conversation":q7((manager,{conversationId:id})=>manager.deleteArchivedConversation(id))',
    );
  }
  if (fixture.includedMarkers.has("active-delete-route")) {
    archiveRoutes.push(
      '"delete-conversation":K7(async(manager,{conversationId:id})=>{await manager.sendRequest(`thread/delete`,{threadId:id})})',
    );
  }
  const nativeAppMain = withLiveArchiveRouter(archiveRoutes.join(","));
  const nativeDataControls = fixture.includedMarkers.has("delete-protocol")
    ? "let messages={delete:{id:`settings.dataControls.archivedChats.delete`}};async function remove(send,id){send(`delete-archived-conversation`,{conversationId:id});send(`delete-archived-conversation`,{conversationId:id});return classify(send,`thread/delete`)}export{remove as DataControlsSettings}"
    : "let value=1;";
  writeText(
    path.join(fixture.asarRoot, "webview", "assets", "app-main-fixture.js"),
    nativeAppMain,
  );
  writeText(
    path.join(fixture.asarRoot, "webview", "assets", "data-controls-fixture.js"),
    nativeDataControls,
  );

  let threadActions = patchThreadActionsSource(STRUCTURAL_THREAD_ACTIONS).code;
  let sidebar = patchSidebarSource(STRUCTURAL_SIDEBAR).code;
  if (!fixture.includedMarkers.has("sidebar-thread-actions")) {
    threadActions = STRUCTURAL_THREAD_ACTIONS;
  }
  if (!fixture.includedMarkers.has("sidebar-delete")) {
    sidebar = sidebar.replace("id:`delete-thread`", "id:`missing-delete-thread`");
  }
  if (!fixture.includedMarkers.has("sidebar-inline-confirmation")) {
    sidebar = sidebar.replace(
      "id:`thread-delete-confirm-action`",
      "id:`missing-thread-delete-confirm-action`",
    );
  }
  writeText(
    path.join(fixture.asarRoot, "webview", "assets", "thread-actions-fixture.js"),
    threadActions,
  );
  writeText(
    path.join(
      fixture.asarRoot,
      "webview",
      "assets",
      "sidebar-flat-sections-fixture.js",
    ),
    sidebar,
  );
  installCanonicalUpdaterWhenComplete(fixture);
}

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-patched-app-"));
  const asarRoot = path.join(root, "src", "win", "_asar");
  fs.mkdirSync(asarRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  if (!options.omitPackage) {
    const packageJson = options.packageText ?? JSON.stringify({
      name: "openai-codex-electron",
      version: options.version ?? EXPECTED_VERSION,
      main: ".vite/build/bootstrap.js",
      codexRebuildWindowsUpdateUrl: "https://example.invalid/windows-update-feed",
    });
    writeText(path.join(asarRoot, "package.json"), packageJson);
  }

  const omitted = new Set(options.omitMarkers ?? []);
  const includedMarkers = new Set(
    MARKERS.filter((marker) => !omitted.has(marker.id)).map((marker) => marker.id),
  );
  const fixture = { root, asarRoot, includedMarkers };
  for (const file of new Set(MARKERS.map((marker) => marker.file))) {
    writeMarkerFile(fixture, file);
  }
  installStructuralFeatureFixtures(fixture);

  return fixture;
}

function addMarker(fixture, marker) {
  fixture.includedMarkers.add(marker.id);
  writeMarkerFile(fixture, marker.file);
  installStructuralFeatureFixtures(fixture);
}

function writeMarkerFile(fixture, relativeFile) {
  const markers = MARKERS.filter(
    (marker) =>
      marker.file === relativeFile && fixture.includedMarkers.has(marker.id),
  );
  if (markers.length === 0) return;

  let source = markers.map((marker) => marker.text).join("\n");
  if (relativeFile === "webview/assets/use-service-tier-settings-fixture.js") {
    source = `function fastSettings(authMethod, requirements) {\n${source}\n}`;
  } else if (relativeFile === ".vite/build/main-features.js") {
    const browserValue = fixture.includedMarkers.has("browser-availability")
      ? "!0"
      : "!1";
    const computerValue = fixture.includedMarkers.has("computer-availability")
      ? "!0"
      : "!1";
    const pluginMarker = MARKERS.find(
      (marker) => marker.id === "plugin-availability",
    );
    source = [
      `const desktopFeatures = { browserPane:${browserValue}, inAppBrowserUse:${browserValue}, inAppBrowserUseAllowed:${browserValue}, externalBrowserUse:${browserValue}, externalBrowserUseAllowed:${browserValue}, computerUse:${computerValue}, computerUseNodeRepl:${computerValue}, control:!0, multiWindow:!0 };`,
      "const desktopFeatureKeys = Object.keys(desktopFeatures);",
      fixture.includedMarkers.has(pluginMarker.id) ? pluginMarker.text : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  writeText(path.join(fixture.asarRoot, relativeFile), source);
}

for (const marker of MARKERS) {
  test(`${marker.contract} fails closed without ${marker.id}`, (t) => {
    const fixture = createFixture(t, { omitMarkers: [marker.id] });

    assert.throws(
      () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
      (error) => error.message.includes(marker.contract),
    );

    addMarker(fixture, marker);
    const result = verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION);
    const expectedFile = toPosix(path.join("src", "win", "_asar", marker.file));
    assert.ok(result.contracts[marker.contract].includes(expectedFile));
  });
}

for (const [contract, markerIds] of [
  ["fast", ["fast-mode", "fast-api-key-authorization"]],
  ["sidebar-delete", ["sidebar-delete", "sidebar-inline-confirmation"]],
]) {
  test(`${contract} requires its markers in the same bundle`, (t) => {
    const fixture = createFixture(t, { omitMarkers: markerIds });
    markerIds.forEach((markerId, index) => {
      const marker = MARKERS.find((candidate) => candidate.id === markerId);
      writeText(
        path.join(fixture.asarRoot, "split", `${contract}-${index}.js`),
        marker.text,
      );
    });

    assert.throws(
      () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
      (error) => error.message.includes(contract),
    );
  });
}

test("fast rejects unrelated same-bundle authorization evidence", (t) => {
  const fixture = createFixture(t, {
    omitMarkers: ["fast-mode", "fast-api-key-authorization"],
  });
  writeText(
    path.join(fixture.asarRoot, "webview", "assets", "fast-decoy.js"),
    [
      "function fastSettings(authMethod, requirements) {",
      "  const allowed = authMethod === `chatgpt`;",
      "  return requirements.fast_mode && allowed;",
      "}",
      "function unrelated(otherAuth) { return otherAuth === `apikey`; }",
    ].join("\n"),
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("fast"),
  );
});

test("fast rejects a detached request authorization marker", (t) => {
  const fixture = createFixture(t, {
    omitMarkers: ["fast-request-api-key-authorization"],
  });
  writeText(
    path.join(
      fixture.asarRoot,
      "webview",
      "assets",
      "read-service-tier-for-request-decoy.js",
    ),
    [
      "const marker = !1/* CodexRebuildFastModeRequestAuth */;",
      "function readFast(requirements) { return requirements.fast_mode; }",
    ].join("\n"),
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("fast"),
  );
});

test("fast rejects an always-false request authorization gate", (t) => {
  const fixture = createFixture(t, {
    omitMarkers: ["fast-request-api-key-authorization"],
  });
  writeText(
    path.join(
      fixture.asarRoot,
      "webview",
      "assets",
      "read-service-tier-for-request-decoy.js",
    ),
    "function readFast(requirements) { if(!1/* CodexRebuildFastModeRequestAuth */) return !1; return requirements.fast_mode; }",
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("fast"),
  );
});

test("fast settings evidence is pinned to use-service-tier-settings bundles", (t) => {
  const fixture = createFixture(t);
  const pinned = path.join(
    fixture.asarRoot,
    "webview",
    "assets",
    "use-service-tier-settings-fixture.js",
  );
  const decoy = path.join(fixture.asarRoot, "webview", "assets", "fast-settings-decoy.js");
  fs.renameSync(pinned, decoy);

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("fast"),
  );
});

test("fast rejects a non-exact request marker comment", (t) => {
  const fixture = createFixture(t);
  const requestPath = path.join(
    fixture.asarRoot,
    "webview",
    "assets",
    "read-service-tier-for-request-fixture.js",
  );
  const source = fs
    .readFileSync(requestPath, "utf8")
    .replace(
      "/* CodexRebuildFastModeRequestAuth */",
      "/* bogus CodexRebuildFastModeRequestAuth evidence */",
    );
  writeText(requestPath, source);

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("fast"),
  );
});

test("fast rejects duplicate pinned settings bundles", (t) => {
  const fixture = createFixture(t);
  const source = fs.readFileSync(
    path.join(
      fixture.asarRoot,
      "webview",
      "assets",
      "use-service-tier-settings-fixture.js",
    ),
    "utf8",
  );
  writeText(
    path.join(
      fixture.asarRoot,
      "webview",
      "assets",
      "use-service-tier-settings-duplicate.js",
    ),
    source,
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("fast"),
  );
});

test("plugin rejects unrelated availability decoys", (t) => {
  const fixture = createFixture(t, {
    omitMarkers: ["browser-availability", "computer-availability"],
  });
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "main-features.js"),
    [
      "const defaults = { browserPane:!1, inAppBrowserUse:!1, inAppBrowserUseAllowed:!1, externalBrowserUse:!1, externalBrowserUseAllowed:!1, computerUse:!1, computerUseNodeRepl:!1, control:!1, multiWindow:!1 };",
      "const windowsOverride = { ...defaults, inAppBrowserUse:!0, computerUse:!0, computerUseNodeRepl:!0 };",
      "const browser = { featureName:`browser_use`, available:!0, isLoading:!1 };",
      "const computer = { featureName:`computer_use`, available:!0, isLoading:!1 };",
    ].join("\n"),
    true,
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("plugin rejects a detached Statsig marker", (t) => {
  const fixture = createFixture(t, {
    omitMarkers: ["plugin-webview-statsig"],
  });
  writeText(
    path.join(
      fixture.asarRoot,
      "webview",
      "assets",
      "use-is-plugins-enabled-fixture.js",
    ),
    "const detached=!0/* CodexRebuildPluginStatsig */;",
    true,
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("plugin rejects a partial webview availability shell instead of aggregate evidence", (t) => {
  const fixture = createFixture(t);
  writeText(
    path.join(
      fixture.asarRoot,
      "webview",
      "assets",
      "use-is-plugins-enabled-fixture.js",
    ),
    [
      "function auth(value){return value.authMethod===`chatgpt`||value.authMethod===`apikey`}",
      "function external(){const featureName=`browser_use_external`;return{allowed:!0,available:!0,isLoading:!1}}",
      "function gates(){const featureName=`computer_use`;let a=!0/* CodexRebuildPluginStatsig */,b=!0/* CodexRebuildPluginStatsig */,c=!0/* CodexRebuildPluginStatsig */;return a&&b&&c}",
    ].join("\n"),
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("plugin rejects Statsig bypasses concentrated in one feature context", (t) => {
  const fixture = createFixture(t);
  writeText(
    path.join(
      fixture.asarRoot,
      "webview",
      "assets",
      "use-is-plugins-enabled-fixture.js",
    ),
    [
      "function auth(value){return value.authMethod===`chatgpt`||value.authMethod===`apikey`}",
      "function computer(){const featureName=`computer_use`;let a=!0/* CodexRebuildPluginStatsig */,b=!0/* CodexRebuildPluginStatsig */,c=!0/* CodexRebuildPluginStatsig */;return{available:!0,isFetching:!1,isLoading:!1,a,b,c}}",
      "function external(){const featureName=`browser_use_external`;return{allowed:!0,available:!0,isLoading:!1}}",
      "function browser(){const featureName=`browser_use`;return{allowed:!0,available:!0,isLoading:!1}}",
    ].join("\n"),
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("plugin rejects a third webview auth alternative", (t) => {
  const fixture = createFixture(t);
  const file = path.join(
    fixture.asarRoot,
    "webview",
    "assets",
    "use-is-plugins-enabled-fixture.js",
  );
  writeText(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace(
        "?.authMethod===`apikey`",
        "?.authMethod===`apikey`||(0,B.useContext)(x)?.authMethod===`amazonBedrock`",
      ),
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("plugin rejects a filter marker detached from the intended filter", (t) => {
  const fixture = createFixture(t);
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "main-features.js"),
    "const detached=!0/* CodexRebuildPluginFilter */;",
    true,
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("plugin requires browser and computer defaults in the same object", (t) => {
  const fixture = createFixture(t, {
    omitMarkers: ["browser-availability", "computer-availability"],
  });
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "main-features.js"),
    [
      "const browserOverride = { browserPane:!0, inAppBrowserUse:!0, inAppBrowserUseAllowed:!0, externalBrowserUse:!0, externalBrowserUseAllowed:!0, computerUse:!1, computerUseNodeRepl:!1, control:!0, multiWindow:!0 };",
      "const computerOverride = { browserPane:!1, inAppBrowserUse:!1, inAppBrowserUseAllowed:!1, externalBrowserUse:!1, externalBrowserUseAllowed:!1, computerUse:!0, computerUseNodeRepl:!0, control:!0, multiWindow:!0 };",
    ].join("\n"),
    true,
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("plugin rejects unrelated always-true filter decoys", (t) => {
  const fixture = createFixture(t, { omitMarkers: ["plugin-availability"] });
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "main-features.js"),
    [
      "const filterNote = `.filter(()=>!0)`;",
      "/* bundledPlugins.filter(()=>!0) */",
      "const unrelated = values.filter(()=>!0);",
    ].join("\n"),
    true,
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("plugin filter context does not cross a shadowed selector binding", (t) => {
  const fixture = createFixture(t, { omitMarkers: ["plugin-availability"] });
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "main-features.js"),
    [
      "function decoySetup(features) {",
      "  const selectBundledPlugins = current => bundledPlugins.filter(()=>!0);",
      "  function unrelated(selectBundledPlugins) {",
      "    const descriptors = selectBundledPlugins(features);",
      "    logger.info(`bundled_plugins_reconcile_started`);",
      "    return install({ marketplacePluginDescriptors:descriptors });",
      "  }",
      "  return unrelated;",
      "}",
    ].join("\n"),
    true,
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("plugin default Object.keys resolves the same block binding", (t) => {
  const fixture = createFixture(t);
  const pluginMarker = MARKERS.find(
    (marker) => marker.id === "plugin-availability",
  );
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "main-features.js"),
    [
      "const desktopFeatures = { browserPane:!0, inAppBrowserUse:!0, inAppBrowserUseAllowed:!0, externalBrowserUse:!0, externalBrowserUseAllowed:!0, computerUse:!0, computerUseNodeRepl:!0, control:!0, multiWindow:!0 };",
      "{",
      "  const desktopFeatures = { browserPane:!1, inAppBrowserUse:!1, inAppBrowserUseAllowed:!1, externalBrowserUse:!1, externalBrowserUseAllowed:!1, computerUse:!1, computerUseNodeRepl:!1, control:!1, multiWindow:!1 };",
      "  const desktopFeatureKeys = Object.keys(desktopFeatures);",
      "}",
      pluginMarker.text,
    ].join("\n"),
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("plugin filter checks every intermediate selector scope", (t) => {
  const fixture = createFixture(t, { omitMarkers: ["plugin-availability"] });
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "main-features.js"),
    [
      "function decoySetup(features) {",
      "  const selectBundledPlugins = current => bundledPlugins.filter(()=>!0);",
      "  function intermediate(selectBundledPlugins) {",
      "    return function grandchild() {",
      "      const descriptors = selectBundledPlugins(features);",
      "      logger.info(`bundled_plugins_reconcile_started`);",
      "      return install({ marketplacePluginDescriptors:descriptors });",
      "    };",
      "  }",
      "  return intermediate;",
      "}",
    ].join("\n"),
    true,
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("updater rejects a marker-complete but inert resolved backend shell", (t) => {
  const fixture = createFixture(t);
  installCanonicalUpdater(fixture);
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "bootstrap-BXjiq4qE.js"),
    [
      "/* CodexRebuildLocalUpdater:start */",
      "const channel=`codex_rebuild:update-command`;",
      "/* CodexRebuildLocalUpdater:end */",
      "if(!CodexRebuildWindowsBootstrap()){require(`./src-BZqs_tzA.js`)}",
      "/* CodexRebuildLocalUpdater:file-end */",
    ].join("\n"),
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("updater"),
  );
});

test("updater rejects a marker-complete main menu detached from the live template", (t) => {
  const fixture = createFixture(t);
  installCanonicalUpdater(fixture);
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "main-CZpDUN17.js"),
    `${LOCAL_UPDATER_MAIN_SOURCE};const detachedUpdater=${makeMainMenuPatch("c")};`,
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("updater"),
  );
});

test("updater rejects empty and unrendered titlebar shells", (t) => {
  const fixture = createFixture(t);
  installCanonicalUpdater(fixture);
  writeText(
    path.join(fixture.asarRoot, "webview", "assets", "app-shell-CVVppk_a.js"),
    `${LOCAL_UPDATER_WEBVIEW_SOURCE};function codexRebuildUpdaterEnsureTitlebarStyle(){}` +
      ";const detached=[{id:'codex-rebuild-updater-top',message:{}}];",
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("updater"),
  );
});

test("updater rejects a canonical titlebar rendered only by a dead function", (t) => {
  const fixture = createFixture(t);
  const installed = installCanonicalUpdater(fixture);
  const relative = "webview/assets/app-shell-CVVppk_a.js";
  const inert = installed.files[relative].replace(
    "(0,Di.jsx)(Ti,{});",
    "function deadRender(){(0,Di.jsx)(Ti,{})}",
  );
  writeExact(path.join(fixture.asarRoot, ...relative.split("/")), inert);

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("updater"),
  );
});

test("updater rejects stale or mismatched canonical block versions", (t) => {
  const fixture = createFixture(t);
  const installed = installCanonicalUpdater(fixture);
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "bootstrap-BXjiq4qE.js"),
    installed.files[".vite/build/bootstrap-BXjiq4qE.js"] +
      "\n/* CodexRebuildLocalUpdater:v0:start */",
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("updater"),
  );
});

test("updater rejects preload exposure detached from a live Program-scope bridge", (t) => {
  const fixture = createFixture(t);
  installCanonicalUpdater(fixture);
  const canonical = makePreloadPatch("q").split("\n");
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "preload.js"),
    [
      "let q=require(`electron`);",
      canonical[0],
      "function hidden(){q.contextBridge.exposeInMainWorld('codexRebuildUpdater',{})}",
      canonical.at(-1),
    ].join("\n"),
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("updater"),
  );
});

test("updater resolves only the live early-bootstrap target", (t) => {
  const fixture = createFixture(t);
  installCanonicalUpdater(fixture);
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "early-bootstrap.js"),
    [
      "// require(`./bootstrap-COMMENT.js`)",
      "const text='require(`./bootstrap-STRING.js`)'",
      "function dead(){require(`./bootstrap-DEAD.js`)}",
      "Promise.resolve().then(()=>require(`./bootstrap-BXjiq4qE.js`));",
    ].join("\n"),
  );

  const result = verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION);
  assert.ok(
    result.contracts.updater.includes(
      "src/win/_asar/.vite/build/bootstrap-BXjiq4qE.js",
    ),
  );
});

test("updater requires the titlebar marker in webview assets", (t) => {
  const fixture = createFixture(t, { omitMarkers: ["updater-titlebar"] });
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "main-updater.js"),
    "const updaterMenu = { id:`codex-rebuild-updater-top` };",
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("updater"),
  );
});

test("updater rejects a stale non-app-shell titlebar asset", (t) => {
  const fixture = createFixture(t, { omitMarkers: ["updater-titlebar"] });
  writeText(
    path.join(
      fixture.asarRoot,
      "webview",
      "assets",
      "windows-titlebar-stale.js",
    ),
    "function codexRebuildUpdaterEnsureTitlebarStyle(){};const updaterMenu={id:`codex-rebuild-updater-top`};",
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("updater"),
  );
});

test("updater rejects an inert resolved backend marker", (t) => {
  const fixture = createFixture(t, { omitMarkers: ["updater-bootstrap"] });
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "bootstrap.js"),
    "/* CodexRebuildLocalUpdater:start */",
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("updater"),
  );
});

test("plugin rejects main-only success without the latest webview postconditions", (t) => {
  const fixture = createFixture(t, {
    omitMarkers: [
      "plugin-webview-auth",
      "plugin-webview-availability",
      "plugin-webview-statsig",
    ],
  });
  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("plugin"),
  );
});

test("archive-delete accepts the unambiguous legacy custom route", (t) => {
  const fixture = createFixture(t, { omitMarkers: ["delete-route", "delete-protocol"] });
  writeText(
    path.join(fixture.asarRoot, "webview", "assets", "app-main-fixture.js"),
    withLiveArchiveRouter(
      '"delete-conversation":K7(async(manager,{conversationId:id})=>{await manager.sendRequest(`thread/delete`,{threadId:id})})',
    ),
  );
  writeText(
    path.join(fixture.asarRoot, "webview", "assets", "data-controls-fixture.js"),
    "function legacy(event,send,conversationId,hostId){if(event.currentTarget.dataset.codexConfirmDelete!==`true`)return;send(`delete-conversation`,{conversationId,hostId})}export{legacy as DataControlsSettings}",
  );
  const result = verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION);
  assert.deepEqual(result.contracts["archive-delete"], [
    "src/win/_asar/webview/assets/app-main-fixture.js",
    "src/win/_asar/webview/assets/data-controls-fixture.js",
  ]);
});

test("archive-delete rejects a data-controls-only route and error-code decoy", (t) => {
  const fixture = createFixture(t, {
    omitMarkers: ["delete-route", "delete-protocol"],
  });
  writeText(
    path.join(fixture.asarRoot, "webview", "assets", "data-controls-decoy.js"),
    [
      "send(`delete-archived-conversation`, { conversationId });",
      "const unsupported = error.code === `thread/delete`;",
    ].join("\n"),
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("archive-delete"),
  );
});

test("archive-delete requires coexisting native and active routes", (t) => {
  const fixture = createFixture(t);
  const nativeRoute =
    '"delete-archived-conversation":q7((manager,{conversationId:id})=>manager.deleteArchivedConversation(id))';
  const legacyRoute =
    '"delete-conversation":K7(async(manager,{conversationId:id})=>{await manager.sendRequest("thread/delete",{threadId:id})})';
  writeText(
    path.join(fixture.asarRoot, "webview", "assets", "app-main-fixture.js"),
    withLiveArchiveRouter(`${nativeRoute},${legacyRoute}`),
  );

  const result = verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION);
  assert.deepEqual(result.contracts["archive-delete"], [
    "src/win/_asar/webview/assets/app-main-fixture.js",
    "src/win/_asar/webview/assets/data-controls-fixture.js",
  ]);
});

test("archive-delete rejects mismatched legacy manager and thread bindings", (t) => {
  const fixture = createFixture(t, {
    omitMarkers: ["delete-route", "delete-protocol"],
  });
  writeText(
    path.join(fixture.asarRoot, "webview", "assets", "legacy-archive.js"),
    'let routes={"delete-conversation":K7(async(manager,{conversationId:id})=>{await other.sendRequest("thread/delete",{threadId:wrong})})};',
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("archive-delete"),
  );
});

test("sidebar-delete rejects inert IDs without structural thread action and row wiring", (t) => {
  const fixture = createFixture(t);
  writeText(
    path.join(
      fixture.asarRoot,
      "webview",
      "assets",
      "sidebar-flat-sections-fixture.js",
    ),
    "const deleteItem={id:`delete-thread`};const confirm={id:`thread-delete-confirm-action`};",
  );

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("sidebar-delete"),
  );
});

test("updater resolves the hashed runtime bootstrap and rejects early-bootstrap-only evidence", (t) => {
  const fixture = createFixture(t);
  const result = verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION);
  assert.ok(
    result.contracts.updater.includes(
      "src/win/_asar/.vite/build/bootstrap-BXjiq4qE.js",
    ),
  );

  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "early-bootstrap.js"),
    "/* CodexRebuildLocalUpdater:start */ Promise.resolve().then(()=>require(`./bootstrap-BXjiq4qE.js`));",
  );
  writeText(
    path.join(fixture.asarRoot, ".vite", "build", "bootstrap-BXjiq4qE.js"),
    "const backend=false;",
  );
  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("updater"),
  );
});

test("updater requires package metadata and Electron main-menu evidence", (t) => {
  const fixture = createFixture(t);
  const packageJson = JSON.parse(fs.readFileSync(path.join(fixture.asarRoot, "package.json"), "utf8"));
  delete packageJson.codexRebuildWindowsUpdateUrl;
  writeText(path.join(fixture.asarRoot, "package.json"), JSON.stringify(packageJson));
  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => error.message.includes("updater"),
  );
});

test("reports recursive evidence files for every satisfied contract", (t) => {
  const fixture = createFixture(t);

  const result = verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION);

  assert.deepEqual(Object.keys(result.contracts), CONTRACT_IDS);
  for (const [contract, evidenceFiles] of Object.entries(result.contracts)) {
    assert.ok(evidenceFiles.length > 0, `${contract} should report evidence`);
    assert.deepEqual(evidenceFiles, [...evidenceFiles].sort());
    assert.ok(evidenceFiles.every((file) => !path.isAbsolute(file)));
  }
  assert.deepEqual(result.contracts.updater, [
    "src/win/_asar/.vite/build/bootstrap-BXjiq4qE.js",
    "src/win/_asar/.vite/build/main-CZpDUN17.js",
    "src/win/_asar/.vite/build/preload.js",
    "src/win/_asar/package.json",
    "src/win/_asar/webview/assets/app-shell-CVVppk_a.js",
  ]);
});

test("combines package mismatch with every unsatisfied contract", (t) => {
  const fixture = createFixture(t, {
    version: "26.707.00000",
    omitMarkers: MARKERS.map((marker) => marker.id),
  });

  assert.throws(
    () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
    (error) => {
      assert.match(error.message, /package-version/);
      assert.match(error.message, /26\.707\.00000/);
      assert.match(error.message, /26\.707\.31428/);
      for (const contract of CONTRACT_IDS) assert.ok(error.message.includes(contract));
      return true;
    },
  );
});

test("rejects a missing or malformed extracted package manifest", async (t) => {
  await t.test("missing", (t) => {
    const fixture = createFixture(t, { omitPackage: true });
    assert.throws(
      () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
      /package-json.*missing/i,
    );
  });

  await t.test("malformed", (t) => {
    const fixture = createFixture(t, { packageText: "{not-json" });
    assert.throws(
      () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
      /package-json.*invalid/i,
    );
  });

  await t.test("version missing", (t) => {
    const fixture = createFixture(t, {
      packageText: JSON.stringify({ name: "openai-codex-electron" }),
    });
    assert.throws(
      () => verifyPatchedApp(fixture.root, "win", EXPECTED_VERSION),
      /package-version.*missing/i,
    );
  });
});

test("supports the Windows verification CLI and prints evidence files", (t) => {
  const fixture = createFixture(t);
  const script = path.join(__dirname, "verify-patched-app.js");

  const result = spawnSync(
    process.execPath,
    [
      script,
      "--root",
      fixture.root,
      "--platform",
      "win",
      "--expected-version",
      EXPECTED_VERSION,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  for (const contract of CONTRACT_IDS) assert.match(result.stdout, new RegExp(contract));
  assert.match(result.stdout, /app-shell-CVVppk_a\.js/);
});

test("patch-all passes the extracted Windows version to the verifier", (t) => {
  const patchAllPath = path.join(__dirname, "patch-all.js");
  const patchAllSource = fs.readFileSync(patchAllPath, "utf8");
  assert.match(
    patchAllSource,
    /if\s*\(require\.main\s*===\s*module\)/,
    "patch-all must be safe to import for integration testing",
  );

  const { runPatchAll } = require("./patch-all");
  const fixture = createFixture(t);
  const patchCalls = [];
  const verificationCalls = [];
  const logger = { error() {}, log() {} };

  const result = runPatchAll(["win"], {
    execFileSync(command, args, options) {
      patchCalls.push({ command, args, options });
    },
    logger,
    projectRoot: fixture.root,
    verifyPatchedApp(...args) {
      verificationCalls.push(args);
      return { contracts: {} };
    },
  });

  assert.ok(patchCalls.length > 0);
  assert.ok(patchCalls.every((call) => call.args.at(-1) === "win"));
  assert.deepEqual(verificationCalls, [
    [fixture.root, "win", EXPECTED_VERSION],
  ]);
  assert.equal(result.failed, 0);
});

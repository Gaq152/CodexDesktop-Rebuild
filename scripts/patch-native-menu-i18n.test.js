#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadPatchModule() {
  const filePath = path.join(__dirname, "patch-native-menu-i18n.js");
  const source = fs
    .readFileSync(filePath, "utf8")
    .replace(/\nmain\(\);\s*$/, "\nmodule.exports = { patchSource };\n");
  const sandbox = {
    __dirname,
    console,
    module: { exports: {} },
    process: { argv: ["node", filePath] },
    require,
  };
  vm.runInNewContext(source, sandbox, { filename: filePath });
  return sandbox.module.exports;
}

const { COMMAND_TITLE_TRANSLATIONS, locateTargets, patchSource } = loadPatchModule();

{
  const commandObjects = COMMAND_TITLE_TRANSLATIONS.map(
    ([messageId, from], index) => index % 2 === 0
      ? `{id:\`${messageId}\`,defaultMessage:\`${from}\`,description:\`fixture\`}`
      : `{defaultMessage:\`${from}\`,id:\`${messageId}\`,description:\`fixture\`}`,
  );
  const source = `const messages=[${commandObjects.join(",")}];const decoy={defaultMessage:\`Close Tab\`};`;
  const first = patchSource(source);

  assert.strictEqual(
    first.replacements.filter((item) => item.key === "commandMessage").length,
    COMMAND_TITLE_TRANSLATIONS.length,
  );
  for (const [messageId, from, to] of COMMAND_TITLE_TRANSLATIONS) {
    assert.ok(first.code.includes(`id:\`${messageId}\``), `missing command message: ${messageId}`);
    assert.ok(first.code.includes(`defaultMessage:\`${to}\``), `missing translation: ${from} -> ${to}`);
  }
  assert.ok(first.code.includes("const decoy={defaultMessage:`Close Tab`}"));

  const second = patchSource(first.code);
  assert.strictEqual(second.code, first.code);
  assert.strictEqual(second.replacements.length, 0);
}

{
  const commandTargets = locateTargets("win").filter((target) => {
    if (!target.path.includes(path.join("webview", "assets"))) return false;
    const source = fs.readFileSync(target.path, "utf8");
    return (
      source.includes("codex.commandMenuTitle.") &&
      (source.includes("menuTitleIntlId") || source.includes("codex.commandDescription."))
    );
  });
  const sources = commandTargets.map((target) => fs.readFileSync(target.path, "utf8"));

  assert.strictEqual(commandTargets.length, 3);
  assert.ok(sources.some((source) => source.includes("menuTitleIntlId")));
  assert.ok(sources.some((source) => source.includes("codex.commandDescription.")));
  const localized = sources.map((source) => patchSource(source).code).join("\n");
  for (const [messageId, , to] of COMMAND_TITLE_TRANSLATIONS) {
    assert.ok(localized.includes(`id:\`${messageId}\``), `missing catalog message: ${messageId}`);
    assert.ok(localized.includes(`defaultMessage:\`${to}\``), `missing catalog translation: ${to}`);
  }
}

{
  const source = "let menu=[{role:`editMenu`,id:t.fo.edit},{label:`View`,submenu:[]}];";
  const { code, replacements } = patchSource(source);

  assert.ok(replacements.some((item) => item.key === "roleMenu" && item.from === "editMenu"));
  assert.ok(code.includes("label:`编辑`"));
  assert.ok(code.includes("label:`撤销`,role:`undo`"));
  assert.ok(code.includes("label:`全选`,role:`selectAll`"));
  assert.ok(!code.includes("role:`editMenu`"));
}

{
  const source = "S&&items.push({role:`copy`,enabled:state.canCopy});";
  const { code, replacements } = patchSource(source);

  assert.ok(replacements.some((item) => item.key === "role" && item.from === "copy"));
  assert.ok(code.includes("{label:`复制`,role:`copy`,enabled:state.canCopy}"));
}

{
  const source = "items.push({label:`复制`,role:`copy`,enabled:state.canCopy});";
  const { code, replacements } = patchSource(source);

  assert.strictEqual(replacements.filter((item) => item.key === "role").length, 0);
  assert.strictEqual((code.match(/label:/g) ?? []).length, 1);
}

{
  const source = "items.push({label:`Copy`,menuTitle:`Search Files…`});";
  const { code } = patchSource(source);

  assert.ok(code.includes("label:`复制`"));
  assert.ok(code.includes("menuTitle:`搜索文件...`"));
}

{
  const source = [
    "const fileMenu=[{menuTitle:`New Task`},{menuTitle:`New Projectless Task`},{role:`quit`}];",
    "const taskCommands=[{menuTitle:`Search Tasks…`},{menuTitle:`Rename task`},{menuTitle:`Archive task`},{menuTitle:`Pin/unpin task`},{menuTitle:`Show pet`}];",
    `const viewMenu=[{menuTitle:\`Previous Task\`},{menuTitle:\`Next Task\`},${Array.from(
      { length: 9 },
      (_, index) => `{menuTitle:\`Go to Task ${index + 1}\`}`,
    ).join(",")}];`,
    "const helpMenu=[{label:`Documentation`},{label:`What's New`},{label:intl.formatMessage({messageId:`electron.appMenu.help.systemStatus`,defaultMessage:`System Status`})}];",
  ].join("");
  const first = patchSource(source);

  for (const expected of [
    "menuTitle:`新建任务`",
    "menuTitle:`新建无项目任务`",
    "label:`退出`,role:`quit`",
    "menuTitle:`搜索任务...`",
    "menuTitle:`重命名任务`",
    "menuTitle:`归档任务`",
    "menuTitle:`固定/取消固定任务`",
    "menuTitle:`显示助手`",
    "menuTitle:`上一个任务`",
    "menuTitle:`下一个任务`",
    ...Array.from({ length: 9 }, (_, index) => `menuTitle:\`转到任务 ${index + 1}\``),
    "label:`文档`",
    "label:`更新内容`",
    "defaultMessage:`系统状态`",
  ]) {
    assert.ok(first.code.includes(expected), `missing localized menu source: ${expected}`);
  }

  const second = patchSource(first.code);
  assert.strictEqual(second.code, first.code);
  assert.strictEqual(second.replacements.length, 0);
}

{
  const source = [
    "var Lu=`trayMenu.openApp`,Ru=`Open {appName}`,",
    "zu=`trayMenu.newChat`,Bu=`New Task`,",
    "Vu=`trayMenu.pinnedThreads`,Hu=`Pinned`,",
    "Uu=`trayMenu.runningThreads`,Wu=`Running`,",
    "Gu=`trayMenu.recentThreads`,Ku=`Recent`,",
    "qu=`trayMenu.unreadThreads`,Ju=`Unread`,",
    "Yu=`trayMenu.usage`,Xu=`Usage`,",
    "Zu=`trayMenu.more`,Qu=`More`,",
    "$u=`trayMenu.projectlessThreads`,ed=`Tasks`;",
    "const decoys=[`Open {appName}`,`New Task`,`Pinned`,`Running`,`Recent`,`Unread`,`Usage`,`More`,`Tasks`];",
  ].join("");
  const first = patchSource(source);

  for (const expected of [
    "Lu=`trayMenu.openApp`,Ru=`打开 {appName}`",
    "zu=`trayMenu.newChat`,Bu=`新建任务`",
    "Vu=`trayMenu.pinnedThreads`,Hu=`置顶`",
    "Uu=`trayMenu.runningThreads`,Wu=`运行中`",
    "Gu=`trayMenu.recentThreads`,Ku=`最近`",
    "qu=`trayMenu.unreadThreads`,Ju=`未读`",
    "Yu=`trayMenu.usage`,Xu=`使用情况`",
    "Zu=`trayMenu.more`,Qu=`更多`",
    "$u=`trayMenu.projectlessThreads`,ed=`任务`",
  ]) {
    assert.ok(first.code.includes(expected), `missing localized tray message: ${expected}`);
  }
  assert.ok(
    first.code.includes(
      "const decoys=[`Open {appName}`,`New Task`,`Pinned`,`Running`,`Recent`,`Unread`,`Usage`,`More`,`Tasks`]",
    ),
    "unscoped tray words must not be replaced",
  );
  assert.strictEqual(
    first.replacements.filter((item) => item.key === "trayMessage").length,
    9,
  );

  const second = patchSource(first.code);
  assert.strictEqual(second.code, first.code);
  assert.strictEqual(second.replacements.length, 0);
}

{
  const source = [
    "var $='trayMenu.openApp',_='Open {appName}';",
    "const descriptor={messageId:\"trayMenu.more\",defaultMessage:'More'};",
  ].join("");
  const first = patchSource(source);

  assert.ok(first.code.includes("$='trayMenu.openApp',_=`打开 {appName}`"));
  assert.ok(
    first.code.includes('messageId:"trayMenu.more",defaultMessage:`更多`'),
  );
  assert.strictEqual(
    first.replacements.filter((item) => item.key === "trayMessage").length,
    2,
  );
  const second = patchSource(first.code);
  assert.strictEqual(second.code, first.code);
  assert.strictEqual(second.replacements.length, 0);
}

{
  const source = `const help=[{label:"What's New"},{label:'Documentation'},{label:\`What's new\`},{label:\`Codex Documentation\`}];`;
  const { code } = patchSource(source);

  assert.strictEqual((code.match(/label:`更新内容`/g) ?? []).length, 2);
  assert.ok(code.includes("label:`文档`"));
  assert.ok(code.includes("label:`Codex 文档`"));
}

{
  const source = [
    "const contextMenu={",
    "searchWithGoogle:T9({id:`searchWithGoogle`,label:`&Search with Google`}),",
    "cut:T9({id:`cut`,label:`Cu&t`}),",
    "copy:T9({id:`copy`,label:`&Copy`}),",
    "paste:T9({id:`paste`,label:`&Paste`}),",
    "selectAll:T9({id:`selectAll`,label:`Select &All`}),",
    "inspect:T9({id:`inspect`,label:`I&nspect Element`})",
    "};",
  ].join("");
  const first = patchSource(source);

  assert.ok(first.code.includes("id:`searchWithGoogle`,label:`使用 Google 搜索`"));
  assert.ok(first.code.includes("id:`cut`,label:`剪切`"));
  assert.ok(first.code.includes("id:`copy`,label:`复制`"));
  assert.ok(first.code.includes("id:`paste`,label:`粘贴`"));
  assert.ok(first.code.includes("id:`selectAll`,label:`全选`"));
  assert.ok(first.code.includes("id:`inspect`,label:`检查元素`"));
  for (const english of [
    "&Search with Google",
    "Cu&t",
    "&Copy",
    "&Paste",
    "Select &All",
    "I&nspect Element",
  ]) {
    assert.ok(!first.code.includes(english), `untranslated context-menu label: ${english}`);
  }

  const second = patchSource(first.code);
  assert.strictEqual(second.code, first.code);
  assert.strictEqual(second.replacements.length, 0);
}

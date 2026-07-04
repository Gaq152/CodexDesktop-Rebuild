#!/usr/bin/env node
/**
 * Post-build patch: localize hard-coded Electron native menu labels.
 *
 * The renderer/webview locale bundle can translate menu bar captions such as
 * File/Edit/View/Help, but several native menu items are hard-coded in the
 * Electron main bundle. Patch those labels directly after upstream extraction.
 *
 * Usage:
 *   node scripts/patch-native-menu-i18n.js [platform]   # Apply
 *   node scripts/patch-native-menu-i18n.js --check      # Dry-run
 */
const fs = require("fs");
const { locateBundles, relPath } = require("./patch-util");

const MENU_LABEL_TRANSLATIONS = [
  ["File", "文件"],
  ["Edit", "编辑"],
  ["View", "视图"],
  ["Window", "窗口"],
  ["Help", "帮助"],
  ["Undo", "撤销"],
  ["Redo", "重做"],
  ["Cut", "剪切"],
  ["Copy", "复制"],
  ["Paste", "粘贴"],
  ["Delete", "删除"],
  ["Select All", "全选"],
  ["Copy conversation path", "复制对话路径"],
  ["Copy deeplink", "复制深度链接"],
  ["Copy session id", "复制会话 ID"],
  ["Copy working directory", "复制工作目录"],
  ["Close Tab", "关闭标签页"],
  ["Close", "关闭"],
  ["Reload Browser Page", "重新加载浏览器页面"],
  ["Force Reload Browser Page", "强制重新加载浏览器页面"],
  ["New Window", "新建窗口"],
  ["Open command menu", "打开命令菜单"],
  ["Search Chats…", "搜索对话..."],
  ["Search Files…", "搜索文件..."],
  ["Rename chat", "重命名对话"],
  ["Toggle File Tree", "切换文件树"],
  ["Start Trace Recording", "开始跟踪录制"],
  ["New Chat", "新建对话"],
  ["Quick Chat", "快速对话"],
  ["Open in New Window", "在新窗口中打开"],
  ["Archive chat", "归档对话"],
  ["Pin/unpin chat", "固定/取消固定对话"],
  ["Dictation", "听写"],
  ["Wake Pet", "唤醒助手"],
  ["Previous Chat", "上一个对话"],
  ["Next Chat", "下一个对话"],
  ["Settings…", "设置..."],
  ["Keyboard Shortcuts", "键盘快捷键"],
  ["Process Manager", "进程管理器"],
  ["Open Folder…", "打开文件夹..."],
  ["Toggle Sidebar", "切换边栏"],
  ["Toggle Bottom Panel", "切换底部面板"],
  ["Toggle Pinned Summary", "切换固定摘要"],
  ["Open Terminal", "打开终端"],
  ["Open Browser Tab", "打开浏览器标签页"],
  ["Toggle Browser Panel", "切换浏览器面板"],
  ["Toggle Side Panel", "切换侧边面板"],
  ["Find", "查找"],
  ["Focus Browser Address Bar", "聚焦浏览器地址栏"],
  ["Back", "后退"],
  ["Forward", "前进"],
  ["Go to Chat 1", "转到对话 1"],
  ["Go to Chat 2", "转到对话 2"],
  ["Go to Chat 3", "转到对话 3"],
  ["Go to Chat 4", "转到对话 4"],
  ["Go to Chat 5", "转到对话 5"],
  ["Go to Chat 6", "转到对话 6"],
  ["Go to Chat 7", "转到对话 7"],
  ["Go to Chat 8", "转到对话 8"],
  ["Go to Chat 9", "转到对话 9"],
  ["Log Out", "退出登录"],
  ["Reload Window", "重新加载窗口"],
  ["Zoom In", "放大"],
  ["Zoom Out", "缩小"],
  ["Actual Size", "实际大小"],
  ["Toggle Full Screen", "切换全屏"],
  ["Codex Documentation", "Codex 文档"],
  ["What's new", "更新内容"],
  ["Automations", "自动化"],
  ["Local Environments", "本地环境"],
  ["Worktrees", "工作树"],
  ["Skills", "技能"],
  ["Model Context Protocol", "模型上下文协议"],
  ["Troubleshooting", "故障排查"],
  ["Send Feedback", "发送反馈"],
  ["Check for Updates…", "检查更新..."],
  ["Toggle Debug Menu", "切换调试菜单"],
  ["Open Deeplink from Clipboard", "从剪贴板打开深度链接"],
  ["Toggle Query Devtools", "切换查询 DevTools"],
  ["Toggle React Scan", "切换 React Scan"],
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsStringLiteralVariants(value) {
  return [
    "`" + value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`",
    JSON.stringify(value),
    "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'",
  ];
}

function templateLiteral(value) {
  return "`" + value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
}

function patchSource(source) {
  let code = source;
  const replacements = [];

  for (const [from, to] of MENU_LABEL_TRANSLATIONS) {
    for (const literal of jsStringLiteralVariants(from)) {
      const pattern = new RegExp(`label\\s*:\\s*${escapeRegex(literal)}`, "g");
      code = code.replace(pattern, (match) => {
        replacements.push({ from, to });
        return match.replace(literal, templateLiteral(to));
      });
    }
  }

  return { code, replacements };
}

function locateTargets(platform) {
  const platforms = platform === "unix" ? ["mac-arm64", "mac-x64"] : platform ? [platform] : null;
  const targets = [];
  for (const plat of platforms ?? [null]) {
    targets.push(
      ...locateBundles({
        dir: "build",
        pattern: /^main(?:-[A-Za-z0-9_-]+)?\.js$/,
        platform: plat ?? undefined,
      })
    );
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win", "unix"].includes(a));
  const targets = locateTargets(platform);

  if (targets.length === 0) {
    console.log("[ok] No Electron main bundles found");
    return;
  }

  let total = 0;
  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf8");
    const { code, replacements } = patchSource(source);
    total += replacements.length;
    console.log(`\n-- [${target.platform}] ${relPath(target.path)}`);

    if (replacements.length === 0) {
      console.log("   [ok] native menu labels already localized or no hard-coded labels found");
      continue;
    }

    const summary = new Map();
    for (const item of replacements) {
      const key = `${item.from} -> ${item.to}`;
      summary.set(key, (summary.get(key) ?? 0) + 1);
    }
    for (const [label, count] of summary) {
      console.log(`   * ${label}${count > 1 ? ` (${count})` : ""}`);
    }

    if (!isCheck) {
      fs.writeFileSync(target.path, code, "utf8");
      console.log(`   [ok] native menu labels localized: ${replacements.length} replacements`);
    }
  }

  if (isCheck) {
    console.log(`\n=> Total patchable replacements: ${total}`);
  }
}

main();

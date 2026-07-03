#!/usr/bin/env node
/**
 * patch-sidebar-delete.js - Add permanent delete to the main sidebar thread row.
 *
 * This uses the app's own "delete-conversation" message route, which is backed
 * by the app-server "thread/delete" protocol. The route itself is injected by
 * patch-archive-delete.js.
 *
 * The sidebar action uses an inline two-step confirmation instead of a native
 * confirm() dialog: first click shows a row-level Confirm button, second click
 * permanently deletes the thread, and moving the mouse out of the row restores
 * the original delete action.
 */
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => walk(child, visitor));
    else if (value && typeof value === "object" && value.type) walk(value, visitor);
  }
}

function parse(code, file) {
  try {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
  } catch (e) {
    console.log(`  [!] ${relPath(file)}: parse failed: ${e.message}`);
    return null;
  }
}

function patchThreadActions(bundles) {
  let patched = 0;

  for (const bundle of bundles) {
    let code = fs.readFileSync(bundle.path, "utf-8");
    let changed = false;

    if (!code.includes("deleteThreadError")) {
      const archiveMessageRe =
        /archiveThread:\{id:`sidebarElectron\.archiveThread`,defaultMessage:`Archive chat`,description:`Menu item to archive a local thread`\},/;
      const insert =
        "archiveThread:{id:`sidebarElectron.archiveThread`,defaultMessage:`Archive chat`,description:`Menu item to archive a local thread`}," +
        "deleteThread:{id:`sidebarElectron.deleteThread`,defaultMessage:`删除对话`,description:`Menu item to permanently delete a local thread`}," +
        "deleteThreadConfirm:{id:`sidebarElectron.deleteThreadConfirm`,defaultMessage:`确认删除？`,description:`Confirmation shown before permanently deleting a local thread`}," +
        "deleteThreadConfirmAction:{id:`sidebarElectron.deleteThreadConfirmAction`,defaultMessage:`确认`,description:`Inline confirmation button label shown before permanently deleting a local thread`}," +
        "deleteThreadError:{id:`sidebarElectron.deleteThreadError`,defaultMessage:`删除对话失败`,description:`Error message when permanently deleting a local thread`},";

      if (!archiveMessageRe.test(code)) {
        console.log(`  [!] ${relPath(bundle.path)}: archiveThread message not found`);
        continue;
      }
      code = code.replace(archiveMessageRe, insert);
      changed = true;
    }

    const messageReplacements = [
      [
        "deleteThread:{id:`sidebarElectron.deleteThread`,defaultMessage:`Delete chat`,description:`Menu item to permanently delete a local thread`}",
        "deleteThread:{id:`sidebarElectron.deleteThread`,defaultMessage:`删除对话`,description:`Menu item to permanently delete a local thread`}",
      ],
      [
        "deleteThreadConfirm:{id:`sidebarElectron.deleteThreadConfirm`,defaultMessage:`Permanently delete this chat?`,description:`Confirmation shown before permanently deleting a local thread`}",
        "deleteThreadConfirm:{id:`sidebarElectron.deleteThreadConfirm`,defaultMessage:`确认删除？`,description:`Confirmation shown before permanently deleting a local thread`}",
      ],
      [
        "deleteThreadConfirm:{id:`sidebarElectron.deleteThreadConfirm`,defaultMessage:`永久删除这个对话？`,description:`Confirmation shown before permanently deleting a local thread`}",
        "deleteThreadConfirm:{id:`sidebarElectron.deleteThreadConfirm`,defaultMessage:`确认删除？`,description:`Confirmation shown before permanently deleting a local thread`}",
      ],
      [
        "deleteThreadError:{id:`sidebarElectron.deleteThreadError`,defaultMessage:`Failed to delete chat`,description:`Error message when permanently deleting a local thread`}",
        "deleteThreadError:{id:`sidebarElectron.deleteThreadError`,defaultMessage:`删除对话失败`,description:`Error message when permanently deleting a local thread`}",
      ],
    ];
    for (const [from, to] of messageReplacements) {
      if (code.includes(from)) {
        code = code.replace(from, to);
        changed = true;
      }
    }

    const confirmActionLong =
      "deleteThreadConfirmAction:{id:`sidebarElectron.deleteThreadConfirmAction`,defaultMessage:`确认删除`,description:`Inline confirmation button label shown before permanently deleting a local thread`}";
    if (code.includes(confirmActionLong)) {
      code = code.replace(
        confirmActionLong,
        "deleteThreadConfirmAction:{id:`sidebarElectron.deleteThreadConfirmAction`,defaultMessage:`确认`,description:`Inline confirmation button label shown before permanently deleting a local thread`}",
      );
      changed = true;
    }

    if (!code.includes("deleteThreadConfirmAction")) {
      const confirmMessageRe =
        /deleteThreadConfirm:\{id:`sidebarElectron\.deleteThreadConfirm`,defaultMessage:`[^`]+`,description:`Confirmation shown before permanently deleting a local thread`\},/;
      if (!confirmMessageRe.test(code)) {
        console.log(`  [!] ${relPath(bundle.path)}: deleteThreadConfirm message not found`);
        continue;
      }
      code = code.replace(
        confirmMessageRe,
        (match) =>
          `${match}deleteThreadConfirmAction:{id:\`sidebarElectron.deleteThreadConfirmAction\`,defaultMessage:\`确认\`,description:\`Inline confirmation button label shown before permanently deleting a local thread\`},`,
      );
      changed = true;
    }

    if (!code.includes("delete-conversation")) {
      const ast = parse(code, bundle.path);
      if (!ast) continue;

      let actionsFn = null;
      walk(ast, (node) => {
        if (node.type !== "FunctionDeclaration") return;
        const slice = code.slice(node.start, node.end);
        if (slice.includes("archive-conversation") && slice.includes("copyConversationMarkdown")) {
          actionsFn = node;
        }
      });

      if (!actionsFn) {
        console.log(`  [!] ${relPath(bundle.path)}: thread actions hook not found`);
        continue;
      }

      const fnCode = code.slice(actionsFn.start, actionsFn.end);
      const sendFn = fnCode.match(/([A-Za-z_$][\w$]*)\(`archive-conversation`/)?.[1];
      const errorParts = fnCode.match(
        /([A-Za-z_$][\w$]*)\.get\(([A-Za-z_$][\w$]*)\)\.danger\(([A-Za-z_$][\w$]*)\.formatMessage\(([A-Za-z_$][\w$]*)\.archiveThreadError\)\)/,
      );

      const returnStmt = actionsFn.body.body.find((node) => node.type === "ReturnStatement");
      const cacheVarDecl = actionsFn.body.body
        .slice()
        .reverse()
        .find((node) => node.type === "VariableDeclaration" && node.end <= returnStmt?.start);

      const objectMatch = returnStmt
        ? code.slice(returnStmt.start, returnStmt.end).match(/\(\w+=({archiveThread:[^?]+?copyConversationMarkdown:[^}]+})/)
        : null;

      if (!sendFn || !errorParts || !returnStmt || !cacheVarDecl || !objectMatch) {
        console.log(`  [!] ${relPath(bundle.path)}: could not resolve thread action variables`);
        continue;
      }

      const scopeVar = errorParts[1];
      const toastSignal = errorParts[2];
      const intlVar = errorParts[3];
      const messagesVar = errorParts[4];
      const deleteVar = cacheVarDecl.declarations[0]?.id?.name;
      if (!deleteVar) {
        console.log(`  [!] ${relPath(bundle.path)}: delete function variable not found`);
        continue;
      }

      const originalObject = objectMatch[1];
      const patchedObject = originalObject.replace("archiveThread:", `deleteThread:${deleteVar},archiveThread:`);
      const replacement =
        `let ${deleteVar}=e=>{let{conversationId:n,hostId:i,onDeleteStart:a,onDeleteSuccess:o,onDeleteError:s}=e;` +
        `a?.(),${sendFn}(\`delete-conversation\`,{conversationId:n,hostId:i}).then(()=>{o?.()}).catch(()=>{s?.(),` +
        `${scopeVar}.get(${toastSignal}).danger(${intlVar}.formatMessage(${messagesVar}.deleteThreadError))})};` +
        `return${patchedObject}`;

      code = code.slice(0, cacheVarDecl.start) + replacement + code.slice(returnStmt.end);
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(bundle.path, code);
      console.log(`  [ok] ${relPath(bundle.path)}: patched thread actions`);
      patched++;
    } else {
      console.log(`  [ok] ${relPath(bundle.path)}: thread actions already patched`);
    }
  }

  return patched;
}

function patchSidebarFlat(bundles) {
  let patched = 0;

  for (const bundle of bundles) {
    let code = fs.readFileSync(bundle.path, "utf-8");
    let changed = false;

    const trashFile = fs.readdirSync(path.dirname(bundle.path)).find((file) => /^trash-.*\.js$/.test(file));
    if (!trashFile) {
      console.log(`  [!] ${relPath(bundle.path)}: trash icon bundle not found`);
      continue;
    }

    if (!code.includes(`from"./${trashFile}"`)) {
      const archiveImport = /import\{n as [^}]+,t as [^}]+\}from"\.\/archive-[^"]+\.js";/;
      if (!archiveImport.test(code)) {
        console.log(`  [!] ${relPath(bundle.path)}: archive icon import not found`);
        continue;
      }
      code = code.replace(
        archiveImport,
        (match) => `${match}import{n as CodexTrashIconInit,t as CodexTrashIcon}from"./${trashFile}";`,
      );
      changed = true;
    }

    if (code.includes("CodexTrashIconInit") && !code.includes("CodexTrashIconInit()")) {
      if (!code.includes("go(),")) {
        console.log(`  [!] ${relPath(bundle.path)}: archive icon initializer not found`);
        continue;
      }
      code = code.replace("go(),", "go(),CodexTrashIconInit(),");
      changed = true;
    }

    const inlineDeleteActions =
      "function zl(e){let t=(0,Hl.c)(16),{archive:n,pinAction:r,deleteAction:i}=e,a=z(),o=i?.confirming??!1;" +
      "if(n==null&&r==null&&i==null)return null;" +
      "let s;t[0]!==r||t[1]!==o?(s=r==null||o?[]:[{id:`thread-pin-action`,ariaLabel:r.ariaLabel,icon:r.isPinned?(0,Wl.jsx)(Do,{className:`translate-x-px`}):(0,Wl.jsx)(Ba,{className:`translate-x-px`}),onClick:r.onClick}],t[0]=r,t[1]=o,t[2]=s):s=t[2];" +
      "let c;t[3]!==n||t[4]!==a||t[5]!==o?(c=n==null||o?[]:[{id:`thread-primary-action`,ariaLabel:a.formatMessage(aa.archiveThread),icon:(0,Wl.jsx)(_o,{}),onClick:n}],t[3]=n,t[4]=a,t[5]=o,t[6]=c):c=t[6];" +
      "let l;t[7]!==i||t[8]!==a||t[9]!==o?(l=i==null?[]:o?[{id:`thread-delete-confirm-action`,ariaLabel:a.formatMessage(aa.deleteThreadConfirmAction),label:a.formatMessage(aa.deleteThreadConfirmAction),color:`secondary`,buttonClassName:`text-token-error-foreground hover:text-token-error-foreground`,onClick:i.onConfirm}]:[{id:`thread-delete-action`,ariaLabel:a.formatMessage(aa.deleteThread),buttonClassName:`text-token-error-foreground hover:text-token-error-foreground`,icon:(0,Wl.jsx)(CodexTrashIcon,{}),onClick:i.onRequest}],t[7]=i,t[8]=a,t[9]=o,t[10]=l):l=t[10];" +
      "let u;return t[11]!==s||t[12]!==c||t[13]!==l||t[14]!==o?(u=(0,Wl.jsx)(fl,{actions:[...s,...c,...l],className:V(Za,o&&`opacity-100`)}),t[11]=s,t[12]=c,t[13]=l,t[14]=o,t[15]=u):u=t[15],u}";
    const legacyDeleteActions =
      "function zl(e){let t=(0,Hl.c)(12),{archive:n,pinAction:r,deleteAction:i}=e,a=z();" +
      "if(n==null&&r==null&&i==null)return null;" +
      "let o;t[0]===r?o=t[1]:(o=r==null?[]:[{id:`thread-pin-action`,ariaLabel:r.ariaLabel,icon:r.isPinned?(0,Wl.jsx)(Do,{className:`translate-x-px`}):(0,Wl.jsx)(Ba,{className:`translate-x-px`}),onClick:r.onClick}],t[0]=r,t[1]=o);" +
      "let s;t[2]!==n||t[3]!==a?(s=n==null?[]:[{id:`thread-primary-action`,ariaLabel:a.formatMessage(aa.archiveThread),icon:(0,Wl.jsx)(_o,{}),onClick:n}],t[2]=n,t[3]=a,t[4]=s):s=t[4];" +
      "let c;t[5]!==i||t[6]!==a?(c=i==null?[]:[{id:`thread-delete-action`,ariaLabel:a.formatMessage(aa.deleteThread),buttonClassName:`text-token-error-foreground hover:text-token-error-foreground`,icon:(0,Wl.jsx)(CodexTrashIcon,{}),onClick:i}],t[5]=i,t[6]=a,t[7]=c):c=t[7];" +
      "let l;return t[8]!==o||t[9]!==s||t[10]!==c?(l=(0,Wl.jsx)(fl,{actions:[...o,...s,...c],className:Za}),t[8]=o,t[9]=s,t[10]=c,t[11]=l):l=t[11],l}";

    if (code.includes(legacyDeleteActions)) {
      code = code.replace(legacyDeleteActions, inlineDeleteActions);
      changed = true;
    } else if (!code.includes("deleteAction:")) {
      const ast = parse(code, bundle.path);
      if (!ast) continue;

      let hoverActionsFn = null;
      walk(ast, (node) => {
        if (node.type !== "FunctionDeclaration") return;
        const slice = code.slice(node.start, node.end);
        if (slice.includes("thread-primary-action") && slice.includes("aa.archiveThread")) {
          hoverActionsFn = node;
        }
      });

      if (!hoverActionsFn) {
        console.log(`  [!] ${relPath(bundle.path)}: hover action function not found`);
        continue;
      }

      code = code.slice(0, hoverActionsFn.start) + inlineDeleteActions + code.slice(hoverActionsFn.end);
      changed = true;
    }

    if (code.includes("ariaLabel:`Confirm delete`,label:`Confirm`")) {
      code = code.replace(
        "ariaLabel:`Confirm delete`,label:`Confirm`",
        "ariaLabel:a.formatMessage(aa.deleteThreadConfirmAction),label:a.formatMessage(aa.deleteThreadConfirmAction)",
      );
      changed = true;
    }

    const stateAnchor = "[x,S]=(0,Ul.useState)(!1),C=z(),";
    if (code.includes(stateAnchor) && !code.includes("CodexDeleteConfirm")) {
      code = code.replace(
        stateAnchor,
        "[x,S]=(0,Ul.useState)(!1),[CodexDeleteConfirm,CodexSetDeleteConfirm]=(0,Ul.useState)(!1),C=z(),",
      );
      changed = true;
    } else if (!code.includes("CodexDeleteConfirm")) {
      console.log(`  [!] ${relPath(bundle.path)}: delete confirmation state anchor not found`);
      continue;
    }

    const actionDestructure =
      "{archiveThread:F,markThreadAsUnread:I,renameThread:L,copyWorkingDirectory:B,copySessionId:V,copyAppLink:H}=ca()";
    if (code.includes(actionDestructure)) {
      code = code.replace(
        actionDestructure,
        "{archiveThread:F,markThreadAsUnread:I,renameThread:L,copyWorkingDirectory:B,copySessionId:V,copyAppLink:H,deleteThread:CodexDeleteThread}=ca()",
      );
      changed = true;
    } else if (!code.includes("deleteThread:CodexDeleteThread")) {
      console.log(`  [!] ${relPath(bundle.path)}: sidebar action destructure not found`);
      continue;
    }

    const archiveHandler =
      "Ce=()=>{Q(),F({conversationId:e,hostId:g?.hostId,source:`sidebar_context_menu`,onArchiveSuccess:te,onArchiveError:ne})},we=ie(()=>{";
    if (code.includes(archiveHandler)) {
      const deleteHandler =
        "Ce=()=>{Q(),F({conversationId:e,hostId:g?.hostId,source:`sidebar_context_menu`,onArchiveSuccess:te,onArchiveError:ne})}," +
        "CodexConfirmDelete=ie(()=>{CodexSetDeleteConfirm(!1),Q(),CodexDeleteThread({conversationId:e,hostId:g?.hostId,onDeleteSuccess:()=>{te(),G&&y(`/`,{replace:!0,state:{focusComposerNonce:Date.now(),prefillCwd:w}})},onDeleteError:ne})})," +
        "CodexRequestDelete=ie(()=>{CodexSetDeleteConfirm(!0)}),we=ie(()=>{";
      code = code.replace(archiveHandler, deleteHandler);
      changed = true;
    } else if (code.includes("CodexHandleDelete=ie(()=>{if(!confirm(C.formatMessage(aa.deleteThreadConfirm)))return;")) {
      code = code.replace(
        "CodexHandleDelete=ie(()=>{if(!confirm(C.formatMessage(aa.deleteThreadConfirm)))return;Q(),CodexDeleteThread({conversationId:e,hostId:g?.hostId,onDeleteSuccess:()=>{te(),G&&y(`/`,{replace:!0,state:{focusComposerNonce:Date.now(),prefillCwd:w}})},onDeleteError:ne})}),",
        "CodexConfirmDelete=ie(()=>{CodexSetDeleteConfirm(!1),Q(),CodexDeleteThread({conversationId:e,hostId:g?.hostId,onDeleteSuccess:()=>{te(),G&&y(`/`,{replace:!0,state:{focusComposerNonce:Date.now(),prefillCwd:w}})},onDeleteError:ne})}),CodexRequestDelete=ie(()=>{CodexSetDeleteConfirm(!0)}),",
      );
      changed = true;
    } else if (code.includes("CodexRequestDelete=ie(()=>{CodexSetDeleteConfirm(!0),setTimeout(()=>CodexSetDeleteConfirm(!1),5e3)})")) {
      code = code.replace(
        "CodexRequestDelete=ie(()=>{CodexSetDeleteConfirm(!0),setTimeout(()=>CodexSetDeleteConfirm(!1),5e3)})",
        "CodexRequestDelete=ie(()=>{CodexSetDeleteConfirm(!0)})",
      );
      changed = true;
    } else if (!code.includes("CodexConfirmDelete")) {
      console.log(`  [!] ${relPath(bundle.path)}: sidebar archive handler not found`);
      continue;
    }

    const archiveMenu = "{id:`archive-thread`,message:aa.archiveThread,onSelect:we},";
    if (code.includes(archiveMenu) && !code.includes("id:`delete-thread`")) {
      code = code.replace(
        archiveMenu,
        `${archiveMenu}{id:\`delete-thread\`,message:aa.deleteThread,onSelect:CodexRequestDelete},`,
      );
      changed = true;
    } else if (code.includes("{id:`delete-thread`,message:aa.deleteThread,onSelect:CodexHandleDelete}")) {
      code = code.replace(
        "{id:`delete-thread`,message:aa.deleteThread,onSelect:CodexHandleDelete}",
        "{id:`delete-thread`,message:aa.deleteThread,onSelect:CodexRequestDelete}",
      );
      changed = true;
    } else if (!code.includes("id:`delete-thread`")) {
      console.log(`  [!] ${relPath(bundle.path)}: archive context menu item not found`);
      continue;
    }

    const renderActions =
      "je=(0,Ul.useCallback)(({archive:t})=>(0,Wl.jsx)(zl,{archive:t!=null&&xe?we:t,pinAction:Ae?{ariaLabel:C.formatMessage(n?_a:Ta),isPinned:n,onClick:()=>{ta(v,e,!n)}}:void 0}),[we,xe,C,n,e,v,Ae])";
    if (code.includes(renderActions)) {
      code = code.replace(
        renderActions,
        "je=(0,Ul.useCallback)(({archive:t})=>(0,Wl.jsx)(zl,{archive:t!=null&&xe?we:t,deleteAction:{confirming:CodexDeleteConfirm,onRequest:CodexRequestDelete,onConfirm:CodexConfirmDelete},pinAction:Ae?{ariaLabel:C.formatMessage(n?_a:Ta),isPinned:n,onClick:()=>{ta(v,e,!n)}}:void 0}),[we,xe,C,n,e,v,Ae,CodexDeleteConfirm,CodexRequestDelete,CodexConfirmDelete])",
      );
      changed = true;
    } else if (code.includes("deleteAction:CodexHandleDelete")) {
      code = code.replace(
        "je=(0,Ul.useCallback)(({archive:t})=>(0,Wl.jsx)(zl,{archive:t!=null&&xe?we:t,deleteAction:CodexHandleDelete,pinAction:Ae?{ariaLabel:C.formatMessage(n?_a:Ta),isPinned:n,onClick:()=>{ta(v,e,!n)}}:void 0}),[we,xe,C,n,e,v,Ae,CodexHandleDelete])",
        "je=(0,Ul.useCallback)(({archive:t})=>(0,Wl.jsx)(zl,{archive:t!=null&&xe?we:t,deleteAction:{confirming:CodexDeleteConfirm,onRequest:CodexRequestDelete,onConfirm:CodexConfirmDelete},pinAction:Ae?{ariaLabel:C.formatMessage(n?_a:Ta),isPinned:n,onClick:()=>{ta(v,e,!n)}}:void 0}),[we,xe,C,n,e,v,Ae,CodexDeleteConfirm,CodexRequestDelete,CodexConfirmDelete])",
      );
      changed = true;
    } else if (!code.includes("onConfirm:CodexConfirmDelete")) {
      console.log(`  [!] ${relPath(bundle.path)}: renderActions callback not found`);
      continue;
    }

    const hoverCount = "additionalHoverActionCount:Ae?1:0,";
    if (code.includes(hoverCount)) {
      code = code.replace(hoverCount, "additionalHoverActionCount:(Ae?1:0)+1,");
      changed = true;
    } else if (code.includes("additionalHoverActionCount:(Ae?1:0)+1")) {
      // Already reserves one slot for the delete/confirm action.
    } else if (code.includes("additionalHoverActionCount:(Ae?1:0)+(CodexDeleteConfirm?3:1)")) {
      code = code.replace(
        "additionalHoverActionCount:(Ae?1:0)+(CodexDeleteConfirm?3:1)",
        "additionalHoverActionCount:(Ae?1:0)+1",
      );
      changed = true;
    } else {
      console.log(`  [!] ${relPath(bundle.path)}: hover action count not found`);
      continue;
    }

    const legacyReturn =
      "return(0,Wl.jsxs)(Wl.Fragment,{children:[re?Me:(0,Wl.jsx)(pe,{getItems:ke,children:Me}),x?(0,Wl.jsx)(ha,{heartbeatAutomationName:be,open:!0,onOpenChange:S,onConfirm:Te}):null]})";
    const leaveReturn =
      "let CodexRow=re?Me:(0,Wl.jsx)(pe,{getItems:ke,children:Me});return(0,Wl.jsxs)(Wl.Fragment,{children:[(0,Wl.jsx)(`div`,{onMouseLeave:()=>CodexSetDeleteConfirm(!1),children:CodexRow}),x?(0,Wl.jsx)(ha,{heartbeatAutomationName:be,open:!0,onOpenChange:S,onConfirm:Te}):null]})";
    if (code.includes(legacyReturn)) {
      code = code.replace(legacyReturn, leaveReturn);
      changed = true;
    } else if (!code.includes("onMouseLeave:()=>CodexSetDeleteConfirm(!1)")) {
      console.log(`  [!] ${relPath(bundle.path)}: sidebar row return not found`);
      continue;
    }

    if (changed) {
      fs.writeFileSync(bundle.path, code);
      console.log(`  [ok] ${relPath(bundle.path)}: patched sidebar delete`);
      patched++;
    } else {
      console.log(`  [ok] ${relPath(bundle.path)}: sidebar delete already patched`);
    }
  }

  return patched;
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win"].includes(arg));

  console.log("  [layer 1] thread-actions: delete action");
  const threadActions = locateBundles({
    dir: "assets",
    pattern: /^thread-actions-.*\.js$/,
    ...(platform ? { platform } : {}),
  });
  const actionCount = patchThreadActions(threadActions);

  console.log("  [layer 2] sidebar-flat-sections: delete UI");
  const sidebarFlat = locateBundles({
    dir: "assets",
    pattern: /^sidebar-flat-sections-.*\.js$/,
    ...(platform ? { platform } : {}),
  });
  const sidebarCount = patchSidebarFlat(sidebarFlat);

  console.log(`  [done] thread actions: ${actionCount}, sidebar bundles: ${sidebarCount}`);
}

main();

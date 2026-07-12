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
const { relPath, SRC_DIR } = require("./patch-util");
const {
  planRequiredRoles,
  commitValidatedPlan,
} = require("./mac-contract-locator");

// Copied from the current upstream trash icon component. Keeping the exact
// 20x20 currentColor SVG here avoids coupling this patch to hashed asset names.
const OFFICIAL_TRASH_ICON_PATH =
  "M10.6299 1.33496C12.0335 1.33496 13.2695 2.25996 13.666 3.60645L13.8809 4.33496H17L17.1338 4.34863C17.4369 4.41057 17.665 4.67858 17.665 5C17.665 5.32142 17.4369 5.58943 17.1338 5.65137L17 5.66504H16.6543L15.8574 14.9912C15.7177 16.629 14.3478 17.8877 12.7041 17.8877H7.2959C5.75502 17.8877 4.45439 16.7815 4.18262 15.2939L4.14258 14.9912L3.34668 5.66504H3C2.63273 5.66504 2.33496 5.36727 2.33496 5C2.33496 4.63273 2.63273 4.33496 3 4.33496H6.11914L6.33398 3.60645L6.41797 3.3584C6.88565 2.14747 8.05427 1.33496 9.37012 1.33496H10.6299ZM5.46777 14.8779L5.49121 15.0537C5.64881 15.9161 6.40256 16.5576 7.2959 16.5576H12.7041C13.6571 16.5576 14.4512 15.8275 14.5322 14.8779L15.3193 5.66504H4.68164L5.46777 14.8779ZM7.66797 12.8271V8.66016C7.66797 8.29299 7.96588 7.99528 8.33301 7.99512C8.70028 7.99512 8.99805 8.29289 8.99805 8.66016V12.8271C8.99779 13.1942 8.70012 13.4912 8.33301 13.4912C7.96604 13.491 7.66823 13.1941 7.66797 12.8271ZM11.002 12.8271V8.66016C11.002 8.29289 11.2997 7.99512 11.667 7.99512C12.0341 7.9953 12.332 8.293 12.332 8.66016V12.8271C12.3318 13.1941 12.0339 13.491 11.667 13.4912C11.2999 13.4912 11.0022 13.1942 11.002 12.8271ZM9.37012 2.66504C8.60726 2.66504 7.92938 3.13589 7.6582 3.83789L7.60938 3.98145L7.50586 4.33496H12.4941L12.3906 3.98145C12.1607 3.20084 11.4437 2.66504 10.6299 2.66504H9.37012Z";

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

function parseRequired(code, label) {
  try {
    return acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    throw new Error(`${label} parse failed: ${error.message}`);
  }
}

function propertyName(node) {
  if (node?.type !== "Property") return null;
  if (!node.computed && node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "Literal") return String(node.key.value);
  return null;
}

function literalValue(node) {
  if (node?.type === "Literal") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function sourceFor(code, node) {
  return code.slice(node.start, node.end);
}

function trashIconSource(jsxAlias) {
  const jsx = `(0,${jsxAlias}.jsx)`;
  return (
    `${jsx}(\`svg\`,{width:20,height:20,viewBox:\`0 0 20 20\`,fill:\`currentColor\`,` +
    `xmlns:\`http://www.w3.org/2000/svg\`,className:\`text-token-error-foreground\`,` +
    `children:${jsx}(\`path\`,{d:\`${OFFICIAL_TRASH_ICON_PATH}\`})})`
  );
}

function applySourceReplacements(code, replacements) {
  let next = code;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    next = next.slice(0, replacement.start) + replacement.text + next.slice(replacement.end);
  }
  return next;
}

function sidebarCount(patchable, already, label) {
  const total = patchable + already;
  if (total !== 1) throw new Error(`${label} expected exactly 1 target, found ${total}`);
  return { patchable, already, total };
}

function countOccurrences(source, token) {
  return source.split(token).length - 1;
}

function sequenceMemberAlias(node, property) {
  if (node?.type !== "CallExpression" || node.callee.type !== "SequenceExpression") return null;
  const member = node.callee.expressions.at(-1);
  if (
    member?.type === "MemberExpression" &&
    !member.computed &&
    member.object.type === "Identifier" &&
    member.property.type === "Identifier" &&
    member.property.name === property
  ) {
    return member.object.name;
  }
  return null;
}

function parseSidebarDocument(code, label) {
  const comments = [];
  let ast;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      onComment: comments,
    });
  } catch (error) {
    throw new Error(`${label} parse failed: ${error.message}`);
  }
  return { ast, comments };
}

function exactSidebarComments(comments, name) {
  return comments.filter(
    (comment) => comment.type === "Block" && comment.value.trim() === name,
  );
}

function patternBinding(pattern, name) {
  if (pattern?.type !== "ObjectPattern") return null;
  const property = pattern.properties.find(
    (item) => item.type === "Property" && propertyName(item) === name,
  );
  return property?.value?.type === "Identifier" ? property.value.name : null;
}

function objectProperty(object, name) {
  return object?.type === "ObjectExpression"
    ? object.properties.find((property) => propertyName(property) === name)
    : null;
}

function objectProperties(object, name) {
  return object?.type === "ObjectExpression"
    ? object.properties.filter((property) => propertyName(property) === name)
    : [];
}

function isFormatMessageFor(node, messageName) {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "formatMessage" &&
    node.arguments.length === 1 &&
    node.arguments[0]?.type === "MemberExpression" &&
    !node.arguments[0].computed &&
    node.arguments[0].property.type === "Identifier" &&
    node.arguments[0].property.name === messageName
  );
}

function isOfficialTrashIcon(node, requireErrorColor = true) {
  const jsxAlias = sequenceMemberAlias(node, "jsx");
  if (
    !jsxAlias ||
    literalValue(node.arguments[0]) !== "svg" ||
    node.arguments[1]?.type !== "ObjectExpression"
  ) return false;
  const props = node.arguments[1];
  const child = objectProperty(props, "children")?.value;
  return (
    literalValue(objectProperty(props, "width")?.value) === 20 &&
    literalValue(objectProperty(props, "height")?.value) === 20 &&
    literalValue(objectProperty(props, "viewBox")?.value) === "0 0 20 20" &&
    literalValue(objectProperty(props, "fill")?.value) === "currentColor" &&
    literalValue(objectProperty(props, "xmlns")?.value) === "http://www.w3.org/2000/svg" &&
    (!requireErrorColor ||
      literalValue(objectProperty(props, "className")?.value) === "text-token-error-foreground") &&
    sequenceMemberAlias(child, "jsx") === jsxAlias &&
    literalValue(child.arguments[0]) === "path" &&
    literalValue(objectProperty(child.arguments[1], "d")?.value) === OFFICIAL_TRASH_ICON_PATH
  );
}

function isFunctionNode(node) {
  return ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(
    node?.type,
  );
}

function walkOwnExecutableBody(node, visitor) {
  function visit(current) {
    if (!current || typeof current !== "object" || isFunctionNode(current)) return;
    visitor(current);
    if (current.type === "IfStatement" && typeof literalValue(current.test) === "boolean") {
      visit(literalValue(current.test) ? current.consequent : current.alternate);
      return;
    }
    for (const [key, value] of Object.entries(current)) {
      if (["type", "start", "end"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && value.type) visit(value);
    }
  }
  visit(node);
}

function returnedObjectExpression(argument) {
  if (argument?.type === "ObjectExpression") return argument;
  if (argument?.type === "AssignmentExpression" && argument.right.type === "ObjectExpression") {
    return argument.right;
  }
  if (argument?.type !== "SequenceExpression") return null;
  const result = argument.expressions.at(-1);
  if (result?.type === "ObjectExpression") return result;
  if (result?.type !== "Identifier") return null;
  const assignments = [];
  for (const expression of argument.expressions.slice(0, -1)) {
    walkOwnExecutableBody(expression, (candidate) => {
      if (
        candidate.type === "AssignmentExpression" &&
        candidate.operator === "=" &&
        candidate.left.type === "Identifier" &&
        candidate.left.name === result.name &&
        candidate.right.type === "ObjectExpression"
      ) {
        assignments.push(candidate.right);
      }
    });
  }
  return assignments.length === 1 ? assignments[0] : null;
}

function directFunctionBinding(functionNode, name) {
  const candidates = [];
  for (const statement of functionNode.body.body) {
    walkOwnExecutableBody(statement, (candidate) => {
      if (candidate.type === "VariableDeclarator") {
        if (
          candidate.id.type === "Identifier" &&
          candidate.id.name === name &&
          isFunctionNode(candidate.init)
        ) candidates.push(candidate.init);
        return;
      }
      if (
        candidate.type === "AssignmentExpression" &&
        candidate.operator === "=" &&
        candidate.left.type === "Identifier" &&
        candidate.left.name === name &&
        isFunctionNode(candidate.right)
      ) candidates.push(candidate.right);
    });
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function inspectThreadActionsPostcondition(code) {
  const { ast, comments } = parseSidebarDocument(code, "sidebar thread-actions");
  const markerComments = exactSidebarComments(comments, "CodexSidebarDeleteAction");
  if (
    markerComments.length !== 1 ||
    comments.some(
      (comment) =>
        comment.value.includes("CodexSidebarDeleteAction") &&
        (comment.type !== "Block" || comment.value.trim() !== "CodexSidebarDeleteAction"),
    )
  ) throw new Error("sidebar thread-actions marker postcondition is malformed");

  const messageObjects = [];
  const actionDeclarations = [];
  const deleteBindings = [];
  const functions = [];
  walk(ast, (node) => {
    if (node.type === "FunctionDeclaration") functions.push(node);
    if (node.type === "ObjectExpression") {
      const archive = objectProperty(node, "archiveThread");
      const archiveId = objectProperty(archive?.value, "id");
      if (literalValue(archiveId?.value) === "sidebarElectron.archiveThread") {
        const expected = new Map([
          ["deleteThread", "sidebarElectron.deleteThread"],
          ["deleteThreadConfirmAction", "sidebarElectron.deleteThreadConfirmAction"],
          ["deleteThreadError", "sidebarElectron.deleteThreadError"],
        ]);
        if (
          [...expected].every(([name, id]) =>
            literalValue(objectProperty(objectProperty(node, name)?.value, "id")?.value) === id,
          )
        ) messageObjects.push(node);
      }
    }
    if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) {
        if (declaration.id.type === "Identifier" && declaration.id.name === "CodexSidebarDeleteAction") {
          actionDeclarations.push({ declaration, statement: node });
        }
      }
    }
    if (
      node.type === "Property" &&
      propertyName(node) === "deleteThread" &&
      node.value?.type === "Identifier" &&
      node.value.name === "CodexSidebarDeleteAction"
    ) deleteBindings.push(node);
  });
  if (messageObjects.length !== 1) {
    throw new Error(`sidebar messages postcondition expected exactly 1 object, found ${messageObjects.length}`);
  }
  if (actionDeclarations.length !== 1 || deleteBindings.length !== 1) {
    throw new Error("sidebar thread-actions action/binding postcondition is incomplete");
  }
  const { declaration, statement } = actionDeclarations[0];
  if (markerComments[0].end !== statement.start) {
    throw new Error("sidebar thread-actions action marker is detached");
  }
  if (declaration.init?.type !== "ArrowFunctionExpression" || declaration.init.params.length !== 1) {
    throw new Error("sidebar thread-actions delete action is not executable");
  }
  const parameter = declaration.init.params[0];
  const bindingPatterns = declaration.init.body.body
    .filter((node) => node.type === "VariableDeclaration")
    .flatMap((node) => node.declarations)
    .filter(
      (node) =>
        node.id.type === "ObjectPattern" &&
        node.init?.type === "Identifier" &&
        parameter.type === "Identifier" &&
        node.init.name === parameter.name,
    )
    .map((node) => node.id);
  if (bindingPatterns.length !== 1) throw new Error("sidebar thread-actions delete parameters are missing");
  const conversationId = patternBinding(bindingPatterns[0], "conversationId");
  const hostId = patternBinding(bindingPatterns[0], "hostId");
  const routeCalls = [];
  walkOwnExecutableBody(declaration.init.body, (node) => {
    if (
      node.type === "CallExpression" &&
      literalValue(node.arguments[0]) === "delete-conversation" &&
      node.arguments[1]?.type === "ObjectExpression"
    ) routeCalls.push(node);
  });
  if (routeCalls.length !== 1 || !conversationId || !hostId) {
    throw new Error("sidebar thread-actions delete route postcondition is incomplete");
  }
  const routeOptions = routeCalls[0].arguments[1];
  const conversationProperty = objectProperty(routeOptions, "conversationId");
  const hostProperty = objectProperty(routeOptions, "hostId");
  if (
    !conversationProperty ||
    !hostProperty ||
    sourceFor(code, conversationProperty.value) !== conversationId ||
    sourceFor(code, hostProperty.value) !== hostId
  ) throw new Error("sidebar thread-actions delete route bindings are mismatched");
  const enclosing = functions.filter(
    (fn) => fn.start < statement.start && fn.end > statement.end && fn.start < deleteBindings[0].start && fn.end > deleteBindings[0].end,
  );
  if (enclosing.length !== 1) throw new Error("sidebar thread-actions delete binding is detached");
  const owner = enclosing[0];
  if (!owner.body.body.includes(statement)) {
    throw new Error("sidebar thread-actions delete action is not a live factory statement");
  }
  const directReturns = owner.body.body.filter((node) => node.type === "ReturnStatement");
  if (directReturns.length !== 1) {
    throw new Error("sidebar thread-actions returned action object is ambiguous");
  }
  const returnedObject = returnedObjectExpression(directReturns[0].argument);
  const returnedDelete = objectProperty(returnedObject, "deleteThread");
  if (returnedDelete !== deleteBindings[0]) {
    throw new Error("sidebar thread-actions delete binding is not in the returned action object");
  }
  const archiveBinding = objectProperty(returnedObject, "archiveThread")?.value;
  if (archiveBinding?.type !== "Identifier") {
    throw new Error("sidebar thread-actions returned archive binding is missing");
  }
  const archiveAction = directFunctionBinding(owner, archiveBinding.name);
  if (!archiveAction) throw new Error("sidebar thread-actions live archive action is missing");
  const archiveCalls = [];
  walkOwnExecutableBody(archiveAction.body, (node) => {
    if (
      node.type === "CallExpression" &&
      literalValue(node.arguments[0]) === "archive-conversation"
    ) archiveCalls.push(node);
  });
  if (
    archiveCalls.length !== 1 ||
    sourceFor(code, archiveCalls[0].callee) !== sourceFor(code, routeCalls[0].callee)
  ) {
    throw new Error("sidebar thread-actions delete route is not bound to the live bridge");
  }
  return { status: "already" };
}

function migrateArchivedSidebarDeleteRoute(code) {
  const { ast } = parseSidebarDocument(code, "sidebar thread-actions migration");
  const calls = [];
  walk(ast, (node) => {
    if (
      node.type !== "VariableDeclarator" ||
      node.id.type !== "Identifier" ||
      node.id.name !== "CodexSidebarDeleteAction" ||
      node.init?.type !== "ArrowFunctionExpression"
    ) return;
    walkOwnExecutableBody(node.init.body, (inner) => {
      if (
        inner.type === "CallExpression" &&
        literalValue(inner.arguments[0]) === "delete-archived-conversation" &&
        inner.arguments[1]?.type === "ObjectExpression" &&
        objectProperty(inner.arguments[1], "conversationId") &&
        objectProperty(inner.arguments[1], "hostId")
      ) calls.push(inner);
    });
  });
  if (calls.length !== 1 || code.includes("`delete-conversation`")) return null;
  const route = calls[0].arguments[0];
  return applySourceReplacements(code, [
    { start: route.start, end: route.end, text: "`delete-conversation`" },
  ]);
}

function patchThreadActionsSource(code) {
  const messageMarker = "id:`sidebarElectron.deleteThread`";
  const actionMarker = "/* CodexSidebarDeleteAction */";
  const messageCount = countOccurrences(code, messageMarker);
  const actionCount = countOccurrences(code, actionMarker);
  const bindingCount = countOccurrences(code, "deleteThread:CodexSidebarDeleteAction");
  if (messageCount > 0 || actionCount > 0 || bindingCount > 0) {
    try {
      inspectThreadActionsPostcondition(code);
    } catch (error) {
      const migrated = migrateArchivedSidebarDeleteRoute(code);
      if (migrated == null) throw error;
      inspectThreadActionsPostcondition(migrated);
      return {
        code: migrated,
        status: "patched",
        counts: {
          messages: sidebarCount(0, 1, "sidebar messages"),
          action: sidebarCount(1, 0, "sidebar action"),
        },
      };
    }
    return {
      code,
      status: "already",
      counts: {
        messages: sidebarCount(0, 1, "sidebar messages"),
        action: sidebarCount(0, 1, "sidebar action"),
      },
    };
  }

  const ast = parseRequired(code, "sidebar thread-actions");
  const archiveMessages = [];
  const actionFunctions = [];
  walk(ast, (node) => {
    if (node.type === "Property" && propertyName(node) === "archiveThread") {
      const idProperty = node.value?.type === "ObjectExpression"
        ? node.value.properties.find((property) => propertyName(property) === "id")
        : null;
      if (literalValue(idProperty?.value) === "sidebarElectron.archiveThread") archiveMessages.push(node);
    }
    if (node.type === "FunctionDeclaration") {
      const source = sourceFor(code, node);
      if (source.includes("archive-conversation") && source.includes("copyConversationMarkdown")) {
        actionFunctions.push(node);
      }
    }
  });
  if (archiveMessages.length !== 1) {
    throw new Error(`sidebar messages expected exactly 1 target, found ${archiveMessages.length}`);
  }
  if (actionFunctions.length !== 1) {
    throw new Error(`sidebar action expected exactly 1 target, found ${actionFunctions.length}`);
  }

  const actionFunction = actionFunctions[0];
  const archiveCalls = [];
  const resultObjects = [];
  const returns = [];
  walk(actionFunction, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      literalValue(node.arguments[0]) === "archive-conversation"
    ) archiveCalls.push(node);
    if (node.type === "ObjectExpression") {
      const names = node.properties.map(propertyName);
      if (names.includes("archiveThread") && names.includes("copyConversationMarkdown")) {
        resultObjects.push(node);
      }
    }
    if (node.type === "ReturnStatement") returns.push(node);
  });
  if (archiveCalls.length !== 1 || resultObjects.length !== 1 || returns.length === 0) {
    throw new Error("sidebar action structure is incomplete");
  }
  const sendFunction = archiveCalls[0].callee.name;
  const finalReturn = returns.at(-1);
  const messages =
    ",deleteThread:{id:`sidebarElectron.deleteThread`,defaultMessage:`删除任务`,description:`Menu item to permanently delete a local task`}" +
    ",deleteThreadConfirmAction:{id:`sidebarElectron.deleteThreadConfirmAction`,defaultMessage:`确认`,description:`Inline confirmation button label shown before permanently deleting a local task`}" +
    ",deleteThreadError:{id:`sidebarElectron.deleteThreadError`,defaultMessage:`删除任务失败`,description:`Error message when permanently deleting a local task`}";
  const action =
    `${actionMarker}let CodexSidebarDeleteAction=e=>{let{conversationId:n,hostId:i,onDeleteStart:a,onDeleteSuccess:o,onDeleteError:s}=e;` +
    `a?.(),${sendFunction}(\`delete-conversation\`,{conversationId:n,hostId:i}).then(()=>o?.()).catch(()=>s?.())};`;
  const next = applySourceReplacements(code, [
      { start: archiveMessages[0].end, end: archiveMessages[0].end, text: messages },
      { start: resultObjects[0].start + 1, end: resultObjects[0].start + 1, text: "deleteThread:CodexSidebarDeleteAction," },
      { start: finalReturn.start, end: finalReturn.start, text: action },
    ]);
  inspectThreadActionsPostcondition(next);
  return {
    code: next,
    status: "patched",
    counts: {
      messages: sidebarCount(1, 0, "sidebar messages"),
      action: sidebarCount(1, 0, "sidebar action"),
    },
  };
}

function analyzeHoverFunction(code, node) {
  const patterns = [];
  const nullTests = [];
  const formatCalls = [];
  const actionRenders = [];
  const returns = [];
  walk(node, (inner) => {
    if (inner.type === "ObjectPattern") {
      const names = inner.properties.map(propertyName);
      if (names.includes("archive") && names.includes("pinAction")) patterns.push(inner);
    }
    if (inner.type === "IfStatement" && sourceFor(code, inner.test).includes("==null")) {
      nullTests.push(inner.test);
    }
    if (
      inner.type === "CallExpression" &&
      inner.callee.type === "MemberExpression" &&
      inner.callee.property?.name === "formatMessage" &&
      inner.arguments[0]?.type === "MemberExpression" &&
      inner.arguments[0].property?.name === "archiveThread"
    ) formatCalls.push(inner);
    const jsxAlias = sequenceMemberAlias(inner, "jsx");
    if (jsxAlias && inner.arguments[1]?.type === "ObjectExpression") {
      const actions = inner.arguments[1].properties.find((property) => propertyName(property) === "actions");
      const className = inner.arguments[1].properties.find((property) => propertyName(property) === "className");
      if (actions?.value.type === "ArrayExpression" && className && inner.arguments[0]?.type === "Identifier") {
        actionRenders.push({ call: inner, actions: actions.value, className: className.value, jsxAlias });
      }
    }
    if (inner.type === "ReturnStatement") returns.push(inner);
  });
  if (
    patterns.length !== 1 ||
    nullTests.length !== 1 ||
    formatCalls.length !== 1 ||
    actionRenders.length !== 1 ||
    returns.length === 0
  ) throw new Error("sidebar hover action structure is incomplete");
  const formatCall = formatCalls[0];
  const render = actionRenders[0];
  const spreadNames = render.actions.elements
    .filter((element) => element?.type === "SpreadElement" && element.argument.type === "Identifier")
    .map((element) => element.argument.name);
  if (spreadNames.length !== 2) throw new Error("sidebar hover action lists are ambiguous");
  const finalReturn = returns.at(-1);
  const priorStatement = node.body.body[node.body.body.indexOf(finalReturn) - 1];
  if (priorStatement?.type !== "VariableDeclaration") {
    throw new Error("sidebar hover return cache structure is missing");
  }
  return {
    pattern: patterns[0],
    nullTest: nullTests[0],
    intl: sourceFor(code, formatCall.callee.object),
    messages: sourceFor(code, formatCall.arguments[0].object),
    render,
    spreadNames,
    tailStart: priorStatement.start,
    tailEnd: finalReturn.end,
  };
}

function analyzeRowFunction(code, node, hoverFunctionName) {
  const hookPatterns = [];
  const stateDeclarations = [];
  const archiveHandlers = [];
  const archiveItems = [];
  const hoverRenders = [];
  const hoverCounts = [];
  const useCallbacks = [];
  walk(node, (inner) => {
    if (inner.type === "VariableDeclarator" && inner.id.type === "ObjectPattern") {
      const names = inner.id.properties.map(propertyName);
      if (names.includes("archiveThread")) hookPatterns.push(inner.id);
    }
    if (
      inner.type === "VariableDeclarator" &&
      inner.id.type === "ArrayPattern" &&
      sequenceMemberAlias(inner.init, "useState")
    ) stateDeclarations.push(inner);
    if (
      inner.type === "VariableDeclarator" &&
      (inner.init?.type === "ArrowFunctionExpression" || inner.init?.type === "FunctionExpression") &&
      sourceFor(code, inner.init).includes("sidebar_context_menu")
    ) archiveHandlers.push(inner);
    if (inner.type === "ObjectExpression") {
      const id = inner.properties.find((property) => propertyName(property) === "id");
      if (literalValue(id?.value) === "archive-thread") archiveItems.push(inner);
      const hoverCount = inner.properties.find(
        (property) => propertyName(property) === "additionalHoverActionCount",
      );
      if (hoverCount) hoverCounts.push({ object: inner, property: hoverCount });
    }
    const jsxAlias = sequenceMemberAlias(inner, "jsx");
    if (
      jsxAlias &&
      inner.arguments[0]?.type === "Identifier" &&
      inner.arguments[0].name === hoverFunctionName &&
      inner.arguments[1]?.type === "ObjectExpression"
    ) hoverRenders.push(inner);
    const reactAlias = sequenceMemberAlias(inner, "useCallback");
    if (reactAlias && inner.arguments[1]?.type === "ArrayExpression") useCallbacks.push(inner);
  });
  if (
    hookPatterns.length !== 1 ||
    stateDeclarations.length < 1 ||
    archiveHandlers.length !== 1 ||
    archiveItems.length !== 1 ||
    hoverRenders.length !== 1 ||
    hoverCounts.length !== 1
  ) throw new Error("sidebar row structure is incomplete");
  const render = hoverRenders[0];
  const callback = useCallbacks.find((call) =>
    call.arguments[0] &&
    render.start >= call.arguments[0].start &&
    render.end <= call.arguments[0].end,
  );
  if (!callback) throw new Error("sidebar renderActions callback is missing");
  const handler = archiveHandlers[0];
  const archiveCall = [];
  walk(handler.init, (inner) => {
    if (inner.type !== "CallExpression") return;
    const options = inner.arguments.find(
      (argument) =>
        argument?.type === "ObjectExpression" &&
        argument.properties.some((property) => propertyName(property) === "conversationId"),
    );
    if (options) archiveCall.push({ call: inner, options });
  });
  if (archiveCall.length !== 1) throw new Error("sidebar archive handler call is ambiguous");
  const archiveArgs = archiveCall[0].options;
  const valueFor = (name) => {
    const property = archiveArgs.properties.find((item) => propertyName(item) === name);
    if (!property) throw new Error(`sidebar archive handler ${name} is missing`);
    return sourceFor(code, property.value);
  };
  const archiveMessage = archiveItems[0].properties.find((property) => propertyName(property) === "message");
  if (archiveMessage?.value.type !== "MemberExpression") {
    throw new Error("sidebar archive message binding is missing");
  }
  return {
    hookPattern: hookPatterns[0],
    stateDeclaration: stateDeclarations[0],
    handler,
    archiveItem: archiveItems[0],
    messageObject: sourceFor(code, archiveMessage.value.object),
    hoverRender: render,
    callbackDependencies: callback.arguments[1],
    hoverCount: hoverCounts[0],
    conversationId: valueFor("conversationId"),
    hostId: valueFor("hostId"),
    success: valueFor("onArchiveSuccess"),
    error: valueFor("onArchiveError"),
  };
}

function functionContaining(functions, node) {
  return functions.filter((fn) => fn.start < node.start && fn.end > node.end);
}

function callToIdentifier(root, name, predicate = () => true) {
  const calls = [];
  walk(root, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === name &&
      predicate(node)
    ) calls.push(node);
  });
  return calls;
}

function isDeleteConfirmResetHandler(code, node) {
  return (
    node?.type === "ArrowFunctionExpression" &&
    node.params.length === 0 &&
    !node.async &&
    node.body?.type === "CallExpression" &&
    node.body.callee?.type === "Identifier" &&
    node.body.callee.name === "CodexSetDeleteConfirm" &&
    node.body.arguments.length === 1 &&
    sourceFor(code, node.body.arguments[0]) === "!1"
  );
}

function identifierSpreadNames(object) {
  return object?.type === "ObjectExpression"
    ? object.properties
      .filter(
        (property) =>
          property?.type === "SpreadElement" && property.argument?.type === "Identifier",
      )
      .map((property) => property.argument.name)
    : [];
}

function resetDataAttributesSource(code, object) {
  const existing = objectProperties(object, "dataAttributes");
  if (existing.length > 1) {
    throw new Error("sidebar row has duplicate dataAttributes props");
  }
  if (existing.length === 1) {
    return `{...(${sourceFor(code, existing[0].value)}??{}),onMouseLeave:()=>CodexSetDeleteConfirm(!1)}`;
  }
  const spreadNames = identifierSpreadNames(object);
  if (spreadNames.length > 1) {
    throw new Error("sidebar row dataAttributes spread source is ambiguous");
  }
  const preserved = spreadNames.length === 1
    ? `...(${spreadNames[0]}.dataAttributes??{}),`
    : "";
  return `{${preserved}onMouseLeave:()=>CodexSetDeleteConfirm(!1)}`;
}

function inspectSidebarPostcondition(code) {
  const { ast, comments } = parseSidebarDocument(code, "sidebar UI");
  const hoverComments = exactSidebarComments(comments, "CodexSidebarDeleteHover");
  const rowComments = exactSidebarComments(comments, "CodexSidebarDeleteRow");
  if (hoverComments.length !== 1 || rowComments.length !== 1) {
    throw new Error("sidebar hover/row marker postcondition is malformed");
  }
  if (
    comments.some(
      (comment) =>
        (comment.value.includes("CodexSidebarDeleteHover") ||
          comment.value.includes("CodexSidebarDeleteRow")) &&
        !["CodexSidebarDeleteHover", "CodexSidebarDeleteRow"].includes(comment.value.trim()),
    )
  ) throw new Error("sidebar hover/row marker postcondition is malformed");
  const functions = [];
  const hoverDeclarations = [];
  walk(ast, (node) => {
    if (node.type === "FunctionDeclaration") functions.push(node);
    if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) {
        if (declaration.id.type === "Identifier" && declaration.id.name === "CodexSidebarDeleteActions") {
          hoverDeclarations.push({ declaration, statement: node });
        }
      }
    }
  });
  if (hoverDeclarations.length !== 1) {
    throw new Error("sidebar hover action postcondition is missing");
  }
  const hoverDeclaration = hoverDeclarations[0];
  if (hoverComments[0].end !== hoverDeclaration.statement.start) {
    throw new Error("sidebar hover action marker is detached");
  }
  const hoverFunctions = functionContaining(functions, hoverDeclaration.statement);
  if (hoverFunctions.length !== 1) throw new Error("sidebar hover action is detached");
  const hoverFunction = hoverFunctions[0];
  const deleteActionBindings = [];
  walk(hoverFunction, (node) => {
    if (node.type === "ObjectPattern") {
      const binding = patternBinding(node, "deleteAction");
      if (binding === "CodexDeleteAction") deleteActionBindings.push(node);
    }
  });
  const expectedActions = new Map([
    ["thread-delete-action", "onRequest"],
    ["thread-delete-confirm-action", "onConfirm"],
  ]);
  const actionObjects = new Map([...expectedActions.keys()].map((id) => [id, []]));
  walk(hoverDeclaration.declaration.init, (node) => {
    if (node.type !== "ObjectExpression") return;
    const id = literalValue(objectProperty(node, "id")?.value);
    if (expectedActions.has(id)) actionObjects.get(id).push(node);
  });
  if (
    deleteActionBindings.length !== 1 ||
    [...actionObjects.values()].some((objects) => objects.length !== 1)
  ) {
    throw new Error("sidebar hover action wiring is incomplete");
  }
  for (const [id, method] of expectedActions) {
    const actionObject = actionObjects.get(id)[0];
    const onClick = objectProperty(actionObject, "onClick")?.value;
    if (
      onClick?.type !== "MemberExpression" ||
      onClick.object?.type !== "Identifier" ||
      onClick.object.name !== "CodexDeleteAction" ||
      onClick.property?.name !== method
    ) throw new Error(`sidebar hover ${id} handler is detached`);
  }
  const deleteActionObject = actionObjects.get("thread-delete-action")[0];
  if (
    objectProperties(deleteActionObject, "ariaLabel").length !== 1 ||
    !isFormatMessageFor(objectProperty(deleteActionObject, "ariaLabel")?.value, "deleteThread") ||
    objectProperties(deleteActionObject, "icon").length !== 1 ||
    !isOfficialTrashIcon(objectProperty(deleteActionObject, "icon")?.value) ||
    objectProperties(deleteActionObject, "label").length !== 0
  ) throw new Error("sidebar normal delete action must use the official icon and accessible label");
  const confirmActionObject = actionObjects.get("thread-delete-confirm-action")[0];
  if (
    objectProperties(confirmActionObject, "ariaLabel").length !== 1 ||
    !isFormatMessageFor(
      objectProperty(confirmActionObject, "ariaLabel")?.value,
      "deleteThreadConfirmAction",
    ) ||
    objectProperties(confirmActionObject, "label").length !== 1 ||
    !isFormatMessageFor(
      objectProperty(confirmActionObject, "label")?.value,
      "deleteThreadConfirmAction",
    ) ||
    objectProperties(confirmActionObject, "icon").length !== 0
  ) throw new Error("sidebar confirm delete action must keep its accessible confirmation label");
  let spreadIntoRenderedActions = 0;
  walk(hoverFunction, (node) => {
    if (
      node.type === "Property" &&
      propertyName(node) === "actions" &&
      node.value?.type === "ArrayExpression" &&
      node.value.elements.some(
        (element) =>
          element?.type === "SpreadElement" &&
          element.argument?.type === "Identifier" &&
          element.argument.name === "CodexSidebarDeleteActions",
      )
    ) spreadIntoRenderedActions += 1;
  });
  if (spreadIntoRenderedActions !== 1) {
    throw new Error("sidebar hover delete actions are not attached to the rendered action list");
  }

  const rowFunctions = functions.filter(
    (fn) => fn.body.start < rowComments[0].start && fn.body.end > rowComments[0].end,
  );
  if (rowFunctions.length !== 1 || rowComments[0].start !== rowFunctions[0].body.start + 1) {
    throw new Error("sidebar row marker is detached");
  }
  const rowFunction = rowFunctions[0];
  let deleteThreadBinding = 0;
  let stateBinding = 0;
  const rowDeclarations = new Map();
  const deleteMenuItems = [];
  const deleteActionProps = [];
  const hoverCounts = [];
  const hoverCountObjects = [];
  walk(rowFunction, (node) => {
    if (node.type === "ObjectPattern" && patternBinding(node, "deleteThread") === "CodexDeleteThread") {
      deleteThreadBinding += 1;
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ArrayPattern" &&
      node.id.elements[0]?.name === "CodexDeleteConfirm" &&
      node.id.elements[1]?.name === "CodexSetDeleteConfirm"
    ) stateBinding += 1;
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      rowDeclarations.set(node.id.name, node.init);
    }
    if (node.type === "ObjectExpression") {
      if (literalValue(objectProperty(node, "id")?.value) === "delete-thread") deleteMenuItems.push(node);
      const deleteAction = objectProperty(node, "deleteAction");
      if (deleteAction) deleteActionProps.push(deleteAction.value);
      const hoverCount = objectProperty(node, "additionalHoverActionCount");
      if (hoverCount) {
        hoverCounts.push(hoverCount.value);
        hoverCountObjects.push(node);
      }
    }
  });
  const requestDelete = rowDeclarations.get("CodexRequestDelete");
  const confirmDelete = rowDeclarations.get("CodexConfirmDelete");
  if (
    deleteThreadBinding !== 1 ||
    stateBinding !== 1 ||
    !requestDelete ||
    !confirmDelete ||
    deleteMenuItems.length !== 1 ||
    deleteActionProps.length !== 1 ||
    hoverCounts.length !== 1 ||
    hoverCountObjects.length !== 1
  ) throw new Error("sidebar row delete state/action wiring is incomplete");
  const menuOnSelect = objectProperty(deleteMenuItems[0], "onSelect")?.value;
  if (menuOnSelect?.type !== "Identifier" || menuOnSelect.name !== "CodexRequestDelete") {
    throw new Error("sidebar row delete menu item is detached");
  }
  const deleteAction = deleteActionProps[0];
  const expectedDeleteActionBindings = new Map([
    ["confirming", "CodexDeleteConfirm"],
    ["onRequest", "CodexRequestDelete"],
    ["onConfirm", "CodexConfirmDelete"],
  ]);
  if (
    deleteAction?.type !== "ObjectExpression" ||
    [...expectedDeleteActionBindings].some(([name, binding]) => {
      const value = objectProperty(deleteAction, name)?.value;
      return value?.type !== "Identifier" || value.name !== binding;
    })
  ) throw new Error("sidebar row deleteAction prop is malformed");
  if (
    hoverCounts[0]?.type !== "BinaryExpression" ||
    hoverCounts[0].operator !== "+" ||
    literalValue(hoverCounts[0].right) !== 1
  ) throw new Error("sidebar row additional hover action count is not incremented");
  const taskRowProps = hoverCountObjects[0];
  const topLevelMouseLeaves = objectProperties(taskRowProps, "onMouseLeave");
  const dataAttributesProps = objectProperties(taskRowProps, "dataAttributes");
  const dataAttributes = dataAttributesProps[0]?.value;
  const dataAttributeMouseLeaves = objectProperties(dataAttributes, "onMouseLeave");
  if (
    topLevelMouseLeaves.length !== 0 ||
    dataAttributesProps.length !== 1 ||
    dataAttributes?.type !== "ObjectExpression" ||
    dataAttributeMouseLeaves.length !== 1 ||
    !isDeleteConfirmResetHandler(code, dataAttributeMouseLeaves[0].value)
  ) throw new Error("sidebar row mouseleave reset must be attached through dataAttributes");
  const rowSpreadNames = identifierSpreadNames(taskRowProps);
  if (rowSpreadNames.length > 1) {
    throw new Error("sidebar row dataAttributes spread source is ambiguous");
  }
  if (rowSpreadNames.length === 1) {
    const nestedSpreads = dataAttributes.properties.filter(
      (property) => property?.type === "SpreadElement",
    );
    const preserved = nestedSpreads[0]?.argument;
    if (
      nestedSpreads.length !== 1 ||
      preserved?.type !== "LogicalExpression" ||
      preserved.operator !== "??" ||
      preserved.left?.type !== "MemberExpression" ||
      preserved.left.computed ||
      preserved.left.object?.type !== "Identifier" ||
      preserved.left.object.name !== rowSpreadNames[0] ||
      preserved.left.property?.name !== "dataAttributes" ||
      preserved.right?.type !== "ObjectExpression" ||
      preserved.right.properties.length !== 0
    ) throw new Error("sidebar row existing dataAttributes are not preserved");
  }
  const confirmCalls = callToIdentifier(confirmDelete, "CodexDeleteThread", (call) =>
    call.arguments[0]?.type === "ObjectExpression" &&
    ["conversationId", "hostId"].every((name) => objectProperty(call.arguments[0], name)),
  );
  if (
    callToIdentifier(requestDelete, "CodexSetDeleteConfirm", (call) => sourceFor(code, call.arguments[0]) === "!0").length !== 1 ||
    callToIdentifier(confirmDelete, "CodexSetDeleteConfirm", (call) => sourceFor(code, call.arguments[0]) === "!1").length !== 1 ||
    confirmCalls.length !== 1
  ) throw new Error("sidebar row request/confirm/reset handlers are not wired");
  return { status: "already" };
}

function migrateSidebarDeleteIcon(code) {
  const { ast } = parseSidebarDocument(code, "sidebar icon migration");
  const functions = [];
  const deleteActionObjects = [];
  walk(ast, (node) => {
    if (node.type === "FunctionDeclaration") functions.push(node);
    if (
      node.type === "ObjectExpression" &&
      literalValue(objectProperty(node, "id")?.value) === "thread-delete-action"
    ) deleteActionObjects.push(node);
  });
  if (deleteActionObjects.length !== 1) {
    throw new Error(
      `sidebar icon migration expected exactly 1 normal delete action, found ${deleteActionObjects.length}`,
    );
  }
  const actionObject = deleteActionObjects[0];
  const labels = objectProperties(actionObject, "label");
  const icons = objectProperties(actionObject, "icon");
  if (
    !(
      (labels.length === 1 && icons.length === 0) ||
      (labels.length === 0 && icons.length === 1)
    )
  ) {
    throw new Error("sidebar icon migration found a malformed text/icon action state");
  }
  if (labels.length === 1 && !isFormatMessageFor(labels[0].value, "deleteThread")) {
    throw new Error("sidebar icon migration found an unexpected delete label binding");
  }
  const owners = functionContaining(functions, actionObject);
  if (owners.length !== 1) throw new Error("sidebar icon migration action owner is ambiguous");
  const renderAliases = [];
  walk(owners[0], (node) => {
    const alias = sequenceMemberAlias(node, "jsx");
    if (!alias || node.arguments[1]?.type !== "ObjectExpression") return;
    const actions = objectProperty(node.arguments[1], "actions")?.value;
    if (
      actions?.type === "ArrayExpression" &&
      actions.elements.some(
        (element) =>
          element?.type === "SpreadElement" &&
          element.argument?.type === "Identifier" &&
          element.argument.name === "CodexSidebarDeleteActions",
      )
    ) renderAliases.push(alias);
  });
  const uniqueAliases = [...new Set(renderAliases)];
  if (uniqueAliases.length !== 1) {
    throw new Error(
      `sidebar icon migration expected exactly 1 JSX runtime alias, found ${uniqueAliases.length}`,
    );
  }
  const replacements = [];
  if (labels.length === 1) {
    replacements.push({
      start: labels[0].start,
      end: labels[0].end,
      text: `icon:${trashIconSource(uniqueAliases[0])}`,
    });
  } else {
    const icon = icons[0].value;
    if (!isOfficialTrashIcon(icon, false)) {
      throw new Error("sidebar icon migration found an unexpected delete icon");
    }
    const iconProps = icon.arguments[1];
    const colorClasses = objectProperties(iconProps, "className");
    if (colorClasses.length > 1) {
      throw new Error("sidebar icon migration found duplicate SVG color classes");
    }
    if (colorClasses.length === 1) {
      if (literalValue(colorClasses[0].value) !== "text-token-error-foreground") {
        throw new Error("sidebar icon migration found an unexpected SVG color class");
      }
    } else {
      replacements.push({
        start: iconProps.end - 1,
        end: iconProps.end - 1,
        text: ",className:`text-token-error-foreground`",
      });
    }
  }
  return {
    code: applySourceReplacements(code, replacements),
    changed: replacements.length > 0,
  };
}

function migrateSidebarMouseLeave(code) {
  const { ast, comments } = parseSidebarDocument(code, "sidebar mouseleave migration");
  const rowComments = exactSidebarComments(comments, "CodexSidebarDeleteRow");
  const functions = [];
  walk(ast, (node) => {
    if (node.type === "FunctionDeclaration") functions.push(node);
  });
  if (rowComments.length !== 1) {
    throw new Error("sidebar mouseleave migration row marker is malformed");
  }
  const rowFunctions = functions.filter(
    (fn) => fn.body.start < rowComments[0].start && fn.body.end > rowComments[0].end,
  );
  if (rowFunctions.length !== 1) {
    throw new Error("sidebar mouseleave migration row owner is ambiguous");
  }
  const taskRowProps = [];
  walk(rowFunctions[0], (node) => {
    if (
      node.type === "ObjectExpression" &&
      objectProperty(node, "additionalHoverActionCount")
    ) taskRowProps.push(node);
  });
  if (taskRowProps.length !== 1) {
    throw new Error(
      `sidebar mouseleave migration expected exactly 1 task row, found ${taskRowProps.length}`,
    );
  }
  const props = taskRowProps[0];
  const topLevelMouseLeaves = objectProperties(props, "onMouseLeave");
  const dataAttributes = objectProperties(props, "dataAttributes");
  if (topLevelMouseLeaves.length === 0 && dataAttributes.length === 1) {
    return { code, changed: false };
  }
  if (
    topLevelMouseLeaves.length !== 1 ||
    dataAttributes.length !== 0 ||
    !isDeleteConfirmResetHandler(code, topLevelMouseLeaves[0].value)
  ) {
    throw new Error("sidebar mouseleave migration found a malformed reset contract");
  }
  return {
    code: applySourceReplacements(code, [{
      start: topLevelMouseLeaves[0].start,
      end: topLevelMouseLeaves[0].end,
      text: `dataAttributes:${resetDataAttributesSource(code, props)}`,
    }]),
    changed: true,
  };
}

function patchSidebarSource(code) {
  const hoverMarker = "/* CodexSidebarDeleteHover */";
  const rowMarker = "/* CodexSidebarDeleteRow */";
  const hoverCount = countOccurrences(code, hoverMarker);
  const rowCount = countOccurrences(code, rowMarker);
  if (hoverCount > 0 || rowCount > 0) {
    const iconMigration = migrateSidebarDeleteIcon(code);
    const mouseLeaveMigration = migrateSidebarMouseLeave(iconMigration.code);
    const changed = iconMigration.changed || mouseLeaveMigration.changed;
    inspectSidebarPostcondition(mouseLeaveMigration.code);
    return {
      code: mouseLeaveMigration.code,
      status: changed ? "patched" : "already",
      counts: {
        hover: sidebarCount(iconMigration.changed ? 1 : 0, iconMigration.changed ? 0 : 1, "sidebar hover"),
        row: sidebarCount(mouseLeaveMigration.changed ? 1 : 0, mouseLeaveMigration.changed ? 0 : 1, "sidebar row"),
      },
    };
  }

  const ast = parseRequired(code, "sidebar UI");
  const hoverFunctions = [];
  const broadRowFunctions = [];
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration") return;
    const source = sourceFor(code, node);
    if (source.includes("thread-primary-action") && source.includes(".archiveThread")) {
      hoverFunctions.push(node);
    }
    if (source.includes("archive-thread") && source.includes("additionalHoverActionCount")) {
      broadRowFunctions.push(node);
    }
  });
  if (hoverFunctions.length !== 1) {
    throw new Error(`sidebar hover expected exactly 1 target, found ${hoverFunctions.length}`);
  }
  const hoverFunction = hoverFunctions[0];
  const rowFunctions = broadRowFunctions.filter((rowFunction) => {
    let rendersHover = false;
    let hasArchiveActionBinding = false;
    walk(rowFunction, (node) => {
      if (
        sequenceMemberAlias(node, "jsx") &&
        node.arguments[0]?.type === "Identifier" &&
        node.arguments[0].name === hoverFunction.id.name
      ) rendersHover = true;
      if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && node.init) {
        const names = node.id.properties.map(propertyName);
        if (names.includes("archiveThread")) hasArchiveActionBinding = true;
      }
    });
    return rendersHover && hasArchiveActionBinding;
  });
  if (rowFunctions.length !== 1) {
    throw new Error(`sidebar row expected exactly 1 target, found ${rowFunctions.length}`);
  }

  const hover = analyzeHoverFunction(code, hoverFunction);
  const rowFunction = rowFunctions[0];
  const row = analyzeRowFunction(code, rowFunction, hoverFunction.id.name);
  const renderComponent = sourceFor(code, hover.render.call.arguments[0]);
  const className = sourceFor(code, hover.render.className);
  const deleteActions =
    `${hoverMarker}let CodexSidebarDeleteActions=CodexDeleteAction==null?[]:CodexDeleteAction.confirming?` +
    `[{id:\`thread-delete-confirm-action\`,ariaLabel:${hover.intl}.formatMessage(${hover.messages}.deleteThreadConfirmAction),label:${hover.intl}.formatMessage(${hover.messages}.deleteThreadConfirmAction),buttonClassName:\`text-token-error-foreground hover:text-token-error-foreground\`,onClick:CodexDeleteAction.onConfirm}]:` +
    `[{id:\`thread-delete-action\`,ariaLabel:${hover.intl}.formatMessage(${hover.messages}.deleteThread),icon:${trashIconSource(hover.render.jsxAlias)},buttonClassName:\`text-token-error-foreground hover:text-token-error-foreground\`,onClick:CodexDeleteAction.onRequest}];` +
    `return(0,${hover.render.jsxAlias}.jsx)(${renderComponent},{actions:[...${hover.spreadNames[0]},...${hover.spreadNames[1]},...CodexSidebarDeleteActions],className:${className}})`;
  const stateInit = sourceFor(code, row.stateDeclaration.init);
  const handlers =
    `,CodexRequestDelete=()=>{CodexSetDeleteConfirm(!0)},CodexConfirmDelete=()=>{CodexSetDeleteConfirm(!1),` +
    `CodexDeleteThread({conversationId:${row.conversationId},hostId:${row.hostId},onDeleteSuccess:${row.success},onDeleteError:${row.error}})}`;
  const renderObject = row.hoverRender.arguments[1];
  const countValue = sourceFor(code, row.hoverCount.property.value);
  const existingDataAttributes = objectProperties(row.hoverCount.object, "dataAttributes");
  if (existingDataAttributes.length > 1) {
    throw new Error("sidebar row has duplicate dataAttributes props");
  }
  const resetDataAttributes = resetDataAttributesSource(code, row.hoverCount.object);
  const replacements = [
    { start: hover.pattern.end - 1, end: hover.pattern.end - 1, text: ",deleteAction:CodexDeleteAction" },
    {
      start: hover.nullTest.start,
      end: hover.nullTest.end,
      text: `(${sourceFor(code, hover.nullTest)})&&CodexDeleteAction==null`,
    },
    { start: hover.tailStart, end: hover.tailEnd, text: deleteActions },
    { start: rowFunction.body.start + 1, end: rowFunction.body.start + 1, text: rowMarker },
    { start: row.hookPattern.end - 1, end: row.hookPattern.end - 1, text: ",deleteThread:CodexDeleteThread" },
    {
      start: row.stateDeclaration.end,
      end: row.stateDeclaration.end,
      text: `,[CodexDeleteConfirm,CodexSetDeleteConfirm]=${stateInit}`,
    },
    { start: row.handler.end, end: row.handler.end, text: handlers },
    {
      start: row.archiveItem.end,
      end: row.archiveItem.end,
      text: `,{id:\`delete-thread\`,message:${row.messageObject}.deleteThread,onSelect:CodexRequestDelete}`,
    },
    {
      start: renderObject.end - 1,
      end: renderObject.end - 1,
      text: ",deleteAction:{confirming:CodexDeleteConfirm,onRequest:CodexRequestDelete,onConfirm:CodexConfirmDelete}",
    },
    {
      start: row.callbackDependencies.end - 1,
      end: row.callbackDependencies.end - 1,
      text: ",CodexDeleteConfirm,CodexRequestDelete,CodexConfirmDelete",
    },
    {
      start: row.hoverCount.property.value.start,
      end: row.hoverCount.property.value.end,
      text: `(${countValue})+1`,
    },
    existingDataAttributes.length === 1
      ? {
        start: existingDataAttributes[0].value.start,
        end: existingDataAttributes[0].value.end,
        text: resetDataAttributes,
      }
      : {
        start: row.hoverCount.object.end - 1,
        end: row.hoverCount.object.end - 1,
        text: `,dataAttributes:${resetDataAttributes}`,
      },
  ];
  const next = applySourceReplacements(code, replacements);
  inspectSidebarPostcondition(next);
  return {
    code: next,
    status: "patched",
    counts: {
      hover: sidebarCount(1, 0, "sidebar hover"),
      row: sidebarCount(1, 0, "sidebar row"),
    },
  };
}

function patchSidebarContracts({ threadActionsSource, sidebarSource }) {
  if (typeof threadActionsSource !== "string") throw new Error("sidebar thread-actions source is required");
  if (typeof sidebarSource !== "string") throw new Error("sidebar source is required");
  const threadActions = patchThreadActionsSource(threadActionsSource);
  const sidebar = patchSidebarSource(sidebarSource);
  return {
    status: threadActions.status === "already" && sidebar.status === "already" ? "already" : "patched",
    threadActions,
    sidebar,
  };
}

function inspectThreadActionsLayer(code) {
  const hasPatchEvidence =
    countOccurrences(code, "id:`sidebarElectron.deleteThread`") > 0 ||
    countOccurrences(code, "/* CodexSidebarDeleteAction */") > 0 ||
    countOccurrences(code, "deleteThread:CodexSidebarDeleteAction") > 0;
  if (hasPatchEvidence) {
    patchThreadActionsSource(code);
    return { state: "recognized" };
  }
  const ast = parseRequired(code, "sidebar thread-actions");
  const archiveMessages = [];
  const actionFunctions = [];
  let recognizedEvidence = false;
  walk(ast, (node) => {
    if (
      (node.type === "Identifier" && node.name === "archiveThread") ||
      literalValue(node) === "archive-conversation" ||
      literalValue(node) === "sidebarElectron.archiveThread"
    ) recognizedEvidence = true;
    if (node.type === "Property" && propertyName(node) === "archiveThread") {
      const idProperty = node.value?.type === "ObjectExpression"
        ? node.value.properties.find((property) => propertyName(property) === "id")
        : null;
      if (literalValue(idProperty?.value) === "sidebarElectron.archiveThread") archiveMessages.push(node);
    }
    if (node.type === "FunctionDeclaration") {
      const source = sourceFor(code, node);
      if (source.includes("archive-conversation") && source.includes("copyConversationMarkdown")) {
        actionFunctions.push(node);
      }
    }
  });
  if (archiveMessages.length === 0 && actionFunctions.length === 0 && !recognizedEvidence) {
    return { state: "absent" };
  }
  patchThreadActionsSource(code);
  return { state: "recognized" };
}

function inspectSidebarLayer(code) {
  const hasPatchEvidence =
    countOccurrences(code, "/* CodexSidebarDeleteHover */") > 0 ||
    countOccurrences(code, "/* CodexSidebarDeleteRow */") > 0;
  if (hasPatchEvidence) {
    patchSidebarSource(code);
    return { state: "recognized" };
  }
  const ast = parseRequired(code, "sidebar UI");
  const hoverFunctions = [];
  const rowFunctions = [];
  let recognizedEvidence = false;
  walk(ast, (node) => {
    if (
      literalValue(node) === "archive-thread" ||
      (node.type === "Property" && propertyName(node) === "additionalHoverActionCount")
    ) recognizedEvidence = true;
    if (node.type !== "FunctionDeclaration") return;
    const source = sourceFor(code, node);
    if (source.includes("thread-primary-action") && source.includes(".archiveThread")) {
      hoverFunctions.push(node);
    }
    if (source.includes("archive-thread") && source.includes("additionalHoverActionCount")) {
      rowFunctions.push(node);
    }
  });
  if (hoverFunctions.length === 0 && rowFunctions.length === 0 && !recognizedEvidence) {
    return { state: "absent" };
  }
  patchSidebarSource(code);
  return { state: "recognized" };
}

function findExactSidebarAsset(platform, pattern, label) {
  const directory = path.join(SRC_DIR, platform, "_asar", "webview", "assets");
  if (!fs.existsSync(directory)) throw new Error(`${label} directory is missing for ${platform}`);
  const matches = fs.readdirSync(directory).filter((fileName) => pattern.test(fileName));
  if (matches.length !== 1) {
    throw new Error(`${label} expected exactly 1 bundle for ${platform}, found ${matches.length}`);
  }
  return path.join(directory, matches[0]);
}

function normalizeSidebarCandidate(candidate) {
  return {
    path: candidate.filePath ?? candidate.path ?? candidate.fileName,
    fileName:
      candidate.fileName ?? path.basename(candidate.filePath ?? candidate.path ?? ""),
    source: candidate.source,
  };
}

function isSidebarWebviewAsset(candidate) {
  const normalizedPath = candidate.path.replaceAll("\\", "/");
  const inAssets =
    normalizedPath.startsWith("webview/assets/") ||
    normalizedPath.includes("/webview/assets/");
  return inAssets && candidate.fileName.endsWith(".js");
}

function topLevelSidebarFunctions(ast) {
  return ast.body.flatMap((statement) => {
    if (statement.type === "FunctionDeclaration") return [statement];
    if (
      (statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportDefaultDeclaration") &&
      statement.declaration?.type === "FunctionDeclaration"
    ) {
      return [statement.declaration];
    }
    return [];
  });
}

function threadActionsOwnershipEvidence(code) {
  let ast;
  try {
    ast = parseRequired(code, "sidebar thread-actions ownership");
  } catch {
    return [];
  }
  let archiveMessageFamilies = 0;
  walk(ast, (node) => {
    if (node.type !== "Property" || propertyName(node) !== "archiveThread") return;
    const id = objectProperty(node.value, "id");
    if (literalValue(id?.value) === "sidebarElectron.archiveThread") {
      archiveMessageFamilies += 1;
    }
  });
  const actionFamilies = topLevelSidebarFunctions(ast).filter((fn) => {
    const directReturns = fn.body.body.filter((node) => node.type === "ReturnStatement");
    if (directReturns.length === 0) return false;
    const returnedObject = returnedObjectExpression(directReturns.at(-1).argument);
    const archiveBinding = objectProperty(returnedObject, "archiveThread")?.value;
    if (archiveBinding?.type !== "Identifier") {
      return false;
    }
    const archiveAction = directFunctionBinding(fn, archiveBinding.name);
    if (!archiveAction) return false;
    let archiveCalls = 0;
    walkOwnExecutableBody(archiveAction.body, (node) => {
      if (
        node.type === "CallExpression" &&
        literalValue(node.arguments[0]) === "archive-conversation"
      ) {
        archiveCalls += 1;
      }
    });
    return archiveCalls > 0;
  });
  return archiveMessageFamilies > 0 && actionFamilies.length > 0
    ? ["associated archive message, bridge call, and returned action family"]
    : [];
}

function probeSidebarThreadActions(candidate) {
  if (
    !candidate.source.includes("sidebarElectron.archiveThread") ||
    !candidate.source.includes("archive-conversation")
  ) {
    return { state: "irrelevant", evidence: [] };
  }
  const evidence = threadActionsOwnershipEvidence(candidate.source);
  if (evidence.length === 0) return { state: "irrelevant", evidence: [] };
  try {
    return {
      state: "exact",
      evidence: ["strict sidebar thread-actions helper satisfied"],
      result: patchThreadActionsSource(candidate.source),
    };
  } catch (error) {
    return evidence.length > 0
      ? { state: "owned-malformed", evidence, error }
      : { state: "irrelevant", evidence: [] };
  }
}

function sidebarUiOwnershipEvidence(code) {
  let ast;
  try {
    ast = parseRequired(code, "sidebar UI ownership");
  } catch {
    return [];
  }
  const functions = topLevelSidebarFunctions(ast);
  const hoverFunctions = functions.filter((fn) => {
    if (fn.body.body.some((statement) => statement.type === "FunctionDeclaration")) {
      return false;
    }
    const source = sourceFor(code, fn);
    return source.includes("thread-primary-action") && source.includes(".archiveThread");
  });
  const associatedPairs = [];
  for (const hover of hoverFunctions) {
    for (const row of functions) {
      if (row.body.body.some((statement) => statement.type === "FunctionDeclaration")) {
        continue;
      }
      const source = sourceFor(code, row);
      if (!source.includes("archive-thread")) {
        continue;
      }
      let rendersHover = false;
      let hasArchiveActionBinding = false;
      walk(row, (node) => {
        if (
          sequenceMemberAlias(node, "jsx") &&
          node.arguments[0]?.type === "Identifier" &&
          node.arguments[0].name === hover.id?.name
        ) {
          rendersHover = true;
        }
        if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern") {
          const names = node.id.properties.map(propertyName);
          if (names.includes("archiveThread")) hasArchiveActionBinding = true;
        }
      });
      if (rendersHover && hasArchiveActionBinding) {
        associatedPairs.push({ hover, row });
      }
    }
  }
  return associatedPairs.length > 0
    ? ["associated primary action, archive menu, hover-count render family"]
    : [];
}

function probeSidebarUi(candidate) {
  if (
    !candidate.source.includes("thread-primary-action") ||
    !candidate.source.includes("archive-thread")
  ) {
    return { state: "irrelevant", evidence: [] };
  }
  const evidence = sidebarUiOwnershipEvidence(candidate.source);
  if (evidence.length === 0) return { state: "irrelevant", evidence: [] };
  try {
    return {
      state: "exact",
      evidence: ["strict sidebar UI helper satisfied"],
      result: patchSidebarSource(candidate.source),
    };
  } catch (error) {
    return evidence.length > 0
      ? { state: "owned-malformed", evidence, error }
      : { state: "irrelevant", evidence: [] };
  }
}

function buildSidebarPlan({ platform, threadActions, sidebar, result }) {
  return planRequiredRoles({
    platform,
    roles: [
      {
        role: "sidebar-thread-actions",
        candidates: [normalizeSidebarCandidate(threadActions)],
        probe: () => ({
          state: "exact",
          evidence: ["Windows exact filename and strict thread-actions helper"],
          result: result.threadActions,
        }),
      },
      {
        role: "sidebar-ui",
        candidates: [normalizeSidebarCandidate(sidebar)],
        probe: () => ({
          state: "exact",
          evidence: ["Windows exact filename and strict sidebar UI helper"],
          result: result.sidebar,
        }),
      },
    ],
  });
}

function sidebarMatchFromRole(selected) {
  return {
    fileName: selected.candidate.fileName,
    filePath: selected.candidate.path,
    path: selected.candidate.path,
    source: selected.candidate.source,
  };
}

function previewSidebarPlan(plan) {
  const threadRole = plan.roles.find(
    (selected) => selected.role === "sidebar-thread-actions",
  );
  const sidebarRole = plan.roles.find((selected) => selected.role === "sidebar-ui");
  const threadActions = sidebarMatchFromRole(threadRole);
  const sidebar = sidebarMatchFromRole(sidebarRole);
  return {
    threadActions,
    sidebar,
    matches: { threadActions: [threadActions], sidebar: [sidebar] },
    result: patchSidebarContracts({
      threadActionsSource: threadActions.source,
      sidebarSource: sidebar.source,
    }),
  };
}

function planMacSidebarPlatform({ platform, candidates }) {
  const scoped = candidates
    .map(normalizeSidebarCandidate)
    .filter(isSidebarWebviewAsset);
  const plan = planRequiredRoles({
    platform,
    roles: [
      {
        role: "sidebar-thread-actions",
        candidates: scoped,
        probe: probeSidebarThreadActions,
      },
      { role: "sidebar-ui", candidates: scoped, probe: probeSidebarUi },
    ],
  });
  return { status: "ready", plan, writes: [previewSidebarPlan(plan)] };
}

function planSidebarPlatform({
  platform,
  threadActionTargets,
  sidebarTargets,
  candidates,
}) {
  if (platform !== "win") {
    return planMacSidebarPlatform({ platform, candidates: candidates ?? [] });
  }
  if (threadActionTargets.length !== 1) {
    throw new Error(
      `sidebar thread-actions expected exactly 1 bundle for ${platform}, found ${threadActionTargets.length}`,
    );
  }
  if (sidebarTargets.length !== 1) {
    throw new Error(
      `sidebar flat-sections expected exactly 1 bundle for ${platform}, found ${sidebarTargets.length}`,
    );
  }
  const threadActions = threadActionTargets[0];
  const sidebar = sidebarTargets[0];
  const result = patchSidebarContracts({
    threadActionsSource: threadActions.source,
    sidebarSource: sidebar.source,
  });
  const plan = buildSidebarPlan({ platform, threadActions, sidebar, result });
  return {
    status: "ready",
    plan,
    writes: [{ threadActions, sidebar, result }],
  };
}

function selectedSidebarWrite(selected) {
  return {
    role: selected.role,
    path: selected.candidate.path,
    fileName: selected.candidate.fileName,
    source: selected.candidate.source,
    result: selected.result,
  };
}

function commitSidebarPlatforms({
  platformPlans,
  isCheck = false,
  writeFile = fs.writeFileSync,
}) {
  return platformPlans.flatMap(({ plan }) =>
    commitValidatedPlan({
      plan,
      writer: (selected) => {
        const write = selectedSidebarWrite(selected);
        if (!isCheck && write.result.code !== write.source) {
          writeFile(write.path, write.result.code, "utf-8");
        }
        return write;
      },
    }),
  );
}

function executeSidebarPlatforms({
  platformInputs,
  isCheck = false,
  writeFile = fs.writeFileSync,
}) {
  const platformPlans = platformInputs.map((input) => ({
    platform: input.platform,
    ...planSidebarPlatform(input),
  }));
  const writes = commitSidebarPlatforms({ platformPlans, isCheck, writeFile });
  return { platformPlans, writes };
}

function formatSidebarSummary(outcomes) {
  const ready = outcomes.filter((outcome) => outcome.status === "ready").map((outcome) => outcome.platform);
  const skipped = outcomes.filter((outcome) => outcome.status === "skipped").map((outcome) => outcome.platform);
  return `[summary] sidebar-delete: ready=[${ready.join(",")}] skipped=[${skipped.join(",")}]`;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win"].includes(arg));
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((name) =>
        fs.existsSync(path.join(SRC_DIR, name, "_asar")),
      );
  if (platforms.length === 0) throw new Error("sidebar-delete expected at least one platform");
  const platformInputs = platforms.map((platformName) => {
    if (platformName === "win") {
      const threadActionsPath = findExactSidebarAsset(
        platformName,
        /^thread-actions-.*\.js$/,
        "sidebar thread-actions",
      );
      const sidebarPath = findExactSidebarAsset(
        platformName,
        /^sidebar-flat-sections-.*\.js$/,
        "sidebar-flat-sections",
      );
      return {
        platform: platformName,
        threadActionTargets: [{
          fileName: path.basename(threadActionsPath),
          path: threadActionsPath,
          source: fs.readFileSync(threadActionsPath, "utf-8"),
        }],
        sidebarTargets: [{
          fileName: path.basename(sidebarPath),
          path: sidebarPath,
          source: fs.readFileSync(sidebarPath, "utf-8"),
        }],
      };
    }
    const directory = path.join(SRC_DIR, platformName, "_asar", "webview", "assets");
    if (!fs.existsSync(directory)) {
      throw new Error(`sidebar asset directory is missing for ${platformName}`);
    }
    return {
      platform: platformName,
      candidates: fs.readdirSync(directory)
        .filter((fileName) => fileName.endsWith(".js"))
        .map((fileName) => {
          const filePath = path.join(directory, fileName);
          return { fileName, filePath, source: fs.readFileSync(filePath, "utf-8") };
        }),
    };
  });
  const execution = executeSidebarPlatforms({ platformInputs, isCheck });
  const outcomes = execution.platformPlans.map(({ platform: name, status }) => ({
    platform: name,
    status,
  }));
  for (const platformPlan of execution.platformPlans) {
    const preview = platformPlan.writes[0];
    console.log(
      `  [${platformPlan.platform}] ${isCheck ? "check" : preview.result.status}: thread=${JSON.stringify(preview.result.threadActions.counts)} sidebar=${JSON.stringify(preview.result.sidebar.counts)}`,
    );
  }
  console.log(formatSidebarSummary(outcomes));
}

if (require.main === module) main();

module.exports = {
  inspectThreadActionsPostcondition,
  inspectSidebarPostcondition,
  patchThreadActionsSource,
  patchSidebarSource,
  patchSidebarContracts,
  planSidebarPlatform,
  executeSidebarPlatforms,
  formatSidebarSummary,
};

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
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

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
  const actionObjects = new Map();
  walk(hoverDeclaration.declaration.init, (node) => {
    if (node.type !== "ObjectExpression") return;
    const id = literalValue(objectProperty(node, "id")?.value);
    if (expectedActions.has(id)) actionObjects.set(id, node);
  });
  if (deleteActionBindings.length !== 1 || actionObjects.size !== expectedActions.size) {
    throw new Error("sidebar hover action wiring is incomplete");
  }
  for (const [id, method] of expectedActions) {
    const onClick = objectProperty(actionObjects.get(id), "onClick")?.value;
    if (
      onClick?.type !== "MemberExpression" ||
      onClick.object?.type !== "Identifier" ||
      onClick.object.name !== "CodexDeleteAction" ||
      onClick.property?.name !== method
    ) throw new Error(`sidebar hover ${id} handler is detached`);
  }
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
  const mouseLeaves = [];
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
      if (hoverCount) hoverCounts.push(hoverCount.value);
      const mouseLeave = objectProperty(node, "onMouseLeave");
      if (mouseLeave) mouseLeaves.push(mouseLeave.value);
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
    mouseLeaves.length !== 1
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
  const confirmCalls = callToIdentifier(confirmDelete, "CodexDeleteThread", (call) =>
    call.arguments[0]?.type === "ObjectExpression" &&
    ["conversationId", "hostId"].every((name) => objectProperty(call.arguments[0], name)),
  );
  if (
    callToIdentifier(requestDelete, "CodexSetDeleteConfirm", (call) => sourceFor(code, call.arguments[0]) === "!0").length !== 1 ||
    callToIdentifier(confirmDelete, "CodexSetDeleteConfirm", (call) => sourceFor(code, call.arguments[0]) === "!1").length !== 1 ||
    confirmCalls.length !== 1 ||
    callToIdentifier(mouseLeaves[0], "CodexSetDeleteConfirm", (call) => sourceFor(code, call.arguments[0]) === "!1").length !== 1
  ) throw new Error("sidebar row request/confirm/reset handlers are not wired");
  return { status: "already" };
}

function patchSidebarSource(code) {
  const hoverMarker = "/* CodexSidebarDeleteHover */";
  const rowMarker = "/* CodexSidebarDeleteRow */";
  const hoverCount = countOccurrences(code, hoverMarker);
  const rowCount = countOccurrences(code, rowMarker);
  if (hoverCount > 0 || rowCount > 0) {
    inspectSidebarPostcondition(code);
    return {
      code,
      status: "already",
      counts: {
        hover: sidebarCount(0, 1, "sidebar hover"),
        row: sidebarCount(0, 1, "sidebar row"),
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
    `[{id:\`thread-delete-action\`,ariaLabel:${hover.intl}.formatMessage(${hover.messages}.deleteThread),label:${hover.intl}.formatMessage(${hover.messages}.deleteThread),buttonClassName:\`text-token-error-foreground hover:text-token-error-foreground\`,onClick:CodexDeleteAction.onRequest}];` +
    `return(0,${hover.render.jsxAlias}.jsx)(${renderComponent},{actions:[...${hover.spreadNames[0]},...${hover.spreadNames[1]},...CodexSidebarDeleteActions],className:${className}})`;
  const stateInit = sourceFor(code, row.stateDeclaration.init);
  const handlers =
    `,CodexRequestDelete=()=>{CodexSetDeleteConfirm(!0)},CodexConfirmDelete=()=>{CodexSetDeleteConfirm(!1),` +
    `CodexDeleteThread({conversationId:${row.conversationId},hostId:${row.hostId},onDeleteSuccess:${row.success},onDeleteError:${row.error}})}`;
  const renderObject = row.hoverRender.arguments[1];
  const countValue = sourceFor(code, row.hoverCount.property.value);
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
    {
      start: row.hoverCount.object.end - 1,
      end: row.hoverCount.object.end - 1,
      text: ",onMouseLeave:()=>CodexSetDeleteConfirm(!1)",
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

function findExactSidebarAsset(platform, pattern, label) {
  const directory = path.join(SRC_DIR, platform, "_asar", "webview", "assets");
  if (!fs.existsSync(directory)) throw new Error(`${label} directory is missing for ${platform}`);
  const matches = fs.readdirSync(directory).filter((fileName) => pattern.test(fileName));
  if (matches.length !== 1) {
    throw new Error(`${label} expected exactly 1 bundle for ${platform}, found ${matches.length}`);
  }
  return path.join(directory, matches[0]);
}

function planSidebarPlatform({
  platform,
  threadActionTargets,
  sidebarTargets,
  warn = console.warn,
}) {
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
  const hasThreadActionsLayer =
    /archiveThread|sidebarElectron\.archiveThread|archive-conversation|CodexSidebarDeleteAction/.test(
      threadActions.source,
    );
  if (platform.startsWith("mac-") && !hasThreadActionsLayer) {
    warn(`[skip] sidebar-delete: unsupported target layout on ${platform}`);
    return { status: "skipped", writes: [] };
  }
  const result = patchSidebarContracts({
    threadActionsSource: threadActions.source,
    sidebarSource: sidebar.source,
  });
  return {
    status: "ready",
    writes: [{ threadActions, sidebar, result }],
  };
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
  const plans = platforms.flatMap((platformName) => {
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
    const threadActionsSource = fs.readFileSync(threadActionsPath, "utf-8");
    const sidebarSource = fs.readFileSync(sidebarPath, "utf-8");
    const platformPlan = planSidebarPlatform({
      platform: platformName,
      threadActionTargets: [{ fileName: path.basename(threadActionsPath), path: threadActionsPath, source: threadActionsSource }],
      sidebarTargets: [{ fileName: path.basename(sidebarPath), path: sidebarPath, source: sidebarSource }],
    });
    return platformPlan.writes.map(({ threadActions, sidebar, result }) => ({
      platform: platformName,
      threadActionsPath: threadActions.path,
      sidebarPath: sidebar.path,
      threadActionsSource: threadActions.source,
      sidebarSource: sidebar.source,
      result,
    }));
  });
  for (const plan of plans) {
    console.log(`  [${plan.platform}] ${isCheck ? "check" : plan.result.status}: thread=${JSON.stringify(plan.result.threadActions.counts)} sidebar=${JSON.stringify(plan.result.sidebar.counts)}`);
  }
  if (!isCheck) {
    for (const plan of plans) {
      if (plan.result.threadActions.code !== plan.threadActionsSource) {
        fs.writeFileSync(plan.threadActionsPath, plan.result.threadActions.code, "utf-8");
      }
      if (plan.result.sidebar.code !== plan.sidebarSource) {
        fs.writeFileSync(plan.sidebarPath, plan.result.sidebar.code, "utf-8");
      }
    }
  }
  console.log(`  [done] sidebar-delete contracts satisfied for ${plans.length} platform(s)`);
}

if (require.main === module) main();

module.exports = {
  inspectThreadActionsPostcondition,
  inspectSidebarPostcondition,
  patchThreadActionsSource,
  patchSidebarSource,
  patchSidebarContracts,
  planSidebarPlatform,
};

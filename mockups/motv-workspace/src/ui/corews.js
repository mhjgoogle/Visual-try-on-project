// ① 故事核心 与 ② 故事大纲（TASK-122 第 3 步）。
//
// 产品负责人 2026-08-30 的规格，逐字：
//
//   1. 故事核心 —— 「中间工作区只使用一个大型文本编辑器。内容可被 Agent 读取和修改。」
//   2. 故事大纲 —— 「使用一个结构化文本编辑器。用户体验仍然像写普通文本。系统需要识别
//      段落/列表节点，并自动生成稳定 Outline Node ID。Node ID 不要求用户手动维护。」
//
// 所以这两页各自**只有一个编辑器**，没有字段表单、没有二级 Tab。节点 id 在屏幕上
// 只作为**行号旁边的一个淡色标记**出现（结构规划要引用它，他得看得见有这么个东西），
// 但从不要他去填、去改、去对齐。
//
// 版本规则（他的原话）：「日常编辑只维护当前最新版。只有用户主动『定稿/保存版本』时
// 才生成历史版本。默认 UI 只显示当前最新版。历史版本可查看、恢复、手动删除。」
// —— 由 `storywork` 的 `finalize*` 家族承担，这里只画那两个按钮。

import { esc } from "../util/dom.js";
import { head } from "./shell.js";
import * as w from "../workflow/storywork.js";

/** 一页里的定稿条：日常改动不产生版本，这个按钮才产生。 */
export function finalizeBar(kind, count, hint = "") {
  return (
    `<div class="sw-fin">` +
    `<button class="btn" data-fin="${esc(kind)}" title="存一版历史。日常编辑不会产生版本">✓ 定稿 · 存一版</button>` +
    (count
      ? `<button class="btn ghost" data-finhist="${esc(kind)}">历史版本 ${count}</button>`
      : `<span class="meta">还没有历史版本 —— 日常编辑不会产生它</span>`) +
    (hint ? `<span class="meta">${esc(hint)}</span>` : "") +
    `</div>`
  );
}

/** 历史版本列表：可查看、可恢复、可手动删（他逐条点名的三件事）。 */
export function historyList(kind, records) {
  if (!records.length) return "";
  const rows = records
    .slice()
    .reverse()
    .map(
      (r) =>
        `<div class="sw-hrow"><span class="v">v${r.v}</span>` +
        `<span class="at">${esc(r.at || "")}</span>` +
        `<span class="note">${esc(r.note || "")}</span>` +
        `<button class="btn ghost sm" data-finview="${esc(kind)}:${r.v}">查看</button>` +
        `<button class="btn ghost sm" data-finrestore="${esc(kind)}:${r.v}">恢复</button>` +
        `<button class="btn ghost sm danger" data-findel="${esc(kind)}:${r.v}">删除</button></div>`,
    )
    .join("");
  return `<div class="sw-hist">${rows}</div>`;
}

/* --- ① 故事核心 ------------------------------------------------------------ */

/** `ctx.story` 是**门面**（doc() / editBrief() …），文档在 `doc()` 里。
 *  这一层写错过一次：`ctx.story.work` 是 undefined，整页白屏（真浏览器里当场抓到）。 */
export function workOf(story) {
  const doc = story && typeof story.doc === "function" ? story.doc() : story;
  return doc && doc.work ? doc.work : null;
}

export function coreModel(story) {
  const work = workOf(story);
  if (!work) return { text: "", chars: 0, history: [] };
  return {
    text: work.core || "",
    chars: (work.core || "").length,
    history: work.finalized.core,
  };
}

export function renderCoreWs(ctx, ui) {
  const m = coreModel(ctx.story);
  const viewing = ui && ui.coreView ? ui.coreView : null;
  return (
    head("故事核心", "项目级") +
    `<div class="sw-page">` +
    `<div class="sw-note">立意、主角、冲突、世界规则、人物关系 —— 都写在这一篇里。` +
    `右边的 Agent 能读它，也能改它。</div>` +
    (viewing
      ? `<div class="sw-viewing">正在看 v${esc(String(viewing.v))} 的内容（只读）` +
        `<button class="btn ghost sm" data-finclose="core">回到最新版</button></div>` +
        `<pre class="sw-editor read">${esc(viewing.body)}</pre>`
      : `<textarea class="sw-editor" data-core="1" spellcheck="false" ` +
        `placeholder="这个故事是关于什么的 —— 立意、主角、他要什么、挡在前面的是什么、这个世界的规则、谁和谁什么关系。">${esc(m.text)}</textarea>`) +
    `<div class="sw-foot"><span class="meta">${m.chars} 字 · 日常编辑只维护最新版</span></div>` +
    finalizeBar("core", m.history.length) +
    (ui && ui.coreHist ? historyList("core", m.history) : "") +
    `</div>`
  );
}

/* --- ② 故事大纲 ------------------------------------------------------------ */

export function outlineWorkModel(story) {
  const work = workOf(story);
  if (!work) return { text: "", nodes: [], history: [] };
  return {
    text: w.outlineText(work),
    nodes: work.outline.nodes,
    history: work.finalized.outline,
  };
}

/** 节点一览：让「有稳定 id 这回事」看得见，但一个字都不用他维护。 */
function nodeStrip(nodes) {
  if (!nodes.length) {
    return `<div class="sw-nodes empty">还没有段落 —— 写下去，系统会自动切成可被引用的节点。</div>`;
  }
  const rows = nodes
    .map(
      (n, i) =>
        `<div class="sw-node"><span class="n">${i + 1}</span>` +
        `<span class="id" title="结构规划的「关联故事大纲」引用的就是它；不用你维护">${esc(n.id)}</span>` +
        `<span class="tx">${esc(n.text.slice(0, 60))}${n.text.length > 60 ? "…" : ""}</span></div>`,
    )
    .join("");
  return `<div class="sw-nodes">${rows}</div>`;
}

export function renderOutlineWorkWs(ctx, ui) {
  const m = outlineWorkModel(ctx.story);
  const viewing = ui && ui.outlineView ? ui.outlineView : null;
  return (
    head("故事大纲", "项目级") +
    `<div class="sw-page">` +
    `<div class="sw-note">像写普通文本一样写。空行分段、「- 」起一条列表 —— ` +
    `系统会自动给每段一个稳定编号，结构规划那张表引用的就是它，<b>不用你维护</b>。</div>` +
    (viewing
      ? `<div class="sw-viewing">正在看 v${esc(String(viewing.v))} 的内容（只读）` +
        `<button class="btn ghost sm" data-finclose="outline">回到最新版</button></div>` +
        `<pre class="sw-editor read">${esc(viewing.body)}</pre>`
      : `<textarea class="sw-editor" data-outline="1" spellcheck="false" ` +
        `placeholder="开端：…&#10;&#10;发展：…&#10;&#10;结局：…">${esc(m.text)}</textarea>`) +
    `<div class="sw-foot"><span class="meta">${m.nodes.length} 个节点 · 日常编辑只维护最新版</span></div>` +
    nodeStrip(m.nodes) +
    finalizeBar("outline", m.history.length) +
    (ui && ui.outlineHist ? historyList("outline", m.history) : "") +
    `</div>`
  );
}

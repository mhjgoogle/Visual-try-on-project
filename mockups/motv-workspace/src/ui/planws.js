// ③ 结构规划（TASK-122 第 4 步）。
//
// 产品负责人 2026-08-30 的规格，逐字：「使用表格，字段严格为：Unit No. / Scene /
// Scene 目的 / 主要人物 / 人物目标 / 冲突 / 关键转折 / Ending State / 关联故事大纲。
// 『关联故事大纲』引用步骤 2 自动生成的 Outline Node。」
//
// **列由 `storywork.PLAN_COLUMNS` 说了算**，这里不另抄一份 —— 抄第二份的那一刻，
// 「字段严格为这九个」就变成了两个各自漂移的名单。

import { esc } from "../util/dom.js";
import { head } from "./shell.js";
import * as w from "../workflow/storywork.js";
import { finalizeBar, historyList, workOf } from "./corews.js";

export function planModel(story) {
  const work = workOf(story);
  if (!work) return { columns: w.PLAN_COLUMNS, rows: [], hidden: [], nodes: [], dangling: [], history: [] };
  const nodes = work.outline.nodes;
  return {
    columns: w.PLAN_COLUMNS,
    rows: w.visiblePlanRows(work),
    hidden: work.plan.rows.filter((r) => r.hidden),
    nodes,
    // 引用了已经不存在的节点 —— **说出来**，不静默丢掉那一格
    dangling: w.danglingRefs(work),
    history: work.finalized.plan,
  };
}

/** 一格「关联故事大纲」：显示引用到的节点，点开可勾选。 */
function refCell(row, nodes, open) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chips = row.outlineRefs
    .map((id) => {
      const n = byId.get(id);
      const i = nodes.findIndex((x) => x.id === id);
      return n
        ? `<span class="sp-ref" title="${esc(n.text.slice(0, 120))}">§${i + 1}` +
          `<button class="x" data-sp-unref="${esc(row.id)}:${esc(id)}" title="取消引用">✕</button></span>`
        : `<span class="sp-ref bad" title="这个大纲节点已经不在了">§? ${esc(id)}` +
          `<button class="x" data-sp-unref="${esc(row.id)}:${esc(id)}">✕</button></span>`;
    })
    .join("");
  const picker = open
    ? `<div class="sp-pick">` +
      (nodes.length
        ? nodes
            .map(
              (n, i) =>
                `<button class="sp-pickrow${row.outlineRefs.includes(n.id) ? " on" : ""}" ` +
                `data-sp-ref="${esc(row.id)}:${esc(n.id)}">§${i + 1} ${esc(n.text.slice(0, 50))}</button>`,
            )
            .join("")
        : `<div class="meta">故事大纲还没有内容 —— 先去写，这里就能引用了。</div>`) +
      `</div>`
    : "";
  return (
    `<div class="sp-refs">${chips}` +
    `<button class="btn ghost sm" data-sp-refopen="${esc(row.id)}">${open ? "收起" : "＋ 关联"}</button>` +
    `</div>${picker}`
  );
}

export function renderPlanWs(ctx, ui) {
  const m = planModel(ctx.story);
  const openRef = ui && ui.planRefOpen;
  const headRow = m.columns.map(([, label]) => `<th>${esc(label)}</th>`).join("");
  const body = m.rows
    .map((row) => {
      const cells = m.columns
        .map(([key]) => {
          if (key === "outlineRefs") return `<td class="sp-c-ref">${refCell(row, m.nodes, openRef === row.id)}</td>`;
          const val = row[key] || "";
          const short = key === "unitNo";
          return (
            `<td class="sp-c${short ? " sp-c-no" : ""}">` +
            `<textarea class="sp-in" data-sp-edit="${esc(row.id)}:${esc(key)}" rows="${short ? 1 : 2}" ` +
            `spellcheck="false">${esc(val)}</textarea></td>`
          );
        })
        .join("");
      return (
        `<tr>${cells}<td class="sp-c-act">` +
        `<button class="btn ghost sm danger" data-sp-del="${esc(row.id)}" title="删除这一行（可撤销）">✕</button></td></tr>`
      );
    })
    .join("");
  return (
    head("结构规划", "项目级") +
    `<div class="sw-page wide">` +
    `<div class="sw-note">一行一个单元。最后一列「关联故事大纲」引用的是大纲里那些自动编号的段落 —— ` +
    `大纲改了，引用不会跟着断。</div>` +
    (m.dangling.length
      ? `<div class="sw-warn">有 ${m.dangling.length} 处引用指向已经不存在的大纲节点 —— ` +
        `它们在表里标成 <b>§?</b>，没有被悄悄删掉。</div>`
      : "") +
    `<div class="sp-wrap"><table class="sp-table"><thead><tr>${headRow}<th></th></tr></thead>` +
    `<tbody>${body}</tbody></table></div>` +
    (m.rows.length ? "" : `<div class="sw-empty">还没有行 —— 加一行开始规划。</div>`) +
    `<div class="sw-foot"><button class="btn" data-sp-add="1">＋ 加一行</button>` +
    (m.hidden.length
      ? `<button class="btn ghost" data-sp-bin="1">回收区 ${m.hidden.length}</button>`
      : "") +
    `<span class="meta">${m.rows.length} 行 · 日常编辑只维护最新版</span></div>` +
    (ui && ui.planBin && m.hidden.length
      ? `<div class="sw-hist">` +
        m.hidden
          .map(
            (r) =>
              `<div class="sw-hrow"><span class="v">${esc(r.unitNo || "—")}</span>` +
              `<span class="note">${esc((r.scene || "").slice(0, 60))}</span>` +
              `<button class="btn ghost sm" data-sp-restore="${esc(r.id)}">恢复</button></div>`,
          )
          .join("") +
        `</div>`
      : "") +
    finalizeBar("plan", m.history.length) +
    (ui && ui.planHist ? historyList("plan", m.history) : "") +
    `</div>`
  );
}

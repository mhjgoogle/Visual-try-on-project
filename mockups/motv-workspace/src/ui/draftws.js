// ④ 正文创作（TASK-122 第 5 步）。
//
// 产品负责人 2026-08-30 的规格，逐字：
//
//   「首先提供两个入口：小说创作 / 剧集创作。支持三种路径：直接小说 / 小说 → 剧集 /
//    直接剧集。小说完成后提供『进入剧集创作』入口，不额外增加一级 Tab。
//    小说模式先设置 Planned Chapters；剧集模式先设置 Planned Episodes。数量可动态
//    增加和减少。根据数量生成 Chapter / Episode 选择器。进入具体 Unit 后，中间工作区
//    内部布局：左侧二级 Brief（显示与 Story Core / Outline / Structure Plan 的关联，
//    以及当前 Chapter / Episode 的简要任务）／中央：大型正文编辑器／正文提供 Copy 按钮。」
//
// 三处约束都在这一份文件里成立：**页内**选择器（不进全局左栏）、**二级** Brief
// （不是一级 Tab）、「进入剧集创作」是**这一页里的一个入口**，不是新的 Tab。

import { esc } from "../util/dom.js";
import { head } from "./shell.js";
import * as w from "../workflow/storywork.js";
import { workOf } from "./corews.js";

const KIND_WORD = { novel: "章", episode: "集" };
const KIND_LABEL = { novel: "小说创作", episode: "剧集创作" };
const PLANNED_LABEL = { novel: "Planned Chapters", episode: "Planned Episodes" };

export function draftModel(story, ui) {
  const work = workOf(story);
  if (!work) return { kind: "", planned: 0, units: [], unit: null, openNo: null };
  const kind = work.form || "";
  const planned = kind ? work.planned[kind] : 0;
  const units = kind ? work.units.filter((u) => u.kind === kind) : [];
  const openNo = ui && ui.unitNo ? ui.unitNo : null;
  const unit = openNo ? units.find((u) => u.no === openNo) || null : null;
  return { kind, planned, units, unit, openNo };
}

/** 二级 Brief：这一章/集要干什么，以及它挂在故事的哪一段上。 */
function unitBrief(story, kind, no, unit) {
  const work = workOf(story);
  if (!work) return "";
  const nodes = work.outline.nodes;
  const row = w
    .visiblePlanRows(work)
    .find((r) => String(r.unitNo).trim() === String(no));
  const refLines = row
    ? row.outlineRefs
        .map((id) => {
          const i = nodes.findIndex((n) => n.id === id);
          return i >= 0 ? `§${i + 1} ${nodes[i].text.slice(0, 40)}` : `§? ${id}`;
        })
        .filter(Boolean)
    : [];
  const core = (work.core || "").trim();
  const block = (title, body) =>
    body ? `<div class="db-b"><div class="t">${esc(title)}</div><div class="v">${esc(body)}</div></div>` : "";
  return (
    `<div class="db-brief">` +
    `<div class="db-h">第 ${no} ${KIND_WORD[kind]} · 简要任务</div>` +
    (row
      ? block("Scene", row.scene) +
        block("这一单元要完成的", row.purpose) +
        block("主要人物", row.characters) +
        block("人物目标", row.goal) +
        block("冲突", row.conflict) +
        block("关键转折", row.turn) +
        block("Ending State", row.endingState)
      : `<div class="db-b"><div class="v meta">结构规划里还没有 Unit No. = ${esc(String(no))} 的行 —— ` +
        `去那张表加一行，这里就会显示它的目的、人物与转折。</div></div>`) +
    (refLines.length
      ? `<div class="db-b"><div class="t">关联故事大纲</div>` +
        refLines.map((s) => `<div class="v">${esc(s)}</div>`).join("") +
        `</div>`
      : "") +
    (core ? block("故事核心", core.slice(0, 220) + (core.length > 220 ? "…" : "")) : "") +
    `<div class="db-b"><div class="t">标题</div>` +
    `<input class="db-title" data-unit-title="${esc(unit ? unit.id : "")}" value="${esc(unit ? unit.title : "")}" ` +
    `placeholder="这一${KIND_WORD[kind]}的标题"></div>` +
    `</div>`
  );
}


/** 还没进到某一章时的左栏 Brief：这次要写的是什么、写到哪儿了。
 *
 *  产品负责人 2026-08-30：「正文创作左边是 brief。」—— **不管有没有打开某一章**，
 *  左边都是 Brief，右边才是控制与编辑器。所以这一页的两栏结构是恒定的，
 *  不会「先一个宽页、点进去忽然变两栏」。 */
function overviewBrief(story, kind, planned, units) {
  const work = workOf(story);
  if (!work) return `<div class="db-brief"></div>`;
  const core = (work.core || "").trim();
  const nodes = work.outline.nodes;
  const rows = w.visiblePlanRows(work);
  const written = units.filter((u) => (u.body || "").trim()).length;
  const block = (title, body) =>
    body ? `<div class="db-b"><div class="t">${esc(title)}</div><div class="v">${esc(body)}</div></div>` : "";
  return (
    `<div class="db-brief">` +
    `<div class="db-h">这次要写的</div>` +
    block("形态", KIND_LABEL[kind] || "还没选") +
    block("进度", `${written} / ${planned} ${KIND_WORD[kind] || ""}已经动过笔`) +
    (core ? block("故事核心", core.slice(0, 260) + (core.length > 260 ? "…" : "")) : "") +
    (nodes.length
      ? `<div class="db-b"><div class="t">故事大纲</div>` +
        nodes
          .slice(0, 6)
          .map((n, i) => `<div class="v">§${i + 1} ${esc(n.text.slice(0, 34))}</div>`)
          .join("") +
        (nodes.length > 6 ? `<div class="v meta">…共 ${nodes.length} 个节点</div>` : "") +
        `</div>`
      : "") +
    block("结构规划", rows.length ? `${rows.length} 行` : "还没有行") +
    `</div>`
  );
}

/** 入口选择：还没选形态时，屏幕上只有这两个入口。 */
function formGate() {
  return (
    head("正文创作", "项目级") +
    `<div class="sw-page">` +
    `<div class="sw-note">先决定这次写什么。选了之后随时能改，已经写下的内容不会丢。</div>` +
    `<div class="db-gate">` +
    `<button class="db-card" data-form="novel"><div class="i">📖</div><div class="n">小说创作</div>` +
    `<div class="d">按「章」写。写完可以直接进入剧集创作。</div></button>` +
    `<button class="db-card" data-form="episode"><div class="i">🎬</div><div class="n">剧集创作</div>` +
    `<div class="d">按「集」写。也可以从已经写好的小说转过来。</div></button>` +
    `</div></div>`
  );
}

/** 章/集选择器 —— **页内**，不进全局左栏（他点名的约束）。 */
function unitPicker(kind, planned, units, openNo) {
  const word = KIND_WORD[kind];
  const byNo = new Map(units.map((u) => [u.no, u]));
  const cells = [];
  const max = Math.max(planned, ...units.map((u) => u.no), 0);
  for (let i = 1; i <= max; i += 1) {
    const u = byNo.get(i);
    const beyond = i > planned;
    const written = u && (u.body || "").trim().length;
    cells.push(
      `<button class="db-u${openNo === i ? " on" : ""}${beyond ? " over" : ""}" data-unit="${i}" ` +
        `title="${beyond ? "计划之外 —— 已经写过，所以留着" : ""}">` +
        `<span class="no">${i}</span><span class="w">${esc(word)}</span>` +
        (written ? `<span class="dot" title="已经写了"></span>` : "") +
        `</button>`,
    );
  }
  return `<div class="db-picker">${cells.join("") || `<div class="meta">把数量设成 1 以上，这里就会出现选择器。</div>`}</div>`;
}

/** 从「剧集创作」进到「剧集制作」的入口。
 *
 *  产品负责人 2026-08-30：「剧集创作要从正文创作里面进入。」——**这是故事侧交给生产线的
 *  那道门，它只开在这里**。结构规划上不再有（他前一句刚说过「结构规划不应该跳到剧集
 *  制作」），左栏里也没有。
 *
 *  它按第 N 集对到生产文档的第 N 集；对不上时**说出来**，而不是画一个按下去没反应的按钮。 */
function produceEntry(ctx, kind, no) {
  if (kind !== "episode" || !no) return "";
  const eps = (ctx.prodData ? ctx.prodData().production.episodes : []) || [];
  const ep = eps[no - 1];
  if (!ep) {
    return (
      `<span class="meta" title="生产文档里还没有第 ${no} 集">` +
      `第 ${no} 集还没有建立，进不了剧集制作</span>`
    );
  }
  return (
    `<button class="btn sm" data-unit-produce="${esc(ep.episodeId || "")}" ` +
    `title="带着第 ${no} 集切换到「剧集制作」">🎬 进入剧集制作 →</button>`
  );
}

export function renderDraftWs(ctx, ui) {
  const m = draftModel(ctx.story, ui);
  if (!m.kind) return formGate();
  const word = KIND_WORD[m.kind];

  // ——— 进到某一章/集：左侧二级 Brief + 中央大编辑器 + Copy
  if (m.openNo) {
    const unit = m.unit;
    return (
      head("正文创作", `第 ${m.openNo} ${word}`) +
      `<div class="sw-page">` +
      `<div class="db-top"><button class="btn ghost sm" data-unit-back="1">← 全部${word}节</button>` +
      unitPicker(m.kind, m.planned, m.units, m.openNo) +
      `</div>` +
      `<div class="db-unit">` +
      unitBrief(ctx.story, m.kind, m.openNo, unit) +
      `<div class="db-main">` +
      `<div class="db-mh"><span class="meta">${(unit && unit.body ? unit.body.length : 0)} 字 · 日常编辑只维护最新版</span>` +
      `<button class="btn ghost sm" data-unit-copy="${esc(unit ? unit.id : "")}">⧉ Copy</button>` +
      `<button class="btn sm" data-unit-fin="${esc(unit ? unit.id : "")}">✓ 定稿 · 存一版</button>` +
      produceEntry(ctx, m.kind, m.openNo) +
      ((unit && unit.finalized.length)
        ? `<button class="btn ghost sm" data-unit-hist="${esc(unit.id)}">历史版本 ${unit.finalized.length}</button>`
        : `<span class="meta">还没有历史版本</span>`) +
      `</div>` +
      `<textarea class="db-editor" data-unit-body="${esc(unit ? unit.id : "")}" spellcheck="false" ` +
      `placeholder="写这一${word}的正文。">${esc(unit ? unit.body : "")}</textarea>` +
      ((ui && ui.unitHist && unit)
        ? `<div class="sw-hist">` +
          unit.finalized
            .slice()
            .reverse()
            .map(
              (r) =>
                `<div class="sw-hrow"><span class="v">v${r.v}</span><span class="at">${esc(r.at)}</span>` +
                `<button class="btn ghost sm" data-unit-restore="${esc(unit.id)}:${r.v}">恢复</button>` +
                `<button class="btn ghost sm danger" data-unit-findel="${esc(unit.id)}:${r.v}">删除</button></div>`,
            )
            .join("") +
          `</div>`
        : "") +
      `</div></div></div>`
    );
  }

  // ——— 形态与数量，以及全部章/集。**左边仍然是 Brief**（他 2026-08-30 点名的）。
  const other = m.kind === "novel" ? "episode" : "novel";
  const wroteSomething = m.units.some((u) => (u.body || "").trim());
  return (
    head("正文创作", "项目级") +
    `<div class="sw-page">` +
    `<div class="db-unit">` +
    overviewBrief(ctx.story, m.kind, m.planned, m.units) +
    `<div class="db-main">` +
    `<div class="db-mode">` +
    `<span class="cur">${esc(KIND_LABEL[m.kind])}</span>` +
    `<button class="btn ghost sm" data-form="${other}">改成${esc(KIND_LABEL[other])}</button>` +
    (m.kind === "novel" && wroteSomething
      ? `<button class="btn sm" data-form="episode" title="小说写好了，用它作为底子进入剧集创作">→ 进入剧集创作</button>`
      : "") +
    `</div>` +
    `<div class="db-planned"><label>${esc(PLANNED_LABEL[m.kind])}</label>` +
    `<button class="btn ghost sm" data-planned="-1">−</button>` +
    `<input class="db-n" data-planned-set="1" value="${m.planned}" inputmode="numeric">` +
    `<button class="btn ghost sm" data-planned="1">＋</button>` +
    `<span class="meta">可以随时加减 —— 减少不会删掉已经写下的${esc(word)}节</span></div>` +
    unitPicker(m.kind, m.planned, m.units, null) +
    `<div class="sw-foot"><span class="meta">选一${esc(word)}开始写</span></div>` +
    `</div></div></div>`
  );
}

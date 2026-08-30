// 剧集制作的那一块画布（TASK-124）。
//
// 产品负责人 2026-08-30：「剧集制作这块你设计了很多入口。有点看不懂。能不能就做一块
// 简洁的画布。更直观的展示各个功能。」
//
// 他面对的是 **6 行左栏 + 14 个二级分区 + 110 个按钮**（真界面上数出来的）。这一屏
// 把它换成三样东西：
//
//   ① 一条流水线   这一集走到哪了 —— 八个阶段，每段有数
//   ② 一排镜头卡   一镜一张，卡在哪一步写在卡上，一张卡只给**一个**主按钮
//   ③ 一句下一步   整集此刻最该做的那一件事
//
// **不重写任何工作区**：卡上的每一步都通向既有的那一页（`data-goto` + 选中这一镜），
// 画布只是把「该去哪」这件事从记忆里搬到屏幕上。原来的五页一个没删。

import { esc } from "../util/dom.js";
import { head } from "./shell.js";
import { productionPlan, episodeShots, shotBlockers } from "./prodplan.js";
import { STAGE_LABEL } from "../workflow/shotstage.js";

/** 一镜要走的那几步，以及每一步该去哪一页。**顺序即流程**。 */
export const SHOT_STEPS = [
  // **用领域自己的名字**（`STAGE_LABEL`），不另起一套。第一版这里把 `storyboard`
  // 叫「分镜」，于是每张卡都显示「分镜 · 未开始」—— 而那三个镜头明明就在屏幕上。
  // 它其实是「分镜草图」这张**资产**做没做，与「有没有这一镜」是两回事。
  { key: "storyboard", label: "草图", goto: "storyboard" },
  { key: "blocking", label: "白膜", goto: "blocking" },
  { key: "keyframe", label: "关键帧", goto: "frames" },
  { key: "video", label: "视频", goto: "video" },
  { key: "qc", label: "审核", goto: "cutreview" },
];


/** 这一集的名字。`title` 常常已经带着集号，别再前缀一次。 */
function episodeLabel(ep) {
  const title = String((ep && ep.title) || "").trim();
  const code = String((ep && ep.code) || "").trim();
  if (!title) return code;
  return title.startsWith(code) ? title : `${code} ${title}`;
}

const MARK = { done: "✓", active: "◔", todo: "·" };

export function canvasModel(ctx) {
  const pd = ctx.prodData();
  const plan = productionPlan(pd, ctx.script ? ctx.script.doc() : null);
  const shots = episodeShots(pd);
  const blocking = (pd.production && pd.production.blocking) || {};
  const cards = shots.map((s) => {
    // 每一镜的阶段板 —— 用**既有的**那一份（`ctx.shot.stageBoard`），
    // 画布不自己再算一遍状态：算第二遍的那一刻，卡片和工作区就会开始各说各话。
    const board = ctx.shot && ctx.shot.stageBoard ? ctx.shot.stageBoard(s.shotId) : null;
    const blockers = shotBlockers(pd, s);
    const b = blocking[s.shotId];
    const hasBlocking = !!(b && (b.actors || []).some((a) => !a.hidden));
    // 每一步的状态：已完成 / 在做 / 还没开始。**白膜那一步读的是真数据**，
    // 不是「有没有点过那个页面」。
    const steps = SHOT_STEPS.map((step) => {
      let state = "todo";
      if (step.key === "blocking") {
        // 白膜那一步读的是**真数据**（场上有没有人），不是「有没有点过那个页面」
        state = hasBlocking ? "done" : "todo";
      } else if (board && board[step.key]) {
        const st = board[step.key];
        state = st.status === "completed" ? "done" : st.status === "in_progress" ? "active" : "todo";
      }
      return { ...step, state, mark: MARK[state] };
    });
    const next = steps.find((x) => x.state !== "done") || null;
    return {
      shotId: s.shotId,
      seq: s.seq,
      title: s.title || s.shotId,
      poster: s.poster || null,
      stageLabel: STAGE_LABEL[(steps.find((x) => x.state !== "done") || {}).key] || "",
      blockers,
      steps,
      next,
    };
  });
  return { plan, cards, episode: plan.episode };
}

/** ① 流水线：这一集走到哪了。八段，每段一个数 —— 不解释，只报事实。 */
function pipeline(plan) {
  const cells = plan.stages
    .map(
      (s) =>
        `<button class="ec-step ec-${esc(s.state)}" data-goto="${esc(s.goto || "")}" ` +
        `title="${esc(s.detail || "")}">` +
        `<span class="m">${MARK[s.state] || "·"}</span>` +
        `<span class="l">${esc(s.label)}</span>` +
        (s.detail ? `<span class="d">${esc(s.detail)}</span>` : "") +
        `</button>`,
    )
    .join(`<span class="ec-arrow">→</span>`);
  return `<div class="ec-pipe">${cells}</div>`;
}

/** ③ 一句下一步：整集此刻最该做的那件事。没有就说做完了。 */
function nextLine(plan) {
  if (!plan.next) {
    return `<div class="ec-next done">这一集该做的都做完了。</div>`;
  }
  const n = plan.next;
  const counts =
    n.ready || n.blocked
      ? `<span class="meta">${n.ready} 个可以做${n.blocked ? ` · ${n.blocked} 个卡住` : ""}</span>`
      : "";
  return (
    `<div class="ec-next"><span class="t">下一步</span>` +
    `<button class="btn" data-goto="${esc(n.goto || "")}">${esc(n.label)}</button>` +
    `<span class="d">${esc(n.detail || "")}</span>${counts}</div>`
  );
}

/** ② 一张镜头卡：缩略图 + 走到哪 + **一个**主按钮。 */
function shotCard(c) {
  const steps = c.steps
    .map(
      (s) =>
        `<button class="ec-dot ec-${esc(s.state)}" data-ec-step="${esc(c.shotId)}:${esc(s.goto)}" ` +
        `title="${esc(s.label)}">${s.mark}<span>${esc(s.label)}</span></button>`,
    )
    .join("");
  const poster = c.poster
    ? `<img class="ec-poster" src="${esc(c.poster)}" alt="" data-media-url="${esc(c.poster)}">`
    : `<div class="ec-poster none">还没有画面</div>`;
  return (
    `<div class="ec-card" data-ec-card="${esc(c.shotId)}">` +
    poster +
    `<div class="ec-h"><span class="n">${esc(String(c.seq ?? ""))}</span>` +
    `<span class="t">${esc(c.title)}</span></div>` +
    `<div class="ec-steps">${steps}</div>` +
    (c.blockers.length
      ? `<div class="ec-block" title="${esc(c.blockers.join(" · "))}">⚠ ${esc(c.blockers[0])}</div>`
      : "") +
    (c.next
      ? `<button class="btn sm ec-go" data-ec-step="${esc(c.shotId)}:${esc(c.next.goto)}">` +
        `下一步：${esc(c.next.label)}</button>`
      : `<div class="ec-done">这一镜做完了</div>`) +
    `</div>`
  );
}

export function renderEpCanvas(ctx, ui) {
  const m = canvasModel(ctx);
  if (!m.episode) {
    return (
      head("制作画布", "本集") +
      `<div class="ec-empty">还没有剧集 —— 先在「故事开发 · 结构规划」确认规划。</div>`
    );
  }
  const showAll = !!ui.ecAllTools;
  return (
    // 标题里不再重复集号：`title` 在真项目里已经带着「EP01 …」，
    // 两个一起写就成了「EP01 EP01 迷雾入城」（截图里当场看到）。
    head("制作画布", esc(episodeLabel(m.episode))) +
    pipeline(m.plan) +
    nextLine(m.plan) +
    (m.cards.length
      ? `<div class="ec-grid">${m.cards.map(shotCard).join("")}</div>`
      : `<div class="ec-empty">这一集还没有镜头 —— 上面那条流水线会告诉你先做哪一步。</div>`) +
    // 原来那五页一个没删：收在这里，需要整页工作的时候进去
    `<div class="ec-tools">` +
    `<button class="btn ghost sm" data-ec-tools="1">${showAll ? "收起" : "全部工作区 ▾"}</button>` +
    (showAll
      ? `<div class="ec-toolrow">` +
        [
          ["board", "本集看板"],
          ["storyboard", "分镜设计"],
          ["blocking", "3D 导演台"],
          ["shotwork", "镜头制作"],
          ["cutreview", "粗剪审片"],
          ["delivery", "后期交付"],
        ]
          .map(([k, l]) => `<button class="btn ghost sm" data-goto="${esc(k)}">${esc(l)}</button>`)
          .join("") +
        `</div>`
      : "") +
    `</div>`
  );
}

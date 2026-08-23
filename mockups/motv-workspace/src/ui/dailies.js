// Dailies — continuous review of an episode (checkpoint CP4 / ADR-0057 决策 4).
//
// Walking an episode shot by shot is the most basic form of the thing this
// studio exists for, and until now the only way to do it was: open a shot,
// look, back out, open the next one. Dailies plays them in CANONICAL order —
// scenes in their order, each scene's shots in ITS order, then the unassigned
// pool — with 播放 / 上一镜 / 下一镜 / Shot Design 摘要 / 状态 / 通过 / 跳过.
//
// TWO RULES THIS MODULE HOLDS:
//
//   1. A shot with no video does NOT break the walk. It appears in sequence,
//      says it has no picture yet, and is simply not playable. An episode is
//      normally half-finished; a reviewer needs to see the holes, not crash on
//      them.
//   2. A shot with no VIDEO cannot be approved. 审片 judges the shot as it will
//      be seen, so clicking 通过 on nothing would record a review that never
//      happened. The guard lives in the domain (ctx.shot.approve) as well as
//      here — a UI-only check leaves every other caller free to bypass it.
//
// The model is DERIVED on every render (ADR-0057 决策 1): the only persisted
// bit is the approval itself.

import { esc } from "../util/dom.js";
import { SHOT_STAGE_LABEL, shotStage, hasStaleApproval } from "../workflow/shotprod.js";
import { head, empty } from "./shell.js";

/** The design facets a reviewer needs to judge against, in reading order. */
const DESIGN_ROWS = [
  ["shotSize", "景别"],
  ["angle", "角度"],
  ["cameraMotion", "运镜"],
  ["action", "动作"],
  ["expression", "表情"],
  ["emotion", "情绪"],
  ["dialogue", "台词"],
];

/**
 * The review sequence for one episode.
 *
 * `view`   proddoc.episodeView() — scenes with their resolved shots, plus the
 *          unassigned pool
 * `mediaOf(shot)` → { image, video }
 * `urlOf(shot)`   → the shot's current video url, or "" when there is none
 *
 * Total by construction: a missing view, an empty episode and a shot whose
 * draft entry no longer resolves all produce a usable (possibly empty) model.
 */
export function dailiesModel({ prod, view, mediaOf, urlOf, coreSyncOf }) {
  const items = [];
  const push = (shot, sceneId, sceneTitle) => {
    if (!shot || typeof shot.shotId !== "string" || !shot.shotId) return;
    const media = (mediaOf && mediaOf(shot)) || {};
    const videoUrl = (urlOf && urlOf(shot)) || "";
    const stage = shotStage(prod, shot, media);
    items.push({
      shotId: shot.shotId,
      title: typeof shot.title === "string" ? shot.title : "",
      description: typeof shot.description === "string" ? shot.description : "",
      sceneId: sceneId || null,
      sceneTitle: sceneTitle || null,
      index: items.length,
      design: DESIGN_ROWS.map(([k, label]) => ({ label, value: typeof shot[k] === "string" ? shot[k] : "" }))
        .filter((r) => r.value.trim()),
      duration: typeof shot.duration_seconds === "number" ? shot.duration_seconds : null,
      stage,
      stageLabel: SHOT_STAGE_LABEL[stage] || stage,
      // `approved` is the CURRENT standing, not "a record exists": a stale
      // approval must never render as passed, or a reviewer reads replaced
      // footage as reviewed (codex review, TASK-060 round 4).
      approved: stage === "approved",
      // …the record still exists, and is said out loud instead
      staleApproval: hasStaleApproval(prod, shot, media),
      videoUrl,
      // there is something to watch
      playable: !!videoUrl,
      // …and 审片 is a judgement about the SHOT AS IT WILL BE SEEN, i.e. its
      // video. An image-only shot is 已生成, not 待审片: approving it would jump
      // it straight to 已通过 having reviewed something that does not exist yet.
      canApprove: !!media.video,
      // 这一镜的审片结论有没有走进核心项目（TASK-103 批次 B）。
      // `null` = 还没问过核心 —— 它与「核心拒绝了」是两件事，不许塌成一件。
      coreSync: (coreSyncOf && coreSyncOf(shot.shotId)) || null,
    });
  };
  const v = view && typeof view === "object" ? view : { scenes: [], unassigned: [] };
  for (const sc of Array.isArray(v.scenes) ? v.scenes : []) {
    for (const entry of Array.isArray(sc.shots) ? sc.shots : []) {
      // episodeView wraps each shot as { shot, dangling } — a dangling ref has
      // no shot to review, and is skipped rather than rendered as a blank card
      push(entry && entry.shot, sc.sceneId, sc.title);
    }
  }
  for (const shot of Array.isArray(v.unassigned) ? v.unassigned : []) {
    push(shot, null, null); // the pool belongs to no scene — never invented one
  }
  // counts the CURRENT standing, not the record: a shot whose approved video
  // was deleted is not part of "已通过 N" any more, or the progress line would
  // claim finished work that no longer exists
  const approved = items.filter((i) => i.approved).length;
  return {
    items,
    total: items.length,
    approved,
    remaining: items.length - approved,
    // how much of the episode can actually be watched right now
    playable: items.filter((i) => i.playable).length,
  };
}

/** Position the walk on one shot. Total: an unknown or absent id lands on the
 *  first item, and the ends clamp instead of wrapping (wrapping in a review
 *  pass makes it impossible to tell you have finished). */
export function dailiesAt(model, shotId) {
  const items = (model && model.items) || [];
  if (!items.length) return { current: null, prev: null, next: null, position: 0 };
  let i = items.findIndex((x) => x.shotId === shotId);
  if (i < 0) i = 0;
  return {
    current: items[i],
    prev: i > 0 ? items[i - 1] : null,
    next: i < items.length - 1 ? items[i + 1] : null,
    position: i + 1,
  };
}

// --- rendering --------------------------------------------------------------- //

function shotCard(it) {
  const player = it.playable
    ? `<video class="dl-video" src="${esc(it.videoUrl)}" controls preload="metadata"></video>`
    : `<div class="dl-novideo"><span class="ic">🎞</span><span>这个镜头还没有视频</span>` +
      `<span class="hh">先在「视频」里生成或导入，再回来审片</span></div>`;
  const design = it.design.length
    ? `<dl class="dl-design">${it.design
        .map((r) => `<dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd>`)
        .join("")}</dl>`
    : `<div class="dl-nodesign">这个镜头还没有设计内容</div>`;
  return (
    `<div class="dl-stage">${player}</div>` +
    `<div class="dl-meta">` +
    `<div class="dl-title">${esc(it.title || "未命名镜头")}` +
    `<span class="chip ${it.approved ? "ok" : ""}">${esc(it.stageLabel)}</span></div>` +
    (it.sceneTitle ? `<div class="dl-scene">${esc(it.sceneTitle)}</div>` : `<div class="dl-scene muted">未分配到场景</div>`) +
    (it.staleApproval
      ? `<div class="dl-stale">⚠ 这个镜头曾被通过，但当时通过的视频已不在了——通过记录保留，状态回到「${esc(it.stageLabel)}」</div>`
      : "") +
    coreSyncLine(it.coreSync) +
    (it.description ? `<p class="dl-desc">${esc(it.description)}</p>` : "") +
    design +
    `</div>`
  );
}

/** 「✓ 通过」按下之后到底去了哪 —— TASK-103 批次 B（TASK-087 §1.2）。
 *
 *  在这之前它只写进画布，核心项目对此一无所知，而界面上没有任何地方说出这一点：
 *  创作者按下按钮、看到状态变成「已通过」，合理地以为这件事已经记在项目里了。
 *
 *  所以四种情况各说各的，绝不合并：
 *    null          还没问过核心（刚打开旧存档）—— 不是「没登记上」
 *    recorded      已登记，带记录号
 *    blocked       核心拒绝了，原样转述它给的理由（缺项目身份 / 镜头没正式记录）
 *    unavailable   没连后端 —— 演示模式下这是正常的，不是故障
 *    failed        网关报错，或回执不是 completed（含 AMBIGUOUS：可能写了也可能
 *                  没写，显示成「已登记」比不显示更糟）
 */
function coreSyncLine(sync) {
  if (!sync || typeof sync !== "object") return "";
  const text = typeof sync.text === "string" ? sync.text : "";
  if (!text) return "";
  const cls = sync.state === "recorded" ? "ok" : sync.state === "unavailable" ? "muted" : "warn";
  // 只有「已登记」和「正在登记」不需要重试。其余每一种 —— 中断、被拒、出错、
  // 没后端 —— 创作者今天都无路可走：镜头一旦通过，「✓ 通过」就被「撤销通过」
  // 顶掉了，没有第二次机会（codex round 1, P1）。
  const retry = sync.state === "recorded" || sync.state === "pending"
    ? ""
    : `<button class="btn sm" data-dl-resync>重试登记</button>`;
  return `<div class="dl-coresync ${cls}">${esc(text)}${retry}</div>`;
}

/** The Dailies workspace. */
export function renderDailies(ctx, ui) {
  const m = ctx.dailies.model();
  if (!m.total) {
    return (
      head("审片", "按场景顺序连续看完这一集") +
      empty("🎬", "这一集还没有镜头", "先在「分镜」里拆出镜头，再回来审片",
        `<button class="btn" data-goto="shots">去分镜</button>`)
    );
  }
  const at = dailiesAt(m, ui.dailiesShotId);
  const it = at.current;
  const actions =
    `<button class="btn" data-dl-prev ${at.prev ? "" : "disabled"}>← 上一镜</button>` +
    `<button class="btn" data-dl-next ${at.next ? "" : "disabled"}>下一镜 →</button>` +
    (it.approved && !it.staleApproval
      ? `<button class="btn" data-dl-unapprove>撤销通过</button>`
      : `<button class="btn primary" data-dl-approve ${it.canApprove ? "" : "disabled"} ` +
        `title="${it.canApprove ? "记录：这个镜头我看过，通过了" : "还没有画面可审——生成后才能通过"}">✔ 通过</button>`) +
    (it.staleApproval ? `<button class="btn" data-dl-unapprove>清除失效的通过记录</button>` : "") +
    `<button class="btn" data-dl-skip ${at.next ? "" : "disabled"}>跳过</button>`;
  return (
    head(
      "审片",
      `第 ${at.position} / ${m.total} 个镜头 · 已通过 ${m.approved} · 待审 ${m.remaining}` +
        (m.playable < m.total ? ` · ${m.total - m.playable} 个还没有视频` : ""),
      actions,
    ) +
    `<div class="dl-wrap">${shotCard(it)}</div>` +
    `<div class="dl-strip">${m.items
      .map((x) => (
        `<button class="dl-chip${x.shotId === it.shotId ? " on" : ""}${x.approved ? " ok" : ""}` +
        `${x.playable ? "" : " novideo"}" data-dl-go="${esc(x.shotId)}" ` +
        `title="${esc(x.title)} · ${esc(x.stageLabel)}">${x.index + 1}</button>`
      ))
      .join("")}</div>`
  );
}

export function bindDailies(root, ctx, ui, render) {
  const m = ctx.dailies.model();
  const at = dailiesAt(m, ui.dailiesShotId);
  const go = (shotId) => {
    if (!shotId) return;
    ui.dailiesShotId = shotId;
    render();
  };
  const on = (sel, fn) => {
    const el = root.querySelector(sel);
    if (el && !el.disabled) el.onclick = fn;
  };
  on("[data-dl-prev]", () => go(at.prev && at.prev.shotId));
  on("[data-dl-next]", () => go(at.next && at.next.shotId));
  // 跳过 is deliberately the same movement as 下一镜 and records NOTHING: an
  // unreviewed shot stays unreviewed, which is the truth.
  on("[data-dl-skip]", () => go(at.next && at.next.shotId));
  on("[data-dl-approve]", () => {
    if (!at.current || !at.current.canApprove) return;
    ctx.shot.approve(at.current.shotId);
    // move on automatically — the point of a review pass is to keep going
    if (at.next) ui.dailiesShotId = at.next.shotId;
    render();
  });
  on("[data-dl-resync]", () => {
    if (at.current) ctx.shot.resyncReview(at.current.shotId);
  });
  on("[data-dl-unapprove]", () => {
    if (!at.current) return;
    ctx.shot.unapprove(at.current.shotId);
    render();
  });
  root.querySelectorAll("[data-dl-go]").forEach((b) => (b.onclick = () => go(b.dataset.dlGo)));
}

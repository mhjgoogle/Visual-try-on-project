// CENTER of 剧集制作 — the Shot 制作流程图 (TASK-066 §8 / §9).
//
//   SH05 制作流程图 ⓘ            ⊙ 自动布局 | 手动布局   ⛶ 全屏   完整溯源 ↗  工作区 ▾
//   ────────────────────────────────────────────────────────────────────────────
//   ┌ 参考输入 ────┐
//   │ ▢ ▢ ▢ ▢ ▢    │→ Image Prompt → 主帧图 → Video Prompt → 最终视频 → End Frame
//   └ 视频编排参考 ┘
//
// WHAT THIS COLUMN OWNS. The picture of how the CURRENT shot gets made, and nothing
// else. The Episode / Scene / Shot selectors moved to the shared top bar
// (ui/shotselect.js) because they belong to the whole space; the reference list moved
// to the left column (ui/shotrefs.js); the per-object operations moved onto the
// cards themselves (ui/shotgraphview.js §10). What is left here is the frame around
// the picture: what it is, how it is laid out, and the ways out of it.
//
// 完整溯源 stays one click away and unchanged — it answers 「这个东西是怎么来的」, which
// is a different question from 「这一镜怎么做出来」 and still worth its own view.
//
// PURE PRESENTATION over ctx read models (`episodeModel` from episodews.js is reused
// verbatim, so this surface and 本集总览 can never disagree about what the episode
// contains; the graph comes from `ctx.shotgraph`, built from the same
// `shotDetailModel` every other consumer reads).

import { esc } from "../util/dom.js";
import { episodeModel } from "./episodews.js";
import {
  episodeLabels, episodeTitleBeside, EPISODE_DEFAULT, EPISODE_WORKSPACES, MODULE_LABEL,
} from "./shell.js";

/** The Focus Filters (TASK-064 §7). They narrow WHICH shots the shot strip offers by
 *  what each one currently has — a view filter, never a mode. `失败` reads the real
 *  generation registry: a shot whose latest generation failed is a shot that needs
 *  attention, and there is no other way to find it in one look. */
export const FOCUS_FILTERS = [
  ["all", "全部"],
  ["image", "图片"],
  ["video", "视频"],
  ["audio", "音频"],
  ["failed", "失败"],
];

/** Does this shot pass the focus filter? Pure, exported for tests.
 *
 *  `image` / `video` mean 「这个镜头还缺它」 rather than 「有它」: a focus filter
 *  exists to find the work left to do. `audio` is the same for a SPEAKING shot;
 *  a shot with no dialogue is not missing audio, so it is simply not in that
 *  focus at all rather than being reported as a gap. */
export function passesFocus(card, focus) {
  if (!focus || focus === "all") return true;
  if (focus === "image") return !card.hasImage;
  if (focus === "video") return !card.hasVideo;
  if (focus === "audio") return !!(card.dialogue && card.dialogue.trim()) && !card.hasAudio;
  if (focus === "failed") return card.lastGenerationFailed === true;
  return true;
}

/** The centre's own view model: the episode plus per-shot facts the map needs
 *  that `episodeModel` does not carry (audio standing, failed generations). */
export function workbenchModel(ctx, ui) {
  const m = episodeModel(ctx);
  if (m.empty) return { empty: true, episodes: episodeLabels(ctx.prodData().production) };
  const pd = ctx.prodData();
  // ONE pass over the generation registry: the newest record per shot, so
  // 「失败」 reflects the LATEST attempt rather than any past failure — a shot
  // that failed once and then succeeded is not a failing shot.
  const latest = new Map();
  for (const g of pd.generations || []) {
    if (!g || g.targetType !== "shot" || !g.targetId) continue;
    const prev = latest.get(g.targetId);
    if (!prev || String(g.createdAt || "") >= String(prev.createdAt || "")) latest.set(g.targetId, g);
  }
  const decorate = (c) => {
    const g = latest.get(c.shotId) || null;
    return {
      ...c,
      hasAudio: !!ctx.episode.hasShotAudio(c.shotId),
      lastGenerationFailed: !!(g && (g.status === "failed" || g.status === "cancelled")),
      lastGenerationStatus: g ? g.status : null,
    };
  };
  const focus = ui.epFocus || "all";
  const scenes = m.scenes.map((s) => {
    const shots = s.shots.map(decorate);
    return { ...s, shots, visible: shots.filter((c) => passesFocus(c, focus)) };
  });
  const unassigned = m.unassigned.map(decorate);
  const all = [...scenes.flatMap((s) => s.shots), ...unassigned];
  return {
    empty: false,
    episodeId: m.episodeId,
    episodeTitle: m.episodeTitle,
    hasScript: m.hasScript,
    counts: m.counts,
    scenes,
    unassigned: unassigned.filter((c) => passesFocus(c, focus)),
    unassignedTotal: unassigned.length,
    shots: all.length,
    shown: scenes.reduce((n, s) => n + s.visible.length, 0) + unassigned.filter((c) => passesFocus(c, focus)).length,
    episodes: episodeLabels(pd.production),
    focus,
    all,
  };
}

/**
 * Which SCENE the creator is standing in, and which SHOT.
 *
 * DERIVED FROM THE SELECTED SHOT, not stored separately. A second piece of state
 * saying 「当前场景」 could disagree with 「当前镜头」 the moment either moves, and the
 * creator would then be looking at a shot filed under a scene it is not in.
 *
 * Exported so a unit test can assert the derivation without a DOM.
 */
export function currentPlace(m, selectedShotId) {
  if (m.empty) return { scene: null, shot: null, shots: [] };
  for (const s of m.scenes) {
    const hit = s.shots.find((c) => c.shotId === selectedShotId);
    if (hit) return { scene: s, shot: hit, shots: s.shots };
  }
  const free = (m.unassigned || []).find((c) => c.shotId === selectedShotId)
    || (m.all || []).find((c) => c.shotId === selectedShotId);
  if (free) {
    const pool = m.scenes.some((s) => s.shots.includes(free))
      ? m.scenes.find((s) => s.shots.includes(free)).shots
      : m.unassigned;
    return { scene: null, shot: free, shots: pool };
  }
  // nothing selected yet — offer the first scene so the strip is never blank
  const first = m.scenes.find((s) => s.shots.length) || null;
  return { scene: first, shot: null, shots: first ? first.shots : m.unassigned };
}

/* -------------------------------------------------------------------------- */
/* render                                                                     */
/* -------------------------------------------------------------------------- */

/** The centre's ONE persistent header: which episode, the way to the full
 *  provenance graph, and the way out to a stage workspace.
 *
 *  It carries no stage tab strip (§8). 「先选功能再找对象」 is exactly what this
 *  round removed. */
function topBar(m, ui, { stage, showFocus, place }) {
  // THE EPISODE / SCENE / SHOT SELECTORS MOVED UP (TASK-066 §2): they belong to the
  // whole space, not to the centre column, so they live in the shared top bar
  // (ui/shotselect.js). What is left here is what the centre itself owns: what this
  // picture is, how it is laid out, and the ways out of it.
  const title = place && place.shot
    ? `${esc(place.shot.title || `镜头 ${place.shot.seq}`)} 制作流程图`
    : "制作流程图";
  // NO FOCUS CHIPS HERE. They used to filter the shot-card wall; the wall became the
  // Shot dropdown (§2), so chips in this header would filter nothing — a control that
  // does nothing is worse than a missing one. They moved INTO the Shot picker, where
  // they narrow the list the creator is choosing from (ui/shotselect.js).
  const focus = "";
  // 完整溯源 — §14 of the previous round still holds: provenance keeps its job and its
  // own workspace, and the entrance is one click from the shot being made.
  const prov = stage === "provenance"
    ? `<button class="ep-wsback" data-mod="${esc(EPISODE_DEFAULT)}">← 回到制作台</button>`
    : `<button class="ep-prov" data-mod="provenance" title="整集的生成溯源：这个东西是怎么来的">完整溯源 ↗</button>`;
  const layout = stage === EPISODE_DEFAULT
    ? `<div class="ep-layout">` +
      ["auto", "manual"].map((k) =>
        `<button class="ep-lbtn${(ui.sgLayout || "auto") === k ? " on" : ""}" data-ep-layout="${k}" ` +
        `title="${k === "auto" ? "按制作顺序自动排布" : "把参考并排铺开，适合参考很多的镜头"}">` +
        `${k === "auto" ? "⊙ 自动布局" : "手动布局"}</button>`).join("") +
      `</div>` +
      `<button class="ep-full" data-ep-full title="${ui.sgFull ? "退出全屏" : "全屏看这张图"}">` +
      `${ui.sgFull ? "⛶ 退出全屏" : "⛶ 全屏"}</button>`
    : "";
  return (
    `<div class="ep-top">` +
    `<b class="ep-title">${esc(title)}</b>` +
    `<span class="ep-i" title="这一镜从参考到最终视频的真实关系；线只画记录里存在的关联">ⓘ</span>` +
    focus +
    `<span class="push"></span>` +
    layout + prov + wsMenu(stage, ui) +
    `</div>`
  );
}

/** The secondary 「工作区」 entry: every stage workspace, one click away, and
 *  visibly NOT a peer of the centre. */
function wsMenu(stage, ui) {
  const onWs = stage !== EPISODE_DEFAULT;
  const cur = EPISODE_WORKSPACES.find(([k]) => k === stage) || null;
  return (
    `<div class="ep-ws">` +
    (onWs && stage !== "provenance"
      ? `<button class="ep-wsback" data-mod="${esc(EPISODE_DEFAULT)}" title="回到制作台">← 制作台</button>`
      : "") +
    `<button class="ep-wsbtn${onWs ? " on" : ""}" data-ep-wsopen>` +
    `<span class="ic">${cur ? cur[1] : "🗂"}</span>${esc(cur ? cur[2] : "工作区")}<span class="cv">▾</span></button>` +
    (ui.epWsOpen
      ? `<div class="ep-wsmenu">` +
        `<div class="ep-wshd">工作区 — 逐个阶段做完一件事</div>` +
        EPISODE_WORKSPACES.map(([k, icon, label]) =>
          `<button class="${k === stage ? "cur" : ""}" data-ep-ws="${esc(k)}">` +
          `<span class="ic">${icon}</span>${esc(label)}</button>`).join("") +
        `<div class="ep-wsnote">这些能力也都能从制作台的图上点节点、在左栏直接操作 —— 工作区只是「一次做完一整个阶段」的绕路。</div>` +
        `</div>`
      : "") +
    `</div>`
  );
}

/** Does this stage have a SHOT PICKER for the focus filter to narrow?
 *
 *  Only the 制作台 does — that is where a shot is chosen. On a stage workspace the
 *  filter would have no list to act on, and on the provenance graph it would sit
 *  beside that graph's own filter chips meaning something different. */
export const showsFocus = (stage) => stage === EPISODE_DEFAULT;

/**
 * The 剧集制作 CENTER.
 *
 * `stage` defaults to the space's own centre — the 制作台. Every other value is one
 * of the existing stage workspaces, which this module does not re-implement — it
 * only frames them.
 *
 * `graph` is the current shot's production graph (already rendered HTML), passed in
 * rather than built here so the shell can hand the same model to `bindShotGraph`
 * and `drawShotEdges` without deriving it twice.
 */
export function renderEpProd(ctx, ui, { stage = EPISODE_DEFAULT, inner = "", graph = null } = {}) {
  const m = workbenchModel(ctx, ui);
  const isCentre = stage === EPISODE_DEFAULT;
  const showFocus = showsFocus(stage);
  if (m.empty) {
    return (
      `<div class="ep-center">` +
      topBar({ episodes: m.episodes, focus: "all", shots: 0, shown: 0 }, ui, { stage, showFocus: false, place: null }) +
      `<div class="st-empty"><div class="ic">📺</div><div class="tt">还没有剧集</div>` +
      `<div class="hh">剧集制作需要一集来做。先在「故事开发 · 分集规划」确认规划，剧集就会建立。</div>` +
      `<button class="btn primary" data-ep-tostory>去故事开发</button></div></div>`
    );
  }
  const place = currentPlace(m, ui.selectedShotId);
  let body;
  if (!isCentre) {
    body = inner;
  } else if (!m.shots) {
    body = m.hasScript
      ? `<div class="st-empty"><div class="ic">🎞</div><div class="tt">剧本有了，还没有拆成镜头</div>` +
        `<div class="hh">在「分镜」里把本集剧本拆成带景别、运镜和时长的镜头草稿。</div>` +
        `<button class="btn primary" data-mod="shots">去分镜</button></div>`
      : `<div class="st-empty"><div class="ic">📄</div><div class="tt">这一集还没有剧本</div>` +
        `<div class="hh">剧集制作从 Episode Script 开始。剧本在「故事开发」里写完，再回到这里。</div>` +
        `<button class="btn primary" data-ep-tostory>去故事开发</button></div>`;
  } else if (graph) {
    body = graph;
  } else {
    // The episode HAS shots but none of them resolves to a selectable one (every
    // shotId in its scenes is missing from the current draft — the draft was
    // regenerated under it). An empty centre here would read as 「坏了」; the truth is
    // that the scenes point at shots that no longer exist, and 分镜 is where that is
    // fixed.
    body =
      `<div class="st-empty"><div class="ic">🎞</div><div class="tt">这一集的镜头都不在当前草稿里</div>` +
      `<div class="hh">场景引用的镜头在当前分镜草稿里找不到——草稿可能被重新生成过。` +
      `在「分镜」里确认草稿版本，或重新把镜头分配到场景。</div>` +
      `<button class="btn primary" data-mod="shots">去分镜</button></div>`;
  }
  return (
    `<div class="ep-center">` +
    topBar(m, ui, { stage, showFocus, place }) +
    `<div class="ep-body${isCentre ? " full" : ""}">${body}</div>` +
    `</div>`
  );
}

/* -------------------------------------------------------------------------- */
/* bind                                                                       */
/* -------------------------------------------------------------------------- */

export function bindEpProd(root, ctx, ui, render, { enterEpisode, setStage, goStory, selectShot } = {}) {
  const on = (q, fn) => { const el = root.querySelector(q); if (el) el.onclick = fn; };

  on("[data-ep-selopen]", () => { ui.epSelOpen = !ui.epSelOpen; render(); });
  root.querySelectorAll("[data-ep-pick]").forEach((b) => (b.onclick = () => {
    ui.epSelOpen = false;
    if (enterEpisode) enterEpisode(b.dataset.epPick);
    else render();
  }));
  root.querySelectorAll("[data-ep-focus]").forEach((b) => (b.onclick = () => {
    ui.epFocus = b.dataset.epFocus;
    render();
  }));
  root.querySelectorAll("[data-ep-tostory]").forEach((b) => (b.onclick = () => {
    if (goStory) goStory();
  }));

  // 工作区 — the secondary entry to a stage workspace. Opening the menu is view
  // state; picking one navigates through the SHELL, which owns the module.
  on("[data-ep-wsopen]", () => { ui.epWsOpen = !ui.epWsOpen; render(); });
  root.querySelectorAll("[data-ep-ws]").forEach((b) => (b.onclick = () => {
    ui.epWsOpen = false;
    if (setStage) setStage(b.dataset.epWs);
    else render();
  }));

  // A SCENE chip moves the current shot to that scene's FIRST shot — a scene is not
  // a thing you produce, so standing on one with no shot selected would leave the
  // centre with nothing to draw. Picking the scene the current shot is already in
  // changes nothing.
  const m = workbenchModel(ctx, ui);
  root.querySelectorAll("[data-ep-scene]").forEach((b) => (b.onclick = () => {
    const sceneId = b.dataset.epScene;
    const pool = sceneId
      ? (m.scenes.find((s) => s.sceneId === sceneId) || { shots: [] }).shots
      : m.unassigned;
    const focused = pool.filter((c) => passesFocus(c, m.focus));
    const next = (focused[0] || pool[0] || null);
    if (next && selectShot) selectShot(next.shotId);
    else render();
  }));
  root.querySelectorAll("[data-ep-shot]").forEach((b) => (b.onclick = () => {
    if (selectShot) selectShot(b.dataset.epShot);
    else render();
  }));

  // 自动布局 / 手动布局 + 全屏 (§8). Both are VIEW state: how the picture is arranged
  // is not a creative decision, so neither is persisted.
  root.querySelectorAll("[data-ep-layout]").forEach((b) => (b.onclick = () => {
    ui.sgLayout = b.dataset.epLayout;
    render();
  }));
  on("[data-ep-full]", () => { ui.sgFull = !ui.sgFull; render(); });

  root.querySelectorAll("[data-mod]").forEach((b) => (b.onclick = () => {
    ui.epWsOpen = false;
    if (setStage) setStage(b.dataset.mod);
  }));
}

/** Human label for a centre tab — used by the breadcrumb so the crumb and the
 *  workspace menu cannot print different names for the same place. */
export const stageLabel = (k) => MODULE_LABEL[k] || k;

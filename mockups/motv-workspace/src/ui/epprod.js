// CENTER column of 剧集制作 — the Production Workspace (ADR-0061 决策 2,
// simplified in TASK-064 Phase 1b).
//
//   Episode Selector (EP01 ▾)                              工作区 ▾
//   ────────────────────────────────────────────────────────────────────────
//   Generation Provenance — the generation graph, full bleed
//
// The GRAPH is this space's centre. Entering 剧集制作 shows what has actually been
// made for this episode and what it was made from; clicking any node makes the
// LEFT inspector that object's operating panel. That is the primary path to
// 参考 / Prompt / 生成 / 画面 / 视频 / 音频 / 审片 now.
//
// WHAT CHANGED AND WHY. This centre used to open on a large Shot Card workbench
// under a strip of ELEVEN same-level tabs (工作台 / 本集总览 / 场景 / 分镜 / 参考统筹 /
// 画面 / 视频 / 音频 / 审片 / 剪辑 / 生成溯源). Eleven peers is not an information
// architecture — it is a list of everything the system can do, and it made the
// creator find 「生成溯源」 by hunting rather than by arriving. The stage
// workspaces all still exist, unchanged, behind one secondary 「工作区」 entry.
//
// The creator never has to answer 「我现在是镜头模式还是场景模式？」: Scene and
// Shot are LEVELS inside one episode, not competing page modes.
//
// This module renders no operating controls of its own — it is the map, not the
// workbench drawer.
//
// PURE PRESENTATION over ctx read models (`episodeModel` from episodews.js is
// reused verbatim, so this surface and 本集总览 can never disagree about what the
// episode contains).

import { esc } from "../util/dom.js";
import { episodeModel } from "./episodews.js";
import {
  episodeLabels, episodeTitleBeside, EPISODE_DEFAULT, EPISODE_WORKSPACES, MODULE_LABEL,
} from "./shell.js";
import { ROLE_LABEL } from "../workflow/geninput.js";

/** The Focus Filters (TASK-064 §7). They narrow WHICH shots are shown by what
 *  each one currently has — a view filter, never a mode. `失败` reads the real
 *  generation registry: a shot whose latest generation failed is a shot that
 *  needs attention, and there is no other way to find it in one look. */
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
  };
}

/* -------------------------------------------------------------------------- */
/* render                                                                     */
/* -------------------------------------------------------------------------- */

/** The centre's ONE persistent header: which episode, and the way out to a stage
 *  workspace. The focus filter is drawn only where it filters something — see
 *  `showsFocus`.
 *
 *  It carries no stage tab strip. The graph is the centre; a workspace is a
 *  detour, and a detour announces itself as one. */
function topBar(m, ui, { stage, showFocus }) {
  const ep = m.episodes.find((e) => e.active) || m.episodes[0] || null;
  const selector = m.episodes.length
    ? `<div class="ep-sel">` +
      `<button class="ep-selbtn" data-ep-selopen>${esc(ep ? ep.code : "—")}` +
      `<span class="nm">${esc(ep ? episodeTitleBeside(ep.code, ep.title) : "")}</span><span class="cv">▾</span></button>` +
      (ui.epSelOpen
        ? `<div class="ep-selmenu">${m.episodes.map((e) =>
            `<button class="${e.active ? "cur" : ""}" data-ep-pick="${esc(e.episodeId)}">` +
            `<b>${esc(e.code)}</b> ${esc(episodeTitleBeside(e.code, e.title))}</button>`).join("")}</div>`
        : "") +
      `</div>`
    : `<span class="chip gate">还没有剧集</span>`;
  // The focus filter narrows SHOT CARDS. On the graph it would be a second
  // filter vocabulary sitting next to the graph's own 全部/图片/视频/音频/渲染/失败
  // chips, and two filter rows that mean different things is worse than one.
  const focus = showFocus
    ? `<div class="ep-focus">${FOCUS_FILTERS.map(([k, label]) =>
        `<button class="ep-fbtn${m.focus === k ? " on" : ""}" data-ep-focus="${k}">${esc(label)}</button>`).join("")}</div>`
    : "";
  const note = showFocus
    ? `<span class="ep-topnote">${m.focus === "all"
        ? `${m.shots} 个镜头`
        : `${m.shown} / ${m.shots} 个镜头符合当前聚焦`}</span>`
    : "";
  return `<div class="ep-top">${selector}${focus}${note}${wsMenu(stage, ui)}</div>`;
}

/** The secondary 「工作区」 entry: every stage workspace, one click away, and
 *  visibly NOT a peer of the centre. When one is open the entry says so and
 *  offers the way back to the graph — a detour the creator can always leave. */
function wsMenu(stage, ui) {
  const onWs = stage !== EPISODE_DEFAULT;
  const cur = EPISODE_WORKSPACES.find(([k]) => k === stage) || null;
  return (
    `<div class="ep-ws">` +
    (onWs
      ? `<button class="ep-wsback" data-mod="${esc(EPISODE_DEFAULT)}" title="回到生成溯源">← 生成溯源</button>`
      : "") +
    `<button class="ep-wsbtn${onWs ? " on" : ""}" data-ep-wsopen>` +
    `<span class="ic">${cur ? cur[1] : "🗂"}</span>${esc(cur ? cur[2] : "工作区")}<span class="cv">▾</span></button>` +
    (ui.epWsOpen
      ? `<div class="ep-wsmenu">` +
        `<div class="ep-wshd">工作区 — 逐个阶段做完一件事</div>` +
        EPISODE_WORKSPACES.map(([k, icon, label]) =>
          `<button class="${k === stage ? "cur" : ""}" data-ep-ws="${esc(k)}">` +
          `<span class="ic">${icon}</span>${esc(label)}</button>`).join("") +
        `<div class="ep-wsnote">这些能力也都能从中央生成溯源图上点节点、在左栏直接操作。</div>` +
        `</div>`
      : "") +
    `</div>`
  );
}

/** One shot card. Its SUB-CARDS are the production objects — clicking one opens
 *  that object in the LEFT inspector, which is the whole point of the layout. */
function shotCard(c, selectedId, inspectKind) {
  const on = c.shotId === selectedId;
  const thumb = c.hasVideo
    ? `<video class="ep-cardth" src="${esc(c.videoUrl)}" preload="metadata" muted playsinline></video>`
    : c.hasImage
      ? `<img class="ep-cardth" src="${esc(c.imageUrl)}" alt="" loading="lazy">`
      : `<div class="ep-cardth none">🎞</div>`;
  const sub = (kind, label, state) =>
    `<button class="ep-sub ${state}${on && inspectKind === kind ? " on" : ""}" ` +
    `data-ep-card="${esc(c.shotId)}" data-ep-kind="${kind}">${esc(label)}</button>`;
  const refState = c.references.length ? "ok" : "none";
  return (
    `<div class="ep-card${on ? " on" : ""}${c.approved ? " ok" : ""}" data-ep-select="${esc(c.shotId)}">` +
    `<div class="ep-cardhead">${thumb}` +
    `<div class="ep-cardmeta"><div class="ep-cardt">${esc(c.title)}</div>` +
    `<div class="ep-cards">${[c.shotSize, c.angle, c.duration ? `${c.duration}s` : ""].filter(Boolean).map(esc).join(" · ")}</div>` +
    `<div class="ep-cardchips"><span class="chip${c.approved ? " ok" : ""}">${esc(c.stageLabel)}</span>` +
    (c.lastGenerationFailed ? `<span class="chip bad">上次生成失败</span>` : "") +
    `</div></div></div>` +
    (c.references.length
      ? `<div class="ep-cardrefs">${c.references.map((r) =>
          `<span class="ep-refchip" title="${esc(ROLE_LABEL[r.kind] || r.kind || "")}">${esc(r.name)}</span>`).join("")}</div>`
      : "") +
    `<div class="ep-subs">` +
    sub("reference", `参考 ${c.references.length || ""}`.trim(), refState) +
    sub("prompt", "Prompt", "ok") +
    sub("generation", "生成", c.lastGenerationFailed ? "bad" : "ok") +
    sub("image", "画面", c.hasImage ? "ok" : "none") +
    sub("video", "视频", c.hasVideo ? "ok" : "none") +
    sub("audio", "音频", c.hasAudio ? "ok" : "none") +
    `</div></div>`
  );
}

function sceneBlock(s, selectedId, inspectKind, focus) {
  const hidden = s.shots.length - s.visible.length;
  return (
    `<section class="ep-scenesec">` +
    `<header class="ep-scenehd"><h3>${esc(s.title)}</h3>` +
    `<span class="ep-scenen">${s.shots.length} 个镜头</span>` +
    (hidden ? `<span class="chip mute">${hidden} 个不在当前聚焦</span>` : "") +
    `</header>` +
    (s.visible.length
      ? `<div class="ep-cards">${s.visible.map((c) => shotCard(c, selectedId, inspectKind)).join("")}</div>`
      : `<div class="ep-none">这个场景没有镜头符合当前聚焦。</div>`) +
    (s.dangling
      ? `<div class="ep-dangling">${s.dangling} 个镜头引用在当前草稿里找不到（草稿可能被重新生成）</div>`
      : "") +
    `</section>`
  );
}

/** Does this centre stage have shot cards for the focus filter to filter? */
export const showsFocus = (stage) => stage === "workbench";

/** The 剧集制作 CENTER. `stage` defaults to the space's own centre — the
 *  generation graph. Every other value is one of the existing stage workspaces,
 *  which this module does not re-implement — it only frames them. */
export function renderEpProd(ctx, ui, { stage = EPISODE_DEFAULT, inner = "" } = {}) {
  const m = workbenchModel(ctx, ui);
  const showFocus = showsFocus(stage);
  if (m.empty) {
    return (
      `<div class="ep-center">` +
      topBar({ episodes: m.episodes, focus: "all", shots: 0, shown: 0 }, ui, { stage, showFocus }) +
      `<div class="st-empty"><div class="ic">📺</div><div class="tt">还没有剧集</div>` +
      `<div class="hh">剧集制作需要一集来做。先在「故事开发 · 分集规划」确认规划，剧集就会建立。</div>` +
      `<button class="btn primary" data-ep-tostory>去故事开发</button></div></div>`
    );
  }
  const body = stage === "workbench"
    ? (m.shots
        ? m.scenes.map((s) => sceneBlock(s, ui.selectedShotId, (ui.inspect && ui.inspect.kind) || "shot", m.focus)).join("") +
          (m.unassigned.length
            ? `<section class="ep-scenesec"><header class="ep-scenehd"><h3>未分配到场景</h3>` +
              `<span class="ep-scenen">${m.unassignedTotal} 个镜头</span></header>` +
              `<div class="ep-cards">${m.unassigned.map((c) => shotCard(c, ui.selectedShotId, (ui.inspect && ui.inspect.kind) || "shot")).join("")}</div></section>`
            : "")
        : m.hasScript
          ? `<div class="st-empty"><div class="ic">🎞</div><div class="tt">剧本有了，还没有拆成镜头</div>` +
            `<div class="hh">在「分镜」里把本集剧本拆成带景别、运镜和时长的镜头草稿。</div>` +
            `<button class="btn primary" data-mod="shots">去分镜</button></div>`
          : `<div class="st-empty"><div class="ic">📄</div><div class="tt">这一集还没有剧本</div>` +
            `<div class="hh">剧集制作从 Episode Script 开始。剧本在「故事开发」里写完，再回到这里。</div>` +
            `<button class="btn primary" data-ep-tostory>去故事开发</button></div>`)
    : inner;
  const c = m.counts;
  const summary = m.shots
    ? `<div class="ep-summary">${esc(m.episodeTitle)} · 已通过 ${c.approved} · 待审 ${c["todo-review"]} · ` +
      `已生成 ${c.generated} · 待生成 ${c["todo-generate"]} · 待设计 ${c["todo-design"]}</div>`
    : "";
  return (
    `<div class="ep-center">` +
    topBar(m, ui, { stage, showFocus }) +
    (stage === "workbench" ? summary : "") +
    `<div class="ep-body${stage === EPISODE_DEFAULT ? " full" : ""}">${body}</div>` +
    `</div>`
  );
}

/* -------------------------------------------------------------------------- */
/* bind                                                                       */
/* -------------------------------------------------------------------------- */

export function bindEpProd(root, ctx, ui, render, { enterEpisode, setStage, goStory } = {}) {
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

  // A card SELECTS the shot; a sub-card additionally chooses which of its objects
  // the LEFT inspector operates on. Both are pure view state.
  root.querySelectorAll("[data-ep-select]").forEach((b) => (b.onclick = () => {
    const id = b.dataset.epSelect;
    if (ui.selectedShotId === id) return;
    ui.selectedShotId = id;
    ui.inspect = { ...(ui.inspect || {}), kind: (ui.inspect && ui.inspect.kind) || "shot", shotId: id };
    ui.piPrompt = null;
    render();
  }));
  root.querySelectorAll("[data-ep-card]").forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation();
    const shotId = b.dataset.epCard;
    const kind = b.dataset.epKind;
    ui.selectedShotId = shotId;
    ui.inspect = { ...(ui.inspect || {}), kind, shotId };
    ui.piPrompt = null;
    render();
  }));
  root.querySelectorAll("[data-mod]").forEach((b) => (b.onclick = () => {
    ui.epWsOpen = false;
    if (setStage) setStage(b.dataset.mod);
  }));
}

/** Human label for a centre tab — used by the breadcrumb so the crumb and the
 *  tab strip cannot print different names for the same place. */
export const stageLabel = (k) => MODULE_LABEL[k] || k;

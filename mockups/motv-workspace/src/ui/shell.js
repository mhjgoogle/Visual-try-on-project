// StudioShell chrome — the parts of the Production studio that are always on
// screen: the breadcrumb, the left rail (project · episode selector · current
// episode's production stages) and the shared header/empty primitives every
// workspace composes with.
//
// PURE PRESENTATION over view-models. It reads the production document for the
// episode list and the badge counts, and owns no state of its own — the module
// selection lives on the shell in production.js (transient), never persisted.
import { esc } from "../util/dom.js";

/** The rail's PRIMARY navigation: 作品开发 — building the creative foundation of
 *  the whole work (ADR-0054 决策 1). The downstream production stages
 *  (画面 / 视频 / 音频 / 剪辑) are deliberately NOT here: they belong to ONE
 *  episode, so they live under the episode the creator entered (EPISODE_NAV),
 *  never in the project-level rail. `assets` is the top bar's 资产 mode and is
 *  absent from the rail entirely. Exported for tests.
 *
 *  An item is `[key, icon, label]`, optionally followed by `{ under }` — the
 *  sub-heading it is grouped beneath (作品设定 groups 人物 / 人物关系 / 世界观).
 *  These four steps are a creative WORKSPACE, not a wizard: every one is
 *  reachable at any time, in any order. */
export const NAV = [
  {
    sec: "作品开发",
    items: [
      ["brief", "💡", "创意"],
      ["story", "📖", "故事大纲"],
      ["characters", "👤", "人物", { under: "作品设定" }],
      ["relationships", "🔗", "人物关系", { under: "作品设定" }],
      ["world", "🌐", "世界观", { under: "作品设定" }],
      ["episodes", "📺", "分集规划"],
    ],
  },
];

/** The EPISODE's own production stages. Shown nested under the episode the
 *  creator has entered — Production's exit, not its main navigation. */
export const EPISODE_NAV = [
  // CP6/ADR-0058: 本集制作 leads, because it IS the work — one creative context
  // holding this episode's script, its scenes, and every scene's shots with the
  // picture each one currently has. The stage modules below it stay exactly as
  // they were: they are how you work THROUGH one stage, not how you see the
  // episode.
  ["episode", "🎬", "本集制作"],
  ["script", "📄", "剧本"],
  ["scenes", "🗂", "场景"],
  ["shots", "🎞", "分镜"],
  ["refplan", "🖼", "参考统筹"],
  ["frames", "🎨", "画面"],
  ["video", "▶", "视频"],
  ["audio", "🎵", "音频"],
  // CP4/ADR-0057: 审片 sits between the media stages and the cut, because that
  // is where it belongs in the work — you review what was generated before you
  // assemble it. 生成成功 != 镜头完成.
  ["dailies", "👁", "审片"],
  ["edit", "✂", "剪辑"],
];

/** Modules that belong to ONE episode. The rail renders the episode context
 *  exactly when one of these is active — no extra shell state to keep in sync. */
export const EPISODE_MODULES = EPISODE_NAV.map(([k]) => k);

/** Stage keys that carry a completion ratio — the rail draws their progress
 *  bar. Keyed to the same badge model so the bar can never disagree with the
 *  number printed beside it. */
export const STAGE_KEYS = ["frames", "video", "audio", "dailies"];

export const MODULE_LABEL = {
  brief: "创意", story: "故事大纲", characters: "人物", relationships: "人物关系",
  world: "世界观", episodes: "分集规划",
  // `settings` stays a working module key (the bible workspace behind 人物) so
  // every existing jump target — the Director's blocker fixes, the shot
  // workspaces' empty states — keeps landing somewhere real.
  settings: "作品设定", storage: "存储", assets: "资产库",
  episode: "本集制作", script: "剧本", scenes: "场景", shots: "分镜",
  refplan: "参考统筹", frames: "画面", video: "视频",
  audio: "音频", dailies: "审片", edit: "剪辑",
};

/** Episode short label: EP01, EP02… derived from position, with the planned
 *  title carried separately (never parsed out of the title string). */
export function episodeLabels(prod) {
  return prod.episodes.map((e, i) => ({
    episodeId: e.episodeId,
    code: `EP${String(i + 1).padStart(2, "0")}`,
    title: e.title,
    active: e.episodeId === prod.activeEpisodeId,
  }));
}

/** The rail's HTML.
 *
 *  Two levels, in this order (ADR-0054 决策 1):
 *    作品开发   the project-level upstream — always the primary navigation
 *    Episodes  the episode list, Production's EXIT; the entered episode
 *              expands to show ITS production stages, nested
 *
 *  `ratios` maps a stage key to {done,total} where known; `episodeMode` is
 *  simply "the active module belongs to an episode", so there is no separate
 *  navigation state that could disagree with what is on screen. */
export function renderRail({ activeModule, badges, episodes, ratios, episodeMode, upstream }) {
  const item = ([k, icon, label], cls = "") => {
    const b = badges[k];
    const r = ratios[k];
    const pct = r && r.total ? Math.round((r.done / r.total) * 100) : 0;
    const bar = r && r.total
      ? `<span class="bar${pct === 100 ? " done" : ""}"><i style="width:${pct}%"></i></span>`
      : "";
    return (
      `<button class="st-navitem${bar ? " st-stage" : ""}${cls ? ` ${cls}` : ""}${k === activeModule ? " on" : ""}" data-mod="${k}">` +
      `<span class="ic">${icon}</span><span class="nm">${esc(label)}</span>` +
      (b ? `<span class="bdg${String(b).startsWith("✓") ? " ok" : ""}">${esc(b)}</span>` : "") +
      bar +
      `</button>`
    );
  };
  // 作品开发, with 作品设定 as a sub-heading over its three creator surfaces
  let sub = null;
  const upstreamHtml = NAV.map((grp) => {
    const rows = grp.items
      .map((it) => {
        const under = it[3] && it[3].under ? it[3].under : null;
        let head = "";
        if (under !== sub) {
          sub = under;
          if (under) head = `<div class="st-railsub">${esc(under)}</div>`;
        }
        return head + item(it, under ? "st-subitem" : "");
      })
      .join("");
    return `<div class="st-railsec">${esc(grp.sec)}</div>${rows}`;
  }).join("");

  // Episodes — the exit. Every episode is a row (code + planned title); the one
  // being worked in carries the nested 本集制作 stages.
  const epRows = episodes.length
    ? episodes
        .map((e) => {
          const open = episodeMode && e.active;
          const flag = upstream && upstream[e.episodeId]
            ? `<span class="bdg gate" title="上游已变化，本集仍基于另一个版本">${upstream[e.episodeId]} 变化</span>`
            : "";
          return (
            `<button class="st-navitem st-eprow${e.active ? " on" : ""}" data-ep="${esc(e.episodeId)}" title="${esc(e.title)}">` +
            `<span class="ic">${open ? "▾" : "▸"}</span><span class="nm">${esc(e.code)} ${esc(e.title)}</span>${flag}</button>` +
            (open ? EPISODE_NAV.map((it) => item(it, "st-subitem")).join("") : "")
          );
        })
        .join("")
    : `<div class="st-railnote">还没有剧集 — 在「分集规划」确认规划后建立</div>`;

  return (
    upstreamHtml +
    `<div class="st-railsec">Episodes</div>` +
    epRows
  );
}

/** The persistent breadcrumb: Project › Episode › Scene › Shot › Module. Only
 *  segments that really exist are shown — no placeholder crumbs. */
export function renderCrumb({ project, episode, scene, shot, module, tail }) {
  const seg = [];
  seg.push(`<span>📁 ${esc(project)}</span>`);
  if (episode) seg.push(`<span class="sep">›</span><span>${esc(episode)}</span>`);
  if (scene) seg.push(`<span class="sep">›</span><span>${esc(scene)}</span>`);
  if (shot) seg.push(`<span class="sep">›</span><span>${esc(shot)}</span>`);
  seg.push(`<span class="sep">›</span><span class="cur">${esc(module)}</span>`);
  return `<header class="st-crumb">${seg.join("")}${tail ? `<span class="tail">${tail}</span>` : ""}</header>`;
}

/** Standard workspace header. */
export function head(title, sub, actions = "") {
  return (
    `<div class="st-head"><div class="st-title">${esc(title)}</div>` +
    (sub ? `<div class="st-sub">${esc(sub)}</div>` : "") +
    (actions ? `<div class="acts">${actions}</div>` : "") +
    `</div>`
  );
}

/** Standard empty state — always says what is missing AND the way forward. */
export function empty(icon, title, hint, action = "") {
  return (
    `<div class="st-empty"><div class="ic">${icon}</div><div class="tt">${esc(title)}</div>` +
    `<div class="hh">${esc(hint)}</div>${action}</div>`
  );
}

/** A media box: real thumbnail, or an honest placeholder that says WHY. */
export function mediaBox(url, { alt = "", missing = "还没有画面", icon = "🎞", cls = "" } = {}) {
  return url
    ? `<img class="media ${cls}" src="${esc(url)}" alt="${esc(alt)}" loading="lazy">`
    : `<div class="media media-none ${cls}"><span class="ic">${icon}</span><span>${esc(missing)}</span></div>`;
}

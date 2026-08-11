// StudioShell chrome — the parts of the Production studio that are always on
// screen: the breadcrumb, the left rail (project · episode selector · current
// episode's production stages) and the shared header/empty primitives every
// workspace composes with.
//
// PURE PRESENTATION over view-models. It reads the production document for the
// episode list and the badge counts, and owns no state of its own — the module
// selection lives on the shell in production.js (transient), never persisted.
import { esc } from "../util/dom.js";

/** Grouped rail navigation. `assets` is reachable from the top bar's 资产 mode
 *  (spec §11) and deliberately absent here — the rail is the PROJECT and the
 *  CURRENT EPISODE, nothing else. Exported for tests. */
export const NAV = [
  {
    sec: "项目",
    items: [
      ["story", "📖", "故事"],
      ["settings", "🎭", "作品设定"],
      ["episodes", "📺", "剧集"],
    ],
  },
  {
    sec: "本集制作",
    items: [
      ["script", "📄", "剧本"],
      ["shots", "🎬", "分镜"],
      ["frames", "🖼", "画面"],
      ["video", "▶", "视频"],
      ["audio", "🎵", "音频"],
      ["edit", "✂", "剪辑"],
    ],
  },
];

/** Stage keys that carry a completion ratio — the rail draws their progress
 *  bar. Keyed to the same badge model so the bar can never disagree with the
 *  number printed beside it. */
export const STAGE_KEYS = ["frames", "video", "audio"];

export const MODULE_LABEL = {
  story: "故事", settings: "作品设定", episodes: "剧集", storage: "存储", assets: "资产库",
  script: "剧本", shots: "分镜", frames: "画面", video: "视频", audio: "音频", edit: "剪辑",
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

/** The rail's HTML. `ratios` maps a stage key to {done,total} where known. */
export function renderRail({ activeModule, badges, episodes, ratios }) {
  const item = ([k, icon, label]) => {
    const b = badges[k];
    const r = ratios[k];
    const pct = r && r.total ? Math.round((r.done / r.total) * 100) : 0;
    const bar = r && r.total
      ? `<span class="bar${pct === 100 ? " done" : ""}"><i style="width:${pct}%"></i></span>`
      : "";
    return (
      `<button class="st-navitem${bar ? " st-stage" : ""}${k === activeModule ? " on" : ""}" data-mod="${k}">` +
      `<span class="ic">${icon}</span><span class="nm">${esc(label)}</span>` +
      (b ? `<span class="bdg${String(b).startsWith("✓") ? " ok" : ""}">${esc(b)}</span>` : "") +
      bar +
      `</button>`
    );
  };
  const eps = episodes.length
    ? `<div class="st-eps">${episodes
        .map((e) => `<button class="st-ep${e.active ? " on" : ""}" data-ep="${esc(e.episodeId)}" title="${esc(e.title)}">${esc(e.code)}</button>`)
        .join("")}</div>`
    : "";
  return NAV.map((grp, gi) => {
    const head = `<div class="st-railsec">${esc(grp.sec)}</div>`;
    // the episode selector sits between the two groups: it is what SWITCHES
    // the "本集制作" group's subject
    return (gi === 1 ? eps : "") + head + grp.items.map(item).join("");
  }).join("");
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

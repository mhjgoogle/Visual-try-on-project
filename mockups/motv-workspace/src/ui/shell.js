// StudioShell chrome — the parts of the Production studio that are always on
// screen: the breadcrumb, the left rail (project · episode selector · current
// episode's production stages) and the shared header/empty primitives every
// workspace composes with.
//
// PURE PRESENTATION over view-models. It reads the production document for the
// episode list and the badge counts, and owns no state of its own — the module
// selection lives on the shell in production.js (transient), never persisted.
import { esc } from "../util/dom.js";

/** The rail's PRIMARY navigation: 故事开发 — writing the story (ADR-0061 决策 1).
 *  Its end point is每一集的 Episode Script; from there the creator leaves for
 *  剧集制作. The media production stages (画面 / 视频 / 音频 / 审片 / 剪辑) are
 *  deliberately NOT here and no longer nest under the episode row either: they
 *  belong to the 剧集制作 space, which is a top-level space of its own.
 *  `assets` is the top bar's 资产库 space and is absent from the rail entirely.
 *  Exported for tests.
 *
 *  An item is `[key, icon, label]`, optionally followed by `{ under }` — the
 *  sub-heading it is grouped beneath (作品设定 groups 人物 / 人物关系 / 世界观).
 *  These steps are a creative WORKSPACE, not a wizard: every one is reachable at
 *  any time, in any order. */
export const NAV = [
  {
    sec: "故事开发",
    items: [
      ["brief", "💡", "创意"],
      ["story", "📖", "故事大纲"],
      ["characters", "👤", "人物", { under: "作品设定" }],
      ["relationships", "🔗", "人物关系", { under: "作品设定" }],
      ["world", "🌐", "世界观", { under: "作品设定" }],
      ["episodes", "📺", "分集规划"],
      // 剧本 is the LAST step of story development: story development ends at
      // each episode's script, and 剧集制作 begins from it (ADR-0061 决策 1).
      ["script", "📄", "本集剧本"],
    ],
  },
];

/** The 剧集制作 space's DEFAULT centre (TASK-064 Phase 1b).
 *
 *  The generation graph IS this space's centre, not one of eleven tabs on it.
 *  Entering 剧集制作 lands here: the creator sees what has actually been made for
 *  this episode and what it was made from, and clicks a node to operate on it in
 *  the LEFT inspector. Making them cross a large Shot Card workbench first and
 *  then go hunting for 「生成溯源」 inverted that. */
export const EPISODE_DEFAULT = "provenance";

/** The EPISODE's own production stages (ADR-0061 决策 2), no longer a rail nested
 *  under an episode row — and no longer eleven same-level tabs either.
 *
 *  `provenance` leads because it is the space's centre (see EPISODE_DEFAULT).
 *  Everything after it is a WORKSPACE for working through one stage: still
 *  reachable, still unmodified, but reached from one secondary 「工作区」 entry
 *  instead of competing with the graph for the creator's attention. The primary
 *  path to all of these capabilities is now: graph node → LEFT inspector.
 *
 *  Nothing was deleted. 参考 / Prompt / 生成 / 画面 / 视频 / 音频 / 审片 all keep
 *  their full workspace AND gained a node entrance. */
export const EPISODE_NAV = [
  // ADR-0061 决策 1: 生成溯源 is a VIEW of this space, not a second workflow
  // model. 流程画布 is deliberately absent from every creator path.
  ["provenance", "🕸", "生成溯源"],
  ["workbench", "🎬", "工作台"],
  ["episode", "📺", "本集总览"],
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
  // 剪辑 stays reachable in this space. ADR-0061 决策 6 moves the CUT into a
  // Post Production Console at the bottom of 剧集制作, but that console is not
  // built yet — dropping the entry before it exists would leave the working
  // timeline workspace unreachable and `spaceOf("edit")` answering 「故事开发」,
  // which is a regression, not a migration (codex review round 1).
  ["edit", "✂", "剪辑"],
];

/** The stage workspaces behind the secondary 「工作区」 entry — EPISODE_NAV minus
 *  the space's own centre. Derived, so a stage can never be listed twice or be
 *  forgotten by one of the two surfaces. */
export const EPISODE_WORKSPACES = EPISODE_NAV.filter(([k]) => k !== EPISODE_DEFAULT);

/** The 资产库 space's rail (ADR-0061 决策 1): 「我有什么可以复用？」 — media
 *  categories, never production navigation. Episode / Scene / Shot survive here
 *  only as FILTERS, which the asset workspace owns. */
export const ASSET_NAV = [
  ["assets", "📦", "全部资产"],
  ["assets:reference", "🖼", "References"],
  ["assets:image", "🎨", "Images"],
  ["assets:video", "▶", "Videos"],
  ["assets:audio", "🎵", "Audio"],
  ["assets:final", "🎬", "Final"],
  ["assets:collection", "🏷", "Collections"],
  ["storage", "💾", "存储管理"],
];

/** Stage keys that belong to ONE episode — the 剧集制作 space's centre tabs. */
export const EPISODE_MODULES = EPISODE_NAV.map(([k]) => k);

/** Which top-level SPACE a module belongs to (ADR-0061 决策 1). One function,
 *  so the top bar, the rail and the breadcrumb can never disagree about where
 *  the creator is. */
export const SPACES = ["story", "episode", "assets"];

export function spaceOf(module) {
  if (typeof module !== "string" || !module) return "story";
  if (module === "storage" || module === "assets" || module.startsWith("assets:")) return "assets";
  if (EPISODE_MODULES.includes(module)) return "episode";
  return "story";
}

export const SPACE_LABEL = { story: "故事开发", episode: "剧集制作", assets: "资产库" };

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
  settings: "作品设定", storage: "存储管理", assets: "资产库",
  "assets:reference": "References", "assets:image": "Images",
  "assets:video": "Videos", "assets:audio": "Audio",
  "assets:final": "Final", "assets:collection": "Collections",
  workbench: "工作台", provenance: "生成溯源",
  episode: "本集总览", script: "本集剧本", scenes: "场景", shots: "分镜",
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

/** The title to print BESIDE the code, without saying the code twice.
 *
 *  A planned title very often already begins with 「EP01」 (the plan writes it
 *  that way), and 「EP01 EP01 沉默酒吧」 is the result of printing both blindly.
 *  The code is still derived from POSITION and still authoritative — this only
 *  drops a duplicate prefix from the display, and never rewrites the stored
 *  title. */
export function episodeTitleBeside(code, title) {
  const t = String(title || "").trim();
  if (!t.startsWith(code)) return t;
  return t.slice(code.length).replace(/^[\s·:：|-]+/, "");
}

/** The 故事开发 rail's HTML.
 *
 *  Two levels, in this order (ADR-0061 决策 1):
 *    故事开发   creative brief → outline → 作品设定 → 分集规划 → 本集剧本
 *    Episodes  the episode list — story development's EXIT. A row switches the
 *              active episode; its 「进入剧集制作 →」 leaves for that space.
 *              The production stages are NOT nested here any more: they belong
 *              to the 剧集制作 space, which is a top-level space of its own.
 *
 *  `ratios` maps a stage key to {done,total} where known. */
export function renderRail({ activeModule, badges, episodes, ratios, upstream }) {
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

  // Episodes — story development's EXIT.
  //
  // TWO DIFFERENT ACTIONS, and conflating them was the bug. A ROW only SELECTS:
  // it makes that episode the one whose script is being written and expands it,
  // and it leaves the creator exactly where they are. 「进入剧集制作 →」 is the
  // ONE explicit cross-space entrance. A row that silently switched workspace
  // meant the creator could not look at EP02 without being moved out of 故事开发,
  // and the top bar then disagreed about where they were.
  //
  // No production stage is nested here: 剧集制作 is a space, not a sub-tree.
  const epRows = episodes.length
    ? episodes
        .map((e) => {
          const flag = upstream && upstream[e.episodeId]
            ? `<span class="bdg gate" title="上游已变化，本集仍基于另一个版本">${upstream[e.episodeId]} 变化</span>`
            : "";
          return (
            `<button class="st-navitem st-eprow${e.active ? " on" : ""}" data-ep-choose="${esc(e.episodeId)}" ` +
            `title="${esc(e.title)} — 选中并展开这一集（不会离开故事开发）">` +
            `<span class="ic">${e.active ? "▾" : "▸"}</span><span class="nm">${esc(e.code)} ${esc(e.title)}</span>${flag}</button>` +
            (e.active
              ? `<button class="st-navitem st-subitem st-epexit" data-ep-produce="${esc(e.episodeId)}" ` +
                `title="带着 ${esc(e.code)} 切换到「剧集制作」">` +
                `<span class="ic">🎬</span><span class="nm">进入剧集制作 →</span></button>`
              : "")
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

/** The 资产库 rail. Media categories only — no production navigation, which is
 *  exactly what 资产库 IA cleanup means (ADR-0061 决策 1 / TASK-064 §15). */
export function renderAssetRail({ activeModule, counts = {} }) {
  const rows = ASSET_NAV.map(([k, icon, label]) => {
    const n = counts[k];
    return (
      `<button class="st-navitem${k === activeModule ? " on" : ""}" data-mod="${esc(k)}">` +
      `<span class="ic">${icon}</span><span class="nm">${esc(label)}</span>` +
      (n ? `<span class="bdg">${esc(String(n))}</span>` : "") +
      `</button>`
    );
  }).join("");
  return `<div class="st-railsec">当前项目</div>${rows}`;
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

/** An asset's name plus its version chip — WITHOUT saying the version twice.
 *
 *  `assetreg.derivedLabel` falls back to 「人物参考 v1」 when the creator has not
 *  named the asset, so a version chip printed beside it read 「人物参考 v1 v1」.
 *  Once named 「林晚 Ref」 the chip is the only place the version appears and is
 *  needed. Deciding from the label itself keeps both cases right without a
 *  second labelling API for callers to pick the wrong one of. */
export function nameWithVersion(name, version) {
  const n = String(name || "");
  return n.endsWith(`v${version}`)
    ? esc(n)
    : `${esc(n)} <span class="chip">v${esc(String(version))}</span>`;
}

/** A media box: real thumbnail, or an honest placeholder that says WHY. */
export function mediaBox(url, { alt = "", missing = "还没有画面", icon = "🎞", cls = "" } = {}) {
  return url
    ? `<img class="media ${cls}" src="${esc(url)}" alt="${esc(alt)}" loading="lazy">`
    : `<div class="media media-none ${cls}"><span class="ic">${icon}</span><span>${esc(missing)}</span></div>`;
}

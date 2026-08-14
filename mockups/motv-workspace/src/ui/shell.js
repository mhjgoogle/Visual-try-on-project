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
      // TASK-073 §1.1 / IA §1–§2: the FIXED set — 三空间 / 十一页. This space holds
      // five of the eleven. 人物 / 人物关系 / 世界观 collapse into ONE page (③ 作品
      // 设定) whose sections they become; every old key still resolves, through
      // `resolveModule` rather than through a rail row of its own.
      ["brief", "💡", "项目与创意"],
      ["story", "📖", "故事大纲"],
      ["settings", "🎭", "作品设定"],
      ["episodes", "📺", "分集规划"],
      // 剧本 is the LAST step of story development: story development ends at
      // each episode's script, and 剧集制作 begins from it (ADR-0061 决策 1).
      ["script", "📄", "本集剧本"],
    ],
  },
];

/** The 剧集制作 space's DEFAULT centre (TASK-065 §5 / §9).
 *
 *  制作台 — 「我现在在做哪一个镜头，它怎么被做出来」. A light Scene → Shot picker over
 *  the CURRENT SHOT's production graph.
 *
 *  WHY IT MOVED OFF `provenance`. TASK-064 Phase 1b made the episode-wide generation
 *  graph the centre, which fixed a real problem (eleven same-level tabs) but
 *  answered the wrong question first: provenance is 「这个东西是怎么来的」, which
 *  matters AFTER something exists. A creator entering 剧集制作 is here to make the
 *  next shot, and an episode-wide graph buries that shot in everything else.
 *
 *  生成溯源 lost nothing: it is a workspace with a permanent 「完整溯源 ↗」 entrance in
 *  the centre header (§14). */
export const EPISODE_DEFAULT = "board";

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
  // TASK-073 §1.1: FIVE pages, down from eleven same-level tabs. This is a
  // regrouping, NOT a removal — every capability behind the old eleven keys is
  // still reachable, as a SECTION of one of these five (see MODULE_ALIAS). What
  // was deleted is the entrance, never the ability (§0 的 一条贯穿全卡的规则).
  ["board", "📋", "本集看板"],
  ["storyboard", "🎞", "分镜设计"],
  ["shotwork", "🎬", "镜头制作"],
  ["cutreview", "👁", "粗剪审片"],
  ["delivery", "✂", "后期交付"],
];

/** ⚙ 项目设置 — its OWN route key, deliberately not `settings` (§1.7).
 *
 *  `settings` is already the formal key of ③ 作品设定. Sharing one key between
 *  them would send every existing deep link and bookmark to the wrong page, so
 *  the two are separate keys that resolve to separate pages — asserted by a
 *  guard test, because this is the kind of collision that reads as correct.
 *
 *  Not part of any space's rail (§1.7): it is reached from the project header. */
export const PROJECT_SETTINGS = "projectsettings";

/**
 * WHERE EVERY OLD MODULE KEY LANDS (§1.1 落点表).
 *
 * Each entry is `[page, section]`. A key that resolved to something before this
 * refactor must still resolve to a REAL page AND a section that is actually
 * rendered — 「落到一个没有该内容的页面」 and 「落空」 are the same failure
 * (ADR-0063 决策 1), which is why `workbench` and `provenance` are dispatched by
 * WHAT THEY DID rather than to the nearest-looking page:
 *
 *   workbench   made ONE shot          → ⑧ 镜头制作
 *   provenance  an episode-wide graph  → ⚙ 存储与诊断 (a diagnostic, not a
 *                                        production page)
 */
export const MODULE_ALIAS = Object.freeze({
  // ③ 作品设定 — three creator surfaces became three sections of one page
  characters: ["settings", "characters"],
  relationships: ["settings", "relationships"],
  world: ["settings", "world"],
  // ⑥ 本集看板
  episode: ["board", "overview"],
  // ⑦ 分镜设计
  scenes: ["storyboard", "scenes"],
  shots: ["storyboard", "shots"],
  // ⑧ 镜头制作 — the four steps of one shot's production
  workbench: ["shotwork", "prepare"],
  refplan: ["shotwork", "prepare"],
  frames: ["shotwork", "image"],
  video: ["shotwork", "video"],
  // 审片 defaults to the SINGLE-SHOT step ④; the episode-wide playback lives in
  // ⑨ and is reached from there (§1.1: 「按来源上下文决定」 — the default is the
  // shot, because that is what the old 审片 workspace opened on)
  dailies: ["shotwork", "pick"],
  // ⑩ 后期交付
  audio: ["delivery", "voice"],
  edit: ["delivery", "timeline"],
  // ⚙ 项目设置
  provenance: [PROJECT_SETTINGS, "storage"],
  storage: [PROJECT_SETTINGS, "storage"],
});

/** The asset-library rail is no longer the ENTRANCE (§1.1: `ASSET_NAV` 删除 means
 *  the rail stops being navigation). Its seven entries were seven near-identical
 *  workspaces over one library; they are now PRESET FILTER VALUES on the single
 *  ⑪ 资产库 page. The keys still resolve — to the library with its type filter set,
 *  which is what those rows always did.
 *
 *  `ASSET_NAV` / `renderAssetRail` themselves are KEPT below: removing the export
 *  in this round would break every current caller, and this card deletes entrances,
 *  not code (TASK-074 §1.5 does the deletion, after real-project acceptance). */
export const ASSET_FILTER_ALIAS = Object.freeze({
  "assets:reference": "reference",
  "assets:image": "image",
  "assets:video": "video",
  "assets:audio": "audio",
  "assets:final": "final",
  "assets:collection": "collection",
});

/**
 * WHERE 「进入剧集制作 →」 lands (产品 2026-08-13).
 *
 *   没有分镜 → 分镜      generate the shot list, edit it, settle it
 *   已有分镜 → 制作台    work shot by shot
 *
 * 「定好分镜之后再对各个分镜做详细制作」 — an episode with no shot draft has nothing
 * to produce yet, and the 制作台 would open on 「先选一个镜头」 with no shots to
 * select. Exported (and pure) so the rule is one line with a guard on it, rather
 * than a condition buried in a shell closure that only a browser can reach.
 */
export function episodeEntryModule(hasShots) {
  // TASK-073 §1.1 keeps the RULE and moves its two targets onto the new pages, via
  // the same 落点表 every other key follows: 分镜 → ⑦ 分镜设计, 制作台 → ⑧ 镜头制作.
  // `EPISODE_DEFAULT` (本集看板) is deliberately NOT the answer here — it is where
  // the space opens when nothing more specific is known, while this function is the
  // explicit 「进入剧集制作」 landing, which is about doing the next piece of work.
  return hasShots ? "shotwork" : "storyboard";
}

/**
 * The ELEVEN old episode stages — KEPT (TASK-073 §0 / §3: this round deletes
 * ENTRANCES, never abilities; deleting files is TASK-074's job, and 验收 #11
 * requires `git diff --stat` to show no removed file).
 *
 * `epprod.js` still renders the 制作台 + 「工作区」 menu from this list. The五页 rail
 * above is the new entrance; this is the old one, still working, until TASK-074
 * retires it. Both resolve through `resolveModule`, so they cannot disagree about
 * where a key goes.
 */
export const LEGACY_EPISODE_STAGES = [
  ["workbench", "🎬", "制作台"],
  ["provenance", "🕸", "生成溯源"],
  ["episode", "📺", "本集总览"],
  ["scenes", "🗂", "场景"],
  ["shots", "🎞", "分镜"],
  ["refplan", "🖼", "参考统筹"],
  ["frames", "🎨", "画面"],
  ["video", "▶", "视频"],
  ["audio", "🎵", "音频"],
  ["dailies", "👁", "审片"],
  ["edit", "✂", "剪辑"],
];

/** The legacy centre of 剧集制作. Still `workbench`: `EPISODE_DEFAULT` moved to
 *  `board`, but the 制作台 shell is what `epprod.js` is built around, and changing
 *  both in one step would leave that component with no centre. */
export const LEGACY_EPISODE_CENTRE = "workbench";

/** The stage workspaces behind the secondary 「工作区」 entry — the LEGACY stage list
 *  minus its own centre. Derived, so a stage can never be listed twice or be
 *  forgotten by one of the two surfaces.
 *
 *  Derived from the legacy list, not from the new five pages: those five are not
 *  「detours from the 制作台」, they are the space itself. TASK-074 removes this
 *  menu; until then it must keep working (§3 迁移方案). */
export const EPISODE_WORKSPACES = LEGACY_EPISODE_STAGES.filter(
  ([k]) => k !== LEGACY_EPISODE_CENTRE,
);

/** Stage keys that belong to ONE episode — the 剧集制作 space's five pages PLUS the
 *  legacy stages, because a legacy key must still report `episode` (a key that
 *  lands on one episode's shots while the top bar says 故事开发 is a regression). */
export const EPISODE_MODULES = [
  ...EPISODE_NAV.map(([k]) => k),
  ...LEGACY_EPISODE_STAGES.map(([k]) => k),
];

/** The ELEVEN pages, as a closed set (IA §1–§2). ⚙ 项目设置 is deliberately not
 *  among them: it is not one of the three spaces' pages.
 *
 *  Exported so a guard test can assert the count rather than trusting a comment —
 *  「新增 Skill 不得新增一级或二级页面」 (ADR-0066 决策 10) is only enforceable if
 *  something checks it. */
export const PAGES = Object.freeze([
  ...NAV[0].items.map(([k]) => k),
  ...EPISODE_NAV.map(([k]) => k),
  "assets",
]);

/**
 * Resolve ANY module key — current or historical — to a real page + section.
 *
 * Returns `{ module, section }`. `section` is null when the page has no sections
 * or the key names the page itself. An unknown key resolves to the first page
 * rather than to nothing: a dead deep link is a worse answer than a landing page,
 * and it is reported as unresolved so the caller can say so.
 *
 * ONE function, so the rail, the breadcrumb, the deep-link reader and every
 * `data-goto` in the tree can never disagree about where a key goes.
 */
export function resolveModule(key) {
  const k = typeof key === "string" ? key : "";
  if (Object.prototype.hasOwnProperty.call(MODULE_ALIAS, k)) {
    const [module, section] = MODULE_ALIAS[k];
    return { module, section, resolved: true };
  }
  if (Object.prototype.hasOwnProperty.call(ASSET_FILTER_ALIAS, k)) {
    return { module: "assets", section: null, filter: ASSET_FILTER_ALIAS[k], resolved: true };
  }
  if (k === PROJECT_SETTINGS) return { module: PROJECT_SETTINGS, section: "info", resolved: true };
  if (PAGES.includes(k)) return { module: k, section: null, resolved: true };
  return { module: PAGES[0], section: null, resolved: false };
}

/** The sections each page really renders. `resolveModule` may only name one of
 *  these, which is what makes 「解析到一个真实分区」 checkable instead of hopeful. */
export const PAGE_SECTIONS = Object.freeze({
  settings: ["characters", "relationships", "world"],
  board: ["overview"],
  storyboard: ["scenes", "shots"],
  // the four steps of §1.3, in order
  shotwork: ["prepare", "image", "video", "pick"],
  cutreview: ["review"],
  delivery: ["timeline", "voice", "ambience", "subtitle", "preview", "qc", "export"],
  [PROJECT_SETTINGS]: ["info", "spec", "budget", "storage"],
});

/** Which top-level SPACE a module belongs to (ADR-0061 决策 1). One function,
 *  so the top bar, the rail and the breadcrumb can never disagree about where
 *  the creator is. */
export const SPACES = ["story", "episode", "assets"];

export function spaceOf(module) {
  if (typeof module !== "string" || !module) return "story";
  // ⚙ 项目设置 belongs to NO space (§1.7). It reports `story` only so the shell has
  // a rail to draw; the top bar highlights nothing, because the creator is not in
  // one of the three spaces.
  if (module === PROJECT_SETTINGS) return "story";
  if (module === "assets" || module.startsWith("assets:")) return "assets";
  // `storage` is a historical key that now lands in ⚙ 存储与诊断
  if (module === "storage") return "story";
  if (EPISODE_MODULES.includes(module)) return "episode";
  // a historical episode key still belongs to 剧集制作, even though it is no longer
  // a page of its own — otherwise the top bar says 故事开发 while the creator is
  // looking at one episode's shots
  const alias = MODULE_ALIAS[module];
  if (alias && EPISODE_MODULES.includes(alias[0])) return "episode";
  return "story";
}

export const SPACE_LABEL = { story: "故事开发", episode: "剧集制作", assets: "资产库" };

/** Stage keys that carry a completion ratio — the rail draws their progress
 *  bar. Keyed to the same badge model so the bar can never disagree with the
 *  number printed beside it. */
export const STAGE_KEYS = ["frames", "video", "audio", "dailies"];

/** The 资产库 rail (ADR-0061 决策 1), KEPT for its current callers — see the note on
 *  `ASSET_FILTER_ALIAS`. Media categories only, never production navigation. */
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

/** Labels for the eleven pages, ⚙, AND every historical key (§1.1 requires the old
 *  keys stay resolvable, and a resolvable key with no label renders blank in the
 *  breadcrumb). The old labels are kept verbatim so a bookmark still reads the way
 *  the creator remembers it. */
export const MODULE_LABEL = {
  // the eleven
  brief: "项目与创意", story: "故事大纲", settings: "作品设定",
  episodes: "分集规划", script: "本集剧本",
  board: "本集看板", storyboard: "分镜设计", shotwork: "镜头制作",
  cutreview: "粗剪审片", delivery: "后期交付",
  assets: "资产库",
  // ⚙ — its own key, never `settings`
  [PROJECT_SETTINGS]: "项目设置",
  // historical keys, still resolvable
  characters: "人物", relationships: "人物关系", world: "世界观",
  storage: "存储与诊断",
  "assets:reference": "References", "assets:image": "Images",
  "assets:video": "Videos", "assets:audio": "Audio",
  "assets:final": "Final", "assets:collection": "Collections",
  workbench: "制作台", provenance: "生成溯源",
  episode: "本集总览", scenes: "场景", shots: "分镜",
  refplan: "参考统筹", frames: "画面", video: "视频",
  audio: "音频", dailies: "审片", edit: "剪辑",
};

/** Section labels, for the in-page section navs. */
export const SECTION_LABEL = {
  characters: "人物", relationships: "人物关系", world: "世界观",
  overview: "本集总览",
  scenes: "场景", shots: "分镜",
  prepare: "① 准备输入", image: "② 制作主画面", video: "③ 制作视频", pick: "④ 对比候选并选定",
  review: "整集连播与问题标记",
  timeline: "时间线与粗剪调整", voice: "配音", ambience: "环境音 / 音效 / 音乐",
  subtitle: "字幕", preview: "成片预览", qc: "交付质检", export: "导出及导出记录",
  info: "项目信息", spec: "成片规格", budget: "预算与限制", storage: "存储与诊断",
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

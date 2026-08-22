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
      ["episodes", "📺", "分集规划"],
      // 「本集剧本」 MOVED TO 剧集制作 (TASK-091 §1.1, confirmed by the owner's 图一:
      // 「剧集制作开始的时候按照图一。写剧本」). It is the FIRST thing that space does,
      // and it was sitting in 故事开发 where the creator had already left for production.
      //
      // ONLY THE SPACE MOVED. The member set of PAGES is byte-identical, so the frozen
      // `PAGES.length === 11` guard (ADR-0066 决策 10) still holds; `spaceOf` and
      // `crumbScope` both derive from EPISODE_NAV, so moving the row is the whole
      // change — no address, no history key and no alias is touched (TASK-086 gave
      // every key a stable address).
      // 作品设定 IS LAST, and that is a product decision this card executes
      // (产品负责人 2026-08-17, TASK-090 §0 / §2.1):
      //
      //   「作品设定的内容不应该在故事开发的时候准备。人物关系应该是随着剧情推进有
      //     变化的。所以可能要放故事开发的最后。」
      //
      // It sat THIRD, i.e. before any script existed to derive it from — which is
      // why it read as an empty form to fill in by hand. Derived content belongs
      // after the thing it is derived from.
      //
      // ONLY THE ORDER MOVED. The member set is untouched, so the frozen
      // `PAGES.length === 11` guard still holds; `resolveModule`, every address and
      // every history key are unchanged (TASK-086 gave each key a stable address).
      // The order assertion in `workspaces.test.mjs` is updated as part of this
      // card because THE RULE CHANGED — not to make a test pass.
      ["settings", "🎭", "作品设定"],
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
  // 剧集制作 STARTS AT THE SCRIPT (图一). The owner's own sequence is
  // 「写剧本 → 脚本生成器自动生成分镜 → …」, so the script is this space's first row
  // rather than 故事开发's last.
  ["script", "📄", "本集剧本"],
  // TASK-073 §1.1: FIVE pages, down from eleven same-level tabs. This is a
  // regrouping, NOT a removal — every capability behind the old eleven keys is
  // still reachable, as a SECTION of one of these five (see MODULE_ALIAS). What
  // was deleted is the entrance, never the ability (§0 的 一条贯穿全卡的规则).
  //
  // TASK-077 §1.5: …and until now it had no entrance EITHER. This list was
  // declared, asserted by two guard tests, and drawn by nothing — see
  // `renderEpisodeRail`, which is the renderer that was missing.
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
/**
 * NOT YET ALIASED, and this is a REAL GAP in §1.1's 落点表 — recorded rather than
 * papered over (independent review, batch 3):
 *
 *   `workbench`   → the table says ⑧ 镜头制作. But ⑧'s four steps do not contain the
 *                   制作台's shot-production graph, and redirecting it made
 *                   `activeModule === LEGACY_EPISODE_CENTRE` permanently false, which
 *                   killed the centre, `showsFocus`, `onCentre` and the whole
 *                   「工作区」 back-navigation.
 *   `provenance`  → the table says ⚙ 存储与诊断. But the graph MOUNTS inside the
 *                   episode-space branch of `render()`, and ⚙ reports `story`, so the
 *                   redirect landed 「完整溯源 ↗」 on 存储管理 with no graph at all.
 *
 * Both are the exact 「落到一个没有该内容的页面」 failure ADR-0063 决策 1 forbids, so
 * they keep their own renderer and their own entrance until the content moves with
 * them. TASK-073 §5.11 tracks the remaining work.
 *
 * STILL TRUE after TASK-077 §1.5. The five-page rail now exists, and neither of
 * these two keys is one of the five, so the rail highlights nothing while they are
 * open — which is honest: the creator is on a legacy surface the IA does not name.
 * `crumbScope` classifies both as shot-scoped, because that is what they show.
 *
 * THEY ARE NOW ADDRESSABLE AS THEMSELVES (TASK-086 §2). Not aliased — that is
 * still the thing this note refuses. Until TASK-081 they had no address at all,
 * which was survivable; after it, `writeUrl` wrote `#/…/episode/workbench` while
 * `parseRoute` read it back as `PAGES[0]`, so opening 制作台 and pressing refresh
 * landed the creator on 项目与创意. TASK-081 验收 #1「刷新页面还在那里」 did not
 * hold for these two, and its round-trip test could not see it: that test's key
 * set is MODULE_ALIAS ∪ ASSET_FILTER_ALIAS ∪ PAGES ∪ ⚙, and these two are in
 * none of them. Resolving them to THEMSELVES closes the round trip without
 * moving any content — `spaceOf` already says `episode`, and neither declares a
 * section, so no address can name one they do not have.
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
  // A LEGACY STAGE THAT NO ALIAS COVERS RESOLVES TO ITSELF (TASK-086 §2).
  // Derived from the stage list, not spelled out: `workbench` / `provenance` are
  // the two that fall through today, and a future key that also has a renderer
  // but no landing place must not have to be remembered here a second time.
  // Without this they resolved to `PAGES[0]`, so the address the app itself
  // wrote could not be read back — see the note above.
  if (LEGACY_EPISODE_STAGES.some(([stage]) => stage === k)) {
    return { module: k, section: null, resolved: true };
  }
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
  // TASK-080 §1.1: 能力目录 is a SECTION of ⚙, not a twelfth page — the eleven
  // are a closed set with a guard test on the count, and ⚙ is deliberately
  // outside them (§1.7). See the header of ui/skillcatalog.js for the full
  // argument against ADR-0066 决策 10.
  [PROJECT_SETTINGS]: ["info", "health", "spec", "budget", "storage", "skills"],
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

/**
 * The 资产库 rail — ENTRANCES ONLY (TASK-082 §1.2).
 *
 * The seven media-category rows are GONE. They were C-018: the same vocabulary
 * offered twice, once as a rail and once as the page's own filter chips, so the
 * creator had to learn that clicking 「Videos」 on the left and 「镜头视频」 in the
 * page were one thing. TASK-073 §1.1 already decided this (`ASSET_NAV` 删除 →
 * `ASSET_FILTER_ALIAS` preset filter values); the aliases landed and the rows
 * were left behind for TASK-074, which is why the duplication survived.
 *
 * The keys keep working — `resolveModule` still resolves every `assets:*` to the
 * library with its filter set, and the URL still carries them (TASK-081). What
 * was deleted is an ENTRANCE, never an ability.
 *
 * 存储管理 STAYS: it is not a media category, it is a different page.
 */
export const ASSET_NAV = [
  ["assets", "📦", "全部资产"],
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
  skills: "能力目录", health: "项目健康",
};

/** Episode short label: EP01, EP02… derived from position, with the planned
 *  title carried separately (never parsed out of the title string). */
export function episodeLabels(prod) {
  // ARCHIVED EPISODES ARE NOT LABELLED (ADR-0072 决策 4 / TASK-094 批次 G). This one
  // function feeds the EPISODES rail, the breadcrumb's 「共 N 集」 and every episode
  // picker, so filtering here is what keeps those three from disagreeing with
  // 分集规划 — the plan page showed 16 while the rail still said 48, which is the
  // 「几个数字互相矛盾」 defect TASK-077 §1.6 spent a card on.
  //
  // The CODE is derived from position in the LIVE list: EP01…EP12 must be what the
  // creator counts on screen. An archived shell is still resolvable by id
  // (`findEpisode`), which is what keeps历史 Run / 剧本 references intact.
  return prod.episodes
    .filter((e) => !(e.archived && e.archived.at))
    .map((e, i) => ({
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

/** ONE rail row. Shared by the 故事开发 rail and the 剧集制作 rail so the two can
 *  never drift in markup, active-state class or badge rules. */
function railItem([k, icon, label], { activeModule, badges = {}, ratios = {} }, cls = "") {
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
}

/**
 * The 剧集制作 rail — the five pages of `EPISODE_NAV` (TASK-077 §1.5).
 *
 * WHY THIS DID NOT EXIST. `EPISODE_NAV` was declared by TASK-073 and asserted by
 * two guard tests, and no renderer ever drew it: the whole space had NO left rail,
 * and its only navigation was the 制作台's 「工作区 ▾」 dropdown over the ELEVEN
 * LEGACY stage keys. So the frozen IA's five pages were unreachable by name, and
 * ⑨ 粗剪审片 (`cutreview`) had no entrance at all — a renderer and a binding for a
 * module `activeModule` could never equal. The tests were right; the rendering was
 * missing, which is why they are untouched by this card.
 *
 * `activeModule` is passed ALREADY RESOLVED (`resolveModule(...).module`), so a
 * legacy key highlights the page it now lands on instead of highlighting nothing.
 *
 * NO BADGES, deliberately. The five pages have no badge model of their own, and
 * this file already records why inventing one is worse than none: 「their own
 * headers report the real numbers, and a second copy here could only ever disagree
 * with them」. `railItem` accepts them so a real per-page model can be wired later.
 */
export function renderEpisodeRail({ activeModule, badges = {}, ratios = {}, episodeCode = "", episodeTitle = "" }) {
  const heading = episodeCode
    ? `${episodeCode}${episodeTitle ? ` ${episodeTitle}` : ""}`
    : "本集制作";
  return (
    `<div class="st-railsec">${esc(heading)}</div>` +
    EPISODE_NAV.map((it) => railItem(it, { activeModule, badges, ratios })).join("")
  );
}

/**
 * WHAT SCOPE a page is really about (TASK-077 §1.6) — "project" | "episode" | "shot".
 *
 * The breadcrumb used to show Scene › Shot for EVERY module inside 剧集制作,
 * because Scene and Shot are levels of that space. But 本集看板 / 粗剪审片 /
 * 后期交付 are EPISODE-level pages, and printing 「照见未明rev2 › EP01 › Shot 01 ›
 * 本集看板」 claims the creator is standing on a shot while looking at the whole
 * episode. A crumb segment that is not part of the current page's scope is a
 * placeholder crumb, which `renderCrumb` already refuses to draw.
 *
 * Pure and exported, so the rule is one table with a test on it rather than a
 * condition buried in a shell closure.
 */
export const SHOT_SCOPED_MODULES = Object.freeze([
  // the five pages: only ⑧ 镜头制作 is about ONE shot
  "shotwork",
  // the legacy stages that were each about one shot
  "workbench", "provenance", "shots", "frames", "video", "audio", "dailies", "refplan",
]);

export function crumbScope(module, section) {
  if (module === "storyboard") {
    // ⑦ 分镜设计 is two sections: 场景 is episode-level, 分镜 selects a shot
    return section === "shots" ? "shot" : "episode";
  }
  if (SHOT_SCOPED_MODULES.includes(module)) return "shot";
  if (EPISODE_MODULES.includes(module)) return "episode";
  const alias = MODULE_ALIAS[module];
  if (alias && EPISODE_MODULES.includes(alias[0])) {
    return SHOT_SCOPED_MODULES.includes(alias[0]) ? "shot" : "episode";
  }
  return "project";
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
  const item = (it, cls = "") => railItem(it, { activeModule, badges, ratios }, cls);
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

/** The FILE a URL points at, for an error message a creator can act on.
 *  「媒体文件已不在磁盘上」 without the filename is a complaint; with it, it is a
 *  thing they can go and look for. */
export function fileNameOf(url) {
  const u = String(url || "").split(/[?#]/)[0];
  const last = u.slice(u.lastIndexOf("/") + 1);
  try { return decodeURIComponent(last); } catch { return last; }
}

/** The honest 「文件不在了」 box (TASK-077 §1.2).
 *
 *  NOT the same state as 「还没有画面」 and never rendered as it: nothing generated
 *  yet is a normal step in the work, while a registered asset whose bytes are
 *  gone is a fact about this project the creator has to know about. The browser's
 *  own broken-image glyph said neither. */
export function mediaGoneInner(url, { reason = "媒体文件已不在磁盘上" } = {}) {
  const name = fileNameOf(url);
  return (
    `<span class="ic">⃠</span><span>${esc(reason)}</span>` +
    (name ? `<span class="fn">${esc(name)}</span>` : "")
  );
}

export function mediaGoneBox(url, { cls = "", reason = "媒体文件已不在磁盘上" } = {}) {
  return `<div class="media media-none media-gone ${cls}">${mediaGoneInner(url, { reason })}</div>`;
}

/** A media box: real thumbnail, or an honest placeholder that says WHY.
 *
 *  `gone` is the caller's probe result — 「登记了，但磁盘上没有」. The `data-media-url`
 *  is what lets ONE central handler (production.js) turn a load failure anywhere
 *  in the tree into that same honest box, so a surface nobody remembered to make
 *  probe-aware still stops showing a broken glyph. */
export function mediaBox(url, { alt = "", missing = "还没有画面", icon = "🎞", cls = "", gone = false } = {}) {
  if (url && gone) return mediaGoneBox(url, { cls });
  return url
    ? `<img class="media ${cls}" data-media-url="${esc(url)}" src="${esc(url)}" alt="${esc(alt)}" loading="lazy">`
    : `<div class="media media-none ${cls}"><span class="ic">${icon}</span><span>${esc(missing)}</span></div>`;
}

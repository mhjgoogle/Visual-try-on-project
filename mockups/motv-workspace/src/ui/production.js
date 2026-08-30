// Production studio shell — the UPSTREAM workspace where the creative
// foundation of the whole work is built (ADR-0054):
//
//   LEFT rail    作品开发（创意 · 故事大纲 · 作品设定 · 分集规划）+ Episodes
//   CENTER       the active workspace
//   RIGHT        the persistent AI Director
//
// Production stops at 分集规划. An episode's own production stages (剧本 / 场景 /
// 分镜 / 画面 / 视频 / 音频 / 剪辑) are reached by ENTERING an episode — they are
// Production's exit, never its main navigation. The workflow node canvas stays
// available under the 工作流 top-level mode.
//
// PURE PRESENTATION over the domain documents (story / scriptDoc / production
// / bible / Asset & Generation registries) through ctx controllers — the shell
// owns only TRANSIENT UI state (active module, selection, edit buffers, open
// drawers), never persisted, never on canvas nodes.
import { $, esc } from "../util/dom.js";
import * as ws from "./workspaces.js";
import { renderStoryboard, bindStoryboard, defaultShotId, isSelectableShot, shotDetailModel } from "./storyboard.js";
import { episodeStageCounts } from "./prodplan.js";
import { renderAudioWs, bindAudioWs } from "./audiows.js";
// NOTE: `ui/timelinews.js` is no longer mounted. ADR-0061 决策 6 replaced the
// 剪辑 workspace with the Post Production Console, and Phase 3 built it — so the
// old workspace would be a SECOND place the same timeline is edited, with its
// own handlers and its own guards to drift from. The module is left in the tree
// (its read model is still unit-tested) but nothing renders it.
import { renderDailies, bindDailies } from "./dailies.js";
import { renderCutReview, bindCutReview } from "./cutreview.js";
import { bindChainMenu } from "./chain.js";
import { renderEpisodeWs, bindEpisodeWs } from "./episodews.js";
import { renderRefPlan, bindRefPlan } from "./refplan.js";
import { renderAssetPrep, bindAssetPrep } from "./assetprepview.js";
import { renderPromptBatch, bindPromptBatch } from "./promptbatch.js";
import { renderStoryboardStrip, bindStoryboardStrip } from "./sbstrip.js";
import { renderKeyframeList, bindKeyframeList } from "./kflist.js";
import { renderVideoBatch, bindVideoBatch } from "./videobatch.js";
import {
  renderAssetLibrary, bindAssetLibrary, RAIL_TYPE,
  // TASK-082 §1.2: the rail is a CONTENT tree now, not a second copy of the chips
  assetTreeModel, renderAssetTree,
} from "./assetlibws.js";
import { renderAssetInboxSection, bindAssetInboxSection } from "./assetinboxsec.js";
import { threadModel, renderThread } from "./convthread.js";
import {
  loadThread, sendTurn, awaitTurn, cancelTurn, reportApplied, openProposalCount,
  decideProposal,
} from "../services/conversation.js";
import { proposalsModel, renderProposals, renderOpinions } from "./proposals.js";
import { renderStorageWs, bindStorageWs } from "./storagews.js";
import { renderStoryWs, bindStoryWs } from "./storyws.js";
import { renderBibleWs, bindBibleWs } from "./biblews.js";
import { renderBriefWs, bindBriefWs } from "./briefws.js";
import { renderWorldWs, bindWorldWs } from "./worldws.js";
import { renderEpPlanWs, bindEpPlanWs } from "./epplanws.js";
import { renderImageWs, bindImageWs, renderVideoWs, bindVideoWs } from "./mediaws.js";
import { renderEpProd, bindEpProd, workbenchModel, currentPlace } from "./epprod.js";
import {
  renderShotGraph, bindShotGraph, drawShotEdges, renderStages,
  renderAddMenu, renderChainMenu, renderStageChips, renderReferenceArea, renderCameraPresets,
} from "./shotgraphview.js";
import { REFERENCE_CATEGORIES } from "../workflow/refset.js";
import * as prodwizard from "./prodwizard.js";
import { renderProdWizard, bindProdWizard } from "./prodwizard.js";
import { inspectFromShotNode } from "../workflow/shotgraph.js";
import { derivedLabel } from "../workflow/assetreg.js";
// TASK-066: the five regions of 剧集制作. Each owns ONE question, and the shell is the
// only thing that knows they are on the same screen.
import { renderCoreWs, renderOutlineWorkWs } from "./corews.js";
import { renderPlanWs } from "./planws.js";
import { renderDraftWs } from "./draftws.js";
import * as swork from "../workflow/storywork.js";
import * as storydoc from "../workflow/storydoc.js";
import { renderShotSelect, bindShotSelect } from "./shotselect.js";
import { renderShotRefs, bindShotRefs } from "./shotrefs.js";
import { renderRefSearch, bindRefSearch, searchModel } from "./refsearch.js";
import { renderInspector, bindInspector } from "./prodinspector.js";
import { renderPostConsole, bindPostConsole } from "./postconsole.js";
// TASK-073 §1.3: 状态 / 耗时 / 成本 / 失败原因 / 重试 / 真实取消, in one place
import { taskRowModel, renderTaskRows, bindTaskRows } from "./taskrow.js";
// TASK-073 §1.4: the contextual Agent panel — two entrances, seven items
// TASK-073 §1.7: the fourteen spec fields + the two hard gates (domain)
import { specStanding, SPEC_FIELD_BY_KEY } from "../workflow/deliveryspec.js";
// TASK-080 §1.1: 「这个系统一共能帮我做哪些事」, in one place
import { skillCatalogModel, renderSkillCatalog, bindSkillCatalog } from "./skillcatalog.js";
// TASK-082 §1.1: 「这个项目整体在哪一步，有什么数据问题」
import { healthModel, renderHealth, bindHealth } from "./healthws.js";
// TASK-080 §1.2 批次 A: ONE persistent session whose context the creator states
import {
  agentSessionModel, renderAgentSession, bindAgentSession, sessionState,
} from "./agentsession.js";
// Only `runOperation` survives here: the shot workbench's prompt actions use it.
// The 导演台 panels that used the rest are gone (REQ-004 v2).
import { runOperation } from "./directorshot.js";
import { episodeView, activeEpisode } from "../workflow/proddoc.js";
import { applyConversationEdits } from "../workflow/convedits.js";
import { actionCatalog } from "../workflow/convactions.js";
import {
  decideRoute, originForRoute, routeOf, scopeOfSkill, zoomTrigger,
} from "../workflow/convroute.js";
import { suggestExecutor, isRunnable } from "../services/runtime.js";
import { renderQcPanel } from "./qcpanel.js";
import { renderPostStatus } from "./poststatusbar.js";
import { renderShotQc, bindShotQc, shotQcModel } from "./shotqcpanel.js";
import {
  NAV, EPISODE_MODULES, EPISODE_DEFAULT, LEGACY_EPISODE_CENTRE, MODULE_LABEL, SPACE_LABEL, spaceOf,
  renderRail, renderAssetRail, renderCrumb, episodeLabels, episodeTitleBeside, head, episodeEntryModule,
  // TASK-073 §1.1: the fixed page set, the old-key resolver and the section tables
  resolveModule, PAGE_SECTIONS, SECTION_LABEL, PROJECT_SETTINGS, empty,
  // TASK-077: the 剧集制作 rail, the honest missing-media box and the crumb scope rule
  renderEpisodeRail, mediaGoneInner, crumbScope,
  // TASK-081: the asset type aliases, so a filtered library keeps its key in the URL
  ASSET_FILTER_ALIAS,
} from "./shell.js";

export { NAV };

/**
 * WHERE A MISSING INPUT GETS FIXED (TASK-073 §1.4 / IA §6.3 item 3).
 *
 * 「缺失输入」 has to be clickable 「点到能修它的地方」 — a list that only tells the
 * creator they are stuck is the blank-space failure in list form. Keyed on the shared
 * context-key vocabulary (`product-skills/skill-inputs.json`), valued with the ELEVEN
 * pages, so a key with no home renders as 「没有可跳转的位置」 instead of a dead link.
 */
const MODULE_ALIAS_GOTO = Object.freeze({
  brief: "brief",
  outline: "story",
  characters: "settings",
  relationships: "settings",
  world: "settings",
  episodePlan: "episodes",
  episodeScript: "script",
  scenes: "storyboard",
  shots: "storyboard",
  // the shot-scoped inputs are all prepared in ⑧, at the step that produces them
  references: "shotwork",
  assetCandidates: "shotwork",
  selectedShotImage: "shotwork",
  shotContext: "shotwork",
  neighbourShots: "shotwork",
  promptUnderReview: "shotwork",
  // post-production surfaces
  timeline: "delivery",
  shotAudio: "delivery",
  subtitles: "delivery",
  // library + diagnostics
  assets: "assets",
  generations: PROJECT_SETTINGS,
});

/**
 * EVERYTHING a page change releases from the shell's transient `ui` bag.
 *
 * Extracted and exported (TASK-080 §1.2 批次 A) because it is the ONLY thing a
 * navigation does to `ui`, and 「换一个页面，会话不重置」 is therefore a property of
 * this list rather than of a comment: what is not named here survives. A guard
 * test asserts the Agent session survives it, which is checkable in a way
 * 「setModule 不要清掉会话」 never was.
 *
 * The keys are exactly the ones whose value belongs to the surface being left:
 * an unsaved shot buffer, the drawers a workspace opened, and the base-prompt
 * buffer typed against one entity. Carrying any of them across is how a write
 * lands on the wrong object.
 */
/**
 * WOULD MOVING FROM `cur` TO `want` DISCARD AN UNSAVED SHOT EDIT? (TASK-081 §1.2 第 1 条)
 *
 * THE ONE GUARD, SHARED. `setModule` has always asked before leaving a page with
 * a dirty shot buffer; `popstate` is a SECOND door into the same move, and a
 * second door with its own rule is how the back button ends up discarding a
 * creator's typing in silence. So the decision lives here, both callers ask it,
 * and a test can assert they ask the same question.
 *
 * Only the three things that change WHAT IS BEING EDITED count: the page, the
 * episode and the selected shot. A section change stays on the same shot and does
 * not prompt — matching what `[data-sec]` already does today.
 */
export function routeLeavesObject(cur = {}, want = {}) {
  const moved = (k) => want[k] != null && want[k] !== cur[k];
  return moved("module") || moved("ep") || moved("shot");
}

export function guardsUnsavedEdit(ui, cur = {}, want = {}) {
  if (!ui || ui.dirty !== true) return false;
  return routeLeavesObject(cur, want);
}

export function releasePageState(ui) {
  ui.dirty = false;
  ui.buffer = {};
  ui.bibleOpen = null;
  ui.relOpen = null;
  ui.relSelectA = null;
  ui.worldOpen = null;
  // the UNSAVED base-prompt buffer belongs to the entity it was typed against, and
  // the open library pickers belong to the drawer that opened them — both are
  // released with the workspace, for the same reason `ui.piPrompt` is
  ui.bpText = null;
  ui.baRefPick = null;
  ui.baVoicePick = null;
}

/** Pure view-model of the script document for the shell (unit-tested):
 *  version standing + exactly one of the transient generation states. */
export function scriptStatus(doc) {
  const p = doc.pending;
  return {
    versions: doc.versions.length,
    active: doc.active,
    nextVersion: doc.versions.length + 1,
    generating: !!p && p.status === "generating",
    proposal:
      p && p.status === "proposed"
        ? { instruction: p.instruction, text: p.proposal }
        : null,
    error: p && p.status === "failed" ? p.error : null,
  };
}

/** Pure nav badges from current state — counts, not availability: every
 *  module stays clickable regardless of workflow progress (unit-tested). */
export function navBadges(doc, pd) {
  const st = scriptStatus(doc);
  const shots = ws.shotsModel(pd);
  const frames = ws.assetsModel(pd);
  const video = ws.videoModel(pd);
  const audio = ws.audioModel(pd);
  const edit = ws.editModel(pd);
  const prod = pd.production;
  const bibleCount = prod && Array.isArray(prod.characters) && Array.isArray(prod.locations)
    ? prod.characters.length + prod.locations.length
    : 0;
  const brief = pd.story && pd.story.brief ? pd.story.brief : null;
  return {
    // TASK-057: the brief badge reflects the REVISION standing (a formal
    // revision > a working draft with content > nothing)
    brief: brief
      ? brief.active ? `✓v${brief.active}` : pd.story.idea.trim() ? "草稿" : ""
      : "",
    // M9: the story badge reflects the OUTLINE standing (approved > drafted > idea)
    story: pd.story
      ? pd.story.approved ? `✓v${pd.story.approved}` : pd.story.versions.length ? `v${pd.story.active}` : pd.story.idea.trim() ? "…" : ""
      : "",
    // M7: real persisted bible entities (characters + locations)
    settings: bibleCount ? String(bibleCount) : "",
    // counts, and NOTHING when there is nothing — a "0" badge is noise, not
    // information (same rule as the 作品设定 badge above)
    characters: prod && Array.isArray(prod.characters) && prod.characters.length
      ? String(prod.characters.length)
      : "",
    // TASK-057: real persisted Relationship definitions
    relationships: prod && Array.isArray(prod.relationships) && prod.relationships.length
      ? String(prod.relationships.length)
      : "",
    // TASK-057: the World Setting's confirmed revision, else its fill standing
    world: prod && prod.world && prod.canon
      ? prod.canon.world ? `✓v${prod.canon.world}` : Object.values(prod.world).some((v) => typeof v === "string" && v.trim()) ? "草稿" : ""
      : "",
    // M6: real persisted Episode entities — the count is honest domain data.
    // ARCHIVED ONES EXCLUDED (批次 G): the badge sits beside 分集规划, and a badge
    // saying 48 next to a page saying 16 is two claims about one quantity.
    episodes: prod && Array.isArray(prod.episodes)
      ? String(prod.episodes.filter((e) => !(e.archived && e.archived.at)).length)
      : "",
    scenes: "",
    // 本集制作 and 参考统筹 carry no badge: their own headers report the real
    // numbers, and a second copy here could only ever disagree with them.
    episode: "",
    refplan: "",
    script: st.versions ? `v${st.active}` : "草稿",
    shots: shots.empty ? "" : String(shots.shots.length),
    frames: frames.empty ? "" : `${frames.done}/${frames.total}`,
    video: video.empty ? "" : `${video.done}/${video.total}`,
    audio: audio.empty ? "" : `${audio.done}/${audio.total}`,
    dailies: "",
    edit: edit.finals ? `✓v${edit.finals}` : "",
    storage: "", // stats live in the workspace; no fabricated badge
    assets: "",
  };
}

/** Per-EPISODE stage standing for the rail.
 *
 *  `navBadges` counts project-wide (the shot draft lives on the scriptgen node,
 *  not per episode). The rail groups these stages under 本集制作, so counting
 *  the whole project there would claim work that belongs to another episode.
 *  Derived from ui/prodplan.js — the SAME derivation the AI Director's
 *  Production Plan prints, so the rail badge and the plan row cannot disagree.
 *  No domain model changes, nothing new persisted. */
export function episodeStages(pd) {
  const c = episodeStageCounts(pd);
  // An episode that owns no shots must show NOTHING here — falling back to the
  // project-wide badge would credit another episode's work to this one, which
  // is exactly what grouping these rows under 本集制作 promises not to do.
  if (!c.total) return { badges: { shots: "", frames: "", video: "", audio: "" }, ratios: {} };
  const stat = (done, total) => ({ done, total });
  // audio is measured against SPEAKING shots (prodplan), not every shot — using
  // c.total here would make the rail contradict the plan row it mirrors
  return {
    badges: {
      shots: String(c.total),
      frames: `${c.frames}/${c.total}`,
      video: `${c.video}/${c.total}`,
      audio: c.audioTotal ? `${c.audio}/${c.audioTotal}` : "",
    },
    ratios: {
      frames: stat(c.frames, c.total),
      video: stat(c.video, c.total),
      ...(c.audioTotal ? { audio: stat(c.audio, c.audioTotal) } : {}),
    },
  };
}

/**
 * @param getCtx           () => the app context
 * @param onNavigate       called after EVERY render with (space, module) — the
 *                         shell's own state, so the top bar reports where the
 *                         creator IS rather than where they last clicked. Without
 *                         it, anything that moved the creator from inside the
 *                         shell (「进入剧集制作 →」, an empty state's jump) left
 *                         「故事开发」 highlighted while 剧集制作 was on screen.
 *                         Notifying from render() rather than from each mover is
 *                         what makes that impossible to forget.
 */
export function createProduction(getCtx, { onNavigate = null } = {}) {
  const root = $("#production");
  // transient view state — NEVER persisted, never on canvas nodes.
  // Production OPENS on the upstream (ADR-0054 决策 1): the creative foundation
  // is what this space is for, and a downstream media stage must not be the
  // first thing a creator lands on.
  let activeModule = "brief";
  // the last PRODUCTION module (never the top-level asset library) — returning
  // from 资产 to 制作 restores where the creator actually was
  let lastProdModule = activeModule;
  let revText = "";
  let vmenuOpen = false;
  // storyboard selection + UNSAVED shot-edit buffer + director instruction —
  // shared across re-renders so a media action / poll re-render never
  // discards in-progress field edits (they commit only on explicit save)
  const ui = {
    selectedShotId: null,
    dirty: false,
    buffer: {},
    directorText: "",
    // Bible: which card's detail drawer is open, and which state is previewed
    bibleOpen: null,
    bibleTab: "characters",
    bibleState: {},
    // --- TASK-065 -------------------------------------------------------- //
    // 人物关系图: which relationship's detail is open, and the FIRST node of a
    // click-two-people-to-connect gesture (transient — the first click writes
    // nothing, so a mis-click on a portrait cannot create canon)
    relOpen: null,
    relSelectA: null,
    // 世界观: which half is showing and which location's drawer is open
    worldTab: "world",
    worldOpen: null,
    // 基础资产面板: the UNSAVED base-prompt buffer `{key, text}` (null = showing the
    // effective prompt, which is not the same as「创作者清空了它」), and which
    // library picker is expanded. All three are keyed/cleared on entity change so
    // a buffer typed for one entity can never be saved onto another.
    bpText: null,
    baRefPick: null,
    baVoicePick: null,
    // 当前 Shot Production Graph: which node the creator last opened, which card's
    // ⋮ menu is open, the layout mode, and whether the picture is full-screen
    sgNode: null,
    sgMenu: null,
    sgLayout: "auto",
    sgFull: false,
    // TASK-066 TOP: which of the three cascading selectors is open
    ssOpen: null,
    // TASK-066 LEFT: which reference card's ⋮ menu is open, and which group's
    // 「+ 添加参考」 popover
    srMenu: null,
    srAdd: null,
    // TASK-066 BOTTOM: the reference searcher's query / type filter / expanded state
    rsQuery: "",
    rsType: "all",
    rsOpen: true,
    // Storyboard/Image/Video: which variant tab is showing
    variantTab: "image",
    // AI Director: per-section collapse overrides (transient; the default is
    // derived contextually from what most needs attention)
    dirOpen: {},
    // Story: which outline version is being read
    storyTab: "outline",
    // Dailies: which shot the review pass is on (transient — a review position
    // is not a decision, so it is never persisted)
    dailiesShotId: null,
    // Asset Library: filters + the open inspector (transient view state)
    alFilters: {},
    alOpen: null,
    // --- 剧集制作 (ADR-0061 决策 2) ---------------------------------------- //
    // Which object the LEFT Production Inspector is operating on. Transient:
    // an inspector selection is a place to stand, not a decision.
    inspect: null,
    // the Prompt Inspector's UNSAVED edit buffer — null means "showing the
    // effective prompt", which is not the same as "the creator cleared it"
    piPrompt: null,
    epFocus: "all",
    epSelOpen: false,
    // 剧集制作 · 工作区: is the secondary stage-workspace menu open? View state.
    epWsOpen: false,
    // AI Director · 能力: which Skill is open, on which executor
    skillId: null,
    skillExecutor: "manual",
    skillPromptOpen: false,
    skillPromptText: "",
    // --- 后期控制台 (ADR-0061 决策 6 / Phase 3) ----------------------------- //
    // Which face of the console is showing, whether the dock is expanded, and
    // whether the preview player is open. All three are view state: a console tab
    // is a place to stand, not a decision.
    postTab: "edit",
    // STARTS COLLAPSED (TASK-065 §16 / §18-8). 上面负责制作镜头，下面负责把镜头剪成
    // 一集 — the console is the LATER step, and expanded it takes 46vh, which on a
    // 1000px viewport left the current shot's production graph with ~200px and
    // pushed most of the chain below the fold. Collapsed it still shows its whole
    // bar (title, all three tabs, 初剪 standing, 展开 ↗), and clicking any tab
    // expands it — so nothing is hidden, only deferred to when it is the work.
    postOpen: false,
    postPreview: false,
  };

  // The executor availability probe (ADR-0056): a SERVER round trip, so it is
  // fetched once per shell and cached here. `null` means not probed yet, which
  // the panel renders as 「未探测」 — never as available.
  let execProbe = null;
  let execProbing = false;
  // The provenance node the LEFT column is standing on for THIS render — set by
  // render(), read by bind(). Transient, never persisted; null whenever the centre
  // is not the graph or nothing is selected on it.
  let provNode = null;
  // The CURRENT SHOT's production graph for THIS render — set by render(), read by
  // bind() and by the edge painter. Transient; null whenever the centre is not the
  // 制作台 or no shot is selected.
  let shotGraph = null;
  // The LEFT column's and BOTTOM strip's models for THIS render — resolved by render(),
  // read by bind(). Deriving them twice is how a picture and its handlers end up
  // describing different shots.
  let shotRefs = null;
  let refSearch = null;
  // …and whether this render IS that surface. Set once in render() and read by
  // aiDirector(), so the two cannot disagree about which panel is showing.
  let onShotBench = false;

  function vmenuHtml(d) {
    const label = { generated: "AI 生成", revision: "AI 修订", manual: "手工" };
    return `<div class="vmenu">${d.versions
      .map(
        (x) =>
          `<button class="${x.v === d.active ? "cur" : ""}" data-v="${x.v}" title="${esc(x.instruction || "")}">v${x.v} · ${esc(label[x.origin] || x.origin)}${x.v === d.active ? " ·当前" : ""}</button>`,
      )
      .join("")}</div>`;
  }

  // --- the SCRIPT module keeps its full live assistant ---------------------- //

  /** The persistent right-side AI Director. Script gets the live assistant;
   *  every other module gets the contextual Director panel. */
  /** The persistent right column: ONE conversation, nothing else.
   *
   *  REQ-004 v2 — 产品负责人 2026-08-27: 「AI导演台不需要了。根本用不上。直接给我做一个
   *  像现在一样的对话框。」 So the six-section 导演台 (导演观察 / 生产计划 / 当前状态 /
   *  能力 / 生成 / 这一镜怎么办) is retired: `director.js`, `skillpanel.js` and
   *  `agentpanel.js` are deleted, not merely unrendered.
   *
   *  WHAT DID NOT GO WITH IT. 资产收件箱 was housed in that column but is an ACTION
   *  surface, not an observation — it is the only place an asset's ownership gets
   *  confirmed. It moved into 资产库's workspace (`assetinboxsec.js`), because the
   *  creator's own IA rule puts 「工作区」 in the middle column.
   */
  function aiDirector(ctx) {
    const session = renderAgentSession(agentSessionModel(ctx, ui), {
      // REQ-004 判据 4 — the history scrolls, the input box does not move
      split: true,
    });
    const label = activeModule === "script"
      ? " · 剧本"
      : ` · ${SPACE_LABEL[spaceOf(activeModule)] || ""}`;
    return (
      `<aside class="st-dir prod-ai">` +
      // 两个窗口，一行 tab（产品负责人 2026-08-29:「聊天窗口A是用来操作当下界面的。
      // 窗口B是用来feedback的这样比较不会乱。但同时也要保持画面简约」）：
      //   作品 —— 改这一页上的东西，历史按页面分（每页一条线）
      //   开发 —— 提意见、看开发的提案、拍板。它是**项目级一条线**，因为「这个界面
      //           不好用」不属于某一页；而且在哪一页提的仍然记在那一轮里。
      // 简约的做法是：**没有第二块面板**，只是同一根流换了一条线。
      `<div class="dir-head">` +
      `<button class="dir-tab${convMode() === "work" ? " on" : ""}" data-cv-mode="work">作品</button>` +
      `<button class="dir-tab${convMode() === "feedback" ? " on" : ""}" data-cv-mode="feedback">` +
      `开发${ui.convOpenProposals ? `<span class="dot">${ui.convOpenProposals}</span>` : ""}</button>` +
      `<span class="dir-space">${esc(convMode() === "work" ? label.slice(3) : "意见与提案")}</span>` +
      `</div>` +
      // THE CONVERSATION IS THE WHOLE COLUMN. 产品负责人 2026-08-27:「会话那个框也很
      // 多余。用不上的东西不要加进去」— so the 运行记录 / 这一页的诊断 box
      // (`session.history`) is no longer mounted. It is still BUILT by
      // `renderAgentSession`, and capability runs remain readable on the 生成记录
      // page, so this removes a surface he does not use rather than a fact.
      // 「开发」窗口：方案**钉在标题栏下面**，不跟着流滚动。
      //
      // 第一版把它画进 `.st-dir-flow` 的顶端 —— 而那根流有一万三千像素高、视图停在
      // 底部，于是卡片落在他视线上方 13217px 处：DOM 里有、屏幕上没有（产品负责人
      // 2026-08-30 第二次说「我根本没看到开发的提案」）。**「渲染了」不等于「看得见」**
      // —— 我第一次只断言了 DOM 里有卡片，那条断言为错误的理由通过了。
      (convMode() === "feedback"
        ? `<div class="st-dir-props">` +
          renderProposals(proposalsModel(ui.convProposals)) +
          renderOpinions(ui.convOpinions) +
          `</div>`
        : "") +
      `<div class="st-dir-flow">` +
      // 开发刚给了新方案 —— 在他正看着的那条流里说一句，而不是等他自己切过去看
      (ui.convProposalNote
        ? `<div class="cv-note"><span class="k">开发给了你 ${ui.convProposalNote} 条新方案</span>` +
          `<button class="btn sm" data-cv-gonote="1">去看看</button></div>`
        : "") +
      // 结构性改动之后的**建议**（不是自动跑）。他点了才走一轮对话去查。
      (convMode() === "work" && ui.convSuggest
        ? `<div class="cv-note"><span class="k">${esc(ui.convSuggest.text)}</span>` +
          `<button class="btn sm" data-cv-suggest="1">查一下</button></div>`
        : "") +
      renderThread(threadModel(convState().turns, {
        pendingRun: convState().pendingRun,
        pendingStatus: convState().pendingStatus,
        applied: convState().applied,
        // 「识别到什么能力 / 跑了没有 / 缺什么」——每次渲染重算，来源是登记表
        // 与当前文档，所以刷新之后说法不变，而且重算不会启动任何东西。
        routeState: convRouteState(ctx, convState().turns),
      })) +
      `</div>` +
      `<div class="st-dir-composer">` + session.composer + `</div>` +
      `</aside>`
    );
  }

  /** Probe the local executors once, then re-render so the Skill panel reports
   *  real availability. Never awaited by render(): a panel that blocks on a
   *  server probe would leave the whole shell blank while it runs. */
  function ensureProbe(ctx) {
    if (execProbe || execProbing) return;
    execProbing = true;
    Promise.resolve(ctx.skills.probe())
      .then((p) => { execProbe = p; })
      .catch(() => { execProbe = {}; }) // a failed probe is "nothing is known", not "available"
      .finally(() => { execProbing = false; render(); });
  }

  /** Ask the disk what is really there, once, then re-render honestly
   *  (TASK-077 §1.2).
   *
   *  Modelled on `ensureProbe` above and never awaited by render(): a page that
   *  blocked on a media scan would leave the shell blank while it runs. Safe to
   *  call every render — `scanRegistry` does no work when there is nothing new to
   *  ask, and resolves false, so this cannot spin.
   *
   *  Scoped to the pages whose NUMBERS or THUMBNAILS depend on it. Probing the
   *  whole registry from every page would fire dozens of requests for a screen
   *  that shows no media. */
  function ensureMediaProbe(ctx) {
    if (!ctx.mediaProbe) return;
    const m = activeModule;
    const wants =
      m === "assets" || m.startsWith("assets:") || m === "storage"
      || (m === PROJECT_SETTINGS && sectionOf(PROJECT_SETTINGS) === "storage");
    if (!wants) return;
    ctx.mediaProbe.scanRegistry().then((changed) => { if (changed) render(); }).catch(() => {});
  }

  /** Read the four project queries ONCE, when ⚙ 项目健康 is actually opened
   *  (TASK-082 §1.1).
   *
   *  Same shape as `ensureProbe`: never awaited by render(), fires only on the
   *  page that needs it, and only from `idle` — so a failed read stays failed
   *  (with its reason on screen) instead of re-firing four requests every repaint
   *  until the backend recovers. 「重新读取」 is the explicit retry. */
  function ensureHealth(ctx) {
    if (!ctx.health) return;
    if (activeModule !== PROJECT_SETTINGS || sectionOf(PROJECT_SETTINGS) !== "health") return;
    if (ctx.health.get().state !== "idle") return;
    ctx.health.load();
  }

  /** Turn ANY media element that fails to load into the honest placeholder.
   *
   *  ONE handler for the whole tree, keyed off `data-media-url`, so a surface
   *  nobody remembered to make probe-aware still stops showing the browser's
   *  broken-image glyph with the alt text hanging off it. The element is replaced
   *  in place immediately AND the observation is recorded, so the next render (and
   *  the storage page's count) agree with what the creator just saw. */
  function bindMediaErrors(root2, ctx) {
    root2.querySelectorAll("[data-media-url]").forEach((elm) => {
      elm.onerror = () => {
        const url = elm.dataset.mediaUrl;
        const changed = ctx.mediaProbe ? ctx.mediaProbe.observe(url, false) : false;
        // keep the element's own layout class (`media` / `al-media` / `pi-vth` …)
        // so the placeholder occupies the same box the picture would have
        const box = document.createElement("div");
        box.className = `${elm.className || ""} media-none media-gone`.trim();
        box.innerHTML = mediaGoneInner(url);
        elm.replaceWith(box);
        if (changed) render();
      };
    });
  }

  /** Everything the breadcrumb needs, resolved from real domain state. */
  function crumb(ctx) {
    const pd = ctx.prodData();
    const prod = pd.production;
    const eps = episodeLabels(prod);
    const ep = eps.find((e) => e.active) || eps[0] || null;
    let scene = null;
    let shot = null;
    if (ui.selectedShotId && prod) {
      const s = (pd.draftShots || []).find((x) => x && x.shotId === ui.selectedShotId);
      if (s) shot = `Shot ${String(s.sequence).padStart(2, "0")}`;
      for (const e of prod.episodes) {
        const sc = e.scenes.find((x) => x.shotIds.includes(ui.selectedShotId));
        if (sc) { scene = sc.title.split(" ")[0] || sc.title; break; }
      }
    }
    const inEpisode = EPISODE_MODULES.includes(activeModule);
    // TASK-077 §1.6: the crumb draws only the segments the CURRENT PAGE is really
    // about. 「Scene and Shot are levels of 剧集制作」 is true of the space and false
    // of its episode-level pages: 本集看板 / 粗剪审片 / 后期交付 printed
    // 「… › EP01 › Shot 01 › 本集看板」, which claims a shot the page is not showing.
    // The rule lives in `crumbScope` (shell.js) so it is one table with a test.
    const scope = crumbScope(activeModule, sectionOf(activeModule));
    const showSel = scope === "shot";
    const tail = ep && eps.length > 1 ? `共 ${eps.length} 集` : "";
    // upstream modules are PROJECT-level: showing an episode crumb there would
    // claim the creator is inside an episode when they are not
    return renderCrumb({
      project: (ctx.project && ctx.project.name) || "未命名项目",
      episode: inEpisode && ep ? ep.code : null,
      scene: showSel ? scene : null,
      shot: showSel ? shot : null,
      module: MODULE_LABEL[activeModule] || "",
      tail,
    });
  }

  function scriptMain(ctx) {
    const d = ctx.script.doc();
    const st = scriptStatus(d);
    const dirty = ctx.script.isDirty();
    const vbar = st.versions
      ? `<div class="vbar"><span class="vchip">v${st.active} ▾</span><span class="dirtytag" ${dirty ? "" : "hidden"}>已手工修改（未版本化）</span>${vmenuOpen ? vmenuHtml(d) : ""}</div>`
      : "";
    const prod = ctx.production.doc();
    const ep = prod.episodes.find((e) => e.episodeId === prod.activeEpisodeId) || prod.episodes[0];
    const story = ctx.story.doc();
    const planned = story.confirmedPlan
      ? (story.plans.find((p) => p.v === story.confirmedPlan) || { episodes: [] }).episodes.some((e) => e.episodeId === (ep && ep.episodeId))
      : false;
    const hint = !st.versions && !ctx.script.hasContent() && !planned
      ? `<div class="chip gate">建议先在「故事」批准大纲 → 在「剧集」确认结构规划</div>`
      : "";
    return (
      head(ep ? ep.title : "当前剧集", "按集剧本 · 应用修订 = 创建新版本，旧版本保留", vbar + hint) +
      `<textarea class="pm-text" spellcheck="false" placeholder="在此输入/粘贴本集剧本，或在右侧用 AI 基于大纲与本集规划生成">${esc(ctx.script.currentText())}</textarea>`
    );
  }

  /** The section in force on a page (TASK-073 §1.1 / §1.2).
   *
   *  FRONT-END ONLY and never persisted (§3 迁移方案): which section a creator has
   *  open is a view state, not a fact about the project. Defaults to the page's
   *  first declared section, so a page always renders something real. */
  function sectionOf(module) {
    const list = PAGE_SECTIONS[module];
    if (!list || !list.length) return null;
    const want = ui.sections && ui.sections[module];
    return list.includes(want) ? want : list[0];
  }

  /** ⚙ 成片规格 / 预算与限制 (TASK-073 §1.7).
   *
   *  READ-ONLY THIS ROUND, and it says so. The fourteen fields, their validation and
   *  the two hard gates are settled in `workflow/deliveryspec.js`; what is NOT
   *  settled is where a project-level spec is stored, which is a persistence
   *  decision (a new canvas field means a schema version and a migration). Rendering
   *  editable controls over a store that does not exist would be a page that looks
   *  finished and silently forgets everything typed into it.
   *
   *  Every field therefore reads 「还没有设置」 — which is the honest answer, and the
   *  same one TASK-074 §1.2's 规格 check will consume: 「取不到某一项 → 该项
   *  unavailable，绝不判定为通过」. */
  function renderSpecSection(ctx, group) {
    const spec = typeof ctx.deliverySpec === "function" ? ctx.deliverySpec() : null;
    const st = specStanding(spec);
    const rows = st.fields.filter((f) => f.group === group);
    /** One editable field. The control follows the DECLARED kind, so a value can
     *  never be typed in a shape the validator will then reject silently. */
    const control = (f) => {
      const decl = SPEC_FIELD_BY_KEY[f.key];
      const cur = f.value === null ? "" : String(f.value);
      if (decl.kind === "enum") {
        return (
          `<select class="ds-in" data-spec="${esc(f.key)}">` +
          `<option value=""${cur === "" ? " selected" : ""}>还没有设置</option>` +
          decl.values
            .map((v) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(v)}</option>`)
            .join("") +
          `</select>`
        );
      }
      const step = decl.kind === "money" ? ' step="0.01"' : ' step="1"';
      return (
        `<input class="ds-in" type="number" data-spec="${esc(f.key)}" ` +
        `value="${esc(cur)}" min="${decl.min}" max="${decl.max}"${step} placeholder="还没有设置">`
      );
    };
    const cell = (f) =>
      `<tr${f.state === "invalid" ? ' class="bad"' : ""}>` +
      `<td class="ds-k">${esc(f.label)}${f.gate ? `<span class="chip gate">硬闸</span>` : ""}</td>` +
      `<td class="ds-v">${control(f)}` +
      (f.state === "invalid" ? `<div class="ds-err">${esc(f.detail)}</div>` : "") +
      `</td></tr>`;
    const gatesNote = group === "budget"
      ? `<div class="meta">两个硬闸<b>fail closed</b>：上限没设置时，付费生成与自动重试` +
        `<b>一律不执行</b>——「没有上限」不等于「不限」。超过上限即拒绝并说明，` +
        `不是弹一句「确定吗」。</div>`
      : "";
    return (
      head(
        group === "spec" ? "成片规格" : "预算与限制",
        group === "spec"
          ? "成片规格与预算的唯一编辑入口就是这一页（IA §4 ⚙）；① 项目与创意只读展示。"
          : "「单次生成上限」与「重试上限」是硬闸，交付质检的「规格」项也读这一页。",
        `<span class="chip${st.complete ? " ok" : " gate"}">` +
        `${st.complete ? "全部已设置" : `${st.missing.length} 项还没有设置`}</span>`,
      ) +
      `<table class="ds-tbl">${rows.map(cell).join("")}</table>` +
      `<div class="meta">留空 = 「还没有设置」，而不是 0：交付质检读到未设置的项会判 ` +
      `<code>unavailable</code>，<b>绝不判定为通过</b>。清空一个已填的值也是合法操作。</div>` +
      gatesNote
    );
  }

  /** The page-level 「询问 Agent」 entrance + the panel itself (TASK-073 §1.4).
   *
   *  TWO ENTRANCES ONLY (IA §6.1): this fixed one, and the object-level 「让 Agent
   *  处理」 a card renders. Closed, the panel occupies NO layout — it is opened on
   *  demand, not a standing sidebar, so an occasional feature does not narrow every
   *  page permanently.
   *
   *  The model is assembled from REAL state: the capability's own missing-input
   *  check and the executor probe decide whether the primary action exists at all,
   *  so 「不可用」 always carries the actual reason (IA §6.4). */
  function agentEntrance() {
    // 产品负责人 2026-08-30：「最上层的那个询问 agent 不需要了。删了吧。」
    //
    // 它当初是「打开对话」的入口（IA §6.1 的两个入口之一）。**对话现在一直在右栏**，
    // 所以这条横幅只是一个「跳到输入框」的按钮 —— 每一页顶部占一行，去换一次
    // 本来点右边就能做的事。入口没有少：右栏永远在，卡片上的「让 Agent 处理」也还在。
    return "";
  }

  /** The task rows for the shot being made (TASK-073 §1.3).
   *
   *  Below the step's own workspace, because they are ABOUT that shot's production
   *  rather than part of the step's controls: 状态 / 耗时 / 成本 / 失败原因 / 重试 /
   *  真实取消, for every run this shot has. Scoped to the selected shot — a
   *  project-wide run log here would bury the one row that needs a decision.
   *
   *  `Date.now()` is read HERE and passed in, so `taskRowModel` stays pure. */
  function shotTaskRows(ctx) {
    const shotId = ui.selectedShotId || null;
    if (!shotId) return "";
    const runs = ctx.skills.runs() || [];
    const mine = runs.filter((r) => r && r.context && r.context.shotId === shotId);
    const models = mine
      .slice()
      .reverse()
      .slice(0, 8)
      .map((r) => taskRowModel(r, { nowMs: Date.now() }));
    return (
      `<div class="tk-block">` +
      `<div class="lab">这个镜头的任务</div>` +
      renderTaskRows(models, { emptyText: "这个镜头还没有发起过任务" }) +
      `</div>`
    );
  }

  /** The in-page section nav. For ⑧ 镜头制作 this IS the four-step flow bar (§1.3),
   *  which is why the steps are numbered in `SECTION_LABEL` rather than here — one
   *  list, so the bar and the resolver cannot disagree about what step ② is. */
  function sectionNav(module) {
    const list = PAGE_SECTIONS[module];
    if (!list || list.length < 2) return "";
    const cur = sectionOf(module);
    const cls = module === "shotwork" ? "st-steps" : "st-secnav";
    return (
      `<nav class="${cls}">` +
      list
        .map(
          (k) =>
            `<button class="st-secitem${k === cur ? " on" : ""}" data-sec="${esc(k)}">` +
            `${esc(SECTION_LABEL[k] || k)}</button>`,
        )
        .join("") +
      `</nav>`
    );
  }

  const WORKSPACES = {
    // --- 故事开发 (project-level upstream) --------------------------------- //
    // ① 故事核心 / ② 故事大纲（TASK-122 第 3 步）—— 产品负责人 2026-08-30 的规格：
    // 各自**只有一个编辑器**。旧的字段表单不再画在屏幕上，但它写下的内容**迁进了**
    // 新编辑器（`seedWork`），所以「不删旧数据」不只是技术上的说法。
    brief: (ctx) => renderCoreWs(ctx, ui),
    story: (ctx) => renderOutlineWorkWs(ctx, ui),
    characters: (ctx) => renderBibleWs(ctx, ui),
    // ③ 作品设定 (TASK-073 §1.1) — ONE page whose three sections are the surfaces
    // that used to be three rail rows. `settings` was already this workspace's
    // legacy key, so every existing jump target keeps landing here; what is new is
    // that 世界观 is now a SECTION of it instead of a page of its own.
    settings: (ctx) => {
      const sec = sectionOf("settings");
      if (sec === "world") return sectionNav("settings") + renderWorldWs(ctx, ui);
      // the bible workspace's own tab follows the section, so 人物关系 as a SECTION
      // and 人物关系 as a TAB (TASK-065 §2) stay one thing rather than two
      ui.bibleTab = sec === "relationships" ? "relationships" : "characters";
      return sectionNav("settings") + renderBibleWs(ctx, ui);
    },
    // TASK-065 §2: 人物关系 is a TAB of 人物 now, but the module KEY stays working —
    // the Director's blocker fixes and several empty states jump to it, and a jump
    // target that resolves to nothing is a regression, not a migration. `setModule`
    // opens 人物 on the relationship tab; this entry is what it renders.
    relationships: (ctx) => renderBibleWs(ctx, ui),
    world: (ctx) => renderWorldWs(ctx, ui),
    // ③ 结构规划（第 4 步）：三个入口 —— 结构表 / 角色设计 / 场景设计
    // （产品负责人 2026-08-30：「结构里面分不同的入口。先是现在的表格，然后进入
    // 角色设计和场景设计。这都会成为之后小说剧集制作的基础财产。」）。
    //
    // 角色设计与场景设计**复用既有的人物 / 世界观工作区**：那就是「基础财产」本身，
    // 在这里另存一份等于让同一个角色有两个真相。作品设定那一页的地址也一条没动。
    //
    // **不挂分集选集器**（「结构规划不应该跳到剧集制作」）—— 通往生产线的那道门
    // 只开在「正文创作 · 剧集创作」里。
    episodes: (ctx) => {
      const sec = sectionOf("episodes");
      if (sec === "cast") {
        ui.bibleTab = "characters";
        return sectionNav("episodes") + renderBibleWs(ctx, ui);
      }
      if (sec === "places") return sectionNav("episodes") + renderWorldWs(ctx, ui);
      return sectionNav("episodes") + renderPlanWs(ctx, ui);
    },
    // ④ 正文创作（第 5 步）：形态入口 → Planned 数量 → 页内章/集选择器 → 单元视图。
    script: (ctx) => renderDraftWs(ctx, ui),

    // --- TASK-073 §1.1/§1.2: the FIVE 剧集制作 pages ------------------------ //
    //
    // COMPOSED FROM THE EXISTING WORKSPACES, never rewritten (§0 的贯穿规则:
    // 「组件复用优先于重写」). Each page is a section nav over the components that
    // already implement those capabilities, so this round changes WHERE a thing is
    // reached, not what it does. Deleting the old entrance is TASK-074's job.
    //
    // ⑥ 本集看板 — the episode's own status view.
    board: (ctx) => sectionNav("board") + renderEpisodeWs(ctx, ui),
    // ⑦ 分镜设计 — scenes list and shot list, two sections of one page.
    storyboard: (ctx) =>
      sectionNav("storyboard") +
      (sectionOf("storyboard") === "scenes"
        ? ws.renderEpisodes(ctx)
        // ④ 那条横向带在**分镜**这一节的顶部（TASK-095 §2.4）：判断「前后接得顺不顺」
        // 要跨镜看，而分镜表本身就是这一屏。不新增页面（ADR-0066 决策 10）。
        // ④ 那条带 + ⑤ 那张全集清单，都在**分镜**这一节：④ 判断前后接不接得顺，
        // ⑤ 说清还差哪几镜；合成本身在单镜画布上做（TASK-095 §1.3）。
        : renderStoryboardStrip(ctx.storyboard.model(), ui)
          + renderKeyframeList(ctx.keyframe.list())
          + renderStoryboard(ctx, ui)),
    // ⑧ 镜头制作 — the FOUR STEPS of one shot's production (§1.3). Each step is the
    // workspace that already did that step; the flow bar is the section nav.
    shotwork: (ctx) => {
      const step = sectionOf("shotwork");
      // 「一键合成全部提示词」是**集级**动作（TASK-095 §2.3），所以它在这一页顶部，
      // 而不是某一镜的卡片里。批次壳走 batchpay（批次 4D 把它接上）。
      // 集级动作，所以它在这一页顶部常驻（ 的四个 section 里都能看到）——
      // 「prompt」不是一个 section（shell 的 SECTIONS 里只有 prepare/image/video/pick），
      // 按不存在的 section 判断等于这块永远不出现。
      const batchBar = renderPromptBatch(ctx.promptBatch.model());
      const inner = step === "image"
        ? renderImageWs(ctx, ui)
        : step === "video"
          // ⑥ 批量生视频是**集级**动作（TASK-095 §2.5 末段），所以在这一节顶部；
          // 单镜生成仍在下面的工作区里，各走各自的两步确认。
          //
          // 挂在**这一处**而不是模块渲染器那张表里：`shotwork` 这一页自己切 section，
          // 模块表里的 `video:` 是另一条路由。4F 的那条带也踩过同一个坑 ——
          // 两处都叫 video，而屏幕上只走这一处。
          ? renderVideoBatch(ctx.videoBatch.model()) + renderVideoWs(ctx, ui)
          // ④ 对比候选并选定 IS 检查层 1 (§1.3): the same dailies component, on one
          // shot. No separate review page is created.
          : step === "pick"
            ? renderDailies(ctx, ui)
            // 第 ② 步「准备资产」（TASK-095 §2.2）就在这一节里，参考统筹之上：
            // 一个是「这一集要哪些设定图」，一个是「每个镜头绑了哪些参考」——
            // 同一屏的两层，不是两页（ADR-0066 决策 10：不新增页面）。
            : renderAssetPrep(ctx, ctx.assetPrep.model(), ui) + renderRefPlan(ctx, ui);
      // STEP ① also opens the asset drawer (§1.1 落点表: `refplan` → ⑧ 步骤①「并打开
      // 资产抽屉」). It is the SAME component as ⑪ 资产库, at drawer size (§1.6).
      const drawer = step === "prepare" && ui.alDrawer === true
        ? renderAssetLibrary(ctx, ui, { mode: "drawer", shotId: ui.selectedShotId || null })
        : "";
      const drawerBtn = step === "prepare"
        ? `<button class="btn sm al-dopen" data-al-drawer-open="1">` +
          `${ui.alDrawer ? "收起参考抽屉" : "+ 添加参考（打开资产抽屉）"}</button>`
        : "";
      return sectionNav("shotwork") + drawerBtn + batchBar + drawer + inner + shotTaskRows(ctx);
    },
    // ⑨ 粗剪审片 — the episode-wide playback + issue marking (检查层 2).
    // ⑨ 粗剪审片 is the EPISODE-WIDE storyboard (TASK-079 §1.1); ⑧ step ④ keeps
    // the per-shot walk. They were the same renderer, which is why 「看不过来」
    // had no surface that could answer it.
    cutreview: (ctx) => renderCutReview(ctx, ui),
    // ⑩ 后期交付 — the post console at full size, with its seven sections.
    delivery: (ctx) => {
      // 「这一集后期还差什么」是**页面级**的问题，所以这一条在 section 之上（批次 5A）：
      // 七个 section 都在它下面。挂进某一个 section 等于让创作者必须先猜对去哪一节
      // 才能看到还差什么。
      const status = renderPostStatus(ctx.postStatus.model());
      // 交付质检 is a section of its OWN (§1.2 新增), not a corner of the post
      // console: it is the only place that answers 「这条片子能不能导出」, and G4's
      // verdict has to be readable next to the rows it came from.
      if (sectionOf("delivery") === "qc") {
        // 两份报告，各答一个问题（批次 5B）：**逐镜质检**说这一集每一镜对不对，
        // **交付质检**说这条成片能不能导出。合成一份会让「哪一镜有问题」和
        // 「这条片子能不能出」互相盖住。
        return sectionNav("delivery") + status
          + renderShotQc(shotQcModel(ctx)) + renderQcPanel(ctx.deliveryQc());
      }
      return sectionNav("delivery") + status + renderPostConsole(ctx, ui, { mode: "full" });
    },
    // ⚙ 项目设置 — its own route key, NOT `settings` (§1.7). Only the 存储与诊断
    // section has an implementation today (`storagews`, plus the provenance
    // diagnostic view); the other three are declared and honestly empty rather
    // than pretending to be elsewhere.
    [PROJECT_SETTINGS]: (ctx) => {
      const sec = sectionOf(PROJECT_SETTINGS);
      const nav = sectionNav(PROJECT_SETTINGS);
      if (sec === "storage") return nav + renderStorageWs(ctx, ui);
      if (sec === "spec" || sec === "budget") return nav + renderSpecSection(ctx, sec);
      if (sec === "skills") return nav + renderSkillCatalog(skillCatalogModel(ctx, ui));
      if (sec === "health") return nav + renderHealth(healthModel(ctx.health ? ctx.health.get() : {}));
      return (
        nav +
        empty(
          "⚙",
          "项目信息还没有接线",
          "本轮搭好了 ⚙ 的分区与路由、成片规格与预算的字段清单，以及两个硬闸的领域实现。",
        )
      );
    },
    // --- 剧集制作 (inside ONE episode) ------------------------------------- //
    // TASK-065 §9: `workbench` (制作台) is this space's CENTRE — a light Scene → Shot
    // picker over the CURRENT shot's production graph. It is rendered by
    // ui/epprod.js + ui/shotgraphview.js, not here, and its graph HTML is passed in
    // by render() so bind() can hand the SAME model to the edge painter.
    // `provenance` is a VIEW of this space: the graph mounts into a container the
    // shell hands it, so the node detail can live in the LEFT inspector.
    workbench: () => "",
    provenance: () => `<div class="ep-graph" id="ep-graph"></div>`,
    // ADR-0061 决策 6 / TASK-064 Phase 3: 剪辑 IS the Post Production Console,
    // full-size. The dock under the centre and this are the SAME component in two
    // sizes — 「展开 ↗」 must not open a different tool than the strip it came from,
    // and there must be exactly one implementation of any post operation.
    edit: (ctx) => renderPostConsole(ctx, ui, { mode: "full" }),
    episode: (ctx) => renderEpisodeWs(ctx, ui),
    refplan: (ctx) => renderAssetPrep(ctx, ctx.assetPrep.model(), ui) + renderRefPlan(ctx, ui),
    scenes: (ctx) => ws.renderEpisodes(ctx),
    shots: (ctx) => renderStoryboardStrip(ctx.storyboard.model(), ui) + renderStoryboard(ctx, ui),
    frames: (ctx) => renderImageWs(ctx, ui),
    // ⑥ 批量生视频是**集级**动作（TASK-095 §2.5 末段），所以在这一屏顶部；
    // 单镜生成仍在下面的工作区里，各走各自的两步确认。
    video: (ctx) => renderVideoBatch(ctx.videoBatch.model()) + renderVideoWs(ctx, ui),
    audio: (ctx) => renderAudioWs(ctx, ui),
    dailies: (ctx) => renderDailies(ctx, ui),
    // 存储管理 stays the storage MANAGER (archive / remove bytes / delete);
    // 资产库 is the visual-first Production Memory Library (CP5). ADR-0061 决策 1
    // gives it a rail of media CATEGORIES: each key simply presets the library's
    // own type filter, so there is one library and one filter vocabulary rather
    // than seven near-identical workspaces.
    storage: (ctx) => renderStorageWs(ctx, ui),
    // REQ-004 v2: 资产收件箱 moved OUT of the retired 导演台 and into the workspace of
    // the space whose subject is assets — it is the only surface where an asset's
    // ownership gets confirmed, so it could not go with the console.
    assets: (ctx) => renderAssetInboxSection(ctx.prodData()) + renderAssetLibrary(ctx, ui),
    "assets:reference": (ctx) => renderAssetInboxSection(ctx.prodData()) + renderAssetLibrary(ctx, ui),
    "assets:image": (ctx) => renderAssetLibrary(ctx, ui),
    "assets:video": (ctx) => renderAssetLibrary(ctx, ui),
    "assets:audio": (ctx) => renderAssetLibrary(ctx, ui),
    "assets:final": (ctx) => renderAssetLibrary(ctx, ui),
    "assets:collection": (ctx) => renderAssetLibrary(ctx, ui),
  };

  /** Shot workspaces open on a real shot: an empty centre column next to a
   *  populated episode is exactly the blank-space failure the studio is meant
   *  to avoid. A selection that no longer resolves (draft regenerated, episode
   *  switched) falls back the same way — it is never left dangling. */
  function ensureShotSelection(pd) {
    // The 制作台 leads this list because the whole centre IS the
    // current shot now: with no selection there is no graph to draw and the LEFT
    // column would greet the creator empty. A scene/shot chip immediately overrides
    // it — this is only the starting object.
    // TASK-073: ⑧ 镜头制作 and ⑦ 分镜设计 are added because they are where per-shot
    // work now happens — a shot page opening on 「先选一个镜头」 with a selection that
    // silently failed to resolve is the blank-centre failure this guards.
    if (![
      LEGACY_EPISODE_CENTRE, "provenance", "shots", "frames", "video",
      "shotwork", "storyboard",
    ].includes(activeModule)) return;
    // scoped to the ACTIVE episode PLUS the unassigned pool: the previous
    // episode's shot still exists in the project-wide draft, so a draft-wide
    // check would keep it selected under the episode just switched to — but the
    // unassigned pool is rendered as selectable and belongs to no episode, so
    // rejecting it would snap the selection back the moment one is clicked
    if (isSelectableShot(pd, ui.selectedShotId)) return;
    if (ui.dirty) return; // never discard an in-progress edit to re-point
    ui.selectedShotId = defaultShotId(pd);
  }

  function render() {
    const ctx = getCtx();
    // 第一次画这个项目时把旧结构迁进新模型（只灌一次）—— 一个空编辑器等于把他
    // 已经写好的东西从屏幕上抹掉，那不叫「旧数据还在」（TASK-122 第 3 步）。
    try { seedWork(ctx); } catch { /* 迁移失败不许挡住整页 */ }
    const pd = ctx.prodData();
    ensureShotSelection(pd);
    // project-wide badges, with the 本集制作 stages overridden by the episode's
    // own standing (a stage listed under "this episode" must count this episode)
    const stages = episodeStages(pd);
    // CP4: the 审片 badge is the episode's REVIEW standing — approved / total,
    // derived (nothing but the approvals themselves is stored)
    const dailies = ctx.dailies.model();
    const badges = {
      ...navBadges(ctx.script.doc(), pd),
      ...stages.badges,
      dailies: dailies.total ? `${dailies.approved}/${dailies.total}` : "",
    };
    const ratios = dailies.total
      ? { ...stages.ratios, dailies: { done: dailies.approved, total: dailies.total } }
      : stages.ratios;
    // TASK-057: per-episode count of upstream surfaces the episode is behind —
    // the deterministic dependency truth from ctx.canon, computed nowhere else
    const upstream = {};
    for (const e of pd.production.episodes) {
      const im = ctx.canon.impact(e.episodeId);
      if (im && im.count) upstream[e.episodeId] = im.count;
    }
    const space = spaceOf(activeModule);
    ensureProbe(ctx);
    ensureMediaProbe(ctx);
    ensureHealth(ctx);
    // The grid differs per space (a 220px rail vs a 300px inspector), and the
    // CSS decides from ONE class so no two rules can disagree about which
    // space is on screen.
    root.className = `space-${space}`;
    // recomputed below only where the graph is the centre; cleared here so a
    // previous render's node can never be read by this one's bind()
    provNode = null;
    shotGraph = null;
    shotRefs = null;
    refSearch = null;
    onShotBench = false;
    // EVERY page carries the page-level Agent entrance at its top-right (IA §6.1).
    // Prepended to the workspace rather than injected per page, so the entrance is
    // 「每页顶部右侧固定位」 by construction and cannot be forgotten by a new page.
    //
    // §1.2 批次 B: the BUTTON is still here — what it opens is no longer a second
    // panel in this column, but the one session in the right one.
    const main =
      agentEntrance() +
      (WORKSPACES[activeModule] || (() => ""))(ctx);

    if (space === "episode") {
      // TASK-066 §17 — FIVE REGIONS, each answering ONE question:
      //
      //   TOP     Episode / Scene / Shot  —— 我在做哪一个 Shot
      //   LEFT    参考输入                —— 这个 Shot 引用了哪些视觉资产
      //   CENTER  制作流程图              —— 它怎么被做出来
      //   RIGHT   AI 导演                 —— 还缺什么，下一步是什么
      //   BOTTOM  参考素材库              —— 已有的视觉素材，一键加入这个 Shot
      //   FOOTER  Shot 进度               —— 做到哪一步了
      //
      // Everything is resolved ONCE here and handed down, so no two regions can
      // disagree about which shot is current.
      const wm = workbenchModel(ctx, ui);
      const place = currentPlace(wm, ui.selectedShotId);
      const onCentre = activeModule === LEGACY_EPISODE_CENTRE;
      // TASK-067: the shot workbench = the centre WITH a shot chosen. The AI
      // Director's operations are all about one shot, so anywhere else they would be
      // buttons with no subject.
      onShotBench = onCentre && !!ui.selectedShotId;
      provNode = activeModule === "provenance" ? ctx.provenanceSelection() : null;
      shotGraph = onCentre && ui.selectedShotId
        ? ctx.shotgraph.model(ui.selectedShotId)
        : null;
      // the LEFT column's own model: the two reference groups, what is still
      // addable per group, and the frame standing
      shotRefs = onCentre && ui.selectedShotId ? shotRefsModel(ctx, ui.selectedShotId) : null;
      // the BOTTOM searcher, filtered to VISUAL assets only (§16)
      refSearch = onCentre
        ? searchModel(
            ctx.assets.library({ type: "all", variant: "all" }).rows,
            new Set(ui.selectedShotId ? ctx.shot.references(ui.selectedShotId) || [] : []),
            { query: ui.rsQuery, type: ui.rsType },
          )
        : null;
      // ADR-0061 决策 6 / TASK-066 §15: the Post Production Console is NO LONGER
      // docked under this centre — audio, subtitles and the cut belong to 后期制作,
      // and this space ends at 「选定的最终 Shot Video」. NOTHING was deleted: the
      // console keeps its full-size form as the `剪辑` module, one click away in
      // 工作区 ▾, and the bottom strip is the reference searcher instead.
      // ⑩ 后期交付 is the post console at full size, and so was the legacy 剪辑 key
      const isConsole = activeModule === "edit" || activeModule === "delivery";
      // TASK-077 §1.5 — the space finally has a LEFT RAIL naming its five pages.
      // Resolved first, so a legacy key (`frames`, `dailies`, …) highlights the page
      // it now lands on; `workbench` / `provenance` resolve to nothing and highlight
      // nothing, which is the honest answer for a surface the IA does not name.
      const railHit = resolveModule(activeModule);
      const epNow = wm.empty
        ? (wm.episodes || []).find((e) => e.active) || null
        : (wm.episodes || []).find((e) => e.episodeId === wm.episodeId) || null;
      const epRail =
        `<nav class="st-rail prod-nav prod-eprail">` +
        renderEpisodeRail({
          activeModule: railHit.resolved ? railHit.module : null,
          episodeCode: epNow ? epNow.code : "",
          episodeTitle: epNow ? episodeTitleBeside(epNow.code, epNow.title) : "",
        }) +
        `</nav>`;
      rememberFlowScroll();
      root.innerHTML =
        crumb(ctx) +
        (onCentre ? renderShotSelect(ctx, ui, wm, place) : "") +
        epRail +
        (onCentre
          ? renderShotRefs(ctx, ui, shotRefs)
          : renderInspector(ctx, ui, {
              node: provNode,
              traceMode: ctx.relationsMode ? ctx.relationsMode() : "full",
            })) +
        `<main class="st-main prod-main ep-main${ui.sgFull ? " full" : ""}">` +
        renderEpProd(ctx, ui, {
          stage: activeModule,
          inner: main,
          graph: shotGraph
            ? // TASK-093 批次 3: the canvas is now WRITABLE, and these four blocks are
              // where that shows. Mounted here rather than left for a later batch —
              // batch 2's lesson was that an unwired module reads exactly like a
              // finished feature (TASK-097 §2.5c).
              // `ctx.shot.stageBoard`, not `ctx.shotgraph.*` — the six stages belong to
              // the SHOT (TASK-092), and the canvas is one of their readers. Caught by
              // opening the real project: the page threw twice while still rendering a
              // perfectly plausible screenshot (TASK-097 §2.6.4 — 测试不替代去看真实屏幕).
              renderStageChips(shotGraph.shotId ? ctx.shot.stageBoard(shotGraph.shotId) : null) +
              renderReferenceArea(
                shotGraph.shotId ? ctx.shotgraph.referenceArea(shotGraph.shotId) : null,
                REFERENCE_CATEGORIES,
              ) +
              // ABOVE the graph, not below it. Rendered after `renderShotGraph` at
              // first, which put it in the DOM and off the bottom of the canvas
              // column — the primary new affordance of this batch was invisible on
              // the real screen while every test passed (TASK-097 §2.6.4).
              // NO SHOT, NO CANVAS CONTROLS (codex 轮 3, P1). `bindShotGraph` returns
              // early on an empty graph, so these rendered with no handlers — clickable
              // and inert. And semantically 「添加到这块画布」 means nothing before a shot
              // is chosen: there is no skeleton to add to. Gating the RENDER is the
              // honest fix; the empty state already says 「先选一个镜头」.
              (shotGraph.shotId ? renderAddMenu(ctx.shotgraph.addable()) : "") +
              // ADR-0075 的可见形式。0/60 那个填充率就在这里被解决 —— 一次点击。
              (shotGraph.shotId ? renderCameraPresets(ctx.shotgraph.cameraPresets(shotGraph.shotId)) : "") +
              renderShotGraph(shotGraph, {
                selectedId: ui.sgNode,
                layout: ui.sgLayout || "auto",
                menuOpen: ui.sgMenu,
              }) +
              (ui.sgNode && shotGraph.shotId
                ? renderChainMenu(ctx.shotgraph.chain(
                    shotGraph.shotId,
                    shotGraph.nodes.find((n) => n.id === ui.sgNode) || null,
                  ))
                : "")
            : null,
        }) +
        `</main>` +
        aiDirector(ctx) +
        // 剧集制作向导 (TASK-095 / 批次 4A) —— 一层**覆盖面**，不是页面。
        // `PAGES.length === 11` 那条冻结守卫不碰（ADR-0066 决策 10）：新界面最容易
        // 顺手多开一页，而向导是既有内容的重新组织，不是第十二页。
        (ui.pwOpen
          ? renderProdWizard(prodwizard.wizardModel({
              counts: ctx.prodWizard.counts(),
              readyOf: ctx.prodWizard.readyOf,
              // NO `|| "shots"` HERE: the model picks the first unfinished step when the
              // creator has not chosen one. Defaulting again in the shell made the outer
              // default win, so the body showed a finished ① while the header said the
              // next step was ② — two places deciding one thing (§2.5e).
              activeId: ui.pwStep || null,
            }))
          : "") +
        (onCentre && !ui.sgFull ? renderRefSearch(ctx, ui, refSearch) : "") +
        (onCentre && shotGraph
          ? `<footer class="ep-foot"><span class="lb">Shot 进度</span>` +
            renderStages(shotGraph, (shotGraph.stages.find((x) => x.state === "doing") || {}).key) +
            `<span class="push"></span>` +
            `<span class="ep-footnote">${shotGraph.done
              ? "这一镜已经有选定的最终视频 —— 剧集制作对它的工作完成了"
              : "剧集制作的终点是「选定的最终 Shot Video」；音频与剪辑属于后期制作"}</span>` +
            `</footer>`
          : "") +
        (isConsole ? "" : "");
      bind(ctx);
      restoreFlowScroll();
      if (shotGraph) drawShotEdges(root, shotGraph);
      notify();
      return;
    }

    if (space === "assets") {
      rememberFlowScroll();
      root.innerHTML =
        crumb(ctx) +
        `<nav class="st-rail prod-nav">` +
        renderAssetTree(
          assetTreeModel(ctx.assets.library({ type: "all", variant: "all" }).rows, ctx.assets.names()),
          ui.alFilters || {},
        ) +
        renderAssetRail({ activeModule, counts: assetRailCounts(ctx) }) +
        `</nav>` +
        `<main class="st-main prod-main">${main}</main>` +
        aiDirector(ctx);
      bind(ctx);
      restoreFlowScroll();
      notify();
      return;
    }

    const rail = renderRail({
      activeModule,
      badges,
      episodes: episodeLabels(pd.production),
      ratios,
      upstream,
    });
    rememberFlowScroll();
    root.innerHTML =
      crumb(ctx) +
      `<nav class="st-rail prod-nav">${rail}</nav>` +
      `<main class="st-main prod-main">${main}</main>` +
      aiDirector(ctx);
    bind(ctx);
    restoreFlowScroll();
    notify();
  }

  /** Tell the top bar where the creator now is. Called at the END of every
   *  render path, from the shell's own state — never from the callers that move
   *  it, so a new mover cannot forget to sync the bar. */
  function notify() {
    if (onNavigate) onNavigate(spaceOf(activeModule), activeModule);
  }

  /**
   * Open a card on the centre graph (from the left column's 查看资产 / frame rows).
   *
   * A REFERENCE is a thumbnail in a cluster, not a card with a `⋮` menu — so setting
   * `sgMenu` for one made 「查看资产」 visibly do nothing (codex review round 2). For a
   * reference, 查看 means SHOW THE ASSET: it opens the lightbox, which is what the word
   * says, and highlights it on the graph so the creator can see where it sits.
   */
  function openShotCard(ctx, want) {
    if (!shotGraph) return;
    const n = shotGraph.nodes.find((x) =>
      (want.type === "reference" && x.refKey === want.refKey)
      || (want.type !== "reference" && x.type === want.type));
    if (!n) { ctx.toast("这一镜的关系图里还没有这个对象"); return; }
    ui.sgNode = n.id;
    if (n.type === "reference") {
      ui.sgMenu = null;
      if (n.assetId && ctx.lightbox) ctx.lightbox(n.assetId);
      else if (!n.assetId) ctx.toast("这个参考的字节不在本地（记录仍在），没有可预览的内容");
      render();
      return;
    }
    // a CARD has a menu, so opening it is the right move
    ui.sgMenu = n.id;
    render();
  }

  /**
   * A CARD ACTION (TASK-066 §10). Three verbs on every media card — 上传 / 自动生成 /
   * 修改 — plus the prompt cards' 查看/修改/复制 and the frame card's 提取.
   *
   * 自动生成 IS HONEST ABOUT WHAT IS CONNECTED (§11):
   *
   *   a PROMPT   really runs the Prompt Director skill. That capability exists, it
   *              produces a recorded proposal, and applying it is a separate click.
   *   a MEDIA    has NO provider wired. So it says exactly that and hands over the
   *              route that works — copy the Prompt + references, generate outside,
   *              upload back. A button that pretended to generate would leave the
   *              creator waiting for something that is never coming, which is the
   *              worst lie this UI could tell.
   */
  function cardAction(ctx, act, n, g) {
    const shotId = g.shotId;
    const genKind = n.type === "video" || n.id === "prompt:video" ? "video" : "image";
    if (act === "view" || act === "edit") {
      // 修改 opens the object's editing surface. For a prompt that is the prompt
      // editor; for media it is the version list + upload, which is the inspector's
      // panel — reached as a focused drawer rather than as a permanent column.
      ui.inspect = n.type === "prompt"
        ? { kind: "prompt", shotId, genKind }
        : { kind: n.type === "video" ? "video" : "image", shotId };
      ui.sgMenu = null;
      setModule(n.type === "prompt" ? "refplan" : n.type === "video" ? "video" : "frames");
      return;
    }
    if (act === "copy") {
      const eff = ctx.prompt.effective(shotId, genKind, ctx.episode.genModel(shotId, genKind).prompt);
      ctx.episode.copyPrompt(eff.text);
      ui.sgMenu = null;
      render();
      return;
    }
    if (act === "generate") {
      ui.sgMenu = null;
      if (n.type === "prompt") {
        // TASK-067 §7 / §8: really run the Image / Video Prompt Director for THIS
        // shot. Which one is decided by the card, not by a tab — an Image Prompt
        // card must never run the video capability.
        //
        // Before this round the button selected the generic `prompt-director` in the
        // capability catalog and asked the creator to press run themselves.
        runOperation(ctx, ui, genKind === "video" ? "videoPrompt" : "imagePrompt", shotId)
          .then((res) => {
            if (!res.ok) ctx.toast(`未能生成：${res.error}`);
            else if (res.manual) ctx.toast("已建立运行记录——在右侧「AI 导演」复制任务 Prompt，跑完把结果粘回来");
            else ctx.toast("提案已生成——在右侧「AI 导演」里「应用」后才写进 Prompt 版本");
            render();
          });
        return;
      }
      // NO MEDIA PROVIDER. Say so, and give the route that works.
      const eff = ctx.prompt.effective(shotId, genKind, ctx.episode.genModel(shotId, genKind).prompt);
      ctx.episode.copyPrompt(eff.text);
      ctx.toast(
        `还没有接入生图 / 生视频的 API —— Prompt 已复制。` +
        `拿它和左栏的参考去外部工具生成，回来用「上传新版」传回这张卡片，` +
        `系统会自动登记资产、记下版本与溯源。`,
      );
      render();
      return;
    }
    if (act === "upload") {
      ui.sgMenu = null;
      // ONE import path (ADR-0055): the file becomes an Asset on this shot AND freezes
      // the prompt + reference inputs it was made from, so the provenance is real.
      const input = document.createElement("input");
      input.type = "file";
      input.accept = n.type === "video" ? "video/mp4,video/webm" : "image/png,image/jpeg,image/webp";
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const eff = ctx.prompt.effective(shotId, genKind, ctx.episode.genModel(shotId, genKind).prompt);
        ctx.episode
          .importResult(shotId, genKind, file, eff.text)
          .then(() => {
            ctx.toast("已上传并登记：成为这一镜的新版本，并自动成为当前选定");
            render();
          })
          .catch((e) => ctx.toast(`上传失败：${e.message}`));
      };
      input.click();
      return;
    }
    if (act === "history") {
      ui.inspect = { kind: n.type === "video" ? "video" : "image", shotId };
      ui.sgMenu = null;
      setModule(n.type === "video" ? "video" : "frames");
      return;
    }
    if (act === "provenance") {
      ui.sgMenu = null;
      setModule("provenance");
      return;
    }
    if (act === "extract" || act === "extractbind") {
      ui.sgMenu = null;
      const target = act === "extractbind" && n.nextShot ? n.nextShot.shotId : null;
      ctx.frames
        .extract(shotId, { pick: "last" })
        .then((out) => {
          if (!target) {
            ctx.toast(`已提取尾帧并登记为派生帧（来自视频 v${out.source.sourceVideoVersion ?? "?"}）`);
            render();
            return;
          }
          const bound = ctx.frames.bind(target, "startFrame", { assetId: out.assetId, source: out.source });
          ctx.toast(bound
            ? "已提取尾帧并设为下一镜的首帧（来源已记录：镜头 / 视频版本 / 时间点）"
            : "帧已登记，但下一镜的首帧槽位已锁定——先解锁再绑定");
          render();
        })
        .catch((e) => { ctx.toast(`提取失败：${e.message}`); render(); });
      return;
    }
    ctx.toast(`「${act}」还没有接线`);
  }

  /**
   * The LEFT column's model (TASK-066 §4 / §6).
   *
   * `groups` is `ctx.refUse.groups` — the SAME split the two prompt compilers were
   * given, so a card cannot claim a side the prompt did not get. `library` is what is
   * still addable per group, so 「+ 添加参考」 never offers something already bound.
   * `frames` carries the continuity standing including drift, because a start frame
   * whose upstream video moved on is the one thing a creator must not miss.
   */
  function shotRefsModel(ctx, shotId) {
    const groups = ctx.refUse.groups(shotId);
    const boundKeys = new Set((ctx.shot.references(shotId) || []));
    const all = ctx.assets.references();
    const forGroup = (roles) => all
      .filter((r) => roles.includes(r.kind) && !boundKeys.has(r.key))
      .map((r) => ({ key: r.key, kind: r.kind, name: derivedLabel(r), version: r.version }));
    const d = ctx.prodData();
    const detail = shotDetailModel(d, shotId);
    const notice = ctx.frames.notice(shotId, "startFrame");
    const frames = detail
      ? {
          start: detail.frames.start
            ? {
                ...detail.frames.start,
                drift: notice
                  ? `来源 ${ctx.refplan.shotName(notice.sourceShotId) || "未记录镜头"} 视频 v${notice.sourceVideoVersion}；` +
                    `该镜头当前是 ${notice.activeSourceVersion != null ? `v${notice.activeSourceVersion}` : "未记录"}`
                  : null,
              }
            : null,
          end: detail.frames.end,
        }
      : { start: null, end: null };
    return {
      empty: !detail,
      shotId,
      groups,
      library: {
        image: forGroup(["character-reference", "location-reference", "prop-reference", "style-reference"]),
        video: forGroup(["video-style-reference", "motion-reference", "camera-reference", "performance-reference"]),
      },
      frames,
    };
  }

  /** Per-category counts for the 资产库 rail. Derived from the SAME library read
   *  model the workspace renders, so a rail badge cannot claim assets the list
   *  does not show. */
  function assetRailCounts(ctx) {
    // TASK-082 §1.2: the seven per-category counts went with the seven rows. The
    // page's own chips carry those numbers (`libraryModel.counts`), and a second
    // copy in the rail could only ever disagree with them.
    return { assets: ctx.assets.library({ type: "all", variant: "all" }).rows.length };
  }

  /** Make `shotId` the shot the whole 剧集制作 space is standing on.
   *
   *  ONE function, because the shot chips, the scene chips and 「在左栏打开这个镜头」
   *  must all release the same transient state. The unsaved Prompt / axis / base
   *  prompt buffers belong to the object they were typed against; the graph node
   *  selection belongs to the shot whose graph it was on. Carrying either across a
   *  shot change is how a write lands on the wrong object. */
  function selectShot(shotId) {
    if (!shotId || ui.selectedShotId === shotId) return;
    ui.selectedShotId = shotId;
    ui.sgNode = null;
    ui.piPrompt = null;
    ui.piAxes = null;
    ui.inspect = { kind: (ui.inspect && ui.inspect.kind) || "shot", shotId };
    render();
  }

  /** Open a module. Returns whether the shell is now ON it — false means the move
   *  was refused (unknown key, or the creator kept an unsaved edit), and a caller
   *  must never claim a move that did not happen (TASK-081 §1.2 第 1 条). */
  function setModule(want) {
    if (!WORKSPACES[want] && want !== "script") return false;
    // TASK-065 §2 / §4: 人物关系 is a TAB of 人物, and 场景地 is a TAB of 世界观.
    //
    // The merged keys are RESOLVED HERE, once, rather than at each caller: every
    // existing jump target (`data-goto="relationships"`, the Director's blocker
    // fixes, an empty state's button) keeps working and lands on the right tab of
    // the right workspace. A caller that has not heard about the merge cannot land
    // on a rail row that no longer exists — which would leave the rail with nothing
    // highlighted and the creator unsure where they are.
    let k = want;
    if (want === "relationships") { k = "characters"; ui.bibleTab = "relationships"; }
    else if (want === "characters" && ui.bibleTab === "relationships") ui.bibleTab = "characters";
    // TASK-073 §1.1: …and the SAME rule for the eleven-page collapse. A historical
    // key resolves to its new page AND opens the section that holds what it used to
    // show — landing on a page that does not contain the thing is the same failure
    // as landing nowhere (ADR-0063 决策 1). Legacy keys that still have their own
    // renderer (`characters`, `frames`, …) are left on it: this round deletes
    // entrances, so the old workspace must stay reachable until TASK-074.
    const hit = resolveModule(k);
    if (hit.resolved && hit.filter) {
      ui.alFilters = { ...(ui.alFilters || {}), type: hit.filter };
      k = hit.module;
    } else if (hit.resolved && hit.module !== k) {
      // The redirect is SAFE because the destination section renders the very same
      // component the old key rendered — `frames` → ⑧ step ② is `renderImageWs`
      // either way. What changes is the entrance, which is exactly this round's
      // scope. The old WORKSPACES entry stays in the file (TASK-074 deletes it).
      ui.sections = { ...(ui.sections || {}), [hit.module]: hit.section };
      k = hit.module;
    }
    if (k === activeModule) {
      // the module key did not move, but the TAB may have — repaint so
      // 「在关系图里编辑」 from inside 人物 actually shows the graph
      render();
      return true;
    }
    if (guardsUnsavedEdit(ui, { module: activeModule }, { module: k })
      && !window.confirm("镜头详情有未保存的修改，离开将丢弃？")) return false;
    releasePageState(ui);
    activeModule = k; // UI navigation state only — domain edits/proposals live
    if (spaceOf(k) !== "assets") lastProdModule = k;
    // A 资产库 rail row simply presets the library's OWN type filter — the rail
    // and the in-page filter chips are two entrances to one vocabulary.
    if (k in RAIL_TYPE) ui.alFilters = { ...(ui.alFilters || {}), type: RAIL_TYPE[k] };
    vmenuOpen = false; // in their documents and survive this switch untouched
    // beatsOpen / impactOpen are keyed by episodeId and only render inside
    // 分集规划 — deliberately NOT reset here, so the AI Director can point the
    // creator at one episode's Impact Review and then navigate there.
    render();
    return true;
  }

  /** Drop the transient per-episode selection state. Shared by the two paths
   *  below so selecting and entering can never disagree about what a switch
   *  invalidates. Returns false when the creator refused (unsaved shot edit),
   *  in which case NOTHING was touched. */
  function releaseEpisodeState() {
    if (ui.dirty && !window.confirm("镜头详情有未保存的修改，切换剧集将丢弃？")) return false;
    ui.dirty = false;
    ui.buffer = {};
    ui.selectedShotId = null;
    // the graph node and the buffers typed against it belong to the shot being left
    ui.sgNode = null;
    ui.piPrompt = null;
    ui.piAxes = null;
    return true;
  }

  /** SELECT an episode without going anywhere.
   *
   *  This is what an episode ROW in the 故事开发 rail does, and the distinction is
   *  the whole point: looking at EP02 must not move the creator out of the space
   *  they are working in. The row still switches which episode is active (the
   *  script workspace, the badges and the plan all follow it) — it simply does not
   *  navigate. 「进入剧集制作 →」 is the one thing that navigates. */
  function selectEpisode(episodeId) {
    const ctx = getCtx();
    // Re-clicking the row of the episode already selected changes NOTHING, so it
    // must not prompt about unsaved shot edits or drop the shot selection. The
    // row is the select affordance now, so clicking the current one is a normal
    // thing to do.
    if (ctx.prodData().production.activeEpisodeId === episodeId) return;
    if (!releaseEpisodeState()) return;
    // setActiveEpisode re-renders on success; on failure nothing moved, but the
    // cleared selection still needs painting
    if (!ctx.production.setActiveEpisode(episodeId)) render();
  }

  /** ENTER an episode: switch the active episode AND open one of ITS stages —
   *  story development's explicit exit. `module` null means: stay where you are
   *  if you are already inside 剧集制作, otherwise open the space's own centre.
   *  Refused while a shot detail has unsaved edits, because the buffer belongs to
   *  the episode being left. */
  function enterEpisode(episodeId, module) {
    const ctx = getCtx();
    if (!releaseEpisodeState()) return;
    if (!ctx.production.setActiveEpisode(episodeId)) return;
    // WHERE 「进入剧集制作」 LANDS (产品 2026-08-13: 「点击进入该剧的剧集制作就要有分镜
    // 的生成…定好分镜之后再对各个分镜做详细制作」).
    //
    // An episode with no shot draft has nothing to produce yet: the 制作台 would open
    // on 「先选一个镜头」 with no shots to select. So it lands on 分镜 — generate the
    // shot list, edit it, and only then work shot by shot. Once a draft exists the
    // landing is the 制作台 again, because that is where the work then is.
    //
    // Already inside the space, the stage the creator was on is kept.
    //
    // COUNTED ON THE EPISODE BEING ENTERED, not on the project. `draftShots` is the
    // project-wide draft list, so asking whether IT is empty answered 「这个作品有没有
    // 分镜」 — and an empty EP02 then landed on the 制作台 just because EP01 had shots,
    // which is exactly the 「先选一个镜头」 dead end this rule exists to avoid
    // (codex review round 2). A shot belongs to an episode through its scenes.
    const view = episodeView(ctx.production.doc(), episodeId, ctx.project.draftShots || []);
    const epShots = view
      ? view.scenes.reduce((n, sc) => n + sc.shots.filter((x) => !x.dangling).length, 0)
      : 0;
    const entry = episodeEntryModule(epShots > 0);
    const target = module === EPISODE_DEFAULT
      ? entry                                   // 「进入剧集制作」 asked for the space's entry
      : module || (EPISODE_MODULES.includes(activeModule) ? activeModule : entry);
    if (target !== activeModule) {
      activeModule = target;
      lastProdModule = target;
      lastOf[spaceOf(target)] = target;
      vmenuOpen = false;
    }
    render(); // setActiveEpisode already re-rendered, but the module may have moved
  }

  /** Open ONE bible entity's own card — 人物 or 场景地 — from anywhere.
   *
   *  `setModule` clears the drawer keys on every switch (it must: a drawer left
   *  open across a navigation shows the previous page's selection), so the
   *  selection is written AFTER it and the page repainted. A character on the
   *  临时角色 tab opens THAT tab; landing on 人物 with the card nowhere in the grid
   *  would be the 「落到一个没有该内容的页面」 failure in miniature. */
  function openEntity(ctx, kind, entityId) {
    if (!entityId) return;
    const prod = ctx.prodData().production;
    if (kind === "location") {
      if (!(prod && (prod.locations || []).some((l) => l && l.locationId === entityId))) {
        ctx.toast("这个场景地已经不在作品设定里了");
        return;
      }
      setModule("world");
      ui.worldOpen = entityId;
      ui.bpText = null;
      render();
      return;
    }
    const c = (prod && (prod.characters || []).find((x) => x && x.characterId === entityId)) || null;
    if (!c) { ctx.toast("这个人物已经不在作品设定里了"); return; }
    setModule("characters");
    ui.bibleTab = c.tier === "bit" ? "bits" : "characters";
    ui.bibleOpen = `c:${entityId}`;
    ui.bpText = null;
    render();
  }

  /** 「交给 AI 导演诊断」 (TASK-079 §1.3) — hand ONE failed attempt to the
   *  Director with what actually failed, in context.
   *
   *  Shell-level like 问 Agent, and for the same reason: it narrows the
   *  Director's scope to this shot and opens the panel. The prefill carries the
   *  recorded reason and the Run id, so the Director is asked about the failure
   *  that happened rather than about failures in general. */
  function diagnoseFailure(ctx, { shotId, kind, runId, model, why }) {
    const shot = ctx.shot.find(shotId);
    const name = shot ? (shot.title || `镜头 ${shot.sequence}`) : shotId;
    const medium = kind === "video" ? "视频" : "画面";
    ui.selectedShotId = shotId;
    // Prefill the CONVERSATION (REQ-004 v2). `ui.directorText` fed the retired
    // 导演台 instruction box, so writing there now would compose a question into a
    // field nobody renders — the creator would press the button and see nothing.
    sessionState(ui).text =
      `「${name}」的${medium}生成失败了。Run ${runId || "未知"}` +
      (model ? ` · 模型 ${model}` : "") +
      `，报的原因是：${why || "（登记表里没有记录失败原因）"}。` +
      `请判断这是 Prompt 的问题、参考的问题，还是别的，并说下一步该怎么改。`;
    render();
  }

  /** Open ONE capability on the run surface, carrying the context the creator is
   *  standing on (TASK-080 §1.1 「在当前上下文运行」).
   *
   *  It SELECTS and OPENS; it does not run. Running is a decision with an
   *  executor behind it and a set of guards in the run path — a second
   *  invocation path here would be a second place to forget them. The scope the
   *  run will record is whatever `ui.selectedShotId` says, which is exactly what
   *  「当前上下文」 means. */
  function openSkillRun(ctx, skillId) {
    if (!skillId) return;
    ui.skillId = skillId;
    // …and the SESSION's task, so 「在当前上下文运行」 from the catalog and `/` in the
    // session are one choice rather than two that can disagree about what is
    // selected (TASK-080 §1.2)
    sessionState(ui).skillId = skillId;
    ui.skillPromptOpen = false;
    ui.dirOpen = { ...(ui.dirOpen || {}), skills: true };
    const s = ctx.skills.find(skillId);
    const missing = ctx.skills.missing(skillId) || [];
    ctx.toast(
      missing.length
        ? `「${s ? s.title : skillId}」还缺 ${missing.length} 项输入——右侧「能力」里写着缺哪些`
        : `已在右侧「能力」里打开「${s ? s.title : skillId}」——选执行器后运行`,
    );
    render();
  }

  /** Run the session's chosen capability against the context the CREATOR STATED.
   *
   *  The scope comes from the session's own context (a `@` shot reference), not
   *  from `ui.selectedShotId` — that is the whole difference between 「上下文由
   *  用户显式给出」 and 「上下文由你在哪一页隐式决定」. The run itself still goes
   *  through `ctx.skills.run`, the one path with the guards on it. */
  /* ---------------------------------------------------------------------- */
  /* 对话（ADR-0089）                                                        */
  /* ---------------------------------------------------------------------- */

  /** ONE CONVERSATION PER PAGE (REQ-004 v3).
   *
   *  产品负责人 2026-08-27:「我可以打开不同的页面都有新的对话框吗。历史内容保存在不同
   *  对话框」。So every piece of per-conversation state is keyed by the page — the
   *  turns, the run in flight and its status. Three flat fields would make a turn
   *  started on 分镜 render its spinner on 资产库.
   */
  /** 开发那边有没有新方案 —— **主动去问**，不等他先开口。
   *
   *  产品负责人 2026-08-29：「你给方案之后要触发前端agent的交互。」开发写方案发生在
   *  另一个进程里（仓库那边），浏览器不可能被通知到，所以这里每 20 秒问一次；数字变大
   *  就在他正看着的那条流里插一行，并把「开发」tab 上的圆点点亮。
   *
   *  **一个定时器，跟着右栏的生命周期**：重复 bind 不会叠出第二个（下面先清）。 */
  function pollProposals(ctx) {
    const tick = () => {
      const before = ui.convOpenProposals || 0;
      Promise.resolve(openProposalCount()).then((n) => {
        if (n === before) return;
        ui.convOpenProposals = n;
        // 变多了 = 开发刚给了新东西。变少了（他刚答复完）只更新数字，不打扰他。
        if (n > before) ui.convProposalNote = n - before;
        render();
      });
    };
    tick();
    if (ui.convPollTimer) clearInterval(ui.convPollTimer);
    ui.convPollTimer = setInterval(tick, 20000);
  }

  /** 当前是哪个窗口。默认「作品」—— 他绝大多数话是要改东西的。 */

  /* ===== Story Development 的四页（TASK-122 第 3–6 步）===================== */
  //
  // 一处绑定，四页共用。所有写入都落到**正式数据模型**（`story.work`），不是改屏幕上
  // 的字 —— 他点名过这一条：「Agent 修改的是正式数据模型，不是只修改 UI 展示文本。」
  // 人手改与 Agent 改因此走的是同一组函数（见 `convactions.js` 的 work.* 动作）。

  /** 旧结构 → 新模型，只灌一次。空编辑器等于把他四版大纲从屏幕上抹掉。 */
  function seedWork(ctx) {
    const doc = ctx.story && ctx.story.doc ? ctx.story.doc() : null;
    if (!doc || !doc.work) return false;
    const active = storydoc.activeOutline(doc);
    const fields = active && active.outline ? active.outline : null;
    const at = new Date().toISOString();
    let did = false;
    did = swork.seedCoreFromStory(doc.work, fields, doc.brief && doc.brief.draft, at) || did;
    did = swork.seedOutlineFromStory(doc.work, fields, at) || did;
    const eps = ctx.prodData ? (ctx.prodData().production.episodes || []) : [];
    did = !!swork.seedPlanFromEpisodes(doc.work, eps, at) || did;
    if (did) ctx.persist();
    return did;
  }

  /** 一次写入 + 重画。`quiet` 用于打字：不重画，避免光标跳走。 */
  function workWrite(fn, quiet) {
    const ctx = getCtx();
    const doc = ctx && ctx.story && ctx.story.doc ? ctx.story.doc() : null;
    if (!doc || !doc.work) return;
    fn(doc.work, ctx);
    ctx.persist();
    if (!quiet) render();
  }

  /** 这一页要读的那份 work（读路径只有这一条，写路径只有 `workWrite`）。 */
  function workOf() {
    const ctx = getCtx();
    const doc = ctx && ctx.story && ctx.story.doc ? ctx.story.doc() : null;
    return doc && doc.work ? doc.work : null;
  }

  function bindStoryWork(root) {
    const now = () => new Date().toISOString();

    // ① 故事核心 / ② 故事大纲：打字即写进模型（不重画，光标不跳）
    const core = root.querySelector("[data-core]");
    if (core) {
      core.oninput = () => workWrite((k) => { k.core = core.value; }, true);
    }
    const outline = root.querySelector("[data-outline]");
    if (outline) {
      outline.oninput = () => workWrite((k) => swork.setOutline(k, outline.value), true);
      // 失焦时重画一次，让节点编号跟上（打字时不重画是为了光标）
      outline.onblur = () => render();
    }

    // 定稿 / 历史（core · outline · plan 同一条规矩）
    root.querySelectorAll("[data-fin]").forEach((b) => (b.onclick = () => {
      const kind = b.dataset.fin;
      let rec = null;
      workWrite((k) => { rec = swork.finalizeDoc(k, kind, now()); });
      getCtx().toast(rec ? `已存为 v${rec.v}` : "内容没变，没有重复存一版");
    }));
    root.querySelectorAll("[data-finhist]").forEach((b) => (b.onclick = () => {
      const kind = b.dataset.finhist;
      ui[kind + "Hist"] = !ui[kind + "Hist"];
      render();
    }));
    root.querySelectorAll("[data-finview]").forEach((b) => (b.onclick = () => {
      const [kind, v] = b.dataset.finview.split(":");
      const work = workOf();
      const rec = work && (work.finalized[kind] || []).find((x) => x.v === Number(v));
      if (rec) { ui[kind + "View"] = rec; render(); }
    }));
    root.querySelectorAll("[data-finclose]").forEach((b) => (b.onclick = () => {
      ui[b.dataset.finclose + "View"] = null;
      render();
    }));
    root.querySelectorAll("[data-finrestore]").forEach((b) => (b.onclick = () => {
      const [kind, v] = b.dataset.finrestore.split(":");
      let ok = false;
      workWrite((k) => { ok = swork.restoreDoc(k, kind, Number(v)); });
      ui[kind + "View"] = null;
      getCtx().toast(ok ? `已恢复到 v${v}` : "没能恢复这一版");
    }));
    root.querySelectorAll("[data-findel]").forEach((b) => (b.onclick = () => {
      const [kind, v] = b.dataset.findel.split(":");
      workWrite((k) => swork.deleteDoc(k, kind, Number(v)));
      getCtx().toast(`已删除 v${v}（当前内容没有动）`);
    }));

    // ③ 结构规划
    // 去掉缩放记号之后高度得自己跟着内容走（他要的是「像 excel 一样简约」，
    // 不是一堆固定两行、写多了就出现内部滚动条的小框）
    const grow = (el) => {
      el.style.height = "auto";
      el.style.height = `${Math.max(el.scrollHeight, 20)}px`;
    };
    root.querySelectorAll("[data-sp-edit]").forEach((el) => grow(el));
    root.querySelectorAll("[data-sp-edit]").forEach((el) => (el.oninput = () => {
      grow(el);
      const i = el.dataset.spEdit.lastIndexOf(":");
      const id = el.dataset.spEdit.slice(0, i);
      const field = el.dataset.spEdit.slice(i + 1);
      workWrite((k) => swork.editPlanRow(k, id, field, el.value), true);
    }));
    root.querySelectorAll("[data-sp-add]").forEach((b) => (b.onclick = () =>
      workWrite((k) => swork.addPlanRow(k, now()))));
    root.querySelectorAll("[data-sp-del]").forEach((b) => (b.onclick = () =>
      workWrite((k) => swork.hidePlanRow(k, b.dataset.spDel, now()))));
    root.querySelectorAll("[data-sp-restore]").forEach((b) => (b.onclick = () =>
      workWrite((k) => swork.restorePlanRow(k, b.dataset.spRestore))));
    root.querySelectorAll("[data-sp-bin]").forEach((b) => (b.onclick = () => {
      ui.planBin = !ui.planBin;
      render();
    }));
    root.querySelectorAll("[data-sp-refopen]").forEach((b) => (b.onclick = () => {
      ui.planRefOpen = ui.planRefOpen === b.dataset.spRefopen ? null : b.dataset.spRefopen;
      render();
    }));
    root.querySelectorAll("[data-sp-ref]").forEach((b) => (b.onclick = () => {
      const [rowId, nodeId] = b.dataset.spRef.split(":");
      workWrite((k) => {
        const row = k.plan.rows.find((r) => r.id === rowId);
        if (!row) return;
        const next = row.outlineRefs.includes(nodeId)
          ? row.outlineRefs.filter((x) => x !== nodeId)
          : [...row.outlineRefs, nodeId];
        swork.editPlanRow(k, rowId, "outlineRefs", next);
      });
    }));
    root.querySelectorAll("[data-sp-unref]").forEach((b) => (b.onclick = () => {
      const [rowId, nodeId] = b.dataset.spUnref.split(":");
      workWrite((k) => {
        const row = k.plan.rows.find((r) => r.id === rowId);
        if (row) swork.editPlanRow(k, rowId, "outlineRefs", row.outlineRefs.filter((x) => x !== nodeId));
      });
    }));

    // ④ 正文创作
    root.querySelectorAll("[data-form]").forEach((b) => (b.onclick = () => {
      workWrite((k) => swork.setForm(k, b.dataset.form));
    }));
    root.querySelectorAll("[data-planned]").forEach((b) => (b.onclick = () => {
      const d = Number(b.dataset.planned);
      workWrite((k) => swork.setPlanned(k, k.form, Math.max(0, k.planned[k.form] + d)));
    }));
    const pn = root.querySelector("[data-planned-set]");
    if (pn) {
      pn.onchange = () => {
        const v = parseInt(pn.value, 10);
        workWrite((k) => swork.setPlanned(k, k.form, Number.isFinite(v) ? Math.max(0, v) : k.planned[k.form]));
      };
    }
    root.querySelectorAll("[data-unit]").forEach((b) => (b.onclick = () => {
      const no = Number(b.dataset.unit);
      workWrite((k) => swork.ensureUnit(k, k.form, no, now()));
      ui.unitNo = no;
      ui.unitHist = false;
      render();
    }));
    // 故事侧 → 生产线的那道门（ADR-0092 之后**只开在正文创作 · 剧集创作**里）
    root.querySelectorAll("[data-unit-produce]").forEach((b) => (b.onclick = () => {
      enterEpisode(b.dataset.unitProduce, EPISODE_DEFAULT);
    }));
    root.querySelectorAll("[data-unit-back]").forEach((b) => (b.onclick = () => {
      ui.unitNo = null;
      render();
    }));
    const body = root.querySelector("[data-unit-body]");
    if (body) {
      body.oninput = () => workWrite((k) => swork.editUnit(k, body.dataset.unitBody, "body", body.value, now()), true);
    }
    const title = root.querySelector("[data-unit-title]");
    if (title) {
      title.oninput = () => workWrite((k) => swork.editUnit(k, title.dataset.unitTitle, "title", title.value, now()), true);
    }
    root.querySelectorAll("[data-unit-copy]").forEach((b) => (b.onclick = async () => {
      const work = workOf();
      const u = work && work.units.find((x) => x.id === b.dataset.unitCopy);
      if (!u) return;
      try {
        await navigator.clipboard.writeText(u.body || "");
        getCtx().toast("正文已复制");
      } catch {
        // 剪贴板被浏览器挡住时**说出来**，不假装复制成功
        getCtx().toast("浏览器没允许复制 —— 请手动全选复制");
      }
    }));
    root.querySelectorAll("[data-unit-fin]").forEach((b) => (b.onclick = () => {
      let rec = null;
      workWrite((k) => { rec = swork.finalizeUnit(k, b.dataset.unitFin, now()); });
      getCtx().toast(rec ? `已存为 v${rec.v}` : "内容没变，没有重复存一版");
    }));
    root.querySelectorAll("[data-unit-hist]").forEach((b) => (b.onclick = () => {
      ui.unitHist = !ui.unitHist;
      render();
    }));
    root.querySelectorAll("[data-unit-restore]").forEach((b) => (b.onclick = () => {
      const [id, v] = b.dataset.unitRestore.split(":");
      workWrite((k) => swork.restoreFinalized(k, id, Number(v), now()));
      getCtx().toast(`已恢复到 v${v}`);
    }));
    root.querySelectorAll("[data-unit-findel]").forEach((b) => (b.onclick = () => {
      const [id, v] = b.dataset.unitFindel.split(":");
      workWrite((k) => swork.deleteFinalized(k, id, Number(v)));
      getCtx().toast(`已删除 v${v}（当前正文没有动）`);
    }));
  }

  // 页内选集器（TASK-122 第 2 步）曾经挂在结构规划页顶。**已经删掉**：
  // 产品负责人 2026-08-30「结构规划不应该跳到剧集制作」—— 它带着「进入剧集制作 →」，
  // 等于在一张讲故事结构的表上开了一扇通往生产线的门。分集选择仍住在「剧集制作」
  // 自己的空间里（`renderEpisodeRail`），要去那边点顶部的空间切换就行。
  //
  // `shell.episodeRows` 保留：剧集制作那边和守卫测试都在用它。

  function convMode() {
    return ui.convMode === "feedback" ? "feedback" : "work";
  }

  //: 「开发」窗口的线程 key。项目级一条线，不随页面变 —— 意见不属于某一页。
  //: 每个页面**是哪个文件画的**。产品负责人 2026-08-29：「前端agent给你的留言应该加入
  //: 更详细的页面定位情报，还需要考虑如何能让你更快的理解问题和解决问题。」
  //:
  //: 后端 Agent 拿到一条「这一页左边太挤」时，最贵的一步是**找到那一页在哪个文件**。
  //: 这张表把那一步从「翻仓库」变成「读一行」。它住在这里，因为这个模块就是页面分发表
  //: 的所在地；`tests/…/prodsource.test.mjs` 钉住它不许指向不存在的文件。
  const MODULE_SOURCE = {
    brief: "src/ui/briefws.js",
    story: "src/ui/storyws.js",
    settings: "src/ui/biblews.js",
    relationships: "src/ui/relws.js",
    world: "src/ui/worldws.js",
    episodes: "src/ui/epplanws.js",
    board: "src/ui/episodews.js",
    storyboard: "src/ui/storyboard.js",
    shotwork: "src/ui/mediaws.js",
    cutreview: "src/ui/cutreview.js",
    delivery: "src/ui/postconsole.js",
    assets: "src/ui/assetlibws.js",
    storage: "src/ui/storagews.js",
  };

  const FEEDBACK_THREAD = "__feedback__";

  function convKey() {
    if (convMode() === "feedback") return FEEDBACK_THREAD;
    return activeModule || "__project__";
  }

  function convState(key) {
    const store = (ui.convByPage = ui.convByPage || {});
    const k = key || convKey();
    if (!store[k]) {
      store[k] = {
        turns: [], pendingRun: null, pendingStatus: "", loaded: "",
        // runId -> [{kind, detail, error}] —— 这一轮提出的改动里，哪些真的落到作品上了。
        // 落地本身是持久的（写进 canvas 的新版本）；这张表只是这次会话里的显示。
        applied: {},
      };
    }
    return store[k];
  }

  /** Load THIS page's conversation once. The thread is server-side (a projection of
   *  the runs), so this is a read, not a cache to keep in sync. The guard is per
   *  (project, page) because `bind()` runs after EVERY render — without it there
   *  would be a request behind every keystroke. */
  function ensureConversation(ctx) {
    const project = ctx.projectName ? ctx.projectName() : null;
    if (!project) return;
    const st = convState();
    const stamp = `${project}::${convKey()}`;
    if (st.loaded === stamp) return;
    st.loaded = stamp;
    // 提案数跟着线程一起读：他不必进「开发」窗口才知道有东西在等他
    pollProposals(ctx);
    Promise.resolve(loadThread(project, convKey())).then((res) => {
      st.turns = res.turns;
      ui.convOtherPages = res.others || {};
      ui.convProposals = res.proposals || [];
      ui.convOpinions = res.opinions || [];
      render();
    });
  }

  /** 强制重读这条线（拍板之后要立刻看到状态变化，不能被 `loaded` 戳记挡住）。 */
  function ensureConversationForce(ctx) {
    convState().loaded = "";
    ensureConversation(ctx);
  }

  function refreshConversation(ctx, key) {
    const project = ctx.projectName ? ctx.projectName() : null;
    if (!project) return Promise.resolve();
    const which = key || convKey();
    const st = convState(which);
    return Promise.resolve(loadThread(project, which)).then((res) => {
      st.turns = res.turns;
      st.pendingRun = null;
      st.pendingStatus = "";
      ui.convOtherPages = res.others || {};
      ui.convProposals = res.proposals || [];
      ui.convOpinions = res.opinions || [];
      render();
    });
  }

  /** Where the creator is standing, as the turn's context.
   *
   *  Sent on EVERY turn: 「这个」「当前」「这一镜」 are the words he actually uses, and
   *  without this the answer has to ask him where he is — which is the thing he
   *  noticed was missing (2026-08-27). */
  function episodeLabelOf(ep, epIndex) {
    const title = String((ep && ep.title) || "").trim();
    if (epIndex < 0) return title;
    const no = `EP${String(epIndex + 1).padStart(2, "0")}`;
    return title.startsWith(no) ? title : `${no} ${title}`.trim();
  }

  function conversationContext(ctx) {
    const pd = ctx.prodData ? ctx.prodData() : null;
    const shotId = ui.selectedShotId || null;
    const shot = shotId && ctx.shot && ctx.shot.find ? ctx.shot.find(shotId) : null;
    const ep = pd && pd.production ? activeEpisode(pd.production) : null;
    const epIndex = ep && pd && pd.production
      ? pd.production.episodes.findIndex((e) => e && e.episodeId === ep.episodeId)
      : -1;
    return {
      // WHAT THE AGENT MAY DO —— 由**这里**送出去，因为界面动作归前端所有
      // （产品负责人 2026-08-29:「用户能够操作的前端的agent都应该可以操作」）。
      // 服务端把它转写进提示词，不再各持一份会漂移的词汇表。
      actions: actionCatalog(),
      // 他在哪个窗口里说话。**服务端据此强制执行**（不是给模型的提示）：
      // 「开发」窗口里的一轮，作品类动作一个都不许落地 —— 那正是两个窗口的意义。
      intent: convMode() === "feedback" ? "feedback" : "work",
      // 哪些材料**此刻真的有**（TASK-119）。服务端的 resolver 靠它决定
      // 「这一类工作现在能不能跑、还缺什么」——创作文档只活在浏览器里，
      // 所以就绪状态只能由这边报。「开发」窗口里不报：那个窗口不会跑作品能力。
      ...(convMode() === "feedback"
        ? {}
        : { readyInputs: ctx.skills.readyInputs(ui.selectedShotId ? { shotId: ui.selectedShotId } : null) }),
      // 定位情报：**结构化**送过去，不指望模型记得写进句子里。
      //   route  —— 他此刻的地址，我照着它就能打开同一屏
      //   section—— 同一页里的哪一节（分镜设计有 场景/分镜 两节）
      //   source —— 画这一页的文件，省掉「先找到它在哪」那一步
      route: (typeof window !== "undefined" && window.location
        ? String(window.location.hash || "")
        : ""),
      section: sectionOf(activeModule) || "",
      source: MODULE_SOURCE[activeModule] || "",
      module: activeModule,
      moduleLabel: MODULE_LABEL[activeModule] || activeModule,
      spaceLabel: SPACE_LABEL[spaceOf(activeModule)] || "",
      shotId,
      shotTitle: shot ? (shot.title || "") : "",
      // 集号只补在标题**没有自带**它的时候：真实项目里标题常常就叫「EP01 迷雾入城」，
      // 无条件拼一次就成了「EP01 EP01 迷雾入城」（台账 #5 上就是这么记下来的）。
      episodeLabel: ep ? episodeLabelOf(ep, epIndex) : "",
    };
  }

  /* ---------------------------------------------------------------------- */
  /* 意图路由：一句话 → 一个能力（TASK-119 / ADR-0091）                       */
  /* ---------------------------------------------------------------------- */

  //: 此刻正在起跑、但还没在登记表里落地的那些路由（TASK-119）。
  //:
  //: 为什么需要它：`hasOriginKey` / `routedRunFor` 查的是登记表，而登记表里那条
  //: 记录要等 `ctx.skills.run` 真的调到 `startRun` 才出现 —— 中间隔着一个微任务。
  //: 「先查后做」之间的这条缝，今天从代码上够不着（一次发送一条链、一个
  //: conversationRunId；建议的 key 在点击时就被同步取走了，第二次点击拿不到），
  //: 但它是**结构性的**：以后任何人再加一条起跑路径，缝就自己张开了，而症状是
  //: 「同一件事跑了两遍」——两次都成功、两份提案、没有任何一处报错。
  //:
  //: 所以按类关掉，而不是论证它今天够不着。**不进 `ui`**：它是这一次页面生命周期
  //: 里的瞬时状态，持久化它会让一次刷新之后的合法重试被永远挡住。
  const routeInflight = new Set();

  /** 这次路由要用哪个执行器，或 null（本机没有能自动跑的）。
   *
   *  `manual` 不算「能自动跑」—— 手工运行是**开一条等人的记录**，不是一次运行。
   *  所以这里返回 null，屏幕上给出「去运行」那条路，而不是假装起跑了。 */
  function routeExecutor(skill) {
    const probe = execProbe || {};
    const picked = suggestExecutor(
      skill && skill.work,
      (id) => id !== "manual" && isRunnable((probe[id] || {}).state),
      null,
    );
    return picked === "manual" ? null : picked;
  }

  /** 一个能力这次跑在什么范围上。只有声明 shot 范围的才需要一个镜头。
   *
   *  范围从 `scopeOfSkill` 读（`routing.internalRouting.scope`）—— 直接写
   *  `skill.routing.scope` 读到的是 `undefined`，而那在每一处判断里都表现为
   *  「不是 shot」：镜头域能力于是永远拿不到 shotId，永远起不来，且不报错。 */
  function routeScopeFor(ctx, skillId) {
    const scope = scopeOfSkill(ctx.skills.find(skillId));
    return scope === "shot" && ui.selectedShotId ? { shotId: ui.selectedShotId } : null;
  }

  /** `decideRoute` 要的那一组回调。`ranFor` 问的是**登记表**，所以幂等跨得过刷新。 */
  function routeCtxFor(ctx, convRunId) {
    return {
      mode: convMode(),
      findSkill: (id) => ctx.skills.find(id),
      missingOf: (id) => ctx.skills.missing(id, {}, routeScopeFor(ctx, id)),
      labelOf: (k) => ctx.skills.inputLabel(k),
      pickExecutor: (skill) => routeExecutor(skill),
      ranFor: () => ctx.skills.routedRunFor(convRunId),
    };
  }

  /** 哪几层**真的有东西**（story-zoom 的五层模型映射到这个产品的权威对象）。
   *
   *  从 `ctx.skills.context("story-zoom")` 读，而不是各自去翻文档：那样这里看到的
   *  材料与那次运行真正拿到的材料永远是同一份。 */
  function layersPresent(ctx) {
    const c = ctx.skills.context("story-zoom") || {};
    const has = (v) => {
      if (v == null) return false;
      if (typeof v === "string") return !!v.trim();
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "object") return Object.keys(v).length > 0;
      return true;
    };
    return {
      L2: has(c.outline) || has(c.currentPlan),
      L3: has(c.scenes) || has(c.shots),
      L4: has(c.characters) || has(c.relationships) || has(c.world),
      L5: has(c.episodeScript),
    };
  }

  /** 起跑一次被路由到的能力。走的是 `ctx.skills.run` —— 与他自己在「能力」里点
   *  运行**同一条路径**，所以守卫、登记、schema 校验、提案语义一条不少。
   *
   *  自动起跑的是**运行**，不是接受：答案照旧落成 pending 的提案，要不要用由他决定。 */
  function launchRouted(ctx, { skillId, executor, origin, summary, said }) {
    return Promise.resolve()
      .then(() => ctx.skills.run(skillId, {
        executor,
        origin,
        summary,
        scope: routeScopeFor(ctx, skillId),
      }))
      .then((res) => {
        if (!res || !res.ok) ctx.toast(`${said}没跑成：${(res && res.error) || "没有返回结果"}`);
        else ctx.toast(`${said} —— 结果在「能力」面板里等你决定要不要用`);
      })
      // 失败也要说出来（ADR-0089 决策 6）：一次静默失败的自动运行，
      // 在屏幕上与「它根本没听懂」无法区分。
      .catch((e) => ctx.toast(`${said}没跑成：${(e && e.message) || e}`))
      .then(() => render());
  }

  /** 这一轮识别到的能力，该跑就跑。
   *
   *  **只在发送那条链里调用**，从不在读线程时调用 —— 那是「刷新 / 轮询不会重复启动」
   *  最结实的那一半保证：读路径上根本没有起跑的代码。另一半是登记表里的幂等键。 */
  function runRouteFor(ctx, convRunId, turn, said, originKey) {
    const route = routeOf(turn);
    if (!route) return Promise.resolve();
    // 这件**事**已经跑过了 —— 与「这一轮跑过了」是两道不同的闸。跨层建议带着
    // 一个稳定身份（哪个文档的第几版）：他点两次、或者一次失败的发送被重发，
    // 都会产生**新的**对话轮次，`conversationRunId` 那道闸拦不住，只有这一道能。
    // 这件**事**已经跑过了 —— 与「这一轮跑过了」是两道不同的闸。跨层建议带着
    // 一个稳定身份（哪个文档的第几版）：他点两次、或者一次失败的发送被重发，
    // 都会产生**新的**对话轮次，`conversationRunId` 那道闸拦不住，只有这一道能。
    const guard = originKey || convRunId;
    if (originKey && ctx.skills.hasOriginKey(originKey)) {
      ctx.toast("这一版的跨层检查已经跑过了");
      render();
      return Promise.resolve();
    }
    // …而登记表里那条记录要等一个微任务之后才写下，所以「查过了」到「写下了」
    // 之间还有一条缝。这一句把它关掉（见 `routeInflight` 的说明）。
    if (guard && routeInflight.has(guard)) return Promise.resolve();
    const decision = decideRoute(route, routeCtxFor(ctx, convRunId));
    if (decision.action !== "run") {
      render(); // 没跑也要显示：识别到了什么、为什么没跑
      return Promise.resolve();
    }
    if (guard) routeInflight.add(guard);
    return launchRouted(ctx, {
      skillId: decision.skillId,
      executor: decision.executor,
      origin: originForRoute(convRunId, originKey),
      summary: `对话里识别到的能力：${String(said || "").slice(0, 60)}`,
      said: `已启动「${decision.title}」`,
      // 起跑结束就放开 —— 那时登记表里已经有记录了，两道闸交接得上。
      // 失败也要放开：一次失败的起跑不该把这条路径永久锁死。
    }).then(() => { if (guard) routeInflight.delete(guard); });
  }

  /** 一次结构性版本变更之后，**建议**查一遍各层还对不对得上 —— 建议，不是自动跑。
   *
   *  为什么是建议：审查不该在每次编辑后自己跑起来。三条门槛（有根 / 跨层 / 只一次）
   *  已经把普通编辑挡在外面了，但即使全都满足，「要不要现在花一次运行去查」仍然是
   *  他的决定 —— 自动跑起来的诊断会在他还没读完上一条答复时又占住一条运行槽。
   *
   *  他点了之后走的是**普通的一轮对话**：同一条路由、同一个服务端 resolver。
   *  所以「跨层诊断该由谁做」只有一处判定，不会一处走 resolver、一处写死。 */
  function suggestZoomFor(ctx, landed) {
    if (convMode() !== "work") return;
    const trigger = zoomTrigger(landed, {
      layersPresent: layersPresent(ctx),
      hasRunKey: (key) => ctx.skills.hasOriginKey(key) || !!(ui.convSuggested || {})[key],
    });
    if (!trigger) return;
    ui.convSuggested = { ...(ui.convSuggested || {}), [trigger.key]: true };
    ui.convSuggest = {
      goal: trigger.goal,
      // 这件事的稳定身份**必须一路带到 startRun**，否则 `hasOriginKey` 永远查不到
      // 东西，「只跑一次」就只剩 `ui.convSuggested` 那半条 —— 刷新一次就没了。
      key: trigger.key,
      text: `${trigger.root.doc === "brief" ? "创意" : trigger.root.doc === "outline" ? "大纲" : "结构规划"}` +
        ` v${trigger.root.version} 落下之后，下游的${trigger.affects.length}层可能还停在旧的上面`,
    };
    // 重画。这是发送那条链的**最后一步**，后面没有别的东西会重画 —— 少了这一句，
    // 建议就要等到某个不相干的渲染才出现，在他眼里等于「什么都没发生」
    // （codex 独立审查轮 2 的 P1）。
    render();
  }

  /** 每一轮的路由在屏幕上是什么状态 —— **从持久事实算出来**，不是页面记着的。
   *
   *  跑过了 → 状态来自登记表（run 记录）；没跑 → 用同一个 `decideRoute` 现算原因，
   *  所以刷新之后他看到的理由与当时的理由一致，而这次重算**不会启动任何东西**
   *  （`decideRoute` 是纯函数）。 */
  function convRouteState(ctx, turns) {
    const out = {};
    // 每次 render 都会走到这里，而 `ctx.skills.missing` 每次都要把整条时间线、音频、
    // 字幕投影一遍。一条线里若干轮都指向同一个能力时，那是同一个答案算了很多次 ——
    // 所以按 skillId 记一次。**只在这一次 render 内有效**：缓存活得比一次渲染长，
    // 就会在文档改了之后继续报旧的「还缺什么」。
    const missingCache = new Map();
    const missingOnce = (skillId) => {
      if (!missingCache.has(skillId)) {
        missingCache.set(skillId, ctx.skills.missing(skillId, {}, routeScopeFor(ctx, skillId)));
      }
      return missingCache.get(skillId);
    };
    for (const t of turns || []) {
      if (!t || t.role !== "agent" || !t.runId) continue;
      const route = routeOf(t);
      if (!route) continue;
      const run = ctx.skills.routedRunFor(t.runId);
      if (run) {
        const skill = ctx.skills.find(run.skillId);
        const failure = run.failureReason || run.error;
        out[t.runId] = {
          skillId: run.skillId,
          title: (skill && skill.title) || run.skillId,
          status: run.status || "",
          error: failure ? String(failure.detail || failure) : "",
          // 那一轮**能力运行**自己的 id：对话里的「用它 / 不用」要拿它去应用提案。
          // 没有它，按钮画不出来 —— 产品负责人 2026-08-30 看到的正是「写好了」
          // 后面什么都没有。
          skillRunId: run.runId || run.skillRunId || "",
          pending: !!(run.disposition === "pending" || run.proposal),
        };
        continue;
      }
      const decision = decideRoute(route, {
        ...routeCtxFor(ctx, t.runId),
        missingOf: missingOnce,
      });
      out[t.runId] = {
        skillId: route.skillId,
        title: decision.title || route.skillId,
        reason: decision.action === "blocked" ? decision.reason : "",
        missing: decision.missing || [],
        canOpen: !!ctx.skills.find(route.skillId),
      };
    }
    return out;
  }

  /** One turn: his sentence on screen NOW, the answer when the run lands.
   *
   *  The local echo matters: a chat that shows what you said only after a round
   *  trip reads as if the send was lost, and the creator presses again. The
   *  server's own copy replaces the echo on the next read. */
  function sendConversationTurn(ctx, text, { originKey = "" } = {}) {
    const project = ctx.projectName ? ctx.projectName() : null;
    if (!project) { ctx.toast("先打开一个项目"); return; }
    // THE PAGE THIS TURN BELONGS TO, captured before the await: he may navigate away
    // while it runs, and the answer belongs to the conversation he asked it in.
    const sentFrom = convKey();
    const st = convState(sentFrom);
    st.turns = [...st.turns, { turnId: `local-${Date.now()}`, role: "user", text }];
    st.pendingStatus = "queued";
    render();
    // EVERY failure has to become a VISIBLE turn. `Promise.resolve(f())` evaluates
    // `f()` first, so a synchronous throw out of `conversationContext` escaped the
    // chain entirely — his sentence stayed on screen with no answer and no error,
    // which is exactly what he reported (「没有回应」). Building the context INSIDE
    // the chain, plus a `.catch()` at the end, is what makes silence impossible.
    Promise.resolve()
      .then(() =>
        // WHAT HE IS LOOKING AT, in the words the UI already uses. The labels come
        // from here because this module owns the page vocabulary (`MODULE_LABEL`),
        // so the server never keeps a second copy that could drift from the rail.
        sendTurn(project, text, conversationContext(ctx)))
      .then((res) => {
        if (!res.ok) {
          // FAIL LOUDLY (ADR-0089 决策 6): a swallowed send is a message the creator
          // believes was delivered.
          st.pendingStatus = "";
          st.turns = [...st.turns, {
            turnId: `err-${Date.now()}`,
            role: "agent",
            status: "failed",
            failure: (res.error && (res.error.detail || res.error.message)) || "发送失败",
          }];
          render();
          return null;
        }
        st.pendingRun = res.runId;
        render();
        return awaitTurn(project, res.runId, {
          onTick: (run) => {
            st.pendingStatus = (run && run.status) || "";
            render();
          },
        }).then((run) => {
          // REFRESH FIRST, THEN APPLY FROM THE THREAD.
          //
          // 原本落地读的是**轮询返回的那个 run**。轮询有超时（也可能因为别的原因拿不到
          // outputs），超时后返回的对象里根本没有 edits —— 于是落地看到「没有可落的改动」
          // 就退场了，而答案照常出现（那是从服务端线程读回来的）。屏幕上就成了
          //「它说已经改好了」+「还没落到作品上」，两句话互相打脸（产品负责人 2026-08-29:
          //「好像是改了没显示」）。
          //
          // 线程是服务端的真相，读一次就有；run 只是它的快照。所以先刷新，再从**这一轮
          // 自己的那条 turn**上取 edits。
          return refreshConversation(ctx, sentFrom).then(() => {
            const turn = (st.turns || []).find(
              (x) => x && x.role === "agent" && x.runId === res.runId,
            );
            // 已经有回执 = 这一轮的改动早就落过了（比如上一次会话里落的），不重复落。
            // **路由不受这条影响**：它有自己的幂等（登记表里的 origin），而且一轮里
            // 「有没有改动要落」与「要不要起一个能力」本来就是两件独立的事。
            const done = turn && Array.isArray(turn.applied) && turn.applied.length;
            const edits = turn && Array.isArray(turn.edits) && turn.edits.length
              ? turn.edits
              : (((run || {}).outputs || {}).conversation || {}).edits;
            const landed = done
              ? []
              : applyConversationEdits(ctx, {
                instruction: text,
                outputs: { conversation: { edits: edits || [] } },
              });
            let after = Promise.resolve();
            if (landed.length) {
              st.applied = { ...(st.applied || {}), [res.runId]: landed };
              render();
              // 回执写进对话线，「已落到作品上」才熬得过一次刷新。回执失败不掩盖落地本身
              // —— 改动已经在作品里了，只是这一行字下次读不回来。
              after = Promise.resolve(reportApplied(project, res.runId, landed))
                .then(() => refreshConversation(ctx, sentFrom));
            }
            // 落地之后才轮到能力：路由的判据是**作品此刻的样子**，所以要读的是
            // 这一轮改完之后的状态，不是改之前的。
            return after
              .then(() => runRouteFor(ctx, res.runId, turn, text, originKey))
              .then(() => suggestZoomFor(ctx, landed));
          });
        });
      })
      .catch((err) => {
        // 决策 6: fail-closed AND say why. An unhandled rejection here reads as
        // 「它无视了我」.
        st.pendingRun = null;
        st.pendingStatus = "";
        st.turns = [...st.turns, {
          turnId: `err-${Date.now()}`,
          role: "agent",
          status: "failed",
          failure: `发送没成功：${(err && (err.detail || err.message)) || err}`,
        }];
        render();
      });
  }

  function runSessionSkill(ctx, skillId) {
    const m = agentSessionModel(ctx, ui);
    if (!skillId || m.blocked) { ctx.toast(m.blocked || "先用 / 选一个能力"); return; }
    // `.then(...)` INSIDE the chain, so a SYNCHRONOUS throw out of `ctx.skills.run`
    // is caught too — `Promise.resolve(f())` evaluates `f()` first and would let it
    // escape. A run that fails must say so; an unhandled rejection is a button that
    // silently does nothing (independent review, batch A round 2).
    Promise.resolve()
      .then(() => ctx.skills.run(skillId, {
        // ONLY what the run contract can really carry (agentsession.SENT_KINDS).
        // `scopeOf` validates the scene against the run's own episode and drops a
        // foreign one, so this can never record a scene the prompt did not read.
        // The remaining references and the creator's prose are NOT sent, and the
        // session says so on screen rather than dropping them quietly.
        executor: ui.skillExecutor || "manual",
        scope: m.scope.shotId || m.scope.sceneId
          ? {
            ...(m.scope.shotId ? { shotId: m.scope.shotId } : {}),
            ...(m.scope.sceneId ? { sceneId: m.scope.sceneId } : {}),
          }
          : null,
        summary: m.scope.shotId
          ? "会话上下文里的镜头"
          : m.scope.sceneId ? "会话上下文里的场景" : "本集范围",
      }))
      .then((res) => {
        if (!res || !res.ok) ctx.toast(`运行失败：${(res && res.error) || "没有返回结果"}`);
        else if (res.manual) ctx.toast("已建立运行记录——在下面「能力」里复制任务 Prompt，跑完把结果粘回来");
        else ctx.toast("提案已生成——在下面「能力」里决定要不要用");
        // point the capability panel at THIS run, so its proposal is one scroll away
        ui.skillId = skillId;
        ui.dirOpen = { ...(ui.dirOpen || {}), skills: true };
      })
      .catch((e) => { ctx.toast(`运行失败：${(e && e.message) || e}`); })
      // ONE repaint, on both paths. A failure that does not repaint leaves the
      // session showing the state it had before the attempt.
      .then(() => render());
  }

  /** 对话流的滚动位置。
   *
   *  产品负责人 2026-08-30：「发送之后总跳到最上面。不应该是维持在最新的对话内容吗」。
   *  每次 render 都重写 `root.innerHTML`，新节点的 `scrollTop` 自然是 0 —— 于是刚发完
   *  一句话，视线就被甩回三天前的对话。
   *
   *  规则不是「永远滚到底」：他往上翻着读旧内容时把他拽回去同样是错的。所以记住的是
   *  **他是不是贴着底**；贴着底就继续贴着底（新内容进来跟着走），否则原样还原他的位置。 */
  const FLOW_SEL = ".st-dir-flow";
  let flowScroll = { top: 0, atBottom: true };

  function rememberFlowScroll() {
    const el = root.querySelector(FLOW_SEL);
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    flowScroll = { top: el.scrollTop, atBottom: gap < 40 };
  }

  function restoreFlowScroll() {
    const el = root.querySelector(FLOW_SEL);
    if (!el) return;
    el.scrollTop = flowScroll.atBottom ? el.scrollHeight : flowScroll.top;
  }

  function bind(ctx) {
    // left rail — every module opens; selection is visually .on
    root.querySelectorAll("[data-mod]").forEach((b) => (b.onclick = () => setModule(b.dataset.mod)));
    // TASK-077 §1.2: a media file that will not load says so, everywhere, once.
    bindMediaErrors(root, ctx);
    // TASK-080 §1.2 批次 A — bound EARLY, because the script branch below returns
    // before the other panels bind and the session is on that page too.
    bindAgentSession(root, ctx, ui, render, {
      onRun: (id) => runSessionSkill(ctx, id),
      onSend: (text) => sendConversationTurn(ctx, text),
    });
    // 「落到作品上」—— 把一条还没落下的改动补落。走的是与自动落地**同一个**函数，
    // 所以两条路不会有两种行为。
    // 拍板三键：走服务端那条确定性端点。「可以，但要改…」把焦点放回输入框并预填，
    // 因为那一档的重点是**他的原话**要原样回到开发那边。
    const decide = (id, verdict, note) => {
      const project = ctx.projectName ? ctx.projectName() : null;
      if (!project) { ctx.toast("先打开一个项目"); return; }
      Promise.resolve(decideProposal(project, id, verdict, note)).then((res) => {
        if (!res.ok) { ctx.toast(`没能记下：${res.error}`); return; }
        ctx.toast(verdict === "approved" ? `已答复 #${id}：同意` : `已答复 #${id}：不要`);
        ui.convProposalNote = 0;
        ensureConversationForce(ctx);
      });
    };
    root.querySelectorAll("[data-pp-ok]").forEach((b) => (b.onclick = () => decide(b.dataset.ppOk, "approved", "")));
    root.querySelectorAll("[data-pp-no]").forEach((b) => (b.onclick = () => decide(b.dataset.ppNo, "rejected", "")));
    root.querySelectorAll("[data-pp-ch]").forEach((b) => (b.onclick = () => {
      const st = sessionState(ui);
      st.text = `#${b.dataset.ppCh} 可以，但要改成：`;
      render();
      const box = root.querySelector(".as-input");
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }));
    root.querySelectorAll("[data-cv-gonote]").forEach((b) => (b.onclick = () => {
      ui.convProposalNote = 0;
      ui.convMode = "feedback";
      render();
      ensureConversation(ctx);
    }));
    root.querySelectorAll("[data-cv-mode]").forEach((b) => (b.onclick = () => {
      const next = b.dataset.cvMode === "feedback" ? "feedback" : "work";
      if (convMode() === next) return;
      ui.convMode = next;
      if (next === "feedback") ui.convProposalNote = 0;
      render();
      ensureConversation(ctx); // 换了线就把那条线读回来
    }));
    root.querySelectorAll("[data-cv-apply]").forEach((b) => (b.onclick = () => {
      const runId = b.dataset.cvApply;
      const project = ctx.projectName ? ctx.projectName() : null;
      if (!project || !runId) { ctx.toast("先打开一个项目"); return; }
      const st = convState();
      const turn = (st.turns || []).find(
        (x) => x && x.role === "agent" && x.runId === runId,
      );
      if (!turn || !Array.isArray(turn.edits) || !turn.edits.length) {
        ctx.toast("这一轮没有可落的改动");
        return;
      }
      const landed = applyConversationEdits(ctx, {
        instruction: "（补落这一轮的改动）",
        outputs: { conversation: { edits: turn.edits } },
      });
      if (!landed.length) { ctx.toast("这一轮没有本应用能落的改动"); return; }
      const failed = landed.filter((x) => x.error);
      ctx.toast(failed.length
        ? `有改动没能落下：${failed.map((x) => x.error).join("；")}`
        : landed.map((x) => x.detail).join("；"));
      st.applied = { ...(st.applied || {}), [runId]: landed };
      render();
      Promise.resolve(reportApplied(project, runId, landed))
        .then(() => refreshConversation(ctx));
    }));
    // 「查一下」—— 结构性改动之后那条建议。它发的是**一轮普通对话**，所以选哪个
    // 诊断器仍然由服务端 resolver 决定，与他自己开口问走的是同一条路。
    root.querySelectorAll("[data-cv-suggest]").forEach((b) => (b.onclick = () => {
      const goal = ui.convSuggest && ui.convSuggest.goal;
      // key 跟着这一次发送走 —— 它最终要落进那次运行的 `origin.idempotencyKey`，
      // 「同一件事只跑一次」才熬得过刷新（丢了它，就只剩页面内存那半条）。
      const originKey = ui.convSuggest && ui.convSuggest.key;
      ui.convSuggest = null;
      if (goal) sendConversationTurn(ctx, goal, { originKey });
      else render();
    }));
    // 「去运行」—— 自动没跑成时的那条**手工兜底**（ADR-0065 决策 2）。它不代跑：
    // 把那个能力在「能力」面板里打开，缺什么、选哪个执行器由他自己看着办。
    root.querySelectorAll("[data-cv-route]").forEach((b) => (b.onclick = () => {
      openSkillRun(ctx, b.dataset.cvRoute);
    }));
    // 「用它 / 不用」就在对话里做决定（TASK-122）。以前这条消息把他指向「能力」面板，
    // 而那个面板在三栏重构时已经删了 —— 跑完的东西没有任何地方能用上。
    root.querySelectorAll("[data-cv-use]").forEach((b) => (b.onclick = () => {
      const res = ctx.skills.applyProposal(b.dataset.cvUse);
      if (!res || !res.ok) ctx.toast(`没能用上：${(res && res.error) || "未知原因"}`);
      else {
        ctx.toast(res.detail || "已经写进去了");
        refreshConversation(ctx);
        render();
      }
    }));
    root.querySelectorAll("[data-cv-drop]").forEach((b) => (b.onclick = () => {
      const res = ctx.skills.reject(b.dataset.cvDrop, "他说不用");
      if (!res || !res.ok) ctx.toast(`没能标成不用：${(res && res.error) || "未知原因"}`);
      else { ctx.toast("知道了，不用它"); refreshConversation(ctx); }
    }));
    root.querySelectorAll("[data-cv-cancel]").forEach((b) => (b.onclick = () => {
      // the same REAL cancel a capability run gets — a local CLI keeps consuming
      // the subscription until something actually kills it
      Promise.resolve(cancelTurn(b.dataset.cvCancel)).then(() => refreshConversation(ctx));
    }));
    ensureConversation(ctx);
    // The page-level Agent panel is retired with the 导演台 (REQ-004 v2): there is
    // one conversation now. What the entrance button does is therefore no longer
    // 「open a second panel」 but 「put my cursor where I talk to it」.
    //
    // Leaving the old `bindAgentPanel` call here after deleting its import threw a
    // ReferenceError on EVERY bind — the picture still rendered, so nothing looked
    // wrong while every handler on the page was dead. That is why the guard in
    // tests/assetinboxsec.test.mjs enumerates the retired symbols: `node --check`
    // cannot see a missing global.
    root.querySelectorAll("[data-agent-open]").forEach((b) => (b.onclick = () => {
      const box = root.querySelector(".st-dir-composer .as-input");
      if (!box) return;
      if (box.scrollIntoView) box.scrollIntoView({ block: "nearest" });
      box.focus();
    }));
    // in-page section nav — and for ⑧ 镜头制作 this is the four-step flow bar
    // (TASK-073 §1.1/§1.3). Front-end state only: a section is never persisted.
    root.querySelectorAll("[data-sec]").forEach((b) => (b.onclick = () => {
      const list = PAGE_SECTIONS[activeModule];
      if (!list || !list.includes(b.dataset.sec)) return; // never open a section this page does not have
      ui.sections = { ...(ui.sections || {}), [activeModule]: b.dataset.sec };
      render();
    }));
    // episode rows in the 故事开发 rail — SELECT ONLY. A row switches which episode
    // is active and expands it; it never changes workspace. The row used to also
    // navigate, which made 「看一下 EP02」 indistinguishable from 「开始做 EP02」.
    bindStoryWork(root);
    root.querySelectorAll("[data-ep-choose]").forEach((b) => (b.onclick = () => selectEpisode(b.dataset.epChoose)));
    // cross-module jumps (empty states, director) — EVERY [data-goto] wires
    root.querySelectorAll("[data-goto]").forEach((j) => (j.onclick = () => setModule(j.dataset.goto)));
    if (activeModule === "brief") bindBriefWs(root, ctx, ui, render);
    if (activeModule === "story") bindStoryWs(root, ctx, ui, render);
    // 人物关系 binds as part of 人物 (bindBibleWs dispatches to it when the
    // relationship tab is showing) — binding it here as well would attach two
    // handlers to the same buttons.
    if (activeModule === "world") bindWorldWs(root, ctx, ui, render);
    if (activeModule === "episodes") {
      // the plan proposal/apply/confirm path stays the shared one
      ws.bindEpisodes(root, ctx);
      bindEpPlanWs(root, ctx, ui, render);
    }
    if (activeModule === "scenes") ws.bindEpisodes(root, ctx);
    if (activeModule === "characters" || activeModule === "settings") bindBibleWs(root, ctx, ui, render);
    if (activeModule === "shots") bindStoryboard(root, ctx, ui, render);
    if (activeModule === "frames") bindImageWs(root, ctx, ui, render);
    if (activeModule === "video") bindVideoWs(root, ctx, ui, render);
    if (activeModule === "audio") bindAudioWs(root, ctx, ui, render);
    if (activeModule === "episode") bindEpisodeWs(root, ctx, ui, render);
    bindPromptBatch(root, ctx, ui, render);
    bindStoryboardStrip(root, ctx, ui, render);
    bindKeyframeList(root, ctx, ui, render);
    bindVideoBatch(root, ctx, ui, render);
    if (activeModule === "refplan") {
      bindAssetPrep(root, ctx, ui, render);
      bindRefPlan(root, ctx, ui, render);
    }
    if (activeModule === "dailies") bindDailies(root, ctx, ui, render);
    if (activeModule === "storage") bindStorageWs(root, ctx, ui, render);
    // --- TASK-073 §1.1/§1.2: the new pages bind the SAME components ---------- //
    //
    // Dispatched by page + section, mirroring WORKSPACES exactly. A page that
    // rendered a component but did not bind it would look finished and do nothing —
    // the failure mode 「界面显示已应用」 exists to prevent.
    if (activeModule === "settings") {
      const sec = sectionOf("settings");
      if (sec === "world") bindWorldWs(root, ctx, ui, render);
      else bindBibleWs(root, ctx, ui, render);
    }
    if (activeModule === "board") bindEpisodeWs(root, ctx, ui, render);
    if (activeModule === "storyboard") {
      if (sectionOf("storyboard") === "scenes") ws.bindEpisodes(root, ctx);
      else bindStoryboard(root, ctx, ui, render);
    }
    if (activeModule === "shotwork") {
      const step = sectionOf("shotwork");
      if (step === "image") bindImageWs(root, ctx, ui, render);
      else if (step === "video") bindVideoWs(root, ctx, ui, render);
      else if (step === "pick") bindDailies(root, ctx, ui, render);
      else {
        bindAssetPrep(root, ctx, ui, render);
        bindRefPlan(root, ctx, ui, render);
      }
      // 「真实取消」 (验收 #7) — `ctx.skills.cancel` calls the backend and refuses to
      // record a cancellation it did not confirm. Deliberately NOT a local state
      // reset: that would print 「已取消」 over a still-running executor.
      if (step === "prepare") {
        root.querySelectorAll("[data-al-drawer-open]").forEach((b) => (b.onclick = () => {
          ui.alDrawer = ui.alDrawer !== true;
          render();
        }));
        root.querySelectorAll("[data-al-drawer-close]").forEach((b) => (b.onclick = () => {
          ui.alDrawer = false;
          render();
        }));
        // the drawer shares the library's own filter handlers — one implementation
        if (ui.alDrawer === true) bindAssetLibrary(root, ctx, ui, render);
        root.querySelectorAll("[data-al-add]").forEach((b) => (b.onclick = () => {
          const shotId = ui.selectedShotId || null;
          if (!shotId) { ctx.toast("先选一个镜头，再把参考加进去"); return; }
          // through the ORDINARY action, so the drawer cannot bypass a guard the
          // reference panel goes through
          const res = ctx.actions.dispatch({
            action: "addReference", shotId, referenceKey: b.dataset.alAdd,
          });
          ctx.toast(res.ok ? "已加入这一镜的参考" : res.error);
          render();
        }));
      }
      // 交付质检的真实探测（TASK-074 §1.2 接线）。Re-render TWICE: once so the
      // button turns into 「正在探测…」 before the scan starts, once when the
      // numbers (or the failure) come back. Without the first render an entire
      // episode's decode looks like a dead button.
      root.querySelectorAll("[data-qc-probe]").forEach((b) => (b.onclick = async () => {
        const pending = ctx.runDeliveryProbe();
        render();
        const state = await pending;
        if (state && state.error) ctx.toast(state.error);
        render();
      }));
      bindTaskRows(root, {
        onCancel: async (runId) => {
          const run = (ctx.skills.runs() || []).find(
            (r) => r && (r.runId === runId || r.runId === runId),
          );
          if (!run) { ctx.toast("找不到这次运行的记录"); render(); return; }
          const res = await ctx.skills.cancel(run.runId);
          if (!res.ok) ctx.toast(res.error);
          render();
        },
        onRetry: (runId) => {
          const run = (ctx.skills.runs() || []).find(
            (r) => r && (r.runId === runId || r.runId === runId),
          );
          // A retry is a NEW run of the same capability, never a re-open of this
          // record — the old one keeps its outcome (系统合同 §5.7 显式重试).
          ctx.toast(run && run.skillId
            ? `重试请在能力面板重新发起「${run.taskName || run.skillId}」——旧记录会保留`
            : "这条记录没有可重试的能力");
        },
      });
    }
    if (activeModule === "cutreview") bindCutReview(root, ctx, ui, render);
    if (activeModule === PROJECT_SETTINGS) {
      const sec = sectionOf(PROJECT_SETTINGS);
      if (sec === "storage") bindStorageWs(root, ctx, ui, render);
      // TASK-080 §1.1 — 「在当前上下文运行」 hands the choice to the ONE run path
      // (the Director's 能力 panel) rather than opening a second one here. The
      // catalog answers 「能做什么」; running stays where its guards already are.
      if (sec === "skills") bindSkillCatalog(root, ctx, ui, render, { onRun: (id) => openSkillRun(ctx, id) });
      if (sec === "health") bindHealth(root, { onReload: () => ctx.health && ctx.health.load() });
      // ⚙ 成片规格 / 预算与限制 — the ONLY editing entrance (§1.7). `change`, not
      // `input`: a half-typed number is not a decision, and validating on every
      // keystroke would reject 「1」 on the way to 「10」.
      root.querySelectorAll("[data-spec]").forEach((el) => (el.onchange = () => {
        const res = ctx.setDeliverySpecField(el.dataset.spec, el.value);
        // A REFUSAL IS REPORTED AND THE FIELD SNAPS BACK. Leaving the rejected text
        // in the box would show a value the project does not have.
        if (!res.ok) { ctx.toast(res.error); }
        render();
      }));
    }
    if (spaceOf(activeModule) === "assets" && activeModule !== "storage") {
      bindAssetLibrary(root, ctx, ui, render);
      // the relocated 资产收件箱 (REQ-004 v2) — its 确认归属 still routes through
      // directorops, so the confirmation gate survived the console it came from
      bindAssetInboxSection(root, ctx);
      // TASK-082 §1.2 — the content tree sets the library's OWN ownership filters
      // (`characterId` / `locationId` / `episodeId` / `unlinked`), which is what
      // makes the tree a view of the library rather than a second library. It
      // never touches the TYPE filter: the page's chips own that vocabulary, and
      // clearing it here would silently undo a chip the creator just clicked.
      root.querySelectorAll("[data-al-tree]").forEach((b) => (b.onclick = () => {
        const key = b.dataset.alTree;
        const id = b.dataset.alTreeId;
        const next = { ...(ui.alFilters || {}) };
        for (const k of ["characterId", "locationId", "episodeId", "unlinked"]) delete next[k];
        if (key !== "all") next[key] = key === "unlinked" ? true : id;
        ui.alFilters = next;
        ui.alOpen = null; // an inspector opened on an asset the new filter hides
        render();
      }));
    }
    // --- 剧集制作 (ADR-0061 决策 2): LEFT inspector + CENTER workspace -------- //
    if (spaceOf(activeModule) === "episode") {
      const onCentre = activeModule === LEGACY_EPISODE_CENTRE;
      const wm = workbenchModel(ctx, ui);
      const place = currentPlace(wm, ui.selectedShotId);
      if (onCentre) {
        // TOP — the three cascading selectors (§2)
        bindShotSelect(root, ctx, ui, render, {
          selectShot,
          enterEpisode: (id) => enterEpisode(id, null),
          m: wm,
          place,
        });
        // LEFT — reference configuration (§4 / §5 / §6)
        if (shotRefs) {
          bindShotRefs(root, ctx, ui, render, {
            shotId: ui.selectedShotId,
            onOpenNode: (n) => openShotCard(ctx, n),
          });
        }
        // BOTTOM — the visual reference searcher (§7)
        bindRefSearch(root, ctx, ui, render, { shotId: ui.selectedShotId });
      } else {
        // a stage workspace still gets the object Inspector: those surfaces have no
        // cards of their own, so removing their only operating panel would strand them
        bindInspector(root, ctx, ui, render, { node: provNode });
      }
      // 剪辑 IS the Post Production Console at full size (§15: nothing deleted, it
      // simply no longer takes room in the Shot workbench).
      if (activeModule === "edit" || activeModule === "delivery") bindPostConsole(root, ctx, ui, render);
      // 逐镜质检只在 delivery 的 qc 一节渲染，所以只在那里绑 —— 而「去这一镜」走
      // shell 自己的 `openShot`（它会问未保存的修改，也不会静默换集）。
      if (activeModule === "delivery" && sectionOf("delivery") === "qc") {
        bindShotQc(root, ctx, ui, render, { openShot: (id) => openShotIn(id) });
      }
      bindEpProd(root, ctx, ui, render, {
        enterEpisode: (id) => enterEpisode(id, null),
        setStage: (k) => setModule(k),
        goStory: () => setModule("episodes"),
        selectShot: (shotId) => selectShot(shotId),
      });
      // CENTER — the cards carry their own actions now (§10)
      if (shotGraph) {
        bindShotGraph(root, shotGraph, {
          onOpen: (n) => { ui.sgNode = n.id; ui.sgMenu = null; render(); },
          onMenu: (id) => { ui.sgMenu = ui.sgMenu === id ? null : id; render(); },
          onStage: (key) => { ui.sgStage = key; render(); },
          onAct: (act, n) => cardAction(ctx, act, n, shotGraph),
          // ---- TASK-093 批次 3 (codex 轮 1, P1: these had no control at all) ---- //
          //
          // 添加 routes to the EXISTING write path for that registry — the canvas adds
          // no second one. An item the domain marked unavailable never reaches here,
          // because `renderAddMenu` draws it as a `<span>`, not a button.
          onAdd: (kind) => {
            // EVERY BRANCH REUSES AN EXISTING WRITE PATH — that is the whole point of
            // TASK-093's first discipline. `cardAction("upload")` is the ONE import
            // path (ADR-0055): the file becomes an Asset on this shot and freezes the
            // inputs it was made from.
            //
            // An earlier draft called `ctx.assets.importInto(...)`, WHICH DOES NOT
            // EXIST — and my own wiring guard passed, because it only checked that the
            // string appeared in this file. A guard that greps for a call cannot tell a
            // real method from an invented one; it now asserts against the methods the
            // canvas genuinely uses.
            if (kind === "reference") { setModule("refplan"); return; }
            if (kind === "from-history") {
              // 「从生成历史选择」 adds no record: it opens the card's version history,
              // where choosing a version is the existing 「设为当前」.
              //
              // WHICH history depends on what the creator is looking at (codex 轮 2,
              // P2). It always opened the IMAGE card, so a shot whose work is on the
              // video side could not reach its own takes while the menu said it could.
              const sel = shotGraph.nodes.find((n) => n.id === ui.sgNode) || null;
              ui.sgMenu = sel && sel.type === "video" ? "video:selected" : "image:selected";
              render();
              return;
            }
            const node = kind === "video"
              ? shotGraph.nodes.find((n) => n.id === "video:selected")
              : shotGraph.nodes.find((n) => n.id === "image:selected");
            if (kind === "audio") {
              // audio lives in the post console, which owns the shot's tracks
              setModule("audio");
              return;
            }
            if (node) cardAction(ctx, "upload", node, shotGraph);
          },
          onChain: (id) => {
            const node = shotGraph.nodes.find((n) => n.id === ui.sgNode) || null;
            if (!node) return;
            if (id === "character-from-image") {
              // ADR-0074 决策 2: the name MUST come from a person. No prompt, no
              // character — a filename-derived name would never match any shot's
              // description while looking like it worked.
              const name = window.prompt("给这个角色起个名字（会用它在画面描述里识别这个人物）");
              if (name === null) return;
              ctx.shotgraph.characterFromImage(node, name);
              render();
              return;
            }
            const t = ctx.shotgraph.chain(shotGraph.shotId, node).find((x) => x.id === id);
            if (!t || !t.available) { ctx.toast((t && t.why) || "这条路现在走不了"); return; }
            if (id === "first-frame") { cardAction(ctx, "usefirst", node, shotGraph); return; }
            if (id === "end-frame") { cardAction(ctx, "extractbind", node, shotGraph); return; }
            if (id === "run-prompt") { cardAction(ctx, "generate", node, shotGraph); return; }
            // Unreachable by construction: `renderChainMenu` draws an unavailable target
            // as a `<span>`, and `CHAIN_HANDLED` is asserted to cover every available
            // one. Kept as a fail-loud floor rather than a silent no-op.
            ctx.toast(`「${t.label}」的落点还没接上 —— 不假装它成功了`);
          },
          onPreset: (presetId) => {
            if (!ui.selectedShotId) { ctx.toast("先选一个镜头"); return; }
            ctx.shotgraph.applyCameraPreset(ui.selectedShotId, presetId);
            render();
          },
        });
      }
      if (ui.pwOpen) {
        bindProdWizard(root, {
          onStep: (id) => { ui.pwStep = id; render(); },
          onGo: (id) => {
            const step = prodwizard.wizardStep(id);
            ui.pwOpen = false;
            // 每一步的落点是一个**既有页面**（向导不新增页面）。指不出落点的步骤
            // 不给一个空白面板 —— 它在向导里已经如实说了「界面还在做」。
            if (step && step.lands) setModule(step.lands);
            else render();
          },
          onClose: () => { ui.pwOpen = false; render(); },
        });
      }
      if (activeModule === "provenance") {
        const box = root.querySelector("#ep-graph");
        if (box && ctx.mountProvenance) {
          ctx.mountProvenance(box, () => { ui.piPrompt = null; ui.piAxes = null; render(); });
        }
      }
    }
    // 「画面描述里的实体是可点的」 (TASK-078 §2.3). Bound HERE, after the workspaces,
    // for the same reason `[data-goto]` is: opening 林照's card is a SHELL move
    // (switch page, switch section, open that drawer), and a workspace wiring its
    // own version would either shadow this one or land on a page that does not
    // contain the entity — ADR-0063 决策 1's failure.
    //
    // `stopPropagation` matters: these links sit INSIDE a cell whose own click
    // opens the description for editing.
    root.querySelectorAll("[data-ent-id]").forEach((b) => (b.onclick = (ev) => {
      ev.stopPropagation();
      openEntity(ctx, b.dataset.entKind, b.dataset.entId);
    }));
    // 「以此生成 →」 (TASK-079 §1.2) — every branch ends in a page switch WITH the
    // item prefilled, so it belongs here with the other cross-page moves. `land`
    // is `setModule`, which is the shell's own navigation and cannot be reached
    // from a workspace module.
    bindChainMenu(root, ctx, ui, render, {
      land: (to, shotId) => {
        // select FIRST, navigate second: the destination renders from
        // `ui.selectedShotId`, so switching before selecting would paint the
        // previous shot for one frame and, when nothing was selected, land on
        // the empty state this feature exists to remove.
        if (shotId) ui.selectedShotId = shotId;
        setModule(to);
        render();
      },
    });
    // 「交给 AI 导演诊断」 (TASK-079 §1.3) — one FAILED attempt, handed over with
    // what actually failed. Same shell-level reasoning as 问 Agent below; the
    // facts ride on the button so this never reaches into the card's model.
    root.querySelectorAll("[data-gc-diagnose]").forEach((b) => (b.onclick = (ev) => {
      ev.stopPropagation();
      diagnoseFailure(ctx, {
        shotId: b.dataset.shot,
        kind: b.dataset.kind,
        runId: b.dataset.gcDiagnose,
        model: b.dataset.model || null,
        why: b.dataset.why || null,
      });
    }));
    // 「问 Agent」 (TASK-079 §1.1) — put THIS item into the AI Director's context.
    //
    // Shell-level for the same reason as the two above: it narrows the Director's
    // scope (which follows `ui.selectedShotId`), opens the panel and prefills the
    // question. The prefill names the real shot and the real medium — a generic
    // 「帮我看看」 would be decoration.
    // 「测量」 — TASK-103 批次 C。只读 ffprobe，一次一个文件，创作者按了才跑。
    // 按钮上写明「只读探测，不花钱」，因为这一页别的按钮不是都这样。
    root.querySelectorAll("[data-cr-measure]").forEach((b) => (b.onclick = async (ev) => {
      ev.stopPropagation();
      b.disabled = true;
      b.textContent = "测量中…";
      // 无论成败都重渲染：失败也有它自己的一句话（「探不到（…）」），
      // 让按钮停在「测量中…」才是把结果吞掉。
      await ctx.review.measure(b.dataset.crMeasure);
      render();
    }));
    root.querySelectorAll("[data-cr-ask]").forEach((b) => (b.onclick = (ev) => {
      ev.stopPropagation();
      const shotId = b.dataset.crAsk;
      const kind = b.dataset.kind === "video" ? "视频" : "画面";
      const shot = ctx.shot.find(shotId);
      const name = shot ? (shot.title || `镜头 ${shot.sequence}`) : shotId;
      ui.selectedShotId = shotId;
      sessionState(ui).text =
        `看一下「${name}」的${kind}：它现在的状态对不对，下一步该做什么？`;
      render();
    }));
    // 「未填 · 去填写」 — the read-only facet displays now LAND ON THE CELL. Also
    // shell-level, and for the same reason: it opens ⑦ 分镜设计, switches it to the
    // table view and points at one row's one column, none of which the workspace
    // showing the blank facet can do for itself.
    root.querySelectorAll("[data-fillfacet]").forEach((b) => (b.onclick = (ev) => {
      ev.stopPropagation();
      // This is the OTHER door into the table view, so it carries the same rule
      // as the 卡片/表格 toggle (codex round 3, P1): the card's unsaved buffer must
      // not survive into the table, or a later card save writes stale facets over
      // whatever the table committed in between. `setModule` clears it on a real
      // page change but returns early when the page does not move — and 「未填 ·
      // 去填写」 is reachable from ⑦'s own card view, which is exactly that case.
      if (ui.dirty && !window.confirm("当前视图有未保存的修改，切换将丢弃？")) return;
      ui.dirty = false;
      ui.buffer = {};
      ui.tableView = true;
      ui.tableFocus = { shotId: b.dataset.shot || null, field: b.dataset.fillfacet };
      // `shots`, not `storyboard`: the page has TWO sections and only one of them
      // renders the shot list. Naming the page alone would leave whichever section
      // was last open — 场景 — and the creator would arrive at a page that does not
      // contain the cell they were sent to fill (ADR-0063 决策 1).
      setModule("shots");
      render();
    }));
    // The CROSS-SPACE entrances — bound LAST, and centrally: entering an episode
    // is a SHELL decision (switch the active episode AND open one of its stages),
    // so it must not be re-implemented per workspace. Binding after the
    // workspaces means a workspace that also wires the attribute cannot shadow it.
    //
    // 「进入剧集制作 →」 (the rail's exit, and 分集规划's row buttons) is the ONE
    // way into 剧集制作, and it lands on that space's own centre.
    // 「进入本集剧本 →」 stays inside 故事开发: 本集剧本 is story development's last
    // step, so it is not a cross-space jump at all.
    root.querySelectorAll("[data-ep-produce]").forEach((b) => (b.onclick = (ev) => {
      ev.stopPropagation();
      enterEpisode(b.dataset.epProduce, EPISODE_DEFAULT);
    }));
    root.querySelectorAll("[data-ep-enter]").forEach((b) => (b.onclick = (ev) => {
      ev.stopPropagation();
      enterEpisode(b.dataset.epEnter, EPISODE_DEFAULT);
    }));
    root.querySelectorAll("[data-ep-open]").forEach((b) => (b.onclick = (ev) => {
      ev.stopPropagation();
      enterEpisode(b.dataset.epOpen, "script");
    }));
    // The 导演台 and its Skill panel are retired (REQ-004 v2), so there is nothing
    // left to bind on the right — the conversation binds itself below.
    if (activeModule !== "script") return;
    // --- script workspace bindings (unchanged behavior) ---
    const text = root.querySelector(".pm-text");
    const dirtyTag = root.querySelector(".dirtytag");
    if (text)
      text.oninput = () => {
        ctx.script.edit(text.value); // no re-render — keeps the caret
        if (dirtyTag) dirtyTag.hidden = !ctx.script.isDirty();
      };
    const rev = root.querySelector(".pa-rev");
    if (rev) rev.oninput = () => { revText = rev.value; };
    const on = (sel, fn) => {
      const el = root.querySelector(sel);
      if (el) el.onclick = fn;
    };
    on("[data-gen]", () => ctx.script.generate("initial", ctx.episodeScriptBrief()));
    on("[data-revise]", () => ctx.script.generate("revision", revText));
    on("[data-apply]", () => { revText = ""; ctx.script.applyProposal(); });
    on("[data-discard]", () => ctx.script.discardProposal());
    on("[data-errx]", () => ctx.script.cancel());
    on(".cx", () => ctx.script.cancel());
    on(".vchip", () => { vmenuOpen = !vmenuOpen; render(); });
    const menu = root.querySelector(".vmenu");
    if (menu)
      menu.querySelectorAll("button").forEach((b) => (b.onclick = () => {
        vmenuOpen = false;
        ctx.script.setActive(+b.dataset.v); // triggers refreshType → re-render
      }));
  }

  // The module each SPACE opens on when the creator switches into it from the top
  // bar. Remembered per space, so returning to 剧集制作 lands where they were
  // rather than resetting every time (ADR-0061 决策 1). 剧集制作's own default is
  // its centre — the generation graph.
  const lastOf = { story: "brief", episode: EPISODE_DEFAULT, assets: "assets" };

  return {
    render,
    /**
     * Open the shell on a SPACE — "story" | "episode" | "assets" — or on a
     * specific module. `null` means "stay where you are".
     *
     * Returns the space actually landed on, which is NOT always the one asked
     * for: an unsaved shot edit refuses the switch, and a caller must never
     * claim a move that did not happen.
     */
    show(target) {
      let next = activeModule;
      if (target === "story" || target === "episode" || target === "assets") {
        next = spaceOf(activeModule) === target ? activeModule : lastOf[target];
      } else if (target && (WORKSPACES[target] || target === "script")) {
        next = target;
      }
      if (next !== activeModule) {
        if (ui.dirty && !window.confirm("镜头详情有未保存的修改，切换将丢弃？")) {
          root.style.display = "grid";
          render();
          return spaceOf(activeModule); // rejected — do not claim the switch
        }
        ui.dirty = false;
        ui.buffer = {};
        activeModule = next;
      }
      lastOf[spaceOf(activeModule)] = activeModule;
      if (spaceOf(activeModule) !== "assets") lastProdModule = activeModule;
      root.style.display = "grid";
      render();
      return spaceOf(activeModule);
    },
    /**
     * WHERE THE CREATOR IS, as a route (TASK-081 §1.1).
     *
     * Derived from the shell's own state at read time, so the address bar reports
     * where they ARE rather than where something last tried to send them.
     *
     * The module is reported as the ASSET TYPE ALIAS when a type filter is in
     * force, because that key is what resolves back to page + filter — writing
     * plain `assets` would drop the filter on every refresh.
     */
    route() {
      const ctx = getCtx();
      const pd = ctx.prodData();
      const prod = pd.production;
      const shot = ui.selectedShotId || null;
      // the SCENE is derived from the shot, never stored: the shell has no scene
      // selection, and inventing one would be a second source of truth for
      // something the document already answers
      let scene = null;
      if (shot && prod) {
        for (const e of prod.episodes || []) {
          const sc = (e.scenes || []).find((x) => (x.shotIds || []).includes(shot));
          if (sc) { scene = sc.sceneId; break; }
        }
      }
      const type = ui.alFilters && ui.alFilters.type;
      const alias = activeModule === "assets" && type && type !== "all"
        ? Object.keys(ASSET_FILTER_ALIAS).find((k) => ASSET_FILTER_ALIAS[k] === type)
        : null;
      return {
        module: alias || activeModule,
        section: sectionOf(activeModule),
        ep: prod ? prod.activeEpisodeId || null : null,
        scene,
        shot,
      };
    },
    /**
     * Go where an address says. Returns false when the move was REFUSED, so the
     * caller can put the address bar back rather than claiming a jump that did
     * not happen.
     *
     * THE UNSAVED-EDIT QUESTION IS ASKED ONCE, HERE. One address can move the
     * page, the episode and the shot at the same time, and each of the three
     * paths below has its own prompt — so the guard runs first for all three and
     * `releasePageState` then clears `ui.dirty`, which is what stops the creator
     * being asked the same question three times for one back-press.
     */
    applyRoute(r) {
      if (!r || !r.module) return false;
      const ctx = getCtx();
      const prod = ctx.prodData().production;
      const cur = {
        module: activeModule,
        ep: prod ? prod.activeEpisodeId || null : null,
        shot: ui.selectedShotId || null,
      };
      // THE TARGET SHOT IS RESOLVED BEFORE THE GUARD RUNS.
      //
      // A SCENE with no shot means 「open this scene」, and the only selection this
      // shell has is a shot — so it opens the scene's first one. Resolving that
      // AFTER the guard meant a `?scene=` address moved the selection while the
      // guard had been told the shot was not changing: the unsaved buffer then
      // belonged to one shot while the shell stood on another, which is worse than
      // discarding it (independent review, round 2). The guard must see the shot
      // the route will actually select, whichever way it was named.
      //
      // With a shot named, the scene is ignored: the shot already determines which
      // scene it is in, and honouring both would let an address name a pair that
      // does not exist.
      let shot = r.shot || null;
      if (!shot && r.scene && prod) {
        for (const e of prod.episodes || []) {
          const sc = (e.scenes || []).find((x) => x && x.sceneId === r.scene);
          if (sc) { shot = (sc.shotIds || [])[0] || null; break; }
        }
      }
      const want = { module: resolveModule(r.module).module, ep: r.ep, shot };
      // ONE PREDICATE DECIDES BOTH THINGS: whether to ASK, and whether to RELEASE.
      //
      // They must be the same question. An earlier version asked with
      // `guardsUnsavedEdit` and then released unconditionally, so a route that
      // moves nothing but the section — which is correctly NOT worth a prompt —
      // silently discarded the shot buffer anyway. That is the exact data loss
      // §1.2 第 1 条 is about, arriving through the door the guard was supposed to
      // close (independent review, round 1).
      const leaves = routeLeavesObject(cur, want);
      if (leaves && ui.dirty === true
        && !window.confirm("镜头详情有未保存的修改，离开将丢弃？")) return false;
      if (leaves) releasePageState(ui);
      // A SELECTION THE PROJECT NO LONGER HAS IS REPORTED, NOT SWALLOWED (§1.2
      // 第 2 条). A shared link ages: the episode it named can be gone, the shot
      // can have been regenerated. Opening the page anyway is right — the address
      // still says which page — but doing it in silence would leave the creator
      // looking at a different shot than the one they were sent to, with nothing
      // on screen to say so.
      const dropped = [];
      if (r.ep && prod && r.ep !== prod.activeEpisodeId) {
        if ((prod.episodes || []).some((e) => e && e.episodeId === r.ep)) {
          // the same transient state an episode switch always releases — the graph
          // node and the buffers typed against it belong to the episode being left
          ui.selectedShotId = null;
          ui.sgNode = null;
          ui.piPrompt = null;
          ui.piAxes = null;
          ctx.production.setActiveEpisode(r.ep);
        } else {
          dropped.push("剧集");
        }
      }
      if (!setModule(r.module)) return false;
      // An asset TYPE alias carries a filter; `setModule` already applies it when
      // the key itself was passed, and this honours it when the caller resolved
      // the key first — one address, one filter, either way in.
      if (r.filter) ui.alFilters = { ...(ui.alFilters || {}), type: r.filter };
      if (r.section && PAGE_SECTIONS[activeModule] && PAGE_SECTIONS[activeModule].includes(r.section)) {
        ui.sections = { ...(ui.sections || {}), [activeModule]: r.section };
      }
      if (shot) {
        if (isSelectableShot(ctx.prodData(), shot)) ui.selectedShotId = shot;
        else dropped.push(r.shot ? "镜头" : "场景");
      }
      if (dropped.length) {
        ctx.toast(
          `地址里的${dropped.join("与")}在这个项目里已经找不到了——页面打开了，`
          + `但没有按地址选中它。链接可能来自这个项目的另一个版本。`,
        );
      }
      lastOf[spaceOf(activeModule)] = activeModule;
      if (spaceOf(activeModule) !== "assets") lastProdModule = activeModule;
      root.style.display = "grid";
      render();
      return true;
    },
    /** Which space is on screen — what the top bar highlights. */
    space: () => spaceOf(activeModule),
    module: () => activeModule,
    hide() { root.style.display = "none"; vmenuOpen = false; },
    isVisible: () => root.style.display === "grid",
    /** True while a shot detail has unsaved edits. Anything OUTSIDE this shell
     *  that would change what the shell is looking at — switching the active
     *  episode from Workflow, for instance — has to ask first: the buffer
     *  belongs to a shot in the episode being left, and re-selection is blocked
     *  while it is dirty, so the edit would end up attributed to the wrong
     *  episode's context. */
    hasUnsavedShotEdit: () => ui.dirty === true,
    /** Drop the unsaved shot buffer. Only for a caller that has ALREADY asked
     *  the creator and been told to discard — it exists so such a caller does
     *  not trigger a second prompt for the same decision, where declining the
     *  second one would strand the buffer under a context that has moved on. */
    discardShotEdit() {
      ui.dirty = false;
      ui.buffer = {};
    },
    /** Open a specific shot in a shot workspace — the hand-off the Workflow
     *  provenance page uses for 「在制作中打开」. It only SELECTS; it does not
     *  switch episodes, because the caller (which knows the shot's episode)
     *  must decide that, and a silent episode switch would move the creator's
     *  context out from under them. Returns false when the selection was
     *  refused (unsaved shot edits), so the caller never claims a jump that
     *  did not happen. */
    openShot: openShotIn,
  };

  /** 「打开这一镜」的**唯一实现**。API 的 `openShot` 与页面内的跳转（逐镜质检的
   *  「去这一镜」，批次 5B）共用它 —— 复制一份就会有一处忘记问「未保存的修改」。 */
  function openShotIn(shotId, module = "shotwork") {
      if (typeof shotId !== "string" || !shotId) return false;
      if (ui.dirty && !window.confirm("镜头详情有未保存的修改，切换将丢弃？")) return false;
      ui.dirty = false;
      ui.buffer = {};
      ui.selectedShotId = shotId;
      // the graph node and the unsaved buffers belong to the shot being left
      ui.sgNode = null;
      ui.piPrompt = null;
      ui.piAxes = null;
      // A shot opens in 剧集制作 on the 制作台, and its own object opens in the LEFT
      // inspector: that is where a shot is worked on now (TASK-065 §9 / §12).
      activeModule = WORKSPACES[module] || module === "script" ? module : EPISODE_DEFAULT;
      ui.inspect = { ...(ui.inspect || {}), kind: (ui.inspect && ui.inspect.kind) || "shot", shotId };
      lastOf[spaceOf(activeModule)] = activeModule;
      lastProdModule = activeModule;
      root.style.display = "grid";
      render();
      return true;
  }
}

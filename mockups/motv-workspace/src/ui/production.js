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
import { renderStoryboard, bindStoryboard, defaultShotId, isSelectableShot } from "./storyboard.js";
import { episodeStageCounts } from "./prodplan.js";
import { renderAudioWs, bindAudioWs } from "./audiows.js";
import { renderTimelineWs, bindTimelineWs } from "./timelinews.js";
import { renderDailies, bindDailies } from "./dailies.js";
import { renderEpisodeWs, bindEpisodeWs } from "./episodews.js";
import { renderRefPlan, bindRefPlan } from "./refplan.js";
import { renderAssetLibrary, bindAssetLibrary, RAIL_TYPE } from "./assetlibws.js";
import { renderStorageWs, bindStorageWs } from "./storagews.js";
import { renderStoryWs, bindStoryWs } from "./storyws.js";
import { renderBibleWs, bindBibleWs } from "./biblews.js";
import { renderBriefWs, bindBriefWs } from "./briefws.js";
import { renderRelWs, bindRelWs } from "./relws.js";
import { renderWorldWs, bindWorldWs } from "./worldws.js";
import { renderEpPlanWs, bindEpPlanWs } from "./epplanws.js";
import { renderImageWs, bindImageWs, renderVideoWs, bindVideoWs } from "./mediaws.js";
import { directorModel, renderDirector, bindDirector } from "./director.js";
import { renderEpProd, bindEpProd } from "./epprod.js";
import { renderInspector, bindInspector } from "./prodinspector.js";
import { skillPanelModel, renderSkillPanel, bindSkillPanel } from "./skillpanel.js";
import {
  NAV, EPISODE_MODULES, EPISODE_DEFAULT, MODULE_LABEL, SPACE_LABEL, spaceOf,
  renderRail, renderAssetRail, renderCrumb, episodeLabels, head,
} from "./shell.js";

export { NAV };

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
    // M6: real persisted Episode entities — the count is honest domain data
    episodes: prod && Array.isArray(prod.episodes) ? String(prod.episodes.length) : "",
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
    // Storyboard/Image/Video: which variant tab is showing
    variantTab: "image",
    shotEdit: false,
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
  function aiPane(ctx, d, st) {
    if (st.generating) {
      const lab = d.pending.kind === "initial" ? "AI 生成剧本中…" : "AI 生成修订稿中…";
      return `<div class="st-skel"><i></i><i></i><i></i><i></i><i></i><i></i></div><div class="genprog"><span class="pc">${lab}</span><span class="cx">取消</span></div>`;
    }
    let out = "";
    if (st.error) {
      out += `<div class="scripterr">⚠ 生成失败：${esc(st.error)}<button class="errx" data-errx>知道了</button></div>`;
    }
    if (st.proposal) {
      // proposal vs current: both labeled, apply is explicitly "new version"
      return (
        out +
        `<div class="meta">当前剧本：<b>v${st.active}</b>${ctx.script.isDirty() ? "（含未版本化的手工修改）" : ""}</div>` +
        `<div class="proposal"><div class="proplab">修订稿提案 · 未应用 · 要求：${esc(st.proposal.instruction)}</div>` +
        `<textarea class="pa-proptext" readonly spellcheck="false">${esc(st.proposal.text)}</textarea>` +
        `<div class="row"><button class="btn primary" data-apply>✔ 应用为 v${st.nextVersion}</button><button class="btn" data-discard>放弃提案</button></div></div>` +
        `<div class="meta">应用后成为持久版本 v${st.nextVersion}；v1…v${st.versions} 全部保留，可随时回切。</div>`
      );
    }
    if (!st.versions && !ctx.script.hasContent()) {
      return (
        out +
        `<div class="meta">基于 创意＋已批准大纲＋本集规划 生成本集剧本：</div>` +
        `<button class="btn primary" data-gen>AI 生成本集剧本 v1</button>`
      );
    }
    return (
      out +
      `<label class="lab">修改要求</label>` +
      `<textarea class="field pa-rev" rows="3" spellcheck="false" placeholder="例如：结尾加一个反转；台词更口语化">${esc(revText)}</textarea>` +
      `<button class="btn primary" data-revise>AI 修订 → 生成提案</button>` +
      `<div class="meta">提案不会直接生效：确认「应用」后才创建新版本 v${st.nextVersion}，旧版本全部保留。</div>`
    );
  }

  /** The persistent right-side AI Director. Script gets the live assistant;
   *  every other module gets the contextual Director panel. */
  function aiDirector(ctx) {
    if (activeModule === "script") {
      const d = ctx.script.doc();
      return (
        `<aside class="st-dir prod-ai">` +
        `<div class="dir-head"><span class="av">🎬</span>AI 导演 · 剧本</div>` +
        aiPane(ctx, d, scriptStatus(d)) +
        `</aside>`
      );
    }
    const m = directorModel({
      module: activeModule,
      doc: ctx.script.doc(),
      story: ctx.story.doc(),
      pd: ctx.prodData(),
      sel: ui,
      // CP8/ADR-0059 要求 1+9: the ONE production read model the Director's
      // observation is built from — and the context ids it read, so that
      // observation can be traced back to the canon it actually saw.
      production: ctx.prodgraph.model({ shotId: ui.selectedShotId || null }),
    });
    // ADR-0061 决策 3: the Director now has a real Skill entrance. It is a
    // collapsible section like the others, and it leads when the creator opened
    // it — running a capability is the one thing the Director could not do.
    const skillOpen = ui.dirOpen && ui.dirOpen.skills === true;
    const sk = skillPanelModel(ctx, ui, execProbe);
    const skillSummary = sk.pending
      ? `<span class="chip gate">有提案待决定</span>`
      : sk.open
        ? `<span class="chip gen">运行中</span>`
        : `<span class="chip">${sk.skills.length} 个能力</span>`;
    const skillSec =
      `<section class="dir-sec${skillOpen ? " open" : ""}${sk.pending ? " surfaced" : ""}">` +
      `<button class="dir-sec-h" data-dsec="skills">` +
      `<span class="tw">${skillOpen ? "▾" : "▸"}</span><span class="ti">能力</span>` +
      `<span class="su">${skillSummary}</span></button>` +
      (skillOpen ? `<div class="dir-sec-b">${renderSkillPanel(sk, ui)}</div>` : "") +
      `</section>`;
    return (
      `<aside class="st-dir prod-ai">` +
      `<div class="dir-head"><span class="av">🎬</span>AI 导演` +
      `<span class="dir-space">${esc(SPACE_LABEL[spaceOf(activeModule)] || "")}</span></div>` +
      renderDirector(m, ui.directorText, ui.dirOpen, skillSec) +
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
    // Inside 剧集制作 the scene/shot crumb is always meaningful — Scene and Shot
    // are LEVELS of that space, not a per-stage extra (ADR-0061 决策 2).
    const showSel = inEpisode || ["shots", "frames", "video", "audio"].includes(activeModule);
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
      ? `<div class="chip gate">建议先在「故事」批准大纲 → 在「剧集」确认分集规划</div>`
      : "";
    return (
      head(ep ? ep.title : "当前剧集", "按集剧本 · 应用修订 = 创建新版本，旧版本保留", vbar + hint) +
      `<textarea class="pm-text" spellcheck="false" placeholder="在此输入/粘贴本集剧本，或在右侧用 AI 基于大纲与本集规划生成">${esc(ctx.script.currentText())}</textarea>`
    );
  }

  const WORKSPACES = {
    // --- 故事开发 (project-level upstream) --------------------------------- //
    brief: (ctx) => renderBriefWs(ctx, ui),
    story: (ctx) => renderStoryWs(ctx, ui),
    characters: (ctx) => renderBibleWs(ctx, ui),
    // `settings` is the legacy key for the bible workspace, kept working so
    // every existing jump target (Director blockers, empty states) still lands
    settings: (ctx) => renderBibleWs(ctx, ui),
    relationships: (ctx) => renderRelWs(ctx, ui),
    world: (ctx) => renderWorldWs(ctx, ui),
    episodes: (ctx) => renderEpPlanWs(ctx, ui),
    // --- 剧集制作 (inside ONE episode) ------------------------------------- //
    // ADR-0061 决策 2: `workbench` is this space's own unified map (Scene → Shot
    // → that shot's production objects) and is rendered by ui/epprod.js, not
    // here — it frames the stage workspaces below rather than being one of them.
    // `provenance` is a VIEW of this space: the graph mounts into a container the
    // shell hands it, so the node detail can live in the LEFT inspector.
    workbench: () => "",
    provenance: () => `<div class="ep-graph" id="ep-graph"></div>`,
    episode: (ctx) => renderEpisodeWs(ctx, ui),
    refplan: (ctx) => renderRefPlan(ctx, ui),
    scenes: (ctx) => ws.renderEpisodes(ctx),
    shots: (ctx) => renderStoryboard(ctx, ui),
    frames: (ctx) => renderImageWs(ctx, ui),
    video: (ctx) => renderVideoWs(ctx, ui),
    audio: (ctx) => renderAudioWs(ctx, ui),
    dailies: (ctx) => renderDailies(ctx, ui),
    edit: (ctx) => renderTimelineWs(ctx, ui),
    // 存储管理 stays the storage MANAGER (archive / remove bytes / delete);
    // 资产库 is the visual-first Production Memory Library (CP5). ADR-0061 决策 1
    // gives it a rail of media CATEGORIES: each key simply presets the library's
    // own type filter, so there is one library and one filter vocabulary rather
    // than seven near-identical workspaces.
    storage: (ctx) => renderStorageWs(ctx, ui),
    assets: (ctx) => renderAssetLibrary(ctx, ui),
    "assets:reference": (ctx) => renderAssetLibrary(ctx, ui),
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
    // EPISODE_DEFAULT is in this list because the graph is now what the creator
    // LANDS on: with no selection the LEFT column would greet them empty, and
    // 左边管当前对象 has to mean something the moment they arrive. A node click
    // immediately overrides it — this is only the starting object.
    if (![EPISODE_DEFAULT, "workbench", "shots", "frames", "video"].includes(activeModule)) return;
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
    // The grid differs per space (a 220px rail vs a 300px inspector), and the
    // CSS decides from ONE class so no two rules can disagree about which
    // space is on screen.
    root.className = `space-${space}`;
    // recomputed below only where the graph is the centre; cleared here so a
    // previous render's node can never be read by this one's bind()
    provNode = null;
    const main =
      activeModule === "script"
        ? scriptMain(ctx)
        : (WORKSPACES[activeModule] || (() => ""))(ctx);

    if (space === "episode") {
      // LEFT = the Production Inspector; CENTER = the generation graph (or the
      // stage workspace the creator stepped into); RIGHT = the AI Director.
      // 左边管输入和当前对象，中间管生产执行，右边永远属于 AI 导演。
      //
      // Resolved ONCE and shared with bind(): render and bind must agree about
      // whether this column is standing on a graph node, or the bindings would
      // release a selection the panel is still derived from (or fail to).
      provNode = activeModule === EPISODE_DEFAULT ? ctx.provenanceSelection() : null;
      root.innerHTML =
        crumb(ctx) +
        renderInspector(ctx, ui, {
          node: provNode,
          traceMode: ctx.relationsMode ? ctx.relationsMode() : "full",
        }) +
        `<main class="st-main prod-main ep-main">` +
        renderEpProd(ctx, ui, { stage: activeModule, inner: main }) +
        `</main>` +
        aiDirector(ctx);
      bind(ctx);
      notify();
      return;
    }

    if (space === "assets") {
      root.innerHTML =
        crumb(ctx) +
        `<nav class="st-rail prod-nav">${renderAssetRail({ activeModule, counts: assetRailCounts(ctx) })}</nav>` +
        `<main class="st-main prod-main">${main}</main>` +
        aiDirector(ctx);
      bind(ctx);
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
    root.innerHTML =
      crumb(ctx) +
      `<nav class="st-rail prod-nav">${rail}</nav>` +
      `<main class="st-main prod-main">${main}</main>` +
      aiDirector(ctx);
    bind(ctx);
    notify();
  }

  /** Tell the top bar where the creator now is. Called at the END of every
   *  render path, from the shell's own state — never from the callers that move
   *  it, so a new mover cannot forget to sync the bar. */
  function notify() {
    if (onNavigate) onNavigate(spaceOf(activeModule), activeModule);
  }

  /** Per-category counts for the 资产库 rail. Derived from the SAME library read
   *  model the workspace renders, so a rail badge cannot claim assets the list
   *  does not show. */
  function assetRailCounts(ctx) {
    const rows = ctx.assets.library({ type: "all", variant: "all" }).rows;
    const n = (fn) => rows.filter(fn).length || 0;
    return {
      assets: rows.length,
      "assets:reference": n((r) => r.isReference),
      "assets:image": n((r) => r.domain === "images" && !r.isReference),
      "assets:video": n((r) => r.domain === "videos" && !r.isReference),
      "assets:audio": n((r) => r.domain === "audio" && !r.isReference),
      "assets:final": n((r) => r.domain === "finals"),
      "assets:collection": n((r) => r.reusable),
    };
  }

  function setModule(k) {
    if (!WORKSPACES[k] && k !== "script") return;
    if (k === activeModule) return; // staying put must not touch unsaved edits
    if (ui.dirty && !window.confirm("镜头详情有未保存的修改，离开将丢弃？")) return;
    ui.dirty = false;
    ui.buffer = {};
    ui.shotEdit = false;
    activeModule = k; // UI navigation state only — domain edits/proposals live
    if (spaceOf(k) !== "assets") lastProdModule = k;
    // A 资产库 rail row simply presets the library's OWN type filter — the rail
    // and the in-page filter chips are two entrances to one vocabulary.
    if (k in RAIL_TYPE) ui.alFilters = { ...(ui.alFilters || {}), type: RAIL_TYPE[k] };
    vmenuOpen = false; // in their documents and survive this switch untouched
    ui.bibleOpen = null;
    ui.relOpen = null;
    // beatsOpen / impactOpen are keyed by episodeId and only render inside
    // 分集规划 — deliberately NOT reset here, so the AI Director can point the
    // creator at one episode's Impact Review and then navigate there.
    render();
  }

  /** Drop the transient per-episode selection state. Shared by the two paths
   *  below so selecting and entering can never disagree about what a switch
   *  invalidates. Returns false when the creator refused (unsaved shot edit),
   *  in which case NOTHING was touched. */
  function releaseEpisodeState() {
    if (ui.dirty && !window.confirm("镜头详情有未保存的修改，切换剧集将丢弃？")) return false;
    ui.dirty = false;
    ui.buffer = {};
    ui.shotEdit = false;
    ui.selectedShotId = null;
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
    // Entering from 故事开发 lands on 剧集制作's own centre — the generation graph
    // (EPISODE_DEFAULT), which is what 「进入剧集制作」 means: see what has been
    // made for this episode and what it came from. Already inside the space, the
    // stage the creator was on is kept.
    const target = module || (EPISODE_MODULES.includes(activeModule) ? activeModule : EPISODE_DEFAULT);
    if (target !== activeModule) {
      activeModule = target;
      lastProdModule = target;
      lastOf[spaceOf(target)] = target;
      vmenuOpen = false;
    }
    render(); // setActiveEpisode already re-rendered, but the module may have moved
  }

  function bind(ctx) {
    // left rail — every module opens; selection is visually .on
    root.querySelectorAll("[data-mod]").forEach((b) => (b.onclick = () => setModule(b.dataset.mod)));
    // episode rows in the 故事开发 rail — SELECT ONLY. A row switches which episode
    // is active and expands it; it never changes workspace. The row used to also
    // navigate, which made 「看一下 EP02」 indistinguishable from 「开始做 EP02」.
    root.querySelectorAll("[data-ep-choose]").forEach((b) => (b.onclick = () => selectEpisode(b.dataset.epChoose)));
    // cross-module jumps (empty states, director) — EVERY [data-goto] wires
    root.querySelectorAll("[data-goto]").forEach((j) => (j.onclick = () => setModule(j.dataset.goto)));
    if (activeModule === "brief") bindBriefWs(root, ctx, ui, render);
    if (activeModule === "story") bindStoryWs(root, ctx, ui, render);
    if (activeModule === "relationships") bindRelWs(root, ctx, ui, render);
    if (activeModule === "world") bindWorldWs(root, ctx, ui);
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
    if (activeModule === "refplan") bindRefPlan(root, ctx, ui, render);
    if (activeModule === "dailies") bindDailies(root, ctx, ui, render);
    if (activeModule === "edit") bindTimelineWs(root, ctx, ui, render);
    if (activeModule === "storage") bindStorageWs(root, ctx, ui, render);
    if (spaceOf(activeModule) === "assets" && activeModule !== "storage") {
      bindAssetLibrary(root, ctx, ui, render);
    }
    // --- 剧集制作 (ADR-0061 决策 2): LEFT inspector + CENTER workspace -------- //
    if (spaceOf(activeModule) === "episode") {
      // the SAME node story render() resolved — bind must never re-derive it
      bindInspector(root, ctx, ui, render, { node: provNode });
      bindEpProd(root, ctx, ui, render, {
        enterEpisode: (id) => enterEpisode(id, null),
        setStage: (k) => setModule(k),
        goStory: () => setModule("episodes"),
      });
      // The provenance graph mounts into the container the centre just rendered.
      // Re-mounting per render is safe and deliberate: `mount` only points the
      // graph at a DOM node — its view state (selection, trace mode, scope)
      // lives in its own closure and survives, which is what lets the LEFT
      // inspector keep showing the selected node across a shell re-render.
      if (activeModule === EPISODE_DEFAULT) {
        const box = root.querySelector("#ep-graph");
        // The rerender callback fires ONLY when the graph's selection actually
        // changed, so it is exactly the point at which the object this column
        // operates on moves. The unsaved Prompt buffer belongs to the object it
        // was typed against: carrying it across would offer shot B the text
        // written for shot A and save it there. Every other selection path
        // (`setInspect`, a shot card) already drops it for the same reason.
        if (box && ctx.mountProvenance) {
          ctx.mountProvenance(box, () => { ui.piPrompt = null; render(); });
        }
      }
    }
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
    // AI Director (non-script modules) — real dispatches only. The Skill panel
    // is part of the Director now, so it binds wherever the Director does.
    if (activeModule !== "script") {
      bindDirector(root, ctx, ui, render);
      bindSkillPanel(root, ctx, ui, render);
      return;
    }
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
        ui.shotEdit = false;
        activeModule = next;
      }
      lastOf[spaceOf(activeModule)] = activeModule;
      if (spaceOf(activeModule) !== "assets") lastProdModule = activeModule;
      root.style.display = "grid";
      render();
      return spaceOf(activeModule);
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
      ui.shotEdit = false;
    },
    /** Open a specific shot in a shot workspace — the hand-off the Workflow
     *  provenance page uses for 「在制作中打开」. It only SELECTS; it does not
     *  switch episodes, because the caller (which knows the shot's episode)
     *  must decide that, and a silent episode switch would move the creator's
     *  context out from under them. Returns false when the selection was
     *  refused (unsaved shot edits), so the caller never claims a jump that
     *  did not happen. */
    openShot(shotId, module = "workbench") {
      if (typeof shotId !== "string" || !shotId) return false;
      if (ui.dirty && !window.confirm("镜头详情有未保存的修改，切换将丢弃？")) return false;
      ui.dirty = false;
      ui.buffer = {};
      ui.shotEdit = false;
      ui.selectedShotId = shotId;
      // A shot opens in 剧集制作, and its own object opens in the LEFT inspector:
      // that is where a shot is worked on now (ADR-0061 决策 2).
      activeModule = WORKSPACES[module] || module === "script" ? module : "workbench";
      ui.inspect = { ...(ui.inspect || {}), kind: (ui.inspect && ui.inspect.kind) || "shot", shotId };
      lastOf[spaceOf(activeModule)] = activeModule;
      lastProdModule = activeModule;
      root.style.display = "grid";
      render();
      return true;
    },
  };
}

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
import { renderEpisodeWs, bindEpisodeWs } from "./episodews.js";
import { renderRefPlan, bindRefPlan } from "./refplan.js";
import { renderAssetLibrary, bindAssetLibrary, RAIL_TYPE } from "./assetlibws.js";
import { renderStorageWs, bindStorageWs } from "./storagews.js";
import { renderStoryWs, bindStoryWs } from "./storyws.js";
import { renderBibleWs, bindBibleWs } from "./biblews.js";
import { renderBriefWs, bindBriefWs } from "./briefws.js";
import { renderWorldWs, bindWorldWs } from "./worldws.js";
import { renderEpPlanWs, bindEpPlanWs } from "./epplanws.js";
import { renderImageWs, bindImageWs, renderVideoWs, bindVideoWs } from "./mediaws.js";
import { directorModel, renderDirector, bindDirector } from "./director.js";
import { renderEpProd, bindEpProd, workbenchModel, currentPlace } from "./epprod.js";
import { renderShotGraph, bindShotGraph, drawShotEdges, renderStages } from "./shotgraphview.js";
import { inspectFromShotNode } from "../workflow/shotgraph.js";
import { derivedLabel } from "../workflow/assetreg.js";
// TASK-066: the five regions of 剧集制作. Each owns ONE question, and the shell is the
// only thing that knows they are on the same screen.
import { renderShotSelect, bindShotSelect } from "./shotselect.js";
import { renderShotRefs, bindShotRefs } from "./shotrefs.js";
import { renderRefSearch, bindRefSearch, searchModel } from "./refsearch.js";
import { renderInspector, bindInspector } from "./prodinspector.js";
import { renderPostConsole, bindPostConsole } from "./postconsole.js";
import { skillPanelModel, renderSkillPanel, bindSkillPanel } from "./skillpanel.js";
import { shotDirectorModel, renderShotDirector, bindShotDirector, runOperation } from "./directorshot.js";
import { episodeView } from "../workflow/proddoc.js";
import {
  NAV, EPISODE_MODULES, EPISODE_DEFAULT, MODULE_LABEL, SPACE_LABEL, spaceOf,
  renderRail, renderAssetRail, renderCrumb, episodeLabels, head, episodeEntryModule,
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
  // The RIGHT column's operational model for THIS render (TASK-067) — resolved by
  // aiDirector(), read by bind(). Non-null only on the shot workbench with a shot
  // selected, which is exactly where its ten operations mean anything.
  let shotDirector = null;
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
    // TASK-067 §2 / §6 / §18 / §19 — the AI Director as a real OPERATION ENTRANCE.
    //
    // On the shot workbench this REPLACES the old 当前状态 checklist rather than
    // sitting beside it. Two checklists of the same shot, derived two ways, is the
    // duplicate this codebase keeps paying for: `shotDirectorModel` reads
    // `shotctx.shotReadiness`, which is the same derivation the capability layer
    // gates on, so the panel and the buttons can never disagree about whether this
    // shot is ready. The 能力 catalog below stays reachable — nothing was removed.
    shotDirector = onShotBench ? shotDirectorModel(ctx, ui, execProbe) : null;
    const shotDirSec = shotDirector
      ? `<section class="dir-sec open sd-sec"><div class="dir-sec-h static">` +
        `<span class="ti">这一镜现在怎么办</span></div>` +
        `<div class="dir-sec-b">${renderShotDirector(shotDirector, ui)}</div></section>`
      : "";
    // 当前状态 (TASK-066 §14) — kept for the stage workspaces, where the operational
    // panel above is not rendered. DERIVED from the same graph the centre draws, so
    // the checklist and the picture cannot disagree about what exists.
    const stateSec = shotGraph && !shotDirector
      ? `<section class="dir-sec open"><div class="dir-sec-h static"><span class="ti">当前状态</span></div>` +
        `<div class="dir-sec-b"><div class="dir-state">` +
        [
          ["主要画面参考", shotGraph.bands.find((b) => b.key === "refs").nodes.length, "个"],
          ["视频编排参考", shotGraph.bands.find((b) => b.key === "directing").nodes.length, "个"],
        ].map(([k, n, unit]) =>
          `<div class="dir-strow ${n ? "ok" : "gap"}"><span class="mk">${n ? "✓" : "!"}</span>` +
          `<span class="k">${esc(k)}</span><span class="v">${n} ${esc(unit)}</span></div>`).join("") +
        [
          ["Image Prompt", shotGraph.nodes.find((n) => n.id === "prompt:image")],
          ["主帧图", shotGraph.nodes.find((n) => n.id === "image:selected")],
          ["Video Prompt", shotGraph.nodes.find((n) => n.id === "prompt:video")],
          ["最终视频", shotGraph.nodes.find((n) => n.id === "video:selected")],
        ].map(([k, n]) => {
          if (!n) return "";
          // the WORDS are the truth of each state, never a generic 「就绪」: 「还缺 2 项」
          // and 「已就绪」 are different facts and the creator acts on them differently
          const done = n.state === "ready" || n.state === "active";
          const what = n.type === "prompt"
            ? (n.missing && n.missing.length ? `还缺 ${n.missing.length} 项` : "已就绪")
            : n.version != null ? `已选定 v${n.version}` : "待生成";
          return `<div class="dir-strow ${done ? "ok" : "gap"}"><span class="mk">${done ? "✓" : "!"}</span>` +
            `<span class="k">${esc(k)}</span><span class="v">${esc(what)}</span></div>`;
        }).join("") +
        `</div>` +
        (shotGraph.done
          ? `<div class="pi-ok">这一镜已经有选定的最终视频。</div>`
          : `<div class="meta">剧集制作的终点是「选定的最终 Shot Video」。</div>`) +
        `</div></section>`
      : "";
    return (
      `<aside class="st-dir prod-ai">` +
      `<div class="dir-head"><span class="av">🎬</span>AI 导演` +
      `<span class="dir-space">${esc(SPACE_LABEL[spaceOf(activeModule)] || "")}</span></div>` +
      shotDirSec +
      stateSec +
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
    // TASK-065 §2: 人物关系 is a TAB of 人物 now, but the module KEY stays working —
    // the Director's blocker fixes and several empty states jump to it, and a jump
    // target that resolves to nothing is a regression, not a migration. `setModule`
    // opens 人物 on the relationship tab; this entry is what it renders.
    relationships: (ctx) => renderBibleWs(ctx, ui),
    world: (ctx) => renderWorldWs(ctx, ui),
    episodes: (ctx) => renderEpPlanWs(ctx, ui),
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
    refplan: (ctx) => renderRefPlan(ctx, ui),
    scenes: (ctx) => ws.renderEpisodes(ctx),
    shots: (ctx) => renderStoryboard(ctx, ui),
    frames: (ctx) => renderImageWs(ctx, ui),
    video: (ctx) => renderVideoWs(ctx, ui),
    audio: (ctx) => renderAudioWs(ctx, ui),
    dailies: (ctx) => renderDailies(ctx, ui),
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
    // EPISODE_DEFAULT (制作台) leads this list because the whole centre IS the
    // current shot now: with no selection there is no graph to draw and the LEFT
    // column would greet the creator empty. A scene/shot chip immediately overrides
    // it — this is only the starting object.
    if (![EPISODE_DEFAULT, "provenance", "shots", "frames", "video"].includes(activeModule)) return;
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
    shotGraph = null;
    shotRefs = null;
    refSearch = null;
    shotDirector = null;
    onShotBench = false;
    const main =
      activeModule === "script"
        ? scriptMain(ctx)
        : (WORKSPACES[activeModule] || (() => ""))(ctx);

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
      const onCentre = activeModule === EPISODE_DEFAULT;
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
      const isConsole = activeModule === "edit";
      root.innerHTML =
        crumb(ctx) +
        (onCentre ? renderShotSelect(ctx, ui, wm, place) : "") +
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
            ? renderShotGraph(shotGraph, {
                selectedId: ui.sgNode,
                layout: ui.sgLayout || "auto",
                menuOpen: ui.sgMenu,
              })
            : null,
        }) +
        `</main>` +
        aiDirector(ctx) +
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
      if (shotGraph) drawShotEdges(root, shotGraph);
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

  function setModule(want) {
    if (!WORKSPACES[want] && want !== "script") return;
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
    if (k === activeModule) {
      // the module key did not move, but the TAB may have — repaint so
      // 「在关系图里编辑」 from inside 人物 actually shows the graph
      render();
      return;
    }
    if (ui.dirty && !window.confirm("镜头详情有未保存的修改，离开将丢弃？")) return;
    ui.dirty = false;
    ui.buffer = {};
    activeModule = k; // UI navigation state only — domain edits/proposals live
    if (spaceOf(k) !== "assets") lastProdModule = k;
    // A 资产库 rail row simply presets the library's OWN type filter — the rail
    // and the in-page filter chips are two entrances to one vocabulary.
    if (k in RAIL_TYPE) ui.alFilters = { ...(ui.alFilters || {}), type: RAIL_TYPE[k] };
    vmenuOpen = false; // in their documents and survive this switch untouched
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
    if (activeModule === "refplan") bindRefPlan(root, ctx, ui, render);
    if (activeModule === "dailies") bindDailies(root, ctx, ui, render);
    if (activeModule === "storage") bindStorageWs(root, ctx, ui, render);
    if (spaceOf(activeModule) === "assets" && activeModule !== "storage") {
      bindAssetLibrary(root, ctx, ui, render);
    }
    // --- 剧集制作 (ADR-0061 决策 2): LEFT inspector + CENTER workspace -------- //
    if (spaceOf(activeModule) === "episode") {
      const onCentre = activeModule === EPISODE_DEFAULT;
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
      if (activeModule === "edit") bindPostConsole(root, ctx, ui, render);
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
        });
      }
      if (activeModule === "provenance") {
        const box = root.querySelector("#ep-graph");
        if (box && ctx.mountProvenance) {
          ctx.mountProvenance(box, () => { ui.piPrompt = null; ui.piAxes = null; render(); });
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
      // TASK-067: the shot workbench's operational panel. Bound only where it was
      // rendered — `shotDirector` is null everywhere else, and binding against a
      // panel that is not on screen would attach handlers carrying the PREVIOUS
      // shot's id.
      if (shotDirector) {
        bindShotDirector(root, ctx, ui, render, {
          shotId: shotDirector.shotId,
          onOpenNode: (node) => openShotCard(ctx, node),
        });
      }
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
    },
    /** Open a specific shot in a shot workspace — the hand-off the Workflow
     *  provenance page uses for 「在制作中打开」. It only SELECTS; it does not
     *  switch episodes, because the caller (which knows the shot's episode)
     *  must decide that, and a silent episode switch would move the creator's
     *  context out from under them. Returns false when the selection was
     *  refused (unsaved shot edits), so the caller never claims a jump that
     *  did not happen. */
    openShot(shotId, module = EPISODE_DEFAULT) {
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
    },
  };
}

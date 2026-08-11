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
import { renderAssetLibrary, bindAssetLibrary } from "./assetlibws.js";
import { renderStorageWs, bindStorageWs } from "./storagews.js";
import { renderStoryWs, bindStoryWs } from "./storyws.js";
import { renderBibleWs, bindBibleWs } from "./biblews.js";
import { renderBriefWs, bindBriefWs } from "./briefws.js";
import { renderRelWs, bindRelWs } from "./relws.js";
import { renderWorldWs, bindWorldWs } from "./worldws.js";
import { renderEpPlanWs, bindEpPlanWs } from "./epplanws.js";
import { renderImageWs, bindImageWs, renderVideoWs, bindVideoWs } from "./mediaws.js";
import { directorModel, renderDirector, bindDirector } from "./director.js";
import { NAV, EPISODE_MODULES, MODULE_LABEL, renderRail, renderCrumb, episodeLabels, head } from "./shell.js";

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

export function createProduction(getCtx) {
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
  };

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
    });
    return (
      `<aside class="st-dir prod-ai">` +
      `<div class="dir-head"><span class="av">🎬</span>AI 导演</div>` +
      renderDirector(m, ui.directorText, ui.dirOpen) +
      `</aside>`
    );
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
    const showSel = ["shots", "frames", "video", "audio"].includes(activeModule);
    const tail = ep && eps.length > 1 ? `共 ${eps.length} 集` : "";
    // upstream modules are PROJECT-level: showing an episode crumb there would
    // claim the creator is inside an episode when they are not
    const inEpisode = EPISODE_MODULES.includes(activeModule);
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
    // --- 作品开发 (project-level upstream) --------------------------------- //
    brief: (ctx) => renderBriefWs(ctx, ui),
    story: (ctx) => renderStoryWs(ctx, ui),
    characters: (ctx) => renderBibleWs(ctx, ui),
    // `settings` is the legacy key for the bible workspace, kept working so
    // every existing jump target (Director blockers, empty states) still lands
    settings: (ctx) => renderBibleWs(ctx, ui),
    relationships: (ctx) => renderRelWs(ctx, ui),
    world: (ctx) => renderWorldWs(ctx, ui),
    episodes: (ctx) => renderEpPlanWs(ctx, ui),
    // --- 本集制作 (inside ONE episode) ------------------------------------- //
    // CP6/ADR-0058: 本集制作 is the unified creative context — the episode's
    // script, its scenes, and each scene's shots with their current picture,
    // in ONE place. The per-stage workspaces below stay exactly as they are;
    // this is where the work is done, they are where a stage is worked through.
    episode: (ctx) => renderEpisodeWs(ctx, ui),
    refplan: (ctx) => renderRefPlan(ctx, ui),
    scenes: (ctx) => ws.renderEpisodes(ctx),
    shots: (ctx) => renderStoryboard(ctx, ui),
    frames: (ctx) => renderImageWs(ctx, ui),
    video: (ctx) => renderVideoWs(ctx, ui),
    audio: (ctx) => renderAudioWs(ctx, ui),
    dailies: (ctx) => renderDailies(ctx, ui),
    edit: (ctx) => renderTimelineWs(ctx, ui),
    // 存储 stays the storage MANAGER (archive / remove bytes / delete);
    // 资产 is now the visual-first Production Memory Library (CP5).
    storage: (ctx) => renderStorageWs(ctx, ui),
    assets: (ctx) => renderAssetLibrary(ctx, ui),
  };

  /** Shot workspaces open on a real shot: an empty centre column next to a
   *  populated episode is exactly the blank-space failure the studio is meant
   *  to avoid. A selection that no longer resolves (draft regenerated, episode
   *  switched) falls back the same way — it is never left dangling. */
  function ensureShotSelection(pd) {
    if (!["shots", "frames", "video"].includes(activeModule)) return;
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
    const rail = renderRail({
      activeModule,
      badges,
      episodes: episodeLabels(pd.production),
      ratios,
      episodeMode: EPISODE_MODULES.includes(activeModule),
      upstream,
    });
    const main =
      activeModule === "script"
        ? scriptMain(ctx)
        : WORKSPACES[activeModule](ctx);
    root.innerHTML =
      crumb(ctx) +
      `<nav class="st-rail prod-nav">${rail}</nav>` +
      `<main class="st-main prod-main">${main}</main>` +
      aiDirector(ctx);
    bind(ctx);
  }

  function setModule(k) {
    if (!WORKSPACES[k] && k !== "script") return;
    if (k === activeModule) return; // staying put must not touch unsaved edits
    if (ui.dirty && !window.confirm("镜头详情有未保存的修改，离开将丢弃？")) return;
    ui.dirty = false;
    ui.buffer = {};
    ui.shotEdit = false;
    activeModule = k; // UI navigation state only — domain edits/proposals live
    if (k !== "assets") lastProdModule = k;
    vmenuOpen = false; // in their documents and survive this switch untouched
    ui.bibleOpen = null;
    ui.relOpen = null;
    // beatsOpen / impactOpen are keyed by episodeId and only render inside
    // 分集规划 — deliberately NOT reset here, so the AI Director can point the
    // creator at one episode's Impact Review and then navigate there.
    render();
  }

  /** Switch the active episode and (optionally) open one of ITS stages —
   *  Production's exit. `module` null means: stay where you are if you are
   *  already inside an episode, otherwise enter at 剧本. Refused while a shot
   *  detail has unsaved edits, because the buffer belongs to the episode being
   *  left. */
  function enterEpisode(episodeId, module) {
    const ctx = getCtx();
    if (ui.dirty && !window.confirm("镜头详情有未保存的修改，切换剧集将丢弃？")) return;
    ui.dirty = false;
    ui.buffer = {};
    ui.shotEdit = false;
    ui.selectedShotId = null;
    if (!ctx.production.setActiveEpisode(episodeId)) return;
    // staying on the stage you were already on when switching episodes; from
    // upstream, entering an episode opens 本集制作 — the view of the whole
    // episode,
    // which is what "进入本集" means now that one exists
    const target = module || (EPISODE_MODULES.includes(activeModule) ? activeModule : "episode");
    if (target !== activeModule) {
      activeModule = target;
      lastProdModule = target;
      vmenuOpen = false;
    }
    render(); // setActiveEpisode already re-rendered, but the module may have moved
  }

  function bind(ctx) {
    // left rail — every module opens; selection is visually .on
    root.querySelectorAll("[data-mod]").forEach((b) => (b.onclick = () => setModule(b.dataset.mod)));
    // episode rows — ENTER an episode (Production's exit). Selecting one always
    // switches the active episode; when the creator is still upstream it also
    // opens the episode's first stage, because that is what "进入本集" means.
    root.querySelectorAll("[data-ep]").forEach((b) => (b.onclick = () => enterEpisode(b.dataset.ep, null)));
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
    if (activeModule === "assets") bindAssetLibrary(root, ctx, ui, render);
    // "进入本集" — bound LAST, and centrally: entering an episode is a SHELL
    // decision (switch the active episode AND open one of its stages), so it
    // must not be re-implemented per workspace. Binding after the workspaces
    // means a workspace that also wires the attribute cannot shadow it.
    //
    // The two entrances land where their LABEL says they land: 「进入本集」opens
    // 本集制作, 「进入本集剧本」opens 剧本. One shared target would have made one
    // of the two buttons lie about where it goes.
    root.querySelectorAll("[data-ep-enter]").forEach((b) => (b.onclick = (ev) => {
      ev.stopPropagation();
      enterEpisode(b.dataset.epEnter, "episode");
    }));
    root.querySelectorAll("[data-ep-open]").forEach((b) => (b.onclick = (ev) => {
      ev.stopPropagation();
      enterEpisode(b.dataset.epOpen, "script");
    }));
    // AI Director (non-script modules) — real dispatches only
    if (activeModule !== "script") {
      bindDirector(root, ctx, ui, render);
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

  return {
    render,
    /** Open the shell on a module. `"assets"` is the top bar's 资产 mode;
     *  `null` means 制作 — which must LEAVE the asset library, restoring the
     *  last production module rather than silently staying on assets. */
    show(module) {
      const next = module === "assets"
        ? "assets"
        : module && (WORKSPACES[module] || module === "script")
          ? module
          : activeModule === "assets" ? lastProdModule : activeModule;
      if (next !== activeModule) {
        if (ui.dirty && !window.confirm("镜头详情有未保存的修改，切换将丢弃？")) {
          root.style.display = "grid";
          render();
          return activeModule; // rejected — the caller must not claim the switch
        }
        ui.dirty = false;
        ui.buffer = {};
        ui.shotEdit = false;
        activeModule = next;
      }
      if (activeModule !== "assets") lastProdModule = activeModule;
      root.style.display = "grid";
      render();
      return activeModule;
    },
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
    openShot(shotId, module = "shots") {
      if (typeof shotId !== "string" || !shotId) return false;
      if (ui.dirty && !window.confirm("镜头详情有未保存的修改，切换将丢弃？")) return false;
      ui.dirty = false;
      ui.buffer = {};
      ui.shotEdit = false;
      ui.selectedShotId = shotId;
      activeModule = WORKSPACES[module] || module === "script" ? module : "shots";
      lastProdModule = activeModule;
      root.style.display = "grid";
      render();
      return true;
    },
  };
}

// 分镜工作区 (M8) — the creator-facing Storyboard / Shot workspace:
// scene rail → shot cards → selected-shot detail (creative facets + scene's
// character/location context) → the shot's media area (image/video variants,
// first frame, voice standing, per-shot generation lineage).
//
// STRICT view over existing domains: shots live on the scriptgen draft
// (edits save as a NEW immutable version via ctx.shots.saveEdit), structure
// on the M6 production document, bible on M7, media on the M3 Asset
// Registry, provenance on the M5 Generation Registry. No state is duplicated
// here; transient UI state (selection, edit buffer) belongs to the shell.
import { esc } from "../util/dom.js";
import { head, empty } from "./shell.js";
import {
  nn, renderSceneStrip, renderShotList, renderHero, renderVariantGrid,
  renderVariantTabs, renderRefCards, renderLineage, renderShotMeta, videoSourceFrame, curVideoVersion,
} from "./studioparts.js";
import { slotEntry } from "../workflow/mediaref.js";
import { buildShotSlotIndex, slotForShotId, buildServerBridge, serverShotIdForShot } from "../workflow/shotmap.js";
import { episodeView, sceneOfShot, activeEpisode } from "../workflow/proddoc.js";
import { findCharacter, findLocation, resolveCharacter, resolveLocation } from "../workflow/bibledoc.js";
import { outlineForPlan } from "../workflow/storydoc.js";
import { compileImagePrompt, compileVideoPrompt } from "../workflow/promptc.js";
import { referenceBlock } from "../workflow/promptrefs.js";
import { promptBlock as promptBlockLookup } from "../workflow/skills.js";
import { referencesOfShot } from "../workflow/shotprod.js";
import { listReferences, derivedLabel, INTERPRETATION_KINDS } from "../workflow/assetreg.js";
import { interpretationInputs } from "../workflow/refinterp.js";
import * as refuse from "../workflow/refuse.js";
import { bindingOf, describeBinding } from "../workflow/framebind.js";
import { shotTableModel, renderShotTable, bindShotTable, tableDirty } from "./shottable.js";


const ORIGIN_ZH = {
  upload: "手工上传", "paid-image": "付费生成", "paid-video": "付费生成",
  adopted: "付费入槽", tts: "本地 TTS", compose: "本地合成",
};

/** The draft-shot fields the detail editor writes. ONE list, used by the form,
 *  by the save mapping AND by the 「有没有真的改动」 check — those three drifting
 *  apart is how a field gets an input box that saves nothing (TASK-078 §2.1). */
const DETAIL_FIELDS = [
  "title", "description", "action", "cameraMotion", "dialogue",
  "shotSize", "angle", "emotion", "lighting",
];

// ---------- pure view-models --------------------------------------------- //

/** A scene's bible references resolved for display (name + state name). */
function sceneRefsView(prod, scene) {
  const characters = (scene.characterRefs || []).map((r) => {
    const c = findCharacter(prod, r.characterId);
    const rc = c ? resolveCharacter(c, r.stateId) : null;
    return {
      characterId: r.characterId,
      name: rc ? rc.name : r.characterId,
      stateName: rc ? rc.stateName : null,
    };
  });
  const lr = scene.locationRef;
  const l = lr && findLocation(prod, lr.locationId);
  const rl = l ? resolveLocation(l, lr.stateId) : null;
  return {
    characters,
    location: lr
      ? { locationId: lr.locationId, name: rl ? rl.name : lr.locationId, stateName: rl ? rl.stateName : null }
      : null,
  };
}

/** One shot card: identity + creative summary + media standing. */
function shotCard(pd, idx, s) {
  const shotId = typeof s.shotId === "string" && s.shotId ? s.shotId : null;
  const slot = shotId ? slotForShotId(idx, s.shotId) : s.slot || null;
  const unresolved = !!(shotId && !slotForShotId(idx, s.shotId) && s.slot);
  const img = slot ? slotEntry(pd.assetUploads, slot) : null;
  const vid = slot ? slotEntry(pd.media.video, slot) : null;
  const cur = (e) => (e ? e.history.find((r) => r.version === e.current) || e.history[e.history.length - 1] : null);
  const imgRef = cur(img);
  const vidRef = cur(vid);
  return {
    shotId,
    seq: s.sequence,
    title: s.title || "",
    description: s.description || "",
    duration: s.duration_seconds ?? null,
    slot,
    unresolved,
    thumb: imgRef ? imgRef.url : "",
    hasVideo: !!vidRef,
  };
}

/** The Storyboard board: the ACTIVE episode's scenes (resolved via canonical
 *  creativeShotId), the unassigned pool, and draft standing. */
export function storyboardModel(pd) {
  const prod = pd.production;
  const draft = pd.draftShots || [];
  const idx = buildShotSlotIndex(draft);
  const ep = prod ? activeEpisode(prod) : null;
  const view = prod && ep ? episodeView(prod, ep.episodeId, draft) : null;
  const cardByShotId = new Map();
  for (const s of draft) {
    const c = shotCard(pd, idx, s);
    if (c.shotId) cardByShotId.set(c.shotId, c);
  }
  const scenes = view
    ? view.scenes.map((sc) => ({
        sceneId: sc.sceneId,
        title: sc.title,
        refs: sceneRefsView(prod, ep.scenes.find((x) => x.sceneId === sc.sceneId) || {}),
        shots: sc.shots.map((x) =>
          x.shot && cardByShotId.has(x.shotId)
            ? cardByShotId.get(x.shotId)
            : { shotId: x.shotId, dangling: true, title: x.shotId, seq: null, thumb: "", hasVideo: false }),
      }))
    : [];
  const unassigned = view ? view.unassigned.map((s) => shotCard(pd, idx, s)) : [];
  // Shots this EPISODE owns — referenced by one of ITS scenes. The draft is
  // project-level (it lives on the scriptgen node) and the unassigned pool
  // belongs to no episode at all, so neither `draft.length` nor the pool may
  // be counted here: both would credit the same work to every episode.
  const episodeShotIds = [];
  for (const sc of scenes) {
    for (const x of sc.shots) if (x.shotId && !x.dangling) episodeShotIds.push(x.shotId);
  }
  const episodeTotal = episodeShotIds.length;
  return {
    hasDraft: draft.length > 0,
    episodeShotIds,
    episodeTotal,
    episodeEmpty: episodeTotal === 0,
    generating: pd.shotVersions ? pd.shotVersions.state === "gen" : false,
    episode: ep ? { episodeId: ep.episodeId, title: ep.title } : null,
    lock: pd.lockedPlan ? { planVersion: pd.lockedPlan.plan_version } : null,
    versions: pd.shotVersions ? { count: pd.shotVersions.count, cur: pd.shotVersions.cur } : null,
    scenes,
    unassigned,
    unassignableCount: view ? view.unassignable.length : 0,
    total: draft.length,
  };
}

/** The shot's FULLY-RESOLVED creative context for prompt compilation (M10):
 *  the scene's characters/location resolved through their states, plus the
 *  outline tone (the CONFIRMED plan's launch outline, honest fallback). */
function promptInputs(pd, shotId) {
  const prod = pd.production;
  const owner = prod ? sceneOfShot(prod, shotId) : null;
  const characters = [];
  let location = null;
  if (owner) {
    for (const r of owner.scene.characterRefs || []) {
      const c = findCharacter(prod, r.characterId);
      if (c) characters.push(resolveCharacter(c, r.stateId));
    }
    const lr = owner.scene.locationRef;
    const l = lr && findLocation(prod, lr.locationId);
    if (l) location = resolveLocation(l, lr.stateId);
  }
  let tone = "";
  const story = pd.story;
  if (story) {
    const plan = story.plans.find((x) => x.v === story.confirmedPlan) || null;
    const o = outlineForPlan(story, plan);
    tone = o ? o.outline.genreTone : "";
  }
  return { characters, location, tone };
}

/**
 * The shot's REFERENCE context for prompt compilation (TASK-064 Phase 2 §21–§23).
 *
 * Resolved HERE rather than at each caller, because `shotDetailModel` is the ONE
 * prompt compiler in the studio: the Inspector, the Generation Input Set, the
 * import path and the legacy media workspaces all read its `prompts`. A second
 * reference-aware compiler beside it is exactly the drift this codebase keeps
 * paying for — two call sites disagreeing about what the effective prompt is.
 *
 * Returns `{ references, interpretation }`. A binding whose reference no longer
 * exists is dropped (never rendered as a phantom); a bound interpretation
 * reference with no reading is KEPT with `read: false`, so the compiler can
 * report it as a gap instead of silently omitting a reference the creator
 * attached on purpose.
 */
function referenceInputs(pd, shotId) {
  const prod = pd.production;
  if (!prod || !pd.assets) {
    return { references: [], interpretation: [], imageReferences: [], videoReferences: [] };
  }
  const byKey = new Map(listReferences(pd.assets).map((r) => [r.key, r]));
  const references = referencesOfShot(prod, shotId)
    .map((key) => byKey.get(key))
    .filter(Boolean)
    .map((r) => ({
      key: r.key,
      kind: r.kind,
      name: derivedLabel(r),
      version: r.version,
      assetId: r.assetId,
      domain: r.domain,
    }));
  // TASK-066 §4/§5: WHICH SIDE each binding serves. The creator's per-card choice
  // wins; with no choice the role's own side applies, which is exactly the behaviour
  // that shipped before this document existed — so an untouched project compiles
  // byte-identical prompts.
  //
  // THIS IS WHERE THE CHOICE BECOMES REAL. The menu on the card would be decoration
  // if the compilers kept reading the full list: 「用于主要画面」 has to change what
  // the Image Prompt says, or it changes nothing at all.
  const doc = pd.refUse || null;
  const imageReferences = references.filter((r) => refuse.feedsImage(doc, shotId, r.key, r.kind));
  const videoReferences = references.filter((r) => refuse.feedsVideo(doc, shotId, r.key, r.kind));
  return {
    references,
    imageReferences,
    videoReferences,
    // the readings follow their own reference to whichever side it serves
    interpretation: interpretationInputs(pd.refInterp || null, references, INTERPRETATION_KINDS),
    imageInterpretation: interpretationInputs(pd.refInterp || null, imageReferences, INTERPRETATION_KINDS),
    videoInterpretation: interpretationInputs(pd.refInterp || null, videoReferences, INTERPRETATION_KINDS),
  };
}

/**
 * The shot's START / END frame for prompt compilation and the Input Set (§7).
 *
 * The EFFECTIVE start frame is the explicit BINDING when there is one, else the
 * shot's own current image. Both are returned with `from` — where the picture came
 * from — because 「以所附图片为第 1 帧」 without naming which picture is how the
 * wrong one gets attached.
 *
 * `nameOfShot` resolves a source shot id to a human name; a shot that no longer
 * exists stays unnamed rather than being printed as a raw id.
 */
function frameInputs(pd, shotId, slot, imageCurrent, nameOfShot) {
  const b = bindingOf(pd.frameBindings || null, shotId, "startFrame");
  const eb = bindingOf(pd.frameBindings || null, shotId, "endFrame");
  const resolve = (assetId) => {
    if (!assetId || !pd.assets) return null;
    for (const domain of ["images", "videos", "audio"]) {
      const m = pd.assets[domain];
      if (!m || typeof m !== "object") continue;
      for (const key of Object.keys(m)) {
        const chain = m[key];
        if (!chain || !Array.isArray(chain.history)) continue;
        const hit = chain.history.find((r) => r && r.assetId === assetId);
        if (hit) return { assetId, url: hit.url || "", version: hit.version ?? null, storageState: hit.storageState || "local" };
      }
    }
    return null;
  };
  const bound = (binding) => {
    if (!binding) return null;
    const hit = resolve(binding.derivedImageAssetId);
    if (!hit) return null; // a binding whose asset is gone states nothing
    return {
      assetId: hit.assetId,
      url: hit.url,
      version: hit.version,
      name: `已绑定的${binding.bindingType === "endFrame" ? "尾帧" : "首帧"}`,
      from: describeBinding(binding, { shotName: typeof nameOfShot === "function" ? nameOfShot(binding.sourceShotId) : null }),
      binding,
    };
  };
  /** The EFFECTIVE pointer already written to `assets.firstFrames[slot]`.
   *
   *  THE MISSING MIDDLE LAYER (TASK-072 §1.9 缺陷 2). This used to fall straight
   *  from 「显式 binding」 to 「本镜头当前画面」, so a first frame that really had
   *  been recorded — by the paid image route, or by the creator pressing 「用作视频
   *  首帧」 before `frameBindings` existed — was displayed as the shot's current
   *  picture while GENERATION read `firstFrames[slot]`. The clipboard said one
   *  thing and the generator received another.
   *
   *  `from` says exactly what is known: it is a recorded frame, with no provenance
   *  record behind it. Inventing a source would be worse than admitting there is
   *  none. */
  const recorded = () => {
    const map = pd.assets && typeof pd.assets.firstFrames === "object" ? pd.assets.firstFrames : null;
    if (!map || !slot || !Object.prototype.hasOwnProperty.call(map, slot)) return null;
    const r = map[slot];
    if (!r || typeof r !== "object" || typeof r.url !== "string" || !r.url) return null;
    return {
      assetId: r.assetId || null,
      url: r.url,
      version: Number.isInteger(r.version) ? r.version : null,
      name: "已记录的首帧",
      from: "已记录的首帧（没有来源记录）",
      binding: null,
    };
  };
  const start = bound(b) || recorded() || (imageCurrent
    ? {
      assetId: imageCurrent.assetId,
      url: imageCurrent.url,
      version: imageCurrent.version,
      name: `本镜头画面 v${imageCurrent.version}`,
      from: "本镜头画面",
      binding: null,
    }
    : null);
  return { start, end: bound(eb), slot };
}

/** Everything the detail panel needs for ONE selected shot: creative fields,
 *  its scene's bible context, its media variants (image/video), first-frame
 *  lineage, voice standing, paid-op status and per-shot generations. */
export function shotDetailModel(pd, shotId) {
  const draft = pd.draftShots || [];
  const s = draft.find((x) => x && x.shotId === shotId);
  if (!s) return null;
  const idx = buildShotSlotIndex(draft);
  const slot = slotForShotId(idx, shotId) || null;
  const variants = (map) => {
    const e = slot ? slotEntry(map, slot) : null;
    if (!e) return { list: [], current: 0 };
    return {
      current: e.current,
      list: e.history.map((r) => ({
        version: r.version,
        url: r.url,
        origin: ORIGIN_ZH[r.origin] || r.origin || "",
        current: r.version === e.current,
        assetId: r.assetId || null,
      })),
    };
  };
  const prod = pd.production;
  const owner = prod ? sceneOfShot(prod, shotId) : null;
  const ff = slot ? pd.firstFrames[slot] : null;
  const voiceE = slot ? slotEntry(pd.media.audio, `voice-${slot}`) : null;
  const voiceCur = voiceE ? voiceE.history.find((r) => r.version === voiceE.current) : null;
  const lockedShots = pd.lockedPlan && pd.lockedPlan.shots;
  const bridge = buildServerBridge(lockedShots);
  const { id: sid, unresolved: opUnresolved } = serverShotIdForShot(bridge, lockedShots, s);
  const op = sid ? (pd.paidOps || {})[sid] || null : null;
  const gens = (pd.generations || [])
    .filter((g) => g && g.targetId === shotId)
    .map((g) => ({
      generationId: g.generationId,
      type: g.type,
      status: g.status,
      createdAt: g.createdAt,
      provider: g.provider,
      // WHICH MODEL made it (TASK-079 §1.1). Already on every Generation record
      // and never surfaced — 「这一集各用了哪个模型」 was unanswerable from any
      // screen even though the answer was in the registry all along.
      model: g.model || null,
      resultAssetIds: Array.isArray(g.resultAssetIds) ? g.resultAssetIds : [],
      // the failure's own reason, when the record carries one
      error: typeof g.error === "string" ? g.error : null,
      // the EXACT prompt this attempt was launched with (TASK-079 §1.3), so a
      // failure can be reopened as the thing it actually was rather than as
      // whatever the shot compiles to now
      promptSnapshot: typeof g.promptSnapshot === "string" ? g.promptSnapshot : null,
      // WHICH compiled packet it ran against. The paid route derives everything
      // (model, resolution, duration, prompt) from the packet, so this number is
      // what 「参数」 actually means there — and it is the only way to see whether
      // a retry today would run the same thing (codex round 1).
      packetVersion: g.parameters && Number.isInteger(g.parameters.packet_version)
        ? g.parameters.packet_version
        : null,
    }))
    .reverse(); // registry is append-only → newest first
  const images = variants(pd.assetUploads);
  const videos = variants(pd.media.video);
  // The source image of EACH video version, from the Generation that produced
  // that version. `firstFrames[slot]` is slot-level and overwritten, so it
  // describes only the newest take — using it for every version would show an
  // older video as having come from an image that did not exist yet.
  const imageByAssetId = new Map(images.list.filter((r) => r.assetId).map((r) => [r.assetId, r]));
  const videoSources = {};
  for (const v of videos.list) {
    let src = null;
    if (v.assetId) {
      const gen = (pd.generations || []).find(
        (g) => g && Array.isArray(g.resultAssetIds) && g.resultAssetIds.includes(v.assetId),
      );
      const inputId = gen && Array.isArray(gen.inputAssetIds) ? gen.inputAssetIds[0] : null;
      const img = inputId ? imageByAssetId.get(inputId) : null;
      if (img) src = { version: img.version, origin: img.origin, url: img.url, proven: true };
    }
    videoSources[v.version] = src;
  }
  const ctxIn = promptInputs(pd, shotId);
  // TASK-064 Phase 2: the references the shot is bound to, their READINGS, and
  // the explicit start/end frame bindings. Resolved once and fed to the ONE
  // compiler, so 「参考真正进了 Prompt」 is a property of every caller.
  const refIn = referenceInputs(pd, shotId);
  const nameOfShot = (sid) => {
    const x = sid ? draft.find((y) => y && y.shotId === sid) : null;
    return x ? (x.title || `镜头 ${x.sequence}`) : null;
  };
  const frames = frameInputs(pd, shotId, slot, images.list.find((r) => r.current) || null, nameOfShot);
  return {
    // M10: compiled generation prompts + honest gaps
    // Each compiler is given the references that serve ITS side (TASK-066 §5), not
    // the whole bound list. `references`/`interpretation` are named explicitly rather
    // than spread, so a future field on `refIn` cannot silently re-widen a prompt's
    // inputs back to everything.
    prompts: {
      image: compileImagePrompt({
        shot: s,
        ...ctxIn,
        references: refIn.imageReferences,
        interpretation: refIn.imageInterpretation,
      }),
      video: compileVideoPrompt({
        shot: s,
        hasImage: images.list.some((r) => r.current),
        startFrame: frames.start,
        endFrame: frames.end,
        references: refIn.videoReferences,
        interpretation: refIn.videoInterpretation,
        // TASK-077 §1.3: the Gateway route sends one image; the manual route is
        // the creator attaching files. Only the parenthetical differs, and an
        // absent `pd.route` (tests, older callers) means the manual route.
        route: pd.route === "gateway" ? "gateway" : "manual",
        // 有序参考集合 + 每类一段用法规则（批次 4D）。规则来自 Skill 包，
        // 查找函数由 shell 注入 —— 这个读模型不知道目录是怎么装进来的。
        referenceBlock: referenceBlock({
          bindings: refIn.videoReferences,
          lookup: promptBlockLookup,
        }),
      }),
    },
    // carried so the Generation Input Set and the Inspector read the SAME
    // resolution the prompt was compiled from
    refInputs: refIn,
    frames,
    shot: {
      shotId,
      seq: s.sequence,
      title: s.title || "",
      description: s.description || "",
      action: s.action || "",
      cameraMotion: s.cameraMotion || "",
      dialogue: s.dialogue || "",
      duration: s.duration_seconds === 10 ? 10 : 6,
      // Directing facets the storyboard shows as compact metadata. They are
      // additive draft-shot fields (like action/cameraMotion before them) and
      // are honestly blank when the draft never carried them.
      shotSize: s.shotSize || "",
      angle: s.angle || "",
      emotion: s.emotion || "",
      // 光影氛围 (TASK-078 §2.1) — new, additive, no migration. It is compiled
      // into 【镜头规格】 alongside 景别/角度/情绪, so filling it changes the prompt
      // rather than only the display.
      lighting: s.lighting || "",
    },
    scene: owner
      ? { sceneId: owner.scene.sceneId, title: owner.scene.title, ...sceneRefsView(prod, owner.scene) }
      : null,
    slot,
    images,
    videos,
    videoSources,
    firstFrame: ff ? { version: ff.version, origin: ORIGIN_ZH[ff.origin] || ff.origin || "", url: ff.url } : null,
    voice: voiceCur
      ? { url: voiceCur.url, versions: voiceE.history.length, origin: ORIGIN_ZH[voiceCur.origin] || voiceCur.origin || "" }
      : null,
    opStatus: op ? op.status : null,
    opUnresolved,
    generations: gens,
  };
}

/** The shot a shot-centric workspace should open on when nothing is selected
 *  yet (or the previous selection left the draft): the active episode's first
 *  resolvable shot, else the first unassigned one, else null. Keeps the centre
 *  column showing real production context instead of a blank panel. */
export function defaultShotId(pd) {
  const m = storyboardModel(pd);
  if (m.episodeShotIds.length) return m.episodeShotIds[0];
  // A project whose shots are all still unassigned has REAL inventory and no
  // episode owning any of it. Returning null here left the shot workspaces with
  // nothing selected and no way to reach that inventory at all, which is the
  // blank centre column this function exists to avoid. An unassigned shot is
  // never credited to the episode — it is only made reachable.
  const free = m.unassigned.find((s) => s.shotId && !s.dangling);
  return free ? free.shotId : null;
}

/** Is `shotId` owned by the ACTIVE episode? Selection must be validated
 *  against this, not against the project-wide draft: a shot from the previous
 *  episode still exists in the draft, so a draft-wide check would leave it
 *  selected after an episode switch and show its media under the new one. */
export function isEpisodeShot(pd, shotId) {
  return !!shotId && storyboardModel(pd).episodeShotIds.includes(shotId);
}

/** Can the shell KEEP this selection?
 *
 *  Broader than `isEpisodeShot` on purpose: the shot list also renders the
 *  UNASSIGNED pool as selectable cards, and those shots belong to no episode at
 *  all, so validating selection against episode ownership alone snapped the
 *  selection back the instant one was clicked — their detail and media were
 *  unreachable. A shot owned by ANOTHER episode is still rejected, which is the
 *  case the episode-scoped check exists for. */
export function isSelectableShot(pd, shotId) {
  if (!shotId) return false;
  const m = storyboardModel(pd);
  return m.episodeShotIds.includes(shotId) || m.unassigned.some((s) => s.shotId === shotId);
}

/** Portrait lookup: a bible entity's ACTIVE reference image url, or "" when it
 *  has none. Reference-only — resolves ids against the M3 registry, never
 *  copies or invents an image. */
export function buildPortraitIndex(pd) {
  const byAsset = new Map();
  for (const slot of Object.keys(pd.assetUploads || {})) {
    const e = slotEntry(pd.assetUploads, slot);
    if (!e) continue;
    for (const r of e.history) if (r && r.assetId) byAsset.set(r.assetId, r.url || "");
  }
  const out = new Map();
  const prod = pd.production;
  const add = (id, activeId, list) => {
    const pick = activeId && byAsset.has(activeId) ? activeId : (list || []).find((a) => byAsset.has(a));
    out.set(id, pick ? byAsset.get(pick) : "");
  };
  for (const c of (prod && prod.characters) || []) add(c.characterId, c.activeReferenceAssetId, c.referenceAssetIds);
  for (const l of (prod && prod.locations) || []) add(l.locationId, l.activeReferenceAssetId, l.referenceAssetIds);
  return (kind, id) => out.get(id) || "";
}

/** The table view's model, with THIS module's compiler and portrait lookup
 *  injected — so the table's 「提示词 · 缺 N」 column reports gaps for the exact
 *  prompt the generation entry would send, and 「有参考图」 means what the bible
 *  cards mean by it. */
export function tableModel(pd, ui = {}, recycled = []) {
  return shotTableModel(pd, {
    buffer: ui.tbuf || {},
    deleted: ui.tdel || [],
    // 回收区从 `pd` 拿不到（镜像只给存活的），由 shell 注入
    recycled,
    // `shots` is the draft WITH the unsaved buffer applied (codex round 1, P2).
    // Compiling against `pd.draftShots` meant the 提示词 column reported the gap
    // count of the text the creator had just replaced — 「运镜为空」 next to a 运镜
    // they were looking at. Everything else about the read model is untouched:
    // media, references, frames and provenance still come from `pd`.
    detailOf: (shotId, shots) => shotDetailModel({ ...pd, draftShots: shots }, shotId),
    portraitFor: buildPortraitIndex(pd),
  });
}

/// ---------- render --------------------------------------------------------- //

/** Selected-shot detail: the media-first surface. A large hero of the shot's
 *  CURRENT frame, compact directing metadata beneath it, the variant gallery
 *  with visible provenance, and the scene's character/location references as
 *  pictures. The editable form lives behind an explicit 编辑 toggle so the
 *  default view reads as a shot, not a database row. */
function detailHtml(ctx, d, ui) {
  const buf = ui.buffer || {};
  const val = (key, committed) => (key in buf ? buf[key] : committed);
  const tab = ui.variantTab || "image";

  const curImg = d.images.list.find((r) => r.current);
  const curVid = d.videos.list.find((r) => r.current);
  const showVideo = tab === "video" && curVid;
  const op = d.opStatus
    ? d.opStatus === "committed" ? `<span class="chip ok">✓ 已付费</span>` : `<span class="chip gen">⏳ ${esc(d.opStatus)}</span>`
    : d.opUnresolved ? `<span class="chip gate">付费状态未解析</span>` : "";

  const hero = renderHero({
    url: showVideo ? curVid.url : curImg ? curImg.url : "",
    kind: showVideo ? "video" : "image",
    // a video is only ever shown over its RECORDED first frame
    poster: videoSourceFrame(d, curVideoVersion(d)),
    title: `${nn(d.shot.seq)} ${d.shot.title}`,
    badges: [
      `<span class="chip solid">${esc(nn(d.shot.seq))}</span>`,
      d.shot.shotSize ? `<span class="chip">${esc(d.shot.shotSize)}</span>` : "",
      `<span class="chip">${d.shot.duration}s</span>`,
    ].filter(Boolean),
    right: [
      showVideo
        ? `<span class="chip ok">Video v${curVid.version}</span>`
        : curImg ? `<span class="chip ok">Image v${curImg.version}</span>` : "",
      op,
    ].filter(Boolean),
    missing: "这个镜头还没有画面 — 用右侧 AI 导演生成或导入",
  });

  // variant gallery — a video card shows the shot's own current image as its
  // frame (that IS the recorded first frame), never a fabricated still
  const counts = { image: d.images.list.length, video: d.videos.list.length, audio: d.voice ? d.voice.versions : 0 };
  let panel;
  if (tab === "image") {
    panel = renderVariantGrid("image", d.slot, d.images, null) +
      (curImg ? `<div class="row"><button class="btn sm" data-useff="${esc(d.slot || "")}">🎬 用作视频首帧</button></div>` : "");
  } else if (tab === "video") {
    panel = renderVariantGrid("video", d.slot, d.videos, (r) => videoSourceFrame(d, r.version));
  } else if (tab === "audio") {
    panel = d.voice
      ? `<div class="row"><span class="chip ok">🎤 配音就绪 · ${d.voice.versions} 版 · ${esc(d.voice.origin)}</span>` +
        `<button class="btn sm" data-goto="audio">在「音频」编辑 →</button></div>` +
        `<audio class="aaud" src="${esc(d.voice.url)}" controls preload="none"></audio>`
      : `<div class="meta">还没有配音 — 到「音频」工作区用本地 TTS 生成，或导入。</div>` +
        `<div class="row"><button class="btn sm" data-goto="audio">→ 去音频工作区</button></div>`;
  } else {
    panel = d.generations.length
      ? `<div class="stack" style="gap:var(--s1)">` + d.generations.slice(0, 8)
          .map((g) => `<div class="dir-hrow"><span class="l">${esc(g.type)} · ${esc(g.provider || "—")}</span>` +
            `<span class="chip${g.status === "success" ? " ok" : g.status === "failed" ? " bad" : " gen"}">${esc(g.status)}</span>` +
            `<span class="t">${g.createdAt ? esc(g.createdAt.slice(0, 16).replace("T", " ")) : ""}</span></div>`)
          .join("") + `</div>`
      : `<div class="meta">这个镜头还没有生成记录。</div>`;
  }

  // DIRECTLY EDITABLE (产品 2026-08-13: 「这些分镜生成也要可以修改编辑的」).
  //
  // No 「✎ 编辑镜头」 mode: the fields are the fields, click and type. Typing goes into
  // the transient buffer; 「保存为新草稿版本」 is what commits, because a shot draft is
  // a versioned document exactly like the Prompt and the Episode Plan — an edit must
  // not silently rewrite the version the generations already point at.
  const editor =
      `<div class="card pad"><div class="st-sec"><h3>镜头内容</h3><div class="acts">` +
      // updated IN PLACE while typing (see bindShotDetail): a re-render per keystroke
      // would move the caret out of the field being typed in, but a stale bar would
      // tell the creator their edit was not registered and 保存 unavailable
      `<span class="chip gate" data-shot-flag${ui.dirty ? "" : " hidden"}>已修改（未保存为版本）</span>` +
      `<span class="chip mute" data-shot-clean${ui.dirty ? " hidden" : ""}>与草稿版本一致</span>` +
      `<button class="btn primary sm" data-shot-save${ui.dirty ? "" : " disabled"}>保存为新草稿版本</button>` +
      `<button class="btn sm" data-shot-editoff${ui.dirty ? "" : " hidden"}>放弃修改</button>` +
      `</div></div>` +
      `<div class="editgrid">` +
      `<div class="kv full"><label class="lab">镜头名</label><input class="field" data-sf="title" maxlength="80" value="${esc(val("title", d.shot.title))}"></div>` +
      `<div class="kv full"><label class="lab">画面内容</label><textarea class="field" rows="3" spellcheck="false" data-sf="description">${esc(val("description", d.shot.description))}</textarea></div>` +
      `<div class="kv"><label class="lab">动作</label><textarea class="field" rows="2" spellcheck="false" data-sf="action" placeholder="例如：她抬手碰了一下纱布，随即放下">${esc(val("action", d.shot.action))}</textarea></div>` +
      `<div class="kv"><label class="lab">运镜</label><textarea class="field" rows="2" spellcheck="false" data-sf="cameraMotion" placeholder="例如：低角度缓慢推近至面部特写">${esc(val("cameraMotion", d.shot.cameraMotion))}</textarea></div>` +
      // 景别 / 角度 / 情绪 / 光影氛围 — THE INPUTS THAT WERE MISSING (TASK-078 §2.1).
      // All four were already displayed in four read-only places and compiled into
      // the Image Prompt, and NONE of them had anywhere to be typed. That is the
      // whole reason the real project reads 「未记录」 on every shot: not a model
      // failure, a form with no field.
      `<div class="kv"><label class="lab">景别</label><input class="field" maxlength="200" data-sf="shotSize" placeholder="例如：中近景 / 特写 / 全景" value="${esc(val("shotSize", d.shot.shotSize))}"></div>` +
      `<div class="kv"><label class="lab">机位角度</label><input class="field" maxlength="200" data-sf="angle" placeholder="例如：低角度仰拍 / 俯视 / 过肩" value="${esc(val("angle", d.shot.angle))}"></div>` +
      `<div class="kv"><label class="lab">情绪</label><input class="field" maxlength="200" data-sf="emotion" placeholder="例如：压抑、克制的紧张" value="${esc(val("emotion", d.shot.emotion))}"></div>` +
      `<div class="kv"><label class="lab">光影氛围</label><input class="field" maxlength="200" data-sf="lighting" placeholder="例如：冷白顶光，屏幕反光打在脸侧" value="${esc(val("lighting", d.shot.lighting))}"></div>` +
      `<div class="kv"><label class="lab">台词 / 旁白</label><textarea class="field" rows="2" spellcheck="false" data-sf="dialogue" placeholder="例如：「你到底是谁？」">${esc(val("dialogue", d.shot.dialogue))}</textarea></div>` +
      `<div class="kv"><label class="lab">时长</label><select class="field" data-sf="duration">${(() => {
        const dur = "duration" in buf ? +buf.duration : d.shot.duration;
        return `<option value="6"${dur === 10 ? "" : " selected"}>6s</option><option value="10"${dur === 10 ? " selected" : ""}>10s</option>`;
      })()}</select></div>` +
      `</div></div>`;

  return (
    `<div class="stack">` +
    hero +
    renderLineage(d) +
    editor +
    renderShotMeta(d.shot) +
    `<div class="variants">${renderVariantTabs(tab, counts)}` +
    (d.slot ? panel : `<div class="meta">镜头身份未解析 — 无法定位媒体槽位。</div>`) +
    `</div></div>`
  );
}

/** The whole Storyboard workspace. `ui` is the shell's transient state:
 *  { selectedShotId, variantTab } — selection only, nothing
 *  persisted. */
export function renderStoryboard(ctx, ui) {
  const pd = ctx.prodData();
  const m = storyboardModel(pd);
  if (m.generating) {
    return (
      head("分镜", "生成中") +
      `<div class="st-empty"><div class="ic">⏳</div><div class="tt">Claude 正在生成分镜草稿…</div>` +
      `<div class="hh">通常 20–60 秒，完成后自动出现在这里</div>` +
      `<div class="st-skel" style="width:100%;max-width:520px"><i></i><i></i><i></i><i></i><i></i></div></div>`
    );
  }
  if (!m.hasDraft) {
    const hasScript = ctx.script.hasContent();
    return (
      head("分镜", "还没有分镜") +
      empty(
        "🎬",
        "从剧本生成分镜，开始逐镜头制作",
        hasScript
          ? "剧本已就绪 — 一键让 AI 拆分镜头。草稿可手工改、可重生成，全部版本保留。"
          : "前置：剧本 — 先到「剧本」工作区写下本集内容或用 AI 生成 v1。",
        hasScript
          ? `<button class="btn primary" data-sb-generate>🎬 基于剧本生成分镜</button>`
          : `<button class="btn" data-goto="script">→ 去剧本工作区</button>`,
      )
    );
  }
  // This EPISODE owns no shots AND there is no unassigned inventory either:
  // there is genuinely nothing to list, so say so and point at the fix.
  //
  // When a pool DOES exist the board renders normally instead — those shots are
  // real work, they are already selectable in the list, and hiding them behind
  // an empty state made a project whose shots are all unassigned impossible to
  // inspect from any shot workspace. The header still states plainly that this
  // episode owns none of them.
  if (m.episodeEmpty && !m.unassigned.length) {
    return (
      head(m.episode ? m.episode.title : "分镜", `本集还没有镜头 · 项目草稿共 ${m.total} 个镜头`) +
      empty(
        "🎬",
        "本集还没有镜头",
        "分镜草稿是项目级的，场景与镜头归属是按集的。先在「剧集」为本集建立场景并归入镜头，或基于本集剧本重新生成分镜。",
        `<div class="row"><button class="btn primary" data-goto="episodes">→ 去剧集建立场景</button>` +
          `<button class="btn" data-goto="script">→ 去本集剧本</button></div>`,
      )
    );
  }
  const selected = ui.selectedShotId;
  const portraitFor = buildPortraitIndex(pd);
  // the scene the selection belongs to drives the strip's highlight
  const selScene = m.scenes.find((sc) => sc.shots.some((s) => s.shotId === selected));
  const d = selected ? shotDetailModel(pd, selected) : null;
  const meta = [
    m.versions && m.versions.count ? `草稿 v${m.versions.cur}/${m.versions.count}` : "",
    m.lock ? `🔒 已锁定 plan v${m.lock.planVersion}` : "未锁定",
    `本集 ${m.episodeTotal} 个镜头${m.episodeTotal === m.total ? "" : `（项目共 ${m.total}）`}`,
    // the episode owns nothing yet, but the pool below is real inventory — say
    // which is which rather than letting the list imply these are this episode's
    m.episodeEmpty ? `本集尚未归入任何镜头 · 下方 ${m.unassigned.length} 个未归组` : "",
    m.unassignableCount ? `⚠ ${m.unassignableCount} 个 legacy 镜头无稳定身份` : "",
  ].filter(Boolean).join(" · ");

  const centre = d
    ? detailHtml(ctx, d, ui)
    : empty("🎞", "选一个镜头", "左侧点击任意镜头，这里会显示它的画面、变体与可直接修改的镜头信息。");

  // TASK-077 §1.4 — 批量准备资产 BACK ON THE MAIN PATH.
  //
  // `ui/wizard.js` has implemented the whole 确认镜头 → 准备资产 → 合成提示词 →
  // 批量生视频 pipeline since M-era, and its ONLY caller was `workflow/nodes/
  // assets.js` — a node on the canvas that ADR-0061 demoted to the `?canvas=1`
  // diagnostic view. The cockpit for every batch operation therefore existed and
  // was unreachable from any creative path. This is the wire back; the node call
  // site is deliberately left alone (this card removes dead ends, not abilities).
  //
  // Placed on ⑦ 分镜设计 because that is where a settled shot list lives, which is
  // the wizard's own step ①. Offered whenever there IS a shot list — a locked plan
  // makes it the obvious next action rather than the only time it is legal.
  const wizardBtn = m.episodeTotal || m.total
    ? `<button class="btn sm${m.lock ? " primary" : ""}" data-wz-open ` +
      `title="确认镜头 → 准备资产 → 合成提示词 → 批量生视频">→ 准备资产</button>`
    : "";
  // 卡片 ⇄ 表格 — BOTH, not one replacing the other (TASK-078 §2.2). The card
  // view is how you look at ONE shot; the table is how you compare sixty. A
  // storyboard needs both and the creator picks per task.
  const viewToggle =
    `<div class="segbtn">` +
    `<button class="btn sm${ui.tableView ? "" : " primary"}" data-sb-view="cards">卡片</button>` +
    `<button class="btn sm${ui.tableView ? " primary" : ""}" data-sb-view="table">表格</button>` +
    `</div>`;
  const header = head(
    m.episode ? m.episode.title : "分镜",
    meta,
    (m.episodeEmpty ? `<button class="btn sm" data-goto="episodes">→ 去剧集归入镜头</button>` : "") +
      viewToggle +
      wizardBtn +
      `<button class="btn sm" data-sb-generate>↻ 重新生成（新版本）</button>`,
  );
  if (ui.tableView) {
    const recycled = ctx.shots && typeof ctx.shots.recycled === "function" ? ctx.shots.recycled() : [];
    return header + renderShotTable(ctx, tableModel(pd, ui, recycled), ui);
  }
  return (
    header +
    renderSceneStrip(m.scenes, selScene ? selScene.sceneId : null) +
    `<div class="wsplit">` +
    `<div class="listcol">${renderShotList(m.scenes, m.unassigned, selected)}</div>` +
    `<div class="maincol">${centre}</div>` +
    `<div class="refcol">${d ? renderRefCards(d.scene, portraitFor) : ""}</div>` +
    `</div>`
  );
}

/** Wire the storyboard. Field edits buffer locally (no re-render while
 *  typing); ONLY 「保存为新草稿版本」 commits — through ctx.shots.saveEdit,
 *  which appends an immutable draft version.
 *
 *  The generation entry (prompt → provider → import) now lives in the AI
 *  Director and is wired by ui/genentry.js; the shot-level wiring below is
 *  unchanged from before that move. */
export function bindStoryboard(root, ctx, ui, rerender) {
  const gen = root.querySelector("[data-sb-generate]");
  if (gen)
    gen.onclick = () => {
      if (!ctx.script.hasContent()) { ctx.toast("剧本为空：先在「剧本」工作区生成/输入剧本"); return; }
      // regeneration replaces the draft: unsaved edits would strand against
      // shots that no longer exist — same confirm-discard gate as switching
      const pending = ui.dirty || tableDirty(ctx.prodData().draftShots || [], {
        buffer: ui.tbuf || {}, deleted: ui.tdel || [],
      });
      if (pending && !window.confirm("镜头详情有未保存的修改，重新生成将丢弃？")) return;
      ui.dirty = false;
      ui.buffer = {};
      // …and the TABLE's buffer too. A regenerated draft mints fresh shot ids, so
      // every buffered row would key against a shot that no longer exists — kept,
      // it is invisible edits that can never be saved and never be found.
      ui.tbuf = {};
      ui.tdel = [];
      ui.tableEdit = null;
      ui.tableDirty = false;
      ui.selectedShotId = null; // the regenerated draft mints fresh shot ids
      if (!ctx.shots.generateDraft()) ctx.toast("已有一个生成在进行中");
    };
  // TASK-077 §1.4 — the batch pipeline's entrance. `ctx.wizard` is wired in
  // app.js; a context without one (tests, embedded uses) says so rather than
  // rendering a button that silently does nothing.
  const wz = root.querySelector("[data-wz-open]");
  if (wz)
    wz.onclick = () => {
      if (!ctx.wizard) { ctx.toast("批量准备资产在这个上下文里不可用"); return; }
      // No node: the wizard's `node` is only the canvas node it used to mark
      // done, and it already guards on it (`if (node)`). Opened from here the
      // pipeline is the same, it just has no node to tick off.
      ctx.wizard.open(null);
    };
  // 卡片 ⇄ 表格.
  //
  // AT MOST ONE DIRTY BUFFER, EVER (codex round 3, P1). The two views edit the
  // SAME draft-shot fields through two separate buffers, and carrying both
  // across a switch made this possible: edit 景别 on the card, switch, edit 景别
  // in the table, save the table — then go back and change only the 镜头名. The
  // card's save writes EVERY key still in its stale buffer, so the 景别 that was
  // just committed is silently reverted by an edit the creator made to something
  // else entirely. A change nobody asked for and nobody saw.
  //
  // So leaving a dirty view DISCARDS its buffer, behind the same confirm this
  // file already uses for switching shots and for regenerating — one gate, one
  // wording, and afterwards only one view can be holding unsaved work.
  root.querySelectorAll("[data-sb-view]").forEach((el) => (el.onclick = () => {
    const toTable = el.dataset.sbView === "table";
    if (toTable === !!ui.tableView) return; // already there — nothing to discard
    const leavingDirty = toTable
      ? ui.dirty
      : tableDirty(ctx.prodData().draftShots || [], { buffer: ui.tbuf || {}, deleted: ui.tdel || [] });
    if (leavingDirty && !window.confirm("当前视图有未保存的修改，切换将丢弃？")) return;
    if (toTable) {
      ui.dirty = false;
      ui.buffer = {};
    } else {
      ui.tbuf = {};
      ui.tdel = [];
      ui.tableEdit = null;
    }
    ui.tableView = toTable;
    rerender();
  }));
  if (ui.tableView) {
    const recycled = ctx.shots && typeof ctx.shots.recycled === "function" ? ctx.shots.recycled() : [];
    bindShotTable(root, ctx, ui, rerender, tableModel(ctx.prodData(), ui, recycled));
    return;
  }
  bindShotSelection(root, ctx, ui, rerender);
  bindShotEditor(root, ctx, ui, rerender);
  bindShotMedia(root, ctx, ui);
}

/** Shot selection — shared by 分镜 / 画面 / 视频 (all three are shot-centric).
 *  Clicking a scene card selects that scene's FIRST shot, which is what makes
 *  the scene strip a navigation control rather than decoration. */
export function bindShotSelection(root, ctx, ui, rerender) {
  const pick = (shotId) => {
    if (!shotId || shotId === ui.selectedShotId) return;
    if (ui.dirty && !window.confirm("镜头详情有未保存的修改，切换将丢弃？")) return;
    ui.dirty = false;
    ui.buffer = {};
    ui.selectedShotId = shotId;
    rerender();
  };
  root.querySelectorAll("[data-shot]").forEach((el) => (el.onclick = () => pick(el.dataset.shot)));
  root.querySelectorAll("[data-scene]").forEach((el) => (el.onclick = () => {
    const m = storyboardModel(ctx.prodData());
    const sc = m.scenes.find((x) => x.sceneId === el.dataset.scene);
    const first = sc && sc.shots.find((s) => s.shotId && !s.dangling);
    if (first) pick(first.shotId);
  }));
  root.querySelectorAll("[data-vtab]").forEach((el) => (el.onclick = () => {
    ui.variantTab = el.dataset.vtab;
    rerender();
  }));
}

/** The buffered shot-detail editor: edits stay local until 保存, which appends
 *  ONE new immutable draft version. */
export function bindShotEditor(root, ctx, ui, rerender) {
  const on = (sel, fn) => {
    const el = root.querySelector(sel);
    if (el) el.onclick = fn;
  };
  // 放弃修改 — the fields are always editable now, so there is no mode to leave;
  // this drops the unsaved buffer and puts the saved draft version back on screen.
  on("[data-shot-editoff]", () => { ui.dirty = false; ui.buffer = {}; rerender(); });
  // the buffer lives on the SHELL's ui state (not this binding closure), so a
  // re-render — media variant switch, generation completion — re-renders the
  // buffered values instead of discarding unsaved edits
  const buffer = ui.buffer || (ui.buffer = {});
  // reflect the dirty state on the bar WITHOUT a re-render, so the caret stays where
  // the creator is typing while 「已修改」 and the enabled 保存 appear immediately
  const flag = root.querySelector("[data-shot-flag]");
  const clean = root.querySelector("[data-shot-clean]");
  const save = root.querySelector("[data-shot-save]");
  const discard = root.querySelector("[data-shot-editoff]");
  const syncBar = () => {
    if (flag) flag.hidden = !ui.dirty;
    if (clean) clean.hidden = !!ui.dirty;
    if (discard) discard.hidden = !ui.dirty;
    if (save) { if (ui.dirty) save.removeAttribute("disabled"); else save.setAttribute("disabled", ""); }
  };
  root.querySelectorAll("[data-sf]").forEach((el) => {
    el.oninput = () => { buffer[el.dataset.sf] = el.value; ui.dirty = true; syncBar(); };
    if (el.tagName === "SELECT") el.onchange = () => { buffer[el.dataset.sf] = el.value; ui.dirty = true; syncBar(); };
  });
  on("[data-shot-save]", () => {
    const draft = ctx.prodData().draftShots || [];
    const before = draft.find((s) => s && s.shotId === ui.selectedShotId);
    const items = draft.map((s) => {
      if (!s || s.shotId !== ui.selectedShotId) return { ...s };
      const n = { ...s };
      for (const k of DETAIL_FIELDS) {
        if (k in buffer) n[k] = buffer[k];
      }
      if ("duration" in buffer) n.duration_seconds = +buffer.duration;
      return n;
    });
    if (!items.length || !before) return;
    // no effective change → no version churn (an identical draft version would
    // only pollute the history)
    const after = items.find((s) => s.shotId === ui.selectedShotId);
    const changed = DETAIL_FIELDS
      .some((k) => (after[k] || "") !== (before[k] || ""))
      || after.duration_seconds !== before.duration_seconds;
    if (!changed) { ctx.toast("没有修改 — 未创建新版本"); return; }
    if (items.some((s) => !(s.title || "").trim())) { ctx.toast("镜头名不能为空"); return; }
    if (ctx.shots.saveEdit(items)) {
      ui.dirty = false;
      ui.buffer = {};
      ctx.toast("已保存为新草稿版本（旧版本保留，可在工作流节点回切）");
      rerender();
    } else {
      ctx.toast("没有可保存的草稿版本");
    }
  });
}

/** Variant switching + the first-frame flow — shared by all shot workspaces. */
export function bindShotMedia(root, ctx, ui) {
  root.querySelectorAll("[data-setcur]").forEach((b) => {
    b.onclick = () => ctx.media.setCurrent(b.dataset.setcur, b.dataset.slot, +b.dataset.v);
  });
  const ff = root.querySelector("[data-useff]");
  if (ff) ff.onclick = () => { if (ff.dataset.useff) ctx.media.useAsFirstFrame(ff.dataset.useff); };
}

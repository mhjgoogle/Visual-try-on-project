// AUTOMATIC ROUGH CUT (ADR-0061 决策 6 / TASK-064 Phase 3 §41–§43).
//
//   Automation First + Human Fine-tuning
//
// 「用户打开控制台时不要看到空 Timeline」. An edit console that opens empty and
// asks the creator to place forty clips they already own is not a tool, it is a
// form. So the system assembles a working first version out of what the project
// really has — canonical shot order, each shot's ACTIVE video take, its dialogue,
// its scene's ambience, its sfx/foley, the episode's BGM — and the human tunes it.
//
// THE THREE RULES THIS MODULE EXISTS TO ENFORCE:
//
//  1. IT INVENTS NOTHING. A shot with no video contributes no clip. A scene with
//     no ambience gets no ambience. Every clip points at an asset that exists,
//     and `skipped` reports each hole with the reason, so 「为什么 SH04 不在里面」
//     always has an answer.
//
//  2. IT NEVER OVERWRITES HUMAN WORK (§50). A LOCKED clip, and a clip the creator
//     placed or edited by hand, survive a re-run untouched. That is what makes
//     「AI Draft → Human Tune → Lock → AI Continue」 a working mode rather than a
//     slogan: the fourth step cannot undo the second.
//
//  3. IT PINS VERSIONS (§48). Every clip records WHICH version it took, so a
//     later change to the shot's active take shows up as drift the creator
//     resolves — never as a silent substitution in a cut they already approved.
//
// Pure planning + timeline transitions — no fetch, no DOM, no clock (the caller
// passes `at`), no rendering. It composes `workflow/timeline.js` operations
// rather than writing clips itself, so every guard that module enforces applies.

import { TRACKS, clipsOf, relayout, addClip } from "./timeline.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const strOrNull = (x) => (typeof x === "string" && x ? x : null);

/** The tracks the rough cut fills, in the order it reasons about them. Video
 *  first: everything else is placed against the picture. */
export const ROUGH_TRACKS = ["video", "dialogue", "vo", "ambience", "sfx", "foley", "bgm"];

/** Default gains for the automatic pass, in the linear volume the timeline
 *  stores. STATED AS NUMBERS rather than as 「ducked under dialogue」, because a
 *  promise cannot be checked and 0.35 can. The creator changes any of them and
 *  the change survives a re-run (an edited clip is a manual clip).
 *
 *  Dialogue is 1.0 — it is the reference level everything else sits against. */
export const AUTO_GAIN = {
  video: 1,        // the picture's own audio is dropped by the renderer
  dialogue: 1,
  vo: 0.95,
  ambience: 0.35,
  sfx: 0.8,
  foley: 0.7,
  bgm: 0.28,       // under dialogue by design; 0.45 when the episode has none
};

export const AUTO_FADE = {
  ambience: { fadeIn: 0.4, fadeOut: 0.6 },
  bgm: { fadeIn: 0.8, fadeOut: 1.2 },
};

/** A clip AUTOMATION may replace: one it placed itself, that nobody has locked
 *  and nobody has edited. Anything else is the creator's and is left alone.
 *
 *  `origin` is stored on the clip by this module; a clip from before this
 *  checkpoint carries none and is therefore treated as MANUAL — the safe
 *  direction, because mistaking a hand placement for an automatic one deletes
 *  work, while the reverse only leaves a clip in place. */
export function isAutoClip(clip, isLocked) {
  if (!isObj(clip)) return false;
  if (typeof isLocked === "function" && isLocked(clip.clipId) === true) return false;
  // A REMOVED clip carries a human decision — 「这一镜不要了」 — even though the
  // arranger placed it. Treating it as ordinary auto work let a rebuild discard
  // it and re-add the same shot from the plan, silently putting back a shot the
  // creator had taken out of the cut.
  if (clip.removed === true) return false;
  return clip.origin === "auto";
}

/**
 * Plan the rough cut. PURE — it decides, it does not write.
 *
 * `rows` are the episode's shots IN CANONICAL ORDER (proddoc.episodeView order),
 * each already resolved by the caller:
 *
 *   { shotId, duration,
 *     video:    { assetId, version } | null,
 *     dialogue: { assetId, version } | null,
 *     vo / sfx / foley: same,
 *     ambience: { assetId, version } | null   (the SCENE's, repeated per shot)
 *     bgm:      { assetId, version } | null   (the EPISODE's / scene's) }
 *
 * Returns `{ clips, skipped, duration }` where `clips` are timeline clips ready
 * to be placed and `skipped` explains every row and track that produced none.
 */
export function planRoughCut(rows, { hasDialogueAnywhere = null } = {}) {
  const clips = [];
  const skipped = [];
  let cursor = 0;
  const list = Array.isArray(rows) ? rows.filter(isObj) : [];
  // Is there dialogue ANYWHERE in this episode? It decides the BGM level, and it
  // has to be answered over the whole episode rather than per shot: music that
  // ducks and un-ducks around every line of an episode is not scoring, it is a
  // fault. The caller may pass the answer; otherwise it is derived from the rows.
  const ducked = typeof hasDialogueAnywhere === "boolean"
    ? hasDialogueAnywhere
    : list.some((r) => r.dialogue && r.dialogue.assetId);
  const bgmGain = ducked ? AUTO_GAIN.bgm : 0.45;

  // contiguous spans of the SAME ambience / bgm asset become ONE clip: a bed is
  // one recording playing under several shots, and one clip per shot would
  // re-trigger its fade at every cut
  let amb = null;
  let bgm = null;
  const flushBed = (span, trackType) => {
    if (!span) return;
    clips.push({
      trackType,
      assetId: span.assetId,
      assetVersion: span.version,
      shotId: null, // a bed belongs to the scene / episode, not to one shot
      startTime: span.start,
      trimIn: 0,
      trimOut: Math.max(0.2, span.end - span.start),
      volume: trackType === "bgm" ? bgmGain : AUTO_GAIN.ambience,
      muted: false,
      ...(AUTO_FADE[trackType] || {}),
      origin: "auto",
    });
  };

  for (const r of list) {
    const shotId = strOrNull(r.shotId);
    const dur = Number.isFinite(r.duration) && r.duration > 0 ? r.duration : 6;
    if (!r.video || !r.video.assetId) {
      // NO FOOTAGE → NO TIME SLOT. The video track is gapless (the render
      // concatenates), so reserving time for a missing shot would shift every
      // later sound against a picture that is not there.
      skipped.push({ shotId, trackType: "video", reason: "这个镜头还没有视频（不占时间线位置）" });
      continue;
    }
    clips.push({
      trackType: "video",
      assetId: r.video.assetId,
      assetVersion: Number.isInteger(r.video.version) ? r.video.version : null,
      shotId,
      startTime: cursor,
      trimIn: 0,
      trimOut: dur,
      volume: 1,
      muted: false,
      fadeIn: 0,
      fadeOut: 0,
      transition: "cut",
      transitionMs: 0,
      origin: "auto",
    });
    for (const track of ["dialogue", "vo", "sfx", "foley"]) {
      const a = r[track];
      if (!a || !a.assetId) {
        // 「这个镜头没有对白」 is only worth reporting where a line exists but the
        // take does not — otherwise every silent shot would file a complaint
        if (track === "dialogue" && strOrNull(r.dialogueText)) {
          skipped.push({ shotId, trackType: track, reason: "有台词但还没有配音 take" });
        }
        continue;
      }
      clips.push({
        trackType: track,
        assetId: a.assetId,
        assetVersion: Number.isInteger(a.version) ? a.version : null,
        shotId,
        startTime: cursor,
        trimIn: 0,
        trimOut: dur,
        volume: AUTO_GAIN[track],
        muted: false,
        fadeIn: 0,
        fadeOut: 0,
        origin: "auto",
      });
    }
    const a = r.ambience && r.ambience.assetId ? r.ambience : null;
    if (a) {
      if (amb && amb.assetId === a.assetId && amb.end === cursor) amb.end = cursor + dur;
      else { flushBed(amb, "ambience"); amb = { assetId: a.assetId, version: a.version ?? null, start: cursor, end: cursor + dur }; }
    } else { flushBed(amb, "ambience"); amb = null; }
    const b = r.bgm && r.bgm.assetId ? r.bgm : null;
    if (b) {
      if (bgm && bgm.assetId === b.assetId && bgm.end === cursor) bgm.end = cursor + dur;
      else { flushBed(bgm, "bgm"); bgm = { assetId: b.assetId, version: b.version ?? null, start: cursor, end: cursor + dur }; }
    } else { flushBed(bgm, "bgm"); bgm = null; }
    cursor += dur;
  }
  flushBed(amb, "ambience");
  flushBed(bgm, "bgm");
  return { clips, skipped, duration: cursor };
}

/**
 * APPLY a plan to the episode's timeline, preserving everything human.
 *
 * Returns `{ placed, kept, skipped, protectedShots }`:
 *
 *   placed          clips this pass added
 *   kept            clips it refused to touch (locked or manual)
 *   skipped         the plan's own holes, plus rows it declined to place
 *                   because the shot's slot is protected
 *
 * `isLocked(clipId)` is the caller's lock predicate (workflow/locks.js).
 *
 * A shot whose picture is LOCKED or hand-placed keeps its ENTIRE stack — the
 * automatic pass does not re-place its dialogue underneath a take it is not
 * allowed to move. Half-updating a shot is worse than leaving it: the sound
 * would belong to a version of the picture that is no longer there.
 */
export function applyRoughCut(t, plan, { isLocked = null, at = null } = {}) {
  if (!isObj(t) || !isObj(plan)) return { placed: [], kept: [], skipped: [] };
  const locked = (id) => (typeof isLocked === "function" ? isLocked(id) === true : false);
  const kept = [];
  const skipped = [...(Array.isArray(plan.skipped) ? plan.skipped : [])];

  // WHICH shots are off limits: any shot with a locked or manual clip on ANY
  // track. Computed before anything is removed, from the timeline as it stands.
  const protectedShots = new Set();
  let projectAudioProtected = false;
  for (const c of t.clips) {
    if (isAutoClip(c, isLocked)) continue;
    // a REMOVED clip protects its shot too: the plan must not re-add the picture
    // the creator took out. Restoring it is their action, not a side effect of
    // pressing 重新初剪.
    if (c.shotId) protectedShots.add(c.shotId);
    else projectAudioProtected = true; // a hand-placed bed protects the beds
  }

  // drop the previous AUTOMATIC pass; keep everything else exactly as it is
  const survivors = [];
  for (const c of t.clips) {
    if (isAutoClip(c, isLocked)) {
      // …except an auto clip belonging to a protected shot, which stays: its
      // shot is not being re-planned, so removing it would silently strip the
      // dialogue from a picture the creator locked
      if (c.shotId && protectedShots.has(c.shotId)) { survivors.push(c); kept.push(c); continue; }
      if (!c.shotId && projectAudioProtected) { survivors.push(c); kept.push(c); continue; }
      continue;
    }
    survivors.push(c);
    kept.push(c);
    if (locked(c.clipId)) skipped.push({ clipId: c.clipId, shotId: c.shotId, reason: "已锁定，未改动" });
  }
  t.clips = survivors;

  const placed = [];
  for (const p of Array.isArray(plan.clips) ? plan.clips : []) {
    if (p.shotId && protectedShots.has(p.shotId)) {
      skipped.push({ shotId: p.shotId, trackType: p.trackType, reason: "这个镜头有锁定或手工摆放的片段，整条保持不动" });
      continue;
    }
    if (!p.shotId && projectAudioProtected) {
      skipped.push({ trackType: p.trackType, reason: "整集音床里有手工摆放的片段，自动铺垫跳过" });
      continue;
    }
    const clip = addClip(t, {
      trackType: p.trackType,
      assetId: p.assetId,
      assetVersion: p.assetVersion,
      shotId: p.shotId,
      startTime: p.startTime,
      duration: Math.max(0.2, p.trimOut - p.trimIn),
    });
    if (!clip) { skipped.push({ shotId: p.shotId, trackType: p.trackType, reason: "片段无法建立（素材或轨道无效）" }); continue; }
    clip.volume = Number.isFinite(p.volume) ? p.volume : 1;
    clip.fadeIn = Number.isFinite(p.fadeIn) ? p.fadeIn : 0;
    clip.fadeOut = Number.isFinite(p.fadeOut) ? p.fadeOut : 0;
    if (p.trackType === "video") {
      clip.transition = p.transition || "cut";
      clip.transitionMs = Number.isFinite(p.transitionMs) ? p.transitionMs : 0;
    }
    // the ORIGIN stamp — this is what makes the next pass able to tell its own
    // work from the creator's, and it is stored, never re-derived
    clip.origin = "auto";
    placed.push(clip);
  }
  // ORDER the video track by the PLAN — canonical shot order.
  //
  // `relayout` derives start times from ARRAY ORDER, and the survivors keep their
  // original positions while newly placed clips are appended at the end. With any
  // protected clip that silently reordered the episode: a kept SH02 stayed ahead
  // of a rebuilt SH01, so 重新初剪 changed playback order behind the creator's
  // back. Sorted by the plan's own shot order here, with anything the plan does
  // not mention keeping its relative position after the shots it does.
  const planOrder = new Map();
  (Array.isArray(plan.clips) ? plan.clips : [])
    .filter((p) => p.trackType === "video" && p.shotId)
    .forEach((p, i) => { if (!planOrder.has(p.shotId)) planOrder.set(p.shotId, i); });
  const videoSlots = [];
  t.clips.forEach((c, i) => { if (c.trackType === "video") videoSlots.push(i); });
  const ordered = videoSlots.map((i) => t.clips[i]);
  ordered.sort((a, b) => {
    const ka = a.shotId != null && planOrder.has(a.shotId) ? planOrder.get(a.shotId) : Infinity;
    const kb = b.shotId != null && planOrder.has(b.shotId) ? planOrder.get(b.shotId) : Infinity;
    if (ka !== kb) return ka - kb;
    // stable for the ones the plan does not place: keep the order they were in
    return videoSlots.indexOf(t.clips.indexOf(a)) - videoSlots.indexOf(t.clips.indexOf(b));
  });
  videoSlots.forEach((slot, i) => { t.clips[slot] = ordered[i]; });
  relayout(t);
  t.roughCutAt = strOrNull(at);
  t.roughCutVersion = (Number.isInteger(t.roughCutVersion) ? t.roughCutVersion : 0) + 1;
  return { placed, kept, skipped, protectedShots: [...protectedShots] };
}

/** Does this episode have enough real data for a rough cut to be worth building?
 *  「当有足够真实数据」 (§41) — stated as a checkable condition rather than left
 *  to a button that produces an empty timeline and calls it a cut. */
export function canBuild(rows) {
  return (Array.isArray(rows) ? rows : []).some((r) => isObj(r) && r.video && r.video.assetId);
}

/** A one-line summary of what a pass did, for the console's own report. Built
 *  from the result rather than from the plan, so it cannot claim clips that were
 *  refused. */
export function summarize(result) {
  if (!isObj(result)) return "";
  const byTrack = new Map();
  for (const c of result.placed || []) byTrack.set(c.trackType, (byTrack.get(c.trackType) || 0) + 1);
  const bits = TRACKS.filter((t) => byTrack.has(t)).map((t) => `${t} ${byTrack.get(t)}`);
  const parts = [];
  parts.push(bits.length ? `已排入 ${bits.join(" · ")}` : "没有排入任何片段");
  if (result.skipped && result.skipped.length) parts.push(`${result.skipped.length} 处跳过`);
  return parts.join("，");
}

/** The video clips in playback order, with their shot — what the console's main
 *  track renders. Exported here rather than in the console so a test can assert
 *  the order without a DOM. */
export function videoOrder(t) {
  return clipsOf(t, "video", { includeRemoved: true }).map((c, i) => ({ index: i, clip: c }));
}

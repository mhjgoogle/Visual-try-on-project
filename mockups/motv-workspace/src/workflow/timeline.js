// Episode Timeline (checkpoint M11) — the LIGHTWEIGHT edit domain:
// five tracks (video / dialogue / ambience / sfx / bgm), clips that REFERENCE
// assets by id and never own media bytes (the M3 registry stays the single
// media source of truth).
//
//   TimelineClip { clipId, trackType, assetId, shotId|null,
//                  startTime, trimIn, trimOut, volume, muted, fadeIn, fadeOut }
//
// SHOT → TIMELINE RULE: an UN-EDITED timeline mirrors the shots (auto-sync is
// safe — nothing hand-made can be lost). The FIRST manual edit sets `edited`;
// from then on source changes (active-video switch, reorder, regeneration)
// are NEVER silently applied — the UI offers an explicit re-sync that the
// creator confirms (it rebuilds and clears `edited`). Non-destructive: clips
// removed from the timeline never touch the referenced assets.
//
// The VIDEO track is SEQUENTIAL: video-clip order = array order; startTimes
// are derived by re-layout after every structural change. Audio clips with a
// shotId are ANCHORED to their shot's video clip and shift with it; scene/
// episode audio (ambience/bgm) keeps its own placement.
//
// Pure state + transitions — no fetch, no DOM, no clock.

import { mintId } from "./identity.js";
import { DEP } from "./mediadep.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
// clamp a non-negative time to a shared upper bound (start/fade caps) so a
// hydrated or edited value can never exceed what the render accepts
const capped = (v, max, d = 0) => Math.min(max, num(v, d));

/** The episode's tracks. `foley` and `vo` joined in TASK-064 Phase 3 (§37): they
 *  are their own tracks in the shot mix, so folding them into sfx/dialogue on the
 *  way to the episode cut would make the episode's own track list disagree with
 *  the shot's — and a foley pass would arrive at the cut labelled as a sound
 *  effect. The render endpoint accepts both (server.py `_agent_render_episode`);
 *  canvasschema validates against THIS list, imported, so the three can never
 *  drift apart.
 *
 *  Subtitle is deliberately NOT here: a cue carries text, not an asset, and a
 *  clip that references no media would break every consumer that resolves one.
 *  It is its own document (workflow/subtitle.js). */
export const TRACKS = ["video", "dialogue", "ambience", "sfx", "foley", "bgm", "vo"];

/** Tracks that carry AUDIO — everything but the picture. Derived so a new track
 *  cannot be forgotten by the render gather or the console's mixer. */
export const AUDIO_TRACKS = TRACKS.filter((t) => t !== "video");

export const TRACK_LABEL = {
  video: "画面",
  dialogue: "对白",
  vo: "旁白",
  ambience: "环境音",
  sfx: "音效",
  foley: "拟音",
  bgm: "BGM",
};

/** The transitions the cut supports. Deliberately three (§46 「basic transition」
 *  / 「不要做 complex compositing」): a cut, a cross dissolve and a dip to black.
 *  Anything richer belongs to an NLE this is explicitly not. */
export const TRANSITIONS = ["cut", "dissolve", "dip"];

export const TRANSITION_LABEL = { cut: "硬切", dissolve: "叠化", dip: "黑场过渡" };

const TRANSITION_SET = new Set(TRANSITIONS);

/** Transition duration bounds. A 4-second dissolve between two 6-second shots is
 *  not a transition, it is a different edit; capping it here keeps the cut
 *  readable and keeps the value renderable. */
export const MAX_TRANSITION_MS = 2000;

// Clip time bounds — the SINGLE source of truth shared by the domain (here),
// canvas validation (canvasschema imports these) and the timeline UI inputs,
// and kept in lock-step with the render endpoint's caps (server.py: start
// <=36000s, fade <=30s). A value a creator can save is therefore always a
// value the render will accept — no "valid-looking edit that cannot render".
export const MAX_CLIP_START = 36000; // seconds
export const MAX_CLIP_FADE = 30; // seconds

/** Render settings — defaults are VISIBLE and editable, never hidden. */
export const DEFAULT_SETTINGS = Object.freeze({
  width: 1280,
  height: 720,
  fps: 25,
  format: "mp4", // container; codec follows (h264/aac)
});

function sanitizeSettings(s) {
  const src = isObj(s) ? s : {};
  return {
    ...src,
    width: Number.isInteger(src.width) && src.width > 0 ? src.width : DEFAULT_SETTINGS.width,
    height: Number.isInteger(src.height) && src.height > 0 ? src.height : DEFAULT_SETTINGS.height,
    fps: Number.isInteger(src.fps) && src.fps > 0 ? src.fps : DEFAULT_SETTINGS.fps,
    format: src.format === "webm" ? "webm" : "mp4",
  };
}

function sanitizeClip(c, taken) {
  if (!isObj(c) || typeof c.assetId !== "string" || !c.assetId) return null;
  if (!TRACKS.includes(c.trackType)) return null;
  const clipId = typeof c.clipId === "string" && c.clipId && !taken.has(c.clipId) ? c.clipId : mintId("clip");
  taken.add(clipId);
  const trimIn = num(c.trimIn, 0);
  let trimOut = typeof c.trimOut === "number" && Number.isFinite(c.trimOut) ? c.trimOut : trimIn + 1;
  if (trimOut <= trimIn) trimOut = trimIn + 1;
  return {
    ...c,
    clipId,
    trackType: c.trackType,
    assetId: c.assetId,
    shotId: typeof c.shotId === "string" && c.shotId ? c.shotId : null,
    // WHICH VERSION was pinned when this clip was placed (§48). A clip that
    // stores only `assetId` already pins a version implicitly — an assetId IS one
    // take — but nothing could then SAY 「时间线用的是 v2，镜头现在的当前版是 v3」,
    // so the drift was invisible. Null on a legacy clip: unknown stays unknown,
    // and `clipStanding` reports it as such rather than as up to date.
    assetVersion: Number.isInteger(c.assetVersion) ? c.assetVersion : null,
    startTime: capped(c.startTime, MAX_CLIP_START, 0),
    trimIn,
    trimOut,
    volume: typeof c.volume === "number" && Number.isFinite(c.volume) ? Math.min(2, Math.max(0, c.volume)) : 1,
    muted: c.muted === true,
    fadeIn: capped(c.fadeIn, MAX_CLIP_FADE, 0),
    fadeOut: capped(c.fadeOut, MAX_CLIP_FADE, 0),
    // REMOVED, not deleted (§46 「remove / restore」). A removed clip keeps its
    // trim, its gain and its place in the order, so restoring it puts back what
    // the creator had rather than a fresh default — and it contributes no time
    // and no bytes while it is out.
    removed: c.removed === true,
    // set only when this clip went out AS PART OF removing its shot's picture —
    // so restoring the picture restores exactly those, and never undoes a
    // separate decision the creator made about one audio clip
    removedWithShot: c.removedWithShot === true,
    // the transition INTO this clip (video only). `cut` is the absence of one and
    // is stored explicitly so 「没设过」 and 「明确要硬切」 are the same thing here,
    // which is true: both play as a cut.
    transition: c.trackType === "video" && TRANSITION_SET.has(c.transition) ? c.transition : "cut",
    transitionMs: c.trackType === "video"
      ? Math.min(MAX_TRANSITION_MS, Math.max(0, num(c.transitionMs, 0)))
      : 0,
    // WHO placed it: "auto" (the Rough Cut builder) or "manual". Only an `auto`
    // clip may be re-placed by a later automatic pass — see roughcut.isAutoClip.
    // A clip from before this checkpoint has no stamp and defaults to MANUAL,
    // which is the safe direction: mistaking a hand placement for an automatic
    // one would delete work, the reverse only leaves a clip in place.
    origin: c.origin === "auto" ? "auto" : "manual",
  };
}

function sanitizeTimeline(t) {
  const src = isObj(t) ? t : {};
  const taken = new Set();
  const clips = [];
  for (const c of Array.isArray(src.clips) ? src.clips : []) {
    const clip = sanitizeClip(c, taken);
    if (clip) clips.push(clip);
  }
  return {
    ...src,
    clips,
    edited: src.edited === true,
    settings: sanitizeSettings(src.settings),
    // WHICH automatic pass this timeline is at, and when. Recorded so the Final
    // Render's provenance can name the timeline version it shipped (§57) — a
    // render that can only say 「某个时间线」 is not reproducible.
    roughCutVersion: Number.isInteger(src.roughCutVersion) && src.roughCutVersion > 0 ? src.roughCutVersion : 0,
    roughCutAt: typeof src.roughCutAt === "string" && src.roughCutAt ? src.roughCutAt : null,
  };
}

/** Hydrate the timelines map (episodeId → timeline). Null-prototype so an
 *  episodeId literally named __proto__ stays an own key. */
export function createTimelines(saved) {
  const out = Object.create(null);
  if (isObj(saved)) {
    for (const k of Object.keys(saved)) {
      if (k) out[k] = sanitizeTimeline(saved[k]);
    }
  }
  return out;
}

export function serialize(timelines) {
  const out = Object.create(null);
  for (const k of Object.keys(timelines)) out[k] = timelines[k];
  return out;
}

/** The episode's timeline, created empty on first access. */
export function timelineFor(timelines, episodeId) {
  if (typeof episodeId !== "string" || !episodeId) return sanitizeTimeline(null);
  if (!timelines[episodeId]) timelines[episodeId] = sanitizeTimeline(null);
  return timelines[episodeId];
}

/** Clips on a track. REMOVED clips are excluded by default: everything that
 *  lays out, renders or measures the cut must treat a removed clip as absent, or
 *  「移除」 would silently keep contributing time. The console asks for
 *  `{ includeRemoved: true }` when it draws the restore affordance. */
export function clipsOf(t, trackType, { includeRemoved = false } = {}) {
  return t.clips.filter((c) => c.trackType === trackType && (includeRemoved || !c.removed));
}

export function findClip(t, clipId) {
  return t.clips.find((c) => c.clipId === clipId) || null;
}

/** Every clip that actually plays — the ONE definition of 「in the cut」, so the
 *  render, the duration and the console cannot disagree about it. */
export function liveClips(t) {
  return t.clips.filter((c) => !c.removed);
}

export function timelineDuration(t) {
  return liveClips(t).reduce((m, c) => Math.max(m, c.startTime + (c.trimOut - c.trimIn)), 0);
}

/** Re-derive the SEQUENTIAL video-track layout (array order = playback
 *  order) and shift shot-ANCHORED audio clips by their shot's delta.
 *
 *  Removed clips take no time, which is what makes 「移除这一镜」 actually shorten
 *  the episode; their own `startTime` is left alone so restoring one lands it
 *  back in sequence via the relayout that follows. */
export function relayout(t) {
  const oldStart = new Map(); // shotId → previous video start
  for (const c of clipsOf(t, "video")) {
    if (c.shotId) oldStart.set(c.shotId, c.startTime);
  }
  let cursor = 0;
  const newStart = new Map();
  for (const c of clipsOf(t, "video")) {
    c.startTime = cursor;
    if (c.shotId) newStart.set(c.shotId, cursor);
    cursor += c.trimOut - c.trimIn;
  }
  for (const c of t.clips) {
    if (c.trackType === "video" || !c.shotId) continue;
    const was = oldStart.get(c.shotId);
    const now = newStart.get(c.shotId);
    if (was !== undefined && now !== undefined) c.startTime = Math.max(0, c.startTime + (now - was));
  }
  return t;
}

/** Build the DEFAULT clip set from the shots (used for auto-sync of an
 *  un-edited timeline and for explicit re-sync). `rows` are ordered:
 *  { shotId, duration, videoAssetId, dialogueAssetId?, sfxAssetId?,
 *    sceneId?, ambienceAssetId?, bgmAssetId? } — every id is an Asset
 *  REFERENCE. Rows lacking a videoAssetId contribute NOTHING and do not
 *  advance time: the video track is GAPLESS (final render concatenates the
 *  video clips back-to-back), so a "planned gap" would shift every later
 *  audio placement against the rendered picture. Missing footage is
 *  surfaced by the shots/video workspaces, never as silent desync here. */
const vnum = (x) => (Number.isInteger(x) ? x : null);

export function buildFromRows(rows) {
  const mk = (over) => ({
    clipId: mintId("clip"),
    trackType: "video",
    assetId: "",
    assetVersion: null,
    shotId: null,
    startTime: 0,
    trimIn: 0,
    trimOut: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    removed: false,
    removedWithShot: false,
    transition: "cut",
    transitionMs: 0,
    // MACHINE-BUILT, so it is marked as such. Without the stamp these clips
    // hydrated as `manual` (the safe default) and the Rough Cut then treated the
    // whole episode as hand-placed and refused to touch any of it — an automatic
    // mirror masquerading as the creator's own work.
    origin: "auto",
    ...over,
  });
  const clips = [];
  let cursor = 0;
  // contiguous spans of the same referenced audio asset are merged into ONE
  // clip (an ambience/bgm asset is reused, never copied per shot)
  let amb = null; // { assetId, start, end }
  let bgm = null;
  const flush = (span, trackType) => {
    if (!span) return;
    clips.push(mk({
      trackType,
      assetId: span.assetId,
      // the BED's version too — it is an asset like any other, and a clip with no
      // pin can never report drift on it
      assetVersion: vnum(span.version),
      startTime: span.start,
      trimIn: 0,
      trimOut: Math.max(1, span.end - span.start),
      volume: trackType === "bgm" ? 0.4 : 0.7,
      fadeIn: 0.5,
      fadeOut: 0.5,
    }));
  };
  for (const r of Array.isArray(rows) ? rows : []) {
    const dur = typeof r.duration === "number" && r.duration > 0 ? r.duration : 6;
    if (!r.videoAssetId) continue; // no footage → no time slot (gapless track)
    clips.push(mk({
      trackType: "video", assetId: r.videoAssetId, assetVersion: vnum(r.videoAssetVersion),
      shotId: r.shotId || null, startTime: cursor, trimOut: dur,
    }));
    if (r.dialogueAssetId) {
      clips.push(mk({
        trackType: "dialogue", assetId: r.dialogueAssetId, assetVersion: vnum(r.dialogueAssetVersion),
        shotId: r.shotId || null, startTime: cursor, trimOut: dur,
      }));
    }
    // EVERY track carries its version through (§48). A clip built without one
    // reports UNKNOWN standing forever, so drift on that track can never be seen
    // — and the Final Render's provenance says 「版本未记录」 for a take the
    // registry knows perfectly well.
    if (r.sfxAssetId) {
      clips.push(mk({
        trackType: "sfx", assetId: r.sfxAssetId, assetVersion: vnum(r.sfxAssetVersion),
        shotId: r.shotId || null, startTime: cursor, trimOut: dur, volume: 0.8,
      }));
    }
    // 拟音 / 旁白 reach the episode cut as themselves (§37). A shot that has a
    // foley pass and a VO take gets both, on their own tracks — collapsing them
    // into sfx/dialogue here is exactly the relabelling the track list exists to
    // prevent.
    if (r.foleyAssetId) {
      clips.push(mk({
        trackType: "foley", assetId: r.foleyAssetId, assetVersion: vnum(r.foleyAssetVersion),
        shotId: r.shotId || null, startTime: cursor, trimOut: dur, volume: 0.8,
      }));
    }
    if (r.voAssetId) {
      clips.push(mk({
        trackType: "vo", assetId: r.voAssetId, assetVersion: vnum(r.voAssetVersion),
        shotId: r.shotId || null, startTime: cursor, trimOut: dur,
      }));
    }
    if (r.ambienceAssetId) {
      if (amb && amb.assetId === r.ambienceAssetId && amb.end === cursor) amb.end = cursor + dur;
      else {
        flush(amb, "ambience");
        amb = { assetId: r.ambienceAssetId, version: r.ambienceAssetVersion, start: cursor, end: cursor + dur };
      }
    } else { flush(amb, "ambience"); amb = null; }
    if (r.bgmAssetId) {
      if (bgm && bgm.assetId === r.bgmAssetId && bgm.end === cursor) bgm.end = cursor + dur;
      else {
        flush(bgm, "bgm");
        bgm = { assetId: r.bgmAssetId, version: r.bgmAssetVersion, start: cursor, end: cursor + dur };
      }
    } else { flush(bgm, "bgm"); bgm = null; }
    cursor += dur;
  }
  flush(amb, "ambience");
  flush(bgm, "bgm");
  return clips;
}

/** Auto/explicit sync: replace the clip set with the default build. Allowed
 *  ONLY on an un-edited timeline or as an EXPLICIT confirmed re-sync — the
 *  caller enforces the confirmation; this clears `edited`. */
export function syncFromRows(t, rows) {
  // SANITIZED on the way in, like every other path that puts clips on a
  // timeline. Assigning the raw build left fields the sanitizer supplies
  // (`origin`, `removed`, `transition`) undefined in memory and absent from the
  // save, so the in-session behaviour and the after-reload behaviour differed —
  // the worst kind of divergence, because only one of them is ever tested.
  const taken = new Set();
  t.clips = buildFromRows(rows).map((c) => sanitizeClip(c, taken)).filter(Boolean);
  t.edited = false;
  return t;
}

// ---- editing operations (each marks the timeline as hand-edited) ---------- //

function touched(t) {
  t.edited = true;
  return true;
}

/** Move a video clip one position earlier/later (sequential order). */
export function reorderVideo(t, clipId, dir) {
  const vids = clipsOf(t, "video");
  const i = vids.findIndex((c) => c.clipId === clipId);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= vids.length) return false;
  const a = t.clips.indexOf(vids[i]);
  const b = t.clips.indexOf(vids[j]);
  [t.clips[a], t.clips[b]] = [t.clips[b], t.clips[a]];
  relayout(t);
  return touched(t);
}

/** Replace WHICH asset a clip references (e.g. another video variant).
 *  Nothing about the old asset changes — reference only.
 *
 *  `version` re-pins the clip. Passing it is how a 「替换为 v3」 stays honest
 *  afterwards; omitting it clears the pin to null (unknown) rather than leaving
 *  the OLD version number attached to a NEW asset, which would make the clip
 *  report a version it is not playing. */
export function replaceClipAsset(t, clipId, assetId, version = null) {
  const c = findClip(t, clipId);
  if (!c || typeof assetId !== "string" || !assetId) return false;
  c.assetId = assetId;
  c.assetVersion = Number.isInteger(version) ? version : null;
  return touched(t);
}

/**
 * Is this clip still playing the version its SHOT currently has active? (§48)
 *
 * Returns one of `mediadep.DEP` — the same five states as image→video drift and
 * frame bindings, because it is the same kind of fact and one vocabulary is
 * enough for the whole studio.
 *
 *   none      not a shot-bound clip (project audio has no shot to trail)
 *   unknown   the clip never recorded which version it pinned, or the shot has
 *             no active version to compare against
 *   current   the pinned version IS the shot's active one
 *   outdated  the shot's active version moved FORWARD past the pin
 *   diverged  the shot's active version is EARLIER than the pin
 *
 * NOTHING HERE REWRITES ANYTHING. §48 is explicit: 「禁止静默替换」. The console
 * shows the state and offers 保持 / 替换 / 对比; this function only says which
 * state it is in.
 */
export function clipStanding(clip, activeVersion) {
  if (!isObj(clip) || !clip.shotId) return DEP.NONE;
  if (!Number.isInteger(activeVersion)) return DEP.UNKNOWN;
  if (!Number.isInteger(clip.assetVersion)) return DEP.UNKNOWN;
  if (clip.assetVersion === activeVersion) return DEP.CURRENT;
  return clip.assetVersion < activeVersion ? DEP.OUTDATED : DEP.DIVERGED;
}

/**
 * Every clip whose pinned version has drifted from its shot's active one.
 *
 * `activeOf(shotId, trackType)` returns `{ assetId, version }` for what that
 * shot currently has active on that track, or null. Passed in so this module
 * never reaches into the asset registry.
 *
 * The result is what the console renders as 「SH03 有新版本 v3，时间线当前仍使用
 * v2」 with its three choices. Only OUTDATED / DIVERGED are reported: a clip
 * whose basis is merely unrecorded is not drift, and reporting it as such would
 * ask the creator to fix a fact rather than a problem.
 */
export function driftedClips(t, activeOf) {
  const out = [];
  if (!isObj(t) || typeof activeOf !== "function") return out;
  for (const c of liveClips(t)) {
    if (!c.shotId) continue;
    const cur = activeOf(c.shotId, c.trackType) || null;
    const state = clipStanding(c, cur && Number.isInteger(cur.version) ? cur.version : null);
    if (state !== DEP.OUTDATED && state !== DEP.DIVERGED) continue;
    out.push({
      clipId: c.clipId,
      shotId: c.shotId,
      trackType: c.trackType,
      pinnedAssetId: c.assetId,
      pinnedVersion: c.assetVersion,
      activeAssetId: cur ? cur.assetId : null,
      activeVersion: cur ? cur.version : null,
      state,
      // exactly the three §48 requires; nothing here picks one
      resolutions: [
        { action: "keep", label: `保持 v${c.assetVersion}` },
        { action: "replace", label: cur && Number.isInteger(cur.version) ? `替换为 v${cur.version}` : "替换为当前版本" },
        { action: "compare", label: "对比" },
      ],
    });
  }
  return out;
}

/** REMOVE / RESTORE a clip without losing it (§46). Removing a VIDEO clip also
 *  removes the audio ANCHORED to its shot, for the same reason the hard delete
 *  does: with the picture out, its anchored audio has no anchor and would play
 *  over later footage. Restoring puts them all back together.
 *
 *  THE CASCADE RESPECTS LOCKS (TASK-072 §1.9 缺陷 4). The lock used to be checked
 *  for the clip NAMED in the call and for nothing else, so removing an unlocked
 *  video clip silently removed the locked audio anchored to the same shot — a lock
 *  defeated by touching a different object. Locked clips are now LEFT ALONE, and
 *  the ones skipped are reported through `skipped` so the caller can say
 *  「N 条已锁定的音频没有跟着移除」 instead of leaving the creator to discover it.
 *
 *  @param {string[]} [opts.skipped] out-param: clipIds the cascade refused to touch. */
export function setClipRemoved(t, clipId, on, { isLocked = null, skipped = null } = {}) {
  const target = findClip(t, clipId);
  if (!target) return false;
  const locked = (id) => (typeof isLocked === "function" ? isLocked(id) === true : false);
  if (locked(clipId)) return false;
  const want = on === true;
  if (target.removed === want) return false;
  target.removed = want;
  if (target.trackType === "video" && target.shotId) {
    for (const c of t.clips) {
      if (c.trackType === "video" || c.shotId !== target.shotId) continue;
      // Neither direction may override a lock: removing a locked audio clip loses
      // it from the cut, and restoring one puts back something the creator pinned
      // out. Both are decisions about THAT clip, and this call is about the picture.
      if (locked(c.clipId)) {
        if (Array.isArray(skipped)) skipped.push(c.clipId);
        continue;
      }
      // a clip the creator removed BY ITSELF stays removed when the picture comes
      // back: restoring the shot must not undo a separate decision about its
      // dialogue. Only clips this same call took out are put back, which is what
      // `removedWithShot` records — it is persisted, because the restore may
      // happen in a later session.
      if (want) { if (!c.removed) { c.removed = true; c.removedWithShot = true; } }
      else if (c.removedWithShot) { c.removed = false; c.removedWithShot = false; }
    }
  }
  relayout(t);
  return touched(t);
}

/** Set the transition INTO a video clip (§46 「basic transition」). */
export function setTransition(t, clipId, kind, durationMs) {
  const c = findClip(t, clipId);
  if (!c || c.trackType !== "video") return false;
  if (!TRANSITION_SET.has(kind)) return false;
  c.transition = kind;
  c.transitionMs = kind === "cut"
    ? 0
    : Math.min(MAX_TRANSITION_MS, Math.max(0, num(durationMs, 500)));
  return touched(t);
}

/** Move a video clip to an absolute INDEX in the video order (§46 reorder by
 *  drag). `reorderVideo` moves by one step; this is the same operation stated
 *  as a destination, which is what a drag produces. */
export function moveVideoClipTo(t, clipId, index) {
  const vids = clipsOf(t, "video", { includeRemoved: true });
  const from = vids.findIndex((c) => c.clipId === clipId);
  if (from < 0) return false;
  const to = Math.max(0, Math.min(vids.length - 1, Number.isInteger(index) ? index : from));
  if (to === from) return false;
  const reordered = vids.slice();
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  // write the new order back into the SAME positions the video clips occupied,
  // leaving every audio clip's array position untouched
  const slots = [];
  t.clips.forEach((c, i) => { if (c.trackType === "video") slots.push(i); });
  slots.forEach((slot, i) => { t.clips[slot] = reordered[i]; });
  relayout(t);
  return touched(t);
}

export function trimClip(t, clipId, trimIn, trimOut) {
  const c = findClip(t, clipId);
  if (!c) return false;
  const ti = num(trimIn, c.trimIn);
  const to = typeof trimOut === "number" && Number.isFinite(trimOut) ? trimOut : c.trimOut;
  if (to <= ti) return false;
  c.trimIn = ti;
  c.trimOut = to;
  if (c.trackType === "video") {
    // trimming the SHOT's picture must not leave its anchored audio overhanging
    // into the next shot: clamp each shot-anchored audio clip so its duration
    // never exceeds the video's new duration (M11 review — A/V sync). A longer
    // video is not artificially extended; the audio simply ends within it.
    if (c.shotId) {
      const vidDur = to - ti;
      for (const a of t.clips) {
        if (a.trackType === "video" || a.shotId !== c.shotId) continue;
        if (a.trimOut - a.trimIn > vidDur) a.trimOut = a.trimIn + vidDur;
      }
    }
    relayout(t);
  }
  return touched(t);
}

export function setClipVolume(t, clipId, volume) {
  const c = findClip(t, clipId);
  if (!c || typeof volume !== "number" || !Number.isFinite(volume)) return false;
  c.volume = Math.min(2, Math.max(0, volume));
  return touched(t);
}

export function setClipMuted(t, clipId, muted) {
  const c = findClip(t, clipId);
  if (!c) return false;
  c.muted = muted === true;
  return touched(t);
}

export function setClipFades(t, clipId, fadeIn, fadeOut) {
  const c = findClip(t, clipId);
  if (!c) return false;
  c.fadeIn = capped(fadeIn, MAX_CLIP_FADE, c.fadeIn);
  c.fadeOut = capped(fadeOut, MAX_CLIP_FADE, c.fadeOut);
  return touched(t);
}

/** Move an AUDIO clip's placement. Video placement is sequential-only. */
export function moveClip(t, clipId, startTime) {
  const c = findClip(t, clipId);
  if (!c || c.trackType === "video") return false;
  c.startTime = capped(startTime, MAX_CLIP_START, c.startTime);
  return touched(t);
}

/** Remove a clip from the timeline — the referenced asset is untouched.
 *  Removing a VIDEO clip also removes the audio clips ANCHORED to its shot
 *  (dialogue/sfx carrying the same shotId): with the shot's picture gone its
 *  anchored audio has no anchor and would otherwise play over later footage /
 *  extend the render past the picture. Scene/episode audio (shotId null —
 *  ambience/bgm) is NOT shot-anchored and is left in place. */
export function removeClip(t, clipId) {
  const target = findClip(t, clipId);
  if (!target) return false;
  const wasVideo = target.trackType === "video";
  const shotId = target.shotId;
  t.clips = t.clips.filter((c) => {
    if (c.clipId === clipId) return false;
    if (wasVideo && shotId && c.trackType !== "video" && c.shotId === shotId) return false;
    return true;
  });
  if (wasVideo) relayout(t);
  return touched(t);
}

/** Add a clip referencing an existing asset. */
export function addClip(t, { trackType, assetId, assetVersion = null, shotId = null, startTime = 0, duration = 4 }) {
  if (!TRACKS.includes(trackType) || typeof assetId !== "string" || !assetId) return null;
  const clip = {
    clipId: mintId("clip"),
    trackType,
    assetId,
    assetVersion: vnum(assetVersion),
    shotId: typeof shotId === "string" && shotId ? shotId : null,
    startTime: capped(startTime, MAX_CLIP_START, 0),
    trimIn: 0,
    trimOut: Math.max(0.2, num(duration, 4)),
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    removed: false,
    removedWithShot: false,
    transition: "cut",
    transitionMs: 0,
  };
  t.clips.push(clip);
  if (trackType === "video") relayout(t);
  touched(t);
  return clip;
}

export function setSettings(t, settings) {
  t.settings = sanitizeSettings({ ...t.settings, ...(isObj(settings) ? settings : {}) });
  return true;
}
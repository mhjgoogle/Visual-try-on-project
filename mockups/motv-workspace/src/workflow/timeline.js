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

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
// clamp a non-negative time to a shared upper bound (start/fade caps) so a
// hydrated or edited value can never exceed what the render accepts
const capped = (v, max, d = 0) => Math.min(max, num(v, d));

export const TRACKS = ["video", "dialogue", "ambience", "sfx", "bgm"];

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
    startTime: capped(c.startTime, MAX_CLIP_START, 0),
    trimIn,
    trimOut,
    volume: typeof c.volume === "number" && Number.isFinite(c.volume) ? Math.min(2, Math.max(0, c.volume)) : 1,
    muted: c.muted === true,
    fadeIn: capped(c.fadeIn, MAX_CLIP_FADE, 0),
    fadeOut: capped(c.fadeOut, MAX_CLIP_FADE, 0),
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
  return { ...src, clips, edited: src.edited === true, settings: sanitizeSettings(src.settings) };
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

export function clipsOf(t, trackType) {
  return t.clips.filter((c) => c.trackType === trackType);
}

export function findClip(t, clipId) {
  return t.clips.find((c) => c.clipId === clipId) || null;
}

export function timelineDuration(t) {
  return t.clips.reduce((m, c) => Math.max(m, c.startTime + (c.trimOut - c.trimIn)), 0);
}

/** Re-derive the SEQUENTIAL video-track layout (array order = playback
 *  order) and shift shot-ANCHORED audio clips by their shot's delta. */
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
export function buildFromRows(rows) {
  const mk = (over) => ({
    clipId: mintId("clip"),
    trackType: "video",
    assetId: "",
    shotId: null,
    startTime: 0,
    trimIn: 0,
    trimOut: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
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
    clips.push(mk({ trackType: "video", assetId: r.videoAssetId, shotId: r.shotId || null, startTime: cursor, trimOut: dur }));
    if (r.dialogueAssetId) {
      clips.push(mk({ trackType: "dialogue", assetId: r.dialogueAssetId, shotId: r.shotId || null, startTime: cursor, trimOut: dur }));
    }
    if (r.sfxAssetId) {
      clips.push(mk({ trackType: "sfx", assetId: r.sfxAssetId, shotId: r.shotId || null, startTime: cursor, trimOut: dur, volume: 0.8 }));
    }
    if (r.ambienceAssetId) {
      if (amb && amb.assetId === r.ambienceAssetId && amb.end === cursor) amb.end = cursor + dur;
      else { flush(amb, "ambience"); amb = { assetId: r.ambienceAssetId, start: cursor, end: cursor + dur }; }
    } else { flush(amb, "ambience"); amb = null; }
    if (r.bgmAssetId) {
      if (bgm && bgm.assetId === r.bgmAssetId && bgm.end === cursor) bgm.end = cursor + dur;
      else { flush(bgm, "bgm"); bgm = { assetId: r.bgmAssetId, start: cursor, end: cursor + dur }; }
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
  t.clips = buildFromRows(rows);
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
 *  Nothing about the old asset changes — reference only. */
export function replaceClipAsset(t, clipId, assetId) {
  const c = findClip(t, clipId);
  if (!c || typeof assetId !== "string" || !assetId) return false;
  c.assetId = assetId;
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
export function addClip(t, { trackType, assetId, shotId = null, startTime = 0, duration = 4 }) {
  if (!TRACKS.includes(trackType) || typeof assetId !== "string" || !assetId) return null;
  const clip = {
    clipId: mintId("clip"),
    trackType,
    assetId,
    shotId: typeof shotId === "string" && shotId ? shotId : null,
    startTime: capped(startTime, MAX_CLIP_START, 0),
    trimIn: 0,
    trimOut: Math.max(0.2, num(duration, 4)),
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
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
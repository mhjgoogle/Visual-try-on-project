// Shot audio timeline (ADR-0061 决策 6 / 决策 7) — a LIGHT multi-track, not a DAW.
//
//   Dialogue · Ambience · SFX · Foley · BGM · VO
//     → clips with timing, trim, gain and fades
//     → internal mix
//     → ONE derived Shot Mixed Audio Asset
//
// THE TWO RULES THIS MODULE EXISTS TO ENFORCE:
//
//  1. EVERY SOURCE SURVIVES. A mix is a DERIVED asset; the dialogue take, the
//     ambience bed and every sound effect stay registered, versioned and
//     independently replaceable. Nothing here can delete or overwrite a source.
//
//  2. TWO TIMING MODES, BOTH FIRST-CLASS (决策 7):
//
//       absolute   startTimeMs = 3200          ambience · BGM · manual placement
//       anchored   anchor = "action:glass_hits_table", offsetMs = +80
//                                              SFX · foley · dialogue sync
//
//     An anchored clip whose anchor does not resolve is NOT silently placed at
//     zero: it reports `unresolved`, because a foley hit 3 seconds away from the
//     action it was written for is worse than an obviously missing one.
//
// LOCK (决策 5 / §50): a clip the creator locked is not moved, retimed, re-gained
// or replaced by Auto Mix / Regenerate Rough Cut. `lockedClips` is consulted by
// every automated writer in this module — see `autoArrange`.
//
// Pure state + transitions — no fetch, no DOM, no clock (callers pass `at`),
// no audio processing. The actual mix is FFmpeg's job, downstream of here.

import { mintId } from "./identity.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const strOrNull = (x) => (typeof x === "string" && x ? x : null);
const int = (x, dflt = 0) => (Number.isFinite(x) ? Math.round(x) : dflt);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** The audio tracks of one shot, in mix order (bottom to top of the stack as a
 *  creator reads it). `video` is deliberately absent: the picture is not an audio
 *  track, and putting it here would let a video clip be gained and faded as if it
 *  were one. */
export const TRACKS = ["dialogue", "vo", "ambience", "sfx", "foley", "bgm"];

export const TRACK_LABEL = {
  dialogue: "对白",
  vo: "旁白",
  ambience: "环境音",
  sfx: "音效",
  foley: "拟音",
  bgm: "BGM",
};

/** Which declared Asset kind belongs on which track. A clip whose asset kind
 *  disagrees with its track is reported, never silently re-tracked: 「这条其实是
 *  BGM」 is a decision for the creator, not an inference. */
export const TRACK_KIND = {
  dialogue: "dialogue",
  vo: "vo",
  ambience: "ambience",
  sfx: "sfx",
  foley: "foley",
  bgm: "bgm",
};

const TRACK_SET = new Set(TRACKS);

/** Gain is in dB and deliberately bounded: a slider that can reach +40 dB only
 *  ever produces clipping, and −∞ is what `muted` is for. */
export const GAIN_MIN_DB = -60;
export const GAIN_MAX_DB = 12;

/** The anchor NAMESPACES a clip may sync to (决策 7). An anchor is
 *  `<namespace>:<name>`; the namespace says what kind of thing it points at, so
 *  a resolver can be given only the anchors it actually knows. */
export const ANCHOR_NAMESPACES = ["action", "dialogue", "shot", "beat"];

/** Split an anchor into `{ ns, name }`, or null when it is not an anchor. */
export function parseAnchor(anchor) {
  if (typeof anchor !== "string" || !anchor) return null;
  const i = anchor.indexOf(":");
  if (i <= 0 || i === anchor.length - 1) return null;
  const ns = anchor.slice(0, i);
  if (!ANCHOR_NAMESPACES.includes(ns)) return null;
  return { ns, name: anchor.slice(i + 1) };
}

/* -------------------------------------------------------------------------- */
/* clips                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Normalize one persisted clip. Total and idempotent; never invents an asset.
 *
 * A clip with no `assetId` is dropped by `createShotAudio`: a timeline entry that
 * points at no media is not a clip, it is a hole that every later consumer has to
 * special-case.
 */
export function sanitizeClip(saved) {
  if (!isObj(saved)) return null;
  const assetId = strOrNull(saved.assetId);
  if (!assetId) return null;
  const trackType = TRACK_SET.has(saved.trackType) ? saved.trackType : null;
  if (!trackType) return null;
  const anchor = parseAnchor(saved.anchor) ? saved.anchor : null;
  // ABSOLUTE and ANCHORED are exclusive. A clip carrying both would have two
  // answers to "where does this start", and whichever the renderer preferred
  // would make the other one a lie shown in the UI.
  const startTimeMs = anchor === null ? Math.max(0, int(saved.startTimeMs, 0)) : null;
  const sourceInMs = Math.max(0, int(saved.sourceInMs, 0));
  const rawOut = int(saved.sourceOutMs, 0);
  // an out point at or before the in point is no clip at all — treat it as
  // "to the end of the source", which is what an unset out point means
  const sourceOutMs = rawOut > sourceInMs ? rawOut : null;
  return {
    clipId: strOrNull(saved.clipId) || mintId("aclip"),
    assetId,
    trackType,
    startTimeMs,
    anchor,
    offsetMs: anchor === null ? 0 : int(saved.offsetMs, 0),
    sourceInMs,
    sourceOutMs,
    gain: clamp(Number.isFinite(saved.gain) ? saved.gain : 0, GAIN_MIN_DB, GAIN_MAX_DB),
    fadeInMs: Math.max(0, int(saved.fadeInMs, 0)),
    fadeOutMs: Math.max(0, int(saved.fadeOutMs, 0)),
    muted: saved.muted === true,
    // a lock is a creator statement, so it is stored rather than derived
    locked: saved.locked === true,
    // WHERE this clip came from: "auto" (built by the arranger) or "manual".
    // Auto Mix may re-place an `auto` clip; it never touches a `manual` one, and
    // it never touches a locked one of either kind (决策 5).
    origin: saved.origin === "manual" ? "manual" : "auto",
  };
}

/** A fresh clip. `timing` is either `{ startTimeMs }` or `{ anchor, offsetMs }` —
 *  passing both is refused rather than resolved by precedence. */
export function makeClip({ assetId, trackType, timing = {}, sourceInMs = 0, sourceOutMs = null,
  gain = 0, fadeInMs = 0, fadeOutMs = 0, origin = "manual" } = {}) {
  const hasAbs = Number.isFinite(timing.startTimeMs);
  const hasAnchor = !!parseAnchor(timing.anchor);
  // An anchor that was SUPPLIED but does not parse is refused outright, even
  // alongside a valid absolute time. Treating it as merely absent silently threw
  // away a timing the caller had stated and placed the sound somewhere else
  // instead (codex review round 4) — and a discarded intent is the hardest kind
  // of bug to notice, because the result looks deliberate.
  if (timing.anchor !== undefined && timing.anchor !== null && !hasAnchor) return null;
  // EXACTLY one mode. Neither is refused as firmly as both: an omitted timing
  // used to fall through to "absolute at 0 ms", so a caller that forgot to say
  // where a sound goes silently placed it on the first frame (codex review round
  // 3) — better a refused clip than a foley hit at the top of the shot.
  if (hasAbs === hasAnchor) return null;
  return sanitizeClip({
    clipId: mintId("aclip"),
    assetId,
    trackType,
    startTimeMs: hasAbs ? timing.startTimeMs : 0,
    anchor: hasAnchor ? timing.anchor : null,
    offsetMs: hasAnchor ? timing.offsetMs : 0,
    sourceInMs,
    sourceOutMs,
    gain,
    fadeInMs,
    fadeOutMs,
    origin,
  });
}

/* -------------------------------------------------------------------------- */
/* the document                                                               */
/* -------------------------------------------------------------------------- */

function putKey(obj, key, val) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = val;
  }
  return obj;
}

function sanitizeMix(saved) {
  if (!isObj(saved)) return null;
  const assetId = strOrNull(saved.assetId);
  if (!assetId) return null;
  return {
    assetId,
    at: strOrNull(saved.at),
    // The mix's PROVENANCE, frozen at mix time (决策 6). It is a snapshot on
    // purpose: the clips may move afterwards, and a mix that reported the CURRENT
    // arrangement would claim to be something it is not.
    sources: (Array.isArray(saved.sources) ? saved.sources : []).map((s) => (isObj(s) ? {
      assetId: strOrNull(s.assetId),
      version: Number.isInteger(s.version) ? s.version : null,
      trackType: TRACK_SET.has(s.trackType) ? s.trackType : null,
      startMs: int(s.startMs, 0),
      endMs: Number.isFinite(s.endMs) ? int(s.endMs, 0) : null,
      anchor: strOrNull(s.anchor),
      offsetMs: int(s.offsetMs, 0),
      gain: Number.isFinite(s.gain) ? s.gain : 0,
      fadeInMs: int(s.fadeInMs, 0),
      fadeOutMs: int(s.fadeOutMs, 0),
    } : null)).filter((s) => s && s.assetId),
    settings: isObj(saved.settings) ? { ...saved.settings } : null,
    // clips whose anchor could not be resolved AT MIX TIME — recorded so the mix
    // never silently claims to contain a sound it could not place
    unresolved: (Array.isArray(saved.unresolved) ? saved.unresolved : [])
      .map(strOrNull).filter(Boolean),
  };
}

/** Hydrate from a persisted `shotAudio` field (or start empty). */
export function createShotAudio(saved) {
  const out = Object.create(null);
  if (!isObj(saved)) return out;
  for (const shotId of Object.keys(saved)) {
    const e = saved[shotId];
    if (!isObj(e)) continue;
    const clips = (Array.isArray(e.clips) ? e.clips : []).map(sanitizeClip).filter(Boolean);
    const mix = sanitizeMix(e.mix);
    if (!clips.length && !mix) continue;
    putKey(out, shotId, { clips, mix });
  }
  return out;
}

function entry(doc, shotId, create = false) {
  if (!isObj(doc) || typeof shotId !== "string" || !shotId) return null;
  let e = Object.prototype.hasOwnProperty.call(doc, shotId) ? doc[shotId] : null;
  if (!isObj(e)) {
    if (!create) return null;
    e = { clips: [], mix: null };
    putKey(doc, shotId, e);
  }
  return e;
}

export function clipsOf(doc, shotId) {
  const e = entry(doc, shotId);
  return e ? e.clips : [];
}

export function mixOf(doc, shotId) {
  const e = entry(doc, shotId);
  return e ? e.mix : null;
}

export function findClip(doc, shotId, clipId) {
  return clipsOf(doc, shotId).find((c) => c.clipId === clipId) || null;
}

/** Add a clip. Returns the clip, or null when refused. */
export function addClip(doc, shotId, clip) {
  const c = sanitizeClip(clip);
  if (!c) return null;
  const e = entry(doc, shotId, true);
  e.clips.push(c);
  return c;
}

export function removeClip(doc, shotId, clipId) {
  const e = entry(doc, shotId);
  if (!e) return false;
  const c = e.clips.find((x) => x.clipId === clipId);
  // A LOCKED clip is not removed by anything — including the creator's own
  // delete, which would otherwise make the lock meaningless the moment it
  // mattered. Unlock first; that is one click and it is explicit.
  if (!c || c.locked) return false;
  e.clips = e.clips.filter((x) => x.clipId !== clipId);
  return true;
}

/** Mutate ONE field group on a clip. Every writer goes through here so the lock
 *  check exists in exactly one place. `force` is for the creator's own edit of a
 *  clip they locked — automation never passes it. */
function edit(doc, shotId, clipId, patch, { force = false } = {}) {
  const c = findClip(doc, shotId, clipId);
  if (!c) return false;
  if (c.locked && !force) return false;
  const next = sanitizeClip({ ...c, ...patch });
  if (!next) return false;
  const e = entry(doc, shotId);
  e.clips = e.clips.map((x) => (x.clipId === clipId ? next : x));
  return true;
}

/** Move a clip. `timing` is `{ startTimeMs }` or `{ anchor, offsetMs }` — the two
 *  modes stay exclusive, so a move can also CHANGE the mode, which is exactly
 *  what 「把这条音效改成跟着动作走」 means. */
export function moveClip(doc, shotId, clipId, timing, opts = {}) {
  const hasAbs = Number.isFinite(timing && timing.startTimeMs);
  const hasAnchor = !!parseAnchor(timing && timing.anchor);
  if (hasAbs === hasAnchor) return false; // neither, or both
  return edit(doc, shotId, clipId, hasAbs
    ? { startTimeMs: timing.startTimeMs, anchor: null, offsetMs: 0 }
    : { anchor: timing.anchor, offsetMs: int(timing.offsetMs, 0), startTimeMs: null }, opts);
}

export function trimClip(doc, shotId, clipId, sourceInMs, sourceOutMs, opts = {}) {
  return edit(doc, shotId, clipId, { sourceInMs, sourceOutMs }, opts);
}

export function setGain(doc, shotId, clipId, gain, opts = {}) {
  if (!Number.isFinite(gain)) return false;
  return edit(doc, shotId, clipId, { gain }, opts);
}

export function setFade(doc, shotId, clipId, fadeInMs, fadeOutMs, opts = {}) {
  return edit(doc, shotId, clipId, { fadeInMs, fadeOutMs }, opts);
}

export function setMuted(doc, shotId, clipId, on, opts = {}) {
  return edit(doc, shotId, clipId, { muted: on === true }, opts);
}

export function replaceClipAsset(doc, shotId, clipId, assetId, opts = {}) {
  if (!strOrNull(assetId)) return false;
  return edit(doc, shotId, clipId, { assetId }, opts);
}

/** Lock / unlock. Not routed through `edit`, because a lock is the one thing that
 *  must remain settable ON a locked clip — otherwise nothing could unlock it. */
export function setLocked(doc, shotId, clipId, on) {
  const c = findClip(doc, shotId, clipId);
  if (!c) return false;
  c.locked = on === true;
  return true;
}

/* -------------------------------------------------------------------------- */
/* timing resolution                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Resolve every clip to real millisecond bounds.
 *
 * `anchors`   Map/object of `"<ns>:<name>"` → ms. An anchor NOT in it is
 *             unresolved — the clip is returned with `startMs: null` and
 *             `unresolved: true`, never placed at 0.
 * `durations` assetId → source duration in ms, where known. Used only to close an
 *             open out point; unknown stays null and the clip reports `endMs:
 *             null` rather than a guessed length.
 */
export function resolveClips(clips, { anchors = {}, durations = {} } = {}) {
  const get = (k) => {
    if (anchors instanceof Map) return anchors.has(k) ? anchors.get(k) : undefined;
    return isObj(anchors) && Object.prototype.hasOwnProperty.call(anchors, k) ? anchors[k] : undefined;
  };
  const dur = (id) => {
    if (durations instanceof Map) return durations.has(id) ? durations.get(id) : undefined;
    return isObj(durations) && Object.prototype.hasOwnProperty.call(durations, id) ? durations[id] : undefined;
  };
  return (Array.isArray(clips) ? clips : []).map((c) => {
    let startMs = null;
    let unresolved = false;
    if (c.anchor) {
      const base = get(c.anchor);
      if (Number.isFinite(base)) startMs = Math.max(0, Math.round(base + c.offsetMs));
      else unresolved = true;
    } else {
      startMs = c.startTimeMs || 0;
    }
    const srcDur = dur(c.assetId);
    const used = c.sourceOutMs != null
      ? c.sourceOutMs - c.sourceInMs
      : Number.isFinite(srcDur) ? Math.max(0, srcDur - c.sourceInMs) : null;
    const endMs = startMs != null && used != null ? startMs + used : null;
    return { ...c, startMs, endMs, durationMs: used, unresolved };
  });
}

/** Group resolved clips by track, in TRACKS order, each sorted by start time.
 *  Unresolved clips are kept and listed FIRST on their track: they need
 *  attention, and sorting them to the end is how they get ignored. */
export function byTrack(resolved) {
  const out = [];
  for (const t of TRACKS) {
    const clips = resolved.filter((c) => c.trackType === t);
    clips.sort((a, b) => {
      if (a.unresolved !== b.unresolved) return a.unresolved ? -1 : 1;
      return (a.startMs || 0) - (b.startMs || 0);
    });
    out.push({ trackType: t, label: TRACK_LABEL[t], clips });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* automatic first pass (决策 6)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build the shot's FIRST audio arrangement from what the project already has.
 *
 *   dialogue take → Dialogue at 0
 *   scene ambience → Ambience at 0, gently faded
 *   scene / episode BGM → BGM at 0, faded, and ducked under dialogue
 *
 * WHAT IT NEVER DOES:
 *   · invent media (a shot with no dialogue take gets no dialogue clip);
 *   · touch a LOCKED clip;
 *   · touch a MANUAL clip (the creator placed it — that is the whole point);
 *   · duplicate a clip that is already there for the same asset+track.
 *
 * Returns `{ added, kept, skipped }` so the caller can report what it did
 * instead of claiming a whole arrangement it mostly left alone.
 */
export function autoArrange(doc, shotId, { dialogue = null, ambience = null, bgm = null, durationMs = null } = {}) {
  const e = entry(doc, shotId, true);
  const added = [];
  const skipped = [];
  const has = (assetId, trackType) => e.clips.some((c) => c.assetId === assetId && c.trackType === trackType);
  const protectedOn = (trackType) => e.clips.some((c) => c.trackType === trackType && (c.locked || c.origin === "manual"));

  const place = (assetId, trackType, extra) => {
    if (!assetId) return;
    if (protectedOn(trackType)) { skipped.push({ trackType, reason: "已有锁定或手工摆放的片段" }); return; }
    if (has(assetId, trackType)) { skipped.push({ trackType, reason: "这条素材已经在轨上" }); return; }
    // an AUTO clip on this track is replaced by the new pass; a manual/locked one
    // was already refused above
    e.clips = e.clips.filter((c) => !(c.trackType === trackType && c.origin === "auto"));
    const clip = makeClip({ assetId, trackType, timing: { startTimeMs: 0 }, origin: "auto", ...extra });
    if (clip) { e.clips.push(clip); added.push(clip); }
  };

  place(dialogue, "dialogue", {});
  // an ambience bed is faded in and out so a cut does not click
  place(ambience, "ambience", { gain: -8, fadeInMs: 400, fadeOutMs: 600 });
  // BGM sits under dialogue: −4 dB when there IS dialogue on this shot, which is
  // the ducking rule stated as a number rather than as a promise
  place(bgm, "bgm", { gain: dialogue ? -10 : -6, fadeInMs: 600, fadeOutMs: 900 });

  // Trim the beds to the shot when its length is known. Unknown length leaves
  // them open-ended, which the renderer handles — inventing a duration here
  // would make every shot exactly as long as we guessed.
  if (Number.isFinite(durationMs) && durationMs > 0) {
    for (const c of e.clips) {
      if (c.origin !== "auto" || c.locked) continue;
      if (c.trackType !== "ambience" && c.trackType !== "bgm") continue;
      if (c.sourceOutMs == null) c.sourceOutMs = Math.round(durationMs);
    }
  }
  return { added, kept: e.clips.filter((c) => c.locked || c.origin === "manual"), skipped };
}

/* -------------------------------------------------------------------------- */
/* the mix                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The provenance record a Shot Mix must carry (决策 6 / §38).
 *
 * Built from the RESOLVED clips, so the timings recorded are the ones the mix was
 * actually made with — not the authored anchors, which resolve differently once
 * the shot design changes. Both are kept: `anchor`/`offsetMs` say what the creator
 * asked for, `startMs`/`endMs` say where it landed.
 */
export function mixProvenance(resolved, { settings = null, versionOf = null } = {}) {
  const sources = [];
  const unresolved = [];
  for (const c of resolved) {
    if (c.muted) continue; // a muted clip is not IN the mix, so it is not claimed
    if (c.unresolved) { unresolved.push(c.clipId); continue; }
    sources.push({
      assetId: c.assetId,
      version: typeof versionOf === "function" ? (versionOf(c.assetId) ?? null) : null,
      trackType: c.trackType,
      startMs: c.startMs,
      endMs: c.endMs,
      anchor: c.anchor,
      offsetMs: c.offsetMs,
      gain: c.gain,
      fadeInMs: c.fadeInMs,
      fadeOutMs: c.fadeOutMs,
    });
  }
  return { sources, unresolved, settings: isObj(settings) ? { ...settings } : null };
}

/** Record the derived Shot Mix. The mix ASSET itself is registered by the caller
 *  through the ordinary asset write path; this only stores the pointer plus the
 *  provenance snapshot. Sources are untouched — that is the invariant. */
export function setMix(doc, shotId, { assetId, at, provenance }) {
  if (!strOrNull(assetId)) return false;
  const e = entry(doc, shotId, true);
  e.mix = sanitizeMix({
    assetId,
    at,
    sources: (provenance && provenance.sources) || [],
    settings: (provenance && provenance.settings) || null,
    unresolved: (provenance && provenance.unresolved) || [],
  });
  return !!e.mix;
}

/** Is the stored mix still describing the CURRENT arrangement?
 *
 *  Compared field by field against the resolved clips — a mix is stale when
 *  anything that went into it moved. `unknown` when there is no mix at all, which
 *  is not the same as stale. */
export function mixStanding(doc, shotId, resolved) {
  const mix = mixOf(doc, shotId);
  if (!mix) return { state: "none" };
  const now = mixProvenance(resolved).sources;
  const key = (s) => [s.assetId, s.trackType, s.startMs, s.endMs, s.gain, s.fadeInMs, s.fadeOutMs].join("|");
  const a = now.map(key).sort();
  const b = mix.sources.map(key).sort();
  const same = a.length === b.length && a.every((x, i) => x === b[i]);
  return { state: same ? "current" : "stale", mix };
}

/* -------------------------------------------------------------------------- */
/* serialization                                                              */
/* -------------------------------------------------------------------------- */

export function serialize(doc) {
  const out = {};
  if (!isObj(doc)) return out;
  for (const shotId of Object.keys(doc)) {
    const e = doc[shotId];
    if (!isObj(e)) continue;
    const clips = (Array.isArray(e.clips) ? e.clips : []).map((c) => ({
      clipId: c.clipId, assetId: c.assetId, trackType: c.trackType,
      startTimeMs: c.startTimeMs, anchor: c.anchor, offsetMs: c.offsetMs,
      sourceInMs: c.sourceInMs, sourceOutMs: c.sourceOutMs,
      gain: c.gain, fadeInMs: c.fadeInMs, fadeOutMs: c.fadeOutMs,
      muted: c.muted, locked: c.locked, origin: c.origin,
    }));
    if (!clips.length && !e.mix) continue;
    // putKey, not `out[shotId] =` — the same reason as promptdoc.serialize: a
    // plain assignment to a shotId literally named `__proto__` writes the
    // PROTOTYPE, and that shot's whole timeline vanishes from the save.
    putKey(out, shotId, { clips, mix: e.mix || null });
  }
  return out;
}

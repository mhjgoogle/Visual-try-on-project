// Frame BINDINGS (TASK-064 Phase 2 §7) — 上一镜的尾帧成为下一镜的首帧.
//
//   SH01 Video v3  ──[提取 t=5.84s]──▶  派生 Image Asset  ──▶  SH02 Start Frame
//
// This is the record that makes that sentence checkable afterwards. Every field
// the requirement names is stored, and nothing is derived at read time that
// could disagree with it:
//
//   sourceShotId · sourceVideoAssetId · sourceVideoVersion · sourceTimecodeMs
//   derivedImageAssetId · targetShotId · bindingType ("startFrame"|"endFrame")
//
// NOT A SECOND FRAME SYSTEM (§7 「不要另造一套 Frame 系统」). The EFFECTIVE start
// frame a video generation receives is still `assets.firstFrames[slot]` — the
// existing slot-level pointer the paid route, the draft lock and the provenance
// graph already read. This module does not replace it; it records WHERE that
// pointer came from, which is the one thing `firstFrames` never held. Binding
// writes both, in one call (app.js `ctx.frames.bind`), so the pointer and its
// provenance cannot drift apart. `endFrame` has no legacy pointer to mirror, so
// the binding IS the record — and the Generation Input Set reads it from here.
//
// THE UPSTREAM RULE (§7). If SH01's video moves from v3 to v4, SH02's start
// frame is NOT re-extracted and NOT replaced. The binding still names v3,
// because that is what the frame actually came from — rewriting it would make
// the record describe media it was not cut from. The creator is told, and
// chooses: 保持 / 从 v4 重新提取 / 解除绑定. Same three-way discipline as
// `mediadep.resolutionsFor`, and the state vocabulary is imported from there
// rather than re-invented.
//
// Pure state + transitions — no fetch, no DOM, no clock, no canvas. Extracting
// the pixels is the caller's job (a <video> + <canvas> in the browser); this
// module only records what was extracted and from where.

import { DEP } from "./mediadep.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const strOrNull = (x) => (typeof x === "string" && x ? x : null);
const intOrNull = (x) => (Number.isInteger(x) ? x : null);

/** The two frame ROLES a shot's generation can be given. They are slots on the
 *  TARGET shot, which is why the document is keyed by target shot id. */
export const BINDING_TYPES = ["startFrame", "endFrame"];

export const BINDING_LABEL = { startFrame: "首帧", endFrame: "尾帧" };

const TYPE_SET = new Set(BINDING_TYPES);

/** Where the frame came from. `extracted` is the one this checkpoint adds; the
 *  other two already existed as behaviours and are named here so a binding can
 *  say which it is instead of every binding looking extracted. */
export const SOURCES = ["extracted", "shot-image", "upload"];

const SOURCE_SET = new Set(SOURCES);

function putKey(obj, key, val) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = val;
  }
  return obj;
}

/**
 * Normalize ONE persisted binding. Total; never invents a provenance field.
 *
 * A binding with no `derivedImageAssetId` is dropped: a frame slot that names no
 * media is not a binding, it is a hole every later consumer has to special-case.
 *
 * An `extracted` binding that cannot name its source video is downgraded to
 * `source: "upload"` rather than kept as a half-truth — 「从 SH01 的视频里剪出来的」
 * is a claim, and a record that cannot say WHICH video must not make it.
 */
export function sanitizeBinding(saved, bindingType) {
  if (!isObj(saved)) return null;
  const derivedImageAssetId = strOrNull(saved.derivedImageAssetId);
  if (!derivedImageAssetId) return null;
  const type = TYPE_SET.has(bindingType) ? bindingType : TYPE_SET.has(saved.bindingType) ? saved.bindingType : null;
  if (!type) return null;
  const sourceShotId = strOrNull(saved.sourceShotId);
  const sourceVideoAssetId = strOrNull(saved.sourceVideoAssetId);
  const sourceVideoVersion = intOrNull(saved.sourceVideoVersion);
  let source = SOURCE_SET.has(saved.source) ? saved.source : "upload";
  if (source === "extracted" && !(sourceVideoAssetId && sourceShotId)) source = "upload";
  return {
    bindingType: type,
    derivedImageAssetId,
    source,
    // the four SOURCE facts, each independently nullable: an upload has none of
    // them and says so, rather than borrowing the previous binding's
    sourceShotId: source === "extracted" ? sourceShotId : strOrNull(saved.sourceShotId),
    sourceVideoAssetId: source === "extracted" ? sourceVideoAssetId : null,
    sourceVideoVersion: source === "extracted" ? sourceVideoVersion : null,
    // WHERE in the clip. Both are kept when both are known: milliseconds are
    // what the extraction actually seeked to, a frame number is what a creator
    // reads. A frame number alone cannot be re-seeked without the fps, so it is
    // never used to reconstruct the timecode.
    sourceTimecodeMs: Number.isFinite(saved.sourceTimecodeMs) ? Math.max(0, Math.round(saved.sourceTimecodeMs)) : null,
    sourceFrame: intOrNull(saved.sourceFrame),
    // 「最后一帧」 vs 「第 142 帧」 — the creator's INTENT, kept because it is what
    // a re-extraction should repeat. `last` re-seeks to the new video's end;
    // `at` re-seeks to the same millisecond.
    pick: saved.pick === "last" ? "last" : "at",
    at: strOrNull(saved.at),
    // a lock (决策 5 / §50): automation must not re-extract or unbind it
    locked: saved.locked === true,
  };
}

/** Hydrate from a persisted `frameBindings` field (or start empty). */
export function createFrameBindings(saved) {
  const out = Object.create(null);
  if (!isObj(saved)) return out;
  for (const targetShotId of Object.keys(saved)) {
    const e = saved[targetShotId];
    if (!isObj(e)) continue;
    const clean = {};
    for (const t of BINDING_TYPES) {
      const b = sanitizeBinding(e[t], t);
      if (b) clean[t] = b;
    }
    if (Object.keys(clean).length) putKey(out, targetShotId, clean);
  }
  return out;
}

export function bindingsOf(doc, targetShotId) {
  if (!isObj(doc) || typeof targetShotId !== "string" || !targetShotId) return {};
  const e = Object.prototype.hasOwnProperty.call(doc, targetShotId) ? doc[targetShotId] : null;
  return isObj(e) ? e : {};
}

export function bindingOf(doc, targetShotId, bindingType) {
  const e = bindingsOf(doc, targetShotId);
  const b = TYPE_SET.has(bindingType) ? e[bindingType] : null;
  return isObj(b) ? b : null;
}

/**
 * Record a binding. Returns the stored binding, or null when refused.
 *
 * REFUSED when the existing binding is LOCKED and the write is not the
 * creator's own — `force` is passed by the creator's own action and never by
 * Auto Rough Cut or a Skill proposal.
 */
export function bind(doc, targetShotId, bindingType, binding, { force = false } = {}) {
  if (!isObj(doc) || typeof targetShotId !== "string" || !targetShotId) return null;
  if (!TYPE_SET.has(bindingType)) return null;
  const prev = bindingOf(doc, targetShotId, bindingType);
  if (prev && prev.locked && !force) return null;
  const next = sanitizeBinding({ ...binding, bindingType }, bindingType);
  if (!next) return null;
  // a lock survives a re-bind the creator themselves made: unlocking is an
  // explicit separate act, and silently clearing it here would make the lock
  // mean 「until you touch it again」
  if (prev && prev.locked) next.locked = true;
  let e = Object.prototype.hasOwnProperty.call(doc, targetShotId) ? doc[targetShotId] : null;
  if (!isObj(e)) {
    e = {};
    putKey(doc, targetShotId, e);
  }
  e[bindingType] = next;
  return next;
}

/** Remove a binding (解除绑定). The derived image Asset is NOT touched — it is a
 *  registered asset with its own provenance, and unbinding is a statement about
 *  this shot, not a delete. A LOCKED binding refuses. */
export function unbind(doc, targetShotId, bindingType, { force = false } = {}) {
  const b = bindingOf(doc, targetShotId, bindingType);
  if (!b) return false;
  if (b.locked && !force) return false;
  const e = doc[targetShotId];
  delete e[bindingType];
  if (!Object.keys(e).length) delete doc[targetShotId];
  return true;
}

export function setLocked(doc, targetShotId, bindingType, on) {
  const b = bindingOf(doc, targetShotId, bindingType);
  if (!b) return false;
  b.locked = on === true;
  return true;
}

/**
 * Is this binding still describing the CURRENT state of its source video?
 *
 * Returns one of `mediadep.DEP` — the SAME five-state vocabulary the studio
 * already uses for image→video drift, because this is the same kind of fact:
 *
 *   none      not an extracted binding (an upload has no upstream to be behind)
 *   unknown   the record does not say which version it came from, OR the source
 *             chain has no active version to compare against. 「未记录」 is not
 *             「落后」 and must not be reported as it.
 *   current   the source video version IS the one the source shot has active
 *   outdated  the source shot's active version moved FORWARD past it
 *   diverged  the source shot's active version is EARLIER (the creator went back)
 *
 * `activeSourceVersion` is the source SHOT's currently active video version.
 */
export function bindingStanding(binding, activeSourceVersion) {
  if (!isObj(binding) || binding.source !== "extracted") return DEP.NONE;
  if (!Number.isInteger(activeSourceVersion)) return DEP.UNKNOWN;
  if (!Number.isInteger(binding.sourceVideoVersion)) return DEP.UNKNOWN;
  if (binding.sourceVideoVersion === activeSourceVersion) return DEP.CURRENT;
  return binding.sourceVideoVersion < activeSourceVersion ? DEP.OUTDATED : DEP.DIVERGED;
}

/** The exact three choices §7 requires, as data. Nothing here picks one, and
 *  nothing rewrites the binding on its own — that is the whole rule.
 *
 *  A `current` / `unknown` / `none` standing offers none: there is nothing to
 *  resolve, and for `unknown` there is no known basis to resolve TOWARDS. */
export function resolutionsFor(state, { activeSourceVersion = null } = {}) {
  if (state !== DEP.OUTDATED && state !== DEP.DIVERGED) return [];
  return [
    { action: "keep", label: "保持当前首帧" },
    {
      action: "reextract",
      label: Number.isInteger(activeSourceVersion) ? `从 v${activeSourceVersion} 重新提取` : "从当前版本重新提取",
      version: Number.isInteger(activeSourceVersion) ? activeSourceVersion : null,
    },
    { action: "unbind", label: "解除绑定" },
  ];
}

/**
 * The one line a shot's frame slot shows about upstream drift, or null.
 *
 * `sourceActive(shotId)` returns the ACTIVE video version of a shot, or null
 * when it has none — passed as a function so this module never reaches into the
 * asset registry.
 */
export function frameNotice(binding, sourceActive) {
  if (!isObj(binding) || binding.source !== "extracted") return null;
  const active = typeof sourceActive === "function" ? sourceActive(binding.sourceShotId) : null;
  const state = bindingStanding(binding, Number.isInteger(active) ? active : null);
  if (state !== DEP.OUTDATED && state !== DEP.DIVERGED) return null;
  return {
    state,
    bindingType: binding.bindingType,
    sourceShotId: binding.sourceShotId,
    sourceVideoVersion: binding.sourceVideoVersion,
    activeSourceVersion: Number.isInteger(active) ? active : null,
    resolutions: resolutionsFor(state, { activeSourceVersion: Number.isInteger(active) ? active : null }),
  };
}

/** A human sentence for the Generation Input Set and the Inspector. Exported so
 *  the two surfaces cannot describe the same binding differently. */
export function describeBinding(binding, { shotName = null } = {}) {
  if (!isObj(binding)) return "";
  if (binding.source !== "extracted") {
    return binding.source === "shot-image" ? "本镜头画面" : "上传的帧";
  }
  const who = shotName || (binding.sourceShotId ? binding.sourceShotId.slice(0, 8) : "未记录的镜头");
  const ver = Number.isInteger(binding.sourceVideoVersion) ? ` 视频 v${binding.sourceVideoVersion}` : " 视频（版本未记录）";
  const at = binding.pick === "last"
    ? " · 尾帧"
    : Number.isFinite(binding.sourceTimecodeMs)
      ? ` · ${(binding.sourceTimecodeMs / 1000).toFixed(2)}s`
      : "";
  return `${who}${ver}${at}`;
}

export function serialize(doc) {
  const out = {};
  if (!isObj(doc)) return out;
  for (const targetShotId of Object.keys(doc)) {
    const e = doc[targetShotId];
    if (!isObj(e)) continue;
    const clean = {};
    for (const t of BINDING_TYPES) {
      const b = e[t];
      if (!isObj(b)) continue;
      clean[t] = {
        bindingType: b.bindingType,
        derivedImageAssetId: b.derivedImageAssetId,
        source: b.source,
        sourceShotId: b.sourceShotId,
        sourceVideoAssetId: b.sourceVideoAssetId,
        sourceVideoVersion: b.sourceVideoVersion,
        sourceTimecodeMs: b.sourceTimecodeMs,
        sourceFrame: b.sourceFrame,
        pick: b.pick,
        at: b.at,
        locked: b.locked === true,
      };
    }
    if (Object.keys(clean).length) putKey(out, targetShotId, clean);
  }
  return out;
}

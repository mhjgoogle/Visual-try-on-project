// Reference INTERPRETATION (ADR-0061 决策 4 / TASK-064 Phase 2 §21–§22) — what a
// directing reference SAYS, in words a prompt can carry.
//
//   Video Style · Motion · Camera · Performance Reference
//     → read by a Skill (or written by the creator)
//     → six axes: 运镜 / 运动 / 表演 / 构图 / 光线 / 节奏
//     → compiled INTO the Prompt (workflow/promptc.js)
//
// WHY THIS EXISTS. Today's image/video models do not ingest a motion clip. The
// wrong conclusions from that fact are (a) refuse the reference, and (b) accept
// it and quietly drop it at generation time — the second is worse, because the
// creator sees their reference listed and believes it is doing something.
// 「Video Reference ≠ 必须直接传入 Video API」: the reference's value is
// interpretive, so it is INTERPRETED and the interpretation is what travels.
//
// NOTHING HERE INFERS ANYTHING FROM THE MEDIA. This module stores a reading that
// a human or a named Skill Run produced, with its provenance. A file called
// `dolly_in.mp4` does not license us to write 「缓慢推进」 into a prompt — that is
// a guess dressed as a directing note, and it would be indistinguishable in the
// prompt from something the creator actually decided.
//
// KEYED BY REFERENCE, NOT BY SHOT. A canonical Reference is one shared thing
// (ADR-0055 决策 3); 「这段素材的运镜是什么」 has one answer regardless of which
// shot points at it. Per-shot deviations belong in the shot's own Prompt version.
//
// NON-DESTRUCTIVE (决策 5): a new reading appends as a version, the active one is
// a pointer, and a LOCKED reading refuses every non-manual write.
//
// Pure state + transitions — no fetch, no DOM, no clock (the caller passes `at`).

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const strOrNull = (x) => (typeof x === "string" && x.trim() ? x : null);

/** The six axes a directing reference is read along, in the order a creator
 *  states them. Deliberately a closed list: an open free-text bag would let two
 *  Skills write 「camera」 and 「运镜」 and make the prompt carry both. */
export const AXES = [
  ["cameraLanguage", "运镜"],
  ["movement", "运动"],
  ["performance", "表演"],
  ["composition", "构图"],
  ["lighting", "光线"],
  ["pacing", "节奏"],
];

export const AXIS_KEYS = AXES.map(([k]) => k);
export const AXIS_LABEL = Object.fromEntries(AXES);

const AXIS_SET = new Set(AXIS_KEYS);

/** Where a reading came from. `skill` carries a skillRunId; `manual` is the
 *  creator's own words. There is deliberately no 「derived」: nothing in this
 *  system may produce a reading without a named author. */
export const ORIGINS = ["manual", "skill"];
const ORIGIN_SET = new Set(ORIGINS);

function putKey(obj, key, val) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = val;
  }
  return obj;
}

/** Normalize one axis bag: known axes only, non-empty trimmed strings only.
 *  An axis the author did not answer stays ABSENT rather than becoming "" —
 *  「没说」 and 「说了空」 mean different things to the prompt compiler, and only
 *  the first one is honest about an unanswered axis. */
export function sanitizeAxes(saved) {
  const out = {};
  if (!isObj(saved)) return out;
  for (const k of AXIS_KEYS) {
    const v = saved[k];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t) out[k] = t;
  }
  return out;
}

function sanitizeVersion(v) {
  if (!isObj(v)) return null;
  if (!Number.isInteger(v.v) || v.v < 1) return null;
  const axes = sanitizeAxes(v.axes);
  // a reading that answers NO axis says nothing; keeping it would put an empty
  // version in the history and make 「已解读」 true of a reference nobody read
  if (!Object.keys(axes).length) return null;
  return {
    v: v.v,
    axes,
    origin: ORIGIN_SET.has(v.origin) ? v.origin : "manual",
    at: strOrNull(v.at),
    skillRunId: strOrNull(v.skillRunId),
    proposalId: strOrNull(v.proposalId),
  };
}

function sanitizeEntry(e) {
  if (!isObj(e)) return null;
  const versions = (Array.isArray(e.versions) ? e.versions : [])
    .map(sanitizeVersion)
    .filter(Boolean)
    .sort((a, b) => a.v - b.v);
  if (!versions.length) return null;
  const active = versions.some((x) => x.v === e.active)
    ? e.active
    : versions[versions.length - 1].v;
  return { active, locked: e.locked === true, versions };
}

/** Hydrate from a persisted `refInterp` field (or start empty). */
export function createInterpretations(saved) {
  const out = Object.create(null);
  if (!isObj(saved)) return out;
  for (const key of Object.keys(saved)) {
    const e = sanitizeEntry(saved[key]);
    if (e) putKey(out, key, e);
  }
  return out;
}

export function entryOf(doc, refKey) {
  if (!isObj(doc) || typeof refKey !== "string" || !refKey) return null;
  const e = Object.prototype.hasOwnProperty.call(doc, refKey) ? doc[refKey] : null;
  return isObj(e) ? e : null;
}

/** The ACTIVE reading of one reference, or null when nobody has read it.
 *  Null is a first-class answer: the UI says 「尚未解读」 and the prompt compiler
 *  reports it as a gap rather than filling it in. */
export function activeReading(doc, refKey) {
  const e = entryOf(doc, refKey);
  if (!e) return null;
  const v = e.versions.find((x) => x.v === e.active) || e.versions[e.versions.length - 1];
  if (!v) return null;
  return {
    axes: { ...v.axes },
    version: v.v,
    origin: v.origin,
    at: v.at,
    skillRunId: v.skillRunId,
    proposalId: v.proposalId,
    locked: e.locked === true,
  };
}

/** Append a NEW reading and make it active. Returns the version, or 0 when
 *  refused.
 *
 *  REFUSED when the entry is LOCKED and the write is not the creator's own
 *  (决策 5): a Skill re-run must not overwrite a reading a human settled on. */
export function addReading(doc, refKey, { axes, origin = "manual", at = null, skillRunId = null, proposalId = null } = {}) {
  if (!isObj(doc) || typeof refKey !== "string" || !refKey) return 0;
  const clean = sanitizeAxes(axes);
  if (!Object.keys(clean).length) return 0;
  const o = ORIGIN_SET.has(origin) ? origin : "manual";
  let e = Object.prototype.hasOwnProperty.call(doc, refKey) ? doc[refKey] : null;
  if (!isObj(e)) {
    e = { active: 0, locked: false, versions: [] };
    putKey(doc, refKey, e);
  }
  if (e.locked === true && o !== "manual") return 0;
  const v = e.versions.reduce((n, x) => Math.max(n, x.v), 0) + 1;
  e.versions.push({
    v,
    axes: clean,
    origin: o,
    at: strOrNull(at),
    skillRunId: strOrNull(skillRunId),
    proposalId: strOrNull(proposalId),
  });
  e.active = v;
  return v;
}

/** Move the ACTIVE pointer. Never deletes. */
export function setActive(doc, refKey, version) {
  const e = entryOf(doc, refKey);
  if (!e || !e.versions.some((x) => x.v === version)) return false;
  e.active = version;
  return true;
}

export function setLocked(doc, refKey, on) {
  const e = entryOf(doc, refKey);
  if (!e) return false;
  e.locked = on === true;
  return true;
}

/**
 * The interpretation INPUTS of one generation, in the shape the prompt compiler
 * and the Generation Input Set both read.
 *
 * `refs` are the shot's bound references already resolved to
 * `{ key, kind, name, version }`; `only` restricts to the interpretation kinds.
 *
 * A bound reference with no reading is returned with `axes: {}` and
 * `read: false` — LISTED, not silently dropped. That is the whole point: the
 * creator can see that they attached a motion reference nothing has read yet,
 * and the compiler can report it as a gap with the fix (run 参考解读).
 */
export function interpretationInputs(doc, refs, only) {
  const want = only instanceof Set ? only : new Set(Array.isArray(only) ? only : []);
  const out = [];
  for (const r of Array.isArray(refs) ? refs : []) {
    if (!isObj(r) || !r.key) continue;
    if (want.size && !want.has(r.kind)) continue;
    const reading = activeReading(doc, r.key);
    out.push({
      key: r.key,
      kind: r.kind,
      name: typeof r.name === "string" ? r.name : "",
      version: r.version ?? null,
      assetId: r.assetId ?? null,
      axes: reading ? reading.axes : {},
      read: !!reading,
      readingVersion: reading ? reading.version : null,
      readingOrigin: reading ? reading.origin : null,
      locked: reading ? reading.locked : false,
    });
  }
  return out;
}

/** MERGE several readings into one per-axis statement, keeping WHO said what.
 *
 *  Axis values are joined rather than picked: two references legitimately
 *  contribute different things to 运镜, and choosing one would drop a reference
 *  the creator deliberately attached. Each contribution is attributed by
 *  reference name, so a prompt reader can tell them apart — and so a
 *  contradiction is visible instead of being resolved by silent precedence. */
export function mergeAxes(inputs) {
  const out = {};
  for (const k of AXIS_KEYS) {
    const bits = [];
    for (const i of Array.isArray(inputs) ? inputs : []) {
      const v = i && i.axes ? i.axes[k] : null;
      if (typeof v === "string" && v.trim()) bits.push({ from: i.name || "", text: v.trim() });
    }
    if (bits.length) out[k] = bits;
  }
  return out;
}

export function serialize(doc) {
  const out = {};
  if (!isObj(doc)) return out;
  for (const key of Object.keys(doc)) {
    const e = doc[key];
    if (!isObj(e) || !Array.isArray(e.versions) || !e.versions.length) continue;
    putKey(out, key, {
      active: e.active,
      locked: e.locked === true,
      versions: e.versions.map((v) => ({
        v: v.v, axes: { ...v.axes }, origin: v.origin, at: v.at,
        skillRunId: v.skillRunId, proposalId: v.proposalId,
      })),
    });
  }
  return out;
}

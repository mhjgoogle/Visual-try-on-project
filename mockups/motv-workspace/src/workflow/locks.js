// LOCK (ADR-0061 决策 5 / TASK-064 Phase 3 §50) — the creator's 「这个我定了」.
//
//   AI Draft → Human Tune → LOCK → AI Continue
//
// The working mode Phase 3 is built around only holds if the last step cannot
// undo the middle one. Auto Rough Cut, Auto Mix, 重新初剪 and every applied Skill
// proposal are automated WRITERS; a lock is the one thing that makes them skip
// something instead of improving it away.
//
// WHY A SHARED DOCUMENT. Three lock flags already existed, each stored next to
// the thing it protects: `promptdoc` entry.locked, `shotaudio` clip.locked,
// `framebind` binding.locked. Those stay — a lock belongs with its object, and
// moving them would break the guards already enforcing them. What was missing is
// a lock for objects that have nowhere to put a flag of their own: a shot's
// IMAGE selection, its VIDEO selection, a reference BINDING, a timeline clip, a
// subtitle cue. This module is that, and `isLocked` is the single predicate every
// automated writer consults, so a new automated writer cannot silently be exempt.
//
// A LOCK IS A STATEMENT, NOT A DERIVATION. It is stored, never inferred from
// 「这个看起来已经定稿了」 — and it is only ever set by an explicit human action.
// `origin: "ai"` is refused outright by `set`: an automation that could lock
// things would be able to protect its own output from the creator.
//
// Pure state + transitions — no fetch, no DOM, no clock (the caller passes `at`).

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const strOrNull = (x) => (typeof x === "string" && x ? x : null);

/**
 * Every lockable SCOPE, with the id shape it is keyed by and what an automated
 * writer must therefore skip. §50 names eight things; three of them already own
 * their flag and are listed here as `owned` so this table stays the complete
 * inventory rather than the half that happens to live in this file.
 */
export const SCOPES = {
  // --- kept here ----------------------------------------------------------- //
  reference: { id: "shotId", label: "参考绑定", of: "这个镜头绑定了哪些参考" },
  image: { id: "shotId", label: "画面选择", of: "这个镜头用哪一版画面" },
  video: { id: "shotId", label: "视频选择", of: "这个镜头用哪一条 take" },
  timelineClip: { id: "clipId", label: "剪辑片段", of: "这一段在成片时间线上的位置与素材" },
  subtitle: { id: "cueId", label: "字幕", of: "这一条字幕的文本与时间" },
  // --- owned by the object's own document, listed for completeness ---------- //
  prompt: { id: "shotId+kind", label: "Prompt", of: "这个镜头的 Prompt", owned: "workflow/promptdoc.js" },
  audioClip: { id: "clipId", label: "音频片段", of: "摆放 / gain / fade", owned: "workflow/shotaudio.js" },
  frameBinding: { id: "shotId+type", label: "首/尾帧绑定", of: "首帧来自哪里", owned: "workflow/framebind.js" },
};

/** The scopes THIS document stores. Derived, so a scope cannot be added to the
 *  table and forgotten by the store (or stored twice). */
export const OWN_SCOPES = Object.keys(SCOPES).filter((k) => !SCOPES[k].owned);

const OWN_SET = new Set(OWN_SCOPES);

export const SCOPE_LABEL = Object.fromEntries(
  Object.entries(SCOPES).map(([k, v]) => [k, v.label]),
);

function putKey(obj, key, val) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = val;
  }
  return obj;
}

function sanitizeLock(saved) {
  if (saved === true) return { at: null, note: "" }; // legacy/compact form
  if (!isObj(saved)) return null;
  return { at: strOrNull(saved.at), note: typeof saved.note === "string" ? saved.note : "" };
}

/** Hydrate from a persisted `locks` field (or start empty). Unknown scopes are
 *  DROPPED rather than carried: a lock in a scope nothing consults would look
 *  like protection and provide none. */
export function createLocks(saved) {
  const out = Object.create(null);
  for (const s of OWN_SCOPES) out[s] = Object.create(null);
  if (!isObj(saved)) return out;
  for (const scope of Object.keys(saved)) {
    if (!OWN_SET.has(scope)) continue;
    const m = saved[scope];
    if (!isObj(m)) continue;
    for (const id of Object.keys(m)) {
      const l = sanitizeLock(m[id]);
      if (l && id) putKey(out[scope], id, l);
    }
  }
  return out;
}

/** Is this object locked? The ONE predicate every automated writer calls.
 *
 *  An unknown scope answers FALSE rather than throwing — but see `set`, which
 *  refuses to create one. A guard that throws on a typo'd scope would take down
 *  the whole Rough Cut; a guard that answers false lets the write through, which
 *  is why the refusal lives on the write side where it can be reported. */
export function isLocked(doc, scope, id) {
  if (!isObj(doc) || !OWN_SET.has(scope)) return false;
  const m = doc[scope];
  if (!isObj(m) || typeof id !== "string" || !id) return false;
  return Object.prototype.hasOwnProperty.call(m, id);
}

export function lockOf(doc, scope, id) {
  if (!isLocked(doc, scope, id)) return null;
  return doc[scope][id];
}

/**
 * Lock / unlock. Returns true when the state CHANGED.
 *
 * `origin` must be "user". An AI-origin lock is refused: the automation level in
 * force is 「AI 建议 → 你确认 → 执行」 (workflow/actions.js), and a lock an
 * automation could set would let it exempt its own output from the creator's
 * next edit — the exact inversion of what a lock is for.
 */
export function set(doc, scope, id, on, { at = null, note = "", origin = "user" } = {}) {
  if (!isObj(doc) || !OWN_SET.has(scope)) return false;
  if (origin !== "user") return false;
  if (typeof id !== "string" || !id) return false;
  const m = doc[scope];
  const had = Object.prototype.hasOwnProperty.call(m, id);
  if (on === true) {
    if (had) return false;
    putKey(m, id, { at: strOrNull(at), note: typeof note === "string" ? note : "" });
    return true;
  }
  if (!had) return false;
  delete m[id];
  return true;
}

/** Every lock in one scope, as `[id, lock][]` — for a 「已锁定 N 项」 readout that
 *  cannot disagree with what the guards actually see. */
export function listScope(doc, scope) {
  if (!isObj(doc) || !OWN_SET.has(scope)) return [];
  const m = doc[scope];
  return Object.keys(m).map((id) => [id, m[id]]);
}

/** Total locks across every scope this document stores. */
export function count(doc) {
  return OWN_SCOPES.reduce((n, s) => n + listScope(doc, s).length, 0);
}

export function serialize(doc) {
  const out = {};
  if (!isObj(doc)) return out;
  for (const scope of OWN_SCOPES) {
    const rows = listScope(doc, scope);
    if (!rows.length) continue;
    const m = {};
    for (const [id, l] of rows) putKey(m, id, { at: l.at, note: l.note });
    out[scope] = m;
  }
  return out;
}

// 参考用途 (TASK-066 §4 / §5) — 「这个参考服务主要画面，还是视频编排，还是两者」.
//
// WHY A DOCUMENT AT ALL. A shot's bindings are a FLAT KEY LIST
// (`shotProduction.references[shotId]`) with no per-binding metadata, and which
// prompt a reference reaches is derived from its ROLE (geninput.ROLE_USE). That
// derivation is right by default — a 人物参考 belongs in the picture, a 运动参考
// belongs in the motion — but the creator has to be able to say otherwise per card,
// and there is nowhere on a bare key list to write that.
//
// SO: a small document beside the binding, exactly the shape `promptdoc` and
// `refinterp` already use in this codebase:
//
//   refUse[shotId][refKey] = "image" | "video" | "both"
//
// DERIVED DEFAULT, EXPLICIT OVERRIDE — the rule that makes this migration-free:
//
//   no record  →  fall back to the ROLE's own side (today's behaviour, exactly)
//   a record   →  the creator said so, and it wins
//
// An existing project therefore behaves identically until somebody touches a menu.
// Nothing here is ever written by automation: a Skill proposal goes through the
// Action Layer like every other write.
//
// WHAT IS NOT OFFERED IS AS IMPORTANT AS WHAT IS (§5 「语义允许时」). `allowedUses`
// answers from what the COMPILERS actually read, so the menu can never show a switch
// the prompt compiler ignores — a control that changes nothing is worse than a
// missing one, because the creator believes it worked.
//
// Pure state + transitions — no fetch, no DOM, no clock.

import { ROLE_USE } from "./geninput.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/** The three sides a reference can serve. */
export const USES = ["image", "video", "both"];

const USE_SET = new Set(USES);

export const USE_LABEL = {
  image: "用于主要画面",
  video: "用于视频编排",
  both: "同时用于两者",
};

/** Short label for the card chip — the menu says 「用于…」, the chip just names it. */
export const USE_CHIP = { image: "主要画面", video: "视频编排", both: "两者" };

/**
 * Which sides a role may serve, from what the compilers really read
 * (workflow/promptc.js):
 *
 *   人物 / 场景 / 道具        `compileImagePrompt` names them as attachments.
 *                            `compileVideoPrompt` does NOT — so 「用于视频编排」
 *                            would be a switch that changes no prompt.
 *   风格                      BOTH compile it (`modelRefLine` in each).
 *   视频风格 / 运动 / 机位 / 表演
 *                            BOTH compile the interpretation block, so both sides
 *                            are real — the video side is the point of them, the
 *                            image side genuinely affects 构图 / 光线.
 *
 * Returns the allowed subset of USES, always including `defaultUse(role)`.
 */
export function allowedUses(role) {
  const use = ROLE_USE[role];
  if (!use) return ["image"];
  if (use === "ai-interpretation") return ["video", "image", "both"];
  if (role === "style-reference") return ["image", "video", "both"];
  // a picture of a person / place / prop reaches the picture, and only the picture
  return ["image"];
}

/** The side a role serves when the creator has said nothing. This IS today's
 *  behaviour, so an untouched project is unaffected by this document existing. */
export function defaultUse(role) {
  return ROLE_USE[role] === "ai-interpretation" ? "video" : "image";
}

/** Safe own-property write: a shotId is arbitrary persisted text and could literally
 *  be `__proto__`, which on a plain object mutates the prototype instead of storing
 *  an entry. Same rule as mediaref.putKey / promptdoc.putKey. */
function putKey(obj, key, val) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = val;
  }
  return obj;
}

/** Hydrate from a persisted `refUse` field (or start empty). An unusable entry is
 *  DROPPED rather than repaired into a choice the creator never made — the derived
 *  default then applies, which is the honest fallback. */
export function createRefUse(saved) {
  const out = Object.create(null);
  if (!isObj(saved)) return out;
  for (const shotId of Object.keys(saved)) {
    const perShot = saved[shotId];
    if (!isObj(perShot)) continue;
    const clean = Object.create(null);
    for (const refKey of Object.keys(perShot)) {
      if (USE_SET.has(perShot[refKey])) putKey(clean, refKey, perShot[refKey]);
    }
    if (Object.keys(clean).length) putKey(out, shotId, clean);
  }
  return out;
}

/** The creator's explicit choice for one binding, or null when they made none. */
export function overrideOf(doc, shotId, refKey) {
  if (!isObj(doc) || typeof shotId !== "string" || typeof refKey !== "string") return null;
  const perShot = Object.prototype.hasOwnProperty.call(doc, shotId) ? doc[shotId] : null;
  if (!isObj(perShot)) return null;
  const v = Object.prototype.hasOwnProperty.call(perShot, refKey) ? perShot[refKey] : null;
  return USE_SET.has(v) ? v : null;
}

/**
 * The EFFECTIVE side one binding serves, plus where that came from.
 *
 * `{ use, source }` where source is `"creator"` or `"role"`. The source is carried
 * because the card has to be able to say 「这是你设的」 vs 「按类型推导」 — a creator
 * who cannot tell the two apart cannot tell whether their click took effect.
 *
 * An override that the ROLE does not allow is IGNORED (falls back to the derived
 * side): it would name a prompt that never reads this reference, and honouring it
 * would make the card claim an input the compiler drops.
 */
export function effectiveUse(doc, shotId, refKey, role) {
  const want = overrideOf(doc, shotId, refKey);
  if (want && allowedUses(role).includes(want)) return { use: want, source: "creator" };
  return { use: defaultUse(role), source: "role" };
}

/** Does this binding feed the IMAGE prompt? */
export function feedsImage(doc, shotId, refKey, role) {
  const { use } = effectiveUse(doc, shotId, refKey, role);
  return use === "image" || use === "both";
}

/** Does this binding feed the VIDEO prompt? */
export function feedsVideo(doc, shotId, refKey, role) {
  const { use } = effectiveUse(doc, shotId, refKey, role);
  return use === "video" || use === "both";
}

/**
 * Record a choice. Returns true when the document changed.
 *
 * Setting the value back to the ROLE's own default DELETES the entry rather than
 * storing it: 「按类型推导」 and 「创作者恰好选了同一边」 must not be the same record,
 * or a later change to the role's default would silently stop applying to a shot
 * that never asked to opt out.
 */
export function setUse(doc, shotId, refKey, use, role) {
  if (!isObj(doc) || typeof shotId !== "string" || !shotId) return false;
  if (typeof refKey !== "string" || !refKey) return false;
  if (!USE_SET.has(use) || !allowedUses(role).includes(use)) return false;
  const prev = overrideOf(doc, shotId, refKey);
  if (use === defaultUse(role)) return clearUse(doc, shotId, refKey);
  if (prev === use) return false;
  let perShot = Object.prototype.hasOwnProperty.call(doc, shotId) ? doc[shotId] : null;
  if (!isObj(perShot)) {
    perShot = Object.create(null);
    putKey(doc, shotId, perShot);
  }
  putKey(perShot, refKey, use);
  return true;
}

/** Drop the override, returning this binding to its derived side. */
export function clearUse(doc, shotId, refKey) {
  const perShot = isObj(doc) && Object.prototype.hasOwnProperty.call(doc, shotId) ? doc[shotId] : null;
  if (!isObj(perShot) || !Object.prototype.hasOwnProperty.call(perShot, refKey)) return false;
  delete perShot[refKey];
  if (!Object.keys(perShot).length) delete doc[shotId];
  return true;
}

/** Forget everything about one shot — used when a binding is removed, so a stale
 *  override cannot come back to life if the same reference is bound again later. */
export function forget(doc, shotId, refKey) {
  return clearUse(doc, shotId, refKey);
}

/** Serialize for persistence. Empty shots are omitted; the whole document is
 *  omitted by the caller when nothing is overridden at all. */
export function serialize(doc) {
  const out = Object.create(null);
  if (!isObj(doc)) return out;
  for (const shotId of Object.keys(doc)) {
    const perShot = doc[shotId];
    if (!isObj(perShot)) continue;
    const clean = Object.create(null);
    for (const refKey of Object.keys(perShot)) {
      // `putKey` ON THE WRITE SIDE TOO. The read side (`createRefUse`) already used
      // it, and using plain assignment here is the exact asymmetry TASK-064 was bitten
      // by: a shotId or refKey that is literally `__proto__` sets the PROTOTYPE instead
      // of storing an entry, so that shot's override is silently dropped on save and
      // gone after reload. Both sides or neither (codex review round 1).
      if (USE_SET.has(perShot[refKey])) putKey(clean, refKey, perShot[refKey]);
    }
    if (Object.keys(clean).length) putKey(out, shotId, clean);
  }
  return out;
}

/**
 * Split a shot's resolved references into the TWO GROUPS the left column shows
 * (§4). A reference set to `both` appears in BOTH groups — that is what 「同时」
 * means, and showing it once with a footnote would hide half of what it does.
 *
 * `references` is `ctx.episode.referencesOfShot(shotId)` output. Each returned row
 * carries its effective use and where that came from, so the card can render the
 * chip and the menu's current selection from one derivation.
 */
export function groupsForShot(doc, shotId, references) {
  const rows = (Array.isArray(references) ? references : []).map((r) => {
    const eff = effectiveUse(doc, shotId, r.key, r.kind);
    return { ...r, use: eff.use, useSource: eff.source, allowed: allowedUses(r.kind) };
  });
  return {
    image: rows.filter((r) => r.use === "image" || r.use === "both"),
    video: rows.filter((r) => r.use === "video" || r.use === "both"),
    all: rows,
  };
}

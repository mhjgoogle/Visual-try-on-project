// Per-shot Prompt versions (ADR-0061 决策 5) — the document behind the Prompt
// Inspector's 「Prompt Version / 历史 / 回切」.
//
// Until now a shot's prompt was COMPILED on every render from the shot design +
// its references, and never stored. That is right as a default — the compiled
// prompt cannot go stale — but it leaves three things impossible:
//
//   · a creator's hand-edited prompt survives nothing (not even a re-render);
//   · a Prompt Director proposal has nowhere to be applied TO;
//   · Lock (决策 5) has no object to lock.
//
// So this module stores the OVERRIDES only. A shot with no entry here has no
// prompt of its own and the compiled one is used — which stays the honest
// default, not a value someone typed.
//
//   prompts[shotId][kind] = { active, locked, versions: [{ v, text, origin, at,
//                                                          skillRunId, proposalId }] }
//
//   origin: "manual" | "compiled" | "skill"
//
// NON-DESTRUCTIVE (决策 5): a new version appends. Switching the active version
// moves a pointer. Nothing here deletes a version, ever.
//
// Pure state + transitions — no fetch, no DOM, no clock (the caller passes `at`).

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const strOrNull = (x) => (typeof x === "string" && x ? x : null);

export const PROMPT_KINDS = ["image", "video"];
export const PROMPT_ORIGINS = ["manual", "compiled", "skill"];

const KIND_SET = new Set(PROMPT_KINDS);
const ORIGIN_SET = new Set(PROMPT_ORIGINS);

/** Safe own-property write: a shotId is arbitrary persisted text and could
 *  literally be `__proto__`, which on a plain object would mutate the prototype
 *  instead of storing an entry. Same rule as mediaref.putKey. */
function putKey(obj, key, val) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = val;
  }
  return obj;
}

function sanitizeVersion(v) {
  if (!isObj(v)) return null;
  if (!Number.isInteger(v.v) || v.v < 1) return null;
  if (typeof v.text !== "string") return null;
  return {
    v: v.v,
    text: v.text,
    origin: ORIGIN_SET.has(v.origin) ? v.origin : "manual",
    at: strOrNull(v.at),
    // WHICH run produced it, when it came from one. Null for a hand edit — an
    // absent provenance is a fact, not something to fill in with the most
    // recent run that happens to exist.
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
  // `active: 0` is a REAL state, not a corrupt pointer: 「用自动编译，但保留我写过
  // 的版本」. Without it the only way back to the compiled prompt was to have
  // never saved one — so 「回到自动编译」 could not actually do what it said
  // (codex review round 2).
  const active = e.active === 0 || versions.some((x) => x.v === e.active)
    ? e.active
    : versions[versions.length - 1].v;
  return { active, locked: e.locked === true, versions };
}

/** Hydrate from a persisted `prompts` field (or start empty). A corrupt entry is
 *  dropped rather than repaired into something the creator never wrote. */
export function createPrompts(saved) {
  const out = Object.create(null);
  if (!isObj(saved)) return out;
  for (const shotId of Object.keys(saved)) {
    const perShot = saved[shotId];
    if (!isObj(perShot)) continue;
    const clean = Object.create(null);
    for (const kind of PROMPT_KINDS) {
      const e = sanitizeEntry(perShot[kind]);
      if (e) clean[kind] = e;
    }
    if (Object.keys(clean).length) putKey(out, shotId, clean);
  }
  return out;
}

/** The stored entry for one shot+kind, or null when the compiled prompt is in
 *  force. Read-only. */
export function entryOf(doc, shotId, kind) {
  if (!isObj(doc) || typeof shotId !== "string" || !shotId || !KIND_SET.has(kind)) return null;
  const perShot = Object.prototype.hasOwnProperty.call(doc, shotId) ? doc[shotId] : null;
  if (!isObj(perShot)) return null;
  const e = perShot[kind];
  return isObj(e) ? e : null;
}

/** The EFFECTIVE prompt: the active stored version, or `compiled` when there is
 *  none. `source` says which — a UI that cannot tell them apart would present a
 *  derived value as something the creator authored. */
export function effectivePrompt(doc, shotId, kind, compiled) {
  const e = entryOf(doc, shotId, kind);
  const asCompiled = (locked = false) => ({
    text: typeof compiled === "string" ? compiled : "",
    source: "compiled",
    version: 0,
    locked,
  });
  if (!e) return asCompiled();
  // active 0 = 「回到自动编译」: the saved versions are all still there, they are
  // simply not in force.
  if (e.active === 0) return asCompiled(e.locked === true);
  const v = e.versions.find((x) => x.v === e.active) || e.versions[e.versions.length - 1];
  return { text: v.text, source: v.origin, version: v.v, locked: e.locked === true, at: v.at };
}

/** Append a NEW version and make it active. Returns the version number, or 0
 *  when refused.
 *
 *  REFUSED when the entry is LOCKED and the write is not the creator's own
 *  (决策 5 / §50): automation must not overwrite what a human locked. A manual
 *  edit still lands — locking protects against `Auto`, not against yourself —
 *  and unlocking is one click away for anything else. */
export function addVersion(doc, shotId, kind, { text, origin = "manual", at = null, skillRunId = null, proposalId = null } = {}) {
  if (!isObj(doc) || typeof shotId !== "string" || !shotId) return 0;
  if (!KIND_SET.has(kind) || typeof text !== "string") return 0;
  const o = ORIGIN_SET.has(origin) ? origin : "manual";
  let perShot = Object.prototype.hasOwnProperty.call(doc, shotId) ? doc[shotId] : null;
  if (!isObj(perShot)) {
    perShot = Object.create(null);
    putKey(doc, shotId, perShot);
  }
  let e = perShot[kind];
  if (!isObj(e)) {
    e = { active: 0, locked: false, versions: [] };
    perShot[kind] = e;
  }
  if (e.locked === true && o !== "manual") return 0;
  const v = e.versions.reduce((n, x) => Math.max(n, x.v), 0) + 1;
  e.versions.push({
    v,
    text,
    origin: o,
    at: strOrNull(at),
    skillRunId: strOrNull(skillRunId),
    proposalId: strOrNull(proposalId),
  });
  e.active = v;
  return v;
}

/** Move the ACTIVE pointer. Never deletes; refuses a version that is not there
 *  rather than silently landing on the newest one. */
export function setActive(doc, shotId, kind, version) {
  const e = entryOf(doc, shotId, kind);
  if (!e || !e.versions.some((x) => x.v === version)) return false;
  e.active = version;
  return true;
}

/** Put the COMPILED prompt back in force, keeping every saved version.
 *
 *  This is what 「回到自动编译」 means, and it is a real state rather than a
 *  deletion: the creator can switch back to any saved version afterwards. A
 *  LOCKED entry refuses it — the lock exists precisely to stop the prompt in
 *  force from changing under automation, and this changes it. */
export function useCompiled(doc, shotId, kind) {
  const e = entryOf(doc, shotId, kind);
  if (!e || e.locked === true) return false;
  if (e.active === 0) return false; // already compiled — nothing changed
  e.active = 0;
  return true;
}

/** Lock / unlock this shot's prompt (决策 5). A lock is a creator statement, so
 *  it is stored, not derived. */
export function setLocked(doc, shotId, kind, on) {
  const e = entryOf(doc, shotId, kind);
  if (!e) return false;
  e.locked = on === true;
  return true;
}

/** Serialize for persistence. Plain objects only, and entries with no versions
 *  are dropped — an empty entry says nothing and would grow the document for
 *  every shot the creator merely looked at. */
export function serialize(doc) {
  const out = {};
  if (!isObj(doc)) return out;
  for (const shotId of Object.keys(doc)) {
    const perShot = doc[shotId];
    if (!isObj(perShot)) continue;
    const clean = {};
    for (const kind of PROMPT_KINDS) {
      const e = perShot[kind];
      if (!isObj(e) || !Array.isArray(e.versions) || !e.versions.length) continue;
      clean[kind] = {
        active: e.active,
        locked: e.locked === true,
        versions: e.versions.map((v) => ({
          v: v.v, text: v.text, origin: v.origin, at: v.at,
          skillRunId: v.skillRunId, proposalId: v.proposalId,
        })),
      };
    }
    // putKey, not `out[shotId] =`: a shotId is arbitrary persisted text, and a
    // plain assignment to `__proto__` writes the PROTOTYPE instead of an own key
    // — so that shot's prompt versions were silently dropped from the save and
    // came back as "never written". Reading already used putKey; the write path
    // had to as well.
    if (Object.keys(clean).length) putKey(out, shotId, clean);
  }
  return out;
}

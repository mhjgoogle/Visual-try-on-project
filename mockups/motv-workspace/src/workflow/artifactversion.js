// ArtifactVersion — the SIX-STATE derived view (系统合同 §3 / TASK-072 §1.7).
//
// A MAPPING, NOT A MIGRATION. Every document keeps storing exactly what it stores
// today (`versions[] + active + locked` for prompts, `{current, history}` chains
// for media, a boolean lock for timeline clips). This module reads those and
// answers one question in one vocabulary:
//
//   draft ──→ suggested ──→ candidate ──→ confirmed ──→ locked
//     └────────────┴─────────────┴────────────┴───────────┴──→ deprecated
//
// Nothing here writes. That is deliberate and it is the whole safety argument: a
// derived view cannot corrupt what it derives from, so introducing this
// vocabulary cannot change a single stored document.
//
// WHY A SHARED MODULE AT ALL. 「这一版行不行」 is currently answered four different
// ways — `active > 0`, `current === version`, an `approved` flag, a clip lock —
// and every surface that needs the answer re-derives it. Four derivations of one
// fact drift, and the drift shows up as a page calling something 已定稿 that the
// generator does not.

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/** The six states, in progression order. `deprecated` is ONE OF THE SIX, not a
 *  flag beside them (ADR-0066 §6 校正 6): a deprecated version stays queryable,
 *  restorable, and referenceable by history. */
export const ARTIFACT_STATES = Object.freeze([
  "draft",
  "suggested",
  "candidate",
  "confirmed",
  "locked",
  "deprecated",
]);

/** Which states an `active` pointer may legally point at (§3 table). */
export const ACTIVE_STATES = Object.freeze(["confirmed", "locked"]);

/** Which states only a USER may produce (§3.1 invariant 1). An AI origin
 *  reaching either of these is a bug, not a permission to grant. */
export const USER_ONLY_STATES = Object.freeze(["confirmed", "locked"]);

export const STATE_LABEL = Object.freeze({
  draft: "草稿",
  suggested: "AI 建议",
  candidate: "候选",
  confirmed: "已确认",
  locked: "已锁定",
  deprecated: "已废弃",
});

/** Origins that mean 「this came out of a Skill Run's proposal」 → `suggested`.
 *
 *  `promptdoc` writes `skill` for exactly that case and `manual` / `compiled`
 *  otherwise, so the set is read from the stored origin rather than guessed from
 *  the presence of a `skillRunId` (a manual version can legally carry one: the
 *  creator may have typed their own text while a run was open). */
const AGENT_ORIGINS = new Set(["skill", "ai", "agent"]);

/**
 * The state of ONE version record.
 *
 * @param {object} version   the stored record (`{v, origin, …}` or a MediaRef)
 * @param {object} ctx
 *   active      the entry's active pointer (version number), or 0 / null for none
 *   locked      whether the ENTRY is locked (the lock lives on the entry, not the
 *               version — that is how the documents store it today)
 *   deprecated  explicit retirement of this version
 *
 * ORDER MATTERS and it is the state machine's own order read backwards:
 * `deprecated` is reachable from everywhere and therefore wins; `locked` is the
 * furthest forward state and only the ACTIVE version can be in it (a lock on an
 * entry says 「the version in force must not be overwritten」, not 「every version
 * this entry ever had is locked」).
 */
export function stateOfVersion(version, { active = 0, locked = false, deprecated = false } = {}) {
  if (!isObj(version)) return null;
  if (deprecated === true || version.deprecated === true) return "deprecated";
  const n = Number.isInteger(version.v) ? version.v : (Number.isInteger(version.version) ? version.version : null);
  const isActive = n != null && n === active && active !== 0;
  if (isActive) return locked === true ? "locked" : "confirmed";
  // NOT active. An agent's proposal is `suggested`; anything else that exists as a
  // real stored artifact is a `candidate` waiting to be picked.
  if (AGENT_ORIGINS.has(String(version.origin || ""))) return "suggested";
  // `draft` is for something written but not yet a proposal — for text versions
  // that means genuinely empty content. An empty stored version is not a
  // candidate: offering it as one asks the creator to pick nothing.
  if (typeof version.text === "string" && !version.text.trim()) return "draft";
  return "candidate";
}

/**
 * Every version of one prompt entry, in six-state form.
 *
 * `active: 0` is a REAL state in `promptdoc` (「用自动编译，但保留我写过的版本」), not
 * a corrupt pointer — so NO stored version is `confirmed` in that case, and the
 * effective prompt is the compiled one. Treating 0 as 「fall back to the newest」
 * would report a version as confirmed that the creator explicitly stepped away
 * from.
 */
export function promptVersionStates(entry) {
  if (!isObj(entry) || !Array.isArray(entry.versions)) return [];
  const active = Number.isInteger(entry.active) ? entry.active : 0;
  const locked = entry.locked === true;
  // FILTERED like every sibling module (independent review, batch 2): a null or
  // primitive element in a stored/legacy document threw a TypeError and took down the
  // entire derived view rather than degrading to "this one version is unreadable".
  return entry.versions.filter(isObj).map((v) => ({
    version: Number.isInteger(v.v) ? v.v : null,
    origin: v.origin || null,
    at: v.at || null,
    state: stateOfVersion(v, { active, locked }),
  }));
}

/**
 * Every version of one media chain (`{current, history}`), in six-state form.
 *
 * `storageState` is deliberately NOT folded in (§3.2): 「字节在不在」 and 「这版行不
 * 行」 are orthogonal facts, and a confirmed version whose bytes were archived is
 * still confirmed. It is carried alongside so a caller can show both.
 */
export function chainVersionStates(chain, { locked = false } = {}) {
  if (!isObj(chain) || !Array.isArray(chain.history)) return [];
  const current = Number.isInteger(chain.current) ? chain.current : 0;
  return chain.history.filter(isObj).map((r) => ({
    version: Number.isInteger(r.version) ? r.version : null,
    assetId: r.assetId || null,
    origin: r.origin || null,
    storageState: r.storageState || "local",
    state: stateOfVersion({ ...r, v: r.version }, { active: current, locked }),
  }));
}

/** The one version in force, or null. By construction at most one (§3.1
 *  invariant 2): it is the one whose state is `confirmed` or `locked`. */
export function activeVersion(states) {
  if (!Array.isArray(states)) return null;
  return states.find((s) => ACTIVE_STATES.includes(s.state)) || null;
}

/** Is this state reachable by an action from `origin`?
 *
 *  §3.1 invariant 1, expressed so a caller can ASK rather than reimplement:
 *  `confirmed` and `locked` are the creator's own judgements and automation may
 *  never produce them, whatever automation level is in force. */
export function stateAllowedFrom(state, origin) {
  if (!ARTIFACT_STATES.includes(state)) {
    return { ok: false, reason: `未知版本状态 ${state}` };
  }
  if (origin === "user") return { ok: true };
  if (USER_ONLY_STATES.includes(state)) {
    return { ok: false, reason: `「${STATE_LABEL[state]}」只能由你本人做出——自动化不产生这个状态` };
  }
  if (state === "suggested") return { ok: true };
  // draft / candidate / deprecated: an agent may produce a proposal or a
  // generated candidate, and the system may retire a version.
  return { ok: true };
}

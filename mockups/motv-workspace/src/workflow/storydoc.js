// Story document (checkpoint M9) — the project-level CREATIVE development
// chain that sits BETWEEN the idea and the episode scripts:
//
//   Idea → AI-assisted Story Development → Story Outline (versioned, approved)
//        → Episode Plan (versioned, confirmed) → per-episode Scripts
//
// Owns the Idea, the append-only Story OUTLINE version chain, and the
// append-only Episode PLAN version chain. AI output is always a PROPOSAL
// (transient `pending`) until the creator applies it as a new immutable
// version; earlier versions are never overwritten. `approved` / `confirmedPlan`
// are durable pointers the downstream steps key off:
//  - the outline must be APPROVED before an episode plan is proposed;
//  - the plan must be CONFIRMED before it instantiates Episode entities
//    (the caller stamps each plan entry's episodeId at confirm time — an
//    explicit identity join, never re-derived from titles or positions).
//
// The outline NEVER writes Production Bible entities (M9 rule 8): formal
// bible sync stays driven by actual episode scripts (M8 breakdown).
//
// Pure state + transitions only — no fetch, no DOM, no clock.

import { mintId } from "./identity.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x : "");
// kept VERBATIM (no trims/caps): hydration must be lossless for persisted
// content — v8 validation rejects malformed values instead of coercing them
const strList = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === "string" && s.trim()) : []);

export const OUTLINE_FIELDS = [
  "premise", "logline", "genreTone", "world", "centralConflict", "storyArc", "ending", "durationNote",
];
export const PLAN_FIELDS = ["title", "synopsis", "purpose", "hook", "endingBeat", "duration"];

/** Normalize a (possibly agent-produced) outline into the canonical shape.
 *  Strings for every facet, characterConcepts a string list, episodeCount a
 *  positive integer or null — anything else degrades honestly, never throws. */
export function sanitizeOutline(o) {
  const src = isObj(o) ? o : {};
  const out = { ...src }; // unknown fields survive the round-trip
  for (const k of OUTLINE_FIELDS) out[k] = str(src[k]);
  out.characterConcepts = strList(src.characterConcepts);
  const n = src.episodeCount;
  // 1..50 — the plan endpoint's parser rejects >50 episodes, so an outline
  // must not be able to request a count that compliant planning cannot serve
  out.episodeCount = Number.isInteger(n) && n > 0 && n <= 50 ? n : null;
  return out;
}

/** Normalize a plan's episode entries: dense epNumber, string facets,
 *  episodeId carried verbatim when present (stamped at confirm time). */
export function sanitizePlanEpisodes(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!isObj(e)) continue;
    const entry = { ...e, epNumber: out.length + 1 }; // unknown fields survive
    for (const k of PLAN_FIELDS) entry[k] = str(e[k]);
    if (!entry.title.trim()) continue; // an episode needs at least a title
    entry.episodeId = typeof e.episodeId === "string" && e.episodeId ? e.episodeId : null;
    out.push(entry);
  }
  return out;
}

function sanitizeVersions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    if (!isObj(x) || !isObj(x.outline)) continue;
    out.push({
      ...x, // unknown fields survive the round-trip
      id: typeof x.id === "string" && x.id ? x.id : mintId("so"),
      v: out.length + 1, // dense chain, defensively renumbered
      outline: sanitizeOutline(x.outline),
      origin: ["developed", "revision", "manual"].includes(x.origin) ? x.origin : "developed",
      instruction: str(x.instruction),
      basedOn: Number.isInteger(x.basedOn) ? x.basedOn : null,
    });
  }
  return out;
}

function sanitizePlans(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    if (!isObj(x)) continue;
    const episodes = sanitizePlanEpisodes(x.episodes);
    if (!episodes.length) continue;
    out.push({
      ...x, // unknown fields survive the round-trip
      id: typeof x.id === "string" && x.id ? x.id : mintId("plan"),
      v: out.length + 1,
      episodes,
      origin: ["proposed", "manual"].includes(x.origin) ? x.origin : "proposed",
      instruction: str(x.instruction),
      outlineVersionId: typeof x.outlineVersionId === "string" && x.outlineVersionId ? x.outlineVersionId : null,
    });
  }
  return out;
}

/** Hydrate from a persisted `story` field, or start empty. */
export function createStory(saved) {
  const doc = {
    idea: "",
    versions: [],
    active: 0,
    approved: 0,
    plans: [],
    activePlan: 0,
    confirmedPlan: 0,
    pending: null, // transient — never persisted
    _seq: 0,
  };
  if (!isObj(saved)) return doc;
  doc.idea = str(saved.idea);
  doc.versions = sanitizeVersions(saved.versions);
  const vOk = (v) => Number.isInteger(v) && doc.versions.some((x) => x.v === v);
  doc.active = vOk(saved.active) ? saved.active : doc.versions.length;
  doc.approved = vOk(saved.approved) ? saved.approved : 0;
  doc.plans = sanitizePlans(saved.plans);
  const pOk = (v) => Number.isInteger(v) && doc.plans.some((x) => x.v === v);
  doc.activePlan = pOk(saved.activePlan) ? saved.activePlan : doc.plans.length;
  doc.confirmedPlan = pOk(saved.confirmedPlan) ? saved.confirmedPlan : 0;
  return doc;
}

/** The durable slice for persistence — transient pending state is dropped. */
export function serialize(doc) {
  return {
    idea: doc.idea,
    versions: doc.versions,
    active: doc.active,
    approved: doc.approved,
    plans: doc.plans,
    activePlan: doc.activePlan,
    confirmedPlan: doc.confirmedPlan,
  };
}

export function activeOutline(doc) {
  return doc.versions.find((x) => x.v === doc.active) || null;
}

export function approvedOutline(doc) {
  return doc.versions.find((x) => x.v === doc.approved) || null;
}

export function activePlan(doc) {
  return doc.plans.find((x) => x.v === doc.activePlan) || null;
}

export function confirmedPlan(doc) {
  return doc.plans.find((x) => x.v === doc.confirmedPlan) || null;
}

export function setIdea(doc, text) {
  doc.idea = String(text ?? "");
}

/** Start an AI development run. kind: "outline" (idea/current outline +
 *  instruction → outline proposal) | "plan" (approved outline → episode-plan
 *  proposal). Returns a call id (0 = refused: one already running, or an
 *  un-reviewed proposal is pending; a plan additionally requires an APPROVED
 *  outline). A `failed` pending may be replaced by a retry. */
export function beginDevelop(doc, kind, instruction) {
  const st = doc.pending && doc.pending.status;
  if (st === "generating" || st === "proposed") return 0;
  if (kind === "plan" && !approvedOutline(doc)) return 0;
  const id = ++doc._seq;
  doc.pending = {
    id,
    kind, // "outline" | "plan"
    status: "generating",
    instruction: String(instruction || ""),
    basedOn: kind === "outline" ? doc.active || null : doc.activePlan || null,
    // plan provenance is captured at LAUNCH — the outline the generation
    // actually ran from, not whatever is approved when the proposal is
    // applied (approving another version mid-review must not re-attribute it)
    outlineVersionId: kind === "plan" ? (approvedOutline(doc) || {}).id ?? null : null,
  };
  return id;
}

/** Land a finished development run as a PROPOSAL awaiting apply/discard. */
export function completeDevelop(doc, id, payload) {
  const p = doc.pending;
  if (!p || p.id !== id || p.status !== "generating") return false; // stale/cancelled
  // A PROPOSAL never carries episode identities: episodeId is stamped ONLY at
  // confirm time by the caller. Agent output smuggling an existing episodeId
  // must not be able to silently link/rename that episode on confirmation.
  const proposal = p.kind === "plan"
    ? sanitizePlanEpisodes(payload).map((e) => ({ ...e, episodeId: null }))
    : sanitizeOutline(payload);
  if (p.kind === "plan" && !proposal.length) {
    doc.pending = { ...p, status: "failed", error: "规划提案为空（没有可用的分集）" };
    return true;
  }
  doc.pending = { ...p, status: "proposed", proposal };
  return true;
}

export function failDevelop(doc, id, message) {
  const p = doc.pending;
  if (!p || p.id !== id || p.status !== "generating") return false;
  doc.pending = { ...p, status: "failed", error: String(message || "生成失败") };
  return true;
}

export function cancelDevelop(doc) {
  doc.pending = null;
}

/** Apply the pending proposal as the next immutable version of its chain.
 *  Every earlier version stays; approval/confirmation pointers do NOT move —
 *  a new outline version must be explicitly re-approved. */
export function applyProposal(doc) {
  const p = doc.pending;
  if (!p || p.status !== "proposed") return null;
  let rec;
  if (p.kind === "plan") {
    rec = {
      id: mintId("plan"),
      v: doc.plans.length + 1,
      episodes: p.proposal,
      origin: "proposed",
      instruction: p.instruction,
      outlineVersionId: p.outlineVersionId ?? null, // captured at launch
    };
    doc.plans.push(rec);
    doc.activePlan = rec.v;
  } else {
    rec = {
      id: mintId("so"),
      v: doc.versions.length + 1,
      outline: p.proposal,
      origin: doc.versions.length ? "revision" : "developed",
      instruction: p.instruction,
      basedOn: p.basedOn,
    };
    doc.versions.push(rec);
    doc.active = rec.v;
  }
  doc.pending = null;
  return rec;
}

export function discardProposal(doc) {
  if (doc.pending && doc.pending.status === "proposed") doc.pending = null;
}

/** Manual outline edit → a NEW immutable version (origin "manual"). */
export function applyManualOutline(doc, fields) {
  const base = activeOutline(doc);
  const merged = sanitizeOutline({ ...(base ? base.outline : {}), ...(isObj(fields) ? fields : {}) });
  const rec = {
    id: mintId("so"),
    v: doc.versions.length + 1,
    outline: merged,
    origin: "manual",
    instruction: "",
    basedOn: doc.active || null,
  };
  doc.versions.push(rec);
  doc.active = rec.v;
  return rec;
}

export function setActiveOutline(doc, v) {
  if (!doc.versions.some((x) => x.v === v)) return false;
  doc.active = v;
  return true;
}

/** Approve an outline version — the durable gate the episode plan keys off. */
export function approveOutline(doc, v) {
  if (!doc.versions.some((x) => x.v === v)) return false;
  doc.approved = v;
  return true;
}

export function setActivePlan(doc, v) {
  if (!doc.plans.some((x) => x.v === v)) return false;
  doc.activePlan = v;
  return true;
}

/** Confirm a plan version — the durable gate before episode scripts. The
 *  CALLER instantiates/links Episode entities and stamps each entry's
 *  episodeId BEFORE confirming (identity is explicit, never re-derived). */
export function confirmPlan(doc, v) {
  if (!doc.plans.some((x) => x.v === v)) return false;
  doc.confirmedPlan = v;
  return true;
}

/** The outline a plan was BUILT from (its launch-time provenance link), with
 *  an honest fallback to the currently approved outline when the linked
 *  version is unavailable. Episode-script context must never mix a newer
 *  approved outline with an older confirmed plan. */
export function outlineForPlan(doc, plan) {
  if (plan && plan.outlineVersionId) {
    const src = doc.versions.find((x) => x.id === plan.outlineVersionId);
    if (src) return src;
  }
  return approvedOutline(doc);
}

// Skill Run Provenance (checkpoint CP3 / ADR-0056) — the durable record of
// what an AI capability was actually asked, by whom, and what the creator did
// with the answer.
//
//   Skill Run {
//     skillRunId, skillId, skillVersion,
//     runtime, executor, model,        // WHO answered (never conflated)
//     inputKeys, inputSummary,         // WHAT it was given (reproducible)
//     contextTrace,                    // …and the CONTENT fingerprint of it
//     status, proposal, error,
//     directorReview,                  // present only if a real check ran
//     decision, decidedAt,             // accept / reject — the creator's call
//     createdAt
//   }
//
// THIS IS NOT CHAT HISTORY. It records the run, not the conversation: which
// skill at which version, which context, which executor, and how the creator
// judged it. That is what a later Skill revision can actually be argued from.
//
// TWO RULES THIS MODULE ENFORCES STRUCTURALLY:
//
//   1. A run NEVER writes canonical data. It carries a Proposal; the canonical
//      write happens elsewhere, only after `accept()`. `status` makes the
//      difference visible: `proposed` is not `accepted`.
//   2. A run NEVER writes back into the Skill. Definitions are frozen constants
//      in skills.js; this registry only records `skillId` + `skillVersion`.
//      Improving a Skill is an explicit revision, never a side effect of one
//      good answer (ADR-0056 决策 6).
//
// FAILURE IS RECORDED AS FAILURE. `unavailable` / `timeout` / `invalid_output`
// are distinct, honest terminal states — none of them ever becomes a proposal
// with invented content.
//
// Pure state + transitions — no fetch, no DOM, no clock (callers pass `now`).

import { mintId } from "./identity.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const strOrNull = (x) => (typeof x === "string" && x ? x : null);

/** The three canon levels a run can be scoped to (ADR-0059). Normalised to a
 *  fixed shape so every consumer reads the same three keys, and to `null` when
 *  the caller named no level at all — an object of three nulls would claim the
 *  context was recorded and simply empty, which is a different statement. */
function contextOf(raw) {
  if (!isObj(raw)) return null;
  const c = {
    episodeId: strOrNull(raw.episodeId),
    sceneId: strOrNull(raw.sceneId),
    shotId: strOrNull(raw.shotId),
  };
  return c.episodeId || c.sceneId || c.shotId ? c : null;
}

/** Terminal and non-terminal run states. */
export const RUN_STATUSES = ["running", "proposed", "failed", "accepted", "rejected"];

/** Why a run failed. Kept apart from each other because the creator's next
 *  action differs: configure the executor / retry / fix the skill. */
export const RUN_ERROR_KINDS = ["unavailable", "unauthenticated", "timeout", "invalid_output", "execution_error"];

const STATUS_SET = new Set(RUN_STATUSES);
const ERROR_SET = new Set(RUN_ERROR_KINDS);

/** Hydrate the registry from a persisted `skillRuns` field (or start empty).
 *  Non-object entries in a hand-corrupted save carry no provenance and are
 *  dropped; every real record is preserved verbatim. */
export function createSkillRunRegistry(saved) {
  return Array.isArray(saved) ? saved.filter(isObj) : [];
}

/**
 * Begin a run, freezing WHAT was asked and WHO was asked at launch.
 *
 * `inputSummary` is a short, human-readable note of the context (e.g.
 * "EP01 · S02 · 4 个镜头") — enough to understand the run later without
 * storing a second copy of the domain documents, which would immediately be
 * a stale duplicate of canon.
 */
export function startRun(reg, entry) {
  if (!Array.isArray(reg) || !isObj(entry)) return null;
  const skillId = strOrNull(entry.skillId);
  if (!skillId) return null; // a run with no capability records nothing usable
  if (!Number.isInteger(entry.skillVersion) || entry.skillVersion < 1) return null;
  const rec = {
    skillRunId: strOrNull(entry.skillRunId) || mintId("skillrun"),
    skillId,
    skillVersion: entry.skillVersion,
    runtime: strOrNull(entry.runtime),
    executor: strOrNull(entry.executor),
    // the model is reported BY the runtime; unknown stays honestly null rather
    // than being filled in with whatever we hoped was running
    model: strOrNull(entry.model),
    inputKeys: Array.isArray(entry.inputKeys) ? entry.inputKeys.filter((k) => typeof k === "string" && k) : [],
    inputSummary: strOrNull(entry.inputSummary),
    // WHICH canon this run read, as ids (ADR-0059). `inputSummary` above stays —
    // it is what a person reads — but a string cannot be traced, and "which
    // episode did this run look at" is a question the graph has to answer.
    //
    // A null level is a FACT, not a gap: an episode-wide continuity check has
    // no shotId. A run whose context was never captured carries `null`, and
    // says so rather than being attached to whatever episode is active now.
    context: contextOf(entry.context),
    // TASK-067 §3 / ADR-0064 决策 2: WHAT the run read, as a content fingerprint —
    // which references at which version serving which side, which reading of each,
    // which frames, which selected takes, which prompt versions, which neighbours.
    //
    // DISTINCT FROM `context` ABOVE, deliberately. `context` is the ADR-0059 identity
    // contract (which level of canon this run belongs to); this is the projection it
    // was actually handed. 「读了 EP01 / S01 / SH02」 and 「读到的是 SH02 的哪一版内容」
    // are different questions, and only the second one can tell you whether a
    // conclusion still applies.
    //
    // Null is a FACT: a project-wide capability read no single shot's projection, so
    // it has no trace, and manufacturing one would claim a precision it lacks.
    contextTrace: isObj(entry.contextTrace) ? entry.contextTrace : null,
    // THE QUESTION THIS RUN ACTUALLY ASKED, frozen at launch (manual runs only).
    //
    // A manual run stays open until the creator brings an answer back, and they get
    // the prompt by pressing 复制任务 Prompt. Recompiling it at copy time reads LIVE
    // state: edit the shot after starting the run and the copied prompt no longer
    // matches the `contextTrace` the record claims the answer came from — the record
    // would describe inputs the answer never saw (codex review round 4).
    //
    // Only manual runs carry it: a local run consumes its prompt immediately, so
    // storing one per run would be a durable copy of something nobody can re-read.
    promptText: strOrNull(entry.promptText),
    status: "running",
    proposal: null,
    directorReview: null,
    error: null,
    decision: null,
    decidedAt: null,
    createdAt: strOrNull(entry.createdAt),
  };
  reg.push(rec);
  return rec;
}

export function findRun(reg, skillRunId) {
  if (!Array.isArray(reg) || typeof skillRunId !== "string" || !skillRunId) return null;
  return reg.find((r) => isObj(r) && r.skillRunId === skillRunId) || null;
}

/** Attach the SCHEMA-VALIDATED structured answer as a Proposal.
 *
 *  `proposed` is deliberately not `accepted`: nothing canonical has been
 *  written, and the creator can still reject it. A run already in a terminal
 *  state is not resurrected — a late answer must not overwrite a decision the
 *  creator already made. */
export function proposeRun(reg, skillRunId, proposal, { model = null } = {}) {
  const r = findRun(reg, skillRunId);
  if (!r || r.status !== "running") return null;
  r.status = "proposed";
  r.proposal = proposal === undefined ? null : proposal;
  // ADR-0059: the proposal gets an IDENTITY the moment it exists, so a
  // production action launched from it can point back at exactly this answer.
  // Minted here rather than at accept: a rejected proposal is still a real
  // thing that was shown, and it keeps its id.
  //
  // ALWAYS MINTED, never read out of the payload. `proposal` is model OUTPUT —
  // an answer carrying its own `proposalId` would put an identity under the
  // control of generated content, and a duplicate would collide with another
  // proposal's graph node and misattribute the generations pointing at it.
  if (isObj(r.proposal)) r.proposal.proposalId = mintId("proposal");
  if (strOrNull(model)) r.model = model; // what ACTUALLY answered, if reported
  return r;
}

/** The proposal's id, or null when this run has none — an older run whose
 *  proposal predates the id, or a run that never produced one. Callers use it
 *  to stamp `generation.origin`; a null must stay null there. */
export function proposalIdOf(run) {
  return isObj(run) && isObj(run.proposal) ? strOrNull(run.proposal.proposalId) : null;
}

/** Record an honest failure. The reason is one of RUN_ERROR_KINDS so the UI can
 *  say something actionable, and `proposal` stays null — a failed run never
 *  becomes content. */
export function failRun(reg, skillRunId, kind, detail) {
  const r = findRun(reg, skillRunId);
  if (!r || r.status === "accepted" || r.status === "rejected") return null;
  r.status = "failed";
  r.proposal = null;
  r.error = {
    kind: ERROR_SET.has(kind) ? kind : "execution_error",
    detail: strOrNull(detail),
  };
  return r;
}

/** Attach the AI Director's review of a proposal.
 *
 *  Only ever called when a REAL check ran. There is no fallback that invents a
 *  verdict: with no checker, `directorReview` stays null and the UI says the
 *  review is unavailable (the same honesty rule as the Impact Review's semantic
 *  verdict, ADR-0054 决策 6). */
export function reviewRun(reg, skillRunId, review) {
  const r = findRun(reg, skillRunId);
  if (!r || r.status !== "proposed" || !isObj(review)) return null;
  r.directorReview = {
    verdict: strOrNull(review.verdict),
    notes: Array.isArray(review.notes) ? review.notes.filter((n) => typeof n === "string" && n) : [],
    by: strOrNull(review.by),
  };
  return r;
}

/** The creator ACCEPTS a proposal. This marks the run; the canonical write is
 *  the caller's, through the normal domain controllers — this module never
 *  touches canon, so an accept can never itself corrupt a document. */
export function acceptRun(reg, skillRunId, at) {
  const r = findRun(reg, skillRunId);
  if (!r || r.status !== "proposed") return null;
  r.status = "accepted";
  r.decision = "accepted";
  r.decidedAt = strOrNull(at);
  return r;
}

/** The creator REJECTS a proposal. The record is KEPT — a rejected run is the
 *  most informative kind for improving a Skill later, and deleting it would
 *  leave only the flattering half of the history. */
export function rejectRun(reg, skillRunId, at, reason) {
  const r = findRun(reg, skillRunId);
  if (!r || r.status !== "proposed") return null;
  r.status = "rejected";
  r.decision = "rejected";
  r.decidedAt = strOrNull(at);
  if (strOrNull(reason)) r.rejectionReason = reason;
  return r;
}

/** Runs of one Skill, newest last — the accumulation a future revision reads. */
export function runsOfSkill(reg, skillId) {
  if (!Array.isArray(reg)) return [];
  return reg.filter((r) => isObj(r) && r.skillId === skillId);
}

/** A plain tally per Skill: how often it ran, and how the creator judged it.
 *  This is the whole of "Skill accumulation" at CP3 — a record to argue from,
 *  NOT an automatic learning loop (ADR-0056 决策 6). */
export function skillStats(reg, skillId) {
  const runs = runsOfSkill(reg, skillId);
  const count = (s) => runs.filter((r) => r.status === s).length;
  return {
    skillId,
    total: runs.length,
    accepted: count("accepted"),
    rejected: count("rejected"),
    failed: count("failed"),
    pending: count("running") + count("proposed"),
    // deliberately NOT a "quality score": accept/reject counts are evidence a
    // human reads, not a number the system may act on by itself
  };
}

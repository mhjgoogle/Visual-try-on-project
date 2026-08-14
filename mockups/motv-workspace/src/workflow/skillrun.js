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

/**
 * The Run lifecycle — EIGHT states, one axis (ADR-0066 决策 8 / 系统合同 §5.2).
 *
 * The old five (`running/proposed/failed/accepted/rejected`) crammed TWO
 * questions into one field: "how did the execution go" and "what did the creator
 * do with the answer". Those move independently — a run can succeed and sit
 * undecided for a week — so they are now two fields, and `disposition` below is
 * the second one.
 *
 * Order matters here: it is the happy path, not the alphabet.
 */
export const RUN_STATUSES = [
  // shown the cost/impact, waiting for the user. Deliberately BEFORE `queued`:
  // an unapproved task must not be holding an execution slot.
  "awaiting_confirmation",
  "queued",
  "running",
  // MANUAL execution: nothing is running, the system is waiting for a person.
  // Saying `running` here was a lie that made the restart sweep treat healthy
  // manual work as a zombie.
  "awaiting_input",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
];

/** What the creator did with the answer — the SECOND axis. */
export const PROPOSAL_DISPOSITIONS = ["pending", "accepted", "rejected", "superseded"];

/** Once written, never rewritten. A late answer must not overwrite a decision. */
/** What the creator sees for each status.
 *
 *  HERE, beside `RUN_STATUSES`, and not in a panel: TASK-073 §1.3 puts task rows on
 *  ⑧ 镜头制作 as well as in the skill panel, and two copies of this table would let
 *  one surface say 「进行中」 while the other says 「running」 for the same run.
 *
 *  The disposition axis (有提案 / 已接受 / 已忽略) is a SECOND axis and stays with
 *  the panel that renders proposals — a `succeeded` run reads differently depending
 *  on what the creator did with the answer. */
export const RUN_STATUS_LABEL = {
  awaiting_confirmation: "待确认",
  queued: "排队中",
  running: "进行中",
  awaiting_input: "等你交结果", // manual: the system is waiting for a PERSON
  cancelling: "取消中",
  cancelled: "已取消",
  succeeded: "已完成",
  failed: "失败",
};

export const TERMINAL_RUN_STATUSES = ["cancelled", "succeeded", "failed"];

const TERMINAL_SET = new Set(TERMINAL_RUN_STATUSES);
/** States a run may be OPENED in. Terminal states are reached by transition,
 *  never by construction. */
const OPENABLE_STATUSES = new Set(
  // `cancelling` is excluded too: it means "a cancel is being delivered to a
  // real process", and a run being CREATED has neither a process nor a pending
  // cancel — opening one there would strand it in a valid non-terminal state
  // nothing can move (codex review, round 14).
  RUN_STATUSES.filter((s) => !TERMINAL_SET.has(s) && s !== "cancelling"),
);
const DISPOSITION_SET = new Set(PROPOSAL_DISPOSITIONS);

/** Is this run still going to change by itself? `awaiting_input` counts: the
 *  creator can still bring an answer back. */
export function isOpen(run) {
  return isObj(run) && !TERMINAL_SET.has(run.status);
}

/** The proposal's disposition, or null when there is no proposal (or it is a
 *  hand-corrupted non-object one, which cannot carry the field). */
export function dispositionOf(run) {
  if (!isObj(run) || !isObj(run.proposal)) return null;
  return DISPOSITION_SET.has(run.proposal.disposition) ? run.proposal.disposition : null;
}

/** A finished run whose answer is still waiting on the creator. This is what
 *  the old `status === "proposed"` meant, now stated as the two facts it was. */
export function isPending(run) {
  return isObj(run) && run.status === "succeeded" && dispositionOf(run) === "pending";
}

/** The creator accepted this answer (the old `status === "accepted"`). */
export function isAccepted(run) {
  return isObj(run) && run.status === "succeeded" && dispositionOf(run) === "accepted";
}

/** The creator rejected it (the old `status === "rejected"`). Kept, not deleted:
 *  a rejected run is the most informative kind for revising a Skill. */
export function isRejected(run) {
  return isObj(run) && run.status === "succeeded" && dispositionOf(run) === "rejected";
}

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
    // A caller may open a run in any NON-TERMINAL state (queued / awaiting_*).
    // A terminal one is refused: this function always sets `proposal: null`, and
    // a `succeeded` record with no proposal is rejected by the v15 validator —
    // i.e. the caller would build a document that cannot be saved (codex review,
    // round 3). Reaching a terminal state is what the transitions below are for.
    status: OPENABLE_STATUSES.has(entry.status) ? entry.status : "running",
    proposal: null,
    directorReview: null,
    error: null,
    decision: null,
    decidedAt: null,
    createdAt: strOrNull(entry.createdAt),
    // --- 系统合同 §5.0 / §5.3 的持久化字段 ---------------------------------- //
    // `runId` is the ONE identity; `skillRunId` above is the same value under
    // its historical name, kept as a compatibility alias until TASK-074.
    runId: strOrNull(entry.skillRunId) || null,
    kind: strOrNull(entry.kind) || "skill",
    // A STABLE MACHINE KEY, never the display name: `taskName` changes with copy
    // and language, and using it as a persisted key loses history on a rewrite.
    taskType: strOrNull(entry.taskType) || `skill.${skillId}`,
    projectId: strOrNull(entry.projectId),
    provider: strOrNull(entry.provider),
    target: isObj(entry.target) ? entry.target : null,
    // `contextTrace` above IS the input-version record (ADR-0064 决策 2); this
    // does not create a second copy of it.
    outputs: null,
    outputVersions: null,
    progress: 0,
    // subscription work costs 0 AND SAYS SO. An absent cost reads as
    // "we don't know", which is a different (and wrong) statement.
    cost: isObj(entry.cost) ? entry.cost : { currency: "USD", amount: 0, basis: "subscription" },
    // WHEN IT STARTED RUNNING — null until it does. Seeding it with the
    // creation time folded queueing, confirmation and manual waiting into the
    // execution duration, so every derived timing was wrong and the field
    // claimed execution had begun when it had not (codex review, round 10).
    startedAt: null,
    endedAt: null,
    failureReason: null,
    confirmation: null,
  };
  // runId defaults to whatever id was actually minted for this run
  rec.runId = rec.runId || rec.skillRunId;
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
export function proposeRun(reg, skillRunId, proposal, { model = null, at = null } = {}) {
  const r = findRun(reg, skillRunId);
  // `awaiting_input` is where a MANUAL run waits, so it is the state a pasted
  // answer lands from — the old code accepted only `running`, which is what a
  // manual run used to (incorrectly) sit in.
  if (!r || (r.status !== "running" && r.status !== "awaiting_input")) return null;
  // A PROPOSAL MUST BE AN OBJECT. v15 requires a `succeeded` run to carry a
  // plain-object proposal with a disposition, so landing anything else would
  // move the run to a state the canvas validator rejects — i.e. produce a
  // document that can no longer be saved (codex review, round 9). Refusing here
  // keeps the failure where it can still be reported.
  //
  // This does NOT block list-shaped products (codex review, round 17 asked):
  // every proposal on the live path comes from `readSkillAnswer`, whose parser
  // only ever returns a top-level OBJECT — a shot list arrives as
  // `{ shots: [...] }`, never as a bare array. The v15 migration wraps bare
  // values because a DAMAGED historical document may contain one; nothing in
  // the running system can produce one.
  if (!isObj(proposal)) return null;
  // The execution SUCCEEDED; what the creator does with the answer is the other
  // axis, and it starts undecided.
  r.status = "succeeded";
  // WHEN it finished. `r.endedAt || null` recorded nothing at all, so every
  // successful canvas-owned run had no end time and its duration could not be
  // derived (codex review, round 16). No clock in here — the caller passes it.
  r.endedAt = strOrNull(at) || r.endedAt || null;
  r.proposal = proposal === undefined ? null : proposal;
  if (isObj(r.proposal)) r.proposal.disposition = "pending";
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
  // A TERMINAL run is never re-failed: whatever really happened is already
  // written down, and a late error must not erase a result the creator saw.
  if (!r || TERMINAL_SET.has(r.status)) return null;
  r.status = "failed";
  r.proposal = null;
  r.error = {
    kind: ERROR_SET.has(kind) ? kind : "execution_error",
    detail: strOrNull(detail),
  };
  // the same fact in the contract's vocabulary; `error` stays for the existing
  // readers rather than being renamed under them
  r.failureReason = { category: r.error.kind, detail: r.error.detail };
  return r;
}

/** Move a run to `awaiting_input` — it is being executed BY A PERSON.
 *  Separate from `running` because nothing is running, and because the backend's
 *  restart sweep must not treat a creator's in-flight work as a zombie. */
export function awaitInput(reg, skillRunId) {
  const r = findRun(reg, skillRunId);
  if (!r || (r.status !== "queued" && r.status !== "running")) return null;
  r.status = "awaiting_input";
  return r;
}

/** The creator asked to stop.
 *
 *  Pre-execution states cancel AT ONCE — they own no process, so there is
 *  nothing to deliver a signal to. Only `running` goes through `cancelling`,
 *  because killing a real process tree takes time and can fail. */
export function cancelRun(reg, skillRunId, at, reason) {
  const r = findRun(reg, skillRunId);
  if (!r || TERMINAL_SET.has(r.status)) return null;
  // WHY they stopped is recorded on BOTH branches. It used to be written only
  // on the pre-execution one, so a `running` run — the case where the reason is
  // most informative — lost it silently (codex review, round 5).
  if (strOrNull(reason)) r.cancelReason = reason;
  if (r.status === "running" || r.status === "cancelling") {
    r.status = "cancelling";
    r.cancelRequestedAt = strOrNull(at);
    return r;
  }
  r.status = "cancelled";
  r.endedAt = strOrNull(at);
  return r;
}

/** The backend confirmed the process is gone. Only from `cancelling`: claiming
 *  `cancelled` without that confirmation is exactly the pretence the contract
 *  forbids (§5.4 rule 3). */
export function confirmCancelled(reg, skillRunId, at) {
  const r = findRun(reg, skillRunId);
  if (!r || r.status !== "cancelling") return null;
  r.status = "cancelled";
  r.endedAt = strOrNull(at);
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
  if (!r || !isPending(r) || !isObj(review)) return null;
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
  if (!r || !isPending(r)) return null;
  // The STATUS does not move: the execution already succeeded. What changes is
  // the creator's disposition of the answer — which is the whole reason these
  // are two fields now.
  r.proposal.disposition = "accepted";
  r.decision = "accepted"; // compatibility field, removed in TASK-074
  r.decidedAt = strOrNull(at);
  return r;
}

/** The creator REJECTS a proposal. The record is KEPT — a rejected run is the
 *  most informative kind for improving a Skill later, and deleting it would
 *  leave only the flattering half of the history. */
export function rejectRun(reg, skillRunId, at, reason) {
  const r = findRun(reg, skillRunId);
  if (!r || !isPending(r)) return null;
  r.proposal.disposition = "rejected";
  r.decision = "rejected"; // compatibility field, removed in TASK-074
  r.decidedAt = strOrNull(at);
  if (strOrNull(reason)) r.rejectionReason = reason;
  return r;
}

/**
 * This proposal has been REPLACED by a newer answer for the same thing.
 *
 * Distinct from `rejected`: the creator did not judge it, it simply stopped
 * being the current one. Recorded rather than deleted, so a later revision can
 * still see what was offered and superseded.
 *
 * NOTHING calls this automatically in TASK-072 批次一, and that is deliberate:
 * the panel shows every open proposal and lets the creator compare them, so
 * auto-superseding would remove a real capability. It is here because the
 * disposition set is frozen (ADR-0066 决策 8) and because TASK-073's proposal
 * replacement is the caller it is waiting for.
 */
export function supersedeRun(reg, skillRunId, at) {
  const r = findRun(reg, skillRunId);
  if (!r || !isPending(r)) return null;
  r.proposal.disposition = "superseded";
  r.decidedAt = strOrNull(at);
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
    // read off the DISPOSITION axis now, not off `status` — the two questions
    // finally have their own fields
    accepted: runs.filter(isAccepted).length,
    rejected: runs.filter(isRejected).length,
    failed: count("failed"),
    // still open: either still executing, or waiting on the creator's decision
    pending:
      count("queued") + count("running") + count("awaiting_input")
      + count("awaiting_confirmation") + count("cancelling")
      + runs.filter(isPending).length,
    // deliberately NOT a "quality score": accept/reject counts are evidence a
    // human reads, not a number the system may act on by itself
  };
}

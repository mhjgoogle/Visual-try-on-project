// Run domain + canvas v14 -> v15 — TASK-072 批次一.
//
// The status split (ADR-0066 决策 8) is the one change in this batch that
// touches every existing document, so the migration is guarded BOTH ways: what
// each old status becomes, and what the validator will and will not accept.

import test from "node:test";
import assert from "node:assert/strict";

import {
  RUN_STATUSES,
  PROPOSAL_DISPOSITIONS,
  createSkillRunRegistry,
  startRun,
  proposeRun,
  acceptRun,
  rejectRun,
  supersedeRun,
  failRun,
  awaitInput,
  cancelRun,
  confirmCancelled,
  isOpen,
  isPending,
  isAccepted,
  isRejected,
  dispositionOf,
  skillStats,
} from "../src/workflow/skillrun.js";
import {
  CANVAS_SCHEMA_VERSION,
  MIGRATIONS,
  validateCanvasDoc as validate,
  migrateToCurrent,
} from "../src/services/canvasschema.js";

const mkRun = (reg, extra = {}) =>
  startRun(reg, { skillId: "story-development", skillVersion: 1, ...extra });

// --- the two axes ----------------------------------------------------------- //

test("the run lifecycle is eight states and the disposition is four", () => {
  assert.deepEqual(RUN_STATUSES, [
    "awaiting_confirmation",
    "queued",
    "running",
    "awaiting_input",
    "cancelling",
    "cancelled",
    "succeeded",
    "failed",
  ]);
  assert.deepEqual(PROPOSAL_DISPOSITIONS, ["pending", "accepted", "rejected", "superseded"]);
});

test("a landed answer is succeeded + pending, not a single fused status", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg);
  proposeRun(reg, r.skillRunId, { premise: "p" });
  assert.equal(r.status, "succeeded", "the EXECUTION succeeded");
  assert.equal(dispositionOf(r), "pending", "the ANSWER is undecided");
  assert.ok(isPending(r));
  assert.ok(!isAccepted(r));
});

test("accepting moves the disposition and leaves the status alone", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg);
  proposeRun(reg, r.skillRunId, { premise: "p" });
  acceptRun(reg, r.skillRunId, "2026-08-13T00:00:00Z");
  assert.equal(r.status, "succeeded", "the run did not re-succeed; it was already done");
  assert.equal(dispositionOf(r), "accepted");
  assert.ok(isAccepted(r));
  assert.equal(r.decision, "accepted", "the pre-v15 field stays for one release");
});

test("rejecting keeps the record — a rejected proposal is the informative kind", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg);
  proposeRun(reg, r.skillRunId, { premise: "p" });
  rejectRun(reg, r.skillRunId, "t", "不要这个方向");
  assert.ok(isRejected(r));
  assert.deepEqual(r.proposal, { premise: "p", proposalId: r.proposal.proposalId, disposition: "rejected" });
});

test("superseded is available but nothing produces it automatically", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg);
  proposeRun(reg, r.skillRunId, { premise: "p" });
  assert.ok(supersedeRun(reg, r.skillRunId, "t"));
  assert.equal(dispositionOf(r), "superseded");
  // …and only a PENDING proposal can be superseded: a decision the creator
  // already made is not quietly overwritten by a newer answer
  const reg2 = createSkillRunRegistry();
  const r2 = mkRun(reg2);
  proposeRun(reg2, r2.skillRunId, { premise: "p" });
  acceptRun(reg2, r2.skillRunId, "t");
  assert.equal(supersedeRun(reg2, r2.skillRunId, "t"), null);
});

// --- manual execution ------------------------------------------------------- //

test("a landed run records when it ended", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg);
  proposeRun(reg, r.skillRunId, { premise: "p" }, { at: "2026-08-13T02:00:00Z" });
  assert.equal(r.endedAt, "2026-08-13T02:00:00Z");
});

test("a manual run waits in awaiting_input and is still open", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg, { executor: "manual" });
  assert.ok(awaitInput(reg, r.skillRunId));
  assert.equal(r.status, "awaiting_input");
  assert.ok(isOpen(r), "the creator can still bring an answer back");
  // …and the pasted answer lands exactly like a local one
  proposeRun(reg, r.skillRunId, { premise: "p" });
  assert.ok(isPending(r));
});

// --- cancel ----------------------------------------------------------------- //

test("cancelling a running run goes through cancelling, never straight to cancelled", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg);
  cancelRun(reg, r.skillRunId, "t");
  assert.equal(r.status, "cancelling", "a kill takes time and can fail");
  assert.equal(confirmCancelled(reg, r.skillRunId, "t2").status, "cancelled");
});

test("a pre-execution run cancels at once — there is no process to signal", () => {
  for (const status of ["queued", "awaiting_confirmation", "awaiting_input"]) {
    const reg = createSkillRunRegistry();
    const r = mkRun(reg, { status });
    cancelRun(reg, r.skillRunId, "t");
    assert.equal(r.status, "cancelled", status);
  }
});

test("confirmCancelled refuses anything that is not cancelling", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg);
  assert.equal(confirmCancelled(reg, r.skillRunId, "t"), null,
    "claiming cancelled without a confirmed kill is the pretence the contract forbids");
});

test("a terminal run is never re-failed by a late error", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg);
  proposeRun(reg, r.skillRunId, { premise: "p" });
  acceptRun(reg, r.skillRunId, "t");
  assert.equal(failRun(reg, r.skillRunId, "timeout", "late"), null);
  assert.equal(r.status, "succeeded");
});

test("abandoning a front-end run reaches a TERMINAL state, not limbo", () => {
  // codex review round 1: `cancelRun` parks a running record in `cancelling`,
  // which is right when a real process must be signalled and confirmed dead.
  // A front-end-owned run has no such process, so nothing would ever complete
  // the transition — reintroducing the stuck-open run this control exists to
  // clear.
  const reg = createSkillRunRegistry();
  const r = mkRun(reg, { executor: "manual" });
  cancelRun(reg, r.skillRunId, "t", "创作者放弃");
  confirmCancelled(reg, r.skillRunId, "t");
  assert.equal(r.status, "cancelled");
  assert.ok(!isOpen(r), "an abandoned run must not stay open");
});

// --- persisted fields ------------------------------------------------------- //

test("a new run carries the contract's fields, with honest nulls", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg, { createdAt: "2026-08-13T00:00:00Z" });
  assert.equal(r.runId, r.skillRunId, "one identity, two names — not two identities");
  assert.equal(r.kind, "skill");
  assert.equal(r.taskType, "skill.story-development", "a STABLE machine key");
  assert.equal(r.provider, null, "unknown stays null — never guessed");
  assert.deepEqual(r.cost, { currency: "USD", amount: 0, basis: "subscription" },
    "subscription work is 0 AND says so; an absent cost reads as 'unknown'");
  assert.equal(r.failureReason, null);
});

test("stats read the disposition axis, not the status", () => {
  const reg = createSkillRunRegistry();
  const a = mkRun(reg);
  proposeRun(reg, a.skillRunId, { premise: "p" });
  acceptRun(reg, a.skillRunId, "t");
  const b = mkRun(reg);
  proposeRun(reg, b.skillRunId, { premise: "q" });
  const c = mkRun(reg);
  failRun(reg, c.skillRunId, "timeout", "slow");
  const s = skillStats(reg, "story-development");
  assert.equal(s.accepted, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.pending, 1, "one answer still awaits a decision");
});

// --- v14 -> v15 ------------------------------------------------------------- //

const v14doc = () => ({
  v: 14,
  skillRuns: [
    { skillRunId: "r1", skillId: "s", skillVersion: 1, status: "proposed", proposal: { a: 1 }, executor: "claude-code" },
    { skillRunId: "r2", skillId: "s", skillVersion: 1, status: "accepted", proposal: { a: 2 }, executor: "claude-code" },
    { skillRunId: "r3", skillId: "s", skillVersion: 1, status: "rejected", proposal: { a: 3 }, executor: "claude-code" },
    { skillRunId: "r4", skillId: "s", skillVersion: 1, status: "failed", proposal: null, executor: "claude-code" },
    { skillRunId: "r5", skillId: "s", skillVersion: 1, status: "running", proposal: null, executor: "manual" },
    { skillRunId: "r6", skillId: "s", skillVersion: 1, status: "running", proposal: null, executor: "claude-code" },
  ],
});

test("v15 migration maps every old status deterministically", () => {
  const doc = MIGRATIONS[14](v14doc());
  const by = Object.fromEntries(doc.skillRuns.map((r) => [r.skillRunId, r]));
  assert.equal(by.r1.status, "succeeded");
  assert.equal(by.r1.proposal.disposition, "pending", "an undecided proposal is NOT lost");
  assert.equal(by.r2.proposal.disposition, "accepted");
  assert.equal(by.r3.proposal.disposition, "rejected");
  assert.equal(by.r4.status, "failed");
  // `running` splits on a field the document ALREADY carries — deterministic,
  // no clock, no guessing
  assert.equal(by.r5.status, "awaiting_input", "a manual run may still be answered");
  assert.equal(by.r6.status, "failed", "its backend process no longer exists");
  assert.equal(by.r6.failureReason.category, "interrupted");
});

test("v15 migration adds identity and classification without inventing history", () => {
  const doc = MIGRATIONS[14](v14doc());
  for (const r of doc.skillRuns) {
    assert.equal(r.runId, r.skillRunId, "same id, new name");
    assert.equal(r.kind, "skill");
    assert.equal(r.taskType, "skill.s");
    // never back-filled: the document simply never captured these
    assert.equal(r.provider, null);
    assert.equal(r.cost, null);
    assert.equal(r.startedAt, null);
  }
});

test("the migration is a pure function of the document (run it twice)", () => {
  const once = MIGRATIONS[14](v14doc());
  const twice = MIGRATIONS[14](MIGRATIONS[14](v14doc()));
  assert.deepEqual(twice, once, "no clock, no randomness — same input, same output");
});

test("the current schema version is 16", () => {
  // v16: ADR-0073 决策 8 adds `production.shotProduction.stages` (skip decisions
  // only). A pinned number is the point — it forces whoever bumps the schema to
  // come here and say what changed, which is how the migration list stays honest.
  assert.equal(CANVAS_SCHEMA_VERSION, 16);
});

// --- validator -------------------------------------------------------------- //

// A REAL current-schema document, produced by the migration chain itself rather
// than hand-built: a hand-built stub drifts from the validator and then tests
// the stub instead of the contract.
const baseDoc = (runs) => {
  const res = migrateToCurrent({ v: 1, nodes: [], edges: [] });
  return { ...res.doc, skillRuns: runs };
};

test("the validator accepts a migrated v15 document", () => {
  const doc = MIGRATIONS[14](v14doc());
  const full = baseDoc(doc.skillRuns);
  assert.equal(validate(full), null, validate(full) || "");
});

test("a succeeded run without a disposition is refused", () => {
  const bad = baseDoc([
    { skillRunId: "x", skillId: "s", skillVersion: 1, status: "succeeded", proposal: { a: 1 } },
  ]);
  assert.match(validate(bad) || "", /disposition/);
});

test("a failed run carrying a proposal is refused — failure never becomes content", () => {
  const bad = baseDoc([
    { skillRunId: "x", skillId: "s", skillVersion: 1, status: "failed", proposal: { a: 1 } },
  ]);
  assert.match(validate(bad) || "", /carries a proposal/);
});

test("a runId that disagrees with skillRunId is refused", () => {
  const bad = baseDoc([
    {
      skillRunId: "x", runId: "y", skillId: "s", skillVersion: 1,
      status: "succeeded", proposal: { a: 1, disposition: "pending" },
    },
  ]);
  assert.match(validate(bad) || "", /conflicting runId/,
    "two identities for one run makes every provenance edge ambiguous");
});

test("a corrupted non-object proposal is WRAPPED, not lost and not left unusable", () => {
  // codex review rounds 4-7: leaving it alone produced a `succeeded` record
  // whose proposal can never be recognised as pending/accepted/rejected.
  const doc = MIGRATIONS[14]({
    v: 14,
    skillRuns: [
      { skillRunId: "r1", skillId: "s", skillVersion: 1, status: "proposed", proposal: ["odd"], executor: "manual" },
    ],
  });
  const r = doc.skillRuns[0];
  assert.deepEqual(r.proposal.payload, ["odd"], "the original bytes are kept");
  assert.equal(r.proposal.disposition, "pending", "and it is usable again");
  assert.equal(validate(baseDoc(doc.skillRuns)), null);
});

test("a succeeded run with a non-object proposal is refused", () => {
  const bad = baseDoc([
    { skillRunId: "x", skillId: "s", skillVersion: 1, status: "succeeded", proposal: [] },
  ]);
  assert.match(validate(bad) || "", /non-object proposal/);
});

test("the pre-v15 statuses are no longer valid", () => {
  for (const status of ["proposed", "accepted", "rejected"]) {
    const bad = baseDoc([
      { skillRunId: "x", skillId: "s", skillVersion: 1, status, proposal: { a: 1 } },
    ]);
    assert.match(validate(bad) || "", /invalid status/, status);
  }
});

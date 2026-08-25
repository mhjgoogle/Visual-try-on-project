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
  proposeRun(reg, r.runId, { premise: "p" });
  assert.equal(r.status, "succeeded", "the EXECUTION succeeded");
  assert.equal(dispositionOf(r), "pending", "the ANSWER is undecided");
  assert.ok(isPending(r));
  assert.ok(!isAccepted(r));
});

test("accepting moves the disposition and leaves the status alone", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg);
  proposeRun(reg, r.runId, { premise: "p" });
  acceptRun(reg, r.runId, "2026-08-13T00:00:00Z");
  assert.equal(r.status, "succeeded", "the run did not re-succeed; it was already done");
  assert.equal(dispositionOf(r), "accepted");
  assert.ok(isAccepted(r));
  assert.equal(r.decision, "accepted", "the pre-v15 field stays for one release");
});

test("rejecting keeps the record — a rejected proposal is the informative kind", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg);
  proposeRun(reg, r.runId, { premise: "p" });
  rejectRun(reg, r.runId, "t", "不要这个方向");
  assert.ok(isRejected(r));
  assert.deepEqual(r.proposal, { premise: "p", proposalId: r.proposal.proposalId, disposition: "rejected" });
});

test("superseded is available but nothing produces it automatically", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg);
  proposeRun(reg, r.runId, { premise: "p" });
  assert.ok(supersedeRun(reg, r.runId, "t"));
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
  proposeRun(reg, r.runId, { premise: "p" }, { at: "2026-08-13T02:00:00Z" });
  assert.equal(r.endedAt, "2026-08-13T02:00:00Z");
});

test("a manual run waits in awaiting_input and is still open", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg, { executor: "manual" });
  assert.ok(awaitInput(reg, r.runId));
  assert.equal(r.status, "awaiting_input");
  assert.ok(isOpen(r), "the creator can still bring an answer back");
  // …and the pasted answer lands exactly like a local one
  proposeRun(reg, r.runId, { premise: "p" });
  assert.ok(isPending(r));
});

// --- cancel ----------------------------------------------------------------- //

test("cancelling a running run goes through cancelling, never straight to cancelled", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg);
  cancelRun(reg, r.runId, "t");
  assert.equal(r.status, "cancelling", "a kill takes time and can fail");
  assert.equal(confirmCancelled(reg, r.runId, "t2").status, "cancelled");
});

test("a pre-execution run cancels at once — there is no process to signal", () => {
  for (const status of ["queued", "awaiting_confirmation", "awaiting_input"]) {
    const reg = createSkillRunRegistry();
    const r = mkRun(reg, { status });
    cancelRun(reg, r.runId, "t");
    assert.equal(r.status, "cancelled", status);
  }
});

test("confirmCancelled refuses anything that is not cancelling", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg);
  assert.equal(confirmCancelled(reg, r.runId, "t"), null,
    "claiming cancelled without a confirmed kill is the pretence the contract forbids");
});

test("a terminal run is never re-failed by a late error", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg);
  proposeRun(reg, r.runId, { premise: "p" });
  acceptRun(reg, r.runId, "t");
  assert.equal(failRun(reg, r.runId, "timeout", "late"), null);
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
  cancelRun(reg, r.runId, "t", "创作者放弃");
  confirmCancelled(reg, r.runId, "t");
  assert.equal(r.status, "cancelled");
  assert.ok(!isOpen(r), "an abandoned run must not stay open");
});

// --- persisted fields ------------------------------------------------------- //

test("a new run carries the contract's fields, with honest nulls", () => {
  const reg = createSkillRunRegistry();
  const r = mkRun(reg, { createdAt: "2026-08-13T00:00:00Z" });
  // TASK-074 §1.5：一个身份，**一个名字**。此前这里断言的是「两个名字、同一个值」；
  // v19 把别名删掉之后，要钉的就变成了「新记录上根本不存在那个名字」——
  // 否则某处重新写回 `skillRunId` 时没有任何东西会红。
  assert.match(r.runId, /^skillrun-/, "身份由 startRun 铸出");
  assert.ok(!("skillRunId" in r), "别名不再被写出（系统合同 §5.0）");
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
  proposeRun(reg, a.runId, { premise: "p" });
  acceptRun(reg, a.runId, "t");
  const b = mkRun(reg);
  proposeRun(reg, b.runId, { premise: "q" });
  const c = mkRun(reg);
  failRun(reg, c.runId, "timeout", "slow");
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
  const by = Object.fromEntries(doc.skillRuns.map((r) => [r.runId, r]));
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
    // 这一步产出的是 **v15** 文档：那一版两个名字都在，且必须是同一个值。
    // 别名的删除发生在 v18→v19（见本文件末尾），不在这里。
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

test("the current schema version is 19", () => {
  // v16: ADR-0073 决策 8 adds `production.shotProduction.stages` (skip decisions
  // only). A pinned number is the point — it forces whoever bumps the schema to
  // come here and say what changed, which is how the migration list stays honest.
  //
  // v17（TASK-095 §2.2 / TASK-097 批次 4C）：道具成为第三类设定对象。
  //   1. `production.props` —— 空数组，不回填任何条目。
  //   2. 每个资产的 `links.propId = null` —— **这一条才是必须升版本的原因**：
  //      `LINK_KEYS` 是「资产属于哪个对象」的唯一那份表，而校验要求每个键都在场
  //      （缺键与 null 是两种不同的「不知道」），所以新增链接键不能靠读时补。
  //
  // v18（TASK-095 §2.3 / 批次 4D）：`batches` —— 批量付费的状态必须活过一次刷新。
  //   一个已确认的批次带着报价、已花多少与「迟到回执还没收齐」；刷新丢掉它，
  //   创作者会再确认一次，而对付费批量那是**第二次真实扣费**。
  //
  // v19（TASK-074 §1.5 / 系统合同 §5.0）：删除 Run 记录自己的 `skillRunId` 别名。
  //   两个字段承载同一个值（v15 起校验就拒绝它们不等），所以删除**不丢信息**；
  //   删它的理由是读侧不必再逐处决定信哪个。外键字段（`generations[].origin`
  //   等）上叫 `skillRunId` 的那些**不动** —— 它们一个值一个名字，不是别名。
  assert.equal(CANVAS_SCHEMA_VERSION, 19);
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
    { runId: "x", skillId: "s", skillVersion: 1, status: "succeeded", proposal: { a: 1 } },
  ]);
  assert.match(validate(bad) || "", /disposition/);
});

test("a failed run carrying a proposal is refused — failure never becomes content", () => {
  const bad = baseDoc([
    { runId: "x", skillId: "s", skillVersion: 1, status: "failed", proposal: { a: 1 } },
  ]);
  assert.match(validate(bad) || "", /carries a proposal/);
});

test("v15–v18: a runId that disagrees with skillRunId is refused", () => {
  // 这条规则描述的是**别名还在的那几版**，所以文档必须真的标成 v18，
  // 而不是拿当前版本的壳子去测一条已经换了形状的规则。
  const bad = { ...baseDoc([]), v: 18, skillRuns: [
    {
      skillRunId: "x", runId: "y", skillId: "s", skillVersion: 1,
      status: "succeeded", proposal: { a: 1, disposition: "pending" },
    },
  ] };
  assert.match(validate(bad) || "", /conflicting runId/,
    "two identities for one run makes every provenance edge ambiguous");
});

test("v19：别名要么不在，要么仍是同一个值", () => {
  // 同一条不变量在 v19 换了形状 —— **两边都要有测试**，否则「别名删掉之后
  // 两个不同的 id 还能不能溜进来」这个问题没有任何东西在答。
  const conflicting = baseDoc([
    {
      runId: "x", skillRunId: "y", skillId: "s", skillVersion: 1,
      status: "succeeded", proposal: { a: 1, disposition: "pending" },
    },
  ]);
  assert.match(validate(conflicting) || "", /conflicting skillRunId alias/);

  // 相等的冗余字段**不构成信息损坏**：它顶多是一份没走完迁移的旧文档，
  // 为它拒绝整份文档只会让创作者打不开自己的项目。
  const redundant = baseDoc([
    {
      runId: "x", skillRunId: "x", skillId: "s", skillVersion: 1,
      status: "succeeded", proposal: { a: 1, disposition: "pending" },
    },
  ]);
  assert.equal(validate(redundant), null);

  // 而**没有 runId** 在 v19 就是损坏 —— 那是这条记录唯一的身份。
  const nameless = baseDoc([
    { skillRunId: "x", skillId: "s", skillVersion: 1, status: "running", proposal: null },
  ]);
  assert.match(validate(nameless) || "", /has no runId/);
});

test("v18 → v19：别名被删掉，身份一个都没少", () => {
  const v18 = {
    v: 18,
    skillRuns: [
      { skillRunId: "r1", runId: "r1", skillId: "s", skillVersion: 1, status: "running", proposal: null },
      // 只有旧名的记录（v15 之前的残留形状）：先补齐身份，再删旧名。
      { skillRunId: "r2", skillId: "s", skillVersion: 1, status: "running", proposal: null },
      // 两个名字都给不出 id —— **原样留着**，交给校验拒绝整份文档。
      // 悄悄改写不可恢复，拒绝加载可恢复（AGENTS.md 第 13 条）。
      { skillRunId: "", runId: null, skillId: "s", skillVersion: 1, status: "running", proposal: null },
    ],
  };
  const out = MIGRATIONS[18](structuredClone(v18));
  assert.equal(out.skillRuns[0].runId, "r1");
  assert.ok(!("skillRunId" in out.skillRuns[0]), "别名删掉了");
  assert.equal(out.skillRuns[1].runId, "r2", "只有旧名时，身份从旧名补齐");
  assert.ok(!("skillRunId" in out.skillRuns[1]));
  assert.equal(out.skillRuns[2].skillRunId, "", "形状不对的那条一个字节都没动");
  assert.equal(out.skillRuns[2].runId, null);

  // 无时钟、无随机：同样的输入两次跑出同样的结果。
  assert.deepEqual(MIGRATIONS[18](MIGRATIONS[18](structuredClone(v18))), out);
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
    { runId: "x", skillId: "s", skillVersion: 1, status: "succeeded", proposal: [] },
  ]);
  assert.match(validate(bad) || "", /non-object proposal/);
});

test("the pre-v15 statuses are no longer valid", () => {
  for (const status of ["proposed", "accepted", "rejected"]) {
    const bad = baseDoc([
      { runId: "x", skillId: "s", skillVersion: 1, status, proposal: { a: 1 } },
    ]);
    assert.match(validate(bad) || "", /invalid status/, status);
  }
});

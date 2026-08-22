// TASK-082 §1.1 — ⚙ 项目健康.
//
// The two rules a creator would notice if they broke:
//
//   1. The top bar's ⚠ and this panel report the SAME number, because one
//      function counts it. Two counts of one source is worse than none: the
//      creator cannot tell which is wrong.
//   2. An `unavailable` reading prints `—` WITH ITS REASON, never 0 and never a
//      blank that reads like 「没有」 (TASK-077 §1.1's rule, reused here).
//
// Pure: no DOM, no fetch, no clock. The DTO shapes below are the ones
// `src/ai_video_workflow/workspace/queries.py` really serves.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mapStanding, mapStages, mapPlan, mapProblemRows, mapApprovals,
  problemCount, problemUnion, mapProblemEnvelope, UNKNOWN,
} from "../src/services/realmap.js";
import { healthModel, renderHealth } from "../src/ui/healthws.js";

/** WQ-14 as the real project serves it: no `config/wfm1.json`, so every budget
 *  field is unavailable and ONE source problem travels in the envelope. */
const BUDGET = {
  items: [{
    budgets_jpy: { value: "no config", provenance: "unavailable" },
    episode_committed_jpy: { value: 0, provenance: "authoritative" },
    episode_outstanding_holds_jpy: { value: 0, provenance: "authoritative" },
  }],
  problems: [
    { category: "source_corrupt", detail: "config/wfm1.json 缺失", context: { source: "project" } },
  ],
};

const STATUS = {
  scope: { current_stage: "L0-S2", approved: 2, total: 8, progress: 0.25 },
  items: [],
};

const PLAN = {
  items: [
    {
      step_id: { value: "L0-S1", provenance: "authoritative" },
      level: { value: "L0", provenance: "authoritative" },
      title: { value: "项目立项", provenance: "authoritative" },
      sequence: { value: 1, provenance: "authoritative" },
      execution: { value: "human", provenance: "authoritative" },
      responsibility: { value: "producer", provenance: "authoritative" },
      gate: { value: "G1", provenance: "authoritative" },
      run_status: { value: "approved", provenance: "authoritative" },
      run_stale: { value: false, provenance: "authoritative" },
    },
    {
      step_id: { value: "S7-1", provenance: "authoritative" },
      level: { value: "S7", provenance: "authoritative" },
      title: { value: "配乐", provenance: "authoritative" },
      sequence: { value: 2, provenance: "authoritative" },
      execution: { value: "ai", provenance: "authoritative" },
      responsibility: { value: "sound", provenance: "authoritative" },
      gate: { value: null, provenance: "derived" },
      // the shape that must NEVER print as 「未开始」
      run_status: {
        value: "WFM1 does not execute this step (owner ADR-0037..0039)",
        provenance: "unavailable",
      },
      run_stale: { value: null, provenance: "unavailable" },
    },
  ],
};

const PROBLEMS = {
  items: [
    {
      kind: { value: "validation_failed", provenance: "authoritative" },
      task_id: { value: "task-3", provenance: "authoritative" },
      occurred_at: { value: "2026-08-10T09:00:00", provenance: "authoritative" },
    },
  ],
  problems: [
    { category: "source_corrupt", detail: "config/wfm1.json 缺失", context: { source: "project" } },
  ],
};

const APPROVALS = {
  items: [
    {
      stage_id: { value: "script", provenance: "authoritative" },
      status: { value: "approved", provenance: "authoritative" },
      stale: { value: false, provenance: "authoritative" },
      approved_by: { value: "mo", provenance: "authoritative" },
      approved_at: { value: "2026-08-01T10:30:00", provenance: "authoritative" },
      approved_targets: { value: [{ ref: "script", version: 3 }], provenance: "authoritative" },
      blocked_by: { value: [], provenance: "derived" },
      reason: { value: null, provenance: "derived" },
    },
    {
      stage_id: { value: "shots", provenance: "authoritative" },
      status: { value: "pending", provenance: "authoritative" },
      stale: { value: false, provenance: "authoritative" },
      approved_by: { value: null, provenance: "authoritative" },
      approved_at: { value: null, provenance: "authoritative" },
      approved_targets: { value: [], provenance: "authoritative" },
      blocked_by: { value: ["script"], provenance: "derived" },
      reason: { value: "blocked by: script", provenance: "derived" },
    },
    { audit_entry: { value: "2026-08-01 approved script", provenance: "authoritative" } },
  ],
  problems: [],
};

const full = () => healthModel({
  standing: mapStanding(BUDGET),
  status: mapStages(STATUS),
  plan: mapPlan(PLAN),
  problems: mapProblemRows(PROBLEMS),
  approvals: mapApprovals(APPROVALS),
  state: "ok",
});

test("顶栏 ⚠ 的问题数 == 项目健康分区的问题数（同一个数据源，同一个计数函数）", () => {
  const standing = mapStanding(BUDGET);
  const m = healthModel({ standing, state: "ok" });
  // the badge counts with `problemCount`; the panel reports the same number
  assert.equal(problemCount(standing), 1);
  assert.equal(m.sourceProblemCount, problemCount(standing));
  assert.equal(m.sourceProblems.length, problemCount(standing));
  // …and it is the SAME DERIVATION, not a copy that could drift. Identity of the
  // array is not the mechanism (the union builds a new one); identity of the
  // FUNCTION is — both surfaces call `problemUnion` with the same sources.
  assert.deepEqual(m.sourceProblems, problemUnion(standing));
  assert.match(renderHealth(m), /config\/wfm1\.json 缺失/);
});

test("「读不出来」和「跑出来有问题」是两件事，各报各的数，不合并", () => {
  const m = full();
  // envelope problems (what the ⚠ counts) …
  assert.equal(m.sourceProblemCount, 1);
  // … and WQ-09's problem RECORDS, which happen to also be 1 — different fact
  assert.equal(m.records.length, 1);
  assert.equal(m.records[0].kind, "validation_failed");
  assert.equal(m.records[0].entity, "task-3");
  const html = renderHealth(m);
  assert.match(html, /数据源问题 · 1/);
  assert.match(html, /问题记录 · 1/);
  // the panel says out loud that the ⚠ counts the first one
  assert.match(html, /顶栏那个 ⚠ 数的就是这一份/);
});

test("unavailable 的运行状态渲染 —，带原因，绝不渲染成「未开始」或 0", () => {
  const m = full();
  const skipped = m.plan.steps.find((s) => s.id === "S7-1");
  assert.equal(skipped.runStatus.provenance, "unavailable");
  const html = renderHealth(m);
  assert.match(html, new RegExp(`>${UNKNOWN}<`));
  // the reason rides on the row so `—` is actionable rather than merely honest
  assert.match(html, /WFM1 does not execute this step/);
  // the CELL itself is `—` and nothing else. (The panel's own prose says the word
  // 「未开始」 to explain what it is refusing to print, so the check is scoped to
  // rendered values rather than to the whole document.)
  assert.match(html, new RegExp(`<td class="hz-st unknown"[^>]*>${UNKNOWN}</td>`));
  assert.ok(!/>未开始</.test(html), "「未开始」 must never be a rendered value");
  // …and a step that IS executed still prints its real status
  assert.match(html, /已批准/);
});

test("阶段推进读不到时显示 —，不是 0", () => {
  const m = healthModel({ standing: mapStanding(BUDGET), status: mapStages({ scope: {}, items: [] }), state: "ok" });
  assert.equal(m.stage.current, null);
  assert.equal(m.stage.approved, null);
  assert.equal(m.stage.total, null);
  // `mapStages` defaults progress to 0; the panel must not print that as a
  // measurement when nothing else about the scope was readable
  const html = renderHealth(m);
  assert.ok(html.includes(UNKNOWN), "an unread scope must print — somewhere");
  assert.ok(!/>0<\/span>/.test(html), "an unread scope must never print 0");
});

test("54 步的计划照原样列出，人工 Gate 标出来", () => {
  const m = full();
  assert.equal(m.plan.total, PLAN.items.length);
  assert.equal(m.plan.steps[0].gate, "G1");
  assert.equal(m.plan.steps[1].gate, null);
  const html = renderHealth(m);
  assert.match(html, /人工 Gate/);
  assert.match(html, /项目立项/);
  assert.match(html, /配乐/);
});

test("没批准过的阶段：批准人与时间显示 —，不是空白", () => {
  const m = full();
  const pending = m.approvals.stages.find((s) => s.stage === "shots");
  assert.equal(pending.by, null);
  assert.equal(pending.at, null);
  assert.deepEqual(pending.blockedBy, ["script"]);
  assert.equal(m.approvals.audit.length, 1);
  const html = renderHealth(m);
  assert.match(html, /被阻塞|blocked by/);
  assert.match(html, /审计条目 1 条/);
});

test("读取失败时说「读不到」，不说「这个项目没问题」", () => {
  const html = renderHealth(healthModel({ state: "error", error: "后端 500" }));
  assert.match(html, /读不到项目健康数据/);
  assert.match(html, /后端 500/);
  assert.match(html, /这不是「这个项目没问题」/);
  // no fabricated zeros anywhere on a failed read
  assert.ok(!html.includes("数据源问题 · 0"));
});

test("还没读取时不假装读过", () => {
  const html = renderHealth(healthModel({}));
  assert.match(html, /还没有读取/);
  assert.match(html, /重新读取/);
});

/* ------------------------------------------------------------------------- */
/* 审查 round 1 的两条 P1                                                       */
/* ------------------------------------------------------------------------- */

test("四个查询各自的来源问题都要算，重复的只算一次（round 1 的 P1-2）", () => {
  // the SAME failure is reported by more than one query …
  const shared = { category: "source_corrupt", detail: "config/wfm1.json 缺失", context: { source: "project" } };
  // … and one of them hit something the budget read never saw
  const onlyPlan = { category: "source_corrupt", detail: "approval marker 'script' unreadable", context: { source: "approval" } };
  const standing = mapStanding(BUDGET);
  const envelopes = [
    mapProblemEnvelope({ problems: [shared, onlyPlan] }),
    mapProblemEnvelope({ problems: [shared] }),
    mapProblemEnvelope({ problems: [] }),
    mapProblemEnvelope({ problems: [shared] }),
  ];
  // counting only the budget envelope hid the second failure entirely
  assert.equal(problemCount(standing), 1);
  // the union sees it, and counts the shared one ONCE rather than four times
  assert.equal(problemCount(standing, ...envelopes), 2);
  const m = healthModel({ standing, envelopes, state: "ok" });
  assert.equal(m.sourceProblemCount, 2);
  assert.equal(m.sourceProblems.length, 2);
  // …and the ⚠ counts the very same union: one function, same arguments
  assert.deepEqual(m.sourceProblems, problemUnion(standing, ...envelopes));
  assert.match(renderHealth(m), /approval marker/);
});

test("没有额外 envelope 时，联合就是预算那一份——顶栏与面板仍然同数", () => {
  const standing = mapStanding(BUDGET);
  const m = healthModel({ standing, envelopes: [], state: "ok" });
  assert.equal(m.sourceProblemCount, problemCount(standing));
  assert.equal(m.sourceProblemCount, 1);
});

test("审批表格的每个单元格都是闭合的（round 1 的 P3，驳回后仍加了断言）", () => {
  const html = renderHealth(full());
  // the reviewer read the string concatenation as an unclosed <td>; it is not.
  // Asserted rather than argued: opening and closing tags must balance.
  const open = (html.match(/<td\b/g) || []).length;
  const close = (html.match(/<\/td>/g) || []).length;
  assert.equal(open, close, "every <td> must be closed exactly once");
  assert.equal((html.match(/<tr\b/g) || []).length, (html.match(/<\/tr>/g) || []).length);
  // …and the stale chip really sits INSIDE a cell
  assert.ok(!/<\/td>\s*<span class="chip bad">已过期<\/span>/.test(html));
});

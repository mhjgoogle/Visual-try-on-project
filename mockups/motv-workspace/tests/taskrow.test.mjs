// TASK-073 §1.3 — the six things every task row must carry, and 验收 #7.
import test from "node:test";
import assert from "node:assert/strict";

import {
  taskRowModel, renderTaskRow, renderTaskRows,
  elapsedMs, formatDuration, formatCost,
} from "../src/ui/taskrow.js";
import { RUN_STATUS_LABEL } from "../src/workflow/skillrun.js";

const T0 = "2026-08-14T10:00:00.000Z";
const T5 = "2026-08-14T10:00:05.500Z";

function run(over = {}) {
  return {
    runId: "run-1", skillRunId: "skillrun-1", taskName: "生成主画面",
    status: "succeeded", startedAt: T0, endedAt: T5,
    cost: { currency: "USD", amount: 0, basis: "subscription" },
    failureReason: null, progress: 100, executor: "claude-code", model: "x",
    ...over,
  };
}

test("§1.3: a row carries all SIX required facts", () => {
  const m = taskRowModel(run());
  assert.equal(m.statusLabel, RUN_STATUS_LABEL.succeeded); // 状态
  assert.equal(m.duration, "5.5s");                        // 耗时
  assert.equal(m.cost, "订阅内（不额外计费）");              // 成本
  assert.equal(m.failure, null);                           // 失败原因（无）
  assert.equal(m.canRetry, false);                         // 重试（成功不需要）
  assert.equal(m.canCancel, false);                        // 取消（已终态）
  const html = renderTaskRow(m);
  for (const s of ["生成主画面", "耗时 5.5s", "订阅内"]) assert.ok(html.includes(s), s);
});

test("unknown stays unknown: no invented duration, no cost of 0", () => {
  // never started → there is no elapsed time, and 「0.0s」 would be a measurement
  // nobody took
  const notStarted = taskRowModel(run({ status: "queued", startedAt: null, endedAt: null }));
  assert.equal(notStarted.durationMs, null);
  assert.equal(notStarted.duration, null);
  assert.ok(renderTaskRow(notStarted).includes("耗时未记录"));

  // cost absent → 未记录, NOT $0.00. 「不知道」 and 「不花钱」 are different answers
  // and a creator deciding whether to retry needs the difference.
  const noCost = taskRowModel(run({ cost: null }));
  assert.equal(noCost.cost, null);
  assert.ok(renderTaskRow(noCost).includes("成本未记录"));

  // a real paid amount prints as money
  assert.equal(formatCost({ currency: "USD", amount: 0.42 }), "$0.42");
  // an unparseable clock is not zero
  assert.equal(elapsedMs({ startedAt: "not a date" }), null);
  assert.equal(formatDuration(null), null);
});

test("a still-running row measures against the caller's clock, and shows progress", () => {
  const nowMs = Date.parse(T5);
  const m = taskRowModel(run({ status: "running", endedAt: null, progress: 60 }), { nowMs });
  assert.equal(m.duration, "5.5s");
  assert.equal(m.running, true);
  assert.equal(m.open, true);
  assert.ok(renderTaskRow(m).includes('style="width:60%"'));
  // with no clock supplied it refuses to guess rather than reporting 0
  assert.equal(taskRowModel(run({ status: "running", endedAt: null })).durationMs, null);
});

test("失败原因 is the backend's own words, on its own line", () => {
  const m = taskRowModel(run({
    status: "failed",
    failureReason: { category: "unavailable", detail: "claude-code 未安装" },
  }));
  assert.equal(m.failure, "claude-code 未安装");
  assert.equal(m.failureCategory, "unavailable");
  assert.equal(m.canRetry, true, "a failed run is retryable");
  const html = renderTaskRow(m);
  assert.ok(html.includes("失败原因：claude-code 未安装"));
  assert.ok(html.includes("data-task-retry"));
});

test("验收 #7: cancel is offered only while open, and says whether it reaches a process", () => {
  // A backend-minted `run-*` id means there IS a process to terminate, so the row
  // promises 「取消运行」. A front-end record (`skillrun-*`) can only be abandoned —
  // promising termination there would be a promise nothing can keep.
  const backend = taskRowModel(run({ status: "running", endedAt: null }));
  assert.equal(backend.canCancel, true);
  assert.equal(backend.cancelReachesBackend, true);
  assert.ok(renderTaskRow(backend).includes(">取消运行<"));
  assert.ok(renderTaskRow(backend).includes("data-task-cancel"));

  const local = taskRowModel(run({ status: "awaiting_input", endedAt: null, runId: "skillrun-9" }));
  assert.equal(local.cancelReachesBackend, false);
  assert.ok(renderTaskRow(local).includes(">放弃<"));

  // terminal → no cancel button at all, rather than one that does nothing
  for (const status of ["succeeded", "failed", "cancelled"]) {
    const m = taskRowModel(run({ status }));
    assert.equal(m.canCancel, false, status);
    assert.ok(!renderTaskRow(m).includes("data-task-cancel"), status);
  }
  // a caller with no cancel wiring can veto the button entirely
  assert.equal(taskRowModel(run({ status: "running", endedAt: null }), { canCancel: false }).canCancel, false);
});

test("a retry is only offered from a TERMINAL state", () => {
  // otherwise a retry could race the run it retries
  for (const status of ["failed", "cancelled"]) {
    assert.equal(taskRowModel(run({ status })).canRetry, true, status);
  }
  for (const status of ["queued", "running", "cancelling", "awaiting_input", "succeeded"]) {
    assert.equal(taskRowModel(run({ status })).canRetry, false, status);
  }
});

test("garbage in is null out; an empty list says so", () => {
  assert.equal(taskRowModel(null), null);
  assert.equal(renderTaskRow(null), "");
  assert.ok(renderTaskRows([]).includes("还没有任务记录"));
  assert.ok(renderTaskRows([null, undefined]).includes("还没有任务记录"));
});

// TASK-073 §1.4 + §1.5 — the Agent panel's seven items, and 「生成记录」.
import test from "node:test";
import assert from "node:assert/strict";

import {
  PANEL_ITEMS, HIDDEN_FIELDS, agentPanelModel, renderAgentPanel,
} from "../src/ui/agentpanel.js";
import { genRecordModel, renderGenRecord } from "../src/ui/genrecord.js";

/* --- §1.4 the panel -------------------------------------------------------- */

const FULL = {
  scope: { kind: "object", label: "SH03" },
  taskName: "为这一镜写画面提示词",
  understanding: ["读了这一镜的设计与两个参考", "读了当前主帧图 v2"],
  problems: [{ text: "还没有选定主帧图", severity: "blocking", targetLabel: "SH03" }],
  missing: [{ key: "selectedShotImage", label: "已选定的主帧图", gotoModule: "shotwork" }],
  nextSteps: ["先在步骤②选一版主画面", "再回来写视频提示词", "第三条", "第四条会被裁掉"],
  available: { ok: true },
  alternatives: [{ taskName: "让 Prompt 审核者先看一遍", why: "先修问题再生成更省钱" }],
  results: [{ label: "候选 A", version: 3, diff: "比 v2 多了雨丝" }],
  // the fields IA §6.3 forbids — deliberately fed in to prove they are dropped
  skillId: "image-prompt-director", skillVersion: 4, runtime: "local_subscription",
  executor: "claude-code", provider: "minimax", model: "abab-x",
  runId: "run-123", contextTrace: { shotId: "s3" }, promptText: "……",
};

test("验收 #4: the panel is exactly SEVEN items, and only two entrances", () => {
  assert.equal(PANEL_ITEMS.length, 7);
  assert.deepEqual(PANEL_ITEMS, [
    "problems", "understanding", "missingInputs", "nextSteps",
    "primaryAction", "alternatives", "results",
  ]);
  // the two entrances, and nothing else
  assert.equal(agentPanelModel({ scope: { kind: "object" } }).scope.kind, "object");
  assert.equal(agentPanelModel({ scope: { kind: "page" } }).scope.kind, "page");
  for (const bogus of ["sidebar", "dock", "", undefined]) {
    assert.equal(agentPanelModel({ scope: { kind: bogus } }).scope.kind, "page", String(bogus));
  }
  const html = renderAgentPanel(agentPanelModel(FULL));
  for (const title of [
    "当前发现的问题", "它对任务的理解", "缺失输入", "推荐下一步", "执行", "结果与版本差异",
  ]) {
    assert.ok(html.includes(title), `missing section: ${title}`);
  }
});

test("验收 #5: NO Skill ID / Runtime / Provider / Model / task id reaches the panel", () => {
  const html = renderAgentPanel(agentPanelModel(FULL));
  // the exact values fed in above must be absent from the rendered panel
  for (const leak of [
    "image-prompt-director", "local_subscription", "claude-code",
    "minimax", "abab-x", "run-123",
  ]) {
    assert.ok(!html.includes(leak), `leaked to the main interface: ${leak}`);
  }
  // …and the model itself carries none of the forbidden keys
  const m = agentPanelModel(FULL);
  for (const k of HIDDEN_FIELDS) {
    assert.ok(!(k in m), `model exposes ${k}`);
  }
  // what the creator DOES see is the task name
  assert.ok(html.includes("为这一镜写画面提示词"));
  // …and the panel points at where the technical detail lives
  assert.ok(html.includes("生成记录"));
});

test("ONE primary action; unavailable states the reason and renders NO button", () => {
  const ok = agentPanelModel({ ...FULL, missing: [] });
  assert.equal(ok.primary.can, true);
  const okHtml = renderAgentPanel(ok);
  assert.equal((okHtml.match(/data-agent-run/g) || []).length, 1, "exactly one primary action");

  // missing inputs are their own reason — more useful than a bare 「不可用」
  const miss = agentPanelModel(FULL);
  assert.equal(miss.primary.can, false);
  assert.match(miss.primary.blockedReason, /缺少必要输入：已选定的主帧图/);
  assert.ok(!renderAgentPanel(miss).includes("data-agent-run"), "no dead button");

  // no runtime → the runtime's own reason, and still no button
  const noRt = agentPanelModel({ ...FULL, missing: [], available: { ok: false, reason: "本机没有可用执行器" } });
  assert.equal(noRt.primary.can, false);
  assert.match(noRt.primary.blockedReason, /本机没有可用执行器/);
  assert.ok(renderAgentPanel(noRt).includes("本机没有可用执行器"));
  // an un-judged capability is NOT available (fail closed)
  assert.equal(agentPanelModel({ taskName: "x" }).primary.can, false);
});

test("missing inputs are clickable to the place that fixes them", () => {
  const html = renderAgentPanel(agentPanelModel(FULL));
  assert.ok(html.includes('data-goto="shotwork"'));
  // …and one with nowhere to go says so instead of rendering a dead link
  const nowhere = agentPanelModel({
    ...FULL, missing: [{ key: "k", label: "某个输入" }],
  });
  const h2 = renderAgentPanel(nowhere);
  assert.ok(h2.includes("没有可跳转的位置"));
  assert.ok(!h2.includes("data-goto="));
});

test("next steps are trimmed to three; alternatives stay folded", () => {
  const m = agentPanelModel(FULL);
  assert.equal(m.nextSteps.length, 3, "「一到三条」");
  const html = renderAgentPanel(m);
  // folded: a <details> cannot compete with the primary action for attention
  assert.ok(html.includes("<details class=\"ag-alt\""));
  assert.ok(html.includes("查看其他方案（1）"));
});

test("the manual fallback is present by default and can be honestly absent", () => {
  assert.ok(renderAgentPanel(agentPanelModel(FULL)).includes("data-agent-manual"));
  const no = agentPanelModel({ ...FULL, manualFallback: { can: false } });
  const html = renderAgentPanel(no);
  assert.ok(!html.includes("data-agent-manual"));
  assert.ok(html.includes("没有手工兜底"));
});

/* --- §1.5 生成记录 --------------------------------------------------------- */

test("§1.5: the record carries everything the panel hides", () => {
  const m = genRecordModel({
    run: {
      taskName: "生成主画面", status: "succeeded", skillId: "image-prompt-director",
      skillVersion: 4, runtime: "local_subscription", executor: "claude-code",
      provider: "minimax", model: "abab-x", runId: "run-123",
      startedAt: "2026-08-15T10:00:00.000Z", endedAt: "2026-08-15T10:00:04.000Z",
      cost: { currency: "USD", amount: 0.02 }, failureReason: null,
    },
    inputs: [{ label: "主帧图", version: 2 }, { label: "参考：雨夜", version: null }],
    params: { seed: 7 },
    confirmation: { by: "user", at: "2026-08-15T10:01:00.000Z" },
  });
  const html = renderGenRecord(m);
  for (const v of [
    "image-prompt-director", "v4", "local_subscription", "claude-code",
    "minimax", "abab-x", "run-123", "4.0s", "$0.02",
  ]) {
    assert.ok(html.includes(v), `record is missing ${v}`);
  }
  // inputs travel WITH their versions; an unrecorded version says so
  assert.ok(html.includes("v2"));
  assert.ok(html.includes("版本未记录"));
  assert.ok(html.includes("由 user 确认"));
});

test("§1.5: unrecorded prints 未记录 — a blank and a zero are not the same", () => {
  const m = genRecordModel({
    run: { taskName: "旧的运行", status: "succeeded", provider: null, model: null, cost: null },
  });
  const html = renderGenRecord(m);
  assert.ok(html.includes("未记录"));
  // a cost of null must NOT render as 0 — historical runs genuinely have none
  assert.ok(!html.includes("$0.00"));
  const cost = m.rows.find((r) => r.label === "成本");
  assert.equal(cost.recorded, false);
  // nothing confirmed it yet, and that is stated: 生成成功 != 定稿
  assert.equal(m.confirmation, null);
  assert.ok(html.includes("生成成功不等于定稿"));
});

test("§1.5: an imported artifact has NO provenance, and says exactly that", () => {
  const m = genRecordModel({ inputs: [], params: {} });
  assert.equal(m.empty, true);
  const html = renderGenRecord(m);
  assert.ok(html.includes("直接导入 / 手工放进来"));
  assert.ok(html.includes("不会编一个来源出来"));
  assert.equal(renderGenRecord(null), "");
});

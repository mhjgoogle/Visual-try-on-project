// 对话提出的动作**真的落到作品上**（REQ-004 v2「能干活的 Agent」/ REQ-006「Agent 的
// 可操作面 = 创作者的可操作面」）。
//
// 断言的是**行为**，不是源码文本：上一批六个 bug 全是「界面看着正常、其实什么都没发生」，
// 而当时的测试只断言了源码里有没有那个词（TASK-109 卡片里的账）。所以这里真的调
// `applyConversationEdits`，用一个记账用的假 ctx 看它到底调了创作者那条路径的哪几个函数。

import test from "node:test";
import assert from "node:assert/strict";

import { threadModel, renderThread } from "../src/ui/convthread.js";
import { applyConversationEdits, applicableEdits } from "../src/workflow/convedits.js";

/** 记账用的假 ctx —— 与真 ctx 同名同签名（`ctx.story.*` / `ctx.setDeliverySpecField`）。 */
function fakeCtx({ commitFails = false, version = 7, outlineV = 5 } = {}) {
  const calls = [];
  return {
    calls,
    story: {
      setIdea: (t) => calls.push(["setIdea", t]),
      editBrief: (f) => calls.push(["editBrief", f]),
      commitBrief: (origin, instruction) => {
        calls.push(["commitBrief", origin, instruction]);
        if (commitFails) throw new Error("磁盘满了");
        return { v: version };
      },
      applyManualOutline: (f) => { calls.push(["applyManualOutline", f]); return { v: outlineV }; },
      approveOutline: (v) => { calls.push(["approveOutline", v]); return true; },
      setActiveOutline: (v) => { calls.push(["setActiveOutline", v]); return true; },
      setActiveBrief: (v) => { calls.push(["setActiveBrief", v]); return true; },
      editPlanEntry: (id, f, v) => { calls.push(["editPlanEntry", id, f, v]); return true; },
      savePlanDraft: () => { calls.push(["savePlanDraft"]); return 3; },
    },
    setDeliverySpecField: (k, v) => {
      calls.push(["setDeliverySpecField", k, v]);
      return { ok: true };
    },
  };
}

const turnWith = (edits, instruction = "帮我把类型改成悬疑") => ({
  instruction,
  outputs: { conversation: { reply: "好", edits, unsupported: [] } },
});

/* --- 走创作者那条写路径 ---------------------------------------------------- */

test("brief.fields 走 editBrief + commitBrief，成为新的一版", () => {
  const ctx = fakeCtx();
  const landed = applyConversationEdits(
    ctx,
    turnWith([{ kind: "brief.fields", text: "把类型改成悬疑", fields: { genre: "悬疑" } }]),
  );
  assert.deepEqual(ctx.calls[0], ["editBrief", { genre: "悬疑" }]);
  assert.deepEqual(ctx.calls[1], ["commitBrief", "developed", "帮我把类型改成悬疑"]);
  assert.equal(landed[0].detail, "类型/题材 → 悬疑（创意简报 v7）");
  assert.equal(landed[0].error, undefined);
});

test("一轮里改了创意又改了字段 —— 只提交一次，成为同一版", () => {
  const ctx = fakeCtx({ version: 9 });
  const landed = applyConversationEdits(ctx, turnWith([
    { kind: "brief.idea", text: "新的核心创意" },
    { kind: "brief.fields", text: "改类型", fields: { genre: "悬疑", tone: "冷" } },
  ]));
  assert.equal(ctx.calls.filter((c) => c[0] === "commitBrief").length, 1);
  assert.equal(landed.length, 2);
  assert.ok(landed.every((x) => x.detail.includes("创意简报 v9")));
});

test("outline.fields 走创作者那条大纲路径，自己就成一版（不借简报的提交）", () => {
  const ctx = fakeCtx({ outlineV: 5 });
  const landed = applyConversationEdits(ctx, turnWith([{
    kind: "outline.fields",
    text: "把一句话故事写实",
    fields: { logline: "被抹除的人在终局世界里找回自己", protagonist: { who: "林照" } },
  }]));
  const call = ctx.calls.find((c) => c[0] === "applyManualOutline");
  assert.ok(call, "没有走 applyManualOutline");
  assert.equal(call[1].logline, "被抹除的人在终局世界里找回自己");
  assert.deepEqual(call[1].protagonist, { who: "林照" });
  assert.equal(
    ctx.calls.filter((c) => c[0] === "commitBrief").length, 0,
    "大纲不该触发简报提交",
  );
  assert.match(landed[0].detail, /故事大纲 v5/);
});

test("批准 / 切换版本这类闸门动作，Agent 也能做 —— 用户能点的它就能点", () => {
  const ctx = fakeCtx();
  applyConversationEdits(ctx, turnWith([
    { kind: "outline.approve", text: "批准 v4", args: { v: 4 } },
    { kind: "brief.setActive", text: "改用 v2", args: { v: 2 } },
  ]));
  assert.deepEqual(ctx.calls.find((c) => c[0] === "approveOutline"), ["approveOutline", 4]);
  assert.deepEqual(ctx.calls.find((c) => c[0] === "setActiveBrief"), ["setActiveBrief", 2]);
});

test("分集规划：改一条 + 保存成新一版；确认仍然留给创作者", () => {
  const ctx = fakeCtx();
  const landed = applyConversationEdits(ctx, turnWith([
    {
      kind: "plan.entry",
      text: "改 EP03 的标题",
      args: { episodeId: "ep-3", field: "title", value: "引路人的价码" },
    },
    { kind: "plan.save", text: "保存" },
  ]));
  assert.deepEqual(ctx.calls[0], ["editPlanEntry", "ep-3", "title", "引路人的价码"]);
  assert.deepEqual(ctx.calls[1], ["savePlanDraft"]);
  assert.match(landed[1].detail, /还需你在页面上确认/);
  assert.ok(!ctx.calls.some((c) => c[0] === "confirmPlan"), "确认会绑定剧集身份，不在表里");
});

test("交付规格也在表里 —— 它是设置页上他自己能改的东西", () => {
  const ctx = fakeCtx();
  applyConversationEdits(ctx, turnWith([
    { kind: "settings.delivery", text: "改宽高比", args: { field: "aspect", value: "9:16" } },
  ]));
  assert.deepEqual(ctx.calls[0], ["setDeliverySpecField", "aspect", "9:16"]);
});

test("表里没有的动作不落地，也不假装落了", () => {
  const ctx = fakeCtx();
  const landed = applyConversationEdits(ctx, turnWith([
    { kind: "story.publish", text: "帮我发布到抖音" },
    { kind: "note", text: "帮我发邮件" },
  ]));
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(landed, []);
});

test("没有可落的动作时，绝不无谓地新建一版", () => {
  const ctx = fakeCtx();
  applyConversationEdits(ctx, turnWith([]));
  assert.deepEqual(ctx.calls, []);
});

test("提交失败要说出来，不能显示成落好了", () => {
  const ctx = fakeCtx({ commitFails: true });
  const landed = applyConversationEdits(
    ctx,
    turnWith([{ kind: "brief.fields", text: "改类型", fields: { genre: "悬疑" } }]),
  );
  assert.equal(landed[0].error, "磁盘满了");
});

test("一条落不下去不连累别的", () => {
  const ctx = fakeCtx();
  ctx.story.approveOutline = () => false; // 没有那一版
  const landed = applyConversationEdits(ctx, turnWith([
    { kind: "outline.approve", text: "批准 v99", args: { v: 99 } },
    { kind: "brief.fields", text: "改类型", fields: { genre: "悬疑" } },
  ]));
  assert.match(landed[0].error, /没有故事大纲 v99/);
  assert.equal(landed[1].error, undefined);
});

test("applicableEdits 只认注册表里有的 kind", () => {
  const run = turnWith([
    { kind: "brief.idea", text: "x" },
    { kind: "outline.fields", text: "y", fields: { logline: "z" } },
    { kind: "story.publish", text: "做不到的" },
    { kind: "note", text: "帮我发布" },
  ]);
  assert.deepEqual(applicableEdits(run).map((e) => e.kind), ["brief.idea", "outline.fields"]);
});

/* --- 屏幕上「说要改」与「已经改了」是两件事 -------------------------------- */

test("落过的改动移出「还没落到作品上」，并说清成了第几版", () => {
  const m = threadModel(
    [
      { turnId: "t1", role: "user", text: "帮我把类型改成悬疑" },
      {
        turnId: "t2", role: "agent", runId: "run-1", status: "succeeded",
        text: "已经把类型改成悬疑。",
        edits: [{ kind: "brief.fields", text: "把类型改成悬疑" }],
        unsupported: [],
      },
    ],
    { applied: { "run-1": [{ kind: "brief.fields", detail: "类型/题材 → 悬疑（创意简报 v7）" }] } },
  );
  const agent = m.rows.find((r) => r.role === "agent");
  assert.equal(agent.applied[0].detail, "类型/题材 → 悬疑（创意简报 v7）");
  assert.deepEqual(agent.edits, [], "同一条不许同时挂在两个标题下");
});

test("还没落的仍然是建议", () => {
  const m = threadModel([{
    turnId: "t2", role: "agent", runId: "run-2", status: "succeeded", text: "我建议这样改",
    edits: [{ kind: "brief.fields", text: "把类型改成悬疑" }],
    unsupported: [],
  }], { applied: {} });
  assert.equal(m.rows[0].applied.length, 0);
  assert.equal(m.rows[0].edits.length, 1);
});

test("注册表里没有的 kind，屏幕上归到「本应用还做不到」", () => {
  const m = threadModel([{
    turnId: "t", role: "agent", runId: "r", status: "succeeded", text: "做不到",
    edits: [{ kind: "story.publish", text: "发布到抖音" }],
    unsupported: [],
  }]);
  assert.deepEqual(m.rows[0].edits, []);
  assert.equal(m.rows[0].unsupported.length, 1);
});

test("意见（feedback.ui）算「做得到」—— 它由服务端记进台账", () => {
  const m = threadModel([{
    turnId: "t", role: "agent", runId: "r", status: "succeeded", text: "记下了",
    edits: [{ kind: "feedback.ui", text: "版本太多了" }],
    applied: [{ kind: "feedback.ui", detail: "已记下这条意见（#3），下次开发时会看到" }],
  }]);
  assert.equal(m.rows[0].unsupported.length, 0);
  assert.equal(m.rows[0].applied.length, 1);
});

test("applied 按 RUN 归属，不会落到别的轮次上", () => {
  const m = threadModel([
    { turnId: "a", role: "agent", runId: "run-A", status: "succeeded", text: "第一轮", edits: [] },
    { turnId: "b", role: "agent", runId: "run-B", status: "succeeded", text: "第二轮", edits: [] },
  ], { applied: { "run-B": [{ kind: "brief.idea", detail: "新创意" }] } });
  assert.equal(m.rows[0].applied.length, 0);
  assert.equal(m.rows[1].applied.length, 1);
});

test("落地失败被带出来，不被吞掉", () => {
  const m = threadModel([{
    turnId: "t", role: "agent", runId: "run-3", status: "succeeded", text: "改好了",
    edits: [{ kind: "brief.idea", text: "新的核心创意" }],
  }], { applied: { "run-3": [{ kind: "brief.idea", detail: "新的核心创意", error: "写入失败" }] } });
  assert.equal(m.rows[0].applied[0].error, "写入失败");
});

test("服务端存的 applied 优先于内存那份 —— 刷新之后仍然是「已落到作品上」", () => {
  const m = threadModel([{
    turnId: "t", role: "agent", runId: "run-9", status: "succeeded", text: "改好了",
    edits: [{ kind: "brief.fields", text: "改类型" }],
    applied: [{ kind: "brief.fields", detail: "类型/题材 → 悬疑（创意简报 v2）" }],
  }], { applied: {} });
  assert.equal(m.rows[0].applied.length, 1);
  assert.equal(m.rows[0].edits.length, 0);
});

/* --- 还没落下的改动要有出口 ------------------------------------------------ */

test("一条能落却还没落的改动，屏幕上有「落到作品上」", () => {
  const html = renderThread(threadModel([{
    turnId: "t", role: "agent", runId: "run-7", status: "succeeded", text: "已经改好了",
    edits: [{ kind: "brief.fields", text: "把类型改成悬疑" }],
  }]));
  assert.match(html, /data-cv-apply="run-7"/);
  assert.match(html, /落到作品上/);
});

test("已经落过的那一轮不再给出口 —— 否则会落第二遍", () => {
  const html = renderThread(threadModel([{
    turnId: "t", role: "agent", runId: "run-7", status: "succeeded", text: "已经改好了",
    edits: [{ kind: "brief.fields", text: "把类型改成悬疑" }],
    applied: [{ kind: "brief.fields", detail: "类型/题材 → 悬疑（创意简报 v7）" }],
  }]));
  assert.doesNotMatch(html, /data-cv-apply/);
  assert.match(html, /已落到作品上/);
});

test("做不到的事不给出口", () => {
  const html = renderThread(threadModel([{
    turnId: "t", role: "agent", runId: "run-9", status: "succeeded", text: "做不到",
    edits: [], unsupported: [{ kind: "note", text: "帮我发布" }],
  }]));
  assert.doesNotMatch(html, /data-cv-apply/);
});

test("落不下的那一条不许同时出现在「已落到作品上」里", () => {
  const html = renderThread(threadModel([{
    turnId: "t", role: "agent", runId: "run-5", status: "succeeded", text: "改好了",
    edits: [{ kind: "outline.fields", text: "改一句话故事" }],
    applied: [{ kind: "outline.fields", detail: "一句话故事 → x", error: "写不进去" }],
  }]));
  assert.doesNotMatch(html, /已落到作品上/);
  assert.match(html, /有改动没能落下：写不进去/);
});

test("服务端自己处理的那几种不算「做不到」（真机上撞见过：一条同时出现在两个标题下）", () => {
  for (const kind of ["feedback.ui", "proposal.decide"]) {
    const m = threadModel([{
      turnId: "t", role: "agent", runId: "r", status: "succeeded", text: "好",
      edits: [{ kind, text: "…" }],
      applied: [{ kind, detail: "已记下" }],
    }]);
    assert.equal(m.rows[0].unsupported.length, 0, kind);
    assert.equal(m.rows[0].applied.length, 1, kind);
  }
});

test("dev.request 也是服务端处理的那一类 —— 真机上它一度同时挂在两个标题下", () => {
  const m = threadModel([{
    turnId: "t", role: "agent", runId: "r", status: "succeeded", text: "已交给开发",
    edits: [{ kind: "dev.request", text: "精简左侧导航" }],
    applied: [{ kind: "dev.request", detail: "已交给开发，正在写方案" }],
  }]);
  assert.equal(m.rows[0].unsupported.length, 0);
  assert.equal(m.rows[0].applied.length, 1);
});

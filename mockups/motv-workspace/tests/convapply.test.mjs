// TASK-111 —— Agent 提出的改动**真的落到作品上**（REQ-004 v2 判据「对话的另一端是能
// 干活的 Agent」的后半段）。
//
// 断言的是**行为**，不是源码文本：上一批六个 bug 全是「界面看着正常、其实什么都没发生」，
// 而当时的测试只断言了源码里有没有那个词（TASK-109 卡片里的账）。所以这里真的调
// `threadModel`、真的喂一条终态 run，检查「已落到作品上」与「还没落到作品上」是两件事。

import test from "node:test";
import assert from "node:assert/strict";

import { threadModel } from "../src/ui/convthread.js";

/* --- 落地后，同一条改动不再挂在「建议」下面 -------------------------------- */

test("applied edits move out of 「它建议的改动」 and say which version they became", () => {
  const turns = [
    { turnId: "t1", role: "user", text: "帮我把类型改成悬疑" },
    {
      turnId: "t2",
      role: "agent",
      runId: "run-1",
      status: "succeeded",
      text: "已经把类型改成悬疑。",
      edits: [{ kind: "brief.fields", text: "把类型改成悬疑" }],
      unsupported: [],
    },
  ];
  const m = threadModel(turns, {
    applied: { "run-1": [{ kind: "brief.fields", detail: "类型/题材 → 悬疑（创意简报 v7）" }] },
  });
  const agent = m.rows.find((r) => r.role === "agent");
  assert.equal(agent.applied.length, 1);
  assert.equal(agent.applied[0].detail, "类型/题材 → 悬疑（创意简报 v7）");
  // 同一条不能既在「已落到作品上」又在「还没落到作品上」
  assert.deepEqual(agent.edits, []);
});

test("an edit that was NOT applied stays a proposal", () => {
  const turns = [{
    turnId: "t2",
    role: "agent",
    runId: "run-2",
    status: "succeeded",
    text: "我建议这样改大纲。",
    edits: [{ kind: "story.outline", text: "第三幕改成……" }],
    unsupported: [],
  }];
  const m = threadModel(turns, { applied: {} });
  const agent = m.rows[0];
  assert.equal(agent.applied.length, 0);
  assert.equal(agent.edits.length, 1);
  assert.equal(agent.edits[0].kind, "story.outline");
});

test("applied is keyed by RUN, so it cannot land on the wrong turn", () => {
  const turns = [
    { turnId: "a", role: "agent", runId: "run-A", status: "succeeded", text: "第一轮", edits: [] },
    { turnId: "b", role: "agent", runId: "run-B", status: "succeeded", text: "第二轮", edits: [] },
  ];
  const m = threadModel(turns, { applied: { "run-B": [{ kind: "brief.idea", detail: "新创意" }] } });
  assert.equal(m.rows[0].applied.length, 0);
  assert.equal(m.rows[1].applied.length, 1);
});

test("a failed apply is carried, not swallowed", () => {
  const turns = [{
    turnId: "t", role: "agent", runId: "run-3", status: "succeeded", text: "改好了",
    edits: [{ kind: "brief.idea", text: "新的核心创意" }],
  }];
  const m = threadModel(turns, {
    applied: { "run-3": [{ kind: "brief.idea", detail: "新的核心创意", error: "写入失败" }] },
  });
  assert.equal(m.rows[0].applied[0].error, "写入失败");
});

test("threadModel without an applied map behaves exactly as before", () => {
  const turns = [{
    turnId: "t", role: "agent", runId: "r", status: "succeeded", text: "答",
    edits: [{ kind: "brief.fields", text: "改类型" }],
  }];
  const m = threadModel(turns);
  assert.equal(m.rows[0].applied.length, 0);
  assert.equal(m.rows[0].edits.length, 1);
});

/* --- 真的走创作者那条写路径 ------------------------------------------------ */

import { applyConversationEdits, applicableEdits } from "../src/workflow/convedits.js";

/** 记账用的假 story facade —— 与 ctx.story 同名同签名。 */
function fakeStory({ commitFails = false, version = 7 } = {}) {
  const calls = [];
  return {
    calls,
    setIdea: (t) => calls.push(["setIdea", t]),
    editBrief: (f) => calls.push(["editBrief", f]),
    commitBrief: (origin, instruction) => {
      calls.push(["commitBrief", origin, instruction]);
      if (commitFails) throw new Error("磁盘满了");
      return { v: version };
    },
  };
}

const turnWith = (edits, instruction = "帮我把类型改成悬疑") => ({
  instruction,
  outputs: { conversation: { reply: "好", edits, unsupported: [] } },
});

test("一条 brief.fields 走 editBrief + commitBrief，成为新的一版", () => {
  const story = fakeStory();
  const landed = applyConversationEdits(
    story,
    turnWith([{ kind: "brief.fields", text: "把类型改成悬疑", fields: { genre: "悬疑" } }]),
  );
  assert.deepEqual(story.calls[0], ["editBrief", { genre: "悬疑" }]);
  assert.deepEqual(story.calls[1], ["commitBrief", "developed", "帮我把类型改成悬疑"]);
  assert.equal(landed.length, 1);
  assert.equal(landed[0].detail, "类型/题材 → 悬疑（创意简报 v7）");
  assert.equal(landed[0].error, undefined);
});

test("一轮里改了创意又改了字段 —— 只提交一次，成为同一版", () => {
  const story = fakeStory({ version: 9 });
  const landed = applyConversationEdits(story, turnWith([
    { kind: "brief.idea", text: "新的核心创意" },
    { kind: "brief.fields", text: "改类型", fields: { genre: "悬疑", tone: "冷" } },
  ]));
  assert.equal(story.calls.filter((c) => c[0] === "commitBrief").length, 1);
  assert.equal(landed.length, 2);
  assert.ok(landed.every((x) => x.detail.includes("创意简报 v9")));
});

test("story.outline 不在这条路径上落地 —— 它仍然只是建议", () => {
  const story = fakeStory();
  const landed = applyConversationEdits(
    story,
    turnWith([{ kind: "story.outline", text: "第三幕改成……" }]),
  );
  assert.deepEqual(story.calls, [], "大纲不许被这条路径改写");
  assert.deepEqual(landed, []);
});

test("没有可落的改动时，绝不无谓地新建一版", () => {
  const story = fakeStory();
  applyConversationEdits(story, turnWith([]));
  assert.deepEqual(story.calls, []);
});

test("提交失败要说出来，不能显示成落好了", () => {
  const story = fakeStory({ commitFails: true });
  const landed = applyConversationEdits(
    story,
    turnWith([{ kind: "brief.fields", text: "改类型", fields: { genre: "悬疑" } }]),
  );
  assert.equal(landed[0].error, "磁盘满了");
});

test("applicableEdits 只认这条路径真能落的两种", () => {
  const run = turnWith([
    { kind: "brief.idea", text: "x" },
    { kind: "brief.fields", text: "y", fields: { genre: "悬疑" } },
    { kind: "brief.fields", text: "没有 fields 的那种" },
    { kind: "story.outline", text: "z" },
    { kind: "note", text: "帮我发布" },
  ]);
  assert.deepEqual(applicableEdits(run).map((e) => e.kind), ["brief.idea", "brief.fields"]);
});

/* --- 回执让「已落到作品上」熬过刷新 ---------------------------------------- */

test("服务端记下的 applied 优先于内存里那份 —— 刷新之后仍然是「已落到作品上」", () => {
  const turns = [{
    turnId: "t", role: "agent", runId: "run-9", status: "succeeded", text: "改好了",
    edits: [{ kind: "brief.fields", text: "改类型" }],
    applied: [{ kind: "brief.fields", detail: "类型/题材 → 悬疑（创意简报 v2）" }],
  }];
  // 内存表是空的（新开的标签页），落地信息只能来自线程本身
  const m = threadModel(turns, { applied: {} });
  assert.equal(m.rows[0].applied.length, 1);
  assert.equal(m.rows[0].edits.length, 0, "落过的改动不许再挂在「建议」下面");
});

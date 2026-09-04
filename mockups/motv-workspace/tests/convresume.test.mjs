// 刷新之后，还在跑的那一轮要被接回来（TASK-106 · REQ-004 判据 6）。
//
// WHAT WAS BROKEN. 线程是服务端的（关掉页面问题还在），**运行不是** —— 轮询它的那个
// 标签页已经没了。于是刷新之后屏幕上是一个没有答案、也没有任何「还在做」迹象的问题：
// 他会再问一遍，而先起的那一轮落地时**没有人在等**（落地只能发生在浏览器，
// ADR-0089 决策 2b），改动就这么丢了。
//
// 这里守的是三件事，每一件都是「看起来没在跑」的一种写法：
//   1. 从线程本身认出那一轮 —— 用户那条 turn 有 runId，服务端会用**同一个 id** 写回
//      Agent 那条（`_conv_reconcile`）。所以「有问没答」= 还没落地，不需要第二份账。
//   2. **问不到 ≠ 没在跑**（TASK-106 验收 4）。后端答不上来时要说「状态未知」，
//      说「没在跑」会让他再起一份。
//   3. **已经结束的那一轮也要落地**。线程是在读状态**之前**读的，所以刚刚结束的
//      那一轮有一条页面从没见过的 Agent turn —— 把终态当成「没事可做」，正好丢掉
//      它的 edits（codex 轮 1 的 P1）。
import test from "node:test";
import assert from "node:assert/strict";

import {
  pendingRunIdIn, turnTextOf, isTerminal, runState, resumePlan, hasUnlandedEdits,
} from "../src/services/conversation.js";
import { resumeThreadRun } from "../src/workflow/convresume.js";
import { awaitTurn } from "../src/services/conversation.js";
import { applyConversationEdits } from "../src/workflow/convedits.js";
import { threadModel, renderThread } from "../src/ui/convthread.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => "application/json" },
  json: async () => body,
});

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return handler(path, init);
  };
  return calls;
}

test("有问没答的那一轮就是还没落地的那一轮", () => {
  const turns = [
    { turnId: "u-1", role: "user", text: "改一下大纲", runId: "r1" },
    { turnId: "t-1", role: "agent", runId: "r1", status: "succeeded", text: "改好了" },
    { turnId: "u-2", role: "user", text: "再把第三段展开", runId: "r2" },
  ];
  assert.equal(pendingRunIdIn(turns), "r2");
  assert.equal(turnTextOf(turns, "r2"), "再把第三段展开");
});

test("每一轮都答过了 → 没有待接回的运行", () => {
  const turns = [
    { turnId: "u-1", role: "user", text: "a", runId: "r1" },
    { turnId: "t-1", role: "agent", runId: "r1", status: "succeeded" },
  ];
  assert.equal(pendingRunIdIn(turns), null);
});

test("答复失败也算答过 —— 失败是终态，不是「还在跑」", () => {
  const turns = [
    { turnId: "u-1", role: "user", text: "a", runId: "r1" },
    { turnId: "t-1", role: "agent", runId: "r1", status: "failed" },
  ];
  assert.equal(pendingRunIdIn(turns), null);
});

test("没有 runId 的本地回显不会被当成一轮运行", () => {
  // 发送时先在屏幕上画一条 `local-…`（否则看起来像没发出去）。它没有 runId，
  // 因此不该被恢复逻辑读成「有一轮在跑」。
  const turns = [{ turnId: "local-9", role: "user", text: "刚打的字" }];
  assert.equal(pendingRunIdIn(turns), null);
});

test("取最后一条没答的 —— 前面若有更早的悬空轮，不抢当前这一轮", () => {
  const turns = [
    { turnId: "u-1", role: "user", text: "老的", runId: "old" },
    { turnId: "u-2", role: "user", text: "新的", runId: "new" },
  ];
  assert.equal(pendingRunIdIn(turns), "new");
});

test("坏输入不炸：不是数组、不是对象，一律回 null", () => {
  assert.equal(pendingRunIdIn(null), null);
  assert.equal(pendingRunIdIn(undefined), null);
  assert.equal(pendingRunIdIn([null, 3, "x"]), null);
  assert.equal(turnTextOf(null, "r1"), "");
  assert.equal(turnTextOf([{ role: "user", runId: "r1" }], "r1"), "");
});

test("终态判定：四个终态之外都还在跑", () => {
  for (const s of ["succeeded", "failed", "cancelled", "awaiting_input"]) {
    assert.equal(isTerminal(s), true, s);
  }
  for (const s of ["queued", "running", "cancelling", "", null, "unknown"]) {
    assert.equal(isTerminal(s), false, String(s));
  }
});

test("读运行状态必须带上项目 —— 不带项目 = 一个项目的看板能看见另一个项目的运行", async () => {
  const calls = stubFetch(() => jsonRes(200, { run_id: "r1", status: "running" }));
  const run = await runState("我的项目", "r1");
  assert.equal(run.status, "running");
  assert.match(calls[0].path, /\/api\/runs\/r1\?project=/);
  assert.match(calls[0].path, /project=%E6%88%91%E7%9A%84%E9%A1%B9%E7%9B%AE/);
});

test("问不到就是问不到 —— 返回 null，由调用方说「状态未知」而不是「没在跑」", async () => {
  stubFetch(() => jsonRes(500, { error: { category: "server", detail: "boom" } }));
  assert.equal(await runState("p", "r1"), null);
  // 少了任一半都不许发请求：没有 runId、没有项目，问出去的都是错问题
  assert.equal(await runState("p", ""), null);
  assert.equal(await runState("", "r1"), null);
});

/* --- 恢复的判定本身（codex 轮 1 的 P1 + 证据不足）------------------------- */

test("**已经结束的也要落地** —— 线程是在读状态之前读的", () => {
  // codex 轮 1 P1：原来这里在终态上直接 return，于是「读线程」与「读状态」之间
  // 结束的那一轮，它的 Agent turn 页面从没见过，edits **永远不会被落地**
  // —— 而落地只能发生在浏览器（ADR-0089 决策 2b）。这是一次静默的改动丢失。
  for (const status of ["succeeded", "failed", "cancelled", "awaiting_input"]) {
    assert.equal(resumePlan({ status }), "land", status);
  }
});

test("还在跑的当然要落地（等它结束）", () => {
  for (const status of ["queued", "running", "cancelling"]) {
    assert.equal(resumePlan({ status }), "land", status);
  }
});

test("问不到 → unknown，而且**只有**问不到才是 unknown", () => {
  assert.equal(resumePlan(null), "unknown");
  assert.equal(resumePlan(undefined), "unknown");
  assert.equal(resumePlan({}), "unknown");
  assert.equal(resumePlan({ status: "" }), "unknown");
  assert.equal(resumePlan({ status: 7 }), "unknown");
  assert.equal(resumePlan("running"), "unknown");
});

test("「状态未知」真的画在屏幕上 —— 不是「没在跑」，也不是一片空白", () => {
  // TASK-106 验收 4 的可见那一半：恢复失败时 `pendingStatus = "unknown"`，
  // 对话流必须把它说出来。
  const html = renderThread(threadModel(
    [{ turnId: "u-1", role: "user", text: "改一下大纲", runId: "r1" }],
    { pendingRun: "r1", pendingStatus: "unknown" },
  ));
  assert.match(html, /状态未知/);
  assert.doesNotMatch(html, /没在跑/);
});

test("恢复中的那一轮在屏幕上有形状 —— 「正在想…」而不是一个没有答案的问题", () => {
  const html = renderThread(threadModel(
    [{ turnId: "u-1", role: "user", text: "改一下大纲", runId: "r1" }],
    { pendingRun: "r1", pendingStatus: "running" },
  ));
  assert.match(html, /正在想/);
});

test("接线：shell 里那个恢复函数只是个适配器 —— 判定不许在它身上", () => {
  // 源码断言是**故意**的，但断的东西变了：判定与顺序已经搬进 `workflow/convresume.js`
  // 并被上面那组真的跑过一遍的测试覆盖，所以这里只钉「shell 没有自己再判一次」——
  // 一份影子判定正是「发送时对、恢复时不对」的产生方式。
  const src = readFileSync(join(HERE, "..", "src", "ui", "production.js"), "utf8");
  const at = src.indexOf("function resumePendingRun(");
  assert.ok(at > 0, "resumePendingRun 不见了");
  const next = src.indexOf(String.fromCharCode(10) + "  function ", at + 1);
  const body = src.slice(at, next > 0 ? next : src.length);
  assert.ok(body.includes("resumeThreadRun({"), "恢复必须走那个模块");
  assert.ok(body.includes("landRun("), "落地由 shell 注入（只有它拿得到 ctx）");
  assert.ok(!body.includes("isTerminal("), "终态不再是一条分支");
  assert.ok(!body.includes("if (resumePlan("), "shell 不许自己再判一次");
});

/* --- 答了但改动没落地（codex 轮 2 的 P1）---------------------------------- */

test("**关掉标签页那种**：答案在、改动没落地 → 仍然要接回来", () => {
  // codex 轮 2 P1。这是最常见的一种：run 在服务端跑完了，`_conv_reconcile` 把答案
  // 折进线程，而它提议的 edits **没有任何浏览器落过** —— 因为落地只有浏览器能做
  // （ADR-0089 决策 2b）。把「有一条 Agent turn」读成「落地已经完成」，
  // 是从一件不能证明它的事上做推断，代价是**静默且永久**地丢掉那些改动。
  const turns = [
    { turnId: "u-1", role: "user", text: "把第二段改写", runId: "r1" },
    {
      turnId: "t-1", role: "agent", runId: "r1", status: "succeeded",
      text: "改好了", edits: [{ kind: "work.core", fields: { logline: "x" } }],
    },
  ];
  assert.equal(pendingRunIdIn(turns), "r1");
  assert.equal(turnTextOf(turns, "r1"), "把第二段改写");
});

test("有回执 = 落过了 → 不重复落", () => {
  const turns = [
    { turnId: "u-1", role: "user", text: "a", runId: "r1" },
    {
      turnId: "t-1", role: "agent", runId: "r1", status: "succeeded",
      edits: [{ kind: "work.core" }], applied: [{ kind: "work.core", version: 3 }],
    },
  ];
  assert.equal(pendingRunIdIn(turns), null);
});

test("没提议过改动的那一轮没有东西可落 —— 纯聊天不该被反复接回", () => {
  const turns = [
    { turnId: "u-1", role: "user", text: "你能看到全文吗", runId: "r1" },
    { turnId: "t-1", role: "agent", runId: "r1", status: "succeeded", text: "能", edits: [] },
  ];
  assert.equal(pendingRunIdIn(turns), null);
  assert.equal(hasUnlandedEdits({ edits: [], applied: [] }), false);
  assert.equal(hasUnlandedEdits({ edits: [{ kind: "x" }] }), true);
  assert.equal(hasUnlandedEdits(null), false);
});

/* --- 整条恢复链，真的跑一遍（codex 轮 2 判的证据不足）--------------------- */

function harness({ turns, run, readThrows = false, taken = null }) {
  const seen = { statuses: [], landed: [], asked: [] };
  return resumeThreadRun({
    project: "我的项目",
    turns,
    pendingRunIdIn,
    resumePlan,
    readRun: (p, runId) => {
      seen.asked.push([p, runId]);
      if (readThrows) return Promise.reject(new Error("网络断了"));
      return Promise.resolve(run);
    },
    claim: (runId) => taken !== runId,
    onStatus: (s) => seen.statuses.push(s),
    land: (runId) => { seen.landed.push(runId); return Promise.resolve(); },
  }).then((out) => ({ ...out, seen }));
}

const RUNNING_THREAD = [{ turnId: "u-1", role: "user", text: "改大纲", runId: "r1" }];

test("整条链 · 还在跑 → 报状态 + 落地，并且带着项目去问", async () => {
  const r = await harness({ turns: RUNNING_THREAD, run: { status: "running" } });
  assert.equal(r.action, "landed");
  assert.deepEqual(r.seen.statuses, ["running"]);
  assert.deepEqual(r.seen.landed, ["r1"]);
  assert.deepEqual(r.seen.asked, [["我的项目", "r1"]]);
});

test("整条链 · **问不到** → 屏幕说 unknown，而且一次都不落地", async () => {
  // TASK-106 验收 4，真的跑一遍：后端答不上来时既不能说「没在跑」，
  // 也不能当作已经结束把它落掉。
  const r = await harness({ turns: RUNNING_THREAD, run: null });
  assert.equal(r.action, "unknown");
  assert.deepEqual(r.seen.statuses, ["unknown"]);
  assert.deepEqual(r.seen.landed, []);
});

test("整条链 · 读请求直接抛出 → 与问不到同一个答案", async () => {
  const r = await harness({ turns: RUNNING_THREAD, run: null, readThrows: true });
  assert.equal(r.action, "unknown");
  assert.deepEqual(r.seen.statuses, ["unknown"]);
  assert.deepEqual(r.seen.landed, []);
});

test("整条链 · 已经结束 → 照样落地（轮 1 的那条 P1）", async () => {
  const r = await harness({ turns: RUNNING_THREAD, run: { status: "succeeded" } });
  assert.equal(r.action, "landed");
  assert.deepEqual(r.seen.landed, ["r1"]);
});

test("整条链 · 答案在、回执不在 → 落地（轮 2 的那条 P1）", async () => {
  const turns = [
    { turnId: "u-1", role: "user", text: "改大纲", runId: "r1" },
    {
      turnId: "t-1", role: "agent", runId: "r1", status: "succeeded",
      edits: [{ kind: "work.core" }],
    },
  ];
  const r = await harness({ turns, run: { status: "succeeded" } });
  assert.equal(r.action, "landed");
  assert.deepEqual(r.seen.landed, ["r1"]);
});

test("整条链 · 已经有人认领了 → 不问、不落，一轮只接一次", async () => {
  const r = await harness({ turns: RUNNING_THREAD, run: { status: "running" }, taken: "r1" });
  assert.equal(r.action, "claimed");
  assert.deepEqual(r.seen.asked, []);
  assert.deepEqual(r.seen.landed, []);
});

test("整条链 · 没有项目 / 没有待接回的轮 → 什么都不做，也不发请求", async () => {
  const a = await harness({ turns: [], run: { status: "running" } });
  assert.equal(a.action, "none");
  assert.deepEqual(a.seen.asked, []);
  const b = await resumeThreadRun({
    project: "",
    turns: RUNNING_THREAD,
    pendingRunIdIn,
    resumePlan,
    readRun: () => { throw new Error("不该被调用"); },
    land: () => { throw new Error("不该被调用"); },
    claim: () => true,
    onStatus: () => {},
  });
  assert.equal(b.action, "none");
});

/* --- 恢复之后「逐步可见」与「真的落到作品上」（REQ-004 判据 6）------------- */
//
// codex 轮 3 判 NOT_EVIDENCED，理由对：上面那组把 `land` 注入掉了，于是「恢复之后
// 步骤逐步出现」与「改动真的落到作品上」两件事没有被证过。这里补的是**真函数**：
// `awaitTurn` 是 `landRun` 用的那一个，`applyConversationEdits` 是它落地时调的那一个。

test("恢复之后步骤**逐步**出现 —— 排队 → 正在想 → 结束，每一次变化都报一次", async () => {
  const seq = ["queued", "queued", "running", "running", "succeeded"];
  let i = 0;
  stubFetch(() => jsonRes(200, { run_id: "r1", status: seq[Math.min(i++, seq.length - 1)] }));
  const ticks = [];
  const run = await awaitTurn("我的项目", "r1", {
    onTick: (r) => ticks.push(r.status),
    everyMs: 0,
    sleep: () => Promise.resolve(),
  });
  // 只在**变化**时报 —— 重复的 queued 不该刷成两行
  assert.deepEqual(ticks, ["queued", "running", "succeeded"]);
  assert.equal(run.status, "succeeded");
});

test("恢复的等待有尽头 —— 一直问不出终态时说「等不到结果」，不是永远转圈", async () => {
  stubFetch(() => jsonRes(200, { run_id: "r1", status: "running" }));
  let clock = 0;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const run = await awaitTurn("p", "r1", {
      timeoutMs: 10,
      everyMs: 0,
      sleep: () => { clock += 100; return Promise.resolve(); },
    });
    assert.equal(run.status, "unknown");
    assert.equal(run.timedOut, true);
  } finally {
    Date.now = realNow;
  }
});

test("恢复之后那条 turn 的 edits **真的落到作品上** —— 走创作者自己那条写路径", () => {
  // `landRun` 落地时调的就是这个函数（各动作类型的覆盖在 `convapply.test.mjs`；
  // 这里证的是**恢复场景**那一条：从线程里取出的 edits 会变成真实的写调用，
  // 并带回版本 —— 回执靠它，而回执正是「下次不再重落」的依据）。
  const calls = [];
  const ctx = {
    story: {
      editBrief: (f) => calls.push(["editBrief", f]),
      commitBrief: (origin, instruction) => {
        calls.push(["commitBrief", origin, instruction]);
        return { v: 7 };
      },
    },
  };
  const thread = [
    { turnId: "u-1", role: "user", runId: "r1", text: "把类型改成悬疑" },
    {
      turnId: "t-1", role: "agent", runId: "r1", status: "succeeded",
      edits: [{ kind: "brief.fields", text: "把类型改成悬疑", fields: { genre: "悬疑" } }],
    },
  ];
  // 恢复路径取的正是这两样：那条 turn 的 edits，与**用户当时说的那句话**
  const turn = thread[1];
  const landed = applyConversationEdits(ctx, {
    instruction: turnTextOf(thread, "r1"),
    outputs: { conversation: { edits: turn.edits } },
  });
  assert.deepEqual(calls[0], ["editBrief", { genre: "悬疑" }]);
  assert.deepEqual(calls[1], ["commitBrief", "developed", "把类型改成悬疑"]);
  assert.equal(landed.length, 1);
  assert.equal(landed[0].version, 7, "落地结果要带回版本 —— 回执靠它");
  assert.equal(landed[0].error, undefined);
});

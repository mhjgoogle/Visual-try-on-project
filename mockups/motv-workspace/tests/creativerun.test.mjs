// 五个创作端点走 `run_id`，不再把模型那几分钟压在一个 HTTP 请求上
// —— TASK-106 判据 2 / ADR-0095 决策 2。
//
// 这条链之前**一个测试都没有**：`grep timeoutMs: 0` 数出十六处同步长调用，
// 而它们全是「发出去、干等、拿产物」。现在的形状是「拿 `run_id` → 由等待循环推进
// → 从 `outputs` 取产物，键两边一样」，所以要钉住的正是那些**看不见的差别**：
// 头带没带、项目名传没传、产物从哪儿取、失败与「问不到」分不分得开。

import test from "node:test";
import assert from "node:assert/strict";

import * as command from "../src/services/command.js";
import { awaitRun, isTerminal } from "../src/services/runwait.js";

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => "application/json" },
  json: async () => body,
});

function stubFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init: init || {} });
    return handler(String(path), init || {});
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const headerOf = (init, name) => {
  const h = (init && init.headers) || {};
  if (typeof h.get === "function") return h.get(name);
  const hit = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit ? h[hit] : undefined;
};

/* --- 等待循环本身（注入的 read/sleep，不碰网络） ---------------------------- */

test("终态是那四个，别的都还没落定", () => {
  for (const s of ["succeeded", "failed", "cancelled", "awaiting_input"]) {
    assert.equal(isTerminal(s), true, s);
  }
  for (const s of ["queued", "running", "cancelling", "", null, undefined]) {
    assert.equal(isTerminal(s), false, String(s));
  }
});

test("一直问到落定为止，状态**变化**时才叫一次 onTick", async () => {
  const seq = [
    { status: "queued" }, { status: "queued" }, { status: "running" },
    { status: "succeeded", outputs: { outline: { a: 1 } } },
  ];
  let i = 0;
  const ticks = [];
  const run = await awaitRun({
    read: async () => seq[Math.min(i++, seq.length - 1)],
    project: "p", runId: "r-1",
    onTick: (x) => ticks.push(x.status),
    sleep: async () => {},
  });
  assert.equal(run.status, "succeeded");
  assert.deepEqual(ticks, ["queued", "running", "succeeded"], "同一个状态被重复播报了");
});

test("问不到的时候答「状态未知」，**绝不答「没在跑」**", async () => {
  // ADR-0095 决策 2 / ADR-0064 决策 6：说「没在跑」会让他再起一轮，
  // 于是两轮同时改同一份文档。
  let now = 0;
  const real = Date.now;
  Date.now = () => now;
  try {
    const run = await awaitRun({
      read: async () => null,                 // 超时 / 500 / 断网都长这样
      project: "p", runId: "r-2", timeoutMs: 50,
      sleep: async () => { now += 30; },
    });
    assert.equal(run.status, "unknown");
    assert.equal(run.timedOut, true);
    assert.equal(run.runId, "r-2", "连是哪一轮都没说，他没法据此做任何事");
  } finally { Date.now = real; }
});

test("等待循环只有一份 —— 对话那条链用的是同一个", async () => {
  // 两份「谁说了算」= 保存一次状态就变一次（ADR-0095 决策 2 存在的全部理由）。
  const conv = await import("../src/services/conversation.js");
  const rw = await import("../src/services/runwait.js");
  assert.equal(conv.isTerminal, rw.isTerminal, "对话链自己又定义了一遍终态");
});

/* --- command.js 的接线 ------------------------------------------------------ */

test("有项目名 → 带 X-Motv-Async 起跑，产物从 outputs 里取（键两边一样）", async () => {
  const s = stubFetch(async (path, init) => {
    if (path.includes("/api/agent/story-develop")) {
      assert.equal(headerOf(init, "X-Motv-Async"), "1", "没请求异步 —— 那还是把模型压在这个请求上");
      const body = JSON.parse(init.body);
      assert.equal(body.project, "夜班沉默", "没带项目名 —— GET /api/runs/<id> 会问不到自己那一轮");
      return jsonRes(202, { run_id: "r-9", status: "queued", outputs: null });
    }
    if (path.includes("/api/runs/r-9")) {
      assert.match(path, /project=/, "读运行状态没带项目名");
      return jsonRes(200, { run_id: "r-9", status: "succeeded", executor: "claude-code", outputs: { outline: { 主题: "夜班" } } });
    }
    throw new Error(`没预料到的请求：${path}`);
  });
  try {
    const outline = await command.developStory({ idea: "一个夜班护士", project: "夜班沉默" });
    assert.deepEqual(outline, { 主题: "夜班" }, "产物没从 outputs 里取出来");
  } finally { s.restore(); }
  assert.equal(s.calls.length, 2, "起跑 + 读状态，应当正好两次");
});

test("没有项目名 → 退回同步分支，不请求异步", async () => {
  // `GET /api/runs/<id>` 按项目隔离，没有项目名就问不到自己那一轮 ——
  // 那时**必须**走还在的同步分支，而不是起一轮再也读不回来的运行。
  const s = stubFetch(async (path, init) => {
    assert.match(path, /story-develop/);
    assert.equal(headerOf(init, "X-Motv-Async"), undefined, "没有项目名却请求了异步");
    assert.equal(JSON.parse(init.body).project, undefined);
    return jsonRes(200, { outline: { 主题: "同步的" }, draft: true, run_id: "r-legacy" });
  });
  try {
    assert.deepEqual(await command.developStory({ idea: "x" }), { 主题: "同步的" });
  } finally { s.restore(); }
});

test("后端没认那个头（老后端答 200 带产物）→ 照常拿到产物，不去读运行状态", async () => {
  const s = stubFetch(async (path) => {
    if (path.includes("/api/runs/")) throw new Error("老后端不该被读运行状态");
    return jsonRes(200, { shots: [{ n: 1 }], draft: true, run_id: "r-old" });
  });
  try {
    const shots = await command.generateShotsDraft("剧本", { project: "夜班沉默" });
    assert.deepEqual(shots, [{ n: 1 }]);
  } finally { s.restore(); }
  assert.equal(s.calls.length, 1);
});

test("那一轮失败了 → 抛，而且带着后端给的原因", async () => {
  const s = stubFetch(async (path) =>
    path.includes("/api/runs/")
      ? jsonRes(200, { run_id: "r-f", status: "failed", failureReason: { category: "agent_failed", detail: "模型没答出 JSON" } })
      : jsonRes(202, { run_id: "r-f", status: "queued" }));
  try {
    await assert.rejects(
      () => command.generateScriptDraft({ idea: "x", project: "p" }),
      (e) => {
        assert.match(e.message, /模型没答出 JSON/, "把后端说的原因丢了");
        assert.equal(e.category, "agent_failed");
        return true;
      },
    );
  } finally { s.restore(); }
});

test("**问不到 ≠ 失败**：状态未知要说成「可能还在跑」，不许说成失败", async () => {
  // 这条是上一条的反面，也是最容易写错的那一半：把 unknown 当失败渲染，
  // 他就会再起一轮，而先起的那一轮还在改同一份文档。
  let now = 0;
  const real = Date.now;
  Date.now = () => now;
  const s = stubFetch(async (path) => {
    if (path.includes("/api/runs/")) { now += 200_000; return jsonRes(500, { error: { detail: "boom" } }); }
    return jsonRes(202, { run_id: "r-u", status: "queued" });
  });
  try {
    await assert.rejects(
      () => command.planEpisodes({ outline: {}, project: "p" }),
      (e) => {
        assert.equal(e.category, "unknown", "问不到被归成了别的类");
        assert.match(e.message, /还在跑|状态未知/, "没告诉他「先别重开一次」");
        assert.doesNotMatch(e.message, /运行失败/, "把「问不到」说成了「失败了」");
        return true;
      },
    );
  } finally { s.restore(); Date.now = real; }
});

test("被取消 → 是它自己的一类，不混进失败里", async () => {
  const s = stubFetch(async (path) =>
    path.includes("/api/runs/")
      ? jsonRes(200, { run_id: "r-c", status: "cancelled" })
      : jsonRes(202, { run_id: "r-c", status: "queued" }));
  try {
    await assert.rejects(
      () => command.generateBibleBreakdown("剧本", { project: "p" }),
      (e) => { assert.equal(e.category, "cancelled"); return true; },
    );
  } finally { s.restore(); }
});

test("五个创作端点**都**走这条路 —— 不是只改了其中一个", async () => {
  const key = { shots: "shots", script: "script", breakdown: "breakdown", outline: "outline", episodes: "episodes" };
  const cases = [
    ["/api/agent/shots-draft", key.shots, [{ n: 1 }], () => command.generateShotsDraft("s", { project: "p" })],
    ["/api/agent/script-draft", key.script, "一段剧本", () => command.generateScriptDraft({ idea: "i", project: "p" })],
    ["/api/agent/bible-breakdown", key.breakdown, { characters: [], locations: [] }, () => command.generateBibleBreakdown("s", { project: "p" })],
    ["/api/agent/story-develop", key.outline, { 主题: "x" }, () => command.developStory({ idea: "i", project: "p" })],
    ["/api/agent/episode-plan", key.episodes, [{ ep: 1 }], () => command.planEpisodes({ outline: {}, project: "p" })],
  ];
  for (const [path, k, product, run] of cases) {
    let asked = false;
    const s = stubFetch(async (p, init) => {
      if (p.includes("/api/runs/")) return jsonRes(200, { run_id: "r", status: "succeeded", outputs: { [k]: product } });
      assert.ok(p.includes(path), `打到了别的端点：${p}`);
      asked = headerOf(init, "X-Motv-Async") === "1";
      return jsonRes(202, { run_id: "r", status: "queued" });
    });
    try {
      assert.deepEqual(await run(), product, `${path} 的产物不对`);
      assert.equal(asked, true, `${path} 还在走同步分支`);
    } finally { s.restore(); }
  }
});

/* --- 「问不到」到了界面上是什么样（codex 轮 1：NOT_EVIDENCED） --------------- */
//
// 上面那几条钉的是**服务层**分不分得开；这几条钉的是**他看到什么、能做什么**。
// 真正会伤到人的不是措辞，是**能不能马上再起一轮** —— 那一轮可能还在后端跑着。

test("问不到不会变成「可以马上重开」的失败 —— 故事发展这条", async () => {
  const storydoc = await import("../src/workflow/storydoc.js");
  const doc = storydoc.createStory();
  const id = storydoc.beginDevelop(doc, "outline", "写一版");
  assert.ok(id, "没起来");

  assert.equal(storydoc.unknownDevelop(doc, id, "状态未知：这一轮可能还在跑"), true);
  assert.equal(doc.pending.status, "unknown", "被记成了别的状态");

  // **这一条是全部要害**：记成 failed 的话下面这行会返回一个新 id。
  assert.equal(storydoc.beginDevelop(doc, "outline", "再写一版"), 0,
    "问不到却放行了下一轮 —— 两轮会同时改同一份文档");

  // 出口是显式的：他说「不等了」才放开
  storydoc.cancelDevelop(doc);
  assert.ok(storydoc.beginDevelop(doc, "outline", "再写一版"), "放弃之后仍然起不来，他被卡死了");
});

test("问不到不会变成「可以马上重开」的失败 —— 剧本这条", async () => {
  const scriptdoc = await import("../src/workflow/scriptdoc.js");
  const doc = scriptdoc.createDoc();
  const id = scriptdoc.beginGeneration(doc, "initial", "想法");
  assert.ok(id);
  assert.equal(scriptdoc.unknownGeneration(doc, id, "状态未知"), true);
  assert.equal(doc.pending.status, "unknown");
  assert.equal(scriptdoc.beginGeneration(doc, "initial", "再来"), 0,
    "问不到却放行了下一轮");
});

test("真失败仍然可以马上重来 —— 别把两件事一起锁上", async () => {
  const storydoc = await import("../src/workflow/storydoc.js");
  const doc = storydoc.createStory();
  const id = storydoc.beginDevelop(doc, "outline", "写一版");
  storydoc.failDevelop(doc, id, "模型没答出 JSON");
  assert.ok(storydoc.beginDevelop(doc, "outline", "再写一版"),
    "把「确定失败了」也锁上了 —— 那是另一件事，他该能直接重试");
});

test("界面认得这个状态：说「可能还在跑」，而且给的是「放弃」不是「重试」", async () => {
  // 漏掉这个分支比说错话更糟：会掉进提案分支去读一个不存在的 proposal，
  // 把他卡在一张空面板前。所以这条走**真渲染**。
  const storydoc = await import("../src/workflow/storydoc.js");
  const { renderStoryWs } = await import("../src/ui/storyws.js");
  const doc = storydoc.createStory(null);
  doc.idea = "一个夜班护士";
  const id = storydoc.beginDevelop(doc, "outline", "写一版");
  assert.ok(id, "没起来");
  storydoc.unknownDevelop(doc, id, "状态未知：这一轮可能还在跑，先别重开一次");

  const html = renderStoryWs(
    { story: { doc: () => doc, activeBrief: () => storydoc.activeBrief(doc) }, toast: () => {} },
    { dirOpen: {} },
  );
  assert.match(html, /状态未知/, "界面没说这一轮状态未知");
  assert.match(html, /还在跑|先别重开/, "没告诉他别重开一次");
  assert.match(html, /放弃这一轮/, "没给显式的出口 —— 他会被卡住");
  assert.doesNotMatch(html, /重试/, "给了「重试」—— 那正是会起第二轮的那颗按钮");
});

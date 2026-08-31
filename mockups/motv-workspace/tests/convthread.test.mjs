// 对话流 —— REQ-004 v2 / ADR-0089 的前端合同。
//
// 守的是「看起来像在工作、其实什么都没发生」这一族：
//   * 发出去的话必须立刻在屏幕上（否则创作者会以为没发出去，再按一次）
//   * 等待中的那一轮必须有形状（否则消息像凭空消失了）
//   * 失败必须写出原因（决策 6）
//   * edits 是**意图**，屏幕上不能读成「已经改好了」（决策 2b）
//   * 它做不到的事要留在屏幕上，不能被静默丢掉
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { threadModel, renderThread } from "../src/ui/convthread.js";

const HERE = dirname(fileURLToPath(import.meta.url));

test("空线程说的是「怎么开始」，不是一句空话", () => {
  const html = renderThread(threadModel([]));
  assert.match(html, /还没有对话/);
  assert.match(html, /先把这个项目的/);
});

test("他说的和 Agent 回的分别可辨", () => {
  const m = threadModel([
    { turnId: "u1", role: "user", text: "把第二个镜头改冷一点" },
    { turnId: "a1", role: "agent", runId: "r1", status: "succeeded", text: "好，我看了这一镜" },
  ]);
  assert.deepEqual(m.rows.map((r) => r.role), ["user", "agent"]);
  const html = renderThread(m);
  assert.match(html, /cv-turn user/);
  assert.match(html, /cv-turn agent/);
  assert.match(html, /把第二个镜头改冷一点/);
  assert.match(html, /好，我看了这一镜/);
});

test("等待中的那一轮有形状，并且可以取消", () => {
  // THE FAILURE THIS CATCHES: send → nothing on screen until the answer lands, so
  // the message looks lost and gets sent twice.
  const m = threadModel(
    [{ turnId: "u1", role: "user", text: "你好" }],
    { pendingRun: "r9", pendingStatus: "running" },
  );
  assert.equal(m.waiting.runId, "r9");
  const html = renderThread(m);
  assert.match(html, /正在想/);
  assert.match(html, /data-cv-cancel="r9"/);
});

test("答案已经到了，就不再显示等待", () => {
  const m = threadModel(
    [
      { turnId: "u1", role: "user", text: "你好" },
      { turnId: "a1", role: "agent", runId: "r9", status: "succeeded", text: "在" },
    ],
    { pendingRun: "r9", pendingStatus: "running" },
  );
  assert.equal(m.waiting, null);
  assert.doesNotMatch(renderThread(m), /cv-skel/);
});

test("失败写出原因和类别，而不是渲染成沉默", () => {
  const html = renderThread(
    threadModel([
      {
        turnId: "a1", role: "agent", runId: "r1", status: "failed",
        failure: "执行器不可用（未找到可执行体）", failureCategory: "unavailable",
      },
    ]),
  );
  assert.match(html, /没能完成/);
  assert.match(html, /执行器不可用/);
  assert.match(html, /unavailable/);
});

test("edits 读起来是「建议」，不是「已完成」（决策 2b）", () => {
  const html = renderThread(
    threadModel([
      {
        turnId: "a1", role: "agent", runId: "r1", status: "succeeded", text: "我建议这样",
        edits: [{ kind: "brief.idea", text: "更冷的酒吧" }],
      },
    ]),
  );
  assert.match(html, /还没落到作品上/, "屏幕上必须分清「它说要改」和「已经改了」");
  assert.match(html, /改核心创意/);
  assert.match(html, /更冷的酒吧/);
});

test("它做不到的事留在屏幕上", () => {
  const html = renderThread(
    threadModel([
      {
        turnId: "a1", role: "agent", runId: "r1", status: "succeeded", text: "这个我做不到",
        unsupported: [{ kind: "project.rename", text: "改项目名" }],
      },
    ]),
  );
  assert.match(html, /还做不到/);
  assert.match(html, /project.rename/);
});

test("正文经过转义 —— 剧本里出现 < 不该变成标签", () => {
  const html = renderThread(
    threadModel([{ turnId: "u1", role: "user", text: '<img src=x onerror="boom">' }]),
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

// --- the wiring, asserted at source level ---------------------------------- //

test("输入框在没有选能力时给的是「发送」，并且 Enter 发送、Shift+Enter 换行", () => {
  const src = readFileSync(join(HERE, "..", "src", "ui", "agentsession.js"), "utf8");
  assert.match(src, /data-as-send/);
  assert.match(src, /Enter 发送/);
  // IME: pressing Enter to accept a Chinese candidate must not send
  assert.match(src, /isComposing/);
});

test("发送走服务层的 conversation 端点，且带 CSRF 头", () => {
  const src = readFileSync(join(HERE, "..", "src", "services", "conversation.js"), "utf8");
  assert.match(src, /\/conversation/);
  assert.match(src, /X-Motv-Runtime/);
  // the read the frontend never had (TASK-106) — without it there is no progress
  assert.match(src, /\/api\/runs\//);
});

test("production 真的挂了对话：渲染、发送、取消、首次加载", () => {
  const src = readFileSync(join(HERE, "..", "src", "ui", "production.js"), "utf8");
  assert.match(src, /renderThread\(threadModel\(/);
  assert.match(src, /onSend: \(text\) => sendConversationTurn/);
  assert.match(src, /data-cv-cancel/);
  assert.match(src, /ensureConversation\(ctx\)/);
});

test("发送按钮不许由渲染态禁用 —— 它会卡在「画出来时文本是空的」那一刻", () => {
  // 产品负责人 2026-08-27：「根本得按不了发送」。输入框为了不让光标跳，打字时**不**重渲染，
  // 所以 `disabled` 一旦写进 HTML 就永远停在最初那一刻。空文本由处理器拒绝，外观由 bind
  // 里 toggle 一个 class 维持。
  const src = readFileSync(join(HERE, "..", "src", "ui", "agentsession.js"), "utf8");
  // COMMENTS STRIPPED FIRST. The comment above the button explains why `disabled` is
  // wrong, so a naive search finds the word it exists to forbid — the same trap
  // `tests/tooling/test_review_script_readability.py` documents for this repo.
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const composer = code.slice(code.indexOf("const composer ="), code.indexOf("const history ="));
  assert.doesNotMatch(composer, /data-as-send[^>]*disabled/);
  assert.doesNotMatch(composer, /disabled[^>]*data-as-send/);
  // and the live affordance exists instead
  assert.match(src, /classList\.toggle\("dim"/);
  // the handler is what refuses an empty send
  const bind = src.slice(src.indexOf("export function bindAgentSession"));
  assert.match(bind, /const text = String\(st\.text \|\| ""\)\.trim\(\);\s*\n\s*if \(!text/);
});

test("每一轮都带上「我在哪」—— 页面、分集、选中的镜头", () => {
  // 产品负责人 2026-08-27:「不能根据我现在点的 tab 或者所在画面自动识别的是吗」。
  // 位置由这个模块装配（它才拥有页面名词表 MODULE_LABEL / SPACE_LABEL），服务端只负责
  // 打印它被告知的东西 —— 否则名词表会有两份，迟早和左栏说的不一样。
  const src = readFileSync(join(HERE, "..", "src", "ui", "production.js"), "utf8");
  assert.match(src, /function conversationContext\(ctx\)/);
  assert.match(src, /sendTurn\(project, text, conversationContext\(ctx\)\)/);
  for (const field of ["moduleLabel", "spaceLabel", "shotTitle", "episodeLabel"]) {
    assert.match(src, new RegExp(field), `上下文里少了 ${field}`);
  }
  assert.match(src, /MODULE_LABEL\[activeModule\]/);
});

test("对话状态按页面分开存 —— 一页的等待不许画到另一页上", () => {
  // 产品负责人 2026-08-27:「打开不同的页面都有新的对话框…历史内容保存在不同对话框」。
  // 三个扁平字段（convTurns / convPendingRun / convPendingStatus）会让在「分镜」发起的
  // 那一轮把转圈画到「资产库」上，而历史也会跟着人跑。
  const src = readFileSync(join(HERE, "..", "src", "ui", "production.js"), "utf8");
  assert.match(src, /ui\.convByPage/);
  assert.match(src, /function convKey\(\)/);
  assert.doesNotMatch(src, /ui\.convTurns/);
  assert.doesNotMatch(src, /ui\.convPendingRun/);
  // 读取与刷新都带上这一页；发送时先把页面记下来（发完他可能已经换页了）
  assert.match(src, /loadThread\(project, convKey\(\)\)/);
  assert.match(src, /const sentFrom = convKey\(\)/);
  assert.match(src, /refreshConversation\(ctx, sentFrom\)/);
});

test("服务层按页面读，并把「别的页面还有对话」带回来", () => {
  const src = readFileSync(join(HERE, "..", "src", "services", "conversation.js"), "utf8");
  assert.match(src, /\?thread=/);
  assert.match(src, /others/);
});

/* --- 「写好了」之后必须有地方点（TASK-122）--------------------------------- */
//
// 产品负责人 2026-08-30：「为什么他说写好了然后还是没有写好」。那一轮跑成功了、
// 消息说「要用就点右边这个按钮」，而按钮**根本没画出来** —— 判断用的是
// `st.runId`，可 `routeState` 里带的是 `skillRunId`。一个说了却不存在的按钮，
// 与「它答应了然后什么都没干」在屏幕上无法区分。

test("跑成功且有提案 → 对话里就有「用它 / 不用」两个按钮", () => {
  const html = renderThread(threadModel([
    { role: "user", text: "写故事大纲" },
    {
      role: "agent",
      runId: "conv-1",
      text: "好，这就写",
      route: { skillId: "story-development", scope: "project" },
    },
  ], {
    routeState: {
      "conv-1": {
        skillId: "story-development",
        title: "开发故事",
        status: "succeeded",
        skillRunId: "skillrun-7",
        pending: true,
        canApply: true,
      },
    },
  }));
  assert.match(html, /data-cv-use="skillrun-7"/, "「用它」按钮必须带真实的运行 id");
  assert.match(html, /data-cv-drop="skillrun-7"/);
  assert.ok(!html.includes("能力」面板"), "不许再把他指向已经删掉的面板");
});

test("还在跑的时候不给按钮 —— 没有东西可用", () => {
  const html = renderThread(threadModel(
    [{ role: "agent", runId: "conv-2", text: "在写", route: { skillId: "story-development" } }],
    { routeState: { "conv-2": { skillId: "story-development", title: "开发故事", status: "running" } } },
  ));
  assert.ok(!html.includes("data-cv-use"), "跑着的时候不该出现「用它」");
});

test("审读意见不给「用它」—— 它给的是「照它改」（2026-08-31）", () => {
  // 他点了「用它」，得到的是一句解释：「这是一份观众视角的审读意见，不是可以直接
  // 替换进作品的文字」。**一个按下去只会解释自己为什么不该被按的按钮**，
  // 比没有按钮更糟 —— 仓库里早就有那道判断（`applicabilityFor`），我加按钮时没问它。
  const html = renderThread(threadModel([
    { role: "agent", runId: "conv-9", text: "审完了", route: { skillId: "audience-engagement-reviewer" } },
  ], {
    routeState: {
      "conv-9": {
        skillId: "audience-engagement-reviewer",
        title: "检查问题",
        status: "succeeded",
        skillRunId: "skillrun-9",
        canApply: false,
        applyWhy: "这是一份观众视角的审读意见，不是可以直接替换进作品的文字。",
        reviser: "story-reviser",
      },
    },
  }));
  assert.ok(!html.includes("data-cv-use"), "不许给「用它」");
  assert.match(html, /data-cv-revise="story-reviser\|skillrun-9"/, "给的是「照它改」");
  // 原因写在消息里，而不是等他点了才说
  assert.ok(html.includes("不是可以直接替换进作品的文字"));
});

test("没有对应修订能力时，什么按钮都不给 —— 也不假装有", () => {
  const html = renderThread(threadModel([
    { role: "agent", runId: "conv-10", text: "看完了", route: { skillId: "continuity-reviewer" } },
  ], {
    routeState: {
      "conv-10": {
        skillId: "continuity-reviewer",
        title: "检查问题",
        status: "succeeded",
        skillRunId: "skillrun-10",
        canApply: false,
        applyWhy: "这是一份连贯性意见。",
        reviser: "",
      },
    },
  }));
  assert.ok(!html.includes("data-cv-use") && !html.includes("data-cv-revise"));
  assert.ok(html.includes("这是一份连贯性意见"));
});

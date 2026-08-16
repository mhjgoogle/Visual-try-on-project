// TASK-078 批次 B — 一次生成 = 一张卡，作为规则：
//
//   1. 参考、Prompt、规格、报价、提交、免费路线在**同一张卡**上。
//   2. 报价来自 Gateway 预检，**不是前端算的**（守卫）。
//   3. 提交仍走 ADR-0041 两步：一次新鲜预检 → 人工确认 → command（守卫）。
//   4. 模型与规格**可见**；**不可选**，因为命令按 ADR-0041 只接受 packet ——
//      卡上如实说明为什么，而不是放一个改不动任何东西的下拉框。
//   5. 免费路线与付费并列在同一张卡上，且只有真的复制成功才记录溯源意图。
//
// 纯测试：无 DOM、无网络。断言的是派生结果或纯渲染器返回的 HTML 字符串。

import { test } from "node:test";
import assert from "node:assert/strict";

import { genCardModel, renderGenCard, referenceChips } from "../src/ui/gencard.js";

/* ========================================================================= */
/* 固定装置                                                                   */
/* ========================================================================= */

/** A `shotDetailModel`-shaped object, trimmed to what the card reads. */
function detail({ refs = [], start = null, gaps = ["运镜为空（在镜头详情填写）"] } = {}) {
  return {
    shot: { shotId: "shot-a", seq: 1, title: "S1-01", description: "d" },
    slot: "v1-1",
    prompts: {
      image: { text: "【画面】d\n【要求】16:9", missing: gaps },
      video: { text: "【首帧】以所附图片为第 1 帧\n【画面】d", missing: gaps },
    },
    refInputs: {
      imageReferences: refs,
      videoReferences: refs,
    },
    frames: { start, end: null, slot: "v1-1" },
  };
}

const REF = (n) => ({
  key: `ref-${n}`, kind: "character-reference", name: `林照 Ref`, version: n, assetId: `a${n}`,
});

const QUOTE = (over = {}) => ({
  shotId: "shot-a",
  inputs: { model: "video-01", resolution: "720p", duration: 6, capability: "image_to_video", stage: "s5" },
  cost: { jpy: 42, original_amount_minor_units: 28, original_currency: "USD" },
  blockers: [],
  at: "2026-08-16T00:00:00Z",
  ...over,
});

/* ========================================================================= */
/* 1 · 一张卡上有全部东西                                                     */
/* ========================================================================= */

test("参考 / Prompt / 报价 / 提交 / 免费路线在同一张卡上", () => {
  const m = genCardModel(detail({ refs: [REF(3)] }), "video", { paid: true, quote: QUOTE() });
  const html = renderGenCard(m);
  assert.ok(html.includes("data-gc=\"video\""), "是一张卡，不是散在四处");
  assert.ok(html.includes("data-gc-prompt"), "Prompt 在卡上");
  assert.ok(html.includes("gc-chip"), "参考在卡上");
  assert.ok(html.includes("data-gc-submit"), "提交在卡上");
  assert.ok(html.includes("data-gc-import"), "导入在卡上");
  for (const entry of ["manual", "chatgpt", "gemini"]) {
    assert.ok(html.includes(`data-gc-free="${entry}"`), `免费路线 ${entry} 在同一张卡上`);
  }
  // …而且报价和提交挨着，不在弹窗里
  const priceAt = html.indexOf("gc-price");
  const submitAt = html.indexOf("data-gc-submit");
  assert.ok(priceAt > -1 && submitAt > priceAt, "报价必须在提交按钮之前、同一行区域");
});

test("参考显示成编号 chip；首帧单独标出来", () => {
  const start = { assetId: "img-1", url: "u/1.png", version: 2, name: "本镜头画面 v2", from: "本镜头画面" };
  const { chips, start: s } = referenceChips(detail({ refs: [REF(1), REF(2)], start }), "video");
  assert.deepEqual(chips.map((c) => c.n), [1, 2], "编号从 1 起，按顺序");
  assert.equal(s.name, "本镜头画面 v2");
  const html = renderGenCard(genCardModel(detail({ refs: [REF(1), REF(2)], start }), "video", { paid: true }));
  assert.ok(html.includes("gc-chip-frame"), "首帧不是普通参考之一，它就是视频的输入");
  assert.ok(html.includes("<b>1</b>") && html.includes("<b>2</b>"));
});

test("一个参考都没绑时如实说，并给出去绑定的入口", () => {
  const html = renderGenCard(genCardModel(detail(), "image", { paid: false }));
  assert.ok(html.includes("还没有绑定参考"));
  assert.ok(html.includes('data-goto="refplan"'));
});

test("Prompt 的缺口如实列出来，不藏起来", () => {
  const html = renderGenCard(genCardModel(detail({ gaps: ["运镜为空（在镜头详情填写）"] }), "video", {}));
  assert.ok(html.includes("运镜为空"));
});

/* ========================================================================= */
/* 2 · 报价来自 Gateway，不是前端算的                                         */
/* ========================================================================= */

test("没有报价时卡上不显示任何价格，只给一个「⚡报价」按钮（守卫）", () => {
  // 前端能拿到 config/providers 的单价，乘一乘就能显示一个数 —— 而那个数
  // 没有人核对过，却正好是创作者花钱前读到的那一个。
  const html = renderGenCard(genCardModel(detail(), "video", { paid: true, quote: null }));
  assert.ok(html.includes("data-gc-quote"));
  assert.ok(!html.includes("gc-price"), "未报价时不得显示任何价格");
  assert.ok(!/JPY|USD/.test(html), "未报价时不得出现任何货币");
  assert.ok(html.includes("未知"), "规格同样未知就说未知");
});

test("报价显示的就是预检返回的数字，原样", () => {
  const html = renderGenCard(genCardModel(detail(), "video", { paid: true, quote: QUOTE() }));
  assert.ok(html.includes("42 JPY"), "JPY 是 Gateway 自己算的那个数，也是预算据以放行的那个");
  assert.ok(html.includes("原始计价 USD"), "原币种如实标注");
});

test("卡上不做任何货币换算 —— 最小单位的指数是按币种变的（codex round 2）", () => {
  // 固定除以 100 会把 28 日元印成 ¥0.28。这是创作者花钱前一刻读到的数字，
  // 而这张卡的第一条规则就是：价格不在前端算。
  const html = renderGenCard(genCardModel(detail(), "video", {
    paid: true, quote: QUOTE({ cost: { jpy: 28, original_amount_minor_units: 28, original_currency: "JPY" } }),
  }));
  assert.ok(html.includes("28 JPY"));
  assert.ok(!html.includes("0.28"), "不得出现任何自行换算出来的金额");
});

test("别的镜头的报价不会显示在这个镜头上", () => {
  const m = genCardModel(detail(), "video", { paid: true, quote: QUOTE({ shotId: "shot-OTHER" }) });
  assert.equal(m.quote, null);
  assert.ok(!renderGenCard(m).includes("gc-price"));
});

test("预检报了阻断就说阻断，不显示一个可以点的价格", () => {
  const html = renderGenCard(genCardModel(detail(), "video", {
    paid: true, quote: QUOTE({ cost: null, blockers: ["budget exceeded", "packet stale"] }),
  }));
  assert.ok(html.includes("无法生成"));
  assert.ok(html.includes("budget exceeded"));
  assert.ok(!html.includes("gc-price"));
});

test("预检回来没有报价时说「报价不可用」，不编一个", () => {
  const html = renderGenCard(genCardModel(detail(), "video", {
    paid: true, quote: QUOTE({ cost: null }),
  }));
  assert.ok(html.includes("报价不可用"));
  assert.ok(!html.includes("gc-price"));
});

/* ========================================================================= */
/* 3 · 模型与规格：可见，但不可选 —— 并说明为什么                             */
/* ========================================================================= */

test("规格来自预检并显示出来", () => {
  const html = renderGenCard(genCardModel(detail(), "video", { paid: true, quote: QUOTE() }));
  assert.ok(html.includes("video-01"), "模型可见");
  assert.ok(html.includes("720p"), "分辨率可见");
  assert.ok(html.includes("6s"), "时长可见");
});

test("卡上没有改不动任何东西的模型下拉框（守卫）", () => {
  // ADR-0041：submit-video-generation 按 packet 走，「never accepts free-form
  // model/resolution/duration/stage」。放一个下拉框会让创作者以为自己选了模型，
  // 而跑的还是 packet 里那个 —— 比不放更糟。
  const html = renderGenCard(genCardModel(detail(), "video", { paid: true, quote: QUOTE() }));
  assert.ok(!html.includes("<select"), "不得渲染一个不会改变结果的选择器");
  assert.ok(html.includes("不接受自由参数"), "要说明为什么不可选");
  assert.ok(html.includes("锁定为正式分镜"), "并指出真正能改它的地方");
});

/* ========================================================================= */
/* 4 · 付费范围与人工确认                                                     */
/* ========================================================================= */

test("没开付费写路径时不渲染提交按钮，只留免费路线", () => {
  const m = genCardModel(detail(), "video", { paid: false });
  assert.equal(m.canSubmit, false);
  const html = renderGenCard(m);
  assert.ok(!html.includes("data-gc-submit"));
  assert.ok(html.includes("--enable-paid"), "说明为什么没有，而不是静静消失");
  assert.ok(html.includes("data-gc-free=\"manual\""), "免费路线仍在");
});

test("付费图片没获批 —— 图片卡不给付费提交，并说明依据", () => {
  // paid_gateway.py：「Paid scope is VIDEO ONLY」；ADR-0038 未 Accepted。
  const m = genCardModel(detail(), "image", { paid: true, quote: QUOTE() });
  assert.equal(m.canSubmit, false);
  const html = renderGenCard(m);
  assert.ok(!html.includes("data-gc-submit"));
  assert.ok(html.includes("ADR-0038"));
});

test("镜头身份未解析时如实说导入会被拒", () => {
  const d = detail();
  d.slot = null;
  assert.ok(renderGenCard(genCardModel(d, "video", { paid: true })).includes("镜头身份未解析"));
});

/* ========================================================================= */
/* 5 · 改过的 Prompt 只用于免费路线                                           */
/* ========================================================================= */

test("改 Prompt 会被标出来，并说清它对付费提交不生效", () => {
  // 付费提交发的是已锁定 packet 里的 Prompt。让创作者以为卡上这段会被发送，
  // 是「界面显示已应用」那一类失败。
  const m = genCardModel(detail(), "video", { paid: true, promptEdit: "我自己改的 Prompt" });
  assert.equal(m.promptEdited, true);
  assert.equal(m.prompt, "我自己改的 Prompt");
  const html = renderGenCard(m);
  assert.ok(html.includes("仅用于免费路线"));
  assert.ok(html.includes("已锁定 packet"));
  assert.ok(html.includes("data-gc-reset"), "可以一键还原为编译结果");
  assert.ok(!/data-gc-editflag hidden/.test(html), "改过就不该还藏着");
  assert.ok(!/data-gc-editnote hidden/.test(html));
});

test("没改过时警告是 hidden，而不是根本没渲染（codex round 1 · P1）", () => {
  // 打字不重渲染（重渲染会把光标顶出正在输入的文本框），所以警告必须**已经在
  // DOM 里**、只是隐藏着，`bindGenCard` 才能在输入时就地掀开它。此前它是
  // 「改过了才渲染」，于是创作者可以改完 Prompt 直接点付费提交，全程没见过任何
  // 警告，而真正跑的是 packet 里那份。
  const html = renderGenCard(genCardModel(detail(), "video", { paid: true }));
  assert.ok(/data-gc-editflag hidden/.test(html), "警告 chip 必须存在且 hidden");
  assert.ok(/data-gc-editnote hidden/.test(html), "说明块必须存在且 hidden");
  assert.ok(html.includes("data-gc-reset"), "还原按钮同样常驻");
  // …而就地掀开它要有一份可比对的编译结果
  assert.ok(html.includes("data-gc-compiled"), "编译结果随卡带出，供实时比对");
});

test("随卡带出的编译结果是转义过的，且就是编译结果本身", () => {
  const d = detail();
  d.prompts.video.text = '【画面】<img src=x onerror="alert(1)">';
  const html = renderGenCard(genCardModel(d, "video", { paid: true }));
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.ok(!html.includes("<img src=x"), "项目内容不得注入 DOM");
});


test("把 Prompt 改回编译结果，就不再算改过", () => {
  const d = detail();
  const m = genCardModel(d, "video", { paid: true, promptEdit: d.prompts.video.text });
  assert.equal(m.promptEdited, false);
});

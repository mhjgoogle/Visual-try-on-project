// TASK-097 批次 4E —— ⑥ 批量生视频，作为规则：
//
//   1. **总额来自 preflight，不是单价 ×N。** Gateway 今天没有批量预检，
//      所以这一批开始不了 —— 而正确反应是**说清原因 + 给出真实可做的那件事**
//      （§2.5h 第二条），不是伪造一个数、也不是偷偷逐镜跑。
//   2. **一次确认（ADR-0041 两步）**：没有总额不得开始。
//   3. **可中止**；中止后已经花掉的照实记账，迟到回执仍然收下。
//   4. **失败不算成功**，「失败但已扣费」必须记进已花。
//   5. **被拒绝的批次不显示成「进行中」**。
//   6. 这一层拥有**两种**批量，所以「摘掉自己那一种」是摘一个集合。
//
// 纯测试：无 DOM、无网络、不花一分钱。

import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import {
  VIDEO_BATCH_KIND, batchItems, startVideoBatch, videoBatchModel, batchOps,
} from "../src/ui/videobatch.js";

const SHOTS = [
  { shotId: "s1", title: "一" }, { shotId: "s2", title: "二" },
  { shotId: "s3", title: "三" }, { shotId: "s4", title: "四" },
];
const quote = (count, amount = 840) => ({
  total: { amount, currency: "JPY", count }, preflight_digest: "pf-1",
});

/* ========================================================================= */
/* 1. 谁进这一批                                                              */
/* ========================================================================= */

test("只装真的能生成的那些：有首帧、还没有视频", () => {
  const { items, already, blocked } = batchItems({
    shots: SHOTS,
    readyOf: (id) => ({
      s1: { hasFrame: true, hasVideo: false },
      s2: { hasFrame: true, hasVideo: true },   // 已经有视频 → 不重复付费
      s3: { hasFrame: false, hasVideo: false }, // 没有首帧 → 生成不了
      s4: { hasFrame: true, hasVideo: false },
    }[id]),
  });
  assert.deepEqual(items.map((i) => i.id), ["s1", "s4"]);
  assert.deepEqual(already.map((i) => i.id), ["s2"]);
  assert.deepEqual(blocked.map((i) => i.id), ["s3"]);
  assert.match(blocked[0].why, /还没有首帧/, "说清为什么进不来，并指出去哪儿补");
  // 「没有要做的」不建批次（与 4D 同一条：那不是一次失败）
  const none = startVideoBatch({ shots: SHOTS, readyOf: () => ({ hasFrame: true, hasVideo: true }) });
  assert.equal(none.nothingToDo, true);
  assert.equal(none.batch, null);
});

/* ========================================================================= */
/* 2. 总额只来自 preflight；拿不到就说拿不到 + 给一条真实的路                     */
/* ========================================================================= */

test("拿不到整批总额时**不伪造**，并且把真实可走的那条路摆出来", () => {
  const made = startVideoBatch({
    shots: SHOTS.slice(0, 2), readyOf: () => ({ hasFrame: true, hasVideo: false }),
  });
  assert.equal(made.batch.state, "draft");
  const why = {
    reason: "拿不到整批总额",
    detail: "Gateway 现在只有逐镜的预检命令，没有批量预检。",
    alternative: "逐镜生成 —— 每一镜自己走两步确认",
  };
  const m = videoBatchModel(made.batch, { quoteUnavailable: why });
  assert.equal(m.state, "draft");
  assert.equal(m.quote, null, "没有总额就是没有 —— 不补一个数");
  assert.equal(m.quoteUnavailable.reason, "拿不到整批总额");
  assert.match(m.quoteUnavailable.alternative, /逐镜生成/);
  // 控制器层：**必然拿不到**这件事写在一处，而且带着替代路径
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const codeOnly = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const from = app.indexOf("  videoBatch: {");
  const after = codeOnly(app.slice(from + "  videoBatch: {".length));
  const next = after.search(/\n {2}[A-Za-z_$][A-Za-z0-9_$]*: \{/);
  const region = after.slice(0, next >= 0 ? next : after.length);
  assert.match(region, /_whyNoQuote/);
  assert.match(region, /alternative:/);
  // **界面不自算**：这一段里没有乘法，也没有把逐镜价加起来
  assert.equal(/amount\s*\*|\*\s*count|reduce\(/.test(region), false, "不许自己把逐镜价加起来");
});

test("总额来了就照它显示，而且它必须覆盖这一批的条数", () => {
  const made = startVideoBatch({
    shots: SHOTS.slice(0, 2), readyOf: () => ({ hasFrame: true, hasVideo: false }),
  });
  const ok = batchOps.applyPreflight(made.batch, quote(2));
  assert.equal(ok.state, "quoted");
  assert.equal(ok.quote.amount, 840);
  const m = videoBatchModel(ok, {});
  assert.match(m.quote.currency, /JPY/);
  // 条数对不上一律拒（batchpay 那一份判定，这里只是确认它真的在这条路上）
  const wrong = batchOps.applyPreflight(made.batch, quote(5));
  assert.equal(wrong.state, "refused");
  assert.match(wrong.refusal.reason, /5 条的总额/);
});

/* ========================================================================= */
/* 3 + 4 + 5. 两步确认、可中止、失败不算成功、被拒不显示成进行中                   */
/* ========================================================================= */

test("没有总额不得开始（ADR-0041 两步）", () => {
  const made = startVideoBatch({ shots: [SHOTS[0]], readyOf: () => ({ hasFrame: true, hasVideo: false }) });
  const early = batchOps.confirmBatch(made.batch, "2026-08-20T00:00:00Z");
  assert.notEqual(early.state, "running");
  const quoted = batchOps.applyPreflight(made.batch, quote(1, 420));
  assert.equal(batchOps.confirmBatch(quoted, "2026-08-20T00:00:00Z").state, "running");
});

test("失败不算成功；**失败但已扣费**要记进已花", () => {
  const made = startVideoBatch({
    shots: SHOTS.slice(0, 3), readyOf: () => ({ hasFrame: true, hasVideo: false }),
  });
  let b = batchOps.confirmBatch(batchOps.applyPreflight(made.batch, quote(3)), "t");
  b = batchOps.recordItem(b, "s1", { outcome: "success", spent: 280 });
  // 失败的那一镜**也扣了钱** —— 只算成功的那种账是好看的版本，而它是错的
  b = batchOps.recordItem(b, "s2", { outcome: "failed", spent: 280, error: "provider 拒绝了这个提示词" });
  const st = batchOps.settlement(b);
  assert.equal(st.allSucceeded, false);
  //  的字段是**平的**（success / failed / pending），不是 by.*
  // —— 合同以那个模块为准，不以记忆为准（本链已经为这个错付过几次）
  assert.equal(st.success, 1);
  assert.equal(st.failed, 1);
  assert.equal(st.pending, 1, "还没跑的那一镜是 pending，不是失败");
  assert.equal(st.spendComplete, false, "还有 pending，账没结清");
  assert.equal(st.spent, 560, "失败那一镜的钱也在账上");
  const m = videoBatchModel(b, {});
  assert.equal(m.state, "running");
  assert.ok(m.line.length > 0);
});

test("被拒绝的批次显示成「已拒绝」，不是「进行中」", () => {
  const made = startVideoBatch({ shots: [SHOTS[0]], readyOf: () => ({ hasFrame: true, hasVideo: false }) });
  const refused = batchOps.applyPreflight(made.batch, { total: { amount: 100, currency: "", count: 1 } });
  assert.equal(refused.state, "refused");
  const m = videoBatchModel(refused, {});
  assert.ok(m.refused, "模型要认出「被拒绝」这件事");
  assert.equal(m.state, "refused");
  const html = readFileSync(new URL("../src/ui/videobatch.js", import.meta.url), "utf8");
  const code = html.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // 渲染里「进行中」只在 running 时出现
  assert.match(code, /m\.refused \? "已拒绝" : m\.state === "running" \? "进行中"/);
});

test("中止之后：已花的照实留下，迟到的回执仍然收得下", () => {
  const made = startVideoBatch({
    shots: SHOTS.slice(0, 2), readyOf: () => ({ hasFrame: true, hasVideo: false }),
  });
  let b = batchOps.confirmBatch(batchOps.applyPreflight(made.batch, quote(2)), "t");
  b = batchOps.recordItem(b, "s1", { outcome: "success", spent: 420 });
  b = batchOps.abortBatch(b, "t2");
  assert.equal(b.state, "aborted");
  assert.equal(batchOps.settlement(b).spent, 420, "已经花掉的不因为中止而消失");
  // 迟到的回执：中止前已在飞的那一镜后来回来了
  const late = batchOps.recordItem(b, "s2", { outcome: "success", spent: 420 });
  assert.equal(batchOps.settlement(late).spent, 840, "迟到的回执照收，账目继续对得上");
});

/* ========================================================================= */
/* 6. 两种批量的所有权                                                        */
/* ========================================================================= */

test("这一层拥有两种批量，「摘掉自己那一种」是摘一个集合", () => {
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /const OWNED_BATCH_KINDS = \["prompt-compose", videobatch\.VIDEO_BATCH_KIND\]/);
  assert.match(app, /for \(const kind of OWNED_BATCH_KINDS\) delete savedBatches\[kind\]/);
  // 两种都水合、两种都写回、换项目两种都清空
  assert.match(app, /videoBatchState = promptbatch\.hydrateBatch\(savedBatches, videobatch\.VIDEO_BATCH_KIND\)/);
  assert.match(app, /\.\.\.\(videoBatchState \? \{ \[videoBatchState\.kind\]: videoBatchState \} : \{\}\)/);
  assert.match(app, /videoBatchState = null;/);
  assert.equal(VIDEO_BATCH_KIND, "video-generate");
});

test("持久化的视频批次经 schema 校验（与提示词那一批同一套规则）", async () => {
  const { CANVAS_SCHEMA_VERSION, MIGRATIONS, validateCanvasDoc } =
    await import("../src/services/canvasschema.js");
  const doc = { v: 1, nodes: [] };
  for (let f = 1; f < CANVAS_SCHEMA_VERSION; f++) MIGRATIONS[f](doc);
  doc.v = CANVAS_SCHEMA_VERSION;
  // 两种批量同时在文档里 —— 互不干扰
  doc.batches = {
    "prompt-compose": { kind: "prompt-compose", state: "done", items: [{ id: "s1", spent: 0 }], quote: null },
    [VIDEO_BATCH_KIND]: {
      kind: VIDEO_BATCH_KIND, state: "quoted", items: [{ id: "s1", spent: null }],
      quote: { amount: 420, currency: "JPY", count: 1 },
    },
  };
  assert.equal(validateCanvasDoc(doc), null, String(validateCanvasDoc(doc)));
  // 报价条数必须覆盖这一批（4D 轮 6 那条，对新 kind 同样成立）
  doc.batches[VIDEO_BATCH_KIND].quote.count = 9;
  assert.match(String(validateCanvasDoc(doc)), /covers 9 items but the batch has 1/);
});

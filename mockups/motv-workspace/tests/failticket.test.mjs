// TASK-079 批次 B — 失败态工单化，作为规则：
//
//   1. 失败进 Generation 注册表，`status: "failed"` **+ 失败原因**。
//      此前只有状态，没有原因 —— 创作者分不清是 packet 过期、Prompt 被拒
//      还是预算不够，也就无从判断原样重试是否有意义。
//   2. 原因是**加法字段**：没有原因的旧记录照常，且一次没带原因的调用
//      **不得抹掉**已经记下的原因。
//   3. 一次真正的成功不会被失败覆盖（既有不变量，本卡不得破坏）。
//   4. 失败卡上保留：模型 · 服务 · packet 版本 · Run id · 当时发出的 Prompt · 原因，
//      并给三个动作：重新提交 / 按这次的 Prompt 重试 / 交给 AI 导演诊断。
//      重试**不得声称「同参数」** —— 付费路线按当前 packet 跑（codex round 1）。
//   5. 没有记录原因时如实说「没有记录失败原因」，不编一个。
//
// 纯测试：无 DOM、无网络。

import { test } from "node:test";
import assert from "node:assert/strict";

import { startGeneration, failGeneration, completeGeneration } from "../src/workflow/genlib.js";
import { genCardModel, renderGenCard } from "../src/ui/gencard.js";

/* ========================================================================= */
/* 1 · 注册表：失败带原因                                                     */
/* ========================================================================= */

function reg() {
  const r = [];
  const g = startGeneration(r, {
    type: "video", targetId: "shot-a", status: "generating",
    promptSnapshot: "【首帧】…", provider: "minimax", model: "video-01",
    createdAt: "2026-08-16T00:00:00Z",
  });
  return { r, id: g.generationId };
}

test("失败会记下原因", () => {
  const { r, id } = reg();
  const g = failGeneration(r, id, "failed", "packet stale · rejected by provider");
  assert.equal(g.status, "failed");
  assert.equal(g.error, "packet stale · rejected by provider");
});

test("没给原因时不写 error —— 旧记录形状不变（加法字段）", () => {
  const { r, id } = reg();
  const g = failGeneration(r, id, "failed");
  assert.equal(g.status, "failed");
  assert.ok(!("error" in g), "没有原因就不该凭空多出一个字段");
});

test("后来一次不带原因的调用，不得抹掉已经记下的原因", () => {
  // 失败的唯一一份说明，被一次记账式调用清掉，比从来没存过更糟。
  const { r, id } = reg();
  failGeneration(r, id, "failed", "budget exceeded");
  failGeneration(r, id, "failed");
  assert.equal(r[0].error, "budget exceeded");
});

test("原因被截断，和其他 agent 文本一样", () => {
  const { r, id } = reg();
  assert.equal(failGeneration(r, id, "failed", "长".repeat(900)).error.length, 500);
});

test("一次真正的成功不会被失败覆盖（既有不变量）", () => {
  const { r, id } = reg();
  completeGeneration(r, id, ["vid-a"]);
  const g = failGeneration(r, id, "failed", "late error");
  assert.equal(g.status, "success");
  assert.ok(!("error" in g), "已经成功的记录不该被写上失败原因");
});

test("取消也是终态，且能带原因", () => {
  const { r, id } = reg();
  const g = failGeneration(r, id, "cancelled", "user cancelled");
  assert.equal(g.status, "cancelled");
  assert.equal(g.error, "user cancelled");
});

test("冻结的输入本来就在 —— 失败之所以能重开，靠的是它们", () => {
  const { r, id } = reg();
  failGeneration(r, id, "failed", "x");
  assert.equal(r[0].promptSnapshot, "【首帧】…");
  assert.equal(r[0].model, "video-01");
  assert.equal(r[0].provider, "minimax");
  assert.equal(r[0].targetId, "shot-a");
});

/* ========================================================================= */
/* 2 · 卡上的失败工单                                                         */
/* ========================================================================= */

function detailWith(gens) {
  return {
    shot: { shotId: "shot-a", seq: 1, title: "S1-01", description: "d" },
    slot: "v1-1",
    prompts: {
      image: { text: "【画面】d", missing: [] },
      video: { text: "【首帧】…", missing: [] },
    },
    refInputs: { imageReferences: [], videoReferences: [] },
    frames: { start: null, end: null, slot: "v1-1" },
    generations: gens,
  };
}

const FAILED = {
  generationId: "gen-abc", type: "video", status: "failed",
  model: "video-01", provider: "minimax", createdAt: "2026-08-16T09:30:00Z",
  error: "provider rejected the request", promptSnapshot: "【首帧】以所附图片为第 1 帧",
  resultAssetIds: [], packetVersion: 7,
};

test("失败工单写出模型 · Run id · 原因 · 当时的 Prompt", () => {
  const m = genCardModel(detailWith([FAILED]), "video", { paid: true });
  assert.equal(m.failures.length, 1);
  const html = renderGenCard(m);
  assert.ok(html.includes("video-01"));
  assert.ok(html.includes("gen-abc"), "Run id 要能对回登记表");
  assert.ok(html.includes("provider rejected the request"));
  assert.ok(html.includes("以所附图片为第 1 帧"), "当时发出的 Prompt 原样保留");
  assert.ok(html.includes("2026-08-16 09:30"));
});

test("三个动作都在", () => {
  const html = renderGenCard(genCardModel(detailWith([FAILED]), "video", { paid: true }));
  assert.ok(html.includes("data-gc-retry="), "重新提交");
  assert.ok(html.includes("data-gc-retry-edit="), "按这次的 Prompt 重试");
  assert.ok(html.includes("data-gc-diagnose="), "交给 AI 导演诊断");
});

test("重试按钮不得声称「同参数」（codex round 1 · P1）", () => {
  // 付费路线的每一项参数都来自已编译的 packet，重新提交跑的是**当前**那一份。
  // 若这次失败之后重新锁定过分镜，那就是另一个作业 —— 打着「同参数」的旗号
  // 扣费，是在为一件被说错了的事收钱。
  const html = renderGenCard(genCardModel(detailWith([FAILED]), "video", { paid: true }));
  assert.ok(!html.includes("同参数重试"), "不得做这个声称");
  assert.ok(html.includes("按当前 packet"), "要说清它实际按哪一份跑");
  assert.ok(html.includes("redo"), "并说明真正的同参数重放还没有被定义");
});

test("失败工单写出它当时跑的是哪一版 packet", () => {
  // packet 决定模型 / 分辨率 / 时长 / Prompt，所以在付费路线上，它就是「参数」。
  // 不写出来，创作者无从判断今天重试跑的是不是同一个东西。
  const html = renderGenCard(genCardModel(detailWith([FAILED]), "video", { paid: true }));
  assert.ok(html.includes("packet"));
  assert.ok(html.includes("v7"));
});

test("失败工单写出是哪家服务拒绝的（codex round 1 · P2）", () => {
  const html = renderGenCard(genCardModel(detailWith([FAILED]), "video", { paid: true }));
  assert.ok(html.includes("minimax"), "provider 收集了就要显示出来");
  const noProv = renderGenCard(genCardModel(
    detailWith([{ ...FAILED, provider: null }]), "video", { paid: true },
  ));
  assert.ok(noProv.includes("服务"), "没有记录也如实说");
});

test("没开付费写路径时不给「重新提交」—— 它会真的扣费", () => {
  const html = renderGenCard(genCardModel(detailWith([FAILED]), "video", { paid: false }));
  assert.ok(!html.includes("data-gc-retry="));
  // 但另外两个仍然可用：改 Prompt 走免费路线、以及问 AI 导演
  assert.ok(html.includes("data-gc-retry-edit="));
  assert.ok(html.includes("data-gc-diagnose="));
});

test("没有 Prompt 快照就不给「按这次的 Prompt 重试」，并说明为什么", () => {
  const html = renderGenCard(genCardModel(
    detailWith([{ ...FAILED, promptSnapshot: null }]), "video", { paid: true },
  ));
  assert.ok(!html.includes("data-gc-retry-edit="));
  assert.ok(html.includes("没有留下 Prompt 快照"));
});

test("没有记录原因时如实说，不编一个", () => {
  const html = renderGenCard(genCardModel(
    detailWith([{ ...FAILED, error: null }]), "video", { paid: true },
  ));
  assert.ok(html.includes("没有记录失败原因"));
});

test("成功与进行中的记录不会被当成失败工单", () => {
  const m = genCardModel(detailWith([
    FAILED,
    { ...FAILED, generationId: "gen-ok", status: "success" },
    { ...FAILED, generationId: "gen-run", status: "generating" },
  ]), "video", { paid: true });
  assert.deepEqual(m.failures.map((f) => f.generationId), ["gen-abc"]);
});

test("另一种媒体的失败不出现在这张卡上", () => {
  const m = genCardModel(detailWith([{ ...FAILED, type: "image" }]), "video", { paid: true });
  assert.equal(m.failures.length, 0);
});

test("一个失败都没有时，卡上不出现失败区", () => {
  const html = renderGenCard(genCardModel(detailWith([]), "video", { paid: true }));
  assert.ok(!html.includes("gc-fails"));
});

test("诊断按钮把原因与 Run id 带在自己身上，且都转义过", () => {
  // shell 靠这些属性提问，绝不回头去翻卡的模型；项目内容也不得注入 DOM。
  const html = renderGenCard(genCardModel(
    detailWith([{ ...FAILED, error: '<img src=x onerror="alert(1)">' }]), "video", { paid: true },
  ));
  assert.ok(html.includes('data-gc-diagnose="gen-abc"'));
  assert.ok(html.includes('data-shot="shot-a"'));
  assert.ok(html.includes('data-kind="video"'));
  assert.ok(html.includes("&lt;img src=x"));
  assert.ok(!html.includes("<img src=x"), "项目内容不得注入 DOM");
});

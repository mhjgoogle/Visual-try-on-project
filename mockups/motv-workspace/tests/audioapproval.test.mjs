// TASK-087 §3.5.3 —— 音频的逐份批准。
//
// 以前：一镜有多个音频片段时 `audioEvidence` 给 `assetId: null`，于是
// `stageStatuses` 那一格永远 `approved: false` —— **音频没有「通过」这件事，
// 只有「在不在」**。挑第一个去绑又等于让「哪一份通过了」指向一个任意答案。
//
// 现在：证据带上 `assetIds`（全部片段），批准按**全称量词**算 ——
// 每一份都通过才算通过。这不是新发明的规矩，是这个模块已经用在 `present`
// 上的那一条：「轨上至少有一个片段，且每一个都在」才算有产物。
import test from "node:test";
import assert from "node:assert/strict";

import { audioEvidence } from "../src/workflow/poststatus.js";
import { stageStatuses } from "../src/workflow/shotstage.js";

const clip = (assetId, trackType) => ({ assetId, trackType });

// `STAGE_TRACKS` 决定哪条轨算哪一步；用真实的 trackType，不猜。
const SFX = "sfx";

function statusOf(evidence, { approved = [] } = {}) {
  const ok = new Set(approved);
  return stageStatuses([], "shot-1", {
    artifact: (stage) => (stage === "sfx" ? evidence.sfx : null),
    approvedFor: (assetId) => ok.has(assetId),
  }).sfx;
}

test("§3.5.3: 多份片段 —— 每一份都通过才算通过", () => {
  const ev = audioEvidence(
    [clip("a1", SFX), clip("a2", SFX), clip("a3", SFX)],
    { presentOf: () => true },
  );
  assert.deepEqual(ev.sfx.assetIds, ["a1", "a2", "a3"]);
  assert.equal(ev.sfx.assetId, null, "多份时不存在「那一个」，仍然是 null");

  assert.equal(statusOf(ev, { approved: ["a1", "a2", "a3"] }).approved, true);
  // 三条里有一条没过 —— 不是通过了
  assert.equal(statusOf(ev, { approved: ["a1", "a2"] }).approved, false);
  assert.equal(statusOf(ev, { approved: [] }).approved, false);
});

test("§3.5.3: 单份片段仍然按原来那样绑", () => {
  const ev = audioEvidence([clip("solo", SFX)], { presentOf: () => true });
  assert.equal(ev.sfx.assetId, "solo");
  assert.deepEqual(ev.sfx.assetIds, ["solo"]);
  assert.equal(statusOf(ev, { approved: ["solo"] }).approved, true);
  assert.equal(statusOf(ev, { approved: ["other"] }).approved, false);
});

test("§3.5.3: **空集不算全通过** —— 全称量词最经典的那个坑", () => {
  // `[].every(...)` 是 true。直接用会把「一条片段都没有」说成「全通过了」，
  // 而那正是这一整族缺陷（把「不知道」显示成「已完成」）的形状。
  const empty = { assetId: null, assetIds: [], present: true, clips: 0 };
  assert.equal(statusOf({ sfx: empty }, { approved: ["anything"] }).approved, false);
});

test("§3.5.3: 有片段但没有 assetId 时，整步不通过（不是被悄悄跳过）", () => {
  // 绑不了批准的片段不能当作「不存在」——那会让一条没人看过的音频混进通过里。
  const ev = audioEvidence(
    [clip("a1", SFX), clip(undefined, SFX)],
    { presentOf: () => true },
  );
  assert.deepEqual(ev.sfx.assetIds, ["a1"], "没有 id 的片段进不了绑定集合");
  assert.equal(ev.sfx.clips, 2, "但它仍然被数进片段总数 —— 它确实在那儿");
  // 片段数与可绑定数对不上 → 这一步**不该显示成通过**。
  // 第一版只写了这句注释而没断言它，代码也没实现 —— 批准 a1 就能让整步变成
  // 「通过」，那条没人能批准的片段被悄悄忽略了。这正是本轮反复出现的那一族
  // （守卫描述了规矩却没执行它），所以补上断言并把规矩写进 `approvedOf`。
  assert.notEqual(ev.sfx.clips, ev.sfx.assetIds.length);
  assert.equal(statusOf(ev, { approved: ["a1"] }).approved, false,
    "有一条片段绑不了批准，整步不能算通过");
});

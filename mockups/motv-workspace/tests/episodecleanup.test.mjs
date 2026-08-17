// 48 集历史数据收口（TASK-094 批次 G / ADR-0072 决策 4-5）。
//
// 产品负责人 2026-08-17 看到的：「目标集数只有 24 集分集规划竟然设计了 48 集」。
// 成因由批次 A 修（改一版规划不再造一部新剧）；这里处理**已经建出来的历史数据**。
//
// 判据不是规划表上的空，是**整份文档里还有没有引用**（决策 5）。手写一张登记表
// 清单会漏 —— 真实项目上就漏了 `timelines`。
import test from "node:test";
import assert from "node:assert/strict";

import { episodeCleanupReport, archivableEpisodes } from "../src/workflow/episodecleanup.js";
import * as pd from "../src/workflow/proddoc.js";
import { migrateToCurrent } from "../src/services/canvasschema.js";

/** A document with three episodes: one active, one with a script, one bare. */
function doc() {
  return {
    production: {
      activeEpisodeId: "ep-1",
      episodes: [
        { episodeId: "ep-1", title: "第一集", scenes: [], bgmAssetId: null, beats: { plot: [], world: [], character: [], relationship: [] }, archived: null },
        { episodeId: "ep-2", title: "第二集", scenes: [], bgmAssetId: null, beats: { plot: [], world: [], character: [], relationship: [] }, archived: null },
        { episodeId: "ep-3", title: "空壳", scenes: [], bgmAssetId: null, beats: { plot: [], world: [], character: [], relationship: [] }, archived: null },
      ],
    },
    story: {
      confirmedPlan: 1,
      plans: [
        { v: 1, episodes: [{ epNumber: 1, title: "第一集", episodeId: "ep-1" }] },
        { v: 2, episodes: [{ epNumber: 1, title: "空壳", episodeId: "ep-3" }] },
      ],
    },
    scripts: { "ep-2": { brief: "", versions: [], active: 0, workingText: null } },
    timelines: {},
    skillRuns: [],
  };
}

test("the verdict is a REFERENCE SCAN, not a checklist of known registries", () => {
  const d = doc();
  const report = episodeCleanupReport(d);
  assert.equal(report.length, 3);
  assert.deepEqual(report.map((r) => r.archivable), [false, false, true]);
  // ep-1: the one in hand AND in the confirmed plan. The active POINTER is not
  // listed a second time as a scan hit — one reason per fact, or the creator has to
  // de-duplicate the explanation themselves.
  assert.deepEqual(report[0].blockers, ["是当前剧集", "在已确认的规划 v1 里"]);
  // ep-2: nothing of its own — but `scripts` has a KEY for it
  assert.match(report[1].blockers[0], /被引用于/);
  assert.match(report[1].blockers[0], /scripts/);
  // ep-3: named only by a plan entry, which proves nothing about content
  assert.deepEqual(report[2].blockers, []);
  assert.deepEqual(archivableEpisodes(d), ["ep-3"]);
});

test("a reference in a registry NOBODY listed still blocks archiving", () => {
  // THE POINT of scanning. The task card's checklist named 剧本 / 分镜 / 资产绑定 /
  // 生成记录 — and the real project turned out to reference episodes from
  // `timelines`, which is in none of those. A new registry added next year is
  // content BY DEFAULT.
  for (const [where, patch] of [
    ["timelines", (d) => { d.timelines["ep-3"] = { clips: [] }; }],
    ["shotAudio", (d) => { d.shotAudio = { "shot-1": { episodeId: "ep-3" } }; }],
    ["skillRuns", (d) => { d.skillRuns.push({ skillRunId: "r1", context: { episodeId: "ep-3" } }); }],
    ["a registry invented tomorrow", (d) => { d.somethingNew = { refs: ["ep-3"] }; }],
  ]) {
    const d = doc();
    patch(d);
    assert.deepEqual(archivableEpisodes(d), [], `${where} 里的引用必须挡住归档`);
  }
});

test("its OWN content blocks it too, each kind named", () => {
  const withScene = doc();
  withScene.production.episodes[2].scenes.push({ sceneId: "s1", title: "一场", shotIds: [] });
  assert.match(episodeCleanupReport(withScene)[2].blockers[0], /1 个场景/);

  const withBeat = doc();
  withBeat.production.episodes[2].beats.plot.push("发生了什么");
  assert.match(episodeCleanupReport(withBeat)[2].blockers[0], /1 条推进记录/);

  const withBgm = doc();
  withBgm.production.episodes[2].bgmAssetId = "a1";
  assert.match(episodeCleanupReport(withBgm)[2].blockers[0], /BGM/);
});

test("an already-archived episode is not offered again", () => {
  const d = doc();
  d.production.episodes[2].archived = { at: "2026-08-18T00:00:00Z", reason: "空壳" };
  const report = episodeCleanupReport(d);
  assert.equal(report[2].alreadyArchived, true);
  assert.equal(report[2].archivable, false);
  assert.deepEqual(archivableEpisodes(d), []);
});

// --- 归档是可回退的（决策 4）------------------------------------------------- //

test("archiving hides it from the working list but keeps it resolvable", () => {
  const prod = pd.createProduction(null);
  const ep2 = pd.addEpisode(prod, "空壳");
  assert.equal(pd.liveEpisodes(prod).length, 2);

  assert.equal(pd.archiveEpisode(prod, ep2.episodeId, { at: "2026-08-18T00:00:00Z", reason: "空壳" }), true);
  assert.equal(pd.liveEpisodes(prod).length, 1, "不在工作列表里了");
  assert.equal(prod.episodes.length, 2, "但仍然在文档里，位置不变");
  assert.ok(pd.findEpisode(prod, ep2.episodeId), "按 id 仍然可解析 —— 指向它的记录不成悬空引用");
  assert.equal(pd.isArchived(pd.findEpisode(prod, ep2.episodeId)), true);

  // …and it comes back
  assert.equal(pd.unarchiveEpisode(prod, ep2.episodeId), true);
  assert.equal(pd.liveEpisodes(prod).length, 2);
  assert.equal(pd.findEpisode(prod, ep2.episodeId).archived, null);
});

test("the episode IN HAND is never archived, whatever the scan says", () => {
  const prod = pd.createProduction(null);
  const active = prod.activeEpisodeId;
  assert.equal(pd.archiveEpisode(prod, active, { at: "2026-08-18T00:00:00Z" }), false,
    "两道守卫：扫描看引用，这一道看指针，谁也不能替代谁");
  assert.equal(pd.isArchived(pd.findEpisode(prod, active)), false);
});

test("archiving refuses without a timestamp — no clock inside the domain", () => {
  const prod = pd.createProduction(null);
  const ep2 = pd.addEpisode(prod, "空壳");
  assert.equal(pd.archiveEpisode(prod, ep2.episodeId, {}), false);
  assert.equal(pd.archiveEpisode(prod, ep2.episodeId, { at: "  " }), false);
  assert.equal(pd.archiveEpisode(prod, "ep-nope", { at: "2026-08-18T00:00:00Z" }), false);
});

test("a half-written archive record degrades to NOT archived, and is refused on save", () => {
  // hydration must not let a malformed field decide what the creator sees
  const revived = pd.createProduction({
    activeEpisodeId: "ep-1",
    episodes: [
      { episodeId: "ep-1", title: "一", scenes: [] },
      { episodeId: "ep-2", title: "二", scenes: [], archived: { reason: "没有时间戳" } },
      { episodeId: "ep-3", title: "三", scenes: [], archived: "不是对象" },
    ],
  });
  assert.equal(pd.liveEpisodes(revived).length, 3, "形状不对就当作没归档");
  assert.equal(revived.episodes[1].archived, null);

  // …and the validator refuses such a document rather than accepting it silently
  const base = migrateToCurrent({ v: 1, nodes: [], edges: [] }).doc;
  const withBad = (archived) => {
    const d = structuredClone(base);
    d.production.episodes.push({
      ...structuredClone(d.production.episodes[0]), episodeId: "ep-x", title: "x", archived,
    });
    return d;
  };
  assert.equal(migrateToCurrent(withBad({ at: "2026-08-18T00:00:00Z" })).status, "ok");
  assert.equal(migrateToCurrent(withBad(null)).status, "ok");
  assert.equal(migrateToCurrent(withBad({ reason: "没有时间戳" })).status, "invalid");
  assert.equal(migrateToCurrent(withBad("不是对象")).status, "invalid");
  assert.equal(migrateToCurrent(withBad({ at: "t", reason: 7 })).status, "invalid");
});

test("a document whose ACTIVE episode is archived is refused", () => {
  const base = migrateToCurrent({ v: 1, nodes: [], edges: [] }).doc;
  const d = structuredClone(base);
  d.production.episodes[0].archived = { at: "2026-08-18T00:00:00Z", reason: "x" };
  // activeEpisodeId still points at it → the creator's current episode would be
  // shown nowhere. `archiveEpisode` refuses to create this; the validator refuses
  // to accept it from anywhere else.
  assert.equal(migrateToCurrent(d).status, "invalid");
});

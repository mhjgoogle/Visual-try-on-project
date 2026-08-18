// TASK-097 批次 4B —— Scene 分组行 + timeOfDay + 镜头软删除，作为规则：
//
//   1. `S01` 派生，不存；`timeOfDay` 缺了就是空，**不猜**。
//   2. 「未分配到场景」是一个**如实的分组 + 一个动作**，不是一个错误提示。
//   3. 场景覆盖是**待办**，不是阻塞（§2.5f 第二条）——「60 个镜头没分场景」不该
//      拦住创作者进第 ① 步，第 ① 步正是做这件事的地方。
//   4. 软删除**不销毁**：标记留在原位，撤销回到原位，一次「读→改→写回」不得
//      丢掉回收区（这条是那个过滤的代价，必须钉住）。
//   5. 「哪些地方还引用这一镜」是**派生扫描**（§2.6.1），而且**两个方向都钉住**
//      （§2.5d）：真有引用要报出来，没人引用要报 0 —— 用**生产那个谓词**。
//
// 纯测试：无 DOM、无网络。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  groupShotsByScene, sceneLabel, sceneCoverage, normalizeTimeOfDay, TIME_OF_DAY_HINTS,
} from "../src/workflow/sceneplan.js";
import {
  partitionShots, softDeleteShot, restoreShot, mergeKeepingRecycled,
  deletionImpact, ownShotDraftPath, installShotMirror,
} from "../src/workflow/shotdelete.js";
import { isDeleted, productionCounts } from "../src/workflow/counts.js";
import { normalizeShots } from "../src/ui/shoteditor.js";

const shot = (id, extra = {}) => ({
  shotId: id, title: `镜 ${id}`, description: "描述", duration_seconds: 6, ...extra,
});

const prodWith = (scenes) => ({
  activeEpisodeId: "ep-1",
  episodes: [{ episodeId: "ep-1", title: "第 1 集", scenes }],
});

/* ========================================================================= */
/* 1. 分组：编号派生，时间缺了就是空                                            */
/* ========================================================================= */

test("`S01` 是派生的，`timeOfDay` 缺了就是空 —— 不猜「白天」", () => {
  const prod = prodWith([
    { sceneId: "sc-1", title: "金銮殿", timeOfDay: "白天", shotIds: ["a", "b"] },
    { sceneId: "sc-2", title: "便利店外", shotIds: ["c"] },
  ]);
  const gs = groupShotsByScene({ prod, episodeId: "ep-1", shots: [shot("a"), shot("b"), shot("c")] });
  assert.deepEqual(gs.map((g) => g.seq), [1, 2]);
  assert.equal(sceneLabel(gs[0]), "S01 ｜ 金銮殿 ｜ 白天");
  // 没写时间的那一组**整段省略**，不打印 S02 ｜ 便利店外 ｜（未填）
  assert.equal(sceneLabel(gs[1]), "S02 ｜ 便利店外");
  assert.equal(gs[1].timeOfDay, "");
  // 编号不来自任何存下来的字段
  assert.equal("seq" in prod.episodes[0].scenes[0], false);
});

test("「未分配到场景」是如实的一组；没有未分配时它不出现", () => {
  const prod = prodWith([{ sceneId: "sc-1", title: "金銮殿", shotIds: ["a"] }]);
  const gs = groupShotsByScene({ prod, episodeId: "ep-1", shots: [shot("a"), shot("b")] });
  assert.equal(gs.length, 2);
  assert.equal(gs[1].unassigned, true);
  assert.equal(sceneLabel(gs[1]), "未分配到场景（1）");
  // 全部分好之后那一组消失 —— 不打印「未分配到场景（0）」去训人
  const all = groupShotsByScene({
    prod: prodWith([{ sceneId: "sc-1", title: "金銮殿", shotIds: ["a", "b"] }]),
    episodeId: "ep-1",
    shots: [shot("a"), shot("b")],
  });
  assert.equal(all.length, 1);
  assert.equal(all.some((g) => g.unassigned), false);
});

test("场景指着一个草稿里已经没有的镜头时，它既不是一行，也不算「已分配」", () => {
  // 老草稿版本有 z，当前版本没有。喊出来是噪音，但算成已分配会让
  // 「这个场景有 2 镜」与它下面的 1 行打架（§2.6.2 那个 16/48 的同一形状）。
  const prod = prodWith([{ sceneId: "sc-1", title: "金銮殿", shotIds: ["a", "z"] }]);
  const gs = groupShotsByScene({ prod, episodeId: "ep-1", shots: [shot("a"), shot("b")] });
  assert.deepEqual(gs[0].shots.map((s) => s.shotId), ["a"]);
  assert.equal(gs[1].unassigned, true);
  assert.deepEqual(gs[1].shots.map((s) => s.shotId), ["b"], "b 仍然是未分配，z 不占名额");
});

test("场景覆盖是**待办**，不返回 blockers（§2.5f 第二条）", () => {
  const cov = sceneCoverage({
    prod: prodWith([{ sceneId: "sc-1", title: "金銮殿", shotIds: ["a"] }]),
    episodeId: "ep-1",
    shots: [shot("a"), shot("b"), shot("c")],
  });
  assert.equal(cov.scenes, 1);
  assert.equal(cov.unassigned, 2);
  assert.equal(cov.noTime, 1);
  assert.equal("blockers" in cov, false, "它是待办，不是阻塞");
  assert.match(cov.todo.join(" "), /2 个镜头还没分到场景/);
  assert.match(cov.todo.join(" "), /1 个场景还没写时间/);
  // 全都齐了就什么都不说
  const done = sceneCoverage({
    prod: prodWith([{ sceneId: "sc-1", title: "金銮殿", timeOfDay: "夜", shotIds: ["a"] }]),
    episodeId: "ep-1",
    shots: [shot("a")],
  });
  assert.deepEqual(done.todo, []);
});

test("时间是自由文本：建议只是建议，雨夜也存得下；空值删字段", () => {
  assert.equal(normalizeTimeOfDay("  黄昏 "), "黄昏");
  assert.equal(normalizeTimeOfDay("雨夜"), "雨夜", "不是闭集");
  assert.equal(normalizeTimeOfDay("   "), null, "空 → 删字段，不是存空串");
  assert.equal(normalizeTimeOfDay(null), null);
  assert.ok(TIME_OF_DAY_HINTS.includes("夜"));
});

/* ========================================================================= */
/* 2. 软删除：不销毁、可撤销、赋值不丢回收区                                     */
/* ========================================================================= */

test("软删除打标记留在原位，撤销回到原位 —— 判定共用 `counts.isDeleted`", () => {
  const shots = [shot("a"), shot("b"), shot("c")];
  const d = softDeleteShot(shots, "b", { at: "2026-08-19T00:00:00Z" });
  assert.equal(d.changed, true);
  assert.deepEqual(d.shots.map((s) => s.shotId), ["a", "b", "c"], "位置不动");
  assert.equal(isDeleted(d.shots[1]), true, "用的是那一份判定，不是第二份");
  assert.equal(shots.some(isDeleted), false, "输入没被就地改");
  const back = restoreShot(d.shots, "b");
  assert.equal(back.changed, true);
  assert.equal("deleted" in back.shots[1], false, "撤销是**删字段**，不是写 null");
  assert.deepEqual(back.shots[1], shot("b"), "回来之后长得和原来一样");
  // 没时间戳不删；删两次不重复算
  assert.equal(softDeleteShot(shots, "b", {}).changed, false);
  assert.equal(softDeleteShot(d.shots, "b", { at: "later" }).changed, false);
  assert.equal(restoreShot(shots, "b").changed, false, "没删过就没什么可撤销");
});

test("一次「读 → 改 → 写回」**不可能**丢掉回收区", () => {
  // 这是那条过滤的代价：读到的列表不含回收项，所以写回一定会漏掉它们。
  const full = [shot("a"), shot("b", { deleted: { at: "t" } }), shot("c")];
  const live = partitionShots(full).live.map((s) => ({ ...s, title: "改过了" }));
  assert.deepEqual(live.map((s) => s.shotId), ["a", "c"], "前提：读到的确实不含 b");
  const merged = mergeKeepingRecycled(full, live);
  assert.deepEqual(merged.map((s) => s.shotId), ["a", "b", "c"], "b 回到它原来的位置");
  assert.equal(isDeleted(merged[1]), true);
  assert.equal(merged[0].title, "改过了", "改动照常生效");
  // 显式撤销/删除仍然说得动它 —— 保护的是「静默丢掉」，不是「改不了」
  assert.equal(restoreShot(merged, "b").changed, true);
});

test("镜像：读到的是存活的，回收的单独取；普通赋值不会删掉回收区", () => {
  const project = { draftShots: [shot("a"), shot("b")] };
  const mirror = installShotMirror(project, project.draftShots);
  assert.deepEqual(project.draftShots.map((s) => s.shotId), ["a", "b"]);
  // 软删除走全量写入
  mirror.setAll(softDeleteShot(mirror.all(), "b", { at: "t" }).shots);
  assert.deepEqual(project.draftShots.map((s) => s.shotId), ["a"], "存活的只剩 a");
  assert.deepEqual(mirror.recycled().map((s) => s.shotId), ["b"]);
  assert.equal(mirror.all().length, 2, "记录一个没少");
  // 一个只知道存活列表的调用点写回来
  project.draftShots = [{ ...shot("a"), title: "新名字" }];
  assert.deepEqual(mirror.all().map((s) => s.shotId), ["a", "b"], "b 没被这次赋值抹掉");
  assert.equal(project.draftShots[0].title, "新名字");
  // 换项目那种「真的清空」仍然做得到
  project.draftShots = null;
  assert.equal(project.draftShots, null);
  assert.deepEqual(mirror.recycled(), []);
});

test("`undefined` 不得清空回收区 —— 它不是一句话，是一次手滑（codex 本批 P1）", () => {
  const project = { draftShots: [shot("a"), shot("b")] };
  const mirror = installShotMirror(project, project.draftShots);
  mirror.setAll(softDeleteShot(mirror.all(), "b", { at: "t" }).shots);
  assert.deepEqual(mirror.recycled().map((s) => s.shotId), ["b"]);
  // `project.draftShots = someMissingThing` 的形状
  let missing;
  project.draftShots = missing;
  assert.deepEqual(mirror.all().map((s) => s.shotId), ["a", "b"], "回收区没被一次手滑抹掉");
  assert.deepEqual(project.draftShots.map((s) => s.shotId), ["a"]);
  // 而 `null` 那句明确的话照旧做得到（两个方向都钉住，§2.5d）
  project.draftShots = null;
  assert.equal(project.draftShots, null, "「没有草稿」必须还能表达 —— 否则它会被读成「已知 0 个镜头」");
});

test("软删除的镜头不进任何计数，但记录仍在（与 `counts` 同源）", () => {
  const shots = [shot("a"), shot("b", { deleted: { at: "t" } }), shot("c")];
  const c = productionCounts({ shots });
  assert.equal(c.shotsReady.value, 2, "60 个镜头已就绪那种数字必须减掉回收的");
  assert.equal(partitionShots(shots).recycled.length, 1);
});

test("保存路径必须带住标记 —— 否则保存一次就把回收的镜头**复活**", () => {
  // normalizeShots 是白名单，而 ADDITIVE_SHOT_FIELDS 全是字符串。历史先例就在
  // 它的注释里：漏掉字段导致「编辑任何字段都会静默擦掉景别」。
  const out = normalizeShots([shot("a"), shot("b", { deleted: { at: "t", by: "me" } })], "v9");
  assert.deepEqual(out[1].deleted, { at: "t", by: "me" });
  assert.equal(isDeleted(out[1]), true);
  // 形状不对的标记不带 —— 带一个读不懂的标记比不带更危险
  const junk = normalizeShots([shot("a", { deleted: { at: "   " } }), shot("b", { deleted: true })], "v9");
  assert.equal("deleted" in junk[0], false);
  assert.equal("deleted" in junk[1], false);
});

/* ========================================================================= */
/* 3. 引用扫描：派生 + **两个方向都用生产谓词钉住**（§2.5d）                      */
/* ========================================================================= */

test("删除影响是派生扫描：真有引用报出来，**没人引用报 0**", () => {
  const doc = {
    nodes: [{ type: "scriptgen", versions: [{ v: 1, raw: [{ shotId: "a" }, { shotId: "b" }] }] }],
    timelines: { "ep-1": { tracks: [{ clips: [{ shotId: "a" }] }] } },
    generations: [{ generationId: "g1", shotId: "a" }],
  };
  const hit = deletionImpact(doc, "a");
  assert.ok(hit.total >= 2, "时间线与生成记录都指着它");
  assert.deepEqual([...new Set(hit.groups.map((g) => g.area))].sort(), ["generations", "timelines"]);
  // 反方向：草稿自己那份不算外部引用，所以没人引用的镜头报 0
  const clean = deletionImpact(doc, "b");
  assert.equal(clean.total, 0, "只钉「会报出来」那一半，等于造一道以后一定被关掉的门");
  assert.deepEqual(clean.groups, []);
});

test("那条「哪里不算」的谓词是**生产用的那个**，而且它真的分得清", () => {
  // §2.5d 那句话是批次 3 买来的：测试自己写一份等价谓词，本身就是一条新的缝。
  const expected = ownShotDraftPath("a");
  assert.equal(expected("$.nodes[0].versions[0].raw[3].shotId"), true, "草稿里镜头自己的位置");
  assert.equal(expected("$.production.episodes[0].scenes[0].shotIds[2]"), false, "场景归属是真引用");
  assert.equal(expected("$.timelines.ep-1.tracks[0].clips[0].shotId"), false, "时间线是真引用");
  assert.equal(expected("$.nodes[0].versions[0].raw[3].refs[0].shotId"), false,
    "草稿里的绑定不是「镜头自己的位置」");
  assert.equal(deletionImpact({}, "").total, 0);
});

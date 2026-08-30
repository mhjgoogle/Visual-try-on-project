// 3D 白膜导演台（TASK-123 / ADR-0094）。
//
// 白膜要回答的只有两件事：**谁从哪走到哪**、**镜头怎么拍**。这份测试钉的就是
// 这两件在数据上成立，以及那些「错了会很难发现」的地方：采样只有一份（预览与录制
// 读同一个）、删了能撤销、存盘往返不丢、拖动的换算两个方向自洽。

import test from "node:test";
import assert from "node:assert/strict";

import * as bl from "../src/workflow/blocking.js";
import { topMapper, hitTest, blockingModel } from "../src/ui/blockingws.js";

const B = () => bl.createBlocking(null);

/* --- 走位与机位 ------------------------------------------------------------- */

test("新建的白膜是一个能直接摆的空场，不是一堆 null", () => {
  const b = B();
  assert.equal(b.stage, bl.STAGE.dflt);
  assert.ok(b.duration > 0);
  assert.deepEqual(b.actors, []);
  assert.ok(b.camera.from && b.camera.to, "起幅与落幅都要有");
});

test("演员有起止两个站位 —— 那就是「走位」", () => {
  const b = B();
  const a = bl.addActor(b, "林晚");
  bl.editActor(b, a.id, { from: { x: -3, z: 0 }, to: { x: 2, z: 1 } });
  const mid = bl.sampleAt(b, 0.5);
  assert.equal(mid.actors[0].at.x, -0.5, "中间时刻在两点之间");
  assert.equal(mid.actors[0].moves, true);
});

test("站定的人不会被画成有走位", () => {
  const b = B();
  const a = bl.addActor(b, "陈默");
  bl.editActor(b, a.id, { from: { x: 1, z: 1 }, to: { x: 1, z: 1 } });
  assert.equal(bl.sampleAt(b, 0.3).actors[0].moves, false);
});

test("机位从起幅推到落幅：位置、高度、焦距都在插值", () => {
  const b = B();
  bl.setCamera(b, "from", { at: { x: 0, z: -8 }, y: 1.6, lens: 24 });
  bl.setCamera(b, "to", { at: { x: 0, z: -2 }, y: 0.8, lens: 85 });
  const mid = bl.sampleAt(b, 0.5);
  assert.equal(mid.camera.at.z, -5);
  assert.ok(Math.abs(mid.camera.y - 1.2) < 1e-9);
  assert.ok(Math.abs(mid.camera.lens - 54.5) < 1e-9);
});

test("`both` 一次改两端 —— 固定机位是一句话的事", () => {
  const b = B();
  assert.equal(bl.setCamera(b, "both", { y: 2.4 }), true);
  assert.equal(b.camera.from.y, 2.4);
  assert.equal(b.camera.to.y, 2.4);
});

test("越界的数被夹住，不是被拒绝也不是原样写进去", () => {
  const b = B();
  bl.setCamera(b, "from", { y: 999 });
  assert.ok(b.camera.from.y <= 30);
  // 时长同样是夹住而不是拒绝：他把框清空/打了个 0，界面上应当出现最短的那个值，
  // 而不是一个「没反应」的输入框。
  bl.setDuration(b, 0);
  assert.equal(b.duration, 0.5, "0 秒不是一个镜头 —— 夹到最短");
  assert.equal(bl.setDuration(b, "不是数"), false, "根本不是数才拒绝");
  assert.equal(bl.setStage(b, 3), true);
});

/* --- 删除可撤销（第 13 条）-------------------------------------------------- */

test("删演员是软删除 —— 摆了半天的走位不该一点就没", () => {
  const b = B();
  const a = bl.addActor(b, "沈既白");
  assert.equal(bl.hideActor(b, a.id, "T1"), true);
  assert.equal(bl.visibleActors(b).length, 0);
  assert.equal(b.actors.length, 1, "记录本身还在");
  assert.equal(bl.restoreActor(b, a.id), true);
  assert.equal(bl.visibleActors(b).length, 1);
});

test("删掉的人不进采样，也就不会出现在画面里", () => {
  const b = B();
  const a = bl.addActor(b, "路人");
  bl.hideActor(b, a.id, "T1");
  assert.equal(bl.sampleAt(b, 0.5).actors.length, 0);
});

/* --- 一份采样，两个读者 ----------------------------------------------------- */

test("同一个 t 采样两次结果一致 —— 预览与录制不可能是两回事", () => {
  const b = B();
  bl.addActor(b, "林晚");
  const one = JSON.stringify(bl.sampleAt(b, 0.37));
  const two = JSON.stringify(bl.sampleAt(b, 0.37));
  assert.equal(one, two);
});

test("t 越界被夹在 [0,1]，不会外推出画面外的机位", () => {
  const b = B();
  bl.setCamera(b, "from", { at: { x: 0, z: -8 } });
  bl.setCamera(b, "to", { at: { x: 0, z: -2 } });
  assert.equal(bl.sampleAt(b, -5).camera.at.z, -8);
  assert.equal(bl.sampleAt(b, 9).camera.at.z, -2);
});

/* --- 焦距是导演的说法 ------------------------------------------------------- */

test("焦距越长视角越窄", () => {
  assert.ok(bl.fovOf(18) > bl.fovOf(50));
  assert.ok(bl.fovOf(50) > bl.fovOf(135));
});

/* --- 说清楚了没有：不猜，缺什么说什么 --------------------------------------- */

test("空场不能录，且说得出为什么", () => {
  const b = B();
  const r = bl.readiness(b);
  assert.equal(r.canRecord, false);
  assert.match(r.gaps[0], /至少放一个/);
});

test("全程静止能录，但要说出来会是一张不动的画面", () => {
  const b = B();
  bl.addActor(b, "林晚");
  const r = bl.readiness(b);
  assert.equal(r.canRecord, true);
  assert.equal(r.still, true);
});

test("有人走动就不算静止", () => {
  const b = B();
  const a = bl.addActor(b, "林晚");
  bl.editActor(b, a.id, { to: { x: 3, z: 3 } });
  assert.equal(bl.readiness(b).still, false);
});

/* --- 存盘往返 --------------------------------------------------------------- */

test("round-trip 无损 —— 刷新一次不许丢走位", () => {
  const b = B();
  const a = bl.addActor(b, "林晚");
  bl.editActor(b, a.id, { from: { x: -2, z: 1 }, to: { x: 3, z: -1 }, facing: 90 });
  bl.addProp(b, "吧台");
  bl.setCamera(b, "to", { lens: 85, y: 0.9 });
  bl.setDuration(b, 6.5);
  const round = bl.createBlocking(JSON.parse(JSON.stringify(bl.serializeBlocking(b))));
  assert.deepEqual(bl.serializeBlocking(round), bl.serializeBlocking(b));
});

test("已录的白膜只记 assetId，不把字节塞进创作文档", () => {
  const b = bl.createBlocking({ takes: [{ assetId: "a-1", at: "T", seconds: 4 }, { at: "T" }] });
  assert.equal(b.takes.length, 1, "没有 assetId 的记录留不住 —— 它指不到任何东西");
  assert.equal(b.takes[0].assetId, "a-1");
});

/* --- 俯视图：拖动的换算两个方向自洽 ----------------------------------------- */

test("世界坐标 ↔ 像素来回一次回到原点", () => {
  const map = topMapper(12, 480);
  const px = map.toPx({ x: -3, z: 2 });
  const back = map.toWorld(px.x, px.y);
  assert.ok(Math.abs(back.x + 3) < 1e-9 && Math.abs(back.z - 2) < 1e-9);
});

test("点在机位上就抓到机位，点在空处什么也不抓", () => {
  const b = B();
  bl.setCamera(b, "from", { at: { x: 0, z: -4 } });
  const map = topMapper(b.stage, 480);
  const at = map.toPx({ x: 0, z: -4 });
  assert.deepEqual(hitTest(b, at.x, at.y, 480), { kind: "camAt", which: "from" });
  assert.equal(hitTest(b, 5, 5, 480), null);
});

test("演员的起点与终点是两个可以分别拖的把手", () => {
  const b = B();
  const a = bl.addActor(b, "林晚");
  bl.editActor(b, a.id, { from: { x: -3, z: 0 }, to: { x: 3, z: 0 } });
  const map = topMapper(b.stage, 480);
  const f = map.toPx({ x: -3, z: 0 });
  const to = map.toPx({ x: 3, z: 0 });
  assert.equal(hitTest(b, f.x, f.y, 480).kind, "actorFrom");
  assert.equal(hitTest(b, to.x, to.y, 480).kind, "actorTo");
});

/* --- 读模型 ----------------------------------------------------------------- */

test("没选镜头时读模型不炸，且如实说不能录", () => {
  const m = blockingModel({ draftShots: [] }, null, null);
  assert.equal(m.ready.canRecord, false);
  assert.equal(m.shot, null);
});

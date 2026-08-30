// Story Development 的新数据模型（TASK-122 第 1 步）。
//
// 产品负责人 2026-08-30 的规格里，有三条是**数据层**的承诺，界面再漂亮也补不回来：
//   1. 大纲节点的 id 要稳 —— 否则结构规划的「关联故事大纲」会集体断掉；
//   2. Planned Chapters/Episodes 可增可减 —— 减少时既有的章/集不许被删掉；
//   3. 日常编辑只留最新版，**点定稿才存历史**，历史可看可恢复可删。
// 这份测试守的就是这三条。

import test from "node:test";
import assert from "node:assert/strict";

import * as w from "../src/workflow/storywork.js";
import * as st from "../src/workflow/storydoc.js";

const work = () => w.createWork(null);

/* --- 大纲节点：id 必须稳 ---------------------------------------------------- */

test("段落切成节点，每个都有 id", () => {
  const k = work();
  const nodes = w.setOutline(k, "第一段\n\n第二段\n\n- 一条列表项");
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.map((n) => n.kind), ["para", "para", "item"]);
  assert.ok(nodes.every((n) => n.id));
  assert.equal(new Set(nodes.map((n) => n.id)).size, 3, "id 不许重复");
});

test("改一个错别字，其余节点的 id 一个都不许变", () => {
  const k = work();
  const before = w.setOutline(k, "开端：他丢了名字\n\n发展：他去找\n\n结局：他换回来");
  const after = w.setOutline(k, "开端：他丢了名字\n\n发展：他去找回\n\n结局：他换回来");
  assert.equal(after[0].id, before[0].id, "没动的第一段换了 id");
  assert.equal(after[2].id, before[2].id, "没动的第三段换了 id");
  // 改过的那一段按位置复用，所以引用它的表格不会断
  assert.equal(after[1].id, before[1].id);
});

test("在中间插一段，前后各段的 id 仍然是自己的", () => {
  const k = work();
  const before = w.setOutline(k, "A\n\nB");
  const after = w.setOutline(k, "A\n\n新的\n\nB");
  const ids = after.map((n) => n.id);
  assert.ok(ids.includes(before[0].id), "A 的 id 丢了");
  assert.ok(ids.includes(before[1].id), "B 的 id 丢了");
});

test("节点与文本互相还原", () => {
  const k = work();
  w.setOutline(k, "第一段\n\n第二段");
  assert.equal(w.outlineText(k), "第一段\n\n第二段");
});

/* --- 结构规划：9 列，引用大纲节点 ------------------------------------------- */

test("那张表的列就是他点名的九列，顺序不变", () => {
  assert.deepEqual(
    w.PLAN_COLUMNS.map(([k]) => k),
    ["unitNo", "scene", "purpose", "characters", "goal", "conflict", "turn", "endingState", "outlineRefs"],
  );
});

test("一行能引用大纲节点；引用不存在的节点会被指出来，而不是静默丢掉", () => {
  const k = work();
  const nodes = w.setOutline(k, "开端\n\n结局");
  const row = w.addPlanRow(k, "T0");
  assert.equal(w.editPlanRow(k, row.id, "outlineRefs", [nodes[0].id, "on-没了"]), true);
  const bad = w.danglingRefs(k);
  assert.deepEqual(bad.map((x) => x.ref), ["on-没了"]);
});

test("表里不认识的列改不动", () => {
  const k = work();
  const row = w.addPlanRow(k, "T0");
  assert.equal(w.editPlanRow(k, row.id, "bogus", "x"), false);
});

test("删一行是软删除，能撤销", () => {
  const k = work();
  const row = w.addPlanRow(k, "T0");
  w.addPlanRow(k, "T0");
  assert.equal(w.hidePlanRow(k, row.id, "T1"), true);
  assert.equal(w.visiblePlanRows(k).length, 1);
  assert.equal(k.plan.rows.length, 2, "行本身不许从表里消失");
  assert.equal(w.restorePlanRow(k, row.id), true);
  assert.equal(w.visiblePlanRows(k).length, 2);
});

/* --- 形态与章/集数：可增可减，减了不删东西 ---------------------------------- */

test("形态不替他默认，乱写的形态不认", () => {
  const k = work();
  assert.equal(k.form, "");
  assert.equal(w.setForm(k, "漫画"), false);
  assert.equal(w.setForm(k, "novel"), true);
  assert.equal(k.form, "novel");
});

test("Planned 数量能加能减，减少时既有的章一个都不删", () => {
  const k = work();
  w.setPlanned(k, "novel", 3);
  w.ensureUnit(k, "novel", 3, "T0");
  assert.equal(w.setPlanned(k, "novel", 1), true);
  assert.equal(k.planned.novel, 1);
  assert.equal(k.units.length, 1, "计划变少不该删掉已经写的东西");
  assert.equal(k.units[0].no, 3);
});

test("同一章拿两次是同一个单元，不会长出第二份", () => {
  const k = work();
  const a = w.ensureUnit(k, "episode", 2, "T0");
  const b = w.ensureUnit(k, "episode", 2, "T1");
  assert.equal(a.id, b.id);
  assert.equal(k.units.length, 1);
});

/* --- 定稿：日常不产生历史 --------------------------------------------------- */

test("日常编辑不产生历史版本", () => {
  const k = work();
  const u = w.ensureUnit(k, "novel", 1, "T0");
  w.editUnit(k, u.id, "body", "写了一段", "T1");
  w.editUnit(k, u.id, "body", "又改了一遍", "T2");
  assert.equal(u.finalized.length, 0, "日常改动不该存历史");
  assert.equal(u.body, "又改了一遍");
});

test("点定稿才存一版；内容没变时不重复存", () => {
  const k = work();
  const u = w.ensureUnit(k, "novel", 1, "T0");
  w.editUnit(k, u.id, "body", "第一稿", "T1");
  assert.equal(w.finalizeUnit(k, u.id, "T2", "第一次定稿").v, 1);
  assert.equal(w.finalizeUnit(k, u.id, "T3"), null, "没改就不该再存一版");
  w.editUnit(k, u.id, "body", "第二稿", "T4");
  assert.equal(w.finalizeUnit(k, u.id, "T5").v, 2);
  assert.equal(u.finalized.length, 2);
});

test("历史能恢复、能手动删", () => {
  const k = work();
  const u = w.ensureUnit(k, "novel", 1, "T0");
  w.editUnit(k, u.id, "body", "第一稿", "T1");
  w.finalizeUnit(k, u.id, "T2");
  w.editUnit(k, u.id, "body", "写坏了", "T3");
  assert.equal(w.restoreFinalized(k, u.id, 1, "T4"), true);
  assert.equal(u.body, "第一稿");
  assert.equal(w.deleteFinalized(k, u.id, 1), true);
  assert.equal(u.finalized.length, 0);
  assert.equal(u.body, "第一稿", "删历史不该动当前正文");
});

/* --- 存盘往返 + 与既有文档并存 ---------------------------------------------- */

test("整份 round-trip 无损 —— 刷新一次不许丢东西", () => {
  const k = work();
  w.setForm(k, "novel");
  k.core = "被世界抹除的人并没有消失";
  w.setOutline(k, "开端\n\n结局");
  const row = w.addPlanRow(k, "T0");
  w.editPlanRow(k, row.id, "scene", "酒吧 · 打烊后");
  w.editPlanRow(k, row.id, "outlineRefs", [k.outline.nodes[0].id]);
  const u = w.ensureUnit(k, "novel", 1, "T0");
  w.editUnit(k, u.id, "body", "正文", "T1");
  w.finalizeUnit(k, u.id, "T2");

  const round = w.createWork(JSON.parse(JSON.stringify(w.serializeWork(k))));
  assert.deepEqual(w.serializeWork(round), w.serializeWork(k));
});

test("它住在故事文档里，且不动既有的简报 / 大纲 / 分集规划", () => {
  const doc = st.createStory(null);
  assert.ok(doc.work, "story.work 没建起来");
  st.setIdea(doc, "创意");
  st.commitBrief(doc);
  w.setForm(doc.work, "episode");
  const round = st.createStory(JSON.parse(JSON.stringify(st.serialize(doc))));
  assert.equal(round.work.form, "episode");
  assert.equal(round.brief.versions.length, 1, "既有的简报版本被动了");
  assert.equal(round.idea, "创意");
});

test("迁移：现有分集变成结构规划的行，且只做一次", () => {
  const k = work();
  const n = w.seedPlanFromEpisodes(k, [{ title: "EP01 迷雾入城" }, { title: "EP02 回声" }], "T0");
  assert.equal(n, 2);
  assert.deepEqual(w.visiblePlanRows(k).map((r) => r.scene), ["EP01 迷雾入城", "EP02 回声"]);
  assert.equal(w.seedPlanFromEpisodes(k, [{ title: "EP03" }], "T1"), 0, "不许重复灌一次");
});

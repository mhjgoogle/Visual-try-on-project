// Story Development 四页（TASK-122 第 3–6 步）。
//
// 这份测试逐条钉的是**产品负责人 2026-08-30 规格里的句子**，不是实现细节 —— 每一条
// 都写明它对应哪一句，因为验收时要拿这张表逐条对照。

import test from "node:test";
import assert from "node:assert/strict";

import * as w from "../src/workflow/storywork.js";
import * as st from "../src/workflow/storydoc.js";
import { renderCoreWs, renderOutlineWorkWs, coreModel } from "../src/ui/corews.js";
import { renderPlanWs, planModel } from "../src/ui/planws.js";
import { renderDraftWs, draftModel } from "../src/ui/draftws.js";
import { actionCatalog, knownAction, runAction } from "../src/workflow/convactions.js";

/** 一个像 app.js 那样的 story 门面（页面读的是 doc()，不是文档本身 —— 写错过一次）。 */
function facade(doc) {
  return { doc: () => doc };
}

function project() {
  const doc = st.createStory(null);
  return { doc, story: facade(doc), ctx: { story: facade(doc) } };
}

/* --- ① 故事核心：「只使用一个大型文本编辑器」------------------------------ */

test("故事核心整页只有一个编辑器", () => {
  const { ctx } = project();
  const html = renderCoreWs(ctx, {});
  assert.equal((html.match(/<textarea/g) || []).length, 1, "多于一个编辑器就不是他要的那一页");
  assert.ok(html.includes('data-core="1"'));
  assert.ok(!/<input /.test(html), "不许再出现字段表单");
});

test("门面写错一层不再白屏 —— 传门面也读得到，传文档也读得到", () => {
  const { doc, story } = project();
  doc.work.core = "文字";
  assert.equal(coreModel(story).text, "文字");
  assert.equal(coreModel(doc).text, "文字");
});

/* --- ② 故事大纲：「像写普通文本」+「自动生成稳定 Node ID」------------------ */

test("大纲页也只有一个编辑器，节点编号是系统给的", () => {
  const { doc, ctx } = project();
  w.setOutline(doc.work, "开端：他丢了名字\n\n发展：他去找");
  const html = renderOutlineWorkWs(ctx, {});
  assert.equal((html.match(/<textarea/g) || []).length, 1);
  assert.equal((html.match(/class="sw-node"/g) || []).length, 2, "两段应当切成两个节点");
  assert.ok(!/data-node-id-input/.test(html), "不许出现要他手填 id 的地方");
});

/* --- ③ 结构规划：「字段严格为」那九个 -------------------------------------- */

test("表头就是他点名的九列，顺序一致", () => {
  const { ctx } = project();
  const html = renderPlanWs(ctx, {});
  const heads = [...html.matchAll(/<th>([^<]+)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(heads, [
    "Unit No.", "Scene", "Scene 目的", "主要人物", "人物目标",
    "冲突", "关键转折", "Ending State", "关联故事大纲",
  ]);
});

test("「关联故事大纲」引用的是大纲自动生成的节点；断掉的引用会被说出来", () => {
  const { doc, ctx } = project();
  const nodes = w.setOutline(doc.work, "开端\n\n结局");
  const row = w.addPlanRow(doc.work, "T0");
  w.editPlanRow(doc.work, row.id, "outlineRefs", [nodes[0].id, "on-没了"]);
  const m = planModel(ctx.story);
  assert.equal(m.dangling.length, 1);
  const html = renderPlanWs(ctx, {});
  assert.ok(html.includes("§1"), "活着的引用按段落序号显示");
  assert.ok(html.includes("§?"), "断掉的引用要标出来，不是悄悄删掉");
});

/* --- ④ 正文创作：两个入口 / 三条路径 / 数量可增减 / 页内选择器 ------------- */

test("没选形态时，屏幕上只有小说创作与剧集创作两个入口", () => {
  const { ctx } = project();
  const html = renderDraftWs(ctx, {});
  assert.ok(html.includes("小说创作") && html.includes("剧集创作"));
  assert.ok(!html.includes("Planned"), "还没选形态就不该谈章数");
});

test("小说模式说 Planned Chapters，剧集模式说 Planned Episodes", () => {
  const { doc, ctx } = project();
  w.setForm(doc.work, "novel");
  assert.ok(renderDraftWs(ctx, {}).includes("Planned Chapters"));
  w.setForm(doc.work, "episode");
  assert.ok(renderDraftWs(ctx, {}).includes("Planned Episodes"));
});

test("写过小说之后才出现「进入剧集创作」——三条路径里的第二条", () => {
  const { doc, ctx } = project();
  w.setForm(doc.work, "novel");
  assert.ok(!renderDraftWs(ctx, {}).includes("进入剧集创作"), "还没写就不该催他转");
  const u = w.ensureUnit(doc.work, "novel", 1, "T0");
  w.editUnit(doc.work, u.id, "body", "正文", "T1");
  assert.ok(renderDraftWs(ctx, {}).includes("进入剧集创作"));
});

test("章/集选择器在**页内**，且减少计划不会让写过的那一章消失", () => {
  const { doc, ctx } = project();
  w.setForm(doc.work, "novel");
  w.setPlanned(doc.work, "novel", 3);
  const u = w.ensureUnit(doc.work, "novel", 3, "T0");
  w.editUnit(doc.work, u.id, "body", "第三章正文", "T1");
  w.setPlanned(doc.work, "novel", 1);
  const html = renderDraftWs(ctx, {});
  assert.equal((html.match(/data-unit="/g) || []).length, 3, "写过的第 3 章仍然在选择器里");
  assert.ok(html.includes("db-u"), "选择器是这一页的一部分，不在左栏");
});

test("进到一章：左侧二级 Brief + 中央大编辑器 + Copy 按钮", () => {
  const { doc, ctx } = project();
  w.setForm(doc.work, "novel");
  w.setPlanned(doc.work, "novel", 2);
  w.ensureUnit(doc.work, "novel", 1, "T0");
  const html = renderDraftWs(ctx, { unitNo: 1 });
  assert.ok(html.includes("db-brief"), "二级 Brief");
  assert.ok(html.includes("db-editor"), "中央大编辑器");
  assert.ok(html.includes("data-unit-copy"), "Copy 按钮");
});

test("二级 Brief 显示与结构规划/大纲/故事核心的关联", () => {
  const { doc, ctx } = project();
  const nodes = w.setOutline(doc.work, "开端：酒吧打烊");
  doc.work.core = "被世界抹除的人并没有消失";
  w.setForm(doc.work, "novel");
  const row = w.addPlanRow(doc.work, "T0");
  w.editPlanRow(doc.work, row.id, "unitNo", "1");
  w.editPlanRow(doc.work, row.id, "purpose", "让他决定不交出录音");
  w.editPlanRow(doc.work, row.id, "outlineRefs", [nodes[0].id]);
  w.ensureUnit(doc.work, "novel", 1, "T0");
  const html = renderDraftWs(ctx, { unitNo: 1 });
  assert.ok(html.includes("让他决定不交出录音"), "这一章的任务");
  assert.ok(html.includes("§1"), "关联到的大纲节点");
  assert.ok(html.includes("被世界抹除的人"), "故事核心");
});

/* --- 版本规则：日常不产生版本，定稿才产生 ---------------------------------- */

test("四样内容同一条版本规矩，且默认只显示最新版", () => {
  const { doc, ctx } = project();
  doc.work.core = "第一稿";
  assert.ok(renderCoreWs(ctx, {}).includes("还没有历史版本"), "日常编辑不产生版本");
  w.finalizeDoc(doc.work, "core", "T1");
  const html = renderCoreWs(ctx, {});
  assert.ok(html.includes("历史版本 1"));
  assert.ok(!html.includes("sw-hist"), "历史默认收起 —— 屏幕上只显示最新版");
  assert.ok(renderCoreWs(ctx, { coreHist: true }).includes("sw-hist"), "点开才列出来");
});

test("历史版本可查看、可恢复、可手动删（他逐条点名的三件事）", () => {
  const { doc, ctx } = project();
  doc.work.core = "第一稿";
  w.finalizeDoc(doc.work, "core", "T1");
  const html = renderCoreWs(ctx, { coreHist: true });
  assert.ok(html.includes("data-finview"), "查看");
  assert.ok(html.includes("data-finrestore"), "恢复");
  assert.ok(html.includes("data-findel"), "手动删除");
});

/* --- Agent 权限：改的是正式数据模型 ---------------------------------------- */

test("Agent 能改这四页的每一样，且走的是同一条写路径", () => {
  const ids = actionCatalog().map((a) => a.id);
  for (const id of [
    "work.core", "work.outline", "plan.row.add", "plan.row.edit", "plan.row.delete",
    "plan.row.restore", "plan.row.link", "work.form", "work.planned", "unit.write", "work.finalize",
  ]) {
    assert.ok(ids.includes(id), `少了动作 ${id}`);
    assert.ok(knownAction(id));
  }
});

test("Agent 写故事核心 → 落到文档，不是只改屏幕上的字", () => {
  const { doc, ctx } = project();
  runAction(ctx, "work.core", {text: "他决定在天亮前交出录音" });
  assert.equal(doc.work.core, "他决定在天亮前交出录音");
  runAction(ctx, "work.core", {append: "但他没有" });
  assert.ok(doc.work.core.endsWith("但他没有"));
});

test("Agent 写大纲 → 节点编号跟着自动维护", () => {
  const { doc, ctx } = project();
  runAction(ctx, "work.outline", {text: "开端\n\n结局" });
  assert.equal(doc.work.outline.nodes.length, 2);
  assert.ok(doc.work.outline.nodes.every((n) => n.id));
});

test("Agent 改结构规划、关联大纲节点，都落到正式数据", () => {
  const { doc, ctx } = project();
  runAction(ctx, "work.outline", {text: "开端" });
  runAction(ctx, "plan.row.add", {unitNo: "1", scene: "酒吧 · 打烊后" });
  const row = w.visiblePlanRows(doc.work)[0];
  assert.equal(row.scene, "酒吧 · 打烊后");
  runAction(ctx, "plan.row.edit", {rowId: row.id, field: "conflict", value: "交出去等于毁掉自己" });
  assert.equal(row.conflict, "交出去等于毁掉自己");
  runAction(ctx, "plan.row.link", {rowId: row.id, nodeId: doc.work.outline.nodes[0].id });
  assert.equal(row.outlineRefs.length, 1);
});

test("Agent 关联一个不存在的节点会被拒绝，而不是写进一个断引用", () => {
  const { ctx } = project();
  runAction(ctx, "plan.row.add", { });
  const rowId = ctx.story.doc().work.plan.rows[0].id;
  assert.throws(() => runAction(ctx, "plan.row.link", {rowId, nodeId: "on-不存在" }));
});

test("Agent 写正文、设数量、定稿 —— 与他自己点按钮同一组函数", () => {
  const { doc, ctx } = project();
  runAction(ctx, "work.form", {form: "novel" });
  runAction(ctx, "work.planned", {n: 3 });
  assert.equal(doc.work.planned.novel, 3);
  runAction(ctx, "unit.write", {no: 2, text: "第二章的正文" });
  const unit = doc.work.units.find((u) => u.no === 2);
  assert.equal(unit.body, "第二章的正文");
  assert.equal(unit.finalized.length, 0, "Agent 写正文也不该产生历史版本");
  runAction(ctx, "work.finalize", {what: "unit", no: 2, note: "第一稿" });
  assert.equal(unit.finalized.length, 1, "定稿才产生");
});

test("Agent 没选形态就写正文 → 说出原因，不猜", () => {
  const { ctx } = project();
  assert.throws(() => runAction(ctx, "unit.write", {no: 1, text: "x" }), /还没选/);
});

/* --- 迁移：他已经写下的东西必须出现在新编辑器里 ---------------------------- */

test("旧大纲里写下的内容迁进故事核心与故事大纲，且只迁一次", () => {
  const { doc } = project();
  const legacy = {
    logline: "调酒师握着一段录音。",
    themes: ["沉默的代价"],
    characters: [{ name: "林晚", role: "主角", want: "把录音交出去" }],
    genreTone: "都市悬疑 / 冷色调",
    beats: ["最后一个客人", "录音笔", "天亮"],
  };
  assert.equal(w.seedCoreFromStory(doc.work, legacy, { genre: "悬疑" }, "T0"), true);
  assert.ok(doc.work.core.includes("调酒师握着一段录音"), "他写的 logline 必须出现在屏幕上");
  assert.ok(doc.work.core.includes("林晚"), "人物也要带过来");
  assert.equal(w.seedOutlineFromStory(doc.work, legacy, "T0"), true);
  assert.equal(doc.work.outline.nodes.length, 3, "beats 一条一个节点");
  // 第二次不再灌 —— 否则会盖掉他后来自己改的
  doc.work.core = "我自己重写的";
  w.seedCoreFromStory(doc.work, legacy, null, "T1");
  assert.equal(doc.work.core, "我自己重写的");
});

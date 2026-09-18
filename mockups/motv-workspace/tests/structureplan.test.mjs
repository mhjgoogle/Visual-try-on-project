// TASK-154 / REQ-009 判据 3：故事核心 / 大纲 / 结构规划三步都能让 AI 来，且在小说语境下成立。
//
// 断言的是**行为**：这一片会静默出错的形状是「落到了不该落的地方」「把他写的盖掉了」
// 「引用指错了段」—— 三种都不报错，只会在他打开那一页时才发现。
//
//   1. 形态与当前结构表如何喂给能力（`formForPrompt` / `planRowsForPrompt`），
//      以及它们真的经 controller 进了提示词；
//   2. `applyCoreProposal` —— 核心落进自己的家，他的原稿先存一版、退得回去；
//   3. `applyPlanProposal` —— 九列进表、§N 解析成节点 id、越界丢并说出、旧行进回收区可拿回；
//   4. `planApply("structure-planner")` —— 提案翻译成 `proposePlanRows`，空表拒绝。

import test from "node:test";
import assert from "node:assert/strict";

import * as w from "../src/workflow/storywork.js";
import * as skills from "../src/workflow/skills.js";
import * as skillrun from "../src/workflow/skillrun.js";
import * as skillapply from "../src/workflow/skillapply.js";
import * as shotctx from "../src/workflow/shotctx.js";
import * as proddoc from "../src/workflow/proddoc.js";
import * as storydoc from "../src/workflow/storydoc.js";
import * as scriptdoc from "../src/workflow/scriptdoc.js";
import * as assetreg from "../src/workflow/assetreg.js";
import * as refinterp from "../src/workflow/refinterp.js";
import * as timeline from "../src/workflow/timeline.js";
import * as subtitle from "../src/workflow/subtitle.js";
import * as mediaref from "../src/workflow/mediaref.js";
import { createSkillController } from "../src/controllers/skillctl.js";
import { installBuiltinCatalog } from "./skillcatalog.mjs";

function novelWork({ planned = 12 } = {}) {
  const k = w.createWork(null);
  w.setForm(k, "novel");
  w.setPlanned(k, "novel", planned);
  return k;
}

// --- 1. 喂给能力的形态与当前表 ------------------------------------------------ //

test("作品形态：小说按章、剧集按集，没选就是 null", () => {
  assert.deepEqual(w.formForPrompt(novelWork({ planned: 12 })), { form: "novel", word: "章", planned: 12 });
  const ep = w.createWork(null);
  w.setForm(ep, "episode");
  w.setPlanned(ep, "episode", 8);
  assert.deepEqual(w.formForPrompt(ep), { form: "episode", word: "集", planned: 8 });
  assert.equal(w.formForPrompt(w.createWork(null)), null);
  assert.equal(w.formForPrompt(null), null);
});

test("当前结构表：一行没有就是 null；有就按九列的中文标签给，引用解析成 §N", () => {
  const k = novelWork();
  assert.equal(w.planRowsForPrompt(k), null);
  w.setOutline(k, "第一段\n\n第二段\n\n第三段");
  const ids = k.outline.nodes.map((n) => n.id);
  const row = w.addPlanRow(k, "T0");
  w.editPlanRow(k, row.id, "scene", "潜水舱");
  w.editPlanRow(k, row.id, "outlineRefs", [ids[2], "gone-node"]);
  const rows = w.planRowsForPrompt(k);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["Scene"], "潜水舱");
  assert.deepEqual(rows[0]["关联故事大纲"], ["§3"], "悬空引用不该冒充一个 §");
  assert.ok(!JSON.stringify(rows).includes(ids[2]), "裸节点 id 不该出现在喂给能力的材料里");
});

// --- 2. 故事核心有自己的家 ---------------------------------------------------- //

test("核心提案写进 work.core；他写过的先存一版、恢复得回去", () => {
  const k = novelWork();
  const r1 = w.applyCoreProposal(k, "AI 写的核心", "T1");
  assert.equal(r1.ok, true);
  assert.equal(r1.kept, null, "空核心不该凭空长出一版历史");
  assert.equal(k.core, "AI 写的核心");

  k.core = "他自己写的核心";
  const r2 = w.applyCoreProposal(k, "AI 第二版核心", "T2");
  assert.equal(r2.ok, true);
  assert.ok(r2.kept, "他写的核心被盖掉却没存下来");
  assert.equal(r2.kept.body, "他自己写的核心");
  assert.match(r2.kept.note, /覆盖前/);
  assert.equal(k.core, "AI 第二版核心");
  assert.equal(w.restoreDoc(k, "core", r2.kept.v, "T3"), true, "退不回他那一版");
  assert.equal(k.core, "他自己写的核心");
});

test("空的核心提案不落，也不动他的核心", () => {
  const k = novelWork();
  k.core = "他的核心";
  for (const text of ["", "   ", null, undefined, 42]) {
    const r = w.applyCoreProposal(k, text, "T");
    assert.equal(r.ok, false, `text=${String(text)} 竟然落了`);
  }
  assert.equal(k.core, "他的核心");
  assert.equal(w.visibleVersions(k.finalized.core).length, 0);
});

// --- 3. 结构规划整表替换 ------------------------------------------------------ //

const PROPOSED = [
  { unitNo: 1, scene: "港口", purpose: "出发", characters: "林深、老周", goal: "拿到许可", conflict: "港务拒签", turn: "老周亮出旧证件", endingState: "船出港", outlineRefs: [1] },
  { unitNo: 2, scene: "深海", purpose: "第一次接触", characters: "林深", goal: "定位信号", conflict: "氧气只够一人", turn: "城市开口说话", endingState: "林深答应回去", outlineRefs: [2, 3] },
];

test("九列一行不少地进表，§N 解析成节点 id，越界引用被丢并计数", () => {
  const k = novelWork();
  w.setOutline(k, "港口的清晨\n\n下潜\n\n城市说话");
  const ids = k.outline.nodes.map((n) => n.id);
  const res = w.applyPlanProposal(k, [...PROPOSED, { ...PROPOSED[1], unitNo: 3, outlineRefs: [9, 0, 2] }], "T1");
  assert.equal(res.ok, true, res.error);
  assert.equal(res.added, 3);
  assert.equal(res.retired, 0);
  assert.equal(res.kept, null, "空表不该凭空长出一版");
  assert.equal(res.droppedRefs, 2, "§9 与 §0 都不存在，应各计一次");
  const rows = w.visiblePlanRows(k);
  assert.equal(rows.length, 3);
  for (const [key] of w.PLAN_COLUMNS) assert.ok(key in rows[0], `少了一列：${key}`);
  assert.equal(rows[0].unitNo, "1");
  assert.equal(rows[0].scene, "港口");
  assert.deepEqual(rows[0].outlineRefs, [ids[0]]);
  assert.deepEqual(rows[1].outlineRefs, [ids[1], ids[2]]);
  assert.deepEqual(rows[2].outlineRefs, [ids[1]], "越界的丢、合法的留");
  assert.equal(w.danglingRefs(k).length, 0, "落进去的引用里不该有悬空的");
});

test("他手填的行先存一版并进回收区（可拿回），不是被抹掉", () => {
  const k = novelWork();
  w.setOutline(k, "一段");
  const mine = w.addPlanRow(k, "T0");
  w.editPlanRow(k, mine.id, "scene", "他手填的场景");
  const res = w.applyPlanProposal(k, PROPOSED, "T1");
  assert.equal(res.ok, true, res.error);
  assert.equal(res.retired, 1);
  assert.ok(res.kept, "旧表没存一版");
  assert.match(res.kept.note, /覆盖前/);
  assert.ok(res.kept.body.includes("他手填的场景"), "存下来的不是他那一版");
  // 屏幕上只剩 AI 的两行；他那一行在回收区，拿得回来
  assert.deepEqual(w.visiblePlanRows(k).map((r) => r.scene), ["港口", "深海"]);
  const hidden = k.plan.rows.filter((r) => r.hidden);
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].id, mine.id);
  assert.equal(w.restorePlanRow(k, mine.id), true, "回收区里的拿不回来");
  assert.equal(w.visiblePlanRows(k).length, 3);
});

test("一行都没有的提案拒绝，不动他的表", () => {
  const k = novelWork();
  const mine = w.addPlanRow(k, "T0");
  for (const rows of [[], null, undefined, "x", [null, 3]]) {
    const r = w.applyPlanProposal(k, rows, "T1");
    assert.equal(r.ok, false, `rows=${JSON.stringify(rows)} 竟然落了`);
  }
  assert.equal(w.visiblePlanRows(k).length, 1);
  assert.equal(w.visiblePlanRows(k)[0].id, mine.id);
});

test("unitNo 是数字也好、字符串也好，进表后都是字符串（表的既有形状）", () => {
  const k = novelWork();
  const r = w.applyPlanProposal(k, [{ ...PROPOSED[0], unitNo: 7 }, { ...PROPOSED[0], unitNo: "8" }], "T");
  assert.equal(r.ok, true);
  assert.deepEqual(w.visiblePlanRows(k).map((x) => x.unitNo), ["7", "8"]);
});

// --- 4. 提案 → action ------------------------------------------------------------ //

test("结构策划的提案翻译成 proposePlanRows；空表拒绝；能力是可应用的", () => {
  const out = skillapply.planApply("structure-planner", { rows: PROPOSED });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.actions.map((a) => a.action), ["proposePlanRows"]);
  assert.equal(out.actions[0].rows.length, 2);
  for (const bad of [{}, { rows: [] }, { rows: "x" }, { rows: [null] }]) {
    assert.equal(skillapply.planApply("structure-planner", bad).ok, false, JSON.stringify(bad));
  }
  const app = skillapply.applicability("structure-planner");
  assert.equal(app.can, true);
  assert.match(app.detail, /回收区/, "按之前要说清旧行去哪了");
});

// --- 5. 真 controller：形态与当前表真的进了提示词 -------------------------------- //

function realController(k) {
  const story = storydoc.createStory(null);
  story.work = k;
  const state = {
    production: { characters: [], relationships: [], world: {}, locations: [], episodes: [], activeEpisodeId: null, blocking: {} },
    story,
    script: scriptdoc.createDoc(null),
    registry: { images: {}, videos: {}, audio: {}, finals: [], firstFrames: {} },
  };
  return createSkillController({
    docs: {
      runs: () => [],
      production: () => state.production, story: () => state.story, script: () => state.script,
      registry: () => state.registry,
      refInterp: () => ({}), timelines: () => ({}), shotAudio: () => ({}), subtitles: () => ({}), generations: () => [],
    },
    catalog: { detail: () => null, problems: () => [] },
    modules: { skills, runtime: { EXECUTOR_BY_ID: new Map() }, skillrun, skillapply, shotctx, proddoc, storydoc, scriptdoc, assetreg, refinterp, timeline, subtitle, mediaref, storywork: w },
    findShot: () => null, slotOf: () => null, isLocked: () => false,
    shotAudio: { resolved: () => [], anchors: () => ({}) },
    shotCtx: { build: () => ({ context: null }), candidates: () => ({ candidates: [] }) },
    draftShots: () => [],
    dispatchAction: () => ({ ok: true }),
    persist: () => {}, refresh: () => {},
    now: () => "2026-09-18T00:00:00Z",
  });
}

test("真 controller：小说项目里 story-development 的提示词带着「作品形态：小说 / 按章」", () => {
  installBuiltinCatalog(skills);
  const k = novelWork({ planned: 12 });
  k.core = "一个想法";
  const ctl = realController(k);
  const prompt = ctl.prompt("story-development");
  // 看的是**数据块**：指令正文里本来就写着「先看作品形态」，那不算证据
  assert.ok(prompt.includes('<数据 键="workForm">'), "workForm 没进提示词");
  assert.match(prompt, /"form": "novel"/);
  assert.match(prompt, /"planned": 12/);
  assert.ok(!skills.findSkill("story-development").instruction.includes("短剧编剧"), "小说项目仍会被当成短剧来发展");
  // 缺形态时那一块不出现 —— 与旧端点的缺省一致
  const bare = realController(w.createWork(null));
  assert.ok(!bare.prompt("story-development").includes('<数据 键="workForm">'), "没选形态却带了一块");
});

test("真 controller：structure-planner 读得到当前结构表（§N），空表时不带那一块", () => {
  installBuiltinCatalog(skills);
  const k = novelWork();
  w.setOutline(k, "一段\n\n两段");
  const ctl = realController(k);
  assert.deepEqual(ctl.missing("structure-planner"), [], "大纲在了却还报缺");
  assert.ok(!ctl.prompt("structure-planner").includes('<数据 键="structurePlan">'), "空表不该出现在提示词里");
  const row = w.addPlanRow(k, "T0");
  w.editPlanRow(k, row.id, "purpose", "出发");
  w.editPlanRow(k, row.id, "outlineRefs", [k.outline.nodes[1].id]);
  const prompt = ctl.prompt("structure-planner");
  assert.ok(prompt.includes('<数据 键="structurePlan">'), "当前表没进提示词");
  assert.match(prompt, /§2/, "引用没解析成 §N");
  assert.match(prompt, /"Scene 目的": "出发"/);
});

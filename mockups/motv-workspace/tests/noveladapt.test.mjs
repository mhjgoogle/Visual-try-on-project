// TASK-155 / REQ-009 判据 5、6：一本小说变成一部剧集 —— 分集提案、确认、进入剧集创作。
//
// 断言的是**行为**：这一片会静默出错的形状是「改编了没写的章」「把小说动了一个字」
// 「集与章对不上位」—— 三种都不报错，只会在他打开剧集创作时才发现。
//
//   1. `novelChaptersForPrompt` —— 只喂已写正文的章；开头截断；带结构规划的目的与结尾。
//   2. `checkChapterRanges` —— 区间连续、不重叠、都是写了的章；错在哪一集说得出。
//   3. `adoptEpisodesFromNovel` —— 切到剧集创作、每集一个单元、Brief 写改编自哪几章；
//      小说单元逐字节不动。
//   4. `storydoc.addPlanVersion` —— 追加一版、旧版保留、`chapters` 过、`episodeId` 一律 null。
//   5. `planApply("novel-adapter")` —— 缺章区间的提案拒绝。
//   6. 真 controller：一章没写 → 必填输入缺；写了 → 提示词带章节；运行 → 提案 → 应用 → 落地。

import test from "node:test";
import assert from "node:assert/strict";

import * as w from "../src/workflow/storywork.js";
import * as sd from "../src/workflow/storydoc.js";
import * as skills from "../src/workflow/skills.js";
import * as skillrun from "../src/workflow/skillrun.js";
import * as skillapply from "../src/workflow/skillapply.js";
import * as shotctx from "../src/workflow/shotctx.js";
import * as proddoc from "../src/workflow/proddoc.js";
import * as scriptdoc from "../src/workflow/scriptdoc.js";
import * as assetreg from "../src/workflow/assetreg.js";
import * as refinterp from "../src/workflow/refinterp.js";
import * as timeline from "../src/workflow/timeline.js";
import * as subtitle from "../src/workflow/subtitle.js";
import * as mediaref from "../src/workflow/mediaref.js";
import { createSkillController } from "../src/controllers/skillctl.js";
import { installBuiltinCatalog } from "./skillcatalog.mjs";

function novelWork({ planned = 6, written = [] } = {}) {
  const k = w.createWork(null);
  w.setForm(k, "novel");
  w.setPlanned(k, "novel", planned);
  for (const [no, body, title] of written) {
    const u = w.ensureUnit(k, "novel", no, "T0");
    w.editUnit(k, u.id, "body", body, "T0");
    if (title) w.editUnit(k, u.id, "title", title, "T0");
  }
  return k;
}

const EPISODES = [
  { epNumber: 1, title: "出港", chapters: { from: 1, to: 2 }, coreGoal: "考古队出发", keyEvents: ["拿到许可", "船出港"], endingBeat: "船出港", hook: "海底有光" },
  { epNumber: 2, title: "接触", chapters: { from: 3, to: 3 }, coreGoal: "第一次听见城市", keyEvents: ["下潜", "城市开口"], endingBeat: "城市开口", hook: "它要什么" },
];

// --- 1. 喂给改编策划的章节 ---------------------------------------------------- //

test("只喂已写正文的章；开头截断；带结构规划里这一章的目的与结尾", () => {
  const k = novelWork({ written: [[1, "第一章正文。".repeat(200), "启程"], [3, "第三章正文"]] });
  w.ensureUnit(k, "novel", 2, "T0"); // 第 2 章空着
  const row = w.addPlanRow(k, "T0");
  w.editPlanRow(k, row.id, "unitNo", "1");
  w.editPlanRow(k, row.id, "purpose", "出发");
  w.editPlanRow(k, row.id, "endingState", "船出港");
  const got = w.novelChaptersForPrompt(k);
  assert.deepEqual(got.map((c) => c.no), [1, 3], "空章不该被喂进去");
  assert.equal(got[0].title, "启程");
  assert.equal(got[0].opening.length, w.CHAPTER_OPENING_CHARS, "开头没截断");
  assert.equal(got[0].words, "第一章正文。".repeat(200).length);
  assert.equal(got[0].purpose, "出发");
  assert.equal(got[0].endingState, "船出港");
  assert.equal(got[1].purpose, "", "没有规划行就是空，不猜");
});

test("不是小说、或一章都没写 → null（必填输入缺，运行前被拒）", () => {
  assert.equal(w.novelChaptersForPrompt(novelWork()), null);
  const ep = w.createWork(null);
  w.setForm(ep, "episode");
  assert.equal(w.novelChaptersForPrompt(ep), null);
  assert.equal(w.novelChaptersForPrompt(null), null);
});

// --- 2. 章区间 ---------------------------------------------------------------- //

test("章区间：连续、不重叠、都是写了的章才过；错在哪一集说得出", () => {
  const k = novelWork({ written: [[1, "一"], [2, "二"], [3, "三"]] });
  assert.equal(w.checkChapterRanges(k, EPISODES), null);
  assert.match(w.checkChapterRanges(k, []), /没有一集/);
  assert.match(w.checkChapterRanges(k, [{ chapters: {} }]), /第 1 集没有说清/);
  assert.match(w.checkChapterRanges(k, [{ chapters: { from: 2, to: 1 } }]), /倒了/);
  assert.match(w.checkChapterRanges(k, [{ chapters: { from: 2, to: 3 } }]), /从第 2 章开始.*上一集到第 0 章/);
  assert.match(
    w.checkChapterRanges(k, [{ chapters: { from: 1, to: 2 } }, { chapters: { from: 2, to: 3 } }]),
    /不重叠/,
  );
  assert.match(w.checkChapterRanges(k, [{ chapters: { from: 1, to: 4 } }]), /还没写正文的第 4 章/);
});

// --- 3. 采纳：切到剧集创作、每集一个单元 ------------------------------------------ //

test("采纳分集：切到剧集创作、Planned 跟上、每集一个带 Brief 的单元；小说逐字节不动", () => {
  const k = novelWork({ written: [[1, "一"], [2, "二"], [3, "三"]] });
  const novelBefore = JSON.stringify(k.units.filter((u) => u.kind === "novel"));
  const res = w.adoptEpisodesFromNovel(k, EPISODES, "T1");
  assert.equal(res.ok, true, res.error);
  assert.equal(k.form, "episode");
  assert.equal(k.planned.episode, 2);
  assert.equal(k.planned.novel, 6, "小说的 Planned 不该被动");
  assert.equal(res.created, 2);
  const eps = k.units.filter((u) => u.kind === "episode").sort((a, b) => a.no - b.no);
  assert.equal(eps.length, 2);
  assert.equal(eps[0].brief, "改编自第 1–2 章：考古队出发");
  assert.equal(eps[1].brief, "改编自第 3 章：第一次听见城市");
  assert.equal(eps[0].title, "出港");
  assert.equal(JSON.stringify(k.units.filter((u) => u.kind === "novel")), novelBefore, "小说被动了");
});

test("已有的剧集单元只补空 Brief，不覆盖他写的", () => {
  const k = novelWork({ written: [[1, "一"], [2, "二"], [3, "三"]] });
  const mine = w.ensureUnit(k, "episode", 1, "T0");
  w.editUnit(k, mine.id, "brief", "他自己写的 Brief", "T0");
  w.editUnit(k, mine.id, "body", "他自己写的剧本", "T0");
  const res = w.adoptEpisodesFromNovel(k, EPISODES, "T1");
  assert.equal(res.ok, true);
  assert.equal(res.created, 1);
  assert.equal(k.units.find((u) => u.id === mine.id).brief, "他自己写的 Brief");
  assert.equal(k.units.find((u) => u.id === mine.id).body, "他自己写的剧本");
});

test("空提案不采纳，形态不动", () => {
  const k = novelWork({ written: [[1, "一"]] });
  assert.equal(w.adoptEpisodesFromNovel(k, [], "T").ok, false);
  assert.equal(w.adoptEpisodesFromNovel(k, null, "T").ok, false);
  assert.equal(k.form, "novel");
});

// --- 4. 规划追加一版 ------------------------------------------------------------ //

test("addPlanVersion：追加一版、旧版保留、chapters 过、episodeId 一律 null", () => {
  const doc = sd.createStory(null);
  doc.plans.push({ id: "plan-old", v: 1, episodes: [{ epNumber: 1, title: "旧的", episodeId: "ep-x" }], origin: "proposed" });
  const rec = sd.addPlanVersion(doc, [{ ...EPISODES[1], epNumber: 9, episodeId: "smuggled" }, EPISODES[0]], { origin: "adapted", instruction: "由小说改编" });
  assert.equal(rec.v, 2);
  assert.equal(rec.origin, "adapted");
  assert.equal(doc.activePlan, 2);
  assert.equal(doc.plans.length, 2, "旧版没保留");
  assert.deepEqual(rec.episodes.map((e) => e.epNumber), [1, 2], "集号要按存活者重排");
  assert.deepEqual(rec.episodes.map((e) => e.episodeId), [null, null], "答案里夹带的 episodeId 不许过（ADR-0072）");
  assert.deepEqual(rec.episodes[0].chapters, { from: 3, to: 3 }, "chapters 没跟着条目走");
  assert.ok(!("claimedEpNumber" in rec.episodes[0]), "瞬时字段不该进版本");
  assert.equal(sd.addPlanVersion(doc, [{ chapters: { from: 1, to: 1 } }]), null, "没标题的条目一条都不剩时不该追加空版");
  assert.equal(doc.plans.length, 2);
});

// --- 5. 提案 → action ------------------------------------------------------------ //

test("改编提案翻译成 adaptNovelToEpisodes；缺章区间 / 空提案拒绝；能力可应用", () => {
  const out = skillapply.planApply("novel-adapter", { episodes: EPISODES });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.actions.map((a) => a.action), ["adaptNovelToEpisodes"]);
  assert.equal(out.actions[0].episodes.length, 2);
  assert.equal(skillapply.planApply("novel-adapter", { episodes: [] }).ok, false);
  const missing = skillapply.planApply("novel-adapter", { episodes: [{ ...EPISODES[0], chapters: null }] });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /第 1 集没有说清/);
  const app = skillapply.applicability("novel-adapter");
  assert.equal(app.can, true);
  assert.match(app.detail, /一字不动/, "按之前要说清小说不会被动");
});

// --- 6. 真 controller ------------------------------------------------------------ //

function realController(k, { answer = null, said = [] } = {}) {
  const story = sd.createStory(null);
  story.work = k;
  const state = {
    production: { characters: [], relationships: [], world: {}, locations: [], episodes: [], activeEpisodeId: null, blocking: {} },
    story,
    script: scriptdoc.createDoc(null),
    registry: { images: {}, videos: {}, audio: {}, finals: [], firstFrames: {} },
  };
  const runs = [];
  const ctl = createSkillController({
    docs: {
      runs: () => runs,
      production: () => state.production, story: () => state.story, script: () => state.script,
      registry: () => state.registry,
      refInterp: () => ({}), timelines: () => ({}), shotAudio: () => ({}), subtitles: () => ({}), generations: () => [],
    },
    catalog: { detail: () => null, problems: () => [] },
    modules: {
      skills, skillrun, skillapply, shotctx, proddoc, storydoc: sd, scriptdoc, assetreg, refinterp, timeline, subtitle, mediaref,
      storywork: w,
      runtime: {
        EXECUTOR_BY_ID: new Map([["claude-code", { id: "claude-code", runtime: "local_subscription" }]]),
        runOnExecutor: async () => ({ ok: true, text: JSON.stringify(answer), model: "fake" }),
      },
    },
    findShot: () => null, slotOf: () => null, isLocked: () => false,
    shotAudio: { resolved: () => [], anchors: () => ({}) },
    shotCtx: { build: () => ({ context: null }), candidates: () => ({ candidates: [] }) },
    draftShots: () => [],
    // `app.js` 那个 handler 的三步里，这里做 storywork / storydoc 那两步（建剧集实体的
    // `confirmPlan` 需要整个外壳，不在这里）。
    dispatchAction: (act) => {
      if (act.action !== "adaptNovelToEpisodes") return { ok: false, error: `没接线：${act.action}` };
      const bad = w.checkChapterRanges(k, act.episodes);
      if (bad) return { ok: false, error: bad };
      const rec = sd.addPlanVersion(story, act.episodes, { origin: "adapted" });
      const adopted = w.adoptEpisodesFromNovel(k, rec.episodes, "T1");
      const detail = `已确认剧集规划 v${rec.v}：${rec.episodes.length} 集；${adopted.created} 个新单元`;
      said.push(detail);
      return { ok: true, detail };
    },
    persist: () => {}, refresh: () => {},
    now: () => "2026-09-18T00:00:00Z",
  });
  return { ctl, story };
}

test("真 controller：一章都没写时改编策划的必填输入缺；写了之后提示词带着章节", () => {
  installBuiltinCatalog(skills);
  const empty = realController(novelWork());
  assert.ok(empty.ctl.missing("novel-adapter").includes("novelChapters"), "没写正文却能起跑");
  const k = novelWork({ written: [[1, "第一章正文", "启程"], [2, "第二章正文"]] });
  const { ctl } = realController(k);
  assert.deepEqual(ctl.missing("novel-adapter"), []);
  const prompt = ctl.prompt("novel-adapter");
  assert.ok(prompt.includes('<数据 键="novelChapters">'), "章节没进提示词");
  assert.match(prompt, /"title": "启程"/);
  assert.match(prompt, /"form": "novel"/, "形态没跟着进去");
});

test("真 controller：运行 → 提案 → 应用：规划追加一版、正文创作切到剧集、小说逐字节不动", async () => {
  installBuiltinCatalog(skills);
  const k = novelWork({ written: [[1, "一"], [2, "二"], [3, "三"]] });
  const novelBefore = JSON.stringify(k.units.filter((u) => u.kind === "novel"));
  const said = [];
  const { ctl, story } = realController(k, { answer: { episodes: EPISODES }, said });
  const run = await ctl.run("novel-adapter", { executor: "claude-code" });
  assert.equal(run.ok, true, run.error);
  const applied = ctl.applyProposal(run.run.runId);
  assert.equal(applied.ok, true, applied.error);
  assert.equal(said.length, 1);
  assert.match(applied.detail, /已确认剧集规划 v1：2 集/, "回执里没有 handler 那一句");
  assert.equal(story.plans.length, 1);
  assert.deepEqual(story.plans[0].episodes.map((e) => e.chapters), [{ from: 1, to: 2 }, { from: 3, to: 3 }]);
  assert.equal(k.form, "episode");
  assert.equal(k.units.filter((u) => u.kind === "episode").length, 2);
  assert.equal(JSON.stringify(k.units.filter((u) => u.kind === "novel")), novelBefore, "小说被动了");
  assert.ok(skillrun.isAccepted(skillrun.findRun(ctl.runs(), run.run.runId)));
});

test("真 controller：引用了没写的章的提案落不下去，一处都不动", async () => {
  installBuiltinCatalog(skills);
  const k = novelWork({ written: [[1, "一"]] });
  const { ctl, story } = realController(k, { answer: { episodes: EPISODES } });
  const run = await ctl.run("novel-adapter", { executor: "claude-code" });
  assert.equal(run.ok, true, run.error);
  const applied = ctl.applyProposal(run.run.runId);
  assert.equal(applied.ok, false);
  assert.match(applied.error, /还没写正文的第 2 章/);
  assert.equal(story.plans.length, 0);
  assert.equal(k.form, "novel");
});

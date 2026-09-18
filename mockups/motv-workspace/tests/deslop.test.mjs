// TASK-157 / REQ-010：去 AI 味那一步在前端的三件事 —— 读得到正文、翻译成写回、落回原处。
//
// 断言的是**行为**。这一片会静默出错的形状只有一个，但它很贵：
// **去味后的正文落进了别的章**（他在生成与应用之间翻了一页），或者**把原稿盖掉却没留下
// 退路**。TASK-146 轮 2/3/4 为同一个类买过三轮，这里把新能力接进同一条既有路径，
// 所以也必须证明它真的走在那条路上。

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

const SLOPPY = "她把手收回来，攥成拳，再松开，掌心是潮的。像已经在这个温度里待了很多年。";
const DESLOPPED = "她收回手。掌心是潮的，她在裤子上擦了两下，没擦干。";

function novelWork({ planned = 6, written = [] } = {}) {
  const k = w.createWork(null);
  w.setForm(k, "novel");
  w.setPlanned(k, "novel", planned);
  for (const [no, body] of written) {
    const u = w.ensureUnit(k, "novel", no, "T0");
    w.editUnit(k, u.id, "body", body, "T0");
  }
  return k;
}

// --- 1. 读得到这一章写了什么 ---------------------------------------------------- //

test("chapterTextOf：拿到那一章此刻的正文；没写过就是 null（必填缺，运行前被拒）", () => {
  const k = novelWork({ written: [[2, SLOPPY]] });
  assert.deepEqual(w.chapterTextOf(k, 2), { no: 2, title: "", text: SLOPPY });
  assert.equal(w.chapterTextOf(k, 3), null, "没写过的章不该冒出一个空壳");
  w.ensureUnit(k, "novel", 4, "T0");
  assert.equal(w.chapterTextOf(k, 4), null, "建出来但没写的章也算没有");
  assert.equal(w.chapterTextOf(k, null), null);
  assert.equal(w.chapterTextOf(k, 0), null);
});

test("chapterTextOf：不是小说就没有这回事", () => {
  const ep = w.createWork(null);
  w.setForm(ep, "episode");
  const u = w.ensureUnit(ep, "episode", 1, "T0");
  w.editUnit(ep, u.id, "body", "第一集的剧本", "T0");
  assert.equal(w.chapterTextOf(ep, 1), null);
  assert.equal(w.chapterTextOf(null, 1), null);
});

// --- 2. 提案 → action ----------------------------------------------------------- //

test("去味提案翻译成 proposeScript，并带上那次运行记下的章号与形态", () => {
  const out = skillapply.planApply(
    "novel-style-editor",
    { chapter: DESLOPPED, changes: [{ was: SLOPPY, now: DESLOPPED, why: "三短句排比" }] },
    { unitNo: 2 },
  );
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.actions.map((a) => a.action), ["proposeScript"]);
  assert.equal(out.actions[0].unitNo, 2, "提案没带上它是为第几章改的");
  assert.equal(out.actions[0].form, "novel");
  assert.equal(out.actions[0].text, DESLOPPED);
  // `changes` 是给他看的说明，不是要写进作品的内容 —— 不该出现在 action 里
  assert.ok(!("changes" in out.actions[0]));
});

test("没有正文的提案被拒 —— 一份只有说明的答案不能落地", () => {
  for (const bad of [{}, { chapter: "" }, { chapter: "   " }, { changes: [] }]) {
    const out = skillapply.planApply("novel-style-editor", bad, { unitNo: 2 });
    assert.equal(out.ok, false, JSON.stringify(bad));
  }
});

test("它是可应用的能力，且按之前说清正文写回哪儿、退不退得回", () => {
  const app = skillapply.applicability("novel-style-editor");
  assert.equal(app.can, true);
  assert.match(app.detail, /存成历史|退回/);
});

// --- 3. 真 controller：读 → 跑 → 应用 → 落回原处、原稿留着 ------------------------ //

function realController(k, { answer = null } = {}) {
  const story = storydoc.createStory(null);
  story.work = k;
  const runs = [];
  const state = {
    production: proddoc.createProduction(null),
    script: scriptdoc.createDoc(null),
    registry: { images: {}, videos: {}, audio: {}, finals: [], firstFrames: {} },
  };
  const ctl = createSkillController({
    docs: {
      runs: () => runs,
      production: () => state.production,
      story: () => story,
      script: () => state.script,
      registry: () => state.registry,
      refInterp: () => ({}), timelines: () => ({}), shotAudio: () => ({}), subtitles: () => ({}),
      generations: () => [],
    },
    catalog: { detail: () => null, problems: () => [] },
    modules: {
      skills, skillrun, skillapply, shotctx, proddoc, storydoc, scriptdoc, assetreg, refinterp,
      timeline, subtitle, mediaref, storywork: w,
      runtime: {
        EXECUTOR_BY_ID: new Map([["claude-code", { id: "claude-code", runtime: "local_subscription" }]]),
        runOnExecutor: async () => ({ ok: true, text: JSON.stringify(answer), model: "fake" }),
      },
    },
    findShot: () => null, slotOf: () => null, isLocked: () => false,
    shotAudio: { resolved: () => [], anchors: () => ({}) },
    shotCtx: { build: () => ({ context: null }), candidates: () => ({ candidates: [] }) },
    draftShots: () => [],
    // `app.js` 的 `proposeScript` handler 做的事
    dispatchAction: (act) => {
      if (act.action !== "proposeScript") return { ok: false, error: `没接线：${act.action}` };
      const r = w.applyBodyProposal(k, { boundForm: act.form, boundUnitNo: act.unitNo }, act.text, "T1");
      return r.ok ? { ok: true, detail: `已写进第 ${r.no} ${r.word}正文` } : { ok: false, error: r.error };
    },
    persist: () => {}, refresh: () => {},
    now: () => "2026-09-18T00:00:00Z",
  });
  return { ctl, runs };
}

test("真 controller：那一章没有正文时必填输入就缺 —— 不会改出一章新的", () => {
  installBuiltinCatalog(skills);
  const { ctl } = realController(novelWork());
  assert.ok(ctl.missing("novel-style-editor", {}, { unitNo: 2 }).includes("chapterText"));
});

test("真 controller：读得到正文 → 提示词带着它，且这一轮记下了是第几章", async () => {
  installBuiltinCatalog(skills);
  const k = novelWork({ written: [[2, SLOPPY]] });
  const { ctl, runs } = realController(k, {
    answer: { chapter: DESLOPPED, changes: [{ was: SLOPPY, now: DESLOPPED, why: "三短句排比" }] },
  });
  const scope = { unitNo: 2 };
  assert.deepEqual(ctl.missing("novel-style-editor", {}, scope), []);
  const prompt = ctl.prompt("novel-style-editor", {}, scope);
  assert.ok(prompt.includes('<数据 键="chapterText">'), "正文没进提示词");
  assert.match(prompt, /攥成拳/);

  const run = await ctl.run("novel-style-editor", { executor: "claude-code", scope });
  assert.equal(run.ok, true, run.error);
  assert.equal(runs[0].context.unitNo, 2, "这一轮没记下是为第几章跑的 —— 应用时就只能看屏幕了");

  const applied = ctl.applyProposal(run.run.runId);
  assert.equal(applied.ok, true, applied.error);
  const unit = k.units.find((u) => u.no === 2);
  assert.equal(unit.body, DESLOPPED, "去味后的正文没落回那一章");
  // 判据 3：原稿先存一版，退得回去
  const kept = w.visibleVersions(unit.finalized);
  assert.equal(kept.length, 1, "原稿没被存下来");
  assert.equal(kept[0].body, SLOPPY);
  assert.equal(w.restoreFinalized(k, unit.id, kept[0].v, "T9"), true);
  assert.equal(k.units.find((u) => u.no === 2).body, SLOPPY, "退不回原稿");
});

test("真 controller：生成之后他翻到别的章，去味稿仍然落回原来那一章", async () => {
  installBuiltinCatalog(skills);
  const k = novelWork({ written: [[2, SLOPPY], [6, "第六章原有的正文"]] });
  const { ctl } = realController(k, {
    answer: { chapter: DESLOPPED, changes: [{ was: SLOPPY, now: DESLOPPED, why: "明喻过密" }] },
  });
  const run = await ctl.run("novel-style-editor", { executor: "claude-code", scope: { unitNo: 2 } });
  assert.equal(run.ok, true, run.error);
  // 屏幕上翻到了第 6 章：`applyProposal` 的 scope 给成 6，但 run 记的是 2
  const applied = ctl.applyProposal(run.run.runId, { unitNo: 6 });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(k.units.find((u) => u.no === 2).body, DESLOPPED);
  assert.equal(k.units.find((u) => u.no === 6).body, "第六章原有的正文", "落进了他正开着的那一章");
});

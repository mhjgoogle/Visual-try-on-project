// 故事大纲的八项落到文档里（TASK-094 批次 C / TASK-089 §2.1–2.2）。
//
// 两条不变量：
//   1. 八项的结构被 SANITIZE，不是原样收下 —— 它们来自模型答案并落进 canvas.json；
//   2. 清单外的四个字段一个都没被静默删掉，旧格式的大纲照样能读能存。
import test from "node:test";
import assert from "node:assert/strict";

import * as st from "../src/workflow/storydoc.js";
import { migrateToCurrent } from "../src/services/canvasschema.js";

const EIGHT = {
  storyCore: "被世界抹除的人并没有消失",
  protagonist: { who: "林照", initialWant: "回到原世界" },
  conflict: { external: "源律只禁止成功", internal: "她不肯认错" },
  worldAndRules: { where: "终局世界", rules: ["抹除不等于死亡", "  ", "成功者被外推"] },
  keyRelationships: [
    { between: ["林照", "许渡"], nature: "交易", howItChanges: "从买路到同伴" },
  ],
  mainline: {
    setup: "a", development: "b", midpointTurn: "c", climax: "d", ending: "e",
  },
  secretsAndReveals: [
    { truth: "校准官也被抹除过", whyNotUpfront: "他是唯一的路", revealAround: "第 8 集" },
  ],
  themeAndChange: { theme: "如何证明自己存在", protagonistBecomes: "留下路的人" },
  episodeCount: 24,
  durationNote: "60-90 秒",
  genreTone: "冷峻科幻",
};

test("the eight items survive sanitize with their structure intact", () => {
  const o = st.sanitizeOutline(EIGHT);
  assert.equal(o.storyCore, "被世界抹除的人并没有消失");
  assert.deepEqual(o.protagonist, { who: "林照", initialWant: "回到原世界" });
  assert.deepEqual(o.conflict, { external: "源律只禁止成功", internal: "她不肯认错" });
  assert.deepEqual(o.worldAndRules, {
    where: "终局世界",
    rules: ["抹除不等于死亡", "成功者被外推"], // the blank one is dropped
  });
  assert.deepEqual(o.mainline, {
    setup: "a", development: "b", midpointTurn: "c", climax: "d", ending: "e",
  });
  assert.deepEqual(o.themeAndChange, { theme: "如何证明自己存在", protagonistBecomes: "留下路的人" });
  assert.equal(o.keyRelationships.length, 1);
  assert.equal(o.secretsAndReveals[0].revealAround, "第 8 集");
});

test("a model answer cannot smuggle a nested structure into the document", () => {
  const o = st.sanitizeOutline({
    storyCore: { $ref: "evil" },
    protagonist: "不是对象",
    conflict: { external: ["nested"], internal: null },
    worldAndRules: { where: 7, rules: "不是列表" },
    keyRelationships: [{ between: ["只有一个"], nature: "x" }, "不是对象", { between: ["a", "b"] }],
    secretsAndReveals: [{ whyNotUpfront: "没有 truth" }, { truth: "  " }],
    mainline: ["不是对象"],
  });
  assert.equal(o.storyCore, "", "非字符串的核心句被规范成空，而不是把对象存进文档");
  assert.deepEqual(o.protagonist, { who: "", initialWant: "" });
  assert.deepEqual(o.conflict, { external: "", internal: "" });
  assert.deepEqual(o.worldAndRules, { where: "", rules: [] });
  assert.deepEqual(o.keyRelationships, [], "缺一个名字的关系行说不出任何事，丢掉");
  assert.deepEqual(o.secretsAndReveals, []);
  assert.deepEqual(o.mainline, {
    setup: "", development: "", midpointTurn: "", climax: "", ending: "",
  });
});

test("the four off-list fields are still readable, and premise still shows", () => {
  // TASK-089 §2.2：premise 合并进 storyCore，但**保留旧字段读取**
  const o = st.sanitizeOutline({ premise: "旧的前提", logline: "旧的主线" });
  assert.equal(o.premise, "旧的前提", "正在被 app.js 的剧本 brief 读取，不得删");
  assert.equal(o.logline, "旧的主线");
  assert.equal(st.storyCoreOf(o), "旧的主线", "没有 storyCore 时退回 logline");
  assert.equal(st.storyCoreOf({ premise: "只有前提" }), "只有前提");
  assert.equal(st.storyCoreOf({ storyCore: "新的核心", logline: "旧的" }), "新的核心",
    "有新字段时优先它");
  // …and the three that stay because something downstream reads them
  const keep = st.sanitizeOutline({ episodeCount: 24, durationNote: "90 秒", genreTone: "冷峻" });
  assert.equal(keep.episodeCount, 24);
  assert.equal(keep.durationNote, "90 秒");
  assert.equal(keep.genreTone, "冷峻");
});

test("an outline written in the OLD shape still hydrates and still validates", () => {
  // this is the shape all four outline versions of 照见未明rev2 are written in
  const doc = st.createStory({
    idea: "i",
    versions: [{
      id: "so-1", v: 1, origin: "developed", instruction: "", basedOn: null,
      outline: {
        premise: "p", logline: "l", genreTone: "t", world: "w", centralConflict: "c",
        storyArc: "a", climax: "x", ending: "e", durationNote: "d",
        characterConcepts: ["林照：核验员"], episodeCount: 24,
      },
    }],
    active: 1, approved: 1, plans: [], activePlan: 0, confirmedPlan: 0,
  });
  assert.equal(doc.versions.length, 1);
  assert.equal(doc.versions[0].outline.premise, "p");
  // the new items hydrate as EMPTY structures, never as invented content
  assert.deepEqual(doc.versions[0].outline.protagonist, { who: "", initialWant: "" });
  assert.deepEqual(doc.versions[0].outline.keyRelationships, []);
  assert.equal(doc.versions[0].outline.storyCore, "");
});

test("the document validates with the eight items, and rejects a malformed one", () => {
  const base = migrateToCurrent({ v: 1, nodes: [], edges: [] }).doc;
  const withOutline = (outline) => {
    const d = structuredClone(base);
    d.story.versions = [{
      id: "so-1", v: 1, outline: st.sanitizeOutline(outline),
      origin: "developed", instruction: "", basedOn: null,
    }];
    d.story.active = 1;
    return d;
  };
  assert.equal(migrateToCurrent(withOutline(EIGHT)).status, "ok");
  // …and an outline written before the eight existed is still a valid document
  assert.equal(migrateToCurrent(withOutline({ premise: "p", logline: "l" })).status, "ok");

  // present-but-wrong rejects the WHOLE document (the additive-field rule):
  // hydration would coerce these, so accepting them loses outline content
  for (const [i, mutate] of [
    (o) => (o.storyCore = 7),
    (o) => (o.protagonist = "不是对象"),
    (o) => (o.conflict.external = ["x"]),
    (o) => (o.worldAndRules.rules = "不是列表"),
    (o) => (o.worldAndRules.rules = ["ok", "  "]),
    (o) => (o.mainline.midpointTurn = 7),
    (o) => (o.keyRelationships[0].between = ["只有一个"]),
    (o) => (o.keyRelationships[0].nature = ""),
    (o) => (o.secretsAndReveals[0].truth = ""),
    (o) => (o.secretsAndReveals[0].revealAround = 7),
  ].entries()) {
    const d = withOutline(EIGHT);
    mutate(d.story.versions[0].outline);
    assert.equal(migrateToCurrent(d).status, "invalid", `case ${i}`);
  }
});

test("a manual outline edit MERGES over the active version, keeping the eight", () => {
  const doc = st.createStory(null);
  doc.idea = "i";
  const id = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, id, EIGHT);
  st.applyProposal(doc);
  // the editor writes one field; everything else must survive
  const rec = st.applyManualOutline(doc, { storyCore: "改过的核心句" });
  assert.equal(rec.outline.storyCore, "改过的核心句");
  assert.deepEqual(rec.outline.mainline, doc.versions[0].outline.mainline);
  assert.equal(rec.outline.keyRelationships.length, 1);
  assert.equal(doc.versions[0].outline.storyCore, "被世界抹除的人并没有消失", "旧版本不变");
});

// 故事大纲界面 = 审阅面（TASK-094 批次 D / TASK-089 §2.3）。
//
// AI 写了的正常显示、可编辑；没写的一行说明，不摆成待填的格子。旧字段（真实项目
// 四版大纲写在里面的那些）显示在新字段的位置上并标明是旧的。
import test from "node:test";
import assert from "node:assert/strict";

import { renderStoryWs, applyBuffer, patchFromBuffer } from "../src/ui/storyws.js";
import * as st from "../src/workflow/storydoc.js";

const EIGHT = {
  storyCore: "被世界抹除的人并没有消失",
  protagonist: { who: "林照", initialWant: "回到原世界" },
  conflict: { external: "源律只禁止成功", internal: "她不肯认错" },
  worldAndRules: { where: "终局世界", rules: ["抹除不等于死亡", "成功者被外推"] },
  keyRelationships: [
    { between: ["林照", "许渡"], nature: "交易关系", howItChanges: "从买路变成同伴" },
  ],
  mainline: {
    setup: "她救下不可被救的人", development: "她找路", midpointTurn: "校准官也被抹除过",
    climax: "她自愿成为证据", ending: "第二套稳定答案",
  },
  secretsAndReveals: [
    { truth: "校准官也被抹除过", whyNotUpfront: "他是唯一的路", revealAround: "第 8 集前后" },
  ],
  themeAndChange: { theme: "如何证明自己存在", protagonistBecomes: "留下路的人" },
  episodeCount: 24,
  genreTone: "冷峻科幻",
  durationNote: "60-90 秒",
};

/** A story doc holding one applied outline version. */
function docWith(outline) {
  const doc = st.createStory(null);
  doc.idea = "被世界抹除的人，并没有消失。";
  const id = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, id, outline);
  st.applyProposal(doc);
  return doc;
}

function render(doc, ui = {}) {
  return renderStoryWs(
    {
      story: {
        doc: () => doc,
        activeBrief: () => st.activeBrief(doc),
      },
      toast: () => {},
    },
    { dirOpen: {}, ...ui },
  );
}

test("all eight items are on the surface, in the product owner's order", () => {
  const html = render(docWith(EIGHT));
  const order = [
    "故事核心", "主角与目标", "核心冲突", "世界与核心规则",
    "主要角色关系", "故事主线", "核心秘密 / 信息揭示顺序", "主题与最终变化",
  ];
  let at = -1;
  for (const title of order) {
    const i = html.indexOf(title);
    assert.ok(i > at, `${title} 不在它应该出现的位置（顺序本身是信息）`);
    at = i;
  }
});

test("what AI wrote is shown — including every part of the structured items", () => {
  const html = render(docWith(EIGHT));
  for (const text of [
    "被世界抹除的人并没有消失",
    "林照", "回到原世界",
    "源律只禁止成功", "她不肯认错",       // 外部 / 内部分开显示
    "终局世界", "抹除不等于死亡",          // where + rules 列表
    "交易关系", "从买路变成同伴",
    "她救下不可被救的人", "校准官也被抹除过", "第二套稳定答案",  // 主线五段
    "第 8 集前后",                        // 揭示时机
    "如何证明自己存在", "留下路的人",
  ]) {
    assert.ok(html.includes(text), `界面上看不到「${text}」`);
  }
});

test("the five mainline segments are LABELLED in order, not merged into prose", () => {
  const html = render(docWith(EIGHT));
  let at = html.indexOf("故事主线");
  for (const label of ["开端", "发展", "中段重大转折", "高潮", "结局"]) {
    const i = html.indexOf(label, at);
    assert.ok(i > at, `主线缺少「${label}」这一段`);
    at = i;
  }
});

test("an item the AI did not write says so — it is not a box to fill in", () => {
  const html = render(docWith({ storyCore: "只有一句核心" }));
  assert.ok(html.includes("AI 没有写这一项"));
  // …and no editable control is drawn for it while merely READING
  assert.doesNotMatch(html, /data-so-path="conflict\.external"/);
});

test("the LEGACY fields of the real project are shown where their replacement goes", () => {
  // 照见未明rev2 的四版大纲全写在这些字段里
  const html = render(docWith({
    premise: "校准员林照救下被判定不可被救的人",
    logline: "每一次校准都是一次赌命",
    centralConflict: "求生欲 VS 源律",
    storyArc: "被抹除 → 找路 → 自愿成为证据",
    climax: "她自愿成为证据",
    ending: "第二套稳定答案",
    world: "「存在」终局世界",
  }));
  assert.ok(html.includes("每一次校准都是一次赌命"), "没有 storyCore 时退回 logline 显示");
  assert.ok(html.includes("校准员林照救下被判定不可被救的人"));
  assert.ok(html.includes("求生欲 VS 源律"));
  assert.ok(html.includes("被抹除 → 找路 → 自愿成为证据"));
  assert.ok(html.includes("「存在」终局世界"));
  for (const label of ["旧字段 · 前提", "旧字段 · 核心冲突", "旧字段 · 故事弧", "旧字段 · 世界观概述"]) {
    assert.ok(html.includes(label), `旧内容必须标明它是旧字段：${label}`);
  }
  // …but NEVER the same paragraph twice: 故事核心 is falling back to `logline` here,
  // so it must not also appear below as 「旧字段 · 主线」 (seen on 照见未明rev2)
  assert.ok(!html.includes("旧字段 · 主线"), "被当作故事核心显示的那个旧字段不再重复一遍");
  assert.equal(html.split("每一次校准都是一次赌命").length - 1, 1, "同一段文字只出现一次");
});

test("a legacy field NOT being used as the fallback still shows", () => {
  // only `premise` exists → it becomes the headline, and there is nothing else
  const onlyPremise = render(docWith({ premise: "只有前提" }));
  assert.ok(onlyPremise.includes("只有前提"));
  assert.equal(onlyPremise.split("只有前提").length - 1, 1);

  // both exist → `logline` is the headline, `premise` is still listed as legacy
  const both = render(docWith({ premise: "前提这一句", logline: "主线这一句" }));
  assert.ok(both.includes("主线这一句"));
  assert.ok(both.includes("前提这一句"));
  assert.ok(both.includes("旧字段 · 前提"));
  assert.ok(!both.includes("旧字段 · 主线"));
});

test("editing draws controls for every part, and only while editing", () => {
  const doc = docWith(EIGHT);
  const read = render(doc);
  assert.doesNotMatch(read, /data-so-path/, "读的时候不摆输入框");
  assert.match(read, /data-st-editon/);

  const edit = render(doc, { storyEdit: true });
  for (const path of [
    "storyCore", "protagonist.who", "protagonist.initialWant",
    "conflict.external", "conflict.internal",
    "worldAndRules.where", "worldAndRules.rules.0",
    "keyRelationships.0.nature", "keyRelationships.0.howItChanges",
    "mainline.setup", "mainline.midpointTurn", "mainline.ending",
    "secretsAndReveals.0.truth", "secretsAndReveals.0.revealAround",
    "themeAndChange.theme", "themeAndChange.protagonistBecomes",
  ]) {
    assert.match(edit, new RegExp(`data-so-path="${path.replace(/\./g, "\\.")}"`), `缺少 ${path} 的控件`);
  }
  assert.match(edit, /data-st-save/);
  assert.match(edit, /正在编辑 · 还没有保存/);
});

test("the buffer addresses nested items by path — a flat one could not", () => {
  const edited = applyBuffer(EIGHT, {
    "conflict.external": "改过的外部冲突",
    "worldAndRules.rules.1": "改过的第二条规则",
    "keyRelationships.0.howItChanges": "改过的走向",
    "secretsAndReveals.0.revealAround": "第 5 集",
    storyCore: "改过的核心句",
  });
  assert.equal(edited.conflict.external, "改过的外部冲突");
  assert.equal(edited.conflict.internal, "她不肯认错", "同一项里没被改的部分原样保留");
  assert.deepEqual(edited.worldAndRules.rules, ["抹除不等于死亡", "改过的第二条规则"]);
  assert.equal(edited.keyRelationships[0].howItChanges, "改过的走向");
  assert.equal(edited.keyRelationships[0].nature, "交易关系");
  assert.equal(edited.secretsAndReveals[0].revealAround, "第 5 集");
  assert.equal(edited.storyCore, "改过的核心句");
  // …and the base object is untouched
  assert.equal(EIGHT.conflict.external, "源律只禁止成功");
});

test("the two names of a relationship are editable, not a static chip", () => {
  // codex review, 批次 D round 1 (BLOCKING): a capability that named the wrong pair
  // was uncorrectable.
  const edit = render(docWith(EIGHT), { storyEdit: true });
  assert.match(edit, /data-so-path="keyRelationships\.0\.between\.0"/);
  assert.match(edit, /data-so-path="keyRelationships\.0\.between\.1"/);
  const edited = applyBuffer(EIGHT, { "keyRelationships.0.between.1": "沈既白" });
  assert.deepEqual(edited.keyRelationships[0].between, ["林照", "沈既白"]);
  assert.equal(edited.keyRelationships[0].nature, "交易关系", "同一行其它字段不动");
  assert.deepEqual(EIGHT.keyRelationships[0].between, ["林照", "许渡"], "基对象不被改");
});

test("while EDITING, every stored legacy field is reachable — including the fallback", () => {
  // codex review, 批次 D round 1 (BLOCKING): reading dedupes the field that is
  // standing in as 故事核心; editing must not, or that content can be neither
  // changed nor cleared (the headline control is bound to an EMPTY `storyCore`).
  const doc = docWith({ logline: "旧的主线这一句", premise: "旧的前提这一句" });
  const read = render(doc);
  assert.ok(!read.includes("旧字段 · 主线"), "读的时候不重复");

  const edit = render(doc, { storyEdit: true });
  assert.ok(edit.includes("旧字段 · 主线"), "编辑时它必须出现，否则改不了也删不掉");
  assert.match(edit, /data-so-path="logline"/);
  assert.match(edit, /data-so-path="premise"/);
  assert.match(edit, /data-so-path="storyCore"/);
  // …and clearing it is a real edit that saves
  const patch = patchFromBuffer(doc.versions[0].outline, { logline: "" });
  assert.equal(st.applyManualOutline(doc, patch).outline.logline, "");
});

test("a stale index never GROWS a list", () => {
  // a render that still shows a row another action removed must not recreate it
  const edited = applyBuffer(EIGHT, {
    "worldAndRules.rules.9": "凭空多出来的规则",
    "keyRelationships.3.nature": "凭空多出来的关系",
    "keyRelationships.0.between.7": "凭空多出来的第三个人",
  });
  assert.equal(edited.worldAndRules.rules.length, 2);
  assert.equal(edited.keyRelationships.length, 1);
  assert.equal(edited.keyRelationships[0].between.length, 2);
});

test("an item MISSING from a legacy document is still editable", () => {
  // an outline written before the eight items existed has no `conflict` at all;
  // the walker builds the object rather than dropping the edit
  const edited = applyBuffer({ premise: "p" }, {
    "conflict.external": "新写的外部冲突",
    "mainline.setup": "新写的开端",
  });
  assert.equal(edited.conflict.external, "新写的外部冲突");
  assert.equal(edited.mainline.setup, "新写的开端");
  assert.equal(edited.premise, "p");
  // …but a numeric segment with no array behind it addresses nothing
  assert.deepEqual(applyBuffer({ premise: "p" }, { "keyRelationships.0.nature": "x" }), { premise: "p" });
});

test("the save patch carries WHOLE items, because the merge is shallow", () => {
  // `applyManualOutline` does `{...base.outline, ...fields}` — handing it a dotted
  // key would store that literal key and leave `conflict` untouched
  const patch = patchFromBuffer(EIGHT, {
    "conflict.external": "改过的外部冲突",
    "mainline.ending": "改过的结局",
  });
  assert.deepEqual(Object.keys(patch).sort(), ["conflict", "mainline"]);
  assert.deepEqual(patch.conflict, { external: "改过的外部冲突", internal: "她不肯认错" });
  assert.equal(patch.mainline.setup, "她救下不可被救的人", "同一项里未改的四段跟着一起带上");
  assert.equal(patch.mainline.ending, "改过的结局");
});

test("saving that patch produces a NEW version and keeps the old one", () => {
  const doc = docWith(EIGHT);
  const patch = patchFromBuffer(doc.versions[0].outline, { "conflict.internal": "改过的内部冲突" });
  const rec = st.applyManualOutline(doc, patch);
  assert.equal(rec.v, 2);
  assert.equal(rec.outline.conflict.internal, "改过的内部冲突");
  assert.equal(rec.outline.conflict.external, "源律只禁止成功");
  assert.equal(doc.versions[0].outline.conflict.internal, "她不肯认错", "旧版本不变");
  assert.equal(doc.approved, 0, "保存不等于批准");
});

test("the PROPOSAL preview shows the eight items, not two legacy lines", () => {
  const doc = st.createStory(null);
  doc.idea = "i";
  const id = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, id, EIGHT);
  const html = render(doc);
  assert.ok(html.includes("故事大纲提案 · 未应用"));
  assert.ok(html.includes("源律只禁止成功"), "提案预览必须显示模型真的答了什么");
  assert.ok(html.includes("中段重大转折"));
  assert.ok(html.includes("第 8 集前后"));
});

test("with no outline at all it explains the eight items and offers one action", () => {
  const doc = st.createStory(null);
  doc.idea = "一句创意";
  const html = render(doc);
  assert.ok(html.includes("从创意发展故事大纲"));
  assert.ok(html.includes("核心冲突（外部 + 内部）"));
  assert.match(html, /data-st-develop/);
  assert.doesNotMatch(html, /data-so-path/, "没有大纲时不摆一堆空框");
});

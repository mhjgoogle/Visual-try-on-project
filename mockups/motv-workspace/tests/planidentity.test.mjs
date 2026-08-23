// 分集规划：改一版规划不再造一部新剧（TASK-094 批次 A / ADR-0072）。
//
// 真实项目 `照见未明rev2` 的实测：目标 24 集，四版规划各 12 条，剧集实体 48 个。
// 成因在这一层——每一份提案的 `episodeId` 都是 null，于是每次「确认规划」都新建。
//
// 产品负责人 2026-08-17 的规则：「A『确认规划』时，已经存在的剧集该被更新」。
import test from "node:test";
import assert from "node:assert/strict";

import * as st from "../src/workflow/storydoc.js";

const OUTLINE = {
  premise: "p", logline: "l", genreTone: "t", world: "w", characterConcepts: [],
  centralConflict: "c", storyArc: "a", climax: "x", ending: "e",
  episodeCount: 2, durationNote: "60-90 秒",
};

/** A story doc with an approved outline and one confirmed plan whose entries
 *  carry episode identities — i.e. the state a real project is in. */
function withConfirmedPlan(entries) {
  const doc = st.createStory(null);
  doc.idea = "一句创意";
  const oid = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, oid, OUTLINE);
  st.applyProposal(doc);
  st.approveOutline(doc, 1);

  const pid = st.beginDevelop(doc, "plan", "");
  st.completeDevelop(doc, pid, entries);
  st.applyProposal(doc);
  // the CALLER stamps identity at confirm time (that contract is unchanged)
  doc.plans[0].episodes.forEach((e, i) => { e.episodeId = `ep-${i + 1}`; });
  st.confirmPlan(doc, 1);
  return doc;
}

const V1 = [
  { epNumber: 1, title: "不可被救的人", coreGoal: "建立", keyEvents: ["她救了人"] },
  { epNumber: 2, title: "回声", coreGoal: "推进", keyEvents: ["她听见回声"] },
];

test("a REVISED plan keeps the episode identities of the version it revises", () => {
  const doc = withConfirmedPlan(V1);
  assert.deepEqual(doc.plans[0].episodes.map((e) => e.episodeId), ["ep-1", "ep-2"]);

  // 「用 AI 改」: launched from v1, so v1 is the base
  const id = st.beginDevelop(doc, "plan", "第 2 集的钩子太弱");
  assert.equal(doc.pending.basedOn, 1, "the base is captured at LAUNCH");
  st.completeDevelop(doc, id, [
    { epNumber: 1, title: "不可被救的人", coreGoal: "建立", keyEvents: ["她救了人"] },
    { epNumber: 2, title: "回声", coreGoal: "推进", keyEvents: ["她听见自己的名字"] },
  ]);
  const v2 = st.applyProposal(doc);

  assert.deepEqual(v2.episodes.map((e) => e.episodeId), ["ep-1", "ep-2"],
    "改一版规划必须复用同样的剧集，否则确认时又新建 12 集");
  assert.equal(v2.basedOn, 1, "which version this was revised from is recorded");
  // …and v1 is untouched: the chain is append-only
  assert.equal(doc.plans[0].episodes[1].keyEvents[0], "她听见回声");
});

test("the identity comes from the DOCUMENT — an answer cannot name an episode", () => {
  const doc = withConfirmedPlan(V1);
  const id = st.beginDevelop(doc, "plan", "改第 2 集");
  // a hostile/confused answer claiming somebody else's identity
  st.completeDevelop(doc, id, [
    { epNumber: 1, title: "改过的第一集", coreGoal: "g", keyEvents: ["a"], episodeId: "ep-999" },
    { epNumber: 2, title: "改过的第二集", coreGoal: "g", keyEvents: ["b"], episodeId: "ep-1" },
  ]);
  assert.deepEqual(doc.pending.proposal.map((e) => e.episodeId), [null, null],
    "completeDevelop still strips every id the model sent");
  const v2 = st.applyProposal(doc);
  assert.deepEqual(v2.episodes.map((e) => e.episodeId), ["ep-1", "ep-2"],
    "身份按 epNumber 从基线推导，不是从答案里读的");
});

test("a deliberately FRESH replan does not inherit the old episodes", () => {
  // codex review, 批次 A round 2 (BLOCKING). 「🪄 重新规划」 sends no revision
  // request, so the backend runs `episode-planner` — a different plan. Carrying
  // the old identities anyway would retitle the existing episodes on confirm and
  // leave every written script under a plan entry it was not written for.
  const doc = withConfirmedPlan(V1);
  assert.equal(st.planRevisionBase(doc, ""), null, "没有修改要求 = 不是修订");
  assert.equal(st.planRevisionBase(doc, "   "), null);
  assert.equal((st.planRevisionBase(doc, "第 2 集钩子太弱") || {}).v, 1);

  const id = st.beginDevelop(doc, "plan", ""); // the 「重新规划」 button
  assert.equal(doc.pending.basedOn, null, "一版全新的规划没有父版本");
  st.completeDevelop(doc, id, [
    { epNumber: 1, title: "完全不同的开局", coreGoal: "g", keyEvents: ["x"] },
    { epNumber: 2, title: "完全不同的第二集", coreGoal: "g", keyEvents: ["y"] },
  ]);
  const v2 = st.applyProposal(doc);
  assert.deepEqual(v2.episodes.map((e) => e.episodeId), [null, null]);
  assert.equal(v2.basedOn, null);
});

test("a FIRST plan links nothing — there is no base to inherit from", () => {
  const doc = st.createStory(null);
  doc.idea = "i";
  const oid = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, oid, OUTLINE);
  st.applyProposal(doc);
  st.approveOutline(doc, 1);
  const pid = st.beginDevelop(doc, "plan", "");
  st.completeDevelop(doc, pid, V1);
  const plan = st.applyProposal(doc);
  assert.deepEqual(plan.episodes.map((e) => e.episodeId), [null, null]);
  assert.equal(plan.basedOn, null, "no parent is null, never guessed as v-1");
});

test("a revision that ADDS an episode leaves the new one unlinked", () => {
  const doc = withConfirmedPlan(V1);
  const id = st.beginDevelop(doc, "plan", "再加一集");
  st.completeDevelop(doc, id, [
    ...V1,
    { epNumber: 3, title: "新的一集", coreGoal: "g", keyEvents: ["c"] },
  ]);
  const v2 = st.applyProposal(doc);
  assert.deepEqual(v2.episodes.map((e) => e.episodeId), ["ep-1", "ep-2", null],
    "真的多了一集就该多一个实体");
});

test("a revision that DROPS an episode does not delete anything", () => {
  const doc = withConfirmedPlan(V1);
  const id = st.beginDevelop(doc, "plan", "砍掉第 2 集");
  st.completeDevelop(doc, id, [V1[0]]);
  const v2 = st.applyProposal(doc);
  assert.deepEqual(v2.episodes.map((e) => e.episodeId), ["ep-1"]);
  // ep-2 is simply not referenced by THIS version; v1 still names it, and the
  // Episode entity (with any script on it) is untouched — AGENTS.md 第 13 条
  assert.equal(doc.plans[0].episodes[1].episodeId, "ep-2");
});

test("a REORDERED answer keeps each episode's own identity", () => {
  // codex review, 批次 A round 1 (BLOCKING): `sanitizePlanEpisodes` densifies
  // `epNumber` to the array position, so matching on the STORED number is
  // matching on position — and a reviser returning the same episodes in another
  // order would have stapled ep-1's identity onto EP02's content.
  const doc = withConfirmedPlan(V1);
  const id = st.beginDevelop(doc, "plan", "把两集顺序换一下");
  st.completeDevelop(doc, id, [
    { epNumber: 2, title: "回声", coreGoal: "推进", keyEvents: ["b"] },
    { epNumber: 1, title: "不可被救的人", coreGoal: "建立", keyEvents: ["a"] },
  ]);
  const v2 = st.applyProposal(doc);
  // the entries are renumbered 1,2 by position (the document requires dense
  // numbering) but each one keeps the identity of the episode it actually is
  assert.deepEqual(v2.episodes.map((e) => e.epNumber), [1, 2]);
  assert.deepEqual(v2.episodes.map((e) => e.title), ["回声", "不可被救的人"]);
  assert.deepEqual(v2.episodes.map((e) => e.episodeId), ["ep-2", "ep-1"],
    "身份跟着内容走，不跟着位置走");
});

test("an answer with unusable episode numbers carries NO identity at all", () => {
  // linking the wrong episode is invisible and irreversible; creating new
  // episodes is visible and archivable. So an unclear answer degrades to 「new」.
  for (const answer of [
    // a missing number
    [{ title: "a", coreGoal: "g", keyEvents: ["x"] }, { epNumber: 2, title: "b", coreGoal: "g", keyEvents: ["y"] }],
    // a duplicated number
    [{ epNumber: 1, title: "a", coreGoal: "g", keyEvents: ["x"] }, { epNumber: 1, title: "b", coreGoal: "g", keyEvents: ["y"] }],
    // a non-integer / out-of-range number
    [{ epNumber: 0, title: "a", coreGoal: "g", keyEvents: ["x"] }, { epNumber: "2", title: "b", coreGoal: "g", keyEvents: ["y"] }],
  ]) {
    const doc = withConfirmedPlan(V1);
    const id = st.beginDevelop(doc, "plan", "改");
    st.completeDevelop(doc, id, answer);
    const v2 = st.applyProposal(doc);
    assert.deepEqual(v2.episodes.map((e) => e.episodeId), [null, null],
      "集号说不清时，宁可新建也不错接");
  }
});

test("an entry claiming an episode the base does not have is simply new", () => {
  const doc = withConfirmedPlan(V1);
  const id = st.beginDevelop(doc, "plan", "改");
  st.completeDevelop(doc, id, [
    { epNumber: 1, title: "a", coreGoal: "g", keyEvents: ["x"] },
    { epNumber: 7, title: "b", coreGoal: "g", keyEvents: ["y"] },
  ]);
  const v2 = st.applyProposal(doc);
  assert.deepEqual(v2.episodes.map((e) => e.episodeId), ["ep-1", null]);
});

test("the claim never reaches the document", () => {
  const doc = withConfirmedPlan(V1);
  const id = st.beginDevelop(doc, "plan", "改");
  st.completeDevelop(doc, id, V1);
  assert.equal(doc.pending.proposal[0].claimedEpNumber, 1, "it is checked, in the transient pending");
  const v2 = st.applyProposal(doc);
  assert.equal("claimedEpNumber" in v2.episodes[0], false, "…and stripped before it is stored");
  assert.equal(JSON.stringify(st.serialize(doc)).includes("claimedEpNumber"), false);
});

test("no two entries can claim one episode", () => {
  const doc = withConfirmedPlan(V1);
  // a corrupted base: two entries with the same epNumber (hand-edited document)
  doc.plans[0].episodes.push({ ...V1[1], epNumber: 1, episodeId: "ep-1" });
  const id = st.beginDevelop(doc, "plan", "改");
  st.completeDevelop(doc, id, [
    { epNumber: 1, title: "a", coreGoal: "g", keyEvents: ["x"] },
    { epNumber: 2, title: "b", coreGoal: "g", keyEvents: ["y"] },
  ]);
  const v2 = st.applyProposal(doc);
  const ids = v2.episodes.map((e) => e.episodeId).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, "a shared episodeId is an unsavable document");
});

// --- 七项：list facets are real document content ----------------------------- //

test("the seven facets survive sanitize and hydration", () => {
  const [e] = st.sanitizePlanEpisodes([{
    epNumber: 1, title: "t", coreGoal: "目标", emotionArc: "平静 → 冲突",
    keyEvents: ["一", "  ", "二"], reveals: ["新信息"],
    characterBeats: [
      { who: "林照", change: "越界", relationChange: "从交易变成同伴" },
      { who: "", change: "无名" },       // half a record says nothing
      { who: "许渡", change: "" },
    ],
  }]);
  assert.equal(e.coreGoal, "目标");
  assert.equal(e.emotionArc, "平静 → 冲突");
  assert.deepEqual(e.keyEvents, ["一", "二"], "blank entries are dropped");
  assert.deepEqual(e.reveals, ["新信息"]);
  assert.deepEqual(e.characterBeats, [
    { who: "林照", change: "越界", relationChange: "从交易变成同伴" },
  ]);
});

test("a model answer cannot smuggle a nested structure into the document", () => {
  const [e] = st.sanitizePlanEpisodes([{
    epNumber: 1, title: "t", coreGoal: "g",
    keyEvents: [{ evil: true }, ["nested"], null, "一条"],
    reveals: "不是列表",
    characterBeats: [{ who: { $ref: "x" }, change: "c" }, "not an object"],
  }]);
  assert.deepEqual(e.keyEvents, ["一条"]);
  assert.deepEqual(e.reveals, []);
  assert.deepEqual(e.characterBeats, []);
});

test("editing a list facet marks the draft dirty — otherwise 保存 stays disabled", () => {
  const doc = withConfirmedPlan(V1);
  assert.equal(st.planDirty(doc), false);

  assert.equal(st.editPlanItem(doc, "id:ep-1", "keyEvents", 0, "她救了不该救的人"), true);
  assert.equal(st.planDirty(doc), true, "编辑主要剧情必须算「已手工修改」");

  st.discardPlanDraft(doc);
  assert.equal(st.planDirty(doc), false);
  assert.equal(st.addPlanItem(doc, "id:ep-1", "characterBeats"), 0);
  assert.equal(st.editPlanBeat(doc, "id:ep-1", 0, "who", "林照"), true);
  assert.equal(st.planDirty(doc), false,
    "只有名字、没写变化 = 还没有内容（`savePlanDraft` 也会丢掉它），所以还不算改动");
  assert.equal(st.editPlanBeat(doc, "id:ep-1", 0, "change", "第一次越界"), true);
  assert.equal(st.planDirty(doc), true, "写全了才算 —— dirty 与「保存会产生新东西」同义");
});

test("a draft edit NEVER reaches the immutable version it was copied from", () => {
  const doc = withConfirmedPlan(V1);
  st.editPlanItem(doc, "id:ep-1", "keyEvents", 0, "改过的事件");
  assert.equal(doc.plans[0].episodes[0].keyEvents[0], "她救了人",
    "浅拷贝会让草稿和已确认版本共用同一个数组");
  assert.equal(st.effectivePlanEpisodes(doc)[0].keyEvents[0], "改过的事件");

  const v = st.savePlanDraft(doc);
  assert.equal(v, 2);
  assert.equal(doc.plans[1].episodes[0].keyEvents[0], "改过的事件");
  assert.equal(doc.plans[1].episodes[0].episodeId, "ep-1", "手工保存也保留身份");
});

test("an ADDED row survives a reload, and does not renumber the ones after it", () => {
  // codex review, 批次 A round 1 (BLOCKING). Two defects in one: running the
  // strict sanitizer over a DRAFT dropped a row that had not been typed into yet,
  // and dropping it shifted every later item's index — while every list op
  // addresses items BY INDEX.
  const doc = withConfirmedPlan([
    { epNumber: 1, title: "t", coreGoal: "g", keyEvents: ["一", "二"] },
    V1[1],
  ]);
  assert.equal(st.addPlanItem(doc, "id:ep-1", "keyEvents"), 2);
  assert.equal(st.addPlanItem(doc, "id:ep-1", "characterBeats"), 0);

  const reloaded = st.createStory(st.serialize(doc));
  const entry = st.effectivePlanEpisodes(reloaded)[0];
  assert.deepEqual(entry.keyEvents, ["一", "二", ""], "打开的那一行必须还在");
  assert.deepEqual(entry.characterBeats, [{ who: "", change: "" }]);
  // …so index 2 still addresses the row the creator is looking at
  assert.equal(st.editPlanItem(reloaded, "id:ep-1", "keyEvents", 2, "三"), true);
  assert.deepEqual(st.effectivePlanEpisodes(reloaded)[0].keyEvents, ["一", "二", "三"]);
});

test("merely OPENING a row is not 「已手工修改」 — and saving one drops it", () => {
  const doc = withConfirmedPlan(V1);
  assert.equal(st.addPlanItem(doc, "id:ep-1", "keyEvents"), 1);
  assert.equal(st.addPlanItem(doc, "id:ep-1", "characterBeats"), 0);
  assert.equal(st.planDirty(doc), false,
    "空行是「我准备写」，不是「我改了」——否则 保存 会被要求去保存一个它必然丢弃的东西");
  assert.equal(st.savePlanDraft(doc), 0);

  // typing into it IS an edit, and then it saves — without the blank row
  st.editPlanItem(doc, "id:ep-1", "keyEvents", 1, "第二件事");
  assert.equal(st.planDirty(doc), true);
  const v = st.savePlanDraft(doc);
  assert.equal(v, 2);
  assert.deepEqual(doc.plans[1].episodes[0].keyEvents, ["她救了人", "第二件事"]);
  assert.deepEqual(doc.plans[1].episodes[0].characterBeats, [],
    "版本里不留空行（严格 sanitizer 仍然管着版本）");
});

test("list ops refuse an out-of-range index rather than appending", () => {
  const doc = withConfirmedPlan(V1);
  assert.equal(st.editPlanItem(doc, "id:ep-1", "keyEvents", 9, "x"), false);
  assert.equal(st.removePlanItem(doc, "id:ep-1", "keyEvents", -1), false);
  assert.equal(st.editPlanBeat(doc, "id:ep-1", 0, "who", "x"), false, "还没有这一行");
  assert.equal(st.editPlanItem(doc, "id:ep-nope", "keyEvents", 0, "x"), false);
  assert.equal(st.editPlanItem(doc, "id:ep-1", "notAFacet", 0, "x"), false);
  assert.equal(st.editPlanBeat(doc, "id:ep-1", 0, "__proto__", "x"), false);
});

test("removing an item removes exactly that one", () => {
  const doc = withConfirmedPlan([
    { epNumber: 1, title: "t", coreGoal: "g", keyEvents: ["一", "二", "三"] },
    V1[1],
  ]);
  assert.equal(st.removePlanItem(doc, "id:ep-1", "keyEvents", 1), true);
  assert.deepEqual(st.effectivePlanEpisodes(doc)[0].keyEvents, ["一", "三"]);
});

// --- what the model is shown ------------------------------------------------ //

test("planForPrompt sends the creative facets and NOT the identities", () => {
  const doc = withConfirmedPlan(V1);
  const sent = st.planForPrompt(st.effectivePlanEpisodes(doc));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].episodeId, undefined, "内部身份不进 prompt（ADR-0072 决策 1）");
  assert.equal(sent[0].title, "不可被救的人");
  assert.deepEqual(sent[0].keyEvents, ["她救了人"]);
  // empty facets are omitted rather than sent as "" — nothing to read there
  assert.equal("emotionArc" in sent[0], false);
  assert.equal(JSON.stringify(sent).includes("ep-1"), false);
});

test("planForPrompt drops round-tripped unknown fields", () => {
  const sent = st.planForPrompt([
    { epNumber: 1, title: "t", coreGoal: "g", keyEvents: ["a"], _legacyJunk: { big: "x" } },
  ]);
  assert.equal("_legacyJunk" in sent[0], false);
});

// Story development & episode planning (checkpoint M9) — run via
// `node --test`, wrapped by tests/test_motv_story_m9.py.
//
// Covers: the story document's proposal→apply→approve/confirm transitions,
// lossless hydration, the v7→v8 migration (per-episode scripts + story chain),
// v8 validation, and the story/episodes workspace + director models.
import test from "node:test";
import assert from "node:assert/strict";

import * as st from "../src/workflow/storydoc.js";
import { CANVAS_SCHEMA_VERSION, migrateToCurrent } from "../src/services/canvasschema.js";
import { storyModel, renderStory, renderPlanPanel } from "../src/ui/workspaces.js";
import { directorModel } from "../src/ui/director.js";
import * as sd from "../src/workflow/scriptdoc.js";

const OUTLINE = {
  premise: "社畜穿越盛唐", logline: "每一次开口都是生死赌局", genreTone: "古装爽剧",
  world: "架空盛唐", characterConcepts: ["李昭：急智诗人"], centralConflict: "求生欲 VS 皇权",
  // `climax` is a v10 outline facet (TASK-057)
  storyArc: "登场→成名→抉择", climax: "殿前当众抗旨", ending: "离席诗换自由",
  episodeCount: 4, durationNote: "每集 60-90 秒",
};
const PLAN = [
  { epNumber: 1, title: "殿前成诗", synopsis: "三步成诗保命", purpose: "建立", hook: "拖拽上殿", endingBeat: "再来一首", duration: "60-90 秒" },
  { epNumber: 2, title: "名动长安", synopsis: "一夜成名", purpose: "扩张", hook: "满城传抄", endingBeat: "捏碎诗笺", duration: "60-90 秒" },
];

// --- transitions: idea → outline proposal → apply → approve ---------------- //

test("outline: develop → proposal → apply as v1 → approve (versions preserved)", () => {
  const doc = st.createStory(null);
  st.setIdea(doc, "社畜穿越盛唐");
  const id = st.beginDevelop(doc, "outline", "");
  assert.ok(id > 0);
  assert.equal(st.beginDevelop(doc, "outline", ""), 0); // one at a time
  assert.ok(st.completeDevelop(doc, id, OUTLINE));
  assert.equal(doc.pending.status, "proposed");
  const rec = st.applyProposal(doc);
  assert.equal(rec.v, 1);
  assert.equal(rec.origin, "developed");
  assert.equal(doc.approved, 0); // applying NEVER auto-approves
  assert.ok(st.approveOutline(doc, 1));
  assert.equal(st.approvedOutline(doc).v, 1);
  // a revision proposal becomes v2; approval stays on v1 until re-approved
  const id2 = st.beginDevelop(doc, "outline", "更黑色幽默");
  st.completeDevelop(doc, id2, { ...OUTLINE, genreTone: "黑色幽默" });
  const rec2 = st.applyProposal(doc);
  assert.equal(rec2.v, 2);
  assert.equal(rec2.origin, "revision");
  assert.equal(doc.versions.length, 2); // v1 preserved verbatim
  assert.equal(doc.approved, 1);
});

test("plan: requires an APPROVED outline; confirm is a separate durable step", () => {
  const doc = st.createStory(null);
  st.setIdea(doc, "想法");
  assert.equal(st.beginDevelop(doc, "plan", ""), 0); // no approved outline → refused
  const id = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, id, OUTLINE);
  st.applyProposal(doc);
  st.approveOutline(doc, 1);
  const pid = st.beginDevelop(doc, "plan", "");
  assert.ok(pid > 0);
  st.completeDevelop(doc, pid, PLAN);
  const plan = st.applyProposal(doc);
  assert.equal(plan.v, 1);
  assert.equal(plan.episodes.length, 2);
  assert.equal(plan.outlineVersionId, doc.versions[0].id); // provenance link
  assert.equal(doc.confirmedPlan, 0); // applying NEVER auto-confirms
  assert.ok(st.confirmPlan(doc, 1));
  assert.equal(st.confirmedPlan(doc).v, 1);
});

test("manual outline edit lands as a NEW version; cancel/fail/discard honest", () => {
  const doc = st.createStory(null);
  const id = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, id, OUTLINE);
  st.applyProposal(doc);
  const rec = st.applyManualOutline(doc, { ending: "开放式结局" });
  assert.equal(rec.v, 2);
  assert.equal(rec.origin, "manual");
  assert.equal(rec.outline.ending, "开放式结局");
  assert.equal(rec.outline.premise, OUTLINE.premise); // merged from base
  assert.equal(doc.versions[0].outline.ending, OUTLINE.ending); // v1 untouched
  // failure keeps a retryable transient state; discard drops a proposal
  const id2 = st.beginDevelop(doc, "outline", "");
  st.failDevelop(doc, id2, "boom");
  assert.equal(doc.pending.status, "failed");
  const id3 = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, id3, OUTLINE);
  st.discardProposal(doc);
  assert.equal(doc.pending, null);
  assert.equal(doc.versions.length, 2);
});

test("an empty plan proposal fails honestly instead of proposing nothing", () => {
  const doc = st.createStory(null);
  const id = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, id, OUTLINE);
  st.applyProposal(doc);
  st.approveOutline(doc, 1);
  const pid = st.beginDevelop(doc, "plan", "");
  st.completeDevelop(doc, pid, [{ noTitle: true }]);
  assert.equal(doc.pending.status, "failed");
});

// --- hydration round-trip ---------------------------------------------------- //

test("serialize → createStory round-trips verbatim (incl. unknown fields)", () => {
  const doc = st.createStory(null);
  st.setIdea(doc, "想法");
  const id = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, id, OUTLINE);
  st.applyProposal(doc);
  st.approveOutline(doc, 1);
  const saved = JSON.parse(JSON.stringify(st.serialize(doc)));
  saved.versions[0].futureField = { keep: true }; // unknown → survives
  const revived = st.createStory(saved);
  assert.deepEqual(revived.versions[0].futureField, { keep: true });
  assert.equal(revived.approved, 1);
  assert.equal(revived.versions[0].outline.premise, OUTLINE.premise);
  // pointers to nonexistent versions degrade honestly
  const bad = st.createStory({ ...saved, approved: 99, active: 42 });
  assert.equal(bad.approved, 0);
  assert.equal(bad.active, 1); // falls back to newest
});

// --- v7 → v8 migration --------------------------------------------------------- //

function v7Doc() {
  return {
    v: 7,
    project: "p",
    scriptDoc: { brief: "老创意", versions: [{ id: "sv-1", v: 1, content: "剧本", instruction: "", origin: "generated", basedOn: null, status: "done" }], active: 1, workingText: null },
    assets: { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [] },
    generations: [],
    production: {
      activeEpisodeId: "ep-1",
      episodes: [{ episodeId: "ep-1", title: "第 1 集", scenes: [] }],
      characters: [],
      locations: [],
    },
    nodes: [{ id: "n1", type: "script", x: 0, y: 0, state: "" }],
    edges: [],
    pan: { x: 0, y: 0 },
  };
}

test("v7→v8 moves the single scriptDoc to the ACTIVE episode and backfills the idea", () => {
  const res = migrateToCurrent(v7Doc());
  assert.equal(res.status, "ok");
  assert.equal(res.doc.v, CANVAS_SCHEMA_VERSION);
  assert.ok(!("scriptDoc" in res.doc)); // the old field is gone for good
  assert.equal(res.doc.scripts["ep-1"].versions[0].id, "sv-1"); // moved verbatim
  assert.equal(res.doc.story.idea, "老创意"); // honest copy of the brief
  assert.deepEqual(res.doc.story.versions, []); // outlines are NEVER fabricated
  assert.equal(res.doc.story.approved, 0);
  // deterministic
  assert.deepEqual(migrateToCurrent(v7Doc()).doc, migrateToCurrent(v7Doc()).doc);
});

test("v7→v8 fails safe on a malformed scriptDoc instead of silently dropping it", () => {
  const doc = { ...v7Doc(), scriptDoc: "text" };
  assert.equal(migrateToCurrent(doc).status, "invalid"); // leftover rejected
});

// --- v8 validation ---------------------------------------------------------------- //

function v8Doc() {
  const doc = migrateToCurrent(v7Doc()).doc;
  doc.story.versions = [{
    id: "so-1", v: 1, outline: { ...OUTLINE, episodeCount: 4 },
    origin: "developed", instruction: "", basedOn: null,
  }];
  doc.story.active = 1;
  doc.story.approved = 1;
  doc.story.plans = [{
    id: "plan-1", v: 1, origin: "proposed", instruction: "", outlineVersionId: "so-1",
    episodes: [{ ...PLAN[0], episodeId: "ep-1" }, { ...PLAN[1], episodeId: "ep-2x" }],
  }];
  doc.story.activePlan = 1;
  doc.story.confirmedPlan = 1;
  return doc;
}

test("a well-formed v8 document validates ok; corruption rejected case by case", () => {
  assert.equal(migrateToCurrent(v8Doc()).status, "ok");
  const cases = [
    (d) => delete d.story,
    (d) => delete d.scripts,
    (d) => (d.scriptDoc = null), // leftover legacy field
    (d) => (d.scripts["ep-1"] = "text"),
    (d) => (d.story.idea = 7),
    (d) => (d.story.versions[0].outline.premise = 7), // coercible → rejected instead
    (d) => (d.story.versions[0].outline.characterConcepts = ["ok", 7]),
    (d) => (d.story.versions[0].outline.episodeCount = "four"),
    (d) => (d.story.versions[0].outline.episodeCount = 51), // above the endpoint cap
    (d) => (d.story.versions[0].v = 3), // not dense → hydration would renumber
    (d) => (d.story.versions.push({ ...d.story.versions[0] })), // dup id
    (d) => (d.story.approved = 9), // dangling pointer
    (d) => (d.story.plans[0].episodes[0].title = ""),
    (d) => (d.story.plans[0].episodes[1].epNumber = 5), // not dense
    (d) => (d.story.plans[0].episodes[0].episodeId = 7),
    (d) => (d.story.confirmedPlan = 4),
    // a CONFIRMED plan may not carry unlinked entries (round-2 fix)
    (d) => (d.story.plans[0].episodes[1].episodeId = null),
    // per-episode scripts are strictly validated at v8 (round-3 fix): a value
    // hydration would coerce/drop/renumber is rejected instead
    (d) => (d.scripts["ep-1"].versions[0].content = 7),
    (d) => (d.scripts["ep-1"].versions[0].v = 3), // not dense
    (d) => (d.scripts["ep-1"].versions[0].origin = "weird"),
    (d) => (d.scripts["ep-1"].active = 9), // dangling pointer
    (d) => (d.scripts["ep-1"].workingText = 7),
    (d) => delete d.scripts["ep-1"].brief,
    // two plan entries mapped to ONE episode entity → shared script — reject
    (d) => (d.story.plans[0].episodes[1].episodeId = "ep-1"),
    // THE PRODUCT OWNER'S SEVEN, additive (TASK-088 §2.1 / TASK-094 批次 A).
    // Absent is legitimate; PRESENT-BUT-WRONG rejects the whole document,
    // because hydration coerces these and accepting a malformed one would lose
    // plan content on the load→save round-trip (`additivePresent`'s rule).
    (d) => (d.story.plans[0].episodes[0].coreGoal = 7),
    (d) => (d.story.plans[0].episodes[0].emotionArc = ["平静"]),
    (d) => (d.story.plans[0].episodes[0].keyEvents = "不是列表"),
    (d) => (d.story.plans[0].episodes[0].keyEvents = ["一", 7]),
    (d) => (d.story.plans[0].episodes[0].keyEvents = ["一", "  "]), // blank → dropped
    (d) => (d.story.plans[0].episodes[0].reveals = { a: 1 }),
    (d) => (d.story.plans[0].episodes[0].characterBeats = "不是列表"),
    (d) => (d.story.plans[0].episodes[0].characterBeats = ["不是对象"]),
    (d) => (d.story.plans[0].episodes[0].characterBeats = [{ change: "无人" }]),
    (d) => (d.story.plans[0].episodes[0].characterBeats = [{ who: "林照" }]),
    (d) => (d.story.plans[0].episodes[0].characterBeats = [{ who: "林照", change: "越界", relationChange: 7 }]),
    (d) => (d.story.plans[0].basedOn = "1"), // which version this was revised from
  ];
  for (const [i, mutate] of cases.entries()) {
    const doc = v8Doc();
    mutate(doc);
    assert.equal(migrateToCurrent(doc).status, "invalid", `case ${i}`);
  }
  // a plan episodeId is NOT required to resolve to a live episode (an episode
  // deleted later leaves the plan history intact — shown honestly in the UI)
  const doc = v8Doc();
  doc.story.plans[0].episodes[0].episodeId = "ep-gone";
  assert.equal(migrateToCurrent(doc).status, "ok");
  // …and an UNCONFIRMED plan may legitimately carry unlinked entries
  const doc2 = v8Doc();
  doc2.story.confirmedPlan = 0;
  doc2.story.plans[0].episodes[1].episodeId = null;
  assert.equal(migrateToCurrent(doc2).status, "ok");

  // A WELL-FORMED plan carrying the seven validates, and so does one carrying
  // none of them — the whole point of an additive field is that a document
  // written before it existed is still a valid document (no version bump).
  const doc3 = v8Doc();
  Object.assign(doc3.story.plans[0].episodes[0], {
    coreGoal: "确立世界规则", emotionArc: "平静 → 冲突",
    keyEvents: ["她救了人", "世界收走她"], reveals: ["抹除不等于死亡"],
    characterBeats: [{ who: "林照", change: "越界", relationChange: "交易 → 同伴" }],
  });
  doc3.story.plans[0].basedOn = null;
  assert.equal(migrateToCurrent(doc3).status, "ok");
});

test("a plan PROPOSAL never carries episode identities (agent smuggling stripped)", () => {
  const doc = st.createStory(null);
  const id = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, id, OUTLINE);
  st.applyProposal(doc);
  st.approveOutline(doc, 1);
  const pid = st.beginDevelop(doc, "plan", "");
  // the agent payload tries to smuggle an existing episodeId
  st.completeDevelop(doc, pid, [{ ...PLAN[0], episodeId: "ep-1" }]);
  assert.equal(doc.pending.proposal[0].episodeId, null); // stripped — stamped only at confirm
});

test("outlineForPlan: episode-script context follows the plan's launch outline", () => {
  const doc = st.createStory(null);
  const id = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, id, OUTLINE);
  st.applyProposal(doc);
  st.approveOutline(doc, 1);
  const pid = st.beginDevelop(doc, "plan", "");
  st.completeDevelop(doc, pid, PLAN);
  const plan = st.applyProposal(doc);
  // approval later moves to a revised outline…
  const rec2 = st.applyManualOutline(doc, { ending: "改结局" });
  st.approveOutline(doc, rec2.v);
  // …but the plan's context outline stays the one it was built from
  assert.equal(st.outlineForPlan(doc, plan).id, doc.versions[0].id);
  // fallback: a plan whose linked outline vanished uses the approved one
  assert.equal(st.outlineForPlan(doc, { outlineVersionId: "so-gone" }).id, rec2.id);
});

// --- view models --------------------------------------------------------------------- //

function storyWith(over = {}) {
  const doc = st.createStory(null);
  Object.assign(doc, over);
  return doc;
}

test("storyModel + director: the M9 pipeline standing and real actions", () => {
  const empty = storyModel(storyWith());
  assert.equal(empty.hasIdea, false);
  assert.equal(empty.approved, null);
  const doc = st.createStory(null);
  st.setIdea(doc, "想法");
  const id = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, id, OUTLINE);
  st.applyProposal(doc);
  st.approveOutline(doc, 1);
  const m = storyModel(doc);
  assert.equal(m.approvedIsActive, true);
  // director: story module develops the outline (never a direct idea→script)
  const pd = { draftShots: null, generations: [], story: doc };
  const dm = directorModel({ module: "story", doc: sd.createDoc(), story: doc, pd, sel: {} });
  assert.equal(dm.primary.kind, "story-develop");
  // episodes module: plan action only WITH an approved outline
  const em = directorModel({ module: "episodes", doc: sd.createDoc(), story: doc, pd, sel: {} });
  assert.equal(em.primary.kind, "story-plan");
  const em0 = directorModel({ module: "episodes", doc: sd.createDoc(), story: st.createStory(null), pd, sel: {} });
  assert.equal(em0.primary, null);
  assert.ok(em0.pending.includes("批准"));
});

test("story workspace renders the pipeline; no idea→script shortcut remains", () => {
  const doc = st.createStory(null);
  const ctx = {
    story: { doc: () => doc },
    script: { doc: () => sd.createDoc() },
    prodData: () => ({ story: doc }),
  };
  let html = renderStory(ctx);
  assert.ok(html.includes("创意 → 大纲 → 剧集规划 → 分集剧本"));
  assert.ok(!html.includes("去剧本工作区生成")); // the old shortcut is GONE
  st.setIdea(doc, "想法");
  html = renderStory(ctx);
  assert.ok(html.includes("data-st-develop")); // AI development entry
  const id = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, id, OUTLINE);
  html = renderStory(ctx);
  assert.ok(html.includes("故事大纲提案")); // proposal panel
  assert.ok(html.includes("data-st-apply"));
  st.applyProposal(doc);
  html = renderStory(ctx);
  assert.ok(html.includes("data-st-approve")); // approval gate visible
});

test("plan panel: gate → proposal → applied → confirmed with per-EP script entry", () => {
  const doc = st.createStory(null);
  const m6 = { episodes: [{ episodeId: "ep-1", title: "第 1 集", active: true, sceneCount: 0, shotRefCount: 0, removable: false }] };
  const ctx = { story: { doc: () => doc }, prodData: () => ({ story: doc }) };
  assert.ok(renderPlanPanel(ctx, m6).includes("先在「故事」发展并批准大纲")); // gated
  const id = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, id, OUTLINE);
  st.applyProposal(doc);
  st.approveOutline(doc, 1);
  assert.ok(renderPlanPanel(ctx, m6).includes("data-pl-develop")); // can propose
  const pid = st.beginDevelop(doc, "plan", "");
  st.completeDevelop(doc, pid, PLAN);
  assert.ok(renderPlanPanel(ctx, m6).includes("data-pl-apply")); // proposal cards
  st.applyProposal(doc);
  let html = renderPlanPanel(ctx, m6);
  assert.ok(html.includes("data-pl-confirm")); // confirmation gate
  assert.ok(!html.includes("data-ep-open")); // scripts only AFTER confirm
  doc.plans[0].episodes[0].episodeId = "ep-1"; // the caller's confirm stamps ids
  doc.plans[0].episodes[1].episodeId = "ep-gone"; // its episode was deleted later
  st.confirmPlan(doc, 1);
  html = renderPlanPanel(ctx, m6);
  // 产品 2026-08-13: the panel is the VERSION control; the per-episode content (and
  // the 「去写本集剧本 →」 entry that goes with it) lives on the editable cards below,
  // so the same text is not rendered twice with only the lower copy editable.
  assert.ok(!html.includes('data-ep-open="ep-1"'));
  assert.ok(html.includes("每一集的内容概要在下面的卡片里"));
  // a confirmed entry whose episode no longer exists is flagged honestly,
  // never rendered as an enterable script link
  // INTEGRITY still reported here: a confirmed entry whose Episode entity is gone has
  // no card below, so the panel is the only place it can be named.
  assert.ok(html.includes("剧集实体缺失"));
  assert.ok(!html.includes('data-ep-open="ep-gone"'));
});

test("plan provenance is the outline captured at LAUNCH, not at apply time", () => {
  const doc = st.createStory(null);
  const id = st.beginDevelop(doc, "outline", "");
  st.completeDevelop(doc, id, OUTLINE);
  st.applyProposal(doc);
  st.approveOutline(doc, 1);
  const launchOutlineId = doc.versions[0].id;
  // launch the plan while v1 is approved…
  const pid = st.beginDevelop(doc, "plan", "");
  st.completeDevelop(doc, pid, PLAN);
  // …then, while the proposal is under review, approval moves to a NEW
  // manual outline version (manual versions bypass the pending gate)
  const rec2 = st.applyManualOutline(doc, { ending: "改结局" });
  st.approveOutline(doc, rec2.v);
  const plan = st.applyProposal(doc);
  // the plan stays attributed to the outline its generation actually ran
  // from (v1 at launch) — never re-attributed to the later approval
  assert.equal(plan.outlineVersionId, launchOutlineId);
  assert.notEqual(plan.outlineVersionId, rec2.id);
});

/* ========================================================================= */
/* TASK-069 · 分集规划的手工修改                                              */
/* ========================================================================= */

test("a hand edit is a DRAFT, not a version — the confirmed baseline never moves", () => {
  const doc = st.createStory({
    plans: [{ id: "p1", v: 1, origin: "proposed", episodes: [
      { episodeId: "ep1", title: "EP01 旧标题", synopsis: "旧梗概", purpose: "", hook: "", endingBeat: "", duration: "8 分钟" },
      { episodeId: "ep2", title: "EP02", synopsis: "", purpose: "", hook: "", endingBeat: "", duration: "" },
    ] }],
    activePlan: 1, confirmedPlan: 1,
  });
  assert.equal(st.planDirty(doc), false);
  assert.equal(st.effectivePlanEpisodes(doc)[0].title, "EP01 旧标题");

  // typing edits the DRAFT — the confirmed version is untouched, which is what
  // every Episode's 「Based on 规划 v1」 baseline depends on (ADR-0054 决策 6)
  assert.equal(st.editPlanEntry(doc, "ep1", "hook", "尸体在第一分钟出现"), true);
  assert.equal(st.planDirty(doc), true);
  assert.equal(st.effectivePlanEpisodes(doc)[0].hook, "尸体在第一分钟出现");
  assert.equal(doc.plans.length, 1, "no version was created by typing");
  assert.equal(doc.plans[0].episodes[0].hook, "", "the immutable version is untouched");
  assert.equal(doc.confirmedPlan, 1);

  // typing it BACK clears the flag — a 「已修改」 the creator cannot get rid of
  // would be worse than none
  st.editPlanEntry(doc, "ep1", "hook", "");
  assert.equal(st.planDirty(doc), false);
});

test("saving the draft appends a manual version and does NOT confirm it", () => {
  const doc = st.createStory({
    plans: [{ id: "p1", v: 1, origin: "proposed", outlineVersionId: "so-1", episodes: [
      { episodeId: "ep1", title: "EP01", synopsis: "", purpose: "", hook: "", endingBeat: "", duration: "" },
    ] }],
    activePlan: 1, confirmedPlan: 1,
  });
  assert.equal(st.savePlanDraft(doc), 0, "nothing to save");
  st.editPlanEntry(doc, "ep1", "purpose", "把观众从旁观者变成共犯");
  const v = st.savePlanDraft(doc);
  assert.equal(v, 2);
  assert.equal(doc.plans.length, 2);
  assert.equal(doc.plans[1].origin, "manual");
  assert.equal(doc.plans[1].basedOn, 1, "a manual version records which version it was typed over");
  assert.equal(doc.plans[1].outlineVersionId, "so-1", "…and keeps the outline link it inherited");
  assert.equal(doc.plans[1].episodes[0].purpose, "把观众从旁观者变成共犯");
  assert.equal(doc.activePlan, 2, "the creator is now looking at what they saved");
  assert.equal(doc.confirmedPlan, 1, "…but CONFIRM is a separate gate — episodes do not move by themselves");
  assert.equal(st.planDraftFor(doc, 1), null);
  assert.equal(st.planDirty(doc), false);
  // v1's content is still exactly what it was
  assert.equal(doc.plans[0].episodes[0].purpose, "");
});

test("an edit is addressed by episodeId, and refuses what it cannot place", () => {
  const doc = st.createStory({
    plans: [{ id: "p1", v: 1, origin: "proposed", episodes: [
      { episodeId: "ep1", title: "EP01", synopsis: "", purpose: "", hook: "", endingBeat: "", duration: "" },
    ] }],
    activePlan: 1, confirmedPlan: 1,
  });
  assert.equal(st.editPlanEntry(doc, "nope", "hook", "x"), false, "an unknown episode is refused, not written to a neighbour");
  assert.equal(st.editPlanEntry(doc, "ep1", "notAField", "x"), false, "only the six plan facets are editable");
  assert.equal(st.editPlanEntry(doc, "", "hook", "x"), false);
  assert.equal(st.planDraftFor(doc, 1), null, "a refused edit creates no draft");
  // with no plan at all there is nothing to edit
  const bare = st.createStory(null);
  assert.equal(st.editPlanEntry(bare, "ep1", "hook", "x"), false);
  assert.equal(st.planEditBase(bare), null);
  assert.deepEqual(st.effectivePlanEpisodes(bare), []);
});

test("the draft survives a save/load round-trip, and a dangling one is dropped", () => {
  const doc = st.createStory({
    plans: [{ id: "p1", v: 1, origin: "proposed", episodes: [
      { episodeId: "ep1", title: "EP01", synopsis: "", purpose: "", hook: "", endingBeat: "", duration: "" },
    ] }],
    activePlan: 1, confirmedPlan: 1,
  });
  st.editPlanEntry(doc, "ep1", "synopsis", "写到一半刷新也不能丢");
  const back = st.createStory(st.serialize(doc));
  assert.equal(st.planDirty(back), true);
  assert.equal(st.effectivePlanEpisodes(back)[0].synopsis, "写到一半刷新也不能丢");
  // a draft whose base version no longer exists cannot be compared against
  // anything, so it is dropped rather than leaving a permanent unresolvable 「已修改」
  const orphan = st.createStory({ plans: [], planDrafts: { "7": [{ episodeId: "ep1", title: "x" }] } });
  assert.deepEqual(orphan.planDrafts, {});
});

test("discarding goes back to the version on file", () => {
  const doc = st.createStory({
    plans: [{ id: "p1", v: 1, origin: "proposed", episodes: [
      { episodeId: "ep1", title: "EP01 原标题", synopsis: "", purpose: "", hook: "", endingBeat: "", duration: "" },
    ] }],
    activePlan: 1, confirmedPlan: 1,
  });
  st.editPlanEntry(doc, "ep1", "title", "EP01 改坏了");
  assert.equal(st.discardPlanDraft(doc), true);
  assert.equal(st.planDirty(doc), false);
  assert.equal(st.effectivePlanEpisodes(doc)[0].title, "EP01 原标题");
  assert.equal(st.discardPlanDraft(doc), false, "nothing to discard twice");
});

test("switching plan versions does NOT destroy an unsaved edit (codex review, P1)", () => {
  // The failure this pins: edit v1 → don't save → press 「查看 v2」 in the plan panel
  // → type one character. With a single draft, the v1 text was still displayed under
  // v2's number, and that keystroke re-seeded the draft from v2 — taking the unsaved
  // v1 edits with it, silently.
  const doc = st.createStory({
    plans: [
      { id: "p1", v: 1, origin: "proposed", episodes: [{ episodeId: "ep1", title: "EP01 一版", synopsis: "", purpose: "", hook: "", endingBeat: "", duration: "" }] },
      { id: "p2", v: 2, origin: "proposed", episodes: [{ episodeId: "ep1", title: "EP01 二版", synopsis: "", purpose: "", hook: "", endingBeat: "", duration: "" }] },
    ],
    activePlan: 1, confirmedPlan: 1,
  });
  st.editPlanEntry(doc, "ep1", "hook", "只在 v1 上写的钩子");
  assert.equal(st.planDirty(doc), true);

  // switch to v2 — it shows V2's OWN text, not v1's draft
  assert.equal(st.setActivePlan(doc, 2), true);
  assert.equal(st.effectivePlanEpisodes(doc)[0].title, "EP01 二版");
  assert.equal(st.effectivePlanEpisodes(doc)[0].hook, "", "v1's draft must not leak onto v2");
  assert.equal(st.planDirty(doc), false, "v2 itself is untouched");
  // …and the v1 draft is still reported as waiting, not silently gone
  assert.deepEqual(st.planDraftVersions(doc), [1]);

  // typing on v2 seeds v2's OWN draft and leaves v1's alone
  st.editPlanEntry(doc, "ep1", "hook", "v2 的钩子");
  assert.deepEqual(st.planDraftVersions(doc), [1, 2]);
  assert.equal(st.planDraftFor(doc, 1)[0].hook, "只在 v1 上写的钩子", "the v1 edit survived");

  // switch back — exactly what was typed is there
  st.setActivePlan(doc, 1);
  assert.equal(st.effectivePlanEpisodes(doc)[0].hook, "只在 v1 上写的钩子");
  assert.equal(st.planDirty(doc), true);

  // saving v1's draft consumes ONLY v1's
  const v = st.savePlanDraft(doc);
  assert.equal(v, 3);
  assert.equal(doc.plans[2].episodes[0].hook, "只在 v1 上写的钩子");
  assert.deepEqual(st.planDraftVersions(doc), [2], "the v2 edit is still waiting");
  // …and discarding is likewise scoped to the version on screen
  st.setActivePlan(doc, 2);
  assert.equal(st.discardPlanDraft(doc), true);
  assert.deepEqual(st.planDraftVersions(doc), []);
});

test("a document written by the FIRST draft shape is migrated, not dropped", () => {
  // The singular `planDraft` shipped for a few minutes before the keyed one. A
  // creator's unsaved work must survive that change of shape.
  const doc = st.createStory({
    plans: [{ id: "p1", v: 1, origin: "proposed", episodes: [{ episodeId: "ep1", title: "EP01", synopsis: "", purpose: "", hook: "", endingBeat: "", duration: "" }] }],
    activePlan: 1, confirmedPlan: 1,
    planDraft: { basedOn: 1, episodes: [{ episodeId: "ep1", title: "EP01", synopsis: "旧形状写的", purpose: "", hook: "", endingBeat: "", duration: "" }] },
  });
  assert.deepEqual(st.planDraftVersions(doc), [1]);
  assert.equal(st.effectivePlanEpisodes(doc)[0].synopsis, "旧形状写的");
  assert.equal(st.planDirty(doc), true);
});

test("a draft typed back to its original is not reported as an unsaved edit", () => {
  // codex review round 2 (non-blocking → fixed): reporting by EXISTENCE meant
  // typing a value and typing it back left a stored-but-identical draft warning
  // 「另有未保存的修改」 — and `discardPlanDraft` only reaches the version on screen,
  // so the warning could not be cleared from where the creator was standing.
  const doc = st.createStory({
    plans: [
      { id: "p1", v: 1, origin: "proposed", episodes: [{ episodeId: "ep1", title: "EP01", synopsis: "原文", purpose: "", hook: "", endingBeat: "", duration: "" }] },
      { id: "p2", v: 2, origin: "proposed", episodes: [{ episodeId: "ep1", title: "EP01", synopsis: "二版", purpose: "", hook: "", endingBeat: "", duration: "" }] },
    ],
    activePlan: 1, confirmedPlan: 1,
  });
  st.editPlanEntry(doc, "ep1", "synopsis", "改了一下");
  assert.deepEqual(st.planDraftVersions(doc), [1]);
  assert.equal(st.planDirty(doc), true);
  // …type it back
  st.editPlanEntry(doc, "ep1", "synopsis", "原文");
  assert.equal(st.planDirty(doc), false, "the version on screen is clean again");
  assert.deepEqual(st.planDraftVersions(doc), [], "…and it is not reported to other versions either");
  // seen from v2, the v1 draft must likewise not raise a warning
  st.setActivePlan(doc, 2);
  assert.deepEqual(st.planDraftVersions(doc), []);
});

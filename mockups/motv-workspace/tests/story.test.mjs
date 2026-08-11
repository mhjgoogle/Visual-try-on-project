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
  assert.ok(html.includes('data-ep-open="ep-1"')); // → 进入本集剧本
  // a confirmed entry whose episode no longer exists is flagged honestly,
  // never rendered as an enterable script link
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

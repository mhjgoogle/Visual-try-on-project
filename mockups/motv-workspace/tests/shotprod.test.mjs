// Checkpoint CP4 (ADR-0057 / TASK-060) — shot production state + Dailies.
//
// What is pinned here:
//   1. 生成成功 != 镜头完成 — only a HUMAN approval reaches 已通过
//   2. `approved: false` does not exist; "not approved" is the ABSENCE of a record
//   3. every other shot stage is DERIVED, never stored
//   4. a Reference is SHARED by key — many shots, one chain, one version pointer
//   5. deleting a reference leaves no phantom binding
//   6. the v12→v13 migration starts EMPTY and approves nothing
//   7. Dailies walks canonical order and survives shots with no video
import test from "node:test";
import assert from "node:assert/strict";

import {
  SHOT_STAGES, SHOT_STAGE_LABEL, hasStaleApproval, isApprovedFor,
  defaultShotProduction, sanitizeShotProduction,
  isApproved, reviewOf, approveShot, approveShot as shotprodApprove, unapproveShot,
  referencesOfShot, addShotReference, removeShotReference, shotsUsingReference,
  pruneShotReferences, isDesigned, shotStage, stageCounts,
} from "../src/workflow/shotprod.js";
import * as pd from "../src/workflow/proddoc.js";
import { CANVAS_SCHEMA_VERSION, MIGRATIONS, migrateToCurrent, validateCanvasDoc } from "../src/services/canvasschema.js";
import { dailiesModel, dailiesAt } from "../src/ui/dailies.js";

const prodWith = (sp) => ({ shotProduction: sanitizeShotProduction(sp) });

// --- 1 & 2. approval is a human decision, and only an approval is stored ----

test("生成成功 != 镜头完成: a shot with a video is 待审片, never 已通过", () => {
  const p = prodWith(null);
  const shot = { shotId: "shot-a", description: "林晚推门", shotSize: "近景" };
  assert.equal(shotStage(p, shot, { image: true, video: true, videoAssetId: "vid-1" }), "todo-review");
  // only a recorded human approval reaches the last stage
  approveShot(p, "shot-a", "vid-1", "2026-08-12T02:00:00Z", "光很好");
  assert.equal(shotStage(p, shot, { image: true, video: true, videoAssetId: "vid-1" }), "approved");
});

test("only APPROVALS are stored — `approved: false` is not a state", () => {
  const p = prodWith({
    reviews: {
      "shot-yes": { approved: true, assetId: "vid-1", approvedAt: "t", note: "ok" },
      "shot-no": { approved: false, assetId: "vid-2", approvedAt: "t", note: "rejected?" },
      "shot-junk": { note: "no approved flag" },
      "shot-nameless": { approved: true, approvedAt: "t", note: "which video?" },
    },
  });
  assert.equal(isApproved(p, "shot-yes"), true);
  // "not approved" is the ABSENCE of a record, never a false flag
  assert.equal(isApproved(p, "shot-no"), false);
  assert.equal(reviewOf(p, "shot-no"), null);
  assert.equal(reviewOf(p, "shot-junk"), null);
  // an approval that cannot say WHICH video it approved is unusable evidence
  assert.equal(reviewOf(p, "shot-nameless"), null);
  assert.equal(Object.keys(p.shotProduction.reviews).length, 1);
});

test("withdrawing an approval REMOVES the record rather than negating it", () => {
  const p = prodWith(null);
  approveShot(p, "shot-a", "vid-1", "t");
  assert.equal(unapproveShot(p, "shot-a"), true);
  assert.equal("shot-a" in p.shotProduction.reviews, false);
  assert.equal(unapproveShot(p, "shot-a"), false); // already absent → no-op
  assert.equal(approveShot(p, "", "vid-1", "t"), false); // no identity, no record
  assert.equal(approveShot(p, "shot-b", "", "t"), false); // no video, no record
});

// --- 3. every other stage is derived ---------------------------------------

test("an approval describes the CURRENT standing, and the record survives", () => {
  // codex review, TASK-060 round 2: an approved shot whose video is deleted or
  // switched away is not 已通过 any more — but the creator really did approve
  // something, so the RECORD is kept and the UI says the approval is stale.
  const p = prodWith(null);
  const shot = { shotId: "s1", description: "推门" };
  const withVid = (id) => ({ image: true, video: !!id, videoAssetId: id || null });
  approveShot(p, "s1", "vid-1", "t");
  assert.equal(shotStage(p, shot, withVid("vid-1")), "approved");
  assert.equal(hasStaleApproval(p, shot, withVid("vid-1")), false);
  // the approved video goes away…
  assert.equal(shotStage(p, shot, withVid(null)), "generated");
  assert.equal(hasStaleApproval(p, shot, withVid(null)), true);
  assert.equal(isApproved(p, "s1"), true, "the decision itself is never erased");
  // …a DIFFERENT take becomes current: unreviewed footage must NOT inherit the
  // 已通过 it never earned (codex review, TASK-060 round 3)
  assert.equal(shotStage(p, shot, withVid("vid-2")), "todo-review");
  assert.equal(hasStaleApproval(p, shot, withVid("vid-2")), true);
  assert.equal(isApprovedFor(p, "s1", "vid-2"), false);
  // …and switching back to the approved take restores it
  assert.equal(shotStage(p, shot, withVid("vid-1")), "approved");
});

test("the stage ladder is derived from what actually exists", () => {
  const p = prodWith(null);
  const bare = { shotId: "s1", title: "只有标题" };
  const designed = { shotId: "s1", title: "x", description: "推门进来" };
  assert.equal(shotStage(p, bare, { image: false, video: false }), "todo-design");
  assert.equal(shotStage(p, designed, { image: false, video: false }), "todo-generate");
  assert.equal(shotStage(p, designed, { image: true, video: false }), "generated");
  assert.equal(shotStage(p, designed, { image: true, video: true }), "todo-review");
  // a title alone is a placeholder, not a design
  assert.equal(isDesigned(bare), false);
  assert.equal(isDesigned(designed), true);
  assert.equal(isDesigned({ shotId: "s", shotSize: "远景" }), true);
  assert.equal(isDesigned(null), false);
  // the vocabulary is closed, fully labelled, and every state is REACHABLE —
  // codex review round 2: a listed stage the data can never produce is a label
  // the UI could print and the system could never mean
  for (const s of SHOT_STAGES) assert.equal(typeof SHOT_STAGE_LABEL[s], "string");
  assert.equal(SHOT_STAGES.includes("designed"), false,
    "已设计 and 待生成 are the same condition — listing both leaves one unreachable");
});

test("stageCounts tallies an episode without storing a single status", () => {
  const p = prodWith(null);
  approveShot(p, "s3", "vid-s3", "t");
  const shots = [
    { shotId: "s1", title: "" },
    { shotId: "s2", description: "有设计" },
    { shotId: "s3", description: "有设计" },
  ];
  const media = { s1: {}, s2: { image: true }, s3: { image: true, video: true, videoAssetId: "vid-s3" } };
  const c = stageCounts(p, shots, (s) => media[s.shotId]);
  assert.equal(c.total, 3);
  assert.equal(c["todo-design"], 1);
  assert.equal(c.generated, 1);
  assert.equal(c.approved, 1);
  assert.equal(c["todo-review"], 0);
});

// --- 4 & 5. references are SHARED by key ------------------------------------

test("many shots share ONE reference key — never a copy per shot", () => {
  const p = prodWith(null);
  for (const s of ["sh01", "sh02", "sh05"]) {
    assert.equal(addShotReference(p, s, "ref-linzhao"), true);
  }
  assert.deepEqual(shotsUsingReference(p, "ref-linzhao").sort(), ["sh01", "sh02", "sh05"]);
  assert.deepEqual(referencesOfShot(p, "sh01"), ["ref-linzhao"]);
  // binding the SAME reference twice to one shot is refused — a duplicate would
  // render two identical chips and double-count the reference's usage
  assert.equal(addShotReference(p, "sh01", "ref-linzhao"), false);
  assert.deepEqual(referencesOfShot(p, "sh01"), ["ref-linzhao"]);
  // order is preserved as bound
  addShotReference(p, "sh01", "ref-bar");
  assert.deepEqual(referencesOfShot(p, "sh01"), ["ref-linzhao", "ref-bar"]);
  // removing the last binding removes the key entirely (no empty arrays)
  assert.equal(removeShotReference(p, "sh02", "ref-linzhao"), true);
  assert.equal("sh02" in p.shotProduction.references, false);
  assert.equal(removeShotReference(p, "sh02", "ref-linzhao"), false);
  assert.equal(addShotReference(p, "sh01", ""), false);
  assert.equal(addShotReference(p, "", "ref-x"), false);
});

test("a deleted reference leaves NO phantom binding", () => {
  const p = prodWith(null);
  addShotReference(p, "sh01", "ref-live");
  addShotReference(p, "sh01", "ref-gone");
  addShotReference(p, "sh02", "ref-gone");
  const removed = pruneShotReferences(p, new Set(["ref-live"]));
  assert.equal(removed, 2);
  assert.deepEqual(referencesOfShot(p, "sh01"), ["ref-live"]);
  assert.equal("sh02" in p.shotProduction.references, false);
});

test("hydration drops unusable bindings and de-duplicates", () => {
  const p = prodWith({
    references: {
      sh01: ["ref-a", "ref-a", "", null, "ref-b"],
      sh02: [],
      sh03: "nope",
    },
  });
  assert.deepEqual(referencesOfShot(p, "sh01"), ["ref-a", "ref-b"]);
  assert.equal("sh02" in p.shotProduction.references, false);
  assert.equal("sh03" in p.shotProduction.references, false);
  assert.deepEqual(defaultShotProduction(), { reviews: {}, references: {} });
});

test("a shotId literally named __proto__ stays an own key", () => {
  const p = prodWith(null);
  approveShot(p, "__proto__", "vid-x", "t");
  addShotReference(p, "__proto__", "ref-x");
  assert.equal(isApproved(p, "__proto__"), true);
  assert.deepEqual(referencesOfShot(p, "__proto__"), ["ref-x"]);
  assert.equal({}.approved, undefined, "the prototype was not polluted");
});

// --- 6. the v12 → v13 migration --------------------------------------------

test("v12→v13 adds an EMPTY shot-production map and approves nothing", () => {
  assert.ok(CANVAS_SCHEMA_VERSION >= 13);
  assert.equal(typeof MIGRATIONS[12], "function");
  const v12 = {
    v: 12, project: "p", scripts: {},
    story: {
      idea: "", versions: [], active: 0, approved: 0, plans: [], activePlan: 0,
      confirmedPlan: 0, pending: null,
      brief: { draft: { genre: "", tone: "", form: "", episodeDuration: "", totalDuration: "", notes: "", targetEpisodes: null }, versions: [], active: 0 },
    },
    assets: { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [] },
    generations: [], skillRuns: [],
    production: {
      episodes: [{
        episodeId: "ep-1", title: "第 1 集", scenes: [], bgmAssetId: null,
        beats: { plot: [], character: [], relationship: [], world: [] },
        basedOn: { brief: 0, outline: 0, characters: 0, relationships: 0, world: 0 },
      }],
      activeEpisodeId: "ep-1", characters: [], locations: [], relationships: [],
      canon: { characters: 0, relationships: 0, world: 0 },
      world: { era: "", rules: "", society: "", regions: "", places: "", visualTone: "", atmosphere: "" },
    },
    timelines: {}, nodes: [], edges: [], pan: { x: 0, y: 0 },
  };
  const snapshot = structuredClone(v12);
  const res = migrateToCurrent(v12);
  assert.equal(res.status, "ok", res.detail);
  assert.deepEqual(v12, snapshot);
  assert.deepEqual(res.doc.production.shotProduction, { reviews: {}, references: {} });
  assert.equal(validateCanvasDoc(res.doc), null);
  // deterministic + idempotent
  assert.deepEqual(migrateToCurrent(structuredClone(res.doc)).doc, res.doc);
});

test("an approval survives a canvas ROUND-TRIP, and inherits nothing it should not", () => {
  // TASK-060 §5A requirement 4: reload must keep the approvals that belong and
  // must not let a different take pick one up.
  const p = pd.createProduction(null);
  shotprodApprove(p, "s1", "vid-1", "2026-08-12T05:00:00Z", "夜色对了");
  const reloaded = pd.createProduction(JSON.parse(JSON.stringify(pd.serialize(p))));
  assert.equal(isApproved(reloaded, "s1"), true, "the decision survives reload");
  assert.equal(isApprovedFor(reloaded, "s1", "vid-1"), true);
  assert.equal(reloaded.shotProduction.reviews["s1"].note, "夜色对了");
  assert.equal(reloaded.shotProduction.reviews["s1"].approvedAt, "2026-08-12T05:00:00Z");
  // …and the take it was NOT given for still does not inherit it after reload
  assert.equal(isApprovedFor(reloaded, "s1", "vid-2"), false);
  const shot = { shotId: "s1", description: "推门" };
  assert.equal(shotStage(reloaded, shot, { image: true, video: true, videoAssetId: "vid-2" }), "todo-review");
  assert.equal(shotStage(reloaded, shot, { image: true, video: true, videoAssetId: "vid-1" }), "approved");
  // a second round-trip is idempotent
  assert.deepEqual(pd.serialize(pd.createProduction(pd.serialize(reloaded))).shotProduction,
    pd.serialize(reloaded).shotProduction);
});

test("v13 validation refuses a review that misreports the creator's decision", () => {
  const base = () => {
    const p = pd.createProduction(null);
    return {
      v: CANVAS_SCHEMA_VERSION, project: "p", scripts: {},
      story: {
        idea: "", versions: [], active: 0, approved: 0, plans: [], activePlan: 0,
        confirmedPlan: 0, pending: null,
        brief: { draft: { genre: "", tone: "", form: "", episodeDuration: "", totalDuration: "", notes: "", targetEpisodes: null }, versions: [], active: 0 },
      },
      assets: { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [] },
      generations: [], skillRuns: [],
      production: pd.serialize(p),
      timelines: {}, nodes: [], edges: [], pan: { x: 0, y: 0 },
    };
  };
  assert.equal(validateCanvasDoc(base()), null);
  const bad = (mutate) => {
    const doc = base();
    mutate(doc.production.shotProduction);
    return validateCanvasDoc(doc);
  };
  assert.ok(bad((sp) => { sp.reviews["s1"] = { approved: false, approvedAt: null, note: "" }; }));
  assert.ok(bad((sp) => { sp.reviews["s1"] = { approved: true, approvedAt: 7, note: "" }; }));
  assert.ok(bad((sp) => { sp.reviews["s1"] = { approved: true, approvedAt: null }; }));
  assert.ok(bad((sp) => { sp.references["s1"] = []; }));
  assert.ok(bad((sp) => { sp.references["s1"] = ["ref-a", "ref-a"]; }));
  assert.ok(bad((sp) => { sp.references["s1"] = ["", "ref-a"]; }));
  const doc = base();
  delete doc.production.shotProduction;
  assert.ok(validateCanvasDoc(doc));
  // …and a well-formed pair passes
  assert.equal(bad((sp) => {
    sp.reviews["s1"] = { approved: true, assetId: "v1", approvedAt: "t", note: "" };
    sp.references["s1"] = ["ref-a", "ref-b"];
  }), null);
});

// --- 7. Dailies --------------------------------------------------------------

function episodeView() {
  return {
    scenes: [
      { sceneId: "sc-1", title: "S1 · 酒吧", shots: [
        { shot: { shotId: "s1", title: "推门", description: "林晚推门" } },
        { shot: { shotId: "s2", title: "反打", description: "陈默抬头" } },
      ] },
      { sceneId: "sc-2", title: "S2 · 天台", shots: [
        { shot: { shotId: "s3", title: "远景", description: "剪影" } },
      ] },
    ],
    unassigned: [{ shotId: "s4", title: "空镜", description: "雨停" }],
  };
}

const media = {
  s1: { image: true, video: true, videoAssetId: "v1" },
  s2: { image: true },
  s3: {},
  s4: { image: true, video: true, videoAssetId: "v4" },
};

test("Dailies walks CANONICAL order: scenes in order, then the unassigned pool", () => {
  const p = prodWith(null);
  const m = dailiesModel({ prod: p, view: episodeView(), mediaOf: (s) => media[s.shotId], urlOf: () => "" });
  assert.deepEqual(m.items.map((i) => i.shotId), ["s1", "s2", "s3", "s4"]);
  assert.equal(m.items[0].sceneTitle, "S1 · 酒吧");
  assert.equal(m.items[3].sceneTitle, null); // the pool belongs to no scene
  assert.equal(m.total, 4);
});

test("审片 needs a VIDEO — an image-only shot is 已生成, not reviewable", () => {
  // codex review, TASK-060 round 1: approving an image-only shot would jump it
  // from 已生成 straight to 已通过, having reviewed something that does not
  // exist yet. 审片 judges the shot AS IT WILL BE SEEN.
  const p = prodWith(null);
  const m = dailiesModel({ prod: p, view: episodeView(), mediaOf: (s) => media[s.shotId], urlOf: () => "" });
  const s2 = m.items.find((i) => i.shotId === "s2"); // image, no video
  assert.equal(s2.stage, "generated");
  assert.equal(s2.canApprove, false);
  const s1 = m.items.find((i) => i.shotId === "s1"); // image + video
  assert.equal(s1.stage, "todo-review");
  assert.equal(s1.canApprove, true);
});

test("a shot with NO video does not break the walk and cannot be approved", () => {
  const p = prodWith(null);
  const m = dailiesModel({ prod: p, view: episodeView(), mediaOf: (s) => media[s.shotId], urlOf: (s) => (media[s.shotId].video ? `/u/${s.shotId}.mp4` : "") });
  const s3 = m.items.find((i) => i.shotId === "s3");
  assert.equal(s3.videoUrl, "");
  assert.equal(s3.playable, false);
  // approving a shot that has no picture would be approving nothing
  assert.equal(s3.canApprove, false);
  // it IS designed (it has a description) — it just has nothing generated yet
  assert.equal(s3.stage, "todo-generate");
  const s1 = m.items.find((i) => i.shotId === "s1");
  assert.equal(s1.playable, true);
  assert.equal(s1.canApprove, true);
});

test("a stale approval never renders as passed", () => {
  // codex review, TASK-060 round 4: `approved` drives the green chip. A record
  // that no longer describes the current video must not paint it green, or a
  // reviewer reads replaced footage as reviewed.
  const p = prodWith(null);
  approveShot(p, "s1", "OLD-take", "t"); // approved a take that is not current
  const m = dailiesModel({ prod: p, view: episodeView(), mediaOf: (s) => media[s.shotId], urlOf: () => "" });
  const s1 = m.items.find((i) => i.shotId === "s1");
  assert.equal(s1.stage, "todo-review");
  assert.equal(s1.approved, false, "the green chip follows the STAGE, not the record");
  assert.equal(s1.staleApproval, true, "…and the record is surfaced instead");
  assert.equal(m.approved, 0, "the progress line counts current standing only");
});

test("Dailies reports real progress and navigates without falling off the ends", () => {
  const p = prodWith(null);
  approveShot(p, "s1", "v1", "t");
  const build = () => dailiesModel({ prod: p, view: episodeView(), mediaOf: (s) => media[s.shotId], urlOf: () => "/u/x.mp4" });
  const m = build();
  assert.equal(m.approved, 1);
  assert.equal(m.remaining, 3);
  // navigation is total: clamped at both ends, and an unknown id lands on the first
  assert.equal(dailiesAt(m, "s1").next.shotId, "s2");
  assert.equal(dailiesAt(m, "s1").prev, null);
  assert.equal(dailiesAt(m, "s4").next, null);
  assert.equal(dailiesAt(m, "s4").prev.shotId, "s3");
  assert.equal(dailiesAt(m, "nope").current.shotId, "s1");
  assert.equal(dailiesAt(m, null).current.shotId, "s1");
  // an empty episode yields an empty, non-throwing model
  const empty = dailiesModel({ prod: p, view: { scenes: [], unassigned: [] }, mediaOf: () => ({}), urlOf: () => "" });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.total, 0);
  assert.equal(dailiesAt(empty, "s1").current, null);
  // …and no view at all is still safe
  assert.equal(dailiesModel({ prod: p, view: null, mediaOf: () => ({}), urlOf: () => "" }).total, 0);
});

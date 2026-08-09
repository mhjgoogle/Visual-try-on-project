// Production domain document (checkpoint M6) — run via `node --test`,
// wrapped by tests/test_motv_production_domain_m6.py.
//
// Covers: default hydration, id stability across reloads, sanitize rules,
// episode/scene transitions (non-destructive refusals), shot assignment with
// move semantics + single-owner invariant, and the episode read model joined
// against a draft (dangling refs flagged, never guessed or pruned).
import test from "node:test";
import assert from "node:assert/strict";

import * as pd from "../src/workflow/proddoc.js";
import { CANVAS_SCHEMA_VERSION, migrateToCurrent } from "../src/services/canvasschema.js";

const draft = () => [
  { shotId: "shot-a", sequence: 1, title: "跪殿", slot: "v1-1" },
  { shotId: "shot-b", sequence: 2, title: "逼诗", slot: "v1-2" },
];

// --- hydration ------------------------------------------------------------ //

test("createProduction: fresh document has ONE active default episode", () => {
  const p = pd.createProduction(null);
  assert.equal(p.episodes.length, 1);
  assert.equal(p.episodes[0].title, "第 1 集");
  assert.deepEqual(p.episodes[0].scenes, []);
  assert.equal(p.activeEpisodeId, p.episodes[0].episodeId);
  assert.match(p.episodes[0].episodeId, /^ep-/);
});

test("createProduction: persisted ids survive verbatim (never re-minted)", () => {
  const saved = {
    activeEpisodeId: "ep-x",
    episodes: [
      {
        episodeId: "ep-x", title: "上集",
        scenes: [{ sceneId: "scene-1", title: "大殿", shotIds: ["shot-a"], characterRefs: [], locationRef: null }],
      },
      { episodeId: "ep-mig-1", title: "第 1 集", scenes: [] },
    ],
    characters: [],
    locations: [],
  };
  const p = pd.createProduction(structuredClone(saved));
  assert.deepEqual(pd.serialize(p), saved);
});

test("createProduction: sanitize drops only unusable entries, deterministically", () => {
  const p = pd.createProduction({
    activeEpisodeId: "ep-gone", // dangling → falls back to first episode
    episodes: [
      { episodeId: "ep-1", title: 7, scenes: [
        { sceneId: "scene-1", shotIds: ["shot-a", "", null, "shot-a"] }, // dup shot ref → first claim wins
        { sceneId: "scene-1", title: "重复", shotIds: [] },              // dup sceneId → dropped
        { title: "无id", shotIds: [] },                                  // no sceneId → dropped
      ] },
      { episodeId: "ep-1", title: "重复集", scenes: [] },                 // dup episodeId → dropped
      "junk",
      { episodeId: "ep-2", scenes: "nope" },                             // malformed scenes → []
    ],
  });
  assert.equal(p.episodes.length, 2);
  assert.equal(p.activeEpisodeId, "ep-1");
  assert.equal(p.episodes[0].title, ""); // non-string title coerced, not invented
  assert.equal(p.episodes[0].scenes.length, 1);
  assert.deepEqual(p.episodes[0].scenes[0].shotIds, ["shot-a"]);
  assert.deepEqual(p.episodes[1].scenes, []);
});

test("createProduction: a shot claimed by TWO scenes keeps only the first claim", () => {
  const p = pd.createProduction({
    activeEpisodeId: "ep-1",
    episodes: [{
      episodeId: "ep-1", title: "", scenes: [
        { sceneId: "scene-1", title: "", shotIds: ["shot-a"] },
        { sceneId: "scene-2", title: "", shotIds: ["shot-a", "shot-b"] },
      ],
    }],
  });
  assert.deepEqual(p.episodes[0].scenes[0].shotIds, ["shot-a"]);
  assert.deepEqual(p.episodes[0].scenes[1].shotIds, ["shot-b"]);
});

// --- episode transitions --------------------------------------------------- //

test("addEpisode mints a stable id; setActiveEpisode switches; rename edits title only", () => {
  const p = pd.createProduction(null);
  const ep = pd.addEpisode(p, "第 2 集");
  assert.equal(p.episodes.length, 2);
  assert.notEqual(ep.episodeId, p.episodes[0].episodeId);
  assert.equal(pd.setActiveEpisode(p, ep.episodeId), true);
  assert.equal(p.activeEpisodeId, ep.episodeId);
  assert.equal(pd.setActiveEpisode(p, "ep-nope"), false);
  assert.equal(pd.renameEpisode(p, ep.episodeId, "终章"), true);
  assert.equal(pd.renameEpisode(p, ep.episodeId, "   "), false); // blank refused
  assert.equal(ep.title, "终章");
});

test("removeEpisode refuses the last episode and any episode holding scenes", () => {
  const p = pd.createProduction(null);
  const only = p.episodes[0].episodeId;
  assert.equal(pd.removeEpisode(p, only), false); // never below one episode
  const ep2 = pd.addEpisode(p, "");
  pd.addScene(p, ep2.episodeId, "场");
  assert.equal(pd.removeEpisode(p, ep2.episodeId), false); // scenes are not silently destroyed
  const scene = p.episodes[1].scenes[0];
  assert.equal(pd.removeScene(p, scene.sceneId), true);
  assert.equal(pd.removeEpisode(p, ep2.episodeId), true);
  assert.equal(p.episodes.length, 1);
});

test("removing the ACTIVE episode re-points active to the first remaining", () => {
  const p = pd.createProduction(null);
  const ep2 = pd.addEpisode(p, "");
  pd.setActiveEpisode(p, ep2.episodeId);
  assert.equal(pd.removeEpisode(p, ep2.episodeId), true);
  assert.equal(p.activeEpisodeId, p.episodes[0].episodeId);
});

// --- scene transitions ------------------------------------------------------ //

test("addScene/renameScene/removeScene: scene lifecycle inside its episode", () => {
  const p = pd.createProduction(null);
  const epId = p.episodes[0].episodeId;
  const s = pd.addScene(p, epId, "");
  assert.match(s.sceneId, /^scene-/);
  assert.equal(s.title, "场 1"); // default title, not empty
  assert.equal(pd.addScene(p, "ep-nope", "x"), null);
  assert.equal(pd.renameScene(p, s.sceneId, "大殿"), true);
  assert.equal(p.episodes[0].scenes[0].title, "大殿");
  pd.assignShot(p, s.sceneId, "shot-a");
  assert.equal(pd.removeScene(p, s.sceneId), false); // holds a shot → refused
  pd.unassignShot(p, "shot-a");
  assert.equal(pd.removeScene(p, s.sceneId), true);
  assert.deepEqual(p.episodes[0].scenes, []);
});

// --- shot assignment --------------------------------------------------------- //

test("assignShot has MOVE semantics: a shot belongs to at most one scene", () => {
  const p = pd.createProduction(null);
  const epId = p.episodes[0].episodeId;
  const s1 = pd.addScene(p, epId, "甲");
  const s2 = pd.addScene(p, epId, "乙");
  assert.equal(pd.assignShot(p, s1.sceneId, "shot-a"), true);
  assert.equal(pd.assignShot(p, s2.sceneId, "shot-a"), true); // moves, not duplicates
  assert.deepEqual(s1.shotIds, []);
  assert.deepEqual(s2.shotIds, ["shot-a"]);
  assert.deepEqual(pd.sceneOfShot(p, "shot-a").scene.sceneId, s2.sceneId);
  assert.equal(pd.assignShot(p, s1.sceneId, ""), false); // no empty identity
  assert.equal(pd.assignShot(p, "scene-nope", "shot-b"), false);
  assert.equal(pd.unassignShot(p, "shot-a"), true);
  assert.equal(pd.unassignShot(p, "shot-a"), false); // already unassigned → no-op
  assert.equal(pd.sceneOfShot(p, "shot-a"), null);
});

// --- episode read model ------------------------------------------------------ //

test("episodeView resolves scene shot refs by canonical shotId; dangling flagged, never pruned", () => {
  const p = pd.createProduction(null);
  const epId = p.episodes[0].episodeId;
  const s = pd.addScene(p, epId, "大殿");
  pd.assignShot(p, s.sceneId, "shot-a");
  pd.assignShot(p, s.sceneId, "shot-gone"); // its shot left the draft
  const v = pd.episodeView(p, epId, draft());
  assert.equal(v.scenes.length, 1);
  const [ra, rgone] = v.scenes[0].shots;
  assert.equal(ra.dangling, false);
  assert.equal(ra.shot.title, "跪殿");
  assert.equal(rgone.dangling, true);
  assert.equal(rgone.shot, null);
  assert.deepEqual(s.shotIds, ["shot-a", "shot-gone"]); // reference kept in the document
  // unassigned pool = draft shots not claimed by ANY scene
  assert.deepEqual(v.unassigned.map((x) => x.shotId), ["shot-b"]);
  assert.deepEqual(v.unassignable, []);
});

test("episodeView: a duplicated creativeShotId in a corrupt draft resolves to NO shot (fail safe)", () => {
  const p = pd.createProduction(null);
  const epId = p.episodes[0].episodeId;
  const s = pd.addScene(p, epId, "场");
  pd.assignShot(p, s.sceneId, "shot-dup");
  const corrupt = [
    { shotId: "shot-dup", sequence: 1, title: "甲" },
    { shotId: "shot-dup", sequence: 2, title: "乙" },
  ];
  const v = pd.episodeView(p, epId, corrupt);
  assert.equal(v.scenes[0].shots[0].dangling, true); // ambiguous → unresolved, never guessed
  assert.deepEqual(v.unassigned, []); // an ambiguous shot is not offered for assignment
});

test("episodeView: legacy draft shots without a shotId are surfaced as unassignable", () => {
  const p = pd.createProduction(null);
  const v = pd.episodeView(p, p.episodes[0].episodeId, [{ sequence: 1, title: "旧", slot: "v1-1" }]);
  assert.deepEqual(v.unassigned, []);
  assert.equal(v.unassignable.length, 1);
  assert.equal(pd.episodeView(p, "ep-nope", draft()), null);
});

test("shots assigned in ANOTHER episode's scene are not re-offered as unassigned", () => {
  const p = pd.createProduction(null);
  const ep2 = pd.addEpisode(p, "第 2 集");
  const s2 = pd.addScene(p, ep2.episodeId, "回忆");
  pd.assignShot(p, s2.sceneId, "shot-a");
  const v = pd.episodeView(p, p.episodes[0].episodeId, draft());
  assert.deepEqual(v.unassigned.map((x) => x.shotId), ["shot-b"]);
});

// --- serialize round-trip ----------------------------------------------------- //

test("serialize → createProduction round-trips the structure unchanged", () => {
  const p = pd.createProduction(null);
  const ep2 = pd.addEpisode(p, "第 2 集");
  const s = pd.addScene(p, ep2.episodeId, "夜战");
  pd.assignShot(p, s.sceneId, "shot-b");
  pd.setActiveEpisode(p, ep2.episodeId);
  const revived = pd.createProduction(JSON.parse(JSON.stringify(pd.serialize(p))));
  assert.deepEqual(pd.serialize(revived), pd.serialize(p));
});

// --- schema v5 → v6 migration + v6 validation ------------------------------- //

function v5Doc() {
  return {
    v: 5,
    project: "p",
    scriptDoc: null,
    assets: { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [] },
    generations: [],
    nodes: [{ id: "n1", type: "script", x: 0, y: 0, state: "" }],
    edges: [],
    pan: { x: 0, y: 0 },
  };
}

function v6Production() {
  return {
    activeEpisodeId: "ep-1",
    episodes: [{
      episodeId: "ep-1", title: "第 1 集",
      scenes: [{ sceneId: "scene-1", title: "大殿", shotIds: ["shot-a"] }],
    }],
  };
}

test("v5→v6 mints exactly the deterministic default single episode, nothing else", () => {
  const res = migrateToCurrent(v5Doc());
  assert.equal(res.status, "ok");
  assert.equal(res.doc.v, CANVAS_SCHEMA_VERSION);
  assert.deepEqual(res.doc.production, {
    activeEpisodeId: "ep-mig-1",
    episodes: [{ episodeId: "ep-mig-1", title: "第 1 集", scenes: [] }],
    characters: [], // v6→v7 continues the chain with an empty bible
    locations: [],
  });
  // deterministic: same input → identical output
  assert.deepEqual(migrateToCurrent(v5Doc()).doc, migrateToCurrent(v5Doc()).doc);
  // …and everything else is untouched
  const { production: _p, ...rest } = res.doc;
  assert.deepEqual(rest, { ...v5Doc(), v: CANVAS_SCHEMA_VERSION });
});

test("v5→v6 replaces hand-crafted junk production (the field is introduced AT v6)", () => {
  const doc = v5Doc();
  doc.production = { episodes: [{ episodeId: "ep-1", scenes: [{ sceneId: "s", shotIds: ["x", "x"] }] }] };
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  assert.equal(res.doc.production.activeEpisodeId, "ep-mig-1");
});

test("a fresh v1 save reaches v6 with the default production structure", () => {
  const v1 = { v: 1, project: "p", scriptDoc: null, nodes: [{ id: "n1", type: "script", x: 0, y: 0 }], edges: [], pan: { x: 0, y: 0 } };
  const res = migrateToCurrent(v1);
  assert.equal(res.status, "ok");
  assert.equal(res.doc.production.episodes.length, 1);
});

test("v6 validation: missing/truncated production fails safe", () => {
  const ok = { ...v5Doc(), v: 6, production: v6Production() };
  assert.equal(migrateToCurrent(structuredClone(ok)).status, "ok");
  for (const bad of [undefined, "nope", [], { episodes: "x" }, { episodes: [] }]) {
    const doc = structuredClone(ok);
    if (bad === undefined) delete doc.production;
    else doc.production = bad;
    assert.equal(migrateToCurrent(doc).status, "invalid", JSON.stringify(bad));
  }
});

test("v6 validation: id uniqueness, single-owner shot refs, active pointer", () => {
  const base = () => ({ ...v5Doc(), v: 6, production: v6Production() });
  const cases = [
    (p) => p.episodes.push({ episodeId: "ep-1", title: "重复", scenes: [] }), // dup episodeId
    (p) => p.episodes[0].scenes.push({ sceneId: "scene-1", title: "重复", shotIds: [] }), // dup sceneId
    (p) => p.episodes[0].scenes.push({ sceneId: "scene-2", title: "乙", shotIds: ["shot-a"] }), // shot in 2 scenes
    (p) => (p.episodes[0].scenes[0].shotIds = ["shot-a", ""]), // empty shot ref
    (p) => (p.activeEpisodeId = "ep-gone"), // dangling active pointer
    (p) => (p.episodes[0].episodeId = ""), // empty id
    (p) => (p.episodes[0].scenes[0].title = 7), // non-string title
  ];
  for (const [i, mutate] of cases.entries()) {
    const doc = base();
    mutate(doc.production);
    assert.equal(migrateToCurrent(doc).status, "invalid", `case ${i}`);
  }
  // dangling SHOT refs (not resolving to any draft shot) are LEGAL — structure
  // outlives a regenerated draft; they merely display as unresolved
  const doc = base();
  doc.production.episodes[0].scenes[0].shotIds = ["shot-not-in-any-draft"];
  assert.equal(migrateToCurrent(doc).status, "ok");
});

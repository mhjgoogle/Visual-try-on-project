// Checkpoint CP8 (ADR-0059 / TASK-062) — the production graph's identity
// contract: the seven layers joined by REAL ids.
//
//   Story/Canon → Director → Skill Run → Proposal → Generation → Asset
//   → Shot QC → Timeline/Final → Workflow Provenance
//
// What is pinned here:
//   1. a Skill Run records WHICH canon it read, as ids — not as a sentence
//   2. a Proposal has an identity, so an action can point back at it
//   3. a Generation records the proposal it was launched from — and NOTHING
//      infers one from proximity
//   4. the graph joins canon → run → proposal → generation → asset → QC → final
//   5. records that never captured linkage read as UNKNOWN, never as a guess
//   6. the unified Production read model returns the context ids it read
//   7. the graph is still derived: nothing about the topology is stored
import test from "node:test";
import assert from "node:assert/strict";

import {
  productionModel, canonBaselineOf, runInScope, runsWithoutContext, CANON_KEYS,
} from "../src/workflow/prodgraph.js";
import { startRun, proposeRun, acceptRun, proposalIdOf } from "../src/workflow/skillrun.js";
import { startGeneration, completeGeneration } from "../src/workflow/genlib.js";
import { buildProvenanceGraph, explainNode, searchGraph, nodeIds } from "../src/workflow/provenance.js";
import { migrateToCurrent, validateCanvasDoc, CANVAS_SCHEMA_VERSION } from "../src/services/canvasschema.js";
import * as pd from "../src/workflow/proddoc.js";
import * as storydoc from "../src/workflow/storydoc.js";
import { approveShot, addShotReference } from "../src/workflow/shotprod.js";

/** The story document, built by the REAL constructor rather than hand-written:
 *  the migration tests need a document the validator accepts at every version
 *  it passes through, and a hand-kept copy of that shape drifts the moment the
 *  domain adds a field. */
const STORY = storydoc.serialize(storydoc.createStory(null));

/** The registry shape every version from v3 on requires. */
const EMPTY_ASSETS = { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [] };

/** Likewise built by the real constructor — the validator pins the production
 *  document's full shape, and a hand-kept copy drifts as the domain grows. */
const emptyProduction = () => pd.serialize(pd.createProduction(null));

const A = (assetId, over = {}) => ({ assetId, url: `blob:${assetId}`, origin: "upload", storageState: "local", version: 1, ...over });

const SHOTS = [
  { shotId: "sh01", sequence: 1, title: "吧台特写", slot: "v1-1", description: "雨" },
  { shotId: "sh02", sequence: 2, title: "门口全景", slot: "v1-2", description: "门" },
];

function production() {
  const p = pd.createProduction(null);
  const ep = p.episodes[0];
  ep.title = "迷雾入城";
  // the canon baseline this episode was built on — canondoc's own stamp
  ep.basedOn = { brief: 1, outline: 2, characters: 3, relationships: 0, world: 1 };
  const s1 = pd.addScene(p, ep.episodeId, "S01 酒吧 · 雨夜");
  pd.assignShot(p, s1.sceneId, "sh01");
  pd.assignShot(p, s1.sceneId, "sh02");
  return { p, epId: ep.episodeId, sceneId: s1.sceneId };
}

// --- 1. the run records WHICH canon it read ---------------------------------

test("a Skill Run records its target context as IDS, not as a sentence", () => {
  const reg = [];
  const r = startRun(reg, {
    skillId: "continuity-review", skillVersion: 1, runtime: "local", executor: "codex_cli",
    inputSummary: "EP01 · S01 · 2 个镜头",
    context: { episodeId: "ep-1", sceneId: "sc-1", shotId: null },
    createdAt: "t0",
  });
  assert.deepEqual(r.context, { episodeId: "ep-1", sceneId: "sc-1", shotId: null });
  // the human summary is KEPT — it is what a person reads — but the ids are
  // what makes the run traceable
  assert.equal(r.inputSummary, "EP01 · S01 · 2 个镜头");
});

test("a level the run was not scoped to is null — that is a fact, not a gap", () => {
  const reg = [];
  const r = startRun(reg, {
    skillId: "continuity-review", skillVersion: 1,
    context: { episodeId: "ep-1" }, createdAt: "t0",
  });
  assert.equal(r.context.episodeId, "ep-1");
  assert.equal(r.context.sceneId, null, "an episode-wide check has no scene");
  assert.equal(r.context.shotId, null);
});

test("a run given NO context carries null — never an empty object", () => {
  const reg = [];
  // an object of three nulls would claim the context was recorded and empty,
  // which is a different statement from "never recorded"
  for (const ctx of [undefined, null, {}, { episodeId: "" }, "ep-1"]) {
    const r = startRun(reg, { skillId: "s", skillVersion: 1, context: ctx, createdAt: "t0" });
    assert.equal(r.context, null, `context ${JSON.stringify(ctx)} must normalise to null`);
  }
});

// --- 2. the proposal has an identity ----------------------------------------

test("a Proposal is given an id the moment it exists, and keeps it", () => {
  const reg = [];
  const r = startRun(reg, { skillId: "s", skillVersion: 1, createdAt: "t0" });
  assert.equal(proposalIdOf(r), null, "a running run has no proposal to point at");
  proposeRun(reg, r.skillRunId, { issues: [] });
  const pid = proposalIdOf(r);
  assert.match(pid, /^proposal-/);
  // rejecting does not erase it: a rejected proposal is still a real thing
  // that was shown, and anything already pointing at it must keep resolving
  acceptRun(reg, r.skillRunId, "t1");
  assert.equal(proposalIdOf(r), pid);
});

test("a proposal that predates the id is left WITHOUT one — never given a fresh one", () => {
  // a new id would claim a link nothing ever recorded
  const legacy = { skillRunId: "run-old", skillId: "s", skillVersion: 1, status: "accepted",
    proposal: { text: "旧提案" }, context: null };
  assert.equal(proposalIdOf(legacy), null);
});

// --- 3. the generation records what launched it -----------------------------

test("a Generation records the proposal it was launched from", () => {
  const reg = [];
  const g = startGeneration(reg, {
    type: "image", targetId: "sh01", createdAt: "t0",
    origin: { skillRunId: "run-1", proposalId: "proposal-1" },
  });
  assert.deepEqual(g.origin, { skillRunId: "run-1", proposalId: "proposal-1" });
});

test("a Generation with no recorded origin has null — nothing is inferred", () => {
  const reg = [];
  for (const origin of [undefined, null, {}, { skillRunId: "" }]) {
    const g = startGeneration(reg, { type: "image", targetId: "sh01", createdAt: "t0", origin });
    assert.equal(g.origin, null);
  }
  // and a run recorded without a referenceable proposal keeps the half it has
  const partial = startGeneration(reg, { type: "image", createdAt: "t0", origin: { skillRunId: "run-9" } });
  assert.deepEqual(partial.origin, { skillRunId: "run-9", proposalId: null });
});

test("an origin naming ONLY a proposal is refused — nothing could resolve it", () => {
  // codex review, TASK-062: a proposalId with no run names an answer with no
  // record of who was asked. An unresolvable link that renders as a link is
  // worse than none.
  const reg = [];
  const g = startGeneration(reg, {
    type: "image", createdAt: "t0", origin: { proposalId: "proposal-1" },
  });
  assert.equal(g.origin, null);
});

// --- 4. the graph joins the whole chain -------------------------------------

/** The real chain, end to end: baseline → run → proposal → generation → asset
 *  → QC → final. Built with the REAL domain functions, not hand-written JSON. */
function fullChain() {
  const { p, epId, sceneId } = production();
  const runs = [];
  const run = startRun(runs, {
    skillId: "storyboard", skillVersion: 1, runtime: "local", executor: "claude_code",
    inputSummary: "EP01 · S01", context: { episodeId: epId, sceneId, shotId: "sh01" },
    createdAt: "t0",
  });
  proposeRun(runs, run.skillRunId, { shots: [] }, { model: "claude-opus-5" });
  acceptRun(runs, run.skillRunId, "t1");
  const proposalId = proposalIdOf(run);

  const gens = [];
  const gen = startGeneration(gens, {
    type: "image", targetId: "sh01", promptSnapshot: "【画面】雨水",
    provider: "manual", createdAt: "t2",
    origin: { skillRunId: run.skillRunId, proposalId },
  });
  completeGeneration(gens, gen.generationId, ["img-1"]);

  // the asset, and the approval bound to a specific take
  const assets = {
    images: { "v1-1": { current: 1, history: [A("img-1", { creativeShotId: "sh01" })] } },
    videos: { "v1-1": { current: 1, history: [A("vid-1", { creativeShotId: "sh01" })] } },
    audio: {}, firstFrames: {}, finals: [A("final-1", { origin: "compose" })],
  };
  approveShot(p, "sh01", "vid-1", "t3", "通过");

  const scripts = { [epId]: { versions: [{ v: 1, content: "场景 1\n雨。" }], active: 1, workingText: null } };
  return {
    src: { assets, generations: gens, production: p, timelines: {}, draftShots: SHOTS, scripts, skillRuns: runs },
    epId, sceneId, run, proposalId, gen,
  };
}

test("the graph joins canon → run → proposal → generation → asset", () => {
  const { src, epId, run, proposalId, gen } = fullChain();
  const g = buildProvenanceGraph(src);
  const has = (from, to, kind) => g.edges.some((e) => e.from === from && e.to === to && e.kind === kind);

  assert.ok(g.nodes.has(nodeIds.canon(epId)), "the episode's baseline heads the chain");
  assert.ok(has(nodeIds.canon(epId), nodeIds.script(epId), "baseline"));
  assert.ok(has(nodeIds.canon(epId), nodeIds.skillRun(run.skillRunId), "baseline"),
    "the run read that baseline");
  assert.ok(has(nodeIds.shot("sh01"), nodeIds.skillRun(run.skillRunId), "asked"),
    "…scoped to the shot it was asked about");
  assert.ok(has(nodeIds.skillRun(run.skillRunId), nodeIds.proposal(proposalId), "proposal"));
  assert.ok(has(nodeIds.proposal(proposalId), nodeIds.generation(gen.generationId), "origin"));
  assert.ok(has(nodeIds.generation(gen.generationId), nodeIds.asset("img-1"), "result"));
});

test("the canon node reports the BASELINE, never the story itself", () => {
  const { src, epId } = fullChain();
  const n = buildProvenanceGraph(src).nodes.get(nodeIds.canon(epId));
  const keys = n.items.map((i) => i.key);
  assert.deepEqual(keys, ["brief", "outline", "characters", "world"]);
  // `0` is canondoc's "never stamped" — it is not version zero
  assert.equal(keys.includes("relationships"), false);
  // and nothing here is story CONTENT
  assert.equal(JSON.stringify(n).includes("雨"), false);
});

test("the chain is walkable from the frame back to the baseline", () => {
  const { src, epId, run, proposalId } = fullChain();
  const g = buildProvenanceGraph(src);
  const asset = explainNode(g, nodeIds.asset("img-1"));
  assert.ok(asset.producedBy, "the frame names the generation that made it");
  const gen = explainNode(g, asset.producedBy.id);
  assert.equal(gen.launchedBy.id, nodeIds.proposal(proposalId), "…which names the proposal");
  const proposal = explainNode(g, nodeIds.proposal(proposalId));
  assert.equal(proposal.fromRun.id, nodeIds.skillRun(run.skillRunId), "…which names the run");
  const runStory = explainNode(g, nodeIds.skillRun(run.skillRunId));
  assert.equal(runStory.partOf.id, nodeIds.canon(epId), "…which names the baseline it read");
  // and none of the three is a generated artefact
  for (const id of [nodeIds.canon(epId), nodeIds.skillRun(run.skillRunId), nodeIds.proposal(proposalId)]) {
    assert.equal(explainNode(g, id).provenance, "authored");
  }
});

test("QC still binds a specific take, and the final lineage is unchanged", () => {
  const { src } = fullChain();
  const review = src.production.shotProduction.reviews.sh01;
  assert.equal(review.assetId, "vid-1", "the approval names the take it approved");
  // …and the render/final path still builds (no regression from CP8)
  const g = buildProvenanceGraph(src);
  assert.ok(g.nodes.has(nodeIds.asset("final-1")));
});

test("a skill run is searchable by skill, runtime and its summary", () => {
  const { src, run } = fullChain();
  const g = buildProvenanceGraph(src);
  assert.ok(searchGraph(g, "storyboard").includes(nodeIds.skillRun(run.skillRunId)));
  assert.ok(searchGraph(g, "claude_code").includes(nodeIds.skillRun(run.skillRunId)));
});

// --- 5. unknown stays unknown -----------------------------------------------

test("a run whose context was never captured is shown, but belongs to NO episode", () => {
  const { src, epId } = fullChain();
  src.skillRuns.push({
    skillRunId: "run-legacy", skillId: "continuity-review", skillVersion: 1,
    runtime: null, executor: null, model: null, status: "failed",
    inputKeys: [], inputSummary: null, proposal: null, error: null,
    decision: null, decidedAt: null, createdAt: "t0", context: null,
  });
  const g = buildProvenanceGraph(src);
  const n = g.nodes.get(nodeIds.skillRun("run-legacy"));
  assert.ok(n, "it is real history and stays visible");
  assert.equal(n.contextRecorded, false);
  assert.equal(n.episodeId, null, "it is NOT swept into the active episode");
  // nothing connects it to the baseline it never named
  assert.equal(g.edges.some((e) => e.to === n.id), false);
  assert.equal(runsWithoutContext(src.skillRuns).length, 1);
  assert.equal(runInScope(n, { episodeId: epId }), false);
});

test("a generation whose origin names nothing that exists is REPORTED, not drawn", () => {
  const { src } = fullChain();
  src.generations.push({
    generationId: "g-orphan", type: "image", targetId: "sh02", status: "success",
    resultAssetIds: [], inputAssetIds: [], referenceAssetIds: [],
    origin: { skillRunId: "run-gone", proposalId: "proposal-gone" }, createdAt: "t9",
  });
  const g = buildProvenanceGraph(src);
  assert.ok(g.warnings.some((w) => w.kind === "danglingOrigin" && w.generationId === "g-orphan"));
  assert.equal(g.edges.some((e) => e.to === nodeIds.generation("g-orphan") && e.kind === "origin"), false);
});

// --- 6. the unified read model ----------------------------------------------

test("the Production read model returns the CONTEXT IDS it read", () => {
  const { src, epId, sceneId } = fullChain();
  const m = productionModel(src, { sceneId, shotId: "sh01" });
  assert.deepEqual(m.context, { episodeId: epId, sceneId, shotId: "sh01" });
});

test("the Production read model reads all nine surfaces at once", () => {
  const { src, epId } = fullChain();
  const m = productionModel(src);
  assert.equal(m.canon.episodeId, epId);            // Story/Canon
  assert.equal(m.episode.code, "EP01");             // Episode
  assert.equal(m.scenes.length, 1);                 // Scene
  assert.equal(m.shots.length, 2);                  // Shot
  assert.deepEqual(m.referenceKeys, []);            // References
  assert.equal(m.skillRuns.length, 1);              // Skill runs
  assert.equal(m.generations.length, 1);            // Generations
  assert.ok(m.assetCount >= 3);                     // Assets
  assert.equal(m.approved, 1);                      // QC
  assert.equal(m.finals.length, 1);                 // Final
  // QC names the TAKE, not merely "approved" (ADR-0057 must not regress)
  assert.equal(m.qc.find((q) => q.shotId === "sh01").approvedAssetId, "vid-1");
  assert.equal(m.qc.find((q) => q.shotId === "sh02").approved, false);
});

test("the read model carries ids and standing — never the story's content", () => {
  const { src } = fullChain();
  src.story = { idea: "一间深夜不打烊的酒吧", versions: [{ v: 1 }], active: 1, approved: 1, confirmedPlan: 1 };
  const m = productionModel(src);
  // the STANDING is what a reader needs; the prose stays in the story document
  assert.equal(m.story.approvedOutline, 1);
  assert.equal(JSON.stringify(m).includes("一间深夜不打烊的酒吧"), false);
  assert.equal(JSON.stringify(m).includes("场景 1"), false, "nor the script text");
});

test("shared references the episode's shots bind are reported by key", () => {
  const { src } = fullChain();
  addShotReference(src.production, "sh01", "ref-lin");
  addShotReference(src.production, "sh02", "ref-lin");
  assert.deepEqual(productionModel(src).referenceKeys, ["ref-lin"], "one chain, not one per shot");
});

test("an episode with no baseline stamp reports none", () => {
  assert.equal(canonBaselineOf({ episodeId: "e", basedOn: {} }), null);
  assert.equal(canonBaselineOf({ episodeId: "e" }), null);
  assert.equal(canonBaselineOf(null), null);
  // every canon key is a real canondoc surface
  assert.deepEqual(CANON_KEYS, ["brief", "outline", "characters", "relationships", "world"]);
});

// --- 7. still derived, and the migration is honest --------------------------

test("v13 → v14 adds the fields as null and invents no linkage", () => {
  const doc = {
    v: 13, nodes: [], edges: [], scripts: {}, story: STORY, assets: EMPTY_ASSETS, timelines: {},
    skillRuns: [
      { skillRunId: "r1", skillId: "s", skillVersion: 1, status: "accepted", proposal: { text: "旧" } },
      { skillRunId: "r2", skillId: "s", skillVersion: 1, status: "running", proposal: null },
    ],
    generations: [{
      generationId: "g1", type: "image", targetType: null, targetId: null,
      inputAssetIds: [], referenceAssetIds: [], promptSnapshot: null,
      provider: null, model: null, parameters: null,
      status: "success", resultAssetIds: ["a1"], createdAt: "t0",
    }],
    production: emptyProduction(),
  };
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok", res.detail || "");
  const out = res.doc;
  assert.equal(out.v, CANVAS_SCHEMA_VERSION);
  assert.ok(CANVAS_SCHEMA_VERSION >= 14);
  // every one of them is NULL — the document never captured this linkage, and
  // back-filling it would invent history
  assert.equal(out.skillRuns[0].context, null);
  assert.equal(out.skillRuns[1].context, null);
  assert.equal(out.skillRuns[0].proposal.proposalId, null);
  assert.equal(out.generations[0].origin, null);
  assert.equal(validateCanvasDoc(out), null);
});

test("v14 validation refuses a malformed context or origin, accepts null", () => {
  const base = () => ({
    v: CANVAS_SCHEMA_VERSION, nodes: [], edges: [], scripts: {}, story: STORY, assets: EMPTY_ASSETS, timelines: {},
    production: emptyProduction(),
    skillRuns: [{ skillRunId: "r1", skillId: "s", skillVersion: 1, status: "running", proposal: null, context: null }],
    generations: [{
      generationId: "g1", type: "image", targetType: null, targetId: null,
      inputAssetIds: [], referenceAssetIds: [], promptSnapshot: null,
      provider: null, model: null, parameters: null,
      status: "success", resultAssetIds: [], createdAt: "t0", origin: null,
    }],
  });
  assert.equal(validateCanvasDoc(base()), null, "null is valid — it means unrecorded");

  const badCtx = base();
  badCtx.skillRuns[0].context = "EP01";
  assert.match(validateCanvasDoc(badCtx), /non-object context/);

  const badId = base();
  badId.skillRuns[0].context = { episodeId: 7 };
  assert.match(validateCanvasDoc(badId), /invalid context\.episodeId/);

  const badOrigin = base();
  badOrigin.generations[0].origin = { skillRunId: 3 };
  assert.match(validateCanvasDoc(badOrigin), /invalid origin\.skillRunId/);
});

test("the graph persists no topology: rebuilding from the same records is identical", () => {
  const { src } = fullChain();
  const a = buildProvenanceGraph(src);
  const b = buildProvenanceGraph(src);
  assert.deepEqual([...a.nodes.keys()].sort(), [...b.nodes.keys()].sort());
  assert.deepEqual(a.edges.map((e) => e.id).sort(), b.edges.map((e) => e.id).sort());
  // …and none of it was written back into the documents it was built from
  assert.equal("nodes" in src.production, false);
  assert.equal(src.skillRuns.every((r) => !("rank" in r) && !("edges" in r)), true);
});

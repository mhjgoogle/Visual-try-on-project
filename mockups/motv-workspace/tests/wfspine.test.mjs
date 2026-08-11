// Checkpoint CP7 (ADR-0058 / TASK-061) — the Workflow graph's CREATIVE SPINE.
//
// TASK-054 gave the graph everything from the Prompt rightwards. The chain a
// creator actually works in starts earlier:
//
//   Script → Scene → Shot → Shared References → Prompt → Generation
//          → Image → Video → Audio → Final
//
// What is pinned here:
//   1. the spine exists and is ordered left→right
//   2. ONE canonical node per shared Reference, however many shots bind it
//   3. an episode with no script gets NO script node — never an empty one
//   4. a shot the draft no longer holds stays, and says so
//   5. scoping keeps the references an in-scope shot binds
//   6. filtering hides nodes but never rewrites an edge, and keeps the spine
//      only where something survived beneath it
import test from "node:test";
import assert from "node:assert/strict";

import { buildProvenanceGraph, scopeGraph, explainNode, searchGraph, nodeIds } from "../src/workflow/provenance.js";
import { filterGraph } from "../src/ui/wfgraph.js";

const A = (assetId, over = {}) => ({ assetId, url: `blob:${assetId}`, origin: "upload", storageState: "local", version: 1, ...over });

/** EP01: a script, one scene, two shots, one Reference SHARED by both shots.
 *  EP02: no script at all. */
function fixture() {
  const production = {
    activeEpisodeId: "ep1",
    characters: [], locations: [],
    episodes: [
      { episodeId: "ep1", title: "EP01 迷雾入城", scenes: [
        { sceneId: "sc1", title: "S01 酒吧 · 雨夜", shotIds: ["shot1", "shot2", "shot-gone"] },
      ] },
      { episodeId: "ep2", title: "EP02 天台", scenes: [{ sceneId: "sc2", title: "S01 天台", shotIds: [] }] },
    ],
    // CP4 shared bindings: BOTH shots point at the same canonical Reference
    shotProduction: {
      references: { shot1: ["ref-lin"], shot2: ["ref-lin"] },
      reviews: {},
    },
  };
  const draftShots = [
    { shotId: "shot1", sequence: 1, title: "吧台特写", slot: "v1-1" },
    { shotId: "shot2", sequence: 2, title: "门口全景", slot: "v1-2" },
  ];
  const assets = {
    images: {
      // a Reference CHAIN at v2 — the current version is the node
      "ref-lin": { current: 2, history: [A("lin-v1", { version: 1 }), A("lin-v2", { version: 2 })] },
      "v1-1": { current: 1, history: [A("img1", { version: 1, creativeShotId: "shot1", origin: "upload" })] },
    },
    videos: { "v1-1": { current: 1, history: [A("vid1", { version: 1, creativeShotId: "shot1" })] } },
    audio: { "voice-v1-1": { current: 1, history: [A("dlg1", { version: 1, creativeShotId: "shot1", origin: "tts" })] } },
    firstFrames: {},
    finals: [],
  };
  const generations = [
    { generationId: "g-img", type: "image", targetType: "shot", targetId: "shot1",
      inputAssetIds: [], referenceAssetIds: ["lin-v2"], promptSnapshot: "【画面】雨水顺着玻璃滑下",
      provider: "手工外部生成", status: "success", resultAssetIds: ["img1"], createdAt: "2026-08-12T01:00:00.000Z" },
    { generationId: "g-vid", type: "video", targetType: "shot", targetId: "shot1",
      inputAssetIds: ["img1"], referenceAssetIds: [], promptSnapshot: "【动作】放下酒杯",
      provider: "手工外部生成", status: "success", resultAssetIds: ["vid1"], createdAt: "2026-08-12T02:00:00.000Z" },
    { generationId: "g-dlg", type: "audio", targetType: "shot", targetId: "shot1",
      promptSnapshot: "【台词】他不会来了。", provider: "piper-local",
      status: "success", resultAssetIds: ["dlg1"], createdAt: "2026-08-12T03:00:00.000Z" },
    { generationId: "g-fail", type: "image", targetType: "shot", targetId: "shot2",
      promptSnapshot: "更冷的色温", provider: "手工外部生成",
      status: "failed", resultAssetIds: [], createdAt: "2026-08-12T04:00:00.000Z" },
  ];
  const scripts = {
    ep1: { versions: [{ v: 1, content: "场景 1 酒吧 · 雨夜\n林晚坐在吧台前。\n「他不会来了。」" }], active: 1, workingText: null },
    // ep2 exists and has NO script — not an empty one, none
    ep2: { versions: [], active: 0, workingText: null },
  };
  return { assets, generations, production, timelines: {}, draftShots, scripts };
}

const build = () => buildProvenanceGraph(fixture());
const aid = (x) => nodeIds.asset(x);
const gid = (x) => nodeIds.generation(x);
const pid = (x) => nodeIds.prompt(x);
const scriptId = (x) => nodeIds.script(x);
const sceneId = (x) => nodeIds.scene(x);
const shotId = (x) => nodeIds.shot(x);

// --- 1. the spine ------------------------------------------------------------

test("the chain runs Script → Scene → Shot → Reference → Prompt → Generation → Image → Video", () => {
  const g = build();
  const r = (id) => {
    assert.ok(g.nodes.has(id), `${id} must exist`);
    return g.nodes.get(id).rank;
  };
  assert.equal(r(scriptId("ep1")), 0);
  assert.equal(r(sceneId("sc1")), 1);
  assert.equal(r(shotId("shot1")), 2);
  assert.equal(r(aid("lin-v2")), 3, "the shared Reference sits right of the shots that bind it");
  assert.equal(r(pid("g-img")), 4);
  assert.equal(r(gid("g-img")), 5);
  assert.equal(r(aid("img1")), 6);
  assert.ok(r(aid("vid1")) > r(aid("img1")), "the video is right of the frame it came from");
  assert.ok(r(aid("dlg1")) > r(shotId("shot1")));
});

test("the spine's edges are the ones the documents prove", () => {
  const g = build();
  const has = (from, to, kind) => g.edges.some((e) => e.from === from && e.to === to && e.kind === kind);
  assert.ok(has(scriptId("ep1"), sceneId("sc1"), "scene"));
  assert.ok(has(sceneId("sc1"), shotId("shot1"), "shot"));
  assert.ok(has(shotId("shot1"), gid("g-img"), "target"), "the generation records the shot it was made for");
  assert.ok(has(shotId("shot1"), aid("lin-v2"), "binds"));
  // EP02's scene belongs to EP02's (absent) script, so it has no incoming edge
  assert.equal(g.edges.some((e) => e.to === sceneId("sc2")), false);
});

// --- 2. ONE node per shared Reference ---------------------------------------

test("a Reference shared by two shots is ONE node with two bindings — never two copies", () => {
  const g = build();
  const refNodes = [...g.nodes.values()].filter((n) => n.chainKey === "ref-lin" && n.type === "asset");
  // the chain has two versions; only the CURRENT one is what a generation
  // launched today would receive, and it is bound once, not once per shot
  const bound = g.edges.filter((e) => e.kind === "binds");
  assert.equal(bound.length, 2, "two shots bind it");
  assert.equal(new Set(bound.map((e) => e.to)).size, 1, "…to ONE canonical node");
  assert.equal(bound[0].to, aid("lin-v2"), "the chain's current version");
  assert.ok(refNodes.some((n) => n.assetId === "lin-v1"), "the old version still exists as history");
  assert.equal(g.edges.some((e) => e.kind === "binds" && e.to === aid("lin-v1")), false,
    "…but nothing is bound to it: a binding names the chain, not a frozen version");
  // and the node itself can say which shots depend on it
  const story = explainNode(g, aid("lin-v2"));
  assert.deepEqual(story.boundByShots.map((n) => n.shotId).sort(), ["shot1", "shot2"]);
});

test("a binding to a Reference that no longer exists is reported, not drawn", () => {
  const src = fixture();
  src.production.shotProduction.references.shot2 = ["ref-vanished"];
  const g = buildProvenanceGraph(src);
  assert.ok(g.warnings.some((w) => w.kind === "danglingReference" && w.referenceKey === "ref-vanished"));
  assert.equal(g.edges.some((e) => e.kind === "binds" && e.from === shotId("shot2")), false);
});

// --- 3 & 4. honest absence ---------------------------------------------------

test("an episode with no script text gets NO script node — never an empty one", () => {
  const g = build();
  assert.equal(g.nodes.has(scriptId("ep1")), true);
  assert.equal(g.nodes.has(scriptId("ep2")), false);
  // its scene still exists: a scene without a script is a real state
  assert.equal(g.nodes.has(sceneId("sc2")), true);
});

test("a scene owning a shot the draft no longer holds keeps it, and says so", () => {
  const g = build();
  const gone = g.nodes.get(shotId("shot-gone"));
  assert.ok(gone, "the node is not quietly dropped");
  assert.equal(gone.dangling, true);
  assert.equal(gone.sceneId, "sc1");
  assert.equal(g.nodes.get(shotId("shot1")).dangling, false);
});

test("the spine is authored, not generated — and says which", () => {
  const g = build();
  assert.equal(explainNode(g, shotId("shot1")).provenance, "authored");
  assert.equal(explainNode(g, scriptId("ep1")).provenance, "authored");
  assert.equal(explainNode(g, aid("img1")).provenance, "generated");
  const shot = explainNode(g, shotId("shot1"));
  assert.deepEqual(shot.boundReferences.map((n) => n.assetId), ["lin-v2"]);
  assert.equal(shot.generations.length, 3, "image, video and dialogue were all made for this shot");
  assert.equal(shot.partOf.sceneId, "sc1");
  assert.equal(explainNode(g, gid("g-img")).madeFor.shotId, "shot1");
});

test("the script's own words are searchable", () => {
  const g = build();
  assert.deepEqual(searchGraph(g, "林晚坐在吧台前"), [scriptId("ep1")]);
  assert.ok(searchGraph(g, "吧台特写").includes(shotId("shot1")));
});

// --- 5. scoping --------------------------------------------------------------

test("an episode scope carries its own spine and nothing from the other episode", () => {
  const g = scopeGraph(build(), { kind: "episode", id: "ep1" });
  assert.ok(g.nodes.has(scriptId("ep1")));
  assert.ok(g.nodes.has(sceneId("sc1")));
  assert.equal(g.nodes.has(sceneId("sc2")), false);
});

test("narrowing to ONE shot keeps the shared Reference it binds", () => {
  const g = scopeGraph(build(), { kind: "shot", id: "shot1" });
  // a Reference is project-level, so ownership alone would drop it — which is
  // exactly the node someone narrowing to one shot most wants to see
  assert.ok(g.nodes.has(aid("lin-v2")));
  assert.ok(g.nodes.has(shotId("shot1")));
  assert.equal(g.nodes.has(shotId("shot2")), false);
});

// --- 6. filtering ------------------------------------------------------------

test("filtering hides nodes but NEVER rewrites an edge", () => {
  const full = scopeGraph(build(), { kind: "episode", id: "ep1" });
  const imgs = filterGraph(full, "image");
  // the video generation is gone…
  assert.equal(imgs.nodes.has(gid("g-vid")), false);
  assert.equal(imgs.nodes.has(aid("vid1")), false);
  // …and no edge was invented to bridge the gap it left
  for (const e of imgs.edges) {
    assert.ok(imgs.nodes.has(e.from) && imgs.nodes.has(e.to));
    assert.ok(full.edges.some((x) => x.id === e.id), `${e.id} must be a REAL edge, not a shortcut`);
  }
  assert.equal(imgs.edges.length <= full.edges.length, true);
});

test("a media filter keeps the spine ABOVE what survived, and drops the rest", () => {
  const full = scopeGraph(build(), { kind: "episode", id: "ep1" });
  const auds = filterGraph(full, "audio");
  // the dialogue survived, so the shot / scene / script that explain it stay
  assert.ok(auds.nodes.has(aid("dlg1")));
  assert.ok(auds.nodes.has(shotId("shot1")));
  assert.ok(auds.nodes.has(sceneId("sc1")));
  assert.ok(auds.nodes.has(scriptId("ep1")));
  // shot2 has no audio at all — keeping it would pad the view with shots that
  // have nothing to do with what was asked for
  assert.equal(auds.nodes.has(shotId("shot2")), false);
  assert.equal(auds.nodes.has(shotId("shot-gone")), false);
});

test("失败 shows the failures and the shot they belong to — not every shot", () => {
  const full = scopeGraph(build(), { kind: "episode", id: "ep1" });
  const bad = filterGraph(full, "failed");
  const gens = [...bad.nodes.values()].filter((n) => n.type === "generation");
  assert.deepEqual(gens.map((n) => n.generationId), ["g-fail"]);
  assert.ok(bad.nodes.has(shotId("shot2")), "the failure is placed in its shot");
  assert.equal(bad.nodes.has(shotId("shot1")), false, "shots with no failure are not shown");
  assert.ok(bad.nodes.has(sceneId("sc1")));
});

test("全部 changes nothing at all", () => {
  const full = scopeGraph(build(), { kind: "episode", id: "ep1" });
  assert.equal(filterGraph(full, "all"), full);
  assert.equal(filterGraph(full, null), full);
});

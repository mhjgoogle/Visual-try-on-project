// TASK-064 Phase 1b — the three UX defects this batch fixes, as RULES:
//
//   1. 故事开发 → 剧集制作 has exactly ONE explicit entrance. An episode row
//      selects; it never navigates.
//   2. 剧集制作's centre IS the generation graph, and every stage capability is
//      reached from a graph node through the LEFT inspector.
//   3. The provenance chain shows every link the records prove — including the
//      recorded first frame and the creator's 审片通过 — and invents none.
//
// Pure: no DOM, no clock, no fetch. Every assertion is about derivation or about
// the HTML string a pure renderer returns.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EPISODE_NAV, EPISODE_MODULES, EPISODE_DEFAULT, LEGACY_EPISODE_CENTRE, EPISODE_WORKSPACES,
  renderRail, spaceOf, episodeEntryModule,
} from "../src/ui/shell.js";
import { renderShotSelect, bindShotSelect } from "../src/ui/shotselect.js";
import * as pdoc from "../src/workflow/proddoc.js";
import { renderEpProd, showsFocus, FOCUS_FILTERS } from "../src/ui/epprod.js";
import { inspectFromNode, inspectorTarget } from "../src/ui/prodinspector.js";
import { buildProvenanceGraph, explainNode, nodeIds, shotGroups, scopeGraph } from "../src/workflow/provenance.js";
import { filterGraph } from "../src/ui/wfgraph.js";

/* ========================================================================= */
/* 1 · 故事开发 → 剧集制作: one explicit entrance                              */
/* ========================================================================= */

const rail = (episodes) => renderRail({
  activeModule: "script",
  badges: {},
  ratios: {},
  upstream: {},
  episodes,
});

const EPS = [
  { episodeId: "ep1", code: "EP01", title: "EP01 迷雾入城", active: true },
  { episodeId: "ep2", code: "EP02", title: "EP02 雨夜追踪", active: false },
];

test("an episode ROW carries no navigation — only 「进入剧集制作 →」 does", () => {
  const html = rail(EPS);
  // the row's own attribute must be the SELECT one…
  assert.ok(html.includes(`data-ep-choose="ep1"`), "the row must be a select action");
  assert.ok(html.includes(`data-ep-choose="ep2"`));
  // …and it must NOT be the attribute the shell binds to enterEpisode. This is
  // the actual defect: a row that entered 剧集制作 made 「看一下 EP02」 and
  // 「开始做 EP02」 the same click.
  assert.ok(!/data-ep="/.test(html), "an episode row must not carry the legacy enter attribute");
  const rows = html.match(/data-ep-choose="/g) || [];
  assert.equal(rows.length, 2, "every episode gets a select row");
});

test("the exit exists once, on the ACTIVE episode, and names where it goes", () => {
  const html = rail(EPS);
  const exits = html.match(/data-ep-produce="/g) || [];
  assert.equal(exits.length, 1, "ONE cross-space entrance, not one per episode");
  assert.ok(html.includes(`data-ep-produce="ep1"`), "it carries the active episode");
  assert.ok(html.includes("进入剧集制作 →"), "its label says which space it enters");
});

test("an episode with no selection offers no exit at all", () => {
  const html = rail(EPS.map((e) => ({ ...e, active: false })));
  assert.ok(!html.includes("data-ep-produce"), "nothing to enter when nothing is selected");
  assert.ok(html.includes("data-ep-choose"), "the rows are still selectable");
});

test("the exit lands in 剧集制作, and 本集剧本 now lives THERE", () => {
  // The rail's exit target and the space it belongs to are decided by ONE
  // function, so the top bar cannot disagree with the centre about where the
  // creator is.
  assert.equal(spaceOf(EPISODE_DEFAULT), "episode");
  // 本集剧本 USED TO BE story development's last step. THE RULE CHANGED
  // (TASK-091 §1.1 / the owner's 图一): writing the episode script is the first
  // thing 剧集制作 does. Entering it is therefore no longer a cross-space jump in
  // the other direction — it is where that space begins.
  assert.equal(spaceOf("script"), "episode");
});

/* ========================================================================= */
/* 2 · 剧集制作 is graph-first, not eleven peers                              */
/* ========================================================================= */

test("制作台 IS the centre; the stage workspaces (incl. 生成溯源) are secondary", () => {
  // A DELIBERATE contract change (TASK-065 §5 / §9). TASK-064 Phase 1b made the
  // episode-wide provenance graph the centre; that answered 「这个东西是怎么来的」
  // first, which matters AFTER something exists. The creator entering 剧集制作 is
  // here to make the next shot, so the centre is now the CURRENT SHOT's production
  // graph. 生成溯源 lost nothing — it is a workspace with a permanent 「完整溯源 ↗」
  // entrance in the centre header (§14).
  // TASK-073 §1.1 split these two apart: the 制作台 shell still has its own centre
  // (`LEGACY_EPISODE_CENTRE`), while the SPACE now opens on ⑥ 本集看板.
  assert.equal(LEGACY_EPISODE_CENTRE, "workbench");
  assert.equal(EPISODE_DEFAULT, "board");
  // The FIRST ROW and the DEFAULT are now different things, deliberately
  // (TASK-091 §1.1): the rail reads in the owner's order — 剧集制作 starts at 本集剧本 —
  // while 「进入剧集制作」 still lands on 本集看板, because a returning creator usually
  // already has a script and wants the next piece of work.
  assert.equal(EPISODE_NAV[0][0], "script");
  assert.ok(EPISODE_NAV.some(([k]) => k === EPISODE_DEFAULT), "the default is still a row");
  // nothing was deleted: every stage is still addressable, provenance included
  for (const k of ["provenance", "episode", "scenes", "shots", "refplan", "frames", "video", "audio", "dailies", "edit"]) {
    assert.ok(EPISODE_MODULES.includes(k), `${k} must stay reachable`);
    assert.ok(EPISODE_WORKSPACES.some(([x]) => x === k), `${k} must be in the 工作区 menu`);
  }
  // …and the centre is not also listed as a detour from itself
  assert.ok(!EPISODE_WORKSPACES.some(([k]) => k === LEGACY_EPISODE_CENTRE));
});

/** A ctx stub for renderEpProd. It renders from the SAME read models the real
 *  shell hands it (`ctx.episode.view()`), reduced to one shot-less episode: the
 *  header and the 工作区 entry are what these tests are about, and an episode with
 *  no shots is the honest minimum that still renders both. */
function epCtx() {
  const production = {
    activeEpisodeId: "ep1",
    episodes: [{ episodeId: "ep1", title: "EP01 迷雾入城", scenes: [] }],
  };
  return {
    prodData: () => ({
      production, generations: [], draftShots: [], assets: {}, scripts: {},
      story: null, timelines: {},
    }),
    episode: {
      view: () => ({ episodeId: "ep1", title: "EP01 迷雾入城", scenes: [], unassigned: [], counts: {} }),
      referencesOfShot: () => [],
      hasShotAudio: () => false,
    },
    script: { currentText: () => "" },
    assets: { names: () => ({}) },
    shot: {
      mediaOf: () => ({}),
      stage: () => "todo-design",
      stageCounts: () => ({ approved: 0, "todo-review": 0, generated: 0, "todo-generate": 0, "todo-design": 0 }),
    },
  };
}

test("the centre renders no stage TAB STRIP — one secondary 工作区 entry instead", () => {
  const html = renderEpProd(epCtx(), { epFocus: "all" }, { stage: LEGACY_EPISODE_CENTRE, inner: "" });
  assert.ok(!html.includes(`class="ep-tabs"`), "the eleven same-level tabs are gone");
  assert.ok(!/class="ep-tab[ "]/.test(html), "no stage tab buttons on the centre");
  assert.ok(html.includes("data-ep-wsopen"), "the secondary 工作区 entry is there");
});

test("the 工作区 menu lists every stage workspace once, and only when opened", () => {
  const ctx = epCtx();
  const closed = renderEpProd(ctx, { epFocus: "all" }, { stage: LEGACY_EPISODE_CENTRE });
  assert.ok(!closed.includes("data-ep-ws="), "a closed menu renders no items");
  const open = renderEpProd(ctx, { epFocus: "all", epWsOpen: true }, { stage: LEGACY_EPISODE_CENTRE });
  for (const [k] of EPISODE_WORKSPACES) {
    assert.ok(open.includes(`data-ep-ws="${k}"`), `${k} must be pickable`);
  }
  assert.ok(!open.includes(`data-ep-ws="${LEGACY_EPISODE_CENTRE}"`), "the centre is not one of its own detours");
});

test("a stage workspace announces itself as a detour and offers the way back", () => {
  const ctx = epCtx();
  const onGraph = renderEpProd(ctx, { epFocus: "all" }, { stage: LEGACY_EPISODE_CENTRE });
  assert.ok(!onGraph.includes("ep-wsback"), "no way back needed from the centre itself");
  const onStage = renderEpProd(ctx, { epFocus: "all" }, { stage: "frames", inner: "<i>frames</i>" });
  assert.ok(onStage.includes("ep-wsback"), "a detour must be leavable");
  assert.ok(onStage.includes(`data-mod="${LEGACY_EPISODE_CENTRE}"`), "…back to the graph");
  assert.ok(onStage.includes("<i>frames</i>"), "the stage workspace itself is still framed, unchanged");
});

test("the focus filter lives where the shot is CHOSEN, not on the centre header", () => {
  // TASK-066 §2 — a DELIBERATE move. The chips used to filter a wall of shot cards in
  // the centre; that wall became the Shot dropdown, so chips left in the centre header
  // would have had nothing to filter. A control that does nothing is worse than a
  // missing one, so they moved INTO the Shot picker (ui/shotselect.js), above the list
  // they narrow.
  assert.equal(showsFocus(LEGACY_EPISODE_CENTRE), true, "the 制作台 is where a shot is chosen");
  assert.equal(showsFocus("provenance"), false);
  assert.equal(showsFocus("frames"), false, "a stage workspace has no shot picker");
  const ctx = epCtx();
  const centre = renderEpProd(ctx, { epFocus: "all" }, { stage: LEGACY_EPISODE_CENTRE });
  assert.ok(!centre.includes("data-ep-focus"), "no dead chips on the centre header");
  // and it is still the same five filters — nothing was dropped
  assert.deepEqual(FOCUS_FILTERS.map((f) => f[0]), ["all", "image", "video", "audio", "failed"]);
});

test("the shot picker offers the five filters and honours them", () => {
  const m = {
    empty: false,
    episodes: [{ episodeId: "ep1", code: "EP01", title: "EP01 迷雾入城", active: true }],
    scenes: [{
      sceneId: "s1",
      title: "S01",
      shots: [
        { shotId: "a", seq: 1, title: "有画面", hasImage: true, hasVideo: true, approved: false },
        { shotId: "b", seq: 2, title: "缺画面", hasImage: false, hasVideo: false, approved: false },
      ],
    }],
    unassigned: [],
    unassignedTotal: 0,
    focus: "image",
    all: [],
  };
  const place = { scene: m.scenes[0], shot: m.scenes[0].shots[1], shots: m.scenes[0].shots };
  const html = renderShotSelect({}, { ssOpen: "shot" }, m, place);
  for (const [k] of FOCUS_FILTERS) assert.ok(html.includes(`data-ss-focus="${k}"`), `${k} is offered`);
  // focus `image` means 「还缺图片」 — so only the shot WITHOUT one is listed…
  assert.ok(html.includes(`data-id="b"`));
  assert.ok(!html.includes(`data-id="a"`));
  // …and the ones held back are COUNTED rather than silently dropped
  assert.ok(/1 个不在聚焦内/.test(html));
});

test("picking a SCENE honours the focus filter when it chooses that scene's shot", () => {
  // codex review round 2 (TASK-066): taking `pool[0]` blindly could select a shot the
  // picker does not list under the current focus — the creator would be standing on
  // something absent from the list they just used.
  const shots = [
    { shotId: "a", seq: 1, title: "有画面", hasImage: true, hasVideo: false, approved: false },
    { shotId: "b", seq: 2, title: "缺画面", hasImage: false, hasVideo: false, approved: false },
  ];
  const m = {
    empty: false,
    episodes: [{ episodeId: "ep1", code: "EP01", title: "EP01", active: true }],
    scenes: [{ sceneId: "s1", title: "S01", shots }],
    unassigned: [], unassignedTotal: 0, focus: "image", all: [],
  };
  const place = { scene: null, shot: null, shots: [] };
  const picked = [];
  // a minimal root: capture the handler `bindShotSelect` attaches to the scene row
  let onScenePick = null;
  const root = {
    querySelectorAll: (q) => (q === "[data-ss-pick]"
      ? [{ dataset: { ssPick: "scene", id: "s1" }, set onclick(f) { onScenePick = f; } }]
      : []),
    querySelector: () => null,
  };
  bindShotSelect(root, {}, {}, () => {}, { selectShot: (id) => picked.push(id), m, place });
  onScenePick({ stopPropagation() {} });
  // focus `image` means 「还缺图片」 → shot "b", NOT pool[0] which is "a"
  assert.deepEqual(picked, ["b"]);
});

/* ========================================================================= */
/* 2b · a graph node opens that object's OPERATING panel                      */
/* ========================================================================= */

const node = (o) => ({ type: "asset", kind: "shotImage", shotId: null, chainKey: null, ...o });

test("画面 / 视频 / Prompt / 生成 / 参考 nodes each open their own panel", () => {
  assert.deepEqual(inspectFromNode(node({ kind: "shotImage", shotId: "s1" })), { kind: "image", shotId: "s1" });
  assert.deepEqual(inspectFromNode(node({ kind: "shotVideo", shotId: "s1" })), { kind: "video", shotId: "s1" });
  assert.deepEqual(inspectFromNode(node({ kind: "dialogue", shotId: "s1" })), { kind: "audio", shotId: "s1" });
  assert.deepEqual(
    inspectFromNode({ type: "prompt", kind: "video", shotId: "s1" }),
    { kind: "prompt", shotId: "s1", genKind: "video" },
  );
  assert.deepEqual(
    inspectFromNode({ type: "generation", kind: "image", shotId: "s1" }),
    { kind: "generation", shotId: "s1", genKind: "image" },
  );
  assert.deepEqual(inspectFromNode({ type: "shot", shotId: "s1" }), { kind: "shot", shotId: "s1" });
});

test("a Reference takes its shot from the RECORDS that use it, not from the cursor", () => {
  const ref = node({ kind: "characterRef", shotId: null, chainKey: "ref-char-1-1" });
  // a shot that BINDS it is the strongest evidence
  assert.deepEqual(
    inspectFromNode(ref, { boundByShots: [{ shotId: "bound" }], usedBy: [{ shotId: "used" }] }, "cursor"),
    { kind: "reference", shotId: "bound", refKey: "ref-char-1-1" },
  );
  // then a generation that consumed it
  assert.deepEqual(
    inspectFromNode(ref, { boundByShots: [], usedBy: [{ shotId: "used" }] }, "cursor"),
    { kind: "reference", shotId: "used", refKey: "ref-char-1-1" },
  );
  // only then wherever the creator is standing
  assert.deepEqual(
    inspectFromNode(ref, { boundByShots: [], usedBy: [] }, "cursor"),
    { kind: "reference", shotId: "cursor", refKey: "ref-char-1-1" },
  );
  // and with no shot anywhere, NO panel is invented
  assert.equal(inspectFromNode(ref, { boundByShots: [], usedBy: [] }, null), null);
  // a reference with no chain key cannot be addressed by the picker
  assert.equal(inspectFromNode(node({ kind: "characterRef", chainKey: null }), null, "cursor"), null);
});

test("nodes with no per-shot panel keep the read-only provenance body", () => {
  // Guessing a shot for any of these would point the creator's next WRITE at an
  // object the records never connected to it.
  for (const n of [
    { type: "script" }, { type: "scene" }, { type: "canon" },
    { type: "skillRun" }, { type: "proposal" }, { type: "review", shotId: "s1" },
    node({ kind: "final", shotId: null }),
    node({ kind: "ambience", shotId: null }),
    node({ kind: "bgm", shotId: null }),
    node({ kind: "unknown", shotId: null }),
    { type: "generation", kind: "render", shotId: null }, // an episode render
    { type: "prompt", kind: "image", shotId: null },
  ]) {
    assert.equal(inspectFromNode(n, null, "cursor"), null, JSON.stringify(n));
  }
  assert.equal(inspectFromNode(null), null);
  assert.equal(inspectFromNode("nope"), null);
});

/* ========================================================================= */
/* 2c · render and bind must agree about WHAT is being operated on            */
/* ========================================================================= */

/** The REAL `inspectorTarget`, on the paths that need no read model.
 *
 *  These three cases are decided before `inspectorTarget` ever consults
 *  `inspectorModel` (a node with no derivable panel, and no node at all), so an
 *  empty production document is enough and nothing here is stubbed away. The
 *  derivation itself is covered by the `inspectFromNode` tests above, and the
 *  derived path end-to-end by the browser acceptance run. */
function targetOf(ui, node) {
  return inspectorTarget({
    prodData: () => ({ production: { activeEpisodeId: "ep1", episodes: [] }, draftShots: [] }),
    episode: { referencesOfShot: () => [] },
    shot: { stage: () => "todo-design", review: () => null },
  }, ui, node);
}

test("a node with no operating panel leaves the column read-only, never on the old shot's panel", () => {
  const ui = { inspect: { kind: "image", shotId: "A" }, selectedShotId: "A" };
  // a scene node has no per-shot panel → read-only provenance, and the sel it
  // reports back is the shell's own (nothing derived to operate on)
  const t = targetOf(ui, { node: { type: "scene", sceneId: "sc1" } });
  assert.equal(t.mode, "node");
  assert.equal(t.sel.shotId, "A", "the fallback is the creator's own position");
});

test("with NO node the column operates on the shell's own selection", () => {
  const ui = { inspect: { kind: "video", shotId: "A" }, selectedShotId: "A" };
  const t = targetOf(ui, null);
  assert.equal(t.mode, "own");
  assert.deepEqual([t.sel.kind, t.sel.shotId], ["video", "A"]);
});

test("an explicit kind:node selection stays read-only even with no graph node", () => {
  const ui = { inspect: { kind: "node", shotId: null }, selectedShotId: null };
  assert.equal(targetOf(ui, null).mode, "node");
});

test("inspectFromNode never returns the shot the creator is STANDING on for another shot's media", () => {
  // The wrong-target write codex found (round 1) was possible because the derived
  // selection was render-local. The derivation itself must name shot B, not the
  // cursor's shot A — that is what makes one shared target correct.
  const d = inspectFromNode(node({ kind: "shotVideo", shotId: "B" }), null, "A");
  assert.deepEqual(d, { kind: "video", shotId: "B" });
  // …and a VIDEO prompt node must derive genKind video, or 保存 would write the
  // IMAGE prompt of the same shot
  assert.equal(inspectFromNode({ type: "prompt", kind: "video", shotId: "B" }).genKind, "video");
  assert.equal(inspectFromNode({ type: "prompt", kind: "image", shotId: "B" }).genKind, "image");
  assert.equal(inspectFromNode({ type: "generation", kind: "video", shotId: "B" }).genKind, "video");
});

/* ========================================================================= */
/* 3 · the chain is complete, and nothing is invented                          */
/* ========================================================================= */

/** The real shape 夜班沉默 has on disk: a paid image route recorded its result as
 *  the slot's FIRST FRAME and never appended it to the image chain, and the video
 *  was generated from it. Reduced to the minimum that reproduces it. */
function realish() {
  return {
    production: {
      activeEpisodeId: "ep1",
      episodes: [{
        episodeId: "ep1", title: "EP01", basedOn: { outline: 1 },
        scenes: [{ sceneId: "sc1", title: "S01 酒吧", shotIds: ["s1"] }],
      }],
      characters: [{ characterId: "c1", name: "林晚", referenceAssetIds: ["a-ref-c"], activeReferenceAssetId: "a-ref-c" }],
      locations: [{ locationId: "l1", name: "暗夜酒吧", referenceAssetIds: ["a-ref-l"], activeReferenceAssetId: "a-ref-l" }],
      shotProduction: {
        references: {},
        reviews: { s1: { approved: true, assetId: "a-vid", approvedAt: "2026-08-12T05:05:19.565Z", note: "" } },
      },
    },
    draftShots: [{ shotId: "s1", sequence: 1, title: "招牌 · 雨夜", slot: "v1-1" }],
    scripts: { ep1: { active: 1, versions: [{ v: 1, content: "他不会来了。" }] } },
    assets: {
      images: {
        "ref-char-c1-1": { current: 1, history: [{ assetId: "a-ref-c", version: 1, url: "/u/ref-c.png", origin: "upload" }] },
        "ref-loc-l1-1": { current: 1, history: [{ assetId: "a-ref-l", version: 1, url: "/u/ref-l.png", origin: "upload" }] },
      },
      videos: {
        "v1-1": { current: 1, history: [{ assetId: "a-vid", version: 1, url: "/u/shot01.mp4", origin: "paid-video", creativeShotId: "s1" }] },
      },
      audio: {},
      // the image that produced the video lives ONLY here
      firstFrames: {
        "v1-1": { assetId: "a-img", slot_id: "v1-1", version: 1, url: "/u/shot01.jpg", origin: "paid-image", creativeShotId: "s1", storageState: "local" },
      },
      finals: [],
    },
    generations: [
      { generationId: "g-img", type: "image", targetType: "shot", targetId: "s1", status: "success",
        provider: "chatgpt-manual", referenceAssetIds: ["a-ref-c", "a-ref-l"], inputAssetIds: [],
        resultAssetIds: ["a-img"], promptSnapshot: "电影感近景", createdAt: "2026-08-12T04:00:00Z" },
      { generationId: "g-vid", type: "video", targetType: "shot", targetId: "s1", status: "success",
        provider: "gemini-manual", referenceAssetIds: [], inputAssetIds: ["a-img"],
        resultAssetIds: ["a-vid"], promptSnapshot: "缓慢推镜", createdAt: "2026-08-12T05:00:00Z" },
    ],
    timelines: {},
    skillRuns: [],
  };
}

test("the whole real chain is derivable: canon → script → scene → shot → refs → image → video → 审片", () => {
  const g = buildProvenanceGraph(realish());
  const at = (id) => g.nodes.get(id);
  const rank = (id) => at(id).rank;
  const has = (from, to, kind) => g.edges.some((e) => e.from === from && e.to === to && e.kind === kind);

  const canon = nodeIds.canon("ep1");
  const script = nodeIds.script("ep1");
  const scene = nodeIds.scene("sc1");
  const shot = nodeIds.shot("s1");
  const img = nodeIds.asset("a-img");
  const vid = nodeIds.asset("a-vid");

  // the spine
  assert.ok(has(canon, script, "baseline"));
  assert.ok(has(script, scene, "scene"));
  assert.ok(has(scene, shot, "shot"));
  // the references the image generation PROVES it used — not dropped
  assert.ok(has(nodeIds.asset("a-ref-c"), nodeIds.generation("g-img"), "reference"));
  assert.ok(has(nodeIds.asset("a-ref-l"), nodeIds.generation("g-img"), "reference"));
  // the image production chain
  assert.ok(has(nodeIds.prompt("g-img"), nodeIds.generation("g-img"), "prompt"));
  assert.ok(has(nodeIds.generation("g-img"), img, "result"));
  // the video's source image is the SAME asset, and it is real media
  assert.ok(has(img, nodeIds.generation("g-vid"), "input"));
  assert.ok(has(nodeIds.prompt("g-vid"), nodeIds.generation("g-vid"), "prompt"));
  assert.ok(has(nodeIds.generation("g-vid"), vid, "result"));
  // …and the creator's decision closes it
  assert.ok(has(vid, nodeIds.review("s1"), "review"));

  // left → right, with no two chain steps sharing a column
  assert.ok(rank(canon) < rank(script));
  assert.ok(rank(script) < rank(scene));
  assert.ok(rank(scene) < rank(shot));
  assert.ok(rank(shot) < rank(nodeIds.prompt("g-img")));
  assert.ok(rank(nodeIds.prompt("g-img")) < rank(nodeIds.generation("g-img")));
  assert.ok(rank(nodeIds.generation("g-img")) < rank(img));
  assert.ok(rank(img) < rank(nodeIds.prompt("g-vid")));
  assert.ok(rank(nodeIds.generation("g-vid")) < rank(vid));
  assert.ok(rank(vid) < rank(nodeIds.review("s1")));
  assert.deepEqual(g.warnings, [], "nothing about this data is unprovable");
});

test("a first frame recorded outside the chain is real media, not 「已删除」", () => {
  // THE DEFECT: walking only the media chains left this image absent, so the
  // video's own recorded input resolved to a missing node and the image half of
  // the chain read as severed — with the file sitting on disk the whole time.
  const g = buildProvenanceGraph(realish());
  const img = g.nodes.get(nodeIds.asset("a-img"));
  assert.equal(img.missing, false);
  assert.equal(img.url, "/u/shot01.jpg");
  assert.equal(img.kind, "shotImage");
  assert.equal(img.version, 1);
  assert.equal(img.origin, "paid-image");
  // it is NOT claimed to be the chain's selected version — it is not in the chain
  assert.equal(img.active, false);
  // and it still belongs to its shot, so an episode scope keeps it
  assert.equal(img.shotId, "s1");
  assert.equal(img.episodeId, "ep1");
  const scoped = scopeGraph(g, { kind: "episode", id: "ep1" });
  assert.ok(scoped.nodes.has(nodeIds.asset("a-img")));
});

test("a chain record always wins over a first-frame copy of the same asset", () => {
  // The same assetId can legitimately appear in both (「用作视频首帧」 copies the
  // chain ref). The chain is the authority on版本 and on which one is ACTIVE.
  const src = realish();
  src.assets.images["v1-1"] = {
    current: 3,
    history: [{ assetId: "a-img", version: 3, url: "/u/chain.jpg", origin: "manual", creativeShotId: "s1" }],
  };
  const g = buildProvenanceGraph(src);
  const img = g.nodes.get(nodeIds.asset("a-img"));
  assert.equal(img.version, 3, "the chain's version, not the first-frame copy's");
  assert.equal(img.url, "/u/chain.jpg");
  assert.equal(img.active, true, "the chain says it is current, so it is");
});

test("審片通过 is a real node bound to ONE take, and says what it approved", () => {
  const g = buildProvenanceGraph(realish());
  const rv = g.nodes.get(nodeIds.review("s1"));
  assert.equal(rv.type, "review");
  assert.equal(rv.kindLabel, "审片通过");
  assert.equal(rv.assetId, "a-vid");
  assert.equal(rv.shotId, "s1");
  assert.equal(rv.episodeId, "ep1");
  assert.equal(rv.sceneId, "sc1");
  const story = explainNode(g, rv.id);
  assert.equal(story.provenance, "authored", "a decision is neither generated nor imported");
  assert.equal(story.approved.id, nodeIds.asset("a-vid"));
  // and the take itself can see its approval
  assert.equal(explainNode(g, nodeIds.asset("a-vid")).approval.id, rv.id);
  // the collapsed shot row must not hide it
  assert.equal(shotGroups(g, realish().production, "sc1")[0].approved, true);
});

test("an approval naming media the registry no longer holds is reported, never redrawn", () => {
  const src = realish();
  src.production.shotProduction.reviews.s1.assetId = "a-gone";
  const g = buildProvenanceGraph(src);
  assert.ok(!g.nodes.has(nodeIds.review("s1")), "no node without the take it approved");
  assert.ok(g.warnings.some((w) => w.kind === "danglingReview" && w.assetId === "a-gone"));
  // and the video that IS there did not inherit somebody else's approval
  assert.equal(explainNode(g, nodeIds.asset("a-vid")).approval, null);
  assert.equal(shotGroups(g, src.production, "sc1")[0].approved, false);
});

test("an approval pointing at ANOTHER shot's take is refused, not redrawn onto it", () => {
  // codex review round 2: existence of the asset is not enough. A stale or corrupt
  // record naming another shot's take would render that take as 已通过 for a shot
  // nobody reviewed it for — a fabricated human decision, which is worse than none.
  const src = realish();
  src.production.episodes[0].scenes[0].shotIds.push("s2");
  src.draftShots.push({ shotId: "s2", sequence: 2, title: "吧台", slot: "v1-2" });
  // s2's approval names s1's video
  src.production.shotProduction.reviews.s2 = {
    approved: true, assetId: "a-vid", approvedAt: "2026-08-12T06:00:00Z", note: "",
  };
  const g = buildProvenanceGraph(src);
  assert.ok(g.nodes.has(nodeIds.review("s1")), "s1's own, consistent approval still stands");
  assert.ok(!g.nodes.has(nodeIds.review("s2")), "s2 gets NO approval node from s1's take");
  const w = g.warnings.find((x) => x.kind === "reviewShotMismatch");
  assert.ok(w, "the contradiction is reported");
  assert.equal(w.shotId, "s2");
  assert.equal(w.assetId, "a-vid");
  assert.equal(w.assetShotId, "s1", "…and says whose take it really is");
  // the take carries exactly ONE approval — s1's
  const approvals = g.edges.filter((e) => e.kind === "review" && e.from === nodeIds.asset("a-vid"));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].to, nodeIds.review("s1"));
  assert.equal(shotGroups(g, src.production, "sc1").find((x) => x.shotId === "s2").approved, false);
});

test("an approval for a take whose own shot is UNKNOWN is refused, not assumed", () => {
  // A record that cannot be checked is not "consistent by absence" — the same rule
  // the skillRun context check applies.
  const src = realish();
  delete src.assets.videos["v1-1"].history[0].creativeShotId;
  // …and no generation produced it either, so nothing can resolve its shot
  src.generations = src.generations.filter((x) => x.generationId !== "g-vid");
  const g = buildProvenanceGraph(src);
  assert.equal(g.nodes.get(nodeIds.asset("a-vid")).shotId, null, "the take's shot is genuinely unknown");
  assert.ok(!g.nodes.has(nodeIds.review("s1")));
  assert.ok(g.warnings.some((w) => w.kind === "reviewShotMismatch" && w.assetShotId === null));
});

test("no review record ⇒ no review node — 生成成功 != 镜头完成", () => {
  const src = realish();
  src.production.shotProduction.reviews = {};
  const g = buildProvenanceGraph(src);
  assert.ok(!g.nodes.has(nodeIds.review("s1")));
  assert.equal(explainNode(g, nodeIds.asset("a-vid")).approval, null);
  assert.deepEqual(g.warnings, []);
});

test("an approval survives filtering with its take, and only with its take", () => {
  const g = buildProvenanceGraph(realish());
  const scoped = scopeGraph(g, { kind: "episode", id: "ep1" });
  const rv = nodeIds.review("s1");
  assert.ok(filterGraph(scoped, "all").nodes.has(rv));
  assert.ok(filterGraph(scoped, "video").nodes.has(rv), "the take is showing, so its approval is");
  assert.ok(!filterGraph(scoped, "image").nodes.has(rv), "a frame nobody reviewed must not wear 已通过");
  assert.ok(!filterGraph(scoped, "audio").nodes.has(rv));
});

/* ========================================================================= */
/* TASK-071 · 进入剧集制作先落在分镜，定好之后才是逐镜制作                      */
/* ========================================================================= */

test("「进入剧集制作」lands on 分镜 until the shot list exists", () => {
  // 产品 2026-08-13：「点击进入该剧的剧集制作就要有分镜的生成…定好分镜之后再对各个分镜
  // 做详细制作」。An episode with no draft has nothing to produce yet — the 制作台 would
  // open on 「先选一个镜头」 with no shots to select.
  // TASK-073 §1.1: same rule, targets moved onto the new pages via the 落点表.
  assert.equal(episodeEntryModule(false), "storyboard");
  assert.equal(episodeEntryModule(true), "shotwork", "…and ⑧ 镜头制作 is where per-shot work happens");
  // both targets are real pages of this space, so neither landing can be a dead end
  assert.ok(EPISODE_MODULES.includes("storyboard"));
  assert.ok(EPISODE_MODULES.includes("shotwork"));
});

test("the entry counts THIS episode's shots, not the project's (codex round 2, P1)", () => {
  // The failure this pins: EP01 has shots, EP02 has none. Asking whether the
  // project-wide `draftShots` list is empty answered 「这个作品有没有分镜」, so entering
  // the empty EP02 landed on the 制作台 — 「先选一个镜头」 with no shots for that
  // episode, which is the dead end the rule exists to avoid.
  const prod = pdoc.createProduction(null);
  const ep1 = prod.episodes[0];
  const ep2 = pdoc.addEpisode(prod, "EP02");
  const sc1 = pdoc.addScene(prod, ep1.episodeId, "S01");
  pdoc.assignShot(prod, sc1.sceneId, "sh-1");
  const draft = [{ shotId: "sh-1", sequence: 1, title: "有分镜的那一集" }];

  const shotsOf = (episodeId) => {
    const v = pdoc.episodeView(prod, episodeId, draft);
    return v ? v.scenes.reduce((n, sc) => n + sc.shots.filter((x) => !x.dangling).length, 0) : 0;
  };
  assert.equal(shotsOf(ep1.episodeId), 1);
  assert.equal(shotsOf(ep2.episodeId), 0, "EP02 has none of its own");
  assert.equal(episodeEntryModule(shotsOf(ep1.episodeId) > 0), "shotwork");
  assert.equal(episodeEntryModule(shotsOf(ep2.episodeId) > 0), "storyboard",
    "…so entering EP02 must land on 分镜, even though the project has shots elsewhere");
  // a DANGLING reference (a scene naming a shot the draft no longer holds) is not a
  // shot: an episode whose only shotIds dangle still has nothing to produce
  const sc2 = pdoc.addScene(prod, ep2.episodeId, "S01");
  pdoc.assignShot(prod, sc2.sceneId, "sh-gone");
  assert.equal(shotsOf(ep2.episodeId), 0);
  assert.equal(episodeEntryModule(shotsOf(ep2.episodeId) > 0), "storyboard");
});

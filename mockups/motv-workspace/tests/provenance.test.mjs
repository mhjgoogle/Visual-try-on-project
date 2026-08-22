// Generation Provenance Graph (TASK-054) — the derived read model behind the
// Workflow page. These cover the 15 behaviours the spec names, and they exist
// mainly to defend ONE property: the graph never claims a link that the records
// do not prove, and never hides one they do.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProvenanceGraph,
  scopeGraph,
  upstreamOf,
  downstreamOf,
  traceOf,
  searchGraph,
  explainNode,
  sceneGroups,
  shotGroups,
  nodeIds,
} from "../src/workflow/provenance.js";

/* -------------------------------------------------------------------------- */
/* fixture                                                                     */
/* -------------------------------------------------------------------------- */

const A = (assetId, over = {}) => ({ assetId, url: `blob:${assetId}`, origin: "paid-image", storageState: "local", ...over });

/** Two episodes; EP01 has one scene with two shots, EP02 has its own shot, so
 *  "does episode filtering leak?" is answerable. */
function fixture() {
  const production = {
    activeEpisodeId: "ep1",
    characters: [
      { characterId: "c1", name: "林晚", referenceAssetIds: ["ref-lin-1", "ref-lin-3"],
        states: [{ stateId: "cs1", name: "黑化", overrides: { referenceAssetIds: ["ref-lin-dark"] } }] },
    ],
    locations: [
      { locationId: "l1", name: "暗夜酒吧", referenceAssetIds: ["ref-bar-2"],
        states: [{ stateId: "ls1", name: "夜", overrides: { referenceAssetIds: ["ref-bar-night"] } }] },
    ],
    episodes: [
      { episodeId: "ep1", title: "EP01 迷雾入城", bgmAssetId: "bgm-1",
        scenes: [{ sceneId: "sc1", title: "Scene03 打烊的酒吧", shotIds: ["shot3", "shot4"], ambienceAssetId: "amb-1" }] },
      { episodeId: "ep2", title: "EP02", scenes: [{ sceneId: "sc9", title: "Scene01", shotIds: ["shot9"] }] },
    ],
  };
  const draftShots = [
    { shotId: "shot3", sequence: 3, title: "吧台独坐", slot: "v1-3" },
    { shotId: "shot4", sequence: 4, title: "推门离开", slot: "v1-4" },
    { shotId: "shot9", sequence: 9, title: "另一集的镜头", slot: "v1-9" },
  ];
  const assets = {
    images: {
      "ref-c1": { current: 3, history: [A("ref-lin-1", { origin: "upload", version: 1 }), A("ref-lin-3", { origin: "upload", version: 3 })] },
      "ref-l1": { current: 2, history: [A("ref-bar-2", { origin: "upload", version: 2 })] },
      "ref-c1s": { current: 1, history: [A("ref-lin-dark", { origin: "upload", version: 1 })] },
      "ref-l1s": { current: 1, history: [A("ref-bar-night", { origin: "upload", version: 1 })] },
      "v1-3": { current: 3, history: [
        A("img3-v1", { version: 1, origin: "upload", creativeShotId: "shot3" }),
        A("img3-v2", { version: 2, creativeShotId: "shot3" }),
        A("img3-v3", { version: 3, creativeShotId: "shot3" }),
      ] },
      "v1-9": { current: 1, history: [A("img9-v1", { version: 1, creativeShotId: "shot9" })] },
      // a plain import that belongs to nothing: no generation, no prompt
      "loose": { current: 1, history: [A("import-1", { version: 1, origin: "upload" })] },
    },
    videos: {
      "v1-3": { current: 2, history: [
        A("vid3-v1", { version: 1, origin: "paid-video", creativeShotId: "shot3" }),
        A("vid3-v2", { version: 2, origin: "paid-video", creativeShotId: "shot3" }),
      ] },
      // a video with NO generation record — only a recorded first frame
      "v1-4": { current: 1, history: [A("vid4-v1", { version: 1, origin: "upload", creativeShotId: "shot4" })] },
    },
    audio: {
      "voice-v1-3": { current: 1, history: [A("dlg3-v1", { version: 1, origin: "tts", creativeShotId: "shot3" })] },
      "ambience-sc1": { current: 1, history: [A("amb-1", { version: 1, origin: "upload" })] },
      "music-ep1": { current: 1, history: [A("bgm-1", { version: 1, origin: "upload" })] },
    },
    firstFrames: {
      "v1-3": { assetId: "img3-v3", slot_id: "v1-3", creativeShotId: "shot3" },
      "v1-4": { assetId: "img4-gone", slot_id: "v1-4", creativeShotId: "shot4" },
    },
    finals: [A("final-1", { origin: "compose" })],
  };
  const generations = [
    // 1 · image: prompt + two references → generation → image v2
    { generationId: "g-img2", type: "image", targetType: "shot", targetId: "shot3",
      inputAssetIds: [], referenceAssetIds: ["ref-lin-1", "ref-bar-2"],
      promptSnapshot: "电影感近景，林晚站在吧台后", provider: "chatgpt-manual", model: null,
      status: "success", resultAssetIds: ["img3-v2"], createdAt: "2026-08-04T10:00:00.000Z" },
    // 2 · a FAILED attempt that produced nothing — must stay visible
    { generationId: "g-img-fail", type: "image", targetType: "shot", targetId: "shot3",
      inputAssetIds: [], referenceAssetIds: ["ref-lin-1"],
      promptSnapshot: "更冷的色温", provider: "chatgpt-manual",
      status: "failed", resultAssetIds: [], createdAt: "2026-08-04T10:05:00.000Z" },
    // 3 · image v3, with the state reference
    { generationId: "g-img3", type: "image", targetType: "shot", targetId: "shot3",
      inputAssetIds: [], referenceAssetIds: ["ref-lin-dark", "ref-bar-night"],
      promptSnapshot: "收紧构图，加冷侧光", provider: "chatgpt-manual",
      status: "success", resultAssetIds: ["img3-v3"], createdAt: "2026-08-04T10:10:00.000Z" },
    // 4 · video v1 from image v2 — NOT from the currently-active v3
    { generationId: "g-vid1", type: "video", targetType: "shot", targetId: "shot3",
      inputAssetIds: ["img3-v2"], referenceAssetIds: [],
      promptSnapshot: "缓慢推近", provider: "gemini-manual",
      status: "success", resultAssetIds: ["vid3-v1"], createdAt: "2026-08-04T11:00:00.000Z" },
    // 5 · video v2 from image v3 — two variants, two different sources
    { generationId: "g-vid2", type: "video", targetType: "shot", targetId: "shot3",
      inputAssetIds: ["img3-v3"], referenceAssetIds: [],
      promptSnapshot: "手持轻微晃动", provider: "gemini-manual",
      status: "success", resultAssetIds: ["vid3-v2"], createdAt: "2026-08-04T11:30:00.000Z" },
    // 6 · dialogue
    { generationId: "g-dlg", type: "audio", targetType: "shot", targetId: "shot3",
      promptSnapshot: "【台词】你还记得那天吗", provider: "piper-local",
      status: "success", resultAssetIds: ["dlg3-v1"], createdAt: "2026-08-04T12:00:00.000Z" },
    // 7 · another episode's work, so scoping has something to leak
    { generationId: "g-ep2", type: "image", targetType: "shot", targetId: "shot9",
      promptSnapshot: "另一集", provider: "chatgpt-manual",
      status: "success", resultAssetIds: ["img9-v1"], createdAt: "2026-08-04T13:00:00.000Z" },
    // 8 · the render: clips in, final out. No prompt — settings are not a prompt.
    { generationId: "g-render", type: "render", targetType: null, targetId: null,
      inputAssetIds: ["vid3-v2", "dlg3-v1", "amb-1", "bgm-1"], referenceAssetIds: [],
      promptSnapshot: null, provider: "ffmpeg-local",
      parameters: { episodeId: "ep1", settings: { fps: 24 } },
      status: "success", resultAssetIds: ["final-1"], createdAt: "2026-08-04T14:00:00.000Z" },
  ];
  const timelines = {
    ep1: { clips: [
      { clipId: "cl1", trackType: "video", assetId: "vid3-v2" },
      { clipId: "cl2", trackType: "dialogue", assetId: "dlg3-v1" },
    ] },
  };
  return { assets, generations, production, timelines, draftShots };
}

const build = () => buildProvenanceGraph(fixture());
const aid = (x) => nodeIds.asset(x);
const gid = (x) => nodeIds.generation(x);
const pid = (x) => nodeIds.prompt(x);

/* -------------------------------------------------------------------------- */
/* 1-3 · the canonical chain                                                   */
/* -------------------------------------------------------------------------- */

test("1 · prompt -> generation -> asset is a real path", () => {
  const g = build();
  assert.ok(g.nodes.has(pid("g-img2")), "the frozen snapshot becomes a Prompt node");
  assert.ok(g.edges.some((e) => e.from === pid("g-img2") && e.to === gid("g-img2") && e.kind === "prompt"));
  assert.ok(g.edges.some((e) => e.from === gid("g-img2") && e.to === aid("img3-v2") && e.kind === "result"));
  const prompt = g.nodes.get(pid("g-img2"));
  assert.equal(prompt.kindLabel, "IMAGE PROMPT");
  assert.match(prompt.text, /电影感近景/);
});

test("2 · several references feed one image generation, each as its own edge", () => {
  const g = build();
  const refs = g.edges.filter((e) => e.to === gid("g-img2") && e.kind === "reference").map((e) => e.from);
  assert.deepEqual(refs.sort(), [aid("ref-bar-2"), aid("ref-lin-1")].sort());
  assert.equal(g.nodes.get(aid("ref-lin-1")).kind, "characterRef");
  assert.equal(g.nodes.get(aid("ref-bar-2")).kind, "locationRef");
  assert.equal(g.nodes.get(aid("ref-lin-1")).roleLabel, "林晚");
});

test("3 · the exact image version that produced the video is the one recorded", () => {
  const g = build();
  const inputs = g.edges.filter((e) => e.to === gid("g-vid2") && e.kind === "input").map((e) => e.from);
  assert.deepEqual(inputs, [aid("img3-v3")]);
  // and v2's video really did come from v2
  const older = g.edges.filter((e) => e.to === gid("g-vid1") && e.kind === "input").map((e) => e.from);
  assert.deepEqual(older, [aid("img3-v2")]);
});

/* -------------------------------------------------------------------------- */
/* 4-8 · honesty                                                               */
/* -------------------------------------------------------------------------- */

test("4 · two video variants keep two different source images", () => {
  const g = build();
  const srcOf = (video) => {
    const gen = g.edges.find((e) => e.kind === "result" && e.to === aid(video)).from;
    return g.edges.filter((e) => e.to === gen && e.kind === "input").map((e) => e.from);
  };
  assert.deepEqual(srcOf("vid3-v1"), [aid("img3-v2")]);
  assert.deepEqual(srcOf("vid3-v2"), [aid("img3-v3")]);
  assert.notDeepEqual(srcOf("vid3-v1"), srcOf("vid3-v2"));
});

test("5 · a failed generation stays in the graph, with its prompt", () => {
  const g = build();
  const n = g.nodes.get(gid("g-img-fail"));
  assert.ok(n, "a failed attempt is provenance, not noise");
  assert.equal(n.status, "failed");
  assert.ok(g.nodes.has(pid("g-img-fail")), "and the prompt that failed is still readable");
  assert.equal(g.edges.filter((e) => e.from === gid("g-img-fail") && e.kind === "result").length, 0);
});

test("6 · a plain import invents no prompt and no generation", () => {
  const g = build();
  const story = explainNode(g, aid("import-1"));
  assert.equal(story.provenance, "import");
  assert.equal(story.prompt, null);
  assert.equal(story.producedBy, null);
  assert.equal(story.references.length, 0);
});

test("7 · an import made through the manual-generation flow keeps its provenance", () => {
  // img3-v2's media record is a paid/manual import, but a Generation recorded
  // the launch — that record, not the origin string, decides the story
  const g = build();
  const story = explainNode(g, aid("img3-v2"));
  assert.equal(story.provenance, "generated");
  assert.equal(story.producedBy.generationId, "g-img2");
  assert.equal(story.prompt.text, "电影感近景，林晚站在吧台后");
  assert.equal(story.references.length, 2);
});

test("8 · an asset the registry no longer holds still appears, marked missing", () => {
  const src = fixture();
  // the generation still names it; the media record is gone
  delete src.assets.images["v1-3"].history[0]; // leaves a hole, not a record
  src.assets.images["v1-3"].history = src.assets.images["v1-3"].history.filter(Boolean);
  src.generations.push({
    generationId: "g-orphan", type: "video", targetId: "shot3",
    inputAssetIds: ["img-deleted"], promptSnapshot: "从一张已删除的图",
    provider: "gemini-manual", status: "success", resultAssetIds: [], createdAt: "z",
  });
  const g = buildProvenanceGraph(src);
  const n = g.nodes.get(aid("img-deleted"));
  assert.ok(n, "the chain must not silently end");
  assert.equal(n.missing, true);
  assert.equal(n.storageState, "deleted");
});

/* -------------------------------------------------------------------------- */
/* 9-11 · scoping and render                                                   */
/* -------------------------------------------------------------------------- */

test("9 · episode scope does not leak another episode's work", () => {
  const g = scopeGraph(build(), { kind: "episode", id: "ep1" });
  assert.ok(!g.nodes.has(aid("img9-v1")), "EP02's image must not appear in EP01");
  assert.ok(!g.nodes.has(gid("g-ep2")));
  assert.ok(g.nodes.has(aid("img3-v3")));
  // project-level references are pulled in only because an in-scope generation
  // proves it used them
  assert.ok(g.nodes.has(aid("ref-lin-1")));
  // the unattached import belongs to no episode and stays out
  assert.ok(!g.nodes.has(aid("import-1")));
});

test("10 · scene and shot scopes narrow to exactly their own lineage", () => {
  const full = build();
  const scene = scopeGraph(full, { kind: "scene", id: "sc1" });
  assert.ok(scene.nodes.has(aid("img3-v3")));
  assert.ok(!scene.nodes.has(aid("img9-v1")));

  const shot = scopeGraph(full, { kind: "shot", id: "shot3" });
  assert.ok(shot.nodes.has(aid("vid3-v2")));
  assert.ok(shot.nodes.has(gid("g-vid2")));
  assert.ok(!shot.nodes.has(aid("vid4-v1")), "shot04's video is not shot03's");
  // shot03's references still come along — the generation proves they were used
  assert.ok(shot.nodes.has(aid("ref-bar-2")));
});

test("11 · render lineage reaches the final from every clip asset", () => {
  const g = build();
  const up = upstreamOf(g, aid("final-1"));
  assert.ok(up.has(gid("g-render")));
  for (const clip of ["vid3-v2", "dlg3-v1", "amb-1", "bgm-1"]) {
    assert.ok(up.has(aid(clip)), `${clip} fed the render`);
  }
  // and through the video, all the way back to the reference images
  assert.ok(up.has(aid("img3-v3")));
  assert.ok(up.has(aid("ref-lin-dark")));
  assert.equal(g.nodes.get(aid("final-1")).kind, "final");
  assert.equal(g.nodes.get(gid("g-render")).kindLabel, "合成渲染");
  assert.equal(g.nodes.get(pid("g-render")), undefined, "render settings are not a prompt");
});

/* -------------------------------------------------------------------------- */
/* 12-15 · tracing, variants, states, unknowns                                 */
/* -------------------------------------------------------------------------- */

test("12 · upstream and downstream traces are exact", () => {
  const g = build();
  const up = upstreamOf(g, aid("vid3-v2"));
  assert.ok(up.has(gid("g-vid2")) && up.has(aid("img3-v3")) && up.has(gid("g-img3")) && up.has(aid("ref-lin-dark")));
  assert.ok(!up.has(aid("img3-v2")), "v2 is not upstream of the video built from v3");

  const down = downstreamOf(g, aid("img3-v3"));
  assert.ok(down.has(aid("vid3-v2")) && down.has(aid("final-1")));
  assert.ok(!down.has(aid("vid3-v1")), "v1 came from a different image");

  const trace = traceOf(g, aid("vid3-v2"), "full");
  assert.ok(trace.has(aid("vid3-v2")) && trace.has(aid("final-1")) && trace.has(aid("ref-bar-night")));
  const upOnly = traceOf(g, aid("vid3-v2"), "up");
  assert.ok(!upOnly.has(aid("final-1")));
});

test("13 · making a variant active does not rewrite history", () => {
  const src = fixture();
  src.assets.images["v1-3"].current = 1; // creator reverts to v1
  const g = buildProvenanceGraph(src);
  const inputs = g.edges.filter((e) => e.to === gid("g-vid2") && e.kind === "input").map((e) => e.from);
  assert.deepEqual(inputs, [aid("img3-v3")], "the video still came from v3");
  assert.equal(g.nodes.get(aid("img3-v1")).active, true);
  assert.equal(g.nodes.get(aid("img3-v3")).active, false);
});

test("a bible reference numbers by its position, and only the chosen one is active", () => {
  // every reference lives in its own single-version chain, so reading the media
  // version would print v1 for all of them and mark every one ACTIVE
  const g = build();
  const first = g.nodes.get(aid("ref-lin-1"));
  const third = g.nodes.get(aid("ref-lin-3"));
  assert.equal(first.version, 1);
  assert.equal(third.version, 2, "林晚's second listed reference");
  assert.equal(first.versionKind, "reference");
  assert.equal(first.active, false, "not the entity's chosen reference");
  const src = fixture();
  src.production.characters[0].activeReferenceAssetId = "ref-lin-3";
  const g2 = buildProvenanceGraph(src);
  assert.equal(g2.nodes.get(aid("ref-lin-3")).active, true);
  assert.equal(g2.nodes.get(aid("ref-lin-1")).active, false);
  // a shot image still uses its real media version
  assert.equal(g.nodes.get(aid("img3-v3")).versionKind, "media");
  assert.equal(g.nodes.get(aid("img3-v3")).version, 3);
});

test("14 · character and location STATE references keep their own identity", () => {
  const g = build();
  const dark = g.nodes.get(aid("ref-lin-dark"));
  assert.equal(dark.kind, "characterRef");
  assert.equal(dark.roleLabel, "林晚 · 黑化");
  assert.equal(dark.roleOwner.type, "characterState");
  const night = g.nodes.get(aid("ref-bar-night"));
  assert.equal(night.kind, "locationRef");
  assert.equal(night.roleLabel, "暗夜酒吧 · 夜");
});

test("15 · unproven links are reported honestly, never invented", () => {
  const g = build();
  // shot04's video has NO generation — only a recorded first frame, and that
  // frame's asset is itself gone. The graph shows the recorded link and marks
  // the missing end; it does not attach the shot's other media instead.
  const ff = g.edges.filter((e) => e.to === aid("vid4-v1"));
  assert.deepEqual(ff.map((e) => e.kind), ["firstFrame"]);
  assert.equal(ff[0].from, aid("img4-gone"));
  assert.equal(g.nodes.get(aid("img4-gone")).missing, true);
  const story = explainNode(g, aid("vid4-v1"));
  assert.equal(story.provenance, "import", "no generation produced it, so we do not claim one");
  assert.equal(story.prompt, null);
  // and a generation targeting an unknown shot is warned about, not hidden
  const src = fixture();
  src.generations.push({ generationId: "g-ghost", type: "image", targetId: "shot-gone", status: "success", resultAssetIds: [], createdAt: "z" });
  const g2 = buildProvenanceGraph(src);
  assert.ok(g2.warnings.some((w) => w.kind === "unknownTarget" && w.targetId === "shot-gone"));
  assert.ok(g2.nodes.has(gid("g-ghost")));
});

/* -------------------------------------------------------------------------- */
/* layout, grouping, search                                                    */
/* -------------------------------------------------------------------------- */

test("a slot's single recorded first frame is claimed by ONE version, the newest", () => {
  // `firstFrames[slot]` is slot-level, singular and overwritten at each launch,
  // so the only take it can describe is the newest one. Attaching it to all of
  // them would assert three imports came from one frame; attaching it to
  // whichever version is SELECTED would invent a source for an older take that
  // did not exist when that take was made.
  const src = fixture();
  src.assets.videos["v1-4"].history.push(
    A("vid4-v2", { version: 2, origin: "upload", creativeShotId: "shot4" }),
    A("vid4-v3", { version: 3, origin: "upload", creativeShotId: "shot4" }),
  );
  src.assets.videos["v1-4"].current = 2; // the creator selected an OLDER take
  src.assets.firstFrames["v1-4"] = { assetId: "img3-v3", slot_id: "v1-4", creativeShotId: "shot4" };
  const g = buildProvenanceGraph(src);
  const framed = g.edges.filter((e) => e.kind === "firstFrame").map((e) => e.to);
  assert.ok(framed.includes(aid("vid4-v3")), "the newest take is the one the record describes");
  assert.ok(!framed.includes(aid("vid4-v2")), "selecting an older take invents no source");
  assert.ok(!framed.includes(aid("vid4-v1")));
  assert.equal(explainNode(g, aid("vid4-v1")).firstFrame.length, 0);
  assert.equal(explainNode(g, aid("vid4-v1")).provenance, "import");
});

test("a first-frame link advances a column, so its wire can be drawn", () => {
  // the wires are drawn left→right only: same-column endpoints would silently
  // drop the one recorded link an imported video has
  const g = build();
  const frame = g.nodes.get(aid("img4-gone"));
  const video = g.nodes.get(aid("vid4-v1"));
  assert.ok(video.rank > frame.rank, `${video.rank} must be right of ${frame.rank}`);
});

test("layout ranks flow left to right: reference < prompt < gen < result < render", () => {
  const g = build();
  const r = (id) => g.nodes.get(id).rank;
  // The prompt gets its own column, IMMEDIATELY before the generation it drove.
  // Pinned as a relation, not as an absolute column number: since CP7 the
  // creative spine (script → scene → shot) occupies the columns to the left, so
  // an absolute pin here would only be re-recording how many spine columns
  // happen to exist in this fixture.
  assert.equal(r(aid("ref-lin-1")), 0, "a bible reference no shot binds starts the chain");
  assert.equal(r(gid("g-img2")) - r(pid("g-img2")), 1);
  assert.equal(r(aid("img3-v2")) - r(gid("g-img2")), 1);
  assert.equal(r(gid("g-vid1")) - r(pid("g-vid1")), 1);
  assert.ok(r(pid("g-vid1")) > r(aid("img3-v2")), "the video prompt sits right of its source frame");
  assert.ok(r(aid("ref-lin-1")) < r(gid("g-img2")));
  assert.ok(r(pid("g-img2")) < r(gid("g-img2")));
  assert.ok(r(gid("g-img2")) < r(aid("img3-v2")));
  assert.ok(r(aid("img3-v3")) < r(gid("g-vid2")));
  assert.ok(r(gid("g-vid2")) < r(aid("vid3-v2")));
  assert.ok(r(aid("vid3-v2")) < r(gid("g-render")));
  assert.ok(r(gid("g-render")) < r(aid("final-1")));
});

test("scene groups summarise exactly what expanding them shows", () => {
  const g = scopeGraph(build(), { kind: "episode", id: "ep1" });
  const groups = sceneGroups(g, fixture().production, "ep1");
  assert.equal(groups.length, 1);
  const sc = groups[0];
  assert.equal(sc.sceneId, "sc1");
  assert.equal(sc.shots, 2);
  assert.equal(sc.failed, 1, "the failed attempt is counted, not hidden");
  assert.equal(sc.images, g.order.filter((id) => {
    const n = g.nodes.get(id);
    return n.sceneId === "sc1" && n.type === "asset" && n.kind === "shotImage";
  }).length);

  const shotsIn = shotGroups(g, fixture().production, "sc1");
  assert.deepEqual(shotsIn.map((s) => s.shotId), ["shot3", "shot4"]);
  assert.equal(shotsIn[0].videos, 2);
});

test("search finds shots, people, versions, providers and prompt text", () => {
  const g = build();
  const hit = (q) => searchGraph(g, q);
  assert.ok(hit("shot 03").length > 0);
  assert.ok(hit("林晚").length > 0);
  assert.ok(hit("gemini").includes(gid("g-vid2")));
  assert.ok(hit("冷侧光").includes(pid("g-img3")));
  assert.ok(hit("g-render").includes(gid("g-render")));
  assert.deepEqual(hit(""), []);
});

test("a corrupt save cannot hang the layout or the walk", () => {
  const g = buildProvenanceGraph({
    assets: { images: { a: { current: 1, history: [null, A("x", { version: 1 })] } } },
    generations: [null, { generationId: "g", type: "image", resultAssetIds: ["x"], status: "success" }, { type: "image" }],
    production: { episodes: [{ episodeId: "e", scenes: [{ sceneId: "s", shotIds: ["nope"] }] }] },
    timelines: { e: { clips: [null, { assetId: "x", trackType: "video" }] } },
    draftShots: [null, { shotId: "sx" }],
  });
  assert.ok(g.nodes.has(aid("x")));
  assert.equal(g.nodes.get(gid("g")).status, "success");
  assert.deepEqual(searchGraph(g, "zzz"), []);
});


test("a scope keeps every proven input, not just the bible references", () => {
  // an in-scope generation whose input is a deleted asset (or a frame from
  // another scene) must still show that input: dropping it makes the
  // generation look sourceless, which the records do not say
  const src = fixture();
  src.generations.push({
    generationId: "g-cross", type: "video", targetType: "shot", targetId: "shot3",
    inputAssetIds: ["img9-v1", "img-deleted"], promptSnapshot: "跨场景素材",
    provider: "gemini-manual", status: "success", resultAssetIds: [], createdAt: "z",
  });
  const g = scopeGraph(buildProvenanceGraph(src), { kind: "shot", id: "shot3" });
  assert.ok(g.nodes.has(aid("img9-v1")), "another episode's frame really was used");
  assert.ok(g.nodes.has(aid("img-deleted")), "and the deleted one is still named");
  assert.equal(g.nodes.get(aid("img-deleted")).missing, true);
});

test("an inputless generation still gets its own PROMPT column", () => {
  // the wires are drawn forward-only; a prompt sharing a column with its
  // generation would silently lose the edge that explains it
  const g = build();
  // the invariant is the GAP, not the column number (see the layout test)
  assert.equal(
    g.nodes.get(gid("g-dlg")).rank - g.nodes.get(pid("g-dlg")).rank, 1,
    "no inputs, but the prompt still gets the column to its left",
  );
});

test("a missing asset is never given a guessed media type", () => {
  const src = fixture();
  src.generations.push(
    { generationId: "g-a", type: "image", targetId: "shot3", referenceAssetIds: ["ref-gone"],
      status: "success", resultAssetIds: [], createdAt: "z" },
    { generationId: "g-b", type: "video", targetId: "shot3", inputAssetIds: [],
      status: "success", resultAssetIds: ["vid-gone"], createdAt: "z" },
  );
  const g = buildProvenanceGraph(src);
  // nothing proves what a deleted REFERENCE was — do not call it a character
  assert.equal(g.nodes.get(aid("ref-gone")).kind, "unknown");
  assert.equal(g.nodes.get(aid("ref-gone")).kindLabel, "已删除的媒体");
  // but a video generation's result IS a video, and that the record does prove
  assert.equal(g.nodes.get(aid("vid-gone")).kind, "shotVideo");
});


test("a producer that froze NO inputs does not suppress the recorded first frame", () => {
  // "a Generation already says it, in full" is only true when that generation
  // actually recorded an input. One that produced the video but froze none
  // explains nothing about its source, so the slot-level record must still show.
  const src = fixture();
  src.generations.push({
    generationId: "g-noinput", type: "video", targetType: "shot", targetId: "shot4",
    inputAssetIds: [], referenceAssetIds: [], promptSnapshot: "无输入的重跑",
    provider: "gemini-manual", status: "success", resultAssetIds: ["vid4-v1"],
    createdAt: "2026-08-04T15:00:00.000Z",
  });
  const g = buildProvenanceGraph(src);
  const framed = g.edges.filter((e) => e.kind === "firstFrame" && e.to === aid("vid4-v1"));
  assert.equal(framed.length, 1, "the slot record is the only source evidence there is");
  assert.equal(framed[0].from, aid("img4-gone"));

  // but when the generation DID record an input, that stronger record wins alone
  src.generations[src.generations.length - 1].inputAssetIds = ["img3-v2"];
  const g2 = buildProvenanceGraph(src);
  assert.equal(g2.edges.filter((e) => e.kind === "firstFrame" && e.to === aid("vid4-v1")).length, 0);
  assert.deepEqual(
    g2.edges.filter((e) => e.kind === "input" && e.to === gid("g-noinput")).map((e) => e.from),
    [aid("img3-v2")],
  );
});

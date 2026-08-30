// Production domain document (checkpoint M6) — run via `node --test`,
//. Owned by the frontend suite (gate frontend tier + CI).
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
  // TASK-057: episodes additionally carry `beats` + the `basedOn` upstream
  // stamp, and the document carries the project-level canon (relationships /
  // world / revision counters) — all part of the durable round-trip.
  const noBeats = { plot: [], character: [], relationship: [], world: [] };
  const noStamp = { brief: 0, outline: 0, characters: 0, relationships: 0, world: 0 };
  const saved = {
    activeEpisodeId: "ep-x",
    episodes: [
      {
        episodeId: "ep-x", title: "上集", bgmAssetId: null,
        scenes: [{ sceneId: "scene-1", title: "大殿", shotIds: ["shot-a"], characterRefs: [], locationRef: null, ambienceAssetId: null, bgmAssetId: null }],
        beats: noBeats, basedOn: noStamp, archived: null,
      },
      { episodeId: "ep-mig-1", title: "第 1 集", scenes: [], bgmAssetId: null, beats: noBeats, basedOn: noStamp, archived: null },
    ],
    characters: [],
    locations: [],
    // TASK-095 §2.2 / 批次 4C 的道具。**保存出来的形状从此带 `props`**，与
    // ADR-0073 给 `stages` 定的规矩一致：老文档缺席合法（水合成 []、schema 放行），
    // 但存下去总是带上它 —— 否则「没有道具」会有「缺键」和「空数组」两个形状，
    // 而两个形状迟早在下游分叉（§2.5f 那条同一形状的老账）。
    props: [],
    relationships: [],
    world: { era: "", rules: "", society: "", regions: "", places: "", visualTone: "", atmosphere: "" },
    canon: { characters: 0, relationships: 0, world: 0 },
    // CP4: shot production state (review approvals + shared Reference
    // bindings) is part of the durable round-trip too.
    // ADR-0073 决策 8 adds `stages` — the ONLY persisted stage decision is 「跳过」,
    // and it round-trips like everything else here.
    shotProduction: { reviews: {}, references: {}, stages: {}, stageReviews: {} },
    // 加法字段（TASK-123 / ADR-0094）：每一镜的白膜。空表是真实状态 ——
    // 「这个项目还没做过白膜」，不是缺失。
    blocking: {},
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
  // Asserted field by field, NOT deep-equal on the whole object: a later
  // migration may legitimately add a field, and this test is about the v5→v6
  // default structure plus the v10 canon — not about the shape of every
  // checkpoint that follows.
  const p6 = res.doc.production;
  assert.equal(p6.activeEpisodeId, "ep-mig-1");
  assert.equal(p6.episodes.length, 1);
  assert.equal(p6.episodes[0].episodeId, "ep-mig-1");
  assert.equal(p6.episodes[0].title, "第 1 集");
  assert.deepEqual(p6.episodes[0].scenes, []);
  assert.equal(p6.episodes[0].bgmAssetId, null); // v9 adds the BGM ref
  // v10 adds the Arc beats + the upstream stamp. Both empty/zero: the versions
  // a legacy episode was built on were never recorded.
  assert.deepEqual(p6.episodes[0].beats, { plot: [], character: [], relationship: [], world: [] });
  assert.deepEqual(p6.episodes[0].basedOn, { brief: 0, outline: 0, characters: 0, relationships: 0, world: 0 });
  assert.deepEqual(p6.characters, []); // v6→v7 continues the chain with an empty bible
  assert.deepEqual(p6.locations, []);
  // v10 project-level canon, all empty — canon is never fabricated
  assert.deepEqual(p6.relationships, []);
  assert.deepEqual(p6.world, { era: "", rules: "", society: "", regions: "", places: "", visualTone: "", atmosphere: "" });
  assert.deepEqual(p6.canon, { characters: 0, relationships: 0, world: 0 });
  // deterministic: same input → identical output
  assert.deepEqual(migrateToCurrent(v5Doc()).doc, migrateToCurrent(v5Doc()).doc);
  // …and everything else is untouched (v8 moves the null scriptDoc away and
  // adds the empty story chain + per-episode scripts map)
  const { production: _p, story: _s, scripts: _sc, timelines: _tl, ...rest } = res.doc;
  assert.deepEqual(_tl, {}); // v9: empty timelines map
  assert.equal(_s.idea, "");
  assert.deepEqual(_s.versions, []);
  assert.deepEqual(_s.plans, []);
  assert.equal(_s.approved, 0);
  assert.equal(_s.confirmedPlan, 0);
  // v10: the Creative Brief starts as an EMPTY working draft with ZERO
  // revisions — a migration never mints a version the creator did not confirm
  assert.deepEqual(_s.brief, {
    draft: { genre: "", tone: "", form: "", episodeDuration: "", totalDuration: "", notes: "", targetEpisodes: null },
    versions: [],
    active: 0,
  });
  assert.deepEqual(_sc, {});
  // every v5 field survives verbatim. Checked field-by-field rather than by
  // deep-equal: a later checkpoint may add a top-level field of its own, and
  // that is not this test's subject.
  const expected = { ...v5Doc(), v: CANVAS_SCHEMA_VERSION };
  delete expected.scriptDoc; // null scriptDoc carries nothing durable
  for (const [k, v] of Object.entries(expected)) {
    assert.deepEqual(rest[k], v, `v5 field ${k} must survive the migration chain`);
  }
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

// --- TASK-105 / ADR-0084：套用流程模板的骨架 -------------------------------- //
//
// 这一族存在的理由很具体：不做这一步，从模板起步的项目和空项目**一模一样**，
// 「选模板」就是一个点了没反应的控件（codex 审查轮 3 的 blocking）。

test("applyFlowSeed 按 episodeCount 长出集数，并停在第 1 集", () => {
  const prod = pd.createProduction(null);
  assert.equal(prod.episodes.length, 1, "前提：全新文档只有一集");

  pd.applyFlowSeed(prod, { conventions: { episodeCount: 12 } });

  assert.equal(prod.episodes.length, 12);
  // 创作者要从头开始，不是从第 12 集开始 —— addEpisode 会把新集设为 active
  assert.equal(prod.activeEpisodeId, prod.episodes[0].episodeId);
  assert.equal(new Set(prod.episodes.map((e) => e.episodeId)).size, 12, "id 不重复");
});

test("已经不止一集的文档不被套用 —— 模板绝不覆盖已经写下的东西", () => {
  const prod = pd.createProduction(null);
  pd.addEpisode(prod, "创作者自己加的");
  const before = prod.episodes.map((e) => e.episodeId);

  pd.applyFlowSeed(prod, { conventions: { episodeCount: 12 } });

  assert.deepEqual(prod.episodes.map((e) => e.episodeId), before, "一集都不该多");
});

test("离谱或缺失的 episodeCount 一律当作没说", () => {
  for (const conventions of [
    {},
    { episodeCount: 0 },
    { episodeCount: -3 },
    { episodeCount: 1.5 },
    { episodeCount: "12" },
    { episodeCount: 1e9 },      // 一份写着十亿的模板不该让新建项目挂住
    { episodeCount: NaN },
  ]) {
    const prod = pd.createProduction(null);
    pd.applyFlowSeed(prod, { conventions });
    assert.equal(prod.episodes.length, 1, JSON.stringify(conventions));
  }
});

test("没有模板 / 模板形状不对时原样返回", () => {
  const prod = pd.createProduction(null);
  for (const flow of [null, undefined, "flow", 7, []]) {
    assert.equal(pd.applyFlowSeed(prod, flow), prod);
    assert.equal(prod.episodes.length, 1);
  }
});

test("episodeCount 为 1 时是一次空操作，不是「再加一集」", () => {
  const prod = pd.createProduction(null);
  pd.applyFlowSeed(prod, { conventions: { episodeCount: 1 } });
  assert.equal(prod.episodes.length, 1);
});

test("一集但已经有内容的文档也不被套用 —— 判据是「动过没有」，不是「几集」", () => {
  // 「集数 == 1」不够：创作者写了半天但仍然只有一集，同样满足它
  // （codex 审查轮 6 的 non-blocking）。
  const withScene = pd.createProduction(null);
  pd.addScene(withScene, withScene.episodes[0].episodeId, "第一场");
  pd.applyFlowSeed(withScene, { conventions: { episodeCount: 12 } });
  assert.equal(withScene.episodes.length, 1, "有场了就不该被模板接着长");

  const withCast = pd.createProduction(null);
  withCast.characters.push({ characterId: "c1", name: "林照" });
  pd.applyFlowSeed(withCast, { conventions: { episodeCount: 12 } });
  assert.equal(withCast.episodes.length, 1, "有角色了同理");
});

test("isUsableFlow：`{}` 是真值，但它不是一份能用的流程", () => {
  // 这条是 codex 审查轮 7 报出来的那个洞：`if (flow)` 会把 `{}` 当成加载成功，
  // 套用时静默 no-op，而自动保存照常把空白画布存下来 —— 与请求失败后果一样。
  assert.equal(pd.isUsableFlow({}), false);
  assert.equal(pd.isUsableFlow({ createdFrom: {} }), false);
  assert.equal(pd.isUsableFlow({ createdFrom: { flowId: "" } }), false);
  assert.equal(pd.isUsableFlow({ createdFrom: { flowId: "   " } }), false);
  assert.equal(pd.isUsableFlow({ createdFrom: "episode-from-scratch" }), false);
  assert.equal(pd.isUsableFlow(null), false);
  assert.equal(pd.isUsableFlow(undefined), false);
  assert.equal(pd.isUsableFlow("flow"), false);
  assert.equal(pd.isUsableFlow([]), false);

  // 后端真正写下的那种形状
  assert.equal(
    pd.isUsableFlow({
      createdFrom: { flowId: "episode-from-scratch", flowVersion: 1, flowDigest: "sha256:x" },
      conventions: { episodeCount: 12 },
    }),
    true,
  );
});

test("isUsableFlow 一次挡住四轮审查报出来的**每一种**拼法", () => {
  // 轮 4：请求失败折成 null / undefined
  // 轮 7：`{}` 是真值
  // 轮 8：`false` / `0` / `""` 是假值，绕过了「形状不对」那一支
  // 轮 8：`{createdFrom:{flowId:"x"}}` 有 id 但没东西可套
  //
  // 谓词只回答**一个**问题：这是不是一份落下来的、认得出身份的流程。
  // 不认识就是不认识 —— 调用方据此停用自动保存，而不需要认得这些拼法。
  for (const bad of [
    undefined, null, false, 0, "", "flow", [], {},
    { createdFrom: null },
    { createdFrom: {} },
    { createdFrom: { flowId: "" } },
    { createdFrom: { flowId: "  " } },
    { createdFrom: { flowVersion: 1 } },
    { conventions: { episodeCount: 12 } },   // 有内容但没身份
  ]) {
    assert.equal(pd.isUsableFlow(bad), false, JSON.stringify(bad));
  }

  // 轮 10 收紧之后，**三个字段一个不少**（ADR-0084 决策 5）：只有 flowId 的
  // 那种「被截断的 flow」也不算能用 —— 它能解除自动保存、套用出零内容，
  // 然后把空白画布存成这个项目的开局。
  assert.equal(pd.isUsableFlow({ createdFrom: { flowId: "x" } }), false);
  assert.equal(
    pd.isUsableFlow({ createdFrom: { flowId: "x", flowVersion: 1 } }),
    false,
  );
  assert.equal(
    pd.isUsableFlow({ createdFrom: { flowId: "x", flowDigest: "sha256:y" } }),
    false,
  );
  assert.equal(
    pd.isUsableFlow({ createdFrom: { flowId: "x", flowVersion: 0, flowDigest: "sha256:y" } }),
    false,
  );

  // 三个都齐**才**算能用。没有可套用的 conventions 是合法的 —— 一份只定义步骤的
  // 模板本来就不改变项目形状，而它的溯源已经落在 project.json 与 studio/flow.json。
  assert.equal(
    pd.isUsableFlow({ createdFrom: { flowId: "x", flowVersion: 1, flowDigest: "sha256:y" } }),
    true,
  );
});

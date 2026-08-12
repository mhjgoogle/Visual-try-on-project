// Checkpoint CP6 (ADR-0058 / TASK-061) — 本集制作 · 参考统筹 · 生成输入集合.
//
// What is pinned here:
//   1. a Scene shows the script text it came from — and REFUSES to guess when
//      it cannot locate it
//   2. a Scene shows its Shots, and a Shot shows its current picture + the
//      canonical References bound to it
//   3. the Reference Plan points at the reference CHAIN: ten shots sharing one
//      reference is ONE row, never ten copies
//   4. a "missing" reference row is a question — it creates nothing
//   5. the Generation Input Set records what a route CANNOT know as null,
//      never as a plausible-looking default
//   6. the manual route produces the SAME Generation shape as any other
//   7. the picker offers three entrances, and the temp upload still registers
import test from "node:test";
import assert from "node:assert/strict";

import { scriptSlices, episodeModel, renderEpisodeWs } from "../src/ui/episodews.js";
import { referencePlan, renderRefPlan, bindRefPlan } from "../src/ui/refplan.js";
import { buildInputSet, missingForGeneration, generationSeedFrom, REFERENCE_ROLES } from "../src/workflow/geninput.js";
import * as pd from "../src/workflow/proddoc.js";
import * as shotprod from "../src/workflow/shotprod.js";

// --- fixtures ---------------------------------------------------------------

const SHOTS = [
  { shotId: "sh01", sequence: 1, title: "吧台特写", description: "雨水顺着玻璃滑下", shotSize: "特写", angle: "平视", cameraMotion: "固定", action: "林晚放下酒杯", dialogue: "他不会来了。", duration_seconds: 6 },
  { shotId: "sh02", sequence: 2, title: "门口全景", description: "门被推开", shotSize: "全景", angle: "俯视", cameraMotion: "推", action: "陌生人进门", duration_seconds: 6 },
  { shotId: "sh05", sequence: 3, title: "天台对峙", description: "风很大", shotSize: "中景", angle: "平视", cameraMotion: "环绕", action: "两人对视", duration_seconds: 10 },
  { shotId: "sh09", sequence: 4, title: "游离镜头" }, // designed nowhere, assigned nowhere
];

function production() {
  const p = pd.createProduction(null);
  const ep = p.episodes[0];
  ep.title = "迷雾入城";
  const s1 = pd.addScene(p, ep.episodeId, "S01 酒吧 · 雨夜");
  const s2 = pd.addScene(p, ep.episodeId, "S02 天台 · 黎明");
  pd.assignShot(p, s1.sceneId, "sh01");
  pd.assignShot(p, s1.sceneId, "sh02");
  pd.assignShot(p, s2.sceneId, "sh05");
  p.characters.push({
    characterId: "ch-lin", name: "林晚", tier: "formal", profile: {}, states: [],
    referenceAssetIds: [], activeReferenceAssetId: null,
    voice: { voiceId: null, description: "", performance: {} },
  });
  p.locations.push({ locationId: "lo-bar", name: "夜班酒吧", profile: {}, states: [], referenceAssetIds: [], activeReferenceAssetId: null });
  const sc1 = pd.findScene(p, s1.sceneId).scene;
  sc1.characterRefs = [{ characterId: "ch-lin", stateId: null }];
  sc1.locationRef = { locationId: "lo-bar", stateId: null };
  return { p, ep, s1: s1.sceneId, s2: s2.sceneId };
}

/** The smallest DOM the bind functions actually use: elements found by a
 *  `[data-*]` selector, each carrying its dataset and an assignable `onclick`.
 *  Enough to prove the WIRING — which handler is attached to which element and
 *  what it does with that element's data — without a real DOM. */
function fakeRoot(html) {
  const els = [];
  for (const tag of html.match(/<[a-z]+[^>]*>/g) || []) {
    const dataset = {};
    for (const [, name, value] of tag.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
      dataset[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    if (Object.keys(dataset).length) els.push({ dataset, onclick: null, tag });
  }
  const matches = (el, sel) => {
    const m = /^\[data-([a-z-]+)\]$/.exec(sel.trim());
    if (!m) return false;
    return m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()) in el.dataset;
  };
  return {
    querySelectorAll: (sel) => els.filter((e) => sel.split(",").some((s) => matches(e, s))),
    find: (sel) => els.find((e) => matches(e, sel)) || null,
  };
}

/** A reference chain as `assetreg.listReferences` returns it. */
const ref = (key, kind, name, links, version = 1) => ({
  key, kind, displayName: name, version, assetId: `a-${key}-v${version}`,
  url: `/u/${key}.png`, storageState: "local", links, tags: [], originalFilename: null,
});

const SCRIPT = `场景 1 酒吧 · 雨夜
林晚坐在吧台前，杯子空了很久。
「他不会来了。」

场景 2 天台 · 黎明
风从东边来，把话都吹散了。`;

/** A ctx exposing exactly what episodeModel reads — real proddoc/shotprod
 *  underneath, so the read model is pinned against the real documents. */
function fakeCtx({ prod, script = SCRIPT, media = {}, refs = {} } = {}) {
  const mediaOf = (shot) => media[shot.shotId] || { image: false, video: false, videoAssetId: null };
  return {
    prodData: () => ({ production: prod, draftShots: SHOTS }),
    script: { currentText: () => script },
    assets: { names: () => ({ character: () => "", location: () => "", episode: () => "", scene: () => "", shot: () => "" }) },
    shot: {
      mediaOf,
      stage: (shot) => shotprod.shotStage(prod, shot, mediaOf(shot)),
      stageCounts: (shots) => shotprod.stageCounts(prod, shots, mediaOf),
      find: (id) => SHOTS.find((s) => s.shotId === id) || null,
    },
    episode: {
      view: () => pd.episodeView(prod, prod.activeEpisodeId, SHOTS),
      referencesOfShot: (shotId) => refs[shotId] || [],
      mediaUrl: (shot, domain) => {
        const m = mediaOf(shot);
        if (domain === "images" && m.image) return `/u/${shot.shotId}.png`;
        if (domain === "videos" && m.video) return `/u/${shot.shotId}.mp4`;
        return "";
      },
    },
  };
}

// --- 1. the script a scene came from ----------------------------------------

test("a Scene shows the script text it came from", () => {
  const { p, s1, s2 } = production();
  const view = pd.episodeView(p, p.activeEpisodeId, SHOTS);
  const slices = scriptSlices(SCRIPT, view.scenes);
  assert.match(slices.get(s1).text, /杯子空了很久/);
  assert.match(slices.get(s2).text, /风从东边来/);
  // and NOT the neighbouring scene's words
  assert.ok(!slices.get(s1).text.includes("风从东边来"));
});

test("when the script cannot be located, it says nothing — it never guesses", () => {
  const { p } = production();
  const view = pd.episodeView(p, p.activeEpisodeId, SHOTS);
  // three headings, two scenes: the correspondence is unknown, so NOTHING is
  // claimed. Showing scene 1 the first block would be a plausible lie.
  const ambiguous = "场景 1 A\na\n场景 2 B\nb\n场景 3 C\nc";
  assert.equal(scriptSlices(ambiguous, view.scenes).size, 0);
  assert.equal(scriptSlices("", view.scenes).size, 0);
  assert.equal(scriptSlices(null, view.scenes).size, 0);
  // prose with no scene headings at all is equally unlocatable
  assert.equal(scriptSlices("一段没有场景标题的散文。", view.scenes).size, 0);
});

// --- 2. scene → shot → current picture --------------------------------------

test("a Scene shows its Shots, each with its stage, picture and references", () => {
  const { p } = production();
  const ctx = fakeCtx({
    prod: p,
    media: { sh01: { image: true, video: true, videoAssetId: "a-v1" }, sh02: { image: true, video: false, videoAssetId: null } },
    refs: { sh01: [{ key: "ref-lin", kind: "character-reference", name: "林晚 Ref", version: 3, assetId: "a-1", url: "/u/lin.png" }] },
  });
  const m = episodeModel(ctx);
  assert.equal(m.episodeTitle, "迷雾入城");
  assert.equal(m.scenes.length, 2);
  assert.deepEqual(m.scenes.map((s) => s.shots.length), [2, 1]);
  const sh01 = m.scenes[0].shots[0];
  assert.equal(sh01.title, "吧台特写");
  assert.equal(sh01.hasVideo, true);
  assert.equal(sh01.videoUrl, "/u/sh01.mp4");        // a REAL video, playable
  assert.equal(sh01.references[0].name, "林晚 Ref");
  assert.equal(sh01.sceneTitle, "S01 酒吧 · 雨夜");   // the shot knows its scene
  // 生成成功 != 镜头完成: a shot with a video is 待审, never 已通过
  assert.equal(sh01.stage, "todo-review");
  assert.equal(sh01.approved, false);
  // an unassigned shot is still shown — real inventory is never hidden
  assert.deepEqual(m.unassigned.map((s) => s.shotId), ["sh09"]);
  assert.equal(m.shots, 4);
  assert.equal(m.counts.approved, 0);
});

test("an approved shot reads as approved, from the review record only", () => {
  const { p } = production();
  shotprod.approveShot(p, "sh01", "a-v1", "2026-08-12T00:00:00Z", "通过");
  const ctx = fakeCtx({ prod: p, media: { sh01: { image: true, video: true, videoAssetId: "a-v1" } } });
  const m = episodeModel(ctx);
  assert.equal(m.scenes[0].shots[0].stage, "approved");
  assert.equal(m.counts.approved, 1);
});

test("本集制作 renders the scenes, the shots and a real <video> for a shot that has one", () => {
  const { p } = production();
  const ctx = fakeCtx({ prod: p, media: { sh01: { image: true, video: true, videoAssetId: "a-v1" } } });
  const html = renderEpisodeWs(ctx, { epShotId: "sh01" });
  assert.match(html, /S01 酒吧 · 雨夜/);
  assert.match(html, /吧台特写/);
  assert.match(html, /杯子空了很久/);                    // the scene's own script
  assert.match(html, /<video class="ep-player" src="\/u\/sh01\.mp4" controls/); // real playback
  assert.match(html, /data-ep-gen="sh01"/);              // the generation task entrance
  assert.match(html, /data-ep-refs="sh01"/);             // the reference entrance
});

test("an episode with a script but no shots says exactly that, and points at 分镜", () => {
  const p = pd.createProduction(null);
  const ctx = {
    ...fakeCtx({ prod: p }),
    prodData: () => ({ production: p, draftShots: [] }),
    episode: { view: () => pd.episodeView(p, p.activeEpisodeId, []), referencesOfShot: () => [], mediaUrl: () => "" },
  };
  const html = renderEpisodeWs(ctx, {});
  assert.match(html, /还没有拆成镜头/);
  assert.match(html, /data-goto="shots"/);
});

// --- 3 & 4. the reference plan ----------------------------------------------

function plan(p, { bindings = {}, references = [] } = {}) {
  return referencePlan({
    view: pd.episodeView(p, p.activeEpisodeId, SHOTS),
    bindings: (shotId) => bindings[shotId] || [],
    references,
    sceneOf: (shotId) => {
      const owner = pd.sceneOfShot(p, shotId);
      if (!owner) return null;
      return {
        sceneId: owner.scene.sceneId,
        title: owner.scene.title,
        characterIds: (owner.scene.characterRefs || []).map((r) => r.characterId),
        locationId: owner.scene.locationRef ? owner.scene.locationRef.locationId : null,
      };
    },
    names: { character: (id) => (id === "ch-lin" ? "林晚" : ""), location: (id) => (id === "lo-bar" ? "夜班酒吧" : "") },
  });
}

test("a shared Reference is ONE row carrying every shot — never one copy per shot", () => {
  const { p } = production();
  const lin = ref("ref-lin", "character-reference", "林晚 Ref", { characterId: "ch-lin" }, 3);
  const m = plan(p, {
    bindings: { sh01: ["ref-lin"], sh02: ["ref-lin"], sh05: ["ref-lin"] },
    references: [lin],
  });
  assert.equal(m.have.length, 1, "one canonical reference → one row");
  assert.deepEqual(m.have[0].shotIds.sort(), ["sh01", "sh02", "sh05"]);
  assert.equal(m.have[0].key, "ref-lin", "the row points at the CHAIN, not a version");
  assert.equal(m.have[0].version, 3);
  assert.equal(m.shared.length, 1);
  // the canonical asset is referenced, never duplicated into the plan
  assert.equal(m.have.filter((r) => r.key === "ref-lin").length, 1);
});

test("a binding to a reference that no longer exists renders nothing at all", () => {
  const { p } = production();
  const m = plan(p, { bindings: { sh01: ["ref-gone"] }, references: [] });
  assert.equal(m.have.length, 0);
});

test("a gap is a QUESTION: the scene names a subject with no reference bound", () => {
  const { p } = production();
  const m = plan(p, { references: [] });
  // S01 names 林晚 and 夜班酒吧; its two shots each lack both
  const char = m.missing.find((x) => x.kind === "character-reference");
  const loc = m.missing.find((x) => x.kind === "location-reference");
  assert.equal(char.subject, "林晚");
  assert.deepEqual(char.shotIds.sort(), ["sh01", "sh02"], "grouped by subject, not one row per shot");
  assert.equal(loc.subject, "夜班酒吧");
  // S02 names nobody, so it asks nothing — an empty scene is not a gap
  assert.equal(m.missing.every((x) => !x.shotIds.includes("sh05")), true);
  assert.equal(m.reuse.length, 0);
  // nothing was created by asking
  assert.equal(m.have.length, 0);
});

test("a bound reference covers ITS subject only — never every character in the scene", () => {
  // codex review, TASK-061 round A: asking only "does this shot have SOME
  // character reference" made one binding cover a whole two-hander — bind 林晚's
  // reference and 陈默's gap silently disappeared, which is the exact question
  // this page exists to answer.
  const { p, s1 } = production();
  p.characters.push({
    characterId: "ch-chen", name: "陈默", tier: "formal", profile: {}, states: [],
    referenceAssetIds: [], activeReferenceAssetId: null,
    voice: { voiceId: null, description: "", performance: {} },
  });
  pd.findScene(p, s1).scene.characterRefs = [
    { characterId: "ch-lin", stateId: null }, { characterId: "ch-chen", stateId: null },
  ];
  const lin = ref("ref-lin", "character-reference", "林晚 Ref", { characterId: "ch-lin" });
  const m = plan(p, { bindings: { sh01: ["ref-lin"], sh02: ["ref-lin"] }, references: [lin] });
  // 林晚 is covered on both shots…
  assert.equal(m.missing.some((x) => x.subjectId === "ch-lin"), false);
  assert.equal(m.reuse.some((x) => x.subjectId === "ch-lin"), false);
  // …and 陈默 is still missing on both, which is the whole point
  const chen = m.missing.find((x) => x.subjectId === "ch-chen");
  assert.ok(chen, "the other character's gap must survive");
  assert.deepEqual(chen.shotIds.sort(), ["sh01", "sh02"]);
});

test("a bound reference for ANOTHER location does not cover this scene's location", () => {
  const { p } = production();
  const elsewhere = ref("ref-roof", "location-reference", "天台 Ref", { locationId: "lo-roof" });
  const m = plan(p, { bindings: { sh01: ["ref-roof"] }, references: [elsewhere] });
  const loc = m.missing.find((x) => x.kind === "location-reference");
  assert.ok(loc, "夜班酒吧 still has no reference of its own");
  assert.equal(loc.subjectId, "lo-bar");
  assert.ok(loc.shotIds.includes("sh01"));
});

test("when a reference for the subject already exists, the plan says REUSE, not create", () => {
  const { p } = production();
  const lin = ref("ref-lin", "character-reference", "林晚 Ref", { characterId: "ch-lin" });
  const m = plan(p, { references: [lin] });
  const r = m.reuse.find((x) => x.kind === "character-reference");
  assert.equal(r.subject, "林晚");
  assert.equal(r.key, "ref-lin", "it points at the EXISTING chain");
  assert.deepEqual(r.shotIds.sort(), ["sh01", "sh02"]);
  // …and it is NOT also listed as missing
  assert.equal(m.missing.some((x) => x.kind === "character-reference"), false);
});

test("参考统筹 renders 已存在 / 建议复用 / 缺失, and binds to the existing chain", () => {
  const { p } = production();
  const lin = ref("ref-lin", "character-reference", "林晚 Ref", { characterId: "ch-lin" }, 2);
  const ctx = {
    refplan: {
      model: () => plan(p, { bindings: { sh01: ["ref-lin"] }, references: [lin] }),
      shotName: (id) => (SHOTS.find((s) => s.shotId === id) || {}).title || "",
    },
  };
  const html = renderRefPlan(ctx, {});
  assert.match(html, /已存在/);
  assert.match(html, /建议复用/);
  assert.match(html, /缺失/);
  assert.match(html, /吧台特写/);
  // the reuse action binds the EXISTING key onto the shots that lack it
  assert.match(html, /data-rp-bind="ref-lin" data-rp-shots="sh02"/);
  // the gap action uploads FOR the named subject — never a blind "new asset" —
  // and carries the shots whose gap it is, so filling it FINISHES the job
  // (codex review, TASK-061 round A3: the returned key was discarded, leaving
  // those shots unbound and the next generation still without the reference)
  assert.match(html, /data-rp-create="location-reference" data-rp-subject="lo-bar" data-rp-shots="sh01,sh02"/);
});

test("filling a gap binds the new reference to exactly the shots whose gap it was", () => {
  const { p } = production();
  const bound = [];
  const ctx = {
    refplan: {
      model: () => plan(p, { references: [] }),
      shotName: (id) => id,
      uploadFor: async () => "ref-new",
    },
    shot: { addReference: (shotId, key) => bound.push([shotId, key]) },
  };
  const root = fakeRoot(renderRefPlan(ctx, {}));
  bindRefPlan(root, ctx, {}, () => {});
  const btn = root.find("[data-rp-create]");
  assert.ok(btn, "the gap row offers an upload action");
  return btn.onclick().then(() => {
    assert.deepEqual(bound.sort(), [["sh01", "ref-new"], ["sh02", "ref-new"]]);
  });
});

test("no shots → the plan says so instead of showing an empty scaffold", () => {
  const p = pd.createProduction(null);
  const ctx = {
    refplan: {
      model: () => referencePlan({
        view: pd.episodeView(p, p.activeEpisodeId, []),
        bindings: () => [], references: [], sceneOf: () => null,
        names: { character: () => "", location: () => "" },
      }),
      shotName: () => "",
    },
  };
  assert.match(renderRefPlan(ctx, {}), /还没有镜头/);
});

// --- 5 & 6. the Generation Input Set ----------------------------------------

const linRef = { key: "ref-lin", kind: "character-reference", name: "林晚 Ref", version: 3, assetId: "a-lin-3", url: "/u/lin.png" };
const barRef = { key: "ref-bar", kind: "location-reference", name: "夜班酒吧 Ref", version: 1, assetId: "a-bar-1", url: "/u/bar.png" };

test("the input set groups references by ROLE and keeps the shot design", () => {
  const set = buildInputSet({
    shot: SHOTS[0],
    context: { shotId: "sh01", sceneId: "sc-1", episodeId: "ep-1", sceneTitle: "S01", episodeCode: "EP01" },
    references: [linRef, barRef],
    frames: null,
    prompt: "【画面】雨水顺着玻璃滑下",
    runtime: { source: "手工外部生成" },
  });
  assert.deepEqual(REFERENCE_ROLES.map((r) => r[0]), [
    "character-reference", "location-reference", "prop-reference", "style-reference",
  ]);
  assert.deepEqual(set.references["character-reference"].map((r) => r.name), ["林晚 Ref"]);
  assert.deepEqual(set.references["prop-reference"], [], "an empty role is empty, not absent");
  assert.equal(set.referenceCount, 2);
  assert.equal(set.design.shotSize, "特写");
  assert.equal(set.design.dialogue, "他不会来了。");
});

test("what a route CANNOT know stays null — never a plausible default", () => {
  const set = buildInputSet({
    shot: SHOTS[0], context: { shotId: "sh01" }, references: [],
    prompt: "x", runtime: { source: "手工外部生成" },
  });
  assert.equal(set.model, null, "an external run does not report its model");
  assert.equal(set.seed, null);
  assert.equal(set.parameters, null);
  assert.equal(set.startFrame, null, "an image generation has no first frame");
  assert.equal(set.endFrame, null);
  assert.equal(set.source, "手工外部生成");
  // a seed of 0 is a REAL seed and must survive
  const zero = buildInputSet({ shot: SHOTS[0], context: {}, references: [], runtime: { seed: 0 } });
  assert.equal(zero.seed, 0);
});

test("the blockers are stated, never a silently disabled button", () => {
  const noPrompt = buildInputSet({ shot: SHOTS[0], context: { shotId: "sh01" }, references: [] });
  assert.deepEqual(missingForGeneration(noPrompt, { kind: "image" }), ["还没有编译 Prompt"]);
  const noFrame = buildInputSet({ shot: SHOTS[0], context: { shotId: "sh01" }, references: [], prompt: "x" });
  assert.deepEqual(missingForGeneration(noFrame, { kind: "video" }), ["视频生成需要首帧图片"]);
  const framed = buildInputSet({
    shot: SHOTS[0], context: { shotId: "sh01" }, references: [], prompt: "x",
    frames: { start: { assetId: "a-img-1", name: "本镜头画面 v1" } },
  });
  assert.deepEqual(missingForGeneration(framed, { kind: "video" }), []);
  // an unresolvable shot is a blocker with a REASON attached
  const lost = buildInputSet({ shot: null, context: {}, references: [], prompt: "x" });
  assert.match(missingForGeneration(lost, { kind: "image" })[0], /镜头身份/);
});

test("the manual route records the SAME Generation shape as any other", () => {
  const set = buildInputSet({
    shot: SHOTS[0],
    context: { shotId: "sh01", sceneId: "sc-1", episodeId: "ep-1" },
    references: [linRef, barRef],
    frames: { start: { assetId: "a-img-1", name: "本镜头画面 v1" } },
    prompt: "【画面】雨水",
    runtime: { source: "手工外部生成" },
  });
  const seed = generationSeedFrom(set, { type: "video" });
  assert.equal(seed.type, "video");
  assert.equal(seed.targetType, "shot");
  assert.equal(seed.targetId, "sh01");
  // the references the creator was actually given are FROZEN into the lineage
  assert.deepEqual(seed.referenceAssetIds, ["a-lin-3", "a-bar-1"]);
  assert.deepEqual(seed.inputAssetIds, ["a-img-1"]);
  assert.equal(seed.promptSnapshot, "【画面】雨水");
  assert.equal(seed.provider, "手工外部生成");
  assert.equal(seed.model, null, "still unknown after the round trip");
  // the canonical context travels with the record, so the generation can still
  // be placed after the draft is regenerated
  assert.equal(seed.parameters.episodeId, "ep-1");
  assert.equal(seed.parameters.sceneId, "sc-1");
  assert.equal("seed" in seed.parameters, false, "an unknown seed is absent, not null-in-parameters");
});

test("a prompt the creator CLEARED is recorded as cleared, not silently restored", () => {
  // codex review, TASK-061 round A5: `promptSnapshot || set.prompt` replaced an
  // explicitly emptied prompt with the compiled one, so the record claimed a
  // prompt that never drove anything.
  const set = buildInputSet({
    shot: SHOTS[0], context: { shotId: "sh01" }, references: [],
    prompt: "【画面】编译出来的原文",
  });
  // not supplied → the set's compiled prompt
  assert.equal(generationSeedFrom(set, { type: "image" }).promptSnapshot, "【画面】编译出来的原文");
  assert.equal(generationSeedFrom(set, { type: "image", promptSnapshot: null }).promptSnapshot, "【画面】编译出来的原文");
  // explicitly cleared → recorded as having none
  assert.equal(generationSeedFrom(set, { type: "image", promptSnapshot: "" }).promptSnapshot, null);
  assert.equal(generationSeedFrom(set, { type: "image", promptSnapshot: "   " }).promptSnapshot, null);
  // edited → the creator's own words, VERBATIM. Whitespace decides emptiness
  // but is never edited out of a real prompt: indentation and line breaks are
  // part of what was actually sent (codex review, round A6).
  assert.equal(generationSeedFrom(set, { type: "image", promptSnapshot: "我改过的" }).promptSnapshot, "我改过的");
  const spaced = "  【画面】雨水\n\n  【要求】16:9  ";
  assert.equal(generationSeedFrom(set, { type: "image", promptSnapshot: spaced }).promptSnapshot, spaced);
});

// --- 7. the picker's three entrances ----------------------------------------

test("the picker offers 已绑定 / 本集推荐 / 资产库 / 临时上传, and never orphans media", () => {
  const { p } = production();
  const ctx = {
    ...fakeCtx({ prod: p, refs: { sh01: [linRef] } }),
  };
  ctx.episode.pickerModel = () => ({ bound: [linRef], suggested: [barRef], library: [] });
  const html = renderEpisodeWs(ctx, { epShotId: "sh01", epPanel: "refs" });
  assert.match(html, /已绑定/);
  assert.match(html, /本集推荐/);
  assert.match(html, /从资产库选择/);
  assert.match(html, /临时上传/);
  assert.match(html, /data-ep-unbind="ref-lin"/);
  assert.match(html, /data-ep-bind="ref-bar"/);
  // an upload entrance for each role, all going through the SAME registration
  for (const [role] of REFERENCE_ROLES) assert.match(html, new RegExp(`data-ep-upload="${role}"`));
  assert.match(html, /绝不产生孤立文件/);
});

test("an archived reference is named as archived — never drawn as a broken image", () => {
  // codex review, TASK-061 round A2: a broken-image glyph says "something went
  // wrong" when the truth is "these bytes were deliberately put away", and the
  // creator cannot tell those apart. The reference still exists and is still
  // bindable — only its bytes are elsewhere.
  const { p } = production();
  const away = { ...barRef, storageState: "archived" };
  const ctx = fakeCtx({ prod: p });
  ctx.episode.pickerModel = () => ({
    bound: [], suggested: [{ ...linRef, storageState: "local" }], library: [away],
  });
  const html = renderEpisodeWs(ctx, { epShotId: "sh01", epPanel: "refs" });
  assert.match(html, /已归档/);
  assert.ok(!html.includes(`src="${away.url}"`), "no <img> is pointed at bytes that are away");
  assert.match(html, new RegExp(`src="${linRef.url}"`), "…while a local one still shows its picture");
  // it is still offered for binding: storage state is a fact about the file
  assert.match(html, new RegExp(`data-ep-bind="${away.key}"`));
});

test("the generation panel shows the input set and admits what it does not know", () => {
  const { p } = production();
  const ctx = fakeCtx({ prod: p });
  ctx.episode.genModel = () => ({
    set: buildInputSet({
      shot: SHOTS[0], context: { shotId: "sh01", sceneTitle: "S01 酒吧 · 雨夜", episodeCode: "EP01" },
      references: [linRef], prompt: "【画面】雨水", runtime: { source: "手工外部生成" },
    }),
    prompt: "【画面】雨水",
    missing: ["视频生成需要首帧图片"],
    slot: "v1-1",
  });
  const html = renderEpisodeWs(ctx, { epShotId: "sh01", epPanel: "gen", epGenKind: "image" });
  assert.match(html, /林晚 Ref/);
  assert.match(html, /人物参考/);
  assert.match(html, /手工外部生成/);
  assert.match(html, /未知（外部生成不上报）/, "the model is admitted as unknown");
  assert.match(html, /视频生成需要首帧图片/, "the blocker is shown with its reason");
  assert.match(html, /class="ep-import"/, "the result comes back through a real upload");
  assert.match(html, /出现在 Workflow 溯源里/);
});

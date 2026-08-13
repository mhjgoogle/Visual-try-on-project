// Production Bible (checkpoint M7) — run via `node --test`, wrapped by
// tests/test_motv_production_bible_m7.py.
//
// Covers: character/location lifecycle, states as overrides of the SAME
// identity, the voice rule (a state never carries its own voice identity),
// asset references (reference-only, outliving media), scene↔bible references
// with non-destructive refusals, resolvers (base ⊕ state merge), hydration
// round-trip, and the v6→v7 migration + v7 validation.
import test from "node:test";
import assert from "node:assert/strict";

import * as pd from "../src/workflow/proddoc.js";
import * as bd from "../src/workflow/bibledoc.js";
import { CANVAS_SCHEMA_VERSION, migrateToCurrent } from "../src/services/canvasschema.js";
import { renderBibleWs } from "../src/ui/biblews.js";

function prodWithScene() {
  const p = pd.createProduction(null);
  const scene = pd.addScene(p, p.episodes[0].episodeId, "大殿");
  return { p, scene };
}

// --- character lifecycle ----------------------------------------------------- //

test("addCharacter mints a stable identity with empty profile/voice/states", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "李昭");
  assert.match(c.characterId, /^char-/);
  assert.equal(c.name, "李昭");
  assert.deepEqual(c.referenceAssetIds, []);
  assert.equal(c.activeReferenceAssetId, null);
  assert.equal(c.voice.voiceId, null);
  assert.deepEqual(c.states, []);
  assert.equal(bd.renameCharacter(p, c.characterId, "李昭仪"), true);
  assert.equal(bd.renameCharacter(p, c.characterId, " "), false);
  assert.equal(bd.updateCharacterProfile(p, c.characterId, { appearance: "束发", junk: "x" }), true);
  assert.equal(c.profile.appearance, "束发");
  assert.ok(!("junk" in c.profile)); // whitelist — unknown facets never land
});

test("removeCharacter is REFUSED while a scene references it", () => {
  const { p, scene } = prodWithScene();
  const c = bd.addCharacter(p, "甲");
  assert.equal(bd.addSceneCharacter(p, scene.sceneId, c.characterId), true);
  assert.equal(bd.removeCharacter(p, c.characterId), false);
  assert.equal(bd.removeSceneCharacter(p, scene.sceneId, c.characterId), true);
  assert.equal(bd.removeCharacter(p, c.characterId), true);
});

// --- states: same identity, whitelisted overrides, voice rule ------------------ //

test("a CharacterState overrides facets but keeps the SAME identity and voice", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "李昭");
  bd.updateCharacterProfile(p, c.characterId, { appearance: "少女妆", costume: "襦裙", personality: "怯懦" });
  bd.setCharacterVoice(p, c.characterId, { voiceId: "zh_CN-huayan", description: "清亮少女声" });
  const s = bd.addCharacterState(p, c.characterId, "黑化时期");
  assert.match(s.stateId, /^cstate-/);
  assert.equal(
    bd.setCharacterStateOverrides(p, c.characterId, s.stateId, {
      appearance: "黑衣冷面",
      voice: { voiceId: "OTHER-VOICE", description: "低沉压抑" }, // voiceId must be stripped
      personality: "狠戾", // not overridable — dropped
    }),
    true,
  );
  const r = bd.resolveCharacter(c, s.stateId);
  assert.equal(r.characterId, c.characterId); // same identity
  assert.equal(r.appearance, "黑衣冷面"); // overridden
  assert.equal(r.costume, "襦裙"); // inherited
  assert.equal(r.personality, "怯懦"); // never state-overridden
  assert.equal(r.voice.voiceId, "zh_CN-huayan"); // VOICE RULE: base identity always
  assert.equal(r.voice.description, "低沉压抑"); // performance may change
  assert.ok(!("voiceId" in s.overrides.voice)); // stripped at write time too
  assert.ok(!("personality" in s.overrides));
});

test("resolver clamps the active reference to the RESOLVED list (state refs override)", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "甲");
  bd.addReferenceAsset(p, c.characterId, "asset-base"); // becomes base active
  const s = bd.addCharacterState(p, c.characterId, "黑化");
  // the state overrides the reference LIST without naming an active one — the
  // base active is not in that list and must NOT leak through
  bd.setCharacterStateOverrides(p, c.characterId, s.stateId, { referenceAssetIds: ["asset-state"] });
  const r = bd.resolveCharacter(c, s.stateId);
  assert.deepEqual(r.referenceAssetIds, ["asset-state"]);
  assert.equal(r.activeReferenceAssetId, null); // never an out-of-list active
  // same rule for locations
  const l = bd.addLocation(p, "殿");
  bd.addReferenceAsset(p, l.locationId, "asset-day");
  const night = bd.addLocationState(p, l.locationId, "夜");
  bd.setLocationStateOverrides(p, l.locationId, night.stateId, { referenceAssetIds: ["asset-night"] });
  assert.equal(bd.resolveLocation(l, night.stateId).activeReferenceAssetId, null);
});

test("a state list CONTAINING the inherited base active keeps it active (resolved view)", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "甲");
  bd.addReferenceAsset(p, c.characterId, "asset-base"); // base active
  const s = bd.addCharacterState(p, c.characterId, "受伤");
  // override list includes the base active but names no active of its own —
  // the resolver keeps the inherited active (it IS a member of this list)
  bd.setCharacterStateOverrides(p, c.characterId, s.stateId, { referenceAssetIds: ["asset-base", "asset-extra"] });
  const r = bd.resolveCharacter(c, s.stateId);
  assert.equal(r.activeReferenceAssetId, "asset-base");
});

test("resolveCharacter: unknown state resolves to BASE, flagged not guessed", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "甲");
  bd.updateCharacterProfile(p, c.characterId, { appearance: "base" });
  const r = bd.resolveCharacter(c, "cstate-gone");
  assert.equal(r.appearance, "base");
  assert.equal(r.stateResolved, false);
  assert.equal(bd.resolveCharacter(c, null).stateResolved, true);
});

test("removeCharacterState is REFUSED while a scene shows the character IN that state", () => {
  const { p, scene } = prodWithScene();
  const c = bd.addCharacter(p, "甲");
  const s = bd.addCharacterState(p, c.characterId, "受伤时期");
  bd.addSceneCharacter(p, scene.sceneId, c.characterId, s.stateId);
  assert.equal(bd.removeCharacterState(p, c.characterId, s.stateId), false);
  assert.equal(bd.setSceneCharacterState(p, scene.sceneId, c.characterId, null), true);
  assert.equal(bd.removeCharacterState(p, c.characterId, s.stateId), true);
});

// --- reference assets ----------------------------------------------------------- //

test("reference assets: add/remove/active are reference-only invariants", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "甲");
  assert.equal(bd.addReferenceAsset(p, c.characterId, "asset-1"), true);
  assert.equal(c.activeReferenceAssetId, "asset-1"); // first ref becomes active
  assert.equal(bd.addReferenceAsset(p, c.characterId, "asset-1"), false); // no dup
  bd.addReferenceAsset(p, c.characterId, "asset-2");
  assert.equal(bd.setActiveReferenceAsset(p, c.characterId, "asset-9"), false); // not a member
  assert.equal(bd.setActiveReferenceAsset(p, c.characterId, "asset-2"), true);
  assert.equal(bd.removeReferenceAsset(p, c.characterId, "asset-2"), true);
  assert.equal(c.activeReferenceAssetId, "asset-1"); // active falls back to a member
  assert.equal(bd.setActiveReferenceAsset(p, c.characterId, null), true);
});

// --- locations -------------------------------------------------------------------- //

test("location lifecycle + LocationState overrides (day/night etc.)", () => {
  const { p, scene } = prodWithScene();
  const l = bd.addLocation(p, "太极殿");
  assert.match(l.locationId, /^loc-/);
  bd.updateLocationProfile(p, l.locationId, { description: "金砖白玉阶", visualInstruction: "对称构图" });
  const night = bd.addLocationState(p, l.locationId, "夜晚");
  bd.setLocationStateOverrides(p, l.locationId, night.stateId, { description: "烛影幢幢" });
  const r = bd.resolveLocation(l, night.stateId);
  assert.equal(r.locationId, l.locationId); // same identity
  assert.equal(r.description, "烛影幢幢");
  assert.equal(r.visualInstruction, "对称构图"); // inherited
  // scene references it → removals refused until released
  assert.equal(bd.setSceneLocation(p, scene.sceneId, l.locationId, night.stateId), true);
  assert.equal(bd.removeLocationState(p, l.locationId, night.stateId), false);
  assert.equal(bd.removeLocation(p, l.locationId), false);
  assert.equal(bd.setSceneLocation(p, scene.sceneId, null, null), true);
  assert.equal(bd.removeLocationState(p, l.locationId, night.stateId), true);
  assert.equal(bd.removeLocation(p, l.locationId), true);
});

// --- scene ↔ bible references ------------------------------------------------------- //

test("scene character refs: by id + state, one ref per character, unknown refused", () => {
  const { p, scene } = prodWithScene();
  const c = bd.addCharacter(p, "甲");
  const s1 = bd.addCharacterState(p, c.characterId, "少女时期");
  assert.equal(bd.addSceneCharacter(p, scene.sceneId, c.characterId, "cstate-gone"), false);
  assert.equal(bd.addSceneCharacter(p, scene.sceneId, c.characterId, s1.stateId), true);
  assert.equal(bd.addSceneCharacter(p, scene.sceneId, c.characterId), false); // already present
  assert.deepEqual(scene.characterRefs, [{ characterId: c.characterId, stateId: s1.stateId }]);
  assert.equal(bd.setSceneCharacterState(p, scene.sceneId, c.characterId, "cstate-gone"), false);
  assert.equal(bd.setSceneCharacterState(p, scene.sceneId, c.characterId, null), true);
  assert.equal(bd.setSceneLocation(p, scene.sceneId, "loc-gone"), false);
});

// --- hydration round-trip ------------------------------------------------------------- //

test("bible + scene refs survive serialize → createProduction verbatim", () => {
  const { p, scene } = prodWithScene();
  const c = bd.addCharacter(p, "李昭");
  const st = bd.addCharacterState(p, c.characterId, "黑化时期");
  bd.setCharacterStateOverrides(p, c.characterId, st.stateId, { appearance: "黑衣" });
  bd.addReferenceAsset(p, c.characterId, "asset-1");
  const l = bd.addLocation(p, "太极殿");
  bd.addSceneCharacter(p, scene.sceneId, c.characterId, st.stateId);
  bd.setSceneLocation(p, scene.sceneId, l.locationId, null);
  const revived = pd.createProduction(JSON.parse(JSON.stringify(pd.serialize(p))));
  assert.deepEqual(pd.serialize(revived), pd.serialize(p));
});

test("hydration drops refs to entities/states that do not exist (internal refs)", () => {
  const { p, scene } = prodWithScene();
  const c = bd.addCharacter(p, "甲");
  const saved = JSON.parse(JSON.stringify(pd.serialize(p)));
  const sc = saved.episodes[0].scenes[0];
  sc.characterRefs = [
    { characterId: c.characterId, stateId: "cstate-gone" }, // unknown state → null
    { characterId: "char-gone", stateId: null }, // unknown character → dropped
    { characterId: c.characterId, stateId: null }, // duplicate character → dropped
  ];
  sc.locationRef = { locationId: "loc-gone", stateId: null };
  const revived = pd.createProduction(saved);
  const rsc = revived.episodes[0].scenes[0];
  assert.deepEqual(rsc.characterRefs, [{ characterId: c.characterId, stateId: null }]);
  assert.equal(rsc.locationRef, null);
  void scene;
});

test("hydration: character/location ids share one namespace; unknown fields survive", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "甲");
  const saved = JSON.parse(JSON.stringify(pd.serialize(p)));
  // a location whose id collides with an existing character is dropped —
  // entity lookups resolve across both kinds, so the collision is ambiguous
  saved.locations = [{
    locationId: c.characterId, name: "冒名", profile: { description: "", visualInstruction: "" },
    referenceAssetIds: [], activeReferenceAssetId: null, states: [],
  }];
  // an unknown field a future checkpoint added survives the round-trip
  saved.characters[0].futureField = { keep: true };
  const revived = pd.createProduction(saved);
  assert.deepEqual(revived.locations, []);
  assert.deepEqual(revived.characters[0].futureField, { keep: true });
});

test("hydration dedupes duplicated reference ids (validation rejects them upstream)", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "甲");
  const saved = JSON.parse(JSON.stringify(pd.serialize(p)));
  saved.characters[0].referenceAssetIds = ["asset-1", "asset-1", "asset-2"];
  const revived = pd.createProduction(saved);
  assert.deepEqual(revived.characters[0].referenceAssetIds, ["asset-1", "asset-2"]);
  void c;
});

test("hydration strips a state's voiceId override even from a tampered save", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "甲");
  const st = bd.addCharacterState(p, c.characterId, "黑化");
  const saved = JSON.parse(JSON.stringify(pd.serialize(p)));
  saved.characters[0].states[0].overrides = { voice: { voiceId: "smuggled", description: "低沉" } };
  const revived = pd.createProduction(saved);
  assert.deepEqual(revived.characters[0].states[0].overrides.voice, { description: "低沉" });
  void st;
});

// --- v6 → v7 migration ------------------------------------------------------------------ //

function v6Doc() {
  return {
    v: 6,
    project: "p",
    scriptDoc: null,
    assets: { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [] },
    generations: [],
    production: {
      activeEpisodeId: "ep-1",
      episodes: [{
        episodeId: "ep-1", title: "第 1 集",
        scenes: [{ sceneId: "scene-1", title: "大殿", shotIds: ["shot-a"] }],
      }],
    },
    nodes: [{ id: "n1", type: "script", x: 0, y: 0, state: "" }],
    edges: [],
    pan: { x: 0, y: 0 },
  };
}

test("v6→v7 adds empty bible + scene ref fields, touching nothing else", () => {
  const res = migrateToCurrent(v6Doc());
  assert.equal(res.status, "ok");
  assert.equal(res.doc.v, CANVAS_SCHEMA_VERSION);
  const p = res.doc.production;
  assert.deepEqual(p.characters, []);
  assert.deepEqual(p.locations, []);
  const sc = p.episodes[0].scenes[0];
  assert.deepEqual(sc.characterRefs, []);
  assert.equal(sc.locationRef, null);
  assert.deepEqual(sc.shotIds, ["shot-a"]); // untouched
  assert.equal(p.activeEpisodeId, "ep-1");
  // deterministic
  assert.deepEqual(migrateToCurrent(v6Doc()).doc, migrateToCurrent(v6Doc()).doc);
});

test("v6→v7 replaces hand-crafted junk bible fields (introduced AT v7)", () => {
  const doc = v6Doc();
  doc.production.characters = [{ characterId: "char-x", states: "junk" }];
  doc.production.episodes[0].scenes[0].characterRefs = [{ characterId: "char-x" }];
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  assert.deepEqual(res.doc.production.characters, []);
  assert.deepEqual(res.doc.production.episodes[0].scenes[0].characterRefs, []);
});

test("a fresh v1 save reaches v7 with an empty bible", () => {
  const v1 = { v: 1, project: "p", scriptDoc: null, nodes: [{ id: "n1", type: "script", x: 0, y: 0 }], edges: [], pan: { x: 0, y: 0 } };
  const res = migrateToCurrent(v1);
  assert.equal(res.status, "ok");
  assert.deepEqual(res.doc.production.characters, []);
  assert.deepEqual(res.doc.production.locations, []);
});

// --- v7 validation ------------------------------------------------------------------------ //

function v7Doc() {
  const doc = migrateToCurrent(v6Doc()).doc;
  doc.production.characters = [{
    characterId: "char-1",
    name: "李昭",
    tier: "formal", // TASK-057: a v10 character carries its tier
    profile: {
      appearance: "", costume: "", personality: "", visualInstruction: "",
      // TASK-057 creative layer (身份 / 欲望 / 弱点 / 核心矛盾 / Character Arc)
      identity: "", desire: "", weakness: "", coreConflict: "", arc: "",
    },
    referenceAssetIds: ["asset-1"],
    activeReferenceAssetId: "asset-1",
    voice: { voiceId: "zh_CN-huayan", description: "", performance: {} },
    states: [{ stateId: "cstate-1", name: "黑化时期", overrides: { appearance: "黑衣" } }],
  }];
  doc.production.locations = [{
    locationId: "loc-1",
    name: "太极殿",
    profile: { description: "", visualInstruction: "" },
    referenceAssetIds: [],
    activeReferenceAssetId: null,
    states: [{ stateId: "lstate-1", name: "夜晚", overrides: {} }],
  }];
  doc.production.episodes[0].scenes[0].characterRefs = [{ characterId: "char-1", stateId: "cstate-1" }];
  doc.production.episodes[0].scenes[0].locationRef = { locationId: "loc-1", stateId: "lstate-1" };
  return doc;
}

test("a well-formed v7 document validates ok", () => {
  assert.equal(migrateToCurrent(v7Doc()).status, "ok");
});

test("v7 validation rejects bible/reference corruption, case by case", () => {
  const cases = [
    (p) => delete p.characters, // registry missing
    (p) => delete p.locations,
    (p) => p.characters.push({ ...structuredClone(p.characters[0]) }), // dup characterId
    (p) => (p.characters[0].states[0].overrides.voice = { voiceId: "other" }), // VOICE RULE
    (p) => (p.characters[0].activeReferenceAssetId = "asset-9"), // active not a member
    (p) => (p.characters[0].states[0].overrides = { activeReferenceAssetId: "a", referenceAssetIds: [] }), // state active not in own list
    (p) => (p.locations[0].states[0].stateId = "cstate-1"), // dup stateId across bible
    (p) => (p.episodes[0].scenes[0].characterRefs = [{ characterId: "char-gone", stateId: null }]), // unknown character
    (p) => (p.episodes[0].scenes[0].characterRefs = [{ characterId: "char-1", stateId: "cstate-gone" }]), // unknown state
    (p) => (p.episodes[0].scenes[0].characterRefs = [
      { characterId: "char-1", stateId: null },
      { characterId: "char-1", stateId: "cstate-1" },
    ]), // character referenced twice in one scene
    (p) => delete p.episodes[0].scenes[0].locationRef, // field required at v7 (truncated scene)
    (p) => (p.episodes[0].scenes[0].locationRef = { locationId: "loc-gone", stateId: null }), // unknown location
    (p) => (p.episodes[0].scenes[0].locationRef = { locationId: "loc-1", stateId: "lstate-gone" }), // unknown location state
    (p) => (p.characters[0].voice = "deep"), // voice not an object
    // round-2 class: anything hydration would coerce/drop is REJECTED instead
    (p) => (p.characters[0].states[0].overrides.referenceAssetIds = "x"), // not a list
    (p) => (p.characters[0].states[0].overrides.mood = "sad"), // unknown override key
    (p) => (p.characters[0].states[0].overrides.appearance = 7), // facet not a string
    (p) => (p.characters[0].states[0].overrides.voice = { pitch: "high" }), // unknown voice override key
    (p) => (p.characters[0].profile.appearance = 7), // base facet not a string
    (p) => (p.locations[0].profile.description = null), // base facet not a string
    (p) => (p.characters[0].voice.performance = "fast"), // base performance not an object
    (p) => (p.locations[0].locationId = "char-1"), // id collides across kinds (one namespace)
    // round-3: duplicated reference ids render twice and one removal would
    // delete every copy — rejected in base lists AND override lists
    (p) => (p.characters[0].referenceAssetIds = ["asset-1", "asset-1"]),
    (p) => (p.characters[0].states[0].overrides = { referenceAssetIds: ["a", "a"] }),
    // round-5: scene references are ID-ONLY — an embedded profile copy (or any
    // extra field hydration would drop) is rejected, never silently lost
    (p) => (p.episodes[0].scenes[0].characterRefs[0].appearance = "内嵌档案"),
    (p) => (p.episodes[0].scenes[0].locationRef.name = "内嵌场景"),
    (p) => delete p.episodes[0].scenes[0].characterRefs[0].stateId,
    (p) => delete p.episodes[0].scenes[0].locationRef.stateId,
  ];
  for (const [i, mutate] of cases.entries()) {
    const doc = v7Doc();
    mutate(doc.production);
    assert.equal(migrateToCurrent(doc).status, "invalid", `case ${i}`);
  }
});

test("v7 validation: bible asset references are SHAPE-only (may outlive the Asset)", () => {
  const doc = v7Doc();
  doc.production.characters[0].referenceAssetIds = ["asset-that-no-longer-exists"];
  doc.production.characters[0].activeReferenceAssetId = "asset-that-no-longer-exists";
  assert.equal(migrateToCurrent(doc).status, "ok");
});

/* ========================================================================= */
/* TASK-070 · 初始人物从故事大纲的主要角色概念来                                */
/* ========================================================================= */

test("a concept splits into a suggested name and 身份 — and the split is a GUESS", () => {
  assert.deepEqual(bd.splitCharacterConcept("林晚 —— 夜班调酒师，不肯交出录音"),
    { name: "林晚", identity: "夜班调酒师，不肯交出录音" });
  assert.deepEqual(bd.splitCharacterConcept("陈默：来要录音的人"),
    { name: "陈默", identity: "来要录音的人" });
  assert.deepEqual(bd.splitCharacterConcept("Lin Wan - the bartender"),
    { name: "Lin Wan", identity: "the bartender" });
  // 「——」 must not be split by the single 「—」 it contains
  assert.equal(bd.splitCharacterConcept("A —— B").identity, "B");
  // a bare name carries no identity, rather than inventing one
  assert.deepEqual(bd.splitCharacterConcept("林晚"), { name: "林晚", identity: "" });
  // a separator at position 0 would leave an empty name — not a split
  assert.deepEqual(bd.splitCharacterConcept("：只有描述"), { name: "：只有描述", identity: "" });
  assert.equal(bd.splitCharacterConcept("   "), null);
  assert.equal(bd.splitCharacterConcept(null), null);
});

test("seeds are joined against the cast that already exists, by name", () => {
  const prod = pd.createProduction(null);
  bd.addCharacter(prod, "林晚");
  const rows = bd.characterSeedsFromConcepts(prod, [
    "林晚 —— 夜班调酒师",
    "陈默：来要录音的人",
    "林晚 —— 夜班调酒师",   // the same concept twice is one character
    "  ",                    // blank
  ]);
  assert.equal(rows.length, 2, "duplicates and blanks are dropped");
  const lin = rows.find((r) => r.name === "林晚");
  assert.equal(lin.exists, true, "already in the cast — offered as 已有, never created twice");
  assert.ok(lin.characterId);
  const chen = rows.find((r) => r.name === "陈默");
  assert.equal(chen.exists, false);
  assert.equal(chen.identity, "来要录音的人");
  assert.equal(chen.concept, "陈默：来要录音的人", "the concept is carried VERBATIM for display");
  // no concepts at all ⇒ nothing to offer, not an error
  assert.deepEqual(bd.characterSeedsFromConcepts(prod, []), []);
  assert.deepEqual(bd.characterSeedsFromConcepts(prod, null), []);
});

test("seeding does not write anything by itself", () => {
  const prod = pd.createProduction(null);
  const before = (prod.characters || []).length;
  bd.characterSeedsFromConcepts(prod, ["林晚 —— 调酒师", "陈默：客人"]);
  assert.equal((prod.characters || []).length, before,
    "deriving what COULD be created must not create it — the outline never writes canon by itself");
});

test("the seeding panel renders the concept verbatim with an EDITABLE name", () => {
  const prod = pd.createProduction(null);
  bd.addCharacter(prod, "林晚");
  const seeds = {
    version: 3, approved: true,
    rows: bd.characterSeedsFromConcepts(prod, ["林晚 —— 调酒师", "陈默：来要录音的人"]),
  };
  const ctx = {
    prodData: () => ({
      production: prod,
      assets: { images: {}, videos: {}, audio: {} },
      assetUploads: {},
      media: { video: {}, audio: {} },
      draftShots: [], generations: [], firstFrames: {},
    }),
    bible: { conceptSeeds: () => seeds },
    baseAssets: { model: () => ({ empty: true }) },
    prodgraph: { model: () => ({ context: {} }) },
    locks: { is: () => false },
    // renderBreakdownPanel reads the 剧本拆解 proposal state; 「没有在跑」 is null-shaped
    breakdown: { state: () => null },
    script: { hasContent: () => false },
  };
  const html = renderBibleWs(ctx, { bibleTab: "characters" });
  // the concept is shown as written — the creator judges the guess against it
  assert.match(html, /陈默：来要录音的人/);
  // …and the NAME is an editable field, prefilled with the split
  assert.match(html, /data-seed-name="0"[^>]*value="陈默"/);
  assert.match(html, /data-seed-identity="0"[^>]*value="来要录音的人"/);
  assert.match(html, /data-seed-add="0"/);
  assert.match(html, /大纲 v3 · 已批准/);
  // 林晚 already exists ⇒ offered once as a row? No — not offered at all
  assert.ok(!/data-seed-name="1"/.test(html), "only the MISSING concepts are offered");
  // every concept already in the cast ⇒ a note, not an empty box
  const allThere = { version: 3, approved: true, rows: bd.characterSeedsFromConcepts(prod, ["林晚 —— 调酒师"]) };
  const html2 = renderBibleWs({ ...ctx, bible: { conceptSeeds: () => allThere } }, { bibleTab: "characters" });
  assert.match(html2, /都已经在人物表里了/);
  assert.ok(!/data-seed-add/.test(html2));
  // no concepts at all ⇒ no panel (a panel offering nothing is noise)
  const none = renderBibleWs({ ...ctx, bible: { conceptSeeds: () => ({ version: 0, approved: false, rows: [] }) } }, { bibleTab: "characters" });
  assert.ok(!/seedbox/.test(none));
});

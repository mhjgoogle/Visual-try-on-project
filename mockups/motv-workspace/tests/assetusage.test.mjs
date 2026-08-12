// Checkpoint CP5 (ADR-0058 / TASK-061) — Asset Usage + the Asset Library.
//
// What is pinned here:
//   1. Usage is DERIVED from canonical relations, and de-duplicated
//   2. a shared Reference reports every shot that uses it — by KEY, one entry
//      per shot, never one per version
//   3. usage names the canonical context (EP / Scene / Shot) it was found in
//   4. an unused asset says so plainly
//   5. the library filters/searches on what the CREATOR sees, not on ids
//   6. Active vs Historical variants are distinguishable
import test from "node:test";
import assert from "node:assert/strict";

import { usageOfAsset, usageIndex, isUnused, USAGE_KINDS, USAGE_KIND_LABEL } from "../src/workflow/assetusage.js";
import { libraryModel, TYPE_FILTERS } from "../src/ui/assetlibws.js";
import { createRegistry } from "../src/workflow/assetlib.js";
import { declare, listAssets } from "../src/workflow/assetreg.js";
import { addVersion, refFromResponse } from "../src/workflow/mediaref.js";
import * as pd from "../src/workflow/proddoc.js";
import { addShotReference } from "../src/workflow/shotprod.js";

function production() {
  const p = pd.createProduction(null);
  const ep = p.episodes[0];
  ep.title = "迷雾入城";
  const s1 = pd.addScene(p, ep.episodeId, "S01 酒吧 · 雨夜");
  const s2 = pd.addScene(p, ep.episodeId, "S02 天台");
  pd.assignShot(p, s1.sceneId, "sh01");
  pd.assignShot(p, s1.sceneId, "sh02");
  pd.assignShot(p, s2.sceneId, "sh05");
  p.characters.push({
    characterId: "ch-lin", name: "林晚", tier: "formal",
    profile: {}, states: [], referenceAssetIds: ["a-charref"],
    activeReferenceAssetId: "a-charref", voice: { voiceId: null, description: "", performance: {} },
  });
  p.locations.push({
    locationId: "lo-bar", name: "夜班酒吧", profile: {}, states: [],
    referenceAssetIds: [], activeReferenceAssetId: null,
  });
  const sc1 = pd.findScene(p, s1.sceneId).scene;
  sc1.ambienceAssetId = "a-amb";
  ep.bgmAssetId = "a-bgm";
  return { p, epId: ep.episodeId, s1: s1.sceneId, s2: s2.sceneId };
}

// --- 1 & 2. shared references ------------------------------------------------

test("a shared Reference reports EVERY shot that uses it — one entry per shot", () => {
  const { p } = production();
  for (const s of ["sh01", "sh02", "sh05"]) addShotReference(p, s, "ref-lin");
  const u = usageOfAsset({ assetId: "a-charref", referenceKey: "ref-lin", production: p, timelines: {}, generations: [] });
  const shots = u.places.filter((x) => x.kind === "shot-reference").map((x) => x.shotId).sort();
  assert.deepEqual(shots, ["sh01", "sh02", "sh05"]);
  // …and it also shows as the character's reference material — a different
  // KIND of dependency, so it is a separate place, not a duplicate
  assert.equal(u.places.filter((x) => x.kind === "character-ref").length, 1);
  assert.equal(u.count, 4);
  // every shot usage names the episode + scene it was found in
  const one = u.places.find((x) => x.shotId === "sh01");
  assert.ok(one.episodeId);
  assert.ok(one.sceneId);
  assert.match(one.label, /EP01/);
});

test("usage is DE-DUPLICATED: the same place is never counted twice", () => {
  const { p } = production();
  addShotReference(p, "sh01", "ref-lin");
  // the SAME asset is the shot's reference AND was the input to two separate
  // generations targeting that same shot, and sits on two clips of one track
  const generations = [
    { generationId: "g1", type: "image", targetId: "sh01", inputAssetIds: ["a-charref"], referenceAssetIds: ["a-charref"], resultAssetIds: [], status: "success" },
  ];
  const timelines = {
    "ep-1": { clips: [
      // the SAME asset split into two clips of ONE shot's video track
      { clipId: "c1", trackType: "video", assetId: "a-charref", shotId: "sh01" },
      { clipId: "c2", trackType: "video", assetId: "a-charref", shotId: "sh01" },
      // …and genuinely used again for a DIFFERENT shot — that is a second place
      { clipId: "c3", trackType: "video", assetId: "a-charref", shotId: "sh02" },
    ] },
  };
  const u = usageOfAsset({ assetId: "a-charref", referenceKey: "ref-lin", production: p, timelines, generations });
  // ONE generation entry even though it is both input and reference there
  assert.equal(u.places.filter((x) => x.kind === "generation").length, 1);
  assert.match(u.places.find((x) => x.kind === "generation").label, /输入\/参考/);
  // two clips of ONE shot's track collapse to one place; the second shot is
  // a genuinely different place in the cut
  const tl = u.places.filter((x) => x.kind === "timeline");
  assert.equal(tl.length, 2);
  assert.deepEqual(tl.map((x) => x.shotId).sort(), ["sh01", "sh02"]);
});

test("de-duplication names the SUBJECT: two characters using one photo are two places", () => {
  // codex review, TASK-061 round A2: a bible reference has no episode, scene or
  // shot, so a key built only from those collapsed 林晚's and 陈默's shared
  // reference into ONE place — the library then reported it as depended on half
  // as much as it really is, which is the same under-reporting the de-dup rule
  // exists to prevent, from the other direction.
  const { p } = production();
  p.characters.push({
    characterId: "ch-chen", name: "陈默", tier: "formal", profile: {}, states: [],
    referenceAssetIds: ["a-charref"], activeReferenceAssetId: "a-charref",
    voice: { voiceId: null, description: "", performance: {} },
  });
  p.locations.push({
    locationId: "lo-roof", name: "天台", profile: {}, states: [],
    referenceAssetIds: ["a-charref"], activeReferenceAssetId: "a-charref",
  });
  const u = usageOfAsset({ assetId: "a-charref", production: p, timelines: {}, generations: [] });
  const chars = u.places.filter((x) => x.kind === "character-ref");
  assert.equal(chars.length, 2, "林晚 and 陈默 are two distinct dependencies");
  assert.deepEqual(chars.map((x) => x.characterId).sort(), ["ch-chen", "ch-lin"]);
  // …and a location using the same photo is a third, different kind of place
  assert.equal(u.places.filter((x) => x.kind === "location-ref").length, 1);
  assert.equal(u.count, 3);
});

test("a SUPERSEDED reference version is not credited with the chain's shot usage", () => {
  // codex review, TASK-061 round A6: a Shot binds the chain, and the chain
  // resolves to exactly one version — so v1 stopped being in use by those shots
  // the moment v2 replaced it. Crediting it showed 林晚 Ref v1 as 「用于 3 处」,
  // and "used a lot" is how a creator decides what is safe to clean up.
  const { p } = production();
  for (const s of ["sh01", "sh02", "sh05"]) addShotReference(p, s, "ref-lin");
  const args = { referenceKey: "ref-lin", production: p, timelines: {}, generations: [] };
  const current = usageOfAsset({ assetId: "a-lin-v2", isCurrent: true, ...args });
  const old = usageOfAsset({ assetId: "a-lin-v1", isCurrent: false, ...args });
  assert.equal(current.places.filter((x) => x.kind === "shot-reference").length, 3);
  assert.equal(old.places.filter((x) => x.kind === "shot-reference").length, 0);
  assert.equal(isUnused(old), true, "the superseded take is honestly unused");
});

// --- 3. scene / episode audio -------------------------------------------------

test("scene ambience and episode BGM are found and named", () => {
  const { p } = production();
  const amb = usageOfAsset({ assetId: "a-amb", production: p, timelines: {}, generations: [] });
  assert.equal(amb.count, 1);
  assert.equal(amb.places[0].kind, "scene-audio");
  assert.match(amb.places[0].label, /环境音/);
  assert.ok(amb.places[0].sceneId);
  const bgm = usageOfAsset({ assetId: "a-bgm", production: p, timelines: {}, generations: [] });
  assert.equal(bgm.places[0].kind, "episode-audio");
  assert.ok(bgm.places[0].episodeId);
});

// --- 4. unused ----------------------------------------------------------------

test("an asset used nowhere says so plainly", () => {
  const { p } = production();
  const u = usageOfAsset({ assetId: "a-nobody", production: p, timelines: {}, generations: [] });
  assert.equal(u.count, 0);
  assert.deepEqual(u.places, []);
  assert.equal(isUnused(u), true);
  assert.equal(isUnused(null), true);
});

test("the usage vocabulary is closed and labelled", () => {
  for (const k of USAGE_KINDS) assert.equal(typeof USAGE_KIND_LABEL[k], "string");
});

test("usage is total: missing documents produce an empty result, never a throw", () => {
  const u = usageOfAsset({ assetId: "x", production: null, timelines: null, generations: null });
  assert.equal(u.count, 0);
  assert.deepEqual(usageIndex({ assets: null, production: null, timelines: null, generations: null }).size, 0);
});

// --- 5 & 6. the library read model -------------------------------------------

function registry() {
  const reg = createRegistry(null);
  const put = (domain, key, url, decl, version = 1) => {
    const ref = refFromResponse(key, "upload", { url, version }, decl.links && decl.links.shotId);
    declare(ref, domain, decl);
    addVersion({ uploads: reg[domain] }, key, ref);
    return ref;
  };
  const charRef = put("images", "ref-lin", "/u/lin.png", {
    kind: "character-reference", displayName: "林晚 Ref", tags: ["定妆", "冷调"],
    links: { characterId: "ch-lin" },
  });
  put("images", "ref-lin", "/u/lin_v2.png", { kind: "character-reference", displayName: "林晚 Ref", links: { characterId: "ch-lin" } }, 2);
  const shotImg = put("images", "v1-1", "/u/sh01.png", {
    kind: "shot-image", links: { shotId: "sh01", sceneId: "sc-1", episodeId: "ep-1" }, tags: ["雨夜"],
  });
  const dlg = put("audio", "voice-v1-1", "/u/line.wav", { kind: "dialogue", links: { shotId: "sh01" } });
  return { reg, charRef, shotImg, dlg };
}

const NAMES = {
  character: (id) => (id === "ch-lin" ? "林晚" : ""),
  location: () => "",
  episode: (id) => (id === "ep-1" ? "EP01 迷雾入城" : ""),
  scene: (id) => (id === "sc-1" ? "S01 酒吧 · 雨夜" : ""),
  shot: (id) => (id === "sh01" ? "吧台特写" : ""),
};

test("the library shows the CURRENT version by default, history on request", () => {
  const { reg } = registry();
  const assets = listAssets(reg);
  const usage = new Map();
  const cur = libraryModel({ assets, usage, names: NAMES, filters: {} });
  // the reference chain has two versions; only v2 is current
  assert.equal(cur.rows.filter((r) => r.key === "ref-lin").length, 1);
  assert.equal(cur.rows.find((r) => r.key === "ref-lin").version, 2);
  const hist = libraryModel({ assets, usage, names: NAMES, filters: { variant: "historical" } });
  assert.equal(hist.rows.find((r) => r.key === "ref-lin").version, 1);
  const all = libraryModel({ assets, usage, names: NAMES, filters: { variant: "all" } });
  assert.equal(all.rows.filter((r) => r.key === "ref-lin").length, 2);
});

test("search matches the creator's words — names, tags and canonical NAMES", () => {
  const { reg } = registry();
  const assets = listAssets(reg);
  const usage = new Map();
  const find = (search) => libraryModel({ assets, usage, names: NAMES, filters: { search } }).rows;
  assert.equal(find("林晚").length, 1, "the display name");
  assert.equal(find("雨夜").length, 1, "a creator tag");
  // BOTH assets attached to sh01 match its name — that is the point of
  // searching by canonical name rather than by id
  assert.equal(find("吧台特写").length, 2, "the SHOT's name, resolved from its id");
  assert.equal(find("EP01").length, 1, "the episode's name");
  assert.equal(find("没有这个东西").length, 0);
});

test("type tabs group by what the creator means, and count honestly", () => {
  const { reg } = registry();
  const assets = listAssets(reg);
  const m = libraryModel({ assets, usage: new Map(), names: NAMES, filters: {} });
  const n = (id) => m.counts.find((c) => c.id === id).n;
  assert.deepEqual(TYPE_FILTERS.map((t) => t[0]), ["all", "reference", "shot-image", "shot-video", "audio", "final"]);
  assert.equal(n("reference"), 2, "both versions of the reference chain are references");
  assert.equal(n("audio"), 1);
  assert.equal(n("shot-video"), 0, "an empty group is honestly zero, not hidden");
});

test("filters compose, and 可复用 only matches an EXPLICIT mark", () => {
  const { reg, shotImg } = registry();
  const assets = listAssets(reg);
  const usage = new Map();
  assert.equal(libraryModel({ assets, usage, names: NAMES, filters: { reusable: true } }).rows.length, 0);
  shotImg.reusable = true;
  const after = libraryModel({ assets: listAssets(reg), usage, names: NAMES, filters: { reusable: true } });
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0].kind, "shot-image");
  // a tag filter and a type filter compose
  const both = libraryModel({ assets: listAssets(reg), usage, names: NAMES, filters: { type: "shot-image", tag: "雨夜" } });
  assert.equal(both.rows.length, 1);
  const neither = libraryModel({ assets: listAssets(reg), usage, names: NAMES, filters: { type: "audio", tag: "雨夜" } });
  assert.equal(neither.rows.length, 0);
});

test("a card carries its usage count, and the header reports what is unused", () => {
  const { reg, charRef } = registry();
  const { p } = production();
  addShotReference(p, "sh01", "ref-lin");
  const assets = listAssets(reg);
  const usage = usageIndex({ assets, production: p, timelines: {}, generations: [] });
  const m = libraryModel({ assets, usage, names: NAMES, filters: {} });
  const ref = m.rows.find((r) => r.key === "ref-lin");
  assert.ok(ref.usage.count >= 1, "the shared reference reports its shot usage");
  assert.equal(ref.unused, false);
  const dlg = m.rows.find((r) => r.media === "audio");
  assert.equal(dlg.unused, true);
  assert.ok(m.unusedCount >= 1);
  assert.equal(charRef.kind, "character-reference");
});

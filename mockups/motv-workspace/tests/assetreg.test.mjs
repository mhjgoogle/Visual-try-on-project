// Checkpoint CP2 (ADR-0055 / TASK-058) — Asset Registration Foundation.
// Run via `node --test`. Owned by the frontend suite (gate frontend tier + CI).
//
// What is pinned here:
//   1. the declaration VOCABULARY is closed and domain-checked
//   2. every media write produces a DECLARED record — an undeclared write path
//      yields an honestly UNCLASSIFIED asset, never an invalid document
//   3. the v10→v11 migration back-fills ONLY facts the document already holds,
//      and invents no filename, no display name and no reusable mark
//   4. v11 validation rejects a malformed declaration instead of silently
//      normalizing away a creator's tags / links / reusable mark
//   5. canonical References are ONE versioned chain many shots share
//   6. reclassification is always explicit — nothing reclassifies itself
import test from "node:test";
import assert from "node:assert/strict";

import {
  CANVAS_SCHEMA_VERSION, MIGRATIONS, migrateToCurrent, validateCanvasDoc,
} from "../src/services/canvasschema.js";
import {
  ASSET_KINDS, ASSET_KIND_LABEL, REFERENCE_KINDS, LINK_KEYS, KIND_DOMAIN,
  declare, ensureDeclaration, updateDeclaration, addTag, removeTag,
  sanitizeDeclaration, sanitizeLinks, sanitizeTags, computeNeedsReview,
  declarationDomainError, checkDeclaration, listAssets, listReferences, derivedLabel,
  mintReferenceKey, isReferenceKey, isReferenceKind,
} from "../src/workflow/assetreg.js";
import { addVersion, refFromResponse } from "../src/workflow/mediaref.js";
import { createRegistry, addCut, findAssetById } from "../src/workflow/assetlib.js";
import { CHARACTER_PROFILE_FIELDS } from "../src/workflow/bibledoc.js";

/** Empty profile objects built from the REAL field lists, so the fixture can
 *  never drift out of sync with what the schema requires. */
const blankProfile = (fields) => Object.fromEntries(fields.map((k) => [k, ""]));

const rec = (slot, url, extra = {}) => ({
  slot_id: slot, origin: "upload", version: 1, digest: null, url, storageState: "local", ...extra,
});

// --- 1. the vocabulary ------------------------------------------------------

test("the kind vocabulary is closed, labelled, and domain-mapped", () => {
  assert.equal(new Set(ASSET_KINDS).size, ASSET_KINDS.length); // no duplicates
  for (const k of ASSET_KINDS) assert.equal(typeof ASSET_KIND_LABEL[k], "string");
  // every reference kind is a member; external-reference is deliberately
  // domain-free (it can be an image, a video or an audio clip)
  for (const k of REFERENCE_KINDS) assert.ok(ASSET_KINDS.includes(k));
  assert.equal(KIND_DOMAIN["external-reference"], undefined);
  assert.equal(KIND_DOMAIN["shot-image"], "images");
  assert.equal(KIND_DOMAIN["shot-video"], "videos");
  assert.equal(KIND_DOMAIN.dialogue, "audio");
  assert.equal(KIND_DOMAIN.final, "finals");
});

test("a declaration is refused when its kind cannot live in that domain", () => {
  assert.equal(declarationDomainError("shot-image", "images"), null);
  assert.equal(declarationDomainError(null, "audio"), null); // unclassified is fine anywhere
  assert.equal(declarationDomainError("external-reference", "audio"), null);
  assert.equal(declarationDomainError("external-reference", "videos"), null);
  // …but `finals` is this project's OUTPUT, never somebody else's reference
  assert.ok(declarationDomainError("external-reference", "finals"));
  assert.ok(declarationDomainError("shot-image", "audio"));
  assert.ok(declarationDomainError("bgm", "images"));
  assert.ok(declarationDomainError("not-a-kind", "images"));
});

test("declare() stamps the declaration and refuses an impossible one — writing nothing", () => {
  const good = rec("s1", "/u/a.png");
  const r = declare(good, "images", {
    kind: "shot-image",
    displayName: "开场大远景",
    originalFilename: "IMG_2201.png",
    links: { shotId: "shot-a", episodeId: "ep-1", nope: "x" },
    tags: [" 雨夜 ", "雨夜", "", "cinematic"],
    reusable: true,
  });
  assert.equal(r.ok, true);
  assert.equal(good.kind, "shot-image");
  assert.equal(good.displayName, "开场大远景");
  assert.equal(good.originalFilename, "IMG_2201.png");
  assert.equal(good.links.shotId, "shot-a");
  assert.equal(good.links.episodeId, "ep-1");
  assert.equal("nope" in good.links, false); // unknown context keys are dropped
  assert.deepEqual(good.tags, ["雨夜", "cinematic"]); // trimmed + de-duplicated
  assert.equal(good.reusable, true);
  assert.equal(good.needsReview, false); // classified

  const bad = rec("s2", "/u/b.mp3");
  const r2 = declare(bad, "audio", { kind: "shot-image" });
  assert.equal(r2.ok, false);
  assert.equal("kind" in bad, false); // a refused declaration stamps NOTHING

  const bad2 = rec("s3", "/u/c.png");
  assert.equal(declare(bad2, "images", { kind: "totally-made-up" }).ok, false);
  assert.equal("kind" in bad2, false);

  assert.equal(declare({ url: "" }, "images", {}).ok, false); // no reachable bytes
});

test("a declaration can be checked BEFORE the bytes are uploaded", () => {
  // codex review, TASK-058 round 3: declaring only AFTER the upload means a
  // refused declaration leaves a file on disk that no Asset points at — the
  // exact orphan this checkpoint exists to make impossible.
  assert.equal(checkDeclaration("images", { kind: "shot-image" }), null);
  assert.equal(checkDeclaration("audio", { kind: null }), null);
  assert.ok(checkDeclaration("audio", { kind: "shot-image" }));
  assert.ok(checkDeclaration("images", { kind: "made-up" }));
  assert.ok(checkDeclaration("finals", { kind: "external-reference" }));
});

// --- 2. no undeclared asset can exist ---------------------------------------

test("addVersion declares by default: an undeclared write is UNCLASSIFIED, not invalid", () => {
  const node = { uploads: {} };
  const ref = refFromResponse("v1-1", "upload", { url: "/u/x.png", version: 1, sha256: null }, null);
  addVersion(node, "v1-1", ref); // no declare() call at all — a legacy write path
  assert.equal(ref.kind, null);
  assert.equal(ref.needsReview, true); // visible, listed, and ASKING
  assert.deepEqual(ref.tags, []);
  assert.equal(ref.reusable, false);
  assert.equal(ref.displayName, null);
  assert.equal(ref.originalFilename, null);
  for (const k of LINK_KEYS) assert.equal(ref.links[k], null);
  assert.ok(ref.assetId); // still a real Asset — registration is never skipped
});

test("a declared ref keeps its declaration verbatim through addVersion", () => {
  const node = { uploads: {} };
  const ref = refFromResponse("v1-1", "upload", { url: "/u/x.png", version: 1 }, "shot-a");
  declare(ref, "images", { kind: "shot-image", links: { shotId: "shot-a" }, tags: ["暖光"] });
  addVersion(node, "v1-1", ref);
  assert.equal(ref.kind, "shot-image");
  assert.equal(ref.links.shotId, "shot-a");
  assert.deepEqual(ref.tags, ["暖光"]);
  assert.equal(ref.needsReview, false);
});

test("a composed CUT is declared `cut` and carries the episode it rendered", () => {
  // TASK-074 §1.7：渲染产出的是候选（`cut`）。`final` 只有过了 G4 的导出写得出来，
  // 所以这条测的是 compose 写路径本来就该测的那件事，只是它现在叫对了名字。
  const reg = createRegistry(null);
  const f = addCut(reg, "/u/final.mp4", "ep-7");
  assert.equal(f.kind, "cut");
  assert.equal(f.links.episodeId, "ep-7");
  assert.equal(f.needsReview, false);
  assert.equal(f.reusable, false); // never presumed
  // no episode known → honest null, not a stand-in
  assert.equal(addCut(reg, "/u/final2.mp4").links.episodeId, null);
});

test("hydration normalizes every persisted declaration, whichever build wrote it", () => {
  const reg = createRegistry({
    images: { s1: { current: 1, history: [rec("s1", "/u/a.png", { assetId: "a1", kind: "shot-image", tags: "oops", reusable: "yes" })] } },
    videos: {}, audio: {}, firstFrames: {},
    finals: [{ assetId: "a2", url: "/u/f.mp4", origin: "compose" }],
    displaced: [],
  });
  const r = reg.images.s1.history[0];
  assert.deepEqual(r.tags, []); // a non-array tag field is not a tag list
  assert.equal(r.reusable, false); // only a real boolean true counts
  assert.equal(r.needsReview, false);
  assert.equal(reg.finals[0].kind, null); // hydration does NOT invent `final`
  assert.equal(reg.finals[0].needsReview, true);
});

// --- 3. the v10 → v11 migration ---------------------------------------------

function v10Doc() {
  return {
    v: 10,
    project: "p",
    scripts: {}, // per-episode since v8; a v10 doc carries no top-level scriptDoc
    story: {
      idea: "夜班", versions: [], active: 0, approved: 0, plans: [], activePlan: 0,
      confirmedPlan: 0, pending: null,
      brief: { draft: { genre: "", tone: "", form: "", episodeDuration: "", totalDuration: "", notes: "", targetEpisodes: null }, versions: [], active: 0 },
    },
    assets: {
      images: {
        "v1-1": { current: 1, history: [rec("v1-1", "/u/shot.png", { assetId: "a-shot", creativeShotId: "shot-a" })] },
        "v1-9": { current: 1, history: [rec("v1-9", "/u/mystery.png", { assetId: "a-myst" })] },
        "ref-x": { current: 1, history: [rec("ref-x", "/u/lin.png", { assetId: "a-charref" })] },
        "ref-y": { current: 1, history: [rec("ref-y", "/u/bar.png", { assetId: "a-locref" })] },
      },
      videos: {
        "v1-1": { current: 1, history: [rec("v1-1", "/u/shot.mp4", { assetId: "a-vid", creativeShotId: "shot-a" })] },
      },
      audio: {
        "voice-v1-1": { current: 1, history: [rec("voice-v1-1", "/u/line.wav", { assetId: "a-voice", creativeShotId: "shot-a" })] },
        "sfx-v1-1": { current: 1, history: [rec("sfx-v1-1", "/u/door.wav", { assetId: "a-sfx", creativeShotId: "shot-a" })] },
        "amb-1": { current: 1, history: [rec("amb-1", "/u/rain.wav", { assetId: "a-amb" })] },
        "bgm-1": { current: 1, history: [rec("bgm-1", "/u/theme.wav", { assetId: "a-bgm" })] },
        "music-main": { current: 1, history: [rec("music-main", "/u/legacy.wav", { assetId: "a-legacy-bgm" })] },
      },
      firstFrames: {},
      finals: [{ assetId: "a-final", url: "/u/final.mp4", origin: "compose", storageState: "local" }],
      displaced: [],
    },
    generations: [],
    production: {
      episodes: [{
        episodeId: "ep-1", title: "第 1 集", bgmAssetId: "a-bgm",
        beats: { plot: [], character: [], relationship: [], world: [] },
        basedOn: { brief: 0, outline: 0, characters: 0, relationships: 0, world: 0 },
        scenes: [{ sceneId: "sc-1", title: "S1", shotIds: ["shot-a"], ambienceAssetId: "a-amb", bgmAssetId: null, characterRefs: [], locationRef: null }],
      }],
      activeEpisodeId: "ep-1",
      characters: [{
        characterId: "ch-1", name: "林照", tier: "formal", profile: blankProfile(CHARACTER_PROFILE_FIELDS), states: [],
        referenceAssetIds: ["a-charref"], activeReferenceAssetId: "a-charref",
        voice: { voiceId: null, description: "", performance: {} },
      }],
      locations: [{
        locationId: "lo-1", name: "夜班酒吧", profile: blankProfile(["description", "visualInstruction"]), states: [],
        referenceAssetIds: ["a-locref"], activeReferenceAssetId: "a-locref",
      }],
      relationships: [],
      world: { era: "", rules: "", society: "", regions: "", places: "", visualTone: "", atmosphere: "" },
      canon: { characters: 0, relationships: 0, world: 0 },
    },
    timelines: {},
    nodes: [{ id: "n1", type: "script", x: 0, y: 0, state: "" }],
    edges: [],
    pan: { x: 0, y: 0 },
  };
}

test("the migration chain reaches v11 and v10→v11 is registered", () => {
  // pins the STEP, not the current version: later checkpoints legitimately add
  // v12, v13… and must not break this
  assert.ok(CANVAS_SCHEMA_VERSION >= 11);
  assert.equal(typeof MIGRATIONS[10], "function");
});

test("v10→v11 back-fills ONLY the classifications the document already records", () => {
  const input = v10Doc();
  const snapshot = structuredClone(input);
  const res = migrateToCurrent(input);
  assert.equal(res.status, "ok", res.detail);
  assert.deepEqual(input, snapshot); // the caller's document is never mutated
  const a = res.doc.assets;
  const at = (dom, key) => a[dom][key].history[0];

  // proven by a recorded creativeShotId
  assert.equal(at("images", "v1-1").kind, "shot-image");
  assert.equal(at("images", "v1-1").links.shotId, "shot-a");
  assert.equal(at("videos", "v1-1").kind, "shot-video");
  assert.equal(at("videos", "v1-1").links.shotId, "shot-a");

  // proven by the bible's own reference lists
  assert.equal(at("images", "ref-x").kind, "character-reference");
  assert.equal(at("images", "ref-x").links.characterId, "ch-1");
  assert.equal(at("images", "ref-y").kind, "location-reference");
  assert.equal(at("images", "ref-y").links.locationId, "lo-1");

  // proven by key prefixes THIS SYSTEM writes (a convention, not a filename guess)
  assert.equal(at("audio", "voice-v1-1").kind, "dialogue");
  assert.equal(at("audio", "voice-v1-1").links.shotId, "shot-a");
  assert.equal(at("audio", "sfx-v1-1").kind, "sfx");
  assert.equal(at("audio", "music-main").kind, "bgm"); // the legacy pool key

  // proven by the scene/episode audio references (these win over the prefix and
  // additionally carry WHERE the reference was made)
  assert.equal(at("audio", "amb-1").kind, "ambience");
  assert.equal(at("audio", "amb-1").links.sceneId, "sc-1");
  assert.equal(at("audio", "bgm-1").kind, "bgm");
  assert.equal(at("audio", "bgm-1").links.episodeId, "ep-1");

  // a composed final is a final by construction
  assert.equal(a.finals[0].kind, "final");

  // …and everything the document never recorded stays HONESTLY unclassified
  assert.equal(at("images", "v1-9").kind, null);
  assert.equal(at("images", "v1-9").needsReview, true);
  assert.equal(at("images", "v1-9").links.shotId, null);
});

test("v10→v11 invents no filename, no display name and no reusable mark", () => {
  const res = migrateToCurrent(v10Doc());
  for (const a of listAssets(res.doc.assets)) {
    assert.equal(a.originalFilename, null, `${a.assetId} gained a fabricated filename`);
    assert.equal(a.displayName, null, `${a.assetId} gained a fabricated display name`);
    assert.equal(a.reusable, false, `${a.assetId} was presumed reusable`);
    assert.deepEqual(a.tags, [], `${a.assetId} gained fabricated tags`);
  }
});

test("v10→v11 is deterministic, idempotent under re-migration, and validates", () => {
  const once = migrateToCurrent(v10Doc()).doc;
  assert.deepEqual(migrateToCurrent(v10Doc()).doc, once);
  assert.equal(validateCanvasDoc(once), null);
  // a document ALREADY at v11 is dispatched untouched
  const again = migrateToCurrent(structuredClone(once));
  assert.equal(again.status, "ok");
  assert.deepEqual(again.doc, once);
});

test("a legacy v3 save reaches v11 with every asset carrying a declaration", () => {
  const v3 = {
    v: 3, project: "p", scriptDoc: null,
    assets: {
      images: { "v1-1": { current: 1, history: [rec("v1-1", "/u/a.png", { assetId: "x1" })] } },
      videos: {}, audio: {}, firstFrames: {},
      finals: [{ assetId: "x2", url: "/u/f.mp4", origin: "compose" }],
      displaced: [],
    },
    nodes: [{ id: "n1", type: "script", x: 0, y: 0, state: "" }],
    edges: [], pan: { x: 0, y: 0 },
  };
  const res = migrateToCurrent(v3);
  assert.equal(res.status, "ok");
  assert.equal(validateCanvasDoc(res.doc), null);
  const all = listAssets(res.doc.assets);
  assert.equal(all.length, 2);
  for (const a of all) {
    assert.ok("kind" in a.record, "every record carries a kind field at v11");
    assert.deepEqual(Object.keys(a.links).sort(), [...LINK_KEYS].sort());
  }
});

// --- 4. v11 validation ------------------------------------------------------

function v11Doc() {
  return migrateToCurrent(v10Doc()).doc;
}

test("v11 validation accepts an unclassified asset — that is a real state", () => {
  const doc = v11Doc();
  const r = doc.assets.images["v1-9"].history[0];
  assert.equal(r.kind, null);
  assert.equal(validateCanvasDoc(doc), null);
});

test("v11 validation rejects a malformed declaration rather than repairing it", () => {
  const bad = (mutate) => {
    const doc = v11Doc();
    mutate(doc.assets.images["v1-1"].history[0], doc);
    return validateCanvasDoc(doc);
  };
  assert.ok(bad((r) => { r.kind = "invented-kind"; }));
  assert.ok(bad((r) => { delete r.kind; }));
  assert.ok(bad((r) => { r.kind = "bgm"; }));            // wrong domain
  assert.ok(bad((r) => { r.links = "nope"; }));
  assert.ok(bad((r) => { r.links.unknownKey = "x"; }));
  // a MISSING canonical key is a second flavour of "unknown" (undefined vs
  // null) that consumers handle differently — rejected, not normalized away
  assert.ok(bad((r) => { delete r.links.sceneId; }));
  // an external reference cannot be declared on a composed final
  assert.ok((() => {
    const doc = v11Doc();
    doc.assets.finals[0].kind = "external-reference";
    return validateCanvasDoc(doc);
  })());
  assert.ok(bad((r) => { r.links.shotId = ""; }));        // empty string is not "unknown"
  assert.ok(bad((r) => { r.tags = ["ok", 7]; }));
  assert.ok(bad((r) => { r.reusable = "true"; }));
  assert.ok(bad((r) => { r.needsReview = 1; }));
  assert.ok(bad((r) => { r.displayName = 7; }));
  // …and a well-formed declaration still passes
  assert.equal(bad((r) => { r.tags = ["雨夜"]; r.reusable = true; }), null);
});

test("v11 validation checks finals too", () => {
  const doc = v11Doc();
  doc.assets.finals[0].kind = "shot-image"; // a final is not a shot image
  assert.ok(validateCanvasDoc(doc));
});

// --- 5. canonical References ------------------------------------------------

test("a Reference is ONE versioned chain many shots share — never copied per shot", () => {
  const reg = createRegistry(null);
  const key = mintReferenceKey();
  assert.ok(isReferenceKey(key));
  assert.ok(isReferenceKind("character-reference"));
  assert.equal(isReferenceKind("shot-image"), false);

  for (const v of [1, 2, 3]) {
    const ref = refFromResponse(key, "upload", { url: `/u/lin_v${v}.png`, version: v }, null);
    declare(ref, "images", { kind: "character-reference", displayName: "林照 Ref", links: { characterId: "ch-1" } });
    addVersion({ uploads: reg.images }, key, ref);
  }
  const refs = listReferences(reg);
  assert.equal(refs.length, 1);                 // ONE reference…
  assert.equal(refs[0].version, 3);             // …at v3
  assert.equal(refs[0].kind, "character-reference");
  assert.equal(refs[0].links.characterId, "ch-1");
  assert.equal(reg.images[key].history.length, 3); // …with all three takes kept
  // and the whole chain is still individually addressable
  assert.equal(listAssets(reg).filter((a) => a.key === key).length, 3);
  assert.equal(listAssets(reg).filter((a) => a.key === key && a.current).length, 1);
});

test("listReferences only reports reference chains, not shot media", () => {
  const reg = createRegistry(null);
  const shot = refFromResponse("v1-1", "upload", { url: "/u/s.png", version: 1 }, "shot-a");
  declare(shot, "images", { kind: "shot-image", links: { shotId: "shot-a" } });
  addVersion({ uploads: reg.images }, "v1-1", shot);
  assert.deepEqual(listReferences(reg), []);
});

// --- 6. reclassification is always explicit ---------------------------------

test("updateDeclaration edits creator metadata and re-derives the review flag", () => {
  const r = sanitizeDeclaration(rec("s1", "/u/a.png", { assetId: "a1" }));
  assert.equal(r.needsReview, true);
  assert.equal(updateDeclaration(r, { kind: "style-reference", displayName: "冷调夜戏" }, "images"), true);
  assert.equal(r.needsReview, false);
  // un-classifying re-raises the flag — the state stays truthful in both directions
  assert.equal(updateDeclaration(r, { kind: null }), true);
  assert.equal(r.needsReview, true);
  // an unknown kind is refused outright
  assert.equal(updateDeclaration(r, { kind: "nope" }, "images"), false);
  // "I looked at this, it is just a file" is expressible and sticks
  assert.equal(updateDeclaration(r, { needsReview: false }), true);
  assert.equal(r.needsReview, false);
});

test("a kind change is DOMAIN-CHECKED — an image can never be re-declared bgm", () => {
  // codex review, TASK-058 round 1: without this the edit path could persist a
  // declaration the v11 validator refuses to load, i.e. an unopenable project.
  const r = sanitizeDeclaration(rec("s1", "/u/a.png", { assetId: "a1", kind: "shot-image" }));
  assert.equal(updateDeclaration(r, { kind: "bgm" }, "images"), false);
  assert.equal(r.kind, "shot-image"); // unchanged
  assert.equal(updateDeclaration(r, { kind: "character-reference" }, "images"), true);
  assert.equal(r.kind, "character-reference");
  // an UNVERIFIABLE change (no domain in hand) is refused, not waved through
  assert.equal(updateDeclaration(r, { kind: "shot-image" }), false);
  assert.equal(r.kind, "character-reference");
  // clearing the kind needs no domain — it can never make a record invalid
  assert.equal(updateDeclaration(r, { kind: null }), true);
  assert.equal(r.kind, null);
  // …and a declaration edited through the checked path still validates
  const doc = v11Doc();
  const target = doc.assets.images["v1-1"].history[0];
  assert.equal(updateDeclaration(target, { kind: "style-reference" }, "images"), true);
  assert.equal(validateCanvasDoc(doc), null);
});

test("links merge rather than replace, so one edit cannot erase another context", () => {
  const r = sanitizeDeclaration(rec("s1", "/u/a.png", { assetId: "a1", links: { shotId: "shot-a", episodeId: "ep-1" } }));
  updateDeclaration(r, { links: { sceneId: "sc-2" } });
  assert.equal(r.links.shotId, "shot-a");
  assert.equal(r.links.episodeId, "ep-1");
  assert.equal(r.links.sceneId, "sc-2");
});

test("reusable is only ever an EXPLICIT mark", () => {
  const r = sanitizeDeclaration(rec("s1", "/u/a.png", { assetId: "a1" }));
  assert.equal(r.reusable, false);
  updateDeclaration(r, { reusable: "yes" }); // truthy but not a real mark
  assert.equal(r.reusable, false);
  updateDeclaration(r, { reusable: true });
  assert.equal(r.reusable, true);
});

test("tags add / remove, de-duplicated and trimmed", () => {
  const r = sanitizeDeclaration(rec("s1", "/u/a.png", { assetId: "a1" }));
  assert.equal(addTag(r, " 雨夜 "), true);
  assert.equal(addTag(r, "雨夜"), false); // already there
  assert.equal(addTag(r, "   "), false);  // not a tag
  assert.equal(addTag(r, "cinematic"), true);
  assert.deepEqual(r.tags, ["雨夜", "cinematic"]);
  assert.equal(removeTag(r, "雨夜"), true);
  assert.equal(removeTag(r, "雨夜"), false);
  assert.deepEqual(r.tags, ["cinematic"]);
});

// --- helpers ----------------------------------------------------------------

test("sanitizers are total and never invent a value", () => {
  assert.deepEqual(sanitizeTags(null), []);
  assert.deepEqual(sanitizeTags(["a", "a", 1, "", " b "]), ["a", "b"]);
  const l = sanitizeLinks({ shotId: "s", bogus: 1, episodeId: 7 });
  assert.equal(l.shotId, "s");
  assert.equal(l.episodeId, null); // a non-string context is NOT KNOWN
  assert.equal("bogus" in l, false);
  assert.equal(computeNeedsReview(null, undefined), true);
  assert.equal(computeNeedsReview("bgm", undefined), false);
  assert.equal(computeNeedsReview(null, false), false); // explicitly cleared
  assert.equal(ensureDeclaration(null), null);
});

test("derivedLabel prefers the creator's name, then the original file, then the kind", () => {
  assert.equal(derivedLabel({ displayName: "林照 Ref", originalFilename: "a.png", kind: "character-reference", version: 3 }), "林照 Ref");
  assert.equal(derivedLabel({ displayName: null, originalFilename: "IMG_2201.png", kind: "shot-image", version: 2 }), "IMG_2201.png");
  assert.equal(derivedLabel({ displayName: null, originalFilename: null, kind: "shot-image", version: 2 }), "镜头图片 v2");
  assert.equal(derivedLabel({ displayName: null, originalFilename: null, kind: null, version: 1 }), "未分类素材 v1");
});

test("the demo seed declares what it seeds, and leaves ONLY its deliberate inbox items unclassified", async () => {
  const { seedDemoProject } = await import("../fixtures/demo-project.js");
  const genlib = await import("../src/workflow/genlib.js");
  const tl = await import("../src/workflow/timeline.js");
  const st = await import("../src/workflow/storydoc.js");
  const pd = await import("../src/workflow/proddoc.js");

  const assets = createRegistry(null);
  seedDemoProject({
    story: st.createStory(null),
    production: pd.createProduction(null),
    scripts: Object.create(null),
    assets,
    generations: genlib.createGenerationRegistry(null),
    timelines: tl.createTimelines(null),
  });

  const all = listAssets(assets);
  assert.ok(all.length > 20);
  const unclassified = all.filter((a) => a.kind === null);
  // the demo INTENDS a handful of unowned imports (the Asset Inbox tier-C
  // demonstration). Everything else it seeds is declared, because a demo of the
  // registration feature that showed 全部待分类 would misrepresent it.
  assert.ok(unclassified.length > 0, "the inbox demonstration still needs its unowned items");
  assert.ok(
    unclassified.length < all.length / 3,
    `${unclassified.length}/${all.length} demo assets are unclassified — the seed stopped declaring`,
  );
  for (const a of unclassified) assert.equal(a.needsReview, true);
  // and the declared ones really carry their canonical context
  const charRefs = all.filter((a) => a.kind === "character-reference");
  assert.ok(charRefs.length >= 2);
  for (const a of charRefs) assert.ok(a.links.characterId, "a character reference names its character");
  const shotImages = all.filter((a) => a.kind === "shot-image");
  assert.ok(shotImages.length > 0);
  for (const a of shotImages) assert.ok(a.links.shotId && a.links.sceneId && a.links.episodeId);
});

test("a registered asset is findable by id with its declaration attached", () => {
  const reg = createRegistry(null);
  const ref = refFromResponse("v1-1", "upload", { url: "/u/a.png", version: 1 }, "shot-a");
  declare(ref, "images", { kind: "shot-image", links: { shotId: "shot-a" } });
  addVersion({ uploads: reg.images }, "v1-1", ref);
  const hit = findAssetById(reg, ref.assetId);
  assert.ok(hit);
  assert.equal(hit.record.kind, "shot-image");
});

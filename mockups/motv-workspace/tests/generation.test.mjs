// Checkpoint M5 — Project Generation Registry (durable provenance) + Asset
// storage lifecycle. Run via `node --test`. Owned by the frontend suite (gate frontend tier + CI).
//
// Covers: generationId stability; frozen input/prompt/target snapshot;
// success/failed/cancelled transitions; completion AFTER the world changed does
// not rewrite provenance; duplicate completion stays consistent; deterministic
// v4→v5 backfill from AI-origin Assets only (never upload, never manufactured
// prompt/model); result↔Asset linkage; storageState decoupled from provenance
// (byte availability can change without touching Generation history); v5
// validation invariants; legacy load; M3/M4 identity invariants preserved.
import test from "node:test";
import assert from "node:assert/strict";

import { CANVAS_SCHEMA_VERSION, migrateToCurrent } from "../src/services/canvasschema.js";
import {
  createGenerationRegistry,
  startGeneration,
  findGeneration,
  completeGeneration,
  completeGenerationByTask,
  failGeneration,
} from "../src/workflow/genlib.js";
import { createRegistry, setStorageState, addCut } from "../src/workflow/assetlib.js";
import { refFromResponse } from "../src/workflow/mediaref.js";

// A v4 canvas save (pre-M5): image chain with an upload + a paid-image version,
// an adopted video, a tts voice. Migration must backfill generations for the
// THREE AI results only (never the upload) and stamp storageState on all.
function v4Doc() {
  return {
    v: 4,
    project: "p",
    scriptDoc: null,
    assets: {
      images: { "v1-1": { current: 2, history: [
        { slot_id: "v1-1", origin: "upload", version: 1, digest: null, url: "/u/a1.png", assetId: "asset-1", creativeShotId: "shot-a" },
        { slot_id: "v1-1", origin: "paid-image", version: 2, digest: "d2", url: "/u/a2.png", assetId: "asset-2", creativeShotId: "shot-a" },
      ] } },
      videos: { "v1-1": { current: 1, history: [
        { slot_id: "v1-1", origin: "adopted", version: 1, digest: null, url: "/u/v1.mp4", assetId: "asset-3", creativeShotId: "shot-a" },
      ] } },
      audio: { "voice-v1-1": { current: 1, history: [
        { slot_id: "voice-v1-1", origin: "tts", version: 1, digest: null, url: "/u/t1.wav", assetId: "asset-4", creativeShotId: null },
      ] } },
      firstFrames: {}, finals: [], displaced: [],
    },
    nodes: [{ id: "g", type: "scriptgen", x: 0, y: 0, versions: [] }],
    edges: [], pan: { x: 0, y: 0 },
  };
}

// --- genlib unit: identity + frozen snapshot + race-safe transitions ------- //

test("startGeneration mints a stable id and freezes the launch snapshot", () => {
  const reg = [];
  const g = startGeneration(reg, {
    type: "video", targetType: "shot", targetId: "shot-a",
    inputAssetIds: ["asset-img-1"], promptSnapshot: "P", provider: "X", model: "m",
    parameters: { seed: 7 }, createdAt: "t0",
  });
  assert.match(g.generationId, /^gen-/);
  assert.equal(g.status, "generating");
  assert.deepEqual(g.resultAssetIds, []);
  assert.equal(reg.length, 1);
  assert.equal(findGeneration(reg, g.generationId), g);
  // a typeless generation carries no usable provenance → rejected
  assert.equal(startGeneration(reg, { promptSnapshot: "x" }), null);
  assert.equal(reg.length, 1);
});

test("a status outside the vocabulary is REJECTED, not coerced to 生成中", () => {
  // TASK-061 independent review F1: coercing it wrote a record that looks like
  // a running job and can never move again — the caller got a non-null record
  // and no error, and the UI showed 生成中 forever.
  const reg = [];
  assert.equal(startGeneration(reg, { type: "video", status: "succeeded", createdAt: "t0" }), null);
  assert.equal(startGeneration(reg, { type: "video", status: "", createdAt: "t0" }), null);
  assert.equal(reg.length, 0, "nothing was written");
  // every real value is accepted, and an ABSENT status still means "starting"
  for (const st of ["queued", "generating", "success", "failed", "cancelled"]) {
    assert.equal(startGeneration(reg, { type: "image", status: st, createdAt: "t0" }).status, st);
  }
  assert.equal(startGeneration(reg, { type: "image", createdAt: "t0" }).status, "generating");
  assert.equal(startGeneration(reg, { type: "image", status: null, createdAt: "t0" }).status, "generating");
});

test("generationId is stable across a persistence round-trip", () => {
  const reg = [];
  const g = startGeneration(reg, { type: "image", targetId: "shot-a", createdAt: "t0" });
  const reload = createGenerationRegistry(JSON.parse(JSON.stringify(reg)));
  assert.equal(reload.length, 1);
  assert.equal(reload[0].generationId, g.generationId);
  assert.equal(findGeneration(reload, g.generationId).generationId, g.generationId);
});

test("completion NEVER rewrites the frozen inputs/prompt/target (world may have changed)", () => {
  const reg = [];
  const g = startGeneration(reg, {
    type: "video", targetId: "shot-a", inputAssetIds: ["asset-img-1"],
    promptSnapshot: "the original prompt", createdAt: "t0",
  });
  // (the active Shot / active image could have changed by now — irrelevant:
  // completion only attaches results, never re-derives the launch snapshot)
  completeGeneration(reg, g.generationId, ["asset-vid-1"]);
  assert.equal(g.status, "success");
  assert.equal(g.targetId, "shot-a");
  assert.deepEqual(g.inputAssetIds, ["asset-img-1"]);
  assert.equal(g.promptSnapshot, "the original prompt");
  assert.deepEqual(g.resultAssetIds, ["asset-vid-1"]);
});

test("duplicate completion is idempotent; distinct results union (no inconsistency)", () => {
  const reg = [];
  const g = startGeneration(reg, { type: "image", createdAt: "t0" });
  completeGeneration(reg, g.generationId, ["asset-x"]);
  completeGeneration(reg, g.generationId, ["asset-x"]); // duplicate callback
  assert.deepEqual(g.resultAssetIds, ["asset-x"]);
  completeGeneration(reg, g.generationId, ["asset-y"]); // a second, distinct result
  assert.deepEqual(g.resultAssetIds, ["asset-x", "asset-y"]);
});

test("a stale completion after cancel/fail does not resurrect the record", () => {
  const reg = [];
  const g = startGeneration(reg, { type: "video", createdAt: "t0" });
  failGeneration(reg, g.generationId, "cancelled");
  completeGeneration(reg, g.generationId, ["asset-late"]); // stale late arrival
  assert.equal(g.status, "cancelled");
  assert.deepEqual(g.resultAssetIds, []);
});

test("a late failure never undoes a real success", () => {
  const reg = [];
  const g = startGeneration(reg, { type: "audio", createdAt: "t0" });
  completeGeneration(reg, g.generationId, ["asset-ok"]);
  failGeneration(reg, g.generationId, "failed");
  assert.equal(g.status, "success");
  assert.deepEqual(g.resultAssetIds, ["asset-ok"]);
});

test("startGeneration DEEP-FREEZES parameters (later caller edits cannot leak in)", () => {
  const reg = [];
  const params = { seed: 1, nested: { a: 1 }, task_id: "t-1" };
  const g = startGeneration(reg, { type: "video", parameters: params, createdAt: "t0" });
  // mutate the caller's object AFTER launch — the frozen snapshot must not change
  params.seed = 999;
  params.nested.a = 999;
  assert.equal(g.parameters.seed, 1);
  assert.equal(g.parameters.nested.a, 1);
  assert.notEqual(g.parameters, params); // a copy, not the same reference
});

test("startGeneration normalizes targetType to agree with targetId (no mismatch saves)", () => {
  const reg = [];
  const a = startGeneration(reg, { type: "video", targetId: "shot-a", targetType: null, createdAt: "t0" });
  assert.equal(a.targetType, "shot"); // an id is present → shot
  assert.equal(a.targetId, "shot-a");
  const b = startGeneration(reg, { type: "image", targetType: "shot", targetId: null, createdAt: "t0" });
  assert.equal(b.targetType, null); // no id → no shot target
  assert.equal(b.targetId, null);
});

test("completeGenerationByTask reconciles the ACTIVE record, never an older success", () => {
  const reg = [];
  const old = startGeneration(reg, { type: "video", parameters: { task_id: "t-dup" }, createdAt: "t0" });
  completeGeneration(reg, old.generationId, ["asset-old"]); // old is now a success
  const active = startGeneration(reg, { type: "video", parameters: { task_id: "t-dup" }, createdAt: "t1" });
  const done = completeGenerationByTask(reg, "t-dup", ["asset-new"]);
  assert.equal(done.generationId, active.generationId); // the ACTIVE one, not the old success
  assert.deepEqual(old.resultAssetIds, ["asset-old"]); // old success untouched
  assert.deepEqual(active.resultAssetIds, ["asset-new"]);
  // a second reconcile of the same task finds no active record → idempotent no-op
  assert.equal(completeGenerationByTask(reg, "t-dup", ["asset-x"]), null);
});

test("completeGenerationByTask reconciles at one active; concurrent same-task → SAFE no-op (never misattribute)", () => {
  const reg = [];
  const a = startGeneration(reg, { type: "video", parameters: { task_id: "t-c" }, createdAt: "t0" });
  const b = startGeneration(reg, { type: "video", parameters: { task_id: "t-c" }, createdAt: "t1" });
  // two concurrent actives share the deterministic per-shot task → refuse to GUESS
  assert.equal(completeGenerationByTask(reg, "t-c", ["asset-x"]), null);
  assert.equal(a.status, "generating"); // never misattributed…
  assert.equal(b.status, "generating"); // …to the wrong launch's frozen inputs
  // once one terminates, EXACTLY ONE active remains → reconciles fully
  failGeneration(reg, a.generationId, "cancelled");
  const done = completeGenerationByTask(reg, "t-c", ["asset-x"]);
  assert.equal(done.generationId, b.generationId);
  assert.deepEqual(b.resultAssetIds, ["asset-x"]);
});

test("startGeneration REDACTS secret-shaped keys (snake_case AND camelCase)", () => {
  const reg = [];
  const g = startGeneration(reg, {
    type: "video", createdAt: "t0",
    parameters: {
      prompt: "p", model: "m", task_id: "t1", monkey: "keep",
      api_key: "x", apiKey: "y", accessToken: "z", clientSecret: "s",
      cookie: "c", sessionCookie: "sc", "openai.api_key": "leak", "x api key": "leak2",
      nested: { password: "p", ok: 1 },
    },
  });
  assert.equal(g.parameters.prompt, "p"); // legitimate provenance kept
  assert.equal(g.parameters.task_id, "t1"); // correlation id is not a secret
  assert.equal(g.parameters.monkey, "keep"); // 'key' as an inner substring must NOT match
  for (const k of ["api_key", "apiKey", "accessToken", "clientSecret", "cookie", "sessionCookie", "openai.api_key", "x api key"]) {
    assert.equal(k in g.parameters, false);
  }
  assert.equal("password" in g.parameters.nested, false); // recursively
  assert.equal(g.parameters.nested.ok, 1);
});

test("startGeneration scrubs a credential embedded in a URL string value", () => {
  const reg = [];
  const g = startGeneration(reg, {
    type: "video", createdAt: "t0",
    parameters: { endpoint: "https://user:s3cr3t@api.example.com/v1", plain: "https://api.example.com/v1" },
  });
  assert.equal(g.parameters.endpoint, "https://<redacted>@api.example.com/v1"); // userinfo removed
  assert.equal(g.parameters.plain, "https://api.example.com/v1"); // a credential-free URL is untouched
});

test("startGeneration degrades a CYCLIC (non-JSON-persistable) parameters object to null", () => {
  const reg = [];
  const params = { prompt: "p", task_id: "t1" };
  params.self = params; // cyclic → cannot be JSON-persisted
  const g = startGeneration(reg, { type: "video", parameters: params, createdAt: "t0" });
  assert.ok(g); // launch did NOT throw (no overflow, no persist-time crash)
  assert.equal(g.parameters, null); // a non-persistable snapshot degrades to null
});

test("completeGenerationByTask reconciles a generating record after its closure is gone", () => {
  const reg = [];
  const g = startGeneration(reg, { type: "video", parameters: { task_id: "t-1" }, createdAt: "t0" });
  // simulate a post-reload registry (fresh objects, no in-memory generationId)
  const reload = createGenerationRegistry(JSON.parse(JSON.stringify(reg)));
  const done = completeGenerationByTask(reload, "t-1", ["asset-v"]);
  assert.equal(done.generationId, g.generationId);
  assert.equal(reload[0].status, "success");
  assert.deepEqual(reload[0].resultAssetIds, ["asset-v"]);
  // unknown task → null; a terminal record is never reconciled
  assert.equal(completeGenerationByTask(reload, "nope", ["x"]), null);
  failGeneration(reload, g.generationId, "cancelled"); // already success → stays success
  assert.equal(reload[0].status, "success");
});

test("createGenerationRegistry drops non-object junk, keeps real records", () => {
  const reg = createGenerationRegistry([null, 7, { generationId: "gen-1", type: "image" }, "x"]);
  assert.equal(reg.length, 1);
  assert.equal(reg[0].generationId, "gen-1");
  assert.deepEqual(createGenerationRegistry(undefined), []);
  assert.deepEqual(createGenerationRegistry("nope"), []);
});

// --- v4 → v5 migration: deterministic backfill from AI-origin Assets only -- //

test("v4→v5 backfills a Generation for every AI-origin Asset, never uploads", () => {
  const res = migrateToCurrent(v4Doc());
  assert.equal(res.status, "ok");
  assert.equal(res.doc.v, CANVAS_SCHEMA_VERSION);
  const gens = res.doc.generations;
  // exactly the paid-image + adopted + tts results — NOT the upload
  assert.equal(gens.length, 3);
  const byResult = new Map(gens.map((g) => [g.resultAssetIds[0], g]));
  assert.ok(byResult.has("asset-2") && byResult.has("asset-3") && byResult.has("asset-4"));
  assert.ok(!byResult.has("asset-1")); // upload is not a generation
  assert.equal(byResult.get("asset-2").type, "image");
  assert.equal(byResult.get("asset-3").type, "video");
  assert.equal(byResult.get("asset-4").type, "audio");
  // targetId is the canonical creativeShotId (never a slot); null when unproven
  assert.equal(byResult.get("asset-2").targetId, "shot-a");
  assert.equal(byResult.get("asset-2").targetType, "shot");
  assert.equal(byResult.get("asset-4").targetId, null);
  assert.equal(byResult.get("asset-4").targetType, null);
  // historical prompt/model/params/inputs were never persisted → honest null,
  // never manufactured
  for (const g of gens) {
    assert.equal(g.promptSnapshot, null);
    assert.equal(g.model, null);
    assert.equal(g.provider, null);
    assert.equal(g.parameters, null);
    assert.deepEqual(g.inputAssetIds, []);
    assert.equal(g.createdAt, null);
    assert.equal(g.status, "success");
    assert.match(g.generationId, /^gen-mig-\d+$/);
  }
});

test("v4→v5 stamps storageState 'local' on every durable Asset", () => {
  const a = migrateToCurrent(v4Doc()).doc.assets;
  assert.equal(a.images["v1-1"].history[0].storageState, "local");
  assert.equal(a.images["v1-1"].history[1].storageState, "local");
  assert.equal(a.videos["v1-1"].history[0].storageState, "local");
  assert.equal(a.audio["voice-v1-1"].history[0].storageState, "local");
});

test("v4→v5 backfill is deterministic (same input → identical generations)", () => {
  assert.deepEqual(migrateToCurrent(v4Doc()).doc.generations, migrateToCurrent(v4Doc()).doc.generations);
});

test("v4→v5 IGNORES any pre-existing generations (v4 never had them) and backfills fresh", () => {
  const doc = v4Doc();
  // `generations` is a v5 field; a v4 save carrying it is hand-crafted junk that
  // could partly satisfy v5 invariants while violating others → unloadable if
  // kept. The migration ignores it entirely and rebuilds from the assets.
  doc.generations = [
    { bogus: true }, // malformed
    {
      generationId: "g-stale", type: "image", targetType: "shot", targetId: "wrong",
      inputAssetIds: [], referenceAssetIds: [], userInstruction: null, promptSnapshot: null,
      provider: null, model: null, parameters: null, status: "success",
      resultAssetIds: ["asset-2"], createdAt: null,
    },
  ];
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok"); // always a valid v5, never unloadable
  const ids = res.doc.generations.map((g) => g.generationId);
  assert.ok(!ids.includes("g-stale")); // pre-existing dropped
  assert.ok(ids.every((id) => /^gen-mig-\d+$/.test(id))); // purely freshly backfilled
  // asset-2 (paid-image) still gets its backfilled generation
  assert.ok(res.doc.generations.some((g) => g.resultAssetIds.includes("asset-2")));
});

test("legacy v1 / v2-less-generations saves still load to a valid v5", () => {
  const v1 = { v: 1, project: "p", scriptDoc: null, nodes: [{ id: "g", type: "scriptgen", x: 0, y: 0, versions: [] }], edges: [], pan: { x: 0, y: 0 } };
  const r1 = migrateToCurrent(v1);
  assert.equal(r1.status, "ok");
  assert.equal(r1.doc.v, CANVAS_SCHEMA_VERSION);
  assert.ok(Array.isArray(r1.doc.generations)); // empty but present
});

// --- v5 validation invariants --------------------------------------------- //

test("v5 rejects a document missing its generations registry", () => {
  const doc = migrateToCurrent(v4Doc()).doc;
  delete doc.generations;
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "invalid");
  assert.match(res.detail, /missing its generations registry/);
});

test("v5 generation links are shape-checked but TOLERATE a removed/dangling Asset", () => {
  const doc = migrateToCurrent(v4Doc()).doc;
  // provenance must OUTLIVE the media: a generation pointing at assets that were
  // later removed (Remove-Local-Copy / replace / permanent-delete) must not make
  // the whole canvas unloadable.
  doc.generations.push({
    generationId: "gen-dangle", type: "video", targetType: "shot", targetId: "shot-a",
    inputAssetIds: ["asset-since-deleted"], referenceAssetIds: [], userInstruction: null,
    promptSnapshot: null, provider: null, model: null, parameters: null,
    status: "success", resultAssetIds: ["asset-also-gone"], createdAt: null,
  });
  assert.equal(migrateToCurrent(doc).status, "ok");
});

test("v5 still rejects a MALFORMED (non-string) generation link", () => {
  const doc = migrateToCurrent(v4Doc()).doc;
  doc.generations.push({
    generationId: "gen-bad", type: "video", targetType: null, targetId: null,
    inputAssetIds: [42], referenceAssetIds: [], userInstruction: null, promptSnapshot: null,
    provider: null, model: null, parameters: null, status: "success", resultAssetIds: [], createdAt: null,
  });
  assert.match(migrateToCurrent(doc).detail, /non-string id/);
});

test("v5 rejects a generation whose target is a slot, not a canonical shot", () => {
  const doc = migrateToCurrent(v4Doc()).doc;
  doc.generations.push({
    generationId: "gen-slot", type: "video", targetType: "slot", targetId: "v1-1",
    inputAssetIds: [], referenceAssetIds: [], userInstruction: null, promptSnapshot: null,
    provider: null, model: null, parameters: null, status: "success",
    resultAssetIds: [], createdAt: null,
  });
  assert.match(migrateToCurrent(doc).detail, /invalid targetType/);
});

test("v5 rejects a generation whose targetType/targetId disagree", () => {
  const mk = (targetType, targetId) => {
    const doc = migrateToCurrent(v4Doc()).doc;
    doc.generations.push({
      generationId: "gen-m", type: "video", targetType, targetId,
      inputAssetIds: [], referenceAssetIds: [], userInstruction: null, promptSnapshot: null,
      provider: null, model: null, parameters: null, status: "success", resultAssetIds: [], createdAt: null,
    });
    return migrateToCurrent(doc);
  };
  assert.match(mk("shot", null).detail, /inconsistent target/); // shot type, no id
  assert.match(mk(null, "shot-a").detail, /inconsistent target/); // id, no shot type
  assert.equal(mk("shot", "shot-a").status, "ok"); // agreeing → fine
  assert.equal(mk(null, null).status, "ok"); // no target → fine
});

test("a video generation input referencing a STANDALONE first frame validates at v5", () => {
  const doc = migrateToCurrent(v4Doc()).doc;
  // a standalone first frame (its OWN id, not an image alias) — a valid video
  // generation input that lives outside the history/finals id sets
  doc.assets.firstFrames["v1-1"] = {
    slot_id: "v1-1", version: 1, url: "/u/frame.png", assetId: "asset-frame",
    digest: null, storageState: "local",
  };
  doc.generations.push({
    generationId: "gen-vf", type: "video", targetType: "shot", targetId: "shot-a",
    inputAssetIds: ["asset-frame"], referenceAssetIds: [], userInstruction: null,
    promptSnapshot: null, provider: null, model: null, parameters: null,
    status: "success", resultAssetIds: ["asset-3"], createdAt: null,
  });
  assert.equal(migrateToCurrent(doc).status, "ok"); // standalone frame is a real Asset link
});

test("a runtime-composed final carries storageState and still validates at v5", () => {
  const doc = migrateToCurrent(v4Doc()).doc;
  const reg = createRegistry(doc.assets); // reg.finals aliases doc.assets.finals
  const fin = addCut(reg, "/u/final.mp4"); // appended to the shared finals array
  assert.equal(fin.storageState, "local");
  assert.equal(migrateToCurrent(doc).status, "ok"); // the composed final validates at v5
});

test("v5 rejects duplicate generationId / invalid type / invalid status", () => {
  const mk = (over) => {
    const doc = migrateToCurrent(v4Doc()).doc;
    doc.generations.push({
      generationId: "gen-dup", type: "image", targetType: null, targetId: null,
      inputAssetIds: [], referenceAssetIds: [], userInstruction: null, promptSnapshot: null,
      provider: null, model: null, parameters: null, status: "success",
      resultAssetIds: [], createdAt: null, ...over,
    });
    return migrateToCurrent(doc);
  };
  const dup = mk({ generationId: "gen-mig-1" }); // collides with a backfilled id
  assert.equal(dup.status, "invalid");
  assert.match(dup.detail, /duplicate generationId/);
  assert.match(mk({ type: "hologram" }).detail, /invalid type/);
  assert.match(mk({ status: "paused" }).detail, /invalid status/);
});

test("v5 rejects an Asset record with a missing/invalid storageState", () => {
  const missing = migrateToCurrent(v4Doc()).doc;
  delete missing.assets.images["v1-1"].history[0].storageState;
  assert.match(migrateToCurrent(missing).detail, /invalid storageState/);
  const bad = migrateToCurrent(v4Doc()).doc;
  bad.assets.videos["v1-1"].history[0].storageState = "cloud-somewhere";
  assert.match(migrateToCurrent(bad).detail, /invalid storageState/);
});

test("v4→v5 NORMALIZES a pre-existing invalid storageState (stays loadable)", () => {
  const doc = v4Doc();
  // v4 permitted arbitrary unknown fields — a bogus storageState must not make
  // the migrated v5 doc unloadable; the migration overwrites it with 'local'.
  doc.assets.images["v1-1"].history[0].storageState = "garbage";
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  assert.equal(res.doc.assets.images["v1-1"].history[0].storageState, "local");
});

// --- storage lifecycle decoupled from provenance -------------------------- //

test("storageState can change to missing/deleted WITHOUT touching Generation history", () => {
  const doc = migrateToCurrent(v4Doc()).doc;
  const reg = createRegistry(doc.assets);
  // release the local video bytes (future Remove-Local-Copy) — identity kept
  assert.equal(setStorageState(reg, "asset-3", "missing"), true);
  const vid = reg.videos["v1-1"].history[0];
  assert.equal(vid.storageState, "missing");
  assert.equal(vid.assetId, "asset-3"); // identity untouched
  assert.equal(vid.url, "/u/v1.mp4"); // last-known location kept for provenance
  // the Generation that produced it is entirely unaffected
  const g = doc.generations.find((x) => x.resultAssetIds.includes("asset-3"));
  assert.ok(g && g.status === "success");
  assert.deepEqual(g.resultAssetIds, ["asset-3"]);
  // and a permanently-deleted Asset still keeps its record so the lineage holds
  assert.equal(setStorageState(reg, "asset-3", "deleted"), true);
  assert.equal(reg.videos["v1-1"].history[0].storageState, "deleted");
  assert.equal(setStorageState(reg, "nope", "missing"), false); // unknown asset
  assert.equal(setStorageState(reg, "asset-3", "banana"), false); // invalid state
});

// --- M3 / M4 identity invariants preserved -------------------------------- //

test("v4→v5 leaves assetId + creativeShotId (M3/M4) untouched", () => {
  const before = v4Doc();
  const a = migrateToCurrent(v4Doc()).doc.assets;
  const b = before.assets;
  for (const [dom, key] of [["images", "v1-1"], ["videos", "v1-1"], ["audio", "voice-v1-1"]]) {
    a[dom][key].history.forEach((r, i) => {
      assert.equal(r.assetId, b[dom][key].history[i].assetId);
      assert.equal(r.creativeShotId, b[dom][key].history[i].creativeShotId);
      assert.equal(r.url, b[dom][key].history[i].url);
      assert.equal(r.version, b[dom][key].history[i].version);
    });
  }
});

// --- runtime ref carries storageState (new media = local bytes) ----------- //

test("refFromResponse stamps a fresh Asset storageState 'local'", () => {
  const r = refFromResponse("v1-1", "paid-image", { url: "/u/x.png", version: 1, sha256: "h" }, "shot-a");
  assert.equal(r.storageState, "local");
  assert.equal(r.creativeShotId, "shot-a");
});

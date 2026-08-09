// Checkpoint M4a — canonical creative-Shot ↔ slot resolver + v3→v4 rename.
// Run via `node --test`, wrapped by tests/test_motv_shotmap_m4a.py.
//
// Covers: the v3→v4 field rename (shot_id → creativeShotId) is deterministic
// and non-destructive; the pure resolver bridges creative shotId ↔ storage
// slot over the authoritative draft; identity (not position) — reorder /
// insert / delete cannot shift another shot's binding; ambiguity resolves to
// null and NEVER a positional-sequence fallback.
import test from "node:test";
import assert from "node:assert/strict";

import { CANVAS_SCHEMA_VERSION, migrateToCurrent } from "../src/services/canvasschema.js";
import {
  buildShotSlotIndex, slotForShotId, shotIdForSlot,
  buildServerBridge, serverShotIdForShot,
} from "../src/workflow/shotmap.js";

const rec = (slot, url, extra = {}) => ({ slot_id: slot, origin: "upload", version: 1, digest: null, url, ...extra });

// A v3 document (the M3 shape): media records carry the CREATIVE `shot_id`.
function v3Doc() {
  return {
    v: 3,
    project: "p",
    scriptDoc: null,
    assets: {
      images: {
        "v1-1": { current: 1, history: [rec("v1-1", "/u/a.png", { assetId: "asset-1", shot_id: "shot-a" })] },
      },
      videos: {
        "v1-1": { current: 2, history: [
          rec("v1-1", "/u/v1.mp4", { assetId: "asset-2", shot_id: "shot-a", version: 1 }),
          rec("v1-1", "/u/v2.mp4", { assetId: "asset-3", shot_id: "shot-a", version: 2 }),
        ] },
      },
      audio: {
        "voice-v1-1": { current: 1, history: [rec("voice-v1-1", "/u/voice.wav", { assetId: "asset-4", shot_id: null })] },
      },
      firstFrames: {
        "v1-1": rec("v1-1", "/u/a.png", { assetId: "asset-1", shot_id: "shot-a" }),
      },
      finals: [{ assetId: "asset-5", url: "/u/final.mp4", origin: null }],
      displaced: [],
    },
    nodes: [{ id: "n1", type: "script", x: 0, y: 0, state: "" }],
    edges: [],
    pan: { x: 0, y: 0 },
  };
}

// --- v3 → v4 rename ------------------------------------------------------- //

test("v3→v4 renames creative shot_id to creativeShotId on every media record", () => {
  const res = migrateToCurrent(v3Doc());
  assert.equal(res.status, "ok");
  assert.equal(res.doc.v, CANVAS_SCHEMA_VERSION);
  const a = res.doc.assets;
  // renamed on chain history (images/videos/audio) and firstFrames…
  assert.equal(a.images["v1-1"].history[0].creativeShotId, "shot-a");
  assert.equal(a.videos["v1-1"].history[0].creativeShotId, "shot-a");
  assert.equal(a.videos["v1-1"].history[1].creativeShotId, "shot-a");
  assert.equal(a.audio["voice-v1-1"].history[0].creativeShotId, null);
  assert.equal(a.firstFrames["v1-1"].creativeShotId, "shot-a");
  // …and the collided name is gone everywhere
  for (const dom of ["images", "videos", "audio"]) {
    for (const k of Object.keys(a[dom])) for (const r of a[dom][k].history) assert.ok(!("shot_id" in r));
  }
  assert.ok(!("shot_id" in a.firstFrames["v1-1"]));
});

test("v3→v4 is non-destructive: assetId/url/slot/version/current/history preserved", () => {
  const before = v3Doc();
  const res = migrateToCurrent(v3Doc());
  const a = res.doc.assets;
  // strip creativeShotId back to shot_id and the doc must equal the original v3
  const strip = (r) => { r.shot_id = "creativeShotId" in r ? r.creativeShotId : r.shot_id; delete r.creativeShotId; };
  for (const dom of ["images", "videos", "audio"]) for (const k of Object.keys(a[dom])) a[dom][k].history.forEach(strip);
  strip(a.firstFrames["v1-1"]);
  res.doc.v = 3;
  assert.deepEqual(res.doc, before);
});

test("v3→v4 is deterministic (same input → identical output)", () => {
  assert.deepEqual(migrateToCurrent(v3Doc()).doc, migrateToCurrent(v3Doc()).doc);
});

test("v3→v4 leaves a record that ALREADY has creativeShotId alone (idempotent-ish)", () => {
  const doc = v3Doc();
  doc.assets.images["v1-1"].history[0] = rec("v1-1", "/u/a.png", { assetId: "asset-1", creativeShotId: "shot-keep" });
  const res = migrateToCurrent(doc);
  assert.equal(res.doc.assets.images["v1-1"].history[0].creativeShotId, "shot-keep");
});

test("a fresh v1 save reaches v4 with creative refs named creativeShotId", () => {
  const v1 = {
    v: 1, project: "p", scriptDoc: null,
    nodes: [
      { id: "g", type: "scriptgen", x: 0, y: 0, state: "done", cur: 1, versions: [{ v: 1, draft: true, shots: [["01", "甲"]], raw: [{ shotId: "shot-x", sequence: 1, title: "甲", slot: "v1-1" }] }] },
      { id: "a", type: "assets", x: 1, y: 0, uploads: { "v1-1": "/u/legacy.png" } },
    ],
    edges: [], pan: { x: 0, y: 0 },
  };
  const res = migrateToCurrent(v1);
  assert.equal(res.status, "ok");
  assert.equal(res.doc.v, CANVAS_SCHEMA_VERSION);
  const r = res.doc.assets.images["v1-1"].history[0];
  assert.ok("creativeShotId" in r && !("shot_id" in r));
  assert.equal(r.creativeShotId, "shot-x"); // provable slot→shot from the draft
});

// --- resolver behavior ---------------------------------------------------- //

const draft = (...rows) => rows.map(([shotId, slot], i) => ({ shotId, slot, sequence: i + 1, title: shotId }));

test("resolver bridges shotId ↔ slot both ways over the authoritative draft", () => {
  const idx = buildShotSlotIndex(draft(["shot-a", "v1-1"], ["shot-b", "v1-2"]));
  assert.equal(slotForShotId(idx, "shot-a"), "v1-1");
  assert.equal(slotForShotId(idx, "shot-b"), "v1-2");
  assert.equal(shotIdForSlot(idx, "v1-1"), "shot-a");
  assert.equal(shotIdForSlot(idx, "v1-2"), "shot-b");
  // unknown → null, never a guess
  assert.equal(slotForShotId(idx, "shot-z"), null);
  assert.equal(shotIdForSlot(idx, "v9-9"), null);
});

test("ambiguity resolves to null in BOTH directions (M4 decision #5)", () => {
  // a slot claimed by two different shotIds, and a shotId with two slots
  const idx = buildShotSlotIndex([
    { shotId: "shot-a", slot: "v1-1", sequence: 1 },
    { shotId: "shot-b", slot: "v1-1", sequence: 2 }, // dup slot v1-1
    { shotId: "shot-c", slot: "v1-3", sequence: 3 },
    { shotId: "shot-c", slot: "v1-4", sequence: 4 }, // dup shotId shot-c
    { shotId: "shot-d", slot: "v1-5", sequence: 5 }, // the one clean binding
  ]);
  // dup slot: neither the slot NOR either claiming shot resolves
  assert.equal(shotIdForSlot(idx, "v1-1"), null);
  assert.equal(slotForShotId(idx, "shot-a"), null);
  assert.equal(slotForShotId(idx, "shot-b"), null);
  // dup shotId: neither the shot NOR either of its slots resolves
  assert.equal(slotForShotId(idx, "shot-c"), null);
  assert.equal(shotIdForSlot(idx, "v1-3"), null);
  assert.equal(shotIdForSlot(idx, "v1-4"), null);
  // the single clean binding is unaffected by others' ambiguity
  assert.equal(slotForShotId(idx, "shot-d"), "v1-5");
  assert.equal(shotIdForSlot(idx, "v1-5"), "shot-d");
});

test("a shot with a shotId but no slot resolves to null (no slot binding yet)", () => {
  const idx = buildShotSlotIndex([{ shotId: "shot-a", slot: null, sequence: 1 }]);
  assert.equal(slotForShotId(idx, "shot-a"), null);
});

test("resolver ignores malformed rows and empty input", () => {
  const idx = buildShotSlotIndex([null, "x", 5, { shotId: "shot-a", slot: "v1-1" }]);
  assert.equal(slotForShotId(idx, "shot-a"), "v1-1");
  const empty = buildShotSlotIndex(undefined);
  assert.equal(slotForShotId(empty, "shot-a"), null);
});

test("resolver tolerates a null OR malformed index without throwing", () => {
  for (const bad of [null, undefined, {}, "nope", 5, { slotByShotId: null }, { slotByShotId: {} }, { slotByShotId: { get: "notafn" } }]) {
    assert.equal(slotForShotId(bad, "shot-a"), null); // never throws, always null
  }
  for (const bad of [null, undefined, {}, { shotIdBySlot: {} }, { shotIdBySlot: { get: 7 } }]) {
    assert.equal(shotIdForSlot(bad, "v1-1"), null);
  }
});

// --- identity NOT position: reorder / insert / delete --------------------- //

test("REORDER preserves every shotId↔slot binding", () => {
  const before = draft(["shot-a", "v1-1"], ["shot-b", "v1-2"], ["shot-c", "v1-3"]);
  const reordered = [before[2], before[0], before[1]]; // c, a, b — sequence would shift
  const i0 = buildShotSlotIndex(before);
  const i1 = buildShotSlotIndex(reordered);
  for (const sid of ["shot-a", "shot-b", "shot-c"]) {
    assert.equal(slotForShotId(i1, sid), slotForShotId(i0, sid));
  }
});

test("INSERT adds a new binding without changing any surviving one", () => {
  const before = draft(["shot-a", "v1-1"], ["shot-b", "v1-2"]);
  const withInsert = [before[0], { shotId: "shot-new", slot: "v2-2", sequence: 2 }, before[1]];
  const i0 = buildShotSlotIndex(before);
  const i1 = buildShotSlotIndex(withInsert);
  assert.equal(slotForShotId(i1, "shot-a"), "v1-1"); // unchanged
  assert.equal(slotForShotId(i1, "shot-b"), "v1-2"); // unchanged despite sequence shift
  assert.equal(slotForShotId(i1, "shot-new"), "v2-2"); // new binding
  assert.equal(slotForShotId(i0, "shot-new"), null); // absent before
});

test("DELETE removes only the deleted binding; survivors are stable", () => {
  const before = draft(["shot-a", "v1-1"], ["shot-b", "v1-2"], ["shot-c", "v1-3"]);
  const withDelete = [before[0], before[2]]; // shot-b deleted
  const i1 = buildShotSlotIndex(withDelete);
  assert.equal(slotForShotId(i1, "shot-a"), "v1-1");
  assert.equal(slotForShotId(i1, "shot-c"), "v1-3"); // did NOT shift into shot-b's old slot
  assert.equal(slotForShotId(i1, "shot-b"), null); // gone
  assert.equal(shotIdForSlot(i1, "v1-2"), null); // its slot is unbound now
});

// --- M4c: creativeShotId ↔ server official shot_id bridge ----------------- //

const lockRec = (shot_id, creativeShotId, sequence) => ({ shot_id, creativeShotId, sequence });

test("buildServerBridge maps clean 1:1 creativeShotId → server shot_id", () => {
  const b = buildServerBridge([
    lockRec("shot-p2-1", "shot-a", 1),
    lockRec("shot-p2-2", "shot-b", 2),
  ]);
  assert.equal(b.bridged, true);
  assert.equal(b.byCreative.get("shot-a"), "shot-p2-1");
  assert.equal(b.byCreative.get("shot-b"), "shot-p2-2");
});

test("buildServerBridge drops conflicts (dup creativeShotId or dup server id)", () => {
  const dupCreative = buildServerBridge([
    lockRec("shot-p2-1", "shot-a", 1),
    lockRec("shot-p2-2", "shot-a", 2), // same creative id → both dropped
  ]);
  assert.equal(dupCreative.bridged, true);
  assert.equal(dupCreative.byCreative.has("shot-a"), false);
  const dupServer = buildServerBridge([
    lockRec("shot-p2-1", "shot-a", 1),
    lockRec("shot-p2-1", "shot-b", 2), // same server id → both dropped
  ]);
  assert.equal(dupServer.byCreative.has("shot-a"), false);
  assert.equal(dupServer.byCreative.has("shot-b"), false);
});

test("buildServerBridge: legacy records (no creativeShotId KEY) → bridged:false", () => {
  const b = buildServerBridge([{ shot_id: "shot-p1-1", sequence: 1 }, { shot_id: "shot-p1-2", sequence: 2 }]);
  assert.equal(b.bridged, false);
  assert.equal(b.byCreative.size, 0);
});

test("buildServerBridge: an ALL-NULL M4c bridge is still bridged (key present) → NOT legacy", () => {
  // the server nulls creativeShotId on fail-safe but KEEPS the key — this must
  // NOT be misread as a legacy lock (which would sequence-fall-back)
  const b = buildServerBridge([
    { shot_id: "shot-p3-1", creativeShotId: null, sequence: 1 },
    { shot_id: "shot-p3-2", creativeShotId: null, sequence: 2 },
  ]);
  assert.equal(b.bridged, true); // M4c-attempted → resolve by identity or unresolved
  assert.equal(b.byCreative.size, 0);
});

test("buildServerBridge tolerates malformed input", () => {
  assert.equal(buildServerBridge(null).bridged, false);
  assert.equal(buildServerBridge([null, "x", 5]).byCreative.size, 0);
});

test("serverShotIdForShot: M4c lock resolves by creativeShotId, NO sequence fallback", () => {
  const locked = [lockRec("shot-p2-1", "shot-a", 1), lockRec("shot-p2-2", "shot-b", 2)];
  const bridge = buildServerBridge(locked);
  // resolve by identity regardless of the shot's current sequence
  assert.deepEqual(serverShotIdForShot(bridge, locked, { shotId: "shot-b", sequence: 1 }), { id: "shot-p2-2", unresolved: false });
  assert.deepEqual(serverShotIdForShot(bridge, locked, { shotId: "shot-a", sequence: 2 }), { id: "shot-p2-1", unresolved: false });
  // an M4c shot that can't be bridged → unresolved, never `shot-<seq>`
  assert.deepEqual(serverShotIdForShot(bridge, locked, { shotId: "shot-ghost", sequence: 1 }), { id: null, unresolved: true });
  assert.deepEqual(serverShotIdForShot(bridge, locked, { sequence: 1 }), { id: null, unresolved: true }); // no shotId
});

test("serverShotIdForShot: legacy lock (no bridge) uses positional fallback", () => {
  const locked = [{ shot_id: "shot-p1-1", sequence: 1 }, { shot_id: "shot-p1-2", sequence: 2 }];
  const bridge = buildServerBridge(locked);
  assert.equal(serverShotIdForShot(bridge, locked, { shotId: "shot-a", sequence: 2 }).id, "shot-p1-2");
});

test("serverShotIdForShot: no lock → pre-seeded shot-<seq>", () => {
  const bridge = buildServerBridge(null);
  assert.deepEqual(serverShotIdForShot(bridge, null, { shotId: "shot-a", sequence: 3 }), { id: "shot-3", unresolved: false });
});

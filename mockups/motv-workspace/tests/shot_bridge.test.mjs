// Checkpoint M4c/M4d — creativeShotId ↔ server official shot_id bridge, and
// adopt-paid / re-lock resolution by canonical Shot identity. Run via
// `node --test`, wrapped by tests/test_motv_shot_bridge_m4c.py.
import test from "node:test";
import assert from "node:assert/strict";

import { CANVAS_SCHEMA_VERSION, migrateToCurrent } from "../src/services/canvasschema.js";
import {
  buildShotSlotIndex, slotForShotId, shotIdForSlot,
  buildServerBridge, serverShotIdForShot, resolveAdoptTarget,
} from "../src/workflow/shotmap.js";


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

// --- M4d: adopt-paid resolves server shot_id → creative Shot → slot -------- //

const m4cPlan = (v, ...pairs) => ({
  plan_version: v,
  shots: pairs.map(([shot_id, creativeShotId], i) => ({ shot_id, creativeShotId, sequence: i + 1 })),
});
const legacyPlan = (v, ...ids) => ({ plan_version: v, shots: ids.map((shot_id, i) => ({ shot_id, sequence: i + 1 })) });
const dr = (...pairs) => pairs.map(([shotId, slot], i) => ({ shotId, slot, sequence: i + 1, title: shotId }));

test("adopt: M4c server id → creativeShotId → current slot", () => {
  const draft = dr(["shot-a", "v3-1"], ["shot-b", "v3-2"]);
  const plan = m4cPlan(3, ["shot-p3-1", "shot-a"], ["shot-p3-2", "shot-b"]);
  assert.deepEqual(resolveAdoptTarget("shot-p3-1", draft, [plan]), { slot: "v3-1", creativeShotId: "shot-a" });
  assert.deepEqual(resolveAdoptTarget("shot-p3-2", draft, [plan]), { slot: "v3-2", creativeShotId: "shot-b" });
});

test("adopt: reorder/insert/delete cannot move an adopted clip to another shot", () => {
  const plan = m4cPlan(3, ["shot-p3-1", "shot-a"], ["shot-p3-2", "shot-b"]);
  // reordered draft: shot-a is now sequence 2, still owns slot v3-1
  const reordered = dr(["shot-b", "v3-2"], ["shot-a", "v3-1"]);
  assert.equal(resolveAdoptTarget("shot-p3-1", reordered, [plan]).slot, "v3-1"); // follows shot-a
  // deleted shot-b: shot-a still resolves; shot-b's op is now unresolved
  const deleted = dr(["shot-a", "v3-1"]);
  assert.equal(resolveAdoptTarget("shot-p3-1", deleted, [plan]).slot, "v3-1");
  const gone = resolveAdoptTarget("shot-p3-2", deleted, [plan]);
  assert.equal(gone.unresolved, true);
  assert.equal(gone.creativeShotId, "shot-b");
});

test("adopt: RE-LOCK — an in-flight op from a prior plan resolves via its own bridge", () => {
  // op minted under plan v3; user re-locked to v4 (same shots, new server ids)
  const planV3 = m4cPlan(3, ["shot-p3-1", "shot-a"], ["shot-p3-2", "shot-b"]);
  const planV4 = m4cPlan(4, ["shot-p4-1", "shot-a"], ["shot-p4-2", "shot-b"]);
  const draft = dr(["shot-a", "v4-1"], ["shot-b", "v4-2"]);
  // the v3 op still adopts SAFELY into shot-a's current slot (not lost, not wrong)
  assert.deepEqual(
    resolveAdoptTarget("shot-p3-1", draft, [planV4, planV3]),
    { slot: "v4-1", creativeShotId: "shot-a" },
  );
});

test("adopt: RE-LOCK after a regenerate — the creative shot is gone → unresolved, preserved", () => {
  const planV3 = m4cPlan(3, ["shot-p3-1", "shot-a"], ["shot-p3-2", "shot-b"]);
  // regenerated draft: brand-new shotIds (AI replacement), shot-a no longer exists
  const newDraft = dr(["shot-x", "v5-1"], ["shot-y", "v5-2"]);
  const planV5 = m4cPlan(5, ["shot-p5-1", "shot-x"], ["shot-p5-2", "shot-y"]);
  const r = resolveAdoptTarget("shot-p3-1", newDraft, [planV5, planV3]);
  assert.equal(r.unresolved, true);
  assert.equal(r.creativeShotId, "shot-a"); // never silently attached to shot-x
  assert.ok(!("slot" in r));
});

test("adopt: an M4c op absent from its plan's bridge is unresolved, NEVER sequence", () => {
  const plan = m4cPlan(3, ["shot-p3-1", "shot-a"], ["shot-p3-2", "shot-b"]);
  const draft = dr(["shot-a", "v3-1"], ["shot-b", "v3-2"]);
  const r = resolveAdoptTarget("shot-p3-9", draft, [plan]); // not in the bridge
  assert.equal(r.unresolved, true);
  assert.equal(r.reason, "server-shot-id-not-in-bridge");
});

test("adopt: legacy pre-M4c locked plan uses approved positional fallback", () => {
  const plan = legacyPlan(2, "shot-p2-1", "shot-p2-2"); // no creativeShotId
  const draft = dr(["shot-a", "v2-1"], ["shot-b", "v2-2"]);
  assert.deepEqual(resolveAdoptTarget("shot-p2-1", draft, [plan]), { slot: "v2-1", legacy: true });
});

test("adopt: pre-seeded shot-<seq> (no lock) uses positional fallback", () => {
  const draft = dr(["shot-a", "v1-1"], ["shot-b", "v1-2"]);
  assert.deepEqual(resolveAdoptTarget("shot-2", draft, []), { slot: "v1-2", legacy: true });
});

test("adopt: positional fallback matches a numeric-STRING sequence (imported save)", () => {
  // a persisted / imported draft may carry sequence as a string; positional
  // matching must still find it — strict === against a number would miss "2"
  const draft = [
    { shotId: "shot-a", slot: "v1-1", sequence: "1", title: "甲" },
    { shotId: "shot-b", slot: "v1-2", sequence: "2", title: "乙" },
  ];
  assert.deepEqual(resolveAdoptTarget("shot-2", draft, []), { slot: "v1-2", legacy: true });
  // but a boolean (true == 1) or a non-numeric string must NOT coincidentally match
  const bad = [{ shotId: "shot-a", slot: "v1-1", sequence: true, title: "甲" }];
  assert.deepEqual(resolveAdoptTarget("shot-1", bad, []), { legacy: true });
});

test("adopt: positional fallback with a DUPLICATE sequence is ambiguous → no slot", () => {
  // a corrupt/imported draft with two shots at sequence 2 must never arbitrarily
  // pick the first (decision #5) — no provable slot, so it preserves unresolved
  const draft = [
    { shotId: "shot-a", slot: "v1-1", sequence: 1, title: "甲" },
    { shotId: "shot-b", slot: "v1-2", sequence: 2, title: "乙" },
    { shotId: "shot-c", slot: "v1-3", sequence: 2, title: "丙" }, // dup sequence
  ];
  assert.deepEqual(resolveAdoptTarget("shot-2", draft, []), { legacy: true });
  // the unambiguous sequence in the SAME draft still resolves
  assert.deepEqual(resolveAdoptTarget("shot-1", draft, []), { slot: "v1-1", legacy: true });
});

test("adopt: ambiguous current-draft slot → unresolved, never guessed", () => {
  const plan = m4cPlan(3, ["shot-p3-1", "shot-a"]);
  // shot-a is duplicated in the draft → its slot binding is ambiguous
  const draft = [
    { shotId: "shot-a", slot: "v3-1", sequence: 1 },
    { shotId: "shot-a", slot: "v3-9", sequence: 2 },
  ];
  const r = resolveAdoptTarget("shot-p3-1", draft, [plan]);
  assert.equal(r.unresolved, true);
});

test("adopt: bridge-less HISTORICAL plan op after re-lock resolves positionally by its own seq", () => {
  // op minted under legacy (bridge-less) plan v2, seq 2; user re-locked to v3
  const legacyV2 = legacyPlan(2, "shot-p2-1", "shot-p2-2");
  const v3 = m4cPlan(3, ["shot-p3-1", "shot-a"], ["shot-p3-2", "shot-b"]);
  const draft = dr(["shot-a", "v3-1"], ["shot-b", "v3-2"]);
  // approved legacy positional: op's own seq (2) → current draft position 2 → slot
  assert.deepEqual(resolveAdoptTarget("shot-p2-2", draft, [v3, legacyV2]), { slot: "v3-2", legacy: true });
});

test("adopt: a bridge-less plan op NOT in that plan → unresolved, never positional", () => {
  // plan 2 is legacy (no bridge) with two real shots; shot-p2-9 is malformed —
  // it names plan 2 but no such record exists. It must NOT positional-guess into
  // a coincidental current shot at sequence 9 (decision #5).
  const plan = legacyPlan(2, "shot-p2-1", "shot-p2-2");
  const draft = [
    ...dr(["shot-a", "v2-1"], ["shot-b", "v2-2"]),
    { shotId: "shot-i", slot: "v2-9", sequence: 9, title: "幽灵" }, // a coincidental seq-9 shot
  ];
  const r = resolveAdoptTarget("shot-p2-9", draft, [plan]);
  assert.equal(r.unresolved, true);
  assert.equal(r.reason, "server-shot-id-not-in-plan");
  // a REAL member of the same plan still resolves positionally
  assert.deepEqual(resolveAdoptTarget("shot-p2-2", draft, [plan]), { slot: "v2-2", legacy: true });
});

test("adopt: an M4c-FORMAT op whose plan is GONE → unresolved, never sequence", () => {
  const draft = dr(["shot-a", "v9-1"], ["shot-b", "v9-2"]);
  // no plan v3 present (its scriptgen version was deleted)
  const r = resolveAdoptTarget("shot-p3-1", draft, [m4cPlan(9, ["shot-p9-1", "shot-a"])]);
  assert.equal(r.unresolved, true);
  assert.equal(r.reason, "locked-plan-not-found");
});

test("adopt: colliding plan_version (corrupt) → unresolved, never guess which bridge", () => {
  const a = m4cPlan(3, ["shot-p3-1", "shot-a"]);
  const b = m4cPlan(3, ["shot-p3-1", "shot-b"]); // same plan_version, different bridge
  const draft = dr(["shot-a", "v3-1"], ["shot-b", "v3-2"]);
  const r = resolveAdoptTarget("shot-p3-1", draft, [a, b]);
  assert.equal(r.unresolved, true);
  assert.equal(r.reason, "ambiguous-plan-version");
});

// --- M4c: the locked bridge is durable across a canvas save/reload -------- //

test("the creativeShotId bridge in lockedPlan survives a canvas dispatch round-trip", () => {
  // lockedPlan rides on a scriptgen node version's `locked` (persisted in the
  // canvas save); the paid-op join reads it from there, never re-fetched from
  // Core — so it must round-trip through the schema dispatcher unchanged.
  const doc = {
    v: CANVAS_SCHEMA_VERSION,
    project: "p",
    scriptDoc: null,
    assets: { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [] },
    generations: [], // M5: a current-version doc carries the generation registry
    // M6/M7: …and the production structure (with its bible registries)
    production: {
      activeEpisodeId: "ep-1",
      episodes: [{ episodeId: "ep-1", title: "第 1 集", scenes: [] }],
      characters: [],
      locations: [],
    },
    nodes: [{
      id: "g", type: "scriptgen", x: 0, y: 0, state: "done", cur: 1,
      versions: [{
        id: "sdv-1", v: 1, draft: true,
        raw: [{ shotId: "shot-a", sequence: 1, title: "甲", slot: "v1-1" }],
        locked: {
          plan_version: 3,
          shots: [{ shot_id: "shot-p3-1", creativeShotId: "shot-a", sequence: 1 }],
        },
      }],
    }],
    edges: [],
    pan: { x: 0, y: 0 },
  };
  const res = migrateToCurrent(JSON.parse(JSON.stringify(doc)));
  assert.equal(res.status, "ok");
  const locked = res.doc.nodes[0].versions[0].locked;
  assert.equal(locked.shots[0].creativeShotId, "shot-a"); // bridge preserved
  assert.equal(locked.shots[0].shot_id, "shot-p3-1");
  // and it rebuilds a working bridge on the other side
  const bridge = buildServerBridge(locked.shots);
  assert.equal(bridge.byCreative.get("shot-a"), "shot-p3-1");
});

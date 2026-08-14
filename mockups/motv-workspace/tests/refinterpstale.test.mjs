// TASK-072 §1.9 缺陷 3 — a reading records WHAT it read, and drift is reported.
import test from "node:test";
import assert from "node:assert/strict";

import {
  addReading, readingStanding, interpretationInputs, activeReading,
  serialize, createInterpretations,
} from "../src/workflow/refinterp.js";

const AXES = { cameraLanguage: "低机位缓推" };

function docWith(basedOnVersion) {
  const doc = Object.create(null);
  addReading(doc, "ref-1", {
    axes: AXES, origin: "manual", at: "t1",
    basedOnAssetId: "asset-9", basedOnVersion,
  });
  return doc;
}

test("a reading records the material it was made against", () => {
  const doc = docWith(1);
  const r = activeReading(doc, "ref-1");
  assert.equal(r.basedOnAssetId, "asset-9");
  assert.equal(r.basedOnVersion, 1);
});

test("the SAME version is fresh; an older one is STALE with the real numbers", () => {
  const doc = docWith(1);
  const reading = activeReading(doc, "ref-1");
  assert.equal(readingStanding(reading, { version: 1 }).staleness, "fresh");
  const stale = readingStanding(reading, { version: 2 });
  assert.equal(stale.staleness, "stale");
  // the message states BOTH versions — 「过期了」 alone is not actionable
  assert.match(stale.staleDetail, /针对 v1 写的，当前是 v2/);
});

test("THE THREE EXITS are data, and nothing rewrites the creator's words", () => {
  const stale = readingStanding(activeReading(docWith(1), "ref-1"), { version: 3 });
  assert.deepEqual(stale.resolutions.map((r) => r.action), ["keep", "reread", "unbind"]);
  // the axes are untouched by the staleness derivation — a stale reading stays
  // exactly as written until the creator chooses
  const doc = docWith(1);
  const before = JSON.stringify(activeReading(doc, "ref-1").axes);
  readingStanding(activeReading(doc, "ref-1"), { version: 9 });
  assert.equal(JSON.stringify(activeReading(doc, "ref-1").axes), before);
});

test("a DIFFERENT asset is stale even when the version number coincides", () => {
  // Comparing only the version reported `fresh` after the refKey was rebound to
  // another asset that happened to be at the same version — precisely the false
  // provenance claim 缺陷 3 exists to remove (independent review, batch 2).
  const reading = activeReading(docWith(1), "ref-1"); // basedOnAssetId: asset-9
  const other = readingStanding(reading, { version: 1, assetId: "asset-OTHER" });
  assert.equal(other.staleness, "stale");
  assert.match(other.staleDetail, /另一个素材/);
  assert.equal(other.resolutions.length, 3);
  // the SAME asset at the same version is still fresh
  assert.equal(readingStanding(reading, { version: 1, assetId: "asset-9" }).staleness, "fresh");
  // an unrecorded id cannot prove a mismatch — it stays version-based, never invented
  const legacy = activeReading(docWith(1), "ref-1");
  delete legacy.basedOnAssetId;
  assert.equal(readingStanding(legacy, { version: 1, assetId: "asset-OTHER" }).staleness, "fresh");
});

test("UNKNOWN is not STALE — a legacy reading is not evidence of drift", () => {
  // §3.1 不变量 5 / the same rule `basedOn = 0` follows for media dependencies
  const legacy = activeReading(docWith(null), "ref-1");
  const st = readingStanding(legacy, { version: 2 });
  assert.equal(st.staleness, "unknown");
  assert.match(st.staleDetail, /没有记录它当时读的是哪一版/);
  assert.deepEqual(st.resolutions, [], "an unknown offers no exits — there is nothing to resolve");
  // …and an unreadable CURRENT version is equally unknown, never fresh
  const cur = readingStanding(activeReading(docWith(1), "ref-1"), { version: null });
  assert.equal(cur.staleness, "unknown");
  // no reading at all is its own answer
  assert.equal(readingStanding(null, { version: 1 }).staleness, "none");
});

test("interpretationInputs carries the staleness, so the prompt can report it", () => {
  const doc = docWith(1);
  const refs = [{ key: "ref-1", kind: "motion-reference", name: "推进", version: 2, assetId: "asset-9" }];
  const [row] = interpretationInputs(doc, refs, ["motion-reference"]);
  assert.equal(row.read, true);
  assert.equal(row.staleness, "stale");
  assert.match(row.staleDetail, /v1/);
  assert.equal(row.resolutions.length, 3);
  // the prompt still gets the axes — 「过期」 is a WARNING, not a deletion of the
  // creator's directing note
  assert.deepEqual(row.axes, AXES);
});

test("the fields survive the persistence round-trip", () => {
  // without this, staleness would reset to `unknown` on every reload and the drift
  // would become unreportable
  const doc = docWith(2);
  const back = createInterpretations(JSON.parse(JSON.stringify(serialize(doc))));
  const r = activeReading(back, "ref-1");
  assert.equal(r.basedOnVersion, 2);
  assert.equal(r.basedOnAssetId, "asset-9");
  assert.equal(readingStanding(r, { version: 3 }).staleness, "stale");
});

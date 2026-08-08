// Checkpoint M2 — stable creator identity + minimal provenance. Run via
// `node --test`, wrapped by tests/test_motv_identity_m2.py.
//
// Covers: deterministic non-destructive v1→v2 migration (incl. the REAL saved
// fixtures), stable Script version ids, stable Shot Draft version ids, per-shot
// shotId semantics across edit/reorder/insert/delete, honest null provenance
// for legacy saves, slot behavior unchanged, save→reload id preservation.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CANVAS_SCHEMA_VERSION,
  migrateToCurrent,
} from "../src/services/canvasschema.js";
import { mintId, assignShotIdentity } from "../src/workflow/identity.js";
import * as scriptdoc from "../src/workflow/scriptdoc.js";
import { normalizeShots } from "../src/ui/shoteditor.js";

// A realistic v1 canvas save: script version chain + two shot-draft versions
// (AI draft + manual edit) with slots/uploads wiring, exactly as M1 persisted.
function v1Save() {
  return {
    v: 1,
    project: "p",
    scriptDoc: {
      brief: "被囚禁",
      versions: [
        { v: 1, content: "第一版剧本", instruction: "被囚禁", origin: "generated", basedOn: null, status: "done" },
        { v: 2, content: "第二版剧本", instruction: "更紧凑", origin: "revision", basedOn: 1, status: "done" },
      ],
      active: 2,
      workingText: null,
    },
    nodes: [
      { id: "n1", type: "script", x: 0, y: 0, state: "" },
      {
        id: "n2", type: "scriptgen", x: 300, y: 0, state: "done", cur: 2,
        versions: [
          {
            v: 1, draft: true,
            shots: [["01", "a"], ["02", "b"]],
            raw: [
              { sequence: 1, title: "a", description: "da", duration_seconds: 6, slot: "v1-1" },
              { sequence: 2, title: "b", description: "db", duration_seconds: 10, slot: "v1-2" },
            ],
          },
          {
            v: 2, draft: true, edited: true,
            shots: [["01", "a2"]],
            raw: [{ sequence: 1, title: "a2", description: "da2", duration_seconds: 6, slot: "v1-1" }],
          },
        ],
      },
      {
        id: "n3", type: "assets", x: 600, y: 0,
        uploads: { "v1-1": { current: 1, history: [{ slot_id: "v1-1", origin: "upload", version: 1, digest: null, url: "/api/uploads/p/assets-v1-1.png" }] } },
      },
    ],
    edges: [{ from: "n1", to: "n2", state: "done" }],
    pan: { x: 0, y: 0 },
  };
}

// Strip exactly the fields the v1→v2 migration adds; the remainder must equal
// the original v1 document byte for byte (non-destructive proof).
function stripM2Fields(doc) {
  const d = structuredClone(doc);
  d.v = 1;
  if (d.scriptDoc && Array.isArray(d.scriptDoc.versions)) {
    d.scriptDoc.versions.forEach((ver) => delete ver.id);
  }
  for (const n of d.nodes || []) {
    for (const ver of n.versions || []) {
      delete ver.id;
      delete ver.sourceScriptVersionId;
      delete ver.basedOnDraftId;
      for (const s of ver.raw || []) delete s.shotId;
    }
  }
  return d;
}

// --- v1 → v2 migration -------------------------------------------------------

test("v1 save migrates to v2 adding identity and losing NOTHING", () => {
  const original = v1Save();
  const res = migrateToCurrent(v1Save());
  assert.equal(res.status, "ok");
  assert.equal(res.doc.v, 2);
  // every script version, draft version and raw shot got a stable id
  res.doc.scriptDoc.versions.forEach((ver) => assert.match(ver.id, /^sv-mig-\d+$/));
  const sg = res.doc.nodes[1];
  sg.versions.forEach((ver) => assert.match(ver.id, /^sdv-mig-\d+$/));
  sg.versions.forEach((ver) => ver.raw.forEach((s) => assert.match(s.shotId, /^shot-mig-\d+$/)));
  // ids are unique
  const all = [
    ...res.doc.scriptDoc.versions.map((x) => x.id),
    ...sg.versions.map((x) => x.id),
    ...sg.versions.flatMap((x) => x.raw.map((s) => s.shotId)),
  ];
  assert.equal(new Set(all).size, all.length);
  // stripping the added fields yields the original document exactly
  assert.deepEqual(stripM2Fields(res.doc), original);
});

test("migrating the same untouched v1 save twice yields identical identities", () => {
  const a = migrateToCurrent(v1Save());
  const b = migrateToCurrent(v1Save());
  assert.deepEqual(a.doc, b.doc);
});

test("legacy provenance is explicitly null, never guessed", () => {
  const res = migrateToCurrent(v1Save());
  for (const ver of res.doc.nodes[1].versions) {
    assert.equal(ver.sourceScriptVersionId, null);
    assert.equal(ver.basedOnDraftId, null);
  }
  // …even though v2 "looks like" an edit of v1 by sequence/slot, no continuity
  // is fabricated between their shots either: all shotIds are distinct
  const [d1, d2] = res.doc.nodes[1].versions;
  assert.notEqual(d1.raw[0].shotId, d2.raw[0].shotId);
});

test("duplicate legacy slots cannot produce duplicate shotIds", () => {
  const doc = v1Save();
  doc.nodes[1].versions[0].raw[1].slot = "v1-1"; // corrupt duplicate slot
  const res = migrateToCurrent(doc);
  const [s1, s2] = res.doc.nodes[1].versions[0].raw;
  assert.notEqual(s1.shotId, s2.shotId); // identity never derives from slot
  assert.equal(s2.slot, "v1-1"); // slot data itself untouched
});

test("records already carrying an id keep it verbatim through migration", () => {
  const doc = v1Save();
  doc.scriptDoc.versions[0].id = "sv-keep-me";
  doc.nodes[1].versions[0].id = "sdv-keep-me";
  doc.nodes[1].versions[0].raw[0].shotId = "shot-keep-me";
  const res = migrateToCurrent(doc);
  assert.equal(res.doc.scriptDoc.versions[0].id, "sv-keep-me");
  assert.equal(res.doc.nodes[1].versions[0].id, "sdv-keep-me");
  assert.equal(res.doc.nodes[1].versions[0].raw[0].shotId, "shot-keep-me");
});

test("pre-existing mig-style ids are skipped, never duplicated", () => {
  const doc = v1Save();
  // a partially migrated save: some records already carry mig-namespace ids
  doc.scriptDoc.versions[0].id = "sv-mig-1";
  doc.nodes[1].versions[0].id = "sdv-mig-2";
  doc.nodes[1].versions[0].raw[0].shotId = "shot-mig-1";
  const res = migrateToCurrent(doc);
  const all = [
    ...res.doc.scriptDoc.versions.map((x) => x.id),
    ...res.doc.nodes[1].versions.map((x) => x.id),
    ...res.doc.nodes[1].versions.flatMap((x) => x.raw.map((s) => s.shotId)),
  ];
  assert.equal(new Set(all).size, all.length, `duplicate ids: ${all}`);
  // kept verbatim…
  assert.equal(res.doc.scriptDoc.versions[0].id, "sv-mig-1");
  // …and the fresh mint for the OTHER script version avoided the collision
  assert.notEqual(res.doc.scriptDoc.versions[1].id, "sv-mig-1");
  // determinism still holds for the same partially-migrated input
  const again = migrateToCurrent(structuredClone(doc));
  assert.deepEqual(again.doc, res.doc);
});

test("REAL saved fixtures migrate deterministically with full identity coverage", async () => {
  const fs = await import("node:fs");
  for (const rel of ["../data/evidence-demo.json", "../data/wfm1-demo.json"]) {
    const p = new URL(rel, import.meta.url);
    if (!fs.existsSync(p)) continue;
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    const a = migrateToCurrent(structuredClone(raw));
    const b = migrateToCurrent(structuredClone(raw));
    assert.equal(a.status, "ok", rel);
    assert.deepEqual(a.doc, b.doc, `${rel}: migration must be deterministic`);
    assert.deepEqual(stripM2Fields(a.doc), raw, `${rel}: migration must be non-destructive`);
    for (const ver of a.doc.scriptDoc ? a.doc.scriptDoc.versions || [] : []) {
      assert.equal(typeof ver.id, "string", rel);
    }
    for (const n of a.doc.nodes) {
      for (const ver of n.versions || []) {
        assert.equal(typeof ver.id, "string", rel);
        for (const s of ver.raw || []) assert.equal(typeof s.shotId, "string", rel);
      }
    }
  }
});

// --- Script version identity --------------------------------------------------

test("script versions get stable ids at creation and keep integer v behavior", () => {
  const doc = scriptdoc.createDoc();
  scriptdoc.beginGeneration(doc, "initial", "一个想法");
  scriptdoc.completeGeneration(doc, 1, "剧本内容");
  assert.equal(doc.versions.length, 1);
  assert.equal(doc.versions[0].v, 1);
  assert.match(doc.versions[0].id, /^sv-/);
  // appending keeps existing ids and mints a distinct one
  const firstId = doc.versions[0].id;
  scriptdoc.editText(doc, "手动改写的剧本");
  scriptdoc.setActive(doc, 1); // snapshots the buffer as a manual version
  assert.equal(doc.versions.length, 2);
  assert.equal(doc.versions[0].id, firstId);
  assert.match(doc.versions[1].id, /^sv-/);
  assert.notEqual(doc.versions[1].id, firstId);
  assert.equal(doc.versions[1].v, 2);
});

test("script version ids survive serialize → createDoc reload", () => {
  const doc = scriptdoc.createDoc();
  scriptdoc.beginGeneration(doc, "initial", "想法");
  scriptdoc.completeGeneration(doc, 1, "内容");
  const ids = doc.versions.map((x) => x.id);
  const reloaded = scriptdoc.createDoc(JSON.parse(JSON.stringify(scriptdoc.serialize(doc))));
  assert.deepEqual(reloaded.versions.map((x) => x.id), ids);
});

test("sourceVersionId: provable when text IS the active version, null when dirty", () => {
  const doc = scriptdoc.createDoc();
  assert.equal(scriptdoc.sourceVersionId(doc), null); // no versions at all
  scriptdoc.beginGeneration(doc, "initial", "想法");
  scriptdoc.completeGeneration(doc, 1, "内容");
  assert.equal(scriptdoc.sourceVersionId(doc), doc.versions[0].id);
  scriptdoc.editText(doc, "内容 + 未版本化修改");
  assert.equal(scriptdoc.sourceVersionId(doc), null); // dirty buffer → not provable
  scriptdoc.editText(doc, "内容"); // buffer equals the active version again
  assert.equal(scriptdoc.sourceVersionId(doc), doc.versions[0].id);
});

// --- per-Shot identity through the manual editor (normalizeShots) -------------

const shot = (shotId, title, slot) => ({ shotId, sequence: 0, title, description: "", duration_seconds: 6, slot });

test("editing a shot's fields preserves its shotId", () => {
  const out = normalizeShots([{ ...shot("shot-a", "改了标题", "v1-1"), duration_seconds: 10 }], "v2");
  assert.equal(out[0].shotId, "shot-a");
  assert.equal(out[0].slot, "v1-1"); // legacy slot untouched
  assert.equal(out[0].duration_seconds, 10);
});

test("reordering shots preserves every shotId (identity ≠ position)", () => {
  const out = normalizeShots([shot("shot-b", "乙", "v1-2"), shot("shot-a", "甲", "v1-1")], "v2");
  assert.deepEqual(out.map((s) => s.shotId), ["shot-b", "shot-a"]);
  assert.deepEqual(out.map((s) => s.sequence), [1, 2]); // sequence renumbers…
  assert.deepEqual(out.map((s) => s.slot), ["v1-2", "v1-1"]); // …slots follow their shot
});

test("inserting a shot mints a NEW shotId without changing surviving ones", () => {
  const out = normalizeShots(
    [shot("shot-a", "甲", "v1-1"), shot(null, "新镜头", null), shot("shot-b", "乙", "v1-2")],
    "v3",
  );
  assert.equal(out[0].shotId, "shot-a");
  assert.equal(out[2].shotId, "shot-b");
  assert.match(out[1].shotId, /^shot-/);
  assert.notEqual(out[1].shotId, "shot-a");
  assert.notEqual(out[1].shotId, "shot-b");
  assert.equal(out[1].slot, "v3-2"); // new shot gets a fresh slot under the new prefix — as before
});

test("deleting a shot does not shift surviving identities", () => {
  const before = [shot("shot-a", "甲", "v1-1"), shot("shot-b", "乙", "v1-2"), shot("shot-c", "丙", "v1-3")];
  const after = normalizeShots([before[0], before[2]], "v2"); // shot-b deleted
  assert.deepEqual(after.map((s) => s.shotId), ["shot-a", "shot-c"]);
  assert.deepEqual(after.map((s) => s.slot), ["v1-1", "v1-3"]);
});

test("assignShotIdentity mints only for missing ids", () => {
  const shots = [{ shotId: "shot-keep" }, { title: "x" }];
  assignShotIdentity(shots);
  assert.equal(shots[0].shotId, "shot-keep");
  assert.match(shots[1].shotId, /^shot-/);
});

test("mintId namespaces never collide with migration ids", () => {
  assert.ok(!mintId("shot").startsWith("shot-mig-"));
});

// --- save → reload preserves all new ids --------------------------------------

test("v2 document round-trips through dispatch without id changes", () => {
  const migrated = migrateToCurrent(v1Save()).doc;
  const reloaded = migrateToCurrent(JSON.parse(JSON.stringify(migrated)));
  assert.equal(reloaded.status, "ok");
  assert.equal(reloaded.fromVersion, CANVAS_SCHEMA_VERSION);
  assert.deepEqual(reloaded.doc, migrated);
});

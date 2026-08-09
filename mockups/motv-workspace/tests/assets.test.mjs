// Checkpoint M3 — Project Asset Registry extraction. Run via `node --test`,
// wrapped by tests/test_motv_assets_m3.py.
//
// Covers: deterministic non-destructive v2→v3 migration (real fixtures too),
// media-domain keying (slots are NOT globally unique), history/current
// preservation, conservative finals migration, first-frame Asset reuse being
// reference-proven (never digest-guessed), provable-only shot association,
// collision-safe id minting, the single write path stamping assetId, and
// registry survival across save/reload.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CANVAS_SCHEMA_VERSION,
  MIGRATIONS,
  migrateToCurrent,
} from "../src/services/canvasschema.js";
import {
  createRegistry,
  finalUrls,
  addFinal,
  shotIdForKey,
} from "../src/workflow/assetlib.js";
import { addVersion, refFromResponse, currentRef, slotUrl, putKey } from "../src/workflow/mediaref.js";

const ref = (slot, version, url, extra = {}) => ({
  slot_id: slot, origin: "upload", version, digest: null, url, ...extra,
});

// A realistic v2 save: same slot "v1-1" under BOTH image and video domains,
// two-version image history with a non-latest current selection, a carried
// first-frame reference, audio voice/music, legacy string video, finals.
function v2Save() {
  return {
    v: 2,
    project: "p",
    scriptDoc: { brief: "b", versions: [{ id: "sv-mig-1", v: 1, content: "剧本", instruction: "", origin: "generated", basedOn: null, status: "done" }], active: 1, workingText: null },
    assets: undefined,
    nodes: [
      { id: "n1", type: "script", x: 0, y: 0, state: "" },
      {
        id: "n2", type: "scriptgen", x: 1, y: 0, state: "done", cur: 1,
        versions: [{
          id: "sdv-mig-1", v: 1, draft: true, sourceScriptVersionId: null, basedOnDraftId: null,
          shots: [["01", "甲"], ["02", "乙"]],
          raw: [
            { shotId: "shot-mig-1", sequence: 1, title: "甲", description: "d1", duration_seconds: 6, slot: "v1-1" },
            { shotId: "shot-mig-2", sequence: 2, title: "乙", description: "d2", duration_seconds: 6, slot: "v1-2" },
          ],
        }],
      },
      {
        id: "n3", type: "assets", x: 2, y: 0,
        uploads: {
          "v1-1": {
            current: 1, // deliberately NOT the latest — selection must survive
            history: [ref("v1-1", 1, "/u/img1.png"), ref("v1-1", 2, "/u/img1_v2.png", { origin: "paid-image", digest: "aaaa" })],
          },
        },
      },
      {
        id: "n4", type: "video", x: 3, y: 0,
        uploads: { "v1-1": "/u/clip1.mp4" }, // legacy string — SAME slot as the image, different domain
        firstFrames: { "v1-1": ref("v1-1", 1, "/u/img1.png") }, // carried from image v1
      },
      {
        id: "n5", type: "audio", x: 4, y: 0,
        uploads: {
          "voice-v1-2": { current: 1, history: [ref("voice-v1-2", 1, "/u/voice2.wav", { origin: "tts" })] },
          "music-main": { current: 1, history: [ref("music-main", 1, "/u/music.mp3")] },
        },
      },
      { id: "n6", type: "edit", x: 5, y: 0, state: "done", finals: ["/u/final_v1.mp4", "/u/final_v2.mp4"] },
    ],
    edges: [],
    pan: { x: 0, y: 0 },
  };
}

// --- v2 → v3 migration --------------------------------------------------- //

test("v2 save migrates to v3: media moves to the registry, nothing lost", () => {
  const res = migrateToCurrent(v2Save());
  assert.equal(res.status, "ok");
  assert.equal(res.doc.v, CANVAS_SCHEMA_VERSION);
  const a = res.doc.assets;
  // domain keying — the same slot lives independently under images AND videos
  assert.ok(a.images["v1-1"]);
  assert.ok(a.videos["v1-1"]);
  assert.notEqual(a.images["v1-1"].history[0].assetId, a.videos["v1-1"].history[0].assetId);
  // history order + current selection preserved exactly
  assert.deepEqual(a.images["v1-1"].history.map((r) => r.url), ["/u/img1.png", "/u/img1_v2.png"]);
  assert.equal(a.images["v1-1"].current, 1);
  // legacy string video normalized to a v1 chain, url unchanged
  assert.equal(a.videos["v1-1"].history[0].url, "/u/clip1.mp4");
  assert.equal(a.videos["v1-1"].current, 1);
  // audio chains intact
  assert.equal(a.audio["voice-v1-2"].history[0].url, "/u/voice2.wav");
  assert.equal(a.audio["music-main"].history[0].url, "/u/music.mp3");
  // every durable media version is an Asset with a stable id
  for (const m of [a.images, a.videos, a.audio]) {
    for (const k of Object.keys(m)) for (const r of m[k].history) assert.match(r.assetId, /^asset-mig-\d+$/);
  }
  // nodes no longer own media
  for (const n of res.doc.nodes) {
    assert.equal(n.uploads, undefined);
    assert.equal(n.firstFrames, undefined);
    assert.equal(n.finals, undefined);
  }
});

test("repeated migration of the same v2 save yields identical asset identities", () => {
  const a = migrateToCurrent(v2Save());
  const b = migrateToCurrent(v2Save());
  assert.deepEqual(a.doc, b.doc);
});

test("carried first-frame reference keeps the SAME Asset id (reference-proven)", () => {
  const res = migrateToCurrent(v2Save());
  const a = res.doc.assets;
  const imgV1 = a.images["v1-1"].history.find((r) => r.version === 1);
  assert.equal(a.firstFrames["v1-1"].assetId, imgV1.assetId); // same slot+version+url = the carried copy
});

test("digest equality alone does NOT merge distinct Assets", () => {
  const doc = v2Save();
  // an unrelated frame ref that merely SHARES bytes (same digest) with image v2
  // but was never carried from it (different version/url pairing)
  doc.nodes[3].firstFrames["v1-1"] = ref("v1-1", 9, "/u/somewhere-else.png", { digest: "aaaa" });
  const res = migrateToCurrent(doc);
  const a = res.doc.assets;
  const ids = a.images["v1-1"].history.map((r) => r.assetId);
  assert.ok(!ids.includes(a.firstFrames["v1-1"].assetId)); // its own Asset, not an alias
});

test("pre-existing assets.firstFrames without ids are stamped, and collide-free", () => {
  const doc = v2Save();
  doc.assets = {
    images: { "v1-1": { current: 1, history: [ref("v1-1", 1, "/u/img1.png")] } },
    videos: {}, audio: {},
    // a partially-migrated first frame carried from image v1 but never stamped
    firstFrames: { "v1-1": ref("v1-1", 1, "/u/img1.png") },
    finals: [], displaced: [],
  };
  delete doc.nodes[3].firstFrames; // no node-derived frame; only the pre-existing one
  const res = migrateToCurrent(doc);
  const ff = res.doc.assets.firstFrames["v1-1"];
  assert.equal(typeof ff.assetId, "string"); // stamped, not identity-less
  assert.ok("shot_id" in ff);
  const imgV1 = res.doc.assets.images["v1-1"].history[0];
  assert.equal(ff.assetId, imgV1.assetId); // reused the carried image Asset's id
});

test("object-valued node.finals ids are pre-scanned so mint never collides", () => {
  const doc = v2Save();
  // an object-map finals whose entry already carries asset-mig-1
  doc.nodes[5].finals = { keep: { assetId: "asset-mig-1", url: "/u/keep.mp4", origin: null } };
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  const all = [];
  const reg = res.doc.assets;
  for (const m of [reg.images, reg.videos, reg.audio]) {
    for (const k of Object.keys(m)) for (const r of m[k].history) all.push(r.assetId);
  }
  for (const f of reg.finals) all.push(f.assetId);
  assert.equal(new Set(all).size, all.length, `duplicate ids: ${all}`); // asset-mig-1 not re-minted
});

test("a truncated v3 document missing its assets registry is rejected", () => {
  const doc = migrateToCurrent(v2Save()).doc;
  delete doc.assets;
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "invalid");
  assert.match(res.detail, /missing its assets registry/);
});

test("a v3 document missing a registry subfield (e.g. images) is rejected", () => {
  const doc = migrateToCurrent(v2Save()).doc;
  delete doc.assets.images; // truncated — restore would replace with empty, losing media
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "invalid");
  assert.match(res.detail, /assets\.images is missing/);
});

test("a first frame reusing an image id but NOT matching its media is rejected", () => {
  const doc = migrateToCurrent(v2Save()).doc;
  // keep the reused image id, but point the frame at different bytes
  doc.assets.firstFrames["v1-1"].url = "/u/some-other-image.png";
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "invalid");
  assert.match(res.detail, /does not match its slot\/media/);
});

test("pathologically deep input fails SAFE (invalid), never crashes the load", () => {
  const doc = v2Save();
  // deep enough to overflow the structuredClone deep-copy — must be caught and
  // reported as invalid, not thrown as an uncaught RangeError
  let deep = { assetId: "asset-mig-1" };
  for (let i = 0; i < 50000; i++) deep = { child: deep };
  doc.assets = { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [{ key: "deep", entry: deep }] };
  const res = migrateToCurrent(doc); // must return, not throw
  assert.equal(res.status, "invalid");
  assert.match(res.detail, /migration failed/);
});

test("a cyclic displaced entry is walked without spinning (collectIds is cycle-safe)", () => {
  const doc = v2Save();
  const cyc = { assetId: "asset-mig-2" };
  cyc.self = cyc; // structuredClone preserves the cycle; a naive walker would spin
  doc.assets = { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [{ key: "cyc", entry: cyc }] };
  const res = migrateToCurrent(doc); // must return, not hang
  assert.equal(res.status, "ok");
  const minted = [];
  for (const m of [res.doc.assets.images, res.doc.assets.videos, res.doc.assets.audio]) {
    for (const k of Object.keys(m)) for (const r of m[k].history) minted.push(r.assetId);
  }
  assert.ok(!minted.includes("asset-mig-2")); // the cyclic entry's id was pre-scanned
});

test("collision pre-scan includes displaced — recovered media keeps unique ids", () => {
  const doc = v2Save();
  doc.assets = {
    images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [],
    // a preserved chain in displaced already holding asset-mig-1
    displaced: [{ key: "old", entry: { history: [{ url: "/u/x.png", assetId: "asset-mig-1" }] } }],
  };
  const res = migrateToCurrent(doc);
  // freshly minted ids must skip the displaced asset-mig-1
  const minted = [];
  const reg = res.doc.assets;
  for (const m of [reg.images, reg.videos, reg.audio]) {
    for (const k of Object.keys(m)) for (const r of m[k].history) minted.push(r.assetId);
  }
  assert.ok(!minted.includes("asset-mig-1") || minted.filter((x) => x === "asset-mig-1").length === 0);
  // the displaced id is still there, untouched, and no new record duplicates it
  const all = [...minted, "asset-mig-1"];
  assert.equal(new Set(all).size, all.length);
});

test("pre-existing v2 registry string finals become loadable Asset records", () => {
  const doc = v2Save();
  doc.nodes[5].finals = []; // isolate the pre-existing registry finals below
  doc.assets = {
    images: {}, videos: {}, audio: {}, firstFrames: {},
    finals: ["/u/f1.mp4", { url: "/u/f2.mp4" }, {}], // legacy string + object + urlless
    displaced: [],
  };
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok"); // must not be rejected as bare-string finals
  assert.deepEqual(finalUrls(res.doc.assets).sort(), ["/u/f1.mp4", "/u/f2.mp4"]);
  res.doc.assets.finals.forEach((f) => assert.match(f.assetId, /^asset-/));
  assert.ok(res.doc.assets.displaced.some((d) => d.key === "final-preexisting")); // {} preserved
});

test("an AMBIGUOUS first-frame match (duplicate image records) mints a fresh id, never guesses", () => {
  const doc = v2Save();
  // two image history records sharing the exact version+url the frame carries
  doc.nodes[2].uploads["v1-1"] = {
    current: 1, // resolves to a real version; both records are v1 (contrived dup)
    history: [
      ref("v1-1", 1, "/u/dup.png", { assetId: "asset-A" }),
      ref("v1-1", 1, "/u/dup.png", { assetId: "asset-B" }), // duplicate version+url
    ],
  };
  doc.nodes[3].firstFrames = { "v1-1": ref("v1-1", 1, "/u/dup.png") }; // no assetId → needs resolve
  const res = migrateToCurrent(doc);
  const fid = res.doc.assets.firstFrames["v1-1"].assetId;
  // ambiguous → a NEW standalone id, not arbitrarily asset-A or asset-B
  assert.ok(fid !== "asset-A" && fid !== "asset-B");
});

test("a partial pre-existing registry gets every chain stamped with an identity", () => {
  const doc = v2Save();
  // simulate a partially-migrated save: assets already present, but its image
  // chain and a final lack assetIds (identity-less)
  doc.assets = {
    images: { "pre-1": { current: 1, history: [ref("pre-1", 1, "/u/pre.png")] } },
    videos: {}, audio: {}, firstFrames: {}, finals: [{ url: "/u/pref.mp4", origin: null }], displaced: [],
  };
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  // the pre-existing image chain record was stamped, not left identity-less
  assert.match(res.doc.assets.images["pre-1"].history[0].assetId, /^asset-mig-\d+$/);
  assert.match(res.doc.assets.finals[0].assetId, /^asset-mig-\d+$/);
  // and its shot_id was resolved (null here — no draft claims "pre-1")
  assert.equal(res.doc.assets.images["pre-1"].history[0].shot_id, null);
});

test("pre-existing image asset is reusable by a carried first frame after stamping", () => {
  const doc = v2Save();
  doc.assets = {
    images: { "v1-1": { current: 1, history: [ref("v1-1", 1, "/u/img1.png")] } },
    videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [],
  };
  // strip the node's own image so the pre-existing registry chain is the source
  delete doc.nodes[2].uploads;
  const res = migrateToCurrent(doc);
  const imgV1 = res.doc.assets.images["v1-1"].history.find((r) => r.version === 1);
  assert.equal(typeof imgV1.assetId, "string");
  assert.equal(res.doc.assets.firstFrames["v1-1"].assetId, imgV1.assetId); // reuse, not a new id
});

test("malformed finals array entries are preserved in displaced, never dropped", () => {
  const doc = v2Save();
  doc.nodes[5].finals = ["/u/good.mp4", null, 42, "", true];
  const res = migrateToCurrent(doc);
  assert.deepEqual(finalUrls(res.doc.assets), ["/u/good.mp4"]); // only the real url surfaces
  const kept = res.doc.assets.displaced.filter((d) => String(d.key).startsWith("final-entry:")).map((d) => d.entry);
  assert.deepEqual(kept, [null, 42, "", true]); // the rest preserved verbatim
});

test("finals migrate conservatively: Asset records, origin honestly null", () => {
  const res = migrateToCurrent(v2Save());
  const f = res.doc.assets.finals;
  assert.deepEqual(f.map((x) => x.url), ["/u/final_v1.mp4", "/u/final_v2.mp4"]); // order kept
  f.forEach((x) => {
    assert.match(x.assetId, /^asset-mig-\d+$/);
    assert.equal(x.origin, null); // historical compose provenance was never persisted
  });
});

test("provable slot→shotId lands on Assets; ambiguity stays null", () => {
  const doc = v2Save();
  // make v1-2 ambiguous: a second draft version claims the same slot for a DIFFERENT shot
  doc.nodes[1].versions.push({
    id: "sdv-mig-2", v: 2, draft: true, edited: true, sourceScriptVersionId: null, basedOnDraftId: "sdv-mig-1",
    shots: [["01", "丙"]],
    raw: [{ shotId: "shot-mig-9", sequence: 1, title: "丙", description: "", duration_seconds: 6, slot: "v1-2" }],
  });
  const res = migrateToCurrent(doc);
  const a = res.doc.assets;
  assert.equal(a.images["v1-1"].history[0].shot_id, "shot-mig-1"); // unique across all drafts
  assert.equal(a.videos["v1-1"].history[0].shot_id, "shot-mig-1");
  assert.equal(a.firstFrames["v1-1"].shot_id, "shot-mig-1");
  assert.equal(a.audio["voice-v1-2"].history[0].shot_id, null); // ambiguous → never guessed
  assert.equal(a.audio["music-main"].history[0].shot_id, null); // not per-shot at all
});

test("duplicate slot across SAME-type nodes: later wins, loser preserved in displaced", () => {
  const doc = v2Save();
  doc.nodes.push({
    id: "n7", type: "assets", x: 9, y: 0,
    uploads: { "v1-1": { current: 1, history: [ref("v1-1", 1, "/u/other.png")] } },
  });
  const res = migrateToCurrent(doc);
  const a = res.doc.assets;
  assert.equal(currentRef(a.images, "v1-1").url, "/u/other.png"); // merged-read behavior kept
  assert.equal(a.displaced.length, 1);
  assert.equal(a.displaced[0].entry.history[0].url, "/u/img1.png"); // nothing destroyed
});

test("pre-existing asset ids are pre-scanned — minting never collides", () => {
  const doc = v2Save();
  doc.nodes[2].uploads["v1-1"].history[0].assetId = "asset-mig-1"; // partially migrated save
  const res = migrateToCurrent(doc);
  const all = [];
  const a = res.doc.assets;
  for (const m of [a.images, a.videos, a.audio]) {
    for (const k of Object.keys(m)) for (const r of m[k].history) all.push(r.assetId);
  }
  all.push(...a.finals.map((x) => x.assetId));
  assert.equal(new Set(all).size, all.length, `duplicate ids: ${all}`);
  // the firstFrame ref legitimately SHARES the carried image Asset's id —
  // that is reuse, not a collision
  assert.equal(a.firstFrames["v1-1"].assetId, "asset-mig-1");
  assert.equal(doc.nodes[2].uploads["v1-1"].history[0].assetId, "asset-mig-1"); // input untouched
});

test("unrecognized uploads entries are preserved in displaced, never dropped", () => {
  const doc = v2Save();
  doc.nodes[2].uploads["broken"] = { current: 1 }; // no history[] — cannot normalize
  doc.nodes[2].uploads["gone"] = 12345; // wrong type entirely
  const res = migrateToCurrent(doc);
  const disp = res.doc.assets.displaced;
  const keys = disp.map((d) => d.key);
  assert.ok(keys.includes("broken"), "unrecognized object entry kept");
  assert.ok(keys.includes("gone"), "wrong-type entry kept");
  assert.equal(disp.find((d) => d.key === "gone").entry, 12345); // verbatim
});

test("first-frame reuse holds even when the video node PRECEDES its assets node", () => {
  const doc = v2Save();
  // reorder: video (n4) before assets (n3) — reuse must not depend on order
  const nodes = doc.nodes;
  const iA = nodes.findIndex((n) => n.id === "n3");
  const iV = nodes.findIndex((n) => n.id === "n4");
  [nodes[iA], nodes[iV]] = [nodes[iV], nodes[iA]];
  const res = migrateToCurrent(doc);
  const a = res.doc.assets;
  const imgV1 = a.images["v1-1"].history.find((r) => r.version === 1);
  assert.equal(a.firstFrames["v1-1"].assetId, imgV1.assetId); // same Asset, order-independent
});

test("duplicate firstFrames slot: later wins, earlier preserved in displaced", () => {
  const doc = v2Save();
  doc.nodes.push({
    id: "n8", type: "video", x: 9, y: 0,
    uploads: {},
    firstFrames: { "v1-1": ref("v1-1", 2, "/u/img1_v2.png", { origin: "paid-image" }) },
  });
  const res = migrateToCurrent(doc);
  // later node's frame (image v2) wins, consistent with the video uploads merge
  assert.equal(res.doc.assets.firstFrames["v1-1"].url, "/u/img1_v2.png");
  const imgV2 = res.doc.assets.images["v1-1"].history.find((r) => r.version === 2);
  assert.equal(res.doc.assets.firstFrames["v1-1"].assetId, imgV2.assetId);
  // the earlier frame link (image v1) is not lost
  const kept = res.doc.assets.displaced.find((d) => d.key === "firstFrame:v1-1");
  assert.ok(kept, "earlier first-frame preserved in displaced");
  assert.equal(kept.entry.url, "/u/img1.png");
});

test("shot provenance comes ONLY from scriptgen nodes, not any node with versions", () => {
  const doc = v2Save();
  // a crafted non-scriptgen node claims slot v1-1 for a DIFFERENT shot — it
  // must not forge or nullify the real association
  doc.nodes.push({
    id: "forge", type: "assets", x: 0, y: 0,
    versions: [{ raw: [{ slot: "v1-1", shotId: "shot-FORGED" }] }],
  });
  const res = migrateToCurrent(doc);
  assert.equal(res.doc.assets.images["v1-1"].history[0].shot_id, "shot-mig-1"); // real, un-forged
});

test("a registry chain map entry that hydration would drop is rejected, not lost", () => {
  const migrated = migrateToCurrent(v2Save()).doc;
  // corrupt one image slot to a non-chain value — schema-valid JSON, but
  // mediaref.migrateUploads would DELETE it on reload → must fail safe instead
  migrated.assets.images["v1-1"] = 42;
  const res = migrateToCurrent(migrated);
  assert.equal(res.status, "invalid");
  assert.match(res.detail, /media chain/);
});

test("null node media fields do not block a valid v2 canvas from loading", () => {
  const doc = v2Save();
  doc.nodes[0].uploads = null; // a legitimate empty media field
  doc.nodes[3].firstFrames = null;
  doc.nodes[5].finals = null;
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok"); // null carries no data — dropped, not rejected
});

test("non-object pre-existing registry maps are preserved in displaced, not clobbered", () => {
  const doc = v2Save();
  doc.assets = { images: "corrupt-was-here", videos: {}, audio: {}, firstFrames: {}, finals: {}, displaced: [] };
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  const disp = res.doc.assets.displaced;
  assert.ok(disp.some((d) => d.key === "__preexisting_images" && d.entry === "corrupt-was-here"));
  assert.ok(disp.some((d) => d.key === "__preexisting_finals")); // {} finals wasn't an array
});

test("an empty-string assetId is re-minted, never accepted as identity", () => {
  const doc = v2Save();
  doc.nodes[2].uploads["v1-1"].history[0].assetId = ""; // empty — not a usable identity
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  assert.match(res.doc.assets.images["v1-1"].history[0].assetId, /^asset-mig-\d+$/);
});

test("v3 identity invariant: missing/duplicate assetIds are rejected", () => {
  const base = migrateToCurrent(v2Save()).doc;
  // missing id
  const a = structuredClone(base);
  delete a.assets.images["v1-1"].history[0].assetId;
  assert.equal(migrateToCurrent(a).status, "invalid");
  // duplicate id across the registry
  const b = structuredClone(base);
  b.assets.videos["v1-1"].history[0].assetId = b.assets.images["v1-1"].history[0].assetId;
  const res = migrateToCurrent(b);
  assert.equal(res.status, "invalid");
  assert.match(res.detail, /duplicate assetId/);
});

test("a first frame reusing a non-image (video) Asset id is rejected", () => {
  const base = migrateToCurrent(v2Save()).doc;
  const videoId = base.assets.videos["v1-1"].history[0].assetId;
  const doc = structuredClone(base);
  doc.assets.firstFrames["v1-1"].assetId = videoId; // misattributed cross-domain reuse
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "invalid");
  assert.match(res.detail, /non-image Asset id/);
  // a standalone first-frame id (matches nothing) stays valid
  const ok = structuredClone(base);
  ok.assets.firstFrames["v1-1"].assetId = "asset-standalone-xyz";
  assert.equal(migrateToCurrent(ok).status, "ok");
});

test("v2's permitted finals: [{}] migrates to a LOADABLE v3 (urlless → displaced)", () => {
  const doc = v2Save();
  doc.nodes[5].finals = [{}, "/u/real.mp4", { url: "" }]; // {} and empty-url were v2-valid
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok"); // must not become an invalid v3
  assert.deepEqual(finalUrls(res.doc.assets), ["/u/real.mp4"]);
  // the urlless entries are preserved, not silently dropped
  assert.ok(res.doc.assets.displaced.some((d) => String(d.key).startsWith("final-entry:")));
});

test("addFinal refuses a malformed (empty/non-string) compose url", () => {
  const reg = createRegistry(null);
  assert.equal(addFinal(reg, ""), null);
  assert.equal(addFinal(reg, undefined), null);
  assert.equal(addFinal(reg, 5), null);
  assert.equal(reg.finals.length, 0); // nothing broken persisted
  assert.ok(addFinal(reg, "/u/ok.mp4"));
  assert.equal(reg.finals.length, 1);
});

test("a first frame with a conflicting slot_id or digest is rejected", () => {
  const base = migrateToCurrent(v2Save()).doc;
  // conflicting slot_id (frame at v1-1 but claims slot_id v9-9)
  const a = structuredClone(base);
  a.assets.firstFrames["v1-1"].slot_id = "v9-9";
  assert.equal(migrateToCurrent(a).status, "invalid");
  // conflicting digest against the reused image (both non-null, disagree)
  const b = structuredClone(base);
  b.assets.images["v1-1"].history[0].digest = "IMGDIGEST";
  b.assets.firstFrames["v1-1"].digest = "OTHERDIGEST";
  b.assets.firstFrames["v1-1"].assetId = b.assets.images["v1-1"].history[0].assetId;
  assert.equal(migrateToCurrent(b).status, "invalid");
});

test("object-valued node.finals: url values become real finals, not lost to displaced", () => {
  const doc = v2Save();
  doc.nodes[5].finals = { a: "/u/one.mp4", b: "/u/two.mp4", junk: 5 };
  const res = migrateToCurrent(doc);
  assert.deepEqual(finalUrls(res.doc.assets).sort(), ["/u/one.mp4", "/u/two.mp4"]);
  assert.ok(res.doc.assets.displaced.some((d) => d.entry === 5)); // non-url preserved
});

test("v3 rejects a chain history record missing url or valid version", () => {
  const base = migrateToCurrent(v2Save()).doc;
  const a = structuredClone(base);
  delete a.assets.images["v1-1"].history[0].url;
  assert.match(migrateToCurrent(a).detail, /history record has no url/);
  const b = structuredClone(base);
  b.assets.images["v1-1"].history[0].version = "1"; // not an integer
  assert.match(migrateToCurrent(b).detail, /no valid version/);
});

test("v3 rejects a chain whose current pointer resolves to no version", () => {
  const doc = migrateToCurrent(v2Save()).doc;
  doc.assets.images["v1-1"].current = 999; // no history record has version 999
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "invalid");
  assert.match(res.detail, /current pointer/);
});

test("v3 rejects a first frame missing url or valid version", () => {
  const base = migrateToCurrent(v2Save()).doc;
  const a = structuredClone(base);
  delete a.assets.firstFrames["v1-1"].url;
  assert.match(migrateToCurrent(a).detail, /firstFrames\[v1-1\] reference has no url/);
  const b = structuredClone(base);
  b.assets.firstFrames["v1-1"].version = null;
  assert.match(migrateToCurrent(b).detail, /reference has no valid version/);
});

test("v3 rejects a final record with no reachable url (would be hidden dead data)", () => {
  const base = migrateToCurrent(v2Save()).doc;
  const a = structuredClone(base);
  a.assets.finals.push({ assetId: "asset-urlless", origin: null }); // no url
  const res = migrateToCurrent(a);
  assert.equal(res.status, "invalid");
  assert.match(res.detail, /finals record has no url/);
});

test("v3 rejects two standalone first frames conflated under one assetId", () => {
  const base = migrateToCurrent(v2Save()).doc;
  const doc = structuredClone(base);
  // two DIFFERENT frame urls sharing one non-image (standalone) assetId
  doc.assets.firstFrames["f1"] = { slot_id: "f1", version: 1, url: "/u/one.png", assetId: "asset-standalone" };
  doc.assets.firstFrames["f2"] = { slot_id: "f2", version: 1, url: "/u/two.png", assetId: "asset-standalone" };
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "invalid");
  assert.match(res.detail, /shares a standalone assetId/);
});

test("v3 identity invariant rejects bare-string finals and primitive first frames", () => {
  const base = migrateToCurrent(v2Save()).doc;
  const a = structuredClone(base);
  a.assets.finals.push("/u/bare.mp4"); // no identity
  const ra = migrateToCurrent(a);
  assert.equal(ra.status, "invalid");
  assert.match(ra.detail, /bare-string/);
  const b = structuredClone(base);
  b.assets.firstFrames["ghost"] = 7; // primitive dead frame
  assert.equal(migrateToCurrent(b).status, "invalid");
});

test("a pre-existing primitive first frame is preserved in displaced, map stays clean", () => {
  const doc = v2Save();
  doc.assets = { images: {}, videos: {}, audio: {}, firstFrames: { "ghost": 7 }, finals: [], displaced: [] };
  delete doc.nodes[3].firstFrames;
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok"); // dead frame moved aside, registry valid
  assert.equal(res.doc.assets.firstFrames["ghost"], undefined);
  assert.ok(res.doc.assets.displaced.some((d) => d.key === "firstFrame:ghost" && d.entry === 7));
});

test("shotIdForKey tolerates a truthy non-array versions value", () => {
  assert.equal(shotIdForKey([{ not: "an array" }], "v1-1"), null); // must not throw
});

test("first-frame Asset reuse is NOT flagged as a duplicate by the invariant", () => {
  // the carried first frame legitimately shares the image Asset's id
  const res = migrateToCurrent(v2Save());
  assert.equal(res.status, "ok");
  const imgId = res.doc.assets.images["v1-1"].history[0].assetId;
  assert.equal(res.doc.assets.firstFrames["v1-1"].assetId, imgId); // aliased, and still valid
});

test("createRegistry preserves an unknown assets field across the round-trip", () => {
  const reg = createRegistry({ images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [], futureMeta: { x: 1 } });
  assert.deepEqual(reg.futureMeta, { x: 1 });
});

test("a first slot named __proto__ does not create a spurious displaced record", () => {
  const doc = v2Save();
  const raw = JSON.parse('{"current":1,"history":[{"slot_id":"__proto__","origin":"upload","version":1,"digest":null,"url":"/u/p.png"}]}');
  doc.nodes[2].uploads = JSON.parse(JSON.stringify(doc.nodes[2].uploads));
  Object.defineProperty(doc.nodes[2].uploads, "__proto__", { value: raw, enumerable: true, writable: true, configurable: true });
  const res = migrateToCurrent(doc);
  // only the genuine v1-1 collision (none here) would displace; __proto__ is a
  // fresh first entry, so nothing spurious lands in displaced for it
  assert.ok(!res.doc.assets.displaced.some((d) => d.key === "__proto__"));
});

test("a crafted node.type shadowing Object.prototype does not crash; its media is inert→displaced", () => {
  const doc = v2Save();
  // own-property DOMAIN lookup must not dereference the inherited constructor
  // (that would make reg[domain] undefined and throw → load DoS)
  doc.nodes.push({ id: "evil", type: "constructor", x: 0, y: 0, uploads: { "x": "/u/x.png" } });
  const res = migrateToCurrent(doc); // must not throw
  assert.equal(res.status, "ok");
  // an unknown node type consumed NO media in v2 — its uploads are preserved
  // (displaced), never promoted to an active domain, and the node is cleaned
  assert.ok(!("x" in res.doc.assets.images) && !("x" in res.doc.assets.videos));
  assert.ok(res.doc.assets.displaced.some((d) => d.key === "node-uploads:evil"));
});

test("a legacy STRING first frame on a video node is normalized to an active MediaRef", () => {
  const doc = v2Save();
  // v2 permitted a url string as a firstFrames value; upgrading must keep it
  // as a working, identity-stamped first frame — not silently disable it
  doc.nodes[3].firstFrames = { "v1-2": "/api/uploads/p/frame-v1-2.png" };
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  const ff = res.doc.assets.firstFrames["v1-2"];
  assert.equal(ff.url, "/api/uploads/p/frame-v1-2.png"); // still configured
  assert.equal(ff.version, 1);
  assert.equal(ff.origin, "upload");
  assert.match(ff.assetId, /^asset-/); // stamped with identity
});

test("firstFrames on a NON-video node is inert (displaced), never an active first frame", () => {
  const doc = v2Save();
  // a well-formed firstFrames map on the ASSETS node — v2 only read it from
  // video nodes, so promoting it could replace the real video first frame
  doc.nodes[2].firstFrames = { "v1-1": ref("v1-1", 9, "/u/wrong-frame.png") };
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  // the real video-node first frame (image v1) is untouched
  assert.equal(res.doc.assets.firstFrames["v1-1"].url, "/u/img1.png");
  assert.ok(res.doc.assets.displaced.some((d) => d.key === "node-firstFrames:n3"));
});

test("finals on a NON-edit node is inert (displaced), never an active final", () => {
  const doc = v2Save();
  doc.nodes[2].finals = ["/u/wrong-final.mp4"]; // finals on the assets node
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  // v2 read finals only from edit nodes — the stray one must not surface
  assert.ok(!finalUrls(res.doc.assets).includes("/u/wrong-final.mp4"));
  assert.ok(res.doc.assets.displaced.some((d) => d.key === "node-finals:n3"));
});

test("a pre-existing non-object assets value is preserved, never clobbered", () => {
  const doc = v2Save();
  doc.assets = "some future extension wrote this";
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  const kept = res.doc.assets.displaced.find((d) => d.key === "__preexisting_assets");
  assert.ok(kept);
  assert.equal(kept.entry, "some future extension wrote this");
});

test("a current-schema doc that still carries node media is rejected (fail-safe)", () => {
  const migrated = migrateToCurrent(v2Save()).doc;
  migrated.nodes[3].uploads = { "v1-1": "/u/leaked.mp4" }; // hand-authored/corrupt v3
  const res = migrateToCurrent(migrated);
  assert.equal(res.status, "invalid");
  assert.match(res.detail, /retains media field/);
});

test("shotIdForKey tolerates a truthy non-array raw (no throw)", () => {
  assert.equal(shotIdForKey([[{ raw: 42 }, { raw: { nope: 1 } }]], "v1-1"), null);
});

test("a slot named __proto__ migrates as an OWN key, never polluting the map", () => {
  const doc = v2Save();
  // JSON.parse stores __proto__ as an own key (the only way this reaches us)
  const raw = JSON.parse('{"current":1,"history":[{"slot_id":"__proto__","origin":"upload","version":1,"digest":null,"url":"/u/evil.png"}]}');
  doc.nodes[2].uploads = JSON.parse(JSON.stringify(doc.nodes[2].uploads));
  Object.defineProperty(doc.nodes[2].uploads, "__proto__", { value: raw, enumerable: true, writable: true, configurable: true });
  const res = migrateToCurrent(doc);
  const images = res.doc.assets.images;
  assert.ok(Object.prototype.hasOwnProperty.call(images, "__proto__")); // stored as own key
  assert.equal({}.polluted, undefined); // Object.prototype NOT polluted
  assert.equal(images["__proto__"].history[0].url, "/u/evil.png"); // media not lost
});

test("putKey stores a __proto__ key as own data without polluting prototypes", () => {
  const m = {};
  putKey(m, "__proto__", { hacked: true });
  assert.ok(Object.prototype.hasOwnProperty.call(m, "__proto__"));
  assert.equal({}.hacked, undefined);
  putKey(m, "v1-1", 42); // ordinary keys behave normally
  assert.equal(m["v1-1"], 42);
});

test("finalUrls tolerates a hand-corrupted finals list", () => {
  const reg = createRegistry({ finals: [null, "raw.mp4", { url: "obj.mp4" }, { origin: null }, { url: "" }, 5] });
  assert.deepEqual(finalUrls(reg), ["raw.mp4", "obj.mp4"]); // real urls only; empty-url object is a phantom
});

test("migration tolerates a pre-existing empty image entry (no history)", () => {
  const doc = v2Save();
  doc.assets = { images: { "v1-1": { current: 0, history: [] } } }; // schema-valid but empty
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok"); // firstFrame resolution must not throw
});

test("v1 saves chain v1→v2→v3 in one dispatch", () => {
  const v1 = {
    v: 1, project: "p", scriptDoc: null,
    nodes: [
      { id: "a", type: "assets", x: 0, y: 0, uploads: { "v1-1": "/u/legacy.png" } },
      { id: "e", type: "edit", x: 1, y: 0, finals: ["/u/f.mp4"] },
    ],
    edges: [], pan: { x: 0, y: 0 },
  };
  const res = migrateToCurrent(v1);
  assert.equal(res.status, "ok");
  assert.equal(res.doc.v, CANVAS_SCHEMA_VERSION);
  assert.equal(res.doc.assets.images["v1-1"].history[0].url, "/u/legacy.png");
  assert.equal(res.doc.assets.finals[0].url, "/u/f.mp4");
});

test("REAL saved fixtures migrate deterministically; urls & slots unchanged", async () => {
  const fs = await import("node:fs");
  for (const rel of ["../data/evidence-demo.json", "../data/wfm1-demo.json"]) {
    const p = new URL(rel, import.meta.url);
    if (!fs.existsSync(p)) continue;
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    const a = migrateToCurrent(structuredClone(raw));
    const b = migrateToCurrent(structuredClone(raw));
    assert.equal(a.status, "ok", rel);
    assert.deepEqual(a.doc, b.doc, `${rel}: deterministic`);
    // every media url present before is still reachable in the registry
    const urlsBefore = new Set();
    for (const n of raw.nodes || []) {
      for (const k of Object.keys(n.uploads || {})) {
        const v = n.uploads[k];
        if (typeof v === "string") urlsBefore.add(v);
        else for (const r of v.history || []) urlsBefore.add(r.url);
      }
      for (const f of n.finals || []) if (typeof f === "string") urlsBefore.add(f);
    }
    const urlsAfter = new Set();
    const reg = a.doc.assets;
    for (const m of [reg.images, reg.videos, reg.audio]) {
      for (const k of Object.keys(m)) for (const r of m[k].history) urlsAfter.add(r.url);
    }
    for (const f of reg.finals) urlsAfter.add(f.url);
    for (const u of urlsBefore) assert.ok(urlsAfter.has(u), `${rel}: lost ${u}`);
  }
});

// --- registry runtime behavior -------------------------------------------- //

test("v3 registry survives save/reload round-trip byte-for-byte", () => {
  const migrated = migrateToCurrent(v2Save()).doc;
  const reloaded = migrateToCurrent(JSON.parse(JSON.stringify(migrated)));
  assert.equal(reloaded.status, "ok");
  assert.equal(reloaded.fromVersion, CANVAS_SCHEMA_VERSION);
  assert.deepEqual(reloaded.doc, migrated);
  // createRegistry hydration keeps ids too (no re-minting on load)
  const reg = createRegistry(JSON.parse(JSON.stringify(migrated.assets)));
  assert.deepEqual(reg.images, migrated.assets.images);
});

test("the single write path mints assetId once and never replaces it", () => {
  const view = { uploads: {} }; // stands for a node view aliasing the registry map
  addVersion(view, "v1-1", refFromResponse("v1-1", "upload", { url: "/u/x.png", version: 1, sha256: "s" }, "shot-a"));
  const first = currentRef(view.uploads, "v1-1");
  assert.match(first.assetId, /^asset-/);
  assert.equal(first.shot_id, "shot-a");
  // a new version is a NEW Asset; re-adding the same version keeps identity rules
  addVersion(view, "v1-1", refFromResponse("v1-1", "upload", { url: "/u/x2.png", version: 2 }));
  const second = currentRef(view.uploads, "v1-1");
  assert.notEqual(second.assetId, first.assetId);
  const kept = { ...first };
  addVersion(view, "v1-1", kept); // replay with an EXISTING id — kept verbatim
  assert.equal(currentRef(view.uploads, "v1-1").assetId, first.assetId);
});

test("addFinal appends registry Assets with honest compose origin", () => {
  const reg = createRegistry(null);
  const rec = addFinal(reg, "/u/new-final.mp4");
  assert.match(rec.assetId, /^asset-/);
  assert.equal(rec.origin, "compose");
  assert.deepEqual(finalUrls(reg), ["/u/new-final.mp4"]);
  // legacy string finals hydrate transparently through finalUrls
  const reg2 = createRegistry({ finals: [{ assetId: "asset-mig-1", url: "/u/old.mp4", origin: null }] });
  assert.deepEqual(finalUrls(reg2), ["/u/old.mp4"]);
});

test("shotIdForKey is domain-aware: an image slot starting 'voice-' is NOT stripped", () => {
  const drafts = [[{ raw: [{ slot: "voice-x", shotId: "shot-img" }, { slot: "x", shotId: "shot-audio" }] }]];
  // image/video domain: the key IS the slot — no prefix stripping
  assert.equal(shotIdForKey(drafts, "voice-x", "images"), "shot-img");
  assert.equal(shotIdForKey(drafts, "voice-x", "videos"), "shot-img");
  // audio domain: 'voice-x' → slot 'x'
  assert.equal(shotIdForKey(drafts, "voice-x", "audio"), "shot-audio");
});

test("migration provenance is domain-correct for a video slot literally named 'voice-1'", () => {
  const doc = v2Save();
  // a (contrived) VIDEO slot whose text starts with voice- must map by the
  // slot itself, not be stripped as if it were audio. nodes: [3]=video draft
  doc.nodes[1].versions[0].raw = [{ shotId: "shot-mig-1", sequence: 1, title: "甲", description: "d", duration_seconds: 6, slot: "voice-1" }];
  doc.nodes[1].versions.length = 1; // single draft version so the slot is unambiguous
  doc.nodes[3].uploads = { "voice-1": { current: 1, history: [ref("voice-1", 1, "/u/v.mp4")] } };
  doc.nodes[3].firstFrames = {};
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  // video slot "voice-1" resolves to the draft's shotId (its own slot), NOT
  // stripped to "1" as an audio key would be
  assert.equal(res.doc.assets.videos["voice-1"].history[0].shot_id, "shot-mig-1");
});

test("a first frame reusing a same-id image at a DIFFERENT slot is rejected", () => {
  const base = migrateToCurrent(v2Save()).doc;
  const doc = structuredClone(base);
  const img = base.assets.images["v1-1"].history[0];
  // frame at slot v1-2 reusing image v1-1's id + exact media — but wrong slot
  doc.assets.firstFrames["v1-2"] = { slot_id: "v1-2", version: img.version, url: img.url, assetId: img.assetId };
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "invalid");
  assert.match(res.detail, /does not match its slot\/media/);
});

test("shotIdForKey: voice prefix maps, music never, ambiguity null", () => {
  const drafts = [[
    { raw: [{ slot: "v1-1", shotId: "shot-a" }, { slot: "v1-2", shotId: "shot-b" }] },
    { raw: [{ slot: "v1-2", shotId: "shot-b2" }] }, // ambiguous
  ]];
  assert.equal(shotIdForKey(drafts, "v1-1"), "shot-a");
  assert.equal(shotIdForKey(drafts, "voice-v1-1"), "shot-a");
  assert.equal(shotIdForKey(drafts, "v1-2"), null);
  assert.equal(shotIdForKey(drafts, "music-main"), null);
  assert.equal(shotIdForKey(drafts, "sfx-main"), null);
  assert.equal(shotIdForKey(drafts, ""), null);
});

test("shotIdForKey: one identified + one UNidentified occurrence resolves to null", () => {
  const drafts = [[
    { raw: [{ slot: "v1-1", shotId: "shot-a" }] },
    { raw: [{ slot: "v1-1" }] }, // same slot, no shotId → ownership not provable
  ]];
  assert.equal(shotIdForKey(drafts, "v1-1"), null);
});

test("slot reads (slotUrl/currentRef) behave identically over registry maps", () => {
  const a = migrateToCurrent(v2Save()).doc.assets;
  assert.equal(slotUrl(a.images, "v1-1"), "/u/img1.png"); // current=1 selection respected
  assert.equal(slotUrl(a.videos, "v1-1"), "/u/clip1.mp4");
  assert.equal(slotUrl(a.audio, "voice-v1-2"), "/u/voice2.wav");
});

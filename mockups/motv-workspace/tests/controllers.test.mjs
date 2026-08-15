// TASK-073 §1.8 — the controllers extracted from app.js.
//
// These test what was UNREACHABLE before the extraction: nothing imports app.js,
// because it touches the DOM at module scope, so none of this logic had a test at
// all. The cases below are the ones that are silent when wrong.
import test from "node:test";
import assert from "node:assert/strict";

import { createReferenceController } from "../src/controllers/refctl.js";
import { createSubtitleController } from "../src/controllers/subtitlectl.js";
import { createShotAudioController } from "../src/controllers/shotaudioctl.js";
import { createFrameController } from "../src/controllers/framectl.js";
import * as framebind from "../src/workflow/framebind.js";
import * as refinterp from "../src/workflow/refinterp.js";
import * as refuse from "../src/workflow/refuse.js";
import * as assetreg from "../src/workflow/assetreg.js";
import * as subtitle from "../src/workflow/subtitle.js";
import * as timeline from "../src/workflow/timeline.js";
import * as shotaudio from "../src/workflow/shotaudio.js";
import * as proddoc from "../src/workflow/proddoc.js";
import * as mediaref from "../src/workflow/mediaref.js";
import * as assetlib from "../src/workflow/assetlib.js";

const AT = "2026-01-01T00:00:00.000Z";
const noop = () => {};
const pass = (x) => x;

/* --- the reason the pattern exists ---------------------------------------- */

test("a document REASSIGNED on project load is the one written to", () => {
  // The binding in app.js is a `let` that project loading replaces wholesale. A
  // factory that captured its VALUE would keep writing into the project the creator
  // just left — silent, and indistinguishable from a save that worked. Every document
  // therefore arrives as a getter, read at call time.
  let doc = refinterp.createInterpretations(null);
  const ctl = createReferenceController({
    docs: { refInterp: () => doc, refUse: () => Object.create(null) },
    modules: { refinterp, refuse, assetreg },
    referencesOfShot: () => [],
    chainOf: () => ({ list: [{ current: true, assetId: "asset-1", version: 1 }] }),
    prodOp: pass,
    persist: noop,
    refresh: noop,
    now: () => AT,
  });

  assert.equal(ctl.interp.save("ref-1", { cameraLanguage: "低机位" }), 1);
  assert.ok(ctl.interp.reading("ref-1"));

  const first = doc;
  doc = refinterp.createInterpretations(null); // ← the project switch
  assert.equal(ctl.interp.reading("ref-1"), null, "the new project has no readings");
  ctl.interp.save("ref-1", { cameraLanguage: "俯拍" });
  assert.ok(ctl.interp.reading("ref-1"), "…and the write landed in the NEW document");
  assert.equal(
    refinterp.activeReading(first, "ref-1").axes.cameraLanguage,
    "低机位",
    "the abandoned project was not touched",
  );
});

test("a reading records the material that existed WHEN it was made", () => {
  // resolved from the registry here, never trusted from the caller: that is what lets
  // a later version swap be reported as drift instead of silently relabelling an old
  // note as a new one (TASK-072 §1.9 缺陷 3)
  const doc = refinterp.createInterpretations(null);
  let chain = { list: [{ current: true, assetId: "asset-v1", version: 1 }] };
  const ctl = createReferenceController({
    docs: { refInterp: () => doc, refUse: () => Object.create(null) },
    modules: { refinterp, refuse, assetreg },
    referencesOfShot: () => [],
    chainOf: () => chain,
    prodOp: pass,
    persist: noop,
    refresh: noop,
    now: () => AT,
  });
  ctl.interp.save("ref-1", { cameraLanguage: "低机位" });
  const r = ctl.interp.reading("ref-1");
  assert.equal(r.basedOnAssetId, "asset-v1");
  assert.equal(r.basedOnVersion, 1);
  assert.equal(r.at, AT, "the clock is injected, so this is deterministic");

  // a chain with no current version records UNKNOWN rather than guessing v1
  chain = { list: [{ current: false, assetId: "asset-x", version: 3 }] };
  ctl.interp.save("ref-2", { cameraLanguage: "推" });
  const r2 = ctl.interp.reading("ref-2");
  assert.equal(r2.basedOnAssetId, null);
  assert.equal(r2.basedOnVersion, null);
});

/* --- the merge-and-edit transaction --------------------------------------- */

function subCtl({ locked = () => false } = {}) {
  const doc = subtitle.createSubtitles(null);
  const production = { activeEpisodeId: "ep-1" };
  const ctl = createSubtitleController({
    docs: { subtitles: () => doc, production: () => production, timelines: () => ({}) },
    modules: { subtitle, timeline },
    findShot: () => null,
    isCueLocked: locked,
    prodOp: pass,
    prodNew: pass,
    persist: noop,
    refresh: noop,
    now: () => AT,
  });
  return { ctl, doc };
}

/** Two adjacent cues. `addCue` MINTS the id, so the caller's is ignored — writing
 *  these tests against a made-up "c1" made them pass while merging nothing at all,
 *  which is the hollow-test failure they exist to catch. */
function twoCues(ctl) {
  const a = ctl.add({ startMs: 0, endMs: 1000, text: "陛下" });
  const b = ctl.add({ startMs: 1000, endMs: 2000, text: "臣有本奏" });
  assert.ok(a && b && a.cueId && b.cueId);
  return [a.cueId, b.cueId];
}

test("merge + a REFUSED edit keeps nothing — no half-applied subtitle", () => {
  const { ctl } = subCtl();
  const [c1] = twoCues(ctl);
  const before = ctl.track().cues.map((c) => ({ ...c }));

  // an edit the domain refuses (an inverted time range) after a successful merge
  const ok = ctl.update(c1, { mergeWithNext: true, startMs: 5000, endMs: 100 });
  assert.equal(ok, false);
  const after = ctl.track().cues;
  assert.equal(after.length, 2, "the merged-away cue came back");
  // and the survivor kept its ORIGINAL text, not the merged one: `slice()` restored
  // the array while `mergeCue` had already mutated the cue in place, which produced
  // duplicated overlapping subtitles (independent review, batch 3)
  assert.equal(after[0].text, "陛下");
  assert.equal(after[1].text, "臣有本奏");
  assert.equal(after[0].endMs, before[0].endMs, "the merged end time was rolled back too");
  assert.deepEqual(after.map((c) => c.cueId), before.map((c) => c.cueId));
});

test("a merge with NO other fields still applies, and a locked cue refuses", () => {
  const { ctl } = subCtl();
  const [c1] = twoCues(ctl);
  assert.equal(ctl.update(c1, { mergeWithNext: true }), true);
  assert.equal(ctl.track().cues.length, 1);
  assert.match(ctl.track().cues[0].text, /陛下/);
  assert.match(ctl.track().cues[0].text, /臣有本奏/);

  // a SKILL's edit is the same write path with the lock enforced — `update` forces,
  // `applyFix` does not, and that difference is the whole point of the two names
  const locked = subCtl({ locked: () => true });
  const only = locked.ctl.add({ startMs: 0, endMs: 1000, text: "陛下" });
  assert.equal(locked.ctl.applyFix(only.cueId, { text: "改写" }, { skillRunId: "r1" }), false);
  assert.equal(locked.ctl.track().cues[0].text, "陛下");
  assert.equal(locked.ctl.update(only.cueId, { text: "人工改写" }), true, "the creator still can");
  assert.equal(locked.ctl.track().cues[0].text, "人工改写");
});

/* --- anchors: resolve or say unresolved, never zero ------------------------ */

function audioCtl(shot) {
  const doc = shotaudio.createShotAudio(null);
  return createShotAudioController({
    docs: {
      shotAudio: () => doc,
      production: () => ({ activeEpisodeId: "ep-1", episodes: [] }),
      registry: () => assetlib.createRegistry(null),
    },
    modules: { shotaudio, proddoc, mediaref, assetreg, assetlib },
    findShot: () => shot,
    slotOf: () => "v1-1",
    contextOfShot: () => ({}),
    session: { connected: () => false, projectName: () => "p" },
    mixShotAudio: async () => ({ version: 1, url: "/u/mix.mp3" }),
    generations: { start: () => null, complete: noop },
    refreshType: noop,
    prodOp: pass,
    prodNew: pass,
    persist: noop,
    refresh: noop,
    toast: noop,
    now: () => AT,
  });
}

test("anchors come from what the documents really hold", () => {
  const ctl = audioCtl({
    shotId: "s1", duration_seconds: 10, dialogue: "陛下",
    audioAnchors: { doorSlam: 2400, negative: -50, bogus: "x" },
  });
  const a = ctl.anchors("s1");
  assert.equal(a["shot:start"], 0);
  assert.equal(a["shot:end"], 10_000);
  assert.equal(a["dialogue:s1"], 0);
  assert.equal(a["action:doorSlam"], 2400);
  assert.equal(a["action:negative"], 0, "a negative beat clamps, it does not vanish");
  assert.equal("action:bogus" in a, false, "a non-numeric beat is NOT invented at zero");

  // no dialogue → no dialogue anchor at all, rather than one pointing at nothing
  const silent = audioCtl({ shotId: "s1", duration_seconds: 6, dialogue: "   " });
  const b = silent.anchors("s1");
  assert.equal("dialogue:s1" in b, false);
  assert.equal(b["shot:end"], 6000);

  // an unknown shot still yields the two bounds — the default length, never NaN
  const none = audioCtl(null);
  assert.equal(none.anchors("s1")["shot:end"], 6000);
});

test("mixing refuses BEFORE any write when there is nothing audible", async () => {
  const ctl = audioCtl({ shotId: "s1", duration_seconds: 6 });
  // demo mode has no backend at all, and that is the first thing checked
  await assert.rejects(() => ctl.mixNow("s1"), /演示模式无后端/);
});

/* --- a binding either takes effect COMPLETELY or is refused with a sentence -- */

function frameCtl({ shot = null, slot = "v1-1", images = {} } = {}) {
  const doc = framebind.createFrameBindings(null);
  const registry = assetlib.createRegistry(null);
  registry.images = images;
  registry.firstFrames = {};
  const said = [];
  const refreshed = [];
  const ctl = createFrameController({
    docs: {
      frameBindings: () => doc,
      registry: () => registry,
      production: () => ({ activeEpisodeId: "ep-1", episodes: [] }),
    },
    modules: { framebind, mediaref, assetreg, assetlib, proddoc },
    findShot: () => shot,
    slotOf: () => slot,
    contextOfShot: () => ({}),
    session: { connected: () => true, projectName: () => "p" },
    uploadAssetImage: async () => ({ version: 1, url: "/u/f.png" }),
    grabVideoFrame: async () => ({ file: null, timecodeMs: 0 }),
    mintId: (p) => `${p}-1`,
    refreshType: (t) => refreshed.push(t),
    persist: noop,
    refresh: noop,
    toast: (m) => said.push(m),
    now: () => AT,
  });
  return { ctl, doc, registry, said, refreshed };
}

/** A registry holding one declared image on chain `key` at v1. */
function imagesWith(key, { kind, assetId }) {
  return {
    [key]: {
      current: 1,
      history: [{ slot_id: key, key, assetId, version: 1, url: "/u/a.png", kind, origin: "upload" }],
    },
  };
}

test("bind refuses BEFORE the first write, and says which check failed", () => {
  // The earlier order (write → discover → report success) produced three distinct
  // silent failures: a binding pointing at no shot; an asset that made the whole
  // document fail validation so the project could no longer be opened; and an
  // effective pointer that was never written, so the prompt showed the new frame
  // while generation still used the old one (TASK-072 §1.9 缺陷 1).
  const images = imagesWith("v1-2", { kind: "image", assetId: "img-other" });

  // ① unknown asset
  const a = frameCtl({ shot: { shotId: "s1" }, images });
  assert.equal(a.ctl.bind("s1", "startFrame", { assetId: "nope" }), null);
  assert.match(a.said[0], /只能绑定已登记的图片资产/);
  assert.deepEqual(a.ctl.bindings("s1"), {}, "nothing was written");

  // ② the target shot does not exist
  const b = frameCtl({ shot: null, images });
  assert.equal(b.ctl.bind("s1", "startFrame", { assetId: "img-other" }), null);
  assert.match(b.said[0], /目标镜头不存在/);

  // ③ the slot cannot be resolved → a binding whose pointer can never be written
  const c = frameCtl({ shot: { shotId: "s1" }, slot: null, images });
  assert.equal(c.ctl.bind("s1", "startFrame", { assetId: "img-other" }), null);
  assert.match(c.said[0], /槽位无法解析/);

  // ④ an image belonging to ANOTHER shot that is not an extracted frame — this is
  // the one that used to make the saved document unloadable
  const d = frameCtl({ shot: { shotId: "s1" }, slot: "v1-1", images });
  assert.equal(d.ctl.bind("s1", "startFrame", { assetId: "img-other" }), null);
  assert.match(d.said[0], /属于另一个镜头/);
  assert.deepEqual(d.registry.firstFrames, {}, "the effective pointer stayed empty");
});

test("a DERIVED frame may cross slots — that is the whole point of one", () => {
  // 上一镜尾帧 → 下一镜首帧 is exactly the case the cross-slot rule exists to allow
  const images = imagesWith("frame-1", { kind: "derived-frame", assetId: "img-frame" });
  const { ctl, registry, refreshed } = frameCtl({ shot: { shotId: "s2" }, slot: "v1-2", images });
  const b = ctl.bind("s2", "startFrame", { assetId: "img-frame", sourceKind: "upload" });
  assert.ok(b, "the binding was recorded");
  // …and the EFFECTIVE pointer moved with it: a record without this is provenance
  // for a frame nothing uses
  assert.equal(registry.firstFrames["v1-2"].assetId, "img-frame");
  assert.ok(refreshed.includes("video"));

  // unbinding clears BOTH, or generation keeps using a frame the record disowns
  assert.equal(ctl.unbind("s2", "startFrame"), true);
  assert.equal("v1-2" in registry.firstFrames, false);
});

test("re-extract refuses when the binding did not come from a video", async () => {
  const { ctl, said } = frameCtl({ shot: { shotId: "s1" } });
  assert.equal(await ctl.reextract("s1", "startFrame"), null);
  assert.match(said[0], /不是从视频里提取的/);
});

test("a project loaded MID-MIX does not split the write across two registries", async () => {
  // The refactor hoisted `docs.registry()` to a const before the `await`. In app.js
  // it was the bare identifier `assetRegistry`, resolved at each use — so everything
  // written AFTER the backend returns lands in whatever registry is current then.
  // Hoisting meant the new audio version went into the ABANDONED registry while the
  // mix pointer persisted into the NEW project, leaving a saved assetId that exists
  // in no registry at all (independent review).
  let registry = assetlib.createRegistry(null);
  const doc = shotaudio.createShotAudio(null);
  const shot = { shotId: "s1", title: "跪殿", duration_seconds: 6 };

  // one audible clip pointing at a local source in the CURRENT registry
  registry.audio["voice-v1-1"] = {
    current: 1,
    history: [{
      slot_id: "voice-v1-1", key: "voice-v1-1", assetId: "aud-1", version: 1,
      url: "/u/voice.wav", origin: "upload", storageState: "local",
    }],
  };
  // `trackType` / `startTimeMs` — `sanitizeClip` returns null for anything else, and
  // a fixture that silently produced no clip would make this test pass by mixing
  // nothing at all (the hollow-test failure this file already caught once)
  assert.ok(shotaudio.addClip(doc, "s1", {
    clipId: "c1", trackType: "dialogue", assetId: "aud-1", startTimeMs: 0, origin: "manual",
  }), "the fixture clip must actually be accepted");

  let switched = null;
  const ctl = createShotAudioController({
    docs: {
      shotAudio: () => doc,
      production: () => ({ activeEpisodeId: "ep-1", episodes: [] }),
      registry: () => registry, // ← read at each use, like the original binding
    },
    modules: { shotaudio, proddoc, mediaref, assetreg, assetlib },
    findShot: () => shot,
    slotOf: () => "v1-1",
    contextOfShot: () => ({}),
    session: { connected: () => true, projectName: () => "p" },
    mixShotAudio: async () => {
      // THE PROJECT SWITCH, in flight
      switched = assetlib.createRegistry(null);
      registry = switched;
      return { version: 1, url: "/u/mix-v1-1.mp3" };
    },
    generations: { start: () => null, complete: noop },
    refreshType: noop,
    prodOp: pass,
    prodNew: pass,
    persist: noop,
    refresh: noop,
    toast: noop,
    now: () => AT,
  });

  const ref = await ctl.mixNow("s1");
  assert.ok(ref && ref.assetId);
  // the new version landed in the registry that is CURRENT — the same one the mix
  // pointer was written against, so the saved assetId resolves
  assert.ok(switched.audio["mix-v1-1"], "the version went to the live registry");
  assert.equal(
    switched.audio["mix-v1-1"].history[0].assetId,
    shotaudio.mixOf(doc, "s1").assetId,
    "the mix pointer and the registered asset are the same one",
  );
});

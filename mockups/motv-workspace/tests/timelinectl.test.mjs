// TASK-073 §1.8 — the timeline controller, extracted from app.js and now testable.
//
// It uses the REAL `workflow/timeline.js` and `workflow/roughcut.js`; only the
// documents, the session values and the sibling controllers are stood in for. So these
// exercise the controller's own wiring — which document each call reads, what it
// persists, and what it refuses — rather than re-testing the domain modules.
import test from "node:test";
import assert from "node:assert/strict";

import { createTimelineController } from "../src/controllers/timelinectl.js";
import * as timeline from "../src/workflow/timeline.js";
import * as roughcut from "../src/workflow/roughcut.js";
import * as proddoc from "../src/workflow/proddoc.js";
import * as mediaref from "../src/workflow/mediaref.js";
import * as assetlib from "../src/workflow/assetlib.js";
import * as shotaudio from "../src/workflow/shotaudio.js";
import * as subtitle from "../src/workflow/subtitle.js";

function harness(over = {}) {
  const log = { persist: 0, refresh: 0, toasts: [], rendered: [] };
  const state = {
    timelines: over.timelines || {},
    // shaped like the real production document: scenes are NESTED inside the
    // episode (proddoc.episodeView reads `ep.scenes[].shotIds`)
    production: over.production || {
      activeEpisodeId: "ep1",
      episodes: [{
        episodeId: "ep1",
        title: "EP01",
        scenes: [{ sceneId: "sc1", title: "S1", shotIds: ["s1"], ambienceAssetId: null }],
      }],
      characters: [], locations: [],
    },
    assets: over.assets || {
      images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [],
    },
    shotAudio: over.shotAudio || {},
    subtitles: over.subtitles || {},
    projectName: over.projectName || "proj",
    connected: over.connected !== undefined ? over.connected : true,
  };
  const draftShots = over.draftShots || [{ shotId: "s1", sequence: 1, duration_seconds: 6, slot: "shot-1" }];
  const ctx = {
    project: { draftShots },
    shot: {
      find: (id) => draftShots.find((s) => s.shotId === id) || null,
      _slotOf: (shot) => (shot ? shot.slot || null : null),
    },
    locks: { is: () => false, count: () => 7 },
    persist: () => { log.persist += 1; },
    refreshType: () => {},
    startGeneration: (g) => { log.gen = g; return { generationId: "gen-1" }; },
    completeGeneration: (id, ids) => { log.completed = { id, ids }; },
  };
  const ctl = createTimelineController({
    docs: {
      timelines: () => state.timelines,
      production: () => state.production,
      assets: () => state.assets,
      shotAudio: () => state.shotAudio,
      subtitles: () => state.subtitles,
    },
    session: { projectName: () => state.projectName, connected: () => state.connected },
    modules: {
      timeline, roughcut, proddoc, mediaref, assetlib, shotaudio, subtitle,
      command: {
        renderEpisode: async (project, clips, settings) => {
          log.rendered.push({ project, clips, settings });
          return { url: "/api/uploads/proj/final-cut_v1.mp4", version: 1 };
        },
      },
    },
    helpers: {
      // the REAL signature would be a hash; a stable stand-in is enough to assert
      // that the fingerprint is stamped and compared, which is what this wiring does
      timelineSourceSig: (clips) => JSON.stringify((clips || []).map((c) => [c.shotId, c.startTime])),
      buildShotSlotIndex: () => new Map(draftShots.map((s) => [s.shotId, s.slot])),
      slotForShotId: (idx, shotId) => idx.get(shotId) || null,
      toast: (m) => log.toasts.push(m),
      refreshProductionView: () => { log.refresh += 1; },
      now: () => "2026-08-15T00:00:00.000Z",
    },
    getCtx: () => ctx,
  });
  return { ctl, state, log, ctx };
}

/** Register a video asset on shot s1's slot so rows carry footage. */
function withVideo(h, { version = 1, storageState = "local" } = {}) {
  mediaref.addVersion({ uploads: h.state.assets.videos }, "shot-1", {
    slot_id: "shot-1", origin: "upload", version, digest: null,
    url: "/api/uploads/proj/shot-1_v1.mp4", assetId: "asset-v1", storageState,
  });
}

test("gatherRows reads the CURRENT documents, not a captured snapshot", () => {
  const h = harness();
  assert.equal(h.ctl.gatherRows().length, 1);
  assert.equal(h.ctl.gatherRows()[0].videoAssetId, null, "no footage yet");
  withVideo(h);
  assert.equal(h.ctl.gatherRows()[0].videoAssetId, "asset-v1");
  assert.equal(h.ctl.gatherRows()[0].videoAssetVersion, 1);
  // THE REASON THE DOCUMENTS ARE GETTERS: project loading REPLACES the whole object.
  // A captured value would keep describing the previous project forever.
  h.state.production = { ...h.state.production, activeEpisodeId: "nope", episodes: [] };
  assert.deepEqual(h.ctl.gatherRows(), [], "follows the swapped document");
});

test("doc() auto-syncs an untouched timeline, and NEVER one the rough cut built", () => {
  const h = harness();
  withVideo(h);
  const t = h.ctl.doc();
  assert.ok(t.clips.length, "an empty, unedited timeline mirrors the source");
  assert.ok(h.log.persist >= 1);
  // a rough-cut timeline is not a mirror any more, even with no hand edit on it
  const h2 = harness();
  withVideo(h2);
  const t2 = timeline.timelineFor(h2.state.timelines, "ep1");
  t2.roughCutVersion = 1;
  const before = JSON.stringify(t2.clips);
  h2.ctl.doc();
  assert.equal(JSON.stringify(t2.clips), before, "roughCutVersion protects it from auto-sync");
  // …and neither is a hand-edited one
  const h3 = harness();
  withVideo(h3);
  const t3 = timeline.timelineFor(h3.state.timelines, "ep1");
  t3.edited = true;
  const before3 = JSON.stringify(t3.clips);
  h3.ctl.doc();
  assert.equal(JSON.stringify(t3.clips), before3, "`edited` protects it too");
});

test("op() routes to the domain function and only persists on success", () => {
  const h = harness();
  withVideo(h);
  const t = h.ctl.doc();
  const clip = t.clips.find((c) => c.trackType === "video");
  const before = h.log.persist;
  assert.equal(h.ctl.op("setClipVolume", clip.clipId, 0.5), true);
  assert.equal(t.clips.find((c) => c.clipId === clip.clipId).volume, 0.5);
  assert.ok(h.log.persist > before, "a successful op persists");
  const after = h.log.persist;
  // an unknown clip is a refusal — and a refusal must not persist
  assert.equal(h.ctl.op("setClipVolume", "no-such-clip", 0.5), false);
  assert.equal(h.log.persist, after, "a refused op does not persist");
});

test("sourceStale compares against the STAMPED fingerprint, not the clip list", () => {
  const h = harness();
  withVideo(h);
  const t = h.ctl.doc(); // syncs and stamps
  assert.equal(h.ctl.sourceStale(t), false);
  // a HAND EDIT must not read as 「source changed」 — that is the whole reason the
  // signature is stamped at sync time rather than derived from the clips
  timeline.setClipVolume(t, t.clips[0].clipId, 0.2);
  assert.equal(h.ctl.sourceStale(t), false, "a volume edit is not a source change");
  // …but a real source change is detected. NOTE: emptying the scene's `shotIds` is
  // NOT one — `episodeView` returns the now-unclaimed draft shot in `unassigned`, so
  // the rows are unchanged. That is correct behaviour and worth stating: the cut
  // mirrors 「这一集有哪些镜头」, and an unassigned shot is still one of them.
  h.ctx.project.draftShots.length = 0;
  assert.equal(h.ctl.sourceStale(t), true, "losing the shot IS a source change");
});

test("buildRoughCut refuses an episode with no footage, and says why", () => {
  const h = harness();
  const res = h.ctl.buildRoughCut();
  assert.equal(res.ok, false);
  assert.match(res.error, /初剪需要真实素材/);
  assert.equal(h.log.persist, 0, "a refusal writes nothing");
  // with footage it builds, and does NOT claim a human edit
  const h2 = harness();
  withVideo(h2);
  const ok = h2.ctl.buildRoughCut();
  assert.equal(ok.ok, true);
  const t = timeline.timelineFor(h2.state.timelines, "ep1");
  assert.ok(Number.isInteger(t.roughCutVersion));
  // FOUND BY THIS TEST, and deliberately asserted AS-IS (see TASK-073 §5.10):
  // `buildRoughCut`'s comment claims an automatic pass does not set `edited`,
  // 「so setting it here made every render claim human tuning that never happened」.
  // It does set it anyway — `roughcut.applyRoughCut` places clips through
  // `timeline.addClip`, which calls `touched()`, which sets `edited = true`. So the
  // Final Render's provenance records `timelineEdited: true` for a cut nobody touched.
  //
  // §1.8's discipline is 「一次提交只移动代码不改行为」 and this extraction is that
  // commit, so the defect is pinned here and recorded rather than fixed in a move.
  assert.equal(t.edited, true, "PRE-EXISTING: addClip → touched() sets edited");
});

test("resync overwrites and SAYS SO — the creator is told what was lost", () => {
  const h = harness();
  withVideo(h);
  h.ctl.resync();
  assert.equal(h.log.toasts.length, 1);
  assert.match(h.log.toasts[0], /此前的手工调整被本次同步覆盖/);
});

test("render refuses without a backend, and refuses non-local media", async () => {
  const off = harness({ connected: false });
  await assert.rejects(() => off.ctl.render(), /演示模式无后端/);

  const h = harness();
  withVideo(h);
  h.ctl.doc();
  // an archived asset must FAIL the render rather than be skipped: a final that
  // silently omits a shot is worse than one that does not exist
  h.state.assets.videos["shot-1"].history[0].storageState = "archived";
  await assert.rejects(() => h.ctl.render(), /媒体不可用/);
});

test("render freezes a provenance record that describes THIS render", async () => {
  const h = harness();
  withVideo(h);
  h.ctl.doc();
  const res = await h.ctl.render();
  assert.equal(h.log.rendered.length, 1);
  assert.equal(h.log.rendered[0].project, "proj", "the session's project name, read at call time");
  const p = h.log.gen.parameters;
  assert.equal(h.log.gen.type, "render");
  assert.equal(h.log.gen.provider, "ffmpeg-local");
  assert.equal(p.timelineEdited, false);
  assert.equal(p.subtitleBurnedIn, false, "an SRT beside the MP4 is not a burn-in");
  // the lock count comes from the ONE counter that spans all four stores
  assert.equal(p.locksInForce, 7);
  assert.ok(Array.isArray(p.clips) && p.clips.length >= 1);
  assert.ok(p.clips[0].assetId, "each clip records WHICH asset played");
  assert.ok(res.assetId, "the Final is registered");
});

test("a timeline with no video clip cannot be rendered", async () => {
  const h = harness();
  // audio only
  const t = timeline.timelineFor(h.state.timelines, "ep1");
  t.clips = [];
  await assert.rejects(() => h.ctl.render(), /没有视频 clip/);
});

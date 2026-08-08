// Unit tests for the Production module workspaces' pure view-models — the
// read-only lenses over existing workflow/node state (no ownership moved).
// Run via `node --test`, wrapped by tests/test_motv_production_view_e2e.py.
import test from "node:test";
import assert from "node:assert/strict";

import {
  ideaModel,
  shotsModel,
  assetsModel,
  videoModel,
  audioModel,
  editModel,
} from "../src/ui/workspaces.js";
import { navBadges } from "../src/ui/production.js";
import * as sd from "../src/workflow/scriptdoc.js";

/** Empty prodData snapshot (fresh project). */
function pdEmpty() {
  return {
    draftShots: null,
    lockedPlan: null,
    shotVersions: null,
    realShots: null,
    assetUploads: {},
    media: { video: {}, audio: {} },
    firstFrames: {},
    finals: [],
    paidOps: {},
  };
}

/** Snapshot with a 2-shot draft and some media in versioned/legacy forms. */
function pdDraft() {
  const pd = pdEmpty();
  pd.draftShots = [
    { sequence: 1, title: "跪殿", description: "大殿中央", duration_seconds: 6, slot: "v1-1" },
    { sequence: 2, title: "逼诗", description: "皇帝俯视", duration_seconds: 10, slot: "v1-2" },
  ];
  pd.shotVersions = { count: 1, cur: 1, state: "done", rows: null };
  // shot 1 has an asset image (2 versions, current v2, paid) — shot 2 has none
  pd.assetUploads["v1-1"] = {
    current: 2,
    history: [
      { slot_id: "v1-1", origin: "upload", version: 1, digest: null, url: "/u/a1.png" },
      { slot_id: "v1-1", origin: "paid-image", version: 2, digest: "d", url: "/u/a1_v2.png" },
    ],
  };
  // shot 1 video uploaded as a legacy plain-string slot; first-frame lineage
  // recorded for it; shot 2 has neither
  pd.media.video["v1-1"] = "/u/vid1.mp4";
  pd.firstFrames["v1-1"] = { slot_id: "v1-1", origin: "paid-image", version: 2, url: "/u/a1_v2.png" };
  // voice for shot 2 only + background music
  pd.media.audio["voice-v1-2"] = "/u/voice2.wav";
  pd.media.audio["music-main"] = "/u/music.mp3";
  return pd;
}

// --- 创意 --------------------------------------------------------------- //

test("ideaModel: brief + script standing + pending status", () => {
  const d = sd.createDoc();
  assert.deepEqual(ideaModel(d), {
    brief: "",
    hasScript: false,
    scriptVersions: 0,
    activeVersion: 0,
    pending: null,
  });
  sd.setBrief(d, "一句创意");
  sd.completeGeneration(d, sd.beginGeneration(d, "initial", "一句创意"), "v1 正文");
  sd.beginGeneration(d, "revision", "改");
  const m = ideaModel(d);
  assert.equal(m.hasScript, true);
  assert.equal(m.scriptVersions, 1);
  assert.equal(m.pending, "generating");
});

// --- 分镜 --------------------------------------------------------------- //

test("shotsModel: empty project opens as empty state, not disabled", () => {
  const m = shotsModel(pdEmpty());
  assert.equal(m.empty, true);
  assert.equal(m.lock, null);
});

test("shotsModel: structured draft exposes index/title/description/duration", () => {
  const m = shotsModel(pdDraft());
  assert.equal(m.empty, false);
  assert.equal(m.kind, "draft");
  assert.deepEqual(m.shots[1], {
    seq: 2, title: "逼诗", description: "皇帝俯视", duration: 10, slot: "v1-2",
  });
  assert.deepEqual(m.versions, { count: 1, cur: 1 });
});

test("shotsModel: falls back to display rows, then real records", () => {
  const pd = pdEmpty();
  pd.shotVersions = { count: 2, cur: 2, state: "done", rows: [["01", "跪殿(逆光)"]] };
  let m = shotsModel(pd);
  assert.equal(m.kind, "rows");
  assert.equal(m.shots[0].title, "跪殿(逆光)");
  assert.equal(m.shots[0].duration, null); // not available — not invented
  const pd2 = pdEmpty();
  pd2.realShots = [["01", "官方镜头记录（6s）"]];
  m = shotsModel(pd2);
  assert.equal(m.kind, "records");
  assert.equal(m.empty, false);
});

// --- 资产 --------------------------------------------------------------- //

test("assetsModel: per-shot slot standing with version chain metadata", () => {
  const m = assetsModel(pdDraft());
  assert.equal(m.done, 1);
  assert.equal(m.total, 2);
  assert.deepEqual(m.items[0], {
    seq: 1, title: "跪殿", slot: "v1-1",
    url: "/u/a1_v2.png", versions: 2, current: 2, origin: "paid-image",
  });
  assert.equal(m.items[1].url, ""); // empty slot shows as missing, still listed
});

test("assetsModel: no shots → empty state", () => {
  const m = assetsModel(pdEmpty());
  assert.equal(m.empty, true);
  assert.equal(m.context, null); // truly nothing — no context to surface
});

test("media models surface existing real/row shots as context, never 'nothing'", () => {
  // connected mode: real locked records exist, but no canvas draft → media
  // slots can't attach; the models must still expose the shots' existence
  const pd = pdEmpty();
  pd.realShots = [["01", "官方镜头（6s）"], ["02", "官方镜头（10s）"]];
  for (const model of [assetsModel, videoModel, audioModel, editModel]) {
    const m = model(pd);
    assert.equal(m.empty, true, model.name);
    assert.deepEqual(m.context, { count: 2, kind: "records" }, model.name);
  }
  // demo mode: scriptgen display rows without a structured draft → same
  const pd2 = pdEmpty();
  pd2.shotVersions = { count: 1, cur: 1, state: "done", rows: [["01", "跪殿"]] };
  assert.deepEqual(videoModel(pd2).context, { count: 1, kind: "rows" });
  // an active draft never reports context (the full per-shot list renders)
  assert.equal(assetsModel(pdDraft()).context, undefined);
});

// --- 视频 --------------------------------------------------------------- //

test("videoModel: known first-frame lineage is exposed; absent stays unknown", () => {
  const m = videoModel(pdDraft());
  assert.equal(m.done, 1);
  const [s1, s2] = m.items;
  assert.equal(s1.url, "/u/vid1.mp4"); // legacy string slot readable as v1
  assert.equal(s1.versions, 1);
  assert.deepEqual(s1.firstFrame, { version: 2, origin: "paid-image", url: "/u/a1_v2.png" });
  assert.equal(s2.firstFrame, null); // never invented
  assert.equal(s2.url, "");
});

test("videoModel: paid ops map via locked plan ids, else shot-<seq>", () => {
  const pd = pdDraft();
  pd.paidOps = { "shot-1": { status: "held" } };
  assert.equal(videoModel(pd).items[0].opStatus, "held");
  pd.lockedPlan = { plan_version: 2, shots: [{ shot_id: "shot-p2-1" }, { shot_id: "shot-p2-2" }] };
  pd.paidOps = { "shot-p2-1": { status: "committed" } };
  const m = videoModel(pd);
  assert.equal(m.items[0].opStatus, "committed");
  assert.equal(m.items[1].opStatus, null);
});

// --- 音频 --------------------------------------------------------------- //

test("audioModel: voice per shot + music/sfx extras", () => {
  const m = audioModel(pdDraft());
  assert.equal(m.done, 1);
  assert.equal(m.items[0].url, ""); // shot 1 has no voice
  assert.equal(m.items[1].url, "/u/voice2.wav");
  const music = m.extras.find((x) => x.key === "music-main");
  assert.equal(music.url, "/u/music.mp3");
  assert.equal(m.extras.find((x) => x.key === "sfx-main").url, "");
});

// --- 剪辑 --------------------------------------------------------------- //

test("editModel: readiness per shot and composed finals", () => {
  const pd = pdDraft();
  pd.finals = ["/u/final_v1.mp4", "/u/final_v2.mp4"];
  const m = editModel(pd);
  assert.equal(m.ready, 1);
  assert.equal(m.total, 2);
  assert.deepEqual(m.items[0], { seq: 1, title: "跪殿", video: true, voice: false });
  assert.deepEqual(m.items[1], { seq: 2, title: "逼诗", video: false, voice: true });
  assert.equal(m.finals, 2);
  assert.equal(m.lastFinal, "/u/final_v2.mp4");
});

test("editModel: empty project still surfaces finals standing", () => {
  const m = editModel(pdEmpty());
  assert.equal(m.empty, true);
  assert.equal(m.finals, 0);
});

// --- 导航徽标 ------------------------------------------------------------ //

test("navBadges: counts reflect state; empty modules still get a badge-less item", () => {
  const d = sd.createDoc();
  const empty = navBadges(d, pdEmpty());
  assert.deepEqual(empty, {
    idea: "", script: "草稿", shots: "", assets: "", video: "", audio: "", edit: "",
  });
  sd.setBrief(d, "想法");
  sd.completeGeneration(d, sd.beginGeneration(d, "initial", "想法"), "v1");
  const b = navBadges(d, pdDraft());
  assert.equal(b.idea, "✓");
  assert.equal(b.script, "v1");
  assert.equal(b.shots, "2");
  assert.equal(b.assets, "1/2");
  assert.equal(b.video, "1/2");
  assert.equal(b.audio, "1/2");
  assert.equal(b.edit, "");
});

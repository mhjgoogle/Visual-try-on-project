// Audio Production + Episode Timeline + Storage Management (checkpoint M11)
// — run via `node --test`, wrapped by tests/test_motv_av_m11.py.
//
// Covers the M11 verification points: voice identity fixed across states/
// episodes (states adjust PERFORMANCE only), dialogue prompt context, scene
// ambience / episode+scene BGM as reused REFERENCES (never per-shot copies),
// timeline clips referencing assetIds (never media bytes), reorder/replace/
// trim/volume/mute/fade persistence across the save round-trip, the edited
// flag protecting hand-made work from silent overwrite, Remove-Local-Copy
// preserving identity+provenance+references, permanent-delete blocked by
// live references, final render as a stable Asset, and legacy-load migration.
import test from "node:test";
import assert from "node:assert/strict";

import * as tl from "../src/workflow/timeline.js";
import * as pd from "../src/workflow/proddoc.js";
import * as bd from "../src/workflow/bibledoc.js";
import * as al from "../src/workflow/assetlib.js";
import { compileDialoguePrompt } from "../src/workflow/promptc.js";
import { storageModel } from "../src/ui/storagews.js";
import { audioShotModel } from "../src/ui/audiows.js";
import { timelineModel } from "../src/ui/timelinews.js";
import { CANVAS_SCHEMA_VERSION, migrateToCurrent, validateCanvasDoc } from "../src/services/canvasschema.js";

// --- fixtures --------------------------------------------------------------- //

/** Ordered shot rows the auto-build consumes (every id an Asset REFERENCE). */
function rows() {
  return [
    { shotId: "shot-a", duration: 6, videoAssetId: "asset-v1", dialogueAssetId: "asset-d1", sceneId: "sc-1", ambienceAssetId: "asset-amb", bgmAssetId: "asset-bgm" },
    { shotId: "shot-b", duration: 10, videoAssetId: "asset-v2", sfxAssetId: "asset-fx1", sceneId: "sc-1", ambienceAssetId: "asset-amb", bgmAssetId: "asset-bgm" },
    { shotId: "shot-c", duration: 4, videoAssetId: "asset-v3", sceneId: "sc-2", ambienceAssetId: null, bgmAssetId: "asset-bgm" },
  ];
}

/** A registry with an audio chain, a video chain (2 versions), a final. */
function regFixture() {
  const reg = al.createRegistry(null);
  reg.videos["v1-1"] = {
    current: 2,
    history: [
      { slot_id: "v1-1", origin: "upload", version: 1, digest: null, url: "/u/vid1.mp4", assetId: "asset-v1", storageState: "local" },
      { slot_id: "v1-1", origin: "paid-video", version: 2, digest: "d", url: "/u/vid1_v2.mp4", assetId: "asset-v1b", storageState: "local" },
    ],
  };
  reg.audio["voice-v1-1"] = {
    current: 1,
    history: [{ slot_id: "voice-v1-1", origin: "tts", version: 1, digest: null, url: "/u/d1.wav", assetId: "asset-d1", storageState: "local" }],
  };
  reg.audio["ambience-1"] = {
    current: 1,
    history: [{ slot_id: "ambience-1", origin: "upload", version: 1, digest: null, url: "/u/amb.mp3", assetId: "asset-amb", storageState: "local" }],
  };
  return reg;
}

// --- voice rule: identity fixed, state = performance only ---------------------- //

test("voice identity NEVER changes across states — states adjust performance only", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "李昭");
  bd.setCharacterVoice(p, c.characterId, { voiceId: "vc-base", description: "低沉男声", performance: { pace: "平稳" } });
  const st = bd.addCharacterState(p, c.characterId, "重伤");
  bd.setCharacterStateOverrides(p, c.characterId, st.stateId, { voice: { description: "气若游丝、缓慢", performance: { pace: "虚弱" }, voiceId: "vc-EVIL" } });
  const base = bd.resolveCharacter(c, null);
  const hurt = bd.resolveCharacter(c, st.stateId);
  // SAME identity in every state — the id a TTS/voice API would receive
  assert.equal(base.voice.voiceId, "vc-base");
  assert.equal(hurt.voice.voiceId, "vc-base");
  // performance characteristics DO follow the state
  assert.equal(hurt.voice.description, "气若游丝、缓慢");
  assert.deepEqual(hurt.voice.performance, { pace: "虚弱" });
  // a state trying to smuggle its own voiceId is stripped at the write path
  assert.ok(!("voiceId" in (bd.findCharacter(p, c.characterId).states[0].overrides.voice || {})));
});

test("compileDialoguePrompt: base identity line fixed; state adds a performance-only line", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "李昭");
  bd.setCharacterVoice(p, c.characterId, { voiceId: "vc-base", description: "低沉男声" });
  const st = bd.addCharacterState(p, c.characterId, "重伤");
  bd.setCharacterStateOverrides(p, c.characterId, st.stateId, { voice: { description: "气若游丝" } });
  const out = compileDialoguePrompt({
    dialogue: "朕……还没死。",
    character: bd.resolveCharacter(c, st.stateId),
    baseVoice: c.voice,
    emotion: "隐忍",
  });
  assert.deepEqual(out.missing, []);
  assert.match(out.text, /【声音身份（固定）】vc-base · 低沉男声/);
  assert.match(out.text, /【状态表现（仅调表现，不换声音）】气若游丝/);
  assert.match(out.text, /【本镜头情绪\/表演】隐忍/);
  // honest gaps when context is absent — never invented
  const bare = compileDialoguePrompt({ dialogue: "" });
  assert.equal(bare.missing.length, 2);
});

test("compileDialoguePrompt: structured state performance (pace/intensity) survives even when description is unchanged (review R2)", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "李昭");
  bd.setCharacterVoice(p, c.characterId, { voiceId: "vc-base", description: "低沉男声", performance: { pace: "平稳" } });
  const st = bd.addCharacterState(p, c.characterId, "重伤");
  // description NOT overridden — only structured performance changes
  bd.setCharacterStateOverrides(p, c.characterId, st.stateId, { voice: { performance: { pace: "急促", intensity: "高" } } });
  const out = compileDialoguePrompt({
    dialogue: "快走！",
    character: bd.resolveCharacter(c, st.stateId),
    baseVoice: c.voice,
  });
  const perfLine = out.text.split("\n").find((l) => l.includes("状态表现"));
  assert.ok(perfLine, "a performance-only state must still produce a 状态表现 line");
  assert.match(perfLine, /pace：急促/); // the changed facet is surfaced
  assert.match(perfLine, /intensity：高/); // the new facet is surfaced
  assert.ok(!perfLine.includes("平稳")); // the UNCHANGED base facet is not repeated
});

test("audioShotModel.hasVideo respects storageState — a removed local copy is not usable (V1 debt)", () => {
  const p = pd.createProduction(null);
  const epId = p.episodes[0].episodeId;
  const sc = pd.addScene(p, epId, "大殿");
  pd.assignShot(p, sc.sceneId, "shot-a");
  const mkPd = (videoState) => ({
    draftShots: [{ shotId: "shot-a", sequence: 1, title: "跪殿", slot: "v1-1", dialogue: "台词" }],
    production: p,
    media: {
      video: { "v1-1": { current: 1, history: [{ slot_id: "v1-1", version: 1, url: "/u/v.mp4", assetId: "asset-v", storageState: videoState }] } },
      audio: {},
    },
  });
  assert.equal(audioShotModel(mkPd("local"), "shot-a").hasVideo, true);
  assert.equal(audioShotModel(mkPd("deleted"), "shot-a").hasVideo, false); // bytes gone
  assert.equal(audioShotModel(mkPd("missing"), "shot-a").hasVideo, false);
});

// --- ambience / BGM: references reused, never copied --------------------------- //

test("scene ambience + episode/scene BGM are Asset REFERENCES with scene override", () => {
  const p = pd.createProduction(null);
  const epId = p.episodes[0].episodeId;
  const s1 = pd.addScene(p, epId, "大殿");
  const s2 = pd.addScene(p, epId, "偏殿");
  assert.equal(pd.setSceneAmbience(p, s1.sceneId, "asset-amb"), true);
  assert.equal(pd.setSceneAmbience(p, s2.sceneId, "asset-amb"), true); // SAME asset, two scenes
  assert.equal(pd.setEpisodeBgm(p, epId, "asset-bgm"), true);
  assert.deepEqual(pd.effectiveBgm(p, epId, s1.sceneId), { assetId: "asset-bgm", from: "episode" });
  assert.equal(pd.setSceneBgm(p, s2.sceneId, "asset-bgm2"), true);
  assert.deepEqual(pd.effectiveBgm(p, epId, s2.sceneId), { assetId: "asset-bgm2", from: "scene" });
  assert.equal(pd.setSceneBgm(p, s2.sceneId, null), true); // null clears → back to episode
  assert.deepEqual(pd.effectiveBgm(p, epId, s2.sceneId), { assetId: "asset-bgm", from: "episode" });
  assert.equal(pd.effectiveBgm(pd.createProduction(null), "ep-x", null), null);
});

test("buildFromRows: a row without video contributes nothing — the video track is GAPLESS (render concat parity, review R1)", () => {
  const r = rows();
  r.splice(1, 0, { shotId: "shot-x", duration: 8, videoAssetId: null, dialogueAssetId: "asset-dx", sceneId: "sc-1", ambienceAssetId: "asset-amb", bgmAssetId: "asset-bgm" });
  const clips = tl.buildFromRows(r);
  // no phantom 8s hole: shot-b still starts right after shot-a, exactly where
  // the ffmpeg concat will put it — audio placements stay in sync
  const vids = clips.filter((c) => c.trackType === "video");
  assert.deepEqual(vids.map((c) => c.startTime), [0, 6, 16]);
  assert.ok(!clips.some((c) => c.assetId === "asset-dx")); // no footage → no slot
  assert.equal(clips.filter((c) => c.trackType === "ambience").length, 1); // span unbroken
});

test("buildFromRows merges contiguous same-asset ambience/bgm into ONE clip (reuse, no per-shot copies)", () => {
  const clips = tl.buildFromRows(rows());
  const amb = clips.filter((c) => c.trackType === "ambience");
  const bgm = clips.filter((c) => c.trackType === "bgm");
  assert.equal(amb.length, 1); // shots a+b share the scene ambience → one span
  assert.deepEqual([amb[0].startTime, amb[0].trimOut], [0, 16]);
  assert.equal(bgm.length, 1); // all three shots under the same BGM → one span
  assert.deepEqual([bgm[0].startTime, bgm[0].trimOut], [0, 20]);
  assert.equal(amb[0].assetId, "asset-amb"); // a REFERENCE — same id, no copy
});

// --- timeline: reference-only clips, sequential video, anchored audio ---------- //

test("clips reference assetIds and never own bytes/urls; video is sequential", () => {
  const t = tl.timelineFor(tl.createTimelines(null), "ep-1");
  tl.syncFromRows(t, rows());
  for (const c of t.clips) {
    assert.match(c.assetId, /^asset-/);
    assert.ok(!("url" in c) && !("bytes" in c) && !("data" in c)); // reference only
  }
  const vids = tl.clipsOf(t, "video");
  assert.deepEqual(vids.map((c) => c.startTime), [0, 6, 16]);
  assert.equal(tl.timelineDuration(t), 20);
  assert.equal(t.edited, false); // auto-build/sync leaves the timeline pristine
});

test("reorderVideo keeps clip identity and shifts shot-ANCHORED audio with its shot", () => {
  const t = tl.timelineFor(tl.createTimelines(null), "ep-1");
  tl.syncFromRows(t, rows());
  const [v1] = tl.clipsOf(t, "video");
  const d1 = tl.clipsOf(t, "dialogue")[0];
  assert.equal(d1.shotId, "shot-a");
  assert.equal(tl.reorderVideo(t, v1.clipId, +1), true); // shot-a after shot-b
  assert.deepEqual(tl.clipsOf(t, "video").map((c) => c.shotId), ["shot-b", "shot-a", "shot-c"]);
  assert.equal(tl.findClip(t, v1.clipId).startTime, 10); // relayout, same clipId
  assert.equal(d1.startTime, 10); // dialogue anchored to shot-a moved with it
  assert.equal(t.edited, true); // a manual edit — protected from silent sync
  assert.equal(tl.reorderVideo(t, tl.clipsOf(t, "video")[2].clipId, +1), false); // edge no-op
});

test("replaceClipAsset is a deterministic REFERENCE swap — nothing about the old asset changes", () => {
  const reg = regFixture();
  const t = tl.timelineFor(tl.createTimelines(null), "ep-1");
  tl.syncFromRows(t, rows());
  const v = tl.clipsOf(t, "video")[0];
  assert.equal(tl.replaceClipAsset(t, v.clipId, "asset-v1b"), true); // another variant of the SAME chain
  assert.equal(v.assetId, "asset-v1b");
  assert.equal(al.findAssetById(reg, "asset-v1").record.storageState, "local"); // old version untouched
  assert.equal(tl.replaceClipAsset(t, v.clipId, ""), false); // empty ref refused
});

test("trimming a video clip clamps its shot-anchored audio so it never overhangs the shot (review R8)", () => {
  const t = tl.timelineFor(tl.createTimelines(null), "ep-1");
  tl.syncFromRows(t, rows());
  const v = tl.clipsOf(t, "video").find((c) => c.shotId === "shot-a"); // 6s
  const d = tl.clipsOf(t, "dialogue").find((c) => c.shotId === "shot-a"); // 6s
  assert.equal(d.trimOut - d.trimIn, 6);
  // trim the shot's picture to 3s → its dialogue must be clamped to ≤3s so it
  // cannot play over the next shot; audio start stays anchored via relayout
  assert.equal(tl.trimClip(t, v.clipId, 0, 3), true);
  assert.equal(tl.findClip(t, d.clipId).trimOut - tl.findClip(t, d.clipId).trimIn, 3);
  // a DIFFERENT shot's audio is untouched
  const other = tl.clipsOf(t, "sfx").find((c) => c.shotId === "shot-b");
  assert.equal(other.trimOut - other.trimIn, 10);
  // trimming the video LONGER does not artificially extend the (now 3s) audio
  assert.equal(tl.trimClip(t, v.clipId, 0, 6), true);
  assert.equal(tl.findClip(t, d.clipId).trimOut - tl.findClip(t, d.clipId).trimIn, 3);
});

test("trim/volume/mute/fades/move persist across the serialize→hydrate round-trip", () => {
  const docs = tl.createTimelines(null);
  const t = tl.timelineFor(docs, "ep-1");
  tl.syncFromRows(t, rows());
  const v = tl.clipsOf(t, "video")[0];
  const d = tl.clipsOf(t, "dialogue")[0];
  assert.equal(tl.trimClip(t, v.clipId, 1, 5), true); // 6s shot → 4s used
  assert.equal(tl.clipsOf(t, "video")[1].startTime, 4); // video relayout follows the trim
  assert.equal(tl.setClipVolume(t, d.clipId, 0.55), true);
  assert.equal(tl.setClipMuted(t, d.clipId, true), true);
  assert.equal(tl.setClipFades(t, d.clipId, 0.3, 0.8), true);
  assert.equal(tl.moveClip(t, d.clipId, 2.5), true);
  assert.equal(tl.moveClip(t, v.clipId, 3), false); // video placement is sequential-only
  assert.equal(tl.trimClip(t, v.clipId, 5, 5), false); // trimOut<=trimIn refused
  tl.setSettings(t, { width: 1920, height: 1080, fps: 30, format: "webm" });
  // RELOAD: hydrate from the plain serialized form (what the canvas doc stores)
  const back = tl.timelineFor(tl.createTimelines(JSON.parse(JSON.stringify(tl.serialize(docs)))), "ep-1");
  assert.equal(back.edited, true);
  const v2 = tl.findClip(back, v.clipId);
  const d2 = tl.findClip(back, d.clipId);
  assert.deepEqual([v2.trimIn, v2.trimOut], [1, 5]);
  assert.deepEqual([d2.volume, d2.muted, d2.fadeIn, d2.fadeOut, d2.startTime], [0.55, true, 0.3, 0.8, 2.5]);
  assert.deepEqual(back.settings, { width: 1920, height: 1080, fps: 30, format: "webm" });
});

test("removeClip/addClip never touch the referenced assets; hydration drops only garbage", () => {
  const reg = regFixture();
  const t = tl.timelineFor(tl.createTimelines(null), "ep-1");
  tl.syncFromRows(t, rows());
  const d = tl.clipsOf(t, "dialogue")[0];
  assert.equal(tl.removeClip(t, d.clipId), true);
  assert.ok(al.findAssetById(reg, "asset-d1")); // clip gone, ASSET stays
  const added = tl.addClip(t, { trackType: "sfx", assetId: "asset-fx9", shotId: "shot-b", startTime: 7, duration: 2 });
  assert.match(added.clipId, /^clip-/);
  assert.equal(tl.addClip(t, { trackType: "video", assetId: "" }), null); // no empty refs
  // hydration: clip without assetId dropped; duplicate clipId re-minted;
  // volume clamped; trimOut<=trimIn repaired; unknown fields carried through
  const h = tl.createTimelines({
    "ep-1": {
      edited: true, futureField: "kept",
      clips: [
        { clipId: "c1", trackType: "video", assetId: "asset-v1", trimIn: 0, trimOut: 6, volume: 9, futureClipField: 1 },
        { clipId: "c1", trackType: "sfx", assetId: "asset-fx1", trimIn: 3, trimOut: 2 },
        { clipId: "c2", trackType: "video", assetId: "" },
        { clipId: "c3", trackType: "hologram", assetId: "asset-x" },
      ],
    },
  })["ep-1"];
  assert.equal(h.clips.length, 2);
  assert.equal(h.clips[0].volume, 2);
  assert.equal(h.clips[0].futureClipField, 1);
  assert.equal(h.futureField, "kept");
  assert.notEqual(h.clips[1].clipId, "c1");
  assert.ok(h.clips[1].trimOut > h.clips[1].trimIn);
});

test("removeClip on a VIDEO clip cascades to its shot-anchored audio, never scene audio (review R4)", () => {
  const t = tl.timelineFor(tl.createTimelines(null), "ep-1");
  tl.syncFromRows(t, rows());
  const v1 = tl.clipsOf(t, "video").find((c) => c.shotId === "shot-a");
  assert.ok(tl.clipsOf(t, "dialogue").some((c) => c.shotId === "shot-a")); // present before
  assert.equal(tl.removeClip(t, v1.clipId), true);
  // the shot's own dialogue is gone (no anchor left → no orphaned audio)
  assert.ok(!tl.clipsOf(t, "dialogue").some((c) => c.shotId === "shot-a"));
  assert.ok(!tl.clipsOf(t, "video").some((c) => c.shotId === "shot-a"));
  // scene ambience / episode bgm (shotId null) are NOT shot-anchored — kept
  assert.equal(tl.clipsOf(t, "ambience").length, 1);
  assert.equal(tl.clipsOf(t, "bgm").length, 1);
  // shot-b's sfx (a different shot) is untouched
  assert.ok(tl.clipsOf(t, "sfx").some((c) => c.shotId === "shot-b"));
});

test("timelineModel labels clips by shot ('01 跪殿'), falling back to assetId (V1 friction)", () => {
  const t = tl.timelineFor(tl.createTimelines(null), "ep-1");
  tl.syncFromRows(t, rows());
  const labels = { "shot-a": "01 跪殿", "shot-b": "02 逼诗" };
  const m = timelineModel(t, regFixture(), labels);
  const vids = m.tracks.find((x) => x.track === "video").clips;
  assert.equal(vids[0].label, "01 跪殿"); // shot-anchored → human label
  assert.equal(vids[1].label, "02 逼诗");
  const bgm = m.tracks.find((x) => x.track === "bgm").clips[0];
  assert.equal(bgm.label, bgm.assetId.slice(0, 12)); // scene/episode audio → assetId fallback
  const c = m.tracks.find((x) => x.track === "video").clips[2]; // shot-c, unmapped
  assert.equal(c.label, c.assetId.slice(0, 12));
});

test("clip start/fade are clamped to the shared render bounds (V1 debt: no unrenderable saves)", () => {
  const t = tl.timelineFor(tl.createTimelines(null), "ep-1");
  tl.syncFromRows(t, rows());
  const d = tl.clipsOf(t, "dialogue")[0];
  tl.setClipFades(t, d.clipId, 999, 999); // absurd fades
  assert.equal(tl.findClip(t, d.clipId).fadeIn, tl.MAX_CLIP_FADE);
  assert.equal(tl.findClip(t, d.clipId).fadeOut, tl.MAX_CLIP_FADE);
  tl.moveClip(t, d.clipId, 1e9); // absurd start
  assert.equal(tl.findClip(t, d.clipId).startTime, tl.MAX_CLIP_START);
  // hydration clamps a corrupt persisted value too, so the doc stays valid
  const h = tl.createTimelines({
    "ep-1": { edited: true, settings: { width: 1280, height: 720, fps: 25, format: "mp4" }, clips: [
      { clipId: "c1", trackType: "dialogue", assetId: "a", startTime: 1e9, trimIn: 0, trimOut: 2, fadeIn: 999, fadeOut: 999 },
    ] },
  })["ep-1"];
  assert.equal(h.clips[0].startTime, tl.MAX_CLIP_START);
  assert.equal(h.clips[0].fadeIn, tl.MAX_CLIP_FADE);
  const doc = v9Doc();
  doc.timelines = { "ep-1": h };
  assert.equal(validateCanvasDoc(doc), null); // clamped values pass validation
  // and validation REJECTS an out-of-bounds value crafted directly (not clamped)
  const bad = v9Doc();
  bad.timelines = { "ep-1": { edited: true, settings: h.settings, clips: [
    { clipId: "x", trackType: "dialogue", assetId: "a", shotId: null, startTime: 0, trimIn: 0, trimOut: 2, volume: 1, muted: false, fadeIn: tl.MAX_CLIP_FADE + 1, fadeOut: 0 },
  ] } };
  assert.notEqual(validateCanvasDoc(bad), null);
});

test("syncFromRows is the ONLY overwrite path and it clears `edited` (explicit confirmed re-sync)", () => {
  const t = tl.timelineFor(tl.createTimelines(null), "ep-1");
  tl.syncFromRows(t, rows());
  tl.setClipVolume(t, tl.clipsOf(t, "dialogue")[0].clipId, 0.2);
  assert.equal(t.edited, true);
  tl.syncFromRows(t, rows()); // caller confirmed — rebuild + clear the flag
  assert.equal(t.edited, false);
  assert.equal(tl.clipsOf(t, "dialogue")[0].volume, 1); // hand edit consciously discarded
});

// --- storage: Remove Local Copy vs Permanent Delete ---------------------------- //

test("Remove Local Copy = storageState 'deleted': identity/url/provenance/references all preserved", () => {
  const reg = regFixture();
  assert.equal(al.setStorageState(reg, "asset-d1", "deleted"), true);
  const hit = al.findAssetById(reg, "asset-d1");
  assert.equal(hit.record.storageState, "deleted"); // ONLY availability changed
  assert.equal(hit.record.assetId, "asset-d1");
  assert.equal(hit.record.url, "/u/d1.wav"); // last-known location kept
  assert.equal(reg.audio["voice-v1-1"].current, 1); // chain untouched
  // a timeline still referencing it keeps the reference (UI shows unavailable)
  const t = tl.timelineFor(tl.createTimelines(null), "ep-1");
  tl.addClip(t, { trackType: "dialogue", assetId: "asset-d1" });
  const refs = al.referencesOfAsset({ reg, assetId: "asset-d1", production: null, timelines: { "ep-1": t }, generations: [] });
  assert.deepEqual(refs.blocking, ["时间线 clip（dialogue）"]);
});

test("referencesOfAsset finds every blocking reference class + counts provenance separately", () => {
  const reg = regFixture();
  reg.firstFrames["v1-1"] = { slot_id: "v1-1", origin: "upload", version: 1, url: "/u/a.png", assetId: "asset-img" };
  const p = pd.createProduction(null);
  const epId = p.episodes[0].episodeId;
  const sc = pd.addScene(p, epId, "大殿");
  const c = bd.addCharacter(p, "李昭");
  bd.addReferenceAsset(p, c.characterId, "asset-img");
  const st = bd.addCharacterState(p, c.characterId, "重伤");
  bd.setCharacterStateOverrides(p, c.characterId, st.stateId, { referenceAssetIds: ["asset-img"] });
  pd.setSceneAmbience(p, sc.sceneId, "asset-img"); // contrived: same id everywhere
  pd.setEpisodeBgm(p, epId, "asset-img");
  const t = tl.timelineFor(tl.createTimelines(null), epId);
  tl.addClip(t, { trackType: "bgm", assetId: "asset-img" });
  const gens = [{ generationId: "g1", inputAssetIds: ["asset-img"], resultAssetIds: [] }];
  const refs = al.referencesOfAsset({ reg, assetId: "asset-img", production: p, timelines: { [epId]: t }, generations: gens });
  assert.equal(refs.blocking.length, 6); // firstFrame + char ref + state ref + ambience + ep BGM + clip
  assert.equal(refs.provenance, 1); // reported, never blocking (dangling by design)
});

test("storageModel counts standalone firstFrames but DEDUPS aliased ones (review R10)", () => {
  const reg = regFixture();
  // an aliased first frame (assetId already in the video chain) + a standalone
  // one (assetId not in any chain)
  reg.firstFrames = {
    "v1-1": { slot_id: "v1-1", version: 2, url: "/u/vid1_v2.mp4", assetId: "asset-v1b" }, // alias of video v2
    "v9-9": { slot_id: "v9-9", version: 1, url: "/u/orphan.png", assetId: "asset-orphan", storageState: "local" }, // standalone
  };
  const m = storageModel({ reg, referencesOf: () => ({ blocking: [], provenance: 0 }) });
  const ids = m.rows.map((r) => r.assetId);
  assert.equal(ids.filter((x) => x === "asset-v1b").length, 1); // NOT double-counted
  assert.equal(ids.filter((x) => x === "asset-orphan").length, 1); // standalone counted
  assert.equal(m.rows.find((r) => r.assetId === "asset-orphan").domain, "firstFrames");
});

test("removeAssetRecord: chain surgery re-points current; emptied key removed; finals filtered", () => {
  const reg = regFixture();
  assert.equal(al.removeAssetRecord(reg, "asset-v1b"), true); // was current v2
  assert.equal(reg.videos["v1-1"].current, 1); // re-pointed to newest remaining
  assert.equal(al.removeAssetRecord(reg, "asset-v1"), true);
  assert.ok(!("v1-1" in reg.videos)); // empty chain key removed
  const fin = al.addFinal(reg, "/u/final-cut-v1.mp4");
  assert.match(fin.assetId, /^asset-/); // final render = stable Asset
  assert.equal(fin.storageState, "local");
  assert.equal(al.removeAssetRecord(reg, fin.assetId), true);
  assert.deepEqual(reg.finals, []);
  assert.equal(al.removeAssetRecord(reg, "asset-nope"), false);
});

// --- schema v9: migration + validation ---------------------------------------- //

/** A genuine current-version document via the real v1→v9 chain. */
function v9Doc() {
  const res = migrateToCurrent({
    v: 1, project: "demo",
    scriptDoc: { brief: "", versions: [], active: 0, workingText: null },
    nodes: [], edges: [], pan: { x: 0, y: 0 },
  });
  assert.equal(res.status, "ok");
  assert.equal(res.fromVersion, 1);
  return res.doc;
}

test("v8→v9 migration: audio refs on episodes/scenes + empty timelines map; doc validates", () => {
  const doc = v9Doc();
  assert.equal(doc.v, CANVAS_SCHEMA_VERSION);
  assert.deepEqual(doc.timelines, {});
  for (const e of doc.production.episodes) {
    assert.equal(e.bgmAssetId, null);
    for (const s of e.scenes) {
      assert.equal(s.ambienceAssetId, null);
      assert.equal(s.bgmAssetId, null);
    }
  }
  assert.equal(validateCanvasDoc(doc), null);
});

test("v8→v9 migration PRESERVES any value already present under the new field names (review R4)", () => {
  // build a GENUINE v8 doc via the real chain, then forward-write the v9 field
  // names onto it (as a future build might) and add a scene — migration must
  // KEEP those values and only DEFAULT genuinely-absent fields
  const v8 = migrateToCurrent({
    v: 1, project: "demo",
    scriptDoc: { brief: "被囚禁", versions: [{ v: 1, content: "正文", instruction: "", origin: "generated", basedOn: null, status: "done" }], active: 1, workingText: null },
    nodes: [], edges: [], pan: { x: 0, y: 0 },
  }, { current: 8 });
  assert.equal(v8.status, "ok", v8.detail);
  const doc8 = v8.doc;
  const ep = doc8.production.episodes[0];
  ep.bgmAssetId = "asset-KEEP-ep"; // forward-written v9 field on a v8 doc
  ep.scenes.push({ sceneId: "sc-1", title: "场景", shotIds: [], characterRefs: [], locationRef: null, ambienceAssetId: "asset-KEEP-amb", bgmAssetId: "asset-KEEP-sc" });
  doc8.timelines = { [ep.episodeId]: { edited: true, settings: { width: 1280, height: 720, fps: 25, format: "mp4" }, clips: [] } };
  const res = migrateToCurrent(doc8);
  assert.equal(res.status, "ok", res.detail);
  const e = res.doc.production.episodes[0];
  assert.equal(e.bgmAssetId, "asset-KEEP-ep"); // NOT clobbered to null
  assert.equal(e.scenes[0].ambienceAssetId, "asset-KEEP-amb");
  assert.equal(e.scenes[0].bgmAssetId, "asset-KEEP-sc");
  assert.equal(res.doc.timelines[ep.episodeId].edited, true); // pre-existing map kept
});

test("v8→v9 migration COERCES a non-string value under a v9 field name to null (review R9)", () => {
  // v8 ignored these field names; a non-string value there must NOT be carried
  // into v9 (v9 validation would then reject the doc) — coerce to null instead
  const v8 = migrateToCurrent({
    v: 1, project: "demo",
    scriptDoc: { brief: "x", versions: [{ v: 1, content: "c", instruction: "", origin: "generated", basedOn: null, status: "done" }], active: 1, workingText: null },
    nodes: [], edges: [], pan: { x: 0, y: 0 },
  }, { current: 8 });
  const doc8 = v8.doc;
  const ep = doc8.production.episodes[0];
  ep.bgmAssetId = { junk: true }; // a non-string value v8 never validated
  ep.scenes.push({ sceneId: "sc-1", title: "场景", shotIds: [], characterRefs: [], locationRef: null, ambienceAssetId: 42, bgmAssetId: "" });
  const res = migrateToCurrent(doc8);
  assert.equal(res.status, "ok", res.detail); // still loadable — not rejected
  const e = res.doc.production.episodes[0];
  assert.equal(e.bgmAssetId, null); // object coerced
  assert.equal(e.scenes[0].ambienceAssetId, null); // number coerced
  assert.equal(e.scenes[0].bgmAssetId, null); // empty string coerced
  assert.equal(validateCanvasDoc(res.doc), null);
});

test("v9 validation: timelines fail safe (dup clipId / bad trim / bad volume / bad track)", () => {
  const ok = (over) => {
    const doc = v9Doc();
    doc.timelines = { "ep-1": { edited: false, settings: { width: 1280, height: 720, fps: 25, format: "mp4" }, clips: [{
      clipId: "c1", trackType: "video", assetId: "asset-1", shotId: null,
      startTime: 0, trimIn: 0, trimOut: 6, volume: 1, muted: false, fadeIn: 0, fadeOut: 0,
      ...over,
    }] } };
    return validateCanvasDoc(doc);
  };
  assert.equal(ok({}), null);
  assert.notEqual(ok({ trimOut: 0 }), null);
  assert.notEqual(ok({ volume: 3 }), null);
  assert.notEqual(ok({ trackType: "hologram" }), null);
  assert.notEqual(ok({ assetId: "" }), null);
  const doc = v9Doc();
  const SETTINGS = { width: 1280, height: 720, fps: 25, format: "mp4" };
  doc.timelines = { "ep-1": { edited: false, settings: SETTINGS, clips: [
    { clipId: "c1", trackType: "video", assetId: "a", shotId: null, startTime: 0, trimIn: 0, trimOut: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 },
    { clipId: "c1", trackType: "sfx", assetId: "b", shotId: null, startTime: 0, trimIn: 0, trimOut: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 },
  ] } };
  assert.notEqual(validateCanvasDoc(doc), null); // duplicate clipId rejected
  // render settings fail safe: hydration would silently reset a malformed
  // value to defaults, so validation rejects it instead (review R1)
  for (const bad of [{ width: 0 }, { fps: "25" }, { format: "avi" }, { height: null }]) {
    const d2 = v9Doc();
    d2.timelines = { "ep-1": { edited: false, settings: { ...SETTINGS, ...bad }, clips: [] } };
    assert.notEqual(validateCanvasDoc(d2), null, JSON.stringify(bad));
  }
  const doc2 = v9Doc();
  delete doc2.timelines;
  assert.notEqual(validateCanvasDoc(doc2), null); // v9 REQUIRES the map
});

test("v9 accepts the non-AI 'render' Generation type (FFmpeg render provenance)", () => {
  const doc = v9Doc();
  doc.generations = [{
    generationId: "gen-r1", type: "render", targetType: null, targetId: null, provider: "ffmpeg-local",
    status: "success", createdAt: "2026-08-08T00:00:00.000Z",
    parameters: { providerMode: "local", settings: { width: 1280, height: 720, fps: 25, format: "mp4" } },
    promptSnapshot: null, inputAssetIds: ["asset-v1"], referenceAssetIds: [], resultAssetIds: ["asset-f1"],
    error: null,
  }];
  assert.equal(validateCanvasDoc(doc), null);
  doc.generations[0].type = "sorcery";
  assert.notEqual(validateCanvasDoc(doc), null);
});

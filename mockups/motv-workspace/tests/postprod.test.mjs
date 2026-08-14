// TASK-064 Phase 2 + Phase 3 — the domain guards.
//
// Every test here asserts a RULE the modules exist to enforce, not an
// implementation detail. The rules, in one list:
//
//   · a reading is never invented, and a LOCKED one refuses automation
//   · a frame binding records where the frame came from, and upstream drift
//     is REPORTED, never silently re-extracted
//   · a lock cannot be set by automation, and every automated writer consults it
//   · subtitles are generated from real dialogue + real cut timing, and a hand
//     edit survives a regenerate
//   · the rough cut invents nothing, pins versions, and preserves human work
//   · timeline drift is reported with three exits and no silent replacement
//   · the prompt actually CARRIES the interpretation, and says so when it cannot

import test from "node:test";
import assert from "node:assert/strict";

import * as refinterp from "../src/workflow/refinterp.js";
import * as framebind from "../src/workflow/framebind.js";
import * as locksdoc from "../src/workflow/locks.js";
import * as subtitle from "../src/workflow/subtitle.js";
import * as roughcut from "../src/workflow/roughcut.js";
import * as timeline from "../src/workflow/timeline.js";
import * as shotaudio from "../src/workflow/shotaudio.js";
import { DEP } from "../src/workflow/mediadep.js";
import { compileImagePrompt, compileVideoPrompt, compileInterpretationBlock } from "../src/workflow/promptc.js";
import { buildInputSet, generationSeedFrom, MODEL_INPUT_ROLES, INTERPRETATION_ROLES } from "../src/workflow/geninput.js";
import { ACTIONS, validate, allowedAt } from "../src/workflow/actions.js";
import { planApply, applicability } from "../src/workflow/skillapply.js";
import { SKILLS, findSkill, readSkillAnswer } from "../src/workflow/skills.js";
import { ASSET_KINDS, KIND_DOMAIN, INTERPRETATION_KINDS } from "../src/workflow/assetreg.js";
import { validateCanvasDoc, CANVAS_SCHEMA_VERSION } from "../src/services/canvasschema.js";
import * as storydoc from "../src/workflow/storydoc.js";
import * as proddoc from "../src/workflow/proddoc.js";
import * as assetlib from "../src/workflow/assetlib.js";


// The catalog is INSTALLED, not imported: `skills.js` no longer carries
// definitions (TASK-075 §1.4). These read the same packages the backend reads,
// so a test can never be asserting against a third copy of a capability.
import * as _skillsModule from "../src/workflow/skills.js";
import { installBuiltinCatalog } from "./skillcatalog.mjs";

installBuiltinCatalog(_skillsModule);

/* ========================================================================== */
/* 1. Reference interpretation (§21–§22)                                      */
/* ========================================================================== */

test("a reading is stored with its author — nothing is inferred from a file", () => {
  const doc = refinterp.createInterpretations(null);
  // an EMPTY reading is refused: it would make 「已解读」 true of a reference
  // nobody read
  assert.equal(refinterp.addReading(doc, "ref-1", { axes: {} }), 0);
  assert.equal(refinterp.addReading(doc, "ref-1", { axes: { cameraLanguage: "   " } }), 0);
  const v = refinterp.addReading(doc, "ref-1", {
    axes: { cameraLanguage: "缓慢推进", pacing: "两拍一动" },
    origin: "skill", at: "2026-08-12T00:00:00Z", skillRunId: "run-1",
  });
  assert.equal(v, 1);
  const r = refinterp.activeReading(doc, "ref-1");
  assert.deepEqual(r.axes, { cameraLanguage: "缓慢推进", pacing: "两拍一动" });
  assert.equal(r.origin, "skill");
  assert.equal(r.skillRunId, "run-1");
  // an UNANSWERED axis stays absent — 「没说」 and 「说了空」 mean different things
  assert.equal("lighting" in r.axes, false);
});

test("a LOCKED reading refuses automation but not the creator's own edit", () => {
  const doc = refinterp.createInterpretations(null);
  refinterp.addReading(doc, "ref-1", { axes: { movement: "慢" } });
  refinterp.setLocked(doc, "ref-1", true);
  assert.equal(refinterp.addReading(doc, "ref-1", { axes: { movement: "快" }, origin: "skill" }), 0);
  assert.equal(refinterp.activeReading(doc, "ref-1").axes.movement, "慢");
  // a manual edit still lands: a lock protects against Auto, not against you
  assert.equal(refinterp.addReading(doc, "ref-1", { axes: { movement: "快" }, origin: "manual" }), 2);
  assert.equal(refinterp.activeReading(doc, "ref-1").axes.movement, "快");
  assert.equal(refinterp.activeReading(doc, "ref-1").locked, true);
});

test("setActive moves a pointer; no version is ever deleted", () => {
  const doc = refinterp.createInterpretations(null);
  refinterp.addReading(doc, "ref-1", { axes: { movement: "a" } });
  refinterp.addReading(doc, "ref-1", { axes: { movement: "b" } });
  assert.equal(refinterp.setActive(doc, "ref-1", 1), true);
  assert.equal(refinterp.activeReading(doc, "ref-1").axes.movement, "a");
  assert.equal(refinterp.entryOf(doc, "ref-1").versions.length, 2);
  assert.equal(refinterp.setActive(doc, "ref-1", 99), false); // never lands on the newest
});

test("a bound-but-UNREAD reference is listed, not dropped", () => {
  const doc = refinterp.createInterpretations(null);
  refinterp.addReading(doc, "ref-read", { axes: { lighting: "硬光侧逆" } });
  const inputs = refinterp.interpretationInputs(doc, [
    { key: "ref-read", kind: "motion-reference", name: "推进 Ref", version: 2 },
    { key: "ref-cold", kind: "camera-reference", name: "机位 Ref", version: 1 },
    { key: "ref-char", kind: "character-reference", name: "林晚 Ref", version: 3 },
  ], INTERPRETATION_KINDS);
  assert.deepEqual(inputs.map((i) => i.key), ["ref-read", "ref-cold"]); // character ref is not interpreted
  assert.equal(inputs[0].read, true);
  assert.equal(inputs[1].read, false);
  assert.deepEqual(inputs[1].axes, {});
});

test("mergeAxes keeps every contributor — a contradiction stays visible", () => {
  const merged = refinterp.mergeAxes([
    { name: "A", axes: { cameraLanguage: "推进" } },
    { name: "B", axes: { cameraLanguage: "固定" } },
  ]);
  assert.equal(merged.cameraLanguage.length, 2);
  assert.deepEqual(merged.cameraLanguage.map((x) => x.from), ["A", "B"]);
});

test("interpretation survives a save/load round trip, __proto__ key included", () => {
  const doc = refinterp.createInterpretations(null);
  refinterp.addReading(doc, "__proto__", { axes: { pacing: "急" } });
  const out = refinterp.serialize(doc);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "__proto__"), true);
  const back = refinterp.createInterpretations(out);
  assert.equal(refinterp.activeReading(back, "__proto__").axes.pacing, "急");
  assert.equal(Object.prototype.pacing, undefined); // the prototype is untouched
});

/* ========================================================================== */
/* 2. Frame bindings — 上一镜尾帧 → 下一镜首帧 (§7)                              */
/* ========================================================================== */

const EXTRACT = {
  derivedImageAssetId: "asset-frame",
  source: "extracted",
  sourceShotId: "shot-01",
  sourceVideoAssetId: "asset-v3",
  sourceVideoVersion: 3,
  sourceTimecodeMs: 5840,
  pick: "last",
};

test("a binding records every source fact the requirement names", () => {
  const doc = framebind.createFrameBindings(null);
  const b = framebind.bind(doc, "shot-02", "startFrame", EXTRACT);
  assert.equal(b.bindingType, "startFrame");
  assert.equal(b.derivedImageAssetId, "asset-frame");
  assert.equal(b.sourceShotId, "shot-01");
  assert.equal(b.sourceVideoAssetId, "asset-v3");
  assert.equal(b.sourceVideoVersion, 3);
  assert.equal(b.sourceTimecodeMs, 5840);
  assert.equal(b.pick, "last");
});

test("an 'extracted' binding that cannot name its video is DOWNGRADED, not half-kept", () => {
  const doc = framebind.createFrameBindings(null);
  const b = framebind.bind(doc, "shot-02", "startFrame", {
    derivedImageAssetId: "asset-x", source: "extracted", sourceShotId: null, sourceVideoAssetId: null,
  });
  assert.equal(b.source, "upload");
  assert.equal(b.sourceVideoAssetId, null);
});

test("upstream version change is REPORTED, never silently re-extracted", () => {
  const doc = framebind.createFrameBindings(null);
  framebind.bind(doc, "shot-02", "startFrame", EXTRACT);
  const b = framebind.bindingOf(doc, "shot-02", "startFrame");
  // SH01 moved v3 → v4
  assert.equal(framebind.bindingStanding(b, 4), DEP.OUTDATED);
  assert.equal(framebind.bindingStanding(b, 3), DEP.CURRENT);
  assert.equal(framebind.bindingStanding(b, 2), DEP.DIVERGED);
  assert.equal(framebind.bindingStanding(b, null), DEP.UNKNOWN);
  // the binding STILL says v3 — rewriting it would make the record describe
  // media the frame was not cut from
  assert.equal(b.sourceVideoVersion, 3);
  const notice = framebind.frameNotice(b, () => 4);
  assert.deepEqual(notice.resolutions.map((r) => r.action), ["keep", "reextract", "unbind"]);
  assert.equal(notice.sourceVideoVersion, 3);
  assert.equal(notice.activeSourceVersion, 4);
});

test("a LOCKED frame binding refuses a re-bind and an unbind", () => {
  const doc = framebind.createFrameBindings(null);
  framebind.bind(doc, "shot-02", "startFrame", EXTRACT);
  framebind.setLocked(doc, "shot-02", "startFrame", true);
  assert.equal(framebind.bind(doc, "shot-02", "startFrame", { ...EXTRACT, derivedImageAssetId: "other" }), null);
  assert.equal(framebind.unbind(doc, "shot-02", "startFrame"), false);
  // the creator's own forced re-bind lands AND keeps the lock
  const b = framebind.bind(doc, "shot-02", "startFrame", { ...EXTRACT, derivedImageAssetId: "other" }, { force: true });
  assert.equal(b.derivedImageAssetId, "other");
  assert.equal(b.locked, true);
});

test("frame bindings round-trip, and describeBinding names the real source", () => {
  const doc = framebind.createFrameBindings(null);
  framebind.bind(doc, "__proto__", "endFrame", { ...EXTRACT, bindingType: "endFrame" });
  const back = framebind.createFrameBindings(framebind.serialize(doc));
  const b = framebind.bindingOf(back, "__proto__", "endFrame");
  assert.equal(b.sourceVideoVersion, 3);
  assert.match(framebind.describeBinding(b, { shotName: "招牌·雨夜" }), /招牌·雨夜.*v3.*尾帧/);
  assert.equal(framebind.describeBinding({ source: "shot-image" }), "本镜头画面");
});

/* ========================================================================== */
/* 3. Locks (§50)                                                              */
/* ========================================================================== */

test("a lock is a HUMAN statement — an AI origin is refused outright", () => {
  const doc = locksdoc.createLocks(null);
  assert.equal(locksdoc.set(doc, "timelineClip", "clip-1", true, { origin: "ai" }), false);
  assert.equal(locksdoc.isLocked(doc, "timelineClip", "clip-1"), false);
  assert.equal(locksdoc.set(doc, "timelineClip", "clip-1", true), true);
  assert.equal(locksdoc.isLocked(doc, "timelineClip", "clip-1"), true);
  assert.equal(locksdoc.set(doc, "timelineClip", "clip-1", true), false); // no change
  assert.equal(locksdoc.count(doc), 1);
});

test("an unknown scope cannot be created — a lock nothing consults is not protection", () => {
  const doc = locksdoc.createLocks(null);
  assert.equal(locksdoc.set(doc, "nonsense", "x", true), false);
  // …and a persisted one is dropped on load
  const back = locksdoc.createLocks({ nonsense: { x: true }, subtitle: { "cue-1": { at: null, note: "" } } });
  assert.equal(locksdoc.isLocked(back, "subtitle", "cue-1"), true);
  assert.equal(locksdoc.count(back), 1);
});

test("the scope table is the COMPLETE inventory, including the externally-owned flags", () => {
  // three locks live on their own documents; listing them here keeps this table
  // the single inventory rather than the half that happens to live in locks.js
  for (const k of ["prompt", "audioClip", "frameBinding"]) {
    assert.ok(locksdoc.SCOPES[k].owned, `${k} must declare which module owns its flag`);
    assert.ok(!locksdoc.OWN_SCOPES.includes(k));
  }
  assert.deepEqual(locksdoc.OWN_SCOPES, ["reference", "image", "video", "timelineClip", "subtitle"]);
});

/* ========================================================================== */
/* 4. Subtitles (§44–§45)                                                      */
/* ========================================================================== */

const ROWS = [
  { shotId: "s1", startMs: 0, endMs: 6000, dialogue: "你到底想要什么？我等了三年。", speaker: "林晚" },
  { shotId: "s2", startMs: 6000, endMs: 12000, dialogue: "" },                 // no line → no cue
  { shotId: "s3", startMs: 12000, endMs: 12000, dialogue: "有台词但没时长" },      // no window → skipped
];

test("Case A generates cues from REAL dialogue and REAL cut timing", () => {
  const track = subtitle.trackFor(subtitle.createSubtitles(null), "ep1");
  const res = subtitle.generateFromDialogue(track, ROWS, { at: "2026-08-12T00:00:00Z" });
  assert.ok(res.added.length >= 2); // the line splits at 。
  assert.ok(res.added.every((c) => c.shotId === "s1"));
  assert.equal(res.added[0].origin, "dialogue");
  assert.equal(res.added[0].speaker, "林晚");
  assert.equal(res.added[0].startMs, 0);
  assert.equal(res.added[res.added.length - 1].endMs, 6000);
  // a shot with no line contributes NOTHING — nothing is invented
  assert.equal(track.cues.some((c) => c.shotId === "s2"), false);
  // a shot with a line but no window is reported, not placed at zero
  assert.ok(res.skipped.some((s) => s.shotId === "s3"));
  assert.equal(track.version, 1);
  assert.equal(track.generatedFrom, "dialogue");
});

test("a hand-edited or LOCKED cue survives a regenerate", () => {
  const doc = subtitle.createSubtitles(null);
  const track = subtitle.trackFor(doc, "ep1");
  subtitle.generateFromDialogue(track, ROWS, {});
  const first = track.cues[0];
  subtitle.updateCue(track, first.cueId, { text: "我改过了" }, { at: "x" });
  assert.equal(subtitle.findCue(track, first.cueId).origin, "manual");
  const res = subtitle.generateFromDialogue(track, ROWS, {});
  assert.equal(subtitle.findCue(track, first.cueId).text, "我改过了");
  assert.ok(res.skipped.some((s) => s.shotId === "s1"));
  // …and a LOCKED cue is refused even by the ordinary edit path
  const locked = track.cues[track.cues.length - 1];
  assert.equal(
    subtitle.updateCue(track, locked.cueId, { text: "no" }, { isLocked: (id) => id === locked.cueId }),
    false,
  );
});

test("split refuses to make an unreadable cue; merge joins text and widens the window", () => {
  const track = subtitle.trackFor(subtitle.createSubtitles(null), "ep1");
  const a = subtitle.addCue(track, { startMs: 0, endMs: 2000, text: "上半句" });
  assert.equal(subtitle.splitCue(track, a.cueId, 100), false);  // first half too short
  assert.equal(subtitle.splitCue(track, a.cueId, 1900), false); // second half too short
  assert.equal(subtitle.splitCue(track, a.cueId, 1000, { splitAtChar: 2 }), true);
  assert.equal(track.cues.length, 2);
  assert.equal(track.cues[0].text, "上半");
  assert.equal(track.cues[1].text, "句");
  assert.equal(subtitle.mergeCue(track, track.cues[0].cueId, {}), true);
  assert.equal(track.cues.length, 1);
  assert.equal(track.cues[0].text, "上半句");
  assert.equal(track.cues[0].endMs, 2000);
});

test("a short cut window yields FEWER cues, never a dropped half-line", () => {
  // A 900 ms window can hold two readable cues, not four. Splitting anyway
  // produced sub-MIN_CUE_MS flashes and then silently discarded the pieces that
  // no longer fitted — the creator's own line, gone, with nothing said.
  const track = subtitle.trackFor(subtitle.createSubtitles(null), "ep1");
  const line = "第一句。第二句。第三句。第四句。";
  const res = subtitle.generateFromDialogue(track, [
    { shotId: "s1", startMs: 0, endMs: 900, dialogue: line },
  ], {});
  assert.ok(res.added.length >= 1);
  assert.ok(res.added.length <= 2, `900ms cannot hold ${res.added.length} readable cues`);
  // EVERY character survives, in order
  assert.equal(res.added.map((c) => c.text).join(""), line);
  for (const c of res.added) {
    assert.ok(c.endMs - c.startMs >= subtitle.MIN_CUE_MS, "no cue is too short to read");
  }
  assert.equal(res.added[res.added.length - 1].endMs, 900, "the last cue ends with the shot");
});

test("overlaps are REPORTED, never auto-nudged", () => {
  const track = subtitle.trackFor(subtitle.createSubtitles(null), "ep1");
  subtitle.addCue(track, { startMs: 0, endMs: 3000, text: "a" });
  subtitle.addCue(track, { startMs: 2000, endMs: 5000, text: "b" });
  assert.equal(subtitle.overlaps(track).length, 1);
  assert.equal(track.cues[1].startMs, 2000); // untouched
});

test("no fake ASR: an unavailable adapter answers with the real reason", () => {
  assert.equal(subtitle.adapterUnavailable("dialogue").ok, true);
  const asr = subtitle.adapterUnavailable("asr");
  assert.equal(asr.ok, false);
  assert.equal(asr.unavailable, true);
  assert.match(asr.error, /没有接入/);
  assert.equal(subtitle.adapterUnavailable("alignment").ok, false);
});

test("SRT export is real, indexed and speaker-prefixed only where a speaker exists", () => {
  const track = subtitle.trackFor(subtitle.createSubtitles(null), "ep1");
  subtitle.addCue(track, { startMs: 1500, endMs: 3250, text: "第一句", speaker: "林晚" });
  subtitle.addCue(track, { startMs: 3300, endMs: 4000, text: "第二句" });
  const srt = subtitle.toSRT(track);
  assert.match(srt, /^1\n00:00:01,500 --> 00:00:03,250\n林晚：第一句/);
  assert.match(srt, /2\n00:00:03,300 --> 00:00:04,000\n第二句/);
});

/* ========================================================================== */
/* 5. Automatic Rough Cut (§41–§43)                                            */
/* ========================================================================== */

const CUT_ROWS = [
  {
    shotId: "s1", duration: 6, dialogueText: "有台词",
    video: { assetId: "v1", version: 2 }, dialogue: { assetId: "d1", version: 1 },
    ambience: { assetId: "amb", version: 1 }, bgm: { assetId: "bgm", version: 1 },
  },
  {
    shotId: "s2", duration: 10,
    video: { assetId: "v2", version: 1 },
    ambience: { assetId: "amb", version: 1 }, bgm: { assetId: "bgm", version: 1 },
  },
  // no footage at all: it takes no time and is reported
  { shotId: "s3", duration: 6, video: null, dialogue: null },
  // HAS footage and HAS a line, but the take is missing — the one case worth
  // reporting on the dialogue track (a silent shot is not missing anything)
  { shotId: "s4", duration: 6, dialogueText: "还没配音", video: { assetId: "v4", version: 1 }, dialogue: null },
];

test("the rough cut invents nothing, pins versions, and stays gapless", () => {
  const plan = roughcut.planRoughCut(CUT_ROWS);
  const vids = plan.clips.filter((c) => c.trackType === "video");
  assert.deepEqual(vids.map((c) => c.assetId), ["v1", "v2", "v4"]);
  assert.deepEqual(vids.map((c) => c.assetVersion), [2, 1, 1]);
  // GAPLESS: the shot with no footage takes no time, so nothing after it shifts
  // against a picture that is not there
  assert.deepEqual(vids.map((c) => c.startTime), [0, 6, 16]);
  assert.equal(plan.duration, 22);
  // …and its absence is REPORTED
  assert.ok(plan.skipped.some((s) => s.shotId === "s3" && s.trackType === "video"));
  // a shot with a LINE but no take is reported; a silent shot files no complaint
  assert.ok(plan.skipped.some((s) => s.shotId === "s4" && s.trackType === "dialogue"));
  assert.equal(plan.skipped.some((s) => s.shotId === "s2" && s.trackType === "dialogue"), false);
  // one bed for a contiguous span, not one per shot
  const beds = plan.clips.filter((c) => c.trackType === "ambience");
  assert.equal(beds.length, 1);
  assert.equal(beds[0].trimOut - beds[0].trimIn, 16, "the bed covers the shots that actually carry it");
  // BGM ducks under dialogue as a NUMBER, not a promise
  assert.equal(plan.clips.find((c) => c.trackType === "bgm").volume, roughcut.AUTO_GAIN.bgm);
  assert.equal(
    roughcut.planRoughCut(CUT_ROWS.map((r) => ({ ...r, dialogue: null })), { hasDialogueAnywhere: false })
      .clips.find((c) => c.trackType === "bgm").volume,
    0.45,
  );
});

test("re-running the rough cut preserves LOCKED and hand-placed work", () => {
  const t = timeline.timelineFor(timeline.createTimelines(null), "ep1");
  roughcut.applyRoughCut(t, roughcut.planRoughCut(CUT_ROWS), {});
  const s1 = timeline.clipsOf(t, "video").find((c) => c.shotId === "s1");
  const s2 = timeline.clipsOf(t, "video").find((c) => c.shotId === "s2");
  assert.equal(s1.origin, "auto");
  // the creator locks SH01's picture and hand-trims SH02
  const locked = new Set([s1.clipId]);
  s2.origin = "manual";
  s2.trimOut = 4;
  const res = roughcut.applyRoughCut(t, roughcut.planRoughCut(CUT_ROWS), {
    isLocked: (id) => locked.has(id),
  });
  const after1 = timeline.findClip(t, s1.clipId);
  const after2 = timeline.findClip(t, s2.clipId);
  assert.ok(after1, "a locked clip is never removed by a rebuild");
  assert.ok(after2, "a hand-placed clip is never removed by a rebuild");
  assert.equal(after2.trimOut, 4, "the creator's trim survives");
  // both shots are reported as skipped rather than silently left out
  assert.ok(res.skipped.some((s) => s.shotId === "s1"));
  assert.ok(res.skipped.some((s) => s.shotId === "s2"));
  // and the whole stack of a protected shot stays: its dialogue is not re-placed
  // under a picture the pass is not allowed to move
  assert.ok(timeline.liveClips(t).some((c) => c.shotId === "s1" && c.trackType === "dialogue"));
  assert.equal(t.roughCutVersion, 2);
});

test("a rebuild keeps CANONICAL shot order even when a clip is protected", () => {
  // `relayout` derives start times from ARRAY ORDER. Survivors keep their slots
  // while newly placed clips are appended, so with any protected clip the kept
  // SH02 stayed ahead of a rebuilt SH01 — 重新初剪 silently reordered the episode.
  const t = timeline.timelineFor(timeline.createTimelines(null), "ep1");
  roughcut.applyRoughCut(t, roughcut.planRoughCut(CUT_ROWS), {});
  const s2 = timeline.clipsOf(t, "video").find((c) => c.shotId === "s2");
  s2.origin = "manual"; // the creator hand-placed SH02
  roughcut.applyRoughCut(t, roughcut.planRoughCut(CUT_ROWS), {});
  assert.deepEqual(
    timeline.clipsOf(t, "video").map((c) => c.shotId),
    ["s1", "s2", "s4"],
    "canonical order survives the rebuild",
  );
  assert.deepEqual(timeline.clipsOf(t, "video").map((c) => c.startTime), [0, 6, 16]);
});

test("canBuild refuses an empty cut rather than producing a blank timeline", () => {
  assert.equal(roughcut.canBuild([]), false);
  assert.equal(roughcut.canBuild([{ shotId: "s", video: null }]), false);
  assert.equal(roughcut.canBuild(CUT_ROWS), true);
});

/* ========================================================================== */
/* 6. Episode timeline: pinned versions, remove/restore, transitions (§46/§48) */
/* ========================================================================== */

function cutFixture() {
  const t = timeline.timelineFor(timeline.createTimelines(null), "ep1");
  roughcut.applyRoughCut(t, roughcut.planRoughCut(CUT_ROWS), {});
  return t;
}

test("a clip PINS a version, and drift is reported with three exits", () => {
  const t = cutFixture();
  const clip = timeline.clipsOf(t, "video").find((c) => c.shotId === "s1");
  assert.equal(clip.assetVersion, 2);
  const drift = timeline.driftedClips(t, (shotId, track) =>
    (shotId === "s1" && track === "video" ? { assetId: "v1b", version: 3 } : null));
  assert.equal(drift.length, 1);
  assert.equal(drift[0].state, DEP.OUTDATED);
  assert.equal(drift[0].pinnedVersion, 2);
  assert.equal(drift[0].activeVersion, 3);
  assert.deepEqual(drift[0].resolutions.map((r) => r.action), ["keep", "replace", "compare"]);
  // NOTHING was replaced by asking
  assert.equal(timeline.findClip(t, clip.clipId).assetId, "v1");
  // a clip whose pin is unrecorded is NOT drift — it is an unknown, and asking
  // the creator to fix a fact is not the same as asking them to fix a problem
  clip.assetVersion = null;
  assert.equal(timeline.clipStanding(clip, 3), DEP.UNKNOWN);
});

test("replacing an asset RE-PINS it — a new asset never keeps the old version number", () => {
  const t = cutFixture();
  const clip = timeline.clipsOf(t, "video").find((c) => c.shotId === "s1");
  timeline.replaceClipAsset(t, clip.clipId, "v1b", 3);
  assert.equal(timeline.findClip(t, clip.clipId).assetVersion, 3);
  timeline.replaceClipAsset(t, clip.clipId, "v1c");
  assert.equal(timeline.findClip(t, clip.clipId).assetVersion, null); // unknown, not stale
});

test("remove is REVERSIBLE and takes the shot's anchored audio with it", () => {
  const t = cutFixture();
  const clip = timeline.clipsOf(t, "video").find((c) => c.shotId === "s1");
  // the PICTURE's length is what a removal shortens. The scene's ambience bed is
  // project-level and keeps its own placement — non-destructive by design; the
  // render caps the output to the picture, and a rebuild re-lays the beds.
  const pictureLen = () => timeline.clipsOf(t, "video").reduce((n, c) => n + (c.trimOut - c.trimIn), 0);
  const before = pictureLen();
  timeline.setClipRemoved(t, clip.clipId, true);
  assert.equal(timeline.findClip(t, clip.clipId).removed, true);
  assert.ok(pictureLen() < before, "a removed clip contributes no picture time");
  assert.equal(timeline.clipsOf(t, "dialogue").some((c) => c.shotId === "s1"), false);
  // the record is KEPT, so restore puts back what the creator had
  timeline.setClipRemoved(t, clip.clipId, false);
  assert.equal(timeline.findClip(t, clip.clipId).removed, false);
  assert.equal(timeline.clipsOf(t, "dialogue").some((c) => c.shotId === "s1"), true);
  assert.equal(pictureLen(), before);
});

test("restoring a shot does NOT undo a separate decision about one audio clip", () => {
  const t = cutFixture();
  const vid = timeline.clipsOf(t, "video").find((c) => c.shotId === "s1");
  const dia = timeline.clipsOf(t, "dialogue").find((c) => c.shotId === "s1");
  timeline.setClipRemoved(t, dia.clipId, true);   // the creator drops the line
  timeline.setClipRemoved(t, vid.clipId, true);   // …then drops the picture
  timeline.setClipRemoved(t, vid.clipId, false);  // …and brings the picture back
  assert.equal(timeline.findClip(t, dia.clipId).removed, true, "the line stays out");
});

test("a rebuild does NOT put back a clip the creator removed", () => {
  // 「这一镜不要了」 is a human decision even on a clip the arranger placed.
  // Treating a removed auto clip as ordinary auto work let the next 重新初剪
  // discard it and re-add the same shot from the plan — silently restoring a
  // shot that had been taken out of the cut.
  const t = cutFixture();
  const clip = timeline.clipsOf(t, "video").find((c) => c.shotId === "s1");
  timeline.setClipRemoved(t, clip.clipId, true);
  const res = roughcut.applyRoughCut(t, roughcut.planRoughCut(CUT_ROWS), {});
  const after = timeline.findClip(t, clip.clipId);
  assert.ok(after, "the removed clip is still there");
  assert.equal(after.removed, true, "and it is still removed");
  assert.equal(
    timeline.clipsOf(t, "video").filter((c) => c.shotId === "s1").length, 0,
    "the plan did not re-add SH01's picture behind the creator's back",
  );
  assert.ok(res.skipped.some((s) => s.shotId === "s1"), "and the skip is reported");
});

test("a LOCKED timeline clip refuses removal", () => {
  const t = cutFixture();
  const clip = timeline.clipsOf(t, "video")[0];
  assert.equal(timeline.setClipRemoved(t, clip.clipId, true, { isLocked: () => true }), false);
  assert.equal(timeline.findClip(t, clip.clipId).removed, false);
});

test("reorder by INDEX moves only the video order; transitions are bounded", () => {
  const t = cutFixture();
  const ids = timeline.clipsOf(t, "video").map((c) => c.clipId);
  assert.equal(timeline.moveVideoClipTo(t, ids[1], 0), true);
  assert.deepEqual(timeline.clipsOf(t, "video").map((c) => c.clipId), [ids[1], ids[0], ids[2]]);
  // start times are RE-DERIVED from the new order: 10s shot, then 6s, then 6s
  assert.deepEqual(timeline.clipsOf(t, "video").map((c) => c.startTime), [0, 10, 16]);
  assert.equal(timeline.setTransition(t, ids[0], "dissolve", 99999), true);
  assert.equal(timeline.findClip(t, ids[0]).transitionMs, timeline.MAX_TRANSITION_MS);
  assert.equal(timeline.setTransition(t, ids[0], "wipe", 400), false);
  // a CUT carries no duration — 「没设过」 and 「明确硬切」 play the same
  timeline.setTransition(t, ids[0], "cut", 400);
  assert.equal(timeline.findClip(t, ids[0]).transitionMs, 0);
});

test("foley and vo reach the episode cut as THEMSELVES", () => {
  assert.ok(timeline.TRACKS.includes("foley"));
  assert.ok(timeline.TRACKS.includes("vo"));
  const clips = timeline.buildFromRows([
    { shotId: "s1", duration: 6, videoAssetId: "v", foleyAssetId: "f", voAssetId: "n" },
  ]);
  assert.equal(clips.filter((c) => c.trackType === "foley").length, 1);
  assert.equal(clips.filter((c) => c.trackType === "vo").length, 1);
});

test("EVERY track's version is pinned — not just video and dialogue", () => {
  // A clip built with no pin reports UNKNOWN standing forever, so drift on that
  // track can never be seen and the Final Render says 「版本未记录」 for a take the
  // registry knows perfectly well. All seven, including the beds.
  const clips = timeline.buildFromRows([{
    shotId: "s1", duration: 6,
    videoAssetId: "v", videoAssetVersion: 3,
    dialogueAssetId: "d", dialogueAssetVersion: 2,
    sfxAssetId: "x", sfxAssetVersion: 5,
    foleyAssetId: "f", foleyAssetVersion: 4,
    voAssetId: "n", voAssetVersion: 6,
    ambienceAssetId: "a", ambienceAssetVersion: 7,
    bgmAssetId: "b", bgmAssetVersion: 8,
  }]);
  const byTrack = Object.fromEntries(clips.map((c) => [c.trackType, c.assetVersion]));
  assert.deepEqual(byTrack, {
    video: 3, dialogue: 2, sfx: 5, foley: 4, vo: 6, ambience: 7, bgm: 8,
  });
});

test("a timeline carrying the new fields still validates as a canvas document", () => {
  const t = cutFixture();
  // Built from the REAL empty documents rather than a hand-written shape: this
  // test is about the TIMELINE rules, and a fixture that drifted from the other
  // documents' schemas would fail for reasons that have nothing to do with them.
  const doc = {
    v: CANVAS_SCHEMA_VERSION,
    nodes: [], edges: [],
    scripts: {},
    story: storydoc.serialize(storydoc.createStory(null)),
    production: proddoc.serialize(proddoc.createProduction(null)),
    assets: assetlib.createRegistry(null),
    generations: [], skillRuns: [],
    timelines: { ep1: JSON.parse(JSON.stringify(t)) },
  };
  assert.equal(validateCanvasDoc(doc), null);
  // …and a bad one is still refused
  doc.timelines.ep1.clips[0].origin = "sneaky";
  assert.match(validateCanvasDoc(doc), /origin is invalid/);
});

/* ========================================================================== */
/* 7. Prompt compilation actually CARRIES the interpretation (§21–§23)         */
/* ========================================================================== */

const DIRECTING = [
  { key: "ref-m", kind: "motion-reference", name: "推进 Ref", version: 2 },
  { key: "ref-c", kind: "camera-reference", name: "机位 Ref", version: 1 },
];

test("a READ directing reference reaches the prompt as words", () => {
  const doc = refinterp.createInterpretations(null);
  refinterp.addReading(doc, "ref-m", { axes: { movement: "由静到动，两拍一推" } });
  refinterp.addReading(doc, "ref-c", { axes: { cameraLanguage: "低机位仰拍", composition: "对角线" } });
  const interpretation = refinterp.interpretationInputs(doc, DIRECTING, INTERPRETATION_KINDS);
  const { text, missing } = compileVideoPrompt({
    shot: { action: "抬头", cameraMotion: "推", environmentMotion: "雨丝斜落", duration_seconds: 6 },
    hasImage: true,
    references: DIRECTING,
    interpretation,
  });
  assert.ok(text.includes("【创作参考解读"));
  assert.ok(text.includes("运镜：低机位仰拍（参考：机位 Ref v1）"));
  assert.ok(text.includes("运动：由静到动，两拍一推（参考：推进 Ref v2）"));
  assert.ok(text.includes("【环境运动】雨丝斜落"), "environment motion is its own input");
  assert.deepEqual(missing, []);
});

test("an UNREAD directing reference is a reported GAP, never silently dropped", () => {
  const interpretation = refinterp.interpretationInputs(
    refinterp.createInterpretations(null), DIRECTING, INTERPRETATION_KINDS,
  );
  const { text, missing } = compileVideoPrompt({
    shot: { action: "a", cameraMotion: "b", duration_seconds: 6 },
    hasImage: true, references: DIRECTING, interpretation,
  });
  assert.equal(text.includes("【创作参考解读"), false, "an empty heading would promise an intent it cannot state");
  assert.equal(missing.length, 2);
  assert.ok(missing[0].includes("推进 Ref v2"));
  assert.ok(missing[0].includes("参考解读"));
});

test("compileInterpretationBlock states nothing when nothing was read", () => {
  assert.equal(compileInterpretationBlock([]), "");
  assert.equal(compileInterpretationBlock([{ read: false, axes: {} }]), "");
});

test("the image prompt names its model-input references as attachments", () => {
  const { text } = compileImagePrompt({
    shot: { description: "雨夜招牌" },
    characters: [{ name: "林晚" }],
    location: { name: "巷口" },
    references: [
      { key: "r1", kind: "character-reference", name: "林晚 Ref", version: 3 },
      { key: "r2", kind: "style-reference", name: "冷调 Ref", version: 1 },
      { key: "r3", kind: "prop-reference", name: "伞 Ref", version: 1 },
    ],
  });
  assert.ok(text.includes("【人物参考】林晚 Ref v3（作为参考图一并提供，保持一致）"));
  assert.ok(text.includes("【风格参考】冷调 Ref v1"));
  assert.ok(text.includes("【道具参考】伞 Ref v1"));
});

test("the video prompt NAMES which picture is frame 1", () => {
  const { text } = compileVideoPrompt({
    shot: { action: "a", cameraMotion: "b", duration_seconds: 6 },
    startFrame: { name: "已绑定的首帧", from: "招牌·雨夜 视频 v3 · 尾帧" },
    endFrame: { name: "已绑定的尾帧", from: "上传的帧" },
  });
  assert.ok(text.includes("来源：招牌·雨夜 视频 v3 · 尾帧"));
  assert.ok(text.includes("【尾帧】"));
});

/* ========================================================================== */
/* 8. Generation Input Set (§4)                                                */
/* ========================================================================== */

test("the input set groups by USE, derived from ROLE_USE rather than listed twice", () => {
  const set = buildInputSet({
    shot: { title: "SH01" },
    context: { shotId: "s1" },
    references: [
      { key: "r1", kind: "character-reference", name: "林晚", version: 1, assetId: "a1" },
      { key: "r2", kind: "motion-reference", name: "推进", version: 1, assetId: "a2" },
    ],
    interpretation: [{ key: "r2", kind: "motion-reference", name: "推进", version: 1, assetId: "a2", read: true, readingVersion: 4, readingOrigin: "skill", axes: { movement: "推" } }],
    prompt: "P",
  });
  assert.deepEqual(set.modelInputs.map((r) => r.key), ["r1"]);
  assert.deepEqual(set.interpretationInputs.map((r) => r.key), ["r2"]);
  assert.equal(set.interpretationUnread.length, 0);
  // the two lists partition the eight roles — no role in both, none in neither
  assert.equal(MODEL_INPUT_ROLES.length + INTERPRETATION_ROLES.length, 8);
  assert.equal(MODEL_INPUT_ROLES.some((r) => INTERPRETATION_ROLES.includes(r)), false);
  const seed = generationSeedFrom(set, { type: "video" });
  // BOTH kinds of reference are recorded as inputs — the motion reference's words
  // went into the prompt, so saying it had no part would be false
  assert.deepEqual(seed.referenceAssetIds.sort(), ["a1", "a2"]);
  // …and WHICH READING drove it, which an assetId alone cannot say
  assert.deepEqual(seed.parameters.interpretedReferences, [
    { referenceKey: "r2", kind: "motion-reference", readingVersion: 4, readingOrigin: "skill" },
  ]);
});

test("an UNREAD interpretation reference contributes no reading to the record", () => {
  const set = buildInputSet({
    context: { shotId: "s1" },
    references: [{ key: "r2", kind: "motion-reference", name: "推进", version: 1, assetId: "a2" }],
    interpretation: [{ key: "r2", kind: "motion-reference", name: "推进", version: 1, assetId: "a2", read: false, axes: {} }],
    prompt: "P",
  });
  assert.equal(set.interpretationUnread.length, 1);
  assert.equal(generationSeedFrom(set, { type: "video" }).parameters.interpretedReferences, undefined);
});

/* ========================================================================== */
/* 9. The Action Layer + the post-production Skills (§52 / §55)                */
/* ========================================================================== */

test("every Phase 2 / Phase 3 mutation has a NAME in the action vocabulary", () => {
  for (const name of [
    "updateInterpretation", "extractFrame", "bindStartFrame", "unbindFrame",
    "moveAudioClip", "trimAudioClip", "setGain", "setFade", "setAudioMuted",
    "autoArrangeShotAudio", "mixShotAudio",
    "replaceTimelineAsset", "trimTimelineClip", "moveTimelineClip",
    "removeTimelineClip", "restoreTimelineClip", "setTimelineVolume", "setTransition",
    "updateSubtitle", "buildSubtitles", "buildRoughCut", "renderEpisode",
    "lockItem", "unlockItem",
  ]) {
    assert.ok(ACTIONS[name], `${name} is missing from the action vocabulary`);
  }
  // shape validation still names the missing argument
  assert.match(validate({ action: "setTransition", clipId: "c" }), /kind、durationMs/);
  assert.equal(validate({ action: "setTransition", clipId: "c", kind: "cut", durationMs: 0 }), null);
});

test("at the level in force, an AI origin may not perform any post mutation", () => {
  for (const name of ["buildRoughCut", "setGain", "updateSubtitle", "renderEpisode", "lockItem"]) {
    assert.equal(allowedAt(name, { origin: "ai" }).ok, false, `${name} must need a human`);
  }
  assert.equal(allowedAt("prepareGeneration", { origin: "ai" }).ok, true); // read-only
});

test("the post-production skills have REAL write-back paths, expressed as actions", () => {
  for (const id of ["reference-interpreter", "editing-director", "sound-designer", "subtitle-reviewer"]) {
    assert.ok(findSkill(id), `${id} must exist in the catalog`);
    assert.equal(applicability(id).can, true, `${id} must have a write-back target`);
  }
  // …and Continuity Reviewer is still honestly read-only
  assert.equal(applicability("continuity-reviewer").can, false);

  const r = planApply("reference-interpreter", {
    readings: [
      { referenceKey: "ref-1", cameraLanguage: "低机位", movement: "" },
      { referenceKey: "", cameraLanguage: "无处可写" },   // unaddressable → dropped
      { referenceKey: "ref-2" },                          // no axis → dropped
    ],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.actions, [{ action: "updateInterpretation", referenceKey: "ref-1", axes: { cameraLanguage: "低机位" } }]);

  // A version swap is bounded by the alternatives the RUN recorded seeing
  // (TASK-072 §1.9 缺陷 8), so the scope carries them — exactly as
  // `applyProposal` passes them from `run.contextTrace`.
  const edits = {
    edits: [
      { clipId: "c1", reason: "太长", trimInMs: 0, trimOutMs: 4300 },
      { clipId: "c2", reason: "换版本", replaceWithAssetId: "asset-9" },
      { clipId: "c3", reason: "多余", remove: true, trimInMs: 0, trimOutMs: 1000 },
      { clipId: "", reason: "无处可写" },
    ],
  };
  const e = planApply("editing-director", edits, {
    timelineAlternatives: { c2: ["asset-9", "asset-10"] },
  });
  assert.deepEqual(e.actions.map((a) => a.action),
    ["trimTimelineClip", "replaceTimelineAsset", "removeTimelineClip"]);
  assert.equal(e.actions[0].outMs, 4300);

  // FAIL CLOSED with no recorded candidate set: a run whose permission cannot be
  // checked is refused, not trusted. Without this the dispatcher's only remaining
  // guard is 「资产存在且轨道对」, which happily accepts any video in the project.
  const noTrace = planApply("editing-director", edits, {});
  assert.equal(noTrace.ok, false);
  assert.match(noTrace.error, /没有记录它当时看到的可替换版本/);

  // An OFF-CANDIDATE swap is dropped and REPORTED; the other edits still apply.
  const offCand = planApply("editing-director", edits, {
    timelineAlternatives: { c2: ["asset-77"] },
  });
  assert.equal(offCand.ok, true);
  assert.deepEqual(offCand.actions.map((a) => a.action),
    ["trimTimelineClip", "removeTimelineClip"]);
  assert.match(offCand.dropped, /不在这次运行看到的候选里/);

  // Edits that name NO asset need no candidate set at all — trim / order /
  // transition / remove cannot point at foreign media.
  const noSwaps = planApply("editing-director", {
    edits: [{ clipId: "c1", reason: "太长", trimInMs: 0, trimOutMs: 4300 }],
  }, {});
  assert.equal(noSwaps.ok, true);
  assert.deepEqual(noSwaps.actions.map((a) => a.action), ["trimTimelineClip"]);

  const s = planApply("sound-designer", {
    adjustments: [
      { layer: "episode", clipId: "c1", reason: "压低", gainDb: -4 },
      { layer: "shot", clipId: "a1", reason: "对位", offsetMs: 80 },
      { layer: "nowhere", clipId: "x", reason: "未指明层", gainDb: -2 }, // dropped
    ],
  });
  assert.deepEqual(s.actions.map((a) => a.action), ["setTimelineVolume", "moveAudioClip"]);
  assert.equal(s.actions[0].gainDb, -4, "gain travels as dB, always");
  assert.equal(s.actions[1].timing.offsetDeltaMs, 80, "an offset is a shift, not a result");

  const sub = planApply("subtitle-reviewer", {
    fixes: [
      { cueId: "q1", reason: "断行", text: "更短的一句" },
      { cueId: "q2", reason: "合并", mergeWithNext: true },
      { cueId: "q3", reason: "什么都没改" },
    ],
  });
  assert.deepEqual(sub.actions.map((a) => a.cueId), ["q1", "q2"]);
});

test("a post skill's output contract is enforced — a clip-less edit is refused", () => {
  const skill = findSkill("editing-director");
  const bad = readSkillAnswer(skill, JSON.stringify({ edits: [{ reason: "没有 clipId" }] }));
  assert.equal(bad.ok, false);
  const good = readSkillAnswer(skill, JSON.stringify({ edits: [{ clipId: "c1", reason: "太长" }] }));
  assert.equal(good.ok, true);
  // an empty list is a VALID answer — 「都很好」 must be expressible
  assert.equal(readSkillAnswer(skill, JSON.stringify({ edits: [] })).ok, true);
});

test("post skills read the post context, and it is a declared input vocabulary", () => {
  for (const [id, key] of [["editing-director", "timeline"], ["sound-designer", "shotAudio"], ["subtitle-reviewer", "subtitles"]]) {
    assert.ok(findSkill(id).inputs.includes(key), `${id} must require ${key}`);
  }
  // no skill hard-wires an executor (the same guard the catalog test applies,
  // re-checked for the four new ones)
  for (const s of SKILLS) {
    assert.equal(JSON.stringify(s).includes("claude-code"), false);
  }
});

/* ========================================================================== */
/* 10. The derived-frame asset kind                                            */
/* ========================================================================== */

test("a derived frame is its OWN kind, in the images domain", () => {
  assert.ok(ASSET_KINDS.includes("derived-frame"));
  assert.equal(KIND_DOMAIN["derived-frame"], "images");
  // it is NOT a shot image: filing it as one would make 「这个镜头有几版画面」
  // count frames nobody designed
  assert.notEqual("derived-frame", "shot-image");
});

/**
 * REGRESSION — the Connected run found this one, and it was the worst kind.
 *
 * Binding an extracted tail frame as the NEXT shot's start frame writes
 * `assets.firstFrames[targetSlot]` pointing at an image that lives on its own
 * `frame-<uuid>` chain. The validator required a first frame to reference an
 * image at the SAME slot, so the document became INVALID — and because a failed
 * validation fails the whole canvas, the project reloaded EMPTY with autosave
 * disabled. The feature worked, and using it lost the session's view of the
 * project until the next reload was diagnosed.
 *
 * The identity checks the rule exists for are all still enforced below.
 */
test("binding an extracted frame keeps the canvas LOADABLE", () => {
  const LINKS = {
    episodeId: null, sceneId: null, shotId: null,
    characterId: null, locationId: null, generationId: null,
  };
  const frameAsset = {
    assetId: "asset-frame", version: 1, url: "/api/uploads/p/assets-frame-x_v1.png",
    digest: null, origin: "upload", storageState: "local", kind: "derived-frame",
    displayName: null, originalFilename: null, links: LINKS, tags: [], reusable: false, needsReview: false,
  };
  const shotImage = {
    assetId: "asset-img", version: 1, url: "/api/uploads/p/assets-v1-2_v1.png",
    digest: null, origin: "upload", storageState: "local", kind: "shot-image",
    displayName: null, originalFilename: null, links: LINKS, tags: [], reusable: false, needsReview: false,
  };
  const doc = () => ({
    v: CANVAS_SCHEMA_VERSION, nodes: [], edges: [], scripts: {},
    story: storydoc.serialize(storydoc.createStory(null)),
    production: proddoc.serialize(proddoc.createProduction(null)),
    generations: [], skillRuns: [], timelines: {},
    assets: {
      images: {
        "frame-x": { current: 1, history: [{ ...frameAsset, slot_id: "frame-x" }] },
        "v1-2": { current: 1, history: [{ ...shotImage, slot_id: "v1-2" }] },
      },
      videos: {}, audio: {}, finals: [], displaced: [], unresolvedPaid: [],
      // the binding: SH02's slot points at the frame cut from SH01's video
      firstFrames: { "v1-2": { ...frameAsset, slot_id: "v1-2" } },
    },
  });
  assert.equal(validateCanvasDoc(doc()), null);

  // …and the rule it relaxes is still enforced. A `shot-image` from ANOTHER slot
  // may NOT be aliased in: that is the identity-gluing this check exists for.
  const wrong = doc();
  wrong.assets.firstFrames["v1-2"] = { ...shotImage, slot_id: "v1-2", assetId: "asset-img" };
  wrong.assets.images["v1-3"] = { current: 1, history: [{ ...shotImage, assetId: "asset-img2", slot_id: "v1-3" }] };
  wrong.assets.firstFrames["v1-2"] = { ...shotImage, assetId: "asset-img2", slot_id: "v1-2" };
  assert.match(validateCanvasDoc(wrong), /does not match its slot\/media/);

  // …and a derived frame whose BYTES disagree with the asset it names is still
  // refused: only the same-slot requirement is waived, never the media checks.
  const tampered = doc();
  tampered.assets.firstFrames["v1-2"] = { ...frameAsset, slot_id: "v1-2", url: "/api/uploads/p/other_v1.png" };
  assert.match(validateCanvasDoc(tampered), /does not match its slot\/media/);
});

test("the legacy auto-sync marks its clips AUTO, so a rough cut may replace them", () => {
  // A mirrored clip is machine-built. Hydrating it as `manual` made the Rough Cut
  // treat an untouched episode as entirely hand-placed and refuse to build.
  const t = timeline.timelineFor(timeline.createTimelines(null), "ep1");
  timeline.syncFromRows(t, [{ shotId: "s1", duration: 6, videoAssetId: "v1", videoAssetVersion: 2 }]);
  const c = timeline.clipsOf(t, "video")[0];
  assert.equal(c.origin, "auto");
  assert.equal(c.assetVersion, 2, "the mirror pins the version it mirrored");
  // …and every sanitizer-supplied field is present IN MEMORY, not only after a
  // reload — otherwise in-session and after-reload behaviour differ
  assert.equal(c.removed, false);
  assert.equal(c.transition, "cut");
  assert.equal(roughcut.isAutoClip(c, null), true);
});

/* ========================================================================== */
/* 11. Shot audio ↔ the console's contract                                     */
/* ========================================================================== */

test("an anchored clip that does not resolve is reported, never placed at zero", () => {
  const doc = shotaudio.createShotAudio(null);
  shotaudio.addClip(doc, "s1", shotaudio.makeClip({
    assetId: "sfx1", trackType: "sfx", timing: { anchor: "action:glass_hits_table", offsetMs: 80 },
  }));
  const unresolved = shotaudio.resolveClips(shotaudio.clipsOf(doc, "s1"), { anchors: {} });
  assert.equal(unresolved[0].unresolved, true);
  assert.equal(unresolved[0].startMs, null);
  const resolved = shotaudio.resolveClips(shotaudio.clipsOf(doc, "s1"), {
    anchors: { "action:glass_hits_table": 2400 },
  });
  assert.equal(resolved[0].startMs, 2480);
});

test("a mix records its sources and does not claim a muted or unresolved clip", () => {
  const doc = shotaudio.createShotAudio(null);
  shotaudio.addClip(doc, "s1", shotaudio.makeClip({ assetId: "d1", trackType: "dialogue", timing: { startTimeMs: 0 } }));
  shotaudio.addClip(doc, "s1", shotaudio.makeClip({ assetId: "m1", trackType: "sfx", timing: { startTimeMs: 500 } }));
  shotaudio.addClip(doc, "s1", shotaudio.makeClip({ assetId: "x1", trackType: "foley", timing: { anchor: "action:none", offsetMs: 0 } }));
  const clips = shotaudio.clipsOf(doc, "s1");
  shotaudio.setMuted(doc, "s1", clips[1].clipId, true);
  const resolved = shotaudio.resolveClips(shotaudio.clipsOf(doc, "s1"), { anchors: {}, durations: { d1: 4000 } });
  const prov = shotaudio.mixProvenance(resolved, { versionOf: () => 2 });
  assert.deepEqual(prov.sources.map((s) => s.assetId), ["d1"]);
  assert.equal(prov.sources[0].version, 2);
  assert.equal(prov.unresolved.length, 1);
});

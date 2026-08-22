// TASK-064 / ADR-0061 — the new pure domain pieces behind the creator IA:
// per-shot Prompt versions, media dependency truth, the Skill apply plan, the
// Action Layer vocabulary, and the shot audio timeline.
//
// Every test here guards a RULE the ADR states, not an implementation detail.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as pd from "../src/workflow/promptdoc.js";
import { dependencyOf, videoDependencies, upstreamNotice, resolutionsFor, DEP } from "../src/workflow/mediadep.js";
import { applicability, planApply, APPLY_TARGETS } from "../src/workflow/skillapply.js";
import { ACTIONS, ACTION_NAMES, allowedAt, validate, CURRENT_LEVEL } from "../src/workflow/actions.js";
import * as sa from "../src/workflow/shotaudio.js";
import { REFERENCE_ROLES, ROLE_USE, isInterpretationRole, MODEL_INPUT_ROLES, INTERPRETATION_ROLES } from "../src/workflow/geninput.js";
import {
  ASSET_KINDS, REFERENCE_KINDS, INTERPRETATION_KINDS, KIND_DOMAINS,
  declarationDomainError, domainsForKind, isInterpretationKind,
} from "../src/workflow/assetreg.js";

/* ========================================================================= */
/* Prompt versions (决策 5)                                                   */
/* ========================================================================= */

test("a shot with no stored prompt uses the COMPILED one, and says so", () => {
  const doc = pd.createPrompts(null);
  const eff = pd.effectivePrompt(doc, "sh01", "image", "编译出来的");
  assert.equal(eff.text, "编译出来的");
  assert.equal(eff.source, "compiled");
  assert.equal(eff.version, 0, "no stored version means version 0, not 1");
  assert.equal(pd.entryOf(doc, "sh01", "image"), null);
});

test("saving appends a version and never replaces one", () => {
  const doc = pd.createPrompts(null);
  assert.equal(pd.addVersion(doc, "sh01", "image", { text: "一稿" }), 1);
  assert.equal(pd.addVersion(doc, "sh01", "image", { text: "二稿" }), 2);
  const e = pd.entryOf(doc, "sh01", "image");
  assert.equal(e.versions.length, 2);
  assert.equal(e.active, 2);
  // switching back keeps BOTH
  assert.ok(pd.setActive(doc, "sh01", "image", 1));
  assert.equal(pd.entryOf(doc, "sh01", "image").versions.length, 2);
  assert.equal(pd.effectivePrompt(doc, "sh01", "image", "编译").text, "一稿");
  // a version that does not exist is refused, not rounded to the newest
  assert.equal(pd.setActive(doc, "sh01", "image", 9), false);
  assert.equal(pd.entryOf(doc, "sh01", "image").active, 1);
});

test("image and video prompts are separate documents", () => {
  const doc = pd.createPrompts(null);
  pd.addVersion(doc, "sh01", "image", { text: "图片" });
  assert.equal(pd.effectivePrompt(doc, "sh01", "video", "编译视频").text, "编译视频");
  assert.equal(pd.effectivePrompt(doc, "sh01", "video", "编译视频").source, "compiled");
});

test("a LOCKED prompt refuses automation but not the creator (决策 5 / §50)", () => {
  const doc = pd.createPrompts(null);
  pd.addVersion(doc, "sh01", "image", { text: "人工定稿" });
  assert.ok(pd.setLocked(doc, "sh01", "image", true));
  // a Skill proposal must not overwrite what a human locked
  assert.equal(pd.addVersion(doc, "sh01", "image", { text: "AI 改的", origin: "skill" }), 0);
  // the creator's own edit still lands — a lock protects against Auto, not you
  assert.equal(pd.addVersion(doc, "sh01", "image", { text: "我自己改的", origin: "manual" }), 2);
  assert.equal(pd.effectivePrompt(doc, "sh01", "image", "x").text, "我自己改的");
});

test("回到自动编译 is a real state: the compiled prompt comes back and versions stay", () => {
  const doc = pd.createPrompts(null);
  pd.addVersion(doc, "sh01", "image", { text: "覆盖稿" });
  assert.equal(pd.effectivePrompt(doc, "sh01", "image", "编译稿").text, "覆盖稿");
  // clearing an edit BUFFER is not enough — the override has to stop being in
  // force, or the next generation silently uses it (codex review round 2)
  assert.ok(pd.useCompiled(doc, "sh01", "image"));
  const eff = pd.effectivePrompt(doc, "sh01", "image", "编译稿");
  assert.equal(eff.text, "编译稿");
  assert.equal(eff.source, "compiled");
  assert.equal(eff.version, 0);
  // nothing was deleted: the saved version is still selectable
  assert.equal(pd.entryOf(doc, "sh01", "image").versions.length, 1);
  assert.ok(pd.setActive(doc, "sh01", "image", 1));
  assert.equal(pd.effectivePrompt(doc, "sh01", "image", "编译稿").text, "覆盖稿");
  // already compiled → no change to report
  pd.useCompiled(doc, "sh01", "image");
  assert.equal(pd.useCompiled(doc, "sh01", "image"), false);
  // and `active: 0` survives persistence rather than being repaired to a version
  const again = pd.createPrompts(JSON.parse(JSON.stringify(pd.serialize(doc))));
  assert.equal(pd.effectivePrompt(again, "sh01", "image", "编译稿").source, "compiled");
});

test("a LOCKED prompt refuses 回到自动编译 — that is what the lock is for", () => {
  const doc = pd.createPrompts(null);
  pd.addVersion(doc, "sh01", "image", { text: "定稿" });
  pd.setLocked(doc, "sh01", "image", true);
  assert.equal(pd.useCompiled(doc, "sh01", "image"), false);
  assert.equal(pd.effectivePrompt(doc, "sh01", "image", "编译").text, "定稿");
  pd.setLocked(doc, "sh01", "image", false);
  assert.ok(pd.useCompiled(doc, "sh01", "image"));
});

test("a skill-authored version carries WHICH run produced it; a hand edit carries null", () => {
  const doc = pd.createPrompts(null);
  pd.addVersion(doc, "sh01", "image", { text: "来自提案", origin: "skill", skillRunId: "sr-1", proposalId: "p-1" });
  pd.addVersion(doc, "sh01", "image", { text: "手改", origin: "manual" });
  const [a, b] = pd.entryOf(doc, "sh01", "image").versions;
  assert.equal(a.skillRunId, "sr-1");
  assert.equal(a.proposalId, "p-1");
  assert.equal(b.skillRunId, null, "an absent provenance stays null, never back-filled");
});

test("prompts survive a serialize/hydrate round trip; a shotId named __proto__ is an own key", () => {
  const doc = pd.createPrompts(null);
  pd.addVersion(doc, "__proto__", "image", { text: "危险的 id" });
  pd.addVersion(doc, "sh01", "video", { text: "视频稿" });
  const again = pd.createPrompts(JSON.parse(JSON.stringify(pd.serialize(doc))));
  assert.equal(pd.effectivePrompt(again, "__proto__", "image", "x").text, "危险的 id");
  assert.equal(pd.effectivePrompt(again, "sh01", "video", "x").text, "视频稿");
  assert.equal(({}).text, undefined, "Object.prototype must be untouched");
  // an entry with no versions is not carried: it says nothing
  assert.deepEqual(Object.keys(pd.serialize(pd.createPrompts(null))), []);
});

/* ========================================================================= */
/* media dependency truth (决策 5 / §27)                                       */
/* ========================================================================= */

test("legacy media with no recorded basis is UNKNOWN, never outdated (§27)", () => {
  // basedOn = 0 / nothing recorded: the document never captured what this take
  // was made from, and calling that "behind" invents a history.
  assert.equal(dependencyOf({ version: 2, sourceVersion: null, proven: false }, 3), DEP.UNKNOWN);
  assert.equal(dependencyOf({ version: 2, sourceVersion: 0, proven: false }, 3), DEP.UNKNOWN);
  // no upstream selected at all is also unknown, not "current"
  assert.equal(dependencyOf({ version: 2, sourceVersion: 1, proven: true }, null), DEP.UNKNOWN);
  // and no downstream take at all is NONE
  assert.equal(dependencyOf(null, 3), DEP.NONE);
});

test("the two stale directions are told apart", () => {
  assert.equal(dependencyOf({ version: 2, sourceVersion: 3, proven: true }, 3), DEP.CURRENT);
  // the active image moved FORWARD past what the video used
  assert.equal(dependencyOf({ version: 2, sourceVersion: 1, proven: true }, 3), DEP.OUTDATED);
  // the creator switched the active image BACK before this video's source
  assert.equal(dependencyOf({ version: 2, sourceVersion: 3, proven: true }, 1), DEP.DIVERGED);
});

test("a stale take offers three explicit exits and is never rewritten (§26)", () => {
  const r = resolutionsFor(DEP.OUTDATED, { sourceVersion: 3, activeVersion: 1 });
  assert.deepEqual(r.map((x) => x.action), ["keep", "regenerate", "revert-upstream"]);
  assert.equal(r[2].version, 3, "reverting points at the version the take was based on");
  // nothing to resolve when there is no divergence
  assert.deepEqual(resolutionsFor(DEP.CURRENT), []);
  assert.deepEqual(resolutionsFor(DEP.UNKNOWN), []);
  // an unknown basis leaves the revert target null rather than guessing one
  assert.equal(resolutionsFor(DEP.OUTDATED, { sourceVersion: null, activeVersion: 2 })[2].version, null);
});

test("only the CURRENT take is reported as upstream-changed", () => {
  const videos = [
    { version: 1, assetId: "v1", current: false },
    { version: 2, assetId: "v2", current: true },
  ];
  const sources = { 1: { version: 1, proven: true }, 2: { version: 3, proven: true } };
  const deps = videoDependencies({ videos, videoSources: sources, activeImage: 1 });
  assert.equal(deps[0].state, DEP.CURRENT, "the historical take matches the image it came from");
  assert.equal(deps[1].state, DEP.DIVERGED);
  const n = upstreamNotice(deps, 1);
  assert.equal(n.videoVersion, 2, "the notice is about the take in force");
  assert.equal(n.sourceVersion, 3);
  // a historical take being older is history, not a problem
  assert.equal(upstreamNotice(videoDependencies({ videos, videoSources: sources, activeImage: 3 }), 3), null);
});

/* ========================================================================= */
/* Skill apply (决策 3)                                                        */
/* ========================================================================= */

test("a skill with no canonical target says so instead of pretending (No Fake AI)", () => {
  const cr = applicability("continuity-reviewer");
  assert.equal(cr.can, false);
  assert.match(cr.reason, /审阅结论/);
  assert.equal(applicability("asset-librarian").can, false);
  // an unknown skill is refused rather than assumed applicable
  assert.equal(applicability("nonesuch").can, false);
  // every declared target names WHERE the write lands
  for (const [id, t] of Object.entries(APPLY_TARGETS)) {
    if (t.can) assert.equal(typeof t.target, "string", `${id} must name its target`);
    else assert.equal(typeof t.reason, "string", `${id} must give a reason`);
  }
});

test("a storyboard proposal becomes a NEW draft version, never an in-place edit", () => {
  const plan = planApply("storyboard-director", {
    shots: [{ title: "雨夜街景", description: "霓虹在雨里", duration_seconds: 6 }],
  });
  assert.ok(plan.ok);
  assert.deepEqual(plan.actions.map((a) => a.action), ["replaceShotDraft"]);
  assert.equal(plan.actions[0].shots.length, 1);
  // a field the proposal did not carry is ABSENT, so the normalizer supplies its
  // own default instead of this module inventing 「中景」 for every shot
  assert.equal("shotSize" in plan.actions[0].shots[0], false);
});

test("cinematography patches address shots by ID — never by position", () => {
  const plan = planApply("cinematography", {
    shots: [
      { shotId: "sh-1", shotSize: "特写", cameraMotion: "手持" },
      { shotSize: "全景" }, // unaddressable
    ],
  });
  assert.ok(plan.ok);
  assert.equal(plan.actions[0].patches.length, 1, "the shot with no id is skipped, not applied by position");
  assert.equal(plan.actions[0].patches[0].shotId, "sh-1");
});

test("a shot-scoped prompt proposal with no shot is REFUSED, not written to whatever is selected", () => {
  const bad = planApply("prompt-director", { prompt: "改好的 prompt" }, {});
  assert.equal(bad.ok, false);
  assert.match(bad.error, /哪个镜头/);
  const good = planApply("prompt-director", { prompt: "改好的 prompt" }, { shotId: "sh-1", genKind: "video" });
  assert.ok(good.ok);
  assert.deepEqual(good.actions, [{ action: "updatePrompt", shotId: "sh-1", kind: "video", text: "改好的 prompt" }]);
});

test("an empty proposal is refused rather than applied as nothing", () => {
  assert.equal(planApply("storyboard-director", { shots: [] }).ok, false);
  assert.equal(planApply("script-doctor", { script: "   " }).ok, false);
  assert.equal(planApply("reference-planner", { bindings: [] }).ok, false);
});

test("reference-planner emits one binding action per reference", () => {
  const plan = planApply("reference-planner", {
    bindings: [{ shotId: "sh-1", referenceKeys: ["ref-a", "ref-b"] }, { shotId: "", referenceKeys: ["ref-c"] }],
  });
  assert.ok(plan.ok);
  // TASK-067 §12 — a DELIBERATE rename, not a behaviour change. The old
  // `replaceReference` only ever ADDED (already-bound reported `satisfied`), so the
  // vocabulary had no way to express a real swap at all. `addReference` is what this
  // caller always did; `replaceReference` now genuinely replaces and requires
  // `replacesKey`.
  assert.deepEqual(plan.actions, [
    { action: "addReference", shotId: "sh-1", referenceKey: "ref-a" },
    { action: "addReference", shotId: "sh-1", referenceKey: "ref-b" },
  ]);
});

/* ========================================================================= */
/* the Action Layer (决策 9 / §52, §53)                                        */
/* ========================================================================= */

test("the vocabulary covers every action the task names (§52)", () => {
  for (const name of [
    "setActiveVersion", "replaceReference", "updatePrompt", "runSkill", "applyProposal",
    "prepareGeneration", "registerGenerationResult", "approveShot",
    "moveAudioClip", "trimAudioClip", "setGain", "setFade",
    "replaceTimelineAsset", "trimTimelineClip", "moveTimelineClip",
    "updateSubtitle", "lockItem", "unlockItem", "renderEpisode",
  ]) {
    assert.ok(ACTION_NAMES.includes(name), `missing action ${name}`);
  }
  for (const [name, spec] of Object.entries(ACTIONS)) {
    assert.ok(Array.isArray(spec.args), `${name} must declare its args`);
    assert.ok(["read", "pointer", "edit", "heavy"].includes(spec.risk), `${name} risk`);
  }
});

test("this round grants NO autonomous mutation (§53)", () => {
  assert.equal(CURRENT_LEVEL, "suggest");
  // a human action is always allowed
  assert.equal(allowedAt("renderEpisode", { origin: "user" }).ok, true);
  // an AI origin may read, and nothing else
  assert.equal(allowedAt("prepareGeneration", { origin: "ai" }).ok, true);
  for (const a of ["setActiveVersion", "updatePrompt", "approveShot", "renderEpisode"]) {
    assert.equal(allowedAt(a, { origin: "ai" }).ok, false, `${a} must need a human decision`);
  }
  // the future levels the architecture carries, without enabling them now
  assert.equal(allowedAt("updatePrompt", { origin: "ai", level: "confirm", confirmed: true }).ok, true);
  assert.equal(allowedAt("updatePrompt", { origin: "ai", level: "confirm" }).ok, false);
  assert.equal(allowedAt("setActiveVersion", { origin: "ai", level: "auto-low-risk" }).ok, true);
  assert.equal(allowedAt("renderEpisode", { origin: "ai", level: "auto-low-risk" }).ok, false,
    "auto-low-risk never covers a render");
  assert.equal(allowedAt("nonesuch", { origin: "user" }).ok, false);
});

test("a malformed action envelope is named, not guessed at", () => {
  assert.match(validate({ action: "setActiveVersion", domain: "images" }), /缺少参数.*key.*version/);
  assert.match(validate({ action: "nope" }), /未知动作/);
  assert.match(validate(null), /必须是一个对象/);
  assert.equal(validate({ action: "approveShot", shotId: "s", note: "" }), null);
});

/* ========================================================================= */
/* Creative References (决策 4)                                               */
/* ========================================================================= */

test("a Reference is not image-only, and the directing four are interpretation inputs", () => {
  for (const k of ["video-style-reference", "motion-reference", "camera-reference", "performance-reference"]) {
    assert.ok(REFERENCE_KINDS.includes(k), `${k} must be a reference kind`);
    assert.ok(ASSET_KINDS.includes(k));
    assert.ok(isInterpretationKind(k));
    // 「Video Reference ≠ 必须直接传入 Video API」: it may be a clip OR a still
    assert.ok(domainsForKind(k).includes("videos"));
    assert.ok(domainsForKind(k).includes("images"));
  }
  assert.deepEqual(INTERPRETATION_KINDS.length, 4);
  // the roles agree with the kinds — one statement, not two that can drift
  assert.deepEqual(INTERPRETATION_ROLES, INTERPRETATION_KINDS);
  assert.deepEqual(MODEL_INPUT_ROLES, [
    "character-reference", "location-reference", "prop-reference", "style-reference",
  ]);
  for (const [role] of REFERENCE_ROLES) {
    assert.ok(["model-input", "ai-interpretation"].includes(ROLE_USE[role]), role);
    assert.equal(isInterpretationRole(role), ROLE_USE[role] === "ai-interpretation");
  }
});

test("a multi-domain kind is checked against its OWN set, not waved through", () => {
  assert.equal(declarationDomainError("camera-reference", "videos"), null);
  assert.equal(declarationDomainError("camera-reference", "images"), null);
  // an mp3 declared a camera reference would make every media filter wrong
  assert.match(declarationDomainError("camera-reference", "audio"), /不能登记到/);
  // …but a line read IS a real performance reference
  assert.equal(declarationDomainError("performance-reference", "audio"), null);
  // `finals` is in no set: this project's output is never somebody's reference
  for (const k of Object.keys(KIND_DOMAINS)) {
    assert.match(declarationDomainError(k, "finals"), /不能登记到/, k);
  }
  // a single-domain kind still holds its line
  assert.match(declarationDomainError("character-reference", "videos"), /不能登记到/);
  assert.equal(declarationDomainError(null, "audio"), null, "unclassified asserts nothing");
});

test("a reference role's allowed domains are what an upload entrance may offer", () => {
  // The picker's `accept` is derived from these (app.js `acceptForKind`), so an
  // advertised 「运动参考」 button cannot end up accepting only images — which is
  // exactly the mismatch codex review round 3 found.
  for (const [role] of REFERENCE_ROLES) {
    const d = domainsForKind(role);
    assert.ok(d.length >= 1, `${role} must declare at least one domain`);
    for (const dom of d) {
      assert.equal(declarationDomainError(role, dom), null, `${role} must accept ${dom}`);
    }
    assert.ok(!d.includes("finals"), `${role} must never be registerable into finals`);
  }
  // the interpretation roles are the ones that may be a clip
  for (const role of INTERPRETATION_ROLES) {
    assert.ok(domainsForKind(role).includes("videos"), `${role} must accept a clip`);
  }
  // …and the model-input four stay images, which is what their generation use is
  for (const role of MODEL_INPUT_ROLES) {
    assert.deepEqual(domainsForKind(role), ["images"], role);
  }
});

/* ========================================================================= */
/* shot audio timeline (决策 6 / 决策 7)                                        */
/* ========================================================================= */

test("the two timing modes are EXCLUSIVE, and exactly one is required", () => {
  assert.equal(sa.makeClip({ assetId: "a", trackType: "sfx", timing: { startTimeMs: 100, anchor: "action:x" } }), null);
  // NEITHER is refused just as firmly: falling through to "absolute at 0 ms" put
  // a sound on the first frame whenever a caller forgot to say where it goes
  assert.equal(sa.makeClip({ assetId: "a", trackType: "sfx" }), null);
  assert.equal(sa.makeClip({ assetId: "a", trackType: "sfx", timing: {} }), null);
  assert.equal(sa.makeClip({ assetId: "a", trackType: "sfx", timing: { anchor: "bogus:x" } }), null,
    "a malformed anchor is refused, not silently placed at 0");
  // …and a malformed anchor is refused even beside a valid absolute time: taking
  // the absolute one would silently DISCARD a timing the caller had stated
  assert.equal(sa.makeClip({ assetId: "a", trackType: "sfx", timing: { startTimeMs: 100, anchor: "bogus:x" } }), null);
  assert.equal(sa.makeClip({ assetId: "a", trackType: "sfx", timing: { startTimeMs: 100, anchor: null } }).startTimeMs,
    100, "an explicitly null anchor is an absence, not a malformed value");
  const abs = sa.makeClip({ assetId: "a", trackType: "ambience", timing: { startTimeMs: 3200 } });
  assert.equal(abs.startTimeMs, 3200);
  assert.equal(abs.anchor, null);
  const anc = sa.makeClip({ assetId: "a", trackType: "sfx", timing: { anchor: "action:glass_hits_table", offsetMs: 80 } });
  assert.equal(anc.startTimeMs, null, "an anchored clip has no absolute start");
  assert.equal(anc.offsetMs, 80);
  // an unknown anchor namespace is not an anchor
  assert.equal(sa.parseAnchor("nonesuch:x"), null);
  assert.deepEqual(sa.parseAnchor("dialogue:line_03"), { ns: "dialogue", name: "line_03" });
});

test("an unresolvable anchor is reported, never silently placed at zero", () => {
  const clips = [
    sa.makeClip({ assetId: "a", trackType: "sfx", timing: { anchor: "action:glass_hits_table", offsetMs: 80 } }),
    sa.makeClip({ assetId: "b", trackType: "foley", timing: { anchor: "action:missing", offsetMs: 0 } }),
  ];
  const r = sa.resolveClips(clips, { anchors: { "action:glass_hits_table": 1500 }, durations: { a: 400, b: 300 } });
  assert.equal(r[0].startMs, 1580);
  assert.equal(r[0].endMs, 1980);
  assert.equal(r[0].unresolved, false);
  assert.equal(r[1].startMs, null);
  assert.equal(r[1].unresolved, true, "a foley hit 3s from its action is worse than an obviously missing one");
});

test("auto-arrange never touches a locked or hand-placed clip (决策 5)", () => {
  const doc = sa.createShotAudio(null);
  const mine = sa.addClip(doc, "sh01", sa.makeClip({
    assetId: "my-amb", trackType: "ambience", timing: { startTimeMs: 500 }, origin: "manual",
  }));
  sa.setLocked(doc, "sh01", mine.clipId, true);
  const res = sa.autoArrange(doc, "sh01", { dialogue: "dlg-1", ambience: "auto-amb", bgm: "bgm-1", durationMs: 6000 });
  const amb = sa.clipsOf(doc, "sh01").filter((c) => c.trackType === "ambience");
  assert.equal(amb.length, 1, "the arranger did not add a second ambience over the creator's");
  assert.equal(amb[0].assetId, "my-amb");
  assert.ok(res.skipped.some((s) => s.trackType === "ambience"));
  // …and it DID do its job on the tracks it was free to touch
  assert.ok(res.added.some((c) => c.trackType === "dialogue" && c.assetId === "dlg-1"));
  assert.ok(res.added.some((c) => c.trackType === "bgm"));
  // BGM sits under dialogue as a NUMBER, not as a promise
  assert.ok(res.added.find((c) => c.trackType === "bgm").gain < 0);
  // it never invents media
  const empty = sa.createShotAudio(null);
  sa.autoArrange(empty, "sh02", {});
  assert.deepEqual(sa.clipsOf(empty, "sh02"), []);
});

test("a locked clip refuses every automated edit and its own delete", () => {
  const doc = sa.createShotAudio(null);
  const c = sa.addClip(doc, "sh01", sa.makeClip({ assetId: "a", trackType: "sfx", timing: { startTimeMs: 0 } }));
  sa.setLocked(doc, "sh01", c.clipId, true);
  assert.equal(sa.setGain(doc, "sh01", c.clipId, -6), false);
  assert.equal(sa.moveClip(doc, "sh01", c.clipId, { startTimeMs: 900 }), false);
  assert.equal(sa.removeClip(doc, "sh01", c.clipId), false);
  // the creator's OWN edit of a clip they locked still lands
  assert.equal(sa.setGain(doc, "sh01", c.clipId, -6, { force: true }), true);
  // unlocking is always possible, or the lock could never be undone
  assert.ok(sa.setLocked(doc, "sh01", c.clipId, false));
  assert.ok(sa.removeClip(doc, "sh01", c.clipId));
});

test("a mix is DERIVED: sources are preserved and its provenance is a snapshot (§38)", () => {
  const doc = sa.createShotAudio(null);
  sa.addClip(doc, "sh01", sa.makeClip({ assetId: "dlg", trackType: "dialogue", timing: { startTimeMs: 0 }, sourceOutMs: 2000 }));
  sa.addClip(doc, "sh01", sa.makeClip({ assetId: "amb", trackType: "ambience", timing: { startTimeMs: 0 }, sourceOutMs: 6000, gain: -8 }));
  const resolved = sa.resolveClips(sa.clipsOf(doc, "sh01"));
  const prov = sa.mixProvenance(resolved, { settings: { normalize: true }, versionOf: () => 2 });
  assert.equal(prov.sources.length, 2);
  for (const s of prov.sources) {
    for (const k of ["assetId", "version", "trackType", "startMs", "endMs", "gain", "fadeInMs", "fadeOutMs"]) {
      assert.ok(k in s, `mix provenance must record ${k}`);
    }
  }
  assert.ok(sa.setMix(doc, "sh01", { assetId: "mix-1", at: "2026-08-12T00:00:00.000Z", provenance: prov }));
  // every source is still there — a mix replaces nothing
  assert.equal(sa.clipsOf(doc, "sh01").length, 2);
  assert.equal(sa.mixStanding(doc, "sh01", resolved).state, "current");
  // move a clip and the stored mix is honestly stale
  const clip = sa.clipsOf(doc, "sh01")[0];
  sa.moveClip(doc, "sh01", clip.clipId, { startTimeMs: 400 });
  assert.equal(sa.mixStanding(doc, "sh01", sa.resolveClips(sa.clipsOf(doc, "sh01"))).state, "stale");
  assert.equal(sa.mixStanding(sa.createShotAudio(null), "shX", []).state, "none");
});

test("a muted clip is not claimed by the mix; an unresolved one is recorded as such", () => {
  const doc = sa.createShotAudio(null);
  const a = sa.addClip(doc, "sh01", sa.makeClip({ assetId: "a", trackType: "sfx", timing: { startTimeMs: 0 }, sourceOutMs: 100 }));
  sa.addClip(doc, "sh01", sa.makeClip({ assetId: "b", trackType: "foley", timing: { anchor: "action:nope" } }));
  sa.setMuted(doc, "sh01", a.clipId, true);
  const prov = sa.mixProvenance(sa.resolveClips(sa.clipsOf(doc, "sh01")));
  assert.equal(prov.sources.length, 0, "a muted clip is not IN the mix");
  assert.equal(prov.unresolved.length, 1);
});

test("shot audio survives a serialize/hydrate round trip, __proto__ shotId included", () => {
  const doc = sa.createShotAudio(null);
  sa.addClip(doc, "sh01", sa.makeClip({ assetId: "a", trackType: "bgm", timing: { startTimeMs: 250 }, gain: -4, fadeInMs: 600 }));
  sa.addClip(doc, "__proto__", sa.makeClip({ assetId: "z", trackType: "sfx", timing: { startTimeMs: 10 } }));
  const again = sa.createShotAudio(JSON.parse(JSON.stringify(sa.serialize(doc))));
  assert.equal(sa.clipsOf(again, "__proto__").length, 1, "a shotId named __proto__ must round-trip as an own key");
  assert.equal(({}).clips, undefined, "Object.prototype must be untouched");
  const c = sa.clipsOf(again, "sh01")[0];
  assert.equal(c.assetId, "a");
  assert.equal(c.startTimeMs, 250);
  assert.equal(c.gain, -4);
  assert.equal(c.fadeInMs, 600);
  // a clip with no asset or no track is not a clip
  assert.equal(sa.sanitizeClip({ trackType: "bgm" }), null);
  assert.equal(sa.sanitizeClip({ assetId: "a", trackType: "nope" }), null);
  // gain is bounded rather than accepted at any value
  assert.equal(sa.sanitizeClip({ assetId: "a", trackType: "bgm", gain: 999 }).gain, sa.GAIN_MAX_DB);
});

test("tracks are ordered and unresolved clips lead their track", () => {
  assert.deepEqual(sa.TRACKS, ["dialogue", "vo", "ambience", "sfx", "foley", "bgm"]);
  const resolved = [
    { clipId: "c1", trackType: "sfx", startMs: 900, unresolved: false },
    { clipId: "c2", trackType: "sfx", startMs: null, unresolved: true },
    { clipId: "c3", trackType: "sfx", startMs: 100, unresolved: false },
  ];
  const sfx = sa.byTrack(resolved).find((t) => t.trackType === "sfx");
  assert.deepEqual(sfx.clips.map((c) => c.clipId), ["c2", "c3", "c1"]);
  assert.deepEqual(sa.byTrack([]).map((t) => t.trackType), sa.TRACKS);
});

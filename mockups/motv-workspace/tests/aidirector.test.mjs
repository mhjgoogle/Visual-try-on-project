// TASK-067 / ADR-0064 — AI 导演的可操作化.
//
// What is pinned here:
//   1. the Shot Context is MINIMAL — it does not carry the project
//   2. it is TRACEABLE — the trace names ids AND versions, and drives the cache key
//   3. the cache is revision-keyed; a changed upstream reads STALE, never fresh
//   4. asset candidates are DETERMINISTIC and carry real ids + evidence
//   5. readiness is DERIVED, and the two prompt gates come from it
//   6. the five new capabilities are shot-scoped and refuse to run without a shot
//   7. Video Prompt Director refuses without a SELECTED main frame — in the
//      capability layer, not as a greyed-out button
//   8. every proposal type §12 names maps to a real Action, and a review with no
//      rewrite is refused rather than faked
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildShotContext, traceOf, contextRevision, shotReadiness, candidatesFor,
  summarize, READINESS_ROLES, traceOf as shotctx_traceOf,
} from "../src/workflow/shotctx.js";
import {
  createCache, put, get, forget, forgetShot, cacheKey, serialize, SCOPES, MAX_ENTRIES,
} from "../src/workflow/ctxcache.js";
import { SKILLS, findSkill, missingInputs, isShotScoped, SHOT_SCOPED_INPUTS, SKILL_INPUTS, compilePrompt } from "../src/workflow/skills.js";
import { EXECUTORS, WORK_KINDS, suggestExecutor } from "../src/services/runtime.js";
import { planApply, applicability, applicabilityFor } from "../src/workflow/skillapply.js";
import { ACTIONS, validate, allowedAt, CURRENT_LEVEL } from "../src/workflow/actions.js";
import { OPERATIONS, primaryOperation, renderShotDirector, shotDirectorModel, operationOfRun } from "../src/ui/directorshot.js";
import { startRun, createSkillRunRegistry } from "../src/workflow/skillrun.js";


// The catalog is INSTALLED, not imported: `skills.js` no longer carries
// definitions (TASK-075 §1.4). These read the same packages the backend reads,
// so a test can never be asserting against a third copy of a capability.
import * as _skillsModule from "../src/workflow/skills.js";
import { installBuiltinCatalog } from "./skillcatalog.mjs";

installBuiltinCatalog(_skillsModule);

/* ========================================================================= */
/* fixtures — a shot detail model shaped exactly like shotDetailModel output   */
/* ========================================================================= */

const REF = (over) => ({
  key: "ref-c", kind: "character-reference", name: "林晚 Ref", version: 3,
  assetId: "ac", domain: "images", ...over,
});

function detail(over = {}) {
  return {
    shot: {
      shotId: "sh01", seq: 2, title: "擦杯子", description: "林晚在吧台后擦杯子",
      action: "缓慢擦拭", cameraMotion: "缓推", dialogue: "", duration: 6,
      shotSize: "中景", angle: "平视", emotion: "疲惫",
    },
    scene: {
      sceneId: "sc1", title: "S01 酒吧 · 打烊后",
      characters: [{ characterId: "ch1", name: "林晚", stateName: "夜班" }],
      location: { locationId: "lo1", name: "暗夜酒吧", stateName: "打烊后" },
    },
    refInputs: { references: [], interpretation: [], imageReferences: [], videoReferences: [] },
    frames: { start: null, end: null },
    images: { list: [], current: 0 },
    videos: { list: [], current: 0 },
    prompts: { image: { text: "", missing: [] }, video: { text: "", missing: [] } },
    ...over,
  };
}

const PLACE = {
  episodeId: "ep1", episodeCode: "EP01", episodeTitle: "EP01 迷雾入城",
  sceneId: "sc1", sceneTitle: "S01 酒吧 · 打烊后",
};
const CANON = { genreTone: "都市悬疑 · 冷色", worldVisualTone: "霓虹与雨", worldRules: "无超自然" };

const build = (over = {}, opts = {}) => buildShotContext({
  detail: detail(over), place: PLACE, canon: CANON, ...opts,
});

/* ========================================================================= */
/* 1 · the context is MINIMAL                                                 */
/* ========================================================================= */

test("shotContext carries this shot and NOT the project (§3 / §15)", () => {
  const { context } = build();
  assert.ok(context);
  // the five levels §3 names are all present
  assert.equal(context.episode.code, "EP01");
  assert.equal(context.scene.title, "S01 酒吧 · 打烊后");
  assert.equal(context.shot.shotId, "sh01");
  assert.equal(context.scene.characters[0].stateName, "夜班", "CharacterState is a first-class input");
  assert.equal(context.scene.location.stateName, "打烊后", "…and so is LocationState");
  assert.equal(context.projectCanon.worldVisualTone, "霓虹与雨");
  // …and the project-wide bags are NOT. This is the whole point of §15: the old
  // context handed over every draft shot, every reference, every asset and every
  // generation to answer a question about one shot.
  for (const forbidden of ["shots", "assets", "generations", "references_all", "timeline", "subtitles"]) {
    assert.equal(context[forbidden], undefined, `shotContext must not carry ${forbidden}`);
  }
  // the compiler's own gaps are carried VERBATIM so the panel and a capability
  // cannot disagree about what is missing
  assert.deepEqual(context.compilerGaps.image, []);
});

test("a neighbour is a SUMMARY, not a shot — and only its bound end frame travels", () => {
  const prev = detail({
    shot: { shotId: "sh00", seq: 1, title: "推门", description: "门被推开", action: "推门", cameraMotion: "固定", dialogue: "", duration: 6, shotSize: "全景", angle: "平视", emotion: "紧张" },
    frames: { start: null, end: { assetId: "endA", version: 2, name: "尾帧", from: "SH00 视频 v2 · 尾帧", binding: { source: "extracted" } } },
  });
  const { context } = build({}, { neighbours: { prev }, neighbourFrames: { prevEndFrameAssetId: "endA" } });
  const p = context.neighbours.previous;
  assert.equal(p.shotId, "sh00");
  assert.equal(p.endFrameAssetId, "endA");
  // a summary, not the record: no prompts, no version history, no reference list
  for (const forbidden of ["prompts", "images", "videos", "references", "refInputs"]) {
    assert.equal(p[forbidden], undefined, `a neighbour summary must not carry ${forbidden}`);
  }
  assert.equal(context.neighbours.next, null, "no next shot is null, never an empty shell");
});

test("summarize is the one-line human label a run list shows", () => {
  const { context } = build({ images: { list: [{ version: 2, url: "b", assetId: "i2", current: true, origin: "上传" }] } });
  const line = summarize(context);
  assert.match(line, /EP01/);
  assert.match(line, /SH02/);
  assert.match(line, /主帧图 v2/);
});

/* ========================================================================= */
/* 2 · traceability, and the revision it drives                               */
/* ========================================================================= */

test("the trace names ids AND versions — 「本次读了什么」 has a machine answer (§3)", () => {
  const { context, trace } = build({
    refInputs: {
      references: [REF(), REF({ key: "ref-m", kind: "motion-reference", name: "Motion Ref", version: 1, assetId: "am", domain: "videos" })],
      interpretation: [
        { key: "ref-m", kind: "motion-reference", name: "Motion Ref", version: 1, read: true, axes: { movement: "缓慢横移" }, readingVersion: 4, locked: false },
      ],
      imageReferences: [], videoReferences: [],
    },
  }, { refUseOf: (k) => (k === "ref-m" ? "video" : "image") });
  assert.equal(trace.shotId, "sh01");
  assert.deepEqual(trace.characterIds, ["ch1/夜班"]);
  assert.equal(trace.locationId, "lo1/打烊后");
  assert.deepEqual(trace.references, [
    { referenceKey: "ref-c", assetId: "ac", version: 3, use: "image", readingVersion: null },
    { referenceKey: "ref-m", assetId: "am", version: 1, use: "video", readingVersion: 4 },
  ]);
  // the READING is on the reference, in the form a prompt can carry — not the media
  const m = context.references.find((r) => r.referenceKey === "ref-m");
  assert.equal(m.interpreted, true);
  assert.deepEqual(m.axes, { movement: "缓慢横移" });
  assert.equal(traceOf(null), null);
});

test("the revision changes when an INPUT changes, and not otherwise (决策 3)", () => {
  const base = build();
  const rev = (b, scope = "assetRecommendation") => contextRevision(b.trace, scope);
  const r0 = rev(base);
  // same inputs → same revision. A clock-based key would differ here and re-spend
  // tokens for nothing.
  assert.equal(rev(build()), r0);
  // a different SCOPE is a different baseline: a recommendation and a continuity
  // summary go stale for different reasons
  assert.notEqual(rev(base, "continuitySummary"), r0);
  // a re-written 画面 invalidates it even though no id moved
  assert.notEqual(rev(build({ shot: { ...detail().shot, description: "林晚盯着门口" } })), r0);
  // a new reference binding invalidates it
  assert.notEqual(rev(build({ refInputs: { references: [REF()], interpretation: [], imageReferences: [], videoReferences: [] } })), r0);
  // a new SELECTED take invalidates it
  assert.notEqual(rev(build({ images: { list: [{ version: 1, url: "b", assetId: "i1", current: true, origin: "上传" }] } })), r0);
  // a re-READ of the same reference invalidates it — the words that reach the prompt
  // changed, even though the reference did not
  const withRead = (v) => build({
    refInputs: {
      references: [REF({ key: "ref-m", kind: "motion-reference", assetId: "am", version: 1, name: "M" })],
      interpretation: [{ key: "ref-m", kind: "motion-reference", name: "M", version: 1, read: true, axes: { movement: "x" }, readingVersion: v, locked: false }],
      imageReferences: [], videoReferences: [],
    },
  });
  assert.notEqual(rev(withRead(2)), rev(withRead(1)));
  assert.equal(contextRevision(null, "x"), null);
});

/* ========================================================================= */
/* 3 · the cache: stale is VISIBLE, never silently fresh                      */
/* ========================================================================= */

test("a cached conclusion whose baseline moved reads STALE, and is still returned", () => {
  const cache = createCache(null);
  put(cache, { scope: "assetRecommendation", shotId: "sh01", baselineRevision: "rev-1", value: { recommendations: [1] }, at: "2026-08-13T00:00:00Z" });
  const fresh = get(cache, { scope: "assetRecommendation", shotId: "sh01", currentRevision: "rev-1" });
  assert.equal(fresh.stale, false);
  assert.deepEqual(fresh.value, { recommendations: [1] });
  const stale = get(cache, { scope: "assetRecommendation", shotId: "sh01", currentRevision: "rev-2" });
  assert.equal(stale.stale, true, "a moved baseline is STALE");
  assert.deepEqual(stale.value, { recommendations: [1] }, "…and the old conclusion is still shown, marked");
  assert.equal(stale.baselineRevision, "rev-1", "…with the baseline it was drawn from");
  // NOT deleted: 「上一次的结论 + 它过期了」 beats an empty panel
  assert.equal(cache.length, 1);
});

test("with no current revision the cache refuses to claim freshness", () => {
  const cache = createCache(null);
  put(cache, { scope: "continuitySummary", shotId: "sh01", baselineRevision: "rev-1", value: { issues: [] } });
  const r = get(cache, { scope: "continuitySummary", shotId: "sh01", currentRevision: null });
  assert.equal(r.stale, true, "unknown baseline ⇒ conservative: may not apply");
});

test("an entry with no baseline is DROPPED on hydrate — it could never be checked", () => {
  const cache = createCache([
    { key: "assetRecommendation:sh01", scope: "assetRecommendation", shotId: "sh01", baselineRevision: "r", value: 1 },
    { key: "assetRecommendation:sh02", scope: "assetRecommendation", shotId: "sh02", value: 2 },   // no baseline
    { key: "nope:sh03", scope: "nope", shotId: "sh03", baselineRevision: "r", value: 3 },          // unknown scope
  ]);
  assert.deepEqual(cache.map((e) => e.shotId), ["sh01"]);
  assert.equal(cacheKey("nope", "sh01"), null, "an unknown scope has no key");
  assert.equal(cacheKey("assetRecommendation", ""), null);
});

test("the cache is bounded, and forgetting is per-conclusion or per-shot", () => {
  const cache = createCache(null);
  for (let i = 0; i < MAX_ENTRIES + 10; i++) {
    put(cache, { scope: "promptReview", shotId: `sh${i}`, baselineRevision: "r", value: i });
  }
  assert.equal(cache.length, MAX_ENTRIES, "oldest evicted first, never unbounded");
  put(cache, { scope: "assetRecommendation", shotId: "shX", baselineRevision: "r", value: 1 });
  put(cache, { scope: "continuitySummary", shotId: "shX", baselineRevision: "r", value: 2 });
  assert.equal(forget(cache, { scope: "assetRecommendation", shotId: "shX" }), true);
  assert.equal(forgetShot(cache, "shX"), 1, "the remaining conclusion about that shot goes too");
  // round-trips
  assert.deepEqual(serialize(createCache(serialize(cache))).length, cache.length);
  assert.deepEqual(SCOPES, ["assetRecommendation", "continuitySummary", "promptReview"]);
});

/* ========================================================================= */
/* 4 · candidates are DETERMINISTIC and carry real ids (§4 / 决策 4)            */
/* ========================================================================= */

const REGISTRY = [
  { key: "ref-linwan", kind: "character-reference", name: "林晚 / 夜班 Ref", version: 3, assetId: "a1", links: { characterId: "ch1" } },
  { key: "ref-other", kind: "character-reference", name: "陈默 Ref", version: 1, assetId: "a2", links: { characterId: "ch9" } },
  { key: "ref-bar", kind: "location-reference", name: "暗夜酒吧 Ref", version: 2, assetId: "a3", links: { locationId: "lo1" } },
  { key: "ref-rain", kind: "style-reference", name: "Rain Style", version: 1, assetId: "a4", links: {}, reusable: true },
  { key: "ref-glass", kind: "prop-reference", name: "杯子", version: 1, assetId: "a5", links: {} },
  { key: "ref-cam", kind: "camera-reference", name: "缓推 Camera", version: 1, assetId: "a6", links: {} },
];

test("candidates come from the REGISTRY with real ids and stated evidence (§4)", () => {
  const { context } = build();
  const out = candidatesFor(context, REGISTRY);
  const byKey = new Map(out.candidates.map((c) => [c.referenceKey, c]));
  // the character in THIS scene is a candidate, by link — with a real assetId
  assert.equal(byKey.get("ref-linwan").assetId, "a1");
  assert.equal(byKey.get("ref-linwan").evidence, "link 到本场出场人物");
  // …and a character who is NOT in this scene is not offered at all. 「随便一张人物
  // 参考」 is not a recommendation.
  assert.equal(byKey.has("ref-other"), false);
  assert.equal(byKey.get("ref-bar").evidence, "link 到本场场景地");
  // a prop named in the shot's own description is evidence; the description says 杯子
  assert.equal(byKey.get("ref-glass").evidence, "镜头描述里提到了它");
  // project-wide directing / style roles are reusable by construction
  assert.equal(byKey.get("ref-rain").side, "image");
  assert.equal(byKey.get("ref-cam").side, "video", "a camera reference serves the video side");
  // ranking is deterministic: linked evidence outranks name matching outranks
  // project-wide reuse
  assert.ok(byKey.get("ref-linwan").score > byKey.get("ref-rain").score);
});

test("an ALREADY BOUND reference is never recommended again", () => {
  const { context } = build({
    refInputs: { references: [REF({ key: "ref-linwan", assetId: "a1" })], interpretation: [], imageReferences: [], videoReferences: [] },
  });
  const out = candidatesFor(context, REGISTRY);
  assert.equal(out.candidates.some((c) => c.referenceKey === "ref-linwan"), false);
  assert.deepEqual(out.bound.map((b) => b.referenceKey), ["ref-linwan"]);
});

test("a CAPPED candidate set says it was capped", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    key: `ref-s${i}`, kind: "style-reference", name: `S${i}`, version: 1, assetId: `s${i}`, links: {},
  }));
  const { context } = build();
  const out = candidatesFor(context, many, { limitPerRole: 3 });
  assert.equal(out.candidates.length, 3);
  assert.equal(out.truncated, 7, "silent truncation would read as 「看过全部候选」");
});

/* ========================================================================= */
/* 5 · readiness is DERIVED (§6)                                              */
/* ========================================================================= */

test("readiness reports 已有 / 缺少 from real data, and gates the two prompts (§6)", () => {
  const empty = shotReadiness(build().context);
  // no image yet ⇒ the Video Prompt gate is shut, and it says why
  assert.equal(empty.canWriteVideoPrompt, false);
  assert.ok(empty.blocking.some((b) => b.kind === "selectedShotImage"));
  // the scene HAS a location and characters here, so those are not gaps…
  assert.equal(empty.blocking.some((b) => b.kind === "sceneLocation"), false);
  // …but the shot has no character reference bound, and that IS one
  assert.ok(empty.gaps.some((g) => g.kind === "character-reference"));
  assert.equal(empty.canWriteImagePrompt, true, "an Image Prompt can be written; it will just be weaker");
  assert.match(empty.verdict, /可以生成 Image Prompt/);

  // with references bound, they move to 已有
  const withRefs = shotReadiness(build({
    refInputs: {
      references: [REF(), REF({ key: "ref-l", kind: "location-reference", name: "暗夜酒吧 Ref", assetId: "al", version: 2 })],
      interpretation: [], imageReferences: [], videoReferences: [],
    },
  }).context);
  assert.ok(withRefs.have.some((h) => h.kind === "character-reference"));
  assert.equal(withRefs.gaps.some((g) => g.kind === "character-reference"), false);
});

test("an empty scene location is BLOCKING, and an empty description too", () => {
  const r = shotReadiness(build({
    scene: { sceneId: "sc1", title: "S01", characters: [], location: null },
    shot: { ...detail().shot, description: "" },
  }).context);
  assert.equal(r.canWriteImagePrompt, false);
  assert.ok(r.blocking.some((b) => b.kind === "sceneLocation"));
  assert.ok(r.blocking.some((b) => b.kind === "shotDescription"));
  assert.match(r.verdict, /还不能写 Image Prompt/);
});

test("a bound but UNREAD directing reference is a gap, not a ✓", () => {
  const r = shotReadiness(build({
    refInputs: {
      references: [REF({ key: "ref-m", kind: "motion-reference", name: "Motion Ref", assetId: "am", version: 1 })],
      interpretation: [{ key: "ref-m", kind: "motion-reference", name: "Motion Ref", version: 1, read: false, axes: {}, readingVersion: null, locked: false }],
      imageReferences: [], videoReferences: [],
    },
  }).context);
  const m = r.missing.find((x) => x.kind === "motion-reference");
  assert.ok(m, "bound-but-unread contributes nothing to the prompt yet");
  assert.equal(m.fix, "interpret");
  assert.equal(r.have.some((h) => h.kind === "motion-reference"), false, "「✓ 已有」 would hide that nobody read it");
});

test("the previous shot's END FRAME turns the start-frame gap into an offer (§12)", () => {
  const prev = detail({
    shot: { ...detail().shot, shotId: "sh00", seq: 1 },
    frames: { start: null, end: { assetId: "endA", version: 2, name: "尾帧", from: "SH00 · 尾帧", binding: { source: "extracted" } } },
  });
  const r = shotReadiness(build(
    { images: { list: [{ version: 1, url: "b", assetId: "i1", current: true, origin: "上传" }] } },
    { neighbours: { prev }, neighbourFrames: { prevEndFrameAssetId: "endA" } },
  ).context);
  const sf = r.missing.find((x) => x.kind === "startFrame");
  assert.equal(sf.fix, "usePreviousShotEndFrame", "the gap names the action that closes it");
  // and with NO previous end frame it is only a soft note about using its own picture
  const own = shotReadiness(build({ images: { list: [{ version: 1, url: "b", assetId: "i1", current: true, origin: "上传" }] } }).context);
  assert.equal(own.missing.find((x) => x.kind === "startFrame").severity, "soft");
});

test("the verdict walks the chain: prompt → image → video prompt → video", () => {
  const v = (over, opts) => shotReadiness(build(over, opts).context).verdict;
  const img = { list: [{ version: 1, url: "b", assetId: "i1", current: true, origin: "上传" }] };
  assert.match(v({ prompts: { image: { text: "P", missing: [] }, video: { text: "", missing: [] } } }, { prompts: { image: { version: 1, text: "P", locked: false }, video: { version: null, text: null, locked: false } } }), /到外部工具出图/);
  assert.match(
    v({ images: img }, { prompts: { image: { version: 1, text: "P", locked: false }, video: { version: null, text: null, locked: false } } }),
    /可以生成 Video Prompt/,
  );
  assert.match(
    v({ images: img, videos: { list: [{ version: 1, url: "b", assetId: "v1", current: true, origin: "上传" }] } },
      { prompts: { image: { version: 1, text: "P", locked: false }, video: { version: 1, text: "V", locked: false } } }),
    /剧集制作对它的工作完成了/,
  );
});

test("READINESS_ROLES only names roles a compiler really reads", () => {
  for (const [kind, label, side] of READINESS_ROLES) {
    assert.equal(typeof label, "string");
    assert.ok(side === "image" || side === "video", `${kind} must serve a real side`);
  }
});

/* ========================================================================= */
/* 6 · the five capabilities are SHOT-SCOPED                                  */
/* ========================================================================= */

test("the five new capabilities are shot-scoped, and nothing else is", () => {
  const scoped = SKILLS.filter(isShotScoped).map((s) => s.skillId).sort();
  assert.deepEqual(scoped, [
    "image-prompt-director", "prompt-reviewer", "shot-asset-recommender",
    "shot-continuity-reviewer", "video-prompt-director",
  ]);
  // the old project-wide capabilities stayed project-wide — this round did not
  // quietly narrow them
  assert.equal(isShotScoped(findSkill("prompt-director")), false);
  assert.equal(isShotScoped(findSkill("storyboard-director")), false);
  for (const k of SHOT_SCOPED_INPUTS) {
    assert.ok(k in SKILL_INPUTS, `${k} must be a declared input`);
  }
});

test("Video Prompt Director REFUSES without a selected main frame — in the capability layer (§8)", () => {
  const s = findSkill("video-prompt-director");
  const { context } = build();
  // no selected image ⇒ the required input is genuinely absent
  assert.deepEqual(missingInputs(s, { shotContext: context, selectedShotImage: null }), ["selectedShotImage"]);
  // …and with one, it runs. `describedAs` is what makes the gate see CONTENT: an
  // object of nothing but ids reads as empty and would refuse a shot that really
  // does have a selected frame.
  assert.deepEqual(
    missingInputs(s, { shotContext: context, selectedShotImage: { assetId: "i1", version: 2, origin: "上传", describedAs: "主帧图 v2（上传）" } }),
    [],
  );
  assert.deepEqual(
    missingInputs(s, { shotContext: context, selectedShotImage: { assetId: "i1", version: 2, origin: null } }),
    ["selectedShotImage"],
    "identity-only is object-shaped nothing — the gate is right to refuse it",
  );
});

test("Shot Continuity Reviewer refuses when there are no neighbours — unavailable, not a fake pass (§10)", () => {
  const s = findSkill("shot-continuity-reviewer");
  const { context } = build();
  assert.deepEqual(missingInputs(s, { shotContext: context, neighbourShots: null }), ["neighbourShots"]);
  assert.deepEqual(
    missingInputs(s, { shotContext: context, neighbourShots: { previous: { shotId: "sh00", title: "推门" }, next: null } }),
    [],
  );
});

test("the shot-scoped prompt inlines the shot context and nothing wider", () => {
  const { context } = build();
  const text = compilePrompt(findSkill("image-prompt-director"), { shotContext: context });
  assert.match(text, /当前 Shot 上下文/);
  assert.match(text, /暗夜酒吧/);
  // the output contract travels with it, identically for every runtime
  assert.match(text, /"prompt"/);
  assert.match(text, /"assumptions"/);
});

test("a Skill Run records the CONTENT trace, not only the canon level (§3)", () => {
  const reg = createSkillRunRegistry(null);
  const { context, trace } = build();
  const rec = startRun(reg, {
    skillId: "image-prompt-director", skillVersion: 1, runtime: "manual", executor: "manual",
    inputKeys: ["shotContext"], inputSummary: summarize(context),
    context: { episodeId: "ep1", sceneId: "sc1", shotId: "sh01" },
    contextTrace: trace, createdAt: "2026-08-13T00:00:00Z",
  });
  assert.equal(rec.context.shotId, "sh01", "the ADR-0059 identity contract");
  assert.deepEqual(rec.contextTrace.characterIds, ["ch1/夜班"], "…and WHAT was read");
  // a project-wide run has no trace, and that is a fact rather than a gap
  const wide = startRun(reg, {
    skillId: "storyboard-director", skillVersion: 1, runtime: "manual", executor: "manual",
    inputKeys: ["episodeScript"], context: { episodeId: "ep1" }, createdAt: "2026-08-13T00:00:00Z",
  });
  assert.equal(wide.contextTrace, null);
});

/* ========================================================================= */
/* 7 · proposal → action (§12 / §13)                                          */
/* ========================================================================= */

test("§12 names eight proposal types, and every one maps to a real Action", () => {
  // addReference / replaceReference / removeReference / updateImagePrompt /
  // updateVideoPrompt / usePreviousShotEndFrame / prepareImageGeneration /
  // prepareVideoGeneration — the last four pairs share an action and differ by `kind`.
  for (const name of ["addReference", "replaceReference", "removeReference", "updatePrompt",
    "usePreviousShotEndFrame", "prepareGeneration", "setReferenceUse"]) {
    assert.ok(ACTIONS[name], `${name} must exist in the vocabulary`);
  }
  // a REAL swap needs to say what it replaces — that is the whole difference from add
  assert.deepEqual(ACTIONS.replaceReference.args, ["shotId", "referenceKey", "replacesKey"]);
  assert.equal(validate({ action: "replaceReference", shotId: "s", referenceKey: "b" }), "replaceReference 缺少参数：replacesKey");
  assert.equal(validate({ action: "addReference", shotId: "s", referenceKey: "b" }), null);
  assert.equal(validate({ action: "usePreviousShotEndFrame", shotId: "s" }), null);
});

test("the automation level is unchanged: an AI origin still cannot write (§13)", () => {
  assert.equal(CURRENT_LEVEL, "suggest");
  for (const name of ["addReference", "replaceReference", "updatePrompt", "usePreviousShotEndFrame"]) {
    assert.equal(allowedAt(name, { origin: "ai" }).ok, false, `${name} must need a human decision`);
    assert.equal(allowedAt(name, { origin: "user" }).ok, true);
  }
  // preparing a generation reads only, so it is allowed — it writes nothing
  assert.equal(allowedAt("prepareGeneration", { origin: "ai" }).ok, true);
});

test("a recommendation becomes bind / swap / use actions, and an unaddressable one is dropped (§4)", () => {
  const plan = planApply("shot-asset-recommender", {
    recommendations: [
      { referenceKey: "ref-linwan", reason: "本场出场人物" },
      { referenceKey: "ref-cam", reason: "运镜", use: "video" },
      { referenceKey: "ref-new", reason: "换一版", replacesKey: "ref-old" },
      { referenceKey: "ref-dup", reason: "第一次" },
      { referenceKey: "ref-dup", reason: "第二次" },        // same reference twice = one decision
      { referenceKey: "", reason: "无处可绑" },              // unaddressable
      { referenceKey: "ref-x" },                            // no reason
      { referenceKey: "ref-y", reason: "坏用途", use: "audio" }, // not a real side
    ],
  }, {
    shotId: "sh01",
    // the run's recorded permission — every key it may bind (ref-x / ref-old are
    // deliberately absent from the proposal's valid rows anyway)
    candidateKeys: ["ref-linwan", "ref-cam", "ref-new", "ref-dup", "ref-y"],
  });
  assert.ok(plan.ok);
  assert.deepEqual(plan.actions, [
    { action: "addReference", shotId: "sh01", referenceKey: "ref-linwan" },
    { action: "addReference", shotId: "sh01", referenceKey: "ref-cam" },
    { action: "setReferenceUse", shotId: "sh01", referenceKey: "ref-cam", use: "video" },
    { action: "replaceReference", shotId: "sh01", referenceKey: "ref-new", replacesKey: "ref-old" },
    { action: "addReference", shotId: "sh01", referenceKey: "ref-dup" },
    { action: "addReference", shotId: "sh01", referenceKey: "ref-y" },
  ]);
  // and with no shot there is nowhere to write it
  assert.equal(planApply("shot-asset-recommender", { recommendations: [{ referenceKey: "r", reason: "x" }] },
    { candidateKeys: ["r"] }).ok, false);
});

test("each Prompt Director writes ITS OWN kind, never the open tab's", () => {
  const img = planApply("image-prompt-director", { prompt: "IMG" }, { shotId: "sh01", genKind: "video" });
  assert.deepEqual(img.actions, [{ action: "updatePrompt", shotId: "sh01", kind: "image", text: "IMG" }]);
  const vid = planApply("video-prompt-director", { prompt: "VID" }, { shotId: "sh01", genKind: "image" });
  assert.deepEqual(vid.actions, [{ action: "updatePrompt", shotId: "sh01", kind: "video", text: "VID" }]);
  assert.equal(planApply("image-prompt-director", { prompt: "  " }, { shotId: "sh01" }).ok, false);
});

test("a review with no rewrite is REFUSED, not turned into a fake write (§9)", () => {
  const advice = planApply("prompt-reviewer", { issues: [{ where: "第 2 行", problem: "服装与状态不符" }] }, { shotId: "sh01" });
  assert.equal(advice.ok, false);
  assert.match(advice.error, /没有给出完整的改写版本/);
  // with a rewrite, it applies to the kind the RUN read
  const applied = planApply("prompt-reviewer", { issues: [], suggestedText: "FIXED" }, { shotId: "sh01", reviewKind: "video" });
  assert.deepEqual(applied.actions, [{ action: "updatePrompt", shotId: "sh01", kind: "video", text: "FIXED" }]);
});

test("Shot Continuity Reviewer stays READ-ONLY — there is no 「连续性」 document", () => {
  const app = applicability("shot-continuity-reviewer");
  assert.equal(app.can, false);
  assert.match(app.reason, /没有「连续性」这份 canonical 文档/);
  assert.equal(planApply("shot-continuity-reviewer", { issues: [] }, { shotId: "sh01" }).ok, false);
});

test("every shot-scoped capability either has a write path or says why not", () => {
  for (const s of SKILLS.filter(isShotScoped)) {
    const app = applicability(s.skillId);
    if (app.can) assert.equal(typeof app.detail, "string", `${s.skillId} must state WHERE it writes`);
    else assert.ok(app.reason && app.reason.length > 10, `${s.skillId} must state why it cannot`);
  }
});

/* ========================================================================= */
/* 8 · the PANEL (§2 / §18 / §19)                                             */
/* ========================================================================= */

test("the panel offers §2's operations, and only ones backed by a real capability", () => {
  const keys = OPERATIONS.map((o) => o.key);
  assert.deepEqual(keys, ["recommend", "imagePrompt", "reviewImage", "videoPrompt", "reviewVideo", "continuity"]);
  for (const op of OPERATIONS) {
    assert.ok(findSkill(op.skillId), `${op.key} names a capability that does not exist`);
    assert.ok(isShotScoped(findSkill(op.skillId)), `${op.key} must run against ONE shot`);
    assert.ok(op.hint && op.hint.length > 8, `${op.key} must say what it does`);
    if (op.gate) {
      // a gate must be a FIELD of the readiness model, not a re-derivation — the
      // button and the checklist can only agree by reading the same value
      assert.ok(op.gateReason, `${op.key} gates on ${op.gate} but states no reason`);
      const r = shotReadiness(build().context);
      assert.equal(typeof r[op.gate], "boolean", `${op.gate} is not a readiness field`);
    }
    if (op.scope) assert.ok(SCOPES.includes(op.scope), `${op.key} caches under an unknown scope`);
  }
  // the two reviews are the SAME capability on different sides — that is why each
  // must declare which prompt it reads, or both buttons would review one side
  assert.equal(OPERATIONS.find((o) => o.key === "reviewImage").needsPrompt, "image");
  assert.equal(OPERATIONS.find((o) => o.key === "reviewVideo").needsPrompt, "video");
});

test("exactly ONE next step is primary, and it walks the chain (§19)", () => {
  const p = (over, opts) => {
    const b = build(over, opts);
    return primaryOperation(shotReadiness(b.context), b.context);
  };
  const img = { list: [{ version: 1, url: "b", assetId: "i1", current: true, origin: "上传" }] };
  const vid = { list: [{ version: 1, url: "b", assetId: "v1", current: true, origin: "上传" }] };
  const PV = (i, v) => ({ prompts: { image: { version: i ? 1 : null, text: i || null, locked: false }, video: { version: v ? 1 : null, text: v || null, locked: false } } });
  // nothing yet → write the Image Prompt
  assert.equal(p({}), "imagePrompt");
  // …unless the shot cannot support one, in which case go find references first
  assert.equal(p({ scene: { sceneId: "sc1", title: "S01", characters: [], location: null } }), "recommend");
  // prompt written, no image yet → review it while you are here
  assert.equal(p({}, PV("P", null)), "reviewImage");
  // image selected → the Video Prompt becomes possible
  assert.equal(p({ images: img }, PV("P", null)), "videoPrompt");
  // video prompt written, no video yet → review it
  assert.equal(p({ images: img }, PV("P", "V")), "reviewVideo");
  // done → continuity is what is left worth doing
  assert.equal(p({ images: img, videos: vid }, PV("P", "V")), "continuity");
  assert.equal(primaryOperation(null, null), null);
});

test("the panel renders derived facts, an unavailable reason, and no fabricated copy", () => {
  const b = build();
  const r = shotReadiness(b.context);
  const m = {
    empty: false, shotId: "sh01", context: b.context, trace: b.trace, readiness: r,
    primary: "imagePrompt",
    ops: OPERATIONS.map((o) => ({
      ...o, version: 1, role: "x",
      available: o.key === "imagePrompt" || o.key === "recommend",
      unavailable: o.key === "imagePrompt" || o.key === "recommend" ? null : "还没有 Image Prompt 可审",
      missing: [], open: null, pending: null, last: null, cached: null,
    })),
    executors: [{ id: "manual", title: "手工（外部网页）", runtime: "manual", goodAt: "任何能力", state: "ready", stateLabel: "可用", runnable: true, detail: "" }],
    chosen: { id: "manual", title: "手工（外部网页）", stateLabel: "可用", runnable: true, detail: "" },
    probed: true, pending: null, openRun: null,
  };
  const html = renderShotDirector(m, {});
  // the verdict and the shot it is about
  assert.match(html, /擦杯子/);
  assert.match(html, /可以生成 Image Prompt/);
  // the primary operation is a real button; an unavailable one states its reason
  assert.match(html, /data-sd-op="imagePrompt"/);
  assert.match(html, /还没有 Image Prompt 可审/);
  assert.ok(!/data-sd-op="reviewImage"/.test(html), "an unavailable operation is not a pressable button");
  // the CONTEXT SNAPSHOT is present, and it is the real ids
  assert.match(html, /ch1\/夜班/);
  assert.match(html, /lo1\/打烊后/);
  // …behind a <details>, because the surface is 「现在怎么办」 (§18)
  assert.match(html, /<details class="sd-det adv"/);
  // no shot selected → it says so rather than rendering an empty shell
  assert.match(renderShotDirector({ empty: true }, {}), /先在上面选一个镜头/);
  assert.match(renderShotDirector({ empty: true, unresolved: true }, {}), /已不在当前草稿版本里/);
});

test("an unprobed runtime is reported as unprobed, never as available (§14)", () => {
  const b = build();
  const m = {
    empty: false, shotId: "sh01", context: b.context, trace: b.trace,
    readiness: shotReadiness(b.context), primary: null, ops: [],
    executors: [{ id: "claude-code", title: "Claude Code", runtime: "local_subscription", goodAt: "创作", state: null, stateLabel: "未探测", runnable: false, detail: "" }],
    chosen: null, probed: false, pending: null, openRun: null,
  };
  const html = renderShotDirector(m, { sdAdv: true });
  assert.match(html, /未探测/);
  assert.match(html, /绝不假设可用/);
});

/* ========================================================================= */
/* 9 · what the Connected acceptance caught (real-project findings)            */
/* ========================================================================= */

test("a Prompt Review with NO rewrite offers no 「应用」 — the button would fail on press", () => {
  // Found on 夜班沉默: `applicability` answers about the CAPABILITY, and prompt-reviewer
  // CAN write in general — but this particular answer has nothing to write, so the
  // panel was offering a button that `planApply` then refused.
  const advice = { issues: [{ where: "第 2 行", problem: "缺服装" }] };
  const rewrite = { issues: [], suggestedText: "改写后的整段 Prompt" };
  assert.equal(applicability("prompt-reviewer").can, true, "the capability can write, in general");
  assert.equal(applicabilityFor("prompt-reviewer", advice).can, false, "…this answer cannot");
  assert.match(applicabilityFor("prompt-reviewer", advice).reason, /没有给出完整的改写版本/);
  assert.equal(applicabilityFor("prompt-reviewer", rewrite).can, true);
  // and the panel's own refusal agrees with the applier's, so the two cannot drift
  assert.equal(planApply("prompt-reviewer", advice, { shotId: "sh01" }).ok, false);
  assert.equal(planApply("prompt-reviewer", rewrite, { shotId: "sh01" }).ok, true);
  // a capability with a proposal-independent answer is unchanged
  assert.equal(applicabilityFor("image-prompt-director", { prompt: "x" }).can, true);
  assert.equal(applicabilityFor("shot-continuity-reviewer", { issues: [] }).can, false);
  // …and with no proposal to judge, the static answer stands
  assert.deepEqual(applicabilityFor("prompt-reviewer", null), applicability("prompt-reviewer"));
});

test("the panel shows the NEWEST open run, so a stuck one cannot hold the slot", () => {
  // Found on 夜班沉默, which had runs stuck in `running` from abandoned sessions.
  // Ordering by OPERATION put the oldest leftover in the only open-run slot, so every
  // answer pasted afterwards was validated against THAT capability's schema and
  // rejected — while the run the creator had just started stayed unreachable.
  const b = build();
  const runOf = (skillId, at, extra = {}) => ({
    skillRunId: `run-${skillId}-${at}`, skillId, skillVersion: 1, status: "running",
    runtime: "manual", executor: "manual", createdAt: at, proposal: null,
    context: { episodeId: "ep1", sceneId: "sc1", shotId: "sh01" }, contextTrace: { shotId: "sh01", ...extra },
  });
  const ctx = {
    shotctx: {
      build: () => b,
      readiness: () => shotReadiness(b.context),
      cached: () => null,
      candidates: () => ({ candidates: [], byRole: {}, bound: [], truncated: 0 }),
    },
    skills: {
      find: (id) => findSkill(id),
      missing: () => [],
      inputLabel: (k) => k,
      executors: () => [{ id: "manual", title: "手工（外部网页）", runtime: "manual", goodAt: "任何能力" }],
      // an OLD recommender run (first in operation order) and a NEW image-prompt run
      runs: () => [runOf("shot-asset-recommender", "2026-08-01T00:00:00Z"), runOf("image-prompt-director", "2026-08-13T00:00:00Z")],
    },
  };
  const m = shotDirectorModel(ctx, { selectedShotId: "sh01", skillExecutor: "manual" }, { manual: { state: "ready", detail: "" } });
  assert.equal(m.openRun.skillId, "image-prompt-director", "the run the creator just started is the one on screen");
  assert.deepEqual(m.otherOpen.map((r) => r.skillId), ["shot-asset-recommender"], "the leftover is still reported…");
  const html = renderShotDirector(m, {});
  // …by NAME, and it can be abandoned — before this round nothing could clear it
  assert.match(html, /生成 Image Prompt/, "the open box says which capability it is waiting for");
  assert.match(html, /data-sd-abandon="run-shot-asset-recommender-2026-08-01T00:00:00Z"/);
  assert.match(html, /另有 1 次运行也在等答案/);
});

/* ========================================================================= */
/* 10 · codex review round 1 (real findings, guarded)                         */
/* ========================================================================= */

test("a recommendation OUTSIDE the run's candidate set is refused (ADR-0064 决策 4)", () => {
  // codex round 1, P1: the applier only checked 「this key exists in the registry」, so a
  // model could name ANY registered asset — another character's portrait included — and
  // it would be bound. The candidate set constrained what the model was SHOWN, not what
  // it was allowed to say.
  const proposal = {
    recommendations: [
      { referenceKey: "ref-allowed", reason: "本场出场人物" },
      { referenceKey: "ref-elsewhere", reason: "看起来也不错" },   // never offered
    ],
  };
  const scoped = planApply("shot-asset-recommender", proposal, {
    shotId: "sh01", candidateKeys: ["ref-allowed", "ref-other"],
  });
  assert.ok(scoped.ok);
  assert.deepEqual(scoped.actions, [{ action: "addReference", shotId: "sh01", referenceKey: "ref-allowed" }]);
  assert.match(scoped.dropped, /1 条推荐不在候选集里/, "dropped items are reported, never silently omitted");
  // ALL of them off-candidate ⇒ nothing is applied, and it says why
  const none = planApply("shot-asset-recommender", proposal, { shotId: "sh01", candidateKeys: ["ref-nope"] });
  assert.equal(none.ok, false);
  assert.match(none.error, /都不在这次运行看到的候选集里/);
  // no recorded candidate set (an older run) ⇒ REFUSED. Treating it as 「everything is
  // allowed」 was a fail-open — see the round-2 guard below.
  const legacy = planApply("shot-asset-recommender", proposal, { shotId: "sh01" });
  assert.equal(legacy.ok, false);
});

test("the trace records WHICH candidates the run was allowed to pick from", () => {
  const { context } = build();
  const t = shotctx_traceOf(context, { candidateKeys: ["ref-a", "ref-b", ""] });
  assert.deepEqual(t.candidateKeys, ["ref-a", "ref-b"], "blank keys are not permissions");
  // a run given no candidate set records null — a fact about the run, not an empty
  // permission list
  assert.equal(traceOf(context).candidateKeys, null);
});

test("the revision covers the NEIGHBOURS' content and the project canon, not just ids", () => {
  // codex round 1, non-blocking → escalated to P2: it is the same defect class as the
  // `readingVersion` bug this file's own guards caught. A continuity summary is drawn
  // from the neighbour's TEXT and an image prompt from the project's visual direction,
  // so a change to either must make a cached conclusion stale.
  const prevWith = (desc) => detail({
    shot: { ...detail().shot, shotId: "sh00", seq: 1, description: desc },
    frames: { start: null, end: null },
  });
  const rev = (over, opts, scope = "continuitySummary") => {
    const b = build(over, opts);
    return contextRevision(b.trace, scope);
  };
  const a = rev({}, { neighbours: { prev: prevWith("门被推开") } });
  const bb = rev({}, { neighbours: { prev: prevWith("门被撞开，玻璃碎了") } });
  assert.notEqual(bb, a, "re-writing the previous shot must invalidate a conclusion drawn from it");
  // …and the project's visual direction
  const canonA = buildShotContext({ detail: detail(), place: PLACE, canon: CANON });
  const canonB = buildShotContext({
    detail: detail(), place: PLACE, canon: { ...CANON, worldVisualTone: "晴天与暖色" },
  });
  assert.notEqual(
    contextRevision(canonB.trace, "promptReview"),
    contextRevision(canonA.trace, "promptReview"),
    "the visual direction compiles INTO the prompt, so changing it invalidates a review of it",
  );
  // identical inputs still produce an identical revision — the point is sensitivity to
  // real change, not churn
  assert.equal(rev({}, { neighbours: { prev: prevWith("门被推开") } }), a);
});

/* ========================================================================= */
/* 11 · WHO RUNS WHAT — Claude Code 执行 / Codex 审阅 (§14)                    */
/* ========================================================================= */

test("every capability declares the KIND of work it does, and review is review", () => {
  for (const s of SKILLS) {
    assert.ok(WORK_KINDS.includes(s.work), `${s.skillId} must declare creative|review`);
  }
  const review = SKILLS.filter((s) => s.work === "review").map((s) => s.skillId).sort();
  assert.deepEqual(review, [
    "asset-librarian", "continuity-reviewer", "prompt-reviewer",
    "script-doctor", "shot-continuity-reviewer", "subtitle-reviewer",
  ], "a reviewer produces findings ABOUT existing content, never new content");
  // the two capabilities this round added for reviewing are review; the two that
  // WRITE prompts are creative — that split is what §14's division rests on
  assert.equal(findSkill("prompt-reviewer").work, "review");
  assert.equal(findSkill("shot-continuity-reviewer").work, "review");
  assert.equal(findSkill("image-prompt-director").work, "creative");
  assert.equal(findSkill("video-prompt-director").work, "creative");
  assert.equal(findSkill("shot-asset-recommender").work, "creative");
});

test("Codex is suggested for REVIEW only — never the creative director (§14)", () => {
  const all = () => true;                       // everything installed
  assert.equal(suggestExecutor("creative", all), "claude-code");
  assert.equal(suggestExecutor("review", all), "codex-cli");
  // …and that is a SUGGESTION: the creator's own runnable pick always wins, in
  // BOTH directions (ADR-0056 决策 1 — no capability is bound to an executor)
  assert.equal(suggestExecutor("review", all, "claude-code"), "claude-code");
  assert.equal(suggestExecutor("creative", all, "codex-cli"), "codex-cli");
  // a pick that is NOT runnable is not honoured — it would only produce a failed run
  assert.equal(suggestExecutor("creative", (id) => id !== "codex-cli", "codex-cli"), "claude-code");
  // with codex absent, review falls back to manual rather than to Claude Code:
  // 「独立复核」 by the same runtime that wrote it is not independent
  assert.equal(suggestExecutor("review", (id) => id === "claude-code" || id === "manual"), "manual");
  // nothing installed at all ⇒ manual, which needs nothing
  assert.equal(suggestExecutor("creative", (id) => id === "manual"), "manual");
  assert.equal(suggestExecutor("review", () => false), "manual");
  // an unknown work kind is treated as creative rather than throwing
  assert.equal(suggestExecutor("nonsense", all), "claude-code");
});

test("the panel shows WHICH executor each operation would use, before the press", () => {
  const b = build();
  const probe = {
    "claude-code": { state: "installed", detail: "" },
    "codex-cli": { state: "installed", detail: "" },
    manual: { state: "ready", detail: "" },
  };
  const ctx = {
    shotctx: {
      build: () => b,
      readiness: () => shotReadiness(b.context),
      cached: () => null,
      candidates: () => ({ candidates: [], byRole: {}, bound: [], truncated: 0 }),
    },
    skills: { find: (id) => findSkill(id), missing: () => [], inputLabel: (k) => k, runs: () => [], executors: () => EXECUTORS },
  };
  const m = shotDirectorModel(ctx, { selectedShotId: "sh01" }, probe);
  const by = Object.fromEntries(m.ops.map((o) => [o.key, o.executorId]));
  assert.equal(by.imagePrompt, "claude-code", "写 Prompt 是创作 → Claude Code");
  assert.equal(by.recommend, "claude-code");
  assert.equal(by.reviewImage, "codex-cli", "审核是复核 → Codex");
  assert.equal(by.continuity, "codex-cli");
  // the name is ON the button, and the handler carries it so the click cannot run
  // on a different subscription than the one advertised
  const html = renderShotDirector(m, {});
  assert.match(html, /data-sd-op="imagePrompt" data-exec="claude-code"/);
  assert.match(html, /Codex CLI/);
  // with codex NOT installed, review moves to manual and says so — it never silently
  // falls back to the runtime that wrote the thing being reviewed
  const noCodex = shotDirectorModel(ctx, { selectedShotId: "sh01" },
    { ...probe, "codex-cli": { state: "unavailable", detail: "not installed" } });
  assert.equal(noCodex.ops.find((o) => o.key === "reviewImage").executorId, "manual");
  assert.equal(noCodex.ops.find((o) => o.key === "imagePrompt").executorId, "claude-code");
});

/* ========================================================================= */
/* 12 · codex batch review round 1                                            */
/* ========================================================================= */

test("a run with NO recorded candidate set is REFUSED, not allowed everything (P1)", () => {
  // The first version of the guard treated a missing list as 「no constraint」 and
  // applied every recommendation — a fail-OPEN. A legacy run (created before the
  // trace carried candidateKeys) or a malformed one could then bind any registered
  // reference at all, which is the boundary the guard exists to hold.
  const proposal = { recommendations: [{ referenceKey: "ref-anything", reason: "x" }] };
  const noList = planApply("shot-asset-recommender", proposal, { shotId: "sh01" });
  assert.equal(noList.ok, false);
  assert.match(noList.error, /没有记录它当时看到的候选集/);
  // an EMPTY recorded set is a real permission (「什么都不许」), not a missing one
  const emptyList = planApply("shot-asset-recommender", proposal, { shotId: "sh01", candidateKeys: [] });
  assert.equal(emptyList.ok, false);
  assert.match(emptyList.error, /都不在这次运行看到的候选集里/);
  // …and a recorded set still works
  const ok2 = planApply("shot-asset-recommender", proposal, { shotId: "sh01", candidateKeys: ["ref-anything"] });
  assert.equal(ok2.ok, true);
});

test("changing the CANDIDATE SET makes a cached recommendation stale — and only that scope", () => {
  // codex review round 2 (non-blocking → P2): registering a new character reference
  // changes what could have been recommended, so a recommendation drawn from the old
  // set no longer applies. It must NOT churn the other scopes: uploading an unrelated
  // reference is no reason for a continuity summary to go stale.
  const { context } = build();
  const t1 = traceOf(context, { candidateKeys: ["ref-a", "ref-b"] });
  const t2 = traceOf(context, { candidateKeys: ["ref-a", "ref-b", "ref-c"] });
  assert.notEqual(
    contextRevision(t2, "assetRecommendation"),
    contextRevision(t1, "assetRecommendation"),
    "a new eligible asset invalidates the recommendation",
  );
  assert.equal(
    contextRevision(t2, "continuitySummary"),
    contextRevision(t1, "continuitySummary"),
    "…but not the continuity summary, which does not read the candidate set",
  );
  assert.equal(
    contextRevision(t2, "promptReview"),
    contextRevision(t1, "promptReview"),
  );
  // identical sets still produce identical revisions
  assert.equal(
    contextRevision(traceOf(context, { candidateKeys: ["ref-a", "ref-b"] }), "assetRecommendation"),
    contextRevision(t1, "assetRecommendation"),
  );
});

test("the Video Prompt writer is told what the first frame LOOKS like, or that it cannot know", () => {
  // codex review round 3: 「以所附图片为第 1 帧，保持完全一致」 is an assertion about an
  // image the writer never sees — the runtime carries TEXT only (ADR-0056 决策 2), and
  // the picture goes to the external tool. The textual answer that DOES exist is the
  // prompt that produced that exact take.
  const s = findSkill("video-prompt-director");
  assert.match(s.instruction, /你看不到那张图本身/);
  assert.match(s.instruction, /fromPrompt/);
  assert.match(s.instruction, /不要假装知道画面细节/,
    "an imported frame with no generation record must not be described from imagination");
  // and the input gate still refuses without a selected frame at all
  const { context } = build();
  assert.deepEqual(missingInputs(s, { shotContext: context, selectedShotImage: null }), ["selectedShotImage"]);
});

test("image and video prompt reviews are separate conclusions, not one shared key", () => {
  // codex review round 4: both draw on the `promptReview` scope, but they are
  // reviews OF DIFFERENT PROMPTS. Sharing one key let the video review overwrite the
  // image one — and the image panel would then display the video review as its own.
  const c = createCache(null);
  assert.notEqual(cacheKey("promptReview", "sh01", "image"), cacheKey("promptReview", "sh01", "video"));
  put(c, { scope: "promptReview", shotId: "sh01", variant: "image", baselineRevision: "r1", value: { v: "img" } });
  put(c, { scope: "promptReview", shotId: "sh01", variant: "video", baselineRevision: "r1", value: { v: "vid" } });
  assert.equal(c.length, 2, "one must not evict the other");
  assert.equal(get(c, { scope: "promptReview", shotId: "sh01", variant: "image", currentRevision: "r1" }).value.v, "img");
  assert.equal(get(c, { scope: "promptReview", shotId: "sh01", variant: "video", currentRevision: "r1" }).value.v, "vid");
  // a shot leaving the draft still forgets BOTH — forgetShot matches on shotId
  forgetShot(c, "sh01");
  assert.equal(c.length, 0);
});

test("a manual run hands back the prompt it was LAUNCHED with, not a recompile", () => {
  // codex review round 4: a manual run stays open while the creator keeps working.
  // Recompiling at copy time would ask a different question than the one
  // `contextTrace` records this run as having asked.
  const reg = [];
  const r = startRun(reg, {
    skillId: "image-prompt-director", skillVersion: 1, executor: "manual",
    promptText: "问题的原文", contextTrace: { shotRevision: "r1" },
  });
  assert.equal(r.promptText, "问题的原文");
  // and a run started before this existed carries null rather than a fake original
  const old = startRun(reg, { skillId: "image-prompt-director", skillVersion: 1 });
  assert.equal(old.promptText, null);
});

test("a run is matched to its operation by which prompt it reviewed, never by skillId alone", () => {
  // codex review round 5: 图片 Prompt 审核 and 视频 Prompt 审核 share `prompt-reviewer`.
  // Matching on skillId returns whichever is declared first, so a manually-submitted
  // VIDEO review was being filed under the IMAGE cache variant — the exact collision
  // round 4's variant fix existed to prevent.
  const shared = OPERATIONS.filter((o) => o.skillId === "prompt-reviewer");
  assert.equal(shared.length, 2, "two operations share one skill — that is the trap");
  assert.deepEqual(shared.map((o) => o.needsPrompt).sort(), ["image", "video"]);

  const runFor = (kind) => ({ skillId: "prompt-reviewer", contextTrace: { reviewedPromptKind: kind } });
  assert.equal(operationOfRun(runFor("video")).needsPrompt, "video");
  assert.equal(operationOfRun(runFor("image")).needsPrompt, "image");
  // an old run that never recorded which side it read is UNMATCHED, not guessed —
  // guessing would file it under a variant it may not belong to
  assert.equal(operationOfRun({ skillId: "prompt-reviewer", contextTrace: null }), null);
  assert.equal(operationOfRun(null), null);
  // a single-operation skill still resolves without any trace
  assert.ok(operationOfRun({ skillId: "shot-asset-recommender", contextTrace: null }));
});

// TASK-065 — 创作对象优先 (creator-object-first IA).
//
// What is pinned here, and why each one is a rule rather than a detail:
//
//   1. 基础资产 are READ from the existing bible + registry — no second store.
//      A state's own reference list is distinguished from an INHERITED one,
//      because 「跟基础设定一致」 and 「这个状态没有参考图」 are different facts and
//      only the second is a gap.
//   2. A base prompt reuses promptdoc under a NAMESPACED key that cannot collide
//      with a shotId — a collision would serve a character's prompt for a shot.
//   3. The suggested reference name is DERIVED and always editable — nothing is
//      registered under a name nobody confirmed.
//   4. 人物 has THREE tabs; 场景地 / 声音 / 风格 are gone from it (§3) and 场景地
//      lives in 世界观 (§4). Nothing was DELETED — the removed tabs' data is
//      edited on the card that owns it.
//   5. The current Shot Production Graph is a CROSSING network: a style
//      reference feeds both prompts, each video take points at the image version
//      its own generation records, and an unread directing reference is not
//      「ready」.
//   6. A / B are kept apart (§10): 已有可复用基础资产 vs 当前 Shot 还需要补充.
//   7. Every graph node opens the LEFT inspector (§12) — a gap placeholder opens
//      nothing, so a click cannot point the next WRITE at an object that is not
//      there.
//   8. The inspector has NO function tab strip (§8) and its reference list never
//      hides a recommendation (§11).
//   9. AI only PROPOSES relationships: an unaddressable or empty proposal is
//      refused rather than applied to a neighbour (§2).
import test from "node:test";
import assert from "node:assert/strict";

import * as bd from "../src/workflow/bibledoc.js";
import * as pdoc from "../src/workflow/proddoc.js";
import * as cd from "../src/workflow/canondoc.js";
import { compileEntityBasePrompt } from "../src/workflow/promptc.js";
import {
  basePromptKey, suggestReferenceName, baseAssetsModel, entityBaseAssets,
  findBaseAssets, BASE_REFERENCE_KIND,
} from "../src/workflow/baseassets.js";
import { relationshipGraph, conflictWeight, nodePosition } from "../src/workflow/relgraph.js";
import { renderRelWs } from "../src/ui/relws.js";
import { shotProductionGraph, inspectFromShotNode, BAND_KEYS, STAGES } from "../src/workflow/shotgraph.js";
import * as refuse from "../src/workflow/refuse.js";
import { planApply, applicability } from "../src/workflow/skillapply.js";
import { ACTIONS } from "../src/workflow/actions.js";
import { TABS as BIBLE_TABS } from "../src/ui/biblews.js";
import { WORLD_TABS } from "../src/ui/worldws.js";
import { currentPlace, showsFocus, renderEpProd } from "../src/ui/epprod.js";
import { renderShotGraph, renderStages } from "../src/ui/shotgraphview.js";
import { renderInspector } from "../src/ui/prodinspector.js";

/* ========================================================================= */
/* helpers                                                                   */
/* ========================================================================= */

const snap = (prod, extra = {}) => ({
  production: prod,
  assetUploads: {},
  media: { video: {}, audio: {} },
  firstFrames: {},
  finals: [],
  paidOps: {},
  generations: [],
  draftShots: [],
  assets: { images: {}, videos: {}, audio: {}, finals: [] },
  timelines: {},
  refInterp: null,
  frameBindings: null,
  ...extra,
});

/** A chain map entry in the shape mediaref/assetreg produce. */
const chain = (key, history) => ({ [key]: { current: history[history.length - 1].version, history } });

const ref = (assetId, version, over = {}) => ({
  assetId, version, url: `blob:${assetId}`, origin: "upload", storageState: "local",
  kind: "character-reference", displayName: null, links: {}, tags: [], reusable: false,
  ...over,
});

/* ========================================================================= */
/* 1 · 基础资产 are DERIVED, and a state's own list ≠ an inherited one         */
/* ========================================================================= */

test("entityBaseAssets: base refs, per-state refs, and INHERITED is not a gap", () => {
  const prod = pdoc.createProduction(null);
  const c = bd.addCharacter(prod, "林婉");
  bd.updateCharacterProfile(prod, c.characterId, { appearance: "短发", visualInstruction: "冷色调" });
  const daily = bd.addCharacterState(prod, c.characterId, "日常");
  const young = bd.addCharacterState(prod, c.characterId, "少女时期");
  bd.addReferenceAsset(prod, c.characterId, "a1");
  bd.setActiveReferenceAsset(prod, c.characterId, "a1");
  // 少女时期 gets its OWN list; 日常 keeps inheriting
  bd.setCharacterStateOverrides(prod, c.characterId, young.stateId, {
    referenceAssetIds: ["a2"], activeReferenceAssetId: "a2",
  });
  const images = { ...chain("ref-1", [ref("a1", 1, { displayName: "林婉 / 日常" })]), ...chain("ref-2", [ref("a2", 1, { displayName: "林婉 / 少女时期" })]) };
  const m = baseAssetsModel(snap(prod, { assetUploads: images }));
  const one = findBaseAssets(m, c.characterId);
  assert.equal(one.kind, "character");
  assert.equal(one.referenceKind, BASE_REFERENCE_KIND.character);
  assert.equal(one.refs.length, 1);
  assert.equal(one.refs[0].name, "林婉 / 日常");
  assert.equal(one.refs[0].active, true);
  assert.equal(one.heroRef.assetId, "a1");
  const byId = Object.fromEntries(one.states.map((s) => [s.stateId, s]));
  // INHERITED: shows the base list, and is NOT reported as a gap
  assert.equal(byId[daily.stateId].inherited, true);
  assert.deepEqual(byId[daily.stateId].refs.map((r) => r.assetId), ["a1"]);
  // OWN list: its own reference, its own active pointer
  assert.equal(byId[young.stateId].inherited, false);
  assert.deepEqual(byId[young.stateId].refs.map((r) => r.assetId), ["a2"]);
  assert.equal(byId[young.stateId].refs[0].active, true);
  assert.ok(!one.gaps.some((g) => g.includes("日常")), "an inherited state is not a gap");
  // the only gap left is the base voice — a portrait is there, a voice is not
  assert.deepEqual(one.gaps, ["还没有 Base Voice"]);
});

test("entityBaseAssets: an OWN state list with no resolvable asset IS a gap", () => {
  const prod = pdoc.createProduction(null);
  const c = bd.addCharacter(prod, "林婉");
  const st = bd.addCharacterState(prod, c.characterId, "受伤状态");
  bd.setCharacterStateOverrides(prod, c.characterId, st.stateId, { referenceAssetIds: ["gone"] });
  bd.addReferenceAsset(prod, c.characterId, "a1");
  const m = baseAssetsModel(snap(prod, { assetUploads: chain("ref-1", [ref("a1", 1)]) }));
  const one = findBaseAssets(m, c.characterId);
  // the reference is KEPT and marked, never dropped — a bible reference legitimately
  // outlives its media bytes (M7)
  assert.equal(one.states[0].refs[0].missing, true);
  assert.ok(one.gaps.some((g) => g.includes("受伤状态")));
});

test("entityBaseAssets: the base voice sample is found by LINK, not by voiceId", () => {
  const prod = pdoc.createProduction(null);
  const c = bd.addCharacter(prod, "林婉");
  // `voiceId` is the identity string local TTS needs — it is NOT a media key, and
  // overwriting it with one would break dialogue generation for this character
  bd.setCharacterVoice(prod, c.characterId, { voiceId: "zh_CN-huayan-medium" });
  const audio = chain("basevoice-1", [ref("v1", 1, {
    kind: "voice-reference", links: { characterId: c.characterId }, at: "2026-08-12T00:00:00Z",
  })]);
  const m = baseAssetsModel(snap(prod, { media: { video: {}, audio } }));
  const one = findBaseAssets(m, c.characterId);
  assert.equal(one.voice.voiceId, "zh_CN-huayan-medium");
  assert.equal(one.voice.sample.assetId, "v1");
  assert.deepEqual(one.gaps, ["还没有人物参考图"]); // the voice is NOT a gap
  // a take linked to somebody else is not this character's voice
  const other = baseAssetsModel(snap(prod, {
    media: { video: {}, audio: chain("basevoice-1", [ref("v1", 1, { kind: "voice-reference", links: { characterId: "else" } })]) },
  }));
  assert.equal(findBaseAssets(other, c.characterId).voice.sample, null);
});

test("baseAssetsModel: locations get the same four things, and no voice", () => {
  const prod = pdoc.createProduction(null);
  const l = bd.addLocation(prod, "暗夜酒吧");
  bd.updateLocationProfile(prod, l.locationId, { description: "潮湿", visualInstruction: "霓虹" });
  const m = baseAssetsModel(snap(prod));
  const one = findBaseAssets(m, l.locationId);
  assert.equal(one.kind, "location");
  assert.equal(one.voice, null, "a location has no voice — an empty voice block would be a dead control");
  assert.deepEqual(one.gaps, ["还没有场景参考图"]);
  assert.equal(one.promptKey, `base:location:${l.locationId}`);
});

test("baseAssetsModel: no production document → empty, never a fabricated shell", () => {
  assert.equal(baseAssetsModel(snap(null)).empty, true);
  assert.equal(findBaseAssets({ empty: true }, "x"), null);
});

/* ========================================================================= */
/* 2 · the base prompt key cannot collide with a shot's                       */
/* ========================================================================= */

test("basePromptKey: namespaced, state-aware, and refused for a bad kind", () => {
  assert.equal(basePromptKey("character", "char-1"), "base:character:char-1");
  assert.equal(basePromptKey("character", "char-1", "cstate-9"), "base:character:char-1|cstate-9");
  assert.equal(basePromptKey("location", "loc-1"), "base:location:loc-1");
  // an entity key must never be able to equal a shotId — nothing mints a shotId
  // starting with `base:`, and this is the only writer of that prefix
  assert.ok(basePromptKey("character", "sh01").startsWith("base:"));
  assert.equal(basePromptKey("nonsense", "x"), null);
  assert.equal(basePromptKey("character", ""), null);
});

/* ========================================================================= */
/* 3 · the base prompt compiles from the ONE resolver, and gaps are honest    */
/* ========================================================================= */

test("compileEntityBasePrompt: a STATE is the same person, merged by the resolver", () => {
  const prod = pdoc.createProduction(null);
  const c = bd.addCharacter(prod, "林婉");
  bd.updateCharacterProfile(prod, c.characterId, {
    appearance: "短发，左眉疤", costume: "黑色风衣", visualInstruction: "冷色调，低角度",
    personality: "克制",
  });
  const young = bd.addCharacterState(prod, c.characterId, "少女时期");
  bd.setCharacterStateOverrides(prod, c.characterId, young.stateId, { costume: "校服" });
  const base = compileEntityBasePrompt({ kind: "character", entity: bd.resolveCharacter(c, null), tone: "都市悬疑" });
  assert.ok(base.text.includes("【风格】都市悬疑"));
  assert.ok(base.text.includes("林婉"));
  assert.ok(base.text.includes("黑色风衣"));
  assert.deepEqual(base.missing, []);
  const st = compileEntityBasePrompt({ kind: "character", entity: bd.resolveCharacter(c, young.stateId) });
  assert.ok(st.text.includes("林婉（少女时期）"));
  assert.ok(st.text.includes("校服"), "the state's override reached the prompt");
  assert.ok(!st.text.includes("黑色风衣"), "…and replaced the base costume rather than joining it");
  // the personality is NEVER state-overridden — the same person
  assert.ok(st.text.includes("克制"));
});

test("compileEntityBasePrompt: an absent facet is a stated GAP, never a plausible default", () => {
  const prod = pdoc.createProduction(null);
  const c = bd.addCharacter(prod, "无名");
  const out = compileEntityBasePrompt({ kind: "character", entity: bd.resolveCharacter(c, null) });
  assert.equal(out.missing.length, 2);
  assert.ok(out.missing.some((x) => x.includes("外貌")));
  assert.ok(out.missing.some((x) => x.includes("画面指令")));
  // nothing was invented to fill the hole
  assert.ok(!/一位|女性|男性/.test(out.text));
  const l = bd.addLocation(prod, "医院走廊");
  const lo = compileEntityBasePrompt({ kind: "location", entity: bd.resolveLocation(l, null), worldTone: "冷白光" });
  assert.ok(lo.text.includes("【风格】冷白光"));
  assert.ok(lo.text.includes("无人物"), "a location plate is empty of people by construction");
  assert.equal(lo.missing.length, 2);
  assert.deepEqual(compileEntityBasePrompt({ kind: "character", entity: null }).missing, ["没有可编译的对象"]);
});

/* ========================================================================= */
/* 4 · the suggested name is DERIVED and only ever a suggestion               */
/* ========================================================================= */

test("suggestReferenceName: entity + state, with a stable default state word", () => {
  assert.equal(suggestReferenceName({ entityName: "林婉", stateName: "少女时期" }), "林婉 / 少女时期");
  assert.equal(suggestReferenceName({ entityName: "林婉" }), "林婉 / 日常");
  assert.equal(suggestReferenceName({ entityName: "林婉", seq: 2 }), "林婉 / 日常 2");
  // no entity → no suggestion, rather than a name made of nothing
  assert.equal(suggestReferenceName({ entityName: "" }), "");
  assert.equal(suggestReferenceName({}), "");
});

/* ========================================================================= */
/* 5 · 人物 = 三个页签; 场景地 moved to 世界观                                  */
/* ========================================================================= */

test("人物 has exactly 正式 / 临时 / 人物关系 — 场景地 · 声音 · 风格 are gone (§3)", () => {
  assert.deepEqual(BIBLE_TABS.map((t) => t[0]), ["characters", "bits", "relationships"]);
  for (const gone of ["locations", "voices", "style"]) {
    assert.ok(!BIBLE_TABS.some((t) => t[0] === gone), `${gone} must not be a 人物 tab`);
  }
});

test("世界观 owns the Location archive now (§4)", () => {
  assert.deepEqual(WORLD_TABS.map((t) => t[0]), ["world", "locations"]);
});

/* ========================================================================= */
/* 6 · 人物关系图                                                              */
/* ========================================================================= */

test("relationshipGraph: layout is DETERMINISTIC and derived from cast position", () => {
  // same cast → same picture, every render and every reload. A stored layout could
  // disagree with the cast; a random one could not be reasoned about at all.
  const a = nodePosition(0, 3);
  assert.deepEqual(nodePosition(0, 3), a);
  assert.notDeepEqual(nodePosition(1, 3), a);
  // one character sits in the middle rather than at 12 o'clock with an empty canvas
  const solo = nodePosition(0, 1);
  assert.deepEqual(nodePosition(0, 1), solo);
});

test("conflictWeight: derived from what is WRITTEN, and 0 when nothing is", () => {
  const blank = { coreConflict: "", tension: "", forbidden: "" };
  assert.equal(conflictWeight(blank), 0);
  assert.equal(conflictWeight({ ...blank, tension: "未说出口" }), 1);
  assert.equal(conflictWeight({ ...blank, coreConflict: "录音" }), 2);
  assert.equal(conflictWeight({ coreConflict: "录音", tension: "忌惮", forbidden: "不能相爱" }), 4);
});

test("relationshipCurrentState: an UNRESOLVABLE episode is unknown, never the finale", () => {
  // codex review round 3: falling back to the last episode for an unknown episodeId
  // makes a stale selection print where the relationship ENDS UP, while the creator
  // believes they are reading 「到本集为止」 — a spoiler dressed as current state.
  const prod = pdoc.createProduction(null);
  const a = bd.addCharacter(prod, "林照");
  const b = bd.addCharacter(prod, "沈既白");
  const rec = cd.addRelationship(prod, a.characterId, b.characterId);
  const ep1 = prod.episodes[0];
  const ep2 = pdoc.addEpisode(prod, "EP02");
  cd.setEpisodeRelationshipBeat(prod, ep1.episodeId, rec.relationshipId, { end: "有限信任" });
  cd.setEpisodeRelationshipBeat(prod, ep2.episodeId, rec.relationshipId, { end: "决裂" });
  // up to EP01 → EP01's state, NOT EP02's
  assert.equal(cd.relationshipCurrentState(prod, rec.relationshipId, ep1.episodeId).text, "有限信任");
  // absent episodeId → the latest, which IS the documented meaning
  assert.equal(cd.relationshipCurrentState(prod, rec.relationshipId).text, "决裂");
  // an episode that does not exist → UNKNOWN, not the finale
  assert.equal(cd.relationshipCurrentState(prod, rec.relationshipId, "ep-deleted"), null);
  // …and the graph passes it straight through, so nothing is drawn either
  const g = relationshipGraph(snap(prod), { episodeId: "ep-deleted" });
  assert.equal(g.edges[0].current, null);
});

test("relationshipGraph: a relationship whose character is gone is REPORTED, not drawn", () => {
  const prod = pdoc.createProduction(null);
  const a = bd.addCharacter(prod, "林照");
  const b = bd.addCharacter(prod, "沈既白");
  const rec = cd.addRelationship(prod, a.characterId, b.characterId);
  // simulate a record that outlived its character (validation makes this
  // unreachable today; saying so beats assuming it)
  prod.characters = prod.characters.filter((c) => c.characterId !== b.characterId);
  const g = relationshipGraph(snap(prod));
  assert.equal(g.edges.length, 0);
  assert.deepEqual(g.dangling.map((d) => d.relationshipId), [rec.relationshipId]);
});

/* ========================================================================= */
/* 7 · the current Shot Production Graph — a CROSSING network                 */
/* ========================================================================= */

/** A shotDetailModel-shaped stub. Only the fields the graph reads. */
function detail(over = {}) {
  return {
    shot: { shotId: "sh01", seq: 1, title: "SH01 林婉擦杯子", description: "", dialogue: "" },
    scene: { sceneId: "sc1", title: "S01 暗夜酒吧", characters: [], location: null },
    slot: "v1-1",
    images: { list: [], current: 0 },
    videos: { list: [], current: 0 },
    videoSources: {},
    generations: [],
    prompts: { image: { text: "x", missing: [] }, video: { text: "y", missing: [] } },
    refInputs: { references: [], interpretation: [] },
    frames: { start: null, end: null },
    ...over,
  };
}

const REFS = [
  { key: "ref-c", kind: "character-reference", name: "林婉 Ref", version: 3, assetId: "ac", domain: "images", url: "blob:ac" },
  { key: "ref-l", kind: "location-reference", name: "暗夜酒吧 Ref", version: 2, assetId: "al", domain: "images", url: "blob:al" },
  { key: "ref-s", kind: "style-reference", name: "Rain Style", version: 1, assetId: "as", domain: "images", url: "blob:as" },
  { key: "ref-m", kind: "motion-reference", name: "Motion Ref", version: 1, assetId: "am", domain: "videos", url: "blob:am" },
];

test("shotProductionGraph: the bands run Image First → Video, in order", () => {
  const g = shotProductionGraph(snap(pdoc.createProduction(null)), "sh01", detail());
  assert.deepEqual(g.bands.map((b) => b.key), BAND_KEYS);
  // TASK-066 §1 / §10 — a DELIBERATE contract change from TASK-065's eight bands:
  // generation is an ACTION on the media card (上传 / 自动生成 / 修改), not a card of
  // its own, so `imageGen` / `videoGen` are gone; and the chain now ends at the
  // optional End Frame this shot hands to the next one.
  assert.deepEqual(BAND_KEYS, [
    "refs", "imagePrompt", "image", "directing", "videoPrompt", "video", "endFrame",
  ]);
  // ONE card per media stage, showing the SELECTED version
  assert.deepEqual(
    g.nodes.map((n) => n.id),
    ["prompt:image", "image:selected", "prompt:video", "video:selected", "frame:endOut"],
  );
  // an empty shot still shows the whole chain, with honest gaps rather than absence
  assert.equal(g.nodes.find((n) => n.id === "image:selected").state, "gap");
  assert.equal(g.nodes.find((n) => n.id === "video:selected").state, "gap");
  assert.equal(g.done, false, "no selected final video ⇒ this shot is not done");
});

test("shotProductionGraph: the four-step locator is derived, and points at ONE step", () => {
  const stages = (over) => shotProductionGraph(snap(pdoc.createProduction(null)), "sh01", detail(over))
    .stages.map((x) => `${x.key}:${x.state}`);
  // nothing yet → the FIRST step is the one being done and the rest are todo. Lighting
  // up everything incomplete would say nothing about where to go next.
  assert.deepEqual(stages({}), ["refs:doing", "image:todo", "video:todo", "final:todo"]);
  assert.deepEqual(
    stages({ refInputs: { references: [REFS[0]], interpretation: [] } }),
    ["refs:done", "image:doing", "video:todo", "final:todo"],
  );
  // a chosen main frame but NO directing reference → 视频编排 is not done: a video
  // prompt with neither motion nor camera input is not 「排好了」
  assert.deepEqual(
    stages({
      refInputs: { references: [REFS[0]], interpretation: [] },
      images: { list: [{ version: 1, url: "b", assetId: "i1", current: true, origin: "上传" }] },
    }),
    ["refs:done", "image:done", "video:doing", "final:todo"],
  );
});

test("shotProductionGraph: a style reference feeds BOTH prompts — the crossing edge", () => {
  const g = shotProductionGraph(
    snap(pdoc.createProduction(null)),
    "sh01",
    detail({ refInputs: { references: REFS, interpretation: [{ key: "ref-m", kind: "motion-reference", read: false }] } }),
  );
  // node ids are NAMESPACED (`ref:<refKey>`) so a reference can never collide with
  // an `image:v1` / `prompt:image` id
  const has = (from, to) => g.edges.some((e) => e.from === from && e.to === to);
  assert.ok(has("ref:ref-s", "prompt:image"), "style → image prompt");
  assert.ok(has("ref:ref-s", "prompt:video"), "style → video prompt (the same reference, two places)");
  // a CHARACTER reference is an image input only — it is not compiled into the
  // video prompt, and drawing that edge would claim a record that does not exist
  assert.ok(has("ref:ref-c", "prompt:image"));
  assert.ok(!has("ref:ref-c", "prompt:video"));
  // the directing reference reaches the VIDEO prompt by interpretation…
  assert.ok(g.edges.some((e) => e.from === "ref:ref-m" && e.to === "prompt:video" && e.kind === "interpretation"));
  // …AND the IMAGE prompt, because `compileImagePrompt` compiles the same
  // interpretation block (a still frame benefits from 构图 / 光线 / 机位). The first
  // version omitted this edge purely because the directing band sits BELOW the image
  // prompt, which made the graph hide an input that really does affect image
  // generation — the one thing this picture must never do (codex review round 4).
  assert.ok(g.edges.some((e) => e.from === "ref:ref-m" && e.to === "prompt:image" && e.kind === "interpretation"),
    "an input the prompt compiler really reads must be on the graph, whichever band it sits in");
  // …and BOUND BUT UNREAD is not ready: it contributes nothing to the prompt yet
  assert.equal(g.nodes.find((n) => n.id === "ref:ref-m").state, "partial");
  assert.equal(g.nodes.find((n) => n.id === "ref:ref-m").read, false);
});

test("shotProductionGraph: the SELECTED take reports the main frame it really came from", () => {
  const g = shotProductionGraph(snap(pdoc.createProduction(null)), "sh01", detail({
    images: { list: [
      { version: 1, url: "blob:i1", assetId: "i1", current: false, origin: "上传" },
      { version: 2, url: "blob:i2", assetId: "i2", current: true, origin: "上传" },
    ] },
    videos: { list: [
      { version: 1, url: "blob:v1", assetId: "v1", current: false, origin: "上传" },
      // the SELECTED take is v2, and its own record says it came from image v1 — an
      // EARLIER main frame than the one selected now. Reporting that is how the creator
      // notices; claiming it came from v2 would be a fabricated lineage.
      { version: 2, url: "blob:v2", assetId: "v2", current: true, origin: "上传" },
    ] },
    videoSources: { 1: { version: 1, proven: true }, 2: { version: 1, proven: true } },
  }));
  const img = g.nodes.find((n) => n.id === "image:selected");
  const vid = g.nodes.find((n) => n.id === "video:selected");
  assert.equal(img.version, 2);
  assert.equal(img.state, "active");
  assert.equal(img.versions, 2);
  // §10: 主界面只显示当前选定版本 — the others are the card's history, newest first,
  // and none of them is dropped
  assert.deepEqual(img.history.map((h) => h.version), [2, 1]);
  assert.equal(vid.version, 2);
  assert.equal(vid.sourceImageVersion, 1, "the take names the frame its own record proves");
  assert.equal(g.selectedVideoVersion, 2);
  assert.equal(g.done, true, "§1: a SELECTED final video is the definition of done");
  assert.ok(g.edges.some((e) => e.from === "image:selected" && e.to === "video:selected" && e.kind === "source"));
});

test("shotProductionGraph: an UNPROVEN video source claims nothing", () => {
  const g = shotProductionGraph(snap(pdoc.createProduction(null)), "sh01", detail({
    images: { list: [{ version: 1, url: "b", assetId: "i1", current: true, origin: "上传" }] },
    videos: { list: [{ version: 1, url: "b", assetId: "v1", current: true, origin: "上传" }] },
    videoSources: { 1: null }, // an import: no generation record says what it came from
  }));
  assert.equal(g.nodes.find((n) => n.id === "video:selected").sourceImageVersion, null);
  assert.ok(!g.edges.some((e) => e.from === "image:selected" && e.to === "video:selected"));
});

/* ========================================================================= */
/* 8 · A / B stay apart (§10)                                                 */
/* ========================================================================= */

function projectWithScene() {
  const prod = pdoc.createProduction(null);
  const ep = prod.episodes[0];
  const c = bd.addCharacter(prod, "林婉");
  bd.addReferenceAsset(prod, c.characterId, "ac");
  bd.setActiveReferenceAsset(prod, c.characterId, "ac");
  bd.addCharacterState(prod, c.characterId, "受伤状态");
  const l = bd.addLocation(prod, "暗夜酒吧");
  bd.addReferenceAsset(prod, l.locationId, "al");
  bd.setActiveReferenceAsset(prod, l.locationId, "al");
  bd.setCharacterVoice(prod, c.characterId, { voiceId: "zh_CN-huayan" });
  const sc = pdoc.addScene(prod, ep.episodeId, "S01 暗夜酒吧");
  pdoc.assignShot(prod, sc.sceneId, "sh01");
  bd.addSceneCharacter(prod, sc.sceneId, c.characterId, null);
  bd.setSceneLocation(prod, sc.sceneId, l.locationId, null);
  const assets = {
    images: {
      ...chain("ref-c", [ref("ac", 3, { kind: "character-reference", displayName: "林婉 Ref", links: { characterId: c.characterId } })]),
      ...chain("ref-l", [ref("al", 2, { kind: "location-reference", displayName: "暗夜酒吧 Ref", links: { locationId: l.locationId } })]),
    },
    videos: {},
    audio: {},
    finals: [],
  };
  return { prod, c, l, sc, assets };
}

test("A vs B: reusable base assets are LISTED as reusable, gaps listed separately", () => {
  const { prod, c, sc, assets } = projectWithScene();
  const g = shotProductionGraph(
    snap(prod, { assets, assetUploads: assets.images }),
    "sh01",
    detail({ scene: { sceneId: sc.sceneId, title: "S01 暗夜酒吧", characters: [{ characterId: c.characterId, name: "林婉", stateName: null }], location: { locationId: prod.locations[0].locationId, name: "暗夜酒吧", stateName: null } } }),
  );
  // A — everything upstream that this shot can simply USE
  const kinds = g.base.map((b) => b.kind);
  assert.ok(kinds.includes("characterRef"));
  assert.ok(kinds.includes("locationRef"));
  assert.ok(kinds.includes("baseVoice"));
  const charRow = g.base.find((b) => b.kind === "characterRef");
  assert.equal(charRow.exists, true);
  assert.equal(charRow.status, "available", "it exists and is not bound yet — 可复用, not 已在用");
  assert.equal(charRow.version, 3);
  assert.equal(charRow.origin, "故事开发 · 人物");
  assert.equal(g.base.find((b) => b.kind === "locationRef").origin, "世界观 · 场景地");
  // B — the shot's OWN gaps, and none of A's rows leaked into it
  const needKinds = g.needs.map((n) => n.kind);
  assert.ok(needKinds.includes("motion-reference"));
  assert.ok(needKinds.includes("camera-reference"));
  assert.ok(needKinds.includes("characterState"), "a character WITH states but no scene state is a real gap");
  assert.ok(!needKinds.includes("characterRef"), "an existing base asset is never a shot-level gap");
  assert.equal(g.counts.available, g.base.filter((b) => b.status === "available").length);
});

test("A vs B: a BOUND base asset reads as 已在用, and a shot with no image reports no start-frame gap", () => {
  const { prod, c, sc, assets } = projectWithScene();
  const refs = [{ key: "ref-c", kind: "character-reference", name: "林婉 Ref", version: 3, assetId: "ac", domain: "images", url: "blob:ac" }];
  const g = shotProductionGraph(
    snap(prod, { assets, assetUploads: assets.images }),
    "sh01",
    detail({
      scene: { sceneId: sc.sceneId, title: "S01", characters: [{ characterId: c.characterId, name: "林婉", stateName: null }], location: null },
      refInputs: { references: refs, interpretation: [] },
    }),
  );
  assert.equal(g.base.find((b) => b.kind === "characterRef").status, "bound");
  assert.equal(g.counts.reused, 1);
  // NO image yet ⇒ a start-frame gap would be a second complaint about one piece of
  // work (「先出图」 is already the image band's gap)
  assert.ok(!g.needs.some((n) => n.kind === "startFrame"));
});

test("A vs B: a start frame that is only the shot's own picture is flagged SOFTLY", () => {
  const { prod, sc, assets } = projectWithScene();
  const g = shotProductionGraph(snap(prod, { assets, assetUploads: assets.images }), "sh01", detail({
    scene: { sceneId: sc.sceneId, title: "S01", characters: [], location: null },
    images: { list: [{ version: 1, url: "b", assetId: "i1", current: true, origin: "上传" }] },
    frames: { start: { assetId: "i1", url: "b", version: 1, name: "本镜头画面 v1", from: "本镜头画面", binding: null }, end: null },
  }));
  const sf = g.needs.find((n) => n.kind === "startFrame");
  assert.ok(sf, "「用的是自己的画面」 is worth saying");
  assert.equal(sf.soft, true, "…but it is not a blocker");
  assert.equal(g.nodes.find((n) => n.id === "frame:start").bound, false);
  // a SOFT need is excluded from the count the header prints
  assert.equal(g.counts.needs, g.needs.filter((n) => !n.soft).length);
});

/* ========================================================================= */
/* 9 · every node opens the LEFT inspector; a gap opens nothing (§12)         */
/* ========================================================================= */

test("inspectFromShotNode: each node kind maps to its own operating panel", () => {
  assert.deepEqual(inspectFromShotNode({ type: "reference", refKey: "ref-c" }, "sh01"), { kind: "reference", shotId: "sh01", refKey: "ref-c" });
  assert.deepEqual(inspectFromShotNode({ type: "prompt", genKind: "video" }, "sh01"), { kind: "prompt", shotId: "sh01", genKind: "video" });
  assert.deepEqual(inspectFromShotNode({ type: "generation", genKind: "image" }, "sh01"), { kind: "generation", shotId: "sh01", genKind: "image" });
  assert.deepEqual(inspectFromShotNode({ type: "image" }, "sh01"), { kind: "image", shotId: "sh01" });
  assert.deepEqual(inspectFromShotNode({ type: "video" }, "sh01"), { kind: "video", shotId: "sh01" });
  // a FRAME is operated on from the video panel, which owns 提取 / 重新提取 / 解除 —
  // offering them twice is the duplicate entrance this round removes
  assert.deepEqual(inspectFromShotNode({ type: "frame" }, "sh01"), { kind: "video", shotId: "sh01" });
  // unaddressable / unknown → nothing, never a neighbour
  assert.equal(inspectFromShotNode({ type: "reference", refKey: null }, "sh01"), null);
  assert.equal(inspectFromShotNode({ type: "whatever" }, "sh01"), null);
  assert.equal(inspectFromShotNode(null, "sh01"), null);
  assert.equal(inspectFromShotNode({ type: "image" }, null), null);
});

test("renderShotGraph: the cards carry their own actions (§10)", () => {
  const g = shotProductionGraph(snap(pdoc.createProduction(null)), "sh01", detail());
  const html = renderShotGraph(g, {});
  // TASK-066 §10 — the whole point of this round's centre: clicking a card does NOT
  // open a large Inspector any more. 上传 / 自动生成 / 修改 sit ON the card.
  for (const act of ["upload", "generate", "edit"]) {
    assert.ok(html.includes(`data-sg-act="${act}"`), `every media card offers ${act}`);
  }
  assert.ok(html.includes(`data-sg-act="view"`), "a prompt card offers 查看 / 修改");
  assert.ok(html.includes(`data-sg-act="copy"`), "…and 复制, for the external-tool route");
  assert.ok(html.includes(`data-sg-act="extract"`), "the End Frame card offers 提取尾帧");
  // the reference CLUSTERS are the dashed boxes, and each is an edge anchor
  assert.ok(html.includes(`data-node="cluster:refs"`));
  assert.ok(html.includes(`data-node="cluster:directing"`));
  // no shot selected at all → say so rather than draw an empty chain
  assert.ok(renderShotGraph({ empty: true }, {}).includes("先选一个镜头"));
});

test("renderStages: the locator marks done / doing / todo, and exactly one 'doing'", () => {
  const g = shotProductionGraph(snap(pdoc.createProduction(null)), "sh01", detail());
  const html = renderStages(g, "refs");
  for (const [, label] of STAGES) assert.ok(html.includes(label), `${label} is on the bar`);
  assert.ok(html.includes(`data-sg-stage="refs"`));
  assert.equal((html.match(/st-doing/g) || []).length, 1, "one current step, never several");
});

test("inspectFromShotNode still resolves every card the graph draws", () => {
  // The centre no longer routes clicks through the Inspector, but the mapping is still
  // the one source of truth for 「这个节点对应哪个对象」 — the left column's 查看资产 and
  // the frame rows both go through it. A node the graph draws but this cannot resolve
  // would be a dead end.
  const g = shotProductionGraph(snap(pdoc.createProduction(null)), "sh01", detail({
    refInputs: { references: REFS, interpretation: [] },
  }));
  for (const n of g.nodes) {
    assert.ok(inspectFromShotNode(n, "sh01"), `${n.id} (${n.type}) must resolve to an object`);
  }
});

/* ========================================================================= */
/* 10 · the inspector: no function tabs, and no hidden recommendation         */
/* ========================================================================= */

/** A ctx stub for renderInspector, reduced to what the reference picker reads. */
function inspCtx() {
  const prod = pdoc.createProduction(null);
  const shot = { shotId: "sh01", sequence: 1, title: "SH01 林婉擦杯子", slot: "v1-1" };
  return {
    prodData: () => snap(prod, { draftShots: [shot] }),
    episode: {
      referencesOfShot: () => [REFS[0]],
      pickerModel: () => ({ bound: [REFS[0]], suggested: [REFS[1]], library: [REFS[2], REFS[3]] }),
      genModel: () => ({ prompt: "", set: {}, missing: [] }),
    },
    refInterp: { reading: () => null, entry: () => null },
    shot: {
      stage: () => "todo-generate",
      review: () => null,
      shotsUsingReference: () => [],
    },
    prompt: { effective: (a, b, compiled) => ({ text: compiled || "", source: "compiled", version: 0, locked: false }), entry: () => null },
    assets: { chainOf: () => null },
    refplan: { shotName: () => "SH01" },
    relationsMode: () => "full",
  };
}

test("the inspector has NO function tab strip — it states where you are (§8)", () => {
  const ctx = inspCtx();
  const html = renderInspector(ctx, { selectedShotId: "sh01", inspect: { kind: "reference", shotId: "sh01" } });
  assert.ok(!html.includes(`class="pi-tabs"`), "the seven-button 先选功能 strip is gone");
  assert.ok(!/class="pi-tab[ "]/.test(html), "no function tab buttons");
  assert.ok(html.includes(`class="pi-where"`), "…replaced by an object PATH");
  assert.ok(html.includes(`data-pi-open="shot"`), "…whose one move is back up to the shot");
  // standing ON the shot, there is nothing to go up to
  const onShot = renderInspector(ctx, { selectedShotId: "sh01", inspect: { kind: "shot", shotId: "sh01" } });
  assert.ok(onShot.includes(`class="pi-where"`));
  assert.ok(!onShot.includes(`data-pi-open="shot"`));
});

test("the reference list never hides a recommendation, and says which is ENABLED (§11)", () => {
  const html = renderInspector(inspCtx(), { selectedShotId: "sh01", inspect: { kind: "reference", shotId: "sh01" } });
  // every reference that COULD reach this generation is on one checkable list
  assert.ok(html.includes(`data-pi-toggle="ref-c"`), "the bound one");
  assert.ok(html.includes(`data-pi-toggle="ref-l"`), "the recommended one — visible, not silently applied");
  // …and the bound one is the only one checked
  assert.ok(/data-pi-toggle="ref-c" data-on="1"/.test(html));
  assert.ok(/data-pi-toggle="ref-l" data-on="0"/.test(html));
  // the whole library sits behind a per-role 展开 rather than burying the two rows
  // that matter under everything else
  assert.ok(html.includes("从资产库选择"));
  // the frames are inputs too, and they are read-only here — the VIDEO panel owns them
  assert.ok(html.includes("首帧 / 尾帧"));
  assert.ok(html.includes(`data-pi-open="video"`));
});

/* ========================================================================= */
/* 11 · the centre's Scene → Shot derivation                                  */
/* ========================================================================= */

test("currentPlace: the scene is DERIVED from the selected shot, never stored twice", () => {
  const m = {
    empty: false,
    scenes: [
      { sceneId: "s1", title: "S01", shots: [{ shotId: "a" }, { shotId: "b" }] },
      { sceneId: "s2", title: "S02", shots: [{ shotId: "c" }] },
    ],
    unassigned: [{ shotId: "z" }],
    all: [{ shotId: "a" }, { shotId: "b" }, { shotId: "c" }, { shotId: "z" }],
  };
  assert.equal(currentPlace(m, "c").scene.sceneId, "s2");
  assert.equal(currentPlace(m, "c").shot.shotId, "c");
  assert.deepEqual(currentPlace(m, "b").shots.map((s) => s.shotId), ["a", "b"]);
  // an UNASSIGNED shot belongs to no scene and says so rather than being filed
  // under one it is not in
  assert.equal(currentPlace(m, "z").scene, null);
  // nothing selected → offer the first scene so the strip is never blank
  assert.equal(currentPlace(m, null).scene.sceneId, "s1");
  assert.equal(currentPlace(m, null).shot, null);
  assert.deepEqual(currentPlace({ empty: true }, "a"), { scene: null, shot: null, shots: [] });
});

test("the centre never goes blank: shots that resolve to nothing say WHY", () => {
  // An episode whose scenes point at shots the current draft no longer holds has
  // `m.shots > 0` but no selectable shot, so no graph is handed in. Rendering "" there
  // would give the creator an empty column that reads as broken.
  const ctx = {
    prodData: () => snap(pdoc.createProduction(null), { draftShots: [] }),
    episode: {
      view: () => ({
        episodeId: "ep1",
        title: "EP01",
        scenes: [{ sceneId: "s1", title: "S01", shotIds: ["gone"], shots: [] }],
        unassigned: [],
        counts: {},
      }),
      referencesOfShot: () => [],
      hasShotAudio: () => false,
    },
    script: { currentText: () => "" },
    assets: { names: () => ({}) },
    shot: {
      mediaOf: () => ({}),
      stage: () => "todo-design",
      stageCounts: () => ({ approved: 0, "todo-review": 0, generated: 0, "todo-generate": 0, "todo-design": 0 }),
    },
  };
  const html = renderEpProd(ctx, { epFocus: "all" }, { stage: "workbench", graph: null });
  assert.ok(html.includes("ep-center"));
  // either an honest empty state or the no-shots state — never an empty body
  assert.ok(/st-empty/.test(html), "an unresolvable episode must state its situation");
  assert.ok(!/<div class="ep-body full"><\/div>/.test(html), "the centre is never rendered blank");
});

test("the focus filter belongs to the shot SELECTOR, not to the provenance graph", () => {
  assert.equal(showsFocus("workbench"), true);
  assert.equal(showsFocus("provenance"), false);
  assert.equal(showsFocus("frames"), false);
});

/* ========================================================================= */
/* 12 · AI only PROPOSES relationships (§2)                                   */
/* ========================================================================= */

test("relationship-director: a proposal must name TWO different characters", () => {
  assert.equal(applicability("relationship-director").can, true);
  const ok = planApply("relationship-director", {
    proposals: [
      { aCharacterId: "c1", bCharacterId: "c2", basis: "搭档", coreConflict: "录音" },
      { aCharacterId: "c1", bCharacterId: "c1", basis: "自己" },   // same person
      { aCharacterId: "c1", basis: "缺一半" },                      // unaddressable
      { aCharacterId: "c1", bCharacterId: "c3" },                   // no facet at all
      { aCharacterId: "c1", bCharacterId: "c4", basis: "   " },     // whitespace only
    ],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.actions.length, 1, "only the addressable, non-empty proposal survives");
  assert.deepEqual(ok.actions[0], {
    action: "upsertRelationship",
    aCharacterId: "c1",
    bCharacterId: "c2",
    fields: { basis: "搭档", coreConflict: "录音" },
    reason: null,
  });
  // nothing usable → a refusal WITH a reason, never a silent success
  const bad = planApply("relationship-director", { proposals: [] });
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes("characterId"));
});

/* ========================================================================= */
/* 13 · codex round 2 regressions — no orphans, no stolen voices             */
/* ========================================================================= */

test("uploadReference: a target that vanished mid-upload is REFUSED, not orphaned", async () => {
  // codex round 2, P1: the file dialog is open for as long as the creator takes and
  // the upload is a server round trip; registering first and attaching afterwards
  // leaves a registered asset attached to nothing — the orphan ADR-0055 exists to
  // prevent, and the very thing this controller's own comment claimed cannot happen.
  const prod = pdoc.createProduction(null);
  const c = bd.addCharacter(prod, "林婉");
  const st = bd.addCharacterState(prod, c.characterId, "少女时期");
  const calls = { imported: 0, attached: 0 };
  // the controller's shape, reduced to the ordering rule under test
  const missingTarget = (kind, entityId, stateId) => {
    const e = bd.findCharacter(prod, entityId);
    if (!e) return "这个人物已不存在";
    if (stateId && !e.states.some((s) => s.stateId === stateId)) return `「${e.name}」已经没有这个状态了`;
    return "";
  };
  const upload = async (entityId, stateId, { deleteBefore = false, deleteDuring = false } = {}) => {
    if (deleteBefore) prod.characters = [];
    const bad = missingTarget("character", entityId, stateId);
    if (bad) throw new Error(bad);            // ← BEFORE any bytes are written
    calls.imported += 1;
    if (deleteDuring) prod.characters = [];
    const gone = missingTarget("character", entityId, stateId);
    if (gone) throw new Error(`${gone}——文件已经登记为资产`);
    calls.attached += 1;
  };
  // deleted while the dialog was open → nothing is uploaded at all
  await assert.rejects(() => upload(c.characterId, st.stateId, { deleteBefore: true }), /已不存在/);
  assert.equal(calls.imported, 0, "no bytes may reach disk for a target that is already gone");
  // deleted DURING the upload → the asset exists, and the failure says so loudly
  prod.characters = [c];
  await assert.rejects(() => upload(c.characterId, st.stateId, { deleteDuring: true }), /已经登记为资产/);
  assert.equal(calls.attached, 0);
  // the happy path still attaches
  prod.characters = [c];
  await upload(c.characterId, st.stateId);
  assert.equal(calls.attached, 1);
  // a state that no longer exists is named specifically, not reported as the entity
  assert.match(missingTarget("character", c.characterId, "cstate-gone"), /没有这个状态/);
});

test("every prompt-compiler input has an edge on the graph — the picture hides nothing", () => {
  // THE GENERAL RULE behind codex round 4's finding, asserted as a rule rather than
  // as one edge: whatever the compiler reads must be reachable on the picture. Both
  // prompts read the interpretation references, so both must have the edge.
  const g = shotProductionGraph(
    snap(pdoc.createProduction(null)),
    "sh01",
    detail({
      refInputs: {
        references: REFS,
        interpretation: [
          { key: "ref-m", kind: "motion-reference", read: true, readingVersion: 1 },
        ],
      },
    }),
  );
  const targets = (from) => g.edges.filter((e) => e.from === from).map((e) => e.to);
  // an interpretation reference feeds BOTH prompts
  assert.deepEqual(targets("ref:ref-m").sort(), ["prompt:image", "prompt:video"]);
  // a style reference feeds BOTH prompts (compileImagePrompt + compileVideoPrompt)
  assert.deepEqual(targets("ref:ref-s").sort(), ["prompt:image", "prompt:video"]);
  // a character reference feeds ONLY the image prompt — compileVideoPrompt does not
  // name it, so that edge would be a claim the records do not hold
  assert.deepEqual(targets("ref:ref-c"), ["prompt:image"]);
  assert.deepEqual(targets("ref:ref-l"), ["prompt:image"]);
  // a READ interpretation reference is ready; an unread one is not
  assert.equal(g.nodes.find((n) => n.id === "ref:ref-m").state, "ready");
  assert.equal(g.nodes.find((n) => n.id === "ref:ref-m").readingVersion, 1);
});

test("relationship graph: SVG clip ids cannot collide across characters", () => {
  // codex round 4: the first version built each clipPath id by stripping punctuation
  // out of the characterId, which is not injective — `a:b` and `ab` collapse to the
  // same id, and two nodes sharing one clipPath means one portrait is clipped by the
  // OTHER node's circle, i.e. drawn in the wrong place.
  const prod = pdoc.createProduction(null);
  const a = bd.addCharacter(prod, "甲");
  const b = bd.addCharacter(prod, "乙");
  a.characterId = "a:b";
  b.characterId = "ab";
  const images = {
    ...chain("ref-a", [ref("pa", 1)]),
    ...chain("ref-b", [ref("pb", 1)]),
  };
  a.referenceAssetIds = ["pa"]; a.activeReferenceAssetId = "pa";
  b.referenceAssetIds = ["pb"]; b.activeReferenceAssetId = "pb";
  const html = renderRelWs(
    {
      relgraph: { model: () => relationshipGraph(snap(prod, { assetUploads: images })) },
      prodData: () => snap(prod, { assetUploads: images }),
    },
    {},
  );
  const ids = (html.match(/<clipPath id="([^"]+)"/g) || []).map((m) => /id="([^"]+)"/.exec(m)[1]);
  assert.equal(ids.length, 2, "both portraits are clipped");
  assert.equal(new Set(ids).size, 2, "…and their clip ids are distinct");
  // each node references its OWN clip
  for (const id of ids) assert.ok(html.includes(`clip-path="url(#${id})"`));
});

test("a base voice sample belongs to ONE character — reuse is refused, never stolen", () => {
  // codex round 2, P1: `links.characterId` is single-valued, so re-pointing another
  // character's sample here REMOVES their only discoverable one. The first version
  // both did that AND advertised 「可共用」 in the picker — a control that silently
  // destroys somebody else's canon.
  const prod = pdoc.createProduction(null);
  const a = bd.addCharacter(prod, "林婉");
  const b = bd.addCharacter(prod, "苏婉");
  const audio = chain("basevoice-1", [ref("v1", 1, {
    kind: "voice-reference", links: { characterId: a.characterId }, at: "2026-08-12T00:00:00Z",
  })]);
  const pd = snap(prod, { media: { video: {}, audio } });
  // it IS 林婉's, and the model says so
  assert.equal(findBaseAssets(baseAssetsModel(pd), a.characterId).voice.sample.assetId, "v1");
  // …and it is NOT 苏婉's, before or after any UI listing
  assert.equal(findBaseAssets(baseAssetsModel(pd), b.characterId).voice.sample, null);
  // the picker's own rule: a take owned by somebody else is `takenBy`, which is what
  // the panel keys the disabled row off. Owned-by-me is NOT takenBy.
  const takenBy = (owner, forWhom) => (owner && owner !== forWhom ? owner : null);
  assert.equal(takenBy(a.characterId, b.characterId), a.characterId, "listed for 苏婉 as taken");
  assert.equal(takenBy(a.characterId, a.characterId), null, "…but not taken from its own owner");
  assert.equal(takenBy(null, b.characterId), null, "an unlinked take is free");
});

/* ========================================================================= */
/* 14 · TASK-066 — 参考用途 (refuse.js)                                       */
/* ========================================================================= */

test("refUse: no record means the ROLE decides — an untouched project is unaffected", () => {
  const doc = refuse.createRefUse(null);
  // 人物 / 场景 / 道具 / 风格 are model input → the picture. 视频风格 / 运动 / 机位 /
  // 表演 are interpreted → the video. This IS the behaviour that shipped before the
  // document existed, which is why adding it needs no migration.
  assert.equal(refuse.effectiveUse(doc, "sh01", "ref-c", "character-reference").use, "image");
  assert.equal(refuse.effectiveUse(doc, "sh01", "ref-m", "motion-reference").use, "video");
  assert.equal(refuse.effectiveUse(doc, "sh01", "ref-c", "character-reference").source, "role");
});

test("refUse: only sides a COMPILER reads are offered (§5 语义允许时)", () => {
  // A 人物参考 reaching the video prompt would be a switch no compiler honours —
  // `compileVideoPrompt` never names it. Offering it would be a control that silently
  // does nothing, which is worse than a missing one.
  assert.deepEqual(refuse.allowedUses("character-reference"), ["image"]);
  assert.deepEqual(refuse.allowedUses("location-reference"), ["image"]);
  // a STYLE reference is compiled by BOTH, so all three sides are real
  assert.deepEqual(refuse.allowedUses("style-reference").sort(), ["both", "image", "video"]);
  // and so is every interpretation role (both compilers read the reading)
  assert.deepEqual(refuse.allowedUses("motion-reference").sort(), ["both", "image", "video"]);
  // an override the role does not allow is IGNORED rather than honoured
  const doc = refuse.createRefUse({ sh01: { "ref-c": "video" } });
  assert.equal(refuse.effectiveUse(doc, "sh01", "ref-c", "character-reference").use, "image");
  assert.equal(refuse.setUse(doc, "sh01", "ref-c", "video", "character-reference"), false);
});

test("refUse: choosing the role's own default stores NOTHING", () => {
  const doc = refuse.createRefUse(null);
  // 「按类型推导」 and 「创作者恰好选了同一边」 must stay distinguishable: storing the
  // latter would make a future change to the role's default silently stop applying to
  // a shot that never asked to opt out.
  assert.equal(refuse.setUse(doc, "sh01", "ref-m", "video", "motion-reference"), false);
  assert.equal(refuse.overrideOf(doc, "sh01", "ref-m"), null);
  // a real change IS stored, and reads back as the creator's own
  assert.equal(refuse.setUse(doc, "sh01", "ref-m", "both", "motion-reference"), true);
  assert.equal(refuse.effectiveUse(doc, "sh01", "ref-m", "motion-reference").source, "creator");
  assert.equal(refuse.feedsImage(doc, "sh01", "ref-m", "motion-reference"), true);
  assert.equal(refuse.feedsVideo(doc, "sh01", "ref-m", "motion-reference"), true);
  // …and setting it back to the default REMOVES the entry rather than pinning it
  assert.equal(refuse.setUse(doc, "sh01", "ref-m", "video", "motion-reference"), true);
  assert.equal(refuse.overrideOf(doc, "sh01", "ref-m"), null);
});

test("refUse: a `__proto__` id survives the save/load round trip", () => {
  // codex review round 1 (TASK-066): `serialize` used plain assignment while the read
  // side used `putKey`. A shotId or refKey that is literally `__proto__` then set the
  // PROTOTYPE instead of storing an entry, so that override vanished on save — the
  // exact asymmetry TASK-064 was bitten by, in the exact same place.
  const doc = refuse.createRefUse(null);
  assert.equal(refuse.setUse(doc, "__proto__", "ref-s", "both", "style-reference"), true);
  assert.equal(refuse.setUse(doc, "sh01", "__proto__", "both", "style-reference"), true);
  const round = refuse.createRefUse(JSON.parse(JSON.stringify(refuse.serialize(doc))));
  assert.equal(refuse.overrideOf(round, "__proto__", "ref-s"), "both", "a __proto__ shotId survives");
  assert.equal(refuse.overrideOf(round, "sh01", "__proto__"), "both", "a __proto__ refKey survives");
  // and nothing was written onto Object.prototype in the process
  assert.equal({}.ref_s, undefined);
  assert.equal(Object.prototype["ref-s"], undefined);
});

test("refUse: groupsForShot puts a 'both' reference in BOTH groups", () => {
  const doc = refuse.createRefUse(null);
  refuse.setUse(doc, "sh01", "ref-s", "both", "style-reference");
  const g = refuse.groupsForShot(doc, "sh01", [
    { key: "ref-c", kind: "character-reference", name: "林婉 Ref" },
    { key: "ref-s", kind: "style-reference", name: "Rain Style" },
    { key: "ref-m", kind: "motion-reference", name: "Motion Ref" },
  ]);
  assert.deepEqual(g.image.map((r) => r.key), ["ref-c", "ref-s"]);
  assert.deepEqual(g.video.map((r) => r.key), ["ref-s", "ref-m"]);
  // …and each row carries what the card needs to render its chip and its menu
  const style = g.image.find((r) => r.key === "ref-s");
  assert.equal(style.use, "both");
  assert.equal(style.useSource, "creator");
  assert.deepEqual(style.allowed.sort(), ["both", "image", "video"]);
});

test("the End Frame card can only offer 接给下一镜 when a next shot was SUPPLIED", () => {
  // codex review round 2 (TASK-066): the model takes `nextShot` from its caller, and the
  // controller was not passing it — so every End Frame card had `nextShot: null` and the
  // 「接给下一镜」 action could never appear. A feature that looked implemented and was
  // dead. The model's contract is asserted here; the CONTROLLER passing it is asserted
  // by the browser probe (`_agent-tools/shot066.mjs`).
  const bare = shotProductionGraph(snap(pdoc.createProduction(null)), "sh01", detail());
  assert.equal(bare.nodes.find((n) => n.id === "frame:endOut").nextShot, null);
  const withNext = shotProductionGraph(snap(pdoc.createProduction(null)), "sh01", detail(), {
    nextShot: { shotId: "sh02", title: "SH02 门口全景" },
  });
  const end = withNext.nodes.find((n) => n.id === "frame:endOut");
  assert.equal(end.nextShot.shotId, "sh02");
  // …and the card really renders the action, rather than the model merely holding it
  assert.ok(renderShotGraph(withNext, {}).includes(`data-sg-act="extractbind"`));
  assert.ok(!renderShotGraph(bare, {}).includes(`data-sg-act="extractbind"`),
    "no next shot ⇒ the button is absent, not a dead button");
});

test("the review record reaches the model when supplied, and is null when not", () => {
  const g = shotProductionGraph(snap(pdoc.createProduction(null)), "sh01", detail({
    videos: { list: [{ version: 1, url: "b", assetId: "v1", current: true, origin: "上传" }] },
  }), { review: { at: "2026-08-12T10:00:00Z", note: "" } });
  assert.equal(g.nodes.find((n) => n.id === "video:selected").approved, true);
  const none = shotProductionGraph(snap(pdoc.createProduction(null)), "sh01", detail({
    videos: { list: [{ version: 1, url: "b", assetId: "v1", current: true, origin: "上传" }] },
  }));
  assert.equal(none.nodes.find((n) => n.id === "video:selected").approved, false);
});

test("the Action Layer names the reference-use mutation as a POINTER change", () => {
  // it moves no media and creates no version — it re-points which prompt reads a
  // reference, which is the same class as Set Active
  assert.deepEqual(ACTIONS.setReferenceUse.args, ["shotId", "referenceKey", "use"]);
  assert.equal(ACTIONS.setReferenceUse.risk, "pointer");
});

test("the Action Layer names the relationship mutations, with honest risk classes", () => {
  assert.deepEqual(ACTIONS.upsertRelationship.args, ["aCharacterId", "bCharacterId", "fields"]);
  assert.equal(ACTIONS.upsertRelationship.risk, "edit");
  assert.equal(ACTIONS.removeRelationship.risk, "edit");
  // swapping the arrow moves no content — it is a pointer-class change
  assert.equal(ACTIONS.swapRelationshipDirection.risk, "pointer");
});

// Production studio (checkpoint M8) — run via `node --test`. Owned by the frontend suite (gate frontend tier + CI).
//
// Covers: the Storyboard workspace models (scene grouping, shot detail with
// creative facets + media variants + lineage), the AI Director model, the M8
// creative-facet passthrough in normalizeShots, and the AI-first bible
// breakdown flow (parse → match → change computation → derived appearances).
import test from "node:test";
import assert from "node:assert/strict";

import { storyboardModel, shotDetailModel, renderStoryboard } from "../src/ui/storyboard.js";
import { videoSourceFrame, curVideoVersion } from "../src/ui/studioparts.js";
import { renderImageWs, renderVideoWs } from "../src/ui/mediaws.js";
import { directorModel } from "../src/ui/director.js";
import { normalizeShots, nextDraftVersion } from "../src/ui/shoteditor.js";
import {
  parseBreakdown,
  matchProposals,
  characterChanges,
  locationChanges,
  gateUpdate,
  derivedAppearances,
} from "../src/workflow/breakdown.js";
import * as pd from "../src/workflow/proddoc.js";
import * as bd from "../src/workflow/bibledoc.js";
import * as sd from "../src/workflow/scriptdoc.js";

/** prodData snapshot with a 2-shot draft, media, a scene and a bible. */
function snapshot() {
  const prod = pd.createProduction(null);
  const scene = pd.addScene(prod, prod.episodes[0].episodeId, "大殿");
  pd.assignShot(prod, scene.sceneId, "shot-a");
  const c = bd.addCharacter(prod, "李昭");
  const st = bd.addCharacterState(prod, c.characterId, "黑化时期");
  const l = bd.addLocation(prod, "太极殿");
  bd.addSceneCharacter(prod, scene.sceneId, c.characterId, st.stateId);
  bd.setSceneLocation(prod, scene.sceneId, l.locationId, null);
  return {
    draftShots: [
      {
        shotId: "shot-a", sequence: 1, title: "跪殿", description: "大殿中央",
        duration_seconds: 6, slot: "v1-1",
        action: "指尖颤抖", cameraMotion: "缓慢推近", dialogue: "「臣遵旨」",
      },
      { shotId: "shot-b", sequence: 2, title: "逼诗", description: "皇帝俯视", duration_seconds: 10, slot: "v1-2" },
    ],
    lockedPlan: null,
    shotVersions: { count: 1, cur: 1, state: "done", rows: null },
    realShots: null,
    assetUploads: {
      "v1-1": {
        current: 2,
        history: [
          { slot_id: "v1-1", origin: "upload", version: 1, url: "/u/a1.png", assetId: "asset-1" },
          { slot_id: "v1-1", origin: "paid-image", version: 2, url: "/u/a1_v2.png", assetId: "asset-2" },
        ],
      },
    },
    media: {
      video: { "v1-1": { current: 1, history: [{ slot_id: "v1-1", origin: "adopted", version: 1, url: "/u/v1.mp4", assetId: "asset-3" }] } },
      audio: { "voice-v1-1": "/u/voice1.wav" },
    },
    firstFrames: { "v1-1": { slot_id: "v1-1", origin: "paid-image", version: 2, url: "/u/a1_v2.png", assetId: "asset-2" } },
    finals: [],
    paidOps: {},
    generations: [
      { generationId: "gen-1", type: "video", targetType: "shot", targetId: "shot-a", status: "success", createdAt: "2026-08-09T10:00:00Z", provider: "minimax" },
      { generationId: "gen-2", type: "image", targetType: "shot", targetId: "shot-b", status: "generating", createdAt: null, provider: null },
    ],
    production: prod,
    _ids: { sceneId: scene.sceneId, characterId: c.characterId, stateId: st.stateId, locationId: l.locationId },
  };
}

// --- storyboardModel --------------------------------------------------------- //

test("storyboardModel groups shots by scene with an unassigned pool", () => {
  const s = snapshot();
  const m = storyboardModel(s);
  assert.equal(m.hasDraft, true);
  assert.equal(m.total, 2);
  assert.equal(m.scenes.length, 1);
  assert.equal(m.scenes[0].title, "大殿");
  assert.deepEqual(m.scenes[0].shots.map((x) => x.shotId), ["shot-a"]);
  assert.equal(m.scenes[0].shots[0].thumb, "/u/a1_v2.png"); // CURRENT image version
  assert.equal(m.scenes[0].shots[0].hasVideo, true);
  // the scene's bible context rides on the scene header
  assert.equal(m.scenes[0].refs.characters[0].name, "李昭");
  assert.equal(m.scenes[0].refs.characters[0].stateName, "黑化时期");
  assert.equal(m.scenes[0].refs.location.name, "太极殿");
  assert.deepEqual(m.unassigned.map((x) => x.shotId), ["shot-b"]);
});

test("storyboardModel: dangling scene ref flagged; empty/generating states honest", () => {
  const s = snapshot();
  pd.assignShot(s.production, s._ids.sceneId, "shot-gone");
  const m = storyboardModel(s);
  const gone = m.scenes[0].shots.find((x) => x.shotId === "shot-gone");
  assert.equal(gone.dangling, true);
  assert.equal(storyboardModel({ ...s, draftShots: null }).hasDraft, false);
  assert.equal(storyboardModel({ ...s, shotVersions: { state: "gen" } }).generating, true);
});

// --- shotDetailModel ---------------------------------------------------------- //

test("shotDetailModel: creative facets + scene context + media variants + lineage", () => {
  const s = snapshot();
  const d = shotDetailModel(s, "shot-a");
  assert.equal(d.shot.title, "跪殿");
  assert.equal(d.shot.action, "指尖颤抖");
  assert.equal(d.shot.cameraMotion, "缓慢推近");
  assert.equal(d.shot.dialogue, "「臣遵旨」");
  assert.equal(d.shot.duration, 6);
  assert.equal(d.scene.title, "大殿");
  assert.equal(d.scene.characters[0].stateName, "黑化时期");
  assert.equal(d.scene.location.name, "太极殿");
  assert.equal(d.slot, "v1-1");
  // image variants with the CURRENT flag on v2
  assert.deepEqual(d.images.list.map((r) => [r.version, r.current]), [[1, false], [2, true]]);
  assert.equal(d.videos.list.length, 1);
  assert.equal(d.firstFrame.version, 2);
  assert.ok(d.voice.url); // legacy plain-string voice slot normalizes
  // per-shot generations only (shot-b's generating image is NOT here)
  assert.deepEqual(d.generations.map((g) => g.generationId), ["gen-1"]);
  // a shot without canonical identity resolution returns null
  assert.equal(shotDetailModel(s, "shot-nope"), null);
});

// --- directorModel -------------------------------------------------------------- //

test("directorModel: per-module context, real primary actions, provenance history", () => {
  const s = snapshot();
  const doc = sd.createDoc();
  // script module: no versions → initial generation
  let m = directorModel({ module: "script", doc, pd: s, sel: {} });
  assert.equal(m.primary.kind, "script-initial");
  sd.completeGeneration(doc, sd.beginGeneration(doc, "initial", "想法"), "剧本");
  m = directorModel({ module: "script", doc, pd: s, sel: {} });
  assert.equal(m.primary.kind, "script-revise");
  // shots module with a draft → regenerate + selected-shot context
  m = directorModel({ module: "shots", doc, pd: s, sel: { selectedShotId: "shot-a" } });
  assert.equal(m.primary.kind, "shots-generate");
  assert.ok(m.context.some((t) => t.includes("跪殿")));
  // settings module → AI-first bible breakdown
  m = directorModel({ module: "settings", doc, pd: s, sel: {} });
  assert.equal(m.primary.kind, "bible-breakdown");
  // history: newest first, real registry statuses
  assert.deepEqual(m.history.map((h) => h.status), ["生成中", "成功"]);
  // frames module: no fake generate button. With NO shot selected there is
  // nothing to act on, so the honest note stands; WITH one, the real
  // generation entry (compiled prompt + provider + import) is offered.
  m = directorModel({ module: "frames", doc, pd: s, sel: {} });
  assert.equal(m.primary, null);
  assert.ok(m.pending.includes("资产准备"));
  m = directorModel({ module: "frames", doc, pd: s, sel: { selectedShotId: "shot-a" } });
  assert.equal(m.primary, null);
  assert.equal(m.pending, null);
  assert.equal(m.genKind, "image");
  assert.ok(m.genDetail);
});

// --- normalizeShots M8 facets ------------------------------------------------------ //

test("normalizeShots carries action/cameraMotion/dialogue additively; blanks omitted", () => {
  const out = normalizeShots(
    [
      { shotId: "shot-a", title: "甲", description: "d", duration_seconds: 6, slot: "v1-1", action: " 抬手 ", cameraMotion: "推近", dialogue: "" },
      { title: "乙", description: "d2", duration_seconds: 10 },
    ],
    "v2",
  );
  assert.equal(out[0].shotId, "shot-a"); // identity carried
  assert.equal(out[0].action, "抬手");
  assert.equal(out[0].cameraMotion, "推近");
  assert.ok(!("dialogue" in out[0])); // blank facet omitted, not stored as ""
  assert.ok(!("action" in out[1]));
  assert.match(out[1].shotId, /^shot-/); // new shot minted
  assert.equal(out[1].slot, "v2-2");
});

test("normalizeShots keeps the framing facets — editing a shot must not erase them", () => {
  // shotSize / angle / emotion are shown as the storyboard's compact metadata
  // and compiled into the image prompt. Dropping them here meant every save
  // silently threw away the shot's directing.
  const out = normalizeShots(
    [{
      shotId: "shot-a", title: "甲", description: "d", duration_seconds: 6, slot: "v1-1",
      shotSize: "远景", angle: " 仰视 ", emotion: "压抑", action: "抬手", cameraMotion: "推近",
    }],
    "v2",
  );
  assert.equal(out[0].shotSize, "远景");
  assert.equal(out[0].angle, "仰视"); // trimmed like the other facets
  assert.equal(out[0].emotion, "压抑");
  // and a blank facet is still omitted rather than stored as ""
  const blank = normalizeShots([{ title: "乙", description: "d", shotSize: "  " }], "v2");
  assert.ok(!("shotSize" in blank[0]));
});

// --- breakdown: parse → match → apply-semantics -------------------------------------- //

test("parseBreakdown sanitizes the agent payload fail-closed", () => {
  const b = parseBreakdown({
    characters: [
      // a bare-string state name is tolerated (plausible agent shorthand);
      // non-string junk and duplicate names are dropped
      { name: " 李昭 ", appearance: "束发", states: [{ name: "黑化", reason: "剧情" }, { name: "黑化" }, "夜行", 42, null] },
      { name: "李昭" }, // duplicate name → dropped
      { appearance: "无名" }, // no name → dropped
      "junk",
    ],
    locations: [{ name: "太极殿", description: "金殿", states: [] }],
  });
  assert.equal(b.characters.length, 1);
  assert.equal(b.characters[0].name, "李昭");
  assert.deepEqual(b.characters[0].states, [{ name: "黑化", reason: "剧情" }, { name: "夜行", reason: "" }]);
  assert.equal(b.locations.length, 1);
  // v3 起提案里还有道具（TASK-095 §2.2）。**形状总是带 `props`**，缺席的输入
  // 得到空数组而不是缺键 —— 否则「这次没有道具」会有两个形状。
  assert.deepEqual(parseBreakdown(null), { characters: [], locations: [], props: [] });
  const withProps = parseBreakdown({
    characters: [], locations: [],
    props: [
      { name: "青铜钥匙", description: "带锈", visualInstruction: "特写可辨" },
      { name: "青铜钥匙", description: "重复的，按归一化名去重" },
      { name: "" },            // 无名 → 丢掉
      "junk",                   // 非对象 → 丢掉
      { name: "旧监视器", states: [{ name: "碎屏" }] }, // 道具没有状态 → 不带过来
    ],
  });
  assert.deepEqual(withProps.props.map((x) => x.name), ["青铜钥匙", "旧监视器"]);
  assert.equal(withProps.props[0].description, "带锈");
  assert.equal("states" in withProps.props[1], false, "道具没有状态这件事在解析时就成立");
});

test("matchProposals: unmatched → new; matched → update with field/state diff; in-sync omitted", () => {
  const s = snapshot(); // bible has 李昭 (empty profile) + 太极殿
  bd.updateCharacterProfile(s.production, s._ids.characterId, { appearance: "束发青衫" });
  const cards = matchProposals(s.production, parseBreakdown({
    characters: [
      { name: "李昭", appearance: "束发青衫", costume: "青色襦裙", states: [{ name: "黑化时期" }, { name: "受伤时期" }] },
      { name: "皇帝", appearance: "冕旒垂面" },
    ],
    locations: [{ name: "太极殿" }], // nothing new → omitted (in sync)
  }));
  assert.deepEqual(cards.map((c) => c.kind), ["update-character", "new-character"]);
  const upd = cards[0];
  assert.equal(upd.entityId, s._ids.characterId);
  // appearance identical → NOT a change; costume empty→filled IS; existing
  // state 黑化时期 excluded, new 受伤时期 proposed
  assert.deepEqual(upd.changes.fields.map((f) => f.key), ["costume"]);
  assert.deepEqual(upd.changes.states.map((x) => x.name), ["受伤时期"]);
});

test("merge mode fills ONLY empty fields — confirmed values always win", () => {
  const s = snapshot();
  const c = bd.findCharacter(s.production, s._ids.characterId);
  bd.updateCharacterProfile(s.production, c.characterId, { appearance: "已确认外貌" });
  const p = parseBreakdown({
    characters: [{ name: "李二昭", appearance: "提案外貌", costume: "提案服装" }],
    locations: [],
  }).characters[0];
  const merge = characterChanges(c, p, "merge");
  assert.deepEqual(merge.fields.map((f) => f.key), ["costume"]); // appearance kept
  const update = characterChanges(c, p, "update");
  assert.deepEqual(update.fields.map((f) => f.key).sort(), ["appearance", "costume"]);
  // locations symmetric
  const l = bd.findLocation(s.production, s._ids.locationId);
  bd.updateLocationProfile(s.production, l.locationId, { description: "已确认描述" });
  const lp = parseBreakdown({ characters: [], locations: [{ name: "x", description: "提案", visualInstruction: "指令" }] }).locations[0];
  assert.deepEqual(locationChanges(l, lp, "merge").fields.map((f) => f.key), ["visualInstruction"]);
});

// --- review-round regressions ----------------------------------------------------------- //

test("gateUpdate writes ONLY what the card showed — a mid-review manual edit is skipped", () => {
  const s = snapshot();
  const c = bd.findCharacter(s.production, s._ids.characterId);
  bd.updateCharacterProfile(s.production, c.characterId, { appearance: "旧外貌", costume: "" });
  const p = parseBreakdown({
    characters: [{ name: c.name, appearance: "提案外貌", costume: "提案服装" }],
    locations: [],
  }).characters[0];
  const changes = characterChanges(c, p, "update"); // the card's snapshot
  // the user manually edits appearance AFTER the card was computed…
  bd.updateCharacterProfile(s.production, c.characterId, { appearance: "评审后手工外貌" });
  const gated = gateUpdate(c, changes);
  // …so appearance is an UNSEEN difference → skipped; costume (still as shown)
  // is written; the skip is counted for honest reporting
  assert.deepEqual(gated.fields.map((f) => f.key), ["costume"]);
  assert.equal(gated.skipped, 1);
  // a state added manually mid-review is not re-added
  bd.addCharacterState(s.production, c.characterId, "受伤时期");
  const changes2 = { fields: [], states: [{ name: "受伤时期", reason: "" }] };
  assert.deepEqual(gateUpdate(c, changes2).states, []);
});

test("nextDraftVersion is max+1, never length+1 (noncontiguous surviving versions)", () => {
  assert.equal(nextDraftVersion([{ v: 2 }, { v: 3 }]), 4); // length+1 would DUPLICATE v3
  assert.equal(nextDraftVersion([]), 1);
  assert.equal(nextDraftVersion([{ v: 1 }, { v: "x" }, null]), 2);
});

test("proposal states dedup by NORMALIZED name; director input only where consumed", () => {
  const b = parseBreakdown({
    characters: [{ name: "甲", states: [{ name: "夜 晚" }, { name: "夜  晚" }, { name: "白日" }] }],
    locations: [],
  });
  assert.deepEqual(b.characters[0].states.map((s) => s.name), ["夜 晚", "白日"]);
  const s = snapshot();
  const doc = sd.createDoc();
  // shots/settings actions do not consume the instruction → no input rendered
  assert.equal(directorModel({ module: "shots", doc, pd: s, sel: {} }).primary.input, false);
  assert.equal(directorModel({ module: "settings", doc, pd: s, sel: {} }).primary.input, false);
  assert.equal(directorModel({ module: "script", doc, pd: s, sel: {} }).primary.input, true);
});

test("normName collapses whitespace but never removes it (distinct names stay distinct)", () => {
  const b = parseBreakdown({
    characters: [{ name: "Ann  Marie" }, { name: "AnnMarie" }],
    locations: [],
  });
  // both survive as SEPARATE proposals — removal would have collided them
  assert.deepEqual(b.characters.map((c) => c.name), ["Ann  Marie", "AnnMarie"]);
  const prod = pd.createProduction(null);
  bd.addCharacter(prod, "Ann Marie");
  const cards = matchProposals(prod, parseBreakdown({ characters: [{ name: "AnnMarie", appearance: "x" }], locations: [] }));
  assert.equal(cards[0].kind, "new-character"); // NOT an update to Ann Marie
});

test("unsaved shot-edit buffer survives a re-render (rendered over committed values)", () => {
  const s = snapshot();
  const ctx = { prodData: () => s, script: { hasContent: () => true } };
  // the editor is secondary now (opened with ✎ 编辑镜头); the buffer guarantee
  // it protects is unchanged — a re-render must still show the unsaved values
  const ui = { selectedShotId: "shot-a", shotEdit: true, buffer: { title: "改到一半的镜头名", dialogue: "新台词" } };
  const html = renderStoryboard(ctx, ui);
  assert.ok(html.includes('value="改到一半的镜头名"')); // buffered, not committed
  assert.ok(html.includes("新台词"));
  assert.ok(!html.includes('value="跪殿"')); // committed title replaced by buffer
});

// --- derived appearances --------------------------------------------------------------- //

test("episode appearances are DERIVED from scene references, never stored", () => {
  const s = snapshot();
  const prod = s.production;
  // second episode whose scene references the SAME character
  const ep2 = pd.addEpisode(prod, "第 2 集");
  const sc2 = pd.addScene(prod, ep2.episodeId, "回忆");
  bd.addSceneCharacter(prod, sc2.sceneId, s._ids.characterId, null);
  const a = derivedAppearances(prod);
  assert.deepEqual(a.characters.get(s._ids.characterId).map((x) => x.title), ["第 1 集", "第 2 集"]);
  assert.deepEqual(a.locations.get(s._ids.locationId).map((x) => x.title), ["第 1 集"]);
  // removing the scene reference removes the derived appearance — no stale list
  bd.removeSceneCharacter(prod, sc2.sceneId, s._ids.characterId);
  assert.deepEqual(derivedAppearances(prod).characters.get(s._ids.characterId).map((x) => x.title), ["第 1 集"]);
});


test("each video version keeps the source image ITS generation recorded", () => {
  // `firstFrames[slot]` is slot-level and overwritten, so it describes only the
  // newest take. Using it for every version showed an older video as having come
  // from an image that did not exist when it was made.
  const s = snapshot();
  s.media.video["v1-1"] = {
    current: 2,
    history: [
      { slot_id: "v1-1", origin: "paid-video", version: 1, url: "/u/v1.mp4", assetId: "asset-v1" },
      { slot_id: "v1-1", origin: "paid-video", version: 2, url: "/u/v2.mp4", assetId: "asset-v2" },
    ],
  };
  s.generations = s.generations.concat([
    { generationId: "g-v1", type: "video", targetId: "shot-a", status: "success",
      inputAssetIds: ["asset-1"], resultAssetIds: ["asset-v1"] },   // from Image v1
    { generationId: "g-v2", type: "video", targetId: "shot-a", status: "success",
      inputAssetIds: ["asset-2"], resultAssetIds: ["asset-v2"] },   // from Image v2
  ]);
  const d = shotDetailModel(s, "shot-a");
  assert.equal(d.videoSources[1].version, 1, "Video v1 came from Image v1");
  assert.equal(d.videoSources[2].version, 2, "Video v2 came from Image v2");
  assert.equal(videoSourceFrame(d, 1), "/u/a1.png");
  assert.equal(videoSourceFrame(d, 2), "/u/a1_v2.png");
  assert.equal(curVideoVersion(d), 2);
});

test("an older video with no recorded generation borrows nothing", () => {
  // the slot-level first frame may stand in for the CURRENT take only
  const s = snapshot();
  s.media.video["v1-1"] = {
    current: 2,
    history: [
      { slot_id: "v1-1", origin: "upload", version: 1, url: "/u/v1.mp4", assetId: "asset-v1" },
      { slot_id: "v1-1", origin: "upload", version: 2, url: "/u/v2.mp4", assetId: "asset-v2" },
    ],
  };
  const d = shotDetailModel(s, "shot-a");
  assert.equal(d.videoSources[1], null);
  assert.equal(videoSourceFrame(d, 1), "", "no invented source for the older take");
  assert.equal(videoSourceFrame(d, 2), "/u/a1_v2.png", "the slot record describes the NEWEST take");

  // selecting an older take must not make the slot record describe THAT one
  s.media.video["v1-1"].current = 1;
  const d2 = shotDetailModel(s, "shot-a");
  assert.equal(curVideoVersion(d2), 1);
  assert.equal(videoSourceFrame(d2, 1), "", "the selected-but-older take still has no proven source");
});


test("the board LISTS the unassigned pool instead of hiding it behind an empty state", () => {
  // a project whose shots are all unassigned must still be inspectable: the
  // empty state is only correct when there is genuinely nothing to show
  const s = snapshot();
  s.production.episodes[0].scenes = [];
  const ctx = {
    prodData: () => s,
    script: { hasContent: () => true, doc: () => null },
  };
  const html = renderStoryboard(ctx, { selectedShotId: "shot-a", buffer: {}, shotEdit: false });
  assert.ok(!html.includes("本集还没有镜头"), "no dead-end empty state while inventory exists");
  assert.ok(html.includes("跪殿"), "the unassigned shot is listed");
  assert.ok(html.includes("未归组"), "and is honestly labelled as not this episode's");

  // with NO shots at all, the empty state is still the right answer
  const s2 = snapshot();
  s2.production.episodes[0].scenes = [];
  s2.draftShots = [];
  const html2 = renderStoryboard({ ...ctx, prodData: () => s2 }, { selectedShotId: null, buffer: {} });
  assert.ok(html2.includes("还没有分镜") || html2.includes("本集还没有镜头"));
});

test("the Image and Video workspaces show the unassigned pool too", () => {
  // the same rule as the board: an empty state is only correct when there is
  // genuinely nothing to work on
  const s = snapshot();
  s.production.episodes[0].scenes = [];
  const ctx = { prodData: () => s, script: { hasContent: () => true, doc: () => null } };
  const ui = { selectedShotId: "shot-a", buffer: {}, variantTab: "image" };
  for (const render of [renderImageWs, renderVideoWs]) {
    const html = render(ctx, ui);
    assert.ok(!html.includes("本集还没有镜头"), "no dead-end while inventory exists");
    assert.ok(html.includes("跪殿"), "the unassigned shot is workable here");
  }
  // with nothing at all, the empty state remains
  const s2 = snapshot();
  s2.production.episodes[0].scenes = [];
  s2.draftShots = [];
  const html2 = renderImageWs({ ...ctx, prodData: () => s2 }, { selectedShotId: null, buffer: {} });
  assert.ok(html2.includes("还没有") );
});

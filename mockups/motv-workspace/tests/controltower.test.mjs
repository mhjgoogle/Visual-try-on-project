// Unit tests for the AI Director's Control Tower layers (TASK-051A):
// Production Plan derivation, Asset Inbox classification, and the
// OBSERVE/PLAN/EXECUTE capability gate.
//
// These are the guarantees that keep the Director honest: it must DERIVE
// everything from existing domain state, never invent an owner for an asset,
// and never run a canon/destructive/paid action without asking.
import test from "node:test";
import assert from "node:assert/strict";

import { productionPlan, shotBlockers, episodeShots, episodeStageCounts, unassignedShots, episodeFinals } from "../src/ui/prodplan.js";
import { assetInbox, knownOwners } from "../src/ui/assetinbox.js";
import { storyboardModel, defaultShotId, isEpisodeShot, isSelectableShot } from "../src/ui/storyboard.js";
import { CAPABILITIES, needsConfirm, isAutomatic, levelOf, invoke } from "../src/ui/directorops.js";
import { episodeStages } from "../src/ui/production.js";
import * as sd from "../src/workflow/scriptdoc.js";

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const chain = (recs) => ({ current: recs[recs.length - 1].version, history: recs });
const img = (assetId, version, shotId, extra = {}) => ({
  slot_id: "s", origin: "upload", version, digest: null, url: `/u/${assetId}.png`,
  assetId, creativeShotId: shotId, storageState: "local", ...extra,
});

/** A two-scene episode: shot-a is fully wired, shot-b has no character refs. */
function pd(over = {}) {
  const base = {
    draftShots: [
      { sequence: 1, title: "跪殿", description: "d1", shotId: "shot-a", slot: "v1-1", duration_seconds: 6 },
      { sequence: 2, title: "厉声", description: "d2", shotId: "shot-b", slot: "v1-2", duration_seconds: 6 },
    ],
    lockedPlan: null,
    shotVersions: { count: 1, cur: 1, state: "done", rows: null },
    realShots: null,
    assetUploads: { "v1-1": chain([img("a1", 1, "shot-a")]) },
    media: { video: {}, audio: {} },
    firstFrames: {},
    finals: [],
    paidOps: {},
    generations: [],
    story: null,
    timelines: {},
    production: {
      activeEpisodeId: "ep-1",
      episodes: [{
        episodeId: "ep-1",
        title: "第 1 集",
        bgmAssetId: null,
        scenes: [
          {
            sceneId: "sc-1", title: "S01 大殿", shotIds: ["shot-a"],
            characterRefs: [{ characterId: "c-1", stateId: null }],
            locationRef: { locationId: "l-1", stateId: null },
            ambienceAssetId: null, bgmAssetId: null,
          },
          {
            sceneId: "sc-2", title: "S02 城墙", shotIds: ["shot-b"],
            characterRefs: [], locationRef: { locationId: "l-1", stateId: null },
            ambienceAssetId: null, bgmAssetId: null,
          },
        ],
      }],
      characters: [{
        characterId: "c-1", name: "沈昭昭",
        profile: { appearance: "", costume: "", personality: "", visualInstruction: "" },
        referenceAssetIds: ["ref-1"], activeReferenceAssetId: "ref-1",
        voice: { voiceId: null, description: "", performance: {} }, states: [],
      }],
      locations: [{
        locationId: "l-1", name: "金銮殿",
        profile: { description: "", visualInstruction: "" },
        referenceAssetIds: ["ref-2"], activeReferenceAssetId: "ref-2", states: [],
      }],
    },
    assets: {
      images: { "v1-1": chain([img("a1", 1, "shot-a")]) },
      videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [], unresolvedPaid: [],
    },
  };
  return { ...base, ...over };
}

/* -------------------------------------------------------------------------- */
/* production plan                                                             */
/* -------------------------------------------------------------------------- */

test("productionPlan derives every stage from existing state — nothing stored", () => {
  const doc = sd.createDoc();
  sd.completeGeneration(doc, sd.beginGeneration(doc, "initial", "x"), "剧本");
  const plan = productionPlan(pd(), doc);
  assert.equal(plan.episode.code, "EP01");
  const by = Object.fromEntries(plan.stages.map((s) => [s.key, s]));
  assert.equal(by.script.state, "done");        // one applied version
  assert.equal(by.shots.state, "done");         // the episode owns 2 shots
  assert.equal(by.frames.state, "active");      // 1 of 2 has an image
  assert.equal(by.frames.detail, "1 / 2");
  assert.equal(by.video.state, "todo");
  assert.equal(by.edit.state, "todo");
  assert.equal(by.final.state, "todo");
  // 场景 sc-2 has no characterRefs → bible sync is partial, not done
  assert.equal(by.bible.state, "active");
  assert.equal(by.bible.detail, "1/2 场景已联结");
});

test("productionPlan counts only the ACTIVE episode's shots", () => {
  const s = pd();
  // a second episode owning another shot must not inflate EP01's numbers
  s.draftShots = s.draftShots.concat([{ sequence: 3, title: "别集", description: "d", shotId: "shot-c", slot: "v1-3" }]);
  s.production.episodes.push({
    episodeId: "ep-2", title: "第 2 集", bgmAssetId: null,
    scenes: [{ sceneId: "sc-9", title: "S", shotIds: ["shot-c"], characterRefs: [], locationRef: null, ambienceAssetId: null, bgmAssetId: null }],
  });
  assert.equal(episodeStageCounts(s).total, 2);
  assert.equal(episodeShots(s).length, 2);
});

test("a shot owned by NO scene belongs to no episode — reported, never counted", () => {
  const doc = sd.createDoc();
  sd.completeGeneration(doc, sd.beginGeneration(doc, "initial", "x"), "剧本");
  const s = pd();
  s.draftShots = s.draftShots.concat([{ sequence: 3, title: "游离", description: "d", shotId: "shot-loose", slot: "v1-3" }]);
  // it is NOT this episode's work…
  assert.equal(episodeShots(s).length, 2);
  assert.equal(episodeStageCounts(s).total, 2);
  // …but it is real inventory and must still be visible
  assert.equal(unassignedShots(s).length, 1);
  const plan = productionPlan(s, doc);
  assert.equal(plan.unassigned, 1);
  assert.match(plan.stages.find((x) => x.key === "shots").detail, /另有 1 未归组/);

  // a second episode must NOT claim the same loose shot
  s.production.episodes.push({ episodeId: "ep-2", title: "第 2 集", bgmAssetId: null, scenes: [] });
  s.production.activeEpisodeId = "ep-2";
  assert.equal(episodeShots(s).length, 0);
  assert.equal(unassignedShots(s).length, 1);
});

test("a state-specific reference image satisfies the blocker check", () => {
  const s = pd();
  // the BASE character has no reference, but the state the scene selected does
  s.production.characters[0].referenceAssetIds = [];
  s.production.characters[0].activeReferenceAssetId = null;
  s.production.characters[0].states = [{
    stateId: "st-1", name: "黑化",
    overrides: { referenceAssetIds: ["ref-dark"], activeReferenceAssetId: "ref-dark" },
  }];
  s.production.episodes[0].scenes[0].characterRefs = [{ characterId: "c-1", stateId: "st-1" }];
  const a = episodeShots(s).find((x) => x.shotId === "shot-a");
  assert.deepEqual(shotBlockers(s, a), []); // resolved THROUGH the state — not blocked

  // and with no state selected, the empty base genuinely does block
  s.production.episodes[0].scenes[0].characterRefs = [{ characterId: "c-1", stateId: null }];
  assert.equal(shotBlockers(s, episodeShots(s).find((x) => x.shotId === "shot-a"))[0].code, "no-character-ref");
});

test("a final counts for the episode that RENDERED it, not for every episode", () => {
  const s = pd();
  s.finals = ["/f/ep1.mp4"];
  s.assets.finals = [{ assetId: "fin-1", url: "/f/ep1.mp4", origin: "compose", storageState: "local" }];
  const ep1 = s.production.episodes[0];
  // single-episode project: unambiguous
  assert.equal(episodeFinals(s, ep1), 1);

  // add a second episode → the link must be PROVEN by the render generation
  s.production.episodes.push({ episodeId: "ep-2", title: "第 2 集", bgmAssetId: null, scenes: [] });
  assert.equal(episodeFinals(s, ep1), 0); // nothing proves it yet
  s.generations = [{
    generationId: "g-1", type: "render", targetType: null, targetId: null,
    inputAssetIds: [], referenceAssetIds: [], userInstruction: null, promptSnapshot: null,
    provider: "ffmpeg-local", model: null, parameters: { episodeId: "ep-1" },
    status: "success", resultAssetIds: ["fin-1"], createdAt: null,
  }];
  assert.equal(episodeFinals(s, ep1), 1);
  assert.equal(episodeFinals(s, s.production.episodes[1]), 0); // never leaks across
});

test("shotBlockers name a real missing field, never a guess", () => {
  const s = pd();
  const shots = episodeShots(s);
  const a = shots.find((x) => x.shotId === "shot-a");
  const b = shots.find((x) => x.shotId === "shot-b");
  assert.deepEqual(shotBlockers(s, a), []); // fully wired
  const bb = shotBlockers(s, b);
  assert.equal(bb[0].code, "no-characters");
  assert.equal(bb[0].fix, "episodes");

  // a character with NO reference image blocks its shots
  const s2 = pd();
  s2.production.characters[0].referenceAssetIds = [];
  s2.production.characters[0].activeReferenceAssetId = null;
  const blocked = shotBlockers(s2, episodeShots(s2).find((x) => x.shotId === "shot-a"));
  assert.equal(blocked[0].code, "no-character-ref");
  assert.match(blocked[0].text, /沈昭昭/);
  assert.equal(blocked[0].fix, "settings");
});

test("the next action is the FIRST incomplete stage, not the most visible one", () => {
  const doc = sd.createDoc();
  sd.completeGeneration(doc, sd.beginGeneration(doc, "initial", "x"), "剧本");
  // sc-2 has no characterRefs → bible sync is incomplete, and that is exactly
  // what blocks shot-b. Proposing "generate images" first would send the
  // creator at a shot that cannot compile a consistent prompt.
  const plan = productionPlan(pd(), doc);
  assert.equal(plan.next.key, "bible");
  assert.equal(plan.next.goto, "episodes");
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].shotId, "shot-b");
  assert.equal(plan.blocked[0].reason.code, "no-characters");
});

test("next action reports ready vs blocked shots honestly", () => {
  const doc = sd.createDoc();
  sd.completeGeneration(doc, sd.beginGeneration(doc, "initial", "x"), "剧本");
  const s = pd();
  // wire sc-2 so the bible stage completes and the media stage leads…
  s.production.episodes[0].scenes[1].characterRefs = [{ characterId: "c-1", stateId: null }];
  // …but strip the character's reference image, so its shots are blocked
  s.production.characters[0].referenceAssetIds = [];
  s.production.characters[0].activeReferenceAssetId = null;
  const plan = productionPlan(s, doc);
  assert.equal(plan.next.key, "frames");
  assert.match(plan.next.detail, /1 个镜头需要画面/);
  assert.equal(plan.next.ready, 0);
  assert.equal(plan.next.blocked, 1);
  assert.equal(plan.next.firstBlocked, "shot-b");

  // with references restored, the same shot becomes READY
  const s2 = pd();
  s2.production.episodes[0].scenes[1].characterRefs = [{ characterId: "c-1", stateId: null }];
  const plan2 = productionPlan(s2, doc);
  assert.equal(plan2.next.key, "frames");
  assert.equal(plan2.next.ready, 1);
  assert.equal(plan2.next.blocked, 0);
  assert.equal(plan2.next.firstReady, "shot-b");
});

test("a finished episode reports no next action", () => {
  const doc = sd.createDoc();
  sd.completeGeneration(doc, sd.beginGeneration(doc, "initial", "x"), "剧本");
  const s = pd();
  s.production.episodes[0].scenes[1].characterRefs = [{ characterId: "c-1", stateId: null }];
  s.assetUploads = { "v1-1": chain([img("a1", 1, "shot-a")]), "v1-2": chain([img("a2", 1, "shot-b")]) };
  s.media = {
    video: { "v1-1": chain([img("v1", 1, "shot-a")]), "v1-2": chain([img("v2", 1, "shot-b")]) },
    audio: { "voice-v1-1": chain([img("au1", 1, "shot-a")]), "voice-v1-2": chain([img("au2", 1, "shot-b")]) },
  };
  s.timelines = { "ep-1": { clips: [{ clipId: "c", trackType: "video", assetId: "v1", startTime: 0, trimIn: 0, trimOut: 6 }], edited: true, settings: {} } };
  s.finals = ["/f/ep1.mp4"];
  const plan = productionPlan(s, doc);
  assert.equal(plan.next, null);
  assert.equal(plan.healthy, true);
});

/* -------------------------------------------------------------------------- */
/* asset inbox                                                                 */
/* -------------------------------------------------------------------------- */

test("assetInbox auto-classifies anything the domain already owns", () => {
  const s = pd();
  const ib = assetInbox(s);
  // a1 carries a creativeShotId that resolves → deterministic, not in the inbox
  assert.equal(ib.total, 1);
  assert.equal(ib.auto, 1);
  assert.equal(ib.pending, 0);
  assert.deepEqual(ib.items, []);
});

test("knownOwners reads every real reference — bible, scene audio, timeline, first frame", () => {
  const s = pd();
  s.production.episodes[0].scenes[0].ambienceAssetId = "amb-1";
  s.production.episodes[0].bgmAssetId = "bgm-1";
  s.timelines = { "ep-1": { clips: [{ clipId: "c", trackType: "video", assetId: "tl-1" }] } };
  s.assets.firstFrames = { "v1-1": { assetId: "ff-1", version: 1, url: "" } };
  const owners = knownOwners({
    production: s.production, timelines: s.timelines, generations: [], reg: s.assets,
  });
  assert.match(owners.get("ref-1"), /角色参考图/);
  assert.match(owners.get("ref-2"), /场景地参考图/);
  assert.match(owners.get("amb-1"), /场景环境音/);
  assert.match(owners.get("bgm-1"), /剧集 BGM/);
  assert.match(owners.get("tl-1"), /时间线片段/);
  assert.match(owners.get("ff-1"), /镜头首帧/);
});

test("assetInbox proposes from EVIDENCE and never attaches on its own", () => {
  const s = pd();
  // an upload that landed on a REAL shot's slot but recorded no shot id
  s.assets.images["v1-2"] = chain([img("a2", 1, null)]);
  const ib = assetInbox(s);
  const it = ib.items.find((x) => x.assetId === "a2");
  assert.equal(it.tier, "proposed");
  assert.equal(it.action, "attach");
  assert.equal(it.proposalShotId, "shot-b");
  assert.ok(it.confidence >= 0.7);
  assert.match(it.evidence, /槽位 v1-2/);
  // proposing is not attaching: the registry record is untouched
  assert.equal(s.assets.images["v1-2"].history[0].creativeShotId, null);
});

test("assetInbox keeps unowned, evidence-free assets as UNCERTAIN", () => {
  const s = pd();
  s.assets.images["loose-1"] = chain([img("a9", 1, null)]);
  const ib = assetInbox(s);
  const it = ib.items.find((x) => x.assetId === "a9");
  assert.equal(it.tier, "uncertain");
  assert.equal(it.confidence, 0);
  assert.equal(it.proposal, null);
  assert.equal(ib.byTier.uncertain, 1);
});

test("assetInbox never reattaches an asset whose shot left the draft", () => {
  const s = pd();
  s.assets.images["v1-9"] = chain([img("a8", 1, "shot-gone")]);
  const ib = assetInbox(s);
  const it = ib.items.find((x) => x.assetId === "a8");
  assert.equal(it.tier, "proposed");
  assert.equal(it.action, "review"); // review, NOT attach
  assert.match(it.evidence, /不存在/);
});

test("assetInbox surfaces unresolved paid results instead of adopting them", () => {
  const s = pd();
  s.assets.unresolvedPaid = [{ taskId: "t-1", serverShotId: "shot-004", creativeShotId: null, reason: "无法映射" }];
  const ib = assetInbox(s);
  const it = ib.items.find((x) => x.taskId === "t-1");
  assert.ok(it);
  assert.equal(it.action, "review");
  assert.equal(it.assetId, null);
});

test("assetInbox does NOT claim AI classification it has not implemented", () => {
  assert.equal(assetInbox(pd()).aiAssisted, false);
});

/* -------------------------------------------------------------------------- */
/* execution safety                                                            */
/* -------------------------------------------------------------------------- */

test("capability table: observe/plan never need confirmation, canon/paid/destructive always do", () => {
  for (const key of ["inspect-project", "find-missing-work", "classify-deterministic", "compile-prompt", "plan-next-actions"]) {
    assert.equal(needsConfirm(key), false, key);
    assert.equal(isAutomatic(key), true, key);
  }
  for (const key of ["canon-change", "attach-asset", "replace-active-asset", "bulk-paid-generate", "destructive", "final-render"]) {
    assert.equal(needsConfirm(key), true, key);
    assert.equal(levelOf(key), "execute", key);
    assert.ok(CAPABILITIES[key].why, `${key} must explain what it is asking about`);
  }
});

test("an UNKNOWN capability fails closed (confirmation required)", () => {
  assert.equal(needsConfirm("something-a-future-checkpoint-adds"), true);
  assert.equal(isAutomatic("something-a-future-checkpoint-adds"), false);
});

test("invoke() runs free actions directly and gates the dangerous ones", () => {
  let ran = 0;
  assert.equal(invoke("shots-generate", () => { ran += 1; }), true);
  assert.equal(ran, 1);

  // a declined confirmation must NOT run the action
  const asked = [];
  const declined = invoke("destructive", () => { ran += 1; }, {
    confirm: (msg) => { asked.push(msg); return false; },
  });
  assert.equal(declined, false);
  assert.equal(ran, 1);
  assert.match(asked[0], /破坏性/);

  // an accepted one does
  assert.equal(invoke("final-render", () => { ran += 1; }, { confirm: () => true }), true);
  assert.equal(ran, 2);
});

/* -------------------------------------------------------------------------- */
/* contextual surfacing                                                        */
/* -------------------------------------------------------------------------- */

test("a DANGLING bible reference blocks the shot instead of passing silently", () => {
  const s = pd();
  // the scene still references entities that were removed from the bible
  s.production.characters = [];
  s.production.locations = [];
  const codes = shotBlockers(s, episodeShots(s).find((x) => x.shotId === "shot-a")).map((b) => b.code);
  assert.ok(codes.includes("dangling-location"), codes.join(","));
  assert.ok(codes.includes("dangling-character"), codes.join(","));
  // and the plan reports the shot as blocked, never as ready
  const doc = sd.createDoc();
  sd.completeGeneration(doc, sd.beginGeneration(doc, "initial", "x"), "剧本");
  assert.ok(productionPlan(s, doc).blocked.some((b) => b.shotId === "shot-a"));
});

test("inbox counts add up: total === auto + pending", () => {
  const s = pd();
  s.assets.images["loose-1"] = chain([img("a9", 1, null)]);
  s.assets.unresolvedPaid = [{ taskId: "t-1", serverShotId: "x", creativeShotId: null, reason: "r" }];
  const ib = assetInbox(s);
  assert.equal(ib.total, ib.auto + ib.pending);
});

test("selection validity is scoped to the ACTIVE episode", () => {
  const s = pd();
  // shot-a belongs to EP01; a second episode must not consider it selectable
  assert.equal(isEpisodeShot(s, "shot-a"), true);
  assert.equal(defaultShotId(s), "shot-a");
  s.production.episodes.push({ episodeId: "ep-2", title: "第 2 集", bgmAssetId: null, scenes: [] });
  s.production.activeEpisodeId = "ep-2";
  assert.equal(isEpisodeShot(s, "shot-a"), false); // still in the draft, NOT in this episode
  assert.equal(defaultShotId(s), null);
  // and it is not selectable EITHER — it belongs to another episode, not to
  // the unassigned pool
  assert.equal(isSelectableShot(s, "shot-a"), false);
});

test("an UNASSIGNED shot stays selected — the list renders it as clickable", () => {
  // validating selection against episode ownership alone snapped the selection
  // back the instant an unassigned shot was clicked, so its detail and media
  // were unreachable
  const s = pd();
  // a draft shot no scene references — real inventory with no episode
  s.draftShots = s.draftShots.concat([
    { sequence: 3, title: "未归组", description: "d3", shotId: "shot-free", slot: "v1-3", duration_seconds: 6 },
  ]);
  assert.ok(storyboardModel(s).unassigned.some((x) => x.shotId === "shot-free"));
  assert.equal(isEpisodeShot(s, "shot-free"), false, "it belongs to no episode");
  assert.equal(isSelectableShot(s, "shot-free"), true, "but the shell must keep it selected");
});

test("episodeTotal excludes the unassigned pool", () => {
  const s = pd();
  s.draftShots = s.draftShots.concat([{ sequence: 3, title: "游离", description: "d", shotId: "shot-loose", slot: "v1-3" }]);
  const m = storyboardModel(s);
  assert.equal(m.episodeTotal, 2);
  assert.equal(m.unassigned.length, 1);
  assert.deepEqual(m.episodeShotIds, ["shot-a", "shot-b"]);
});

test("the audio stage is measured against SPEAKING shots, not every shot", () => {
  const doc = sd.createDoc();
  sd.completeGeneration(doc, sd.beginGeneration(doc, "initial", "x"), "剧本");
  const s = pd();
  s.production.episodes[0].scenes[1].characterRefs = [{ characterId: "c-1", stateId: null }];
  // only shot-a has a line, and it already has a take
  s.draftShots[0].dialogue = "「你到底是谁？」";
  s.media = { video: {}, audio: { "voice-v1-1": chain([img("au1", 1, "shot-a")]) } };
  const c = episodeStageCounts(s);
  assert.equal(c.audioTotal, 1);
  assert.equal(c.audio, 1);
  const row = productionPlan(s, doc).stages.find((x) => x.key === "audio");
  assert.equal(row.state, "done");           // NOT 1/2 forever
  assert.match(row.detail, /1 \/ 1 有台词/);

  // an episode with no dialogue at all has nothing to do here
  const s2 = pd();
  s2.production.episodes[0].scenes[1].characterRefs = [{ characterId: "c-1", stateId: null }];
  const row2 = productionPlan(s2, doc).stages.find((x) => x.key === "audio");
  assert.equal(row2.state, "done");
  assert.equal(row2.detail, "无台词");

  // a speaking shot WITHOUT a take is still counted as outstanding
  const s3 = pd();
  s3.production.episodes[0].scenes[1].characterRefs = [{ characterId: "c-1", stateId: null }];
  s3.draftShots[1].dialogue = "「三年前也是这样的雨。」";
  const c3 = episodeStageCounts(s3);
  assert.equal(c3.audioTotal, 1);
  assert.equal(c3.audio, 0);
});

test("the rail badge and the plan row can never disagree about audio", () => {
  const doc = sd.createDoc();
  sd.completeGeneration(doc, sd.beginGeneration(doc, "initial", "x"), "剧本");
  const s = pd();
  s.production.episodes[0].scenes[1].characterRefs = [{ characterId: "c-1", stateId: null }];
  s.draftShots[0].dialogue = "「你到底是谁？」";           // 1 of 2 shots speaks
  s.media = { video: {}, audio: { "voice-v1-1": chain([img("au1", 1, "shot-a")]) } };

  const rail = episodeStages(s);
  const row = productionPlan(s, doc).stages.find((x) => x.key === "audio");
  // the rail counts speaking shots, exactly like the plan — not all 2 shots
  assert.equal(rail.badges.audio, "1/1");
  assert.deepEqual(rail.ratios.audio, { done: 1, total: 1 });
  assert.equal(row.state, "done");
  assert.match(row.detail, /1 \/ 1/);

  // an episode with no lines shows no audio badge at all rather than "0/2"
  const s2 = pd();
  s2.production.episodes[0].scenes[1].characterRefs = [{ characterId: "c-1", stateId: null }];
  assert.equal(episodeStages(s2).badges.audio, "");
  assert.equal(episodeStages(s2).ratios.audio, undefined);
});

test("migration-displaced media is surfaced, never hidden from the inbox", () => {
  const s = pd();
  // the v2→v3 migration preserves unplaceable media as {key, entry} blobs of
  // arbitrary legacy shape — a chain, a bare url string, or junk
  s.assets.displaced = [
    { key: "node-uploads:n1", entry: chain([img("d1", 1, null)]) },
    { key: "legacy-slot", entry: "/u/old.png" },
    { key: "junk", entry: 42 },
  ];
  const ib = assetInbox(s);
  const rows = ib.items.filter((i) => i.displacedKey);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.tier === "uncertain" && r.action === "review"));
  // a viewable frame is recovered where the shape allows it
  assert.equal(rows.find((r) => r.displacedKey === "legacy-slot").url, "/u/old.png");
  assert.equal(rows.find((r) => r.displacedKey === "junk").url, "");
  // and the header arithmetic still adds up
  assert.equal(ib.total, ib.auto + ib.pending);
});


test("a generation result whose shot left the draft stays in the inbox", () => {
  // a regenerated storyboard mints fresh shot ids, so an older generation can
  // point at a shot that no longer exists. Treating it as a settled owner would
  // silently drop the asset out of the review queue.
  const s = pd();
  s.assets.images["v1-9"] = chain([img("orphan-1", 1, null)]);
  s.generations = [{
    generationId: "g-old", type: "image", targetType: "shot", targetId: "shot-gone",
    status: "success", resultAssetIds: ["orphan-1"],
  }];
  const owners = knownOwners({
    production: s.production, timelines: s.timelines, generations: s.generations,
    reg: s.assets, liveShotIds: new Set(["shot-a", "shot-b"]),
  });
  assert.equal(owners.has("orphan-1"), false, "a dead target names no owner");
  const ib = assetInbox(s);
  assert.ok(ib.items.some((x) => x.assetId === "orphan-1"), "it must still need a human decision");

  // and a LIVE target does settle it
  s.generations[0].targetId = "shot-a";
  assert.ok(!assetInbox(s).items.some((x) => x.assetId === "orphan-1"));
});


test("a project whose shots are ALL unassigned can still be worked on", () => {
  // the target behaviour: enter a shot workspace, and the first unassigned shot
  // is reachable. Returning null here left the centre column blank with no way
  // to reach real inventory.
  const s = pd();
  s.production.episodes[0].scenes = [];      // this episode owns nothing
  const m = storyboardModel(s);
  assert.equal(m.episodeShotIds.length, 0);
  assert.deepEqual(m.unassigned.map((x) => x.shotId), ["shot-a", "shot-b"]);
  assert.equal(defaultShotId(s), "shot-a", "falls back to the first unassigned shot");
  assert.equal(isSelectableShot(s, "shot-a"), true);
  // and it is STILL not credited to the episode
  assert.equal(isEpisodeShot(s, "shot-a"), false);
  assert.equal(m.episodeTotal, 0);
});

test("an episode that owns shots keeps preferring its own", () => {
  const s = pd();
  assert.equal(defaultShotId(s), "shot-a"); // owned by EP01's scene, not the pool
  s.production.episodes.push({ episodeId: "ep-2", title: "第 2 集", bgmAssetId: null, scenes: [] });
  s.production.activeEpisodeId = "ep-2";
  // EP02 owns nothing; shot-a/shot-b belong to EP01's scenes, so they are NOT
  // unassigned and must not be offered here
  assert.equal(storyboardModel(s).unassigned.length, 0);
  assert.equal(defaultShotId(s), null);
});

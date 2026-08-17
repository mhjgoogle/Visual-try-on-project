// TASK-082 §1.3 — 落地页项目卡：封面 + 进度.
//
// The rules under test:
//
//   1. A cover is NEVER a file the probe says is gone (§1.3 「封面不是碎图」).
//   2. A project whose canvas cannot be read prints NO numbers — not zeros. 「0 集
//      · 0 镜」 for a project full of work is the same lie 「余额 ¥0」 was.
//   3. The counts are the document's own: shots are counted as a SET (a shot id
//      in two scenes is one shot), and 「已生成」 counts SHOTS with a selected
//      video, not takes.
import { test } from "node:test";
import assert from "node:assert/strict";

import { projectCardModel, pickCover, cardStats, renderCover } from "../src/ui/landingcard.js";
import { currentDraftShots } from "../src/workflow/shotmap.js";
import { MISSING, PRESENT, createMediaProbe } from "../src/services/mediaprobe.js";

const asset = (over) => ({
  assetId: over.assetId, url: over.url, version: over.version || 1,
  origin: "upload", storageState: "local", kind: over.kind || null,
  creativeShotId: over.creativeShotId || null,
  links: {}, tags: [],
});

/** A canvas document in the shape `persist.loadCanvas().doc` really has. */
const DOC = {
  production: {
    episodes: [
      {
        episodeId: "ep-1",
        scenes: [
          { sceneId: "sc-1", shotIds: ["sh-1", "sh-2"] },
          // sh-2 again: the same shot, listed twice
          { sceneId: "sc-2", shotIds: ["sh-2", "sh-3"] },
        ],
      },
      { episodeId: "ep-2", scenes: [] },
    ],
  },
  assets: {
    images: {
      "ref-1": { current: 1, history: [asset({ assetId: "i1", url: "/media/ref.png", kind: "character-reference" })] },
      "shot-1": { current: 2, history: [
        asset({ assetId: "i2", url: "/media/old.png", version: 1 }),
        asset({ assetId: "i3", url: "/media/shot.png", version: 2 }),
      ] },
    },
    videos: {
      "video-1": { current: 2, history: [
        // three TAKES of one shot — 「已生成」 must count the shot once
        asset({ assetId: "v1", url: "/media/a.mp4", version: 1, creativeShotId: "sh-1" }),
        asset({ assetId: "v2", url: "/media/b.mp4", version: 2, creativeShotId: "sh-1" }),
      ] },
    },
    audio: {}, firstFrames: {}, finals: [], displaced: [],
  },
};

test("集 / 镜 / 已生成 都来自文档自己，镜按集合去重", () => {
  const m = projectCardModel(DOC);
  assert.equal(m.readable, true);
  assert.equal(m.episodes, 2);
  // sh-1, sh-2, sh-3 — sh-2 appears in two scenes and is ONE shot
  assert.equal(m.shots, 3);
  assert.equal(m.grouped, 3, "every shot here is claimed by a scene");
  // one shot with a selected video, not two takes
  assert.equal(m.generated, 1);
  // all grouped → no parenthetical, because there is nothing to explain
  assert.equal(cardStats(m), "2 集 · 3 镜 · 1 已生成");
});

/* ------------------------------------------------------------------------- */
/* TASK-086 §3 · 「镜」 means the shots that EXIST, and says how many are grouped */
/* ------------------------------------------------------------------------- */

/** The live project's shape: a drafted shot list, and NO scene claiming any of
 *  it. `照见未明rev2` really is this — 60 drafted, 0 grouped — and the card said
 *  「0 镜」 while 本集看板 said 「60 个镜头」. */
const UNGROUPED = {
  production: { episodes: [{ episodeId: "ep-1", scenes: [] }, { episodeId: "ep-2", scenes: [] }] },
  nodes: [
    { id: "n2", type: "scriptgen", cur: 1, versions: [
      { v: 1, raw: [
        { shotId: "sh-a", slot: "v1-1" },
        { shotId: "sh-b", slot: "v1-2" },
        { shotId: "sh-c", slot: "v1-3" },
      ] },
    ] },
  ],
  assets: { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [] },
};

test("草稿里的镜头算「镜」，哪怕一个场景都没归组（TASK-086 §3）", () => {
  const m = projectCardModel(UNGROUPED);
  assert.equal(m.shots, 3, "3 个草稿镜头存在，卡上不能写 0");
  assert.equal(m.grouped, 0);
  assert.equal(cardStats(m), "2 集 · 3 镜（0 已归组） · 0 已生成");
});

test("未全部归组时必须写出口径，不能只留一个数字", () => {
  const stats = cardStats({ readable: true, episodes: 48, shots: 60, grouped: 0, generated: 0 });
  assert.match(stats, /60 镜/);
  assert.match(stats, /已归组/, "两个数字不一致的地方必须说明口径（GAP-06 同一族）");
});

test("归组数与草稿数取并集，永远不小于任何一半", () => {
  // a shot a scene still claims but the CURRENT draft no longer lists: it exists
  const doc = {
    ...UNGROUPED,
    production: { episodes: [{ episodeId: "ep-1", scenes: [{ sceneId: "sc-1", shotIds: ["sh-a", "sh-gone"] }] }] },
  };
  const m = projectCardModel(doc);
  assert.equal(m.shots, 4, "sh-a/b/c 加上只有场景还记得的 sh-gone");
  assert.equal(m.grouped, 2);
});

test("没有 scriptgen 节点时不抛异常，也不臆造镜头数", () => {
  const m = projectCardModel({ production: { episodes: [] }, assets: {} });
  assert.equal(m.readable, true);
  assert.equal(m.shots, 0);
  assert.equal(m.grouped, 0);
});

test("草稿读法只有一处：卡片与 hydrate 用的是同一个 currentDraftShots", () => {
  // Not a spelling check — call it and require it to answer the same list the
  // card counted. A second copy of that node walk is how two surfaces came to
  // disagree about 「几镜」 in the first place.
  assert.equal(currentDraftShots(UNGROUPED).length, 3);
  assert.equal(currentDraftShots(null).length, 0);
  assert.equal(currentDraftShots({ nodes: [] }).length, 0);
  // a version that is not the current one is not the draft
  assert.equal(
    currentDraftShots({ nodes: [{ type: "scriptgen", cur: 2, versions: [{ v: 1, raw: [{ shotId: "x" }] }] }] }).length,
    0,
  );
});

test("画布读不出来时一个数字都不写，绝不写 0", () => {
  const m = projectCardModel(null);
  assert.equal(m.readable, false);
  assert.equal(m.episodes, null);
  assert.equal(m.shots, null);
  assert.equal(m.generated, null);
  assert.equal(cardStats(m), null, "an unreadable canvas must print no stats line at all");
  assert.deepEqual(m.coverCandidates, []);
});

test("封面候选先参考图再镜头图，且只取当前版本", () => {
  const m = projectCardModel(DOC);
  assert.deepEqual(m.coverCandidates, ["/media/ref.png", "/media/shot.png"]);
  // the superseded take is NOT a candidate: it is not what this project looks
  // like now
  assert.ok(!m.coverCandidates.includes("/media/old.png"));
});

test("封面不选一个探针判定为 MISSING 的文件", () => {
  const m = projectCardModel(DOC);
  const probe = createMediaProbe({ fetchImpl: async () => ({ ok: true, status: 200 }) });
  // nothing known yet → the first candidate wins
  assert.equal(pickCover(m.coverCandidates, (u) => probe.isMissing(u)), "/media/ref.png");
  // the reference turns out to be gone → the NEXT candidate becomes the cover
  probe.observe("/media/ref.png", false);
  assert.equal(probe.isMissing("/media/ref.png"), true);
  assert.equal(pickCover(m.coverCandidates, (u) => probe.isMissing(u)), "/media/shot.png");
  // both gone → no cover at all, and the caller falls back to the placeholder
  probe.observe("/media/shot.png", false);
  assert.equal(pickCover(m.coverCandidates, (u) => probe.isMissing(u)), null);
});

test("「问不出来」不等于「不见了」——封面照用", () => {
  const probe = createMediaProbe({ fetchImpl: async () => ({ ok: false, status: 405 }) });
  const m = projectCardModel(DOC);
  return probe.scan(m.coverCandidates).then(() => {
    // a server that declines HEAD must not blank the landing page
    assert.notEqual(probe.stateOf ? probe.stateOf("/media/ref.png") : null, MISSING);
    assert.equal(probe.isMissing("/media/ref.png"), false);
    assert.equal(pickCover(m.coverCandidates, (u) => probe.isMissing(u)), "/media/ref.png");
  });
});

test("没有封面时保留原来的占位图，不留一个空框", () => {
  const fallback = `<div class="thumb">📁</div>`;
  assert.equal(renderCover(null, fallback), fallback);
  const html = renderCover("/media/ref.png", fallback);
  assert.match(html, /thumb-cover/);
  // it carries `data-media-url`, which is what lets a load failure be RECORDED
  // rather than merely displayed as a broken glyph
  assert.match(html, /data-media-url="\/media\/ref\.png"/);
  assert.match(html, /data-pcard-cover="1"/);
});

test("空项目是可读的空，不是读不出来", () => {
  const m = projectCardModel({ production: { episodes: [] }, assets: {} });
  assert.equal(m.readable, true);
  assert.equal(cardStats(m), "0 集 · 0 镜 · 0 已生成");
  assert.notEqual(PRESENT, MISSING); // the two states are distinct, by construction
});

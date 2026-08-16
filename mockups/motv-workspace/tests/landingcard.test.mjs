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
  // one shot with a selected video, not two takes
  assert.equal(m.generated, 1);
  assert.equal(cardStats(m), "2 集 · 3 镜 · 1 已生成");
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

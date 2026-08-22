// TASK-079 批次 A — 审阅面与链式流转，作为规则：
//
//   1. ⑨ 粗剪审片是**一集的镜头 × 三列清单**，一屏之内回答：哪些镜头有视频、
//      各用了哪个模型、多长、首帧来自哪张、哪些失败了。不再是 60 个页码。
//   2. 状态取自 `shotprod.shotStage` 那**一份**计算（经 dailiesModel），
//      不新建第二份。
//   3. 记录里没有的东西如实写「未记录」，绝不填成看起来合理的值。
//   4. 筛选是纯函数，且每个筛选都报出自己的条数。
//   5. 「以此生成 →」按**现有能力**如实给；不可用的组合灰掉**并说明原因**，
//      不隐藏 —— 而且两种「没有下一镜」的原因不能混为一谈。
//
// 纯测试：无 DOM、无网络。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  reviewBoardModel, reviewRow, REVIEW_FILTERS, NOT_RECORDED, NOT_MEASURED,
} from "../src/ui/cutreview.js";
import { chainOptions, renderChainMenu } from "../src/ui/chain.js";

/* ========================================================================= */
/* 固定装置 —— 一集三个镜头：一个已通过、一个只有图、一个什么都没有且失败过    */
/* ========================================================================= */

const ITEM = (over = {}) => ({
  shotId: "shot-a", index: 0, title: "S1-01 实验室", description: "白天，算法实验室",
  sceneId: "sc-1", sceneTitle: "第一场", duration: 10,
  stage: "todo-review", stageLabel: "待审片", approved: false, staleApproval: false,
  canApprove: true, playable: true, videoUrl: "u/a.mp4", design: [],
  ...over,
});

const DETAIL = (over = {}) => ({
  shot: { shotId: "shot-a" },
  slot: "v1-1",
  images: { current: 1, list: [{ version: 1, url: "u/a.png", origin: "付费生成", current: true, assetId: "img-a" }] },
  videos: { current: 1, list: [{ version: 1, url: "u/a.mp4", origin: "付费生成", current: true, assetId: "vid-a" }] },
  videoSources: { 1: { version: 1, origin: "付费生成", url: "u/a.png", proven: true } },
  generations: [
    { generationId: "g2", type: "video", status: "success", model: "video-01", provider: "minimax", createdAt: "2026-08-16T00:00:00Z", resultAssetIds: ["vid-a"], error: null },
    { generationId: "g1", type: "image", status: "success", model: "image-02", provider: "minimax", createdAt: "2026-08-15T00:00:00Z", resultAssetIds: ["img-a"], error: null },
  ],
  ...over,
});

const EMPTY_DETAIL = {
  shot: { shotId: "shot-c" },
  slot: "v1-3",
  images: { current: 0, list: [] },
  videos: { current: 0, list: [] },
  videoSources: {},
  generations: [
    { generationId: "gf", type: "video", status: "failed", model: "video-01", provider: "minimax", createdAt: "2026-08-16T00:00:00Z", resultAssetIds: [], error: "provider rejected the request" },
  ],
};

function board({ filter = "all" } = {}) {
  const items = [
    ITEM({ shotId: "shot-a", index: 0, stage: "approved", stageLabel: "已通过", approved: true }),
    ITEM({ shotId: "shot-b", index: 1, title: "S1-02 屏幕", stage: "generated", stageLabel: "已生成", playable: false, videoUrl: "", canApprove: false }),
    ITEM({ shotId: "shot-c", index: 2, title: "S1-03 走廊", stage: "todo-design", stageLabel: "待设计", playable: false, videoUrl: "", canApprove: false, sceneId: null, sceneTitle: null }),
  ];
  const details = {
    "shot-a": DETAIL(),
    "shot-b": DETAIL({ videos: { current: 0, list: [] }, videoSources: {}, generations: [DETAIL().generations[1]] }),
    "shot-c": EMPTY_DETAIL,
  };
  const dailies = { items, total: 3, approved: 1, remaining: 2, playable: 1 };
  return reviewBoardModel(dailies, (id) => details[id] || null, { filter });
}

/* ========================================================================= */
/* 1 · 一屏之内回答得出来                                                     */
/* ========================================================================= */

test("每一条视频写着用了哪个模型、多长、首帧来自哪张", () => {
  const r = reviewRow(ITEM(), DETAIL());
  assert.equal(r.video.model, "video-01");
  assert.equal(r.video.duration, "10s（设计）", "时长要标明是设计值 —— 实际时长没人存过");
  assert.equal(r.video.sourceFrame.url, "u/a.png");
  assert.equal(r.video.sourceFrame.version, 1);
  assert.equal(r.image.model, "image-02", "图片那一列也说得出模型");
});

test("首帧只在**能证明**的时候才说，证不出来就说未记录", () => {
  // videoSources 里 proven:false 表示这一版视频没有对应的 Generation 输入记录，
  // 拿槽位上最新那张图冒充，会把更早的视频说成来自一张当时还不存在的图。
  const d = DETAIL({ videoSources: { 1: { version: 9, origin: "手工上传", url: "u/x.png", proven: false } } });
  assert.equal(reviewRow(ITEM(), d).video.sourceFrame, null);
});

test("还没量过就说「未探测」—— 不编一个数，也不说成「未记录」", () => {
  // TASK-103 批次 C 之前这里写「未记录」，那是把两件事说成一件：登记表里确实
  // 没有像素尺寸字段（今天仍然没有，加它是一次 schema 改动），但文件就在磁盘上，
  // 量一下就知道。「未记录」听起来像没救了，「未探测」才是真话 —— 而两者要求的
  // 下一步完全不同。
  const r = reviewRow(ITEM(), DETAIL());
  assert.equal(r.image.size, NOT_MEASURED);
  assert.equal(r.video.size, NOT_MEASURED);
  assert.equal(r.image.measured, null);
});

test("量到了就给真实像素；量不到就说清楚是哪种量不到", () => {
  const measured = {
    "u/a.png": { state: "ok", width: 1920, height: 1080, duration: null },
    "u/a.mp4": { state: "no_ffprobe" },
  };
  const r = reviewRow(ITEM(), DETAIL(), { measuredOf: (u) => measured[u] || null });
  assert.match(r.image.size, /1920×1080/);
  assert.match(r.video.size, /没有 ffprobe/);
  // 「量过了，量不出来」绝不退化成「还没量」——否则界面会一直劝人再按一次
  assert.notEqual(r.video.size, NOT_MEASURED);
});

test("真实字节数只作附注，绝不冒充像素尺寸", () => {
  // 字节数是目录审计免费带回来的真实值，但它不是尺寸。让它顶替像素值，
  // 就是这一列一开始要避免的那种「填一个看起来像答案的东西」。
  const r = reviewRow(ITEM(), DETAIL(), { bytesOf: (u) => (u === "u/a.png" ? 2048 : null) });
  assert.match(r.image.size, /^未探测 · 2 KB$/);
  assert.equal(r.video.size, NOT_MEASURED);
});

test("实测时长与设计时长不一致时**两个都说**", () => {
  // 差异本身就是审片要看的东西：只显示一个，等于替创作者决定哪个才算数。
  const measured = { "u/a.mp4": { state: "ok", width: 1920, height: 1080, duration: 4.5 } };
  const r = reviewRow(ITEM(), DETAIL(), { measuredOf: (u) => measured[u] || null });
  assert.match(r.video.duration, /4\.50s/);
  assert.match(r.video.duration, /设计 10s/);
});

test("没量过时时长仍如实标明它是设计值，不是实测值", () => {
  assert.equal(reviewRow(ITEM(), DETAIL()).video.duration, "10s（设计）");
});

test("模型没记录的生成，说未记录，而不是留空", () => {
  const d = DETAIL({ generations: [{ generationId: "g", type: "video", status: "success", model: null, provider: null, createdAt: null, resultAssetIds: ["vid-a"], error: null }] });
  assert.equal(reviewRow(ITEM(), d).video.model, NOT_RECORDED);
});

test("模型与状态属于**当前那一条**媒体，不是这个镜头最新那次生成（codex round 1 · P1）", () => {
  // 一条能播的视频来自更早那次成功，后来又试了一次并失败了。按类型取最新，
  // 会把这条好视频标成 failed、并挂上那次失败用的模型 —— 而这一页存在的
  // 全部意义就是把「它是哪来的」说对。
  const d = DETAIL({
    generations: [
      { generationId: "g3", type: "video", status: "failed", model: "video-BAD", provider: "p", createdAt: "2026-08-17T00:00:00Z", resultAssetIds: [], error: "rejected" },
      { generationId: "g2", type: "video", status: "success", model: "video-01", provider: "p", createdAt: "2026-08-16T00:00:00Z", resultAssetIds: ["vid-a"], error: null },
      { generationId: "g1", type: "image", status: "success", model: "image-02", provider: "p", createdAt: "2026-08-15T00:00:00Z", resultAssetIds: ["img-a"], error: null },
    ],
  });
  const r = reviewRow(ITEM(), d);
  assert.equal(r.video.model, "video-01", "显示做出这条视频的那次生成的模型");
  assert.equal(r.video.status, "success", "而不是后来那次失败的状态");
  // …失败本身没有被吞掉：它仍然进「失败」筛选
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].model, "video-BAD");
});

test("当前媒体没有任何生成认领它，就说是导入的 —— 不借用别人的模型", () => {
  const d = DETAIL({
    videos: { current: 1, list: [{ version: 1, url: "u/a.mp4", origin: "手工上传", current: true, assetId: "vid-UPLOADED" }] },
    generations: [
      { generationId: "g2", type: "video", status: "success", model: "video-01", provider: "p", createdAt: "2026-08-16T00:00:00Z", resultAssetIds: ["vid-OTHER"], error: null },
    ],
  });
  const r = reviewRow(ITEM(), d);
  assert.equal(r.video.status, "imported");
  assert.equal(r.video.model, null, "手工上传的东西没有模型，不能借一个来填");
});

test("当前媒体没有 assetId（历史数据）时不猜出处", () => {
  const d = DETAIL({
    videos: { current: 1, list: [{ version: 1, url: "u/a.mp4", origin: "手工上传", current: true, assetId: null }] },
  });
  const r = reviewRow(ITEM(), d);
  assert.equal(r.video.model, null);
  assert.equal(r.video.status, "imported");
});

test("状态取自传进来的 stage，不在这里重算（守卫）", () => {
  const r = reviewRow(ITEM({ stage: "approved", stageLabel: "已通过", approved: true }), DETAIL());
  assert.equal(r.stage, "approved");
  assert.equal(r.stageLabel, "已通过");
  // 这个模型不导出任何自己判定 stage 的函数
  assert.equal(typeof reviewRow, "function");
});

/* ========================================================================= */
/* 2 · 筛选                                                                   */
/* ========================================================================= */

test("六个筛选都是纯函数，且各报各的条数", () => {
  const m = board();
  assert.deepEqual(REVIEW_FILTERS.map(([k]) => k),
    ["all", "approved", "review", "generated", "pending", "failed"]);
  assert.equal(m.counts.all, 3);
  assert.equal(m.counts.approved, 1);
  assert.equal(m.counts.generated, 2, "有图或有视频都算已生成");
  assert.equal(m.counts.pending, 1, "shot-c 什么都没有");
  assert.equal(m.counts.failed, 1, "shot-c 有一条失败记录");
});

test("按「失败」筛，筛出来的就是有失败记录的那些", () => {
  const m = board({ filter: "failed" });
  assert.deepEqual(m.visible.map((r) => r.shotId), ["shot-c"]);
  assert.equal(m.visible[0].failed[0].error, "provider rejected the request");
});

test("按「待生成」筛不会把只有图的镜头算进去", () => {
  assert.deepEqual(board({ filter: "pending" }).visible.map((r) => r.shotId), ["shot-c"]);
});

test("认不出来的筛选键退回「全部」，而不是筛出空", () => {
  const m = board({ filter: "nonsense" });
  assert.equal(m.filter, "all");
  assert.equal(m.visible.length, 3);
});

test("三个镜头都在，一屏之内 —— 不再是一次一个", () => {
  const m = board();
  assert.equal(m.rows.length, 3);
  assert.deepEqual(m.rows.map((r) => r.seq), [1, 2, 3]);
});

/* ========================================================================= */
/* 3 · 「以此生成 →」按现有能力如实给                                          */
/* ========================================================================= */

test("图片能作视频首帧；图生图与设为角色参考今天不可用，灰掉并说明", () => {
  const opts = chainOptions("image", { slot: "v1-1" });
  const by = Object.fromEntries(opts.map((o) => [o.id, o]));
  assert.equal(by["to-video"].ok, true);
  assert.equal(by["to-image"].ok, false);
  assert.ok(by["to-image"].reason.includes("ADR-0038"), "说明为什么没有，而不是空着");
  assert.equal(by["to-charref"].ok, false);
  assert.ok(by["to-charref"].reason.includes("上传文件"));
});

test("不可用的组合是灰掉并写出原因，不是消失（守卫）", () => {
  const html = renderChainMenu("image", chainOptions("image", { slot: "v1-1" }), { open: true, shotId: "shot-a" });
  assert.ok(html.includes("图生图"), "不可用的组合仍然在菜单里");
  assert.ok(html.includes("chain-item off"), "灰掉");
  assert.ok(html.includes("ADR-0038"), "并带着原因");
  assert.ok(!html.includes('data-chain="to-image"'), "但它不可点");
  assert.ok(html.includes('data-chain="to-video"'), "可用的那条是可点的");
});

test("「没有下一镜」的两种原因不得混为一谈", () => {
  // 真实项目 60 个镜头全部未归入场景。说成「这是最后一个镜头」就是假话。
  const unassigned = chainOptions("video", { slot: "v1-1", nextShot: null, inScene: false });
  const lastInScene = chainOptions("video", { slot: "v1-1", nextShot: null, inScene: true });
  const tail = (o) => o.find((x) => x.id === "tail-to-next");
  assert.ok(tail(unassigned).reason.includes("还没有归入任何场景"));
  assert.ok(tail(lastInScene).reason.includes("本场景的最后一个镜头"));
  assert.notEqual(tail(unassigned).reason, tail(lastInScene).reason);
});

test("有下一镜时，选项直接写出它是哪一镜", () => {
  const opts = chainOptions("video", { slot: "v1-1", nextShot: { shotId: "shot-b", title: "S1-02 屏幕" } });
  const tail = opts.find((o) => o.id === "tail-to-next");
  assert.equal(tail.ok, true);
  assert.ok(tail.label.includes("S1-02 屏幕"), "落点要说清是接到哪一镜");
});

test("进时间线如实标注它是派生的 —— 不假装是一次「加入」", () => {
  // 时间线由每个镜头的当前媒体派生（timelinectl.gatherRows），这条剪辑本来就在
  // 里面。写成「加入时间线」会让创作者以为自己做了一个不存在的动作。
  for (const kind of ["video", "audio"]) {
    const t = chainOptions(kind, { slot: "v1-1" }).find((o) => o.id === "to-timeline");
    assert.equal(t.ok, true);
    assert.equal(t.derived, true);
  }
  const html = renderChainMenu("audio", chainOptions("audio", { slot: "v1-1" }), { open: true, shotId: "s" });
  assert.ok(html.includes("已自动纳入"));
});

test("镜头身份未解析时，需要槽位的那些选项灰掉并说明", () => {
  const opts = chainOptions("image", { slot: null });
  assert.equal(opts.find((o) => o.id === "to-video").ok, false);
  assert.ok(opts.find((o) => o.id === "to-video").reason.includes("槽位"));
});

test("菜单没打开时不渲染任何选项", () => {
  const html = renderChainMenu("image", chainOptions("image", { slot: "v1-1" }), { open: false, shotId: "s" });
  assert.ok(html.includes("data-chain-open"));
  assert.ok(!html.includes("chain-menu"));
});

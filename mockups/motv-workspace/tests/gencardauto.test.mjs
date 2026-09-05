// 生成卡上那颗 ✨ 自动出图 —— TASK-139 / REQ-008 判据 1。
//
// **为什么这个文件必须存在**：上一版我把按钮加在了「资产准备」那个旧的流程节点画布
// 上，而当前 IA 是三空间十一页，那个画布不在里面 —— 产品负责人打开界面**找不到按钮**。
// 测试当时是绿的，因为它测的是「那个处理器」，没有人问过「那一页他到得了吗」。
// 所以这里钉的是**活的那张生成卡**（`shotwork → 画面` 用的就是它）。
//
// 纯测试：无 DOM 框架、无网络 —— 一个最小的 card stub 就够。
import test from "node:test";
import assert from "node:assert/strict";

import { renderGenCard, bindGenCard } from "../src/ui/gencard.js";
import { renderEpCanvas } from "../src/ui/epcanvas.js";

const MODEL = {
  kind: "image",
  shotId: "shot-1",
  label: "画面",
  prompt: "竹林里的少年剑客，电影感",
  promptCompiled: "竹林里的少年剑客，电影感",
  promptEdited: false,
  gaps: [],
  chips: [],
  startFrame: null,
  slot: "s1",
  canSubmit: false,
  paid: false,
  quote: null,
  failures: [],
  refCapability: null,
  refViolation: null,
};

test("✨ 只长在画面卡上，并且带着这一镜的槽位", () => {
  const img = renderGenCard(MODEL);
  assert.match(img, /data-gc-auto/, "画面卡必须有自动出图按钮");
  assert.match(img, /data-gc-slot="s1"/, "槽位随渲染带下来，bind 不再重推一遍");
  assert.match(img, /免费/);
  assert.equal(/data-gc-auto[\s\S]*\$/.test(img.split("data-gc-auto")[1].slice(0, 200)), false,
    "这条路上没有金额可报");

  // 视频卡上按下去必然失败（这条来源只出图）—— 一颗必然失败的按钮比没有按钮更糟
  const vid = renderGenCard({ ...MODEL, kind: "video", label: "视频" });
  assert.equal(/data-gc-auto/.test(vid), false);
});

/** 最小 card stub：只实现 bindGenCard 真正用到的两个查询。 */
function fakeRoot(overrides = {}) {
  const auto = { dataset: { gcSlot: "s1" }, onclick: null, disabled: false };
  const area = { value: MODEL.prompt, oninput: null };
  const card = {
    querySelector: (sel) =>
      sel === "[data-gc-auto]" ? auto
      : sel === "[data-gc-prompt]" ? area
      : sel === "[data-gc-compiled]" ? { textContent: MODEL.promptCompiled }
      : overrides[sel] !== undefined ? overrides[sel]
      : null,
    querySelectorAll: () => [],
  };
  return {
    auto,
    area,
    root: { querySelector: (sel) => (sel === '[data-gc="image"]' ? card : null) },
  };
}

function fakeCtx(generateShotImage) {
  const log = { toasts: [] };
  return {
    log,
    toast: (m) => log.toasts.push(m),
    media: { generateShotImage },
  };
}

test("点一下 → 用编辑框里那份 Prompt、按这一镜的槽位生成（判据 1）", async () => {
  const calls = [];
  const { auto, root } = fakeRoot();
  const ctx = fakeCtx(async (slot, shotId, prompt) => {
    calls.push({ slot, shotId, prompt });
    return { ok: true, version: 1, model: "pollinations/sana" };
  });
  let rerendered = 0;
  bindGenCard(root, ctx, {}, () => (rerendered += 1), { kind: "image", shotId: "shot-1" });

  await auto.onclick();

  assert.deepEqual(calls, [{ slot: "s1", shotId: "shot-1", prompt: MODEL.prompt }]);
  assert.equal(rerendered, 1, "出图之后要重画，否则他看不到新版本");
  const last = ctx.log.toasts.at(-1);
  assert.match(last, /已生成 v1/);
  assert.match(last, /未产生账单/);
  assert.equal(last.includes("$"), false);
});

test("Prompt 空的时候不发请求", async () => {
  const calls = [];
  const { auto, area, root } = fakeRoot();
  area.value = "   ";
  const ctx = fakeCtx(async () => (calls.push(1), {}));
  bindGenCard(root, ctx, {}, () => {}, { kind: "image", shotId: "shot-1" });

  await auto.onclick();

  assert.equal(calls.length, 0);
  assert.match(ctx.log.toasts.at(-1), /Prompt 是空的/);
});

test("额度用完时说出「可能已经消耗过」，而不是只说稍后再试", async () => {
  const { auto, root } = fakeRoot();
  const err = new Error("quota");
  err.category = "quota_exhausted";
  err.sideEffect = "unknown"; // 429 按合同 §5.8 白名单判 unknown
  const ctx = fakeCtx(async () => {
    throw err;
  });
  bindGenCard(root, ctx, {}, () => {}, { kind: "image", shotId: "shot-1" });

  await auto.onclick();

  const last = ctx.log.toasts.at(-1);
  assert.match(last, /额度用完/);
  assert.match(last, /可能已经消耗过/);
  assert.equal(auto.disabled, false, "失败之后按钮要放开，否则他被卡在这一屏");
});

// --- 制作画布上的那颗 ✨ 出图 ------------------------------------------------ //
//
// **这条守卫的来历**：按钮先后放错过两次 —— 旧的流程节点画布（不在十一页里）、
// 「关键帧」那一页的生成卡（从画布出发要先做草图、再做白膜才走得到）。两次前端
// 测试都是绿的，因为它们问的是「这个处理器对不对」，没有人问
// **「他从他真正在看的那一屏，点得到它吗」**。所以这里钉的是那一屏本身。

function canvasCtx(imageUrl) {
  const production = {
    episodes: [{ episodeId: "ep-1", title: "迷雾入城", scenes: [{ sceneId: "s1", shotIds: ["sh1"] }] }],
    activeEpisodeId: "ep-1",
    characters: [],
    locations: [],
    blocking: {},
    shotProduction: { reviews: {}, references: {}, stages: {}, stageReviews: {} },
  };
  // 当前画面走的是**资产登记**（`assetUploads` 的槽位版本链），不是镜头记录上的
  // 某个字段 —— 这正是 `poster` 那条缺陷的成因，所以测试也得用真的那条路。
  const slot = "sh1";
  return {
    prodData: () => ({
      production,
      draftShots: [{ shotId: "sh1", sequence: 1, seq: 1, title: "招牌 · 雨夜", sceneId: "s1", slot }],
      assetUploads: imageUrl
        ? { [slot]: { current: 1, history: [{ version: 1, url: imageUrl }] } }
        : {},
      media: { video: {}, audio: {} },
      timelines: null,
    }),
    script: null,
    shot: null,
  };
}

test("制作画布上，「还没有画面」的镜头卡自己带一颗出图按钮", () => {
  const html = renderEpCanvas(canvasCtx(null), {});
  assert.match(html, /还没有画面/, "前提：这一镜确实没有画面");
  assert.match(html, /data-ec-gen="sh1"/, "那句话旁边就该有它的出口");
  assert.match(html, /出图/);
  // 主按钮仍然是「下一步」——「一镜一张卡，一个主按钮」没有被推翻
  assert.match(html, /data-ec-step="sh1:/);
});

test("已经有画面的镜头卡不再长那颗按钮 —— 它是那个洞的出口，不是常驻控件", () => {
  const html = renderEpCanvas(canvasCtx("/api/uploads/p/sh1_v1.jpg"), {});
  assert.equal(/还没有画面/.test(html), false);
  assert.equal(/data-ec-gen/.test(html), false);
});

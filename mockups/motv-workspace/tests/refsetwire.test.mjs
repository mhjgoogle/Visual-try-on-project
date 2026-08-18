// TASK-097 批次 2 —— ADR-0071 的接线（界面这一侧），作为规则：
//
//   1. 参考图能力**来自 Gateway 预检**（决策 4：catalog 声明能力，Provider 不猜），
//      不是前端写死的常量。
//   2. 「没问过」与「问过、答案是 0」必须分得清 —— 前者该去取报价，后者是事实。
//   3. 能力不足时**拒绝并说明原因**，不静默降级成单图（决策 5 / 方案 C）。
//      判据与后端 `paid_coordinator.reference_capability_violation` **同一套**。
//   4. 界面这一侧的判定与后端那一侧必须给出**同向**的答案：少了前者创作者白绑一堆图，
//      少了后者一个绕过界面的调用就能把图悄悄丢掉。
//
// 批次 0 已经把「文本 ↔ 集合一起改」打硬了（chainmech.test.mjs），本文件**不重推**
// 那套逻辑，只测接线（TASK-097 §2.5b）。
//
// 纯测试：无 DOM、无网络。

import { test } from "node:test";
import assert from "node:assert/strict";

import { referenceCapability, referenceViolation, quoteView } from "../src/workflow/genspec.js";
import {
  ROUTE_CAPABILITY, gatewayCapabilityFrom, effectiveRoleUse, referenceRouteNote,
} from "../src/workflow/geninput.js";
import { normalizeReferenceInputs, refMarkers } from "../src/workflow/refset.js";
import { genCardModel, renderGenCard } from "../src/ui/gencard.js";

/* ========================================================================= */
/* 固定装置 —— preflight 响应的真实形状（paid_gateway._preview 的 inputs）      */
/* ========================================================================= */

const PREFLIGHT = (referenceImages, over = {}) => ({
  inputs: {
    model: "video-01",
    resolution: "720p",
    duration: 6,
    capability: "image_to_video",
    stage: "production_lock",
    ...(referenceImages === undefined ? {} : { reference_images: referenceImages }),
  },
  cost: { jpy: 28, original_currency: "USD" },
  blockers: [],
  ...over,
});

/* ========================================================================= */
/* 1 + 2. 能力来自预检；三种答案分得清                                         */
/* ========================================================================= */

test("没取过报价时，能力是「还不知道」，不是「不吃」", () => {
  const cap = referenceCapability(null);
  assert.equal(cap.known, false);
  assert.equal(cap.maxImages, 0);
  assert.match(cap.note, /还不知道/);
  assert.match(cap.note, /报价/, "并且告诉创作者怎么才能知道");
});

test("目录明确说不吃，与目录里没有这个模型，说法不同", () => {
  const declared = referenceCapability(PREFLIGHT({ max: 0, addressable: false, roles: [], declared: true }));
  assert.equal(declared.known, true);
  assert.equal(declared.maxImages, 0);
  assert.match(declared.note, /明确声明/);
  assert.match(declared.note, /不会进模型/, "如实说明那些图去了哪里");

  const undeclared = referenceCapability(PREFLIGHT({ max: 0, addressable: false, roles: [], declared: false }));
  assert.equal(undeclared.maxImages, 0, "两者都按 0 处理");
  assert.match(undeclared.note, /没有这个模型的参考图声明/, "但话不一样");
  assert.notEqual(declared.note, undeclared.note);
});

test("声明了多图就照说，包括认不认编号", () => {
  const addressable = referenceCapability(PREFLIGHT({ max: 3, addressable: true, roles: [], declared: true }));
  assert.equal(addressable.maxImages, 3);
  assert.equal(addressable.addressable, true);
  assert.match(addressable.note, /3 张/);
  assert.match(addressable.note, /\[\[ref:N\]\]/);

  const notAddressable = referenceCapability(PREFLIGHT({ max: 2, addressable: false, roles: [], declared: true }));
  assert.match(notAddressable.note, /不认编号指代/);
});

test("能力与报价读的是同一份预检 —— 不会「按 A 的能力显示、按 B 的报价收费」", () => {
  const pf = PREFLIGHT({ max: 3, addressable: true, roles: [], declared: true });
  assert.equal(quoteView(pf).available, true);
  assert.equal(referenceCapability(pf).maxImages, 3);
  // 预检被阻断时，报价不可用 —— 但**能力仍然可信**，而且这是对的：
  // 能力是「这个模型吃不吃图」，是模型的事实；预算不够跟它无关。
  // 后端也正是这样：`paid_gateway._preview` 只在模型解析成功之后才写
  // `reference_images`，所以「有这个字段」本身就意味着目录真的被查过了。
  const blocked = PREFLIGHT({ max: 3, addressable: true, roles: [], declared: true }, { blockers: ["budget denied"] });
  assert.equal(quoteView(blocked).available, false, "钱这一侧照样拒绝");
  assert.equal(referenceCapability(blocked).maxImages, 3, "能力这一侧不受预算影响");

  // 而模型根本没解析出来时，字段不存在，于是能力老实说不知道 ——
  // 这才是「读不到」的那种情况（后端在 blockers 分支里不写这个字段）。
  const unresolved = { inputs: { stage: "production_lock" }, blockers: ["ShotNotFound: shot-9"] };
  assert.equal(referenceCapability(unresolved).known, false, "它真的会说不知道");
});

/* ========================================================================= */
/* 3. 拒绝而不是截断                                                          */
/* ========================================================================= */

test("没绑图时不报任何问题", () => {
  const cap = referenceCapability(PREFLIGHT({ max: 0, addressable: false, roles: [], declared: true }));
  assert.equal(referenceViolation(cap, { count: 0 }), null);
});

test("零张图时仍然检查标记 —— 否则界面放行、后端拒绝", () => {
  // 后端在轮 2 修的是同一个早退（codex 轮 4 在界面这一侧又发现一次）。
  const cap = referenceCapability(PREFLIGHT({ max: 3, addressable: true, roles: [], declared: true }));
  const why = referenceViolation(cap, { count: 0, markers: [1] });
  assert.ok(why, "它真的会拒绝");
  // 没有标记、也没有图 → 本来就没事
  assert.equal(referenceViolation(cap, { count: 0, markers: [] }), null);
});

test("[[ref:N]] 只认 ASCII 数字，与后端同一条规则", () => {
  // Python 的 \\d 匹配全部 Unicode 十进制数字，JS 的不匹配 —— 两边都必须用 [0-9]，
  // 否则同一条提示词在两层被读成不同的东西。
  assert.deepEqual(refMarkers("[[ref:1]] 与 [[ref:23]]"), [1, 23]);
  assert.deepEqual(refMarkers("[[ref:٣]]"), [], "阿拉伯-印度数字不是标记");
});

test("没声明多图 → 拒绝，并说清「不静默降级成单图」", () => {
  const cap = referenceCapability(PREFLIGHT({ max: 0, addressable: false, roles: [], declared: true }));
  const why = referenceViolation(cap, { count: 3 });
  assert.ok(why, "它真的会拒绝");
  assert.match(why, /方案 C/);
  assert.match(why, /变成谎/, "并说明为什么不能降级");
});

test("超出声明张数 → 拒绝并让创作者选留哪几张，不替他截断", () => {
  const cap = referenceCapability(PREFLIGHT({ max: 3, addressable: true, roles: [], declared: true }));
  assert.equal(referenceViolation(cap, { count: 3 }), null);
  const why = referenceViolation(cap, { count: 5 });
  assert.ok(why, "它真的会拒绝");
  assert.match(why, /选留哪几张/);
  assert.match(why, /不会被截断/);
});

test("模型不认编号但提示词用了 [[ref:N]] → 拒绝", () => {
  const cap = referenceCapability(PREFLIGHT({ max: 3, addressable: false, roles: [], declared: true }));
  assert.equal(referenceViolation(cap, { count: 2, markers: [] }), null);
  const why = referenceViolation(cap, { count: 2, markers: [1] });
  assert.ok(why, "它真的会拒绝");
  assert.match(why, /不认编号指代/);
});

test("悬空编号在**界面**就被拒 —— 不能等到提交才由后端说不", () => {
  // codex 轮 5：只传「有没有用标记」这个布尔时，两张图 + [[ref:99]] 在界面上合法，
  // 而后端按 1..N 拒绝。判定必须逐条对齐，用的是同一条规则。
  const cap = referenceCapability(PREFLIGHT({ max: 3, addressable: true, roles: [], declared: true }));
  assert.equal(referenceViolation(cap, { count: 2, markers: [1, 2] }), null);
  const why = referenceViolation(cap, { count: 2, markers: [1, 99] });
  assert.ok(why, "它真的会拒绝");
  assert.match(why, /\[\[ref:99\]\]/);
  assert.match(why, /编号只能是 1\.\.2/);
  // 0 与负数同样是悬空
  assert.ok(referenceViolation(cap, { count: 2, markers: [0] }));
  // 多个悬空编号逐个报出，不只报第一个
  const many = referenceViolation(cap, { count: 2, markers: [7, 9] });
  assert.match(many, /\[\[ref:7\]\]/);
  assert.match(many, /\[\[ref:9\]\]/);
});

test("角色不在声明之内 → 拒绝并指名是哪个角色", () => {
  const cap = referenceCapability(
    PREFLIGHT({ max: 3, addressable: true, roles: ["character-reference"], declared: true }),
  );
  assert.equal(referenceViolation(cap, { count: 1, roles: ["character-reference"] }), null);
  const why = referenceViolation(cap, { count: 2, roles: ["character-reference", "prop-reference"] });
  assert.ok(why, "它真的会拒绝");
  assert.match(why, /prop-reference/);
});

test("能力还没取到就绑了图 → 说「先报价，不猜」", () => {
  const why = referenceViolation(referenceCapability(null), { count: 2 });
  assert.ok(why, "它真的会拒绝");
  assert.match(why, /不猜/);
});

test("判定吃的是 refset 的产出，不自己数参考 —— 编号也从 refset 解析", () => {
  const { inputs } = normalizeReferenceInputs([
    { assetId: "a", version: 1, contentDigest: "d", kind: "character-reference", role: "character-reference" },
    { assetId: "b", version: 1, contentDigest: "d", kind: "prop-reference", role: "prop-reference" },
  ]);
  const text = "身份看 [[ref:1]]，道具看 [[ref:2]]";
  const cap = referenceCapability(
    PREFLIGHT({ max: 3, addressable: true, roles: ["character-reference"], declared: true }),
  );
  const why = referenceViolation(cap, {
    count: inputs.length,
    markers: refMarkers(text),
    roles: inputs.map((r) => r.role),
  });
  assert.match(why, /prop-reference/, "角色限制按实际集合判定");
});

/* ========================================================================= */
/* 4. 路线能力不再写死                                                        */
/* ========================================================================= */

test("Gateway 路线的参考图能力由预检决定，静态项只是 fail-closed 的回退", () => {
  // 还没问过 → 回退到静态项，且静态项仍然是「只带一张首帧」
  assert.equal(gatewayCapabilityFrom(null), ROUTE_CAPABILITY.gateway);
  assert.equal(ROUTE_CAPABILITY.gateway.referenceImages, false);
  assert.match(referenceRouteNote(ROUTE_CAPABILITY.gateway), /不会进模型/);

  // 目录说不吃 → 仍然回退（答案相同，来源不同）
  const zero = referenceCapability(PREFLIGHT({ max: 0, addressable: false, roles: [], declared: true }));
  assert.equal(gatewayCapabilityFrom(zero).referenceImages, false);

  // 目录说吃 3 张 → 能力翻转，且 ROLE 的有效用途随之翻转
  const three = referenceCapability(PREFLIGHT({ max: 3, addressable: true, roles: [], declared: true }));
  const cap = gatewayCapabilityFrom(three);
  assert.equal(cap.referenceImages, true);
  assert.equal(cap.maxImages, 3);
  assert.equal(
    effectiveRoleUse("character-reference", cap),
    "model-input",
    "目录说图会进模型，界面就不该再说它只会被解读成文字",
  );
  // …而在回退能力上，同一个角色仍然如实降级
  assert.equal(effectiveRoleUse("character-reference", ROUTE_CAPABILITY.gateway), "ai-interpretation");
});

test("手工路线不受影响：创作者自己附文件，那句话本来就是对的", () => {
  assert.equal(ROUTE_CAPABILITY.manual.referenceImages, true);
  assert.match(referenceRouteNote(ROUTE_CAPABILITY.manual), /由你把文件附给外部工具/);
});

/* ========================================================================= */
/* 5. 真的接上了 —— 生成卡是这两个判定的生产调用方                             */
/* ========================================================================= */

test("生成卡把目录声明与集合违规**显示出来**，而不是让创作者提交后才被后端拒", () => {
  // codex 轮 6 的第一条：这两个函数当时只有测试在调用，于是界面照旧无条件说
  // 「参考图不会进模型」，而且允许提交一组 Gateway 一定会拒的集合。
  const detail = () => ({
    shot: { shotId: "shot-a" },
    slot: "v1-1",
    prompts: {
      image: { text: "构图", missing: [] },
      video: { text: "身份看 [[ref:1]]", missing: [] },
    },
    refInputs: {
      imageReferences: [],
      videoReferences: [
        { key: "ref-a", name: "现代沈昭昭", version: 3, kind: "character-reference" },
      ],
    },
    frames: {},
    images: { current: 0, list: [] },
    videos: { current: 0, list: [] },
    videoSources: {},
    generations: [],
  });
  const QUOTE = (referenceImages) => ({
    shotId: "shot-a",
    inputs: { model: "video-01", resolution: "720p", duration: 6, capability: "image_to_video", reference_images: referenceImages },
    cost: { jpy: 28, original_currency: "USD" },
    blockers: [],
  });

  // 目录说这个模型不吃参考图 → 卡上如实说，并且拦住提交
  const zero = genCardModel(detail(), "video", {
    paid: true, quote: QUOTE({ max: 0, addressable: false, roles: [], declared: true }),
  });
  assert.match(zero.refCapability.note, /明确声明/);
  assert.ok(zero.refViolation, "它真的会拦住");
  const zeroHtml = renderGenCard(zero);
  assert.match(zeroHtml, /不会进模型/, "创作者能在卡上看到这句话");
  assert.match(zeroHtml, /方案 C/);
  assert.match(zeroHtml, /disabled/, "提交按钮说明了为什么按不下去");

  // 目录说吃 3 张并认编号 → 不再无条件说「不会进模型」，也不拦
  const three = genCardModel(detail(), "video", {
    paid: true, quote: QUOTE({ max: 3, addressable: true, roles: [], declared: true }),
  });
  assert.equal(three.refViolation, null);
  const threeHtml = renderGenCard(three);
  assert.match(threeHtml, /3 张/);
  assert.equal(/不会进模型/.test(threeHtml), false, "目录说会进，界面就不该说不会");

  // 还没取报价 → 说「还不知道」，而不是断言任何一方
  const unknown = genCardModel(detail(), "video", { paid: true, quote: null });
  assert.equal(unknown.refCapability.known, false);
  assert.ok(unknown.refViolation, "能力未知而绑了图 → 先报价，不猜");
});

test("超长编号在界面与后端得到同向结论", () => {
  const absurd = refMarkers(`[[ref:${"9".repeat(400)}]]`);
  assert.equal(absurd.length, 1, "它是一个真的标记，不能被丢掉");
  assert.equal(Number.isFinite(absurd[0]), false);
  const cap = referenceCapability(PREFLIGHT({ max: 3, addressable: true, roles: [], declared: true }));
  const why = referenceViolation(cap, { count: 2, markers: absurd });
  assert.ok(why, "它真的会拒绝");
  assert.match(why, /离谱/);
});

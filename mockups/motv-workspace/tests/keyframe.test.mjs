// TASK-097 批次 4G —— ⑤ Keyframe 合成，作为规则：
//
//   1. **它是合成**：四个输入各管一件事，而且每张图声明自己管什么
//      （构图 / 身份 / 环境）。没有输入图就只是又一次文生图。
//   2. **方案 C 的拒绝在提交路径上**（§2.5b-2）：provider 未声明「多图不额外计费」
//      → 拒绝，**不退成单图**。退成单图会让「用了角色设定图」变成谎。
//   3. **闸门用 4F 那一份谓词**，两个方向都钉：没过的进不去（但不置灰导航），
//      `skipped` 与已 approved 的**真的放行**。
//   4. 三件「通过」是三件不同的事实（§2.5h 第一条）：草图 / keyframe / 视频
//      各有自己的格子。
//   5. 「不知道」不是「可以送」：没问过能力时不许提交。
//
// 纯测试：无 DOM、无网络、不花一分钱。

import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import {
  KEYFRAME_ROLES, roleOfKind, composePlan, composeSubmission, markersOf, keyframeList,
} from "../src/workflow/keyframe.js";
import { installCatalog, promptBlock } from "../src/workflow/skills.js";
import { USAGE_RULE_SKILL, usageRuleBlockName } from "../src/workflow/promptrefs.js";
import { storyboardStrip } from "../src/workflow/sbdraft.js";
import * as pdoc from "../src/workflow/proddoc.js";
import { approveStage, approveShot, isStageArtifactApproved } from "../src/workflow/shotprod.js";
import { skipStage } from "../src/workflow/shotstage.js";

/** 五类规则都装上（真实包），否则输入会被 fail-closed 扣下。 */
function installRules() {
  const manifest = JSON.parse(readFileSync(
    new URL(`../../../product-skills/builtin/${USAGE_RULE_SKILL}/manifest.json`, import.meta.url),
    "utf8",
  ));
  installCatalog({
    skills: [{
      skillId: manifest.skillId, version: manifest.skillVersion,
      instruction: "x", outputSchema: { type: "object", required: [], fields: {} },
      promptBlocks: manifest.promptBlocks, optionalInputs: [],
    }],
    inputs: {}, shotScopedInputs: [],
  });
}

const DRAFT = { assetId: "sb-1", version: 2, contentDigest: "d0", name: "第 1 镜草图" };
const REFS = [
  { assetId: "ch-1", version: 3, contentDigest: "d1", kind: "character-reference", name: "林照 Ref" },
  { assetId: "lo-1", version: 1, contentDigest: "d2", kind: "location-reference", name: "便利店外" },
];
const CAP = { known: true, declared: true, maxImages: 6, addressable: true, roles: [] };
const OPEN = { ok: true, reason: "" }; // 闸门已过：本组用例测的是方案 C 与编排本身


/* ========================================================================= */
/* 1. 合成：每张图说得出自己管什么                                              */
/* ========================================================================= */

test("四个输入各管一件事，草图排第一（构图是骨架）", () => {
  installRules();
  const plan = composePlan({
    shotId: "s1", draft: DRAFT, refs: REFS, prompt: "特写，林照站在便利店外", lookup: promptBlock,
  });
  assert.equal(plan.ready, true, plan.missing.join("；"));
  assert.deepEqual(plan.inputs.map((r) => r.ordinal), [1, 2, 3]);
  assert.equal(plan.inputs[0].name, "第 1 镜草图", "草图排第一");
  assert.deepEqual(plan.inputs.map((r) => r.note), [
    KEYFRAME_ROLES.storyboard, KEYFRAME_ROLES.character, KEYFRAME_ROLES.location,
  ]);
  // 提示词里带上「哪几张 / 每张管什么 / 怎么用」
  assert.match(plan.prompt, /特写，林照站在便利店外/);
  assert.match(plan.prompt, /这张管构图/);
  assert.match(plan.prompt, /这张管身份/);
  assert.match(plan.prompt, /这张管环境/);
  assert.match(plan.prompt, /【参考图使用规则】/);
  // 那一句挡住「四视图被画成四个视图」的规则必须在
  assert.match(plan.prompt, /若此参考图是角色多视图，则必须保证角色不能重复出现/);
  assert.equal(roleOfKind("nope"), "", "认不出来的 kind 不猜一个角色");
});

test("没有输入图 / 没有提示词 → 不算能合成（那只是又一次文生图）", () => {
  installRules();
  const noImg = composePlan({ shotId: "s1", draft: null, refs: [], prompt: "有提示词", lookup: promptBlock });
  assert.equal(noImg.ready, false);
  assert.ok(noImg.missing.some((x) => /又一次文生图/.test(x)));
  const noPrompt = composePlan({ shotId: "s1", draft: DRAFT, refs: REFS, prompt: "  ", lookup: promptBlock });
  assert.equal(noPrompt.ready, false);
  assert.ok(noPrompt.missing.some((x) => /还没有分镜提示词/.test(x)));
});

test("有一张输入被扣下 → 这一镜就不算好了（4D 统一出来的判据）", () => {
  // 只装角色那一段规则：场景那一张会被扣下
  installCatalog({
    skills: [{
      skillId: USAGE_RULE_SKILL, version: 9, instruction: "x",
      outputSchema: { type: "object", required: [], fields: {} },
      promptBlocks: { [usageRuleBlockName("character")]: "只参考角色形象" },
      optionalInputs: [],
    }],
    inputs: {}, shotScopedInputs: [],
  });
  const plan = composePlan({ shotId: "s1", draft: DRAFT, refs: REFS, prompt: "描述", lookup: promptBlock });
  assert.equal(plan.ready, false, "要它进去而它没进去 → 不算好了");
  assert.ok(plan.withheld.length >= 1);
  assert.equal(/便利店外/.test(plan.prompt), false, "扣下的不出现在模型看到的文本里");
  // 而提交那一层照样拒（不是「记一笔然后送」）
  const sub = composeSubmission({ plan, capability: CAP, gate: OPEN });
  assert.equal(sub.ok, false);
  assert.equal(sub.degraded, false);
});

/* ========================================================================= */
/* 2. 方案 C：拒绝在提交路径上，而且没有降级路径                                 */
/* ========================================================================= */

test("provider 未声明多图不额外计费 → 拒绝，**不退成单图**", () => {
  installRules();
  const plan = composePlan({ shotId: "s1", draft: DRAFT, refs: REFS, prompt: "描述", lookup: promptBlock });
  const undeclared = { known: true, declared: false, maxImages: 0, addressable: false, roles: [] };
  const sub = composeSubmission({ plan, capability: undeclared, gate: OPEN });
  assert.equal(sub.ok, false);
  assert.match(sub.reason, /没有声明「多图不额外计费」/);
  assert.match(sub.reason, /不会退成单图/);
  assert.equal(sub.degraded, false, "**没有**降级路径 —— 这个字段存在就是为了让它可被断言");
  // 声明了 max 但为 0 也一样拒
  assert.equal(composeSubmission({
    plan, capability: { known: true, declared: true, maxImages: 0, addressable: true }, gate: OPEN,
  }).ok, false);
});

test("「没问过」不是「可以送」", () => {
  installRules();
  const plan = composePlan({ shotId: "s1", draft: DRAFT, refs: REFS, prompt: "描述", lookup: promptBlock });
  const unknown = composeSubmission({ plan, capability: { known: false, note: "还不知道…先取报价" }, gate: OPEN });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /还不知道|取报价/);
  assert.equal(composeSubmission({ plan, capability: null, gate: OPEN }).ok, false);
  assert.equal(composeSubmission({ plan: null, capability: CAP, gate: OPEN }).ok, false);
});

test("张数超过声明的上限 → 拒绝，不替 provider 截断", () => {
  installRules();
  const plan = composePlan({ shotId: "s1", draft: DRAFT, refs: REFS, prompt: "描述", lookup: promptBlock });
  const tight = { known: true, declared: true, maxImages: 2, addressable: true, roles: [] };
  const sub = composeSubmission({ plan, capability: tight, gate: OPEN });
  assert.equal(sub.ok, false);
  assert.match(sub.reason, /要送 3 张/);
  assert.match(sub.reason, /不替它截断/);
});

test("悬空标记转交 genspec 那一份判定；一切合规时**真的放行**（反方向）", () => {
  installRules();
  const plan = composePlan({
    shotId: "s1", draft: DRAFT, refs: REFS, prompt: "画面里 [[ref:9]] 出现", lookup: promptBlock,
  });
  const bad = composeSubmission({ plan, capability: CAP, gate: OPEN });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /\[\[ref:9\]\]/);
  // 合规的那一份必须**真的通过** —— 只钉「会拒绝」那一半就是造一道迟早被关掉的门
  const good = composePlan({
    shotId: "s1", draft: DRAFT, refs: REFS, prompt: "画面里 [[ref:2]] 的人站在 [[ref:3]] 前", lookup: promptBlock,
  });
  const ok = composeSubmission({ plan: good, capability: CAP, gate: OPEN });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.count, 3);
  assert.deepEqual(markersOf("[[ref:1]] 和 [[ref:12]]"), [1, 12]);
  assert.equal(markersOf("[[ref:1234567890123]]")[0], Infinity, "位数离谱的编号不被过滤掉");
});

/* ========================================================================= */
/* 3. 闸门：用 4F 那一份谓词，两个方向都钉                                       */
/* ========================================================================= */

test("闸门：skipped 与已通过的**真的放行**；没过的进不去但不置灰导航", () => {
  const prod = pdoc.createProduction(null);
  const stages = prod.shotProduction.stages;
  skipStage(stages, "s1", "storyboard", "2026-08-20T00:00:00Z");
  approveStage(prod, "s2", "storyboard", "sb-2", "2026-08-20T00:00:00Z");
  const strip = storyboardStrip({
    items: [
      { shotId: "s1", index: 0, title: "跳过的" },
      { shotId: "s2", index: 1, title: "通过的" },
      { shotId: "s3", index: 2, title: "有草图未通过" },
      { shotId: "s4", index: 3, title: "还没画" },
    ],
    stages,
    draftOf: (id) => (id === "s2" ? { assetId: "sb-2", url: "/u/2.png", version: 1, present: true }
      : id === "s3" ? { assetId: "sb-3", url: "/u/3.png", version: 1, present: true } : null),
    approvedFor: (shotId, assetId) => isStageArtifactApproved(prod, shotId, "storyboard", assetId),
  });
  const list = keyframeList({ rows: strip.rows, keyframeOf: () => null });
  assert.deepEqual(list.rows.map((r) => r.gateOk), [true, true, false, false]);
  assert.deepEqual(list.rows.map((r) => r.canCompose), [true, true, false, false]);
  // 不置灰导航：每一行都进得去看
  assert.equal(list.rows.every((r) => r.canEnter), true);
  // 说清缺哪几镜，而且给一条走得通的路
  assert.equal(list.blocked.length, 2);
  assert.match(list.todo, /2 镜还过不了/);
  assert.match(list.todo, /去 ④ 通过草图，或者把那几镜跳过/);
  // 全放行时不留一句多余的话
  const allOpen = keyframeList({ rows: strip.rows.slice(0, 2), keyframeOf: () => null });
  assert.equal(allOpen.todo, "");
});

test("keyframe 的四态，与 ④ 同一套词汇", () => {
  const rows = [
    { shotId: "a", state: "approved", title: "已合成并通过" },
    { shotId: "b", state: "approved", title: "已合成未通过" },
    { shotId: "c", state: "skipped", title: "整镜跳过" },
    { shotId: "d", state: "approved", title: "还没合成" },
  ];
  const list = keyframeList({
    rows,
    keyframeOf: (id) => (id === "a" ? { assetId: "kf-a", present: true, approved: true }
      : id === "b" ? { assetId: "kf-b", present: true, approved: false }
        : id === "c" ? { skipped: true } : null),
  });
  assert.deepEqual(list.rows.map((r) => r.state), ["approved", "made", "skipped", "not_started"]);
  assert.equal(list.approved, 1);
  assert.equal(list.made, 1);
  assert.equal(list.skipped, 1);
  assert.equal(list.notStarted, 1);
});

/* ========================================================================= */
/* 4. 三件「通过」是三件不同的事实（§2.5h 第一条）                                */
/* ========================================================================= */

test("草图通过 / keyframe 通过 / 视频通过互不覆盖", () => {
  const prod = pdoc.createProduction(null);
  approveStage(prod, "s1", "storyboard", "sb-1", "2026-08-20T00:00:00Z");
  approveStage(prod, "s1", "keyframe", "kf-1", "2026-08-20T01:00:00Z");
  approveShot(prod, "s1", "video-1", "2026-08-20T02:00:00Z");
  // 三件事分别为真 —— 这正是它们不能共用一个格子的原因
  assert.equal(isStageArtifactApproved(prod, "s1", "storyboard", "sb-1"), true);
  assert.equal(isStageArtifactApproved(prod, "s1", "keyframe", "kf-1"), true);
  assert.equal(isStageArtifactApproved(prod, "s1", "video", "video-1"), true);
  // 而且各自只认自己那一张
  assert.equal(isStageArtifactApproved(prod, "s1", "keyframe", "sb-1"), false);
  assert.equal(isStageArtifactApproved(prod, "s1", "storyboard", "kf-1"), false);
  // 往返之后三件都还在
  const round = pdoc.createProduction(pdoc.serialize(prod));
  assert.equal(isStageArtifactApproved(round, "s1", "keyframe", "kf-1"), true);
  assert.equal(isStageArtifactApproved(round, "s1", "storyboard", "sb-1"), true);
  assert.equal(isStageArtifactApproved(round, "s1", "video", "video-1"), true);
});

/* ========================================================================= */
/* 5. 结构守卫：本模块里没有降级路径                                            */
/* ========================================================================= */

test("模块里**没有**任何「退成单图」的代码路径", () => {
  const src = readFileSync(new URL("../src/workflow/keyframe.js", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // 不得出现截断 / 取第一张 / slice(0,1) 这类降级写法
  assert.equal(/slice\(0,\s*1\)/.test(code), false, "不得只取第一张送出去");
  assert.equal(/inputs\[0\]\s*\]/.test(code), false);
  assert.equal(/degraded:\s*true/.test(code), false, "没有任何一条路把 degraded 置真");
  // 判定与话术都是转交，不是重写
  assert.match(code, /referenceViolation\(/);
  assert.match(code, /referenceBlock\(/);
  assert.match(code, /keyframeGate\(/);
});

/* ========================================================================= */
/* 6. round 1 的 P1：闸门必须在**提交路径**上，不只在界面上                       */
/* ========================================================================= */

test("闸门没过 → 提交被拒；给不出闸门结论 → 也拒（round 1 的 P1）", () => {
  installRules();
  const plan = composePlan({ shotId: "s1", draft: DRAFT, refs: REFS, prompt: "描述", lookup: promptBlock });
  assert.equal(plan.ready, true, "前提：编排本身是齐的");
  // 草图存在但**没通过** —— 第一版这里返回 ok，因为它只在界面上算 canCompose
  const closed = composeSubmission({
    plan, capability: CAP, gate: { ok: false, reason: "草图还没通过 —— 在这条带上按「通过」" },
  });
  assert.equal(closed.ok, false);
  assert.match(closed.reason, /草图还没通过/);
  // **给不出闸门结论也拒**（不知道 ≠ 可以送）
  const unknown = composeSubmission({ plan, capability: CAP });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /没有 ④→⑤ 的闸门结论/);
  // 反方向：闸门过了、编排齐了、能力声明了 → **真的放行**
  const open = composeSubmission({ plan, capability: CAP, gate: { ok: true, reason: "" } });
  assert.equal(open.ok, true, open.reason);
  assert.equal(open.count, 3);
});

test("闸门结论来自 `keyframeGate` 那一份，提交与界面读同一个判断", () => {
  installRules();
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const codeOnly = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const from = app.indexOf("  keyframe: {");
  const after = codeOnly(app.slice(from + "  keyframe: {".length));
  const next = after.search(/\n {2}[A-Za-z_$][A-Za-z0-9_$]*: \{/);
  const region = after.slice(0, next >= 0 ? next : after.length);
  // submit 与 tryAll 都必须把闸门结论传下去
  assert.match(region, /gate = row \? \{ ok: row\.gateOk, reason: row\.gateReason \} : null/);
  assert.match(region, /composeSubmission\(\{ plan, capability, gate \}\)/);
  assert.match(region, /gate: \{ ok: r\.gateOk, reason: r\.gateReason \}/);
  // 而清单那一行的 gateOk 本身来自 sbdraft 的谓词（keyframe.js 里转交）
  const mod = readFileSync(new URL("../src/workflow/keyframe.js", import.meta.url), "utf8");
  assert.match(codeOnly(mod), /keyframeGate\(r\)/);
});

/* ========================================================================= */
/* 7. round 2 的两条                                                          */
/* ========================================================================= */

test("只有**通过了的**草图才进合成 —— 跳过 ④ 时那张旧草图不许影响画面（round 2 的 P1）", () => {
  // 闸门有两条放行路：草图通过，或这一镜跳过。跳过时硬盘上可能还留着一张
  // 没通过的旧草图 —— 第一版只看 `present`，于是那张被否决的草图仍然被送进合成。
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const codeOnly = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const from = app.indexOf("    plan: (shotId) => {");
  const body = codeOnly(app.slice(from, from + 2000));
  assert.match(body, /isStageArtifactApproved\(productionDoc, shotId, "storyboard", draftRow\.assetId\)/,
    "草图要先问「通过了吗」");
  assert.match(body, /const draft = draftApproved/, "没通过就不当输入");
  assert.equal(/draftRow && draftRow\.present\s*\?/.test(body), false, "不得只看 present");
});

test("能力上限读不出来 → 不送（round 2 的 non-blocking）", () => {
  installRules();
  const plan = composePlan({ shotId: "s1", draft: DRAFT, refs: REFS, prompt: "描述", lookup: promptBlock });
  // `undefined <= 0` 与 `count > undefined` 都是 false —— 两道比较同时失效
  const broken = composeSubmission({
    plan, capability: { known: true, declared: true }, gate: OPEN,
  });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /读不出来|读不懂/);
  const notInt = composeSubmission({
    plan, capability: { known: true, declared: true, maxImages: "6" }, gate: OPEN,
  });
  assert.equal(notInt.ok, false, "字符串 6 不是整数 6");
  // 反方向：正整数照常工作（上限内放行、超限拒绝）。
  // `addressable` 要给上 —— 参考段里有 `[[ref:N]]`，而 genspec 的规则是
  // 「不认编号指代的模型不许收到编号」。这是它那一份判定，不是这里重写的。
  //  = 「不限制角色」（读不懂是另一件事，见下面那个测试）
  const okCap = (maxImages) => ({ known: true, declared: true, maxImages, addressable: true, roles: [] });
  assert.equal(composeSubmission({ plan, capability: okCap(3), gate: OPEN }).ok, true);
  assert.equal(composeSubmission({ plan, capability: okCap(2), gate: OPEN }).ok, false);
});

test("形状不完整的能力对象**不许把方案 C 那道门打崩**", () => {
  // 这道判定长在提交路径上。在这里抛异常，等于让门以一种没人预料的方式消失
  // ——调用方若在外层 catch 一下，就变成了「没有违规」。
  installRules();
  const plan = composePlan({ shotId: "s1", draft: DRAFT, refs: REFS, prompt: "描述", lookup: promptBlock });
  // 缺 roles / 缺 addressable / 缺 maxImages 的能力对象：只许被**拒绝**，不许抛
  for (const cap of [
    { known: true, declared: true, maxImages: 6 },                    // 缺 roles / addressable
    { known: true, declared: true, maxImages: 6, addressable: true }, // 缺 roles
    { known: true, declared: true },                                  // 缺 maxImages
  ]) {
    const r = composeSubmission({ plan, capability: cap, gate: OPEN });
    assert.equal(typeof r.ok, "boolean", "必须给出结论，而不是抛出去");
    assert.equal(r.ok, false, "而且那个结论必须是**拒绝** —— 读不懂不是可以送");
    assert.equal(r.degraded, false);
  }
  // **「没声明限制」与「读不懂」是两件事**（codex 轮 3：我在轮 2 把前者的处理
  // 套到了后者身上，于是角色校验被整段跳过 —— 一个 fail-closed 被改成了 fail-open）
  const noLimit = { known: true, declared: true, maxImages: 6, addressable: true, roles: [] };
  assert.equal(composeSubmission({ plan, capability: noLimit, gate: OPEN }).ok, true,
    "roles: [] 是「不限制角色」—— 该放行");
  const restricted = { known: true, declared: true, maxImages: 6, addressable: true, roles: ["身份"] };
  const bad = composeSubmission({ plan, capability: restricted, gate: OPEN });
  assert.equal(bad.ok, false, "只接受「身份」的模型，收到「构图」「环境」必须被拒");
  assert.match(bad.reason, /不接受这些参考角色/);
});

// TASK-097 批次 0 —— 五段复用的共同机制，作为规则：
//
//   1. 派生引用扫描：谁还引用着这个 id，靠走文档，不靠清单（§2.6.1）。
//   2. 有序参考集合：ordinal 连续、悬空标记**拒绝编译**、version+digest 必带
//      （ADR-0071 决策 1/2）。
//   3. 五个一级分类是**派生**的，而「进不进模型」这个事实**没有被合并掉**
//      （TASK-092 §5 / TASK-077 §1.3）。
//   4. 批量付费：总额来自 preflight、可中止、中途失败不算整批成功、方案 C fail-closed。
//   5. 计数：来自实际登记表；答不上来时是「—」，**不是 0**（§2.5 / §2.6.2）。
//   6. 报价与规格只有一个读法，且它**没有裸参数入口**可以「乘一下」（§2.1）。
//
// §2.6.3 的纪律：每个守卫都要有一次「它真的会拒绝」的证明 —— 下面每一组的第一条
// 断言都是先让它失败一次。fixture 一律从这些模块自己的契约构造，不手写一个
// 「看起来像」的对象去发明字段。
//
// 纯测试：无 DOM、无网络。

import { test } from "node:test";
import assert from "node:assert/strict";

import { findPaths, foreignReferences, isReferenced, valuesAtKey } from "../src/workflow/refscan.js";
import {
  normalizeReferenceInputs, normalizeReferenceSet, reorderReferenceInputs, refMarkers, validateReferenceSet,
  compileReferenceMarkers, remapMarkers, categoryOf, modelReach, groupByCategory,
  usageRuleFor, usageRuleBlock, REFERENCE_CATEGORIES,
} from "../src/workflow/refset.js";
import {
  createBatch, applyPreflight, confirmBatch, abortBatch, recordItem, settlement, settlementLine,
} from "../src/workflow/batchpay.js";
import { productionCounts, countText, PRODUCTION_COUNTS, UNKNOWN, isDeleted } from "../src/workflow/counts.js";
import {
  GEN_SITES, genSite, quoteView, specRows, specViolations, isDisplayableAmount,
} from "../src/workflow/genspec.js";

/* ========================================================================= */
/* 1. 派生引用扫描                                                            */
/* ========================================================================= */

// The document shape is the one `persist` writes — the same one `episodecleanup`
// walks. `timelines` is in here on purpose: it is the key TASK-094's four-item
// checklist forgot, and this test exists so the next checklist cannot forget it
// either.
const DOC = {
  production: { activeEpisodeId: "ep-2", episodes: [{ episodeId: "ep-1" }, { episodeId: "ep-2" }] },
  scripts: { "ep-1": { versions: [] } },
  timelines: { "ep-1": { clips: [] } },
  story: { plans: [{ v: 1, episodes: [{ episodeId: "ep-1" }] }] },
  assets: { images: { a: { history: [{ kind: "character-reference", links: { episodeId: "ep-1" } }] } } },
};

test("引用扫描找得到只存在于 KEY 上的引用 —— 那正是清单漏掉的那一个", () => {
  const paths = findPaths(DOC, "ep-1");
  // proves it would REJECT: a value-only walk misses both of these
  assert.ok(paths.includes("$.scripts.ep-1<key>"), "scripts 的 key 引用");
  assert.ok(paths.includes("$.timelines.ep-1<key>"), "timelines 的 key 引用（094 漏掉的那一个）");
  assert.ok(paths.includes("$.assets.images.a.history[0].links.episodeId"), "深层 value 引用");
});

test("「哪里不算」是闭集，其余一律算引用 —— 新加的键默认是内容", () => {
  const expected = (p) => /^\$\.production\.episodes\[\d+\]\.episodeId$/.test(p);
  const foreign = foreignReferences(DOC, "ep-1", expected);
  assert.ok(foreign.length >= 4, "剧本 / 时间线 / 规划 / 资产四处都算");
  // 一个此刻还不存在的键，明天加上就自动算引用 —— 不需要谁记得来改这个断言
  const withNewKey = { ...DOC, futureThing: { pointsAt: "ep-1" } };
  assert.ok(
    foreignReferences(withNewKey, "ep-1", expected).includes("$.futureThing.pointsAt"),
    "未来新增的引用点默认算内容",
  );
  assert.equal(isReferenced(DOC, "ep-9", expected), false, "没人引用的 id 就是没人引用");
});

test("valuesAtKey 答的是「实际存了哪些 kind」，不是「我们记得有哪些 kind」", () => {
  assert.deepEqual([...valuesAtKey(DOC, "kind")], ["character-reference"]);
});

/* ========================================================================= */
/* 2 + 3. 有序参考集合与五个一级分类                                           */
/* ========================================================================= */

const REF = (over = {}) => ({
  assetId: "img-1", version: 3, contentDigest: "sha256:aaa",
  kind: "character-reference", name: "现代沈昭昭", role: "character-reference", note: "身份",
  ...over,
});

test("没有版本或 digest 的参考被拒收并说明原因 —— 不是静默少一张", () => {
  const { inputs, dropped } = normalizeReferenceInputs([
    REF(),
    REF({ assetId: "img-2", version: null }),
    REF({ assetId: "img-3", contentDigest: "" }),
  ]);
  assert.equal(inputs.length, 1);
  assert.equal(dropped.length, 2);
  assert.match(dropped[0].why, /版本号/);
  assert.match(dropped[1].why, /contentDigest/);
});

test("ordinal 由规整给出，1..N 连续无洞", () => {
  const { inputs } = normalizeReferenceInputs([
    REF({ assetId: "a" }), REF({ assetId: "b" }), REF({ assetId: "c" }),
  ]);
  assert.deepEqual(inputs.map((r) => r.ordinal), [1, 2, 3]);
});

test("悬空的 [[ref:N]] 拒绝编译并指名是哪一个 —— 不静默删标记", () => {
  const { inputs } = normalizeReferenceInputs([REF()]);
  const bad = compileReferenceMarkers("以 [[ref:1]] 为身份，构图参考 [[ref:2]]", inputs);
  assert.equal(bad.ok, false, "它真的会拒绝");
  assert.deepEqual(bad.dangling, [2]);
  assert.equal(bad.text, null, "拒绝时不得给出一个「尽力而为」的字符串");
  assert.match(bad.reasons[0], /\[\[ref:2\]\]/);

  const good = compileReferenceMarkers("以 [[ref:1]] 为身份", inputs);
  assert.equal(good.ok, true, "补齐之后它会通过");
  assert.match(good.text, /【参考1：现代沈昭昭 v3，身份】/);
});

test("集合里有、提示词没引用的，不是错误 —— 它是「一并提供」", () => {
  const { inputs } = normalizeReferenceInputs([REF({ assetId: "a" }), REF({ assetId: "b" })]);
  const v = validateReferenceSet({ text: "只提到 [[ref:1]]", inputs });
  assert.equal(v.ok, true);
  assert.deepEqual(v.unreferenced, [2]);
});

test("编号不连续会被判定为不合法 —— 否则每个标记都指向另一张图", () => {
  const { inputs } = normalizeReferenceInputs([REF({ assetId: "a" }), REF({ assetId: "b" })]);
  const v = validateReferenceSet({ text: "[[ref:1]]", inputs: [inputs[0], { ...inputs[1], ordinal: 3 }] });
  assert.equal(v.ok, false);
  assert.equal(v.contiguous, false);
});

test("未绑定版本 / digest 的参考在**任何**入口都编译不出去，不只在规整那一道", () => {
  // 直接绕过 normalizeReferenceInputs，手工凑一个「编号看起来没问题」的集合
  const unpinned = [{ ordinal: 1, assetId: "img-1", name: "现代沈昭昭" }];
  const v = validateReferenceSet({ text: "身份看 [[ref:1]]", inputs: unpinned });
  assert.equal(v.ok, false, "它真的会拒绝");
  assert.deepEqual(v.unpinned, [1]);
  assert.match(v.reasons[0], /同参数重跑/);
  const c = compileReferenceMarkers("身份看 [[ref:1]]", unpinned);
  assert.equal(c.ok, false, "编译入口同样拒绝 —— 校验不取决于调用方走哪扇门");
  assert.equal(c.text, null);
});

test("两张参考都自称第 N 张时拒绝重编号 —— 歧义不能被改写成一个确定的错答案", () => {
  const clash = [REF({ assetId: "a", ordinal: 1 }), REF({ assetId: "b", ordinal: 1 })];
  const { conflicts } = normalizeReferenceInputs(clash);
  assert.deepEqual(conflicts, [1]);
  const r = normalizeReferenceSet({ text: "构图看 [[ref:1]]", inputs: clash });
  assert.equal(r.ok, false, "它真的会拒绝");
  assert.equal(r.text, null);
  assert.match(r.reasons[0], /不止一张参考声称自己是第 1 张/);
});

test("没写 ordinal 的那一张也占着一个编号 —— 隐式与显式撞车同样是歧义", () => {
  // 第一张没写 ordinal（按位置就是 1），第二张显式写 ordinal: 1 —— 只看「写出来的」
  // 编号会认为毫无冲突，然后把 [[ref:1]] 悄悄绑到另一张图上。
  const clash = [REF({ assetId: "a" }), REF({ assetId: "b", ordinal: 1 })];
  const { conflicts } = normalizeReferenceInputs(clash);
  assert.deepEqual(conflicts, [1], "它真的会发现这次撞车");
  assert.equal(normalizeReferenceSet({ text: "[[ref:1]]", inputs: clash }).ok, false);
});

test("重排既换编号也改标记，两件事一起做 —— 只做一半就是静默重指", () => {
  const { inputs } = normalizeReferenceInputs([REF({ assetId: "a" }), REF({ assetId: "b" })]);
  const { inputs: next, mapping } = reorderReferenceInputs(inputs, [2, 1]);
  assert.deepEqual(next.map((r) => r.assetId), ["b", "a"]);
  const { text, unmapped } = remapMarkers("身份 [[ref:1]]，姿势 [[ref:2]]", mapping);
  assert.equal(text, "身份 [[ref:2]]，姿势 [[ref:1]]");
  assert.deepEqual(unmapped, []);
  assert.deepEqual(refMarkers(text), [2, 1]);
});

test("剔除一张之后重新编号，会让已有的标记指向另一张图 —— 因此带文本时必须拒绝", () => {
  // 第 1 张不可绑定（没有 digest），第 2 张合法。规整会把第 2 张变成 ordinal 1，
  // 于是提示词里原本指第 2 张的 [[ref:2]] 悬空，而 [[ref:1]] 静默改指了另一张图。
  const inputs = [
    REF({ assetId: "a", ordinal: 1, contentDigest: "" }),
    REF({ assetId: "b", ordinal: 2, name: "第二张" }),
  ];
  const bare = normalizeReferenceInputs(inputs);
  assert.equal(bare.mapping.get(1), null, "被剔除的映射到 null，不是「没提到」");
  assert.equal(bare.mapping.get(2), 1);

  const refused = normalizeReferenceSet({ text: "构图看 [[ref:1]]", inputs });
  assert.equal(refused.ok, false, "它真的会拒绝");
  assert.equal(refused.text, null, "拒绝时不得给出一个编号已经改过的提示词");
  assert.match(refused.reasons[0], /已被剔除/);

  // 标记指向仍然存在的那一张时，文本随之改号，一次改完
  const ok = normalizeReferenceSet({ text: "身份看 [[ref:2]]", inputs });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, "身份看 [[ref:1]]");
  assert.equal(ok.inputs[0].assetId, "b", "改号之后指的还是同一张图");
});

test("重排时被漏掉的项不会消失，而是排到末尾", () => {
  const { inputs } = normalizeReferenceInputs([REF({ assetId: "a" }), REF({ assetId: "b" }), REF({ assetId: "c" })]);
  const { inputs: next } = reorderReferenceInputs(inputs, [3]);
  assert.deepEqual(next.map((r) => r.assetId), ["c", "a", "b"]);
});

test("五个一级分类是派生的，kind 数据一个字都没改", () => {
  assert.deepEqual(REFERENCE_CATEGORIES.map(([id]) => id), ["character", "location", "prop", "visual", "audio"]);
  assert.equal(categoryOf("character-reference"), "character");
  assert.equal(categoryOf("motion-reference"), "visual");
  assert.equal(categoryOf("camera-reference"), "visual");
  assert.equal(categoryOf("bgm"), "audio");
  assert.equal(categoryOf("shot-image"), null, "镜头图片不是参考，硬要归类才是发明");
});

test("合并的是归类，不是「进不进模型」那个事实（TASK-077 §1.3 修的那个谎）", () => {
  // 五个都在「视觉参考」这一组里…
  const cats = ["style-reference", "video-style-reference", "motion-reference", "camera-reference", "performance-reference"]
    .map(categoryOf);
  assert.deepEqual(cats, ["visual", "visual", "visual", "visual", "visual"]);
  // …但只有 style 的图会进模型
  assert.equal(modelReach("style-reference"), "model-input");
  for (const k of ["video-style-reference", "motion-reference", "camera-reference", "performance-reference"]) {
    assert.equal(modelReach(k), "ai-interpretation", `${k} 的图不进模型`);
  }
  assert.equal(modelReach("external-reference"), "none", "外部参考不参与生成");
});

test("分组把每一项的 reach 一起带出来，界面无从只显示归类", () => {
  const { groups, unclassified } = groupByCategory([
    { kind: "style-reference", name: "盛唐" },
    { kind: "motion-reference", name: "推轨" },
    { kind: "shot-image", name: "不是参考" },
  ]);
  const visual = groups.find((g) => g.id === "visual");
  assert.deepEqual(visual.items.map((i) => i.reach), ["model-input", "ai-interpretation"]);
  assert.equal(unclassified.length, 1, "归不了类的报出来，不是丢掉");
});

test("没有用法规则时 fail-closed 地说出来 —— 四视图会让模型画出四个视图", () => {
  const none = usageRuleFor("character", null);
  assert.equal(none.ok, false, "它真的会拒绝");
  assert.match(none.reason, /四视图/);
  const withRule = usageRuleFor("character", { character: "只参考角色形象；不参考角度、构图、姿势、表情" });
  assert.equal(withRule.ok, true);
  assert.equal(withRule.source, "skill", "规则来自 Skill 包，不是硬编码字符串");
});

test("用法规则块按集合里**实际有的**分类派生，不是固定几行", () => {
  const { inputs } = normalizeReferenceInputs([REF(), REF({ assetId: "b", kind: "location-reference" })]);
  const rules = { character: "只参考角色形象", location: "只参考环境" };
  const block = usageRuleBlock(inputs, rules);
  assert.deepEqual(block.categories, ["character", "location"]);
  assert.match(block.text, /人物：只参考角色形象/);
  assert.match(block.text, /场景：只参考环境/);
  assert.equal(block.missing.length, 0);
  // 少一条规则就报缺，不是悄悄少一行
  const partial = usageRuleBlock(inputs, { character: "只参考角色形象" });
  assert.equal(partial.missing.length, 1);
});

test("归不了类的参考不是「跳过」，而是最危险的那一张 —— 必须报缺", () => {
  const { inputs } = normalizeReferenceInputs([REF({ kind: "shot-image", name: "某张镜头图" })]);
  const block = usageRuleBlock(inputs, { character: "只参考角色形象" });
  assert.deepEqual(block.categories, []);
  assert.deepEqual(block.uncategorized, ["某张镜头图"]);
  assert.equal(block.missing.length, 1, "它真的会报缺，而不是让这张图不带规则被送出去");
  assert.match(block.missing[0], /不要不带规则就送出去/);
});

/* ========================================================================= */
/* 4. 批量付费                                                                */
/* ========================================================================= */

const ITEMS = [{ id: "s1", label: "第 1 镜" }, { id: "s2", label: "第 2 镜" }];
const PREFLIGHT = { total: { amount: 84, currency: "JPY", count: 2 }, blockers: [], preflight_digest: "d1" };

test("预检没给总额就拒绝 —— 不按单价 ×N 自算", () => {
  const b = applyPreflight(createBatch({ kind: "video", items: ITEMS }), { blockers: [] });
  assert.equal(b.state, "refused", "它真的会拒绝");
  assert.match(b.refusal.reason, /总额/);
  assert.match(b.refusal.detail, /界面永不自算/);
});

test("预检报的条数与这一批不符也拒绝 —— 那是两件不同的活", () => {
  const b = applyPreflight(createBatch({ kind: "video", items: ITEMS }), {
    total: { amount: 60, currency: "JPY", count: 1 }, blockers: [],
  });
  assert.equal(b.state, "refused");
  assert.match(b.refusal.reason, /1 条的总额.*2 条/);
});

test("预检没说这个总额覆盖几条，同样拒绝 —— 未说明的条数就是缺失的条数", () => {
  const b = applyPreflight(createBatch({ kind: "video", items: ITEMS }), {
    total: { amount: 84, currency: "JPY" }, blockers: [],
  });
  assert.equal(b.state, "refused", "它真的会拒绝");
  assert.match(b.refusal.reason, /没有说这个总额覆盖几条/);
});

test("负数总额是数据坏了，不是「便宜」", () => {
  const b = applyPreflight(createBatch({ kind: "video", items: ITEMS }), {
    total: { amount: -84, currency: "JPY", count: 2 }, blockers: [],
  });
  assert.equal(b.state, "refused", "它真的会拒绝");
});

test("有金额没币种也拒绝 —— 说不出单位的总额，事后也报不出「花了多少」", () => {
  const b = applyPreflight(createBatch({ kind: "video", items: ITEMS }), {
    total: { amount: 84, count: 2 }, blockers: [],
  });
  assert.equal(b.state, "refused", "它真的会拒绝");
  assert.match(b.refusal.reason, /没给币种/);
});

test("同一条金额判定，三处共用 —— 三种拼法各写一遍就是三次同样的洞", () => {
  assert.equal(isDisplayableAmount(0), true);
  assert.equal(isDisplayableAmount(-1), false);
  assert.equal(isDisplayableAmount(Number.NaN), false);
  assert.equal(isDisplayableAmount(Number.POSITIVE_INFINITY), false);
});

test("条目 id 重复直接拒绝 —— 一次结果结清两条，记账必然错", () => {
  const b = createBatch({ kind: "video", items: [{ id: "s1" }, { id: "s1" }] });
  assert.equal(b.state, "refused", "它真的会拒绝");
  assert.match(b.refusal.reason, /重复的条目 id/);
  assert.equal(b.items.length, 0, "不得静默去重后继续 —— 那是少跑一条而不告诉任何人");
});

test("有条目没有可用 id 时整批拒绝 —— 跳过它等于悄悄少跑几条", () => {
  const b = createBatch({ kind: "video", items: [{ id: "s1" }, { label: "没有 id" }] });
  assert.equal(b.state, "refused", "它真的会拒绝");
  assert.match(b.refusal.reason, /没有可用的 id/);
  assert.equal(b.items.length, 0);
});

test("币种是纯空白等于没有币种", () => {
  const b = applyPreflight(createBatch({ kind: "video", items: ITEMS }), {
    total: { amount: 84, currency: "   ", count: 2 }, blockers: [],
  });
  assert.equal(b.state, "refused", "它真的会拒绝");
});

test("provider 未声明「多图不额外计费」→ fail-closed 拒绝，不静默降级成单图", () => {
  const b = applyPreflight(createBatch({ kind: "keyframe", items: ITEMS }), PREFLIGHT, {
    needsReferenceImages: true,
    capability: { providerLabel: "MiniMax video_generation", maxImages: 0 },
  });
  assert.equal(b.state, "refused", "它真的会拒绝");
  assert.match(b.refusal.reason, /多图不额外计费/);
  assert.match(b.refusal.detail, /不静默降级成单图/);
  assert.equal(b.quote, null, "拒绝发生在报价之前，没花钱");
  // 声明了能力就放行
  const ok = applyPreflight(createBatch({ kind: "keyframe", items: ITEMS }), PREFLIGHT, {
    needsReferenceImages: true, capability: { providerLabel: "X", maxImages: 4 },
  });
  assert.equal(ok.state, "quoted");
});

test("报价带着出处，界面可以断言「这个数字是预检给的」", () => {
  const b = applyPreflight(createBatch({ kind: "video", items: ITEMS }), PREFLIGHT);
  assert.equal(b.state, "quoted");
  assert.equal(b.quote.amount, 84);
  assert.equal(b.quote.source, "gateway-preflight");
  assert.equal(b.quote.preflightDigest, "d1");
});

test("没有报价就确认不了 —— ADR-0041 两步不因为「是批量」而放松", () => {
  const draft = createBatch({ kind: "video", items: ITEMS });
  assert.equal(confirmBatch(draft, "t0").state, "draft", "它真的会拒绝");
  const quoted = applyPreflight(draft, PREFLIGHT);
  assert.equal(confirmBatch(quoted, "t0").state, "running");
});

test("中止把未执行的记成「未执行」，不是「失败」—— 创作者按停不是 provider 报错", () => {
  let b = confirmBatch(applyPreflight(createBatch({ kind: "video", items: ITEMS }), PREFLIGHT), "t0");
  b = recordItem(b, "s1", { outcome: "success", spent: 42 });
  b = abortBatch(b, "t1");
  assert.equal(b.state, "aborted");
  assert.deepEqual(b.items.map((i) => i.outcome), ["success", "skipped"]);
  assert.match(b.items[1].error, /中止/);
});

test("中途失败不把整批标成成功，已花的钱如实记账（失败也可能已扣费）", () => {
  let b = confirmBatch(applyPreflight(createBatch({ kind: "video", items: ITEMS }), PREFLIGHT), "t0");
  b = recordItem(b, "s1", { outcome: "success", spent: 42 });
  b = recordItem(b, "s2", { outcome: "failed", spent: 42, error: "provider 拒绝" });
  const s = settlement(b);
  assert.equal(b.state, "settled");
  assert.equal(s.allSucceeded, false, "它真的会拒绝把这批叫作成功");
  assert.equal(s.spent, 84, "失败那条也扣了钱，照记");
  assert.equal(s.spendComplete, true);
  assert.deepEqual(s.failures.map((f) => f.id), ["s2"]);
  assert.match(settlementLine(b), /1 条失败/);
});

test("中止之后迟到的回执仍然记账 —— 已经在飞的请求可能真的扣了钱", () => {
  let b = confirmBatch(applyPreflight(createBatch({ kind: "video", items: ITEMS }), PREFLIGHT), "t0");
  b = abortBatch(b, "t1");
  assert.equal(settlement(b).awaitingLate, 2, "中止时两条都还在飞，结算尚未成立");
  assert.equal(settlement(b).spendComplete, false, "还可能有回执，就不能说钱已经数清了");
  b = recordItem(b, "s1", { outcome: "success", spent: 42 });
  const s = settlement(b);
  assert.equal(b.state, "aborted", "迟到的回执只纠正账目，不会把批次「重新启动」");
  assert.equal(s.success, 1);
  assert.equal(s.spent, 42, "它真的会把这 42 记进去，而不是当成「未执行」丢掉");
  assert.equal(s.awaitingLate, 1);
});

test("负数的单条花费当作「不知道」，不去冲减总额", () => {
  let b = confirmBatch(applyPreflight(createBatch({ kind: "video", items: ITEMS }), PREFLIGHT), "t0");
  b = recordItem(b, "s1", { outcome: "success", spent: 42 });
  b = recordItem(b, "s2", { outcome: "success", spent: -100 });
  const s = settlement(b);
  assert.equal(s.spent, 42, "它真的不会把 -100 加进去");
  assert.equal(s.spendComplete, false, "而是如实说这一条的花费不明");
});

test("同一条不会被两次结清", () => {
  let b = confirmBatch(applyPreflight(createBatch({ kind: "video", items: ITEMS }), PREFLIGHT), "t0");
  b = recordItem(b, "s1", { outcome: "success", spent: 42 });
  b = recordItem(b, "s1", { outcome: "failed", spent: 42 });
  assert.equal(settlement(b).spent, 42);
  assert.equal(settlement(b).failed, 0);
});

test("有条目没报出实际花费时，说「至少」，不假装知道总数", () => {
  let b = confirmBatch(applyPreflight(createBatch({ kind: "video", items: ITEMS }), PREFLIGHT), "t0");
  b = recordItem(b, "s1", { outcome: "success", spent: 42 });
  b = recordItem(b, "s2", { outcome: "failed" });
  const s = settlement(b);
  assert.equal(s.spendComplete, false);
  assert.equal(s.unknownSpend, 1);
  assert.match(settlementLine(b), /至少 42 JPY/);
});

test("免费的一批照样结得清账：0 是事实，不是「不知道」", () => {
  let b = confirmBatch(applyPreflight(createBatch({ kind: "storyboard", items: ITEMS }), {
    total: { amount: 0, currency: "JPY", count: 2 }, blockers: [],
  }), "t0");
  b = recordItem(b, "s1", { outcome: "success", spent: 0 });
  b = recordItem(b, "s2", { outcome: "success", spent: 0 });
  const s = settlement(b);
  assert.equal(s.spendComplete, true, "0 结清了账，不是永远悬着的未知");
  assert.equal(s.unknownSpend, 0);
  assert.match(settlementLine(b), /已计费 0 JPY/, "它真的会把这一行印出来，而不是静默省略");
  assert.equal(/至少/.test(settlementLine(b)), false);
});

test("空批次不开预检", () => {
  const b = createBatch({ kind: "video", items: [] });
  assert.equal(b.state, "refused");
});

test("还没跑完就不许说账已经清了", () => {
  let b = confirmBatch(applyPreflight(createBatch({ kind: "video", items: ITEMS }), PREFLIGHT), "t0");
  b = recordItem(b, "s1", { outcome: "success", spent: 42 });
  assert.equal(settlement(b).spendComplete, false, "还有一条在跑，42 不是最终账单");
  b = recordItem(b, "s2", { outcome: "success", spent: 42 });
  assert.equal(settlement(b).spendComplete, true);
});

test("被拒绝的一批说「未执行」，不说「进行中」—— 从没开始与做到一半是相反的事实", () => {
  const refused = applyPreflight(createBatch({ kind: "video", items: ITEMS }), { blockers: [] });
  assert.equal(refused.state, "refused");
  const line = settlementLine(refused);
  assert.match(line, /未执行（已拒绝）/, "它真的不会把没跑过的一批印成进行中");
  assert.equal(/进行中/.test(line), false);
  // 报价前 / 报价后待确认，也各说各的
  assert.match(settlementLine(createBatch({ kind: "video", items: ITEMS })), /待报价/);
  assert.match(
    settlementLine(applyPreflight(createBatch({ kind: "video", items: ITEMS }), PREFLIGHT)),
    /已报价待确认/,
  );
});

/* ========================================================================= */
/* 5. 计数                                                                    */
/* ========================================================================= */

const SHOTS = [{ shotId: "a" }, { shotId: "b" }, { shotId: "c", deleted: { at: "t" } }];

test("答不上来时是「—」，不是 0 —— 0 是一个我们此刻没资格做的断言", () => {
  const c = productionCounts({});
  for (const def of PRODUCTION_COUNTS) {
    assert.equal(c[def.id].known, false, `${def.id} 无来源时不得声称已知`);
    assert.ok(c[def.id].text.includes(UNKNOWN), `${def.id} 应显示 ${UNKNOWN}`);
  }
});

test("镜头计数查的是登记表，且软删除的不算", () => {
  const c = productionCounts({ shots: SHOTS });
  assert.equal(c.shotsReady.value, 2);
  assert.equal(c.shotsReady.text, "2 个镜头已就绪");
  assert.equal(isDeleted(SHOTS[2]), true);
});

test("设定图计数直接来自 assetReadiness，不重算", () => {
  const c = productionCounts({ shots: SHOTS, assetReadiness: { total: 10, ready: 0 } });
  assert.equal(c.assetsReady.text, "0/10 已生成 · 差 10 个");
});

test("两份提示词都在才算「已合成」—— 只有一份不算", () => {
  const promptsOf = (id) => (id === "a" ? { image: true, video: true } : { image: true, video: false });
  const c = productionCounts({ shots: SHOTS, promptsOf });
  assert.equal(c.promptsComposed.text, "1/2 已合成");
});

test("stage 计数读 TASK-092 那一份状态，且「跳过」与「还没做」分开显示", () => {
  const stageOf = (id) => (id === "a"
    ? { storyboardStatus: "completed" }
    : { storyboardStatus: "skipped" });
  const c = productionCounts({ shots: SHOTS, stageOf });
  assert.equal(c.storyboardPassed.value, 1);
  assert.equal(c.storyboardPassed.skipped, 1);
  assert.match(c.storyboardPassed.text, /1 镜跳过/);
  // 没有 stageOf 就是答不上来，而不是「0 通过」
  assert.equal(productionCounts({ shots: SHOTS }).storyboardPassed.known, false);
});

test("countText 是唯一的显示入口 —— 消费者没有自己拼字符串的理由", () => {
  const c = productionCounts({ shots: SHOTS });
  assert.equal(countText("shotsReady", c), "2 个镜头已就绪");
  assert.equal(countText("videoDone", c), `${UNKNOWN} 视频已完成`);
  assert.equal(countText("nope", c), UNKNOWN);
});

/* ========================================================================= */
/* 6. 报价与规格只有一个读法                                                   */
/* ========================================================================= */

test("五处生成都在闭集里，且各自声明了档位与今天有没有付费路线", () => {
  assert.deepEqual(GEN_SITES.map((s) => s.id), ["asset-image", "prompt", "storyboard", "keyframe", "video"]);
  assert.equal(genSite("storyboard").tier, "draft", "草图是便宜档");
  assert.equal(genSite("keyframe").tier, "final");
  assert.equal(genSite("video").paidToday, true);
  for (const s of GEN_SITES) {
    if (!s.paidToday) assert.ok(s.why, `${s.id} 不可付费时必须说明原因，不是静默灰掉`);
  }
});

test("草图路径请求 2K 会被判违规 —— 便宜是它存在的理由", () => {
  assert.deepEqual(specViolations("storyboard", { resolution: "512" }), []);
  const bad = specViolations("storyboard", { resolution: "2K" });
  assert.equal(bad.length, 1, "它真的会拒绝");
  assert.match(bad[0], /便宜档/);
  assert.deepEqual(specViolations("keyframe", { resolution: "2K" }), [], "正式档本来就该 2K");
});

test("quoteView 拿不到 preflight 就说拿不到，且没有裸参数入口可以「乘一下」", () => {
  assert.equal(quoteView(null).available, false);
  assert.equal(quoteView({ blockers: ["首帧缺失"] }).available, false);
  assert.equal(quoteView({ blockers: ["首帧缺失"] }).reason, "首帧缺失");
  const noCost = quoteView({ inputs: { model: "m" }, blockers: [] });
  assert.equal(noCost.available, false, "它真的会拒绝");
  assert.match(noCost.reason, /界面不自算/);
  const negative = quoteView({ inputs: { model: "m" }, cost: { jpy: -28 }, blockers: [] });
  assert.equal(negative.available, false, "负价是数据坏了 —— 不得渲染成一个可以确认的报价");
  const ok = quoteView({ inputs: { model: "video-01" }, cost: { jpy: 28, original_currency: "USD" }, blockers: [] });
  assert.equal(ok.available, true);
  assert.equal(ok.cost.jpy, 28, "金额不做任何除法：¥28 不得印成 ¥0.28");
  assert.equal(ok.source, "gateway-preflight");
});

test("规格读不到就是「未知」，不填看起来合理的默认值", () => {
  assert.equal(specRows(null).known, false);
  const rows = specRows({ inputs: { model: "video-01", resolution: "1080P" }, cost: { jpy: 1 }, blockers: [] });
  assert.equal(rows.known, true);
  assert.deepEqual(rows.rows.map(([, v]) => v), ["video-01", "1080P", null, null]);
});

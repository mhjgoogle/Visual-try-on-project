// TASK-097 批次 4A / TASK-095 —— 向导骨架，作为规则：
//
//   1. **向导不新增页面。** `PAGES.length === 11` 必须仍为真，而且与**向导可见性
//      同时断言** —— 分开断言等于两处各自成立而合起来不成立（ADR-0066 决策 10）。
//   2. 顶部那些数字**全部走 `counts.productionCounts`**，不就地算。
//      就地算会同时造成「模块永远接不上」和「多出第二份计数」（§2.5c 规则 4 / §2.6.2）。
//   3. **每一步的 `ready` 来自它真实的完成条件**，不是「上一步点过了」。
//      §2.5e：向导的每一步本身就是一条缝 ——「说可以进下一步」与「下一步真的能做」
//      是两处在陈述同一件事实，在向导上那条缝的形状是**「下一步亮着但点进去是空的」**。
//   4. 闸门**不置灰导航**：不能开始也仍然给一条进去看的路，只是如实说缺什么。
//   5. 本集剧本搬进剧集制作：`spaceOf` / `crumbScope` 都改成集级，**成员集合不变**。
//
// §2.6.3：每条守卫先有一次「它真的会拒绝」的证明。
//
// 纯测试：无 DOM、无网络。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WIZARD_STEPS, wizardStep, wizardModel, renderProdWizard, stepReadiness,
} from "../src/ui/prodwizard.js";
import { productionCounts, UNKNOWN } from "../src/workflow/counts.js";
import { PAGES, NAV, EPISODE_NAV, spaceOf, crumbScope } from "../src/ui/shell.js";

/* ========================================================================= */
/* 1. 不新增页面 —— 与向导可见性**同时**断言                                    */
/* ========================================================================= */

test("向导可见的**同时**，十一页那条冻结守卫仍然成立", () => {
  // 分开断言等于两处各自成立而合起来不成立。ADR-0066 决策 10 禁止的是
  // 「新增一级或二级页面」，所以必须在向导真的渲染出来的那一刻检查页数。
  const m = wizardModel({
    counts: productionCounts({ shots: [{ shotId: "a" }] }),
    readyOf: () => ({ done: false, blockers: [] }),
  });
  const html = renderProdWizard(m);
  assert.match(html, /pw-scrim show/, "向导确实渲染出来了");
  assert.match(html, /确认镜头/);
  // …而且此刻页数没变
  assert.equal(PAGES.length, 11, `expected eleven pages, got ${PAGES.join(" ")}`);
  // 向导也不得偷偷把自己登记成一页
  assert.equal(PAGES.includes("wizard"), false);
  assert.equal(PAGES.filter((p) => p.startsWith("pw")).length, 0);
});

test("五步是闭集，每一步都指名它顶部显示哪一个计数", () => {
  assert.deepEqual(WIZARD_STEPS.map((s) => s.id),
    ["shots", "assets", "prompts", "storyboard", "keyframe"]);
  assert.deepEqual(WIZARD_STEPS.map((s) => s.n), [1, 2, 3, 4, 5]);
  for (const s of WIZARD_STEPS) {
    assert.ok(s.count, `${s.id} 没有指名计数 —— 顶部数字就会是就地算的`);
    // 已建成的步骤必须指得出落点（向导不新增页面，它组织既有内容）
    if (s.built) assert.ok(s.lands, `${s.id} 说自己建好了却指不出落点`);
    else assert.equal(s.lands, null, `${s.id} 还没建成却指了一个落点`);
  }
  assert.equal(wizardStep("nope"), null);
});

/* ========================================================================= */
/* 2. 数字来自 counts，不就地算                                                */
/* ========================================================================= */

test("顶部数字来自 counts —— 答不上来时显示「—」，不是 0", () => {
  // 没有任何来源：五步的数字全部是「不知道」。**0 是一个我们此刻没资格做的断言。**
  const m = wizardModel({ counts: productionCounts({}), readyOf: () => ({}) });
  for (const s of m.steps) {
    assert.ok(s.countText.includes(UNKNOWN), `${s.id} 无来源时应显示 ${UNKNOWN}`);
  }
  const html = renderProdWizard(m);
  assert.match(html, new RegExp(UNKNOWN));
  assert.equal(/\b0 个镜头已就绪/.test(html), false, "不得把「不知道」印成 0");
});

test("有来源时数字是真的，且与其他消费者同源", () => {
  const counts = productionCounts({
    shots: [{ shotId: "a" }, { shotId: "b" }, { shotId: "c", deleted: { at: "t" } }],
    assetReadiness: { total: 10, ready: 3 },
  });
  const m = wizardModel({ counts, readyOf: () => ({}) });
  const shots = m.steps.find((s) => s.id === "shots");
  const assets = m.steps.find((s) => s.id === "assets");
  assert.equal(shots.countText, "2 个镜头已就绪", "软删除的那一镜不算");
  assert.equal(assets.countText, "3/10 已生成 · 差 7 个");
  // 同一个数字**不是**向导自己算的 —— 它就是 counts 的产出
  assert.equal(shots.countText, counts.shotsReady.text);
  assert.equal(assets.countText, counts.assetsReady.text);
});

/* ========================================================================= */
/* 3 + 4. 每一步的 ready 是真实条件；闸门不置灰导航                             */
/* ========================================================================= */

test("`ready` 来自真实条件 —— 不是「上一步点过了」", () => {
  // 关键：向导**不存进度**。同一个 counts + 同一个 readyOf 永远得到同一个模型，
  // 无论创作者点过哪些步。一个记录导航历史的向导会立刻变成 §2.5e 那条缝。
  const counts = productionCounts({ shots: [{ shotId: "a" }] });
  const readyOf = (id) => (id === "shots"
    ? { done: true, blockers: [] }
    : { done: false, blockers: ["先完成第 ① 步"] });
  const atStep1 = wizardModel({ counts, readyOf, activeId: "shots" });
  const atStep3 = wizardModel({ counts, readyOf, activeId: "prompts" });
  // 走到第 ③ 步并不会让第 ② 步变成 done
  assert.equal(atStep1.steps.find((s) => s.id === "assets").done, false);
  assert.equal(atStep3.steps.find((s) => s.id === "assets").done, false);
  // 「下一步」也是派生的：第一个没做完的那一步
  assert.equal(atStep1.next.id, "assets");
  assert.equal(atStep3.next.id, "assets", "当前停在哪一步不改变「下一步是什么」");
});

test("不能开始的那一步**仍然进得去**，但如实说缺什么（闸门不置灰导航）", () => {
  const m = wizardModel({
    counts: productionCounts({ shots: [{ shotId: "a" }] }),
    readyOf: (id) => (id === "prompts"
      ? { done: false, blockers: ["还有 3 个人物 / 场景没有设定图 —— 合成的提示词会用到它们"] }
      : { done: true, blockers: [] }),
    activeId: "prompts",
  });
  const step = m.steps.find((s) => s.id === "prompts");
  assert.equal(step.ready, false, "它真的会拦住");
  const html = renderProdWizard(m);
  assert.match(html, /还不能开始这一步/);
  assert.match(html, /没有设定图/, "缺什么写出来，不是一个禁用的按钮");
  assert.match(html, /仍然进去看看/, "而且仍然给一条进去的路 —— 闸门不置灰导航");
});

test("还没建成的那一步不给空白面板，如实说界面还在做；建成的那一步给落点", () => {
  // 批次 4F 之后 ④ 已经建成（那条横向带），所以它**指得出落点**；
  // ⑤ 仍未建成（4G），继续如实说。这条守卫因此同时钉住两半 ——
  // 否则它会在每一批建成之后静默变成永真（§2.6.3 第 1 条）。
  const built = wizardModel({
    counts: productionCounts({}),
    readyOf: () => ({ done: false, blockers: [] }),
    activeId: "storyboard",
  });
  const builtHtml = renderProdWizard(built);
  assert.equal(/界面还在做/.test(builtHtml), false, "④ 已建成，不该再说还在做");
  assert.match(builtHtml, /进入「Storyboard」/, "建成了就指得出落点");
  const unbuilt = wizardModel({
    counts: productionCounts({}),
    readyOf: () => ({ done: false, blockers: [] }),
    activeId: "keyframe",
  });
  const unbuiltHtml = renderProdWizard(unbuilt);
  assert.match(unbuiltHtml, /界面还在做/);
  assert.match(unbuiltHtml, /4F \/ 4G/, "并指明它在本链的哪一批");
  assert.equal(/进入「Keyframe」/.test(unbuiltHtml), false, "不给一个进不去的入口");
});

test("五步全完成才说可以批量生视频", () => {
  const allDone = wizardModel({
    counts: productionCounts({}),
    readyOf: () => ({ done: true, blockers: [] }),
  });
  assert.equal(allDone.allDone, true);
  assert.match(renderProdWizard(allDone), /可以批量生视频/);
  const notYet = wizardModel({
    counts: productionCounts({}),
    readyOf: (id) => ({ done: id !== "keyframe", blockers: [] }),
  });
  assert.equal(notYet.allDone, false, "它真的会拒绝");
  assert.equal(/可以批量生视频/.test(renderProdWizard(notYet)), false);
});

test("向导说清自己到哪儿为止 —— 配音 / 剪辑 / 质检不在里面", () => {
  const html = renderProdWizard(wizardModel({
    counts: productionCounts({}), readyOf: () => ({ done: false, blockers: [] }),
  }));
  assert.match(html, /后期交付/);
  assert.match(html, /太 busy/, "并说明为什么不塞进来");
});

/* ========================================================================= */
/* 5. 剧本搬入剧集制作 —— 成员集合不变                                         */
/* ========================================================================= */

test("本集剧本归剧集制作，且是它的第一行", () => {
  assert.equal(spaceOf("script"), "episode");
  assert.equal(crumbScope("script", null), "episode", "面包屑改成集级");
  assert.equal(EPISODE_NAV[0][0], "script");
  assert.equal(NAV[0].items.some(([k]) => k === "script"), false, "它离开了故事开发的 rail");
});

test("**只是换了空间**：十一页的成员集合一个不多一个不少", () => {
  // 这是「移动」与「新增/删除」的区别，也是 ADR-0066 决策 10 真正禁止的东西。
  assert.deepEqual([...PAGES].sort(), [
    "assets", "board", "brief", "cutreview", "delivery",
    "episodes", "script", "settings", "shotwork", "story", "storyboard",
  ]);
  assert.equal(new Set(PAGES).size, PAGES.length, "没有一页被登记两次");
});

test("没指定时**打开在第一个没做完的那一步** —— 否则那句「只有一个下一步」在自己的屏幕上就不成立", () => {
  // 真实项目上看到的：①③ 已完成，头部说「下一步：准备资产」，而主区显示的是 ①。
  // 测试当时全绿，因为它们都显式传了 activeId（§2.6.4）。
  const counts = productionCounts({ shots: [{ shotId: "a" }] });
  const readyOf = (id) => ({ done: id === "shots" || id === "prompts", blockers: [] });
  const m = wizardModel({ counts, readyOf });
  assert.equal(m.active.id, "assets", "打开在下一步，不是第一步");
  assert.equal(m.next.id, "assets", "而且主区与头部说的是同一步");
  assert.equal(m.active.id, m.next.id);
  // 创作者显式点了某一步，就尊重他的选择
  const picked = wizardModel({ counts, readyOf, activeId: "keyframe" });
  assert.equal(picked.active.id, "keyframe");
  // 全部完成时打开在第一步（没有「下一步」了）
  const allDone = wizardModel({ counts, readyOf: () => ({ done: true, blockers: [] }) });
  assert.equal(allDone.next, null);
  assert.equal(allDone.active.id, "shots");
});

/* ========================================================================= */
/* 6. 就绪判定：**答不上来 ≠ 放行**，两个方向都用生产谓词钉住（§2.5d）           */
/* ========================================================================= */

test("上游答不上来时**不放行** —— codex 在本批报的那个 P1", () => {
  // 一集没有镜头：assetsReady 是「不知道」（没有分镜就无从抽取资产）。
  // 旧代码只在 `known && missing > 0` 时给阻塞，于是 unknown 落进 else，
  // 第 ③ 步亮着「进入」，点进去是一个空的 shotwork —— 文件头那句
  // 「下一步亮着但点进去是空的」。
  const empty = productionCounts({});
  assert.equal(empty.assetsReady.known, false, "前提：它确实是「不知道」");
  const r = stepReadiness(empty, "prompts");
  assert.equal(r.done, false);
  assert.equal(r.blockers.length > 0, true, "不知道就是拦，不是放行");
  assert.match(r.blockers[0], /先完成第 1 步/, "并指名第一个卡住的上游");
  // 五步没有一步会在「什么都不知道」时说可以开始
  for (const s of WIZARD_STEPS) {
    assert.equal(stepReadiness(empty, s.id).blockers.length > 0, true,
      `${s.id} 在无来源时放行了`);
  }
});

test("**反方向也钉住**：真的齐了就真的能开始（否则这只是一道迟早被关掉的闸门）", () => {
  // §2.5d：只钉「会拒绝」那一半，等于造一道以后一定会被关掉的闸门。
  const ready = productionCounts({
    shots: [{ shotId: "a" }, { shotId: "b" }],
    assetReadiness: { total: 3, ready: 3 },
    promptsOf: () => ({ image: true, video: true }),
  });
  assert.deepEqual(stepReadiness(ready, "shots"), { done: true, blockers: [] });
  assert.deepEqual(stepReadiness(ready, "assets"), { done: true, blockers: [] });
  assert.deepEqual(stepReadiness(ready, "prompts"), { done: true, blockers: [] },
    "上游齐了、自己也齐了 —— 必须真的能开始");
});

test("`blockers` 说的是「开始不了」，不是「还没做完」—— 否则正在做的那一步会被自己拦住", () => {
  // 真实屏幕上看到的（测试当时全绿）：第 ② 步 1/2，顶着一句「还不能开始这一步 ——
  // 还有 1 个没有设定图」。那句话把**你要做的工作**印成了**拦住你的理由**。
  // 它是上面那个 P1 的镜像：只会拒绝的闸门同样是错的（§2.5d 钉反方向的理由）。
  const c = productionCounts({
    shots: [{ shotId: "a" }],
    assetReadiness: { total: 4, ready: 1 },
    promptsOf: () => ({ image: true, video: false }),
  });
  assert.equal(stepReadiness(c, "shots").done, true);
  const assets = stepReadiness(c, "assets");
  assert.equal(assets.done, false, "1/4 当然没做完");
  assert.deepEqual(assets.blockers, [], "但它**开始得了** —— 它就是此刻该做的那一步");
  // 第 ③ 步才是真的开始不了：它的输入（设定图）还不齐
  const prompts = stepReadiness(c, "prompts");
  assert.match(prompts.blockers[0], /先完成第 2 步「准备资产」/);
  assert.match(prompts.blockers[0], /还有 3 个/, "并说清上游差什么");
  assert.equal(stepReadiness(c, "nope").blockers.length, 0, "不认识的步骤不编造阻塞");
});

test("第 ① 步是唯一自己就能「开始不了」的一步 —— 它的输入是剧本，不是别的步骤", () => {
  const noShots = productionCounts({ shots: [] });
  const r = stepReadiness(noShots, "shots");
  assert.equal(r.done, false);
  assert.match(r.blockers[0], /先在「本集剧本」里写剧本/, "指向剧本，不是指向某个步骤");
  // 有了分镜就不再拦
  assert.deepEqual(stepReadiness(productionCounts({ shots: [{ shotId: "a" }] }), "shots"),
    { done: true, blockers: [] });
});

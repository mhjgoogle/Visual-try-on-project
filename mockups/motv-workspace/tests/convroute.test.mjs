// 意图路由的前端一半（TASK-119 / ADR-0091）。
//
// 这个模块只回答一个问题：**服务端已经解析出来的那个能力，现在能不能跑。**
// 所以这里守的也只有那几条会静默出错的性质：
//
//   1. 「开发」窗口一个作品能力都不许起跑（第二道闸，服务端那道才是强制的）；
//   2. 输入不够时**不跑**，并且说得出缺什么 —— 模型说「齐了」不作数；
//   3. 同一轮不会跑第二次（刷新、轮询、重试都会重新走到这里）；
//   4. 结构性变更之后的跨层建议：有根 / 跨层 / 只一次，普通编辑一条都不满足。
//
// 还有一条是**这个文件里没有的东西**：任何一个内部专业能力的名字。前端拿到的
// skillId 来自服务端的解析结果，不是它自己认识的一张表 —— 那正是这次收敛的边界。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

import {
  decideRoute, routeOf, rejectedRouteOf, structuralRoot, zoomKeyFor, zoomTrigger,
  STRUCTURAL_ACTIONS, USER_CAPABILITY_ZH,
} from "../src/workflow/convroute.js";

/** 服务端解析结果的形状：capability 是他看得见的那一类，skillId 是解析出来的。 */
const PLAN = {
  capability: "story-review",
  skillId: "some-internal-skill",
  title: "内部能力",
  scope: "episode",
  reason: "你说的话里点到了「剧本」",
};

const SKILL = { skillId: "some-internal-skill", title: "内部能力", work: "review" };

function ctx(over = {}) {
  return {
    mode: "work",
    findSkill: (id) => (id === SKILL.skillId ? SKILL : null),
    missingOf: () => [],
    labelOf: (k) => ({ outline: "故事大纲", episodeScript: "本集剧本" })[k] || k,
    pickExecutor: () => "claude-code",
    ranFor: () => null,
    ...over,
  };
}

test("没有 route 就是没有 route —— 不编一个出来", () => {
  assert.equal(decideRoute(null, ctx()).action, "none");
  assert.equal(decideRoute({}, ctx()).action, "none");
  assert.equal(decideRoute({ skillId: "" }, ctx()).action, "none");
  // 只有 capability 而服务端没解析出 skillId：那一轮没有可执行的计划
  assert.equal(decideRoute({ capability: "story-review" }, ctx()).action, "none");
});

test("输入齐、执行器在 → 跑；带上服务端给的理由与那一类", () => {
  const d = decideRoute(PLAN, ctx());
  assert.equal(d.action, "run");
  assert.equal(d.skillId, "some-internal-skill");
  assert.equal(d.executor, "claude-code");
  assert.equal(d.capability, "story-review");
  assert.equal(d.why, "你说的话里点到了「剧本」");
});

test("「开发」窗口里一个作品能力都不许起跑", () => {
  const d = decideRoute(PLAN, ctx({ mode: "feedback" }));
  assert.equal(d.action, "blocked");
  assert.match(d.reason, /开发/);
  assert.match(d.reason, /作品/, "要指出切回哪个窗口能做");
});

test("输入不够就不跑，并说得出缺哪几样 —— 模型说「齐了」不作数", () => {
  // 服务端也判过一次（它拿的是这边报的 readyInputs），但**权威的那一次在这里**：
  // 文档在浏览器里，判定就该在浏览器里落定。
  const d = decideRoute(PLAN, ctx({ missingOf: () => ["outline", "episodeScript"] }));
  assert.equal(d.action, "blocked");
  assert.deepEqual(d.missing, ["故事大纲", "本集剧本"]);
  assert.match(d.reason, /故事大纲/);
  assert.match(d.reason, /本集剧本/);
});

test("目录里没有这个能力 → 不跑，而且不说内部 id", () => {
  const d = decideRoute(PLAN, ctx({ findSkill: () => null }));
  assert.equal(d.action, "blocked");
  assert.ok(
    !d.reason.includes("some-internal-skill"),
    "屏幕上不该出现内部能力的 id（ADR-0091 决策 5）",
  );
});

test("本机没有可用执行器 → 不跑，但给出手工那条路", () => {
  const d = decideRoute(PLAN, ctx({ pickExecutor: () => null }));
  assert.equal(d.action, "blocked");
  assert.match(d.reason, /手工/, "ADR-0065 决策 2：每个 AI 动作都要有手工兜底");
});

test("同一轮不会跑第二次 —— 刷新 / 轮询 / 重试都走到这里", () => {
  const ran = { runId: "r-1", status: "succeeded" };
  const d = decideRoute(PLAN, ctx({ ranFor: () => ran }));
  assert.equal(d.action, "already");
  assert.equal(d.run, ran);
});

test("幂等这一关排在输入检查之前 —— 跑过了就不该再报「缺输入」", () => {
  // 顺序有实际后果：跑完之后文档可能变了，这时重算的「缺什么」与当时那次无关，
  // 屏幕上会出现一条对不上号的理由。
  const d = decideRoute(
    PLAN,
    ctx({ ranFor: () => ({ runId: "r-1" }), missingOf: () => ["outline"] }),
  );
  assert.equal(d.action, "already");
});

test("turn 上的 route / routeRejected 读得出来，坏形状读成 null", () => {
  assert.equal(routeOf({ route: PLAN }), PLAN);
  assert.equal(routeOf({ route: { capability: "x" } }), null, "没有 skillId 就不是计划");
  assert.equal(routeOf({}), null);
  assert.deepEqual(rejectedRouteOf({ routeRejected: { reason: "不认识" } }), {
    reason: "不认识",
  });
  assert.equal(rejectedRouteOf({ routeRejected: { reason: "" } }), null);
  assert.equal(rejectedRouteOf({}), null);
});

test("三类工作各有中文说法 —— 屏幕上说的是它们，不是内部 id", () => {
  assert.deepEqual(Object.keys(USER_CAPABILITY_ZH).sort(), [
    "episode-production", "story-development", "story-review",
  ]);
  for (const v of Object.values(USER_CAPABILITY_ZH)) assert.ok(v.trim());
});

/* ========================================================================= */
/* 结构性变更 → 跨层一致性建议                                                */
/* ========================================================================= */

const LAYERS = { L2: true, L3: true, L4: true, L5: true };

test("只有产生新版本的那几条动作算结构性变更", () => {
  // 判据是**它是否产生了一个下游要跟着走的新版本**，不是名字。
  assert.deepEqual(Object.keys(STRUCTURAL_ACTIONS).sort(), [
    "brief.fields", "brief.idea", "outline.approve", "outline.fields", "plan.save",
  ]);
});

test("普通编辑不触发 —— 指针、软删除、撤销一条都不算", () => {
  for (const kind of [
    "brief.setActive", "outline.setActive", "shot.hide", "shot.restore",
    "brief.hideVersion", "outline.restoreVersion", "settings.delivery", "plan.entry",
  ]) {
    assert.equal(
      zoomTrigger([{ kind, detail: "x" }], { layersPresent: LAYERS }),
      null,
      `${kind} 不该触发跨层检查`,
    );
  }
});

test("没有版本号就不触发 —— 拿不到稳定身份就没有「只一次」的保证", () => {
  assert.equal(structuralRoot([{ kind: "outline.fields", detail: "x" }]), null);
  assert.equal(zoomTrigger([{ kind: "outline.fields" }], { layersPresent: LAYERS }), null);
});

test("落地失败的那一条不算 —— 它没落下", () => {
  const landed = [{ kind: "outline.fields", version: 3, error: "写不进去" }];
  assert.equal(zoomTrigger(landed, { layersPresent: LAYERS }), null);
});

test("下游一层都还没有东西时不触发 —— 「不同步」无从谈起", () => {
  const landed = [{ kind: "outline.fields", version: 3 }];
  assert.equal(zoomTrigger(landed, { layersPresent: {} }), null);
  assert.equal(zoomTrigger(landed, { layersPresent: { L2: true } }), null,
    "L2 是被改的那一层自己，不算下游");
});

test("有根 + 跨层 → 给出一条建议（是建议，不是直接跑）", () => {
  const landed = [{ kind: "outline.fields", version: 3, detail: "改了结局" }];
  const t = zoomTrigger(landed, { layersPresent: LAYERS });
  assert.ok(t);
  // 返回的是**一类工作**，不是某个 skillId —— 选哪个诊断器仍然归服务端 resolver，
  // 与他自己开口问走的是同一条路，所以这件事只有一处判定。
  assert.equal(t.capability, "story-review");
  assert.ok(!("skillId" in t), "前端不得自己指定内部能力");
  assert.deepEqual(t.affects, ["L3", "L4", "L5"]);
  assert.equal(t.key, "consistency:outline:v3");
  // goal 用的是**跨层措辞**，所以 resolver 会选中跨层诊断器而不是剧本诊断
  assert.match(t.goal, /各层|同步|设定与剧本/);
});

test("同一次变更只提一次", () => {
  const landed = [{ kind: "outline.fields", version: 3 }];
  const key = zoomKeyFor({ doc: "outline", version: 3 });
  assert.equal(
    zoomTrigger(landed, { layersPresent: LAYERS, hasRunKey: (k) => k === key }),
    null,
  );
});

test("同一份文档的同一版永远是同一个 key；不同版不是", () => {
  assert.equal(zoomKeyFor({ doc: "outline", version: 3 }), "consistency:outline:v3");
  assert.notEqual(
    zoomKeyFor({ doc: "outline", version: 3 }),
    zoomKeyFor({ doc: "outline", version: 4 }),
  );
  assert.equal(zoomKeyFor({ doc: "outline" }), null, "没有版本就没有 key");
  assert.equal(zoomKeyFor(null), null);
});

test("一轮里改了创意又改了大纲 → 根是最上游那个（创意）", () => {
  // 大纲的变化本来就是创意的下游；以它为根会把同一件事拆成两次检查。
  const landed = [
    { kind: "outline.fields", version: 7 },
    { kind: "brief.idea", version: 2 },
  ];
  const root = structuralRoot(landed);
  assert.equal(root.layer, "L1");
  assert.equal(root.doc, "brief");
  assert.equal(root.version, 2);
});

test("一句话里改了创意又改了类型 → 同一版，所以只提一次", () => {
  // `applyConversationEdits` 一轮只 commit 一次 brief，两条动作共享同一个版本身份。
  const landed = [
    { kind: "brief.idea", version: 5 },
    { kind: "brief.fields", version: 5 },
  ];
  const t = zoomTrigger(landed, { layersPresent: LAYERS });
  assert.equal(t.key, "consistency:brief:v5");
});

/* ========================================================================= */
/* 接线：起跑只在发送那条链里，读路径上一行都没有                              */
/* ========================================================================= */

test("读线程的路径上没有任何起跑代码 —— 刷新与轮询不可能重复启动", () => {
  // 这是「不重复启动」最结实的那一半保证：另一半是登记表里的幂等键。
  // 用源码断言是**故意**的 —— 这条性质说的就是「这几个函数里没有调用某样东西」，
  // 行为测试看不见「它没调什么」。
  const src = readFileSync(join(HERE, "..", "src", "ui", "production.js"), "utf8");
  const body = (name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > 0, `${name} 不见了`);
    // 到下一个顶层 `  function ` 为止，够用且不依赖括号配平
    const next = src.indexOf("\n  function ", at + 1);
    return src.slice(at, next > 0 ? next : src.length);
  };
  for (const reader of ["ensureConversation", "refreshConversation", "convRouteState"]) {
    const text = body(reader);
    assert.ok(!text.includes("launchRouted("), `${reader} 不该起跑任何能力`);
    assert.ok(!text.includes("ctx.skills.run("), `${reader} 不该起跑任何能力`);
    assert.ok(!text.includes("runRouteFor("), `${reader} 不该起跑任何能力`);
  }
  // …而发送那条链里确实有它
  assert.ok(body("sendConversationTurn").includes("runRouteFor("));
});

test("跨层诊断是**建议**，不是自动跑", () => {
  const src = readFileSync(join(HERE, "..", "src", "ui", "production.js"), "utf8");
  const at = src.indexOf("function suggestZoomFor(");
  assert.ok(at > 0);
  const next = src.indexOf("\n  function ", at + 1);
  const text = src.slice(at, next > 0 ? next : src.length);
  assert.ok(!text.includes("launchRouted("), "它只放一条建议，不替他决定跑不跑");
  assert.ok(!text.includes("ctx.skills.run("));
  assert.ok(text.includes("ui.convSuggest"));
});

test("自动起跑走的是创作者自己那条运行路径", () => {
  // 同一个 `ctx.skills.run`，所以守卫、登记、schema 校验、提案语义一条不少 ——
  // 「自动触发的是运行，不是接受」靠的就是这一点。
  const src = readFileSync(join(HERE, "..", "src", "ui", "production.js"), "utf8");
  const at = src.indexOf("function launchRouted(");
  const next = src.indexOf("\n  function ", at + 1);
  const text = src.slice(at, next > 0 ? next : src.length);
  assert.ok(text.includes("ctx.skills.run("), "不得另开一条运行路径");
  assert.ok(text.includes("origin"), "要记下是谁要求跑的（幂等键就是它）");
});

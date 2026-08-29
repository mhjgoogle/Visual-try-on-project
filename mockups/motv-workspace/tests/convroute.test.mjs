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
  decideRoute, originForRoute, routeOf, rejectedRouteOf, scopeOfSkill, structuralRoot,
  zoomKeyFor, zoomTrigger, STRUCTURAL_ACTIONS, USER_CAPABILITY_ZH,
} from "../src/workflow/convroute.js";
import { createSkillController } from "../src/controllers/skillctl.js";
import * as skills from "../src/workflow/skills.js";
import * as runtime from "../src/services/runtime.js";
import * as skillrun from "../src/workflow/skillrun.js";
import * as skillapply from "../src/workflow/skillapply.js";

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
  // …而且要重画。它是发送那条链的**最后一步**，后面没有别的东西会重画 ——
  // 少了这一句，建议要等某个不相干的渲染才出现，在他眼里等于什么都没发生
  // （codex 独立审查轮 2 的 P1）。
  assert.ok(text.includes("render()"), "设了要显示的状态就必须重画");
});

test("发送那条链里，每个会改 UI 状态的终点都重画", () => {
  // 这是上面那条 P1 的**类**，不是那一个实例：一条异步链的终点改了要显示的状态却
  // 不重画，屏幕上与「它没做」无法区分，而且不会报错。
  const src = readFileSync(join(HERE, "..", "src", "ui", "production.js"), "utf8");
  const body = (name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > 0, `${name} 不见了`);
    const next = src.indexOf("\n  function ", at + 1);
    return src.slice(at, next > 0 ? next : src.length);
  };
  for (const fn of ["runRouteFor", "suggestZoomFor", "launchRouted"]) {
    assert.ok(body(fn).includes("render()"), `${fn} 改了状态却不重画`);
  }
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

/* ========================================================================= */
/* 作用范围读的是**真实的公开形状**（codex 审查轮 1 的 P1）                    */
/* ========================================================================= */

test("范围从 routing.internalRouting.scope 读 —— 拆分前的路径读不出东西", () => {
  // 这是那个 P1 的形状：`skill.routing.scope` 在拆分后是 undefined，而 undefined
  // 在每一处判断里都表现为「不是 shot」—— 镜头域能力于是永远拿不到 shotId，
  // 永远因为「缺一个镜头」起不来，**而且不报错**。
  assert.equal(
    scopeOfSkill({ routing: { internalRouting: { scope: "shot" } } }),
    "shot",
  );
  assert.equal(scopeOfSkill({ routing: { scope: "shot" } }), "", "拆分前的写法不该被认");
  assert.equal(scopeOfSkill({ routing: null }), "");
  assert.equal(scopeOfSkill({}), "");
  assert.equal(scopeOfSkill(null), "");
});

test("对着真实的内置包也读得出来 —— 钉住磁盘上的形状，不是我脑子里的形状", () => {
  // 直接读产品资产：这条会在 manifest 的路由形状再变一次时转红，
  // 而那正是上一次没有人发现的那种改动。
  const repo = join(HERE, "..", "..", "..");
  const read = (id) =>
    JSON.parse(readFileSync(join(repo, "product-skills", "builtin", id, "manifest.json"), "utf8"));

  // 目录装进页面时用的是 `Skill.public()` 的形状，其中 routing 原样带过来
  const asInstalled = (m) => ({ skillId: m.skillId, title: m.title, work: m.work, routing: m.routing });

  assert.equal(scopeOfSkill(asInstalled(read("shot-continuity-reviewer"))), "shot",
    "它声明了镜头域输入，只能对着一个镜头跑");
  assert.equal(scopeOfSkill(asInstalled(read("script-doctor"))), "episode");
  assert.equal(scopeOfSkill(asInstalled(read("story-zoom"))), "project");
  // 没有 routing 的包（不参与自然语言路由）读出空字符串，而不是炸
  assert.equal(scopeOfSkill(asInstalled(read("cinematography"))), "");
});

test("镜头域能力选中了镜头就跑得起来；没选中才该被拦", () => {
  // 这是 P1 的**行为面**：修好之前，第一种情况也会被拦，理由还是「缺一个镜头」。
  const shotSkill = {
    skillId: "some-internal-skill",
    title: "内部能力",
    work: "review",
    routing: { userCapability: ["story-review"], internalRouting: { scope: "shot" } },
  };
  const scopeFor = (selectedShotId) =>
    scopeOfSkill(shotSkill) === "shot" && selectedShotId ? { shotId: selectedShotId } : null;
  assert.deepEqual(scopeFor("s-2"), { shotId: "s-2" }, "选中了镜头就要把它带上");
  assert.equal(scopeFor(null), null);

  // 带上了 scope，`missingOf` 就拿得到那个镜头的投影，于是不再报缺 —— 能跑
  const d = decideRoute(
    { ...PLAN, scope: "shot" },
    ctx({ findSkill: () => shotSkill, missingOf: () => [] }),
  );
  assert.equal(d.action, "run");
});

/* ========================================================================= */
/* 判据 3 与 5 的证据（codex 审查轮 3 报的两处 NOT_EVIDENCED）                 */
/* ========================================================================= */
//
// 轮 3 说得对，两处都对：
//   判据 5 —— 之前那条只喂了一个假的「已跑过」回调，证不了**持久化**那一半；
//   判据 3 —— 之前只证了「它调了 ctx.skills.run」，没证输出仍然是待定的提案。
// 所以这里用**真的** skillctl、真的登记表、真的 skillrun 转移走一遍。

/** 一个只接了登记表的 skillctl。`routedRunFor` / `hasOriginKey` 只读 `docs.runs()`，
 *  其余依赖在这两条路径上不会被碰到，所以给空壳就够 —— 这样测的仍然是真实现。 */
function makeSkillController(registry) {
  return createSkillController({
    docs: { runs: () => registry },
    catalog: { detail: () => null, problems: () => [] },
    modules: {
      skills, runtime, skillrun, skillapply,
      shotctx: {}, proddoc: {}, storydoc: {}, scriptdoc: {}, assetreg: {},
      refinterp: {}, timeline: {}, subtitle: {}, mediaref: {},
    },
    findShot: () => null,
    slotOf: () => null,
    isLocked: () => false,
    shotAudio: { resolved: () => [], anchors: () => [] },
    shotCtx: { build: () => ({}), candidates: () => ({}) },
    draftShots: () => [],
    dispatchAction: () => ({ ok: true }),
    persist: () => {},
    refresh: () => {},
    now: () => "2026-08-30T00:00:00Z",
  });
}

test("判据 5：去重问的是**登记表**，所以刷新 / 重试之后仍然不会重复起跑", () => {
  const registry = [];
  assert.equal(makeSkillController(registry).routedRunFor("conv-1"), null, "还没跑过");

  skillrun.startRun(registry, {
    skillId: "script-doctor",
    skillVersion: 2,
    origin: { kind: "conversation", conversationRunId: "conv-1" },
  });
  assert.equal(registry.length, 1);

  // 「刷新」= 拿同一份持久化的登记表重新构造一个控制器（页面内存全没了）
  const afterRefresh = makeSkillController(registry);
  assert.ok(afterRefresh.routedRunFor("conv-1"), "刷新之后仍然认得出这一轮跑过了");
  assert.equal(afterRefresh.routedRunFor("conv-2"), null, "别的轮次不受影响");

  // 于是 decideRoute 拿到它就不再起跑
  const d = decideRoute(PLAN, ctx({ ranFor: () => afterRefresh.routedRunFor("conv-1") }));
  assert.equal(d.action, "already");
});

test("判据 5：跨层建议的幂等键**真的走进 origin** —— 不是测试自己拼出来的", () => {
  // 上一版这条测试**手工插了一条带 idempotencyKey 的记录**，于是它证的是
  // `hasOriginKey` 会读这个字段，而不是「真实路径会写这个字段」——
  // 而真实路径当时根本没写（点击时把 key 丢了）。这正是「为了错误的理由而通过」。
  // 现在先用 `originForRoute`（生产代码里唯一构造 origin 的地方）造出那条记录。
  const registry = [];
  const key = zoomKeyFor({ doc: "outline", version: 3 });
  const origin = originForRoute("conv-9", key);
  assert.deepEqual(origin, {
    kind: "conversation",
    conversationRunId: "conv-9",
    idempotencyKey: "consistency:outline:v3",
  });
  skillrun.startRun(registry, { skillId: "story-zoom", skillVersion: 1, origin });
  const afterRefresh = makeSkillController(registry);
  assert.equal(afterRefresh.hasOriginKey("consistency:outline:v3"), true);
  assert.equal(afterRefresh.hasOriginKey("consistency:outline:v4"), false, "另一版是另一件事");
  assert.equal(
    zoomTrigger([{ kind: "outline.fields", version: 3 }], {
      layersPresent: LAYERS,
      hasRunKey: (k) => afterRefresh.hasOriginKey(k),
    }),
    null,
  );
});

test("判据 3：自动起跑的运行落成**待定的提案**，不是已接受的改动", () => {
  const registry = [];
  const rec = skillrun.startRun(registry, {
    skillId: "script-doctor",
    skillVersion: 2,
    origin: { kind: "conversation", conversationRunId: "conv-1" },
    createdAt: "2026-08-30T00:00:00Z",
  });
  // origin 是**起跑时**就写下的，所以一次失败的运行照样占住幂等位
  assert.deepEqual(rec.origin, { kind: "conversation", conversationRunId: "conv-1" });
  assert.equal(rec.proposal, null, "刚起跑时还没有提案");
  assert.equal(rec.decision, null);

  const landed = skillrun.proposeRun(registry, rec.runId, { findings: [] }, {
    model: "m",
    at: "2026-08-30T00:01:00Z",
  });
  assert.ok(landed, "答案落成提案");
  assert.equal(landed.status, "succeeded");
  assert.equal(skillrun.dispositionOf(landed), "pending", "**待定** —— 不是自动接受");
  assert.equal(skillrun.isPending(landed), true);
  assert.equal(skillrun.isAccepted(landed), false, "要不要用仍然由他决定");
  // origin 一路带着，所以「谁要求跑的」在提案上仍然查得到
  assert.deepEqual(landed.origin, { kind: "conversation", conversationRunId: "conv-1" });
});

test("判据 3：两个新诊断能力**结构上**写不回作品", () => {
  for (const id of ["story-zoom", "audience-engagement-reviewer"]) {
    const app = skillapply.applicability(id);
    assert.equal(app.can, false, `${id} 不该有写回路径`);
    assert.ok(app.reason.trim(), "而且要说清为什么 —— 「设计如此」与「还没做」是两件事");
  }
  // …对比一个真的能写回的，证明这条断言不是恒真
  assert.equal(skillapply.applicability("world-director").can, true);
});

test("判据 5：没有幂等键时 origin 不长出一个空字段", () => {
  // 普通的一轮对话没有「这件事」的身份，只有「这一轮」的身份。
  assert.deepEqual(originForRoute("conv-1"), {
    kind: "conversation",
    conversationRunId: "conv-1",
  });
  assert.deepEqual(originForRoute("conv-1", ""), {
    kind: "conversation",
    conversationRunId: "conv-1",
  });
});

test("判据 5：换一轮对话也拦得住 —— 那是 conversationRunId 拦不住的那一半", () => {
  // 他点两次「查一下」，或者一次失败的发送被重发，都会产生**新的** conversationRunId。
  // 只有这件事自己的身份能拦住第二次（codex 最后一轮的 P1 正是这条断了）。
  const registry = [];
  const key = zoomKeyFor({ doc: "outline", version: 3 });
  skillrun.startRun(registry, {
    skillId: "story-zoom",
    skillVersion: 1,
    origin: originForRoute("conv-A", key),
  });
  const ctl = makeSkillController(registry);
  assert.equal(ctl.routedRunFor("conv-B"), null, "换一轮：这道闸确实拦不住");
  assert.equal(ctl.hasOriginKey(key), true, "但这件事已经跑过了 —— 这道闸拦得住");
});

test("接线：建议带着 key，一路送到 origin，且起跑前先查一次", () => {
  // 源码断言是**故意**的：这条性质说的是「这几个值有没有被一路传下去」，
  // 中间任何一环丢掉它，行为上都表现为「幂等键从来没被写进去过」——
  // 而那正是上一版发生的事，当时所有测试都是绿的。
  const src = readFileSync(join(HERE, "..", "src", "ui", "production.js"), "utf8");
  assert.ok(src.includes("key: trigger.key"), "建议里要带上这件事的身份");
  assert.ok(
    src.includes("sendConversationTurn(ctx, goal, { originKey })"),
    "点击时要把它交给这一次发送",
  );
  assert.ok(
    src.includes("runRouteFor(ctx, res.runId, turn, text, originKey)"),
    "发送链要把它交给起跑那一步",
  );
  assert.ok(
    src.includes("originForRoute(convRunId, originKey)"),
    "起跑时要用唯一那个构造函数写进 origin",
  );
  assert.ok(
    src.includes("ctx.skills.hasOriginKey(originKey)"),
    "起跑前先问登记表：这件事是不是已经跑过了",
  );
});

test("接线：先查后做之间的那条缝被关掉了（in-flight 闸）", () => {
  // `hasOriginKey` / `routedRunFor` 查的是登记表，而那条记录要等 `ctx.skills.run`
  // 调到 `startRun` 才出现 —— 中间隔着一个微任务。今天从代码上够不着这条缝
  // （一次发送一条链、一个 conversationRunId；建议的 key 在点击时被同步取走），
  // 但它是**结构性的**：再加一条起跑路径缝就自己张开，症状是「同一件事跑了两遍」，
  // 两次都成功、两份提案、没有任何一处报错（codex 最后一轮）。
  const src = readFileSync(join(HERE, "..", "src", "ui", "production.js"), "utf8");
  assert.ok(src.includes("const routeInflight = new Set()"), "要有这道闸");
  assert.ok(src.includes("routeInflight.has(guard)"), "起跑前要问它");
  assert.ok(src.includes("routeInflight.add(guard)"), "起跑前要占住");
  assert.ok(src.includes("routeInflight.delete(guard)"), "起跑结束要放开");
  // **不能进 ui**：那是持久化的页面状态，持久化它会让刷新之后的合法重试被永远挡住
  assert.ok(!src.includes("ui.routeInflight"), "这是瞬时状态，不该被持久化");
});

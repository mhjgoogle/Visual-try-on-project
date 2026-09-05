// 动作注册表：Agent 的可操作面 = 创作者的可操作面（REQ-006）。
//
// 产品负责人 2026-08-29：「用户能够操作的前端的agent都应该可以操作。」
//
// 这份测试守的是注册表**本身**的性质，而不是某一条动作：词汇表就是这张表（不是另抄
// 一份）、白名单真的在挡未知键、以及**不可逆的动作不在表里**。最后一条最重要 ——
// 它是「不问就能落」的全部前提（AGENTS.md §1）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  actionCatalog, knownAction, sanitizeArgs, runAction, _ACTIONS,
} from "../src/workflow/convactions.js";
import * as bibledoc from "../src/workflow/bibledoc.js";
import * as canondoc from "../src/workflow/canondoc.js";
import * as swork from "../src/workflow/storywork.js";

test("词汇表就是注册表，不是另抄的一份", () => {
  const catalog = actionCatalog();
  assert.deepEqual(catalog.map((a) => a.id), _ACTIONS.map((a) => a.id));
  for (const row of catalog) {
    assert.ok(row.label, `${row.id} 没有中文名 —— 屏幕和提示词都要用它`);
    assert.ok(row.fields || row.args, `${row.id} 没说要什么参数`);
  }
});

test("每条动作都能被认出来；表外的一律不认", () => {
  for (const a of _ACTIONS) assert.equal(knownAction(a.id), true, a.id);
  assert.equal(knownAction("project.delete"), false);
  assert.equal(knownAction(""), false);
  assert.equal(knownAction(undefined), false);
});

test("每条动作都要写明撤销的那条路 —— 这才是「不问就能落」的判据", () => {
  // 判据不是「名字里有没有 delete」。第一版这条测试就是那么写的，于是把动作改名叫
  // `hide` 就能绕过去 —— 一个为了错误的理由而通过的测试（这仓库反复付过的代价）。
  for (const a of _ACTIONS) {
    assert.ok(
      typeof a.undo === "string" && a.undo.trim(),
      `${a.id} 没有写 undo：撤销它的动作 id，或它为什么天然可逆`,
    );
  }
});

test("不可逆与花钱的能力，这个模块根本碰不到", async () => {
  // 用源码断言是**故意**的：这条性质说的就是「这个模块允许调哪些 ctx 函数」。
  // 行为测试看不见「它没调什么」。
  const fs = await import("node:fs/promises");
  const url = new URL("../src/workflow/convactions.js", import.meta.url);
  const src = await fs.readFile(url, "utf8");
  const forbidden = [
    "confirmPlan",      // 绑定剧集身份，反悔不干净
    "startGeneration",  // 花钱
    "promptBatch",      // 花钱
    "removeProject",    // 动的是他的项目列表
    "unregisterProject",
    "saveCanvas",       // 绕过创作者那条写路径
  ];
  // 找的是**调用**（`name(`），不是提及：文件头正大光明地写着为什么 confirmPlan
  // 不在表里，那句话不该让这条测试转红。
  for (const name of forbidden) {
    assert.ok(!src.includes(`${name}(`), `${name}() 不该被动作表调用`);
  }
});

test("白名单挡住未知键，也挡住第二层以外的结构", () => {
  const out = sanitizeArgs("brief.fields", {
    fields: { genre: "悬疑", bogus: "x", targetEpisodes: 24 },
  });
  assert.deepEqual(out, { fields: { genre: "悬疑", targetEpisodes: 24 } });

  const outline = sanitizeArgs("outline.fields", {
    fields: { logline: "一句话", protagonist: { who: "林照", junk: 7 }, nope: "x" },
  });
  assert.deepEqual(outline.fields.protagonist, { who: "林照" });
  assert.equal(outline.fields.nope, undefined);
});

test("字段一个都写不了时返回 null —— 上层据此报「没收到能写的内容」", () => {
  assert.equal(sanitizeArgs("brief.fields", { fields: { bogus: "x" } }), null);
  assert.equal(sanitizeArgs("brief.fields", {}), null);
  assert.equal(sanitizeArgs("project.delete", { fields: {} }), null);
});

test("模型把 fields 摊平写在顶层时也能收下 —— 它经常这么干", () => {
  const out = sanitizeArgs("brief.fields", { genre: "悬疑" });
  assert.deepEqual(out, { fields: { genre: "悬疑" } });
});

test("args 型动作只取它声明过的键", () => {
  const out = sanitizeArgs("plan.entry", {
    episodeId: "ep-3", field: "title", value: "价码", secret: "不要",
  });
  assert.deepEqual(out, { episodeId: "ep-3", field: "title", value: "价码" });
});

test("值有界 —— 它要落进他的 canvas.json", () => {
  const out = sanitizeArgs("brief.fields", { fields: { notes: "长".repeat(5000) } });
  assert.equal(out.fields.notes.length, 2000);
});

test("runAction 落到创作者那条函数上，并说清做了什么", () => {
  const calls = [];
  const ctx = {
    story: {
      editBrief: (f) => calls.push(["editBrief", f]),
      applyManualOutline: (f) => { calls.push(["applyManualOutline", f]); return { v: 3 }; },
    },
  };
  const brief = runAction(ctx, "brief.fields", { fields: { genre: "悬疑" } });
  assert.deepEqual(calls[0], ["editBrief", { genre: "悬疑" }]);
  assert.equal(brief.versioned, "brief", "简报改的是草稿，要靠一次提交成版");
  assert.equal(brief.said, "类型/题材 → 悬疑");
  assert.equal(brief.label, "改创意简报");

  const outline = runAction(ctx, "outline.fields", { fields: { logline: "一句话" } });
  assert.equal(outline.versioned, undefined, "大纲自己就成一版");
  assert.match(outline.said, /故事大纲 v3/);
});

test("表外的动作抛错，而不是静默什么都不做", () => {
  assert.throws(() => runAction({}, "project.delete", {}), /没有「project.delete」这个动作/);
});

test("能写的内容为空时抛错 —— 不许落一个空版本", () => {
  assert.throws(
    () => runAction({ story: {} }, "brief.fields", { fields: { bogus: "x" } }),
    /没有收到能写的内容/,
  );
});

// ---- 宣称的栏位 vs 文档真能写的栏位 ---------------------------------------- //

test("动作宣称的每一栏，文档都真的写得下去", () => {
  // **这条测试是 2026-08-31 那次搬运买来的。** 他让 Agent 把故事核心里的人物和
  // 世界观搬进角色设计，回执写着「改好了」，角色设计上却什么都没多出来：
  //
  //   - `character.fields` 宣称能写 background / speech / note —— 三个
  //     `CHARACTER_PROFILE_FIELDS` 里根本没有的名字，`updateCharacterProfile`
  //     只认自己那张表，于是**静默丢掉**；
  //   - `relationship.fields` 宣称 `nature`，文档里叫 `basis`；
  //   - `world.fields` 宣称 `premise`，而前提属于故事大纲，不属于世界观。
  //
  // 三条动作全部「跑成功了、什么都没写」。34 条动作的 `args` 就是模型看到的词汇表
  // （服务端不另抄一份），所以**幻影字段等于教模型去写一个不存在的地方**。
  //
  // 判据是「文档函数认不认这个键」，不是「这个名字看着像不像」。
  const writable = {
    "character.fields": [...bibledoc.CHARACTER_PROFILE_FIELDS, "name"],
    // `a` / `b`（两个人名）与 `relationshipId`（界面手里的关系 id）都是**寻址**参数，
    // 由 apply 消费，不是文档栏 —— 与下面 `name` 同类（TASK-127）。
    "relationship.fields": [...canondoc.RELATIONSHIP_FIELDS, "a", "b", "relationshipId"],
    "world.fields": [...canondoc.WORLD_FIELDS],
    // `updateLocationProfile` 的表就写在它自己那个 for 循环里，没有导出常量 ——
    // 名单跟着它抄，改了那边这里就该跟着红。
    "location.fields": ["description", "visualInstruction", "name"],
  };
  for (const [id, allowed] of Object.entries(writable)) {
    const spec = _ACTIONS.find((a) => a.id === id);
    assert.ok(spec, `${id} 不见了`);
    for (const key of Object.keys(spec.fields || spec.args || {})) {
      assert.ok(
        allowed.includes(key),
        `${id} 宣称能写 ${key}，但文档里没有这一栏 —— 模型会照着写，然后什么都不会发生`,
      );
    }
  }
});

test("白名单剥掉了什么，回答里要说出来", () => {
  // 白名单本身是对的。错的是它一声不吭 —— 那正是上面三个幻影字段能瞒住人的原因。
  const ctx = fakeCtx();
  const out = runAction(ctx, "character.fields", {
    name: "林照", identity: "被抹除者", background: "两次被抹除",
  });
  assert.match(out.said, /background/, "剥掉的栏没有说出来");
  assert.equal(ctx.prod.characters[0].profile.identity, "被抹除者");
});

// ---- 没有就新建 ------------------------------------------------------------ //

/** 一个真的会写字的 ctx —— 底下就是 `bibledoc` / `canondoc` 本人。
 *  假的写路径会让这条测试为了错误的理由通过。 */
function fakeCtx() {
  const prod = { characters: [], relationships: [], locations: [], world: {}, canon: {} };
  for (const k of canondoc.WORLD_FIELDS) prod.world[k] = "";
  return {
    prod,
    prodData: () => ({ production: prod }),
    bible: {
      addCharacter: (name, tier) => bibledoc.addCharacter(prod, name, tier),
      updateCharacterProfile: (id, f) => bibledoc.updateCharacterProfile(prod, id, f),
      addLocation: (name) => bibledoc.addLocation(prod, name),
      updateLocationProfile: (id, f) => bibledoc.updateLocationProfile(prod, id, f),
      addCharacterState: (id, name) => bibledoc.addCharacterState(prod, id, name),
      setCharacterStateOverrides: (id, sid, ov) =>
        bibledoc.setCharacterStateOverrides(prod, id, sid, ov),
      addLocationState: (id, name) => bibledoc.addLocationState(prod, id, name),
      setLocationStateOverrides: (id, sid, ov) =>
        bibledoc.setLocationStateOverrides(prod, id, sid, ov),
    },
    canon: {
      addRelationship: (a, b) => canondoc.addRelationship(prod, a, b),
      updateRelationship: (id, f) => canondoc.updateRelationship(prod, id, f),
      updateWorld: (f) => canondoc.updateWorld(prod, f),
    },
  };
}

test("人物不在角色设计里就新建 —— 而不是报「人物里没有他」", () => {
  // 2026-08-31：他让 Agent 把三个人物搬进角色设计，三条全落空，报的都是
  // 「人物里没有「林照」」。不是他写错了 —— 是这张表**只会改、不会加**，
  // 而角色设计本来就是空的，所以每一条都必然失败。
  const ctx = fakeCtx();
  const out = runAction(ctx, "character.fields", {
    name: "林照", identity: "被世界抹除的人", arc: "从求生到破局",
  });
  assert.equal(ctx.prod.characters.length, 1);
  assert.equal(ctx.prod.characters[0].name, "林照");
  assert.equal(ctx.prod.characters[0].profile.identity, "被世界抹除的人");
  assert.equal(ctx.prod.characters[0].profile.arc, "从求生到破局");
  // 新建是可逆的，所以不必问他 —— 但**必须说是新建的**，否则他不知道自己多了一个人物
  assert.match(out.said, /新建/, "新建了人物却没说");
});

test("同一个人物第二次写，是改不是再建一个", () => {
  const ctx = fakeCtx();
  runAction(ctx, "character.fields", { name: "林照", identity: "旧" });
  const out = runAction(ctx, "character.fields", { name: "林照", identity: "新" });
  assert.equal(ctx.prod.characters.length, 1, "同名人物被建了第二遍");
  assert.equal(ctx.prod.characters[0].profile.identity, "新");
  assert.doesNotMatch(out.said, /新建/);
});

test("关系按 characterIds 找 —— 找不到就连人带关系一起建", () => {
  // 上一版按 r.aId / r.bId / r.aName / r.bName 去找，而文档里存的是 `characterIds`：
  // 那四个字段**根本不存在**，所以就算关系已经建好，也照样报「没有这段关系」。
  const ctx = fakeCtx();
  const out = runAction(ctx, "relationship.fields", {
    a: "林照", b: "许渡", basis: "单向信息差的组队", aToB: "唯一的线索",
  });
  assert.equal(ctx.prod.characters.length, 2, "关系的两头没有落成人物");
  assert.equal(ctx.prod.relationships.length, 1);
  const rel = ctx.prod.relationships[0];
  assert.equal(rel.profile.basis, "单向信息差的组队");
  assert.equal(rel.profile.aToB, "唯一的线索");
  assert.match(out.said, /新建/);

  // 第二次写同一段：改，不再建
  runAction(ctx, "relationship.fields", { a: "许渡", b: "林照", tension: "越走越紧" });
  assert.equal(ctx.prod.relationships.length, 1, "同一段关系被建了第二遍");
  assert.equal(ctx.prod.relationships[0].profile.tension, "越走越紧");
  assert.equal(ctx.prod.characters.length, 2, "反过来写又多建了人物");
});

test("一段关系要两个不同的人", () => {
  const ctx = fakeCtx();
  assert.throws(() => runAction(ctx, "relationship.fields", { a: "林照", b: "林照", basis: "x" }));
  assert.equal(ctx.prod.characters.length, 0, "失败的动作不该留下半个人物");
});

test("场景地也能加 —— 场景设计这一页之前根本没有动作", () => {
  // 人物和世界观都能改、场景地不能，是登记漏了，不是设计如此。他把结构规划切成
  // 「表格 → 角色设计 → 场景设计」时说过：这些都是之后小说和剧集制作的基础财产。
  const ctx = fakeCtx();
  const out = runAction(ctx, "location.fields", {
    name: "轮居之城", description: "事物在存在与不存在之间摇摆，因而没有永久房产",
  });
  assert.equal(ctx.prod.locations.length, 1);
  assert.equal(ctx.prod.locations[0].name, "轮居之城");
  assert.match(ctx.prod.locations[0].profile.description, /摇摆/);
  assert.match(out.said, /新建/);

  runAction(ctx, "location.fields", { name: "轮居之城", visualInstruction: "冷灰、半透明" });
  assert.equal(ctx.prod.locations.length, 1, "同名场景地被建了第二遍");
  assert.equal(ctx.prod.locations[0].profile.visualInstruction, "冷灰、半透明");
});

/* --- 2026-09-05 补审第二轮：长文不许被静默砍掉 ------------------------------ */

test("故事核心 / 大纲 / 正文的长文不被白名单砍掉", () => {
  // 4000 字那道护栏是给**模型输出**定的，本来没问题。出事的是 ADR-0096 之后
  // **界面按钮也走这张表**：正文编辑器每敲一个字就调 `unit.write`
  // （production.js:1976），于是他自己写的正文一过 4000 字就被静默切掉、当场落库，
  // 而他看到的是「现在有 4000 字」，不是一句报错。
  //
  // 「Agent 能做的 = 他能做的」这条路打通之后，**给模型定的护栏就成了给他定的护栏**。
  const big = "字".repeat(9000);
  assert.equal(sanitizeArgs("unit.write", { no: 1, text: big }).text.length, 9000);
  assert.equal(sanitizeArgs("work.core", { text: big }).text.length, 9000);
  assert.equal(sanitizeArgs("work.outline", { text: big }).text.length, 9000);
  // 追加也走同一条路
  assert.equal(sanitizeArgs("unit.write", { no: 1, append: big }).append.length, 9000);
});

test("没声明长文上限的动作，仍然只收 4000 字", () => {
  // 护栏没有被拆掉，只是长文动作自己说出了上限。
  const big = "x".repeat(9000);
  const out = sanitizeArgs("character.fields", { name: "林照", identity: big });
  assert.equal(out.identity.length, 4000);
});

test("失败的动作不留下半个人物", () => {
  // 这个文件的约定是「抛错 = 没落下」。上一版先建人物、再检查改不改得动，
  // 于是一次失败会留下一个空人物（补审 2026-09-05 第二轮）。
  const prod = { characters: [], relationships: [], locations: [], world: {} };
  const ctx = { prodData: () => ({ production: prod }), bible: {}, canon: {} };
  assert.throws(() => runAction(ctx, "character.fields", { name: "林照", identity: "x" }));
  assert.equal(prod.characters.length, 0, "抛了错却留下一个空人物");
});

test("塞进未知的对象键，也要说出来", () => {
  // 上一版只统计字符串值的未知键 → 模型把内容塞进未知的对象/数组键时，
  // 既没写进去，也不出现在「没有这些栏」的提示里。
  const ctx = fakeCtx();
  const out = runAction(ctx, "character.fields", {
    name: "林照", identity: "被抹除者", backstory: { 起因: "两次被抹除" },
  });
  assert.match(out.said, /backstory/, "对象值的未知键被悄悄丢了");
});

test("长文超上限是报错，不是砍掉一截", () => {
  // 只把上限从 4000 抬到 20 万，是把「静默丢字」挪远一格，不是修掉它：
  // 200001 字进来，仍然会悄悄留下前 200000 字（codex 补审第九轮）。
  // 现在超了就拒，并说清超了多少 —— fail-closed 并说明白。
  const big = "字".repeat(200001);
  assert.throws(
    () => runAction(fakeCtx(), "unit.write", { no: 1, text: big }),
    /超过 200000 字上限.*200001 字/s,
    "超上限没有报错",
  );
  // 白名单不再在这一层砍：砍与不砍的判断只有一处
  assert.equal(sanitizeArgs("unit.write", { no: 1, text: big }).text.length, 200001);
  // 没声明长文上限的字段仍然受 4000 护栏（那道护栏管的是模型输出）
  assert.equal(sanitizeArgs("character.fields", { name: "x", identity: big }).identity.length, 4000);
});

test("往写满的正文后面追加：拒绝，而不是悄悄切掉追加的内容", () => {
  // 参数长度检查过得去（只追加一个字），出事的是**拼接之后**：
  // 上一版由 editUnit 悄悄切回 20 万，而回执照样报「现在有 200000 字」
  //（codex 补审第十轮）。检查的必须是落地之后的长度。
  const ctx = fakeCtx();
  const doc = { work: swork.createWork(null) };
  swork.setForm(doc.work, "novel");
  const u = swork.ensureUnit(doc.work, "novel", 1, "T0");
  swork.editUnit(doc.work, u.id, "body", "字".repeat(swork.UNIT_MAX), "T1");
  ctx.story = { doc: () => doc };
  assert.throws(
    () => runAction(ctx, "unit.write", { no: 1, append: "追" }),
    /追加后会有 \d+ 字.*一个字都没有写进去/s,
  );
  assert.equal(doc.work.units[0].body.length, swork.UNIT_MAX, "被拒的那次动了正文");
});

// ---- 状态级参考图：四个入口（TASK-129 切片 2e） ----------------------------- //
//
// 这四条以前只有界面走得到 —— 算法住在 `ui/workspaces.js`。搬进 workflow 层之后
// Agent 也能走了，所以这里测的是**动作**，不是界面：同一份决策，两条路进来。

/** 一个带状态、且状态上还没有自己参考图列表的人物。 */
function withState(ctx, primary = "asset-base") {
  const c = bibledoc.addCharacter(ctx.prod, "林照", "main");
  c.activeReferenceAssetId = primary;
  c.referenceAssetIds = [primary];
  const st = bibledoc.addCharacterState(ctx.prod, c.characterId, "受伤");
  return { c, st };
}

test("状态挂参考图：第一张成主图，之后的不顶掉它", () => {
  const ctx = fakeCtx();
  const { c, st } = withState(ctx);
  runAction(ctx, "character.state.reference.add", {
    name: "林照", state: "受伤", assetId: "asset-x",
  });
  let ov = ctx.prod.characters[0].states[0].overrides;
  // 第一张：继承来的主图不在这份新清单里 → 它自己当主图
  assert.deepEqual(ov.referenceAssetIds, ["asset-x"]);
  assert.equal(ov.activeReferenceAssetId, "asset-x");
  runAction(ctx, "character.state.reference.add", {
    name: "林照", state: "受伤", assetId: "asset-y",
  });
  ov = ctx.prod.characters[0].states[0].overrides;
  assert.deepEqual(ov.referenceAssetIds, ["asset-x", "asset-y"]);
  assert.equal(ov.activeReferenceAssetId, "asset-x", "加次要图把主图顶掉了");
  // 寻址两条路都要通：名字走过了，id 也要走得通
  assert.equal(st.stateId, ctx.prod.characters[0].states[0].stateId);
  runAction(ctx, "character.state.reference.add", {
    name: c.characterId, state: st.stateId, assetId: "asset-z",
  });
  assert.equal(ctx.prod.characters[0].states[0].overrides.referenceAssetIds.length, 3);
});

test("状态挂参考图：重复挂、缺参数、认不出的状态，都要报出来", () => {
  const ctx = fakeCtx();
  withState(ctx);
  const add = (a) => runAction(ctx, "character.state.reference.add", a);
  add({ name: "林照", state: "受伤", assetId: "asset-x" });
  assert.throws(() => add({ name: "林照", state: "受伤", assetId: "asset-x" }), /已经有/);
  assert.throws(() => add({ name: "林照", state: "受伤", assetId: "  " }), /没说挂哪张/);
  assert.throws(() => add({ name: "林照", state: "不存在", assetId: "a" }), /没有状态/);
  assert.throws(() => add({ name: "查无此人", state: "受伤", assetId: "a" }), /没有「查无此人」/);
});

test("摘掉主图时主图位让给下一张；摘光了就没有主图", () => {
  const ctx = fakeCtx();
  withState(ctx);
  for (const id of ["a", "b"]) {
    runAction(ctx, "character.state.reference.add", { name: "林照", state: "受伤", assetId: id });
  }
  const ov = () => ctx.prod.characters[0].states[0].overrides;
  assert.equal(ov().activeReferenceAssetId, "a");
  runAction(ctx, "character.state.reference.remove", { name: "林照", state: "受伤", assetId: "a" });
  assert.deepEqual(ov().referenceAssetIds, ["b"]);
  assert.equal(ov().activeReferenceAssetId, "b", "主图被摘掉后指针没让位");
  runAction(ctx, "character.state.reference.remove", { name: "林照", state: "受伤", assetId: "b" });
  assert.deepEqual(ov().referenceAssetIds, []);
  assert.equal(ov().activeReferenceAssetId, null);
  assert.throws(
    () => runAction(ctx, "character.state.reference.remove", {
      name: "林照", state: "受伤", assetId: "b",
    }),
    /没有这张图/,
  );
});

test("换主图只能在这个状态自己挂着的那几张里选", () => {
  const ctx = fakeCtx();
  withState(ctx);
  for (const id of ["a", "b"]) {
    runAction(ctx, "character.state.reference.add", { name: "林照", state: "受伤", assetId: id });
  }
  runAction(ctx, "character.state.reference.setActive", {
    name: "林照", state: "受伤", assetId: "b",
  });
  assert.equal(ctx.prod.characters[0].states[0].overrides.activeReferenceAssetId, "b");
  // 指向一张它没挂的图 = 一个指不到东西的主图指针
  assert.throws(
    () => runAction(ctx, "character.state.reference.setActive", {
      name: "林照", state: "受伤", assetId: "asset-base",
    }),
    /没有挂这张图/,
  );
});

test("改回继承：两个键一起撤，不留下指着不存在清单的主图", () => {
  const ctx = fakeCtx();
  withState(ctx);
  runAction(ctx, "character.state.reference.add", { name: "林照", state: "受伤", assetId: "a" });
  const st = () => ctx.prod.characters[0].states[0];
  assert.ok("activeReferenceAssetId" in st().overrides);
  runAction(ctx, "character.state.reference.reset", { name: "林照", state: "受伤" });
  assert.equal("referenceAssetIds" in st().overrides, false);
  assert.equal("activeReferenceAssetId" in st().overrides, false, "清单撤了，主图指针还留着");
  assert.throws(
    () => runAction(ctx, "character.state.reference.reset", { name: "林照", state: "受伤" }),
    /本来就在继承/,
  );
});

test("场景地走的是同一份实现 —— 两边不该有第二套语义", () => {
  const ctx = fakeCtx();
  const l = bibledoc.addLocation(ctx.prod, "太极殿");
  bibledoc.addLocationState(ctx.prod, l.locationId, "夜");
  runAction(ctx, "location.state.reference.add", { name: "太极殿", state: "夜", assetId: "a" });
  runAction(ctx, "location.state.reference.add", { name: "太极殿", state: "夜", assetId: "b" });
  const ov = ctx.prod.locations[0].states[0].overrides;
  assert.deepEqual(ov.referenceAssetIds, ["a", "b"]);
  assert.equal(ov.activeReferenceAssetId, "a");
});

test("摘掉的是**继承来的**主图时，主图位也要让出去", () => {
  // codex 2026-09-05 审出来的：上一版只比对 overrides 里**显式**写的那张主图。
  // 于是「基础主图 a、状态覆盖清单 ["a","b"]、摘掉 a」之后，指针还继承着 a，
  // 而 a 已经不在清单里了 —— 一个指向非成员的主图。
  //
  // 判据是「**生效的**那张还在不在清单里」，显式那张只是它的一个特例。
  const ctx = fakeCtx();
  const { c, st } = withState(ctx, "asset-base");
  // 造一份「含继承主图、但自己没写 activeReferenceAssetId」的覆盖
  ctx.bible.setCharacterStateOverrides(c.characterId, st.stateId, {
    referenceAssetIds: ["asset-base", "b"],
  });
  const ov = () => ctx.prod.characters[0].states[0].overrides;
  assert.equal("activeReferenceAssetId" in ov(), false, "前置条件：这个状态还在继承主图");
  runAction(ctx, "character.state.reference.remove", {
    name: "林照", state: "受伤", assetId: "asset-base",
  });
  assert.deepEqual(ov().referenceAssetIds, ["b"]);
  assert.equal(ov().activeReferenceAssetId, "b", "继承来的主图被摘掉后指针没让位");
});

test("摘图不动那张还在清单里的继承主图", () => {
  // 反方向：生效的主图没被摘，就不该凭空写出一个显式指针来 ——
  // 那会把「继承」悄悄变成「覆盖」，之后改基础主图这个状态就不跟了。
  const ctx = fakeCtx();
  const { c, st } = withState(ctx, "asset-base");
  ctx.bible.setCharacterStateOverrides(c.characterId, st.stateId, {
    referenceAssetIds: ["asset-base", "b"],
  });
  runAction(ctx, "character.state.reference.remove", {
    name: "林照", state: "受伤", assetId: "b",
  });
  const ov = ctx.prod.characters[0].states[0].overrides;
  assert.deepEqual(ov.referenceAssetIds, ["asset-base"]);
  assert.equal("activeReferenceAssetId" in ov, false, "继承被悄悄改成了覆盖");
});

test("他显式选了「不要主图」，摘掉一张次要图不该替他改主意", () => {
  // codex 审查轮 2。摘图**从不凭空造出主图** —— 它只在「本来有一张、现在它没了」
  // 时补位。与加图那侧刻意不同：加图时清单在变长，让新的一张顶上顺理成章；
  // 摘图时什么都没多出来，把 `null` 改成某一张就是替他做主。
  const ctx = fakeCtx();
  const { c, st } = withState(ctx, "asset-base");
  ctx.bible.setCharacterStateOverrides(c.characterId, st.stateId, {
    referenceAssetIds: ["a", "b"],
    activeReferenceAssetId: null,
  });
  runAction(ctx, "character.state.reference.remove", {
    name: "林照", state: "受伤", assetId: "b",
  });
  const ov = ctx.prod.characters[0].states[0].overrides;
  assert.deepEqual(ov.referenceAssetIds, ["a"]);
  assert.equal(ov.activeReferenceAssetId, null, "「不要主图」被摘图动作改掉了");
});

test("基础档案本来就没有主图时，摘图也不该造一个出来", () => {
  // 同一条规矩的继承版：继承来的主图是 `null`，摘掉一张次要图之后仍然是没有主图。
  const ctx = fakeCtx();
  const c = bibledoc.addCharacter(ctx.prod, "无照", "main");
  c.activeReferenceAssetId = null;
  c.referenceAssetIds = [];
  const st = bibledoc.addCharacterState(ctx.prod, c.characterId, "夜");
  ctx.bible.setCharacterStateOverrides(c.characterId, st.stateId, {
    referenceAssetIds: ["a", "b"],
  });
  runAction(ctx, "character.state.reference.remove", {
    name: "无照", state: "夜", assetId: "b",
  });
  const ov = ctx.prod.characters[0].states[0].overrides;
  assert.deepEqual(ov.referenceAssetIds, ["a"]);
  assert.equal("activeReferenceAssetId" in ov, false, "继承状态被摘图变成了覆盖");
});

test("加图那侧相反：他选了「不要主图」时，第一张加进来的就是主图", () => {
  // 两侧的**反应**不同是有意的，各自钉一条，免得日后有人「统一」掉。
  const ctx = fakeCtx();
  const { c, st } = withState(ctx, "asset-base");
  ctx.bible.setCharacterStateOverrides(c.characterId, st.stateId, {
    referenceAssetIds: [],
    activeReferenceAssetId: null,
  });
  runAction(ctx, "character.state.reference.add", {
    name: "林照", state: "受伤", assetId: "x",
  });
  const ov = ctx.prod.characters[0].states[0].overrides;
  assert.equal(ov.activeReferenceAssetId, "x");
});

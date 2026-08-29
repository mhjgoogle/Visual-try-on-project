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

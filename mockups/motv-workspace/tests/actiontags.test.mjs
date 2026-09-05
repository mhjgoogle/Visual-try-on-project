// 动作表的三个能力标签，以及它们在 `runAction` 里怎么被判（TASK-127 / ADR-0096 决策 2）。
//
//   reversible       不可逆、又不付费、又不绑身份的动作**没有资格进表**（登记时抛）
//   paid             谁调都拒 —— 花钱是唯一必须问创作者的事，不由这张表替他决定
//   identityBinding  只有他自己在界面上点（origin "ui"）才行；Agent 反悔不干净
//
// 另外守两条这一轮为「UI 也走动作表」补的动作语义：
//   unit.ensure        「打开第 N 章/集」—— 幂等，已有的一个字不动
//   plan.row.link      `remove: true` 只删不加（界面上「×」的语义）
import test from "node:test";
import assert from "node:assert/strict";

import {
  actionCatalog, actionTags, knownAction, runAction, _ACTIONS,
} from "../src/workflow/convactions.js";
import * as swork from "../src/workflow/storywork.js";

/** 一个只有故事开发数据模型的最小 ctx —— `runAction` 的 work.* 动作只碰它。 */
function ctxWithWork() {
  const work = swork.createWork(null);
  const toasts = [];
  return {
    work,
    toasts,
    story: { doc: () => ({ work }) },
    toast: (m) => toasts.push(m),
  };
}

test("每条动作都带三个布尔标签，目录里也带着 —— 模型与守卫读的是同一份", () => {
  for (const a of _ACTIONS) {
    assert.equal(typeof a.reversible, "boolean", `${a.id}.reversible`);
    assert.equal(typeof a.paid, "boolean", `${a.id}.paid`);
    assert.equal(typeof a.identityBinding, "boolean", `${a.id}.identityBinding`);
  }
  for (const c of actionCatalog()) {
    assert.deepEqual(
      { reversible: c.reversible, paid: c.paid, identityBinding: c.identityBinding },
      actionTags(c.id),
    );
  }
  assert.equal(actionTags("no.such.action"), null);
});

test("今天表里没有付费动作，也没有绑身份的动作 —— 有一条就要有一条 ADR", () => {
  assert.deepEqual(_ACTIONS.filter((a) => a.paid).map((a) => a.id), []);
  assert.deepEqual(_ACTIONS.filter((a) => a.identityBinding).map((a) => a.id), []);
  assert.deepEqual(_ACTIONS.filter((a) => !a.reversible).map((a) => a.id), []);
});

test("paid 的动作谁调都拒 —— 包括界面自己", () => {
  // 往表里临时塞一条付费动作，验 runAction 的判定；测完立刻拿掉，不污染别的测试。
  const spec = {
    id: "test.paid", label: "花钱的事", doc: "work", undo: "—", args: {},
    reversible: true, paid: true, identityBinding: false, apply: () => ({ said: "不该跑到这" }),
  };
  _ACTIONS.push(spec);
  try {
    // ACTION_BY_ID 是加载时建的表：这条不在里面，所以先证「表外的 id 被拒」……
    assert.throws(() => runAction(ctxWithWork(), "test.paid", {}, { origin: "ui" }), /没有「test.paid」/);
  } finally {
    _ACTIONS.pop();
  }
  // ……真正的付费判定在 `runAction` 里对 `spec.paid` 判：用一条真实动作把标签临时翻成付费
  const real = _ACTIONS.find((a) => a.id === "work.core");
  const saved = real.paid;
  real.paid = true;
  try {
    assert.throws(() => runAction(ctxWithWork(), "work.core", { text: "x" }, { origin: "ui" }), /要花钱/);
    assert.throws(() => runAction(ctxWithWork(), "work.core", { text: "x" }, { origin: "agent" }), /要花钱/);
    assert.throws(() => runAction(ctxWithWork(), "work.core", { text: "x" }), /要花钱/);
  } finally {
    real.paid = saved;
  }
});

test("identityBinding 的动作只认 origin: ui；没写 origin 视为 agent", () => {
  const real = _ACTIONS.find((a) => a.id === "work.form");
  const saved = real.identityBinding;
  real.identityBinding = true;
  try {
    const ctx = ctxWithWork();
    const before = ctx.work.form;
    assert.notEqual(before, "novel");
    assert.throws(() => runAction(ctx, "work.form", { form: "novel" }), /只能由你自己在界面上点/);
    assert.throws(() => runAction(ctx, "work.form", { form: "novel" }, { origin: "agent" }), /只能由你自己/);
    assert.equal(ctx.work.form, before, "被拒的动作一个字都没写");
    const out = runAction(ctx, "work.form", { form: "novel" }, { origin: "ui" });
    assert.match(out.said, /小说/);
    assert.equal(ctx.work.form, "novel");
  } finally {
    real.identityBinding = saved;
  }
});

test("unit.ensure：打开第 N 章/集，没有就建、有的一个字不动", () => {
  const ctx = ctxWithWork();
  assert.ok(knownAction("unit.ensure"));
  assert.throws(() => runAction(ctx, "unit.ensure", { no: 1 }, { origin: "ui" }), /还没选/);
  swork.setForm(ctx.work, "episode");
  // 空 args 经 sanitize 变成 {} → no 是 NaN → 说「不是有效编号」，而不是建出一个 NaN 集
  assert.throws(() => runAction(ctx, "unit.ensure", {}, { origin: "ui" }), /有效的编号/);
  assert.equal(ctx.work.units.length, 0);
  const a = runAction(ctx, "unit.ensure", { no: 3 }, { origin: "ui" });
  assert.match(a.said, /第 3 集/);
  const unit = ctx.work.units.find((u) => u.no === 3 && u.kind === "episode");
  assert.ok(unit);
  runAction(ctx, "unit.write", { no: 3, text: "雨夜" }, { origin: "ui" });
  runAction(ctx, "unit.ensure", { no: 3 }, { origin: "ui" });
  assert.equal(unit.body, "雨夜", "再 ensure 一次不能清空已写的正文");
  assert.equal(ctx.work.units.filter((u) => u.no === 3).length, 1, "不能建出第二个第 3 集");
});

/* --- uiAct 不替动作预判「有没有数据」（codex 轮 2 P1）--------------------------- */
//
// production.js 的本地 uiAct 原来开头有一句「没有 story.work 就 return null」——那是给故事
// 四页写的。⚙ 成片规格（settings.delivery）也走这条路之后，一个还没写过故事的项目改成片
// 规格会被它**静默吞掉**：不写、不说。数据在不在该由动作自己的 apply 判并说出来。

import { uiAct } from "../src/ui/uiact.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 一个**没有故事数据**的项目：只有成片规格能改。 */
function ctxWithoutStoryWork() {
  const calls = [];
  return {
    calls,
    story: { doc: () => ({}) }, // 没有 .work
    setDeliverySpecField: (field, value) => { calls.push(["spec", field, value]); return { ok: true }; },
    persist: () => calls.push(["persist"]),
    toast: (m) => calls.push(["toast", m]),
  };
}

test("没有故事数据的项目，改成片规格照样落 —— 不被「没有 work」那句预判吞掉", () => {
  const ctx = ctxWithoutStoryWork();
  let rendered = 0;
  const out = uiAct(ctx, "settings.delivery", { field: "fps", value: "24" }, { rerender: () => { rendered += 1; } });
  assert.ok(out, "动作应当落下");
  assert.deepEqual(ctx.calls.filter((c) => c[0] === "spec"), [["spec", "fps", "24"]]);
  assert.ok(ctx.calls.some((c) => c[0] === "persist"), "落了就要 persist");
  assert.equal(rendered, 1);
  assert.equal(ctx.calls.some((c) => c[0] === "toast"), false, "成功不该有 toast 噪音");
});

test("同一个项目改故事核心 → 由**动作自己**说「还没有故事开发的数据模型」，不静默", () => {
  const ctx = ctxWithoutStoryWork();
  const out = uiAct(ctx, "work.core", { text: "x" }, { rerender: () => {} });
  assert.equal(out, null);
  const toasts = ctx.calls.filter((c) => c[0] === "toast").map((c) => c[1]);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /还没有故事开发的数据模型/);
  assert.equal(ctx.calls.some((c) => c[0] === "persist"), false, "被拒的动作不 persist");
});

test("production.js 的本地 uiAct 不再预判 story.work（源码守卫）", () => {
  // 源码断言是**故意**的：这条性质说的是「那句 return null 不在了」，行为测试从
  // uiact.js 这一层看不见 production.js 里那个闭包。
  const src = readFileSync(join(HERE, "..", "src", "ui", "production.js"), "utf8");
  const at = src.indexOf("function uiAct(id, args");
  assert.ok(at > 0, "本地 uiAct 不见了");
  const body = src.slice(at, src.indexOf("\n  }", at));
  // 看的是**代码形状**（`.doc().work` 那句判断），不是注释里提到的词
  assert.doesNotMatch(body, /\.doc\(\)\s*\.work\b/, "本地 uiAct 不许再按 story.work 预判 —— ⚙ 成片规格也走它");
  assert.ok(body.includes("sharedUiAct("), "它只是共享实现的适配器");
});

test("plan.row.link：不带 remove 是切换；remove: true 只删不加", () => {
  const ctx = ctxWithWork();
  swork.setOutline(ctx.work, "第一段\n\n第二段");
  const nodeId = ctx.work.outline.nodes[0].id;
  const row = swork.addPlanRow(ctx.work, "2026-09-05T00:00:00Z");
  runAction(ctx, "plan.row.link", { rowId: row.id, nodeId }, { origin: "ui" });
  assert.deepEqual(row.outlineRefs, [nodeId], "第一次：加上");
  runAction(ctx, "plan.row.link", { rowId: row.id, nodeId, remove: true }, { origin: "ui" });
  assert.deepEqual(row.outlineRefs, [], "remove: 删掉");
  runAction(ctx, "plan.row.link", { rowId: row.id, nodeId, remove: true }, { origin: "ui" });
  assert.deepEqual(row.outlineRefs, [], "remove 对不存在的引用是空操作，**不会**反过来加上");
});

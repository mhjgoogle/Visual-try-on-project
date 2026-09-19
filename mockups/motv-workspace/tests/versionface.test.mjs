// 版本列表里的「认得出」—— 产品负责人 2026-09-19：「我这里写好的东西怎么没了」。
//
// 查下来**一个字都没丢**：故事核心 9 版全在，其中 6 版在回收区（他 00:28:27–00:28:33
// 六秒内连点删掉的）。丢的是认出「哪版是哪版」的能力 —— 那时一行只有 `v6` 和一串
// `2026-08-30T12:52:11.995Z`，回收区更只有光秃秃的 `v1 v2 v3`。
//
// **在那种列表里，删掉和找不到是同一种体验。** 这份测试盯的就是那两个把版本变得
// 认得出的纯函数：摘要取得对不对、时间说不说人话。

import test from "node:test";
import assert from "node:assert/strict";

import { versionGist, versionWhen } from "../src/ui/corews.js";

// --- 摘要：这一版写的是什么 -------------------------------------------------- //

test("取开头一句，句号不带进来", () => {
  assert.equal(
    versionGist("被世界抹除的人，并没有消失。他们只是被排除。"),
    "被世界抹除的人，并没有消失",
  );
});

test("段落稿取第一行，不是把整篇压扁", () => {
  const body = "一、 项目基础与定位\n\n    作品名：《照见未明》\n    笔名：折光";
  assert.equal(versionGist(body), "一、 项目基础与定位");
});

test("长句截断并带省略号 —— 它要占一行，不能把按钮挤出屏幕", () => {
  const got = versionGist("这是一个很长很长的开头没有任何标点一直写下去直到超过上限为止还在写");
  assert.equal(got.length, 25, "24 字 + 省略号");
  assert.ok(got.endsWith("…"));
});

test("不足上限的不加省略号", () => {
  const got = versionGist("短句");
  assert.equal(got, "短句");
  assert.ok(!got.includes("…"));
});

test("空的那一版说它空 —— 那正是他需要知道的事", () => {
  // 返回空串会让这一行看起来像渲染坏了，而「这一版是空的」本身是信息。
  for (const empty of ["", "   ", "\n\n", null, undefined]) {
    assert.equal(versionGist(empty), "（空）", `${JSON.stringify(empty)} 没被认成空`);
  }
});

test("整篇没有句读时，退回整段而不是返回空", () => {
  // `split` 在没有分隔符时给出整串；一旦这里写成「取不到就空」，
  // 一篇没标点的稿子在列表里就彻底认不出来了。
  assert.equal(versionGist("没有任何标点的一段话"), "没有任何标点的一段话");
});

test("首行是空行时不会得到一个空摘要", () => {
  assert.equal(versionGist("\n\n真正的开头在第三行"), "真正的开头在第三行");
});

// --- 时间：多久以前 ---------------------------------------------------------- //

const NOW = new Date(2026, 8, 19, 9, 30); // 2026-09-19 09:30 本地时间

test("同一天说今天", () => {
  assert.equal(versionWhen(new Date(2026, 8, 19, 0, 24), NOW), "今天 00:24");
});

test("前一天说昨天", () => {
  assert.equal(versionWhen(new Date(2026, 8, 18, 10, 38), NOW), "昨天 10:38");
});

test("更早给月日 —— 他找的是「8-30 写的那版」", () => {
  assert.equal(versionWhen(new Date(2026, 7, 30, 12, 52), NOW), "8-30 12:52");
});

test("跨天按日历算，不按 24 小时算", () => {
  // 23:50 与次日 00:10 相差 20 分钟，但那是「昨天」——
  // 用小时差会把它说成「今天」，他昨晚写的稿子就对不上号了。
  assert.equal(versionWhen(new Date(2026, 8, 18, 23, 50), new Date(2026, 8, 19, 0, 10)), "昨天 23:50");
});

test("认不出来的时间原样给出，不显示 Invalid Date", () => {
  for (const bad of ["", null, undefined, "不是时间"]) {
    const got = versionWhen(bad, NOW);
    assert.ok(!got.includes("Invalid"), `${JSON.stringify(bad)} 渲染成了 ${got}`);
  }
});

test("ISO 串照样认得", () => {
  const got = versionWhen("2026-09-19T00:24:20.364Z", NOW);
  assert.match(got, /^(今天|昨天|9-\d\d) \d\d:\d\d$/, `拿到的是 ${got}`);
});

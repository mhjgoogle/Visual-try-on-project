// 版本行：默认只露最新版，旧版收起来。
//
// 产品负责人 2026-08-29：「我希望只有最新版可以看到。旧版就不看了」。
// 「不看」≠「不存在」—— 旧版本一律保留，这里只管默认露不露。

import test from "node:test";
import assert from "node:assert/strict";

import { versionRow } from "../src/ui/versionrow.js";

const vs = (n, activeV) => Array.from({ length: n }, (_, i) => ({
  v: i + 1,
  isActive: i + 1 === activeV,
}));

test("六版里默认只画最新那一颗", () => {
  const html = versionRow(vs(6, 6), { attr: "cbV", toggleAttr: "cbHist" });
  assert.match(html, /data-cb-v="6"/);
  for (const v of [1, 2, 3, 4, 5]) {
    assert.doesNotMatch(html, new RegExp(`data-cb-v="${v}"`), `v${v} 不该默认露出来`);
  }
  assert.match(html, /历史版本 5/);
});

test("当前依据的那一版不是最新版时，它也留在台面上", () => {
  // 他手动切回过 v3：藏起来等于藏起「你现在基于的是哪一版」——那是产品事实，不是历史
  const html = versionRow(vs(6, 3), { attr: "cbV", toggleAttr: "cbHist" });
  assert.match(html, /data-cb-v="6"/);
  assert.match(html, /data-cb-v="3"/);
  assert.doesNotMatch(html, /data-cb-v="4"/);
  assert.match(html, /历史版本 4/);
});

test("展开之后一颗不少，按钮变成「收起历史」", () => {
  const html = versionRow(vs(6, 6), { attr: "cbV", open: true, toggleAttr: "cbHist" });
  for (let v = 1; v <= 6; v += 1) assert.match(html, new RegExp(`data-cb-v="${v}"`));
  assert.match(html, /收起历史/);
});

test("只有一版时不出现「历史版本」", () => {
  const html = versionRow(vs(1, 1), { attr: "cbV", toggleAttr: "cbHist" });
  assert.match(html, /data-cb-v="1"/);
  assert.doesNotMatch(html, /历史版本/);
});

test("没有版本就什么都不画", () => {
  assert.equal(versionRow([], { attr: "cbV", toggleAttr: "cbHist" }), "");
  assert.equal(versionRow(null, { attr: "cbV" }), "");
});

test("驼峰属性名变成正确的 data 属性", () => {
  const html = versionRow(vs(2, 2), { attr: "stV", toggleAttr: "stHist" });
  assert.match(html, /data-st-v="2"/);
  assert.match(html, /data-st-hist="1"/);
});

test("标签与 title 被转义 —— 它们来自作者写的指令", () => {
  const html = versionRow(
    [{ v: 1, isActive: true, label: 'v1 <b>x</b>', title: '他写的 "指令" <script>' }],
    { attr: "stV" },
  );
  assert.doesNotMatch(html, /<b>/);
  assert.doesNotMatch(html, /<script>/);
});

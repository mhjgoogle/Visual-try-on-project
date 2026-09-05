// 「开发」窗口里看得见的提案卡片（TASK-121）。
//
// 产品负责人 2026-08-30：「开发给的方案在哪里。我根本没看到」「我明明说那么清楚了
// 为什么前端agent一直问我重复的问题」。
//
// 两个抱怨是同一个形状：**方案只活在模型的转述里**。所以这份测试守的是两件事 ——
// 方案的**正文**要在屏幕上（不是只有标题），以及**他答过的**要留在屏幕上。

import test from "node:test";
import assert from "node:assert/strict";

import { proposalsModel, renderProposals, renderOpinions } from "../src/ui/proposals.js";

const open1 = { id: 1, title: "左栏收成 4 个工作台", body: "现在：一长排入口\n改完：只剩 4 个\n不变：内容一个不删\n要你定：形态锁不锁" };
const open2 = { id: 2, title: "提完当场告诉你怎么改", body: "现在：只回一句已记下\n改完：多一句怎么改" };
const done1 = { id: 3, title: "旧的那条", body: "…", decision: { verdict: "changes", note: "可以，但历史版本要能一键全展开" } };

test("待答复的方案连**正文**一起画出来 —— 只有标题等于没给他看", () => {
  const html = renderProposals(proposalsModel([open1, open2]));
  assert.match(html, /等你拍板/);
  assert.match(html, /左栏收成 4 个工作台/);
  assert.match(html, /改完：只剩 4 个/, "正文没画出来");
  assert.match(html, /要你定：形态锁不锁/);
});

test("三个拍板按钮都在，且带着提案号", () => {
  const html = renderProposals(proposalsModel([open1]));
  assert.match(html, /data-pp-ok="1"/);
  assert.match(html, /data-pp-no="1"/);
  assert.match(html, /data-pp-ch="1"/);
});

test("正在写的方案不给按钮 —— 那时还没有东西可拍板", () => {
  const html = renderProposals(proposalsModel([{ id: 9, title: "（开发正在写方案）…", pending: true }]));
  assert.match(html, /开发正在写方案/);
  assert.doesNotMatch(html, /data-pp-ok/);
});

test("答过的连**他的原话**一起留在屏幕上 —— 这是「不许再问」的证据", () => {
  const html = renderProposals(proposalsModel([open1, done1]));
  assert.match(html, /已答复（1）/);
  assert.match(html, /要改/);
  assert.match(html, /你说：可以，但历史版本要能一键全展开/);
});

test("一条都没有时不占地方", () => {
  assert.equal(renderProposals(proposalsModel([])), "");
  assert.equal(renderProposals(proposalsModel(null)), "");
});

test("「我提过的意见」列出状态与页面，最新的在最上面", () => {
  const html = renderOpinions([
    { id: 1, text: "左边太挤", status: "done", page: "故事开发 · 项目与创意" },
    { id: 2, text: "分镜列表太窄", status: "new", page: "剧集制作 · 分镜设计" },
  ]);
  assert.match(html, /我提过的意见（2，待处理 1）/);
  assert.ok(html.indexOf("分镜列表太窄") < html.indexOf("左边太挤"), "最新的应该在最上面");
  assert.match(html, /已处理/);
});

test("意见里的文字被转义 —— 那是他自己打的字", () => {
  const html = renderOpinions([{ id: 1, text: "<script>x</script>", status: "new" }]);
  assert.doesNotMatch(html, /<script>/);
});

// 「这一页是哪个文件画的」那张表（TASK-120）。
//
// 产品负责人 2026-08-29：「前端agent给你的留言应该加入更详细的页面定位情报，还需要
// 考虑如何能让你更快的理解问题和解决问题。」
//
// 那张表的价值全在**它是准的**。文件改个名它就悄悄指向不存在的地方，而没有任何东西
// 会喊 —— 这份测试就是那个会喊的东西。它读源码，因为这条性质说的就是源码里那张表。

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

const PROD = new URL("../src/ui/production.js", import.meta.url);

async function sourceMap() {
  const src = await readFile(PROD, "utf8");
  const start = src.indexOf("const MODULE_SOURCE = {");
  assert.ok(start > 0, "production.js 里没有 MODULE_SOURCE 表");
  const body = src.slice(start, src.indexOf("};", start));
  return new Map([...body.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
}

test("表里每个文件都真的存在", async () => {
  const map = await sourceMap();
  assert.ok(map.size >= 10, `表太小了（${map.size} 条）—— 是不是被删了？`);
  for (const [mod, rel] of map) {
    await access(new URL(`../${rel}`, import.meta.url)).catch(() => {
      assert.fail(`${mod} → ${rel} 不存在`);
    });
  }
});

test("那几个他最常待的页面必须在表里", async () => {
  const map = await sourceMap();
  for (const mod of ["brief", "story", "episodes", "storyboard", "shotwork"]) {
    assert.ok(map.has(mod), `${mod} 不在表里 —— 他在那一页提的意见就没有文件线索`);
  }
});

test("每个 key 都是真的模块 id（不是随手编的名字）", async () => {
  const map = await sourceMap();
  const shell = await readFile(new URL("../src/ui/shell.js", import.meta.url), "utf8");
  const labels = shell.slice(shell.indexOf("export const MODULE_LABEL = {"));
  for (const mod of map.keys()) {
    // 用 includes 而不是模板字面量里的正则：模板里的 `\b` 是**退格符**，于是
    // `\bbrief\s*:` 编译成了 `briefs*:` —— 一个永远不匹配的正则，测试会因此
    // 报「brief 不是模块 id」这种明显错误的话（第一次跑就撞见）。
    assert.ok(
      labels.slice(0, labels.indexOf("};")).includes(`${mod}:`),
      `${mod} 不是 MODULE_LABEL 里的模块 id`,
    );
  }
});

/* --- 集号不该被拼两遍 ------------------------------------------------------ */

test("标题已经带着集号时不再补一次（台账 #5 上记成了「EP01 EP01 迷雾入城」）", async () => {
  const src = await readFile(PROD, "utf8");
  const start = src.indexOf("function episodeLabelOf(");
  assert.ok(start > 0, "没有 episodeLabelOf —— 集号的拼法又散回调用点了？");
  const body = src.slice(start, src.indexOf("\n  }", start));
  assert.match(body, /startsWith\(no\)/, "没有「标题已带集号」这一支");
});

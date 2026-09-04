// 浏览器入口必须能按 ESM 解析 —— 这条守卫存在，是因为它曾经不成立而 2118 条测试全绿。
//
// 2026-09-05（TASK-074 §1.7 审查轮 3/4）：`app.js` 里多了一个 `},`，把 `ctx` 对象提前关掉，
// 后面的 `storage: {` 变成 `const ctx = {…}, storage` 的第二个声明 → 浏览器一加载就是
// SyntaxError，整个 Studio 起不来。而**没有一条前端测试 import `app.js`**（它是入口，
// 顶层就碰 DOM），所以全绿；`node --check` 又按 CJS 解析、对 ESM 语法睁一只眼闭一只眼，
// 于是我拿它当证据反驳了审查者两轮。审查者是对的。
//
// 动态 `import()` 会**先解析再执行**：解析失败抛 SyntaxError；执行到 `document` 抛
// ReferenceError。这里只要求前者不发生 —— 一个入口文件在 node 里跑不起来是正常的，
// 解析不了不是。
import test from "node:test";
import assert from "node:assert/strict";

const ENTRIES = ["../src/app.js", "../src/ui/production.js"];

for (const entry of ENTRIES) {
  test(`${entry.replace("../src/", "")} 按 ESM 解析成功（运行期缺 DOM 可以，语法错不行）`, async () => {
    let err = null;
    try {
      await import(entry);
    } catch (e) {
      err = e;
    }
    if (err) {
      assert.notEqual(
        err.constructor && err.constructor.name,
        "SyntaxError",
        `${entry} 解析失败：${err.message} —— 浏览器一加载就会白屏`,
      );
    }
  });
}

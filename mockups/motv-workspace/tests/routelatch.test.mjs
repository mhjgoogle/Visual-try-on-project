// 路由闩：一次只跑一次，但不丢掉排在后面的那一次 —— TASK-103 批次 D（TASK-087 §5.6）。
//
// 旧的 `routeApplying` 闩解决的是真问题（一次后退同时触发 popstate 与
// hashchange，重复应用会重绘并把「有未保存的修改」问两遍），但它用的是**丢弃**。
// 快速连按前进/后退时第二次按下就这么没了：地址栏在第二个位置，界面在第一个，
// 然后 `writeUrl()` 把地址改回界面所在处。屏幕与地址最终一致（所以这条一直是
// P3），但那一次按下什么都没发生，且没有任何提示。
import test from "node:test";
import assert from "node:assert/strict";

import { createRouteLatch } from "../src/services/routelatch.js";

/** 一个可以由测试决定何时结束的动作。 */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("在制中不重复跑 —— 这是旧闩本来就对的那一半", async () => {
  const d = deferred();
  let runs = 0;
  const latch = createRouteLatch(async () => { runs++; await d.promise; });
  const first = latch.trigger();
  latch.trigger();
  latch.trigger();
  assert.equal(runs, 1, "在制中不得并发跑第二次");
  assert.equal(latch.busy(), true);
  assert.equal(latch.pending(), true);
  d.resolve();
  await first;
  assert.equal(runs, 2, "排在后面的那一次必须补跑");
});

test("连按多次合并成一次补跑 —— 要去的是最后那个地址", async () => {
  // 中间那些地址是路过。补跑 N 次等于把中间态一个个画出来。
  const d = deferred();
  let runs = 0;
  const latch = createRouteLatch(async () => { runs++; if (runs === 1) await d.promise; });
  const first = latch.trigger();
  for (let i = 0; i < 5; i++) latch.trigger();
  d.resolve();
  await first;
  assert.equal(runs, 2);
});

test("空闲时触发就直接跑，不排队", async () => {
  let runs = 0;
  const latch = createRouteLatch(async () => { runs++; });
  await latch.trigger();
  assert.equal(runs, 1);
  assert.equal(latch.pending(), false);
  await latch.trigger();
  assert.equal(runs, 2);
});

test("一次导航失败不会顺手把排在后面的那一次也丢掉", async () => {
  // 否则就只是把丢弃换了个触发条件。
  const d = deferred();
  const seen = [];
  const latch = createRouteLatch(async () => {
    seen.push("run");
    if (seen.length === 1) { await d.promise; throw new Error("boom"); }
  });
  const first = latch.trigger();
  latch.trigger();
  d.resolve();
  await assert.rejects(first, /boom/);
  assert.deepEqual(seen, ["run", "run"], "第二次仍然要跑");
});

test("排空之后闩是干净的，下一次触发照常", async () => {
  const d = deferred();
  let runs = 0;
  const latch = createRouteLatch(async () => { runs++; if (runs === 1) await d.promise; });
  const first = latch.trigger();
  latch.trigger();
  d.resolve();
  await first;
  assert.equal(latch.busy(), false);
  assert.equal(latch.pending(), false);
  await latch.trigger();
  assert.equal(runs, 3);
});

test("闩不缓存参数 —— 动作自己去读当前地址", async () => {
  // 缓存第一次的参数会让合并后跑的是**旧**地址，那还是「按了但没反应」，
  // 只是换了种表现。
  let address = "a";
  const seen = [];
  const d = deferred();
  const latch = createRouteLatch(async () => {
    seen.push(address);
    if (seen.length === 1) await d.promise;
  });
  const first = latch.trigger();
  address = "b";
  latch.trigger();
  address = "c";
  latch.trigger();
  d.resolve();
  await first;
  assert.deepEqual(seen, ["a", "c"], "补跑读到的必须是最后那个地址");
});

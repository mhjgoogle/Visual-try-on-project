// TASK-152 / REQ-009 判据 4：连着往下写若干章，可停、可改、不覆盖。
//
// 断言的是**行为**：这一片会静默出错的形状全在「写到了不该写的章」这一族 ——
// 覆盖了他刚写的、跳过了失败的那一章接着往下、停不下来、接错了上一章。
//
//   1. `chainTargets` —— 下一批写谁：没正文的、到 Planned 为止、按 count 截断。
//   2. `runChain` —— 每章现读再决定；失败停在原地；停止在两章之间生效；
//      每次运行的章号就是目标章号；应用用的是那次运行的 runId。
//   3. `chapterPlan.previous` —— 接着**最近一章有正文的**写，读的是此刻的正文。

import test from "node:test";
import assert from "node:assert/strict";

import * as w from "../src/workflow/storywork.js";
import * as chain from "../src/workflow/novelchain.js";

function novelWork({ planned = 12 } = {}) {
  const k = w.createWork(null);
  w.setForm(k, "novel");
  w.setPlanned(k, "novel", planned);
  return k;
}

function write(k, no, text) {
  const u = w.ensureUnit(k, "novel", no, "T0");
  w.editUnit(k, u.id, "body", text, "T0");
  return u;
}

// --- 1. 下一批写谁 ---------------------------------------------------------- //

test("从第一章没正文的开始，已写的跳过，到 Planned 为止", () => {
  const k = novelWork({ planned: 6 });
  write(k, 1, "第一章");
  write(k, 2, "第二章");
  assert.deepEqual(w.chainTargets(k, null), [3, 4, 5, 6]);
  assert.deepEqual(w.chainTargets(k, 3), [3, 4, 5]);
  assert.deepEqual(w.chainTargets(k, 1), [3]);
});

test("中间空着的章也补 —— 显式假设，写在卡 §2", () => {
  const k = novelWork({ planned: 5 });
  write(k, 1, "一");
  write(k, 3, "三");
  assert.deepEqual(w.chainTargets(k, 2), [2, 4]);
});

test("计划内全写完了 → 空数组，不越过 Planned 去写", () => {
  const k = novelWork({ planned: 2 });
  write(k, 1, "一");
  write(k, 2, "二");
  assert.deepEqual(w.chainTargets(k, 5), []);
});

test("只对小说成立；计划为 0 或 count 非法时什么都不写", () => {
  const ep = w.createWork(null);
  w.setForm(ep, "episode");
  w.setPlanned(ep, "episode", 5);
  assert.deepEqual(w.chainTargets(ep, 3), []);
  const k = novelWork({ planned: 0 });
  assert.deepEqual(w.chainTargets(k, null), []);
  const k2 = novelWork({ planned: 4 });
  assert.deepEqual(w.chainTargets(k2, 0), []);
  assert.deepEqual(w.chainTargets(k2, -1), []);
  assert.deepEqual(w.chainTargets(k2, "x"), []);
});

test("只有空白的章不算已写", () => {
  const k = novelWork({ planned: 3 });
  write(k, 1, "   \n ");
  assert.deepEqual(w.chainTargets(k, null), [1, 2, 3]);
});

// --- 2. 驱动链 --------------------------------------------------------------- //

/** 一个假的「运行 + 应用」：运行成功就把正文写进 work 的那一章（应用做的事）。 */
function fakeDeps(k, { failAt = null, onRun = null } = {}) {
  const runs = [];
  const applied = [];
  let seq = 0;
  return {
    runs,
    applied,
    deps: {
      work: () => k,
      run: async (no) => {
        runs.push(no);
        if (onRun) onRun(no);
        if (failAt === no) return { ok: false, error: "执行器不可用" };
        seq += 1;
        return { ok: true, run: { runId: `run-${seq}`, unitNo: no } };
      },
      apply: (runId) => {
        applied.push(runId);
        const no = runs[runs.length - 1];
        write(k, no, `AI 写的第 ${no} 章`);
        return { ok: true };
      },
    },
  };
}

test("三章依次写出、落进各自那一章；已写的两章一个字不动", async () => {
  const k = novelWork({ planned: 12 });
  write(k, 1, "他写的第一章");
  write(k, 2, "他写的第二章");
  const c = chain.createChain(w.chainTargets(k, 3), { count: 3 });
  const f = fakeDeps(k);
  await chain.runChain(c, f.deps);

  assert.equal(c.status, "done");
  assert.deepEqual(f.runs, [3, 4, 5], "每次运行的章号必须就是目标章号");
  assert.deepEqual(f.applied, ["run-1", "run-2", "run-3"], "应用的是那次运行自己的 runId");
  assert.deepEqual(c.written, [3, 4, 5]);
  for (const no of [3, 4, 5]) {
    assert.equal(k.units.find((u) => u.no === no).body, `AI 写的第 ${no} 章`);
  }
  assert.equal(k.units.find((u) => u.no === 1).body, "他写的第一章");
  assert.equal(k.units.find((u) => u.no === 2).body, "他写的第二章");
});

test("链跑着的时候他自己写了下一章 → 那一章跳过，不覆盖，且说出来", async () => {
  const k = novelWork({ planned: 6 });
  const c = chain.createChain(w.chainTargets(k, 3), { count: 3 }); // [1,2,3]
  const f = fakeDeps(k, {
    // 写第 1 章的那次运行进行中，他在第 2 章手写了几段
    onRun: (no) => { if (no === 1) write(k, 2, "他中途写的第二章"); },
  });
  await chain.runChain(c, f.deps);

  assert.equal(c.status, "done");
  assert.deepEqual(f.runs, [1, 3], "第 2 章不该被跑");
  assert.deepEqual(c.skipped, [2]);
  assert.equal(k.units.find((u) => u.no === 2).body, "他中途写的第二章", "他写的被覆盖了");
  assert.match(chain.describe(c), /第 2 章已有正文，跳过/);
});

test("一章失败 → 链停在那一章，不跳过它去写下一章", async () => {
  const k = novelWork({ planned: 5 });
  const c = chain.createChain(w.chainTargets(k, null));
  const f = fakeDeps(k, { failAt: 2 });
  await chain.runChain(c, f.deps);

  assert.equal(c.status, "failed");
  assert.deepEqual(f.runs, [1, 2], "失败之后还在往下跑");
  assert.deepEqual(c.written, [1]);
  assert.deepEqual(c.failed, { no: 2, error: "执行器不可用" });
  assert.equal(k.units.find((u) => u.no === 2), undefined, "失败的那一章不该有东西落进去");
  assert.match(chain.describe(c), /停在第 2 章/);
});

test("应用失败也算失败 —— 写出来却没落地，不能当写完", async () => {
  const k = novelWork({ planned: 3 });
  const c = chain.createChain(w.chainTargets(k, null));
  const f = fakeDeps(k);
  f.deps.apply = () => ({ ok: false, error: "还不知道该写第几章" });
  await chain.runChain(c, f.deps);
  assert.equal(c.status, "failed");
  assert.deepEqual(c.written, []);
  assert.equal(c.failed.no, 1);
});

test("停止在两章之间生效：写完手上这一章就停，再接着来不重写", async () => {
  const k = novelWork({ planned: 6 });
  const c = chain.createChain(w.chainTargets(k, null)); // 1..6
  const f = fakeDeps(k, {
    onRun: (no) => { if (no === 2) chain.requestStop(c); }, // 第 2 章跑着的时候按了停
  });
  await chain.runChain(c, f.deps);

  assert.equal(c.status, "stopped");
  assert.deepEqual(f.runs, [1, 2], "按了停还往下跑了");
  assert.deepEqual(c.written, [1, 2], "手上那一章要写完落地，不是半途丢掉");
  assert.match(chain.describe(c), /已停下/);

  // 再说一次「接着写」：从进度接着算，不重写 1、2
  assert.deepEqual(w.chainTargets(k, null), [3, 4, 5, 6]);
});

test("运行抛异常不让链崩掉 —— 记成失败停下", async () => {
  const k = novelWork({ planned: 2 });
  const c = chain.createChain(w.chainTargets(k, null));
  const f = fakeDeps(k);
  f.deps.run = async () => { throw new Error("网断了"); };
  await chain.runChain(c, f.deps);
  assert.equal(c.status, "failed");
  assert.equal(c.failed.error, "网断了");
});

test("没有可写的章：链一开始就是 done，且说的是「都已经有正文了」", async () => {
  const c = chain.createChain([]);
  assert.equal(c.status, "done");
  assert.match(chain.describe(c), /都已经有正文/);
  const f = fakeDeps(novelWork());
  await chain.runChain(c, f.deps);
  assert.deepEqual(f.runs, []);
});

// --- 3. 接着谁写 --------------------------------------------------------------- //

test("本章任务带着上一章此刻的结尾 —— 他中途改过就是改过的", () => {
  const k = novelWork({ planned: 5 });
  write(k, 1, "第一章原稿。结尾是旧的。");
  assert.equal(w.chapterPlanOf(k, 2).previous.no, 1);
  assert.match(w.chapterPlanOf(k, 2).previous.tail, /结尾是旧的/);

  const u1 = k.units.find((u) => u.no === 1);
  w.editUnit(k, u1.id, "body", "第一章改过了。结尾变成新的。", "T1");
  assert.match(w.chapterPlanOf(k, 2).previous.tail, /结尾变成新的/, "读的不是此刻的正文");
});

test("接着的是最近一章**有正文**的，不是第 N−1 章；第一章没有 previous", () => {
  const k = novelWork({ planned: 5 });
  write(k, 1, "一");
  w.ensureUnit(k, "novel", 2, "T0"); // 第 2 章空着
  const p = w.chapterPlanOf(k, 3).previous;
  assert.equal(p.no, 1, "接了一个空章");
  assert.equal(w.chapterPlanOf(k, 1).previous, null);
});

test("结尾只取最后一段，不把整章塞回去", () => {
  const k = novelWork({ planned: 3 });
  write(k, 1, "开头".repeat(500) + "真正的结尾");
  const tail = w.chapterPlanOf(k, 2).previous.tail;
  assert.equal(tail.length, w.PREVIOUS_TAIL_CHARS);
  assert.ok(tail.endsWith("真正的结尾"));
});

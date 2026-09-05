// 录白膜录到的是哪块画布？—— TASK-087 §5.22。
//
// 原来的顺序是「取画布 → captureStream → render() → 开录」。`render()` 换掉
// `root.innerHTML` 之后，手里那块 canvas 成了孤儿：动画画在新节点上，录出来的
// 白膜**不含动画**。它不报错、文件也不空，只是一段静止画面 —— 「看起来成功了」
// 的失败。§5.18 同时记着：这条路径从来没在真浏览器里跑通过，一个测试都没有。

import test from "node:test";
import assert from "node:assert/strict";
import { recordCanvas } from "../src/ui/bkrecord.js";

/** 一个够用的录制器替身：记下它是被哪块画布造出来的，以及有没有真的开录。 */
function fakeRecorder(view, chunk = new Blob(["x"])) {
  const rec = {
    view, started: false, stopped: false,
    ondataavailable: null, onstop: null,
    start() {
      this.started = true;
      if (this.ondataavailable) this.ondataavailable({ data: chunk });
    },
    stop() { this.stopped = true; if (this.onstop) this.onstop(); },
  };
  return rec;
}

test("录的是屏幕上那块画布，不是被重绘换掉的那块孤儿", async () => {
  // 这条钉住的就是 §5.22 的缺陷：`showRecording` 会重绘（换掉整块 DOM），
  // 所以取画布**必须在它之后**。取早了，录到的是没人再往上面画的孤儿。
  const orphan = { id: "旧画布" };
  const live = { id: "新画布" };
  let current = orphan;
  const made = [];

  const out = await recordCanvas({
    seconds: 2,
    showRecording: () => { current = live; },   // ← 重绘：节点被换掉
    getView: () => current,
    makeRecorder: (v) => { const r = fakeRecorder(v); made.push(r); return r; },
    play: async () => {},
    toast: () => {},
  });

  assert.equal(out.ok, true, `没录成：${out.reason}`);
  assert.equal(made.length, 1);
  assert.equal(made[0].view, live, "录的是被换掉的那块旧画布 —— 白膜里不会有动画");
  assert.equal(made[0].started && made[0].stopped, true, "没有真的开录/停录");
});

test("开录之前画布又被换掉 —— 不录，而且说出来", async () => {
  // 正常路径走不到这里（重绘只有一次）。它防的是**以后**有人在中间再加一次
  // `render()`：那时必须当场出声，而不是又交出一段不动的白膜。
  const a = { id: "a" }; const b = { id: "b" };
  let n = 0;
  const said = [];
  const made = [];

  const out = await recordCanvas({
    seconds: 2,
    showRecording: () => {},
    getView: () => (++n === 1 ? a : b),          // 第二次问，答案就变了
    makeRecorder: (v) => { const r = fakeRecorder(v); made.push(r); return r; },
    play: async () => { throw new Error("不该走到这里"); },
    toast: (m) => said.push(m),
  });

  assert.equal(out.ok, false);
  assert.equal(out.reason, "view-swapped");
  assert.equal(made[0].started, false, "画布已经不是那块了，却还是开了录");
  assert.match(said.join(" "), /换掉|没有写入任何资产/, "悄悄没录 —— 一声不吭");
});

test("录出来是空的 —— 不写入资产，并且出声", async () => {
  const said = [];
  const v = { id: "v" };                                  // 同一块画布，别让身份守卫先拦下
  const out = await recordCanvas({
    seconds: 1,
    showRecording: () => {},
    getView: () => v,
    makeRecorder: (c) => fakeRecorder(c, new Blob([])),   // 一个字节都没有
    play: async () => {},
    toast: (m) => said.push(m),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "empty");
  assert.equal(out.blob, undefined, "空的也交出去了 —— 那会被当成一段白膜登记进资产库");
  assert.match(said.join(" "), /空/, "录出来是空的却没告诉他");
});

test("画布不在了 / 浏览器不支持 / 造录制器就抛了 —— 三条都出声，且都把「录制中」收回去", async () => {
  const cases = [
    { name: "画布不在了", getView: () => null, makeRecorder: () => fakeRecorder({}), reason: "no-view" },
    { name: "不支持", getView: () => ({}), makeRecorder: () => null, reason: "unsupported" },
    { name: "造不出来", getView: () => ({}), makeRecorder: () => { throw new Error("boom"); }, reason: "recorder-failed" },
  ];
  for (const c of cases) {
    const said = [];
    const shown = [];
    const out = await recordCanvas({
      seconds: 1,
      showRecording: (s) => shown.push(s),
      getView: c.getView,
      makeRecorder: c.makeRecorder,
      play: async () => { throw new Error("不该走到这里"); },
      toast: (m) => said.push(m),
    });
    assert.equal(out.ok, false, c.name);
    assert.equal(out.reason, c.reason, c.name);
    assert.equal(said.length >= 1, true, `${c.name}：一声不吭`);
    assert.equal(shown.at(-1), null, `${c.name}：界面永远停在「录制中」`);
  }
});

test("这一镜走到一半抛了 —— 也要停录、也要把「录制中」收回去", async () => {
  // 播放里抛异常不该把界面永久留在「录制中」，那和把人锁在只读编辑器前面是同一类错。
  const shown = [];
  const v = { id: "v" };
  let rec;
  await assert.rejects(
    recordCanvas({
      seconds: 1,
      showRecording: (s) => shown.push(s),
      getView: () => v,
      makeRecorder: (c) => { rec = fakeRecorder(c); return rec; },
      play: async () => { throw new Error("播到一半炸了"); },
      toast: () => {},
    }),
    /播到一半炸了/,
  );
  assert.equal(rec.stopped, true, "抛了就没停录 —— 录制器一直挂着");
  assert.equal(shown.at(-1), null, "界面永远停在「录制中」");
});

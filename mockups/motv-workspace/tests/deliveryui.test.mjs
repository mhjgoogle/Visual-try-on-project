// 交付生命周期的**界面那一半**（TASK-074 §1.7 第 2、4 步；codex 轮 2 判证据不足）。
//
// 上一轮的教训：给这块加按钮那次编辑被闸门整条拦掉，而 2089 条测试照旧全绿 ——
// 因为没有一条测试问过「候选行画出来了吗、按钮接上了吗」。这里就问这个：
//   · 没测过的候选：「导出成片」disabled + 理由 + 「对这一版跑质检」
//   · 放行的候选：「导出成片」可点
//   · 已导出的成片：「撤回这一版成片（归档）」
//   · 三个按钮点下去调的是**真的那三个**操作，且带着**这一版**的 assetId
import test from "node:test";
import assert from "node:assert/strict";

import { finalBody, bindPostConsole } from "../src/ui/postconsole.js";

/** 最小的 ctx：只给 finalBody / 三个处理器真会碰的东西。 */
function ctxWith(overrides = {}) {
  const calls = [];
  return {
    calls,
    probeState: () => ({ assetId: null, name: null, running: false, error: null, measured: false }),
    cutSpecCheck: () => null,
    assets: { provenanceOf: () => null },
    toast: (m) => calls.push(["toast", m]),
    delivery: {
      exportability: () => ({ ok: false, step: "unmeasured", reason: "没测过" }),
      exportCut: (id) => { calls.push(["exportCut", id]); return { url: "/media/fin.mp4" }; },
    },
    runDeliveryProbe: (id) => { calls.push(["probe", id]); return Promise.resolve({ error: null }); },
    storage: { archive: (id, on) => { calls.push(["archive", id, on]); return true; } },
    actions: { dispatch: () => ({ ok: true }) },
    locks: { is: () => false, count: () => 0 },
    timeline: { setSettings: () => {} },
    ...overrides,
  };
}

const model = (cuts, finals = []) => ({
  edit: { settings: { width: 1080, height: 1920, fps: 24, format: "mp4" }, video: [], duration: 0 },
  subtitles: { version: 0 },
  locks: 0,
  cuts,
  finals,
});

const CUT = (gate) => ({ assetId: "cut-1", url: "/media/cut_v1.mp4", kind: "cut", gate });

test("没测过的候选：导出按钮 disabled、理由印在旁边、给一个「对这一版跑质检」", () => {
  const html = finalBody(ctxWith(), model([CUT({ ok: false, step: "unmeasured", reason: "这一版候选还没被测量过" })]));
  assert.match(html, /候选成片（1）/);
  assert.match(html, /data-pc-export="cut-1"\s+disabled/);
  assert.match(html, /这一版候选还没被测量过/);
  assert.match(html, /data-pc-qc="cut-1"/);
  assert.match(html, /候选 · 还不是成片/);
  assert.match(html, /还没有导出过成片/);
});

test("G4 拒绝的候选：按钮 disabled、阻断理由可见、仍给「对这一版跑质检」", () => {
  const html = finalBody(ctxWith(), model([CUT({ ok: false, step: "g4", reason: "有 1 个阻断级质检问题还没解决：缺帧", blockingIssueIds: ["qc-1"] })]));
  assert.match(html, /data-pc-export="cut-1"\s+disabled/);
  assert.match(html, /缺帧/);
  assert.match(html, /data-pc-qc="cut-1"/);
});

test("放行的候选：导出按钮可点；**重新质检仍然可到达**（第 4 条：重新审片）", () => {
  // codex 轮 3：一版干净的候选也该能再测一次 —— 素材换了、规格改了，上一次的通过不再说明什么
  const html = finalBody(ctxWith(), model([CUT({ ok: true, step: "ready" })]));
  assert.match(html, /data-pc-export="cut-1">/, "没有 disabled");
  assert.doesNotMatch(html, /data-pc-export="cut-1"\s+disabled/);
  assert.match(html, /交付质检通过，可以导出/);
  assert.match(html, /data-pc-qc="cut-1">重新质检/);
});

test("已导出的成片单独一组，带「撤回（归档）」；候选与成片不混在一栏", () => {
  const html = finalBody(ctxWith(), model(
    [CUT({ ok: false, step: "unmeasured", reason: "没测过" })],
    [{ assetId: "fin-1", url: "/media/fin_v1.mp4", kind: "final" }],
  ));
  assert.match(html, /已导出的成片（1）/);
  assert.match(html, /data-pc-archive="fin-1"/);
  assert.match(html, /撤回这一版成片/);
  // 顺序 = 生命周期：候选在成片之前
  assert.ok(html.indexOf("候选成片（1）") < html.indexOf("已导出的成片（1）"));
});

/* --- 三个按钮真的接到真的操作上 ------------------------------------------- */

/** 最小 DOM：只认 data-pc-export / data-pc-qc / data-pc-archive 三种按钮。 */
function fakeRoot(buttons) {
  const els = buttons.map(([attr, val]) => ({ dataset: { [attr]: val }, onclick: null, attr }));
  return {
    els,
    querySelector: () => null,
    querySelectorAll: (sel) => {
      const m = /^\[(data-[a-z-]+)\]$/.exec(sel);
      if (!m) return [];
      const prop = m[1].replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return els.filter((e) => e.attr === prop);
    },
  };
}

test("点「导出成片」→ 调 `ctx.delivery.exportCut(这一版)`，成功后报出文件名", () => {
  const ctx = ctxWith();
  const root = fakeRoot([["pcExport", "cut-1"]]);
  let renders = 0;
  bindPostConsole(root, ctx, {}, () => { renders += 1; });
  root.els[0].onclick();
  assert.deepEqual(ctx.calls.filter((c) => c[0] === "exportCut"), [["exportCut", "cut-1"]]);
  assert.ok(ctx.calls.some((c) => c[0] === "toast" && /已导出成片/.test(c[1])));
  assert.equal(renders, 1);
});

test("导出被闸门拒了 → 屏幕上说「导出被拒绝：<理由>」，不是静默", () => {
  const ctx = ctxWith({
    delivery: {
      exportability: () => ({ ok: false }),
      exportCut: () => { throw new Error("有 1 个阻断级质检问题还没解决"); },
    },
  });
  const root = fakeRoot([["pcExport", "cut-1"]]);
  bindPostConsole(root, ctx, {}, () => {});
  root.els[0].onclick();
  assert.ok(ctx.calls.some((c) => c[0] === "toast" && /导出被拒绝：有 1 个阻断级/.test(c[1])));
});

test("点「对这一版跑质检」→ `runDeliveryProbe(这一版)`，不是「最新那条」", async () => {
  const ctx = ctxWith();
  const root = fakeRoot([["pcQc", "cut-7"]]);
  let renders = 0;
  bindPostConsole(root, ctx, {}, () => { renders += 1; });
  await root.els[0].onclick();
  assert.deepEqual(ctx.calls.filter((c) => c[0] === "probe"), [["probe", "cut-7"]]);
  assert.equal(renders, 2, "探测前后各重画一次：先把按钮变成「正在探测…」，再带回结果");
});

test("点「撤回这一版成片（归档）」→ `storage.archive(这一版, true)`", () => {
  const ctx = ctxWith();
  const root = fakeRoot([["pcArchive", "fin-3"]]);
  bindPostConsole(root, ctx, {}, () => {});
  root.els[0].onclick();
  assert.deepEqual(ctx.calls.filter((c) => c[0] === "archive"), [["archive", "fin-3", true]]);
  assert.ok(ctx.calls.some((c) => c[0] === "toast" && /已撤回/.test(c[1])));
});

test("归档失败（不是本地副本 / 已归档）要说出来，不能装成成功", () => {
  const ctx = ctxWith({ storage: { archive: () => false } });
  const root = fakeRoot([["pcArchive", "fin-3"]]);
  bindPostConsole(root, ctx, {}, () => {});
  root.els[0].onclick();
  assert.ok(ctx.calls.some((c) => c[0] === "toast" && /没法归档/.test(c[1])));
});

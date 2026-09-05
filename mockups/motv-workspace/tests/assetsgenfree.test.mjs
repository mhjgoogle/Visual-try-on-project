// 免费自动出图那颗按钮的**处理器级**证据 —— TASK-139 批次 B / REQ-008 判据 1、5。
//
// 为什么是这个形状：codex 补审判「服务层被调用」不足以证明判据 1（「点一下就生成」），
// 也不足以证明判据 5（重复点击不重复消耗），并给了做法 —— **一个最小的 element /
// ctx stub 就够，不需要完整 DOM 框架**。这个文件就是那个 stub：
//
//   - `el` 只实现 `querySelectorAll`，返回带 `dataset` 的假按钮；
//   - `ctx` 只实现处理器真正用到的那几个方法，每一个都记录被调用的事实；
//   - `declare` / `addVersion` / `refFromResponse` **用真的**（它们是纯函数），
//     所以「登记到槽位」这一步是真的发生了，不是被 stub 掉的。
//
// 纯测试：无 DOM、无网络。
import test from "node:test";
import assert from "node:assert/strict";

import assetsNode from "../src/workflow/nodes/assets.js";
import { slotUrl } from "../src/workflow/mediaref.js";

const SHOT = {
  sequence: 1,
  title: "竹林对峙",
  slot: "s1",
  shotId: "shot-1",
  description: "少年剑客在竹林中回头",
  duration_seconds: 6,
};

/** 只实现处理器用到的那一个方法。选择器 → 假按钮数组。 */
function fakeEl() {
  const buttons = new Map();
  return {
    _buttons: buttons,
    querySelectorAll(sel) {
      if (!buttons.has(sel)) {
        // data-genfree="1" —— 处理器按 `b.dataset.genfree` 找镜头
        const name = sel.replace(/^\[data-|\]$/g, "");
        buttons.set(sel, [{ dataset: { [camel(name)]: "1", genfree: "1" }, onclick: null }]);
      }
      return buttons.get(sel);
    },
    querySelector: () => null,
  };
}
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function fakeCtx(accountImage) {
  const log = { toasts: [], started: [], completed: [], failed: [], persisted: 0, refreshed: 0 };
  return {
    log,
    project: { draftShots: [SHOT] },
    accountImage,
    toast: (m) => log.toasts.push(m),
    startGeneration: (g) => {
      log.started.push(g);
      return { generationId: "gen-1" };
    },
    completeGeneration: (id, assets) => log.completed.push({ id, assets }),
    failGeneration: (id, why) => log.failed.push({ id, why }),
    contextOfShot: (shotId) => ({ shotId }),
    refreshType: () => (log.refreshed += 1),
    persist: () => (log.persisted += 1),
  };
}

/** 绑定一次，返回那颗 ✨ 按钮的 onclick。 */
function bindFree(node, ctx) {
  const el = fakeEl();
  globalThis.window = { confirm: () => true }; // 「单幅首帧图」那一问
  assetsNode.bind(node, el, ctx);
  const btn = el.querySelectorAll("[data-genfree]")[0];
  assert.equal(typeof btn.onclick, "function", "✨ 按钮必须被绑定");
  return () => btn.onclick({ stopPropagation() {} });
}

test("点一下就生成，并把结果登记到这个镜头的槽位（REQ-008 判据 1）", async () => {
  const calls = [];
  const node = { id: 1, type: "assets", uploads: {} };
  const ctx = fakeCtx(async (slug, prompt) => {
    calls.push({ slug, prompt });
    return { ok: true, url: "/api/uploads/p/assets-s1_v1.jpg", version: 1, model: "pollinations/sana" };
  });

  await bindFree(node, ctx)();

  // 后端拿到的是这个镜头的槽位与真实 prompt —— 不是空串，也不是别的镜头
  assert.equal(calls.length, 1);
  assert.equal(calls[0].slug, "assets-s1");
  assert.match(calls[0].prompt, /竹林对峙/);
  // **真的登记了**：`addVersion` 是真函数，所以槽位上现在有一版可解析的地址
  assert.equal(slotUrl(node.uploads, "s1"), "/api/uploads/p/assets-s1_v1.jpg");
  // 溯源闭合，且提示里没有金额（判据 2 在界面这一侧的样子）
  assert.deepEqual(ctx.log.completed.map((c) => c.id), ["gen-1"]);
  assert.equal(ctx.log.failed.length, 0);
  assert.equal(ctx.log.toasts.some((t) => t.includes("$")), false);
  assert.equal(ctx.log.persisted, 1);
});

test("在途时重复点击不会再消耗一次（REQ-008 判据 5）", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const calls = [];
  const node = { id: 1, type: "assets", uploads: {} };
  const ctx = fakeCtx(async (slug) => {
    calls.push(slug);
    await gate;
    return { ok: true, url: "/api/uploads/p/assets-s1_v1.jpg", version: 1 };
  });

  const click = bindFree(node, ctx);
  const first = click();
  await click(); // 第一次还没回来时又点了一下
  release();
  await first;

  assert.equal(calls.length, 1, "第二次点击不得再发一次生成");
});

test("不确定的失败不标 failed，而且**说出**这一次可能已经消耗过", async () => {
  const node = { id: 1, type: "assets", uploads: {} };
  const err = new Error("quota");
  err.category = "quota_exhausted";
  err.sideEffect = "unknown"; // 429 现在判 unknown（合同 §5.8 白名单）
  const ctx = fakeCtx(async () => {
    throw err;
  });

  await bindFree(node, ctx)();

  // 标成失败会让下一次重试看起来是干净的第一次
  assert.equal(ctx.log.failed.length, 0);
  const last = ctx.log.toasts.at(-1);
  assert.match(last, /额度用完/);
  assert.match(last, /可能已经消耗过/, "「消耗没消耗」要由 sideEffect 说，不由类别说");
  assert.ok(!slotUrl(node.uploads, "s1"), "失败不得留下版本");
});

test("确定没发生的失败才标 failed", async () => {
  const node = { id: 1, type: "assets", uploads: {} };
  const err = new Error("no tier");
  err.category = "billing_not_established";
  err.sideEffect = "none";
  err.definitiveReject = true;
  const ctx = fakeCtx(async () => {
    throw err;
  });

  await bindFree(node, ctx)();

  assert.deepEqual(ctx.log.failed.map((f) => f.id), ["gen-1"]);
  const last = ctx.log.toasts.at(-1);
  assert.match(last, /没声明是免费额度/);
  assert.equal(/消耗过/.test(last), false, "确定没发生就不该暗示消耗");
});

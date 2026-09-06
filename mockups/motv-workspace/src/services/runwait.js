// 等一轮运行落定 —— **只有这一份**（TASK-106 判据 2 · ADR-0095 决策 2）。
//
// 为什么单独一个模块：这套等待原来只长在 `conversation.js` 的 `awaitTurn` 里，
// 服务对话那条链。现在五个创作端点也要走 `run_id`，如果各写一个循环，「谁说了算」
// 就有了两份规则 —— 而 ADR-0095 决策 2 的全部内容就是**那必须是同一份**：
//
//   | 拿到什么 | 怎么答 |
//   | 终态（succeeded/failed/cancelled/awaiting_input） | 就是它，交出去 |
//   | 问不到（超时 / 500 / 断网） | **「状态未知」，绝不说「没在跑」** |
//
// 第二行是 ADR-0064 决策 6 在运行状态上的那一次应用：说「没在跑」会让他再起一轮，
// 于是两轮同时改同一份文档。**问不到是关于我们的陈述，不是关于那一轮的。**
//
// `read` 是注入的（`(project, runId) => run|null`），所以这份逻辑不碰网络，
// 也因此能被真调用钉住 —— 而不是靠扫源码确认「循环里有没有那个判断」。

/** 终态：这四个状态之后不会再自己变了。 */
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "awaiting_input"]);

export function isTerminal(status) {
  return TERMINAL.has(String(status || ""));
}

/**
 * 等一轮运行落定，状态每变一次就叫一次 `onTick`。
 *
 * **有上限，而且放弃的时候说实话。** 没有上限的轮询会把一个死掉的后端变成永远
 * 转下去的圈；这一份会停，并且交出 `{ status: "unknown", timedOut: true }` ——
 * 那是他能据此做点什么的一句话，而「没在跑」不是。
 *
 * @param {object}   o
 * @param {Function} o.read      `(project, runId) => Promise<run|null>`
 * @param {string}   o.project
 * @param {string}   o.runId
 * @param {Function} [o.onTick]  状态**变化**时叫一次（不是每轮都叫）
 * @param {number}   [o.timeoutMs=180000]
 * @param {number}   [o.everyMs=1200]
 * @param {Function} [o.sleep]   注入的等待，测试用
 */
export async function awaitRun({
  read, project, runId, onTick, timeoutMs = 180000, everyMs = 1200, sleep,
} = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  let last = null;
  for (;;) {
    const run = await read(project, runId);
    const status = run && run.status;
    if (status && status !== last) {
      last = status;
      if (onTick) onTick(run);
    }
    if (isTerminal(status)) return run;
    if (Date.now() - started > timeoutMs) {
      // **不是 `null`，也不是「没在跑」** —— 是一句「我问不到」。
      return { runId, status: "unknown", timedOut: true };
    }
    await wait(everyMs);
  }
}

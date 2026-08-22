// 一次只跑一次路由，但**不丢掉**排在后面的那一次（TASK-103 批次 D / TASK-087 §5.6）。
//
// `honourAddress` 有一个 `routeApplying` 闩，它解决的是真问题：一次后退会同时
// 触发 `popstate` 与 `hashchange`，重复应用会重绘、并把「有未保存的修改，确定
// 离开？」问两遍。
//
// 但它的做法是**丢弃**：在制中到达的事件直接 return。快速连按前进/后退时，
// 第二次按下就这么没了 —— 地址栏停在第二个位置，界面停在第一个，然后结尾的
// `writeUrl()` 把地址改回界面所在处。屏幕与地址最终一致（所以这条一直是 P3），
// 但**创作者按下的那一次什么都没发生，且没有任何提示**。
//
// 这里把「丢弃」换成「合并」：在制中到达的事件只记一个标记，当前这次跑完后再
// 跑一次。多次到达合并成一次 —— 要去的是**最后**那个地址，中间那些是路过。
//
// 为什么单独成模块：`honourAddress` 住在入口编排层 `app.js` 里，`.test.mjs`
// import 不到它，于是这个闩的行为在前端侧没有可执行落点。把它抽出来之后，闩
// 本身可以被完整驱动（含重入、异常、连续合并），app.js 只剩接线。

/**
 * 包一个异步动作，使它同一时刻只跑一个实例。
 *
 * @param {(payload:any) => Promise<void>} run 真正的动作。
 * @returns {{trigger: (payload?:any) => Promise<void>, busy: () => boolean, pending: () => boolean}}
 *
 * **闩记住的是最后那个 payload，不是一个布尔**（codex 轮 1，P1）。
 * 第一版让补跑自己去读 `window.location.hash`，理由是「要去的是最后那个地址」。
 * 那个理由对，但那个做法错：第一次导航跑完时会调 `writeUrl()` 把地址**规范回**
 * 它自己所在的位置，于是补跑读到的是被改回去的旧地址，`sameRoute` 直接短路 ——
 * 快速连按的最后一次仍然静默丢失，只是丢在了更靠后的地方。
 *
 * 所以事件到达的那一刻就把地址取下来交给闩；多次到达后写覆盖前写，最终跑的
 * 仍然是**最后**那一个，而它不再依赖跑的时候地址栏还是不是那个值。
 */
export function createRouteLatch(run) {
  let running = false;
  let queued = false;
  let queuedPayload;

  async function trigger(payload) {
    if (running) {
      // 合并，不丢弃。后写覆盖前写 —— 中间那些地址是路过，要去的是最后一个。
      queued = true;
      queuedPayload = payload;
      return;
    }
    running = true;
    // 错误先接住再排空，**而不是**用 try/finally 直接抛出去：一次失败的导航
    // 不该顺手把排在后面的那一次也丢掉 —— 那正是本模块要消除的丢弃行为，只是
    // 换了个触发条件。排空之后原样抛，调用方看到的仍是第一次的那个错误。
    let failure = null;
    try {
      await run(payload);
    } catch (e) {
      failure = e;
    }
    running = false;
    // 排在后面的那一次在 `running` 落回 false **之后**才跑，否则它会看见
    // `running === true` 又把自己排一遍，成了永远排不空的队。
    if (queued) {
      const next = queuedPayload;
      queued = false;
      queuedPayload = undefined;
      await trigger(next);
    }
    if (failure) throw failure;
  }

  return {
    trigger,
    busy: () => running,
    pending: () => queued,
  };
}

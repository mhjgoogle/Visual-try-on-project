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
 * @param {() => Promise<void>} run 真正的动作。**它自己负责去读当前地址** ——
 *        闩不缓存参数，因为合并之后要去的是最后那个地址，缓存第一次的参数正是
 *        它要消除的那种「按了但没反应」。
 * @returns {{trigger: () => Promise<void>, busy: () => boolean, pending: () => boolean}}
 */
export function createRouteLatch(run) {
  let running = false;
  let queued = false;

  async function trigger() {
    if (running) {
      // 合并，不丢弃。多次到达只排一次 —— 中间那些地址是路过。
      queued = true;
      return;
    }
    running = true;
    // 错误先接住再排空，**而不是**用 try/finally 直接抛出去：一次失败的导航
    // 不该顺手把排在后面的那一次也丢掉 —— 那正是本模块要消除的丢弃行为，只是
    // 换了个触发条件。排空之后原样抛，调用方看到的仍是第一次的那个错误。
    let failure = null;
    try {
      await run();
    } catch (e) {
      failure = e;
    }
    running = false;
    // 排在后面的那一次在 `running` 落回 false **之后**才跑，否则它会看见
    // `running === true` 又把自己排一遍，成了永远排不空的队。
    if (queued) {
      queued = false;
      await trigger();
    }
    if (failure) throw failure;
  }

  return {
    trigger,
    busy: () => running,
    pending: () => queued,
  };
}

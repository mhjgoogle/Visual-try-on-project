// 接回还没完事的那一轮 —— 恢复这件事本身的决策与顺序（TASK-106 / ADR-0095）。
//
// WHY IT LIVES HERE AND NOT IN THE SHELL. 这段逻辑原来长在 `ui/production.js` 的一个
// 闭包里，于是它**只能被源码断言测**：拿不到它，就没法真的跑一遍「后端答不上来时
// 屏幕上说什么」。而这条链上每一个错误都是**静默**的（改动丢了、任务看起来没在跑），
// 静默缺陷恰恰是最需要被真的跑一遍的那种。
//
// 依赖全部由调用方注入（读运行状态、落地、报状态、认领），所以这里没有 fetch、
// 没有 DOM、没有时钟 —— 一个测试可以让「问不到」真的发生。
//
// 顺序是有意的，三步各自防一件事：
//
//   1. 认领（claim）在 await **之前** —— `ensureConversation` 每次渲染后都会跑，
//      两次恢复同一轮会轮询两遍、落地两遍。
//   2. 问一次运行状态 —— 线程只带回**问题**，「它还在做吗」只有后端知道。
//   3. 落地，无论终态还是在跑 —— 见 ADR-0095 决策 2：终态不是「没事可做」。

/**
 * Recover one thread's unfinished run.
 *
 * @param {object} deps
 * @param {string} deps.project     which project's runs to ask about (required by the
 *                                  route on purpose: 「没有项目就是全部」 is how one
 *                                  project's board shows another's runs)
 * @param {string[]|object[]} deps.turns  the thread as just read
 * @param {function} deps.pendingRunIdIn  which run is unfinished (pure, from the thread)
 * @param {function} deps.resumePlan      "land" | "unknown", from the run status
 * @param {function} deps.readRun         (project, runId) → run | null
 * @param {function} deps.land            (runId) → Promise — wait, refresh, apply, receipt
 * @param {function} deps.claim           (runId) → boolean; false = somebody already has it
 * @param {function} deps.onStatus        (status) → void; what the column shows
 *
 * @returns {Promise<{action: "none"|"claimed"|"unknown"|"landed", runId: string|null}>}
 *          `action` is returned rather than inferred by the caller so a test can assert
 *          WHICH of the four things happened — 「什么都没做」 and 「问不到」 look the
 *          same on a screen that is not looking carefully, and that is the bug.
 */
export function resumeThreadRun({
  project,
  turns,
  pendingRunIdIn,
  resumePlan,
  readRun,
  land,
  claim,
  onStatus,
}) {
  const runId = project ? pendingRunIdIn(turns) : null;
  if (!runId) return Promise.resolve({ action: "none", runId: null });
  // CLAIM BEFORE THE AWAIT — see note 1 above.
  if (claim && claim(runId) === false) {
    return Promise.resolve({ action: "claimed", runId });
  }
  return Promise.resolve(readRun(project, runId)).then(
    (run) => {
      if (resumePlan(run) === "unknown") {
        // 问不到 ≠ 没在跑。Saying 「没在跑」 is the dishonest answer that lets a
        // creator start a second copy of a task that is still running.
        if (onStatus) onStatus("unknown");
        return { action: "unknown", runId };
      }
      if (onStatus) onStatus(run.status);
      return Promise.resolve(land(runId)).then(() => ({ action: "landed", runId }));
    },
    () => {
      // A THROWN read is the same fact as a null one: we could not ask.
      if (onStatus) onStatus("unknown");
      return { action: "unknown", runId };
    },
  );
}

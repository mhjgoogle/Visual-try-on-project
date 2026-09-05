// 载入期间把编辑器锁住 —— 一把**只在状态变化时动手**的锁。
//
// 为什么存在：`canvasActive` 在 `enterCanvas` 开头置假、载入完才置真。重新进入项目时
// **旧界面还留在屏幕上**，那段窗口里他敲的字会写进一份马上被替换掉的文档然后丢掉
// （并行会话 2026-09-05 在旅程 e2e 里实测约 1/5 复现）。能防住的丢字不该只靠提示。
//
// 为什么单独成一个模块：上一版直接写在 `app.js` 里，于是**没法测行为** —— 守卫只能去
// 扫源码文本，而 codex 当场点了它「没有真的驱动那些顺序」。断言性质不要断言写法
// （TASK-087 §7 推论 1）：搬到这里之后，下面两种顺序都能用真调用钉住。

/** 一把锁。`getRoot()` 给出生产区根节点（可能还不存在，那就什么都不做）。 */
export function createEditLock({ getRoot, warn = () => {}, toast = null, timeoutMs = 15000 } = {}) {
  let locked = false;
  let watchdog = null;

  function apply(root, on) {
    root.classList.toggle("is-loading", on);
    root.querySelectorAll("textarea, input").forEach((el) => {
      if (on) {
        // **标记只在「进入锁定」这一次写**（codex 2026-09-05 判 P1）。
        // 上一版每次上锁都写：第二次上锁时 `readOnly` 已经是我们自己设的 true，
        // 于是被记成「原本就只读」，解锁后**本来可编辑的框永远只读**。
        if (el.readOnly) el.dataset.motvWasReadonly = "1";
        el.readOnly = true;
      } else if (el.dataset.motvWasReadonly) {
        delete el.dataset.motvWasReadonly; // 本来就只读 —— 保持只读
      } else {
        el.readOnly = false;
      }
    });
  }

  function arm() {
    clearTimeout(watchdog);
    // **锁死比丢字更糟，所以这把锁一定会自己开。** `enterCanvas` 里有 `await`，
    // 抛异常就走不到解锁那一行（还有一处「切到别的项目就 return」）。
    watchdog = setTimeout(() => {
      warn("motv: 载入迟迟没完成 —— 放开输入，避免把你锁在外面");
      set(false);
      if (toast) toast("载入没完成：已放开输入，但这时改的东西可能存不下");
    }, timeoutMs);
  }

  /** 上锁 / 解锁。**只在状态真的变化时动手** —— 这是上面那条 P1 的修法：
   *  重复上锁不重写标记，重复解锁不再放开「本来就只读」的那些。 */
  function set(next) {
    const want = !!next;
    const root = typeof getRoot === "function" ? getRoot() : null;
    if (!root) return locked;
    if (want === locked) {
      // 已经锁着又要求上锁：**不碰标记**，只把看门狗重新计时
      // （嵌套的重新进入不该让第一次的看门狗提前把人放开）。
      if (want) arm();
      return locked;
    }
    locked = want;
    if (want) arm();
    else {
      clearTimeout(watchdog);
      watchdog = null;
    }
    apply(root, want);
    return locked;
  }

  return {
    lock: () => set(true),
    unlock: () => set(false),
    isLocked: () => locked,
    /** 测试用：不等 15 秒就让看门狗跑一次。 */
    _fireWatchdog: () => {
      if (!watchdog) return false;
      clearTimeout(watchdog);
      watchdog = null;
      warn("motv: 载入迟迟没完成 —— 放开输入，避免把你锁在外面");
      set(false);
      if (toast) toast("载入没完成：已放开输入，但这时改的东西可能存不下");
      return true;
    },
  };
}

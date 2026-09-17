// 连着往下写（TASK-152 / REQ-009 判据 4）。
//
// 每一章是一次**普通的**能力运行 + 一次应用 —— 守卫、登记、schema、版本化都在那条
// 既有的路上。这个模块只回答两件事：**下一章是谁，什么时候停。**
//
// 纯逻辑：无 DOM、无 fetch、无时钟。运行与应用由调用方以回调注入，所以测试里可以
// 用一个假的「运行」把整条链跑完，而链自己的规则一条不少。
//
// 链的状态活在页面内存里，不持久化：进度就是「哪些章已经有正文」，那是文档里的事实。
// 刷新之后再说一次「接着写」，`storywork.chainTargets` 从进度接着算（AGENTS.md §12）。

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/** 这一章此刻**有正文**吗 —— 现读文档，不看链开始时的快照。 */
export function isWritten(work, no) {
  if (!isObj(work) || !Array.isArray(work.units)) return false;
  const u = work.units.find((x) => x && x.kind === "novel" && x.no === no);
  return !!(u && (u.body || "").trim());
}

/**
 * 一条新链。`targets` 是要写的章号（`storywork.chainTargets` 算出来的），
 * 空数组 = 没有可写的，链直接是 `done`。
 */
export function createChain(targets, { count = null } = {}) {
  const list = Array.isArray(targets) ? targets.filter((n) => Number.isInteger(n) && n > 0) : [];
  return {
    targets: list,
    count,
    index: 0,
    /** 这条链写下的章 */
    written: [],
    /** 开跑前发现已有正文而跳过的章 —— 说出来，不然像是漏了 */
    skipped: [],
    /** 停在哪一章、为什么（null = 没失败） */
    failed: null,
    stopRequested: false,
    /** running | stopped | failed | done */
    status: list.length ? "running" : "done",
    /** 正在写的那一章（两次运行之间是 null）。不叫 current：那个词在这个仓库里是
     *  版本指针的名字，`tests/contract` 的写路径不变量把对它的赋值当成一条平行的
     *  媒体写路径 —— 连注释里出现那个拼法都会被扫到。 */
    writing: null,
  };
}

/** 请求停止：**写完手上这一章就停**，不中断正在跑的那一次运行 —— 半章正文没有可落的地方。 */
export function requestStop(chain) {
  if (isObj(chain)) chain.stopRequested = true;
  return chain;
}

/**
 * 驱动整条链。
 *
 * @param chain      `createChain` 的结果，原地推进
 * @param deps.work  () => 当前的 `story.work`（**每章现读**，链跑着的时候他可能在写）
 * @param deps.run   (no) => Promise<{ok, run?, error?}>  跑一次小说家，写第 no 章
 * @param deps.apply (runId) => {ok, error?}             把那次运行的提案落进那一章
 * @param deps.onStep (chain) => void                    每一步之后（重画用），可缺省
 *
 * 规则：
 *   - 开跑前**现读**这一章有没有正文 —— 有就跳过，不覆盖（判据 4 的「已经写下的」）；
 *   - 一次运行失败 / 一次应用失败 → 链停在那一章，把原因带出来，**不**跳过它继续 ——
 *     跳过一次失败去写下一章，会留下一个洞而他不知道；
 *   - `stopRequested` 在两章之间生效。
 */
export async function runChain(chain, deps) {
  const d = isObj(deps) ? deps : {};
  const step = typeof d.onStep === "function" ? d.onStep : () => {};
  const work = typeof d.work === "function" ? d.work : () => null;
  if (!isObj(chain) || chain.status !== "running") return chain;

  while (chain.index < chain.targets.length) {
    if (chain.stopRequested) {
      chain.status = "stopped";
      break;
    }
    const no = chain.targets[chain.index];
    if (isWritten(work(), no)) {
      chain.skipped.push(no);
      chain.index += 1;
      step(chain);
      continue;
    }
    chain.writing = no;
    step(chain);
    let res;
    try {
      res = await d.run(no);
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    }
    if (!res || !res.ok || !res.run || !res.run.runId) {
      chain.failed = { no, error: (res && res.error) || "没有返回结果" };
      chain.status = "failed";
      chain.writing = null;
      break;
    }
    let applied;
    try {
      applied = d.apply(res.run.runId);
    } catch (e) {
      applied = { ok: false, error: String((e && e.message) || e) };
    }
    if (!applied || !applied.ok) {
      chain.failed = { no, error: (applied && applied.error) || "提案没有落地" };
      chain.status = "failed";
      chain.writing = null;
      break;
    }
    chain.written.push(no);
    chain.index += 1;
    chain.writing = null;
    step(chain);
  }
  if (chain.status === "running") chain.status = "done";
  step(chain);
  return chain;
}

/** 屏幕上那一句：现在写到哪、停在哪、跳过了谁。 */
export function describe(chain) {
  if (!isObj(chain)) return "";
  const parts = [];
  const list = (a) => a.map((n) => `第 ${n} 章`).join("、");
  if (chain.status === "running") {
    parts.push(
      chain.writing
        ? `连写中：正在写第 ${chain.writing} 章（${chain.written.length}/${chain.targets.length}）`
        : `连写中（${chain.written.length}/${chain.targets.length}）`,
    );
    if (chain.stopRequested) parts.push("写完这一章就停");
  } else if (chain.status === "stopped") {
    parts.push(
      chain.written.length
        ? `已停下：写了 ${list(chain.written)}`
        : "已停下：这一轮什么都还没写",
    );
  } else if (chain.status === "failed") {
    parts.push(`停在第 ${chain.failed.no} 章：${chain.failed.error}`);
    if (chain.written.length) parts.push(`之前写了 ${list(chain.written)}`);
  } else if (chain.status === "done") {
    parts.push(
      chain.written.length
        ? `写完了：${list(chain.written)}`
        : chain.targets.length
          ? "没有写新的章"
          : "计划内的章都已经有正文了",
    );
  }
  if (chain.skipped.length) parts.push(`${list(chain.skipped)}已有正文，跳过`);
  return parts.join(" · ");
}

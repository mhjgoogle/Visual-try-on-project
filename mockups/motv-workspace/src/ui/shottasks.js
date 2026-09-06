// 「这个镜头的任务」那一块 —— 任务行 + 每行下面的生成记录。
//
// 为什么单独成一个模块：它原来是 `production.js` 里的闭包 `shotTaskRows`，于是
// **没法驱动**。我给它接上「生成记录」之后写了一条守卫，把入口拆掉那条守卫却照样
// 绿 —— 因为它断言的是「有没有 import」和测试自己搭的组合，不是真渲染出来的那一页。
// 这是今天第二次犯同一个毛病（第一次是那条自己实现了一遍判断的守卫），所以这次
// 把可测性一起做掉：断言性质不要断言写法。
//
// 「生成记录」为什么必须挂在这里：IA §6.3 把 Skill / Skill 版本 / Runtime /
// Executor / Model 从主界面移走，原话是「moved here」不是 erased，而在此之前
// `ui/genrecord.js` 在 `src/` 里**零 importer** —— 那个 here 谁也到不了
// （TASK-087 §5.13）。更重的是 `production.js` 里那段注释：运行记录框被删掉的
// 理由写的正是「能力运行仍可在生成记录里读到」——**一个界面被删的理由，依赖于
// 一个不存在的地方**。
import { taskRowModel, renderTaskRows } from "./taskrow.js";
import { genRecord } from "./genrecord.js";

/** 最多显示几条 —— 这里要的是「最近发生了什么」，不是一份全量日志。 */
const MAX_ROWS = 8;

/**
 * 渲染某一镜的任务块。
 *
 * @param {Array}  runs    这个项目的全部运行记录
 * @param {string} shotId  当前选中的镜头；空则整块不渲染
 * @param {object} [o]
 * @param {number} [o.nowMs]  现在几点 —— 由调用方读，好让这里保持纯函数
 */
export function renderShotTasks(runs, shotId, { nowMs = null } = {}) {
  if (!shotId) return "";
  const mine = (Array.isArray(runs) ? runs : []).filter(
    (r) => r && r.context && r.context.shotId === shotId,
  );
  const shown = mine.slice().reverse().slice(0, MAX_ROWS);
  const models = shown.map((r) => taskRowModel(r, { nowMs }));
  const byId = new Map(shown.map((r) => [r && r.runId, r]));
  return (
    `<div class="tk-block">` +
    `<div class="lab">这个镜头的任务</div>` +
    renderTaskRows(models, {
      emptyText: "这个镜头还没有发起过任务",
      // 贴着结果本身，而不是让人 navigate 到一张全集的图上去（`genrecord.js` 的原话）
      extra: (m) => genRecord({ run: byId.get(m.runId) || null }, { nowMs }),
    }) +
    `</div>`
  );
}

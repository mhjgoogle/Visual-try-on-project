// 界面上的一次写 = 动作表里的一条动作（ADR-0096 决策 1 / TASK-127）。
//
// 以前每个页面的按钮直接调 `ctx.story.*` / `ctx.bible.*` / `swork.*`，Agent 那边另有一张
// `ACTIONS` 表调同一组函数 —— 两份名单靠人眼对齐，于是「UI 有、Agent 没有」只在他撞到时
// 才被发现（TASK-126：人物 / 关系 / 场景地「只会改、不会加」）。
//
// 现在按钮也走 `runAction`：一个按钮若没有对应的动作，**它根本发不出写**；「他能点的」与
// 「它能做的」是同一张表的两次读取，由 `tests/contract/test_surface_manifest.py` 证穷尽。
//
// 一份实现，所有页面共用 —— 第二份适配器就是第二份漂移点。
import { runAction } from "../workflow/convactions.js";

/**
 * @param {object}   ctx       app ctx（`runAction` 要它落地，`persist` 要它保存）
 * @param {string}   id        `ACTIONS` 里的动作 id
 * @param {object}   args      动作参数（会经 `sanitizeArgs` 白名单）
 * @param {object}   [opts]
 * @param {Function} [opts.rerender]  落地后重画；`quiet` 时不调（打字即写不重画，光标不跳）
 * @param {boolean}  [opts.quiet]
 * @returns {{said: string, label: string}|null}  `null` = 没落下（原因已 toast）
 */
export function uiAct(ctx, id, args, { rerender = null, quiet = false } = {}) {
  if (!ctx) return null;
  let out = null;
  try {
    // origin "ui"：只有他自己点，`identityBinding` 类动作才放行（ADR-0096 决策 2）
    out = runAction(ctx, id, args, { origin: "ui" });
  } catch (err) {
    // 抛错 = 没落下。原因说出来（决策 6），不静默。
    if (ctx.toast) ctx.toast(`没改成：${(err && err.message) || err}`);
    if (rerender && !quiet) rerender();
    return null;
  }
  if (ctx.persist) ctx.persist();
  if (rerender && !quiet) rerender();
  return out;
}

// 镜头软删除 (TASK-095 §2.1 / TASK-097 批次 4B) —— **删除不抹掉记录**。
//
// AGENTS.md 第 13 条：删除做成软删除 / 移入回收区，保留历史版本。
// CLAUDE.md 决策模式：不可逆是**实现方式的缺陷**，先消除它。
//
// 形状：镜头留在原位，加一个 `deleted: { at }` 标记。判定**不在这里重写** ——
// 它是 `counts.isDeleted`，批次 0 就为此立了一处（§2.5e：两处陈述同一件事实
// 就是缺陷本身）。
//
// ─────────────────────────────────────────────────────────────────────────────
// 为什么不在 28 个消费者里各加一次过滤
//
// `draftShots` 今天有 28 个文件在读。让每个调用点自己 `filter(!isDeleted)` 正是
// §2.6.1 那条「手写的 N 项清单总会漏一项」—— 而漏掉的那一处会**显示一个已删除的
// 镜头**，或者更糟，把它算进「60 个镜头已就绪」。
//
// 所以过滤放在**镜头列表镜像的唯一出入口**（`installShotMirror`）：读到的永远是
// 存活的，回收的从 `recycled()` 单独取。28 个消费者不用改一行，而且**将来新增的
// 消费者天生就是对的**。
//
// 随之而来的真实危险，必须在同一处消除：一个「读 → map → 写回」的调用点会把
// 回收的镜头**静默丢掉**（读到的列表里没有它们）。`mergeKeepingRecycled` 就是为此
// 存在 —— 普通赋值**不可能**删掉回收区里的东西；只有显式的 `restoreShot` /
// `purgeShot` 能动它们。
// ─────────────────────────────────────────────────────────────────────────────
//
// PURE：数组进、数组出。无时钟（`at` 由调用方给）、无 DOM、无持久化。

import { isDeleted } from "./counts.js";
import { foreignReferences } from "./refscan.js";

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x : "");
const idOf = (s) => (isObj(s) ? str(s.shotId) : "");

/** 存活 / 回收两分。判定共用 `counts.isDeleted`，不新写一份。 */
export function partitionShots(shots) {
  const list = Array.isArray(shots) ? shots.filter(isObj) : [];
  return {
    live: list.filter((s) => !isDeleted(s)),
    recycled: list.filter((s) => isDeleted(s)),
  };
}

/** 打上回收标记。`at` 必须由调用方给（时钟不进纯模块）；给不出就不删 ——
 *  一条没有时间的删除记录事后无法与「谁先谁后」对齐。 */
export function softDeleteShot(shots, shotId, { at, by = null } = {}) {
  const id = str(shotId);
  const when = str(at);
  const list = Array.isArray(shots) ? shots : [];
  if (!id || !when) return { shots: list.slice(), changed: false };
  let changed = false;
  const out = list.map((s) => {
    if (idOf(s) !== id || isDeleted(s)) return s;
    changed = true;
    // 原位加标记：**顺序不动**，撤销才能回到原来的位置（§AGENTS 13 的「可回滚」
    // 不只是「数据还在」，还包括「回来之后长得一样」）。
    return { ...s, deleted: by ? { at: when, by } : { at: when } };
  });
  return { shots: out, changed };
}

/** 撤销：**删字段**，不是写 `deleted: null` —— 加法字段的反面是移除，
 *  留一个 `null` 会让「撤销过」与「从来没删过」持久成两个形状。 */
export function restoreShot(shots, shotId) {
  const id = str(shotId);
  const list = Array.isArray(shots) ? shots : [];
  if (!id) return { shots: list.slice(), changed: false };
  let changed = false;
  const out = list.map((s) => {
    if (idOf(s) !== id || !isDeleted(s)) return s;
    changed = true;
    const { deleted, ...rest } = s;
    return rest;
  });
  return { shots: out, changed };
}

/**
 * 一次赋值不得丢掉回收区。
 *
 * `next` 是调用方算出来的新列表（通常来自「读 → 改 → 写回」）。任何**只在 `prev`
 * 里、且带回收标记**的镜头都会被放回它原来的位置。
 *
 * 这不是保守，是那条过滤的代价：既然读到的列表不含回收项，写回就一定会漏掉它们。
 */
export function mergeKeepingRecycled(prev, next) {
  const before = Array.isArray(prev) ? prev.filter(isObj) : [];
  const after = Array.isArray(next) ? next.filter(isObj) : [];
  const keptIds = new Set(after.map(idOf).filter(Boolean));
  const out = after.slice();
  // 从后往前插，前面的下标才不会被前一次插入推走
  const orphans = [];
  before.forEach((s, i) => {
    const id = idOf(s);
    if (!id || keptIds.has(id) || !isDeleted(s)) return;
    orphans.push({ at: i, shot: s });
  });
  for (const { at, shot } of orphans) {
    out.splice(Math.min(at, out.length), 0, shot);
  }
  return out;
}

/**
 * 删除这一镜会影响到哪儿 —— **派生扫描，不是手写清单**（§2.6.1 的表里点名了
 * 「软删除 shot → 哪些地方引用 shotId」）。
 *
 * **这里没有 fail-closed 闸门，是有意的。** 软删除不销毁任何东西：镜头留在文档里、
 * 生成记录与资产一个不动、撤销把它原位放回。既然没有不可逆，就没有该拦的东西 ——
 * 拦一道不需要的门，只会让创作者去找绕开它的路（§2.5f 第二条同一个道理：
 * 不要把用户要做的事印成拦住他的理由）。
 *
 * 它给的是**后果清单**：删了之后这 N 处引用会指向一个已回收的镜头。创作者据此决定。
 *
 * `expectedPath` 是那条「哪里不算」的闭集，**生产与测试共用同一份**（§2.5d）：
 * 分镜草稿自己的那些位置不算外部引用，别的都算。
 */
export function ownShotDraftPath(shotId) {
  const id = str(shotId);
  return (p) => {
    const path = str(p);
    if (!id || !path) return false;
    // 草稿版本自己就是镜头的家；它当然「引用」这一镜。
    // 只认 shots/draftShots 数组下的元素本体（`…shots[3].shotId`），
    // 不放过 `…shots[3].refs[0]` 这种真正的绑定。
    return /(?:^|\.)(?:draftShots|shots|raw|rows)\[\d+\]\.shotId$/.test(path);
  };
}

export function deletionImpact(doc, shotId, isExpected = null) {
  const id = str(shotId);
  if (!id) return { shotId: "", paths: [], groups: [], total: 0 };
  const expected = typeof isExpected === "function" ? isExpected : ownShotDraftPath(id);
  const paths = foreignReferences(doc, id, expected);
  // 按顶层区域归组，让人一眼看出「时间线里有它」这种真正要紧的
  const groups = [];
  const seen = new Map();
  for (const p of paths) {
    const m = /^\$\.?([A-Za-z0-9_]+)/.exec(p);
    const area = m ? m[1] : "(其他)";
    if (!seen.has(area)) {
      const g = { area, paths: [] };
      seen.set(area, g);
      groups.push(g);
    }
    seen.get(area).paths.push(p);
  }
  return { shotId: id, paths, groups, total: paths.length };
}

/**
 * 装到项目镜像上：**读到的是存活的，回收的单独取。**
 *
 * 这是本文件头那段的落点 —— 一处决定「镜头列表是什么」，28 个消费者继承它。
 * 赋值经 `mergeKeepingRecycled`，所以一次「读 → 改 → 写回」不可能删掉回收区。
 *
 * 返回一个 `{ all, recycled, set }` 句柄，给需要看全量的地方（回收区界面、
 * 保存成新草稿版本的写路径）用。
 */
export function installShotMirror(project, initial = null) {
  let raw = Array.isArray(initial) ? initial.slice() : null;
  Object.defineProperty(project, "draftShots", {
    configurable: true,
    enumerable: true,
    get: () => (raw === null ? null : partitionShots(raw).live),
    set: (v) => {
      // `null` 是一句**明确的话**：「这个项目没有分镜草稿」。它必须做得到 ——
      // 换成 `[]` 会让「没有草稿」被读成「已知有 0 个镜头」，那正是
      // §2.5f 第一条禁止的方向（不知道 ≠ 一个数字）。
      if (v === null) {
        raw = null;
        return;
      }
      // `undefined` **不是**一句话，它是「那个属性不存在」的产物 ——
      // `project.draftShots = someMissingThing` 就会得到它。所以它绝不允许清空：
      // 一次手滑不该让回收区里的镜头永久消失（codex 本批 round 1 的 P1；
      // 本文件此前的注释写着「只有 null 才真的清空」，而代码把两者当成一回事 ——
      // 又一次「两处陈述同一件事实而没共用同一份」）。
      if (v === undefined) return;
      raw = mergeKeepingRecycled(raw, Array.isArray(v) ? v : []);
    },
  });
  return {
    all: () => (raw === null ? null : raw.slice()),
    recycled: () => (raw === null ? [] : partitionShots(raw).recycled),
    /** 全量写入（含回收项），给软删除 / 撤销这两条显式路径用。 */
    setAll: (v) => { raw = Array.isArray(v) ? v.slice() : null; },
  };
}

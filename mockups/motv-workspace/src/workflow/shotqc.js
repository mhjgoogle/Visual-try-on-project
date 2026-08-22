// 逐镜质检 —— 第 9 步 QC 从「文件在不在」升级成「对不对」
// (TASK-096 §2.4 / TASK-097 批次 5B)。
//
// 三条判据，全部**机械可查**，一条都不猜：
//
//   时长    每镜实际时长 vs 分镜表的「时长」列 —— **超差如实标出，不自动改数据**
//   缺口    哪几镜没视频 / 没配音 / 没音效 —— 取自 TASK-092 的状态，**不另算**
//   一致性  绑定的设定图**是否真的被送进那次生成** —— 查生成记录里冻结的
//           `referenceAssetIds`（`genlib.startGeneration` 在发起时就冻好了）
//
// ─────────────────────────────────────────────────────────────────────────────
// **这张卡点名的那个陷阱，就在一致性这一条上**（TASK-096 §2.4）：
//
//   「这一条只在 ADR-0071 落地后才有意义，否则它永远报『没用上』。」
//
// 所以「没有发送记录」与「记录里没有这一张」是**两个不同的答案**：
//
//   没有生成记录        → **无法判定**（可能是手工上传的视频）
//   记录里一张参考都没有 → **无法判定**（这一版生成没有留下发送记录）
//   记录里有几张，缺这张 → **不一致**（这才是一个真的发现）
//
// 把前两种读成「没用上」，就是把「我们不知道」印成「它没做」——
// 与 `counts.js` 那条「不知道 ≠ 0」同一条规矩，只是换到了判据这一端。
// ─────────────────────────────────────────────────────────────────────────────
//
// **本模块不写任何东西**（TASK-096 §2.4 末句：「QC 报告是只读判断，不修数据」）。
// 时长超差**绝不**顺手把分镜表的数字改成实测值 —— 那个数字是**创作意图**，
// 实测值是**产物**，两者不一致时该改哪一个只有创作者知道。报告给的是一条跳回去的路。
//
// **不做画面内容的自动审美判断**（明确不做，需视频理解，超出当前授权）。
//
// PURE：测量结果、状态、绑定、生成记录全部由调用方注入。没有 fetch / DOM / clock。

import { postRows, PHASE_LABEL, SETTLED_PHASES } from "./poststatus.js";
import { STAGE_LABEL } from "./shotstage.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

/** 三条判据，闭集。`severity` 只在 `fail` 时有意义。 */
export const QC_ITEMS = Object.freeze([
  { key: "duration", label: "时长", severity: "warning" },
  { key: "gaps", label: "缺口", severity: "blocking" },
  { key: "consistency", label: "一致性", severity: "warning" },
]);

/** 三值答案。`unknown` 既不是通过也不是失败 —— 它是「还答不上来」。 */
export const QC_STATES = ["pass", "fail", "unknown"];

/**
 * 时长容差，命名且可见。
 *
 * 0.5 秒：一条 6 秒的镜头剪成 5.5 或 6.5 秒，时间线还吸收得住；再多就会看出漂移。
 * 写成常量而不是字面量，因为它是一个**判据**，将来要改就该有一处可改。
 */
export const DURATION_TOLERANCE_S = 0.5;

/** 逐镜质检要看的三个 stage。`video` 在内 —— 缺口问的第一件事就是它。 */
export const QC_STAGES = ["video", "voice", "sfx"];

function row(key, state, detail, { action = null, severity = null } = {}) {
  const decl = QC_ITEMS.find((c) => c.key === key);
  return {
    key,
    label: decl ? decl.label : key,
    state,
    severity: state === "fail" ? (severity || (decl ? decl.severity : "warning")) : null,
    detail: detail || null,
    // 「现在能做什么」—— 报告只读，所以这里永远是一条**跳过去**的路，不是一次修改
    action: action || null,
  };
}

/* -------------------------------------------------------------------------- */
/* 一、时长                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 实测时长 vs 分镜表写的时长。
 *
 * `measurement`：
 *   null                      从来没测过           → 无法判定（附「去测」）
 *   { error }                 测了但没跑成          → 无法判定（附原因）
 *   { durationS }             测到了               → 比
 *
 * **「没测过」和「没跑成」是两个不同的处境**，会把创作者送到不同的地方
 * （一个是点按钮，一个是装 ffmpeg）—— 与 `runDeliveryProbe` 那条既有纪律同源。
 */
export function durationCheck(shot, measurement) {
  // 分镜表写的那个数**照原样读**。
  //
  // 本仓库别处有一句「6 或 10，其他一律当 6」（`shotaudioctl.shotDurationMs`）——
  // 那是**排音频轨**时的一个兜底，放在这里是错的：一条 8 秒的镜头会被拿去和 6 秒比，
  // 于是报出一条「差 +2.1s」的**假发现**。判据不能自己发明比较的目标；
  // 读不出目标就说读不出（codex 轮 2 的 non-blocking，真的，已修）。
  const written = isObj(shot) ? shot.duration_seconds : null;
  const nominal = Number.isFinite(written) && written > 0 ? written : null;
  if (nominal === null) {
    return row("duration", "unknown", "分镜表没写这一镜的时长 —— 没有可比的目标", {
      action: "去这一镜：在分镜表填上时长",
    });
  }
  if (!isObj(measurement)) {
    return row("duration", "unknown", `分镜表写 ${nominal}s，还没测过实际时长`, {
      action: "测这一镜的时长",
    });
  }
  if (measurement.error) {
    return row("duration", "unknown", `没测成：${measurement.error}`, { action: "再测一次" });
  }
  if (!isNum(measurement.durationS) || measurement.durationS <= 0) {
    // 探测跑完了却没有这个字段 = 这一项没测出来（server 端「测不到就不写」的约定）
    return row("duration", "unknown", "探测跑完了，但没测出时长", { action: "再测一次" });
  }
  const actual = measurement.durationS;
  const diff = Math.round((actual - nominal) * 100) / 100;
  if (Math.abs(diff) <= DURATION_TOLERANCE_S) {
    return row("duration", "pass", `实际 ${actual}s，分镜表写 ${nominal}s`);
  }
  return row(
    "duration",
    "fail",
    `实际 ${actual}s，分镜表写 ${nominal}s —— 差 ${diff > 0 ? "+" : ""}${diff}s`,
    // 该改哪一个只有创作者知道：意图错了改分镜表，产物错了重生成。
    // 报告**不动任何数据**。
    { action: "去这一镜：改分镜表的时长，或者重新生成" },
  );
}

/* -------------------------------------------------------------------------- */
/* 二、缺口                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 这一镜的 video / voice / sfx 三步里，哪些还没了结。
 *
 * **状态取自 `poststatus.postRows`**（它又取自 TASK-092 的 `stageBoard`）——
 * 本函数只会数和措辞，一个状态都不重算（TASK-096 §2.1 的守卫）。
 *
 * 「无法判定」的那些**单独说**：把它们并进「还差」就是又一次把不知道印成没做。
 */
export function gapCheck(rowsOfShot) {
  const mine = (Array.isArray(rowsOfShot) ? rowsOfShot : []).filter(isObj);
  if (!mine.length) return row("gaps", "unknown", "读不到这一镜的状态");
  const settled = mine.filter((r) => SETTLED_PHASES.includes(r.phase));
  const unknown = mine.filter((r) => r.phase === "unknown");
  const missing = mine.filter(
    (r) => !SETTLED_PHASES.includes(r.phase) && r.phase !== "unknown",
  );
  if (settled.length === mine.length) {
    return row("gaps", "pass", `${mine.map((r) => r.stageLabel).join(" · ")} 都已了结`);
  }
  const say = (list) => list.map((r) => `${r.stageLabel}（${PHASE_LABEL[r.phase]}）`).join(" · ");
  if (!missing.length) {
    // 全部差在「不知道」上 —— 那不是一个缺口的清单，是一个还没被回答的问题
    return row("gaps", "unknown", `${say(unknown)}`, { action: "去这一镜决定要不要做" });
  }
  return row(
    "gaps",
    "fail",
    `还差 ${say(missing)}` + (unknown.length ? `；另有 ${say(unknown)}` : ""),
    { action: "去这一镜" },
  );
}

/* -------------------------------------------------------------------------- */
/* 三、一致性                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 绑定的设定图，**有没有真的被送进那一次生成**。
 *
 * `bound`      这一镜绑定的参考：`[{ assetId, name }]`
 * `generation` 产出**当前那条视频**的那条生成记录，或 null。
 *              它的 `referenceAssetIds` 是 `genlib.startGeneration` 在**发起时**
 *              冻结的，所以它就是「当时真的送了什么」。
 *
 * 三个答案，界限写死在下面的注释里 —— 这是本卡点名的那个陷阱。
 */
export function consistencyCheck({ bound = [], generation = null } = {}) {
  const want = (Array.isArray(bound) ? bound : []).filter(
    (b) => isObj(b) && typeof b.assetId === "string" && b.assetId,
  );
  if (!want.length) {
    return row("consistency", "unknown", "这一镜没有绑定任何设定图 —— 没有可核对的东西", {
      action: "去这一镜绑定角色 / 场景的设定图",
    });
  }
  if (!isObj(generation)) {
    // 手工上传的视频、或者还没生成 —— **不是**「没用上」
    return row("consistency", "unknown", "这一版视频没有对应的生成记录（可能是手工放进来的）");
  }
  const sent = Array.isArray(generation.referenceAssetIds)
    ? generation.referenceAssetIds.filter((x) => typeof x === "string" && x)
    : [];
  if (!sent.length) {
    // 记录在，但一张参考都没记 —— 分不清「真的一张没送」和「这一版没记这件事」。
    // 印「没用上」就是把不知道说成没做（TASK-096 §2.4 点名的那条）。
    return row("consistency", "unknown", "这一版生成没有留下参考发送记录，无法判定");
  }
  const set = new Set(sent);
  const absent = want.filter((b) => !set.has(b.assetId));
  if (!absent.length) {
    return row("consistency", "pass", `绑的 ${want.length} 张都在这次生成里`);
  }
  return row(
    "consistency",
    "fail",
    `${absent.map((b) => b.name || b.assetId).join(" · ")} 没有进这一次生成`
    + `（这次送了 ${sent.length} 张）`,
    { action: "去这一镜：确认绑定，然后重新生成" },
  );
}

/* -------------------------------------------------------------------------- */
/* 报告                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 一集的逐镜质检报告。
 *
 * 注入：
 *   shots        存活的镜头
 *   boardOf(id)  `shotstage.stageBoard` —— 状态的唯一来源
 *   boundOf(id)  这一镜绑定的设定图 `[{assetId,name}]`
 *   genOf(id)    产出当前那条视频的生成记录，或 null
 *   measureOf(id)时长测量结果，或 null（没测过）
 *
 * `passed` 在**还有 unknown 时为 false** —— 与交付质检同一条纪律：
 * 未检查不是通过。但它**不拦任何东西**：这份报告是只读判断，没有闸门。
 */
export function shotQcReport({
  shots, boardOf, boundOf, genOf, measureOf, needOf,
} = {}) {
  const bound = typeof boundOf === "function" ? boundOf : () => [];
  const gen = typeof genOf === "function" ? genOf : () => null;
  const measure = typeof measureOf === "function" ? measureOf : () => null;
  const all = postRows(shots, { boardOf, needOf, stages: QC_STAGES });
  const byShot = new Map();
  for (const r of all) {
    if (!byShot.has(r.shotId)) byShot.set(r.shotId, []);
    byShot.get(r.shotId).push(r);
  }
  const rows = [];
  for (const shot of Array.isArray(shots) ? shots.filter(isObj) : []) {
    const shotId = typeof shot.shotId === "string" ? shot.shotId : "";
    if (!shotId) continue;
    const checks = [
      durationCheck(shot, measure(shotId)),
      gapCheck(byShot.get(shotId) || []),
      consistencyCheck({ bound: bound(shotId), generation: gen(shotId) }),
    ];
    rows.push({
      shotId,
      seq: Number.isFinite(shot.sequence) ? shot.sequence : null,
      title: (typeof shot.title === "string" && shot.title.trim()) || shotId,
      checks,
      fails: checks.filter((c) => c.state === "fail").length,
      unknowns: checks.filter((c) => c.state === "unknown").length,
    });
  }
  return { rows, summary: qcSummary(rows), ...verdict(rows) };
}

/** 每一条判据一行的汇总：多少镜通过 / 多少镜有发现 / 多少镜答不上来。 */
export function qcSummary(rows) {
  const all = Array.isArray(rows) ? rows.filter(isObj) : [];
  const out = {};
  for (const item of QC_ITEMS) {
    const cells = all.map((r) => (r.checks || []).find((c) => c.key === item.key)).filter(isObj);
    const by = { pass: 0, fail: 0, unknown: 0 };
    for (const c of cells) if (c.state in by) by[c.state] += 1;
    out[item.key] = {
      key: item.key,
      label: item.label,
      known: cells.length > 0,
      total: cells.length,
      by,
      text: cells.length
        ? `${item.label}：${[
          by.fail ? `${by.fail} 镜有发现` : "",
          by.pass ? `${by.pass} 镜通过` : "",
          by.unknown ? `${by.unknown} 镜无法判定` : "",
        ].filter(Boolean).join(" · ")}`
        : `${item.label}：还没有镜头可判`,
    };
  }
  return out;
}

function verdict(rows) {
  const all = Array.isArray(rows) ? rows.filter(isObj) : [];
  const fails = all.reduce((n, r) => n + (r.fails || 0), 0);
  const unknowns = all.reduce((n, r) => n + (r.unknowns || 0), 0);
  return {
    fails,
    unknowns,
    // 未检查不是通过（交付质检同一条）。而它不拦任何东西 —— 只读。
    passed: all.length > 0 && fails === 0 && unknowns === 0,
    line: !all.length
      ? "这一集还没有镜头可判"
      : `${all.length} 镜：${fails} 条发现`
        + (unknowns ? ` · ${unknowns} 条无法判定` : "")
        + (fails === 0 && unknowns === 0 ? " —— 三条判据全过" : ""),
  };
}

/** 只列**有话说**的那些镜头（有发现或答不上来）—— 60 行全绿的表没人会看。 */
export function interesting(rows) {
  return (Array.isArray(rows) ? rows.filter(isObj) : []).filter(
    (r) => (r.fails || 0) > 0 || (r.unknowns || 0) > 0,
  );
}

/** 三个 stage 的中文名，供界面用 —— 与状态那一份同源，不另写。 */
export const QC_STAGE_LABEL = Object.fromEntries(
  QC_STAGES.map((s) => [s, STAGE_LABEL[s] || s]),
);

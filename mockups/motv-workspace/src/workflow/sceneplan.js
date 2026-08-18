// 分镜表按 Scene 分组 (TASK-095 §2.1.1 / TASK-097 批次 4B)。
//
// 产品负责人要的形态：
//
//   ▼ Scene 01 ｜ 金銮殿 ｜ 白天
//       Shot 01 …
//   ▼ Scene 02 ｜ 便利店外 ｜ 夜
//
// **Scene 是分组行，不是每行重复的一列。** 这一条同时治 GAP-13（真实项目 48 集
// 全部 0 场景、60 个镜头全在「未分配到场景」）：TASK-091 §1.2 想把「拆场景」做成
// 一个显式步骤，而**分组行本身就迫使 Scene 存在** —— 表要分组就必须有组。少一步，
// 效果更强。
//
// 三条硬纪律：
//
// 1. **`S01` 这个编号是派生的，不存。** 存了就会与 `shotIds` 的顺序打架，
//    而那是 §2.5e 那张表的又一行（两处陈述同一件事实）。
// 2. **`timeOfDay` 缺失就显示空，不猜、不填默认值。** 老数据没有这个字段是常态；
//    给它编一个「白天」等于替创作者做了一个他没做的决定。
// 3. **「未分配到场景」是一个如实的分组，不是一个错误。** 它必须能被看见、
//    能就地把镜头放进某个场景 —— 否则那 60 个镜头永远出不来。
//
// PURE：只读文档，返回模型。无 DOM、无写入、无时钟。

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x : "");

/** 时间的常用值。**只是输入建议，不是闭集** —— 存的是自由文本（「黄昏」「雨夜」
 *  都是合法的场景时间），所以这里不做校验，只帮创作者少打字。 */
export const TIME_OF_DAY_HINTS = ["白天", "夜", "清晨", "黄昏", "深夜", "室内日", "室内夜"];

/** 存进文档前的规整：去空白；空串**删字段**而不是存 `""`。
 *  与 `normalizeShots` 同一姿态：「清空时间」与「从来没填过时间」必须持久成同一形状，
 *  否则两个看起来一样、实际不同的形状会在下游分叉。 */
export function normalizeTimeOfDay(v) {
  const t = str(v).trim();
  return t ? t : null;
}

/**
 * 分组。**派生自 `prod` 里 scene 的 `shotIds`**，不在 shot 上存 sceneId ——
 * 归属只有一份（`sanitizeScene` 已经保证一个 shot 至多属于一个 scene）。
 *
 * 返回的每一组都带 `seq`（1 起，派生）、`title`、`timeOfDay`、`shots`。
 * 末尾**总是**有一个 `unassigned` 组的位置：它有镜头时出现，没有时不出现 ——
 * 不打印一个空的「未分配到场景（0）」去训人。
 */
export function groupShotsByScene({ prod, episodeId, shots } = {}) {
  const list = Array.isArray(shots) ? shots.filter(isObj) : [];
  const episodes = isObj(prod) && Array.isArray(prod.episodes) ? prod.episodes : [];
  const ep = episodeId
    ? episodes.find((e) => isObj(e) && e.episodeId === episodeId) || null
    : null;
  const scenes = ep && Array.isArray(ep.scenes) ? ep.scenes.filter(isObj) : [];
  const byId = new Map();
  for (const s of list) {
    const id = str(s.shotId);
    if (id && !byId.has(id)) byId.set(id, s);
  }
  const claimed = new Set();
  const groups = scenes.map((sc, i) => {
    const mine = [];
    for (const id of Array.isArray(sc.shotIds) ? sc.shotIds : []) {
      const shot = byId.get(str(id));
      // A scene may name a shot this episode's draft no longer has (an older
      // draft version had it). That is not an error to shout about — it is
      // simply not a row. But it must NOT be counted as claimed either, or
      // 「这个 scene 有 3 镜」 would disagree with the 2 rows underneath it.
      if (!shot) continue;
      claimed.add(str(id));
      mine.push(shot);
    }
    return {
      sceneId: sc.sceneId,
      seq: i + 1,
      title: str(sc.title),
      // 缺就是空。见文件头第 2 条。
      timeOfDay: str(sc.timeOfDay),
      shots: mine,
      unassigned: false,
    };
  });
  const rest = list.filter((s) => !claimed.has(str(s.shotId)));
  if (rest.length) {
    groups.push({
      sceneId: null,
      seq: null,
      title: "未分配到场景",
      timeOfDay: "",
      shots: rest,
      unassigned: true,
    });
  }
  return groups;
}

/**
 * 分组行上那一行字：`S01 ｜ 便利店外 ｜ 夜`。
 *
 * **缺的段落整段省略**，不打印 `S01 ｜ ｜`，也不打印「（未命名）｜（未填时间）」——
 * 那种括号提示每一行都在训人，094 已经为它付过一次代价（每行都写着
 * 「0 条 · 少于建议的 3～6 条」）。
 */
export function sceneLabel(g) {
  if (!isObj(g)) return "";
  if (g.unassigned) return `未分配到场景（${g.shots.length}）`;
  const parts = [`S${String(g.seq).padStart(2, "0")}`];
  if (g.title) parts.push(g.title);
  if (g.timeOfDay) parts.push(g.timeOfDay);
  return parts.join(" ｜ ");
}

/** 「把这一镜放进哪个场景」的可选项。派生，且**不含它当前所在的那个**。 */
export function sceneTargets({ prod, episodeId, currentSceneId = null } = {}) {
  const groups = groupShotsByScene({ prod, episodeId, shots: [] });
  return groups
    .filter((g) => !g.unassigned && g.sceneId !== currentSceneId)
    .map((g) => ({ sceneId: g.sceneId, label: sceneLabel(g) }));
}

/**
 * 这一集的场景健康度 —— 供第 ① 步如实说话。
 *
 * **`unassigned` 是「待办」，不是「阻塞」**（§2.5f 第二条）：60 个镜头没分场景
 * 的确是要做的活，但它不该拦住创作者进第 ① 步 —— 第 ① 步正是做这件事的地方。
 * 所以这里返回的是数字与话术，**不返回 blockers**。
 */
export function sceneCoverage({ prod, episodeId, shots } = {}) {
  const groups = groupShotsByScene({ prod, episodeId, shots });
  const real = groups.filter((g) => !g.unassigned);
  const un = groups.find((g) => g.unassigned);
  const unassigned = un ? un.shots.length : 0;
  const noTime = real.filter((g) => !g.timeOfDay).length;
  return {
    scenes: real.length,
    unassigned,
    noTime,
    // 待办，不是阻塞
    todo: [
      unassigned ? `${unassigned} 个镜头还没分到场景` : "",
      real.length && noTime ? `${noTime} 个场景还没写时间（白天 / 夜）` : "",
    ].filter(Boolean),
  };
}

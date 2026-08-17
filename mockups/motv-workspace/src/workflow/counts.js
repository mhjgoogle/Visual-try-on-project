// 剧集制作的计数 (TASK-097 §2.5 / §2.6.2) — 每个数字**一处派生，全部消费者共用**。
//
// 「14 个镜头已就绪」「0/10 已生成、还差 10 个」「1/14 已合成」 —— 向导顶部那三行是
// 产品负责人指名要的（TASK-095 §1）。它们看起来是三个字符串，实际上是这条链最容易
// 出错的三个地方，原因有两个，而且两个都在本仓库发生过：
//
//   §2.5   计数必须来自实际登记表，不查清单上的空。
//          前车之鉴：`storageState` 声明「文件在」而从不核对，存储页因此报
//          「媒体不可用 0」——一个从未被验证过的声明被当成事实显示了很久。
//
//   §2.6.2 每个计数都有**多个消费者**，改一个其余继续说谎。
//          实测：TASK-094 把分集规划页改成显示 16 之后，rail 徽章、「共 48 集」、
//          EPISODES 列表、Director **四处仍然显示 48**。这与审计 GAP-06
//          （目标 24 / 规划 12 / 实体 48 三个数字互不校验）是同一个形状。
//
// 所以计数在这里**登记**：一个 id、一段派生、一句显示文本。消费者只准调
// `productionCounts()` 并打印 `text`，不准自己拼。守卫测试按登记表的 `units` 派生出
// 一条扫描规则去找「谁在自己数」（tests/counts.test.mjs），因此**新增一个消费者会被
// 自动抓到**——这正是 2.6.1 说的「要派生，不要手写」。
//
// 「不知道」是一等答案。一个还没有登记表可查的计数返回 `known: false` 并显示 「—」，
// **不显示 0**。0 是一个断言（「一个都没有」），而我们此刻没有资格做这个断言 ——
// TASK-096 §5 对「参考图有没有真的被送出去」下的也是同一条规矩。
//
// PURE. 全部输入由调用方给出，没有 fetch / DOM / clock / 写入。

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/** 「—」 —— 我们还答不上来。与 0 严格区分。 */
export const UNKNOWN = "—";

/**
 * 这条链引入的全部计数，闭集。
 *
 * `units` 是守卫扫描的原料：它派生出「什么样的写法算作在自己数数」。新增一个计数就
 * 自动扩大扫描面，不需要谁记得去改测试。
 */
export const PRODUCTION_COUNTS = [
  {
    id: "shotsReady",
    label: "镜头已就绪",
    units: ["个镜头已就绪"],
    /** 第 ① 步：分镜表里**没有被软删除**的镜头数。查的是镜头登记表本身。 */
    derive: (s) => {
      if (!Array.isArray(s.shots)) return { known: false };
      const live = s.shots.filter((x) => isObj(x) && !isDeleted(x));
      return { known: true, value: live.length, total: live.length };
    },
    text: (c) => (c.known ? `${c.value} 个镜头已就绪` : `${UNKNOWN} 个镜头已就绪`),
  },
  {
    id: "assetsReady",
    label: "设定图已生成",
    units: ["已生成 · 差", "个设定图"],
    /**
     * 第 ② 步：**实际有参考图的实体 / 分镜点到的实体**。
     *
     * `readiness` 由 `shotentity.assetReadiness` 产出，而它的 `ready` 逐个问
     * 「这个实体真的有参考图吗」——查登记表，不查清单上的空。这里只负责把它变成
     * 一句话，绝不重算。
     */
    derive: (s) => {
      const r = s.assetReadiness;
      if (!isObj(r) || !Number.isInteger(r.total)) return { known: false };
      return { known: true, value: r.ready || 0, total: r.total, missing: r.total - (r.ready || 0) };
    },
    text: (c) => (c.known
      ? `${c.value}/${c.total} 已生成 · 差 ${c.missing} 个`
      : `${UNKNOWN} 已生成`),
  },
  {
    id: "promptsComposed",
    label: "提示词已合成",
    units: ["已合成"],
    /** 第 ③ 步：**两份提示词都编译出来**的镜头数（TASK-095 §2.3.1）。
     *  只有一份的不算已合成——那正是「运镜进了出图提示词」那类错误的温床。 */
    derive: (s) => {
      if (!Array.isArray(s.shots)) return { known: false };
      const live = s.shots.filter((x) => isObj(x) && !isDeleted(x));
      if (typeof s.promptsOf !== "function") return { known: false };
      const done = live.filter((x) => {
        const p = s.promptsOf(x.shotId);
        return isObj(p) && !!p.image && !!p.video;
      });
      return { known: true, value: done.length, total: live.length };
    },
    text: (c) => (c.known ? `${c.value}/${c.total} 已合成` : `${UNKNOWN} 已合成`),
  },
  {
    id: "storyboardPassed",
    label: "草图已通过",
    units: ["草图已通过"],
    /** 第 ④ 步。**跳过也算这一步已了结**（轻量模式），但它与「通过」分开计，
     *  因为界面必须能区分「他决定不画」和「他还没画」（TASK-092 §2.2）。 */
    derive: (s) => stageCount(s, "storyboardStatus"),
    text: (c) => (c.known
      ? `${c.value}/${c.total} 草图已通过${c.skipped ? ` · ${c.skipped} 镜跳过` : ""}`
      : `${UNKNOWN} 草图已通过`),
  },
  {
    id: "keyframePassed",
    label: "关键帧已就绪",
    units: ["关键帧已就绪"],
    derive: (s) => stageCount(s, "keyframeStatus"),
    text: (c) => (c.known
      ? `${c.value}/${c.total} 关键帧已就绪`
      : `${UNKNOWN} 关键帧已就绪`),
  },
  {
    id: "videoDone",
    label: "视频已完成",
    units: ["视频已完成"],
    derive: (s) => stageCount(s, "videoStatus"),
    text: (c) => (c.known ? `${c.value}/${c.total} 视频已完成` : `${UNKNOWN} 视频已完成`),
  },
];

const BY_ID = new Map(PRODUCTION_COUNTS.map((c) => [c.id, c]));

/** 软删除的镜头不参与任何计数，但**记录仍在**（AGENTS.md 第 13 条）。
 *  判定写在一处：如果每个计数各写一遍 `!x.deletedAt`，删除语义一变就得改六处。 */
export function isDeleted(shot) {
  return !!(isObj(shot) && isObj(shot.deleted) && shot.deleted.at);
}

/** 六个 stage 里某一个的完成计数。`stageOf(shotId)` 由 TASK-092 那一份状态提供 ——
 *  **不重算**（§2.4：状态只有一份，本模块是它的读者）。 */
function stageCount(s, field) {
  if (!Array.isArray(s.shots) || typeof s.stageOf !== "function") return { known: false };
  const live = s.shots.filter((x) => isObj(x) && !isDeleted(x));
  let value = 0;
  let skipped = 0;
  for (const shot of live) {
    const st = s.stageOf(shot.shotId);
    const v = isObj(st) ? st[field] : null;
    if (v === "completed") value += 1;
    else if (v === "skipped") skipped += 1;
  }
  return { known: true, value, total: live.length, skipped };
}

/**
 * 全部计数，一次算完。
 *
 * `sources`:
 *   shots           镜头登记表（含软删除标记）
 *   assetReadiness  shotentity.assetReadiness() 的产出
 *   promptsOf(id)   → { image: bool, video: bool }
 *   stageOf(id)     → TASK-092 的六个 stage
 *
 * 缺哪一项，对应的计数就 `known: false` —— 不猜、不填 0。
 */
export function productionCounts(sources = {}) {
  const s = isObj(sources) ? sources : {};
  const out = {};
  for (const c of PRODUCTION_COUNTS) {
    const derived = c.derive(s) || { known: false };
    const entry = { id: c.id, label: c.label, known: !!derived.known, ...derived };
    entry.text = c.text(entry);
    out[c.id] = entry;
  }
  return out;
}

/** 一个计数的显示文本。消费者只准用这个 —— 自己拼字符串就是 §2.6.2 那个 16/48。 */
export function countText(id, counts) {
  const c = isObj(counts) ? counts[id] : null;
  if (c && typeof c.text === "string") return c.text;
  const def = BY_ID.get(id);
  return def ? def.text({ known: false }) : UNKNOWN;
}

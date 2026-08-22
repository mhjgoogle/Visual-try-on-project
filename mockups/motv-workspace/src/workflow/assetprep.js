// 第 ② 步「准备资产」的读模型 (TASK-095 §2.2 / TASK-097 批次 4C)。
//
// 产品负责人给的形态（图 3）：顶部一块**全局风格**长文本；下面按
// **角色 / 场景 / 道具**分组的卡片，每张是「生成或上传设定图」+ 名称 + 描述摘要，
// 末位一个「＋ 新增」；底部如实提示
// **「检测到 5 个人物角色和 3 个场景和 2 个道具没有设定图」**。
//
// ─────────────────────────────────────────────────────────────────────────────
// 三条本链硬规则在这个模块里的落点
//
// 1. **那句「还差几个」是待办，不是阻塞**（§2.5f 第二条）。第 ② 步的全部工作就是
//    补设定图；把「还差 5 个」做成一道拦住第 ② 步的门，等于界面在拦住它请创作者
//    做的事。所以本模块**不返回 blockers**，只返回数字与话术。
//    （第 ③ 步能不能开始，由 `prodwizard.stepReadiness` 一处决定。）
//
// 2. **计数走 `counts` / `shotentity`，不在这里重新数**（§2.5c / §2.6.2）。
//    「M 个实体、N 个已有设定图」由 `assetReadiness` 给出；本模块只把同一份结果
//    **按 kind 分组**用于话术 —— 分组是对同一份数据的重排，不是第二次计数。
//
// 3. **「AI 抽出的清单」与「登记表里的实体」是一条缝**（§2.5e）。抽取说要 8 个角色，
//    登记表里 5 个 —— 这是两处在陈述同一件事实。`reconcile()` 把两边放在一个
//    模型里算，于是它们不可能各自显示一个数字。
// ─────────────────────────────────────────────────────────────────────────────
//
// PURE：读文档、返回模型。无 DOM、无写入、无时钟。

import { assetReadiness, buildEntityIndex } from "./shotentity.js";
import { normName } from "./breakdown.js";

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x.trim() : "");

/** 三类，闭集，按产品负责人给的顺序。`word` 用于那句缺口话术。 */
export const PREP_KINDS = [
  { kind: "character", word: "人物角色", label: "角色", collection: "characters", idKey: "characterId" },
  { kind: "location", word: "场景", label: "场景", collection: "locations", idKey: "locationId" },
  { kind: "prop", word: "道具", label: "道具", collection: "props", idKey: "propId" },
];

const KIND_BY = new Map(PREP_KINDS.map((k) => [k.kind, k]));

/** 一张卡片的描述摘要。**不编**：没有描述就是空，由界面显示「还没写描述」。 */
function summaryOf(entity) {
  const p = isObj(entity) && isObj(entity.profile) ? entity.profile : {};
  return str(p.description) || str(p.appearance) || str(p.visualInstruction) || "";
}

/**
 * 三组卡片。
 *
 * `hasReferenceImage(kind, id)` 由调用方注入 —— 与 `assetReadiness` 用的是
 * **同一个判断**（`ui/storyboard.js buildPortraitIndex`），所以卡片上的「已有设定图」
 * 与底部那句缺口话术不可能互相矛盾（§2.6.2）。
 */
export function prepGroups({ prod, hasReferenceImage } = {}) {
  const has = typeof hasReferenceImage === "function" ? hasReferenceImage : () => false;
  return PREP_KINDS.map((k) => {
    const list = isObj(prod) && Array.isArray(prod[k.collection]) ? prod[k.collection] : [];
    const rows = list.filter(isObj).map((e) => ({
      kind: k.kind,
      id: e[k.idKey],
      name: str(e.name),
      summary: summaryOf(e),
      refCount: Array.isArray(e.referenceAssetIds) ? e.referenceAssetIds.length : 0,
      // 已经挂在它身上的资产 —— 弹窗里「已在此」用它，免得重复挂一张
      attachedIds: Array.isArray(e.referenceAssetIds) ? [...e.referenceAssetIds] : [],
      ready: !!has(k.kind, e[k.idKey]),
    }));
    return { ...k, rows, ready: rows.filter((r) => r.ready).length, total: rows.length };
  });
}

/**
 * 底部那句话 —— **「检测到 5 个人物角色和 3 个场景和 2 个道具没有设定图」**。
 *
 * 从 `assetReadiness().missing` **按 kind 分组派生**，不重新数一遍。
 * 缺席的类别整段省略：没有道具缺口就不说「和 0 个道具」。
 */
export function gapLine(readiness) {
  const missing = isObj(readiness) && Array.isArray(readiness.missing) ? readiness.missing : [];
  if (!missing.length) return "";
  const parts = [];
  for (const k of PREP_KINDS) {
    const n = missing.filter((e) => isObj(e) && e.kind === k.kind).length;
    if (n) parts.push(`${n} 个${k.word}`);
  }
  if (!parts.length) return "";
  // 产品负责人的原话逐字：「检测到 5 个人物角色和 3 个场景和 2 个道具没有设定图」
  // —— 连接词两侧的空格也照抄，因为那句话是验收依据（TASK-095 §7）。
  return `检测到 ${parts.join("和 ")}没有设定图`;
}

/**
 * 「AI 抽出的清单」与「登记表」的对账（§2.5e 的缝）。
 *
 * `proposals` 是 `breakdown.matchProposals` 的输出（可能为 null —— 还没跑过抽取）。
 * **null 与空数组是两件事**：前者是「还不知道」，后者是「抽过，没有新东西」。
 * 混成一个就是 §2.5f 第一条 —— 把「我不知道」实现成「已经齐了」。
 */
export function reconcile({ prod, proposals } = {}) {
  const known = PREP_KINDS.map((k) => {
    const list = isObj(prod) && Array.isArray(prod[k.collection]) ? prod[k.collection] : [];
    return [k.kind, new Set(list.filter(isObj).map((e) => normName(e.name)))];
  });
  const inRegistry = new Map(known);
  if (proposals === null || proposals === undefined) {
    return {
      known: false,
      registry: PREP_KINDS.map((k) => ({ kind: k.kind, label: k.label, count: inRegistry.get(k.kind).size })),
      pending: [],
      text: "还没有从分镜表抽取过资产清单 —— 抽一次才知道这一集到底要多少个对象",
    };
  }
  const cards = Array.isArray(proposals) ? proposals.filter(isObj) : [];
  const pending = [];
  for (const c of cards) {
    const m = /^(new|update)-(character|location|prop)$/.exec(String(c.kind || ""));
    if (!m) continue;
    const kind = m[2];
    const name = str(isObj(c.proposal) ? c.proposal.name : "");
    if (!name) continue;
    pending.push({
      kind,
      name,
      isNew: m[1] === "new",
      // 「AI 说要这个，登记表里已经有同名的了吗」—— 一处判断，两边共用
      inRegistry: inRegistry.get(kind).has(normName(name)),
    });
  }
  const rows = PREP_KINDS.map((k) => {
    const mine = pending.filter((p) => p.kind === k.kind);
    return {
      kind: k.kind,
      label: k.label,
      registry: inRegistry.get(k.kind).size,
      proposedNew: mine.filter((p) => p.isNew).length,
      proposedUpdate: mine.filter((p) => !p.isNew).length,
    };
  });
  const short = rows.filter((r) => r.proposedNew > 0);
  return {
    known: true,
    registry: rows,
    pending,
    text: short.length
      ? `AI 从分镜表里还抽出 ${short.map((r) => `${r.proposedNew} 个${r.label}`).join("、")}`
        + "，登记表里还没有 —— 逐条确认后才会写进作品设定"
      : "AI 抽出的对象都已经在作品设定里了",
  };
}

/**
 * 整个第 ② 步的读模型。
 *
 * `style` 是**全局风格**。它**不是新字段**：作品设定里的世界观已经有「视觉基调」
 * (`world.visualTone`)，由 world-director 写、创作者可改。再开一个 `globalStyle`
 * 就是 §2.5e 那条缝的教科书版本 —— 两处陈述「这部戏看起来是什么样」。
 */
export function assetPrepModel({ prod, shots, hasReferenceImage, proposals = null } = {}) {
  const index = buildEntityIndex(prod);
  const readiness = assetReadiness({ index, shots, hasReferenceImage });
  const groups = prepGroups({ prod, hasReferenceImage });
  // 三态，不是两态（§2.5f 第一条）。
  //
  // **「一个都没识别出来」不等于「都已经有设定图」。** 真实项目上第一次打开这块
  // 面板时它正是这个状态（那一集的镜头描述里还没点到任何实体），而第一版把
  // `missing.length === 0` 直接读成「齐了」，于是屏幕上写着「这一集用到的对象都
  // 已经有设定图」——而实际上我们**什么都不知道**。这与「不知道 ≠ 0」是同一条：
  // 没有可数的东西时，答案是「还不知道」，不是一个乐观的结论。
  const nothingIdentified = readiness.total === 0;
  const todoState = nothingIdentified ? "unknown" : readiness.missing.length ? "gap" : "ready";
  return {
    style: isObj(prod) && isObj(prod.world) ? str(prod.world.visualTone) : "",
    groups,
    readiness,
    // 待办，不是阻塞（见文件头第 1 条）
    todoState,
    todo: todoState === "gap"
      ? gapLine(readiness)
      : todoState === "ready"
        ? `这一集用到的 ${readiness.total} 个对象都已经有设定图`
        : "还没从分镜表里识别出任何对象 —— 先抽取一次资产清单，或者去第 ① 步把画面描述写上",
    reconcile: reconcile({ prod, proposals }),
  };
}

/** 一个 kind 的元数据，给界面用（避免每个调用点各写一份中文标签）。 */
export function prepKind(kind) {
  return KIND_BY.get(kind) || null;
}

// ⑤ Keyframe —— **合成，不是又一次文生图** (TASK-095 §1.3 / §2.5 · TASK-097 批次 4G)。
//
// 四个输入各管一件事，而且**必须说出来自己管什么**：
//
//   ④ 草图        构图 / 机位 / 人物在画面里的位置
//   ② 角色设定图  身份（长相、服装、特征的一致性）
//   ② 场景设定图  环境
//   ③ 分镜提示词  描述与视觉风格
//
// **第 ② 步在结构上就合不了 keyframe** —— 那一步手上只有基础资产，草图还不存在。
// 这是产品负责人自己的判断（TASK-095 §1.3），也是 ⑤ 必须在单镜画布上做的理由：
// 「哪几张图、什么顺序、每张管什么」这件事，一个按钮表达不了。
//
// ─────────────────────────────────────────────────────────────────────────────
// 本模块**不重新推导任何东西**（§2.5b）
//
//   有序集合 / `[[ref:N]]` / 用法规则   → `promptrefs`（它再转交 `refset`）
//   方案 C 的能力判定与违规判定         → `genspec.referenceCapability` /
//                                        `genspec.referenceViolation`
//   ④→⑤ 闸门                          → `sbdraft.keyframeGate`（4F 那一份）
//   「通过」是哪一件事                  → `shotprod.isStageArtifactApproved`
//
// 三件「通过」是**三件不同的事实**（§2.5h 第一条）：草图的通过、keyframe 的通过、
// 视频的通过会分别为真，所以它们各有自己的格子 —— 不因为都叫「通过」就并进一个。
// ─────────────────────────────────────────────────────────────────────────────
//
// PURE：读模型 + 判定。无 DOM、无 fetch、无写入、无时钟。

import { referenceBlock } from "./promptrefs.js";
import { referenceViolation } from "./genspec.js";
import { keyframeGate } from "./sbdraft.js";

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x.trim() : "");

/**
 * 四个输入各自管什么。**闭集**，而且这些词会原样进提示词（`role` → `note`），
 * 所以它们是产品语言，不是内部枚举名。
 */
export const KEYFRAME_ROLES = Object.freeze({
  storyboard: "构图",
  character: "身份",
  location: "环境",
  prop: "道具",
  style: "风格",
});

/** 一张输入图声明它管什么。认不出来的 kind **不猜**：返回空，由用法规则那一层
 *  fail-closed（归不到一级分类的参考会被扣下，见 `promptrefs`）。 */
export function roleOfKind(kind) {
  const k = str(kind);
  if (k === "storyboard") return KEYFRAME_ROLES.storyboard;
  if (k === "character-reference") return KEYFRAME_ROLES.character;
  if (k === "location-reference") return KEYFRAME_ROLES.location;
  if (k === "prop-reference") return KEYFRAME_ROLES.prop;
  if (k === "style-reference") return KEYFRAME_ROLES.style;
  return "";
}

/**
 * 一镜的合成编排。
 *
 * `draft` 是 ④ 那张通过了的草图；`refs` 是 ② 的设定图（角色 / 场景 / 道具 / 风格）；
 * `prompt` 是 ③ 的**分镜提示词**（不是视频运动那一份 —— 静态帧不表达运动）。
 *
 * **草图排在第一位**，因为构图是这次合成的骨架；其余按 `refs` 给的顺序。
 * 顺序就是 `[[ref:N]]` 的编号来源（ADR-0071：集合有序）。
 */
export function composePlan({ shotId, draft, refs = [], prompt = "", lookup } = {}) {
  const bindings = [];
  if (isObj(draft) && str(draft.assetId)) {
    bindings.push({
      assetId: draft.assetId,
      version: Number.isInteger(draft.version) ? draft.version : null,
      contentDigest: str(draft.contentDigest) || str(draft.digest),
      kind: "storyboard",
      name: str(draft.name) || "本镜草图",
      role: KEYFRAME_ROLES.storyboard,
    });
  }
  for (const r of Array.isArray(refs) ? refs.filter(isObj) : []) {
    bindings.push({
      assetId: str(r.assetId),
      version: Number.isInteger(r.version) ? r.version : null,
      contentDigest: str(r.contentDigest) || str(r.digest),
      kind: str(r.kind),
      name: str(r.name),
      // 每张图**声明它管什么**（TASK-095 §2.5）。给不出角色的，
      // 由用法规则那一层扣下 —— 不猜一个。
      role: roleOfKind(r.kind),
    });
  }
  // 有序集合 + 每类一段用法规则，全部转交（§2.5b）
  const block = referenceBlock({ bindings, lookup });
  const missing = [...block.missing];
  const text = str(prompt);
  if (!text) missing.push("这一镜还没有分镜提示词 —— 第 ③ 步先合成它（keyframe 要用它的描述与风格）");
  if (!bindings.length) missing.push("这一镜没有任何输入图 —— keyframe 是合成，没有输入就只是又一次文生图");
  else if (!block.sent.length) missing.push("这一镜的输入图全部被扣下了 —— 补上用法规则，或先不用它们");
  return {
    shotId: str(shotId),
    // 送出去的那一份（已由 refset 连续编号）
    inputs: block.sent,
    withheld: block.withheld,
    // 提示词 + 参考段：参考段说「哪几张、每张管什么、怎么用」
    prompt: [text, block.text].filter(Boolean).join("\n"),
    promptOnly: text,
    referenceText: block.text,
    missing,
    // **有一张要它进去而它没进去 → 这一镜就不算好了**（4D 统一出来的判据）
    ready: !!text && block.sent.length > 0 && block.withheld.length === 0,
  };
}

/**
 * 方案 C —— **拒绝发生在真正要发请求的这一层**（ADR-0071 / §2.5b-2）。
 *
 * 判定与违规话术都转交 `genspec`（批次 0/2 打硬的那一份）。这里的价值只有一件事：
 * **它是提交路径上的那一道**，而不是一份人类可读报告里的一句话。
 *
 * 返回 `{ ok, reason, degraded }`：
 *   - `degraded` 恒为 **false**。这个字段存在只是为了让「有没有降级」这件事
 *     **可被断言**：静默降级成单图会让「用了角色设定图」变成谎（TASK-077 §1.3
 *     修掉的正是那个），所以本模块**不提供**降级路径。
 */
export function composeSubmission({ plan, capability, gate } = {}) {
  const p = isObj(plan) ? plan : null;
  if (!p) return { ok: false, reason: "没有可提交的编排", degraded: false };
  // **④→⑤ 那道门必须在这里查**（codex 本批 round 1 的 P1）。
  //
  // 第一版只在清单界面上算 `canCompose`，而这里 —— **真正决定要不要提交的这一层**
  // —— 完全不看它：草图存在但没通过时，提示词与参考齐了就返回 ok。那正是 §2.5b-2
  // 那条：判定写在一处，而被执行的是另一处。闸门与提交必须是同一条路上的同一个判断。
  //
  // `gate` 是 `sbdraft.keyframeGate(row)` 的产出（生产那一份谓词，§2.5d）——
  // 这里不重写它，只要求调用方把它带上：**给不出闸门结论就不许提交**
  // （不知道 ≠ 可以送）。
  if (!isObj(gate)) {
    return {
      ok: false,
      reason: "没有 ④→⑤ 的闸门结论 —— 不知道这一镜能不能开始合成，就不提交",
      degraded: false,
    };
  }
  if (gate.ok !== true) {
    return { ok: false, reason: gate.reason || "④→⑤ 那道门还没过", degraded: false };
  }
  if (!p.ready) {
    return {
      ok: false,
      reason: p.missing[0] || "这一镜还不能合成",
      degraded: false,
    };
  }
  const cap = isObj(capability) ? capability : null;
  if (!cap || cap.known !== true) {
    // 「没问过」不是「可以送」（§2.5f 第一条）
    return {
      ok: false,
      reason: (cap && cap.note) || "还不知道这个模型吃不吃多图 —— 先向 Gateway 取一次报价",
      degraded: false,
    };
  }
  const count = p.inputs.length;
  // 上限必须是一个**正整数**，否则 fail-closed（codex 本批 round 2 的 non-blocking）。
  // `undefined <= 0` 与 `count > undefined` 都是 false —— 两道比较同时失效，
  // 于是一份形状不对的能力数据可以放行任意张数。「读不懂」不是「没有上限」。
  const max = Number.isInteger(cap.maxImages) ? cap.maxImages : null;
  if (max === null) {
    return {
      ok: false,
      reason: "这个模型的多图上限读不出来（不是一个整数）—— 读不懂就不送",
      degraded: false,
    };
  }
  // 多图路线未被声明 → **拒绝，并且不送单图**（方案 C）
  if (cap.declared !== true || max <= 0) {
    return {
      ok: false,
      reason: "这个模型没有声明「多图不额外计费」，所以多图合成在它上面不可用 ——"
        + "**不会退成单图送出去**：退成单图之后「用了角色设定图」这句话就成了谎",
      degraded: false,
    };
  }
  if (count > max) {
    return {
      ok: false,
      reason: `这一镜要送 ${count} 张，而这个模型声明最多 ${max} 张 ——`
        + "先减少输入（去掉一张，或把角色合成一张四视图），不替它截断",
      degraded: false,
    };
  }
  // 悬空标记 / 零图带标记等，全部转交 genspec 的那一份判定
  const violation = referenceViolation(cap, {
    count,
    markers: markersOf(p.prompt),
    usesMarkers: /\[\[ref:/.test(p.prompt),
    roles: p.inputs.map((r) => str(r.note)).filter(Boolean),
  });
  if (violation) return { ok: false, reason: violation, degraded: false };
  return { ok: true, reason: "", degraded: false, count };
}

/** 提示词里出现过的 `[[ref:N]]` 编号。与 `refset` 的正则同形（ASCII 数字）。 */
export function markersOf(text) {
  const out = [];
  const re = /\[\[ref:([0-9]+)\]\]/g;
  let m = re.exec(String(text ?? ""));
  while (m) {
    const digits = m[1];
    out.push(digits.length > 9 ? Infinity : Number(digits));
    m = re.exec(String(text ?? ""));
  }
  return out;
}

/**
 * 向导第 ⑤ 步那张**全集清单**。
 *
 * 每行：这一镜的 keyframe 状态 + ④→⑤ 闸门 + 一个「进入这一镜的画布合成 →」。
 * **向导说清还差哪几镜，画布做那一镜**（TASK-095 §1.3）。
 *
 * 闸门用的是 4F 那一份 `keyframeGate` —— 不在这里重写一遍（§2.5d：生产与测试
 * 共用同一个谓词；4F 那次 born-closed 的教训就是这么来的）。
 */
export function keyframeList({ rows, keyframeOf } = {}) {
  const src = Array.isArray(rows) ? rows.filter(isObj) : [];
  const kfOf = typeof keyframeOf === "function" ? keyframeOf : () => null;
  const out = src.map((r) => {
    const gate = keyframeGate(r);
    const kf = kfOf(r.shotId);
    const has = !!(isObj(kf) && kf.present === true && str(kf.assetId));
    const approved = has && kf.approved === true;
    // 四态，与 ④ 同一套词汇（`skipped` 是决定，不是空位）
    const state = kf && kf.skipped ? "skipped"
      : approved ? "approved"
        : has ? "made"
          : "not_started";
    return {
      shotId: r.shotId,
      seq: r.seq ?? null,
      title: r.title || "",
      // ④ 那一格的状态照带 —— 清单要说得出「为什么这一镜进不去」
      storyboardState: r.state,
      gateOk: gate.ok,
      gateReason: gate.reason,
      state,
      keyframe: has ? { assetId: kf.assetId, url: str(kf.url), version: kf.version ?? null } : null,
      // **不置灰导航**：进不去的那些仍然给一条进去看的路（既有纪律）
      canEnter: true,
      canCompose: gate.ok,
    };
  });
  const by = (s) => out.filter((r) => r.state === s).length;
  const blocked = out.filter((r) => !r.gateOk);
  return {
    rows: out,
    total: out.length,
    approved: by("approved"),
    made: by("made"),
    skipped: by("skipped"),
    notStarted: by("not_started"),
    blocked,
    // 「还差哪几镜」—— 一句话说清，而且是**待办**不是阻塞（§2.5f 第二条）
    todo: blocked.length
      ? `${blocked.length} 镜还过不了 ④→⑤ 那道门：${blocked.slice(0, 3).map((r) => r.title || r.shotId).join("、")}`
        + `${blocked.length > 3 ? " 等" : ""} —— 去 ④ 通过草图，或者把那几镜跳过`
      : "",
  };
}

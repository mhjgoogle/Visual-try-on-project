// 单镜画布的**可写层** (TASK-093 / TASK-097 批次 3)。
//
// TASK-093 的第一条纪律排在所有交付项之前，所以它也排在这个文件的第一行：
//
//   > **骨架永远派生。用户只能在骨架上加东西，而且加的东西也写回既有登记表。**
//   > **不是「一块空白画布，你随便摆」。**
//
// 产品负责人问过「一个 shot 一个画布是不是有点奢侈了」，而这条纪律就是答案：
//
//   画布是**要管理的文档** → 12 集 × 30–60 镜 = 360–720 个文档要起名、导航、维护
//   画布是**派生视图**     → 零。720 个镜头和 1 个镜头一样便宜
//
// LibTV 是前者（149 个节点是手工摆的，20 个镜头组是创作者复制出来的）；我们是后者。
// 一旦用户摆的节点变成自由文档，就真的有 720 个文档要管了。
//
// 于是本模块的形状由那条纪律直接决定：**每一种可添加的节点都必须指名它写进哪一张
// 既有登记表。** 指不出来的类型不是「以后再说」，而是**在菜单里灰掉并写出原因**
// （TASK-093 §2.3 沿用 TASK-079 §1.2 的既有姿态：不可用的类型灰掉并写出原因，不隐藏）。
// 这不是文档纪律，是可执行的：`ADDABLE_NODES` 里没有 `registry` 的项永远不可用，
// 守卫测试遍历它断言这一点。
//
// PURE。判定与预填在这里，写入由既有控制器执行（`ctx.assets` / `ctx.refs` / …），
// 所以这里没有 fetch、没有 DOM、没有 clock，也没有第二条写路径。

import { foreignReferences } from "./refscan.js";
import { categoryOf, modelReach, MODEL_REACH_LABEL } from "./refset.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x) => typeof x === "string" && x !== "";

/* -------------------------------------------------------------------------- */
/* 能加什么 —— 由「有没有地方装」决定                                            */
/* -------------------------------------------------------------------------- */

/**
 * 画布上可以添加的节点，闭集。
 *
 * `registry` 是这一项写进哪张**既有**登记表；`null` 表示今天没有地方装它，
 * 于是它在菜单里灰掉并显示 `why`。
 *
 * LibTV 的菜单有九项（文本 / 图片 / 视频 / 智能剪辑 / 导演台 / 逐帧拉片 / 音频 /
 * 脚本 / 素材库）。我们只做当前能力覆盖的那几种，其余**如实灰掉**：
 *
 *   逐帧拉片 / 3D 导演台  明确不做（需视频理解 / 3D 引擎，超出当前授权，
 *                        见 ui-correction-plan §0.2）
 *   自由文本便签          **没有登记表** —— 它会变成第 721 个要管理的文档，
 *                        正是 §0c 那条纪律要挡住的东西
 */
export const ADDABLE_NODES = [
  {
    id: "reference",
    label: "参考",
    icon: "🖼",
    registry: "shotProduction.references",
    detail: "从资产库绑一张已有的参考 —— 引用，不复制",
    why: null,
  },
  {
    id: "image",
    label: "图片",
    icon: "🎨",
    registry: "assets.images",
    detail: "上传或导入一张镜头图片，登记到资产库",
    why: null,
  },
  {
    id: "video",
    label: "视频",
    icon: "▶",
    registry: "assets.videos",
    detail: "上传或导入一段镜头视频，登记到资产库",
    why: null,
  },
  {
    id: "audio",
    label: "音频",
    icon: "🎵",
    registry: "assets.audio",
    detail: "上传配音 / 音效，登记到资产库",
    why: null,
  },
  {
    // 「从生成历史选择」——不是新对象，是把已有的一版设为当前
    id: "from-history",
    label: "从生成历史选择",
    icon: "🕘",
    registry: "assets.images / assets.videos",
    detail: "把这一镜已经生成过的某一版设为当前，不新增任何记录",
    why: null,
  },
  {
    id: "text-note",
    label: "文本便签",
    icon: "📝",
    registry: null,
    detail: null,
    why: "本产品没有「画布便签」这张登记表 —— 加了它，12 集就会多出 360–720 个"
      + "要起名、要导航、要维护的文档，而那正是「一个 shot 一个画布是不是有点奢侈了」"
      + "担心的东西（TASK-093 §0c）。镜头说明请写在镜头的「画面描述」里。",
  },
  {
    id: "frame-reader",
    label: "逐帧拉片",
    icon: "🎞",
    registry: null,
    detail: null,
    why: "需要视频理解能力，超出当前授权，明确不做（ui-correction-plan §0.2）",
  },
  {
    id: "director-3d",
    label: "3D 导演台",
    icon: "🎬",
    registry: null,
    detail: null,
    why: "需要 3D 引擎，超出当前授权，明确不做（ui-correction-plan §0.2）",
  },
];

/** 可添加项的菜单模型。`available` **只**由「有没有登记表」决定 —— 这就是那条纪律
 *  的可执行形式，没有第二个开关能把一个无处可写的节点放出来。 */
export function addableNodes() {
  return ADDABLE_NODES.map((n) => ({
    id: n.id,
    label: n.label,
    icon: n.icon,
    registry: n.registry,
    available: nonEmpty(n.registry),
    detail: n.detail,
    why: n.why,
  }));
}

/* -------------------------------------------------------------------------- */
/* 「以此生成 →」 (TASK-093 §2.2 / GAP-19)                                      */
/* -------------------------------------------------------------------------- */

/**
 * 从这个节点出发能生成什么，以及**每个落点预填了什么**。
 *
 * LibTV 的 `⊕ → 引用该节点生成` 是「任意类型 → 任意类型，一个统一动作」。
 * 我们今天只有一条（资产「🎬 用作视频首帧」），这是 GAP-19。
 *
 * 两条纪律：
 *
 *   1. **落点必须预填输入**（§2.2）。一个「以此生成」跳过去却是空白表单，
 *      等于把刚才那一步的上下文丢了。`prefill` 写明它带过去什么。
 *   2. **不可用的组合灰掉并说明原因**，不隐藏。而且两种「不可用」要分开：
 *      「这条路本产品没有」与「这一镜现在还不满足条件」是不同的话。
 *
 * `stage` 是 TASK-092 的六个 stage（由调用方注入，**不在这里重算** —— §2.4）。
 */
/** 「以此生成 →」 的落点里，**今天真的有处理器**的那些。
 *
 *  这张表存在的理由是 codex 轮 2 的那条 P1：一个 `available` 却没有处理器的落点会
 *  渲染成可点，然后什么都不发生。守卫按这张表断言 `available ⊆ HANDLED`，
 *  于是「渲染了但接不上」在结构上不可能出现，而不是靠人记得。 */
export const CHAIN_HANDLED = ["first-frame", "end-frame", "run-prompt", "character-from-image"];

export function chainTargets(node, { stage = null, hasPrompt = false, nextShotId = null } = {}) {
  if (!isObj(node)) return [];
  const out = [];
  const add = (t) => out.push({ prefill: null, why: null, ...t });

  if (node.type === "image" || node.type === "storyboard") {
    // 既有的那一条：图 → 视频首帧。它接的是 `shot.first_frame_image` 那条路，
    // 不新建第二条通道。
    add({
      id: "first-frame",
      label: "用作视频首帧",
      icon: "🎬",
      available: !!node.assetId,
      prefill: node.assetId ? { firstFrameAssetId: node.assetId, version: node.version } : null,
      why: node.assetId ? null : "这张图还没有登记的资产 id —— 先上传或生成出来",
    });
    // TWO CONDITIONS, BOTH REQUIRED (codex 轮 1). 之前只看闸门，于是一张没有
    // assetId 的图在闸门开着时是**可点的**，而 `prefill` 是 null —— 一次合成会在
    // 没有源图的情况下开始。「闸门开了」与「这张图真的存在」是两件事。
    // ④→⑤ 那道闸门在 TASK-092 里，这里**读**它，不复制它的判定。
    // `gate` 可能整个不存在（调用方还没有 stage board）—— 那时不是「放行」，
    // 也不能去 `stage.keyframe.blockers` 里取话：拿不到闸门就如实说拿不到。
    const gate = isObj(stage) && isObj(stage.keyframe) ? stage.keyframe : null;
    const gateOk = !!(gate && gate.ok);
    const gateWhy = gate
      ? (gate.blockers && gate.blockers[0]) || "关键帧这一步的前置还没满足"
      : "还不知道关键帧能不能开工 —— 没有拿到这一镜的环节状态";
    // NOT BUILT YET, SO NOT AVAILABLE (codex 轮 2, P1). The gate logic below is
    // correct and tested, but the multi-image compose it would start is TASK-095
    // 批次 4G's deliverable. Rendering it as available produced an ENABLED action that
    // fell through to 「落点还没接上」 — a button that does nothing is worse than a
    // greyed one, because the creator has already decided to use it.
    //
    // `implemented` is a separate fact from `available` on purpose: the gate reason
    // stays useful (「第 3 镜的草图还没确认」 tells the creator what to do), while the
    // binding constraint is what actually stops the click today. 4G flips one flag and
    // adds the handler.
    const composeBuilt = false;
    add({
      id: "keyframe-compose",
      label: "作为构图参考合成关键帧",
      icon: "🖼",
      available: composeBuilt && gateOk && !!node.assetId,
      prefill: node.assetId ? { composeFrom: node.assetId, role: "构图" } : null,
      why: !node.assetId
        ? "这张图还没有登记的资产 id —— 合成需要一张真的存在的源图"
        : !gateOk
          ? gateWhy
          : "多图合成关键帧的执行面还没做完 —— 前置已经满足，等这一步接上就能用",
    });
    // ADR-0074：从这张图创建角色。放在「以此生成 →」里，因为它就是一次
    // 「引用该节点生成一个新对象」—— 与 LibTV 图上右键「创建主体」同一件事。
    add({
      id: "character-from-image",
      label: "从这张图创建角色",
      icon: "👤",
      available: !!node.assetId,
      prefill: node.assetId ? { referenceAssetId: node.assetId } : null,
      why: node.assetId ? null : "这张图还没有登记的资产 id —— 那条参考绑定会立刻悬空",
    });
  }

  if (node.type === "video") {
    add({
      id: "end-frame",
      label: "提取尾帧给下一镜",
      icon: "⇥",
      available: !!(node.assetId && nextShotId),
      prefill: node.assetId && nextShotId ? { fromAssetId: node.assetId, toShotId: nextShotId } : null,
      // 两种「没有下一镜」不能混为一谈（TASK-079 §1.2 的既有纪律）
      why: !node.assetId
        ? "这一版视频还没有登记的资产 id"
        : (!nextShotId ? "这是本场景的最后一镜，没有下一镜可接" : null),
    });
  }

  if (node.type === "prompt") {
    add({
      id: "run-prompt",
      label: "按这段提示词生成",
      icon: "⚡",
      available: hasPrompt,
      prefill: hasPrompt ? { promptText: node.preview || "", genKind: node.genKind } : null,
      why: hasPrompt ? null : "提示词还是空的 —— 先补齐它缺的那几项",
    });
  }

  if (node.type === "reference") {
    // NOT AVAILABLE, because carrying the reference to another shot is not built
    // (codex 轮 3, P1). It used to be `available` while the handler threw the prefill
    // away and opened a generic page — the action promised to take this reference
    // somewhere and took nothing. Half-wiring it would be worse than saying so: the
    // creator would believe the binding happened.
    //
    // The capability itself is real and cheap (`shotProduction.references` already
    // shares keys across shots), it just needs a shot picker. Stated, not pretended.
    add({
      id: "reuse-elsewhere",
      label: "在别的镜头也用这张参考",
      icon: "⧉",
      available: false,
      prefill: node.refKey ? { referenceKey: node.refKey } : null,
      why: node.refKey
        ? "还没有「选哪一镜」的入口 —— 参考本来就是跨镜共享的，缺的只是这个选择器。"
          + "现在可以在「参考统筹」里给那一镜绑同一个参考。"
        : "这个参考没有 key，无法共享",
    });
  }

  // 本产品没有的那两条，**每个节点都如实列出**而不是隐藏：创作者看过 LibTV，
  // 会来找它们。
  add({
    id: "smart-edit",
    label: "智能剪辑",
    icon: "✂",
    available: false,
    why: "本产品用既有 FFmpeg 时间线做剪辑（原 M1 的稳定基础），不做「智能剪辑」替换它",
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/* 删一个节点意味着什么 (TASK-097 §2.5d 两个方向都要钉)                          */
/* -------------------------------------------------------------------------- */

/**
 * 这个东西现在能不能删。
 *
 * 画布上删一个节点 = 删它背后那条**记录**，所以必须先问「还有谁引用着它」——
 * 用派生扫描而不是清单（§2.6.1；TASK-094 的清单漏了 `timelines`，而 `timelines`
 * 引用着四个剧集）。
 *
 * **两个方向都要钉住**（§2.5d）：
 *
 *   拒绝：仍被引用的，列出**每一处**引用位置，让创作者能去解开
 *   放行：无人引用的，**必须真的能删** —— 只钉会拒绝的那一半，
 *         就是在造一个迟早被关掉的闸门
 *
 * `expected` 是「哪些位置不算引用」的谓词（例如它自己的登记条目）。闭集是
 * 「哪里不算」，而不是「哪里算」—— 明天新增的引用点默认算引用。
 */
/**
 * 「哪些位置是这个资产**自己的**登记条目」—— 也就是不算引用的那些。
 *
 * WHY THIS IS AN EXPORTED FUNCTION AND NOT AN INLINE LAMBDA (codex 轮 4, P1).
 * app.js 里那个内联谓词写错了：
 *
 *     (p) => p.endsWith(".assetId") === false && p.includes("<key>")
 *
 * 于是资产**自己**的登记记录（`…history[0].assetId`）被算成外部引用，
 * **任何东西都永远删不掉**。而我的 JS 测试用的是默认谓词（什么都不算 expected），
 * 所以「无人引用的真的能删」那一半在测试里通过、在产品里恒假 ——
 * §2.5d 说的正是这个：**只钉会拒绝的那一半，等于造一个迟早被关掉的闸门**。
 *
 * 现在它是一个有名字、可测试、生产与测试**共用同一份**的谓词。
 *
 * 一个资产自己的位置只有两种：
 *
 *   `$.assets.<domain>.<slot>.history[i].assetId`   它的版本记录
 *   `$.assets.<domain>.<slot>.<id><key>`            以它为键的映射（若存在）
 *
 * 其余一切 —— `firstFrames`、`timelines`、`shotProduction`、`generations`、
 * 明天新增的任何键 —— 都算引用（闭集是「哪里不算」，§2.6.1）。
 */
export function ownAssetRegistryPath(id) {
  const own = new RegExp(
    `^\\$\\.assets\\.(images|videos|audio|finals)\\.[^.]+\\.history\\[\\d+\\]\\.assetId$`,
  );
  const ownKey = new RegExp(`^\\$\\.assets\\.(images|videos|audio|finals)\\.${escapeForRegex(id)}<key>$`);
  return (path) => own.test(path) || ownKey.test(path);
}

function escapeForRegex(s) {
  return String(s == null ? "" : s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function removalCheck(doc, id, { expected = () => false, label = "这个对象" } = {}) {
  if (!nonEmpty(id)) {
    return { ok: false, blockers: ["没有 id，无法判断它被谁引用"], sites: [] };
  }
  const sites = foreignReferences(doc, id, expected);
  if (!sites.length) return { ok: true, blockers: [], sites: [] };
  return {
    ok: false,
    sites,
    blockers: [
      `${label}还被 ${sites.length} 处引用着：${sites.join(" / ")}`
      + " —— 先解开这些引用，或者改成软删除（记录留着、不再显示）",
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* 参考区的五个一级分类 (TASK-093 §2.5)                                          */
/* -------------------------------------------------------------------------- */

/**
 * 画布参考区的分组：**人物｜场景｜道具｜视觉参考｜声音**。
 *
 * 零迁移（`kind` 数据不动，界面派生分组），但**必须保住一条事实**：合并进「视觉参考」
 * 的五个横跨 `ROLE_USE` 的分界 —— `style` 的图**进模型**，`video-style` / `motion` /
 * `camera` / `performance` 的**不进模型**，只被 Skill 读成 Prompt 里的文字。
 * **合并的是归类，不是那个事实**（TASK-077 §1.3 修的正是这个谎）。
 *
 * 所以这里不自己判断 reach，而是调 `refset.modelReach` —— 那一份已经被 6 轮 codex
 * 审过，重新推导等于重新踩（TASK-097 §2.5b）。
 */
export function referenceArea(references) {
  const groups = new Map();
  const unclassified = [];
  for (const r of Array.isArray(references) ? references : []) {
    if (!isObj(r)) continue;
    const cat = categoryOf(r.kind);
    const reach = modelReach(r.kind);
    const row = { ...r, category: cat, reach, reachLabel: MODEL_REACH_LABEL[reach] };
    if (!cat) { unclassified.push(row); continue; }
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(row);
  }
  return { groups, unclassified };
}

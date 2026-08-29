// 一句话 → 一类工作 → 一个能力：意图路由的**前端一半**（TASK-119 / ADR-0091）。
//
// 分工，一句话说清：
//
//   模型      读懂他要什么，说出这属于**三类用户能力**里的哪一类，以及他要达成什么
//   服务端    用确定性规则把那一类解析成一个具体的内部专业能力（resolver）
//   这个模块  **能不能现在就跑** —— 输入够不够、执行器在不在、是不是已经跑过了
//
// 为什么最后一关在前端：作品文档只活在浏览器里（ADR-0089 决策 2b），所以「大纲写了
// 没有」「这一集有没有剧本」只有这边答得上来。服务端也判过一次（它拿的是这边报的
// `readyInputs`），但**权威的那一次在这里** —— 文档在哪边，判定就在哪边落定。
//
// 这个文件里**没有任何一个内部能力的名字**。它拿到的 skillId 来自服务端的解析结果，
// 而不是它自己认识的某张表 —— 那正是这次收敛要守住的边界。
//
// 纯函数：无 fetch、无 DOM、无时钟。

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/** 前端 Agent 看得见的三类工作。与 `skillpkg.USER_CAPABILITIES` 同一套词，
 *  只在屏幕文案里用 —— 判定与执行都不看它。 */
export const USER_CAPABILITY_ZH = {
  "story-development": "开发故事",
  "episode-production": "制作这一集",
  "story-review": "检查问题",
};

/** 服务端已经解析好的执行计划（没有就是 null）。 */
export function routeOf(turn) {
  const r = turn && turn.route;
  return isObj(r) && typeof r.skillId === "string" && r.skillId ? r : null;
}

/** 服务端拒掉的那一条（不认识的能力名、错的窗口、没有能承担它的包）。
 *  **保留而不是丢掉**：一个被静默丢弃的路由，在屏幕上与「它答应了然后什么都没干」
 *  无法区分。 */
export function rejectedRouteOf(turn) {
  const r = turn && turn.routeRejected;
  return isObj(r) && typeof r.reason === "string" && r.reason ? r : null;
}

/**
 * 这一轮解析出来的能力该不该现在跑，跑不了是为什么。
 *
 * @returns {{action: "none"|"already"|"blocked"|"run", skillId?, title?,
 *            capability?, reason?, missing?: string[], executor?: string}}
 *
 * `blocked` 不是失败，是**一条要显示出来的事实** —— 屏幕上要说清缺什么、或者
 * 为什么不能自动跑，并给出他自己点的那条路（ADR-0065 决策 2 的手工兜底）。
 */
export function decideRoute(route, ctx) {
  const {
    mode = "work",
    findSkill = () => null,
    missingOf = () => [],
    labelOf = (k) => k,
    pickExecutor = () => null,
    ranFor = () => null,
  } = ctx || {};
  if (!isObj(route) || typeof route.skillId !== "string" || !route.skillId) {
    return { action: "none" };
  }
  const skillId = route.skillId;
  const base = {
    skillId,
    capability: route.capability || "",
    title: route.title || skillId,
    why: String(route.reason || ""),
  };
  // 第二道窗口闸。服务端已经筛过一次（那才是强制的那一道），这里再挡一次是因为
  // 「在这个窗口里我的东西不会被改」必须是**产品行为**，不是一处代码的正确性。
  if (mode !== "work") {
    return {
      ...base,
      action: "blocked",
      reason: "「开发」窗口里不会启动作品能力 —— 要动作品请切回「作品」窗口。",
    };
  }
  const skill = findSkill(skillId);
  if (!skill) {
    return {
      ...base,
      action: "blocked",
      reason: "这台机器上没装能做这件事的能力（后端没连上，或那个包没加载成功）。",
    };
  }
  base.title = skill.title || base.title;
  // 幂等：这一轮已经起过一次就不再起（刷新、轮询、网络重试都会重新走到这里）。
  const already = ranFor();
  if (already) return { ...base, action: "already", run: already };
  // **输入够不够由文档说了算**，不由模型说了算。
  const missing = missingOf(skillId) || [];
  if (missing.length) {
    const said = missing.map((k) => labelOf(k) || k);
    return {
      ...base,
      action: "blocked",
      missing: said,
      reason: "还缺 " + said.join("、") + " —— 先把这些补上。",
    };
  }
  const executor = pickExecutor(skill);
  if (!executor) {
    return {
      ...base,
      action: "blocked",
      reason: "本机没有可用的执行器 —— 在「能力」里选「手工」也能跑这一次。",
    };
  }
  return { ...base, action: "run", executor };
}

// --- 结构性变更 → 只跑一次的一致性诊断 -------------------------------------- //
//
// 「改了大纲之后别的地方还对得上吗」这件事，创作者多半**不会主动问**。所以一次真的
// 落到作品上的结构性改动之后查一遍是有价值的 —— 但它必须满足三条，否则就是噪音：
//
//   1. **有根**：确实有一次落地的版本化写入，而不是一次渲染、一次刷新、一次轮询。
//   2. **跨层**：被改的那一层下游**真的已经有东西**，否则「不同步」无从谈起。
//   3. **只一次**：以那次变更的稳定身份（哪个文档的第几版）作 key，跑过就不再跑。
//
// 「不要在每次编辑后自动触发审查」正是这三条的落法：一次普通编辑（改一个字段、
// 切一个版本指针、删一条又撤销）**一条都不满足**。
//
// 微小改动不在表里 —— 指针切换（setActive）、删除与撤销、交付规格、还没保存的分集
// 草稿都不是结构性变更。判据是**它是否产生了一个下游要跟着走的新版本**。

/** 会触发跨层检查的那几条动作，以及它们写的是哪一层的哪份文档。 */
export const STRUCTURAL_ACTIONS = {
  "brief.idea": { layer: "L1", doc: "brief" },
  "brief.fields": { layer: "L1", doc: "brief" },
  "outline.fields": { layer: "L2", doc: "outline" },
  "outline.approve": { layer: "L2", doc: "outline" },
  "plan.save": { layer: "L2", doc: "plan" },
};

/** 一层之下还有哪几层。L3–L5 是末端，改它们不往下传。 */
const DOWNSTREAM = {
  L1: ["L2", "L3", "L4", "L5"],
  L2: ["L3", "L4", "L5"],
};

/**
 * 这一批落地的动作里，最上游的那次结构性写入。
 *
 * 取**最上游**（L1 优于 L2）：一轮里既改了创意又改了大纲时，根是创意那一次 ——
 * 大纲的变化本来就是它的下游。
 *
 * 没有版本号就返回 null，这是**故意的**：key 必须是那次变更的稳定身份，
 * 拿不到身份就没有「只跑一次」的保证，那时宁可不跑。
 */
export function structuralRoot(landed) {
  const rows = (Array.isArray(landed) ? landed : []).filter(
    (r) => r && !r.error && STRUCTURAL_ACTIONS[r.kind],
  );
  let best = null;
  for (const row of rows) {
    const spec = STRUCTURAL_ACTIONS[row.kind];
    const version = Number(row.version);
    if (!Number.isInteger(version) || version < 1) continue;
    const candidate = { ...spec, version, kind: row.kind };
    if (!best || candidate.layer < best.layer) best = candidate;
  }
  return best;
}

/** 这次变更的稳定身份。同一份文档的同一版永远得到同一个 key。 */
export function zoomKeyFor(root) {
  if (!root || !root.doc || !Number.isInteger(root.version)) return null;
  return `consistency:${root.doc}:v${root.version}`;
}

/**
 * 这一批落地之后，要不要查一次跨层一致性。
 *
 * 返回的是**一类工作**（`story-review` + 一句跨层措辞的 goal），不是一个 skillId ——
 * 选哪个诊断器仍然由服务端的 resolver 决定，与他自己开口问时走的是同一条路。
 * 这样「跨层诊断」这件事只有一处判定，不会一处走 resolver、一处写死。
 *
 * @param landed        `applyConversationEdits` 的返回
 * @param layersPresent {L2: bool, L3: bool, L4: bool, L5: bool} —— 哪些层**真的有东西**
 * @param hasRunKey     (key) => bool，问登记表这个 key 是不是已经跑过
 * @returns {{capability, goal, key, root, affects: string[]}} 或 null
 */
export function zoomTrigger(landed, { layersPresent = {}, hasRunKey = () => false } = {}) {
  const root = structuralRoot(landed);
  if (!root) return null;
  const affects = (DOWNSTREAM[root.layer] || []).filter((l) => layersPresent[l]);
  // 「至少影响两个层级」= 被改的那一层 + 至少一个**已经存在**的下游层。
  // 一个只有大纲、还没有剧本没有镜头的项目，改大纲不会让任何东西失去同步。
  if (!affects.length) return null;
  const key = zoomKeyFor(root);
  if (!key || hasRunKey(key)) return null;
  return {
    capability: "story-review",
    // 这句话会走进 resolver 的关键词匹配 —— 用的是跨层措辞，所以选中的是跨层
    // 诊断器，而不是「这一集剧本有什么问题」那个。
    goal: "大纲改了之后，各层还同步吗；设定与剧本有没有对不上",
    key,
    root,
    affects,
  };
}

// Shot 的六个 Stage（ADR-0073 / TASK-092）—— 「这一镜的每个制作环节各自到哪了」。
//
// 产品负责人 2026-08-17：
//
//   「不要让 shotStage = storyboard → keyframe → video → audio 表达整个 Shot。
//     改成几个并行 Stage：Visual（Storyboard / Keyframe / Video）、Audio（Voice /
//     SFX）、QC（Approval）…shotStage 可以继续存在，但只能作为 UI 汇总状态，
//     不能作为真实 Workflow State。」
//
// 四态词汇一个不改，但**来源按「谁才知道」分开**（ADR-0073 决策 2）：
//
//   not_started   默认            —— 无证据、无决定
//   in_progress   派生：有在途 Run —— 存储的 in_progress 在崩溃后会永久说谎
//   completed     派生 + 要证据    —— 产物存在，且探针**没有否认也没有说不知道**
//                                   （`INCONCLUSIVE` 是「问过、答不上来」，它不算
//                                    完成；「从未问过」才算 —— 那时登记表的 current
//                                    指针就是我们手上的证据。两者是不同的处境。）
//   skipped       **存储**         —— 只有人 / Workflow 的决定能知道
//
// 于是**只有 `skipped` 是真正新增的持久状态**，其余三个是把已有证据读成一个词。
// `completed` 尤其不得写入文档：一个被写下来的「做完了」会在产物被删除或换版本
// 之后继续说做完了 —— 那正是 TASK-077 里 `storageState` 声明「文件在」而从不核对，
// 于是存储页报「媒体不可用 0」的同一个形状。
//
// `approved` 不在这个枚举里（决策 3）。它已经有正确的位置：`shotprod.isApprovedFor`
// 把批准绑在**具体那个产物**上，所以换了草图批准自动失效。塞进 stage 枚举会立刻
// 产生第二份批准真相，而且是不绑产物的那一份。
//
// PURE。全部证据由调用方注入（`inflight` / `artifact` / `approvedFor`），
// 所以这里没有 fetch、没有 DOM、没有 clock，也因此「崩溃后 in_progress 会不会说谎」
// 这种问题可以直接测。

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x) => typeof x === "string" && x !== "";

/** 六个 stage，产品负责人给定的清单，顺序即阅读顺序。 */
export const STAGES = ["storyboard", "keyframe", "video", "voice", "sfx", "qc"];

export const STAGE_LABEL = {
  storyboard: "分镜草图",
  keyframe: "关键帧",
  video: "视频",
  voice: "配音",
  sfx: "音效",
  qc: "审核",
};

/** 三组。Visual 内部串行，三组之间**不**串行（决策 5）。 */
export const STAGE_GROUP = {
  storyboard: "visual",
  keyframe: "visual",
  video: "visual",
  voice: "audio",
  sfx: "audio",
  qc: "qc",
};

export const GROUP_LABEL = { visual: "画面", audio: "声音", qc: "审核" };

export const STATUSES = ["not_started", "in_progress", "completed", "skipped"];

export const STATUS_LABEL = {
  not_started: "还没开始",
  in_progress: "进行中",
  completed: "已完成",
  // 「跳过」与「还没做」必须在界面上可分 —— 这是 skipped 存在的全部理由
  skipped: "按设计跳过",
};

/* -------------------------------------------------------------------------- */
/* 依赖关系是数据（ADR-0073 决策 4）                                            */
/* -------------------------------------------------------------------------- */

/**
 * `stage → 前置条件`。加 Lip Sync / BGM / Retake **只是加一行**，判定代码不动。
 *
 * `satisfiedBy` 是一个**条件名的列表**，任一满足即放行（OR）。条件名的实现在
 * `CONDITIONS` 里，也是数据 —— 判定函数只会查表，永远不会长出一串 `if (stage ===
 * "keyframe")`。这一条是可测的：`tests/shotstage.test.mjs` 加一个假 stage，只加一行。
 */
export const STAGE_DEPENDENCIES = {
  storyboard: [],
  // 产品负责人的原话，逐字：
  //   「Keyframe 的启动条件应该是：Storyboard == approved OR Storyboard == skipped
  //     而不是单纯 Storyboard == completed。」
  keyframe: [{ on: "storyboard", satisfiedBy: ["skipped", "completed-and-approved"] }],
  video: [{ on: "keyframe", satisfiedBy: ["completed", "skipped"] }],
  // AUDIO 不以 VIDEO 为前置（决策 5）—— 但它**有**前置，产品负责人说得很清楚：
  // 「它的前置是『台词已确认』」。第一版把它写成空表，等于把那句话删掉，于是配音
  // 可以在台词还没定稿时开工，录完必然重录（codex 轮 1，P1）。
  //
  // `dialogue` 不是第七个 stage，是一个**事实**（剧本层的），所以它以 FACTS 的形式
  // 进同一张表 —— 依赖仍然是数据，而不是为它开一个特例分支。
  voice: [{ on: "dialogue", satisfiedBy: ["completed", "skipped"] }],
  sfx: [{ on: "dialogue", satisfiedBy: ["completed", "skipped"] }],
  // QC 是「**两组都就位后**」（TASK-092 §2.5 的原话）。只写 video 等于说画面好了就能
  // 判片，而一条没有配音的镜头根本没法判（codex 轮 1，P1）。
  // 音频那两项允许 `skipped`：一个没有台词的镜头本来就不需要配音，那是决定，不是缺口。
  qc: [
    { on: "video", satisfiedBy: ["completed", "skipped"] },
    { on: "voice", satisfiedBy: ["completed", "skipped"] },
    { on: "sfx", satisfiedBy: ["completed", "skipped"] },
  ],
};

/**
 * 依赖表里可以出现的**非 stage 事实**。
 *
 * 「台词已确认」住在剧本 / 分镜表里，不是一个制作环节，所以它不该变成第七个 stage
 * （那会让它出现在每一个 stage 面板上）。它以事实的形式进同一张表，因此判定代码
 * 仍然只查表。
 *
 * 缺省是 `not_started` —— 没人告诉我们台词定了，就是没定。**fail-closed**：
 * 猜「大概定了吧」正是本卡在消除的那类声明。
 */
export const FACTS = ["dialogue"];

export const FACT_LABEL = { dialogue: "台词" };

/** 条件名 → 判定。也是表，不是分支。 */
const CONDITIONS = {
  completed: (st) => st.status === "completed",
  skipped: (st) => st.status === "skipped",
  // 「completed 且那张草图已 approved」—— 批准绑在产物上，所以问的是产物
  "completed-and-approved": (st) => st.status === "completed" && st.approved === true,
};

/**
 * 这个 stage 现在能不能开工，以及**为什么不能**。
 *
 * 闸门**不置灰导航**（既有纪律）：调用方仍然让创作者进得去，只是主行动显示
 * `blockers`。一个禁用的按钮不说原因，就是一个死胡同。
 */
export function canStart(stage, statuses, { dependencies = STAGE_DEPENDENCIES } = {}) {
  const deps = Array.isArray(dependencies[stage]) ? dependencies[stage] : [];
  const blockers = [];
  for (const dep of deps) {
    const st = (isObj(statuses) && statuses[dep.on]) || { status: "not_started", approved: false };
    const ok = (dep.satisfiedBy || []).some((name) => {
      const fn = CONDITIONS[name];
      // 一个表里没有的条件名 = fail-closed。一个我们看不懂的前置绝不当成已满足。
      return typeof fn === "function" ? fn(st) : false;
    });
    if (!ok) blockers.push(explain(dep, st));
  }
  return { ok: blockers.length === 0, blockers };
}

function explain(dep, st) {
  const name = STAGE_LABEL[dep.on] || FACT_LABEL[dep.on] || dep.on;
  const wants = (dep.satisfiedBy || []).map((c) => CONDITION_ZH[c] || c).join("，或者");
  const now = st.status === "completed" && st.approved !== true
    ? "已完成但还没确认"
    : STATUS_LABEL[st.status] || st.status;
  return `${name}：现在是「${now}」，需要${wants}`;
}

const CONDITION_ZH = {
  completed: "已完成",
  skipped: "按设计跳过",
  "completed-and-approved": "出了草图并且你已经确认它",
};

/* -------------------------------------------------------------------------- */
/* 存储的那一个：skipped                                                        */
/* -------------------------------------------------------------------------- */

/** 文档里 stage 决定的容器。形状与 ADR-0072 决策 4 的软归档一致 —— `{ at, reason }`，
 *  一个半写的记录降级成「没有决定」，而不是让可见状态被半条记录决定。 */
export function defaultShotStages() {
  return {};
}

function sanitizeDecision(d) {
  if (!isObj(d)) return null;
  const at = typeof d.at === "string" ? d.at : "";
  if (!at.trim()) return null;
  return { at, reason: typeof d.reason === "string" ? d.reason : "" };
}

/**
 * 规整持久化的 stage 决定。
 *
 * **只认 `skipped`。** 任何其他被写进文档的状态一律丢弃并且不报错地忽略——
 * 一个被写下来的 `completed` 是决策 2 明令禁止的东西，读进来会立刻开始说谎。
 * 这不是宽容，是 fail-closed：我们宁可丢掉一个来路不明的声明，也不让它决定界面。
 */
export function sanitizeShotStages(saved) {
  const out = {};
  const src = isObj(saved) ? saved : {};
  for (const shotId of Object.keys(src)) {
    const perShot = src[shotId];
    if (!isObj(perShot)) continue;
    const kept = {};
    for (const stage of STAGES) {
      const d = sanitizeDecision(isObj(perShot[stage]) ? perShot[stage].skipped : null);
      if (d) kept[stage] = { skipped: d };
    }
    if (Object.keys(kept).length) putKey(out, shotId, kept);
  }
  return out;
}

/** `__proto__` 安全写入 —— shotId 是任意字符串，与 `shotprod.putKey` 同一条规矩。 */
function putKey(obj, key, val) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = val;
  }
  return obj;
}

/** 记下「这一步按设计不做」。**唯一的新增写路径。** */
export function skipStage(stages, shotId, stage, at, reason = "") {
  // THE WRITE PATH MUST ACCEPT EXACTLY WHAT SURVIVES (codex 轮 2, P2). `at` was
  // checked with `nonEmpty` while `sanitizeShotStages` and the v16 validator both
  // require `at.trim()` — so a whitespace timestamp produced a skip the creator
  // could SEE, that then vanished on reload (or made the next save invalid). A
  // decision that does not persist is worse than a refused one.
  if (!nonEmpty(shotId) || !STAGES.includes(stage) || !nonEmpty(at) || !at.trim()) return false;
  const perShot = isObj(stages[shotId]) ? { ...stages[shotId] } : {};
  perShot[stage] = { skipped: { at, reason: typeof reason === "string" ? reason : "" } };
  putKey(stages, shotId, perShot);
  return true;
}

/** 撤销跳过 —— 删记录，而不是写一个 `skipped: false`。
 *  「没有决定」和「决定要做」是两件事，后者今天没有对应的事实可存
 *  （要不要做由 workflow 与前置决定），写下来就是发明状态。 */
export function unskipStage(stages, shotId, stage) {
  const perShot = stages[shotId];
  if (!isObj(perShot) || !isObj(perShot[stage])) return false;
  const next = { ...perShot };
  delete next[stage];
  if (Object.keys(next).length) putKey(stages, shotId, next);
  else delete stages[shotId];
  return true;
}

export function isSkipped(stages, shotId, stage) {
  const perShot = isObj(stages) ? stages[shotId] : null;
  return !!(isObj(perShot) && isObj(perShot[stage]) && isObj(perShot[stage].skipped));
}

/* -------------------------------------------------------------------------- */
/* 派生：把证据读成一个词                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 六个 stage 的当前状态。
 *
 * 证据全部注入，因为它们各自住在不同的登记表里，而这个模块必须保持纯：
 *
 *   `inflight(stage)`     → bool。有在途 Run 吗（生成登记里 queued/generating）。
 *   `artifact(stage)`     → `{ assetId, present }` 或 null。产物在不在，
 *                            `present` 是**探针的结论**，不是声明。
 *   `approvedFor(assetId)`→ bool。这个产物上有没有一条批准记录（绑产物，不绑 stage）。
 *   `fact(name)`          → `"completed" | "skipped" | null`。非 stage 的前置事实，
 *                            目前只有 `dialogue`（「台词已确认」）。**默认 null =
 *                            没定**，绝不猜成定了。
 *
 * 顺序有意如此：**决定 > 在途 > 证据 > 默认**。
 * 一个被跳过的步骤即使意外留下了产物也仍然是跳过的——那是人的决定，
 * 而产物可能只是他试了一下。
 */
export function stageStatuses(stages, shotId, { inflight, artifact, approvedFor, fact } = {}) {
  const runOf = typeof inflight === "function" ? inflight : () => false;
  const artOf = typeof artifact === "function" ? artifact : () => null;
  const okOf = typeof approvedFor === "function" ? approvedFor : () => false;
  const factOf = typeof fact === "function" ? fact : () => null;
  const out = {};
  // 非 stage 的前置事实，与 stage 放在同一张表里，因此 `canStart` 只查表。
  for (const name of FACTS) {
    const v = factOf(name);
    out[name] = {
      status: v === "completed" || v === "skipped" ? v : "not_started",
      approved: false,
      assetId: null,
    };
  }
  for (const stage of STAGES) {
    if (isSkipped(stages, shotId, stage)) {
      out[stage] = { status: "skipped", approved: false, assetId: null };
      continue;
    }
    if (runOf(stage)) {
      out[stage] = { status: "in_progress", approved: false, assetId: null };
      continue;
    }
    const art = artOf(stage);
    // COMPLETED 要证据，而且要的是**探针说它在**，不是登记表声明它在。
    // `present !== true` 覆盖了 false（确实没了）和 undefined（没人问过）两种情况：
    // 没人问过就不能算完成，否则就是又一次「声明当事实」。
    if (isObj(art) && art.present === true) {
      out[stage] = {
        status: "completed",
        assetId: nonEmpty(art.assetId) ? art.assetId : null,
        approved: nonEmpty(art.assetId) ? !!okOf(art.assetId) : false,
      };
      continue;
    }
    out[stage] = { status: "not_started", approved: false, assetId: null };
  }
  return out;
}

/** 每个 stage 加上「能不能开工」，一次算完 —— 界面要的就是这两件事。 */
export function stageBoard(stages, shotId, evidence, { dependencies = STAGE_DEPENDENCIES } = {}) {
  const statuses = stageStatuses(stages, shotId, evidence);
  const board = {};
  for (const stage of Object.keys(dependencies)) {
    const st = statuses[stage] || { status: "not_started", approved: false, assetId: null };
    board[stage] = {
      stage,
      label: STAGE_LABEL[stage] || stage,
      group: STAGE_GROUP[stage] || null,
      ...st,
      statusLabel: STATUS_LABEL[st.status] || st.status,
      ...canStart(stage, statuses, { dependencies }),
    };
  }
  return board;
}

/* -------------------------------------------------------------------------- */
/* 汇总（ADR-0073 决策 6）                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 「这一镜**真的**做完了吗」 —— 六个 stage 全部就位。
 *
 * WHY THIS IS A SEPARATE FUNCTION FROM `summarizeStages` (codex 轮 1 的第一条发现).
 * The reviewer is right that something must answer 「一个镜头可以 approved 而完全
 * 没有配音」 —— TASK-092 §1 lists exactly that as a defect. But the fix is NOT to
 * redefine the五档词汇: `approved` on ⑨ 粗剪审片 means 「我看过这条视频，通过了」,
 * which is a true and useful statement about the take, and TASK-092 §2.6 requires
 * the three consumers' existing assertions to keep passing. Overloading that word
 * with 「整镜完成」 would make 审片 stop being able to say the thing it exists to say.
 *
 * So the missing answer gets its own name. `shotStage` says where the PICTURE is;
 * this says whether the shot is finished. A stage that was deliberately skipped
 * counts as settled — that is what 「按设计跳过」 means.
 */
export function shotComplete(statuses) {
  const settled = (k) => {
    const st = isObj(statuses) && isObj(statuses[k]) ? statuses[k] : { status: "not_started" };
    return st.status === "completed" || st.status === "skipped";
  };
  const missing = STAGES.filter((k) => !settled(k));
  return {
    complete: missing.length === 0,
    missing,
    // one sentence a surface can print: 「还差 配音 · 审核」
    reason: missing.length ? `还差 ${missing.map((k) => STAGE_LABEL[k] || k).join(" · ")}` : "",
  };
}

/**
 * 六个 stage → `shotStage` 那一个字。
 *
 * 五档词汇**一个不改**，三个消费者（故事板审片 / 镜头制作 / ⑦ 分镜表）的调用签名与
 * 既有断言全部继续成立。变的只是它从哪里算出来。
 *
 * SCOPE, STATED SO IT CANNOT BE MISREAD: this summarises the VISUAL chain, because
 * that is what the five legacy words describe and what the three consumers ask for.
 * `approved` here means 「这条视频已通过审片」, NOT 「整镜完成」 —— for the latter, call
 * `shotComplete` above.
 *
 * `designed` 由调用方给（镜头有没有设计内容是 draft shot 的事实，不是 stage 的）。
 */
export function summarizeStages(statuses, { designed = false } = {}) {
  const st = (k) => (isObj(statuses) && isObj(statuses[k]) ? statuses[k] : { status: "not_started" });
  const video = st("video");
  const keyframe = st("keyframe");
  if (video.status === "completed" && video.approved === true) return "approved";
  if (video.status === "completed") return "todo-review";
  if (keyframe.status === "completed") return "generated";
  if (designed) return "todo-generate";
  return "todo-design";
}

// 后期状态 —— 配音 / 音效 / 审核 这三步「还差什么」(TASK-096 / TASK-097 批次 5A)。
//
// ─────────────────────────────────────────────────────────────────────────────
// 本模块**不判定状态**。四态由 TASK-092 的 `shotstage` 算，本模块是它的第一个后期
// 消费者（TASK-096 §2.1：「不得再算一遍」）。这里做的是另外三件它不做的事：
//
//   1. **把「可以开始」与「可以定稿」分开显示**。判定本体在 `shotstage.canStart` /
//      `shotstage.canFinalize`（同一个引擎两张表），这里只负责把两个 ok 变成
//      创作者看得懂的一个词。这是本批的主要用户价值 ——
//      产品负责人原话「音频在视频之后，但可以并行准备」今天在界面上没有任何体现。
//
//   2. **说清「要不要做」这件事有没有人写下来**。这与「能不能开始」不是同一个问题：
//      闸门问的是前置到位没有，需求问的是这一镜到底需不需要一段配音。
//
//   3. **声音的证据通道**：`shotstage.artifact("voice"/"sfx")` 在批次 5A 之前一直
//      返回 null（老实话：没有通道）。这里把音频片段读成那个通道。
//
// ─────────────────────────────────────────────────────────────────────────────
// 一处**故意的**分歧，写在这里免得被当成 bug 修掉：
//
//   `shotstage` 的 `fact("dialogue")` 把**空台词读作 `skipped`**，理由是不要让一条
//   没台词的镜头把 voice 闸门永久锁死 —— 那个理由在**闸门**上成立。
//
//   但「需不需要配音」不是闸门。空着的台词列**分不清**「这一镜是默戏」和「台词还没
//   写」，所以在需求这个问题上它是 **null（不知道）**，不是「不需要」。
//   实测：照见未明rev2 的 60 个镜头由 AI 拆出来时**根本没有 dialogue 字段**，
//   此时印「60 镜无需配音」与存储页那句「媒体不可用 0」是同一类谎
//   （一个从未被任何人写下的断言）。
//
//   两个不同的问题，两个答案，各有一处 —— 不是同一件事实的两份拷贝（§2.5e/§2.5g）。
//   而且「不需要」在本仓库**已经有**表达方式：把这一步标为**跳过**（`skipStage`），
//   那是一条人做的决定，会被存下来。所以这里不发明第二套「不需要」的词汇。
//
// PURE：证据与镜头全部由调用方注入，没有 fetch / DOM / clock / 写入。

import {
  STAGES, STAGE_GROUP, STAGE_LABEL, STATUSES, STATUS_LABEL, FINALIZE_EXTRA,
} from "./shotstage.js";
import { TRACKS as AUDIO_TRACKS, TRACK_LABEL as AUDIO_TRACK_LABEL } from "./shotaudio.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const trimmed = (x) => (typeof x === "string" ? x.trim() : "");

/**
 * 后期那三步，**派生**自六个 stage 的分组 —— 不手写 `["voice","sfx","qc"]`。
 * 将来加 Lip Sync / BGM（ADR-0073 决策 4 说加一行即可），它会自动出现在后期面板上，
 * 而手写的那份清单会安静地漏掉它（§2.6.1：要派生，不要手写）。
 */
export const POST_STAGES = STAGES.filter((s) => STAGE_GROUP[s] !== "visual");

/**
 * 哪些音频轨算哪一步的产物。
 *
 * `bgm` **不属于任何一镜的 stage**：它是剧集级的音乐，按镜头去问「这一镜的 BGM 做完
 * 了吗」本身就是错的问题。所以它显式列在 `UNSTAGED_TRACKS` 里 ——
 * 「漏掉了」和「想清楚了不算」必须能分辨，守卫测试因此可以断言
 * **每一条轨都被分类过**：新增一条轨（拟音、旁白、Lip Sync）会当场被抓到，
 * 而不是静默地不参与任何状态。
 */
export const STAGE_TRACKS = {
  voice: ["dialogue", "vo"],
  sfx: ["ambience", "sfx", "foley"],
};

/** 有意不参与逐镜 stage 的轨，以及为什么。 */
export const UNSTAGED_TRACKS = {
  bgm: "剧集级的音乐，不逐镜判定 —— 在「剧集剪辑」里铺",
};

/** 这条轨属于哪一步；不属于任何一步时返回 null。 */
export function stageOfTrack(track) {
  for (const stage of Object.keys(STAGE_TRACKS)) {
    if (STAGE_TRACKS[stage].includes(track)) return stage;
  }
  return null;
}

/** 每一条轨都必须被分类过 —— 供守卫测试与本模块自己使用。 */
export function unclassifiedTracks(tracks = AUDIO_TRACKS) {
  return (Array.isArray(tracks) ? tracks : []).filter(
    (t) => !stageOfTrack(t) && !(t in UNSTAGED_TRACKS),
  );
}

/* -------------------------------------------------------------------------- */
/* 证据通道：音频片段 → `shotstage.artifact(stage)`                             */
/* -------------------------------------------------------------------------- */

/**
 * 一镜的音频片段读成 voice / sfx 两个 stage 的产物。
 *
 * `presentOf(assetId)` → bool：**探针的结论**，不是登记表的声明（与 keyframe /
 * video 那两条通道同一口径，TASK-077 那条教训）。
 *
 * 判定：这一步的轨上**至少有一个片段，且每一个都在**才算有产物。三条音效里丢了一条
 * 就不是「做完了」—— 合成出来会缺一条，而界面此刻说的是「已完成」。
 *
 * `assetId` 只在**恰好一个**片段时给出。它是「那一个」的绑点，而多份时确实
 * 不存在「那一个」—— 挑第一个去绑等于让「哪一份通过了」指向一个任意答案。
 *
 * `assetIds` 是这一步轨上的**全部**片段（TASK-087 §3.5.3）。批准按全称量词算：
 * **每一份都通过才算通过**，与上面 `present` 的「每一个都在」是同一条规矩 ——
 * 三条音效里丢了一条不算做完，那三条里有一条没过当然也不算通过。
 * 不需要新的 schema：`approvedFor` 本来就是绑产物的，缺的只是「多份时算谁」。
 */
export function audioEvidence(clips, { presentOf } = {}) {
  const has = typeof presentOf === "function" ? presentOf : () => false;
  const out = {};
  for (const stage of Object.keys(STAGE_TRACKS)) {
    const mine = (Array.isArray(clips) ? clips : []).filter(
      (c) => isObj(c) && STAGE_TRACKS[stage].includes(c.trackType),
    );
    if (!mine.length) { out[stage] = null; continue; }
    const allPresent = mine.every((c) => has(c.assetId));
    const ids = mine
      .map((c) => c.assetId)
      .filter((id) => typeof id === "string" && id);
    out[stage] = {
      assetId: mine.length === 1 && typeof mine[0].assetId === "string" ? mine[0].assetId : null,
      // 全部片段，供「每一份都通过才算通过」用（§3.5.3）。**片段数与 id 数不等**
      // 时（有片段没有 assetId）下面 `clips` 与 `assetIds.length` 会对不上 ——
      // 那种片段绑不了批准，所以它让整步不通过，而不是被悄悄跳过。
      assetIds: ids,
      present: allPresent,
      clips: mine.length,
    };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 「要不要做」——与「能不能开始」是两个问题                                      */
/* -------------------------------------------------------------------------- */

export const NEED_UNKNOWN = {
  voice: "台词列是空的 —— 空着分不清「这一镜是默戏」和「台词还没写」",
  sfx: "分镜表的「音效需求」列是空的 —— 空着分不清「这一镜不用音效」和「还没想」",
};

/** 不知道要不要做时，创作者**真实可做**的那件事（§2.5h 第二条）。 */
export const NEED_ACTIONS = {
  voice: "在分镜表的「台词」列写上台词，或者把这一镜的配音标为跳过",
  sfx: "在分镜表的「音效需求」列写下要什么音效，或者把这一镜的音效标为跳过",
};

/**
 * 这一镜的这一步**需不需要做**。
 *
 *   true  写下来了（台词非空）
 *   null  **没人写下来** —— 不是「不需要」。「不需要」的表达方式是把这一步标为跳过，
 *         那是一条会被存下来的人的决定。
 *
 * 所以本函数**永远不返回 false**：它没有资格代替创作者做那个决定。
 */
export function soundNeed(shot, stage) {
  if (stage === "voice") return trimmed(shot && shot.dialogue) ? true : null;
  // TASK-087 §3.5.2：以前这里无条件 `return null` —— 镜头上根本没有地方写
  // 「这一镜需要什么音效」，于是逐镜质检对音效**永远只能答无法判定**。
  // `sfxNote` 是那个地方，口径与 `dialogue` **完全一致**：写了就是要做，
  // 空着就是没人写下来（**不是不需要** —— 「不需要」要标为跳过，那是一条
  // 会被存下来的人的决定）。
  if (stage === "sfx") return trimmed(shot && shot.sfxNote) ? true : null;
  // qc 不问「要不要做」—— 每一镜都要判
  return true;
}

/* -------------------------------------------------------------------------- */
/* 一镜一步 → 一个词                                                           */
/* -------------------------------------------------------------------------- */

/**
 * 显示用的那一个词，闭集。
 *
 * `parallel` 与 `waiting` 是本批**新出现**的两个：它们正是「可以开始 ≠ 可以定稿」
 * 在屏幕上的形状，今天一个都没有。
 */
export const PHASES = [
  "done", "waiting", "running", "ready", "parallel", "blocked", "skipped", "unknown",
];

export const PHASE_LABEL = {
  done: "已完成",
  waiting: "等画面对齐",
  running: "进行中",
  ready: "可以开始",
  parallel: "现在就能开始",
  blocked: "还不能开始",
  skipped: "按设计跳过",
  unknown: "要不要做还没写下来",
};

/** 哪些 phase 算「这一步在这一镜上已经了结」。 */
export const SETTLED_PHASES = ["done", "skipped"];

/**
 * 这一步的定稿**有没有对齐前置**。
 *
 * 派生自 `FINALIZE_EXTRA`（那张表是唯一的来源）。为什么必须区分：
 * 「等画面对齐」只有对**有对齐前置**的那些步骤成立。`video` 没有额外前置，
 * 于是 `canFinalize === canStart` —— 一条**已经有视频**、但关键帧从未做过的镜头
 * 会被读成「等画面对齐」，而它其实就是做完了（产物在，上游那道闸门此刻已经无意义）。
 * 批次 5B 的逐镜质检第一次把 `video` 也放进来，这个缺陷当场现形。
 */
export function hasAlignmentGate(stage) {
  return Array.isArray(FINALIZE_EXTRA[stage]) && FINALIZE_EXTRA[stage].length > 0;
}

/**
 * `cell` 是 `shotstage.stageBoard(shotId)[stage]` —— **直接用，不重算**。
 *
 * 读不出四态就是 `unknown`，绝不读作放行（§2.5f：不知道 ≠ 放行）。
 */
export function postPhase(cell, need) {
  if (!isObj(cell) || !STATUSES.includes(cell.status)) return "unknown";
  if (cell.status === "skipped") return "skipped";
  const canFinalize = !!(isObj(cell.finalize) && cell.finalize.ok);
  // 认不出是哪一步时按**有对齐前置**处理：「等画面对齐」比「已完成」保守，
  // 而这里宁可保守也不要替创作者宣布做完了。
  const gated = typeof cell.stage === "string" ? hasAlignmentGate(cell.stage) : true;
  if (cell.status === "completed") return gated && !canFinalize ? "waiting" : "done";
  if (cell.status === "in_progress") return "running";
  // 还没开始 —— 这里才轮到「要不要做」
  if (need !== true) return "unknown";
  if (!cell.ok) return "blocked";
  return canFinalize ? "ready" : "parallel";
}

/**
 * 一镜 × 三步。
 *
 * `boardOf(shotId)` → `shotstage.stageBoard(shotId)`。给不出 board 的镜头，三步
 * 全部 `unknown` —— 那是老实话，不是「都没开始」。
 */
export function postRows(shots, { boardOf, needOf, stages = POST_STAGES } = {}) {
  const board = typeof boardOf === "function" ? boardOf : () => null;
  const need = typeof needOf === "function" ? needOf : soundNeed;
  const which = Array.isArray(stages) && stages.length ? stages : POST_STAGES;
  const rows = [];
  for (const shot of Array.isArray(shots) ? shots.filter(isObj) : []) {
    const shotId = typeof shot.shotId === "string" ? shot.shotId : "";
    if (!shotId) continue;
    const b = board(shotId);
    // `stages` 可以指定 —— 逐镜质检要问的是 video / voice / sfx（批次 5B），
    // 而它必须**用这一份派生**，不是再写一遍 phase 那套词汇（§2.5g）。
    for (const stage of which) {
      const cell = isObj(b) ? b[stage] : null;
      const known = isObj(cell) && STATUSES.includes(cell.status);
      const needed = need(shot, stage);
      const phase = postPhase(cell, needed);
      rows.push({
        shotId,
        seq: Number.isFinite(shot.sequence) ? shot.sequence : null,
        title: trimmed(shot.title) || shotId,
        stage,
        stageLabel: STAGE_LABEL[stage] || stage,
        status: known ? cell.status : null,
        statusLabel: known ? (STATUS_LABEL[cell.status] || cell.status) : null,
        needed,
        needWhy: needed === true ? null : (NEED_UNKNOWN[stage] || null),
        needAction: needed === true ? null : (NEED_ACTIONS[stage] || null),
        canStart: !!(isObj(cell) && cell.ok),
        startBlockers: isObj(cell) && Array.isArray(cell.blockers) ? cell.blockers : [],
        canFinalize: !!(isObj(cell) && isObj(cell.finalize) && cell.finalize.ok),
        finalizeBlockers: isObj(cell) && isObj(cell.finalize) && Array.isArray(cell.finalize.blockers)
          ? cell.finalize.blockers
          : [],
        phase,
        phaseLabel: PHASE_LABEL[phase],
      });
    }
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* 汇总                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 每一步一行。
 *
 * `known: false` 只在**一个镜头都没有**时出现 —— 那时说「0 镜已完成」是在断言一件
 * 我们没资格断言的事（`counts.js` 同一条规矩）。有镜头时每一镜都归入某个 phase，
 * 其中 `unknown` 本身就是一个如实的桶，不会被并进「还没开始」。
 */
export function postSummary(rows, { stages = POST_STAGES } = {}) {
  const all = Array.isArray(rows) ? rows.filter(isObj) : [];
  const out = {};
  for (const stage of stages) {
    const mine = all.filter((r) => r.stage === stage);
    const by = Object.fromEntries(PHASES.map((p) => [p, 0]));
    for (const r of mine) if (r.phase in by) by[r.phase] += 1;
    const settled = SETTLED_PHASES.reduce((n, p) => n + by[p], 0);
    out[stage] = {
      stage,
      label: STAGE_LABEL[stage] || stage,
      known: mine.length > 0,
      total: mine.length,
      by,
      settled,
      text: summaryText(stage, mine.length, by),
    };
  }
  return out;
}

/** 只印非零的桶，按 `PHASES` 的顺序 —— 「0 镜进行中」是噪音，不是信息。 */
function summaryText(stage, total, by) {
  const label = STAGE_LABEL[stage] || stage;
  if (!total) return `${label}：还没有镜头可判`;
  const parts = PHASES.filter((p) => by[p] > 0).map((p) => `${by[p]} 镜${PHASE_LABEL[p]}`);
  return `${label}：${parts.join(" · ")}`;
}

/**
 * 「可以开始」与「可以定稿」在这一集上的差额 —— 本批要让创作者看见的那句话。
 *
 * 只有真的存在这个差额时才给出文字：没有一镜处在那个窗口里的时候，
 * 印一句「0 镜现在就能开始」只是把规则念了一遍。
 */
export function parallelWindow(rows) {
  const all = Array.isArray(rows) ? rows.filter(isObj) : [];
  const now = all.filter((r) => r.phase === "parallel");
  const waiting = all.filter((r) => r.phase === "waiting");
  const reason = [...now, ...waiting]
    .flatMap((r) => r.finalizeBlockers)
    .find((b) => typeof b === "string" && b) || null;
  return {
    startable: now.length,
    awaitingPicture: waiting.length,
    exists: now.length > 0 || waiting.length > 0,
    reason,
    text: now.length
      ? `${now.length} 处现在就能开始 —— 不用等视频；定稿再等画面`
      : (waiting.length ? `${waiting.length} 处素材已就位，等画面对齐才能定稿` : ""),
  };
}

/**
 * 声音资产：还差哪些文件。
 *
 * **为什么在后期这一页，而不是第 ② 步**（TASK-096 §2.3，写在屏幕上免得被「修」回去）：
 * 第 ② 步准备的是进模型的图，声音不参与图像生成；而音效要落在画面的动作上，
 * 在还没有画面时挑，挑完必然重挑。
 */
export const SOUND_HOME_WHY =
  "声音资产在后期这一页准备，不在第 ② 步：② 准备的是进模型的图，声音不参与出图；"
  + "而音效要贴画面的动作，没有画面时挑完必然重挑";

export function soundGaps(rows) {
  const all = Array.isArray(rows) ? rows.filter(isObj) : [];
  const audio = all.filter((r) => r.stage === "voice" || r.stage === "sfx");
  const isMissing = (r) => r.needed === true && !SETTLED_PHASES.includes(r.phase);
  const byStage = {};
  for (const stage of Object.keys(STAGE_TRACKS)) {
    const mine = audio.filter((r) => r.stage === stage);
    const undecided = mine.filter((r) => r.phase === "unknown");
    byStage[stage] = {
      stage,
      label: STAGE_LABEL[stage] || stage,
      tracks: STAGE_TRACKS[stage].map((t) => AUDIO_TRACK_LABEL[t] || t),
      missing: mine.filter(isMissing).length,
      undecided: undecided.length,
      have: mine.filter((r) => r.phase === "done" || r.phase === "waiting").length,
      why: undecided.length ? (NEED_UNKNOWN[stage] || null) : null,
      action: undecided.length ? (NEED_ACTIONS[stage] || null) : null,
    };
  }
  return {
    missing: audio.filter(isMissing).length,
    undecided: audio.filter((r) => r.phase === "unknown").length,
    byStage,
  };
}

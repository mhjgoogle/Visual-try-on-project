// RIGHT of 剧集制作 — AI 导演，作为真实操作入口 (TASK-067 §2 / §6 / §18 / §19).
//
//   当前判断    林晚在酒吧擦杯子 —— 可以生成 Image Prompt 了
//   已匹配      ✓ 林晚 / 夜班 Ref   ✓ 暗夜酒吧 Ref
//   缺少        ! Start Frame  ! Motion Ref
//   下一步      [生成 Image Prompt]  [推荐参考资产]  [连续性检查]
//   推荐资产    林晚 / 少女时期 Ref   [接受] [替换] [忽略]
//   提案        Image Prompt Proposal  [应用] [重新生成] [忽略]
//
// WHY THIS MODULE EXISTS (§2). The Director was a status column: 当前上下文 / 一段
// 观察 / 生产计划 / 资产收件箱, plus a 能力 section that was a CATALOG — open it,
// scroll twenty skills, pick an executor, press 运行. Every real question a creator
// has while making a shot ("what is missing", "which reference should I use", "is
// this prompt any good") was answerable only by them, by hand. §2 asks for ten
// operations; this is where they live.
//
// FOUR RULES IT FOLLOWS:
//
//   1. NOTHING IS FABRICATED (§6). Every ✓ and every ! comes from
//      `shotctx.shotReadiness`, derived from the documents. There is no demo copy in
//      this file, and no recommendation is invented here — a recommendation can only
//      arrive as a Skill Proposal (ADR-0064 决策 4).
//   2. AN UNAVAILABLE CAPABILITY SAYS SO (§2 last line / §14). A runtime that is not
//      runnable, a required input that is missing, a review with nothing to review:
//      each renders as a stated reason, never as a button that pretends.
//   3. THE CREATOR DECIDES (§5 / §13). Every action here goes through
//      `ctx.actions.dispatch` after an explicit press. Nothing auto-applies.
//   4. CREATOR FIRST (§18). runtime / model / skill version / context snapshot / ids
//      live inside `<details>`. The surface answers 「现在怎么办」.
//
// PURE PRESENTATION over ctx.shotctx / ctx.skills. No state of its own.

import { esc } from "../util/dom.js";
import { EXECUTOR_STATE_LABEL, isRunnable, suggestExecutor } from "../services/runtime.js";
import { applicabilityFor } from "../workflow/skillapply.js";
import { isPending, isOpen } from "../workflow/skillrun.js";

/**
 * The operations §2 asks for, in the order a shot actually gets made.
 *
 * Each names the capability it runs and the readiness gate it needs. A gate is a
 * FIELD of the readiness model, not a re-derivation: the button and the checklist
 * must agree about whether this shot is ready, and they can only do that by reading
 * the same value.
 *
 * `A. 分析当前 Shot` is deliberately NOT in this list — it is not a model run. The
 * analysis is `shotReadiness`, which is derived and always current, so making the
 * creator press a button to see it (and wait for a model) would be theatre.
 */
export const OPERATIONS = [
  {
    key: "recommend",
    skillId: "shot-asset-recommender",
    label: "推荐参考资产",
    hint: "在资产库里按这一镜的人物 / 场景 / 描述检索，给出该绑定哪些参考",
    gate: null,
    scope: "assetRecommendation",
  },
  {
    key: "imagePrompt",
    skillId: "image-prompt-director",
    label: "生成 Image Prompt",
    hint: "把参考、状态、镜头规格编译成这次出图真正要用的提示词",
    gate: "canWriteImagePrompt",
    gateReason: "还缺 Image Prompt 的必要输入",
    primary: true,
  },
  {
    key: "reviewImage",
    skillId: "prompt-reviewer",
    label: "审核 Image Prompt",
    hint: "人物 / 场景一致性、服装与状态、构图、光影、是否遗漏关键内容",
    needsPrompt: "image",
    scope: "promptReview",
  },
  {
    key: "videoPrompt",
    skillId: "video-prompt-director",
    label: "生成 Video Prompt",
    hint: "以已选定的主帧图为第 1 帧，写出动作、运镜、表演、环境运动与节奏",
    gate: "canWriteVideoPrompt",
    gateReason: "要先有一版已选定的主帧图",
    primary: true,
  },
  {
    key: "reviewVideo",
    skillId: "prompt-reviewer",
    label: "审核 Video Prompt",
    hint: "动作逻辑、运镜与机位参考是否冲突、时长、前后镜连续性、视觉漂移风险",
    needsPrompt: "video",
    scope: "promptReview",
  },
  {
    key: "continuity",
    skillId: "shot-continuity-reviewer",
    label: "连续性检查",
    hint: "与前后镜的人物、状态、服装、场景、时间天气、道具、画面方向、首尾帧",
    scope: "continuitySummary",
  },
];

/** Which operation is the ONE to lead with, given where the shot stands.
 *
 *  Exactly one: a panel that highlights three next steps has not answered
 *  「下一步是什么」, it has restated the list. */
export function primaryOperation(readiness, context) {
  if (!readiness || !context) return null;
  if (!context.prompts.image.text) {
    return readiness.canWriteImagePrompt ? "imagePrompt" : "recommend";
  }
  if (!context.media.selectedShotImage) return "reviewImage";
  if (!context.prompts.video.text) {
    return readiness.canWriteVideoPrompt ? "videoPrompt" : "recommend";
  }
  if (!context.media.selectedShotVideo) return "reviewVideo";
  return "continuity";
}

/**
 * Everything the panel renders.
 *
 * `probe` is the executor availability map the shell caches. `null` means 「还没探测」,
 * which is displayed as such and NEVER as available (§14).
 */
export function shotDirectorModel(ctx, ui, probe) {
  const shotId = ui.selectedShotId || null;
  if (!shotId) return { empty: true };
  const built = ctx.shotctx.build(shotId);
  const context = built.context;
  if (!context) return { empty: true, unresolved: true };
  const readiness = ctx.shotctx.readiness(shotId);
  const runs = ctx.skills.runs();

  // --- RUNTIME standing (§14) --------------------------------------------- //
  // The creator's chosen executor, and whether it can actually run. `manual` is a
  // first-class peer here, not a fallback: it is the route that works today.
  const executors = ctx.skills.executors().map((e) => {
    const p = probe && probe[e.id] ? probe[e.id] : null;
    return {
      id: e.id,
      title: e.title,
      runtime: e.runtime,
      goodAt: e.goodAt,
      state: p ? p.state : null,
      stateLabel: p ? EXECUTOR_STATE_LABEL[p.state] || p.state : "未探测",
      detail: p ? p.detail : "",
      runnable: p ? isRunnable(p.state) : false,
    };
  });
  // WHO RUNS WHAT, by default (TASK-067 §14).
  //
  //   Claude Code  执行     — 创作型能力（推荐 / 写 Prompt）
  //   Codex CLI    审阅     — 复核型能力（Prompt Review / 连续性检查）
  //   手工          任何     — 兜底，永远可用
  //
  // A DEFAULT, NOT A BINDING (ADR-0056 决策 1). The creator's own pick always wins,
  // every executor can run every capability, and the radios stay free. What this
  // removes is only the need to re-pick an executor for every operation — and the
  // risk of Codex silently becoming the creative director, which §14 forbids.
  const isRunnableFor = (id) => {
    const e = executors.find((x) => x.id === id);
    return !!(e && e.runnable);
  };
  // THE CREATOR'S OWN OVERRIDE, and only that.
  //
  // Deliberately `ui.sdExecutor` rather than the legacy 能力 panel's
  // `ui.skillExecutor`: that one is DEFAULTED to "manual" the first time a skill is
  // picked there, and reading it here made a default nobody chose look like an
  // explicit decision — which pinned every operation to 手工 and silently cancelled
  // the whole 「Claude Code 执行 / Codex 审阅」 division. A default is not a choice.
  const chosenId = ui.sdExecutor && isRunnableFor(ui.sdExecutor) ? ui.sdExecutor : null;
  // `chosen` is the creator's OVERRIDE, or null for 「按操作自动选择」. It used to fall
  // back to `manual`, which made the radio group show 手工 as selected while the
  // buttons were really running on Claude Code and Codex — the panel and the buttons
  // disagreeing about which subscription a click spends (codex review round 1 follow-up).
  const chosen = chosenId ? executors.find((e) => e.id === chosenId) || null : null;

  // --- the OPERATIONS, each with its real availability -------------------- //
  const ops = OPERATIONS.map((op) => {
    const skill = ctx.skills.find(op.skillId);
    // `reviewKind` decides WHICH prompt a review reads, so it must travel into the
    // context builder — otherwise both review buttons would review the same side.
    const extra = op.needsPrompt ? { reviewKind: op.needsPrompt } : {};
    const missing = skill ? ctx.skills.missing(op.skillId, extra, { shotId }) : [];
    // WHICH executor this operation would use — resolved BEFORE availability, because
    // 「这个能力现在能不能跑」 depends on the executor it would actually use, not on a
    // single panel-wide choice. `suggestExecutor` falls back to manual, which always
    // works, so this is never the reason an operation is blocked.
    const executorId = suggestExecutor(skill ? skill.work : "creative", isRunnableFor, chosenId);
    const executor = executors.find((e) => e.id === executorId) || null;
    // THE REASONS, in the order the creator can act on them
    let unavailable = null;
    if (!skill) unavailable = `「${op.skillId}」这个能力不存在`;
    else if (op.gate && readiness && !readiness[op.gate]) unavailable = op.gateReason;
    else if (op.needsPrompt && !context.prompts[op.needsPrompt].text) {
      unavailable = op.needsPrompt === "image" ? "还没有 Image Prompt 可审" : "还没有 Video Prompt 可审";
    } else if (missing.length) {
      unavailable = `缺少必要输入：${missing.map((k) => ctx.skills.inputLabel(k)).join("、")}`;
    } else if (!executor) unavailable = "没有可用的执行方式";
    else if (!executor.runnable) unavailable = `「${executor.title}」当前${executor.stateLabel}`;
    // the newest run of THIS operation, so the panel can show its proposal
    const mine = runs
      .filter((r) => r && r.skillId === op.skillId
        && r.context && r.context.shotId === shotId
        && (!op.needsPrompt || (r.contextTrace && r.contextTrace.reviewedPromptKind === op.needsPrompt)))
      .slice().reverse();
    const cached = op.scope ? ctx.shotctx.cached(op.scope, shotId, op.needsPrompt || null) : null;
    return {
      ...op,
      version: skill ? skill.version : null,
      role: skill ? skill.role : null,
      work: skill ? skill.work : null,
      executorId,
      executorTitle: executor ? executor.title : executorId,
      unavailable,
      available: !unavailable,
      missing,
      // "still going" = every NON-TERMINAL state, taken from the domain rather
      // than re-listed here. Hand-listing them left `awaiting_confirmation` out,
      // so a run waiting for the creator's approval read as absent and the panel
      // offered actions that conflict with it (codex review, round 7).
      open: mine.find(isOpen) || null,
      pending: mine.find(isPending) || null,
      last: mine[0] || null,
      // a REMEMBERED conclusion, with honest staleness (§15)
      cached: cached ? { stale: cached.stale, at: cached.at, value: cached.value } : null,
    };
  });

  const primary = primaryOperation(readiness, context);
  return {
    empty: false,
    shotId,
    context,
    trace: built.trace,
    readiness,
    ops,
    primary,
    executors,
    chosen,
    probed: !!probe,
    // the ONE proposal that needs a decision right now — the newest across all
    // operations for this shot. Surfacing several would ask the creator to choose
    // which decision to make first, which is not a decision they asked for.
    pending: ops.map((o) => o.pending).filter(Boolean)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null,
    // …and the NEWEST open run, not the first in operation order.
    //
    // Ordering by operation looked tidy and was wrong: a run left `running` — a manual
    // run the creator walked away from, a local run whose page was closed — sits in
    // that slot forever, and every answer pasted afterwards goes to THAT run instead of
    // the operation just pressed. It fails schema validation (a recommendation is not a
    // prompt), the creator sees 「结果未被采纳」 for an answer that was perfectly good,
    // and the real run they started is never reachable. Found on the real project,
    // which had accumulated exactly such leftovers.
    openRun: ops.map((o) => o.open).filter(Boolean)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null,
    // every OTHER run still waiting, so a stale one can be abandoned rather than
    // silently blocking the slot
    otherOpen: ops.map((o) => o.open).filter(Boolean)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(1),
  };
}

/* ========================================================================== */
/* render                                                                     */
/* ========================================================================== */

const SEV_MARK = { blocking: "✕", gap: "!", soft: "·" };

function haveList(r) {
  if (!r.have.length) return `<div class="meta">这一镜还没有任何参考输入。</div>`;
  return (
    `<ul class="sd-have">` +
    r.have.map((h) =>
      `<li><span class="mk ok">✓</span><span class="nm">${esc(h.label)}</span>` +
      `<span class="dt">${esc(h.names.slice(0, 2).join("、") || `${h.count} 个`)}` +
      `${h.names.length > 2 ? ` 等 ${h.names.length} 个` : ""}</span></li>`).join("") +
    `</ul>`
  );
}

/** The gaps, each with the action that closes it. A gap the creator cannot act on
 *  is just a complaint, so every row carries its own way forward.
 *
 *  ONE BUTTON PER DISTINCT FIX. A shot with no references has a gap per role — 人物 /
 *  场景 / 风格 / 机位 / 运动 / 表演 — and every one of them is closed by the SAME
 *  recommender run, so a button on each row gave the real project eight identical
 *  「找参考」 buttons in a 300px column (found by the Connected acceptance). The first
 *  row of a kind carries the action; the rest state the gap. */
function missingList(r) {
  const rows = [...r.blocking, ...r.gaps, ...r.soft];
  if (!rows.length) return `<div class="meta ok">没有缺失项——这一镜的输入是齐的。</div>`;
  const seenFix = new Set();
  return (
    `<ul class="sd-miss">` +
    rows.map((row) => {
      const first = !seenFix.has(row.fix);
      seenFix.add(row.fix);
      const m = first ? row : { ...row, fix: null };
      return (
      `<li class="sv-${esc(m.severity)}">` +
      `<span class="mk">${SEV_MARK[m.severity] || "!"}</span>` +
      `<span class="tx">${esc(m.text)}</span>` +
      (m.fix === "usePreviousShotEndFrame"
        ? `<button class="btn sm" data-sd-fix="usePreviousShotEndFrame">接上一镜尾帧</button>`
        : m.fix === "recommend"
          ? `<button class="btn sm" data-sd-op="recommend">找参考</button>`
          : m.fix === "interpret"
            ? `<button class="btn sm" data-sd-interp="${esc((m.refKeys || []).join(","))}">去解读</button>`
            : m.fix === "prepareImageGeneration"
              ? `<button class="btn sm" data-sd-prepare="image">准备出图</button>`
              : m.fix === "scene"
                ? `<button class="btn sm" data-sd-goto="scenes">去场景</button>`
                : m.fix === "shot"
                  ? `<button class="btn sm" data-sd-goto="shots">去镜头</button>`
                  : "") +
      `</li>`
      );
    }).join("") +
    `</ul>`
  );
}

/** One operation button, or its honest reason for being unavailable. */
function opButton(op, isPrimary) {
  if (!op.available) {
    return (
      `<div class="sd-op off">` +
      `<span class="nm">${esc(op.label)}</span>` +
      `<span class="why">◌ ${esc(op.unavailable)}</span></div>`
    );
  }
  return (
    `<button class="sd-op${isPrimary ? " primary" : ""}" data-sd-op="${esc(op.key)}" ` +
    `data-exec="${esc(op.executorId || "")}" ` +
    `title="${esc(`${op.hint}\n执行：${op.executorTitle || ""}`)}">` +
    `<span class="nm">${esc(op.label)}</span>` +
    // WHO WILL RUN IT, on the button. 「审核」 going to Codex and 「生成」 going to
    // Claude Code is the division of labour §14 asks for, and it has to be visible
    // BEFORE the press — otherwise the creator cannot tell which subscription a
    // click is about to spend.
    `<span class="ex">${esc(op.executorTitle || "")}</span>` +
    (op.pending ? `<span class="chip gate">有提案</span>` : "") +
    (op.cached && !op.pending
      ? `<span class="chip${op.cached.stale ? " gate" : " mute"}">${op.cached.stale ? "结论已过期" : "有上次结论"}</span>`
      : "") +
    `</button>`
  );
}

/**
 * A proposal, rendered as WHAT IT PROPOSES rather than as raw JSON.
 *
 * The JSON is still reachable (in 详情), because a structured proposal is the thing
 * the Action Layer will act on and the creator is entitled to see it. But a 300px
 * column whose primary content is `JSON.stringify` has not presented a decision.
 */
function proposalBody(run) {
  const p = run.proposal || {};
  // PROPOSAL-AWARE, not just capability-aware: a Prompt Review with no rewrite has
  // nothing to write, and offering 应用 for it is a button that fails on press.
  const app = applicabilityFor(run.skillId, p);
  const rows = [];

  if (Array.isArray(p.recommendations) && p.recommendations.length) {
    rows.push(
      `<div class="lab">推荐参考</div><ul class="sd-recs">` +
      p.recommendations.map((r) =>
        `<li><b>${esc(r.referenceKey || "")}</b>` +
        (r.use ? `<span class="chip mute">${esc(r.use)}</span>` : "") +
        (r.replacesKey ? `<span class="chip">替换 ${esc(r.replacesKey)}</span>` : "") +
        `<span class="rz">${esc(r.reason || "")}</span></li>`).join("") +
      `</ul>`,
    );
  }
  if (Array.isArray(p.missing) && p.missing.length) {
    rows.push(
      `<div class="lab">还需要新建的参考</div><ul class="sd-miss">` +
      p.missing.map((m) => `<li class="sv-gap"><span class="mk">!</span><span class="tx">${esc(m.kind || "")}${m.subject ? ` · ${esc(m.subject)}` : ""}：${esc(m.reason || "")}</span></li>`).join("") +
      `</ul>`,
    );
  }
  if (typeof p.prompt === "string" && p.prompt.trim()) {
    rows.push(`<div class="lab">提议的 Prompt</div><pre class="sd-pre">${esc(p.prompt)}</pre>`);
    for (const [k, label] of [
      ["actionSequence", "动作序列"], ["cameraMotion", "运镜"], ["performance", "表演"],
      ["environmentMotion", "环境运动"], ["pacing", "节奏"], ["continuity", "连续性"],
      ["visualStability", "视觉稳定性"],
    ]) {
      if (typeof p[k] === "string" && p[k].trim()) {
        rows.push(`<div class="sd-axis"><b>${esc(label)}</b>${esc(p[k])}</div>`);
      }
    }
  }
  if (Array.isArray(p.issues)) {
    rows.push(p.issues.length
      ? `<div class="lab">审核发现</div><ul class="sd-iss">` +
        p.issues.map((i) =>
          `<li class="sv-${esc(i.severity || "minor")}"><b>${esc(i.where || "")}</b>` +
          `<span class="tx">${esc(i.problem || "")}</span>` +
          (i.fix ? `<span class="fx">→ ${esc(i.fix)}</span>` : "") + `</li>`).join("") +
        `</ul>`
      : `<div class="meta ok">审核没有发现问题。</div>`);
    if (typeof p.suggestedText === "string" && p.suggestedText.trim()) {
      rows.push(`<div class="lab">建议的改写</div><pre class="sd-pre">${esc(p.suggestedText)}</pre>`);
    }
  }
  if (Array.isArray(p.unknown) && p.unknown.length) {
    // THE FIELD THAT MAKES 「没问题」 TRUSTWORTHY — see the skill's own contract
    rows.push(
      `<div class="lab">无法判断</div><ul class="sd-unk">` +
      p.unknown.map((u) => `<li><b>${esc(u.kind || "")}</b>${esc(u.reason || "")}</li>`).join("") +
      `</ul><div class="meta">这些项没有被检查，不是「通过」。</div>`,
    );
  }
  if (Array.isArray(p.assumptions) && p.assumptions.length) {
    rows.push(
      `<div class="lab">它替你做的假设</div><ul class="sd-asm">` +
      p.assumptions.map((a) => `<li>${esc(a)}</li>`).join("") + `</ul>`,
    );
  }
  if (Array.isArray(p.missingInputs) && p.missingInputs.length) {
    rows.push(
      `<div class="lab">它说还缺</div><ul class="sd-asm">` +
      p.missingInputs.map((a) => `<li>${esc(a)}</li>`).join("") + `</ul>`,
    );
  }
  if (!rows.length) rows.push(`<pre class="sd-pre">${esc(JSON.stringify(p, null, 2))}</pre>`);

  return (
    `<div class="sd-prop">` +
    `<div class="sd-proph"><b>提案</b>` +
    `<span class="chip mute">${esc(run.model || "模型未记录")}</span></div>` +
    rows.join("") +
    (app.can
      ? `<div class="meta">${esc(app.detail || "")}</div>`
      : `<div class="dir-unavail">◌ ${esc(app.reason || "没有可写回的目标")}</div>`) +
    `<div class="sd-acts">` +
    (app.can ? `<button class="btn primary sm" data-sd-apply="${esc(run.runId)}">应用</button>` : "") +
    `<button class="btn sm" data-sd-regen="${esc(run.runId)}">重新生成</button>` +
    `<button class="btn sm" data-sd-reject="${esc(run.runId)}">忽略</button>` +
    `</div>` +
    `<details class="sd-det"><summary>结构化提案 / 运行详情</summary>` +
    `<div class="sd-kv"><span>能力</span><code>${esc(run.skillId)} v${esc(String(run.skillVersion))}</code></div>` +
    `<div class="sd-kv"><span>执行</span><code>${esc(run.executor || "—")} · ${esc(run.runtime || "—")}</code></div>` +
    `<div class="sd-kv"><span>模型</span><code>${esc(run.model || "未记录")}</code></div>` +
    `<div class="sd-kv"><span>提案 id</span><code>${esc((run.proposal && run.proposal.proposalId) || "—")}</code></div>` +
    `<pre class="sd-pre">${esc(JSON.stringify(p, null, 2))}</pre></details>` +
    `</div>`
  );
}

/**
 * Which operation produced this run?
 *
 * `skillId` ALONE IS NOT AN ANSWER. 图片 Prompt 审核 and 视频 Prompt 审核 are two
 * operations sharing one skill (`prompt-reviewer`), so matching on skillId silently
 * returns whichever is declared first — the image one — and a video review then gets
 * filed as an image review (codex review round 5, the hole left by round 4's fix).
 *
 * The run itself records which side it read, in `contextTrace.reviewedPromptKind`.
 * That is the only trustworthy discriminator, so every caller goes through here
 * rather than re-deriving it — three copies of this predicate is how one of them
 * ends up wrong.
 */
export function operationOfRun(run) {
  if (!run) return null;
  return OPERATIONS.find((o) => o.skillId === run.skillId
    && (!o.needsPrompt || (run.contextTrace && run.contextTrace.reviewedPromptKind === o.needsPrompt))) || null;
}

/** WHICH capability an open run belongs to, in words — so the creator can tell that
 *  the box in front of them is waiting for a Video Prompt and not a recommendation. */
function opLabelOf(run) {
  const op = operationOfRun(run);
  return op ? op.label : run.skillId;
}

/**
 * An OPEN manual run: the creator is the runtime, so the panel hands them the prompt
 * and takes the answer back through the same validation gate.
 *
 * It NAMES the capability. With one anonymous 「等你把答案带回来」 box, an answer for
 * the wrong operation looks identical to an answer for the right one — and the
 * validator rejects it with a message about a schema the creator never saw.
 */
function openRunBody(run, others) {
  const stale = others && others.length
    ? `<div class="meta">另有 ${others.length} 次运行也在等答案（` +
      others.map((r) => esc(opLabelOf(r))).join("、") +
      `）。放弃它们可以让这一栏只剩你正在做的那一次：` +
      others.map((r) => `<button class="btn sm" data-sd-abandon="${esc(r.runId)}">放弃「${esc(opLabelOf(r))}」</button>`).join("") +
      `</div>`
    : "";
  if (run.executor !== "manual") {
    return (
      `<div class="sd-open"><b>运行中 · ${esc(opLabelOf(run))}</b>` +
      `<div class="meta">由「${esc(run.executor || "")}」执行，答案回来后会自动变成提案。</div>` +
      `<div class="sd-acts"><button class="btn sm" data-sd-abandon="${esc(run.runId)}">放弃这次运行</button></div>` +
      stale + `</div>`
    );
  }
  return (
    `<div class="sd-open"><b>等你把答案带回来 · ${esc(opLabelOf(run))}</b>` +
    `<div class="meta">复制下面的任务 Prompt，到 ChatGPT / Claude / Gemini 里跑，把结果原样粘回来。` +
    `同一个能力、同一份输出契约、同一道确认门——只是执行者不同。</div>` +
    `<div class="sd-acts"><button class="btn sm" data-sd-copyprompt="${esc(run.runId)}">复制任务 Prompt</button>` +
    `<button class="btn sm" data-sd-abandon="${esc(run.runId)}">放弃</button></div>` +
    `<textarea class="field sd-answer" rows="6" spellcheck="false" placeholder="粘贴模型返回的 JSON"></textarea>` +
    `<div class="sd-acts"><button class="btn primary sm" data-sd-submit="${esc(run.runId)}">提交结果</button></div>` +
    stale + `</div>`
  );
}

export function renderShotDirector(m, ui) {
  if (m.empty) {
    return (
      `<section class="sd">` +
      `<div class="meta">${m.unresolved
        ? "选中的镜头已不在当前草稿版本里——重新选一个镜头。"
        : "先在上面选一个镜头，AI 导演会分析它现在缺什么、下一步该做什么。"}</div></section>`
    );
  }
  const r = m.readiness;
  const c = m.context;
  const title = `${String(c.shot.sequence).padStart(2, "0")} ${c.shot.title || ""}`.trim();

  // OPERATIONS: the primary one leads, the rest follow in chain order. Unavailable
  // ones are listed with their reason rather than hidden — 「为什么不能」 is the
  // information the creator needs (§2 last line).
  const available = m.ops.filter((o) => o.available);
  const blocked = m.ops.filter((o) => !o.available);
  const ordered = [
    ...available.filter((o) => o.key === m.primary),
    ...available.filter((o) => o.key !== m.primary),
  ];

  return (
    `<section class="sd">` +
    // --- 当前判断 (§19) --------------------------------------------------- //
    `<div class="sd-verdict"><div class="sd-shot">${esc(title)}</div>` +
    `<div class="sd-v">${esc(r.verdict)}</div></div>` +

    // --- 已匹配 / 缺少 (§6) ---------------------------------------------- //
    `<div class="lab">已匹配</div>${haveList(r)}` +
    `<div class="lab">缺少</div>${missingList(r)}` +

    // --- 下一步 (§2) ----------------------------------------------------- //
    `<div class="lab">下一步</div>` +
    `<div class="sd-ops">${ordered.map((o) => opButton(o, o.key === m.primary)).join("")}</div>` +
    (blocked.length
      ? `<details class="sd-det"><summary>另有 ${blocked.length} 项现在还不能做</summary>` +
        blocked.map((o) => opButton(o, false)).join("") + `</details>`
      : "") +

    // --- the one open run / the one pending proposal ---------------------- //
    (m.openRun ? openRunBody(m.openRun, m.otherOpen) : "") +
    (m.pending ? proposalBody(m.pending) : "") +

    // --- ADVANCED (§18): runtime, model, context snapshot, ids ------------ //
    `<details class="sd-det adv"${ui.sdAdv ? " open" : ""}><summary>运行方式与本次依据</summary>` +
    `<div class="lab">执行方式</div>` +
    `<div class="sd-execs">` +
    // AUTO is a real, selectable state, not the absence of a choice: with no override
    // each operation picks the executor suited to its kind of work, and the panel has
    // to be able to say so instead of pointing at whichever one it fell back to.
    `<label class="sd-exec${m.chosen ? "" : " on"}">` +
    `<input type="radio" name="sd-exec" value="__auto"${m.chosen ? "" : " checked"}>` +
    `<span class="nm">按操作自动选择</span>` +
    `<span class="chip ok">推荐</span>` +
    `<span class="ga">创作 → Claude Code · 审阅 → Codex（按钮上写着各自用哪个）</span></label>` +
    m.executors.map((e) =>
      `<label class="sd-exec${m.chosen && e.id === m.chosen.id ? " on" : ""}">` +
      `<input type="radio" name="sd-exec" value="${esc(e.id)}"${m.chosen && e.id === m.chosen.id ? " checked" : ""}>` +
      `<span class="nm">${esc(e.title)}</span>` +
      `<span class="chip${e.runnable ? " ok" : e.state ? " bad" : " mute"}">${esc(e.stateLabel)}</span>` +
      `<span class="ga">${esc(e.goodAt || "")}</span></label>`).join("") +
    `</div>` +
    (!m.probed
      ? `<div class="meta">正在探测本机执行器……未探测出来的一律显示为不可用，绝不假设可用。</div>`
      : "") +
    (m.chosen && !m.chosen.runnable && m.chosen.detail
      ? `<details class="sd-hint"><summary>为什么不可用 / 怎么配置</summary><pre class="sd-pre">${esc(m.chosen.detail)}</pre></details>`
      : "") +
    // CONTEXT SNAPSHOT — the real ids this reading was built from (§18 / §3)
    `<div class="lab">本次读取的上下文</div>` +
    `<div class="sd-kv"><span>剧集 / 场景 / 镜头</span><code>${esc(m.trace.episodeId || "—")} / ${esc(m.trace.sceneId || "—")} / ${esc(m.trace.shotId || "—")}</code></div>` +
    `<div class="sd-kv"><span>出场人物 / 状态</span><code>${esc(m.trace.characterIds.join("、") || "—")}</code></div>` +
    `<div class="sd-kv"><span>场景地 / 状态</span><code>${esc(m.trace.locationId || "—")}</code></div>` +
    `<div class="sd-kv"><span>参考</span><code>${esc(m.trace.references.map((x) => `${x.referenceKey}@v${x.version}`).join("、") || "—")}</code></div>` +
    `<div class="sd-kv"><span>Prompt 版本</span><code>image v${esc(String(m.trace.promptVersions.image ?? "—"))} · video v${esc(String(m.trace.promptVersions.video ?? "—"))}</code></div>` +
    `<div class="sd-kv"><span>前 / 后镜</span><code>${esc(m.trace.neighbourShotIds.previous || "—")} / ${esc(m.trace.neighbourShotIds.next || "—")}</code></div>` +
    `<div class="meta">AI 只读到上面这些。整个项目不会被塞给模型——这是本轮的 token 策略，` +
    `也是每次 Skill Run 都会记下来的依据。</div>` +
    `</details>` +
    `</section>`
  );
}

/* ========================================================================== */
/* bind                                                                       */
/* ========================================================================== */

/**
 * Run one operation for one shot.
 *
 * EXPORTED because three surfaces start the same work: this panel's own buttons, the
 * LEFT column's `⊙ AI 推荐`, and the CENTER prompt cards' `自动生成`. One function
 * rather than three copies — the alternative is three call sites that drift about
 * which scope they pass, and a wrong scope is what makes a proposal get applied to a
 * shot the run never read.
 *
 * Returns the run result so a caller can report it in its own words.
 */
export async function runOperation(ctx, ui, key, shotId, executor = null) {
  const op = OPERATIONS.find((o) => o.key === key);
  if (!op) return { ok: false, error: `未知操作 ${key}` };
  if (!shotId) return { ok: false, error: "先选一个镜头" };
  // WHO RUNS IT, resolved HERE so all three entrances agree (§14).
  //
  // The panel passes the executor it already showed on the button; the LEFT column's
  // ⊙ AI 推荐 and the CENTER prompt cards' 自动生成 pass none and get the same
  // resolution. Doing it per-call-site is how 「同一个操作，从不同入口点，跑在不同
  // 订阅上」 happens.
  //
  // The probe is the server's, and it is cached (30s TTL) — this costs at most one
  // request per explicit creator action, and it is the only way availability can be
  // a fact rather than an assumption.
  let chosen = executor;
  if (!chosen) {
    const skill = ctx.skills.find(op.skillId);
    let probe = null;
    try { probe = await ctx.skills.probe(); } catch { probe = null; }
    const runnable = (id) => {
      const p = probe && probe[id] ? probe[id] : null;
      return !!(p && isRunnable(p.state));
    };
    const current = ui.sdExecutor && runnable(ui.sdExecutor) ? ui.sdExecutor : null;
    chosen = suggestExecutor(skill ? skill.work : "creative", runnable, current);
  }
  const res = await ctx.skills.run(op.skillId, {
    executor: chosen,
    // the SCOPE is what the creator is standing on. It is also what makes the context
    // minimal, so it is never omitted.
    scope: { shotId },
    ...(op.needsPrompt ? { extra: { reviewKind: op.needsPrompt } } : {}),
  });
  // REMEMBER the conclusion against the revision it was drawn from (§15), so the next
  // visit reuses it instead of re-spending tokens — and so a changed upstream makes
  // it read as stale rather than as current.
  if (res.ok && res.proposal && op.scope) {
    // `needsPrompt` is the VARIANT: 图片 Prompt 审核 and 视频 Prompt 审核 share the
    // `promptReview` scope but are conclusions about two different prompts.
    ctx.shotctx.remember(op.scope, shotId, res.proposal,
      { skillRunId: res.run.runId, variant: op.needsPrompt || null });
  }
  return { ...res, op };
}

/**
 * Wire the panel. Every write goes through `ctx.actions.dispatch` or an existing
 * controller, after an explicit press — there is no second business-logic path here
 * (§13).
 */
export function bindShotDirector(root, ctx, ui, render, { shotId, onOpenNode } = {}) {
  const all = (q, fn) =>
    root.querySelectorAll(q).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el, ev); }));

  root.querySelectorAll('input[name="sd-exec"]').forEach((el) => (el.onchange = () => {
    // an EXPLICIT override — from here on this panel stops suggesting per operation
    // and does what the creator said. Kept apart from the legacy panel's
    // `ui.skillExecutor`, whose "manual" is a default rather than a decision.
    // `__auto` clears the override and hands each operation back to the suggestion
    ui.sdExecutor = el.value === "__auto" ? null : el.value;
    ui.sdAdv = true; // keep the panel the creator is standing in open
    render();
  }));

  // --- run an operation --------------------------------------------------- //
  all("[data-sd-op]", async (el) => {
    el.disabled = true;
    const was = el.textContent;
    el.textContent = "运行中…";
    // the executor the PANEL resolved for THIS operation — not a panel-wide one, so
    // 审核 goes to the reviewer and 生成 goes to the creative runtime in the same
    // session without the creator re-picking between clicks
    const res = await runOperation(ctx, ui, el.dataset.sdOp, shotId, el.dataset.exec || null);
    if (!res.ok) ctx.toast(`运行失败：${res.error}`);
    else if (res.manual) ctx.toast("已建立运行记录——复制任务 Prompt，跑完把结果粘回来");
    el.disabled = false;
    el.textContent = was;
    render();
  });

  // --- the three proposal decisions -------------------------------------- //
  all("[data-sd-apply]", (el) => {
    const res = ctx.skills.applyProposal(el.dataset.sdApply, { shotId });
    ctx.toast(res.ok ? `已应用：${res.detail}` : `未应用：${res.error}`);
    render();
  });
  all("[data-sd-reject]", (el) => {
    ctx.skills.reject(el.dataset.sdReject, "创作者忽略");
    render();
  });
  all("[data-sd-regen]", async (el) => {
    // 重新生成 = ignore this proposal, then run the SAME capability again. Two steps
    // rather than one, because a rejected proposal is real history: it is the most
    // informative kind of record for improving a Skill later (ADR-0056 决策 6).
    const runs = ctx.skills.runs();
    const run = runs.find((r) => r && r.runId === el.dataset.sdRegen);
    if (!run) return;
    ctx.skills.reject(run.runId, "创作者要求重新生成");
    const op = operationOfRun(run);
    const res = op
      ? await runOperation(ctx, ui, op.key, shotId)
      : { ok: false, error: `「${run.skillId}」不是这一栏的操作` };
    if (!res.ok) ctx.toast(`重新生成失败：${res.error}`);
    render();
  });

  // --- the MANUAL runtime's two halves ----------------------------------- //
  all("[data-sd-copyprompt]", async (el) => {
    const runs = ctx.skills.runs();
    const run = runs.find((r) => r && r.runId === el.dataset.sdCopyprompt);
    if (!run) return;
    // THE PROMPT THIS RUN WAS LAUNCHED WITH, verbatim.
    //
    // Recompiling it here would read LIVE state: a manual run stays open while the
    // creator works, so an edit made in between would hand them a prompt asking a
    // different question than the one `contextTrace` records this run as having asked
    // (codex review round 4). Recompiling is the FALLBACK for runs started before this
    // was frozen — and it says so, rather than passing a reconstruction off as the
    // original.
    let text = run.promptText;
    if (!text) {
      const op = operationOfRun(run);
      text = ctx.skills.prompt(
        run.skillId,
        op && op.needsPrompt ? { reviewKind: op.needsPrompt } : {},
        { shotId: (run.context && run.context.shotId) || shotId },
      );
      ctx.toast("这次运行没有存下原始 Prompt，已按当前内容重新生成——若期间改过镜头，它与运行记录不一致");
    }
    try {
      await navigator.clipboard.writeText(text);
      el.textContent = "已复制";
    } catch {
      el.textContent = "复制失败";
    }
  });
  all("[data-sd-abandon]", async (el) => {
    // AWAITED: abandoning may have to reach the backend to stop a run it owns
    // (codex review, round 20). Treating it as synchronous would report success
    // from a pending promise and leave the two sides disagreeing.
    const res = await ctx.skills.abandon(el.dataset.sdAbandon);
    ctx.toast(res.ok ? "已放弃这次运行（记录保留为「已取消」，不是删掉）" : res.error);
    render();
  });
  all("[data-sd-submit]", (el) => {
    const area = root.querySelector(".sd-answer");
    const text = area ? area.value : "";
    if (!text.trim()) { ctx.toast("先把模型返回的结果粘进来"); return; }
    const res = ctx.skills.submitManual(el.dataset.sdSubmit, text);
    if (!res.ok) ctx.toast(`结果未被采纳：${res.error}`);
    else {
      const run = ctx.skills.runs().find((x) => x && x.runId === el.dataset.sdSubmit);
      const op = operationOfRun(run);
      if (op && op.scope && res.proposal) {
        ctx.shotctx.remember(op.scope, shotId, res.proposal,
          { skillRunId: el.dataset.sdSubmit, variant: op.needsPrompt || null });
      }
    }
    render();
  });

  // --- the gap-closing actions (§12) ------------------------------------- //
  all("[data-sd-fix]", (el) => {
    const res = ctx.actions.dispatch({ action: el.dataset.sdFix, shotId });
    if (!res.ok && !res.satisfied) ctx.toast(res.error);
    else ctx.toast(res.satisfied ? res.error : "已把上一镜的尾帧接成这一镜的首帧（来源已记录）");
    render();
  });
  all("[data-sd-prepare]", (el) => {
    const res = ctx.actions.dispatch({ action: "prepareGeneration", shotId, kind: el.dataset.sdPrepare });
    ctx.toast(res.ok ? (res.detail || "已准备生成输入") : res.error);
    render();
  });
  all("[data-sd-interp]", (el) => {
    // 解读 is the Reference Interpreter's job, and it is per-REFERENCE rather than
    // per-shot — so this opens that reference on the graph instead of running a
    // shot-scoped capability that does not exist for it.
    const first = String(el.dataset.sdInterp || "").split(",").filter(Boolean)[0];
    if (first && onOpenNode) onOpenNode({ type: "reference", refKey: first });
    else ctx.toast("在左栏该参考的「解读」里写，或运行「参考解读」能力");
    render();
  });
  all("[data-sd-goto]", (el) => {
    const btn = document.querySelector(`[data-mod="${el.dataset.sdGoto}"]`);
    if (btn) btn.click();
    else ctx.toast("在「工作区 ▾」里打开对应的工作区");
  });
}

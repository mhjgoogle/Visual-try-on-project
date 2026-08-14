// AI 导演 · 能力 — the REAL Skill entrance (ADR-0061 决策 3 / TASK-064 §1, §13).
//
//   运行 Skill → Skill Run → Proposal → [应用 | 用于生成 | 忽略]
//
// Until this module existed, `ctx.skills.*` was a complete domain — catalog,
// context assembly, scope ids, runtime dispatch, proposal validation, accept /
// reject, origin stamps — with NO caller anywhere in src/ui. A Skill Run could
// only appear on the provenance graph; a creator could not start one. That is the
// gap this closes.
//
// FOUR SEPARATE THINGS, still separate (ADR-0056 决策 1 / TASK-064 §14):
//
//   Role      AI 导演              who supervises
//   Skill     Storyboard Director  which capability
//   Runtime   local_subscription   which KIND of execution
//   Executor  claude-code          which concrete binary
//   Model     reported at run time what actually answered
//
// Nothing here binds a Role to an executor, and no default is a hard-coding: the
// skill's `recommendedRuntime` is a hint the creator can ignore.
//
// NO FAKE AI (ADR-0061): only skills that really exist are listed. An executor's
// availability is the server's probe result, never an assumption. A model the
// runtime did not report stays 「未记录」. And 「应用」 is offered only where a
// canonical write path genuinely exists — see workflow/skillapply.js.

import { esc } from "../util/dom.js";
import { SKILL_INPUTS } from "../workflow/skills.js";
import { EXECUTOR_STATE_LABEL, isRunnable } from "../services/runtime.js";
import { applicability } from "../workflow/skillapply.js";
import { isPending, isOpen, dispositionOf, RUN_STATUS_LABEL } from "../workflow/skillrun.js";

const DISPOSITION_LABEL = {
  pending: "有提案",
  accepted: "已接受",
  rejected: "已忽略",
  superseded: "已被取代",
};

function runLabel(r) {
  if (r && r.status === "succeeded") {
    return DISPOSITION_LABEL[dispositionOf(r)] || RUN_STATUS_LABEL.succeeded;
  }
  return RUN_STATUS_LABEL[r && r.status] || (r && r.status) || "";
}

const ERROR_HINT = {
  unavailable: "这个执行器在本机不可用——换手工运行，或按下面的说明配置它。",
  unauthenticated: "执行器在，但没有登录。先在终端登录一次，再回来重跑。",
  timeout: "超时了。缩小范围（只跑一个场景 / 一个镜头）通常就够。",
  invalid_output: "答案不符合这个能力的输出契约，所以没有被记成提案——原样丢弃，不做局部保留。",
  execution_error: "执行过程本身出错了。详情见下。",
};

/**
 * Everything the panel renders, derived from real state.
 *
 * `probe` is the executor availability map (`ctx.skills.probe()` result) the
 * shell caches — it is an async server probe, so the panel takes it as data
 * rather than firing one per render. `null` means "not probed yet", which is
 * displayed as such and never as available.
 */
export function skillPanelModel(ctx, ui, probe) {
  const catalog = ctx.skills.catalog();
  // WHY the catalog might be empty (TASK-075 §1.4). Since the definitions moved
  // into packages the backend loads, an empty list has two very different causes:
  // "we could not load them" and "there are none". Rendering both as a blank list
  // is the failure ADR-0064 决策 6 names — so the reason is carried into the model.
  // A ctx without the accessor (older callers) reports no reason rather than
  // inventing one; it never reports a catalog as loaded when it is not.
  const state =
    typeof ctx.skills.catalogState === "function" ? ctx.skills.catalogState() : null;
  const catalogState = {
    installed: state ? !!state.installed : catalog.length > 0,
    detail: state && state.detail ? state.detail : "",
    problems: state && Array.isArray(state.problems) ? state.problems : [],
  };
  const shotId = ui.selectedShotId || null;
  const selected = catalog.find((s) => s.skillId === ui.skillId) || null;
  const runs = ctx.skills.runs();
  const skills = catalog.map((s) => {
    const missing = ctx.skills.missing(s.skillId);
    return {
      skillId: s.skillId,
      version: s.version,
      role: s.role,
      title: s.title,
      purpose: s.purpose,
      inputs: s.inputs,
      optionalInputs: s.optionalInputs,
      recommendedRuntime: s.recommendedRuntime,
      missing,
      ready: missing.length === 0,
      stats: ctx.skills.stats(s.skillId),
    };
  });
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
      version: p ? p.version || null : null,
      runnable: p ? isRunnable(p.state) : false,
    };
  });
  const chosenExecutor = executors.find((e) => e.id === ui.skillExecutor) || null;
  // History for the SELECTED skill only — the panel is 300px wide and a project
  // -wide run log there would bury the one proposal waiting on a decision.
  const history = selected
    ? runs
        .filter((r) => r && r.skillId === selected.skillId)
        .slice()
        .reverse()
        .slice(0, 6)
        .map((r) => ({
          skillRunId: r.skillRunId,
          status: r.status,
          statusLabel: runLabel(r),
          disposition: dispositionOf(r),
          runtime: r.runtime,
          executor: r.executor,
          model: r.model,
          skillVersion: r.skillVersion,
          context: r.context || null,
          error: r.error || null,
          proposal: r.proposal || null,
          proposalId: r.proposal && r.proposal.proposalId ? r.proposal.proposalId : null,
          createdAt: r.createdAt,
        }))
    : [];
  // The one run that needs a decision right now. Deliberately the NEWEST
  // proposed run of this skill and nothing else: a panel that surfaces several
  // at once makes the creator choose which decision to make first, which is not
  // a decision they asked for.
  const pending = history.find(isPending) || null;
  // "still going" now spans the states an execution can legitimately sit in,
  // including `awaiting_input` where a MANUAL run waits for the creator
  // EVERY non-terminal state counts as open. Listing them by hand left
  // `awaiting_confirmation` and `cancelling` out, so the panel treated an
  // unfinished run as absent and offered actions that conflict with it
  // (codex review, round 5). The domain already knows what "still open" means.
  const open = history.find(isOpen) || null;
  return {
    skills,
    selected: selected ? skills.find((s) => s.skillId === selected.skillId) : null,
    executors,
    chosenExecutor,
    history,
    pending,
    open,
    shotId,
    apply: selected ? applicability(selected.skillId) : null,
    probed: !!probe,
    catalog: catalogState,
  };
}

/* -------------------------------------------------------------------------- */
/* render                                                                    */
/* -------------------------------------------------------------------------- */

function inputChips(s) {
  const req = s.inputs.map((k) => {
    const miss = s.missing.includes(k);
    return `<span class="chip${miss ? " bad" : " ok"}">${esc(SKILL_INPUTS[k] || k)}</span>`;
  });
  const opt = s.optionalInputs.map((k) => `<span class="chip mute">${esc(SKILL_INPUTS[k] || k)}</span>`);
  return `<div class="sk-chips">${req.join("")}${opt.join("")}</div>`;
}

function proposalBody(m, r) {
  const app = m.apply;
  const preview = JSON.stringify(r.proposal, null, 2);
  return (
    `<div class="sk-prop">` +
    `<div class="sk-proph"><b>提案</b>` +
    `<span class="chip">${esc(r.statusLabel)}</span>` +
    (r.model ? `<span class="chip mute">${esc(r.model)}</span>` : `<span class="chip mute">模型未记录</span>`) +
    `</div>` +
    `<pre class="sk-pre">${esc(preview)}</pre>` +
    (app && app.can
      ? `<div class="meta">${esc(app.detail || "")}</div>`
      : `<div class="dir-unavail">◌ ${esc((app && app.reason) || "没有可写回的目标")}</div>`) +
    `<div class="sk-acts">` +
    (app && app.can
      ? `<button class="btn primary sm" data-sk-apply="${esc(r.skillRunId)}">应用</button>`
      : "") +
    `<button class="btn sm" data-sk-usegen="${esc(r.skillRunId)}">用于生成</button>` +
    `<button class="btn sm" data-sk-reject="${esc(r.skillRunId)}">忽略</button>` +
    `</div>` +
    `<div class="meta">「用于生成」会把这份提案记为已接受，并把 ` +
    `<code>skillRunId + proposalId</code> 带到下一次生成的记录上——溯源图里能看到这次生成` +
    `确实是从这份提案发起的。</div>` +
    `</div>`
  );
}

function openRunBody(r) {
  if (r.executor !== "manual") {
    return (
      `<div class="sk-open"><b>运行中</b>` +
      `<div class="meta">由「${esc(r.executor || "")}」执行，答案回来后会自动变成提案。</div></div>`
    );
  }
  return (
    `<div class="sk-open"><b>等你把答案带回来</b>` +
    `<div class="meta">复制下面的完整任务 Prompt，到 ChatGPT / Claude / Gemini 里跑，` +
    `把结果原样粘回来。同一个能力、同一份输出契约、同一道确认门——只是执行者不同。</div>` +
    `<div class="sk-acts"><button class="btn sm" data-sk-copyprompt="${esc(r.skillRunId)}">复制任务 Prompt</button></div>` +
    `<textarea class="field sk-answer" rows="6" spellcheck="false" placeholder="粘贴模型返回的 JSON"></textarea>` +
    `<div class="sk-acts"><button class="btn primary sm" data-sk-submit="${esc(r.skillRunId)}">提交结果</button></div></div>`
  );
}

/** The catalog's own health, shown ABOVE the list.
 *
 *  Two separate facts, never merged: the catalog as a whole failed to load, or it
 *  loaded and some individual packages did not. The second case must stay visible
 *  — a capability that fails validation disappearing from the list looks identical
 *  to one that was never written (§1.7), and only one of those is a problem the
 *  creator can act on. */
function catalogNotice(m) {
  const c = m.catalog || { installed: true, detail: "", problems: [] };
  const rows = [];
  if (!c.installed) {
    rows.push(
      `<div class="dir-unavail">◌ 能力目录不可用${c.detail ? `：${esc(c.detail)}` : ""}</div>` +
      `<div class="meta">这不是「没有能力」，是没能把能力包读进来。Skill 包在磁盘上，只有后端能读它们` +
      `（项目 → 用户 → 内置三个来源）；静态 demo 没有后端，所以这里如实显示不可用。</div>`,
    );
  }
  if (c.problems.length) {
    rows.push(
      `<details class="sk-hint"><summary>${c.problems.length} 个能力包没能加载</summary>` +
      c.problems
        .map(
          (p) =>
            `<div class="meta"><b>${esc(p.skillId || "（未能读出能力 ID）")}</b>` +
            (p.source ? `<span class="chip mute">${esc(p.source)}</span>` : "") +
            `<br>${esc(p.detail || p.reason || "没有给出原因")}</div>`,
        )
        .join("") +
      `<div class="meta">加载失败的能力不会被降级使用，也不会回退到同名的低优先级包` +
      `（ADR-0067 决策 7）——修好它或升一版，它才会重新出现。</div></details>`,
    );
  }
  return rows.join("");
}

export function renderSkillPanel(m, ui) {
  const notice = catalogNotice(m);
  const list = m.skills
    .map((s) =>
      `<button class="sk-row${m.selected && s.skillId === m.selected.skillId ? " on" : ""}" data-sk-pick="${esc(s.skillId)}">` +
      `<span class="sk-role">${esc(s.role)}</span>` +
      `<span class="sk-title">${esc(s.title)}</span>` +
      `<span class="chip${s.ready ? " ok" : " gate"}">${s.ready ? "可运行" : `缺 ${s.missing.length}`}</span>` +
      `</button>`)
    .join("");
  if (!m.selected) {
    return (
      `<div class="lab">能力</div>` +
      notice +
      `<div class="sk-list">${list}</div>` +
      (m.catalog && !m.catalog.installed
        ? ""
        : `<div class="meta">这些是系统里真实存在的 Film Skill，由后端从 Skill 包加载。选一个：` +
          `我会用当前 canon 组装它的输入，按它自己的输出契约校验答案，然后交给你决定要不要用。</div>`)
    );
  }
  const s = m.selected;
  const execRows = m.executors
    .map((e) =>
      `<label class="sk-exec${m.chosenExecutor && e.id === m.chosenExecutor.id ? " on" : ""}">` +
      `<input type="radio" name="sk-exec" value="${esc(e.id)}"${m.chosenExecutor && e.id === m.chosenExecutor.id ? " checked" : ""}>` +
      `<span class="sk-execn">${esc(e.title)}</span>` +
      `<span class="chip${e.runnable ? " ok" : e.state ? " bad" : " mute"}">${esc(e.stateLabel)}</span>` +
      `</label>`)
    .join("");
  const chosen = m.chosenExecutor;
  const blocked = !s.ready
    ? `缺少必要输入：${s.missing.map((k) => SKILL_INPUTS[k] || k).join("、")}`
    : !chosen
      ? "先选一个执行器"
      : !chosen.runnable
        ? `「${chosen.title}」当前${chosen.stateLabel}`
        : null;
  return (
    `<div class="lab">能力</div>` +
    notice +
    `<div class="sk-list">${list}</div>` +
    `<div class="sk-detail">` +
    `<div class="sk-dh"><b>${esc(s.title)}</b><span class="chip mute">v${s.version}</span>` +
    `<span class="chip mute">${esc(s.role)}</span></div>` +
    `<div class="meta">${esc(s.purpose)}</div>` +
    `<div class="lab">输入</div>${inputChips(s)}` +
    `<div class="lab">当前上下文</div>` +
    `<div class="meta">${m.shotId ? "已限定到当前镜头（记录会写下这一层）" : "本集范围（没有限定到某个镜头）"}` +
    `<br>推荐运行方式：${esc(s.recommendedRuntime || "未声明")}（只是建议，不是绑定）</div>` +
    `<div class="lab">执行器</div><div class="sk-execs">${execRows}</div>` +
    (chosen && !chosen.runnable && chosen.detail
      ? `<details class="sk-hint"><summary>为什么不可用 / 怎么配置</summary><pre class="sk-pre">${esc(chosen.detail)}</pre></details>`
      : "") +
    (!m.probed ? `<div class="meta">正在探测本机执行器……未探测出来的一律显示为不可用，绝不假设可用。</div>` : "") +
    `<div class="sk-acts">` +
    `<button class="btn primary" data-sk-run${blocked ? " disabled" : ""}>运行 Skill</button>` +
    `<button class="btn" data-sk-showprompt>查看任务 Prompt</button>` +
    `</div>` +
    (blocked ? `<div class="dir-unavail">◌ ${esc(blocked)}</div>` : "") +
    (ui.skillPromptOpen
      ? `<details class="sk-hint" open><summary>任务 Prompt（每种运行方式完全一致）</summary>` +
        `<pre class="sk-pre">${esc(ui.skillPromptText || "")}</pre></details>`
      : "") +
    (m.open ? openRunBody(m.open) : "") +
    (m.pending ? proposalBody(m, m.pending) : "") +
    (m.history.length
      ? `<div class="lab">运行记录</div><ul class="sk-hist">` +
        m.history.map((r) =>
          `<li><span class="chip${r.disposition === "accepted" ? " ok" : r.status === "failed" ? " bad" : ""}">${esc(r.statusLabel)}</span>` +
          `<span class="sk-hm">v${r.skillVersion} · ${esc(r.executor || "—")}</span>` +
          `<span class="sk-ht">${esc(String(r.createdAt || "").slice(5, 16).replace("T", " "))}</span>` +
          (r.error ? `<div class="sk-err">${esc(ERROR_HINT[r.error.kind] || "")} ${esc(r.error.detail || "")}</div>` : "") +
          `</li>`).join("") +
        `</ul>`
      : `<div class="meta">这个能力还没有运行记录。</div>`) +
    `<div class="sk-acts"><button class="btn sm" data-sk-back>← 全部能力</button></div>` +
    `</div>`
  );
}

/* -------------------------------------------------------------------------- */
/* bind                                                                      */
/* -------------------------------------------------------------------------- */

export function bindSkillPanel(root, ctx, ui, render) {
  const redraw = render || (() => {});

  root.querySelectorAll("[data-sk-pick]").forEach((b) => (b.onclick = () => {
    ui.skillId = b.dataset.skPick;
    ui.skillPromptOpen = false;
    // Default the executor to the one the skill RECOMMENDS a runtime for, and
    // only if it is actually runnable — never to a fixed binary. `manual` is a
    // first-class peer, so falling back to it is not a degraded mode.
    if (!ui.skillExecutor) ui.skillExecutor = "manual";
    redraw();
  }));
  const back = root.querySelector("[data-sk-back]");
  if (back) back.onclick = () => { ui.skillId = null; ui.skillPromptOpen = false; redraw(); };

  root.querySelectorAll('input[name="sk-exec"]').forEach((r) => (r.onchange = () => {
    ui.skillExecutor = r.value;
    redraw();
  }));

  const show = root.querySelector("[data-sk-showprompt]");
  if (show) show.onclick = () => {
    ui.skillPromptOpen = !ui.skillPromptOpen;
    ui.skillPromptText = ui.skillPromptOpen && ui.skillId ? ctx.skills.prompt(ui.skillId) : "";
    redraw();
  };

  const run = root.querySelector("[data-sk-run]");
  if (run) run.onclick = async () => {
    if (run.hasAttribute("disabled")) return;
    const skillId = ui.skillId;
    if (!skillId) return;
    run.disabled = true;
    run.textContent = "运行中…";
    // The SCOPE is what the creator is standing on — nothing here invents one.
    // `ctx.skills.scopeOf` drops a level the skill does not actually read, so a
    // project-wide skill records no shot even when one is selected.
    const res = await ctx.skills.run(skillId, {
      executor: ui.skillExecutor || "manual",
      scope: ui.selectedShotId ? { shotId: ui.selectedShotId } : null,
      summary: ui.selectedShotId ? "当前镜头" : "本集范围",
    });
    if (!res.ok) ctx.toast(`运行失败：${res.error}`);
    else if (res.manual) ctx.toast("已建立运行记录——复制任务 Prompt，跑完把结果粘回来");
    redraw();
  };

  const copy = root.querySelector("[data-sk-copyprompt]");
  if (copy) copy.onclick = async () => {
    const skillId = ui.skillId;
    if (!skillId) return;
    try {
      await navigator.clipboard.writeText(ctx.skills.prompt(skillId));
      copy.textContent = "已复制";
    } catch {
      copy.textContent = "复制失败";
    }
  };

  const submit = root.querySelector("[data-sk-submit]");
  if (submit) submit.onclick = () => {
    const area = root.querySelector(".sk-answer");
    const text = area ? area.value : "";
    if (!text.trim()) { ctx.toast("先把模型返回的结果粘进来"); return; }
    const res = ctx.skills.submitManual(submit.dataset.skSubmit, text);
    if (!res.ok) ctx.toast(`结果未被采纳：${res.error}`);
    redraw();
  };

  // --- the three proposal decisions --------------------------------------- //
  const apply = root.querySelector("[data-sk-apply]");
  if (apply) apply.onclick = () => {
    const res = ctx.skills.applyProposal(apply.dataset.skApply, {
      shotId: ui.selectedShotId || null,
      genKind: ui.inspect && ui.inspect.genKind === "video" ? "video" : "image",
    });
    ctx.toast(res.ok ? `已应用：${res.detail}` : `未应用：${res.error}`);
    redraw();
  };
  const useGen = root.querySelector("[data-sk-usegen]");
  if (useGen) useGen.onclick = () => {
    const res = ctx.skills.useForGeneration(useGen.dataset.skUsegen);
    if (!res.ok) { ctx.toast(`无法用于生成：${res.error}`); redraw(); return; }
    // Open the Generation Inspector so the creator lands exactly where the
    // origin they just stamped will be used.
    ui.inspect = {
      ...(ui.inspect || {}),
      kind: "generation",
      shotId: res.shotId || ui.selectedShotId || null,
    };
    ctx.toast("已记为已接受；下一次生成会带上这份提案的 origin");
    redraw();
  };
  const reject = root.querySelector("[data-sk-reject]");
  if (reject) reject.onclick = () => {
    ctx.skills.reject(reject.dataset.skReject, "创作者忽略");
    redraw();
  };
}

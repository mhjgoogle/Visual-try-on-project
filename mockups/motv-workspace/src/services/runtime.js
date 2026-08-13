// Local AI Runtime (checkpoint CP3 / ADR-0056) — the client half of the
// runtime layer: which executors exist, whether they are usable right now, and
// how a Skill is dispatched to one.
//
// RUNTIME ≠ EXECUTOR ≠ MODEL:
//
//   runtime   local_subscription | manual     the KIND of execution
//   executor  claude-code | codex-cli | —     the concrete thing that runs
//   model     reported by the executor        what actually answered
//
// Nothing here (and nothing in the domain) binds a Role or a Skill to an
// executor. `skills.js` states a RECOMMENDED runtime; the creator chooses.
//
// SAFETY (ADR-0056 决策 2): this module sends a PROMPT and receives TEXT. It
// never sends a path, never asks the executor to read or write anything, and
// the server starts it with tools disabled in a neutral working directory. That
// is also why there is nothing to translate between Windows and WSL path
// conventions — no path ever crosses the boundary.

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/** The two runtime kinds. `manual` is a first-class peer, not a degraded mode:
 *  it is the CURRENT main way media-adjacent creative work gets done. */
export const RUNTIMES = [
  {
    id: "local_subscription",
    title: "本地订阅",
    detail: "用本机已登录的 Claude Code / Codex CLI 跑（不消耗 API 额度）",
  },
  {
    id: "manual",
    title: "手工",
    detail: "复制完整任务 Prompt → 到 ChatGPT / Claude / Gemini 跑 → 粘贴结果回来",
  },
];

/** The executors a local_subscription run can use. Availability is NOT decided
 *  here — the server probes it, because only the server can resolve a binary. */
/** The two kinds of work a capability does. Used to SUGGEST an executor, never to
 *  bind one (ADR-0056 决策 1).
 *
 *    creative  produces new content — a story, a shot list, a Prompt
 *    review    produces findings ABOUT existing content — issues, conflicts, gaps
 *
 *  This is a fact about the WORK, stated on the Skill; which executor suits which
 *  kind is a separate fact stated on the executor below. Keeping them apart is what
 *  lets the creator pair them any way they like. */
export const WORK_KINDS = ["creative", "review"];

export const EXECUTORS = [
  {
    id: "claude-code",
    title: "Claude Code",
    runtime: "local_subscription",
    // a hint the UI shows; the creator can still pick anything
    goodAt: "创作型工作（故事 / 剧本 / 分镜 / Prompt）",
    // WHAT IT IS SUGGESTED FOR — a default, not a restriction. Every executor can
    // run every capability; this only decides which radio starts selected.
    suits: ["creative"],
  },
  {
    id: "codex-cli",
    title: "Codex CLI",
    runtime: "local_subscription",
    goodAt: "独立复核 / 结构化检查 / 第二意见",
    // TASK-067 §14 「不要把 Codex 默认当 Creative Director」 — it is suggested for
    // REVIEW only. A creator who wants it to write a Prompt still can; the point is
    // that nothing defaults it into the creative seat.
    suits: ["review"],
    // codex has no tool-free mode: `--sandbox read-only` blocks WRITES but the
    // agent can still READ local files and echo them into its answer. Our
    // prompts inline user-authored script text, so that is a live injection
    // surface — the backend therefore reports this executor unavailable unless
    // the operator explicitly opts in.
    readsFilesystem: true,
  },
  {
    id: "manual",
    title: "手工（外部网页）",
    runtime: "manual",
    goodAt: "任何能力 — 由你在外部工具里跑",
    // suits BOTH, and it is the last resort in `suggestExecutor`: it always works,
    // so it must never win over a local runtime that is actually available.
    suits: ["creative", "review"],
  },
];

/**
 * Which executor should START SELECTED for a capability doing `work`.
 *
 * A SUGGESTION with three rules, in order:
 *   1. the creator's own current choice always wins — this never overrides them
 *   2. otherwise the first RUNNABLE executor that suits this kind of work
 *   3. otherwise manual, which needs nothing installed
 *
 * `isRunnableFor` is passed in rather than read here, because availability is the
 * server's probe result and this module never assumes it.
 */
export function suggestExecutor(work, isRunnableFor, current = null) {
  if (current && isRunnableFor(current)) return current;
  const wanted = WORK_KINDS.includes(work) ? work : "creative";
  for (const e of EXECUTORS) {
    if (e.id === "manual") continue; // last resort, considered below
    if (!Array.isArray(e.suits) || !e.suits.includes(wanted)) continue;
    if (isRunnableFor(e.id)) return e.id;
  }
  return "manual";
}

export const EXECUTOR_BY_ID = new Map(EXECUTORS.map((e) => [e.id, e]));

/** The states an executor can be in. They are kept apart because the creator's
 *  next action differs for each — collapsing them into one "not working" would
 *  leave them guessing which.
 *
 *  `installed` is deliberately NOT `ready`: a `--version` probe succeeds on an
 *  installed-but-logged-out CLI, so calling that "ready" would assert something
 *  nobody checked, and the creator would only find out when a run failed. Login
 *  is proven by a run, not by a probe. `ready` is reserved for the manual
 *  runtime, which genuinely needs nothing installed. */
export const EXECUTOR_STATES = {
  READY: "ready", // nothing to install (manual)
  INSTALLED: "installed", // resolves; login not verified until a run succeeds
  UNAVAILABLE: "unavailable", // no binary and no configured launch command
  UNAUTHENTICATED: "unauthenticated", // a RUN came back saying: not logged in
  ERROR: "error", // present, but the probe itself failed
};

export const EXECUTOR_STATE_LABEL = {
  ready: "可用",
  installed: "已安装（登录未验证）",
  unavailable: "未安装 / 未配置",
  unauthenticated: "未登录",
  error: "探测失败",
};

/** Can a run be attempted at all? `installed` qualifies — the point is that we
 *  do not know about login yet, not that it is broken. */
export function isRunnable(state) {
  return state === EXECUTOR_STATES.READY || state === EXECUTOR_STATES.INSTALLED;
}

/** How to make an unavailable executor available — shown verbatim in the UI, so
 *  a creator on THIS machine (where claude/codex live only inside WSL) has an
 *  actionable next step instead of a dead end. */
export function configurationHint(executorId) {
  const up = executorId === "codex-cli" ? "CODEX" : "CLAUDE";
  const bin = executorId === "codex-cli" ? "codex" : "claude";
  return (
    `未在 PATH 上找到该执行器。若它装在别处（例如 WSL 里），用两个环境变量说明：\n` +
    `  MOTV_RUNTIME_${up}_BIN       —— 可执行体在那边的**绝对路径**\n` +
    `  MOTV_RUNTIME_${up}_LAUNCHER  —— 纯传输前缀（JSON 数组），说明「怎么过去」\n\n` +
    `强制安全参数（工具全关 / 只读沙箱）由服务端在可执行体之后追加，任何配置都` +
    `改不到它们——所以前缀里**不能出现 shell**（bash / sh / cmd …）：shell 会把` +
    `追加的参数当成脚本的位置参数吞掉。例如：\n` +
    `  MOTV_RUNTIME_${up}_LAUNCHER=["wsl","-e","/home/<用户>/.nvm/versions/node/<版本>/bin/node"]\n` +
    `  MOTV_RUNTIME_${up}_BIN=/home/<用户>/.nvm/versions/node/<版本>/bin/${bin}`
  );
}

/** Probe every executor. Returns a map executorId → { state, detail, version }.
 *
 *  A backend-less (static demo) page gets every local executor reported as
 *  `unavailable` with an honest reason — never a fabricated "ready". */
export async function probeExecutors() {
  const fallback = () => {
    const out = {};
    for (const e of EXECUTORS) {
      out[e.id] = e.id === "manual"
        ? { state: EXECUTOR_STATES.READY, detail: "手工运行不需要后端" }
        : { state: EXECUTOR_STATES.UNAVAILABLE, detail: "没有后端：无法探测本机执行器" };
    }
    return out;
  };
  const VALID = new Set(Object.values(EXECUTOR_STATES));
  try {
    const r = await fetch("/api/runtimes", {
      cache: "no-store",
      // the probe route spawns `--version` subprocesses, so it carries the same
      // custom-header guard as /api/skill/run
      headers: { "X-Motv-Runtime": "1" },
    });
    const ctype = (r.headers && r.headers.get && r.headers.get("content-type")) || "";
    if (!r.ok || !ctype.includes("application/json")) return fallback();
    const j = await r.json();
    if (!isObj(j) || !isObj(j.executors)) return fallback();
    const out = fallback();
    for (const id of Object.keys(j.executors)) {
      const v = j.executors[id];
      if (!isObj(v)) continue;
      out[id] = {
        state: VALID.has(v.state) ? v.state : EXECUTOR_STATES.ERROR,
        detail: typeof v.detail === "string" ? v.detail : "",
        version: typeof v.version === "string" ? v.version : null,
      };
    }
    return out;
  } catch {
    return fallback();
  }
}

/**
 * Ask the backend to cancel a Run it owns.
 *
 * Returns `{ ok }` when the backend settled it, or `{ unknown: true }` when it
 * has no such run — which is a REAL answer, not a failure: local/demo mode and
 * purely front-end records genuinely belong to the canvas, and only then may the
 * page settle them itself (contract §5.5).
 */
export async function cancelRun(runId, project = null) {
  if (typeof runId !== "string" || !runId) return { unknown: true };
  let r;
  try {
    r = await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Motv-Runtime": "1" },
      body: JSON.stringify(project ? { project } : {}),
    });
  } catch (e) {
    // A network failure is NOT "it does not exist" — refusing here keeps the
    // page from declaring a run cancelled that may still be running.
    return { ok: false, detail: e && e.message ? e.message : "请求失败" };
  }
  if (r.status === 404) {
    // A 404 IS NOT PROOF. The lookup is project-scoped, so a stale or missing
    // project id produces the same answer as a genuinely unknown run — and
    // retrying with `null` does not help, because `null` is itself a scope (the
    // project-less runs). Believing it would mark the canvas cancelled while a
    // real backend run and its subprocess carry on (codex review, rounds 22-23).
    //
    // The ONLY case the caller may treat as frontend-owned is a run the backend
    // was never told about, and the caller knows that without asking: see
    // `ctx.skills.abandon`.
    return { ok: false, notFound: true, detail: "后端没有找到这次运行（可能是项目归属不符）" };
  }
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    const err = isObj(j) && isObj(j.error) ? j.error : {};
    return { ok: false, detail: err.detail || `HTTP ${r.status}` };
  }
  const j = await r.json().catch(() => null);
  // ONLY `cancelled` is a cancellation. `cancelling` means the kill was not
  // confirmed; `succeeded` / `failed` mean the run finished before the request
  // landed — and reporting either as success let the canvas overwrite a real
  // outcome with 「已取消」 (codex review, round 21).
  const status = isObj(j) ? j.status : null;
  if (status === "cancelled") return { ok: true, run: j };
  if (status === "cancelling") {
    return {
      ok: false,
      detail: (j.cancelFailure && j.cancelFailure.detail) || "子进程尚未确认退出",
    };
  }
  return {
    ok: false,
    finished: true,
    detail: `这次运行已经是「${status || "未知"}」，没有被取消`,
    run: j,
  };
}

/**
 * Run one compiled Skill prompt on a local executor.
 *
 * Returns { ok: true, text, model } or { ok: false, kind, detail } where `kind`
 * is one of skillrun.js's RUN_ERROR_KINDS. The distinction is preserved all the
 * way from the server: a timeout, a missing binary and a crashed process are
 * three different problems with three different fixes.
 *
 * NOTE what is NOT sent: no project path, no file list, no repository. Just the
 * prompt text the creator could equally have pasted into a web chat.
 */
export async function runOnExecutor({ executor, prompt, timeoutSeconds }) {
  if (!EXECUTOR_BY_ID.has(executor) || executor === "manual") {
    return { ok: false, kind: "unavailable", detail: `未知执行器 ${executor}` };
  }
  let r;
  try {
    r = await fetch("/api/skill/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // CSRF guard: a cross-origin page cannot set a custom header without a
        // preflight, and this backend answers none — so a hostile page cannot
        // reach the one route that starts a real local CLI.
        "X-Motv-Runtime": "1",
      },
      body: JSON.stringify({
        executor,
        prompt,
        ...(Number.isFinite(timeoutSeconds) ? { timeout: timeoutSeconds } : {}),
      }),
    });
  } catch (e) {
    return { ok: false, kind: "execution_error", detail: e && e.message ? e.message : "请求失败" };
  }
  let j = null;
  try {
    j = await r.json();
  } catch {
    return { ok: false, kind: "execution_error", detail: `无法解析响应（HTTP ${r.status}）` };
  }
  if (!r.ok || !isObj(j)) {
    const err = isObj(j) && isObj(j.error) ? j.error : {};
    return {
      ok: false,
      kind: typeof err.category === "string" ? err.category : "execution_error",
      detail: typeof err.detail === "string" ? err.detail : `HTTP ${r.status}`,
    };
  }
  return {
    ok: true,
    text: typeof j.text === "string" ? j.text : "",
    // honestly null when the executor did not report one — never assumed
    model: typeof j.model === "string" && j.model ? j.model : null,
  };
}

// 对话（ADR-0089）—— 一句话进去，一个 run 出来，答案随后落进线程。
//
// WHAT THIS MODULE IS NOT. It is not a chat client that holds the conversation in
// memory. The THREAD IS SERVER-SIDE (`<project>/studio/conversation.json`, a
// projection of the runs), so this module only sends, reads and waits. That is the
// difference between 「关掉页面答案就没了」 and 「回来还在」.
import { attempt, request } from "./apiclient.js";

//: The same custom header `/api/skill/run` requires. A cross-origin page cannot
//: set it without a preflight this server never answers, so it is the CSRF guard
//: for the one route that spends the creator's subscription.
const RUNTIME_HEADER = { "X-Motv-Runtime": "1" };

/** Read ONE page's conversation (REQ-004 v3). Never throws: an unreadable thread
 *  must not blank the column — it reports emptiness with the reason attached.
 *
 *  `others` says which OTHER pages have history, so the column can point at them
 *  instead of leaving the creator to remember where he said something. */
export async function loadThread(project, thread) {
  if (!project) return { turns: [], others: {}, proposals: [], opinions: [], error: null };
  const q = thread ? `?thread=${encodeURIComponent(thread)}` : "";
  const res = await attempt(
    `/api/projects/${encodeURIComponent(project)}/conversation${q}`,
    { headers: RUNTIME_HEADER },
  );
  if (!res.ok) {
    return { turns: [], others: {}, proposals: [], opinions: [], error: res.error };
  }
  const turns = Array.isArray(res.data && res.data.turns) ? res.data.turns : [];
  const proposals = Array.isArray(res.data && res.data.proposals) ? res.data.proposals : [];
  const opinions = Array.isArray(res.data && res.data.opinions) ? res.data.opinions : [];
  const others = (res.data && res.data.threads) || {};
  return { turns, others, proposals, opinions, error: null };
}

/** Send one turn. Returns `{ok, runId, turn, error}` — never throws, because a
 *  send that fails must SAY so in the thread rather than swallow the sentence. */
export async function sendTurn(project, message, context) {
  const text = String(message || "").trim();
  if (!project) return { ok: false, error: { detail: "还没有打开项目" } };
  if (!text) return { ok: false, error: { detail: "先写一句话" } };
  const res = await attempt(`/api/projects/${encodeURIComponent(project)}/conversation`, {
    method: "POST",
    headers: RUNTIME_HEADER,
    body: { message: text, ...(context ? { context } : {}) },
  });
  if (!res.ok) return { ok: false, error: res.error };
  const data = res.data || {};
  return {
    ok: true,
    runId: (data.run && data.run.run_id) || null,
    turn: data.turn || null,
    // The server says whether the question itself was filed. A stored=false send
    // means the answer will arrive with no question above it, and the column has
    // to be able to say that instead of looking merely odd.
    threadStored: data.threadStored !== false,
    error: null,
  };
}

/**
 * 一条针对某个页面元素的意见 —— **直接进台账，不跑模型**（TASK-132）。
 *
 * 和 `sendTurn` 是两条路，故意不合并：那条要起一轮运行、由模型从回答里把
 * `feedback.ui` 摘出来，于是「他写的那句话能不能被记下」取决于模型这一轮的表现。
 * 一条意见的原文是**他的东西**，不该由模型的成败决定它存不存在。
 *
 * `annotationId` 由调用方生成并在重试时**保持不变** —— 服务端按它幂等，所以
 * 重发不会产生第二条意见。刻意不借用 `runId`：那是模型某一轮的身份，为了迁就
 * 现有去重而伪造一个，会让两条本来无关的路径共用一个命名空间。
 *
 * 和 `sendTurn` 一样**不抛异常**：写失败必须变成屏幕上说得出的一句话，
 * 而不是一个被吞掉的 promise。
 */
export async function fileElementFeedback({ project, text, annotationId, context }) {
  const body = String(text || "").trim();
  if (!body) return { ok: false, error: { detail: "先写一句话" } };
  if (!annotationId) return { ok: false, error: { detail: "缺 annotationId" } };
  const res = await attempt("/api/feedback/element", {
    method: "POST",
    body: { annotationId, project: project || "", text: body, ...(context ? { context } : {}) },
  });
  if (!res.ok) return { ok: false, error: res.error };
  const data = res.data || {};
  return { ok: true, id: data.id, duplicate: data.duplicate === true, error: null };
}

/** One run's current state. This is the read the frontend never had (TASK-106):
 *  without it, 「Agent 正在做什么」 could only be guessed from a spinner.
 *
 *  `project` IS REQUIRED by the route — 「no project means everything」 is refused on
 *  purpose so one project's board cannot show another's runs. Omitting it 404s every
 *  poll, which looks exactly like a turn that never finishes (found by running a real
 *  turn against a real project). */
export async function runState(project, runId) {
  if (!runId || !project) return null;
  const q = `?project=${encodeURIComponent(project)}`;
  const res = await attempt(`/api/runs/${encodeURIComponent(runId)}${q}`, {
    headers: RUNTIME_HEADER,
  });
  if (!res.ok) return null;
  return res.data || null;
}

/**
 * THE RUN THIS THREAD HAS NOT FINISHED WITH — read from the thread alone (TASK-106).
 *
 * WHY THIS EXISTS. A turn is launched, the creator refreshes, and the tab that was
 * polling it is gone. The thread comes back (it is server-side) but the run does not:
 * nothing on screen says a task is still going, so he sends the same sentence again
 * and the answer — when it lands — has nobody waiting to apply its edits
 * (落地只能发生在浏览器，ADR-0089 决策 2b). 「刷新之后页面从后端恢复它的状态」 is
 * REQ-004 判据 6, and this is the first half of it.
 *
 * TWO WAYS A TURN IS UNFINISHED, and the second one is the COMMON one:
 *
 *   1. **问了，还没答** — a user turn whose `runId` has no agent turn. The run is
 *      still in flight (or settled a millisecond ago).
 *   2. **答了，改动却没落地** — an agent turn that carries `edits` but no `applied`
 *      receipt. This is what a closed tab looks like: the run finished server-side,
 *      `_conv_reconcile` folded the answer into the thread, and the edits it proposed
 *      were never applied by any browser — because applying them is something only a
 *      browser can do. Reading 「有一条 Agent turn」 as 「落地已经完成」 is an
 *      inference from something that does not prove it, and it loses those edits
 *      **permanently and silently** (codex 轮 2 P1).
 *
 * NO SECOND BOOKKEEPING FIELD. Both answers come from what the thread already
 * carries — the `runId` the send returned, and the `applied` receipt the browser
 * writes back after it lands. A third field tracking 「还没落地的」 would be one more
 * thing that can drift, and its drift looks exactly like this defect.
 *
 * It returns a CANDIDATE, never a verdict: only `GET /api/runs/<id>` can say what the
 * run is doing now, which is why the caller asks before showing anything.
 *
 * RE-LANDING BEATS LOSING. A receipt that failed to save makes an already-applied
 * turn look unlanded, so it is applied again — and that produces one more VERSION of
 * the creator's document (nothing is overwritten, AGENTS.md 第 13 条). Losing an edit
 * is silent and permanent; an extra version is visible and revertible, so the tie
 * breaks this way on purpose.
 */
export function pendingRunIdIn(turns) {
  const list = Array.isArray(turns) ? turns : [];
  const agentByRun = new Map();
  for (const t of list) {
    if (t && t.role === "agent" && t.runId) agentByRun.set(String(t.runId), t);
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const t = list[i];
    const rid = t && t.runId ? String(t.runId) : "";
    if (!rid) continue;
    const agent = agentByRun.get(rid);
    if (!agent) return rid;
    if (hasUnlandedEdits(agent)) return rid;
  }
  return null;
}

/** An agent turn that PROPOSED changes and has no receipt saying they landed.
 *  A turn with no edits proposed nothing, so there is nothing to land. */
export function hasUnlandedEdits(turn) {
  if (!turn || typeof turn !== "object") return false;
  const edits = Array.isArray(turn.edits) ? turn.edits : [];
  if (!edits.length) return false;
  const applied = Array.isArray(turn.applied) ? turn.applied : [];
  return applied.length === 0;
}

/** That turn's own words — what the resumed landing has to call the instruction. */
export function turnTextOf(turns, runId) {
  const hit = (Array.isArray(turns) ? turns : []).find(
    (t) => t && t.role !== "agent" && t.runId && String(t.runId) === String(runId),
  );
  return hit && typeof hit.text === "string" ? hit.text : "";
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "awaiting_input"]);

export function isTerminal(status) {
  return TERMINAL.has(String(status || ""));
}

/**
 * Wait for one turn to land, calling `onTick` as the state changes.
 *
 * BOUNDED, AND HONEST WHEN IT GIVES UP. A poll loop with no deadline turns a dead
 * backend into a spinner that never stops; this one stops and says the wait ended
 * without a result, which is a thing the creator can act on.
 */
export async function awaitTurn(project, runId, { onTick, timeoutMs = 180000, everyMs = 1200, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  let last = null;
  for (;;) {
    const run = await runState(project, runId);
    const status = run && run.status;
    if (status && status !== last) {
      last = status;
      if (onTick) onTick(run);
    }
    if (isTerminal(status)) return run;
    if (Date.now() - started > timeoutMs) {
      return { runId, status: "unknown", timedOut: true };
    }
    await wait(everyMs);
  }
}

/**
 * WHAT TO DO WITH A RECOVERED RUN — `"land"` or `"unknown"` (TASK-106 / ADR-0095 决策 2).
 *
 * TWO OUTCOMES, NOT THREE. 「已经结束了」 is NOT 「没事可做」: the thread was read
 * BEFORE the status was, so a run that settled in between has an agent turn the
 * page has never seen — and its edits are applied by the browser or by nobody
 * (ADR-0089 决策 2b). Treating terminal as 「什么都不用做」 loses exactly those
 * edits, permanently, and silently. So terminal lands too; landing re-reads the
 * thread first and skips anything already receipted, which makes it safe to run
 * on a run that finished a moment ago AND on one that finished last week.
 *
 * `"unknown"` is the only other answer, and it is a statement about US, not about
 * the run: we could not ask. Saying 「没在跑」 here is what lets a creator start a
 * second copy of a task that is still running (ADR-0064 决策 6).
 */
export function resumePlan(run) {
  const status = run && typeof run === "object" ? run.status : null;
  return typeof status === "string" && status ? "land" : "unknown";
}

/** Tell the thread what a turn's edits actually became.
 *
 *  落地只能发生在浏览器（ADR-0089 决策 2b），所以只有浏览器知道结果。不回执的话，
 *  「已落到作品上」只活在这一个标签页的内存里，刷新一次就退回「还没落到作品上」——
 *  在他眼里那等于改动丢了。
 *
 *  回执失败不是致命的：改动本身已经写进作品，所以这里吞掉错误并返回 false，由调用方
 *  决定要不要说。 */
export async function reportApplied(project, runId, applied) {
  if (!project || !runId || !Array.isArray(applied) || !applied.length) return false;
  try {
    await request(`/api/projects/${encodeURIComponent(project)}/conversation/applied`, {
      method: "POST",
      headers: RUNTIME_HEADER,
      body: { runId, applied },
    });
    return true;
  } catch {
    return false;
  }
}

/** 他在提案卡片上拍板 —— **不经过模型**：点「同意」就是 approved。 */
export async function decideProposal(project, id, verdict, note = "") {
  try {
    await request(`/api/projects/${encodeURIComponent(project)}/proposal/decide`, {
      method: "POST",
      headers: RUNTIME_HEADER,
      body: { id, verdict, note },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && (err.detail || err.message)) || String(err) };
  }
}

/** 还有几条开发的提案在等他拍板 —— 「开发」窗口上那个小圆点。
 *
 *  读不到就当 0：这是一个提示点，不是事实来源；为它把整根右栏变成错误态是过度反应。 */
export async function openProposalCount() {
  try {
    const res = await attempt("/api/feedback", { retries: 0 });
    const n = res.ok && res.data ? res.data.openProposals : 0;
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Cancel a turn in flight — the same real cancel a skill run gets. */
export async function cancelTurn(runId) {
  if (!runId) return false;
  try {
    await request(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      headers: RUNTIME_HEADER,
      body: {},
    });
    return true;
  } catch {
    return false;
  }
}

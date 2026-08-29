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
  if (!project) return { turns: [], others: {}, error: null };
  const q = thread ? `?thread=${encodeURIComponent(thread)}` : "";
  const res = await attempt(
    `/api/projects/${encodeURIComponent(project)}/conversation${q}`,
    { headers: RUNTIME_HEADER },
  );
  if (!res.ok) return { turns: [], others: {}, error: res.error };
  const turns = Array.isArray(res.data && res.data.turns) ? res.data.turns : [];
  const others = (res.data && res.data.threads) || {};
  return { turns, others, error: null };
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

// Command Gateway seam.
//
// PAID mode (backend started with --enable-paid): the REAL two-step write path
// per ADR-0033/0041 — POST preflight (read-only: estimated_cost + blockers +
// preflight_digest) → human confirmation → POST command with
// confirmation=preflight_digest → receipt. The backend forces actor="user" and
// routes through the Command Gateway → approved coordinator; the browser never
// touches a Provider.
//
// Non-paid modes keep the harmless stub so the demo flows still narrate the
// boundary without any write.

import { request } from "./apiclient.js";

/** The gateway's error shape: `.category` is the BACKEND's, because the blockers
 *  a preflight reports are keyed on it. */
function _err(e, label) {
  const backend = e.body && e.body.error ? e.body.error : null;
  const err = new Error(e.detail || `${label} ${e.status || ""}`.trim());
  err.category = backend && backend.category ? backend.category : "error";
  err.status = e.status;
  return err;
}

async function _get(path, label) {
  try {
    return await request(path);
  } catch (e) {
    throw _err(e, label);
  }
}

async function _post(project, sub, payload) {
  try {
    // NO transport retry (apiclient enforces this for every non-GET): `submit`
    // may spend money, and a replay the user did not ask for is the failure
    // 系统合同 §5.8 exists to prevent.
    return await request(`/api/projects/${encodeURIComponent(project)}/${sub}`, {
      method: "POST",
      body: payload,
      timeoutMs: 0, // a confirmed command can involve a provider call
    });
  } catch (e) {
    throw _err(e, sub);
  }
}

/** Read-only generation coordinates (target digest + suggested params). */
export function getGenerationTarget(project, shotId) {
  return _get(
    `/api/projects/${encodeURIComponent(project)}/generation-target?shot_id=${encodeURIComponent(shotId)}`,
    "target",
  );
}

/** Read-only lock coordinates (current shot-plan version + digest, ADR-0047). */
export function getLockTarget(project) {
  return _get(`/api/projects/${encodeURIComponent(project)}/lock-target`, "lock-target");
}

/** Step 1: read-only preflight — never spends, never writes. */
export function preflight(project, envelope) {
  return _post(project, "preflight", envelope);
}

/** Step 2: confirmed submit — the actual HIGH-risk write (may spend). */
export function submit(project, envelope, confirmation) {
  return _post(project, "command", { ...envelope, confirmation });
}

/** Paid-op status projection (read-only; reservations + staging artifacts). */
export async function paidOps(project) {
  const j = await _get(`/api/paid-ops/${encodeURIComponent(project)}`, "ops");
  return j.ops || [];
}

/** Adopt a paid staging clip into a canvas upload slot (copy; no spend).
 *  An occupied slot gains a NEW version (TASK-048 — never overwritten).
 *  Returns {url, version, sha256}. */
export async function adoptPaid(project, taskId, slug) {
  try {
    return await request("/api/agent/adopt-paid", {
      method: "POST",
      body: { project, task_id: taskId, slug },
      timeoutMs: 0, // copies bytes
    });
  } catch (e) {
    throw _err(e, "adopt");
  }
}

/** Demo stub (non-paid modes): logs and resolves, changes nothing. */
export function submitCommand(cmd) {
  const envelope = {
    command_id: "cmd-" + Math.round(performance.now()),
    name: cmd.name,
    actor: "user",
    target: cmd.target || null,
    params: cmd.params || {},
  };
  // eslint-disable-next-line no-console
  console.info("[gateway:stub] submit", envelope);
  return { status: "accepted", command: envelope, note: "prototype stub — no real write" };
}

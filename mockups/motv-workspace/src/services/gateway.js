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

async function _post(project, sub, payload) {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(project)}/${sub}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const detail = j && j.error ? j.error.detail : `${sub} ${r.status}`;
    const err = new Error(detail);
    err.category = j && j.error ? j.error.category : "error";
    throw err;
  }
  return j;
}

/** Read-only generation coordinates (target digest + suggested params). */
export async function getGenerationTarget(project, shotId) {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(project)}/generation-target?shot_id=${encodeURIComponent(shotId)}`,
  );
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j && j.error ? j.error.detail : `target ${r.status}`);
  return j;
}

/** Read-only lock coordinates (current shot-plan version + digest, ADR-0047). */
export async function getLockTarget(project) {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(project)}/lock-target`,
  );
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j && j.error ? j.error.detail : `lock-target ${r.status}`);
  return j;
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
  const r = await fetch(`/api/paid-ops/${encodeURIComponent(project)}`);
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j && j.error ? j.error.detail : `ops ${r.status}`);
  return j.ops || [];
}

/** Adopt a paid staging clip into a canvas upload slot (copy; no spend).
 *  An occupied slot gains a NEW version (TASK-048 — never overwritten).
 *  Returns {url, version, sha256}. */
export async function adoptPaid(project, taskId, slug) {
  const r = await fetch("/api/agent/adopt-paid", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, task_id: taskId, slug }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j && j.error ? j.error.detail : `adopt ${r.status}`);
  return j;
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

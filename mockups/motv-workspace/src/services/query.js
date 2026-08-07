// Read-only query seam.
//
// - CONNECTED mode: a same-origin backend (server.py) is present and exposes the
//   accepted ADR-0031 read-only query contract over real project data. We fetch it.
// - LOCAL/demo mode: no backend (or no query package) — fall back to the JS
//   fixture so the static `python3 -m http.server` demo still works.
//
// This never writes pipeline state; the only mutations are the mockup-local
// canvas saves in persist.js.

import SHENGTANG from "../../fixtures/project-shengtang.js";

let _meta = null;

/** Probe the backend once; sets the mode for the session. */
export async function detectMode() {
  try {
    const r = await fetch("/api/meta", { cache: "no-store" });
    if (r.ok) {
      _meta = await r.json();
      return _meta;
    }
  } catch {
    /* no backend — static demo */
  }
  _meta = { mode: "local", contract_version: null };
  return _meta;
}

export const meta = () => _meta || { mode: "local" };
export const isConnected = () => meta().mode === "connected";

/** Real project names (CONNECTED only), else empty. */
export async function listProjects() {
  if (!isConnected()) return [];
  try {
    const r = await fetch("/api/projects");
    const j = await r.json();
    return (j.projects || []).map((p) => p.name);
  } catch {
    return [];
  }
}

/** One read-only query (plan/status/budget/cost/problems/approvals) as JSON. */
export async function getQuery(name, q) {
  const r = await fetch(`/api/projects/${encodeURIComponent(name)}/${q}`);
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j && j.error ? j.error.detail : `${q} ${r.status}`);
  return j;
}

/** The project's REAL shot records (CONNECTED only), [] otherwise. */
export async function getShots(name) {
  if (!isConnected()) return [];
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(name)}/shots`);
    const j = await r.json();
    return j.shots || [];
  } catch {
    return [];
  }
}

/** Creative agent (ADR-0042): script → structured shot DRAFT via the local
 *  Claude CLI (subscription-billed; the browser never sees a credential). */
export async function generateShotsDraft(script) {
  const r = await fetch("/api/agent/shots-draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const e = j && j.error ? j.error : {};
    const err = new Error(e.detail || `agent ${r.status}`);
    err.category = e.category;
    err.rawExcerpt = e.raw_excerpt;
    throw err;
  }
  return j.shots || [];
}

/** Manual image provider (prototype scratch): upload a user-generated reference
 *  image (e.g. from the Gemini web app) for an asset slot. Returns its URL. */
export async function uploadAssetImage(project, slug, file) {
  const r = await fetch(
    `/api/uploads/${encodeURIComponent(project)}/${encodeURIComponent(slug)}`,
    { method: "PUT", headers: { "Content-Type": file.type }, body: file },
  );
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.error && j.error.detail) || `upload ${r.status}`);
  return j.url;
}

/** The demo creative fixture (used for canvas authoring content in both modes). */
export function fixtureProject() {
  return SHENGTANG;
}

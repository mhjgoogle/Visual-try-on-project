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

/** The demo creative fixture (used for canvas authoring content in both modes). */
export function fixtureProject() {
  return SHENGTANG;
}

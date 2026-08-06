// Canvas persistence — the mockup's OWN editable state (script drafts, node
// positions, edges), keyed by project name. Prototype-local scratch only: it is
// NOT a projection of core facts and is never written back to any core file.
//
// - With the backend: PUT/GET /api/canvas/<name> → data/<name>.json.
// - Without it: localStorage fallback, so the static demo still persists.

const _timers = {};

/** Load a saved canvas graph, or {} if none. */
export async function loadCanvas(name) {
  try {
    const r = await fetch(`/api/canvas/${encodeURIComponent(name)}`, { cache: "no-store" });
    if (r.ok) return await r.json();
  } catch {
    /* no backend */
  }
  try {
    const s = localStorage.getItem("motv:" + name);
    if (s) return JSON.parse(s);
  } catch {
    /* localStorage unavailable */
  }
  return {};
}

/** Debounced save of the canvas graph for `name`. */
export function saveCanvas(name, data) {
  clearTimeout(_timers[name]);
  _timers[name] = setTimeout(async () => {
    const body = JSON.stringify(data);
    try {
      const r = await fetch(`/api/canvas/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (r.ok) return;
    } catch {
      /* fall through to localStorage */
    }
    try {
      localStorage.setItem("motv:" + name, body);
    } catch {
      /* nothing we can do — keep the in-memory graph */
    }
  }, 700);
}

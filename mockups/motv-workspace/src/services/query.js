// Read-only query seam (STUB).
//
// Real version: the browser reads project data through the versioned read-only
// query contract (ADR-0031 / WQ-01..WQ-19) served on loopback — no path scanning,
// no importing domain internals. Here it just returns local fixtures so the
// mockup has grounded sample content.

import SHENGTANG from "../../fixtures/project-shengtang.js";

const PROJECTS = { shengtang: SHENGTANG };

/** @returns fixture project data, or null when unknown. */
export function getProject(id) {
  return PROJECTS[id] || null;
}

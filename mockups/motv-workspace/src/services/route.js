// URL 即状态 —— the studio's route, as one pure pair of functions (TASK-081 §1.1).
//
// WHAT WAS BROKEN. `grep pushState|replaceState|popstate` over the whole
// repository returned NOTHING. Navigation lived entirely in an in-memory
// `activeModule`, so: a refresh landed back on the landing page, 「EP07 的 SH12」
// could not be sent to anyone, and the browser's own back button left the
// application. `resolveModule` was written FOR deep links — its comment says 「a
// dead deep link is a worse answer than a landing page」 — and there were no deep
// links for it to resolve.
//
//   #/<project>/<space>/<module>[/<section>]?ep=<id>&scene=<id>&shot=<id>
//
// HASH, NOT PATH. The backend (`mockups/motv-workspace/server.py`) is a static
// file server; a path route needs a catch-all rewrite, and this card does not
// touch the backend. A hash also means an external deep link never 404s.
//
// `<space>` IS DERIVED, NOT AUTHORITATIVE. It is in the address because a human
// reads it, but `spaceOf(module)` is the only rule that decides it — so a
// hand-edited `#/p/episode/brief` opens 故事开发's ① and the address is rewritten
// to match on the next paint, rather than two halves of one URL disagreeing
// forever.
//
// RESOLUTION GOES THROUGH `resolveModule`, ALWAYS. A second mapping table here
// is how a bookmark starts landing somewhere the rail, the crumb and the
// highlight disagree about (ADR-0063 决策 1).
//
// PURE. No DOM, no history API, no fetch — those live at the call site, which is
// the only reason the round-trip property below can be asserted at all.
import { resolveModule, spaceOf, PAGE_SECTIONS } from "../ui/shell.js";

const enc = (s) => encodeURIComponent(String(s == null ? "" : s));

function dec(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * The address for a place in the studio.
 *
 * The module is RESOLVED first, so a historical key (`frames`, `dailies`, …)
 * writes the page it actually lands on. The ONE exception is an asset TYPE alias
 * (`assets:image`): resolving it to `assets` would drop the filter the key exists
 * to carry, so those keep their own spelling and resolve back to page + filter.
 */
export function formatRoute({ project, module, section = null, ep = null, scene = null, shot = null } = {}) {
  const hit = resolveModule(module);
  const mod = hit.resolved
    ? (hit.filter ? String(module) : hit.module)
    : String(module || "");
  const sec = hit.resolved && hit.section && !section ? hit.section : section;
  const parts = [enc(project), enc(spaceOf(mod)), enc(mod)];
  // A SECTION IS WRITTEN ONLY WHEN THE PAGE REALLY HAS IT. Writing one a page does
  // not declare would produce an address that cannot be honoured — the same dead
  // -link failure, one level down.
  const list = PAGE_SECTIONS[mod];
  if (sec && list && list.includes(sec)) parts.push(enc(sec));
  const q = [];
  if (ep) q.push(`ep=${enc(ep)}`);
  if (scene) q.push(`scene=${enc(scene)}`);
  if (shot) q.push(`shot=${enc(shot)}`);
  return `#/${parts.join("/")}${q.length ? `?${q.join("&")}` : ""}`;
}

/**
 * Read an address back.
 *
 * Returns `{ ok, project, module, section, filter, ep, scene, shot, resolved, reason }`.
 *
 *   ok:false        there is no address to honour (empty hash) — NOT an error
 *   module:null     the address names a project but no page → open its default
 *   resolved:false  the module key is not one this build knows → the caller opens
 *                   the project's default page AND states the reason. Deliberately
 *                   NOT the landing page: §1.2 第 3 条 already covers 「项目打不开」,
 *                   and throwing a creator out of a project they CAN open because
 *                   one segment aged badly is the harsher of the two failures.
 *                   What §1.2 第 2 条 forbids is swallowing it silently, and it is
 *                   not swallowed — `reason` names the segment that failed.
 */
export function parseRoute(hash) {
  const raw = typeof hash === "string" ? hash : "";
  const body = raw.startsWith("#") ? raw.slice(1) : raw;
  const empty = {
    ok: false, project: null, module: null, section: null, filter: null,
    ep: null, scene: null, shot: null, resolved: false, reason: null,
  };
  if (!body || body === "/") return empty;
  const [path, query = ""] = body.split("?");
  const seg = path.split("/").filter((s) => s !== "").map(dec);
  if (!seg.length) return empty;
  const params = new Map();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const at = pair.indexOf("=");
    if (at < 0) continue;
    params.set(dec(pair.slice(0, at)), dec(pair.slice(at + 1)));
  }
  const project = seg[0] || null;
  // seg[1] is the SPACE and is deliberately ignored — `spaceOf(module)` decides it,
  // so the two halves of an address can never disagree (see the header).
  const key = seg[2] || null;
  const wantSection = seg[3] || null;
  const selection = {
    ep: params.get("ep") || null,
    scene: params.get("scene") || null,
    shot: params.get("shot") || null,
  };
  if (!key) return { ...empty, ok: true, project, ...selection };
  const hit = resolveModule(key);
  const list = PAGE_SECTIONS[hit.module];
  // A section named in the address wins over the alias's own landing section ONLY
  // if the page really declares it; a section that exists nowhere is dropped and
  // reported, never honoured.
  const sectionOk = wantSection && list && list.includes(wantSection);
  return {
    ok: true,
    project,
    module: hit.module,
    section: sectionOk ? wantSection : hit.section || null,
    filter: hit.filter || null,
    ...selection,
    resolved: !!hit.resolved,
    reason: hit.resolved
      ? (wantSection && !sectionOk
        ? `地址里的分区「${wantSection}」不属于这一页，已打开这一页的默认分区`
        : null)
      : `地址里的页面「${key}」不是这个版本认识的页面，已打开默认页面`,
  };
}

/** Do two addresses name the same place?
 *
 *  Used to swallow the duplicate event a browser fires when one hash change
 *  produces BOTH `popstate` and `hashchange`. Applying the same route twice would
 *  repaint and — much worse — re-ask the unsaved-edit question the creator has
 *  already answered. */
export function sameRoute(a, b) {
  if (!a || !b) return false;
  // `filter` IS PART OF THE PLACE, not decoration. `assets` and `assets:image`
  // both resolve to the module `assets`, so leaving the filter out made the two
  // addresses compare EQUAL — and the router, which uses this to swallow a
  // duplicate event, swallowed a real navigation instead: the URL said
  // `assets:image` while the library still showed everything (independent review,
  // round 3).
  return ["project", "module", "section", "filter", "ep", "scene", "shot"]
    .every((k) => (a[k] || null) === (b[k] || null));
}

/* -------------------------------------------------------------------------- */
/* 上次所在页 (§1.3)                                                           */
/* -------------------------------------------------------------------------- */

/** WHERE the last position is kept.
 *
 *  `localStorage`, deliberately NOT `canvas.json` (§1.3): canvas.json is the
 *  creator's WORK, and 「上次打开的是哪一页」 is a property of this browser, not of
 *  the film. Writing it into the document would also make every navigation a
 *  document mutation, i.e. an autosave storm and a diff nobody can read. */
const LAST_ROUTE_KEY = "motv:lastRoute";

const readAll = (storage) => {
  try {
    const raw = storage && storage.getItem(LAST_ROUTE_KEY);
    const j = raw ? JSON.parse(raw) : null;
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    // corrupt or unavailable storage is 「不知道上次在哪」, never a crash on boot
    return {};
  }
};

export function loadLastRoute(storage, project) {
  const hit = readAll(storage)[project];
  return hit && typeof hit === "object" ? hit : null;
}

export function saveLastRoute(storage, project, route) {
  if (!storage || !project || !route || !route.module) return false;
  try {
    const all = readAll(storage);
    all[project] = {
      module: route.module,
      section: route.section || null,
      ep: route.ep || null,
      scene: route.scene || null,
      shot: route.shot || null,
    };
    storage.setItem(LAST_ROUTE_KEY, JSON.stringify(all));
    return true;
  } catch {
    // a full or blocked storage must not break navigation — the position is a
    // convenience, and losing it costs one click
    return false;
  }
}

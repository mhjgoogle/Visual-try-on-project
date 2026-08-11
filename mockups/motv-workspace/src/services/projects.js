// Project registry — the landing page's list of projects the creator has
// made in this prototype, plus the asset location each one declares.
//
// SCOPE: prototype-local scratch, exactly like the canvas document. It records
// a NAME and a DECLARED asset root; it never creates a directory, never writes
// media, and is not a projection of any core fact. Real project directories
// are created by the backend/CLI, which owns the write path (ADR-0033+).
//
// PATHS: the asset root is a STRING the creator supplies. This module never
// resolves it against the host filesystem and never assumes a platform — it
// only joins for DISPLAY, using whichever separator the root itself uses, so
// a Windows root renders as Windows and a POSIX root as POSIX (AGENTS.md §3:
// no hardcoded separators, no platform-specific syscalls).
//
// Pure functions + an injected storage object (localStorage in the app, a stub
// in tests). No DOM, no fetch, no clock — `now` is passed in.

const KEY = "motv.projects.v1";

/** Characters that can never appear in a project NAME: it becomes a directory
 *  segment downstream, so separators, traversal and the Windows-reserved set
 *  are rejected up front rather than sanitized silently. */
const NAME_FORBIDDEN = /[\\/:*?"<>|]/;
// eslint-disable-next-line no-control-regex -- control characters ARE the target
const NAME_CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_NAME = 60;
// Windows refuses these as directory names in ANY case, with or without an
// extension, and also refuses a trailing dot or space. This tool is
// Windows-first (ADR-0049), so they are rejected here rather than failing
// later at mkdir time with an opaque OS error.
const WIN_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Collapse whitespace; keep everything else the creator typed. */
export function normalizeName(raw) {
  return String(raw ?? "").trim().replace(/\s+/g, " ");
}

/** Validate a project name against the existing list (case-insensitive: the
 *  same name in different case would collide on NTFS). */
export function validateName(raw, existing = []) {
  const name = normalizeName(raw);
  if (!name) return { ok: false, error: "请输入项目名" };
  if (name.length > MAX_NAME) return { ok: false, error: `项目名不能超过 ${MAX_NAME} 个字符` };
  if (NAME_FORBIDDEN.test(name)) return { ok: false, error: '项目名不能包含 \\ / : * ? " < > |' };
  // Control characters are not merely invalid segments: a NUL reaches the
  // backend's Path() and raises ValueError (not OSError), which would drop the
  // connection instead of returning a validation error.
  if (NAME_CONTROL.test(name)) return { ok: false, error: "项目名不能包含控制字符" };
  if (name === "." || name === "..") return { ok: false, error: "项目名不能是 . 或 .." };
  if (/[.\s]$/.test(name)) return { ok: false, error: "项目名不能以 . 或空格结尾" };
  if (WIN_RESERVED.has(name.split(".")[0].toLowerCase())) {
    return { ok: false, error: `「${name}」是 Windows 保留名，不能作为文件夹名` };
  }
  const lower = name.toLowerCase();
  if (existing.some((n) => String(n).toLowerCase() === lower)) {
    return { ok: false, error: "已有同名项目" };
  }
  return { ok: true, name };
}

/** Validate a declared asset root. Deliberately permissive about PLATFORM —
 *  it may be a Windows or POSIX path — but never accepts traversal, which is
 *  the one thing that would make the declared location misleading. */
export function validateRoot(raw) {
  const root = String(raw ?? "").trim();
  if (!root) return { ok: false, error: "请填写资产保存位置" };
  const parts = root.split(/[\\/]+/);
  if (parts.some((p) => p === "..")) return { ok: false, error: "路径不能包含 .." };
  return { ok: true, root: trimTrailingSep(root) };
}

/** Drop trailing separators WITHOUT erasing a root that IS one: "/" is a real
 *  POSIX location and must not collapse to the empty string. */
export function trimTrailingSep(root) {
  const s = String(root || "");
  if (!s) return "";
  const cut = s.replace(/[\\/]+$/, "");
  return cut || s[0]; // all separators ("/" or "\") → keep exactly one
}

/** Which separator this root already uses — Windows roots stay Windows. */
export function separatorFor(root) {
  const s = String(root || "");
  if (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s)) return "\\";
  if (s.includes("\\") && !s.includes("/")) return "\\";
  return "/";
}

/** Where THIS project's assets are declared to live: <root><sep><name>.
 *  Display only — nothing here touches a filesystem. */
export function assetPathFor(root, name) {
  const raw = String(root || "");
  const n = normalizeName(name);
  if (!raw) return n;
  const r = trimTrailingSep(raw);
  if (!n) return r;
  const sep = separatorFor(raw);
  // a root that IS a separator already ends in one — never double it
  return r.endsWith(sep) ? `${r}${n}` : `${r}${sep}${n}`;
}

/* -------------------------------------------------------------------------- */
/* registry                                                                    */
/* -------------------------------------------------------------------------- */

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/** Read the registry. A corrupt/absent value yields an empty list rather than
 *  throwing — the landing page must always render. */
export function loadRegistry(storage) {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p) => isObj(p) && typeof p.name === "string" && p.name)
      .map((p) => ({
        name: p.name,
        assetRoot: typeof p.assetRoot === "string" ? p.assetRoot : "",
        createdAt: typeof p.createdAt === "string" ? p.createdAt : "",
        openedAt: typeof p.openedAt === "string" ? p.openedAt : "",
      }));
  } catch {
    return [];
  }
}

/** Persist the registry. A full/blocked storage must not break the app. */
export function saveRegistry(storage, list) {
  try {
    storage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Add a project. Returns { ok, list, error } — the caller re-renders from
 *  `list`, so a rejected name never half-applies. */
export function addProject(storage, { name, assetRoot, now }) {
  const list = loadRegistry(storage);
  const v = validateName(name, list.map((p) => p.name));
  if (!v.ok) return { ok: false, list, error: v.error };
  // The location is OPTIONAL metadata: demo mode has no filesystem at all, so
  // a project there legitimately has none. A location that IS given must still
  // be a valid one.
  let root = "";
  if (String(assetRoot ?? "").trim()) {
    const r = validateRoot(assetRoot);
    if (!r.ok) return { ok: false, list, error: r.error };
    root = r.root;
  }
  const next = list.concat([{ name: v.name, assetRoot: root, createdAt: now || "", openedAt: now || "" }]);
  // a failed write must NOT report success: the project would open and then
  // vanish from the landing page on the next load
  if (!saveRegistry(storage, next)) {
    return { ok: false, list, error: "无法保存项目列表（浏览器存储已满或被禁用）— 项目未创建" };
  }
  return { ok: true, list: next, name: v.name, assetRoot: root };
}

/** Stamp a project as most-recently opened (drives the landing order). */
export function touchProject(storage, name, now) {
  const list = loadRegistry(storage);
  const i = list.findIndex((p) => p.name === name);
  if (i < 0) return list;
  const next = list.slice();
  next[i] = { ...next[i], openedAt: now || next[i].openedAt };
  saveRegistry(storage, next);
  return next;
}

/**
 * The landing page's cards: locally created projects merged with the real
 * projects the backend reports.
 *
 * A backend project is REAL (it has records/budget behind it); a local one is
 * a prototype canvas with no core project directory. The two are labelled
 * differently and never conflated — a local entry that shares a name with a
 * real project is shown once, as the real one.
 */
export function projectCards({ local = [], remote = [], demo = null } = {}) {
  const seen = new Set();
  const cards = [];
  for (const name of remote) {
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const match = local.find((p) => p.name === name);
    cards.push({
      name,
      kind: "real",
      assetRoot: match ? match.assetRoot : "",
      openedAt: match ? match.openedAt : "",
    });
  }
  for (const p of local) {
    if (seen.has(p.name.toLowerCase())) continue;
    seen.add(p.name.toLowerCase());
    cards.push({ name: p.name, kind: "canvas", assetRoot: p.assetRoot, openedAt: p.openedAt });
  }
  // newest-opened first; never-opened entries keep insertion order after them
  cards.sort((a, b) => String(b.openedAt || "").localeCompare(String(a.openedAt || "")));
  if (demo) cards.push({ ...demo, kind: "demo" });
  return cards;
}

// Script document — the DOMAIN state for the creator-first Idea → Script slice.
//
// Owns the Creative Brief (创意) and the append-only Script version chain
// (v1, v2… — a new version NEVER overwrites an earlier one), independent of any
// canvas node: nodes render FROM this document, so deleting/duplicating the
// 剧本 node cannot lose script content. Pure state + transitions only — no
// fetch, no DOM; the AI call itself lives behind ctx.script in app.js.
//
// Persisted shape (inside the canvas save, `scriptDoc` field): brief, versions,
// active, workingText. `pending` is TRANSIENT generation state (generating /
// proposed / failed) and is intentionally NOT persisted — a reload lands on the
// last durable version, never on a half-finished call.

import { mintId } from "./identity.js";

/** One immutable version record: what was asked (instruction), what came back
 *  (content), where it started (basedOn) and how (origin). `id` is the stable
 *  machine identity (M2) — minted once here, carried forever; the integer `v`
 *  stays the creator-facing number and keeps its existing dense-chain rules. */
function versionRecord(doc, { content, instruction, origin, basedOn }) {
  return {
    id: mintId("sv"),
    v: doc.versions.length + 1,
    content: String(content),
    instruction: String(instruction || ""),
    origin, // "generated" (from the brief) | "revision" (AI proposal applied) | "manual"
    basedOn: basedOn ?? null,
    status: "done",
  };
}

const ORIGINS = ["generated", "revision", "manual"];

function sanitizeVersions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    if (!x || typeof x.content !== "string" || !Number.isInteger(x.v)) continue;
    out.push({
      // stable id survives the reload verbatim; only a tampered/legacy record
      // without one gets a fresh mint (the v1→v2 migration normally backfills
      // deterministic ids before this ever runs)
      id: typeof x.id === "string" && x.id ? x.id : mintId("sv"),
      v: out.length + 1, // renumber defensively — the chain must stay dense
      content: x.content,
      instruction: typeof x.instruction === "string" ? x.instruction : "",
      // whitelist: a tampered save must not smuggle arbitrary strings into
      // the UI through this enum-like field
      origin: ORIGINS.includes(x.origin) ? x.origin : "generated",
      basedOn: Number.isInteger(x.basedOn) ? x.basedOn : null,
      status: "done",
    });
  }
  return out;
}

/** Hydrate a document from a persisted `scriptDoc` (or a legacy plain node
 *  text via `{ legacyText }`), or start empty. */
export function createDoc(saved) {
  const doc = { brief: "", versions: [], active: 0, workingText: null, pending: null, _seq: 0 };
  if (!saved || typeof saved !== "object") return doc;
  if (typeof saved.legacyText === "string" && saved.legacyText) {
    doc.workingText = saved.legacyText; // pre-scriptDoc canvases: unversioned buffer
    return doc;
  }
  if (typeof saved.brief === "string") doc.brief = saved.brief;
  doc.versions = sanitizeVersions(saved.versions);
  doc.active =
    Number.isInteger(saved.active) && doc.versions.some((x) => x.v === saved.active)
      ? saved.active
      : doc.versions.length; // default to the newest version (0 when none)
  if (typeof saved.workingText === "string") doc.workingText = saved.workingText;
  return doc;
}

/** The durable slice for persistence — transient pending state is dropped. */
export function serialize(doc) {
  return {
    brief: doc.brief,
    versions: doc.versions,
    active: doc.active,
    workingText: doc.workingText,
  };
}

export function activeVersion(doc) {
  return doc.versions.find((x) => x.v === doc.active) || null;
}

/** The script the creator currently sees (and downstream steps consume):
 *  the manual edit buffer when present, else the active version's content. */
export function currentText(doc) {
  if (typeof doc.workingText === "string") return doc.workingText;
  const av = activeVersion(doc);
  return av ? av.content : "";
}

/** True when the buffer holds manual edits diverging from the active version. */
export function isDirty(doc) {
  const av = activeVersion(doc);
  return av != null && typeof doc.workingText === "string" && doc.workingText !== av.content;
}

/** The stable id of the Script version whose exact content downstream steps
 *  would consume RIGHT NOW — or null when that provenance cannot be proven
 *  (no versions yet, or the buffer holds unversioned manual edits). Missing
 *  provenance is recorded honestly as null, never guessed (M2). */
export function sourceVersionId(doc) {
  const av = activeVersion(doc);
  return av && !isDirty(doc) ? av.id : null;
}

export function setBrief(doc, idea) {
  doc.brief = String(idea ?? "");
}

/** Manual typing in the script textarea — buffer only, versions untouched. */
export function editText(doc, text) {
  doc.workingText = String(text ?? "");
}

/** Start a generation. kind: "initial" (brief → script) | "revision"
 *  (current script + instruction → proposal). Returns a call id used to
 *  reject stale completions, or 0 when refused: one is already running, or
 *  an un-applied proposal is still awaiting an explicit apply/discard (a new
 *  run would silently overwrite the draft the user is reviewing). A `failed`
 *  pending is transient and may be replaced by a retry. */
export function beginGeneration(doc, kind, instruction) {
  const st = doc.pending && doc.pending.status;
  if (st === "generating" || st === "proposed") return 0;
  const id = ++doc._seq;
  doc.pending = {
    id,
    status: "generating",
    kind,
    instruction: String(instruction || ""),
    basedOn: doc.active || null, // the version the request was made against
  };
  return id;
}

/** Applying a version resets the manual buffer — so a non-empty buffer that
 *  diverges from the active version would be SILENTLY lost. Never overwrite
 *  user text: snapshot it as a `manual` version first. Returns its v (or 0). */
function snapshotBufferIfNeeded(doc) {
  const t = doc.workingText;
  if (typeof t !== "string" || !t.trim()) return 0;
  const av = activeVersion(doc);
  if (av && av.content === t) return 0;
  const rec = versionRecord(doc, {
    content: t,
    instruction: "",
    origin: "manual",
    basedOn: doc.active || null,
  });
  doc.versions.push(rec);
  doc.active = rec.v;
  return rec.v;
}

/** Land a finished generation. Initial applies straight to a new version
 *  (v1, v2…); a revision becomes a PROPOSAL awaiting the user's apply. */
export function completeGeneration(doc, id, content) {
  const p = doc.pending;
  if (!p || p.id !== id || p.status !== "generating") return false; // cancelled/stale
  if (p.kind === "initial") {
    const snap = snapshotBufferIfNeeded(doc);
    const rec = versionRecord(doc, {
      content,
      instruction: p.instruction,
      origin: "generated",
      basedOn: snap || p.basedOn,
    });
    doc.versions.push(rec);
    doc.active = rec.v;
    doc.workingText = null; // the buffer follows the new active version
    doc.pending = null;
  } else {
    doc.pending = { ...p, status: "proposed", proposal: String(content) };
  }
  return true;
}

export function failGeneration(doc, id, message) {
  const p = doc.pending;
  if (!p || p.id !== id || p.status !== "generating") return false;
  doc.pending = { ...p, status: "failed", error: String(message || "生成失败") };
  return true;
}

/** User-initiated cancel; a late completion for the old id is then ignored. */
export function cancelGeneration(doc) {
  doc.pending = null;
}

/** Apply the pending revision proposal as the next immutable version.
 *  Every earlier version stays in the chain untouched. */
export function applyProposal(doc) {
  const p = doc.pending;
  if (!p || p.status !== "proposed") return null;
  const snap = snapshotBufferIfNeeded(doc); // manual edits survive as their own version
  const rec = versionRecord(doc, {
    content: p.proposal,
    instruction: p.instruction,
    origin: "revision",
    basedOn: snap || p.basedOn,
  });
  doc.versions.push(rec);
  doc.active = rec.v;
  doc.workingText = null;
  doc.pending = null;
  return rec;
}

export function discardProposal(doc) {
  if (doc.pending && doc.pending.status === "proposed") doc.pending = null;
}

/** Switch the active version — the view then shows exactly the selected
 *  version's content. Unsaved manual edits in the buffer are snapshotted as
 *  their own `manual` version first, never silently dropped. */
export function setActive(doc, v) {
  if (!doc.versions.some((x) => x.v === v)) return false;
  snapshotBufferIfNeeded(doc);
  doc.active = v;
  doc.workingText = null;
  return true;
}

// Story document (checkpoint M9; Creative Brief added by TASK-057) — the
// project-level CREATIVE development chain that sits BETWEEN the idea and the
// episode scripts:
//
//   Creative Brief (working draft + revisions)
//        → AI-assisted Story Development → Story Outline (versioned, approved)
//        → Episode Plan (versioned, confirmed) → per-episode Scripts
//
// Owns the Idea, the Creative BRIEF (working draft + append-only revision
// chain), the append-only Story OUTLINE version chain, and the append-only
// Episode PLAN version chain. AI output is always a PROPOSAL
// (transient `pending`) until the creator applies it as a new immutable
// version; earlier versions are never overwritten. `approved` / `confirmedPlan`
// are durable pointers the downstream steps key off:
//  - the outline must be APPROVED before an episode plan is proposed;
//  - the plan must be CONFIRMED before it instantiates Episode entities
//    (the caller stamps each plan entry's episodeId at confirm time — an
//    explicit identity join, never re-derived from titles or positions).
//
// The outline NEVER writes Production Bible entities (M9 rule 8): formal
// bible sync stays driven by actual episode scripts (M8 breakdown).
//
// Pure state + transitions only — no fetch, no DOM, no clock.

import { mintId } from "./identity.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x : "");
// kept VERBATIM (no trims/caps): hydration must be lossless for persisted
// content — v8 validation rejects malformed values instead of coercing them
const strList = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === "string" && s.trim()) : []);

// `climax` joins the outline at TASK-057 (v10): 高潮 is one of the beats a
// creator reads an outline for, and it was previously only expressible inside
// the storyArc prose. Purely additive — every earlier version migrates to "".
export const OUTLINE_FIELDS = [
  "premise", "logline", "genreTone", "world", "centralConflict", "storyArc", "climax", "ending", "durationNote",
];
export const PLAN_FIELDS = ["title", "synopsis", "purpose", "hook", "endingBeat", "duration"];

// ---- Creative Brief (TASK-057) --------------------------------------------- //
// The brief's own fields. The CORE IDEA is deliberately NOT one of them: it
// stays `story.idea`, the single canonical place it has always lived (a second
// copy is exactly what ADR-0054 决策 2 forbids). A brief REVISION snapshots the
// idea alongside these fields, because a revision must be immutable.
export const BRIEF_FIELDS = ["genre", "tone", "form", "episodeDuration", "totalDuration", "notes"];

/** Normalize the brief's editable draft. `targetEpisodes` is a positive
 *  integer or null (1..50, matching the plan endpoint's cap, so a brief can
 *  never ask for a count compliant planning cannot serve). */
export function sanitizeBriefDraft(d) {
  const src = isObj(d) ? d : {};
  const out = { ...src }; // unknown fields survive the round-trip
  for (const k of BRIEF_FIELDS) out[k] = str(src[k]);
  const n = src.targetEpisodes;
  out.targetEpisodes = Number.isInteger(n) && n > 0 && n <= 50 ? n : null;
  return out;
}

function sanitizeBriefVersions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    if (!isObj(x)) continue;
    out.push({
      ...x, // unknown fields survive
      id: typeof x.id === "string" && x.id ? x.id : mintId("cb"),
      v: out.length + 1, // dense chain, defensively renumbered
      // a revision is IMMUTABLE and self-contained: it carries the idea it was
      // taken with, so "Based on Creative Brief v2" means one exact thing
      idea: str(x.idea),
      fields: sanitizeBriefDraft(x.fields),
      origin: ["manual", "developed"].includes(x.origin) ? x.origin : "manual",
      instruction: str(x.instruction),
    });
  }
  return out;
}

function createBrief(saved) {
  const doc = { draft: sanitizeBriefDraft(null), versions: [], active: 0 };
  if (!isObj(saved)) return doc;
  doc.draft = sanitizeBriefDraft(saved.draft);
  doc.versions = sanitizeBriefVersions(saved.versions);
  const vOk = (v) => Number.isInteger(v) && doc.versions.some((x) => x.v === v);
  // an unusable pointer falls back to the LATEST revision (deterministic), and
  // 0 (= only a working draft, no formal revision yet) is always legal
  doc.active = saved.active === 0 ? 0 : vOk(saved.active) ? saved.active : doc.versions.length;
  return doc;
}

/** The Creative Brief revision the downstream is based on, or null when the
 *  creator has only a working draft so far (honest — never invented). */
export function activeBrief(doc) {
  return doc.brief.versions.find((x) => x.v === doc.brief.active) || null;
}

/** Edit the working draft. AUTOSAVE ONLY — never creates a revision. The core
 *  idea is not a brief field: it is written through setIdea, so there is
 *  exactly one place the idea lives. */
export function editBriefDraft(doc, fields) {
  if (!isObj(fields)) return false;
  for (const k of BRIEF_FIELDS) {
    if (k in fields) doc.brief.draft[k] = str(fields[k]);
  }
  if ("targetEpisodes" in fields) {
    const n = fields.targetEpisodes;
    doc.brief.draft.targetEpisodes = Number.isInteger(n) && n > 0 && n <= 50 ? n : null;
  }
  return true;
}

/** True while the working draft differs from the active revision (or there is
 *  no revision yet and the creator has written something). Drives the
 *  「Working Draft · 未版本化」 標記 — the UI never guesses this. */
export function briefIsDirty(doc) {
  const cur = activeBrief(doc);
  const d = doc.brief.draft;
  if (!cur) {
    return !!doc.idea.trim() || BRIEF_FIELDS.some((k) => d[k].trim()) || d.targetEpisodes !== null;
  }
  if (cur.idea !== doc.idea) return true;
  if (cur.fields.targetEpisodes !== d.targetEpisodes) return true;
  return BRIEF_FIELDS.some((k) => cur.fields[k] !== d[k]);
}

/** Create a formal Brief REVISION from the current working draft — the ONLY
 *  thing that bumps the brief's version number (决策 2 / 决策 6). Returns the
 *  record, or null when nothing has changed since the active revision (a
 *  no-op must not mint an identical version). */
export function commitBrief(doc, origin = "manual", instruction = "") {
  if (!briefIsDirty(doc)) return null;
  const rec = {
    id: mintId("cb"),
    v: doc.brief.versions.length + 1,
    idea: doc.idea,
    fields: sanitizeBriefDraft(doc.brief.draft),
    origin: ["manual", "developed"].includes(origin) ? origin : "manual",
    instruction: String(instruction || ""),
  };
  doc.brief.versions.push(rec);
  doc.brief.active = rec.v;
  return rec;
}

/** Read an EARLIER revision without changing what downstream is based on:
 *  switching the active pointer IS a downstream-visible decision, so it is a
 *  separate explicit op. */
export function setActiveBrief(doc, v) {
  if (!doc.brief.versions.some((x) => x.v === v)) return false;
  doc.brief.active = v;
  return true;
}

/** Restore an earlier revision's content INTO the working draft (non
 *  destructive: the revision chain is untouched, and the restored draft is
 *  only formal once the creator commits it). */
export function restoreBriefDraft(doc, v) {
  const rec = doc.brief.versions.find((x) => x.v === v);
  if (!rec) return false;
  doc.brief.draft = sanitizeBriefDraft(rec.fields);
  doc.idea = rec.idea;
  return true;
}

/** Normalize a (possibly agent-produced) outline into the canonical shape.
 *  Strings for every facet, characterConcepts a string list, episodeCount a
 *  positive integer or null — anything else degrades honestly, never throws. */
export function sanitizeOutline(o) {
  const src = isObj(o) ? o : {};
  const out = { ...src }; // unknown fields survive the round-trip
  for (const k of OUTLINE_FIELDS) out[k] = str(src[k]);
  out.characterConcepts = strList(src.characterConcepts);
  const n = src.episodeCount;
  // 1..50 — the plan endpoint's parser rejects >50 episodes, so an outline
  // must not be able to request a count that compliant planning cannot serve
  out.episodeCount = Number.isInteger(n) && n > 0 && n <= 50 ? n : null;
  return out;
}

/** Normalize a plan's episode entries: dense epNumber, string facets,
 *  episodeId carried verbatim when present (stamped at confirm time). */
export function sanitizePlanEpisodes(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!isObj(e)) continue;
    const entry = { ...e, epNumber: out.length + 1 }; // unknown fields survive
    for (const k of PLAN_FIELDS) entry[k] = str(e[k]);
    if (!entry.title.trim()) continue; // an episode needs at least a title
    entry.episodeId = typeof e.episodeId === "string" && e.episodeId ? e.episodeId : null;
    out.push(entry);
  }
  return out;
}

function sanitizeVersions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    if (!isObj(x) || !isObj(x.outline)) continue;
    out.push({
      ...x, // unknown fields survive the round-trip
      id: typeof x.id === "string" && x.id ? x.id : mintId("so"),
      v: out.length + 1, // dense chain, defensively renumbered
      outline: sanitizeOutline(x.outline),
      origin: ["developed", "revision", "manual"].includes(x.origin) ? x.origin : "developed",
      instruction: str(x.instruction),
      basedOn: Number.isInteger(x.basedOn) ? x.basedOn : null,
      // TASK-057: the Creative Brief revision this outline was developed from.
      // Honestly null when there was none (never back-derived from a later
      // revision — an outline written before any brief revision is based on no
      // revision, and saying otherwise would fake provenance).
      briefVersionId: typeof x.briefVersionId === "string" && x.briefVersionId ? x.briefVersionId : null,
    });
  }
  return out;
}

function sanitizePlans(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    if (!isObj(x)) continue;
    const episodes = sanitizePlanEpisodes(x.episodes);
    if (!episodes.length) continue;
    out.push({
      ...x, // unknown fields survive the round-trip
      id: typeof x.id === "string" && x.id ? x.id : mintId("plan"),
      v: out.length + 1,
      episodes,
      origin: ["proposed", "manual"].includes(x.origin) ? x.origin : "proposed",
      instruction: str(x.instruction),
      outlineVersionId: typeof x.outlineVersionId === "string" && x.outlineVersionId ? x.outlineVersionId : null,
    });
  }
  return out;
}

/** Hydrate from a persisted `story` field, or start empty. */
export function createStory(saved) {
  const doc = {
    idea: "",
    // Creative Brief (TASK-057): working draft + append-only revision chain
    brief: createBrief(null),
    versions: [],
    active: 0,
    approved: 0,
    plans: [],
    activePlan: 0,
    confirmedPlan: 0,
    // TASK-069: UNVERSIONED hand edits of the plan, keyed by the plan version they
    // were typed over. Persisted like the episode script's `workingText` — a refresh
    // mid-sentence must not lose one — and turned into a version only by an explicit
    // save. Keyed by base so switching versions cannot silently discard one.
    planDrafts: {},
    pending: null, // transient — never persisted
    _seq: 0,
  };
  if (!isObj(saved)) return doc;
  doc.idea = str(saved.idea);
  doc.brief = createBrief(saved.brief);
  doc.versions = sanitizeVersions(saved.versions);
  const vOk = (v) => Number.isInteger(v) && doc.versions.some((x) => x.v === v);
  doc.active = vOk(saved.active) ? saved.active : doc.versions.length;
  doc.approved = vOk(saved.approved) ? saved.approved : 0;
  doc.plans = sanitizePlans(saved.plans);
  const pOk = (v) => Number.isInteger(v) && doc.plans.some((x) => x.v === v);
  doc.activePlan = pOk(saved.activePlan) ? saved.activePlan : doc.plans.length;
  doc.confirmedPlan = pOk(saved.confirmedPlan) ? saved.confirmedPlan : 0;
  // TASK-069: the unversioned hand edits. A draft is kept only when it names a plan
  // version that still exists — one whose base is gone cannot be compared against
  // anything, so keeping it would make 「已修改」 permanent and unresolvable.
  const saveDrafts = isObj(saved.planDrafts) ? saved.planDrafts : null;
  if (saveDrafts) {
    for (const k of Object.keys(saveDrafts)) {
      const v = Number(k);
      if (!pOk(v) || !Array.isArray(saveDrafts[k])) continue;
      const eps = sanitizePlanEpisodes(saveDrafts[k]);
      if (eps.length) doc.planDrafts[String(v)] = eps;
    }
  } else if (isObj(saved.planDraft) && pOk(saved.planDraft.basedOn)) {
    // a document written by the FIRST shape of this feature (one draft, keyed by
    // `basedOn`). Migrated rather than dropped — it is the creator's unsaved work.
    const eps = sanitizePlanEpisodes(saved.planDraft.episodes);
    if (eps.length) doc.planDrafts[String(saved.planDraft.basedOn)] = eps;
  }
  return doc;
}

/** The durable slice for persistence — transient pending state is dropped. */
export function serialize(doc) {
  return {
    idea: doc.idea,
    brief: { draft: doc.brief.draft, versions: doc.brief.versions, active: doc.brief.active },
    versions: doc.versions,
    active: doc.active,
    approved: doc.approved,
    plans: doc.plans,
    activePlan: doc.activePlan,
    confirmedPlan: doc.confirmedPlan,
    planDrafts: doc.planDrafts,
  };
}

export function activeOutline(doc) {
  return doc.versions.find((x) => x.v === doc.active) || null;
}

export function approvedOutline(doc) {
  return doc.versions.find((x) => x.v === doc.approved) || null;
}

/* -------------------------------------------------------------------------- */
/* MANUAL plan editing (TASK-069)                                             */
/* -------------------------------------------------------------------------- */
//
// 分集规划 used to be AI-only: the six facets of each episode (title / synopsis /
// purpose / hook / endingBeat / duration) could be produced by a proposal and
// confirmed, but never typed. This is the hand-editing half.
//
// WHY A DRAFT AND NOT AN IN-PLACE EDIT. A plan version is IMMUTABLE canon, and
// every Episode records which version it was built on (`canondoc` stamps it, and
// 分集规划 renders it as 「Based on … 规划 vN」). Editing a confirmed version in
// place would leave that chip saying vN while its content had been replaced —
// the baseline would be a lie, and the Impact Review that rests on it (ADR-0054
// 决策 6) would be reporting about something that no longer exists.
//
// So a hand edit lands in a DRAFT, exactly like the episode script's
// `workingText`: persisted (a refresh mid-sentence must not lose it), visible as
// 「已手工修改（未版本化）」, and turned into a real version only by an explicit
// save. Confirming that version stays a separate act, so downstream episodes are
// never carried along by an edit still in progress.

/**
 * The plan version on screen, and therefore the one a hand edit starts from:
 * the ACTIVE one, falling back to the confirmed one.
 *
 * ACTIVE, not confirmed — that is the plan panel's own convention (it renders
 * `story.activePlan` and switches it with 「查看 v2」). Basing edits on the
 * confirmed version instead made the just-saved version vanish from the screen:
 * saving sets `activePlan` to the new version, but the cards kept re-reading the
 * confirmed one, so the creator's edit appeared to be discarded.
 *
 * Null when there is no plan at all — there is nothing to edit yet.
 */
export function planEditBase(doc) {
  return activePlan(doc) || confirmedPlan(doc) || null;
}

/** The unsaved hand edit OF THE VERSION ON SCREEN, or null.
 *
 *  Drafts are kept PER BASE VERSION. A single draft could not survive the plan
 *  panel's 「查看 v2」: it would still be displayed while the panel said v2, and
 *  the next keystroke would re-seed it from v2 and take the unsaved v1 edits with
 *  it — silent data loss, found by codex review. Keyed by base, switching away and
 *  back returns to exactly what was typed. */
export function planDraftFor(doc, v) {
  const d = doc.planDrafts ? doc.planDrafts[String(v)] : null;
  return Array.isArray(d) ? d : null;
}

/** The entries currently on screen: the draft FOR THIS VERSION when one exists,
 *  else the version's own. ONE derivation, so the editor and the reader cannot
 *  disagree — and it can never show one version's text under another's number. */
export function effectivePlanEpisodes(doc) {
  const base = planEditBase(doc);
  if (!base) return [];
  return planDraftFor(doc, base.v) || base.episodes;
}

/** Is the version on screen edited but unsaved? Compared by CONTENT against that
 *  version, so re-typing a value back to what it was clears the flag rather than
 *  leaving a permanent 「已修改」 the creator cannot get rid of. */
/** The version number `savePlanDraft` WILL create — always one past the newest plan,
 *  never `base + 1`. Editing an older base does not overwrite the versions after it
 *  (canon is append-only), so predicting `base + 1` in the UI told the creator a
 *  version number the save would never produce (codex review round 4). */
export function nextPlanVersion(doc) {
  return (doc && Array.isArray(doc.plans) ? doc.plans.length : 0) + 1;
}

export function planDirty(doc) {
  const base = planEditBase(doc);
  if (!base) return false;
  const a = planDraftFor(doc, base.v);
  if (!a) return false;
  const b = base.episodes;
  if (a.length !== b.length) return true;
  return a.some((e, i) => PLAN_FIELDS.some((k) => str(e[k]) !== str(b[i][k])));
}

/** Does this version's stored draft actually DIFFER from it? */
function draftDiffers(doc, v) {
  const base = doc.plans.find((x) => x.v === v) || null;
  const a = planDraftFor(doc, v);
  if (!base || !a) return false;
  if (a.length !== base.episodes.length) return true;
  return a.some((e, i) => PLAN_FIELDS.some((k) => str(e[k]) !== str(base.episodes[i][k])));
}

/**
 * Every version that has an unsaved edit — so the UI can say that a draft is
 * waiting on a version the creator is not currently looking at, instead of it
 * being invisible until they happen to switch back.
 *
 * BY CONTENT, not by mere existence. Typing a value and then typing it back leaves
 * a stored draft that is identical to its version; reporting that would warn about
 * 「另有未保存的修改」 that are not modifications at all — and `discardPlanDraft`
 * only reaches the version on screen, so the creator could not clear the warning
 * from where they were standing (codex review, non-blocking → fixed).
 */
export function planDraftVersions(doc) {
  if (!doc.planDrafts) return [];
  return Object.keys(doc.planDrafts)
    .map((k) => Number(k))
    .filter((v) => Number.isInteger(v) && draftDiffers(doc, v))
    .sort((a, b) => a - b);
}

/**
 * Type one facet of one episode's plan entry.
 *
 * Addressed by `episodeId` — never by index. An index would move under any
 * re-order and silently write 「EP03 的钩子」 onto EP02.
 *
 * Returns false when there is nothing to edit (no plan) or the episode / field
 * is not part of the plan — a refusal, never a silent no-op that reports success.
 */
export function editPlanEntry(doc, episodeId, field, value) {
  if (!PLAN_FIELDS.includes(field)) return false;
  if (typeof episodeId !== "string" || !episodeId) return false;
  const base = planEditBase(doc);
  if (!base) return false;
  // CHECK BEFORE SEEDING. Validating after would leave a draft behind for an edit
  // that was refused — state created by an operation that reported failure.
  if (!base.episodes.some((e) => e.episodeId === episodeId)) return false;
  if (!doc.planDrafts) doc.planDrafts = {};
  const key = String(base.v);
  if (!Array.isArray(doc.planDrafts[key])) {
    // seed THIS VERSION's draft from it, deep enough that editing cannot mutate
    // the immutable version it came from. Other versions' drafts are untouched.
    doc.planDrafts[key] = base.episodes.map((e) => ({ ...e }));
  }
  const entry = doc.planDrafts[key].find((e) => e.episodeId === episodeId);
  if (!entry) return false;
  entry[field] = str(value);
  return true;
}

/**
 * Turn the draft into the next plan version (`origin: "manual"`).
 *
 * Returns the new version number, or 0 when there is nothing to save. Pointers
 * do NOT move: `activePlan` follows the new version (it is what the creator is
 * now looking at), but `confirmedPlan` stays where it was — confirming is the
 * gate that instantiates/links episodes, and a hand edit must not walk through
 * it by itself.
 */
export function savePlanDraft(doc) {
  if (!planDirty(doc)) return 0;
  const base = planEditBase(doc);
  const rec = {
    id: mintId("plan"),
    v: doc.plans.length + 1,
    episodes: sanitizePlanEpisodes(planDraftFor(doc, base.v)),
    origin: "manual",
    instruction: "",
    // the same launch-time provenance link a proposed version carries, so a
    // hand-edited plan can still say which outline it belongs to
    outlineVersionId: base ? base.outlineVersionId ?? null : null,
    // WHICH version was typed over. A proposed version records its instruction;
    // a manual one records its parent, which is the only honest answer to
    // 「这一版是从哪一版改出来的」.
    basedOn: base ? base.v : null,
  };
  if (!rec.episodes.length) return 0; // sanitizer dropped everything — nothing to save
  doc.plans.push(rec);
  doc.activePlan = rec.v;
  // only THIS version's draft is consumed — an edit waiting on another version is
  // still waiting, and saving one must not throw the other away
  delete doc.planDrafts[String(base.v)];
  return rec.v;
}

/** Throw away the hand edit ON THE VERSION ON SCREEN and go back to it as filed.
 *  Drafts on other versions are untouched — 放弃 means 「放弃我正在看的这一版的修改」. */
export function discardPlanDraft(doc) {
  const base = planEditBase(doc);
  if (!base || !planDraftFor(doc, base.v)) return false;
  delete doc.planDrafts[String(base.v)];
  return true;
}

export function activePlan(doc) {
  return doc.plans.find((x) => x.v === doc.activePlan) || null;
}

export function confirmedPlan(doc) {
  return doc.plans.find((x) => x.v === doc.confirmedPlan) || null;
}

export function setIdea(doc, text) {
  doc.idea = String(text ?? "");
}

/** Start an AI development run. kind: "outline" (idea/current outline +
 *  instruction → outline proposal) | "plan" (approved outline → episode-plan
 *  proposal). Returns a call id (0 = refused: one already running, or an
 *  un-reviewed proposal is pending; a plan additionally requires an APPROVED
 *  outline). A `failed` pending may be replaced by a retry. */
export function beginDevelop(doc, kind, instruction) {
  const st = doc.pending && doc.pending.status;
  if (st === "generating" || st === "proposed") return 0;
  if (kind === "plan" && !approvedOutline(doc)) return 0;
  const id = ++doc._seq;
  const brief = activeBrief(doc);
  doc.pending = {
    id,
    kind, // "outline" | "plan"
    status: "generating",
    instruction: String(instruction || ""),
    basedOn: kind === "outline" ? doc.active || null : doc.activePlan || null,
    // captured at LAUNCH, like outlineVersionId below: committing another brief
    // revision mid-review must not re-attribute this run
    briefVersionId: kind === "outline" ? (brief ? brief.id : null) : null,
    // plan provenance is captured at LAUNCH — the outline the generation
    // actually ran from, not whatever is approved when the proposal is
    // applied (approving another version mid-review must not re-attribute it)
    outlineVersionId: kind === "plan" ? (approvedOutline(doc) || {}).id ?? null : null,
  };
  return id;
}

/** Land a finished development run as a PROPOSAL awaiting apply/discard. */
export function completeDevelop(doc, id, payload) {
  const p = doc.pending;
  if (!p || p.id !== id || p.status !== "generating") return false; // stale/cancelled
  // A PROPOSAL never carries episode identities: episodeId is stamped ONLY at
  // confirm time by the caller. Agent output smuggling an existing episodeId
  // must not be able to silently link/rename that episode on confirmation.
  const proposal = p.kind === "plan"
    ? sanitizePlanEpisodes(payload).map((e) => ({ ...e, episodeId: null }))
    : sanitizeOutline(payload);
  if (p.kind === "plan" && !proposal.length) {
    doc.pending = { ...p, status: "failed", error: "规划提案为空（没有可用的分集）" };
    return true;
  }
  doc.pending = { ...p, status: "proposed", proposal };
  return true;
}

export function failDevelop(doc, id, message) {
  const p = doc.pending;
  if (!p || p.id !== id || p.status !== "generating") return false;
  doc.pending = { ...p, status: "failed", error: String(message || "生成失败") };
  return true;
}

export function cancelDevelop(doc) {
  doc.pending = null;
}

/** Apply the pending proposal as the next immutable version of its chain.
 *  Every earlier version stays; approval/confirmation pointers do NOT move —
 *  a new outline version must be explicitly re-approved. */
export function applyProposal(doc) {
  const p = doc.pending;
  if (!p || p.status !== "proposed") return null;
  let rec;
  if (p.kind === "plan") {
    rec = {
      id: mintId("plan"),
      v: doc.plans.length + 1,
      episodes: p.proposal,
      origin: "proposed",
      instruction: p.instruction,
      outlineVersionId: p.outlineVersionId ?? null, // captured at launch
    };
    doc.plans.push(rec);
    doc.activePlan = rec.v;
  } else {
    rec = {
      id: mintId("so"),
      v: doc.versions.length + 1,
      outline: p.proposal,
      origin: doc.versions.length ? "revision" : "developed",
      instruction: p.instruction,
      basedOn: p.basedOn,
      briefVersionId: p.briefVersionId ?? null, // captured at launch
    };
    doc.versions.push(rec);
    doc.active = rec.v;
  }
  doc.pending = null;
  return rec;
}

export function discardProposal(doc) {
  if (doc.pending && doc.pending.status === "proposed") doc.pending = null;
}

/** Manual outline edit → a NEW immutable version (origin "manual"). */
export function applyManualOutline(doc, fields) {
  const base = activeOutline(doc);
  const merged = sanitizeOutline({ ...(base ? base.outline : {}), ...(isObj(fields) ? fields : {}) });
  const brief = activeBrief(doc);
  const rec = {
    id: mintId("so"),
    v: doc.versions.length + 1,
    outline: merged,
    origin: "manual",
    instruction: "",
    basedOn: doc.active || null,
    briefVersionId: brief ? brief.id : null,
  };
  doc.versions.push(rec);
  doc.active = rec.v;
  return rec;
}

export function setActiveOutline(doc, v) {
  if (!doc.versions.some((x) => x.v === v)) return false;
  doc.active = v;
  return true;
}

/** Approve an outline version — the durable gate the episode plan keys off. */
export function approveOutline(doc, v) {
  if (!doc.versions.some((x) => x.v === v)) return false;
  doc.approved = v;
  return true;
}

export function setActivePlan(doc, v) {
  if (!doc.plans.some((x) => x.v === v)) return false;
  doc.activePlan = v;
  return true;
}

/** Confirm a plan version — the durable gate before episode scripts. The
 *  CALLER instantiates/links Episode entities and stamps each entry's
 *  episodeId BEFORE confirming (identity is explicit, never re-derived). */
export function confirmPlan(doc, v) {
  if (!doc.plans.some((x) => x.v === v)) return false;
  doc.confirmedPlan = v;
  return true;
}

/** The outline a plan was BUILT from (its launch-time provenance link), with
 *  an honest fallback to the currently approved outline when the linked
 *  version is unavailable. Episode-script context must never mix a newer
 *  approved outline with an older confirmed plan. */
/** The Creative Brief revision an OUTLINE version was developed from, or null.
 *  Display-only ("Based on Creative Brief v2"); an outline predating the brief
 *  chain honestly resolves to null rather than borrowing today's revision. */
export function briefForOutline(doc, outline) {
  if (!outline || !outline.briefVersionId) return null;
  return doc.brief.versions.find((x) => x.id === outline.briefVersionId) || null;
}

export function outlineForPlan(doc, plan) {
  if (plan && plan.outlineVersionId) {
    const src = doc.versions.find((x) => x.id === plan.outlineVersionId);
    if (src) return src;
  }
  return approvedOutline(doc);
}

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
// THE PRODUCT OWNER'S SEVEN (TASK-088 §2.1, 2026-08-17). `coreGoal` and
// `emotionArc` join the string facets; `keyEvents` / `reveals` / `characterBeats`
// are lists and live in the two lists below, because they cannot be compared or
// coerced like a string.
//
// NOTHING WAS REMOVED. `synopsis` and `purpose` are what the seven REPLACE for
// new content, but four plan versions of the real project are written in them and
// two downstream readers (the script brief, the shot context) read them — so they
// stay, optional, and the readers prefer the new field and fall back to the old
// one. Deleting a field that is in use is the defect TASK-089 §2.2 names.
export const PLAN_FIELDS = [
  "title", "synopsis", "purpose", "hook", "endingBeat", "duration",
  "coreGoal", "emotionArc",
];
/** Plan facets that are lists OF STRINGS: 主要剧情 / 信息揭示. */
export const PLAN_LIST_FIELDS = ["keyEvents", "reveals"];
/** 角色推进 — a list of `{who, change, relationChange?}`. Its own shape, because
 *  `who` has to be an existing character and the other two are free text. */
export const PLAN_BEAT_KEYS = ["who", "change", "relationChange"];

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

/** One 角色推进 row, normalized. A row without both `who` and `change` says
 *  nothing ("someone changed" / "X did something"), so it is dropped rather than
 *  kept as half a record. */
function sanitizeBeat(b) {
  if (!isObj(b)) return null;
  const who = str(b.who).trim();
  const change = str(b.change).trim();
  if (!who || !change) return null;
  const out = { who, change };
  const rel = str(b.relationChange).trim();
  if (rel) out.relationChange = rel;
  return out;
}

/** Normalize a plan's episode entries: dense epNumber, string facets, the three
 *  list facets, episodeId carried verbatim when present (stamped at confirm
 *  time). */
export function sanitizePlanEpisodes(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!isObj(e)) continue;
    const entry = { ...e, epNumber: out.length + 1 }; // unknown fields survive
    for (const k of PLAN_FIELDS) entry[k] = str(e[k]);
    if (!entry.title.trim()) continue; // an episode needs at least a title
    // THE LIST FACETS ARE SANITIZED, NOT PASSED THROUGH. `{...e}` let unknown
    // fields survive the round-trip, which is right for provenance — but these
    // three now come from a MODEL ANSWER and land in studio/canvas.json, so an
    // arbitrary nested structure must not reach the document under a key the
    // renderer will iterate (TASK-094 批次 A).
    for (const k of PLAN_LIST_FIELDS) entry[k] = strList(e[k]);
    entry.characterBeats = (Array.isArray(e.characterBeats) ? e.characterBeats : [])
      .map(sanitizeBeat)
      .filter(Boolean);
    entry.episodeId = typeof e.episodeId === "string" && e.episodeId ? e.episodeId : null;
    out.push(entry);
  }
  return out;
}

/**
 * The DRAFT's own hydration — blank rows survive.
 *
 * A draft is work in progress: 「＋ 添加一条」 appends an EMPTY row for the creator
 * to type into, and it is persisted the moment it appears (a refresh mid-sentence
 * must not lose anything). Running the strict sanitizer over a draft therefore
 * did two bad things (codex review, 批次 A round 1, blocking):
 *
 *   1. an added row that had not been typed into yet VANISHED on reload;
 *   2. worse, dropping a blank row RENUMBERED the ones after it — and every list
 *      op addresses items BY INDEX, so the next keystroke would land on a
 *      different item than the one on screen.
 *
 * Versions keep the strict rule (`savePlanDraft` runs `sanitizePlanEpisodes`), so
 * a blank row can never become part of a plan VERSION. It only survives as the
 * draft it is.
 */
export function sanitizePlanDraft(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!isObj(e)) continue;
    const entry = { ...e, epNumber: out.length + 1 };
    for (const k of PLAN_FIELDS) entry[k] = str(e[k]);
    if (!entry.title.trim()) continue; // an episode still needs a title
    // the ITEMS are kept verbatim (blank included); only their TYPE is enforced,
    // so nothing but a string can reach a text control
    for (const k of PLAN_LIST_FIELDS) {
      entry[k] = (Array.isArray(e[k]) ? e[k] : []).filter((s) => typeof s === "string");
    }
    entry.characterBeats = (Array.isArray(e.characterBeats) ? e.characterBeats : [])
      .filter(isObj)
      .map((b) => {
        const row = { who: str(b.who), change: str(b.change) };
        if (typeof b.relationChange === "string") row.relationChange = b.relationChange;
        return row;
      });
    entry.episodeId = typeof e.episodeId === "string" && e.episodeId ? e.episodeId : null;
    out.push(entry);
  }
  return out;
}

/** A deep-enough copy of one entry for the unversioned draft.
 *
 *  `{...e}` was enough while every facet was a string; the list facets made it
 *  DANGEROUS — a shallow copy shares the arrays with the immutable plan version,
 *  so typing in a draft's 主要剧情 would edit the confirmed version in place, and
 *  every Episode's 「Based on 规划 vN」 chip would then point at content that had
 *  been silently replaced (the exact reason drafts exist — see the MANUAL plan
 *  editing note below). */
function clonePlanEntry(e) {
  const copy = { ...e };
  for (const k of PLAN_LIST_FIELDS) copy[k] = [...(Array.isArray(e[k]) ? e[k] : [])];
  copy.characterBeats = (Array.isArray(e.characterBeats) ? e.characterBeats : []).map((b) => ({ ...b }));
  return copy;
}

/** The plan as the MODEL should see it: the creative facets, and nothing else.
 *
 *  `episodeId` is deliberately stripped. The model has no use for an internal
 *  identity, and not sending it is what keeps 「the answer cannot name an
 *  episode」 true at the transport as well as in `completeDevelop` — identity is
 *  re-derived from the document (ADR-0072 决策 1), never read back out of an
 *  answer. Unknown round-tripped fields are dropped too: they bound the payload
 *  and mean nothing to the capability. */
export function planForPrompt(entries) {
  return (Array.isArray(entries) ? entries : []).map((e) => {
    const out = { epNumber: e.epNumber };
    for (const k of PLAN_FIELDS) if (str(e[k]).trim()) out[k] = e[k];
    for (const k of PLAN_LIST_FIELDS) {
      const list = strList(e[k]);
      if (list.length) out[k] = list;
    }
    const beats = (Array.isArray(e.characterBeats) ? e.characterBeats : [])
      .map(sanitizeBeat)
      .filter(Boolean);
    if (beats.length) out.characterBeats = beats;
    return out;
  });
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
      // WHICH version this one was revised from. A manual save has always
      // recorded it; a proposed one does too since TASK-094 批次 A, because that
      // link is what carried the episode identities forward (ADR-0072 决策 1) and
      // a plan whose parent is unknown cannot be explained afterwards. Honestly
      // null for versions written before it existed — never back-derived from
      // `v - 1`, which would invent a provenance chain.
      basedOn: Number.isInteger(x.basedOn) ? x.basedOn : null,
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
      const eps = sanitizePlanDraft(saveDrafts[k]);
      if (eps.length) doc.planDrafts[String(v)] = eps;
    }
  } else if (isObj(saved.planDraft) && pOk(saved.planDraft.basedOn)) {
    // a document written by the FIRST shape of this feature (one draft, keyed by
    // `basedOn`). Migrated rather than dropped — it is the creator's unsaved work.
    const eps = sanitizePlanDraft(saved.planDraft.episodes);
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

/** Do two plan entries differ in ANY facet a creator can edit?
 *
 *  EVERY facet, not just the string ones (TASK-094 批次 A). While this compared
 *  `PLAN_FIELDS` alone, editing 主要剧情 or 角色推进 left `planDirty` false — so
 *  「已手工修改」 never appeared, 「保存为新版本」 stayed disabled, and the edit was
 *  only ever a draft the creator could not turn into a version. */
function entryDiffers(a, b) {
  if (PLAN_FIELDS.some((k) => str(a[k]) !== str(b[k]))) return true;
  for (const k of PLAN_LIST_FIELDS) {
    const x = strList(a[k]);
    const y = strList(b[k]);
    if (x.length !== y.length || x.some((v, i) => v !== y[i])) return true;
  }
  // BY CONTENT, so a row the creator merely OPENED is not an edit yet. Comparing
  // raw arrays reported 「已手工修改」 the instant 「＋ 添加一条」 appended a blank row,
  // and 「保存为新版本」 then refused it (the strict sanitizer drops blanks, so the
  // saved version would have been identical) — a dirty flag the creator could not
  // clear. `strList` above already ignores blank items for the same reason.
  const meaningful = (list) => (Array.isArray(list) ? list : []).map(sanitizeBeat).filter(Boolean);
  const p = meaningful(a.characterBeats);
  const q = meaningful(b.characterBeats);
  if (p.length !== q.length) return true;
  return p.some((beat, i) => PLAN_BEAT_KEYS.some((k) => str(beat[k]) !== str(q[i][k])));
}

export function planDirty(doc) {
  const base = planEditBase(doc);
  if (!base) return false;
  const a = planDraftFor(doc, base.v);
  if (!a) return false;
  const b = base.episodes;
  if (a.length !== b.length) return true;
  return a.some((e, i) => entryDiffers(e, b[i]));
}

/** Does this version's stored draft actually DIFFER from it? */
function draftDiffers(doc, v) {
  const base = doc.plans.find((x) => x.v === v) || null;
  const a = planDraftFor(doc, v);
  if (!base || !a) return false;
  if (a.length !== base.episodes.length) return true;
  return a.some((e, i) => entryDiffers(e, base.episodes[i]));
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
  const entry = draftEntry(doc, episodeId);
  if (!entry) return false;
  entry[field] = str(value);
  return true;
}

/**
 * The draft row for one episode, seeding this version's draft on first touch.
 *
 * Shared by every plan edit op so 「先校验、再建草稿」 is stated once: validating
 * after seeding would leave a draft behind for an edit that was refused, i.e.
 * state created by an operation that reported failure.
 */
function draftEntry(doc, episodeId) {
  if (typeof episodeId !== "string" || !episodeId) return null;
  const base = planEditBase(doc);
  if (!base) return null;
  if (!base.episodes.some((e) => e.episodeId === episodeId)) return null;
  if (!doc.planDrafts) doc.planDrafts = {};
  const key = String(base.v);
  if (!Array.isArray(doc.planDrafts[key])) {
    // seed THIS VERSION's draft from it, deep enough that editing cannot mutate
    // the immutable version it came from. Other versions' drafts are untouched.
    doc.planDrafts[key] = base.episodes.map(clonePlanEntry);
  }
  return doc.planDrafts[key].find((e) => e.episodeId === episodeId) || null;
}

/** The list living under `field` on one draft row, or null when that is not a
 *  list facet / not an editable episode. */
function draftList(doc, episodeId, field) {
  const entry = draftEntry(doc, episodeId);
  if (!entry) return null;
  if (field === "characterBeats") {
    if (!Array.isArray(entry.characterBeats)) entry.characterBeats = [];
    return entry.characterBeats;
  }
  if (!PLAN_LIST_FIELDS.includes(field)) return null;
  if (!Array.isArray(entry[field])) entry[field] = [];
  return entry[field];
}

/**
 * Type one item of a STRING list facet (主要剧情 / 信息揭示).
 *
 * Addressed by index WITHIN the addressed episode, and refused when the index
 * does not exist — appending through an out-of-range write would let a stale
 * render (an item another action removed) silently recreate it.
 */
export function editPlanItem(doc, episodeId, field, index, value) {
  if (!PLAN_LIST_FIELDS.includes(field)) return false;
  const list = draftList(doc, episodeId, field);
  if (!list || !Number.isInteger(index) || index < 0 || index >= list.length) return false;
  list[index] = str(value);
  return true;
}

/** Append an EMPTY item and return its index (-1 = refused).
 *
 *  Empty on purpose: the creator asked for a row to type in, and the caller
 *  marks it 「opened」 so `reviewface`'s blank-row filter renders it. Nothing is
 *  invented on their behalf. */
export function addPlanItem(doc, episodeId, field) {
  const list = draftList(doc, episodeId, field);
  if (!list) return -1;
  list.push(field === "characterBeats" ? { who: "", change: "" } : "");
  return list.length - 1;
}

/** Remove one item of a list facet. */
export function removePlanItem(doc, episodeId, field, index) {
  const list = draftList(doc, episodeId, field);
  if (!list || !Number.isInteger(index) || index < 0 || index >= list.length) return false;
  list.splice(index, 1);
  return true;
}

/** Type one field of one 角色推进 row. `who` is a character NAME here (that is
 *  what the capability answers with); the surface flags a name that matches no
 *  character rather than dropping it — silently discarding the model's answer is
 *  how a creator ends up believing nothing was produced. */
export function editPlanBeat(doc, episodeId, index, key, value) {
  if (!PLAN_BEAT_KEYS.includes(key)) return false;
  const list = draftList(doc, episodeId, "characterBeats");
  if (!list || !Number.isInteger(index) || index < 0 || index >= list.length) return false;
  if (!isObj(list[index])) return false;
  list[index][key] = str(value);
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

/**
 * IS THIS PLAN RUN A REVISION, AND OF WHAT? Decided ONCE, here.
 *
 * 「用 AI 改这一版」 = a revision request against the plan on screen. 「🪄 重新规划」 =
 * write a fresh one from the outline. The two mean opposite things for episode
 * IDENTITY, so the answer must not be derived twice:
 *
 *   revision  → the new version continues these episodes (ADR-0072 决策 1)
 *   fresh     → it is a different plan; its episodes are new
 *
 * Deriving it separately per layer is what went wrong: the backend selected the
 * writer/reviser package from (current plan + instruction) while the document
 * carried identity from `activePlan` alone — so a deliberately fresh replan
 * inherited the old identities and confirming it would have silently retitled the
 * existing episodes, leaving each script under a plan entry it was not written
 * for (codex review, 批次 A round 2, blocking). Same predicate, one place, and the
 * caller sends the model the base this returns.
 *
 * Returns the base plan version, or null.
 */
export function planRevisionBase(doc, instruction) {
  const steer = typeof instruction === "string" ? instruction.trim() : "";
  if (!steer) return null;
  const base = planEditBase(doc);
  return base && base.episodes.length ? base : null;
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
    // For a PLAN this is the version being revised — null when the creator asked
    // for a fresh one, because identity carry-over reads it (`planRevisionBase`).
    basedOn:
      kind === "outline"
        ? doc.active || null
        : (planRevisionBase(doc, instruction) || {}).v ?? null,
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

/**
 * A plan answer → proposal entries, each remembering WHICH episode it claims to be.
 *
 * Sanitized ONE AT A TIME so the claim can travel with the entry that survives:
 * `sanitizePlanEpisodes` drops a titleless entry, so the payload's indices and the
 * result's indices do not line up, and a claim matched back by position would be
 * matched to the wrong entry — the very defect this exists to close.
 */
function planProposalEntries(payload) {
  const out = [];
  for (const item of Array.isArray(payload) ? payload : []) {
    const [clean] = sanitizePlanEpisodes([item]);
    if (!clean) continue;
    const claimed = isObj(item) ? item.epNumber : null;
    out.push({
      ...clean,
      // densified across the SURVIVORS, which is what the document requires
      epNumber: out.length + 1,
      episodeId: null,
      claimedEpNumber:
        Number.isInteger(claimed) && claimed > 0 && !Number.isNaN(claimed) ? claimed : null,
    });
  }
  return out;
}

/** Land a finished development run as a PROPOSAL awaiting apply/discard. */
export function completeDevelop(doc, id, payload) {
  const p = doc.pending;
  if (!p || p.id !== id || p.status !== "generating") return false; // stale/cancelled
  // A PROPOSAL never carries episode identities: episodeId is stamped ONLY at
  // confirm time by the caller. Agent output smuggling an existing episodeId
  // must not be able to silently link/rename that episode on confirmation.
  //
  // WHICH EPISODE THE ANSWER SAYS EACH ENTRY IS, kept beside it (`claimedEpNumber`).
  // `sanitizePlanEpisodes` DENSIFIES `epNumber` to the array position, so matching
  // on it after sanitizing is matching on POSITION — and a reviser that returns
  // the same 12 episodes in a different order would then hand EP01's identity to
  // EP02's content, i.e. attach an existing script to the wrong episode (codex
  // review, 批次 A round 1, blocking).
  //
  // It lives on the TRANSIENT pending only (`serialize` drops it and
  // `carryEpisodeIdentity` strips it), so it never reaches the document: it is a
  // claim being checked, not a fact being stored.
  const proposal = p.kind === "plan"
    ? planProposalEntries(payload)
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

/**
 * Give a revised plan the SAME episode identities as the version it revises
 * (ADR-0072 决策 1).
 *
 * THE 48-EPISODE DEFECT. Every proposal arrives with `episodeId: null` (see
 * `completeDevelop`), so `confirmPlan` created 12 fresh Episode entities for each
 * confirmed version: 4 versions × 12 = the 48 the product owner found in a
 * project whose target is 24. His rule — 「A『确认规划』时，已经存在的剧集该被
 * 更新」 — needs the identities to survive the revision.
 *
 * THE IDENTITY COMES FROM THE DOCUMENT, NEVER FROM THE ANSWER. `basedOn` is the
 * plan version recorded when the run was LAUNCHED, and the ids are read out of
 * `doc.plans`. `completeDevelop` still strips every id the model sent, so the
 * security property it was written for is untouched: a model answer cannot name,
 * link or rename an episode.
 *
 * BY THE ANSWER'S OWN `epNumber` — NOT by array position. The reviser is told to
 * keep every episode's number, and `sanitizePlanEpisodes` densifies `epNumber` to
 * the array position, so the stored number cannot be the join key: an answer
 * returning the same 12 episodes in a different order would hand EP01's identity
 * to EP02's content and confirmation would attach an existing script to the wrong
 * episode (codex review, 批次 A round 1, blocking).
 *
 * IF THE CLAIMS DO NOT FORM A CLEAN MAPPING, NOTHING IS CARRIED. A missing,
 * duplicated or unmatched number means we cannot tell which base episode an entry
 * continues — and the two possible mistakes are not symmetric:
 *
 *   linking the WRONG episode  →  a script silently belongs to another episode.
 *                                 Irreversible in practice: nobody can tell.
 *   linking NOTHING            →  a few new episodes get created. Visible, and
 *                                 archivable (ADR-0072 决策 4).
 *
 * So an unclear answer degrades to 「these are new episodes」, all-or-nothing:
 * a partially carried plan would be the worst of both — some rows continued, some
 * duplicated, with nothing saying which.
 *
 * A revision that adds episodes leaves the new ones unlinked (they are genuinely
 * new); one that drops episodes leaves those entities alone — they may already
 * carry scripts, and deleting them would be irreversible (AGENTS.md 第 13 条).
 */
function carryEpisodeIdentity(doc, proposal, basedOnV) {
  const strip = (e) => {
    const { claimedEpNumber, ...rest } = e; // never reaches the document
    return { ...rest, episodeId: null };
  };
  const base = Number.isInteger(basedOnV)
    ? doc.plans.find((x) => x.v === basedOnV) || null
    : null;
  if (!base) return proposal.map(strip);

  const claims = proposal.map((e) => e.claimedEpNumber);
  const clean =
    claims.every((n) => Number.isInteger(n) && n > 0) &&
    new Set(claims).size === claims.length;
  if (!clean) return proposal.map(strip);

  const byNumber = new Map();
  for (const b of base.episodes) {
    // a base with duplicate numbers (hand-edited document) is not a mapping we
    // can trust either — first wins, and the duplicate claim below finds nothing
    if (!byNumber.has(b.epNumber)) byNumber.set(b.epNumber, b.episodeId || null);
  }
  const taken = new Set();
  const linked = proposal.map((e) => {
    const id = byNumber.get(e.claimedEpNumber) || null;
    // ONE ENTITY PER ENTRY. Two entries sharing an episodeId would fight over the
    // title on every confirmation and share one script — `canvasschema` rejects
    // such a document outright.
    if (!id || taken.has(id)) return strip(e);
    taken.add(id);
    const { claimedEpNumber, ...rest } = e;
    return { ...rest, episodeId: id };
  });
  return linked;
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
      episodes: carryEpisodeIdentity(doc, p.proposal, p.basedOn),
      origin: "proposed",
      instruction: p.instruction,
      outlineVersionId: p.outlineVersionId ?? null, // captured at launch
      // WHICH version this one was revised from. A manual save already records
      // its parent; a proposed version recorded only its instruction, so
      // 「这一版是从哪一版改出来的」 had no answer — and that answer is now
      // load-bearing, because it is what `carryEpisodeIdentity` matched against.
      basedOn: p.basedOn ?? null,
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

// SUBTITLE track (ADR-0061 决策 6 / TASK-064 Phase 3 §44–§45) — a real track,
// automatic by default.
//
// THE ORDERING THAT MATTERS (§44). A subtitle editor that opens empty and asks
// the creator to type every line is not a feature, it is data entry. So:
//
//   A. dialogue text + shot timing exist  →  cues are GENERATED (this module)
//   B. text exists, timing is unreliable  →  a local alignment adapter
//   C. only audio/video exist             →  a local ASR adapter
//
// Case A is implemented and is the one that actually covers this project's data:
// every speaking shot carries its line, and the episode timeline knows where that
// shot starts and how long it runs. Cases B and C are declared as ADAPTER POINTS
// with an honest `unavailable` state (`ADAPTERS`), because a fake ASR that
// silently returns the dialogue it was already given would make 「已转写」 true of
// something nobody transcribed — see §45 「如果本轮没有真实 ASR：不要 fake」.
//
// A CUE IS NOT A DIALOGUE LINE. It carries its own text, timing and speaker, and
// once generated it is INDEPENDENT: editing a cue does not rewrite the shot's
// dialogue, and re-generating does not discard an edited cue (`origin: "manual"`
// and Lock both protect it). The shot's line stays the script's; the cue is the
// subtitle's.
//
// Pure state + transitions — no fetch, no DOM, no clock (the caller passes `at`),
// no audio processing, no ASR.

import { mintId } from "./identity.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const strOrNull = (x) => (typeof x === "string" && x ? x : null);
const int = (x, d = 0) => (Number.isFinite(x) ? Math.round(x) : d);

/** Where a cue's text came from. `asr` and `alignment` exist so a future adapter
 *  has a truthful origin to write; nothing in this build produces them. */
export const CUE_ORIGINS = ["dialogue", "manual", "asr", "alignment", "skill"];
const ORIGIN_SET = new Set(CUE_ORIGINS);

export const CUE_ORIGIN_LABEL = {
  dialogue: "由台词自动生成",
  manual: "手工编辑",
  asr: "语音识别",
  alignment: "对齐校正",
  skill: "来自 Skill 提案",
};

/** The transcription/alignment ADAPTER POINTS. Real, named, and honestly
 *  unavailable — the console renders these verbatim rather than hiding the
 *  buttons, so 「为什么不能从音频生成字幕」 has an answer in the UI.
 *
 *  `available: false` is a fact about this build, not a licence to fake it. */
export const ADAPTERS = [
  {
    id: "dialogue",
    label: "台词 → 字幕",
    available: true,
    detail: "用镜头台词与本集时间线上的镜头时长生成 cue。文字来自剧本，时间来自剪辑，两者都是真实记录。",
  },
  {
    id: "alignment",
    label: "本地对齐（文本已有，时间不准）",
    available: false,
    detail: "适配点已留：需要一个本地强制对齐器（forced aligner）。本轮没有接入，所以不提供——" +
      "拿台词的时长按比例摊到音频上并称之为「已对齐」，是把猜测写成记录。",
  },
  {
    id: "asr",
    label: "本地语音识别（只有音频/视频）",
    available: false,
    detail: "适配点已留：需要一个本地 ASR。本轮没有接入。把已有的台词原样返回并标成「已转写」，" +
      "会让「转写」这个字段永远无法被信任。",
  },
];

/** Subtitle STYLE presets (§45). Presentation only — they carry no timing and no
 *  text, so switching one can never change what the subtitle says. */
export const STYLE_PRESETS = [
  { id: "default", label: "标准", detail: "居中底部，白字黑描边" },
  { id: "large", label: "大字", detail: "更大字号，适合竖屏/手机" },
  { id: "topbar", label: "顶部条", detail: "顶部单行，适合画面下方有信息时" },
  { id: "caption", label: "说明字幕", detail: "偏小，用于旁白/注释" },
];

const STYLE_SET = new Set(STYLE_PRESETS.map((p) => p.id));

/** The minimum a cue can be on screen. A 120 ms subtitle is unreadable, and a
 *  0 ms one is invisible — a split that produced one would look like it lost a
 *  line. Enforced in `split`, not silently in the sanitizer, so a persisted cue
 *  is never rewritten behind the creator's back. */
export const MIN_CUE_MS = 400;

function putKey(obj, key, val) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = val;
  }
  return obj;
}

/**
 * Normalize one persisted cue. Total; a cue with no usable timing is dropped
 * rather than placed at zero — a subtitle at the top of the episode that should
 * have been at 4:12 is worse than a missing one, because it looks deliberate.
 */
export function sanitizeCue(saved) {
  if (!isObj(saved)) return null;
  const startMs = Math.max(0, int(saved.startMs, -1));
  const endMs = int(saved.endMs, -1);
  if (startMs < 0 || endMs <= startMs) return null;
  const text = typeof saved.text === "string" ? saved.text : "";
  return {
    cueId: strOrNull(saved.cueId) || mintId("cue"),
    startMs,
    endMs,
    text,
    // WHO says it. Null is honest: a cue from an unattributed line has no
    // speaker, and printing the first character in the scene would be a guess.
    speaker: strOrNull(saved.speaker),
    // WHICH shot it belongs to, when it came from one. This is what lets a
    // regenerate replace 「this shot's auto cue」 without touching the rest.
    shotId: strOrNull(saved.shotId),
    origin: ORIGIN_SET.has(saved.origin) ? saved.origin : "manual",
    style: STYLE_SET.has(saved.style) ? saved.style : null, // null = the track's preset
    at: strOrNull(saved.at),
  };
}

function sanitizeTrack(saved) {
  const src = isObj(saved) ? saved : {};
  const cues = (Array.isArray(src.cues) ? src.cues : [])
    .map(sanitizeCue)
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return {
    cues,
    style: STYLE_SET.has(src.style) ? src.style : "default",
    // the track's own version counter — bumped on every generate, so the Final
    // Render's provenance can name WHICH subtitle version it shipped (§57)
    version: Number.isInteger(src.version) && src.version > 0 ? src.version : (cues.length ? 1 : 0),
    generatedAt: strOrNull(src.generatedAt),
    generatedFrom: strOrNull(src.generatedFrom), // an ADAPTERS id
  };
}

/** Hydrate the subtitles map (episodeId → track). */
export function createSubtitles(saved) {
  const out = Object.create(null);
  if (!isObj(saved)) return out;
  for (const epId of Object.keys(saved)) {
    if (!epId) continue;
    const t = sanitizeTrack(saved[epId]);
    if (t.cues.length || t.version) putKey(out, epId, t);
  }
  return out;
}

/** The episode's track, created empty on first access. */
export function trackFor(doc, episodeId) {
  if (!isObj(doc) || typeof episodeId !== "string" || !episodeId) return sanitizeTrack(null);
  if (!Object.prototype.hasOwnProperty.call(doc, episodeId)) {
    putKey(doc, episodeId, sanitizeTrack(null));
  }
  return doc[episodeId];
}

export function findCue(track, cueId) {
  return (isObj(track) ? track.cues : []).find((c) => c.cueId === cueId) || null;
}

/* -------------------------------------------------------------------------- */
/* Case A: dialogue → subtitle                                                */
/* -------------------------------------------------------------------------- */

/**
 * Split one line into readable cues.
 *
 * The line is broken at sentence punctuation, and each piece gets a share of the
 * available window PROPORTIONAL TO ITS LENGTH — the only honest distribution
 * available without alignment, and it is labelled `dialogue`, never `alignment`.
 * A single short line stays one cue.
 *
 * `maxChars` bounds a cue rather than the whole line: a 90-character sentence
 * with no punctuation is still split, because one unreadable cue is not a
 * subtitle.
 */
export function splitLine(text, { maxChars = 24 } = {}) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return [];
  // sentence-ish boundaries, CJK and Latin. The delimiter is KEPT with its
  // sentence: subtitles read wrong without their punctuation.
  const rough = raw.split(/(?<=[。！？!?；;…])/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const piece of rough.length ? rough : [raw]) {
    if (piece.length <= maxChars) { out.push(piece); continue; }
    // no punctuation to break on — break at commas, then hard-wrap
    const sub = piece.split(/(?<=[，,、])/).map((x) => x.trim()).filter(Boolean);
    for (const p of sub.length > 1 ? sub : [piece]) {
      if (p.length <= maxChars) { out.push(p); continue; }
      for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars));
    }
  }
  return out;
}

/**
 * Generate the episode's subtitle cues from dialogue (Case A).
 *
 * `rows` are the episode's shots IN CANONICAL ORDER, each
 * `{ shotId, startMs, endMs, dialogue, speaker }` — the caller resolves the
 * timing from the timeline (the picture is what the viewer sees, so the picture's
 * timing is what a subtitle must match).
 *
 * WHAT IT NEVER DOES:
 *   · invent a cue for a shot with no line;
 *   · touch a cue the creator EDITED (`origin: "manual"`) or LOCKED;
 *   · touch a cue belonging to a shot that is not in `rows` (a shot removed from
 *     the cut keeps its cue until the creator removes it — silently dropping it
 *     would delete an edit they may still want);
 *   · claim a transcription.
 *
 * `isLocked(cueId)` is the caller's lock predicate (workflow/locks.js).
 * Returns `{ added, kept, skipped }`.
 */
export function generateFromDialogue(track, rows, { at = null, isLocked = null, maxChars = 24 } = {}) {
  if (!isObj(track)) return { added: [], kept: [], skipped: [] };
  const locked = (id) => (typeof isLocked === "function" ? isLocked(id) === true : false);
  const protectedCue = (c) => c.origin === "manual" || locked(c.cueId);
  const rowShots = new Set(
    (Array.isArray(rows) ? rows : []).map((r) => (isObj(r) ? strOrNull(r.shotId) : null)).filter(Boolean),
  );
  const kept = [];
  const skipped = [];
  // keep every protected cue, and every cue whose shot this pass is not about
  const survivors = [];
  for (const c of track.cues) {
    if (protectedCue(c)) { survivors.push(c); kept.push(c); continue; }
    if (!c.shotId || !rowShots.has(c.shotId)) { survivors.push(c); kept.push(c); continue; }
    // an AUTO cue for a shot in this pass is replaced by it
  }
  const added = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isObj(r)) continue;
    const shotId = strOrNull(r.shotId);
    const line = String(r.dialogue == null ? "" : r.dialogue).trim();
    if (!shotId || !line) continue; // no line → no cue. Nothing is invented.
    if (track.cues.some((c) => c.shotId === shotId && protectedCue(c))) {
      skipped.push({ shotId, reason: "这个镜头已有手工编辑或锁定的字幕" });
      continue;
    }
    const startMs = Math.max(0, int(r.startMs, 0));
    const endMs = int(r.endMs, 0);
    if (endMs <= startMs) {
      skipped.push({ shotId, reason: "这个镜头在时间线上没有时长（还没有画面片段）" });
      continue;
    }
    let pieces = splitLine(line, { maxChars });
    const window = endMs - startMs;
    // HOW MANY cues this window can actually hold at a readable length. A shot
    // trimmed to 500 ms cannot carry four cues; splitting anyway produced
    // sub-MIN_CUE_MS flashes and then DROPPED the pieces that no longer fitted —
    // silent loss of the creator's own line. Fewer, longer cues instead, and the
    // whole line always survives.
    const capacity = Math.max(1, Math.floor(window / MIN_CUE_MS));
    if (pieces.length > capacity) {
      // regroup into `capacity` cues, keeping the pieces' order and every
      // character of the text
      const per = Math.ceil(pieces.length / capacity);
      const merged = [];
      for (let i = 0; i < pieces.length; i += per) merged.push(pieces.slice(i, i + per).join(""));
      pieces = merged;
    }
    const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
    let cursor = startMs;
    pieces.forEach((p, i) => {
      const remaining = pieces.length - i;
      // never take so much that the cues after this one cannot exist
      const maxShare = Math.max(0, endMs - cursor - (remaining - 1) * MIN_CUE_MS);
      const share = i === pieces.length - 1
        ? Math.max(0, endMs - cursor)
        : Math.min(maxShare, Math.max(MIN_CUE_MS, Math.round((p.length / total) * window)));
      const cueEnd = Math.min(endMs, cursor + share);
      if (cueEnd <= cursor) return; // no room left — a zero-length cue is not a cue
      added.push(sanitizeCue({
        cueId: mintId("cue"),
        startMs: cursor,
        endMs: cueEnd,
        text: p,
        speaker: strOrNull(r.speaker),
        shotId,
        origin: "dialogue",
        at,
      }));
      cursor = cueEnd;
    });
  }
  track.cues = [...survivors, ...added.filter(Boolean)].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (added.length) {
    track.version = (Number.isInteger(track.version) ? track.version : 0) + 1;
    track.generatedAt = strOrNull(at);
    track.generatedFrom = "dialogue";
  }
  return { added: added.filter(Boolean), kept, skipped };
}

/** What an unavailable adapter answers. Called instead of running one, so the
 *  refusal is a value the UI renders rather than a silent no-op. */
export function adapterUnavailable(id) {
  const a = ADAPTERS.find((x) => x.id === id) || null;
  if (!a) return { ok: false, error: `未知的字幕来源 ${id}` };
  if (a.available) return { ok: true };
  return { ok: false, unavailable: true, error: a.detail };
}

/* -------------------------------------------------------------------------- */
/* editing                                                                    */
/* -------------------------------------------------------------------------- */

/** Edit a cue's text / timing / speaker / style. `origin` becomes `manual` on
 *  any TEXT or TIMING change, because that is what protects it from the next
 *  auto-generate; changing only the style is presentation and does not.
 *
 *  `force` is the creator's own edit of a cue they locked. Automation never
 *  passes it. */
export function updateCue(track, cueId, fields, { at = null, force = false, isLocked = null, origin = null } = {}) {
  const c = findCue(track, cueId);
  if (!c || !isObj(fields)) return false;
  if (typeof isLocked === "function" && isLocked(cueId) === true && !force) return false;
  const next = { ...c };
  let substantive = false;
  if ("text" in fields) {
    const t = typeof fields.text === "string" ? fields.text : "";
    if (t !== c.text) substantive = true;
    next.text = t;
  }
  if ("startMs" in fields) { next.startMs = fields.startMs; substantive = true; }
  if ("endMs" in fields) { next.endMs = fields.endMs; substantive = true; }
  if ("speaker" in fields) { next.speaker = fields.speaker; substantive = true; }
  if ("style" in fields) next.style = fields.style;
  if (substantive) {
    next.origin = ORIGIN_SET.has(origin) ? origin : "manual";
    next.at = strOrNull(at) || c.at;
  }
  const clean = sanitizeCue(next);
  if (!clean) return false; // a refused edit changes NOTHING
  track.cues = track.cues.map((x) => (x.cueId === cueId ? clean : x))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return true;
}

/** Add a cue by hand. */
export function addCue(track, cue) {
  const c = sanitizeCue({ ...cue, cueId: mintId("cue"), origin: "manual" });
  if (!c || !isObj(track)) return null;
  track.cues = [...track.cues, c].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return c;
}

export function removeCue(track, cueId, { isLocked = null } = {}) {
  if (!isObj(track)) return false;
  if (typeof isLocked === "function" && isLocked(cueId) === true) return false;
  const before = track.cues.length;
  track.cues = track.cues.filter((c) => c.cueId !== cueId);
  return track.cues.length !== before;
}

/** MERGE a cue with the one after it: one cue spanning both windows, texts
 *  joined. Refused when either is locked, or when there is nothing after it. */
export function mergeCue(track, cueId, { at = null, isLocked = null } = {}) {
  if (!isObj(track)) return false;
  const i = track.cues.findIndex((c) => c.cueId === cueId);
  if (i < 0 || i + 1 >= track.cues.length) return false;
  const a = track.cues[i];
  const b = track.cues[i + 1];
  const lock = (id) => (typeof isLocked === "function" ? isLocked(id) === true : false);
  if (lock(a.cueId) || lock(b.cueId)) return false;
  const merged = sanitizeCue({
    ...a,
    endMs: Math.max(a.endMs, b.endMs),
    text: [a.text, b.text].filter((x) => x && x.trim()).join(""),
    // the merged cue keeps A's shot only when both came from the same one:
    // a cue spanning two shots belongs to neither, and claiming one would let a
    // regenerate of that shot delete a cue covering the other as well
    shotId: a.shotId && a.shotId === b.shotId ? a.shotId : null,
    speaker: a.speaker && a.speaker === b.speaker ? a.speaker : a.speaker || b.speaker,
    origin: "manual",
    at,
  });
  if (!merged) return false;
  track.cues = [...track.cues.slice(0, i), merged, ...track.cues.slice(i + 2)];
  return true;
}

/** SPLIT a cue at `atMs` (absolute). Both halves must clear MIN_CUE_MS, or the
 *  split is refused rather than producing an invisible cue.
 *
 *  `splitAtChar` divides the TEXT; absent, all text stays on the first half —
 *  which is honest (nothing guesses which word lands where) and one edit away
 *  from right. */
export function splitCue(track, cueId, atMs, { splitAtChar = null, at = null, isLocked = null } = {}) {
  if (!isObj(track)) return false;
  const c = findCue(track, cueId);
  if (!c) return false;
  if (typeof isLocked === "function" && isLocked(cueId) === true) return false;
  const mid = int(atMs, -1);
  if (mid - c.startMs < MIN_CUE_MS || c.endMs - mid < MIN_CUE_MS) return false;
  const cut = Number.isInteger(splitAtChar) && splitAtChar > 0 && splitAtChar < c.text.length
    ? splitAtChar
    : c.text.length;
  const first = sanitizeCue({ ...c, endMs: mid, text: c.text.slice(0, cut), origin: "manual", at });
  const second = sanitizeCue({
    ...c, cueId: mintId("cue"), startMs: mid, text: c.text.slice(cut), origin: "manual", at,
  });
  if (!first || !second) return false;
  const i = track.cues.findIndex((x) => x.cueId === cueId);
  track.cues = [...track.cues.slice(0, i), first, second, ...track.cues.slice(i + 1)];
  return true;
}

export function setStyle(track, style) {
  if (!isObj(track) || !STYLE_SET.has(style)) return false;
  track.style = style;
  return true;
}

/* -------------------------------------------------------------------------- */
/* read models + export                                                       */
/* -------------------------------------------------------------------------- */

/** Cues that OVERLAP each other — two subtitles on screen at once. Reported,
 *  never auto-nudged: moving one to fix it is a creative decision about which
 *  line yields, and the timing came from the cut. */
export function overlaps(track) {
  const out = [];
  const cs = isObj(track) ? track.cues : [];
  for (let i = 1; i < cs.length; i++) {
    if (cs[i].startMs < cs[i - 1].endMs) out.push([cs[i - 1].cueId, cs[i].cueId]);
  }
  return out;
}

const srtTime = (ms) => {
  const t = Math.max(0, Math.round(ms));
  const h = String(Math.floor(t / 3600000)).padStart(2, "0");
  const m = String(Math.floor((t % 3600000) / 60000)).padStart(2, "0");
  const s2 = String(Math.floor((t % 60000) / 1000)).padStart(2, "0");
  const msPart = String(t % 1000).padStart(3, "0");
  return `${h}:${m}:${s2},${msPart}`;
};

/** SRT text for the track. A real, portable deliverable — the picture is NOT
 *  burned this round (see the console's own note), and an SRT beside the MP4 is
 *  the honest form of 「字幕交付」 without pretending to a burn-in that did not
 *  happen. Speaker is prefixed only where one is recorded. */
export function toSRT(track) {
  const cs = (isObj(track) ? track.cues : []).filter((c) => c.text && c.text.trim());
  return cs
    .map((c, i) =>
      `${i + 1}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n` +
      `${c.speaker ? `${c.speaker}：` : ""}${c.text.trim()}\n`)
    .join("\n");
}

export function serialize(doc) {
  const out = {};
  if (!isObj(doc)) return out;
  for (const epId of Object.keys(doc)) {
    const t = doc[epId];
    if (!isObj(t)) continue;
    if (!Array.isArray(t.cues) || (!t.cues.length && !t.version)) continue;
    putKey(out, epId, {
      cues: t.cues.map((c) => ({
        cueId: c.cueId, startMs: c.startMs, endMs: c.endMs, text: c.text,
        speaker: c.speaker, shotId: c.shotId, origin: c.origin, style: c.style, at: c.at,
      })),
      style: t.style,
      version: t.version,
      generatedAt: t.generatedAt,
      generatedFrom: t.generatedFrom,
    });
  }
  return out;
}

// 哪一集真的是零内容空壳（ADR-0072 决策 5 / TASK-094 批次 G）。
//
// WHY A REFERENCE SCAN AND NOT A CHECKLIST. The plan table's blank is NOT evidence:
// 照见未明rev2 has 48 episodes and four 12-entry plan versions, and 「这一集在规划表上
// 是空的」 says nothing about whether a script, a timeline or a Run points at it. The
// obvious implementation — 「check scripts, check scenes, check assets」 — is a
// hand-written list, and a hand-written list MISSES one. That is this repository's
// most-repeated defect (TASK-087 §7: 不变量只覆盖了一半，另一半就在相邻那一层), and
// it was measured here: the audit of the real project found `timelines` entries for
// four episodes that no checklist in the task card mentioned.
//
// So the judgement is: does this `episodeId` appear ANYWHERE in the document other
// than the two places it is expected? Anything else counts as content and the
// episode is kept. The scan's error direction is deliberately conservative — it
// keeps an episode too many, never archives one too few.
//
// PURE. It takes the serialized canvas document (what `persist` writes) and returns
// a verdict per episode. No clock, no writes, no DOM.

// THE SCAN ITSELF NOW LIVES IN `refscan.js` (TASK-097 §2.6.1). It was written here
// and it earned its keep here, but this chain has five more 「谁还引用着它」 questions
// — 软删除 shot、新增 asset kind、QC 缺口、Keyframe 的输入、每个计数 — and each of
// them is one hand-written checklist away from the defect this scan caught. Lifted
// out unchanged; these tests are the proof it still behaves identically.
import { foreignReferences } from "./refscan.js";

/**
 * The two locations where an episodeId is EXPECTED, and which therefore prove
 * nothing about content:
 *
 *   `production.episodes[i].episodeId`        the episode being judged
 *   `story.plans[v].episodes[j].episodeId`    a plan entry's identity join
 *   `story.planDrafts.*`                      an unversioned copy of a plan entry
 *
 * Everything else — `scripts`, `timelines`, `shotAudio`, `subtitles`, `prompts`,
 * `refUse`, `frameBindings`, `generations`, `locks`, `reviews`, `skillRuns`,
 * `production.shotProduction`, and anything added later — counts. Listing what
 * counts would be the checklist this exists to avoid; listing what does NOT is a
 * closed set of three, and a new reference site is content BY DEFAULT.
 */
function isExpected(path) {
  return /^\$\.production\.episodes\[\d+\]\.episodeId$/.test(path)
    || /^\$\.story\.plans\[\d+\]\.episodes\[\d+\]\.episodeId$/.test(path)
    || /^\$\.story\.planDrafts\./.test(path)
    // the ACTIVE POINTER is a real reference, and it is checked separately and
    // unconditionally below — listing it here as well produced two blockers saying
    // the same thing (「是当前剧集」 + 「被引用于 $.production.activeEpisodeId」), and a
    // reason list the creator has to de-duplicate reads like two problems
    || path === "$.production.activeEpisodeId";
}

const BEAT_KINDS = ["plot", "world", "character", "relationship"];

/**
 * Per-episode verdict over the WHOLE document.
 *
 * @param doc the serialized canvas (`{ production, story, scripts, timelines, … }`)
 * @returns `[{ episodeId, title, index, archivable, blockers }]` in document order
 */
export function episodeCleanupReport(doc) {
  const prod = (doc && doc.production) || {};
  const story = (doc && doc.story) || {};
  const plans = Array.isArray(story.plans) ? story.plans : [];
  const confirmed = plans.find((p) => p && p.v === story.confirmedPlan) || null;
  const out = [];
  for (const [index, ep] of (Array.isArray(prod.episodes) ? prod.episodes : []).entries()) {
    const id = ep && ep.episodeId;
    if (typeof id !== "string" || !id) continue;
    const blockers = [];
    // 1. the one in hand
    if (prod.activeEpisodeId === id) blockers.push("是当前剧集");
    // 2. the plan the creator is actually working from
    if (confirmed && confirmed.episodes.some((e) => e && e.episodeId === id)) {
      blockers.push(`在已确认的规划 v${story.confirmedPlan} 里`);
    }
    // 3. its own content
    if ((ep.scenes || []).length) blockers.push(`${ep.scenes.length} 个场景`);
    const beats = ep.beats || {};
    const beatCount = BEAT_KINDS.reduce((n, k) => n + ((beats[k] || []).length), 0);
    if (beatCount) blockers.push(`${beatCount} 条推进记录`);
    if (ep.bgmAssetId) blockers.push("绑定了本集 BGM");
    // 4. ANY other reference, anywhere in the document
    const foreign = foreignReferences(doc, id, isExpected);
    if (foreign.length) blockers.push(`被引用于 ${foreign.join(" / ")}`);
    out.push({
      episodeId: id,
      title: typeof ep.title === "string" ? ep.title : "",
      index,
      alreadyArchived: !!(ep.archived && ep.archived.at),
      archivable: blockers.length === 0 && !(ep.archived && ep.archived.at),
      blockers,
    });
  }
  return out;
}

/** Just the ids that may be archived — what the UI offers and the domain applies. */
export function archivableEpisodes(doc) {
  return episodeCleanupReport(doc).filter((r) => r.archivable).map((r) => r.episodeId);
}

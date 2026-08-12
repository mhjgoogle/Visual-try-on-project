// Unified Production read model (checkpoint CP8 / ADR-0059) — the ONE place
// that reads the whole production at once:
//
//   Story/Canon · Episode · Scene/Shot · References · Skill runs & Proposals
//   · Generations · Assets · QC/review · Final
//
// WHY IT EXISTS: the AI Director used to assemble a different slice of the
// world in every module, so no two of its observations were built from the
// same picture, and none of them could say WHICH episode or shot they were
// looking at. An observation you cannot trace to its context is an opinion.
//
// So this model carries `context` — the real ids it read — alongside the data.
// Anything derived from it can be traced back to exactly the canon it saw.
//
// TWO RULES:
//
//   1. READ ONLY. It writes nothing, mints nothing, persists nothing. Every
//      field is recomputed from the canonical documents on each call.
//   2. IT DOES NOT COPY CANON. It carries ids and counts and the few resolved
//      labels a reader needs; the story itself stays in the story document
//      (ADR-0059 决策 5 / 要求 8). Copying it here would create the second,
//      drifting truth this whole checkpoint exists to prevent.
//
// Pure derivation — no fetch, no DOM, no clock, no writes.

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x) => (typeof x === "string" ? x : "");

/** The upstream surfaces an Episode is built on. Names match `canondoc`'s
 *  UPSTREAM_KEYS — this module reports the stamp, it never defines it. */
export const CANON_KEYS = ["brief", "outline", "characters", "relationships", "world"];

export const CANON_LABEL = {
  brief: "创意",
  outline: "故事大纲",
  characters: "人物",
  relationships: "人物关系",
  world: "世界观",
};

/**
 * The canon baseline an Episode was built on — its `basedOn` stamp, read as
 * ids and versions, never as content.
 *
 * Returns `null` when the episode carries no stamp: an episode created before
 * the baseline existed has no recorded baseline, and saying "it is based on
 * the current canon" would be an invention.
 */
export function canonBaselineOf(episode) {
  if (!isObj(episode) || !isObj(episode.basedOn)) return null;
  const items = [];
  for (const key of CANON_KEYS) {
    const v = episode.basedOn[key];
    // `0` is canondoc's "never stamped" — it is NOT version zero. An episode
    // that was never stamped against a surface has no baseline for it, and
    // printing 「大纲 v0」 would name a version that does not exist.
    if (!v) continue;
    // a version number for the versioned surfaces, a count for the collections
    items.push({ key, label: CANON_LABEL[key] || key, value: v });
  }
  return items.length ? { episodeId: episode.episodeId, items } : null;
}

/**
 * The whole production, as ids and counts.
 *
 * `sources` are the canonical documents, passed in rather than imported so
 * this stays a pure function over whatever the caller holds:
 *   { story, scripts, production, draftShots, assets, generations,
 *     skillRuns, timelines, finals }
 * `scope` narrows to one episode / scene / shot; anything omitted stays null.
 */
export function productionModel(sources = {}, scope = {}) {
  const prod = isObj(sources.production) ? sources.production : null;
  const draft = arr(sources.draftShots);
  const generations = arr(sources.generations);
  const skillRuns = arr(sources.skillRuns);

  const episodes = arr(prod ? prod.episodes : []);
  const wantEpisode = str(scope.episodeId) || (prod ? str(prod.activeEpisodeId) : "") || null;
  const episode = episodes.find((e) => e.episodeId === wantEpisode) || null;
  // …reported only once it RESOLVES. An id that names no episode would have the
  // Director cite one that does not exist.
  const episodeId = episode ? episode.episodeId : null;

  // --- scenes & shots of the scoped episode --------------------------------- //
  const allScenes = arr(episode ? episode.scenes : []).map((sc) => ({
    sceneId: sc.sceneId,
    title: str(sc.title),
    shotIds: arr(sc.shotIds),
    characterIds: arr(sc.characterRefs).map((r) => r && r.characterId).filter(Boolean),
    locationId: isObj(sc.locationRef) ? sc.locationRef.locationId || null : null,
  }));
  const ownedShotIds = new Set(allScenes.flatMap((s) => s.shotIds));

  // --- the context this model ACTUALLY READ --------------------------------- //
  // A requested id is only reported once it RESOLVES against the documents: a
  // stale selection, or one from another episode, would otherwise have the
  // Director cite evidence whose records it never opened. What does not resolve
  // is dropped, and the model is scoped by what remains — so the data and the
  // context it claims are always the same thing.
  const wantScene = str(scope.sceneId) || null;
  const wantShot = str(scope.shotId) || null;
  const scene = wantScene ? allScenes.find((s) => s.sceneId === wantScene) || null : null;
  const sceneId = scene ? scene.sceneId : null;
  // a shot must belong to the scoped scene when there is one, and to the
  // episode otherwise — the pair is checked together, never independently
  const shotId = wantShot && (scene ? scene.shotIds.includes(wantShot) : ownedShotIds.has(wantShot))
    ? wantShot
    : null;
  // EVERYTHING the model reports is within the context it claims. Narrowing to
  // a scene or a shot narrows the scenes, shots, QC and references too — a
  // judgment labelled 「这个镜头」 must not be built from the rest of the episode.
  const homeScene = scene || (shotId ? allScenes.find((s) => s.shotIds.includes(shotId)) || null : null);
  // …and the context REPORTS that scene. The UI narrows by shot alone, and the
  // model resolves its owning scene to do the narrowing — leaving it out of the
  // evidence would drop a context id the model demonstrably read, which is the
  // shot→scene step of the traceability this checkpoint exists for.
  const context = { episodeId: episodeId || null, sceneId: homeScene ? homeScene.sceneId : null, shotId };
  const scenes = homeScene ? [homeScene] : allScenes;
  const scopeShotIds = shotId
    ? new Set([shotId])
    : homeScene
      ? new Set(homeScene.shotIds)
      : ownedShotIds;

  const byShotId = new Map(draft.filter((s) => isObj(s) && s.shotId).map((s) => [s.shotId, s]));
  const shots = [...scopeShotIds].map((id) => {
    const raw = byShotId.get(id) || null;
    const scene = scenes.find((s) => s.shotIds.includes(id)) || null;
    return {
      shotId: id,
      title: raw ? str(raw.title) : "",
      sequence: raw ? raw.sequence : null,
      sceneId: scene ? scene.sceneId : null,
      // a scene can own a shot the current draft no longer holds — a real state
      dangling: !raw,
    };
  });

  // --- QC / review ----------------------------------------------------------- //
  // Read straight off the production document. The APPROVAL IS BOUND TO A TAKE
  // (ADR-0057), so this reports the reviewed assetId, never merely "approved".
  const reviews = isObj(prod) && isObj(prod.shotProduction) && isObj(prod.shotProduction.reviews)
    ? prod.shotProduction.reviews
    : {};
  const qc = shots.map((s) => {
    const r = reviews[s.shotId];
    return {
      shotId: s.shotId,
      approved: isObj(r),
      // WHICH take was approved — the whole point of ADR-0057
      approvedAssetId: isObj(r) ? str(r.assetId) || null : null,
      at: isObj(r) ? str(r.at) || null : null,
      note: isObj(r) ? str(r.note) : "",
    };
  });

  // --- shared References the scoped episode's shots bind --------------------- //
  const bindings = isObj(prod) && isObj(prod.shotProduction) && isObj(prod.shotProduction.references)
    ? prod.shotProduction.references
    : {};
  const referenceKeys = [...new Set(shots.flatMap((s) => arr(bindings[s.shotId])))];

  // --- generations & skill runs, scoped ------------------------------------- //
  // Narrowing has to narrow. A scene-scoped model that returned every shot's
  // generations, or a shot-scoped one that swept in the episode's targetless
  // renders, would let an observation about ONE scene be built from history
  // that belongs elsewhere.
  const scopedGenerations = generations.filter((g) => {
    if (!isObj(g)) return false;
    // a targetless generation (an episode render) belongs to the EPISODE, so it
    // is in scope only when nothing narrower was asked for
    if (!g.targetId) return !sceneId && !shotId && episodeOf(g) === episodeId;
    return scopeShotIds.has(g.targetId);
  });
  const scopedRuns = skillRuns.filter((r) => isObj(r) && runInScope(r, { episodeId, sceneId, shotId }));

  // --- final -------------------------------------------------------------- //
  // The registry keeps finals under `assets.finals`; accepting a top-level
  // `finals` too would let a caller pass the same list twice and have the two
  // disagree. One source, with the registry's own location preferred.
  const finals = arr(sources.finals).length
    ? arr(sources.finals)
    : arr(isObj(sources.assets) ? sources.assets.finals : null);
  const timelines = isObj(sources.timelines) ? sources.timelines : {};
  const timeline = episodeId && isObj(timelines[episodeId]) ? timelines[episodeId] : null;

  return {
    context,
    // Story/Canon: the BASELINE, not the story
    canon: canonBaselineOf(episode),
    story: storyStanding(sources.story),
    episode: episode
      ? {
          episodeId: episode.episodeId,
          title: str(episode.title),
          code: episodeCode(episodes, episode.episodeId),
          bgmAssetId: str(episode.bgmAssetId) || null,
        }
      : null,
    episodes: episodes.map((e, i) => ({
      episodeId: e.episodeId,
      title: str(e.title),
      code: `EP${String(i + 1).padStart(2, "0")}`,
      active: e.episodeId === episodeId,
    })),
    script: scriptStanding(sources.scripts, episodeId),
    scenes,
    shots,
    referenceKeys,
    skillRuns: scopedRuns,
    generations: scopedGenerations,
    assetCount: countAssets(sources.assets),
    qc,
    approved: qc.filter((q) => q.approved).length,
    timeline: timeline
      ? { clips: arr(timeline.clips).length, sourceSig: str(timeline.sourceSig) || null }
      : null,
    finals: finals.map((f) => ({ assetId: isObj(f) ? str(f.assetId) || null : null })),
  };

  function episodeOf(g) {
    const p = isObj(g.parameters) ? g.parameters : null;
    return p && typeof p.episodeId === "string" ? p.episodeId : null;
  }
}

/** Is a skill run within this scope? A run with NO recorded context belongs to
 *  no scope at all — it is never swept into the active episode, which would be
 *  exactly the invented attribution ADR-0059 决策 6 forbids. */
export function runInScope(run, { episodeId = null, sceneId = null, shotId = null } = {}) {
  const c = isObj(run) && isObj(run.context) ? run.context : null;
  if (!c) return false;
  if (shotId) return c.shotId === shotId;
  if (sceneId) return c.sceneId === sceneId;
  if (episodeId) return c.episodeId === episodeId;
  return true;
}

/** Runs whose context was never captured. Surfaced deliberately: they are real
 *  history, and the honest place for them is a named 「未记录上下文」 group. */
export function runsWithoutContext(skillRuns) {
  return arr(skillRuns).filter((r) => isObj(r) && !isObj(r.context));
}

function episodeCode(episodes, episodeId) {
  const i = arr(episodes).findIndex((e) => e.episodeId === episodeId);
  return i >= 0 ? `EP${String(i + 1).padStart(2, "0")}` : null;
}

/** The story's STANDING — which versions are approved/confirmed. Not the text. */
function storyStanding(story) {
  if (!isObj(story)) return null;
  return {
    idea: !!str(story.idea).trim(),
    activeOutline: Number.isInteger(story.active) ? story.active : 0,
    approvedOutline: Number.isInteger(story.approved) ? story.approved : 0,
    confirmedPlan: Number.isInteger(story.confirmedPlan) ? story.confirmedPlan : 0,
  };
}

/** The episode's script standing — version count and whether it has content. */
function scriptStanding(scripts, episodeId) {
  const doc = isObj(scripts) && episodeId ? scripts[episodeId] : null;
  if (!isObj(doc)) return { versions: 0, active: 0, hasContent: false };
  const text = typeof doc.workingText === "string"
    ? doc.workingText
    : (arr(doc.versions).find((v) => isObj(v) && v.v === doc.active) || {}).content || "";
  return {
    versions: arr(doc.versions).length,
    active: Number.isInteger(doc.active) ? doc.active : 0,
    hasContent: !!str(text).trim(),
  };
}

function countAssets(assets) {
  if (!isObj(assets)) return 0;
  let n = 0;
  for (const domain of ["images", "videos", "audio"]) {
    const m = assets[domain];
    if (!isObj(m)) continue;
    for (const key of Object.keys(m)) {
      const e = m[key];
      if (isObj(e) && Array.isArray(e.history)) n += e.history.length;
    }
  }
  return n + arr(assets.finals).length;
}

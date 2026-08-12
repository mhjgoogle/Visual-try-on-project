// Media dependency truth (ADR-0061 决策 5) — is this video still based on the
// image the shot currently has selected?
//
// The五个 states and their meanings are NOT re-invented here: they are the ones
// `canondoc.js` already established for episodes-vs-upstream, reused verbatim so
// the studio has ONE dependency vocabulary rather than two that drift apart.
//
//   none      there is nothing downstream to be stale (no video at all)
//   unknown   the records do not say what it was based on. An IMPORT has no
//             generation record, so its source image is genuinely not known —
//             and 「未记录」 is not the same claim as 「落后」. Legacy media
//             (nothing recorded a basis) lands here and MUST NOT be reported as
//             outdated: that would invent a history the document never held.
//   current   the proven source IS the version the shot has active
//   outdated  the active version moved FORWARD past the proven source
//   diverged  the active version is EARLIER than the proven source (the creator
//             switched back). Not 「outdated」 — the opposite direction, and
//             conflating them would tell them the wrong thing to do about it.
//
// Pure derivation — no fetch, no DOM, no clock, no writes. Nothing here is ever
// persisted: a dependency state is a fact about two versions, recomputed every
// time, so it cannot go stale in storage.

import { UPSTREAM_STATE } from "./canondoc.js";

/** The SAME five states as `canondoc.UPSTREAM_STATE`, imported rather than
 *  re-declared: two lists of state names in one studio is one list too many. */
export const DEP = UPSTREAM_STATE;

/** Media-side wording for those states. The states are shared; only the words
 *  differ, because 「上游」 here is a specific image version rather than a whole
 *  upstream surface. */
export const DEP_LABEL = {
  none: "还没有下游",
  unknown: "来源未记录",
  current: "与当前上游一致",
  outdated: "上游已更新",
  diverged: "上游已回退",
};

const isInt = (x) => Number.isInteger(x);

/**
 * The dependency state of ONE downstream take against its upstream chain.
 *
 * `downstream`  { version, sourceVersion, proven } — the take, plus which
 *               upstream version the RECORDS prove it was generated from.
 *               `proven: false` means no generation record named an input, so
 *               the source is unknown rather than absent.
 * `activeUpstreamVersion`  the upstream chain's currently selected version, or
 *               null when the chain has none.
 */
export function dependencyOf(downstream, activeUpstreamVersion) {
  if (!downstream || !isInt(downstream.version)) return DEP.NONE;
  // No upstream selected at all: there is no version to compare against, so the
  // honest answer is "not known", never "current".
  if (!isInt(activeUpstreamVersion)) return DEP.UNKNOWN;
  if (!downstream.proven || !isInt(downstream.sourceVersion)) return DEP.UNKNOWN;
  if (downstream.sourceVersion === activeUpstreamVersion) return DEP.CURRENT;
  return downstream.sourceVersion < activeUpstreamVersion ? DEP.OUTDATED : DEP.DIVERGED;
}

/** What the creator can DO about a state, as an explicit list of choices —
 *  never a silent rewrite (ADR-0061 决策 5 / TASK-064 §26).
 *
 *  The three options for a stale take are deliberately symmetric: keep what you
 *  have, regenerate from what is active now, or put the active pointer back where
 *  this take came from. Nothing here picks one.
 *  A `current` / `none` / `unknown` state offers none: there is no divergence to
 *  resolve, and for `unknown` there is no known basis to resolve it TOWARDS. */
export function resolutionsFor(state, { sourceVersion = null, activeVersion = null } = {}) {
  if (state !== DEP.OUTDATED && state !== DEP.DIVERGED) return [];
  return [
    { action: "keep", label: "保持当前版本" },
    {
      action: "regenerate",
      label: isInt(activeVersion) ? `基于 v${activeVersion} 新生成` : "基于当前上游新生成",
    },
    {
      action: "revert-upstream",
      label: isInt(sourceVersion) ? `切回上游 v${sourceVersion}` : "切回它所基于的上游版本",
      // Nothing to switch BACK to when the basis is unknown — the option is
      // still listed, but a caller must not act on a null version.
      version: isInt(sourceVersion) ? sourceVersion : null,
    },
  ];
}

/**
 * Every video take of one shot, with its dependency on the shot's ACTIVE image.
 *
 * `videos`        the video chain as `{ version, assetId, current }[]`
 * `videoSources`  version → { version, proven } | null, as the shot detail model
 *                 derives it from the Generation that produced that take
 * `activeImage`   the image chain's current version, or null
 */
export function videoDependencies({ videos = [], videoSources = {}, activeImage = null } = {}) {
  return videos.map((v) => {
    const src = videoSources[v.version] || null;
    const down = {
      version: v.version,
      sourceVersion: src && isInt(src.version) ? src.version : null,
      proven: !!(src && src.proven),
    };
    const state = dependencyOf(down, activeImage);
    return {
      version: v.version,
      assetId: v.assetId || null,
      current: !!v.current,
      sourceVersion: down.sourceVersion,
      proven: down.proven,
      state,
      label: DEP_LABEL[state] || state,
      resolutions: resolutionsFor(state, { sourceVersion: down.sourceVersion, activeVersion: activeImage }),
    };
  });
}

/** The ONE line the shot's video card shows about upstream drift, or null when
 *  there is nothing to report. Only the CURRENT take is reported: a historical
 *  take being based on an older image is not a problem, it is what history is. */
export function upstreamNotice(deps, activeImage) {
  const cur = deps.find((d) => d.current);
  if (!cur) return null;
  if (cur.state !== DEP.OUTDATED && cur.state !== DEP.DIVERGED) return null;
  return {
    state: cur.state,
    label: DEP_LABEL[cur.state],
    videoVersion: cur.version,
    sourceVersion: cur.sourceVersion,
    activeImage: Number.isInteger(activeImage) ? activeImage : null,
    resolutions: cur.resolutions,
  };
}

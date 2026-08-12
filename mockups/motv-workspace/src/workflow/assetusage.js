// Asset Usage (checkpoint CP5 / ADR-0058) — the answer to the one question an
// asset library exists to answer:
//
//     这个资产被哪里用了？   →  EP01/S01/SH01 · EP01/S01/SH02 · EP02/S03/SH04
//
// ENTIRELY DERIVED. Usage is recomputed from the canonical relations every time
// it is asked for; nothing about it is stored. Storing it would create a second
// truth that drifts the moment a scene is re-cut, a variant is switched, or a
// reference is unbound — and "where is this used" is exactly the question you
// cannot afford a stale answer to.
//
// FIVE SOURCES, each a place that genuinely points AT an asset:
//
//   bible        character/location referenceAssetIds (+ state overrides)
//   scene/episode  ambience / bgm references
//   shot         the CP4 shared-Reference bindings (by reference KEY)
//   generation   inputs / references / results (frozen provenance, M5)
//   timeline     clips (by assetId)
//
// DE-DUPLICATION IS THE POINT. The same asset legitimately appears twice in one
// place — a reference bound to a shot that ALSO fed the generation that made
// that shot's image, say. Counting both would tell the creator this reference is
// used twice as much as it is, and "used a lot" is how people decide what to
// keep. So every usage is keyed by (kind, episode, scene, shot, extra) and the
// same place is only ever reported once.
//
// Pure derivation — no fetch, no DOM, no clock, no writes.

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x) => typeof x === "string" && x !== "";

/** Where a usage came from. Each is a different KIND of dependency, and the
 *  creator's next action differs, so they are never merged into one "used". */
export const USAGE_KINDS = [
  "character-ref",   // a Character's reference material
  "location-ref",    // a Location's reference material
  "scene-audio",     // a Scene's ambience / BGM
  "episode-audio",   // an Episode's BGM
  "shot-reference",  // a Shot points at this canonical Reference (CP4)
  "generation",      // a Generation consumed or produced it (frozen, M5)
  "timeline",        // a Timeline clip references it
];

export const USAGE_KIND_LABEL = {
  "character-ref": "人物参考",
  "location-ref": "场景参考",
  "scene-audio": "场景音频",
  "episode-audio": "剧集 BGM",
  "shot-reference": "镜头参考",
  generation: "生成记录",
  timeline: "时间线",
};

/**
 * Every place ONE asset is used.
 *
 * `assetId`      the asset itself
 * `referenceKey` its chain key, when it is a canonical Reference — a Shot binds
 *                the CHAIN, not one version, so shot usage is found by key
 *
 * Returns { places: [...], count, byKind } where each place carries the
 * canonical context it was found in (episodeId / sceneId / shotId) plus a
 * human label. `count` is the number of DISTINCT places.
 */
export function usageOfAsset({
  assetId,
  referenceKey = null,
  // Whether this asset is the CHAIN's current version. A Shot binds the chain,
  // and the chain resolves to exactly one version — so a superseded take is not
  // in use by those shots, however many of them point at the chain. Counting it
  // showed 林晚 Ref v1 as 「用于 3 处」 the moment v2 replaced it, and
  // "used a lot" is how a creator decides what is safe to clean up.
  isCurrent = true,
  production,
  timelines,
  generations,
}) {
  const places = [];
  const seen = new Set();
  const add = (place) => {
    // JSON, not a joined string: a separator has to be a character that cannot
    // appear inside an id, and every such candidate is either guessable-wrong
    // or (as a literal NUL) turns this source file binary for git and every
    // diff reviewer. JSON.stringify is unambiguous for any input and costs
    // nothing here. `kind` stays part of the key — a Character's reference
    // material and a Shot's binding are different KINDS of dependency on the
    // same asset, and collapsing them would under-report real usage.
    //
    // The key must name the SUBJECT too. A bible reference has no episode,
    // scene or shot — every field but `kind` is empty — so one photo used as
    // both 林晚's and 陈默's reference material collapsed into a single place
    // and the library reported it as depended on half as much as it is. That is
    // the same under-reporting this de-duplication exists to prevent, from the
    // other direction.
    const key = JSON.stringify([
      place.kind,
      place.episodeId || "",
      place.sceneId || "",
      place.shotId || "",
      place.characterId || "",
      place.locationId || "",
      place.extra || "",
    ]);
    if (seen.has(key)) return; // the same place is reported ONCE (see header)
    seen.add(key);
    places.push(place);
  };

  const prod = isObj(production) ? production : null;

  // --- where a shot lives, so every usage can name its episode + scene ------ //
  const shotHome = new Map();
  if (prod) {
    for (const ep of prod.episodes || []) {
      for (const sc of ep.scenes || []) {
        for (const id of sc.shotIds || []) {
          if (!shotHome.has(id)) {
            shotHome.set(id, { episodeId: ep.episodeId, sceneId: sc.sceneId, sceneTitle: sc.title, episodeTitle: ep.title });
          }
        }
      }
    }
  }
  const epIndex = new Map((prod ? prod.episodes || [] : []).map((e, i) => [e.episodeId, i + 1]));
  const shotLabel = (shotId) => {
    const home = shotHome.get(shotId);
    if (!home) return `未分配镜头`;
    const n = epIndex.get(home.episodeId);
    const ep = n ? `EP${String(n).padStart(2, "0")}` : "";
    const sc = home.sceneTitle ? home.sceneTitle.split(" ")[0] : "";
    return [ep, sc].filter(Boolean).join(" / ");
  };

  if (prod) {
    // --- bible reference material ------------------------------------------ //
    for (const c of prod.characters || []) {
      const own = [
        ...(Array.isArray(c.referenceAssetIds) ? c.referenceAssetIds : []),
        ...(Array.isArray(c.states) ? c.states : []).flatMap((st) =>
          isObj(st) && isObj(st.overrides) && Array.isArray(st.overrides.referenceAssetIds)
            ? st.overrides.referenceAssetIds
            : []),
      ];
      if (own.includes(assetId)) {
        add({ kind: "character-ref", label: `人物参考 · ${c.name}`, characterId: c.characterId, episodeId: null, sceneId: null, shotId: null });
      }
    }
    for (const l of prod.locations || []) {
      const own = [
        ...(Array.isArray(l.referenceAssetIds) ? l.referenceAssetIds : []),
        ...(Array.isArray(l.states) ? l.states : []).flatMap((st) =>
          isObj(st) && isObj(st.overrides) && Array.isArray(st.overrides.referenceAssetIds)
            ? st.overrides.referenceAssetIds
            : []),
      ];
      if (own.includes(assetId)) {
        add({ kind: "location-ref", label: `场景参考 · ${l.name}`, locationId: l.locationId, episodeId: null, sceneId: null, shotId: null });
      }
    }

    // --- scene / episode audio --------------------------------------------- //
    for (const ep of prod.episodes || []) {
      const n = epIndex.get(ep.episodeId);
      const epCode = n ? `EP${String(n).padStart(2, "0")}` : ep.title;
      if (ep.bgmAssetId === assetId) {
        add({ kind: "episode-audio", label: `${epCode} · BGM`, episodeId: ep.episodeId, sceneId: null, shotId: null, extra: "bgm" });
      }
      for (const sc of ep.scenes || []) {
        if (sc.ambienceAssetId === assetId) {
          add({ kind: "scene-audio", label: `${epCode} / ${sc.title} · 环境音`, episodeId: ep.episodeId, sceneId: sc.sceneId, shotId: null, extra: "ambience" });
        }
        if (sc.bgmAssetId === assetId) {
          add({ kind: "scene-audio", label: `${epCode} / ${sc.title} · BGM`, episodeId: ep.episodeId, sceneId: sc.sceneId, shotId: null, extra: "bgm" });
        }
      }
    }

    // --- shots that point at this canonical Reference (by KEY) -------------- //
    if (nonEmpty(referenceKey) && isCurrent && isObj(prod.shotProduction)) {
      const map = prod.shotProduction.references || {};
      for (const shotId of Object.keys(map)) {
        const list = Array.isArray(map[shotId]) ? map[shotId] : [];
        if (!list.includes(referenceKey)) continue;
        const home = shotHome.get(shotId) || {};
        add({
          kind: "shot-reference",
          label: `${shotLabel(shotId)} · 镜头参考`,
          episodeId: home.episodeId || null,
          sceneId: home.sceneId || null,
          shotId,
        });
      }
    }
  }

  // --- generations (frozen provenance) -------------------------------------- //
  for (const g of Array.isArray(generations) ? generations : []) {
    if (!isObj(g)) continue;
    const roles = [];
    if (Array.isArray(g.inputAssetIds) && g.inputAssetIds.includes(assetId)) roles.push("输入");
    if (Array.isArray(g.referenceAssetIds) && g.referenceAssetIds.includes(assetId)) roles.push("参考");
    if (Array.isArray(g.resultAssetIds) && g.resultAssetIds.includes(assetId)) roles.push("产出");
    if (!roles.length) continue;
    const shotId = nonEmpty(g.targetId) ? g.targetId : null;
    const home = (shotId && shotHome.get(shotId)) || {};
    add({
      kind: "generation",
      label: `${shotId ? `${shotLabel(shotId)} · ` : ""}${g.type} 生成（${roles.join("/")}）`,
      episodeId: home.episodeId || null,
      sceneId: home.sceneId || null,
      shotId,
      generationId: g.generationId,
      extra: g.generationId,
      status: g.status,
    });
  }

  // --- timeline clips -------------------------------------------------------- //
  if (isObj(timelines)) {
    for (const episodeId of Object.keys(timelines)) {
      const t = timelines[episodeId];
      for (const c of isObj(t) && Array.isArray(t.clips) ? t.clips : []) {
        if (!isObj(c) || c.assetId !== assetId) continue;
        const n = epIndex.get(episodeId);
        const epCode = n ? `EP${String(n).padStart(2, "0")}` : episodeId;
        add({
          kind: "timeline",
          label: `${epCode} · 时间线（${c.trackType}）`,
          episodeId,
          sceneId: null,
          shotId: c.shotId || null,
          // One entry per (track, shot): the same asset cut into two clips of
          // one shot's video track is ONE dependency, but the same asset used
          // for two different shots really is two places in the cut.
          extra: c.trackType,
        });
      }
    }
  }

  const byKind = {};
  for (const p of places) byKind[p.kind] = (byKind[p.kind] || 0) + 1;
  return { assetId, places, count: places.length, byKind };
}

/** Usage for MANY assets at once — one pass over the canonical documents
 *  instead of one pass per asset, so the library can show a usage count on
 *  every card without becoming quadratic. Returns Map(assetId → usage). */
export function usageIndex({ assets, production, timelines, generations }) {
  const out = new Map();
  for (const a of Array.isArray(assets) ? assets : []) {
    if (!a || !nonEmpty(a.assetId)) continue;
    out.set(
      a.assetId,
      usageOfAsset({
        assetId: a.assetId,
        referenceKey: a.key || null,
        isCurrent: a.current !== false,
        production,
        timelines,
        generations,
      }),
    );
  }
  return out;
}

/** Is this asset used nowhere at all? The library says so plainly — an unused
 *  asset is not a defect, but it IS the thing a creator wants to find when they
 *  ask what is safe to clean up. */
export function isUnused(usage) {
  return !usage || usage.count === 0;
}

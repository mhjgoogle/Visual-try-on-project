// 人物关系图 (TASK-065 §2) — the relationship GRAPH's layout + label model.
//
// A relationship is already a first-class object (ADR-0054 决策 3 / canondoc.js).
// What was missing is a picture: eleven text facets per pair read as a form, and a
// form cannot answer 「谁跟谁是对立的」 at a glance.
//
// FOUR THINGS THE GRAPH HAS TO SAY (§2), and where each one comes from:
//
//   关系类型     profile.basis            — 「曾经的搭档，现在的对手」
//   方向         characterIds order       — A → B, swapped by canondoc.swapRelationshipDirection
//   情绪 / 冲突  profile.tension / coreConflict
//   当前关系     canondoc.relationshipCurrentState(…, activeEpisodeId)
//
// NODES ARE REAL CHARACTERS, NEVER COPIES (§2 的硬约束). A node carries a
// characterId and the name/portrait resolved from the bible on every derivation.
// Nothing here stores a character, so a rename in 人物 cannot leave a stale label
// on the graph, and deleting a relationship cannot touch a character.
//
// LAYOUT IS DETERMINISTIC. Positions come from each character's INDEX in
// `production.characters` — same cast, same picture, every render and every
// reload. Nothing random (scripts in this codebase cannot call Math.random
// anyway) and nothing persisted: a layout is not a creative decision, so storing
// one would create a document that can disagree with the cast.
//
// Pure derivation — no fetch, no DOM, no clock, no writes.

import { relationshipCurrentState, pairKey } from "./canondoc.js";
import { slotEntry } from "./mediaref.js";

const s = (x) => (typeof x === "string" ? x.trim() : "");

/** The viewBox the layout is computed in. The renderer scales it; keeping the
 *  numbers here means the model can place a label without knowing the pixel size
 *  of the box it lands in. */
export const VIEW = { w: 1000, h: 620 };

/** Node radius and the ring the cast is laid out on. */
const R = 46;
const RING = { cx: VIEW.w / 2, cy: VIEW.h / 2, rx: VIEW.w / 2 - R - 74, ry: VIEW.h / 2 - R - 40 };

/** The conflict WEIGHT of one relationship — how loud its edge should be.
 *
 *  Derived from what is actually written: a pair with a core conflict AND an
 *  emotional tension is a hotter edge than a pair with only a basis. This is a
 *  presentation weight, NOT a judgement the graph invents — an edge with nothing
 *  written scores 0 and is drawn as the quiet line it is. */
export function conflictWeight(profile) {
  let n = 0;
  if (s(profile.coreConflict)) n += 2;
  if (s(profile.tension)) n += 1;
  if (s(profile.forbidden)) n += 1;
  return n;
}

/** Portrait url for a character, from its ACTIVE reference (else its first).
 *  Never a fabricated image: a character with no reference gets "" and the
 *  renderer draws an honest initial. */
function portraitOf(c, assetUploads) {
  const want = c.activeReferenceAssetId || (c.referenceAssetIds || [])[0] || null;
  if (!want) return "";
  for (const key of Object.keys(assetUploads || {})) {
    const e = slotEntry(assetUploads, key);
    if (!e) continue;
    for (const r of e.history) if (r && r.assetId === want) return r.url || "";
  }
  return "";
}

/** Ellipse position for cast member `i` of `n`.
 *
 *  Starts at the TOP and goes clockwise, so the first character in the cast is
 *  where a reader's eye starts. A single character sits in the middle rather than
 *  at 12 o'clock with the rest of the canvas empty. */
export function nodePosition(i, n) {
  if (n <= 1) return { x: RING.cx, y: RING.cy };
  const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
  return { x: RING.cx + RING.rx * Math.cos(a), y: RING.cy + RING.ry * Math.sin(a) };
}

/**
 * Where an edge's label goes, pushed off the straight line so two edges between
 * neighbouring nodes do not stack their text on top of each other.
 *
 * `lane` is the edge's index among the edges that share this pair's midpoint
 * region; it only offsets perpendicular to the line. Deterministic, like
 * everything else here.
 */
function labelPoint(a, b, lane) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // perpendicular unit vector, alternating side by lane parity so successive
  // lanes fan out around the line instead of drifting off in one direction
  const sign = lane % 2 === 0 ? 1 : -1;
  const step = 22 * Math.ceil(lane / 2) * sign;
  return { x: mx + (-dy / len) * step, y: my + (dx / len) * step };
}

/** Shorten an edge so it starts and ends at the node BORDER rather than at the
 *  centre — an arrowhead buried under a portrait says nothing about direction. */
function trim(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return {
    x1: a.x + ux * (R + 3), y1: a.y + uy * (R + 3),
    x2: b.x - ux * (R + 9), y2: b.y - uy * (R + 9),
  };
}

/**
 * The whole graph.
 *
 * @param pd         the production read snapshot
 * @param episodeId  which episode 「当前关系」 is measured up to. Defaults to the
 *                   ACTIVE episode — the graph a creator reads while working on
 *                   EP03 should say where the relationships stand in EP03, not
 *                   where they end up in the finale.
 */
export function relationshipGraph(pd, { episodeId = null } = {}) {
  const prod = pd && pd.production;
  if (!prod || !Array.isArray(prod.characters) || !Array.isArray(prod.relationships)) {
    return { empty: true, nodes: [], edges: [] };
  }
  const upto = episodeId || prod.activeEpisodeId || null;
  const cast = prod.characters;
  const nodes = cast.map((c, i) => ({
    characterId: c.characterId,
    name: c.name,
    tier: c.tier,
    url: portraitOf(c, pd.assetUploads),
    // the initial the renderer falls back to — computed here so the SVG does not
    // have to know that a name can be empty
    initial: s(c.name).slice(0, 1) || "?",
    ...nodePosition(i, cast.length),
  }));
  const byId = new Map(nodes.map((n) => [n.characterId, n]));
  // lane per unordered pair, so a second edge between the same two people (which
  // the domain forbids today) would still not overprint the first
  const lanes = new Map();
  const edges = [];
  const dangling = [];
  for (const r of prod.relationships) {
    const [aId, bId] = r.characterIds;
    const a = byId.get(aId) || null;
    const b = byId.get(bId) || null;
    if (!a || !b) {
      // a relationship whose character is gone is REPORTED, not drawn. Drawing it
      // against a placeholder node would put a person on the graph who is not in
      // the cast (validation makes this unreachable today; saying so beats
      // assuming it).
      dangling.push({ relationshipId: r.relationshipId, characterIds: r.characterIds });
      continue;
    }
    // canondoc.pairKey, NOT a hand-joined string. A characterId is arbitrary
    // non-empty text, so ANY separator character could legally occur inside one and
    // make two different pairs collide on one lane — which is precisely why canondoc
    // has this function (it JSON-encodes the ordered pair, which is injective).
    const pk = pairKey(aId, bId);
    const lane = lanes.get(pk) || 0;
    lanes.set(pk, lane + 1);
    const current = relationshipCurrentState(prod, r.relationshipId, upto);
    edges.push({
      relationshipId: r.relationshipId,
      a: { characterId: aId, name: a.name },
      b: { characterId: bId, name: b.name },
      ...trim(a, b),
      label: labelPoint(a, b, lane),
      // 关系类型 — the basis IS the type in this domain. An empty one is left
      // empty; 「未定义」 as a drawn label would look like a decision.
      type: s(r.profile.basis),
      conflict: s(r.profile.coreConflict),
      tension: s(r.profile.tension),
      forbidden: s(r.profile.forbidden),
      arc: s(r.profile.arc),
      weight: conflictWeight(r.profile),
      current,
      filled: Object.keys(r.profile).filter((k) => s(r.profile[k])).length,
    });
  }
  // every pair that could still be defined — the graph's own 「建立关系」 entry, so
  // a creator adds one by picking two people on the picture instead of hunting a
  // select box for a pair label
  const pairs = [];
  for (let i = 0; i < cast.length; i++) {
    for (let j = i + 1; j < cast.length; j++) {
      const aId = cast[i].characterId;
      const bId = cast[j].characterId;
      const exists = edges.some((e) =>
        (e.a.characterId === aId && e.b.characterId === bId)
        || (e.a.characterId === bId && e.b.characterId === aId));
      if (!exists) pairs.push({ a: aId, b: bId, label: `${cast[i].name} × ${cast[j].name}` });
    }
  }
  return {
    empty: false,
    view: VIEW,
    radius: R,
    nodes,
    edges,
    pairs,
    dangling,
    episodeId: upto,
    castCount: cast.length,
    revision: prod.canon.relationships,
  };
}

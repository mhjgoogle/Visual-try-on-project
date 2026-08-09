// Canonical creative-Shot ↔ slot resolver (checkpoint M4a).
//
// A `slot` (`v<N>-<i>`) is the media STORAGE/version/file key. The creative
// `shotId` (M2, `shot-…`/`shot-mig-N`) is the BUSINESS identity. This pure,
// side-effect-free resolver bridges them over the AUTHORITATIVE draft — a
// scriptgen version's `raw[]` shot list — so downstream joins can ask "which
// media belongs to this shot" by shotId while storage stays slot-keyed.
//
// Identity, not position: the mapping is rebuilt from the current draft each
// time, and every shot carries its own stable shotId and its own carried slot,
// so reordering / inserting / deleting a shot cannot shift another shot's
// binding. Fail-safe (M4 decision #5): a slot or shotId that is duplicated /
// missing within the draft is AMBIGUOUS and resolves to null — never guessed,
// and NEVER a positional-sequence fallback. Callers rewiring joins (M4b+) must
// treat null as "unresolved", not silently fall back to sequence.
//
// M4a ships the resolver ONLY — no existing join is rewired yet.

/** Build a bidirectional shotId↔slot index from an authoritative draft's raw
 *  shots. A binding resolves ONLY when BOTH its shotId and its slot are
 *  unambiguous (each appears exactly once across the draft). If either side is
 *  duplicated, the binding is dropped in BOTH directions — a duplicated slot
 *  never resolves via slotForShotId, and a duplicated shotId never resolves via
 *  shotIdForSlot. Absent sides bind nothing. Never guessed, never positional. */
export function buildShotSlotIndex(rawShots) {
  const rows = [];
  const shotIdCount = new Map();
  const slotCount = new Map();
  for (const s of Array.isArray(rawShots) ? rawShots : []) {
    if (s == null || typeof s !== "object") continue;
    const sid = typeof s.shotId === "string" && s.shotId ? s.shotId : null;
    const slot = typeof s.slot === "string" && s.slot ? s.slot : null;
    rows.push({ sid, slot });
    if (sid) shotIdCount.set(sid, (shotIdCount.get(sid) || 0) + 1);
    if (slot) slotCount.set(slot, (slotCount.get(slot) || 0) + 1);
  }
  const slotByShotId = new Map();
  const shotIdBySlot = new Map();
  for (const { sid, slot } of rows) {
    // a clean 1:1 binding needs an unambiguous shotId AND an unambiguous slot
    if (sid && slot && shotIdCount.get(sid) === 1 && slotCount.get(slot) === 1) {
      slotByShotId.set(sid, slot);
      shotIdBySlot.set(slot, sid);
    }
  }
  return { slotByShotId, shotIdBySlot };
}

/** The storage slot for a creative shotId, or null when unresolved/ambiguous.
 *  Tolerates a null/malformed index (returns null rather than throwing) — the
 *  map must be a real Map, so a non-Map/non-callable `.get` can never crash. */
export function slotForShotId(index, shotId) {
  if (typeof shotId !== "string" || !shotId) return null;
  const m = index && index.slotByShotId;
  return m instanceof Map ? m.get(shotId) ?? null : null;
}

/** The creative shotId a storage slot belongs to, or null when
 *  unresolved/ambiguous. A slot with no proven shotId resolves to null.
 *  Tolerates a null/malformed index (returns null rather than throwing). */
export function shotIdForSlot(index, slot) {
  if (typeof slot !== "string" || !slot) return null;
  const m = index && index.shotIdBySlot;
  return m instanceof Map ? m.get(slot) ?? null : null;
}

// ---- creativeShotId ↔ server official shot_id bridge (M4c) ---------------- //

/** Build the creativeShotId → server shot_id bridge from a locked plan's shot
 *  records. A record `{ shot_id, creativeShotId, sequence }` contributes ONLY a
 *  clean 1:1 mapping: a creativeShotId claimed by multiple records, or a
 *  server shot_id claimed by multiple creativeShotIds, is dropped (conflict →
 *  unresolved, fail safe). Returns { byCreative: Map, bridged: bool } where
 *  `bridged` is true when ANY record carries a creativeShotId (an M4c lock);
 *  false means a legacy pre-M4c lock, where a positional fallback is allowed. */
export function buildServerBridge(lockedShots) {
  const rows = [];
  const creativeCount = new Map();
  const serverCount = new Map();
  let bridged = false;
  for (const r of Array.isArray(lockedShots) ? lockedShots : []) {
    if (r == null || typeof r !== "object") continue;
    // Presence of the KEY (even null) marks an M4c-attempted lock — a bridge
    // the server nulled on fail-safe must still be treated as M4c (unresolved),
    // NEVER misread as legacy → sequence fallback. Legacy locks lack the key.
    if (Object.prototype.hasOwnProperty.call(r, "creativeShotId")) bridged = true;
    const cid = typeof r.creativeShotId === "string" && r.creativeShotId ? r.creativeShotId : null;
    const sid = typeof r.shot_id === "string" && r.shot_id ? r.shot_id : null;
    rows.push({ cid, sid });
    if (cid) creativeCount.set(cid, (creativeCount.get(cid) || 0) + 1);
    if (sid) serverCount.set(sid, (serverCount.get(sid) || 0) + 1);
  }
  const byCreative = new Map();
  for (const { cid, sid } of rows) {
    if (cid && sid && creativeCount.get(cid) === 1 && serverCount.get(sid) === 1) {
      byCreative.set(cid, sid);
    }
  }
  return { byCreative, bridged };
}

/** The server official shot_id a draft shot's paid records join to (M4c):
 *  returns { id, unresolved }.
 *  - M4c lock (bridge present): resolve by creativeShotId ONLY; a shot whose
 *    identity can't be proven is { id: null, unresolved: true } — NEVER a
 *    sequence fallback (decision #5).
 *  - legacy pre-M4c lock (no bridge) or no lock: explicit positional fallback
 *    (lockedShots[seq-1].shot_id, else the pre-seeded `shot-<seq>`). */
export function serverShotIdForShot(bridge, lockedShots, shot) {
  if (bridge && bridge.bridged) {
    const sid = shot && typeof shot.shotId === "string" && shot.shotId
      ? bridge.byCreative.get(shot.shotId)
      : undefined;
    return sid ? { id: sid, unresolved: false } : { id: null, unresolved: true };
  }
  const seq = shot && shot.sequence;
  const row = Array.isArray(lockedShots) ? lockedShots[seq - 1] : null;
  const id = row && typeof row.shot_id === "string" && row.shot_id ? row.shot_id : `shot-${seq}`;
  return { id, unresolved: false };
}

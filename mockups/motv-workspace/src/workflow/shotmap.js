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

/** The storage slot for a creative shotId, or null when unresolved/ambiguous. */
export function slotForShotId(index, shotId) {
  if (!index || typeof shotId !== "string" || !shotId) return null;
  return index.slotByShotId.get(shotId) ?? null;
}

/** The creative shotId a storage slot belongs to, or null when
 *  unresolved/ambiguous. A slot with no proven shotId resolves to null. */
export function shotIdForSlot(index, slot) {
  if (!index || typeof slot !== "string" || !slot) return null;
  return index.shotIdBySlot.get(slot) ?? null;
}

// Creator-domain identity minting (checkpoint M2).
//
// Stable identities are minted ONCE at creation time and then only carried —
// never re-derived from sequence, slot, node id, array index, or canvas
// position. Prefixes:
//   sv-…   Script version        (scriptDoc.versions[].id)
//   sdv-…  Shot Draft version    (scriptgen node versions[].id)
//   shot-… individual draft Shot (raw[].shotId)
// Migrated legacy records instead get deterministic `<prefix>-mig-<n>` ids
// from canvasschema.js's v1→v2 migration; the two namespaces cannot collide.

/** Mint a fresh, unique creator-domain id. */
export function mintId(prefix) {
  if (globalThis.crypto && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  // ancient-browser fallback — uniqueness, not cryptography
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Ensure every shot entry carries a stable shotId, minting ONLY where one is
 *  missing — existing identities are never replaced. Returns the same array. */
export function assignShotIdentity(shots) {
  if (!Array.isArray(shots)) return shots;
  for (const s of shots) {
    if (s && typeof s === "object" && typeof s.shotId !== "string") s.shotId = mintId("shot");
  }
  return shots;
}

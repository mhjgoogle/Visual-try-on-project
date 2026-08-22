// REFERENCE controller — 参考解读 (`refInterp`) + 参考用途 (`refUse`).
//
// TASK-073 §1.8, following the pattern `controllers/lockctl.js` set: every document
// arrives as a GETTER, because the bindings it reads are module-level `let`s that get
// REASSIGNED on project load. A factory capturing their values would keep writing to
// the previous project's documents.
//
// WHY THESE TWO TOGETHER. They are one domain seen from two sides: a reading says
// 「我从这张参考里读出了什么」 and a use says 「这张参考服务哪一边」. Both are keyed by
// (shot, refKey), both are consumed by the same two compilers, and both derive from
// the SAME bound-reference list. Splitting them would mean two modules each holding
// half of 「这张参考对这个镜头意味着什么」, and the compilers reading one of them
// without the other is precisely how a control ends up doing nothing.
//
// WHAT THIS MODULE OWNS AND WHAT IT DOES NOT: it records and derives. It never
// decides whether a write is allowed — the lock check happens in the domain modules
// it calls — and it owns no clock: `now()` is injected, so a reading's timestamp is
// deterministic in a test.

/**
 * @param {object} deps
 *   docs        `{ refInterp, refUse }` — GETTERS returning the current documents
 *   modules     `{ refinterp, refuse, assetreg }`
 *   referencesOfShot  `(shotId) => string[]` — the shot's bound Reference keys
 *   chainOf     `(refKey) => { list } | null` — the reference's version chain
 *   prodOp      persists + refreshes on a truthy result, and returns it
 *   persist     `() => void`
 *   refresh     `() => void`
 *   now         `() => string` — the timestamp source
 */
export function createReferenceController({
  docs, modules, referencesOfShot, chainOf, prodOp, persist, refresh, now,
}) {
  const { refinterp, refuse, assetreg } = modules;

  return {
    interp: {
      reading: (refKey) => refinterp.activeReading(docs.refInterp(), refKey),
      entry: (refKey) => refinterp.entryOf(docs.refInterp(), refKey),

      /** Record a reading. Returns the version, or 0 when refused (a LOCKED
       *  reading refuses everything that is not a manual edit). */
      save: (refKey, axes, opts = {}) => {
        // WHAT IS BEING READ, recorded with the reading (TASK-072 §1.9 缺陷 3).
        // Resolved HERE from the registry rather than trusted from the caller: the
        // whole point is that the record describes the material that actually existed
        // at the moment of reading, so a later version swap can be reported as drift
        // instead of silently relabelling an old note as a new one.
        const chain = chainOf(refKey);
        const cur = chain && Array.isArray(chain.list)
          ? chain.list.find((x) => x.current) || null
          : null;
        const v = refinterp.addReading(docs.refInterp(), refKey, {
          axes,
          origin: opts.origin || "manual",
          at: now(),
          skillRunId: opts.skillRunId || null,
          proposalId: opts.proposalId || null,
          basedOnAssetId: cur && cur.assetId ? cur.assetId : null,
          basedOnVersion: cur && Number.isInteger(cur.version) ? cur.version : null,
        });
        if (v) { persist(); refresh(); }
        return v;
      },

      setActive: (refKey, version) => prodOp(refinterp.setActive(docs.refInterp(), refKey, version)),
      setLocked: (refKey, on) => prodOp(refinterp.setLocked(docs.refInterp(), refKey, on)),

      /** The interpretation inputs for a shot — its bound INTERPRETATION-kind
       *  references, each with its active reading (or `read: false`). ONE
       *  derivation, shared by the prompt compiler, the Generation Input Set and
       *  the Inspector, so those three cannot disagree about what has been read. */
      forShot: (shotId) => refinterp.interpretationInputs(
        docs.refInterp(),
        referencesOfShot(shotId),
        assetreg.INTERPRETATION_KINDS,
      ),
    },

    // ------------------------------------------------------------------ //
    // 参考用途 (TASK-066 §4 / §5) — 「这个参考服务主要画面，还是视频编排，还是两者」.
    //
    // The card's `⋮` menu writes here, and `referenceInputs` (ui/storyboard.js) reads
    // it when it splits the bound list for the two compilers — so a choice made in
    // the menu really changes what the Prompt says. Without that read it would be a
    // control that does nothing, which is the empty promise this codebase keeps
    // catching itself at.
    //
    // A choice equal to the role's own default is stored as NOTHING (see
    // refuse.setUse): 「按类型推导」 and 「恰好选了同一边」 must stay distinguishable.
    // ------------------------------------------------------------------ //
    use: {
      USES: refuse.USES,
      USE_LABEL: refuse.USE_LABEL,
      USE_CHIP: refuse.USE_CHIP,

      /** Which sides this role may serve — from what the COMPILERS read, so the menu
       *  can never offer a switch the prompt compiler ignores (§5 「语义允许时」). */
      allowed: (role) => refuse.allowedUses(role),

      /** `{ use, source }` — `source` is "creator" or "role", so the card can say
       *  whether the creator set it or it was derived. */
      effective: (shotId, refKey, role) =>
        refuse.effectiveUse(docs.refUse(), shotId, refKey, role),

      /** The two groups the LEFT column renders. A `both` reference is in BOTH. */
      groups: (shotId) =>
        refuse.groupsForShot(docs.refUse(), shotId, referencesOfShot(shotId)),

      set: (shotId, refKey, use, role) =>
        prodOp(refuse.setUse(docs.refUse(), shotId, refKey, use, role)),
      clear: (shotId, refKey) => prodOp(refuse.clearUse(docs.refUse(), shotId, refKey)),
    },
  };
}

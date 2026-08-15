// SUBTITLE controller (ADR-0061 决策 6 / §44–§45) — automatic by default.
//
// TASK-073 §1.8, same pattern as `lockctl.js`: documents arrive as GETTERS because
// the bindings are module-level `let`s reassigned on project load.
//
// `_writeCue` came WITH it. It was a module-level helper in app.js used only by this
// controller's `update` / `applyFix`, and it holds the one rule that is easy to get
// wrong twice: a merge-plus-edit either applies WHOLE or not at all. Leaving it
// behind would have put the transaction and its only callers in different files.

/**
 * @param {object} deps
 *   docs      `{ subtitles, production, timelines }` — GETTERS
 *   modules   `{ subtitle, timeline }`
 *   findShot  `(shotId) => shot | null`
 *   isCueLocked `(cueId) => boolean`
 *   prodOp / prodNew  persist + refresh on a truthy result, and return it
 *   persist / refresh
 *   now       `() => string` — the timestamp source, injected so a test is
 *             deterministic and this module owns no clock
 */
export function createSubtitleController({
  docs, modules, findShot, isCueLocked, prodOp, prodNew, persist, refresh, now,
}) {
  const { subtitle, timeline } = modules;

  const track = () => subtitle.trackFor(docs.subtitles(), docs.production().activeEpisodeId);

  /**
   * Write one subtitle cue: a merge, a field edit, or BOTH (TASK-072 §1.9 缺陷 6).
   *
   * The two used to be exclusive branches — `mergeWithNext === true` took the merge
   * path and every other field in the same fix (`text`, `startMs`, `endMs`,
   * `speaker`) was SILENTLY DROPPED while the surface reported success. A Subtitle
   * Reviewer that says 「合并这两条，并把文字改成…」 is one fix, not two, and half of
   * it landing is worse than none: the creator sees 已应用 and the text they were
   * shown is not what is in the track.
   *
   * BOTH OR NEITHER. The merge runs first (the field edit describes the merged
   * window), and if the edit is then refused — a lock, a bad value — the merge is
   * ROLLED BACK from a snapshot so the track never keeps half a fix.
   *
   * (The doc block travelled with the function. Left behind in app.js it came to sit
   * above `prodOp`, attributing this transaction to a helper that performs no part
   * of it — independent review.)
   */
  function writeCue(cueId, fields, { force = false, origin = null } = {}) {
    const t = track();
    if (!t || fields == null || typeof fields !== "object") return false;
    const at = now();
    const isLocked = (id) => isCueLocked(id);
    const opts = { at, force, isLocked, ...(origin ? { origin } : {}) };
    const rest = {};
    for (const k of Object.keys(fields)) {
      if (k !== "mergeWithNext") rest[k] = fields[k];
    }
    const hasRest = Object.keys(rest).length > 0;
    if (fields.mergeWithNext !== true) {
      return !!subtitle.updateCue(t, cueId, rest, opts);
    }
    // A DEEP snapshot. `slice()` copies the ARRAY but not the cues in it, and
    // `mergeCue` mutates the surviving cue in place (text, endMs, speaker) — so
    // restoring the array put back the next cue while the merged one KEPT its merged
    // text, producing duplicated/overlapping subtitles: exactly the half-applied fix
    // this function exists to prevent (independent review, batch 3).
    const snapshot = t.cues.map((c) => ({ ...c }));
    if (!subtitle.mergeCue(t, cueId, { at, isLocked })) return false;
    if (!hasRest) return true;
    if (!subtitle.updateCue(t, cueId, rest, opts)) {
      t.cues = snapshot; // refuse whole, keep nothing
      return false;
    }
    return true;
  }

  return {
    ADAPTERS: subtitle.ADAPTERS,
    STYLE_PRESETS: subtitle.STYLE_PRESETS,
    track,
    overlaps: () => subtitle.overlaps(track()),

    /** Case A: dialogue text + the CUT's timing → cues. The timing comes from the
     *  timeline because that is what the viewer sees; using the shot's nominal
     *  duration would drift from the picture the moment anything was trimmed. */
    generate: () => {
      const t = timeline.timelineFor(docs.timelines(), docs.production().activeEpisodeId);
      const rows = [];
      // `liveClips`, NOT `clipsOf` (TASK-072 §1.9 缺陷 5). `clipsOf` excludes
      // removed clips by default TODAY, but the cut's definition of 「in the
      // picture」 is `liveClips` — one definition, so the SRT, the render and the
      // duration cannot disagree. Generating cues for a clip the viewer will never
      // see ships a subtitle describing a shot that is not in the film.
      for (const c of timeline.liveClips(t)) {
        if (c.trackType !== "video") continue;
        if (!c.shotId) continue;
        const shot = findShot(c.shotId);
        if (!shot) continue;
        rows.push({
          shotId: c.shotId,
          startMs: Math.round(c.startTime * 1000),
          endMs: Math.round((c.startTime + (c.trimOut - c.trimIn)) * 1000),
          dialogue: shot.dialogue || "",
          // WHO speaks, ONLY where the shot itself names a speaker. Falling back
          // to the scene's first character would print a name nobody said — and a
          // subtitle attributing a line to the wrong character is worse than an
          // unattributed one, because it reads as a fact.
          speaker: typeof shot.speaker === "string" && shot.speaker ? shot.speaker : null,
        });
      }
      const res = subtitle.generateFromDialogue(track(), rows, {
        at: now(),
        isLocked: (cueId) => isCueLocked(cueId),
      });
      if (res.added.length) { persist(); refresh(); }
      return res;
    },

    /** An unavailable adapter answers with its real reason — no fake ASR (§45). */
    tryAdapter: (id) => subtitle.adapterUnavailable(id),

    update: (cueId, fields) => prodOp(writeCue(cueId, fields, { force: true })),

    /** A SKILL's edit of a cue — same write path, but the lock is enforced. */
    applyFix: (cueId, fields, meta = {}) =>
      prodOp(
        writeCue(cueId, fields, {
          force: false,
          origin: meta.skillRunId ? "skill" : "manual",
        }),
      ),

    add: (cue) => prodNew(subtitle.addCue(track(), cue)),
    remove: (cueId) => prodOp(subtitle.removeCue(track(), cueId, {
      isLocked: (id) => isCueLocked(id),
    })),
    split: (cueId, atMs, splitAtChar) => prodOp(subtitle.splitCue(track(), cueId, atMs, {
      splitAtChar, at: now(), isLocked: (id) => isCueLocked(id),
    })),
    setStyle: (style) => prodOp(subtitle.setStyle(track(), style)),

    /** SRT for the current track. Subtitles are NOT burned into the picture this
     *  round; an SRT beside the MP4 is the honest form of 「字幕交付」 without
     *  claiming a burn-in that did not happen. */
    srt: () => subtitle.toSRT(track()),
  };
}

// LOCK controller (ADR-0061 决策 5 / §50) — 「这个我定了」.
//
// Moved out of app.js as the FIRST step of TASK-073 §1.8, and the shape here is the
// pattern the remaining controllers follow.
//
// WHY IT COULD NOT BE A PLAIN MOVE. §1.8 asks for 「纯搬运」, and that is not
// achievable for these controllers: they closed over module-level `let` bindings
// (`locksDoc`, `promptsDoc`, `shotAudioDoc`, `frameBindingsDoc`, `refInterpDoc`) that
// are REASSIGNED whenever a project is loaded. A factory capturing their VALUES would
// keep mutating the previous project's documents — the same class of defect as a
// stale alias, and silent. So every document arrives as a GETTER, read at call time,
// which preserves the original semantics exactly (a closure over a `let` also reads
// at call time).
//
// WHAT THIS BUYS BESIDES SIZE: the lock router is now constructible with fake
// documents, so it can be tested at all. In app.js it was unreachable from any test
// — nothing imports app.js, because it touches the DOM at module scope. 「四个存储的
// 锁路由」 is exactly the kind of logic that deserves a test: it is the ONE predicate
// every automated writer consults, and a scope routed to the wrong store means
// automation silently overwrites something the creator pinned.
//
// One predicate (`is`) that every automated writer consults. The three locks that
// live on their own documents (prompt / audio clip / frame binding) are routed here
// too, so a caller has ONE lock API and cannot reach half of them.

/**
 * @param {object} deps
 *   docs        `{ locks, prompts, shotAudio, frameBindings, refInterp }` — each a
 *               GETTER returning the current document (see the note above)
 *   modules     `{ locksdoc, promptdoc, shotaudio, framebind, refinterp }`
 *   findShotAudioClip  `(clipId) => { shotId, clip } | null`
 *   prodOp      persists + refreshes on a truthy result, and returns it
 *   now         `() => string` — the timestamp source, injected so a test is
 *               deterministic and this module owns no clock
 */
export function createLockController({ docs, modules, findShotAudioClip, prodOp, now }) {
  const { locksdoc, promptdoc, shotaudio, framebind, refinterp } = modules;
  const kindOf = (raw) => (raw === "video" ? "video" : "image");
  const split = (id) => String(id || "").split("|");

  return {
    SCOPES: locksdoc.SCOPES,

    is: (scope, id) => {
      if (scope === "prompt") {
        // a prompt lock is keyed by shot+kind and stored on promptdoc
        const [shotId, kind] = split(id);
        const e = promptdoc.entryOf(docs.prompts(), shotId, kindOf(kind));
        return !!(e && e.locked === true);
      }
      if (scope === "audioClip") {
        const hit = findShotAudioClip(id);
        return !!(hit && hit.clip.locked === true);
      }
      if (scope === "frameBinding") {
        const [shotId, type] = split(id);
        const b = framebind.bindingOf(docs.frameBindings(), shotId, type);
        return !!(b && b.locked === true);
      }
      return locksdoc.isLocked(docs.locks(), scope, id);
    },

    /** Lock / unlock. Routed to whichever document owns that scope's flag, so a
     *  UI toggle never has to know which of the four stores it is talking to. */
    set: (scope, id, on) => {
      let ok = false;
      if (scope === "prompt") {
        const [shotId, kind] = split(id);
        ok = promptdoc.setLocked(docs.prompts(), shotId, kindOf(kind), on === true);
      } else if (scope === "audioClip") {
        const hit = findShotAudioClip(id);
        ok = !!hit && shotaudio.setLocked(docs.shotAudio(), hit.shotId, id, on === true);
      } else if (scope === "frameBinding") {
        const [shotId, type] = split(id);
        ok = framebind.setLocked(docs.frameBindings(), shotId, type, on === true);
      } else {
        ok = locksdoc.set(docs.locks(), scope, id, on === true, { at: now() });
      }
      return prodOp(ok);
    },

    /** EVERY lock in force, across all four stores.
     *
     *  Counting only the lock document under-reported: a locked Prompt, a locked
     *  audio clip and a locked frame binding are locks the creator set and automation
     *  obeys, and the console's 「锁定 N 项」 and the Final Render's `locksInForce`
     *  both print this number. A count that silently omits three of the eight scopes
     *  is a wrong number in a provenance record. */
    count: () => {
      let n = locksdoc.count(docs.locks());
      const prompts = docs.prompts();
      for (const shotId of Object.keys(prompts)) {
        for (const kind of promptdoc.PROMPT_KINDS) {
          const e = promptdoc.entryOf(prompts, shotId, kind);
          if (e && e.locked === true) n += 1;
        }
      }
      const audio = docs.shotAudio();
      for (const shotId of Object.keys(audio)) {
        for (const c of shotaudio.clipsOf(audio, shotId)) if (c.locked) n += 1;
      }
      const frames = docs.frameBindings();
      for (const shotId of Object.keys(frames)) {
        for (const t of framebind.BINDING_TYPES) {
          const b = framebind.bindingOf(frames, shotId, t);
          if (b && b.locked === true) n += 1;
        }
      }
      // …and the reference READINGS, which carry their own lock too
      const interp = docs.refInterp();
      for (const key of Object.keys(interp)) {
        const e = refinterp.entryOf(interp, key);
        if (e && e.locked === true) n += 1;
      }
      return n;
    },

    list: (scope) => locksdoc.listScope(docs.locks(), scope),
  };
}

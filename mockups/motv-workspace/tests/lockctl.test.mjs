// TASK-073 §1.8 — the lock controller, extracted from app.js and testable at last.
//
// It was unreachable from any test while it lived in app.js (nothing imports app.js —
// it touches the DOM at module scope). That matters for THIS controller in particular:
// `is()` is the one predicate every automated writer consults, and a scope routed to
// the wrong store means automation silently overwrites something the creator pinned.
import test from "node:test";
import assert from "node:assert/strict";

import { createLockController } from "../src/controllers/lockctl.js";

/** Minimal stand-ins for the five documents and their modules. */
function harness(over = {}) {
  const state = {
    locks: over.locks || { shot: { s1: { at: "t" } } },
    prompts: over.prompts || { s1: { image: { locked: true }, video: { locked: false } } },
    shotAudio: over.shotAudio || { s1: [{ clipId: "c1", locked: true }] },
    frameBindings: over.frameBindings || { s1: { startFrame: { locked: true } } },
    refInterp: over.refInterp || { "ref-1": { locked: true } },
  };
  const persisted = [];
  const ctl = createLockController({
    docs: {
      locks: () => state.locks,
      prompts: () => state.prompts,
      shotAudio: () => state.shotAudio,
      frameBindings: () => state.frameBindings,
      refInterp: () => state.refInterp,
    },
    modules: {
      locksdoc: {
        SCOPES: { shot: {}, timelineClip: {} },
        isLocked: (doc, scope, id) => !!(doc[scope] && doc[scope][id]),
        set: (doc, scope, id, on, opts) => {
          persisted.push({ store: "locks", scope, id, on, at: opts.at });
          doc[scope] = doc[scope] || {};
          if (on) doc[scope][id] = { at: opts.at };
          else delete doc[scope][id];
          return true;
        },
        count: (doc) => Object.values(doc).reduce((n, m) => n + Object.keys(m).length, 0),
        listScope: (doc, scope) => Object.keys(doc[scope] || {}),
      },
      promptdoc: {
        PROMPT_KINDS: ["image", "video"],
        entryOf: (doc, shotId, kind) => (doc[shotId] ? doc[shotId][kind] : null),
        setLocked: (doc, shotId, kind, on) => {
          persisted.push({ store: "prompts", shotId, kind, on });
          if (!doc[shotId] || !doc[shotId][kind]) return false;
          doc[shotId][kind].locked = on;
          return true;
        },
      },
      shotaudio: {
        clipsOf: (doc, shotId) => doc[shotId] || [],
        setLocked: (doc, shotId, clipId, on) => {
          persisted.push({ store: "shotAudio", shotId, clipId, on });
          const c = (doc[shotId] || []).find((x) => x.clipId === clipId);
          if (!c) return false;
          c.locked = on;
          return true;
        },
      },
      framebind: {
        BINDING_TYPES: ["startFrame", "endFrame"],
        bindingOf: (doc, shotId, type) => (doc[shotId] ? doc[shotId][type] : null),
        setLocked: (doc, shotId, type, on) => {
          persisted.push({ store: "frameBindings", shotId, type, on });
          if (!doc[shotId] || !doc[shotId][type]) return false;
          doc[shotId][type].locked = on;
          return true;
        },
      },
      refinterp: { entryOf: (doc, key) => doc[key] || null },
    },
    findShotAudioClip: (clipId) => {
      for (const shotId of Object.keys(state.shotAudio)) {
        const c = state.shotAudio[shotId].find((x) => x.clipId === clipId);
        if (c) return { shotId, clip: c };
      }
      return null;
    },
    prodOp: (ok) => ok,
    now: () => "2026-08-15T00:00:00.000Z",
  });
  return { ctl, state, persisted };
}

test("`is` routes each scope to the store that OWNS that flag", () => {
  const { ctl } = harness();
  // the three that live on their own documents
  assert.equal(ctl.is("prompt", "s1|image"), true);
  assert.equal(ctl.is("prompt", "s1|video"), false);
  assert.equal(ctl.is("audioClip", "c1"), true);
  assert.equal(ctl.is("frameBinding", "s1|startFrame"), true);
  assert.equal(ctl.is("frameBinding", "s1|endFrame"), false, "absent binding is not locked");
  // …and everything else on the lock document
  assert.equal(ctl.is("shot", "s1"), true);
  assert.equal(ctl.is("shot", "s2"), false);
  // an unknown id/scope is NOT locked — a wrong `true` would block a legitimate write
  assert.equal(ctl.is("audioClip", "nope"), false);
  assert.equal(ctl.is("prompt", "nope|image"), false);
});

test("a malformed composite id degrades to a miss, never a throw", () => {
  // `is` is consulted on every automated write; throwing here would take down the
  // write path rather than refuse one lock lookup
  const { ctl } = harness();
  for (const id of [null, undefined, "", "|image", 42]) {
    assert.equal(ctl.is("prompt", id), false, String(id));
  }
  for (const id of [null, undefined, "", "s1", "s1|", "|start", 42]) {
    assert.equal(ctl.is("frameBinding", id), false, String(id));
  }
});

test("PRESERVED-AS-IS: a `prompt` id with no `|kind` is read as the IMAGE lock", () => {
  // Found by this test, and DELIBERATELY NOT CHANGED here. The original code is
  // `kind === "video" ? "video" : "image"`, so a bare `"s1"` (kind `undefined`)
  // resolves to the image prompt — meaning `is("prompt", "s1")` answers about a lock
  // the caller did not name.
  //
  // §1.8's discipline is 「一次提交只移动代码不改行为」, and this extraction is that
  // commit. Tightening it is a behaviour change with real call sites behind it (a
  // caller may be relying on the bare form meaning image), so it is recorded as a
  // follow-up in TASK-073 §5.10 rather than smuggled into a move.
  const { ctl } = harness();
  assert.equal(ctl.is("prompt", "s1"), true, "bare id → image lock (original semantics)");
  assert.equal(ctl.is("prompt", "s1|"), true, "empty kind → image lock (original semantics)");
});

test("`prompt` kind defaults to image for anything that is not `video`", () => {
  // the original behaviour, preserved verbatim: `kind === "video" ? "video" : "image"`
  const { ctl, persisted } = harness();
  ctl.set("prompt", "s1|nonsense", true);
  assert.equal(persisted.at(-1).kind, "image");
  ctl.set("prompt", "s1|video", true);
  assert.equal(persisted.at(-1).kind, "video");
});

test("`set` writes to the owning store, and the injected clock is the only clock", () => {
  const { ctl, state, persisted } = harness();
  ctl.set("shot", "s2", true);
  const rec = persisted.at(-1);
  assert.equal(rec.store, "locks");
  assert.equal(rec.at, "2026-08-15T00:00:00.000Z", "the timestamp comes from `now`, injected");
  assert.equal(state.locks.shot.s2.at, "2026-08-15T00:00:00.000Z");
  // unlocking an audio clip reaches the audio document, not the lock document
  ctl.set("audioClip", "c1", false);
  assert.equal(persisted.at(-1).store, "shotAudio");
  assert.equal(state.shotAudio.s1[0].locked, false);
  // an unresolvable clip is a refusal, not a write elsewhere
  assert.equal(ctl.set("audioClip", "missing", true), false);
});

test("`count` spans ALL stores — omitting three of them is a wrong provenance number", () => {
  const { ctl } = harness();
  // 1 lock doc entry + 1 locked prompt + 1 locked audio clip + 1 locked binding
  // + 1 locked reading = 5
  assert.equal(ctl.count(), 5);
  // …and it follows the documents as they change
  const empty = harness({
    locks: {}, prompts: {}, shotAudio: {}, frameBindings: {}, refInterp: {},
  });
  assert.equal(empty.ctl.count(), 0);
});

test("the documents are read through GETTERS — a project switch is followed", () => {
  // THE REASON THIS IS NOT A PLAIN MOVE. `locksDoc` and friends are module-level
  // `let`s that project loading REASSIGNS. A factory that captured their values would
  // keep reading (and writing) the previous project's documents forever — silently.
  const { ctl, state } = harness();
  assert.equal(ctl.is("shot", "s1"), true);
  // simulate a project load replacing the whole document object
  state.locks = { shot: { other: { at: "t" } } };
  assert.equal(ctl.is("shot", "s1"), false, "still reading the OLD document");
  assert.equal(ctl.is("shot", "other"), true);
  assert.deepEqual(ctl.list("shot"), ["other"]);
});

test("SCOPES is re-exported from the lock document module, not redefined", () => {
  // two lists of scopes would drift, and the drift shows up as a scope the UI can
  // toggle but no writer consults
  const { ctl } = harness();
  assert.deepEqual(Object.keys(ctl.SCOPES), ["shot", "timelineClip"]);
});

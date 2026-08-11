// Autosave binding for canonical TEXT fields (TASK-057 persistence fix).
//
// THE RULE this enforces: a creator's typing reaches the canonical document —
// and therefore studio/canvas.json — while they are still typing. Binding a
// field only to `change` means the value lives nowhere but the DOM until the
// element happens to lose focus, so a browser refresh (or closing the tab)
// while the caret is still in the field loses it silently. That is exactly the
// blocker this module exists to prevent; the script textarea already used the
// right idiom (write on `input`, never re-render mid-typing) and every upstream
// field now uses it too.
//
// TWO complications this handles:
//
// 1. Some controllers re-render. `ctx.story.editBrief` only persists, but every
//    `ctx.canon.*` / `ctx.bible.*` write goes through the shell's prodOp, which
//    re-renders the whole Production surface. Re-rendering on each keystroke
//    would destroy the textarea the creator is typing in. So writes are
//    DEBOUNCED, and the focused field + caret are recorded before the write and
//    restored after the re-render — the caret survives.
// 2. A pending write must not be lost by navigation. The value is captured in
//    the closure at schedule time (never read back off a detached element), and
//    `flushFields` commits anything still pending.
//
// No DOM is created here and no domain rule lives here: this module only decides
// WHEN a write happens, never what it writes.

/** Debounce delay before a keystroke reaches the domain. Short enough that
 *  "type, pause, refresh" keeps the text; long enough that a re-rendering
 *  controller is not invoked per character. */
const WRITE_DELAY_MS = 300;

/** A field identity that survives a DOM rebuild: the tag plus every data-*
 *  attribute. The markup is deterministic, so the same field re-renders with
 *  the same key — no ids need to be added to the templates. */
function keyOf(el) {
  const data = el.dataset ? Object.entries({ ...el.dataset }).sort() : [];
  return `${el.tagName}|${JSON.stringify(data)}`;
}

/** Every shell state that currently has a field bound, so a page teardown can
 *  flush all of them. A Set of the `ui` objects themselves — they are the
 *  shells' own transient state and are dropped with the page. */
const _bound = new Set();

/** Per-shell transient sync state, hung off the shell's own `ui` object so it
 *  is never persisted and never shared between projects. */
function stateOf(ui) {
  if (!ui._fieldsync) ui._fieldsync = { timer: null, pending: null, focus: null };
  _bound.add(ui);
  return ui._fieldsync;
}

/** Commit every pending write across every bound shell. Called when the page is
 *  going away: a debounce that has not fired yet must not take the creator's
 *  last sentence with it. Exported for tests. */
export function flushAllFields() {
  let n = 0;
  for (const ui of _bound) {
    if (flushFields(ui)) n += 1;
  }
  return n;
}

// A RELOAD OR TAB CLOSE MUST NOT LOSE TYPING. `pagehide` fires for reloads,
// navigations and tab closes (and, unlike `beforeunload`, is reliable when the
// page enters the back/forward cache); `visibilitychange → hidden` is the signal
// that survives on mobile, where a tab can be terminated without `pagehide`.
//
// Both merely commit what is pending. The canonical write then reaches the
// canvas save, which is ALREADY in its immediate-keepalive mode by then —
// services/persist.js sets that flag from the same two events, before flushing
// anything — so the order the listeners happen to run in cannot leave a write
// sitting in a 700ms timer that a dying document will never fire.
//
// Registration is guarded so this module stays usable under `node --test`.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", flushAllFields);
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushAllFields();
    });
  }
}

/** Commit any write still waiting in the debounce window. Safe to call at any
 *  time (idempotent); returns true when something was actually written. */
export function flushFields(ui) {
  const s = stateOf(ui);
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  const p = s.pending;
  s.pending = null;
  if (!p) return false;
  p.write(p.value);
  return true;
}

/**
 * Bind ONE text field so its value autosaves.
 *
 * @param el         the input/textarea
 * @param ui         the shell's transient state object
 * @param write      (value) => void — the canonical controller call
 * @param opts.onInput  optional side effect per keystroke (e.g. a local buffer)
 */
export function bindField(el, ui, write, opts = {}) {
  const s = stateOf(ui);
  const schedule = (value) => {
    // A pending write for a DIFFERENT field must not be dropped by this one:
    // commit it first, then take the slot.
    if (s.pending && s.pending.key !== keyOf(el)) flushFields(ui);
    s.pending = { key: keyOf(el), value, write };
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      const p = s.pending;
      s.pending = null;
      if (p) p.write(p.value);
    }, WRITE_DELAY_MS);
  };
  // IME COMPOSITION. Chinese/Japanese input goes through a multi-keystroke
  // composition that fires `input` events for each intermediate state. Writing
  // during it would re-render the very textarea being composed in — cancelling
  // or committing a half-formed word. Since this product is written in Chinese,
  // that is the normal typing path, not an edge case: writes are suspended for
  // the duration of a composition and flushed when it ends.
  let composing = false;
  el.oncompositionstart = () => {
    composing = true;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; } // no write mid-word
  };
  el.oncompositionend = () => {
    composing = false;
    // the composed text is now final — persist it
    if (opts.onInput) opts.onInput(el.value);
    s.focus = { key: keyOf(el), start: el.selectionStart, end: el.selectionEnd, at: Date.now() };
    schedule(el.value);
  };
  el.oninput = () => {
    if (opts.onInput) opts.onInput(el.value);
    // remember where the caret is BEFORE any re-render the write may trigger
    s.focus = { key: keyOf(el), start: el.selectionStart, end: el.selectionEnd, at: Date.now() };
    // mid-composition the value is an intermediate IME state: keep it in the
    // local buffer (above) but do NOT write or re-render until it is committed
    if (composing) return;
    schedule(el.value);
  };
  // blur commits immediately — no reason to make the creator wait for the
  // debounce once they have moved on
  el.onchange = () => {
    composing = false; // a change event means the value is settled
    if (s.pending && s.pending.key === keyOf(el)) flushFields(ui);
    else write(el.value);
    if (opts.onChange) opts.onChange(el.value);
  };
}

/** Re-focus the field the creator was typing in and restore its caret. Called
 *  at the end of a workspace's bind, i.e. after every re-render. */
export function restoreFieldFocus(root, ui) {
  const s = stateOf(ui);
  const f = s.focus;
  if (!f) return;
  // Only restore focus if the creator was typing JUST NOW. An empty
  // activeElement is not proof they still want this field: a re-render that
  // removes the element they clicked also leaves activeElement at <body>, and
  // dragging focus back into the previous field would send their next keystrokes
  // somewhere they are not looking. The write debounce is 300ms, so a window a
  // little wider than that covers "the re-render my own typing caused" and
  // nothing else.
  const FOCUS_WINDOW_MS = 1000;
  if (!f.at || Date.now() - f.at > FOCUS_WINDOW_MS) {
    s.focus = null;
    return;
  }
  const active = root.ownerDocument && root.ownerDocument.activeElement;
  const idle = !active || active === root.ownerDocument.body;
  if (!idle) {
    s.focus = null;
    return;
  }
  for (const el of root.querySelectorAll("textarea,input")) {
    if (keyOf(el) !== f.key) continue;
    try {
      el.focus();
      if (typeof el.setSelectionRange === "function" && f.start != null) {
        el.setSelectionRange(f.start, f.end == null ? f.start : f.end);
      }
    } catch {
      /* a field type that rejects selection ranges (e.g. number) — focus is enough */
    }
    return;
  }
}

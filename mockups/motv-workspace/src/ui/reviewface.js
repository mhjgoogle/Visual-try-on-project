// 审阅面 — the shape of a surface AI WROTE and a creator REVIEWS (TASK-094 §1.2).
//
// Three pages need the same posture and were about to invent it three times:
// 分集规划 (TASK-088), 故事大纲 (TASK-089) and 作品设定 (TASK-090). So the posture
// lives here once.
//
// THE ONE RULE, in the product owner's own words (2026-08-17):
//
//   「为什么那么多重复的内容要写呢」
//
// 分集规划 laid out 6 characters × 48 episodes = 288 empty inputs that no
// capability produces a single character of, and every one of them read as work
// waiting to be done by hand. So:
//
//   AI WROTE IT      render it, editable, exactly as it is.
//   AI DID NOT       say so in ONE muted line with ONE way to write it yourself.
//                    Never a pre-laid-out grid of empty boxes.
//
// A RANGE IS A HINT, NEVER A GATE. 「主要剧情 3～6 条」 is guidance: too few or too
// many is FLAGGED and still saves. A creator part-way through an episode is not
// making an error, and blocking the save would make the flag their problem
// instead of the model's.
//
// PURE STRING BUILDING, like every other renderer here. This module owns the
// SHAPE; the caller owns the data hooks it passes in (`attrs`) and the controller
// those hooks write to — so a page keeps its existing `bindField` wiring and no
// second write path appears (TASK-094 §1.2 最后一条).
import { esc } from "../util/dom.js";

/**
 * Is this value something the AI actually wrote?
 *
 * A blank string, a whitespace-only string, an empty list and a null are all
 * ABSENT — the four ways "nothing was produced" arrives from a model answer, a
 * hydrated document and a sanitizer respectively. Treating any of them as
 * present is what puts an empty box on screen.
 */
export function written(value) {
  if (value == null) return false;
  if (typeof value === "string") return !!value.trim();
  if (Array.isArray(value)) return value.some((x) => written(x));
  if (typeof value === "object") return Object.values(value).some((x) => written(x));
  return true;
}

/**
 * The count flag for a ranged list: `null` when the count is fine, otherwise a
 * chip that STATES the deviation.
 *
 * Never a disabled button and never a refused save — see the module note.
 */
export function countNote(n, min, max, unit = "条") {
  const count = Number.isInteger(n) ? n : 0;
  // NOTHING WRITTEN IS NOT 「TOO FEW」. An empty list already says 「AI 没有写这一项」;
  // adding 「0 条 · 少于建议的 3～6 条」 beside it scolds the creator for an absence
  // that has already been stated once, and reads as a validation error on a
  // surface that deliberately blocks nothing.
  if (count === 0) return null;
  const lo = Number.isInteger(min) ? min : null;
  const hi = Number.isInteger(max) ? max : null;
  // A ONE-SIDED range is legitimate (「至少 1 条」 has no upper bound), so the
  // phrase is built from the bounds that actually exist — interpolating the
  // missing one printed guidance like 「1～null 条」 (codex review, batch 0).
  const range = lo !== null && hi !== null ? `${lo}～${hi}` : `${lo !== null ? lo : hi}`;
  const suffix = lo !== null && hi !== null ? "" : lo !== null ? " 以上" : " 以内";
  if (lo !== null && count < lo) {
    return {
      state: "short",
      text: `${count} ${unit} · 少于建议的 ${range}${suffix} ${unit}`,
      title: "这是提示，不是限制 —— 仍然可以保存",
    };
  }
  if (hi !== null && count > hi) {
    return {
      state: "over",
      text: `${count} ${unit} · 多于建议的 ${range}${suffix} ${unit}`,
      title: "这是提示，不是限制 —— 仍然可以保存",
    };
  }
  return null;
}

/** The count chip's markup, or "" when the count is within range. */
export function countChip(n, min, max, unit = "条") {
  const note = countNote(n, min, max, unit);
  if (!note) return "";
  return `<span class="chip gate rf-count" data-rf-count="${esc(note.state)}" title="${esc(note.title)}">${esc(note.text)}</span>`;
}

/**
 * ONE muted line for something the AI did not write, plus the way to write it
 * by hand — and nothing else.
 *
 * `addAttrs` is the caller's own hook for its 「自己写」 control. Omit it and the
 * absence is simply STATED: some fields (a derived one, a field the next run
 * will fill) have no sensible hand-entry action, and inventing a disabled button
 * for them would be another box that looks like work.
 */
export function absentRow(label, { addAttrs = "", addLabel = "自己写一条", why = "" } = {}) {
  return (
    `<div class="rf-absent" data-rf-absent="${esc(label)}">` +
    `<span class="k">${esc(label)}</span>` +
    `<span class="meta">${esc(why || "AI 没有写这一项")}</span>` +
    (addAttrs ? `<button class="btn sm" ${addAttrs}>＋ ${esc(addLabel)}</button>` : "") +
    `</div>`
  );
}

/**
 * One text facet of a review surface.
 *
 * WRITTEN  → a labelled, editable control carrying the caller's hooks.
 * ABSENT   → `absentRow`, i.e. one line, not a box.
 *
 * `force` renders the control even when the value is absent — for the facets a
 * creator explicitly opened for hand entry (see `absentRow`'s add action), and
 * for the ones that are the surface's whole subject (an episode's TITLE is its
 * name; a nameless row cannot be identified, so there has to be somewhere to
 * type it).
 */
export function reviewText(label, value, {
  attrs = "",
  rows = 0,
  hint = "",
  placeholder = "",
  force = false,
  addAttrs = "",
  addLabel = "自己写",
  why = "",
} = {}) {
  const text = typeof value === "string" ? value : "";
  if (!written(text) && !force) {
    // `addAttrs`, not `attrs`: the absent state's control REVEALS the field (a
    // page-level ui flag the caller then passes back as `force`), it does not
    // write to the document. Handing it the field's own write hook would bind a
    // click to a text-write handler.
    return absentRow(label, { addAttrs, addLabel, why });
  }
  const control = rows > 0
    ? `<textarea class="rf-t" rows="${rows}" spellcheck="false" placeholder="${esc(placeholder)}" ${attrs}>${esc(text)}</textarea>`
    : `<input class="rf-i" spellcheck="false" placeholder="${esc(placeholder)}" ${attrs} value="${esc(text)}">`;
  return (
    `<div class="rf-f"><span class="k">${esc(label)}</span>` +
    (hint ? `<span class="hint">${esc(hint)}</span>` : "") +
    control +
    `</div>`
  );
}

/**
 * A LIST facet: one row per item the AI actually produced, plus one 「add」.
 *
 * Never N blank rows. `rowAttrs(index)` gives each row the caller's own hook, so
 * the write path stays the page's existing one.
 *
 * `open` is the indices the creator explicitly opened for hand entry — an
 * appended (therefore blank) row, or one revealed from the absent state. Without
 * it 「＋ 添加一条」 would append an entry the blank-row filter immediately hides,
 * i.e. an add button that does nothing.
 *
 * `min`/`max` only produce a `countChip`; they never remove the add button and
 * never mark the surface invalid.
 */
export function reviewList(label, items, {
  rowAttrs = () => "",
  addAttrs = "",
  min = null,
  max = null,
  unit = "条",
  placeholder = "",
  addLabel = "添加一条",
  hint = "",
  rows = 0,
  open = null,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  // ROWS THE CREATOR EXPLICITLY OPENED. 「＋ 添加一条」 appends an entry that is by
  // definition blank, and the blank-row filter below would swallow it — so the
  // add action would do nothing visible and hand entry became impossible
  // (codex review, batch 0 round 2, blocking). An opened index is the caller's
  // page-level ui state, the same `force` idea `reviewText` already uses: a row
  // the creator ASKED for is not an empty box nobody wanted.
  const opened = open instanceof Set
    ? open
    : new Set(Array.isArray(open) ? open : open == null ? [] : [open]);
  // ONLY THE ENTRIES THAT WERE ACTUALLY WRITTEN GET A ROW (codex review, batch 0).
  // `written()` calls a blank string absent, and rendering one anyway recreated
  // the very empty-input surface this module exists to prevent — a model
  // answering `keyEvents: ["", ""]` would have put two empty boxes on screen.
  //
  // The ORIGINAL INDEX travels with each kept entry, so `rowAttrs(i)` still
  // addresses the caller's own array: filtering must not renumber the rows, or a
  // blank entry earlier in the list would shift every later row's write target.
  const kept = list
    .map((value, index) => ({ value, index }))
    .filter(({ value, index }) => written(value) || opened.has(index));
  const control = ({ value, index }) => (rows > 0
    ? `<textarea class="rf-t" rows="${rows}" spellcheck="false" placeholder="${esc(placeholder)}" ${rowAttrs(index)}>${esc(String(value ?? ""))}</textarea>`
    : `<input class="rf-i" spellcheck="false" placeholder="${esc(placeholder)}" ${rowAttrs(index)} value="${esc(String(value ?? ""))}">`);
  const body = kept.length
    ? kept.map((entry) => `<div class="rf-row">${control(entry)}</div>`).join("")
    : `<div class="meta rf-none">AI 没有写这一项</div>`;
  return (
    `<div class="rf-l" data-rf-list="${esc(label)}">` +
    `<div class="rf-lh"><span class="k">${esc(label)}</span>` +
    (hint ? `<span class="hint">${esc(hint)}</span>` : "") +
    // …and the range hint counts WRITTEN entries. Counting blank ones would
    // report 「3 条」 above two filled rows, and a row the creator just opened and
    // has not typed into yet is not a key event.
    countChip(list.filter((v) => written(v)).length, min, max, unit) +
    `</div>` +
    body +
    (addAttrs ? `<button class="btn sm rf-add" ${addAttrs}>＋ ${esc(addLabel)}</button>` : "") +
    `</div>`
  );
}

/**
 * 「这一面还没有跑过 AI」 — the state TASK-090 §2.5 names: a review surface with
 * nothing to review must SAY that, rather than presenting an empty form as if
 * the creator were expected to fill it in.
 *
 * `runAttrs` is the primary action. It is the only control here: the point of
 * this state is that there is exactly one thing to do.
 */
export function notRunYet(title, what, { runAttrs = "", runLabel = "让 AI 梳理一版" } = {}) {
  return (
    `<div class="rf-empty" data-rf-notrun><div class="ti">${esc(title)}</div>` +
    `<div class="meta">${esc(what)}</div>` +
    (runAttrs ? `<button class="btn primary" ${runAttrs}>✨ ${esc(runLabel)}</button>` : "") +
    `</div>`
  );
}

/**
 * Wire the two controls this module OWNS: 「＋ 添加」 and per-row 「删除」.
 *
 * Everything else on a review surface is the caller's own hook, bound by the
 * caller's own `bindField` call — this deliberately does not touch text fields,
 * because autosave/caret/IME behaviour belongs to ui/fieldsync.js and a second
 * implementation of it here is exactly the duplication this module exists to
 * avoid.
 */
export function bindReviewFace(root, { add, remove } = {}) {
  root.querySelectorAll("[data-rf-add]").forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      if (add) add(el.dataset.rfAdd, el.dataset);
    };
  });
  root.querySelectorAll("[data-rf-del]").forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      if (remove) remove(el.dataset.rfDel, el.dataset);
    };
  });
}

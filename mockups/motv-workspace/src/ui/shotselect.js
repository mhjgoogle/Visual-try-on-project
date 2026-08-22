// TOP of 剧集制作 — 当前制作对象 (TASK-066 §2).
//
//   EP01 《夜色微光》 ▼    Scene 02 酒吧相遇 ▼    SH05 林晚端起酒杯看向门口 ▼
//   SH05 · 林晚端起酒杯看向门口 ✎   时长 6s │ 镜头类型 中景 │ 情绪 戒备、试探
//
// THREE CASCADING SELECTORS, NOT TABS (§2 「不要用大 Tab 表达 Scene / Shot」). A tab
// strip says 「pick a mode」; a selector says 「pick the thing you are making」, which is
// the whole point of this space. Switching the Shot re-points every region at once —
// left references, centre graph, right Director, bottom search.
//
// THE CASCADE IS DERIVED, NEVER STORED TWICE. There is exactly one piece of state
// behind all three: the selected shot (`ui.selectedShotId`) plus the production
// document's own active episode. The Scene is DERIVED from the shot (`currentPlace`
// in epprod.js). A second stored 「current scene」 could disagree with 「current shot」
// the moment either moved, and the creator would be looking at a shot filed under a
// scene it is not in.
//
// PURE PRESENTATION over the centre's own view model.

import { esc } from "../util/dom.js";
import { episodeTitleBeside } from "./shell.js";
import { FOCUS_FILTERS, passesFocus } from "./epprod.js";

/** One dropdown. `open` is view state; the menu only exists while it is open, so a
 *  stale menu can never be left behind pointing at a shot that has moved. */
function picker(kind, { code, name, open, rows, empty, head = "" }) {
  return (
    `<div class="ss-sel${open ? " open" : ""}">` +
    `<button class="ss-btn" data-ss-open="${kind}">` +
    `<b>${esc(code)}</b>` +
    (name ? `<span class="nm">${esc(name)}</span>` : "") +
    `<span class="cv">▾</span></button>` +
    (open
      ? `<div class="ss-menu">${head}${rows.length
          ? rows.map((r) =>
              `<button class="${r.active ? "cur" : ""}" data-ss-pick="${kind}" data-id="${esc(r.id)}">` +
              `<b>${esc(r.code)}</b>${r.name ? ` <span class="nm">${esc(r.name)}</span>` : ""}` +
              (r.note ? `<span class="note">${esc(r.note)}</span>` : "") +
              `</button>`).join("")
          : `<div class="ss-none">${esc(empty)}</div>`}</div>`
      : "") +
    `</div>`
  );
}

/**
 * The selector bar + the current Shot's summary.
 *
 * `m` is `workbenchModel(ctx, ui)`, `place` is `currentPlace(m, ui.selectedShotId)` —
 * both passed in rather than recomputed, so this bar and the centre it sits above can
 * never disagree about which shot is current.
 */
export function renderShotSelect(ctx, ui, m, place) {
  const ep = m.episodes.find((e) => e.active) || m.episodes[0] || null;
  const epRows = m.episodes.map((e) => ({
    id: e.episodeId,
    code: e.code,
    name: episodeTitleBeside(e.code, e.title),
    active: e.active,
  }));
  const sceneRows = m.scenes.map((s, i) => ({
    id: s.sceneId,
    code: `Scene ${String(i + 1).padStart(2, "0")}`,
    name: s.title,
    note: `${s.shots.filter((c) => c.approved).length}/${s.shots.length}`,
    active: !!(place.scene && place.scene.sceneId === s.sceneId),
  }));
  if (m.unassignedTotal) {
    sceneRows.push({
      id: "",
      code: "未分配",
      name: "不属于任何场景的镜头",
      note: String(m.unassignedTotal),
      active: !place.scene && !!place.shot,
    });
  }
  const pool = place.shots || [];
  // THE FOCUS FILTER NARROWS THIS LIST (TASK-066). It used to sit in the centre header
  // filtering a wall of shot cards; the wall became this dropdown, so the filter came
  // with it — this is where a creator is choosing a shot, and 「只看还缺视频的」 is
  // exactly the question they are asking while they choose.
  const shotRows = pool
    .filter((c) => passesFocus(c, m.focus))
    .map((c, i) => ({
      id: c.shotId,
      code: `SH${String(c.seq != null ? c.seq : i + 1).padStart(2, "0")}`,
      name: c.title,
      note: c.approved ? "已通过" : c.hasVideo ? "有视频" : c.hasImage ? "有画面" : "待制作",
      active: !!(place.shot && place.shot.shotId === c.shotId),
    }));
  const hiddenByFocus = pool.length - shotRows.length;
  const curScene = sceneRows.find((r) => r.active) || null;
  const curShot = shotRows.find((r) => r.active) || null;
  const shot = place.shot || null;

  // THE SUMMARY. Only facets the draft really carries are printed; an unrecorded one
  // says 未记录 rather than being filled with a plausible default — the same rule the
  // Inspector's 设计 block follows.
  const facet = (label, value) =>
    `<span class="ss-facet"><i>${esc(label)}</i>` +
    (value ? esc(value) : `<u>未记录</u>`) + `</span>`;
  const summary = shot
    ? `<div class="ss-sum">` +
      `<div class="ss-sumt">` +
      `<b>${esc(curShot ? curShot.code : "")} · ${esc(shot.title || "未命名镜头")}</b>` +
      `<button class="ss-edit" data-ss-rename="${esc(shot.shotId)}" title="重命名这个镜头">✎</button>` +
      `</div>` +
      `<div class="ss-facets">` +
      facet("时长", shot.duration ? `${shot.duration}s` : "") +
      facet("镜头类型", shot.shotSize) +
      facet("情绪", shot.emotion) +
      `</div></div>`
    : `<div class="ss-sum"><div class="ss-sumt"><b>还没有选中镜头</b></div></div>`;

  return (
    `<div class="ss">` +
    picker("ep", {
      code: ep ? ep.code : "—",
      name: ep ? episodeTitleBeside(ep.code, ep.title) : "",
      open: ui.ssOpen === "ep",
      rows: epRows,
      empty: "还没有剧集",
    }) +
    picker("scene", {
      code: curScene ? curScene.code : "—",
      name: curScene ? curScene.name : "",
      open: ui.ssOpen === "scene",
      rows: sceneRows,
      empty: "这一集还没有场景",
    }) +
    picker("shot", {
      code: curShot ? curShot.code : "—",
      name: curShot ? curShot.name : "",
      open: ui.ssOpen === "shot",
      rows: shotRows,
      empty: hiddenByFocus ? "没有镜头符合当前聚焦" : "这个场景还没有镜头",
      // the five filters live in the picker's own head, above the list they narrow
      head: `<div class="ss-focus"><span class="lb">聚焦</span>` +
        FOCUS_FILTERS.map(([k, label]) =>
          `<button class="ss-fbtn${m.focus === k ? " on" : ""}" data-ss-focus="${esc(k)}">${esc(label)}</button>`).join("") +
        (hiddenByFocus ? `<span class="note">${hiddenByFocus} 个不在聚焦内</span>` : "") +
        `</div>`,
    }) +
    // 上一个 / 下一个 —— walking the scene in order is what a creator actually does,
    // and it is two clicks fewer than opening the dropdown每次
    `<div class="ss-step">` +
    `<button class="ss-nav" data-ss-step="-1"${shotRows.findIndex((r) => r.active) > 0 ? "" : " disabled"} title="上一个镜头">◀</button>` +
    `<button class="ss-nav" data-ss-step="1"${
      shotRows.findIndex((r) => r.active) >= 0 && shotRows.findIndex((r) => r.active) < shotRows.length - 1 ? "" : " disabled"
    } title="下一个镜头">▶</button>` +
    `</div>` +
    summary +
    `</div>`
  );
}

/**
 * Bind the bar.
 *
 * `selectShot` is the shell's ONE shot-selection path (it releases the transient
 * buffers), and `enterEpisode` is the shell's episode switch. Neither is
 * re-implemented here: this bar decides WHAT was picked, never what picking means.
 */
export function bindShotSelect(root, ctx, ui, render, { selectShot, enterEpisode, m, place } = {}) {
  root.querySelectorAll("[data-ss-open]").forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation();
    const k = b.dataset.ssOpen;
    ui.ssOpen = ui.ssOpen === k ? null : k;
    render();
  }));

  root.querySelectorAll("[data-ss-focus]").forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation();
    ui.epFocus = b.dataset.ssFocus;
    // the menu STAYS open: the creator is narrowing a list they are still reading, and
    // closing it would make them reopen it to see the result of their own click
    render();
  }));
  root.querySelectorAll("[data-ss-pick]").forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation();
    const kind = b.dataset.ssPick;
    const id = b.dataset.id;
    ui.ssOpen = null;
    if (kind === "ep") {
      if (enterEpisode) enterEpisode(id);
      else render();
      return;
    }
    if (kind === "shot") {
      if (selectShot) selectShot(id);
      else render();
      return;
    }
    // A SCENE is not a thing you produce, so picking one moves to its first shot.
    // Standing on a scene with no shot selected would leave every other region with
    // nothing to show.
    //
    // THE ACTIVE FOCUS FILTER APPLIES. Taking `pool[0]` blindly could select a shot the
    // Shot picker does not even list under the current focus — the creator would then be
    // standing on something they cannot see in the list they just used (codex review
    // round 2). A scene with nothing in focus falls back to its first shot rather than
    // selecting nothing: the filter narrows what is offered, it does not make a real
    // scene unreachable.
    const pool = id
      ? ((m && m.scenes.find((s) => s.sceneId === id)) || { shots: [] }).shots
      : (m && m.unassigned) || [];
    const focused = pool.filter((c) => passesFocus(c, m && m.focus));
    const next = focused[0] || pool[0] || null;
    if (next && selectShot) selectShot(next.shotId);
    else render();
  }));

  root.querySelectorAll("[data-ss-step]").forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation();
    if (b.hasAttribute("disabled")) return;
    const pool = (place && place.shots) || [];
    const i = pool.findIndex((c) => place.shot && c.shotId === place.shot.shotId);
    const next = pool[i + Number(b.dataset.ssStep)];
    if (next && selectShot) selectShot(next.shotId);
  }));

  const rename = root.querySelector("[data-ss-rename]");
  if (rename)
    rename.onclick = (ev) => {
      ev.stopPropagation();
      const shotId = rename.dataset.ssRename;
      const cur = place && place.shot ? place.shot.title : "";
      const t = window.prompt("镜头标题", cur || "");
      if (t == null) return;
      // A shot's title lives on the DRAFT, and editing the draft creates a new
      // immutable version — so this goes through `ctx.shots.saveEdit`, the one write
      // path, rather than mutating the row in place.
      const draft = (ctx.prodData().draftShots || []).map((s) => ({ ...s }));
      const hit = draft.find((s) => s && s.shotId === shotId);
      if (!hit) { ctx.toast("这个镜头不在当前草稿里"); return; }
      hit.title = t.trim();
      if (!ctx.shots.saveEdit(draft)) ctx.toast("无法保存新的草稿版本");
      render();
    };
}

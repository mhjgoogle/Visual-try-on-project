// Manual shot editor (人工 Gate): open with the current draft's shots, let the
// user edit titles/descriptions/durations and add/remove shots, then hand the
// result back via onSave — the CALLER creates a NEW immutable version (never
// overwrites history, per §1.2). All user/agent text is escaped on render.
import { $, esc } from "../util/dom.js";
import { mintId } from "../workflow/identity.js";

/** How many shots ONE EPISODE may hold.
 *
 *  MUST EQUAL `_MAX_SHOTS_PER_EPISODE` in `server.py`, and a guard test pins the
 *  two together — they cannot share a constant across Python and JS, so the
 *  agreement is enforced rather than hoped for.
 *
 *  This was the THIRD hard-coded `20` (independent review, 2026-08-15). The
 *  other two were raised together and this one was missed, which produced a
 *  self-contradiction the creator would hit immediately: a real episode draft
 *  holds ~42 shots, and pressing 「+ 添加镜头」 on it refused with 「最多 20 个
 *  镜头」 — a limit the list in front of them had already passed. That is the
 *  whole reason a shared ceiling has to be one NAMED value with a guard, not a
 *  literal repeated wherever a check happens to be needed. */
export const MAX_SHOTS_PER_EPISODE = 120;

/** Normalize edited shots for a NEW immutable draft version (pure — used by
 *  the save handler, exported for tests). Identity semantics (M2):
 *  - a surviving shot keeps its `shotId` no matter how its fields changed or
 *    where it moved in the list — identity is carried, never re-derived;
 *  - a shot without one (newly added here, or derived from display-only demo
 *    rows) mints a fresh `shotId`;
 *  - `slot` keeps its EXACT legacy behavior: surviving shots keep their slot
 *    (their uploaded media follows them), new shots get `<prefix>-<i>`.
 *  M8 creative facets (action / cameraMotion / dialogue) are OPTIONAL additive
 *  fields on the raw shot: carried when non-empty, omitted when blank — the
 *  lock/paid pipeline reads only the fields it always did. */
export function normalizeShots(items, slotPrefix) {
  return items.map((s, i) => {
    const out = {
      shotId: typeof s.shotId === "string" && s.shotId ? s.shotId : mintId("shot"),
      sequence: i + 1,
      title: s.title.trim().slice(0, 80),
      description: (s.description || "").trim().slice(0, 500) || s.title.trim(),
      duration_seconds: s.duration_seconds === 10 ? 10 : 6,
      slot: s.slot || `${slotPrefix}-${i + 1}`,
    };
    // Every additive draft-shot field has to survive a save. shotSize / angle /
    // emotion are shown as the storyboard's compact metadata AND compiled into
    // the image prompt, so omitting them here meant editing ANY field silently
    // erased the shot's framing — the edit saved, the directing did not.
    for (const k of ADDITIVE_SHOT_FIELDS) {
      const v = typeof s[k] === "string" ? s[k].trim().slice(0, 500) : "";
      if (v) out[k] = v;
    }
    // 软删除标记必须活过**每一条**保存路径（TASK-097 批次 4B）。
    // 它是对象，`ADDITIVE_SHOT_FIELDS` 全是字符串，所以单独带 —— 漏掉它的后果与
    // 上面那段注释里「编辑任何字段都会静默擦掉景别」是同一类，只是更糟：
    // 保存一次就把回收区里的镜头**复活成存活镜头**，而没有任何一处会喊。
    const d = s.deleted;
    if (d && typeof d === "object" && typeof d.at === "string" && d.at.trim()) {
      out.deleted = typeof d.by === "string" && d.by
        ? { at: d.at, by: d.by }
        : { at: d.at };
    }
    return out;
  });
}

/** The OPTIONAL draft-shot fields that ride additively on a raw shot.
 *
 *  ONE list, because this is the third place that had to know it and the first
 *  two disagreed: `normalizeShots` carried six of them while `open()` below
 *  deep-copied only the base four, so passing a draft through the manual editor
 *  ERASED 景别/角度/情绪 from every shot in it. A field is only additive if it
 *  survives every save path, not just the one it was added for.
 *
 *  `expression` and `environmentMotion` are here because `workflow/promptc.js`
 *  compiles them; `lighting` (光影氛围) and `color` (行标记) are TASK-078 §2.1/§2.2
 *  additions. None of them is required and none triggers a migration. */
export const ADDITIVE_SHOT_FIELDS = [
  "action", "cameraMotion", "dialogue", "shotSize", "angle", "emotion",
  "expression", "environmentMotion", "lighting", "color",
  // `sfxNote`（音效需求）是 TASK-087 §3.5.2 的加法字段：以前镜头上没有任何地方
  // 写「这一镜需要什么音效」，于是逐镜质检对音效永远只能答无法判定。
  // 登记在这里，是因为上面那句话 —— 只在一条保存路径上活下来的字段不叫加法字段。
  "sfxNote",
];

/** The next draft version number: max existing + 1 — NEVER length + 1. The
 *  connected restore filters non-draft versions, so surviving numbers can be
 *  noncontiguous; length+1 would mint a DUPLICATE v and corrupt the
 *  current-version lookup. Pure, exported for tests. */
export function nextDraftVersion(versions) {
  return (
    (Array.isArray(versions) ? versions : []).reduce(
      (m, x) => Math.max(m, Number.isInteger(x && x.v) ? x.v : 0),
      0,
    ) + 1
  );
}

export function createShotEditor({ toast }) {
  const scrim = $("#se-scrim");
  const body = $("#se-b");
  const sub = $("#se-sub");
  let items = [];
  let onSave = null;
  let slotPrefix = "m";
  const close = () => scrim.classList.remove("show");

  function render() {
    body.innerHTML = items
      .map(
        (s, i) => `
      <div class="se-item" data-i="${i}">
        <div class="se-top"><span class="se-n">${String(i + 1).padStart(2, "0")}</span>
          <input data-f="title" value="${esc(s.title)}" placeholder="镜头名（必填）" maxlength="80">
          <select data-f="duration_seconds"><option value="6"${s.duration_seconds === 10 ? "" : " selected"}>6s</option><option value="10"${s.duration_seconds === 10 ? " selected" : ""}>10s</option></select>
          <button class="se-del" data-del="${i}" title="删除镜头">✕</button></div>
        <textarea data-f="description" placeholder="画面内容（可直接用作生成提示词）" maxlength="500">${esc(s.description)}</textarea>
      </div>`,
      )
      .join("");
    // Field edits update items in place; only add/delete re-renders.
    body.querySelectorAll(".se-item").forEach((it) => {
      const i = +it.dataset.i;
      it.querySelectorAll("[data-f]").forEach((f) => {
        f.oninput = () => {
          items[i][f.dataset.f] =
            f.dataset.f === "duration_seconds" ? +f.value : f.value;
        };
      });
      const del = it.querySelector("[data-del]");
      if (del)
        del.onclick = () => {
          items.splice(i, 1);
          render();
        };
    });
  }

  $("#se-x") && ($("#se-x").onclick = close);
  $("#se-cancel").onclick = close;
  $("#se-add").onclick = () => {
    if (items.length >= MAX_SHOTS_PER_EPISODE) {
      toast(`最多 ${MAX_SHOTS_PER_EPISODE} 个镜头`);
      return;
    }
    items.push({ sequence: items.length + 1, title: "", description: "", duration_seconds: 6, slot: null });
    render();
    body.scrollTop = body.scrollHeight;
  };
  $("#se-save").onclick = () => {
    if (!items.length) {
      toast("至少保留 1 个镜头");
      return;
    }
    if (items.some((s) => !s.title.trim())) {
      toast("每个镜头都需要镜头名");
      return;
    }
    const out = normalizeShots(items, slotPrefix);
    close();
    if (onSave) onSave(out);
  };

  function open(initial, opts = {}) {
    // Deep-copy so cancel never mutates the caller's version data.
    //
    // THE ADDITIVE FIELDS COME ALONG (TASK-078 §2.1). This copy used to list six
    // keys, which meant every field the storyboard added later — 景别 / 角度 /
    // 情绪 / 光影 — was silently dropped the moment a draft passed through this
    // modal, even if the creator only renamed one shot. The editor still shows
    // and edits four of them; the rest are CARRIED, not shown, which is the
    // difference between "this modal doesn't edit that" and "this modal deletes
    // that".
    items = (initial || []).map((s) => {
      const copy = {
        shotId: typeof s.shotId === "string" && s.shotId ? s.shotId : null,
        sequence: s.sequence,
        title: s.title || "",
        description: s.description || "",
        duration_seconds: s.duration_seconds === 10 ? 10 : 6,
        slot: s.slot || null,
      };
      for (const k of ADDITIVE_SHOT_FIELDS) {
        if (typeof s[k] === "string" && s[k]) copy[k] = s[k];
      }
      return copy;
    });
    onSave = opts.onSave || null;
    slotPrefix = opts.slotPrefix || "m";
    sub.textContent = opts.subtitle || "";
    render();
    scrim.classList.add("show");
  }

  return { open, close };
}

// Manual shot editor (人工 Gate): open with the current draft's shots, let the
// user edit titles/descriptions/durations and add/remove shots, then hand the
// result back via onSave — the CALLER creates a NEW immutable version (never
// overwrites history, per §1.2). All user/agent text is escaped on render.
import { $, esc } from "../util/dom.js";

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
    if (items.length >= 20) {
      toast("最多 20 个镜头");
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
    const out = items.map((s, i) => ({
      sequence: i + 1,
      title: s.title.trim().slice(0, 80),
      description: (s.description || "").trim().slice(0, 500) || s.title.trim(),
      duration_seconds: s.duration_seconds === 10 ? 10 : 6,
      // surviving shots keep their slot (uploaded image follows the SHOT);
      // new shots get a fresh slot under the caller's version prefix.
      slot: s.slot || `${slotPrefix}-${i + 1}`,
    }));
    close();
    if (onSave) onSave(out);
  };

  function open(initial, opts = {}) {
    // Deep-copy so cancel never mutates the caller's version data.
    items = (initial || []).map((s) => ({
      sequence: s.sequence,
      title: s.title || "",
      description: s.description || "",
      duration_seconds: s.duration_seconds === 10 ? 10 : 6,
      slot: s.slot || null,
    }));
    onSave = opts.onSave || null;
    slotPrefix = opts.slotPrefix || "m";
    sub.textContent = opts.subtitle || "";
    render();
    scrim.classList.add("show");
  }

  return { open, close };
}

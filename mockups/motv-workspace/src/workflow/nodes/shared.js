// Shared helpers for node bodies.

/** Render "下一步：X →" guidance chips. Each button carries data-next (+ data-dy
 *  for vertical offset of the spawned node); app.js binds them to ctx.addNext. */
export const nx = (pairs) =>
  `<div class="nextchips">${pairs
    .map(([t, l, dy]) => `<button class="nextchip" data-next="${t}" data-dy="${dy || 0}">下一步：${l} →</button>`)
    .join("")}</div>`;

/** Bind the manual-provider slot buttons rendered by a node body:
 *  [data-copy] copies a generation prompt/text (getPrompt(key) → string), and
 *  [data-up] uploads a user-generated media file into the slot's upload map
 *  (node.uploads[key] = url; slot ids keep an upload glued to ITS shot). */
export function bindSlots(node, el, ctx, { accept, getPrompt, copiedMsg, uploadedMsg }) {
  el.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    const text = getPrompt(b.dataset.copy);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      ctx.toast(copiedMsg || "已复制");
    } catch {
      ctx.toast("复制失败：请手动选择文本复制");
    }
  }));
  el.querySelectorAll("[data-up]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const k = b.dataset.up; // slot id, e.g. "v3-2" / "voice-v3-2" / "music-main"
    if (!k) { ctx.toast("该槽位缺少标识：请重新生成或编辑分镜"); return; }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (!ctx.uploadMedia) { ctx.toast("演示模式暂不支持上传（需连接后端）"); return; }
      try {
        const url = await ctx.uploadMedia(`${node.type}-${k}`, file);
        node.uploads = node.uploads || {};
        node.uploads[k] = url;
        ctx.refresh(node);
        if (ctx.persist) ctx.persist();
        ctx.toast(uploadedMsg || "已上传");
      } catch (err) {
        ctx.toast("上传失败：" + err.message);
      }
    };
    input.click();
  }));
}

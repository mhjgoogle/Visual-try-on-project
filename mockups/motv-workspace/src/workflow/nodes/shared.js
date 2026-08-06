// Shared helpers for node bodies.

/** Render "下一步：X →" guidance chips. Each button carries data-next (+ data-dy
 *  for vertical offset of the spawned node); app.js binds them to ctx.addNext. */
export const nx = (pairs) =>
  `<div class="nextchips">${pairs
    .map(([t, l, dy]) => `<button class="nextchip" data-next="${t}" data-dy="${dy || 0}">下一步：${l} →</button>`)
    .join("")}</div>`;

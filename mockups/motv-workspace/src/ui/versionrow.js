// 版本切换行：默认只露最新的一版，旧版收在「历史版本」后面。
//
// 产品负责人 2026-08-29：「我希望只有最新版可以看到。旧版就不看了」。
//
// 「不看」≠「不存在」：旧版本一律保留（AGENTS.md 第 13 条、ADR-0089 决策 3 的整条
// 前提就是「改了能回来」）。这里改的只是**默认露不露**——展开一次就全在。
//
// 为什么最新版之外还可能多露一颗：`active` 是**下游依据的那一版**。它不是最新版时
// （他手动切回过旧版），把它藏起来就等于藏起「你现在基于的是哪一版」——那是产品事实，
// 不是历史。所以规则是：**最新版 + 当前依据的那一版**，其余收起。

import { esc } from "../util/dom.js";

/**
 * @param versions [{v, isActive, label?, title?}]（按 v 升序）
 * @param opts.attr      切换按钮上的 data 属性名，如 "cbV" → `data-cb-v`
 * @param opts.open      是否已展开
 * @param opts.toggleAttr 展开/收起按钮的 data 属性名，如 "cbHist" → `data-cb-hist`
 */
export function versionRow(versions, { attr, open = false, toggleAttr } = {}) {
  const list = Array.isArray(versions) ? versions.filter(Boolean) : [];
  if (!list.length) return "";
  const latest = list.reduce((a, b) => (b.v > a.v ? b : a), list[0]);
  const shown = open
    ? list
    : list.filter((x) => x.v === latest.v || x.isActive);
  const hidden = list.length - shown.length;
  const dataName = (name) => name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  const btns = shown
    .map((x) => (
      `<button class="st-ep${x.isActive ? " on" : ""}" data-${dataName(attr)}="${x.v}"` +
      (x.title ? ` title="${esc(String(x.title))}"` : ' title="切换下游所依据的版本"') +
      `>${esc(String(x.label || `v${x.v}`))}</button>`
    ))
    .join("");
  const toggle = toggleAttr && (hidden > 0 || open)
    ? `<button class="st-ep hist" data-${dataName(toggleAttr)}="1" title="旧版本一律保留，这里只控制显不显示">` +
      (open ? "收起历史" : `历史版本 ${hidden}`) +
      `</button>`
    : "";
  return `<div class="row tight">${btns}${toggle}</div>`;
}

// 资产收件箱 — assets whose owner is not already known, as proposals awaiting a
// human decision.
//
// WHY IT IS ITS OWN MODULE NOW (TASK-109 · REQ-004 v2). It used to be one of the
// six sections stacked in the AI 导演台 right column, and 产品负责人 2026-08-27 killed
// that column: 「AI导演台不需要了。根本用不上。」 But the inbox is not an observation
// panel — it is the ONLY surface in the app where an asset's ownership gets
// confirmed (his real project has 7 waiting), and `assetlibws.js` has no
// equivalent. Deleting it with the console would have removed a capability
// nobody asked to lose, which is exactly the failure this repo keeps paying for.
//
// So it moved to where the creator's own IA rule puts it: 资产库's workspace —
// 「中间工作区」 for the space whose subject IS assets.
//
// The render and the three handlers are LIFTED VERBATIM from `director.js`,
// including the confirmation route: attaching an asset to a shot changes a
// reference the creator owns, so it still goes through `directorops.invoke`,
// which decides what runs automatically and what must be confirmed first.
import { esc } from "../util/dom.js";
import { assetInbox, inboxLabel } from "./assetinbox.js";
import { invoke } from "./directorops.js";

/** The inbox body — unchanged from the Director's section, minus the collapsible
 *  chrome it no longer needs (the workspace is not a stack of panels). */
export function renderAssetInboxSection(pd) {
  const ib = assetInbox(pd);
  if (!ib.total) return "";
  const head =
    `<div class="ib-head"><span class="ib-ti">资产收件箱</span>` +
    (ib.pending
      ? `<span class="chip gate">${ib.pending} 待确认</span>`
      : `<span class="chip ok">没有待整理项</span>`) +
    `</div>`;
  if (!ib.pending) {
    return (
      `<section class="ib-sec">${head}` +
      `<div class="meta">全部 ${ib.total} 个资产都能确定归属，没有待整理项。</div></section>`
    );
  }
  const PREVIEW = 4;
  const rows = ib.items
    .slice(0, PREVIEW)
    .map((it) => {
      const conf = it.confidence
        ? `<span class="chip${it.confidence >= 0.7 ? " ok" : " gate"}">把握 ${Math.round(it.confidence * 100)}%</span>`
        : `<span class="chip bad">不确定</span>`;
      const thumb = it.url
        ? `<img class="ib-th" src="${esc(it.url)}" alt="">`
        : `<span class="ib-th ph">?</span>`;
      const act = it.action === "attach" && it.proposalShotId
        ? `<button class="btn sm" data-ibattach="${esc(it.assetId)}" data-shot2="${esc(it.proposalShotId)}">确认归属</button>`
        : `<button class="btn sm" data-ibopen="${esc(it.assetId || it.taskId || "")}">查看</button>`;
      return (
        `<div class="ib-row">${thumb}<div class="ib-tx">` +
        `<div class="ib-t">${esc(inboxLabel(it))}</div>` +
        `<div class="ib-p">${it.proposal ? `建议：${esc(it.proposal)}` : "没有可用线索"}</div>` +
        `<div class="ib-e">${esc(it.evidence)}</div></div>` +
        `<div class="ib-a">${conf}${act}</div></div>`
      );
    })
    .join("");
  const more = ib.pending > PREVIEW ? `<div class="meta">另有 ${ib.pending - PREVIEW} 项待确认。</div>` : "";
  return (
    `<section class="ib-sec">${head}` +
    `<div class="ib-sum"><b>${ib.total}</b> 个资产 · <b>${ib.auto}</b> 已自动归属 · ` +
    `<b class="warn">${ib.pending}</b> 待确认</div>` +
    rows + more +
    `<div class="row"><span class="chip mute" title="自动归属只用已有事实：记录的镜头身份、已有引用、生成结果。外部导入媒体的 AI 识别归类（角色 / 状态 / 场景）是后续能力，需另立 ADR——现在绝不猜。">仅按已有事实归属</span></div>` +
    `</section>`
  );
}

/** The three handlers, lifted with their reasons. */
export function bindAssetInboxSection(root, ctx) {
  // attaching an asset to a shot CHANGES a reference the creator owns → the
  // capability table forces a confirmation before anything is written.
  root.querySelectorAll("[data-ibattach]").forEach((b) => (b.onclick = () => {
    invoke("attach-asset", () => {
      ctx.toast("归属写回需要 Gateway 写侧（ADR-0033+）— 本检查点只做提案与确认门，未写入");
    }, { detail: `资产 ${b.dataset.ibattach.slice(0, 12)}… → 镜头 ${b.dataset.shot2.slice(0, 12)}…` });
  }));
  // The rows now live INSIDE 资产库, so 「查看」 scrolls to the library below rather
  // than navigating to the mode the creator is already in.
  root.querySelectorAll("[data-ibopen]").forEach((b) => (b.onclick = () => invoke("navigate", () => {
    const lib = root.querySelector(".alib, .assetgrid, .ws-list");
    if (lib && lib.scrollIntoView) lib.scrollIntoView({ block: "start" });
    else ctx.toast("待整理资产在下面的资产库里逐项确认");
  })));
}

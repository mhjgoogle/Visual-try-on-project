// 「以此生成 →」通用链式 (TASK-079 §1.2) — one menu on a media card, listing the
// things this item can become, and landing on the workspace that makes them
// WITH THIS ITEM ALREADY FILLED IN.
//
// WHY. There was exactly ONE typed hop in the whole product: an image's
// 「🎬 用作视频首帧」. Wanting to voice that shot meant leaving for the audio
// workspace, finding the shot again in its list, and re-establishing where you
// were — every time, for every shot.
//
// TWO RULES, both from the card:
//
//   1. A landing must PREFILL. Arriving at an empty page that happens to be the
//      right workspace is the failure ADR-0063 决策 1 names — 「落到一个没有该内容
//      的页面」 and 「落空」 are the same thing to the person who clicked.
//   2. An unavailable pair is GREYED WITH ITS REASON, never hidden. A menu that
//      silently omits 图生图 tells the creator this product has no opinion about
//      it; a greyed row saying 「没有图生图能力」 tells them the truth.
//
// The option list is pure and exported, so 「今天到底能做什么」 is a testable fact
// rather than a claim in a comment.

import { esc } from "../util/dom.js";
import { shotDetailModel } from "./storyboard.js";

/**
 * What this media item can become, and — when it cannot — why.
 *
 * `kind`  "image" | "video" | "audio"
 * `has`   { nextShot, slot }  — capabilities that depend on THIS shot's context
 *
 * Every entry is `{ id, label, to, ok, reason }`. `to` is the workspace the
 * action lands on; `reason` is filled in exactly when `ok` is false, and is the
 * honest explanation, not an apology.
 */
export function chainOptions(kind, { nextShot = null, slot = null, inScene = true } = {}) {
  if (kind === "image") {
    return [
      {
        id: "to-video",
        label: "视频（作首帧）",
        to: "video",
        ok: !!slot,
        reason: slot ? "" : "这个镜头的身份未解析，定位不到媒体槽位",
      },
      {
        id: "to-image",
        label: "图片（图生图 / 改写）",
        to: "frames",
        ok: false,
        // Honest, and specific: there is no image-to-image capability anywhere.
        // The free route is copy-the-prompt-to-an-external-tool, and paid image
        // generation is not admitted (ADR-0038 未 Accepted, paid scope is video
        // only). Saying so beats an entry that opens something unrelated.
        reason: "还没有图生图能力：付费图片未获批（ADR-0038），免费路线是把 Prompt 复制到外部工具重画",
      },
      {
        id: "to-charref",
        label: "设为角色参考",
        to: "settings",
        ok: false,
        // `assetctl.importReference` takes a FILE. Promoting an existing Asset
        // into a Reference chain is a registry write that does not exist yet —
        // inventing it here would be a second, unreviewed way into the registry.
        reason: "还不能把已有资产提升为参考：目前只有「上传文件建立参考」这一条路",
      },
    ];
  }
  if (kind === "video") {
    return [
      {
        id: "tail-to-next",
        label: nextShot ? `提取尾帧 → 下一镜首帧（${nextShot.title}）` : "提取尾帧 → 下一镜首帧",
        to: "video",
        ok: !!nextShot,
        // TWO DIFFERENT REASONS, and they are not interchangeable. 「下一镜」 is
        // scoped to the shot's own SCENE (framectl.nextShotOf), so an UNASSIGNED
        // shot has no next shot for a completely different cause than the last
        // shot of a scene does — and on the real project every shot is
        // unassigned, where 「这是最后一个镜头」 would simply be false.
        reason: nextShot
          ? ""
          : inScene
            ? "这是本场景的最后一个镜头，没有下一镜可以接"
            : "这个镜头还没有归入任何场景，因此推不出「下一镜」——先在「⑦ 分镜设计」归组",
      },
      {
        id: "to-voice",
        label: "配音",
        to: "audio",
        ok: !!slot,
        reason: slot ? "" : "这个镜头的身份未解析，定位不到媒体槽位",
      },
      {
        id: "to-timeline",
        label: "进时间线",
        to: "edit",
        ok: true,
        // Not a lie by omission: the timeline is DERIVED from each shot's
        // current media (`timelinectl.gatherRows`), so this clip is already in
        // it. The action is 「去看它在哪」, and the label says so below.
        derived: true,
        reason: "",
      },
    ];
  }
  if (kind === "audio") {
    return [
      { id: "to-timeline", label: "进时间线", to: "edit", ok: true, derived: true, reason: "" },
    ];
  }
  return [];
}

/** The menu markup. `open` is the shell's transient 「which menu is showing」. */
export function renderChainMenu(kind, opts, { open = false, shotId = "" } = {}) {
  const items = opts.map((o) =>
    o.ok
      ? `<button class="chain-item" data-chain="${esc(o.id)}" data-kind="${esc(kind)}" ` +
        `data-shot="${esc(shotId)}">${esc(o.label)}` +
        (o.derived ? `<span class="chain-note">已自动纳入 · 去看它</span>` : "") + `</button>`
      : `<span class="chain-item off" title="${esc(o.reason)}">${esc(o.label)}` +
        `<span class="chain-note">${esc(o.reason)}</span></span>`).join("");
  return (
    `<div class="chain">` +
    `<button class="btn sm" data-chain-open="${esc(kind)}">以此生成 →</button>` +
    (open ? `<div class="chain-menu">${items}</div>` : "") +
    `</div>`
  );
}

/**
 * Wire the menu.
 *
 * `land(to, shotId)` is the shell's navigation — passed in rather than imported,
 * because switching page IS a shell decision and this component must not grow a
 * second opinion about where things live.
 */
export function bindChainMenu(root, ctx, ui, rerender, { land }) {
  root.querySelectorAll("[data-chain-open]").forEach((b) => (b.onclick = () => {
    const k = b.dataset.chainOpen;
    ui.chainOpen = ui.chainOpen === k ? null : k;
    rerender();
  }));
  root.querySelectorAll("[data-chain]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.chain;
    const shotId = b.dataset.shot;
    ui.chainOpen = null;
    try {
      // Each branch PREFILLS before it navigates — rule 1. A branch that only
      // navigated would be the empty-page failure with extra steps.
      if (id === "to-video") {
        const d = shotDetailModel(ctx.prodData(), shotId);
        if (!d || !d.slot) { ctx.toast("镜头身份未解析：无法定位媒体槽位"); return; }
        await ctx.media.useAsFirstFrame(d.slot);
        ui.selectedShotId = shotId;
        land("video", shotId);
        return;
      }
      if (id === "tail-to-next") {
        const next = ctx.frames.nextShotOf(shotId);
        if (!next) { ctx.toast("这是最后一个镜头，没有下一镜可以接"); return; }
        const extracted = await ctx.frames.extract(shotId, { pick: "last" });
        if (!extracted || !extracted.assetId) { ctx.toast("尾帧提取失败：没有可用的视频帧"); return; }
        // `source` is the extraction PROVENANCE OBJECT the extract returned —
        // not the shot id. `framectl.bind` files a binding as `extracted` on the
        // strength of this object, and handing it a bare string would record a
        // frame that cannot say which video, which version or which timecode it
        // was cut from.
        const bound = ctx.frames.bind(next.shotId, "startFrame", {
          assetId: extracted.assetId, source: extracted.source, sourceKind: "extracted",
        });
        if (!bound) { ctx.toast("下一镜的首帧已锁定，未覆盖"); return; }
        ui.selectedShotId = next.shotId;
        ctx.toast(`已把本镜尾帧绑定为「${next.title || next.shotId}」的首帧`);
        land("video", next.shotId);
        return;
      }
      if (id === "to-voice") {
        ui.selectedShotId = shotId;
        land("audio", shotId);
        return;
      }
      if (id === "to-timeline") {
        ui.selectedShotId = shotId;
        land("edit", shotId);
        return;
      }
    } catch (e) {
      ctx.toast("操作失败：" + e.message);
    }
  }));
}

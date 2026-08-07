// 资产准备 — character / scene / prop reference sheets (S4 母资产). Opens the
// batch wizard; on generate it flips to done and guides to video/audio.
import { nx } from "./shared.js";
import { esc } from "../../util/dom.js";

function labels(ctx) {
  // When a Claude shot DRAFT is active, the placeholder grid must show the
  // draft's shots — not the demo fixture's characters/scenes (which would
  // contradict the script). Demo mode (no draft) keeps the fixture labels.
  const draft = ctx.project.draftShots;
  if (draft && draft.length) {
    return draft.slice(0, 6).map((s) => `${String(s.sequence).padStart(2, "0")} ${s.title}`);
  }
  const chars = ctx.project.characters.slice(0, 5).map((c) => c[0]);
  return [...chars, ctx.project.scenes[0][0]];
}

export default {
  type: "assets",
  step: 2,
  stage: "S4 素材制造",
  title: "资产准备",
  icon: "🧑‍🎨",
  init() {
    return { state: "" };
  },
  render(node, ctx) {
    // Downstream auto-fill (ADR-0042): when an upstream Claude shot DRAFT
    // exists, derive the asset checklist preview from it instead of fixtures.
    const draft = ctx.project.draftShots;
    if (draft && draft.length && node.state !== "done") {
      // Agent-generated content is UNTRUSTED — always escaped before innerHTML.
      const items = draft
        .slice(0, 6)
        .map(
          (s) =>
            `<div class="audrow">🎬 ${esc(String(s.sequence).padStart(2, "0"))} ${esc(s.title)}</div>`,
        )
        .join("");
      return `<div>${items}<div style="font-size:11px;color:var(--gate);margin:9px 2px 0">⚠ 从分镜草稿派生（${draft.length} 镜头）· 资产设定图待生成</div><button class="nrun" data-run>一键生成所有资产 →</button></div>`;
    }
    const cells = labels(ctx)
      .map((a) => {
        const bg = node.state === "done" ? "linear-gradient(135deg,#3a2a5e,#12183a)" : "var(--elev)";
        const col = node.state === "done" ? "#fff" : "var(--text-dim)";
        return `<div class="a" style="background:${bg}"><span class="lb" style="color:${col}">${esc(a)}</span></div>`;
      })
      .join("");
    const grid = `<div class="assetgrid">${cells}</div>`;
    if (node.state === "done") {
      // Connected mode never really generates (write-side gated): say so plainly
      // instead of claiming "✓ 已生成". Demo mode keeps its pretend-generated ✓.
      const ph = ctx.isConnected && ctx.isConnected();
      const msg = ph
        ? `<div style="font-size:11px;color:var(--gate);margin:9px 2px 0">占位推进 · 未真实生成（待 Gateway）</div>`
        : `<div style="font-size:11px;color:var(--ok);margin:9px 2px 0">✓ 9 个资产已生成</div>`;
      return `<div>${grid}${msg}${nx([["video", "视频生成"], ["audio", "音频生成", 150]])}</div>`;
    }
    return `<div>${grid}<div style="font-size:11px;color:var(--gate);margin:9px 2px 0">⚠ 9 个资产缺设定图</div><button class="nrun" data-run>一键生成所有资产 →</button></div>`;
  },
  run(node, ctx) {
    ctx.wizard.open(node); // wizard's confirm -> estimate -> marks node done
  },
  next: ["video", "audio"],
};

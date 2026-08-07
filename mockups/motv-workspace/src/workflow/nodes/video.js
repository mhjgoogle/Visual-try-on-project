// 视频生成 — batch all shots, or generate a single shot. Both go through the
// pre-generation budget preflight (paid Provider) before any spend.
import { nx } from "./shared.js";

const SINGLE_SHOTS = ["01", "02", "03", "04", "05", "06"];

export default {
  type: "video",
  step: 3,
  stage: "S4 素材制造",
  title: "视频生成",
  icon: "▶",
  init() {
    return { state: "", pickSingle: false };
  },
  render(node, ctx) {
    const total = ctx.project.shots.total;
    if (node.state === "done") {
      return `<div class="filmprev"><div class="pl"></div><div class="lb mono">${total} 镜头 · 已生成</div></div><div style="font-size:11px;color:var(--ok);margin-bottom:2px">✓ 批量视频已生成</div>${nx([["edit", "剪辑合成"]])}`;
    }
    const pick = node.pickSingle
      ? `<div class="shotpick">${SINGLE_SHOTS.map((s) => `<button data-shot="${s}">镜头 ${s}</button>`).join("")}</div>`
      : "";
    return `<div style="font-size:11.5px;color:var(--text-dim);width:220px">${total} 个镜头 · 首帧图生视频<br><span style="color:var(--text-faint);font-size:11px">Provider: minimax · 经 Command Gateway</span></div>
      <div class="vbtns"><button class="nrun" data-run>批量生成 ${total} 镜头</button><button class="nrun ghost" data-single>生成单个 ▾</button></div>${pick}`;
  },
  run(node, ctx) {
    const total = ctx.project.shots.total;
    ctx.estimate({
      cmd: `generate_videos · 批量 ${total} 镜头`,
      kind: "视频",
      count: total,
      p50: 46.2,
      p90: 62.4,
      actual: 46.2,
      label: `已提交 Gateway：批量视频生成 ${total} 镜头`,
      after: () => { node.state = "done"; ctx.refresh(node); ctx.markIncoming(node.id, "done"); },
    });
  },
  bind(node, el, ctx) {
    const sg = el.querySelector("[data-single]");
    if (sg) sg.onclick = (e) => { e.stopPropagation(); node.pickSingle = !node.pickSingle; ctx.refresh(node); };
    el.querySelectorAll("[data-shot]").forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const shot = b.dataset.shot;
      ctx.estimate({
        cmd: `generate_video · 单镜头 ${shot}`,
        kind: "视频",
        count: 1,
        // paid mode binds the REAL generation to exactly this shot
        shot: `shot-${Number(shot)}`,
        p50: 4.2,
        p90: 6.0,
        actual: 4.2,
        label: `已提交 Gateway：单镜头 ${shot} 生成`,
        after: () => { node.pickSingle = false; ctx.refresh(node); },
      });
    }));
  },
  next: ["edit"],
};

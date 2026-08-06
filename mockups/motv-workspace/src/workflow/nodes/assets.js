// 资产准备 — character / scene / prop reference sheets (S4 母资产). Opens the
// batch wizard; on generate it flips to done and guides to video/audio.
import { nx } from "./shared.js";

function labels(ctx) {
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
    const cells = labels(ctx)
      .map((a) => {
        const bg = node.state === "done" ? "linear-gradient(135deg,#3a2a5e,#12183a)" : "var(--elev)";
        const col = node.state === "done" ? "#fff" : "var(--text-dim)";
        return `<div class="a" style="background:${bg}"><span class="lb" style="color:${col}">${a}</span></div>`;
      })
      .join("");
    const grid = `<div class="assetgrid">${cells}</div>`;
    if (node.state === "done") {
      return `<div>${grid}<div style="font-size:11px;color:var(--ok);margin:9px 2px 0">✓ 9 个资产已生成</div>${nx([["video", "视频生成"], ["audio", "音频生成", 150]])}</div>`;
    }
    return `<div>${grid}<div style="font-size:11px;color:var(--gate);margin:9px 2px 0">⚠ 9 个资产缺设定图</div><button class="nrun" data-run>一键生成所有资产 →</button></div>`;
  },
  run(node, ctx) {
    ctx.wizard.open(node); // wizard's confirm -> estimate -> marks node done
  },
  next: ["video", "audio"],
};

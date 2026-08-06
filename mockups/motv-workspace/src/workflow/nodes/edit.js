// 剪辑合成 — assembly → rough/fine cut → mix → subtitle/grade → master candidate
// (S5). Local FFmpeg, so NO paid preflight (only paid Provider gen needs one).
import { nx } from "./shared.js";

export default {
  type: "edit",
  step: 4,
  stage: "S5 装配后期",
  title: "剪辑合成",
  icon: "✂",
  init() {
    return { state: "", prog: 0 };
  },
  render(node) {
    if (node.state === "gen") {
      return `<div class="tl"><span>🎞</span><span class="tk v"><i></i></span></div><div class="tl"><span>🔊</span><span class="tk a"><i></i></span></div><div class="genprog"><div class="pb"><i style="width:${node.prog}%"></i></div><span class="pc">合成中 ${node.prog}%</span></div>`;
    }
    if (node.state === "done") {
      return `<div class="filmprev"><div class="pl"></div><div class="lb mono">master v1 · 1080p</div></div><div style="font-size:11px;color:var(--text-faint);margin-bottom:6px">粗剪→精剪→混音→字幕/调色 · master candidate v1</div>${nx([["master", "成片/质检"]])}`;
    }
    return `<div class="tl"><span>🎞</span><span class="tk v"><i></i></span><span>11</span></div><div class="tl"><span>🔊</span><span class="tk a"><i></i></span><span>混音</span></div><div style="font-size:11px;color:var(--text-faint);margin:6px 2px">本地 FFmpeg 合成 · 不产生 Provider 费用</div><button class="nrun" data-run>合成成片（FFmpeg）</button>`;
  },
  run(node, ctx) {
    if (node.state === "done") { ctx.toast("预览成片 · master candidate v1（原型）"); return; }
    node.state = "gen";
    node.prog = 8;
    ctx.refresh(node);
    ctx.markIncoming(node.id, "active");
    const t = setInterval(() => {
      node.prog += Math.floor(Math.random() * 16) + 7;
      if (node.prog >= 100) {
        node.prog = 100;
        clearInterval(t);
        node.state = "done";
        ctx.refresh(node);
        ctx.markIncoming(node.id, "done");
        ctx.toast("成片已合成 · master candidate v1（S5，本地 FFmpeg，零 Provider 费用）");
      } else {
        ctx.refresh(node);
      }
    }, 380);
  },
  next: ["master"],
};

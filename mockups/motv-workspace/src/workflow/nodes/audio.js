// 音频生成 — dialogue / music / SFX (S4). Paid Provider, so it goes through the
// budget preflight. Feeds 剪辑合成 alongside 视频生成 (a merge in the graph).
import { nx } from "./shared.js";

export default {
  type: "audio",
  step: 3,
  stage: "S4 素材制造",
  title: "音频生成",
  icon: "🎵",
  init() {
    return { state: "" };
  },
  render(node) {
    if (node.state === "done") {
      return `<div class="audrow ok">✓ 对白配音 · 11 句</div><div class="audrow ok">✓ 背景音乐 · 3 段</div><div class="audrow ok">✓ 音效 · 8 处</div>${nx([["edit", "剪辑合成"]])}`;
    }
    return `<div class="audrow">🎤 对白配音（S4-T04）</div><div class="audrow">🎼 背景音乐（S4-T06）</div><div class="audrow">🔊 音效（S4-T06）</div><button class="nrun" data-run>生成对白/音乐/音效</button>`;
  },
  run(node, ctx) {
    ctx.estimate({
      cmd: "generate_audio · 对白/音乐/音效",
      kind: "音频",
      count: 22,
      p50: 9.2,
      p90: 14.0,
      actual: 9.2,
      label: "已提交 Gateway：音频批量生成",
      after: () => { node.state = "done"; ctx.refresh(node); ctx.markIncoming(node.id, "done"); },
    });
  },
  next: ["edit"],
};

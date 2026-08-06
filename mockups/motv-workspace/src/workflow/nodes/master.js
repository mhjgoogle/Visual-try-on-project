// 成片 · 质检发布 — QC set + release/export (S6). Release goes through the
// Command Gateway and requires QC to pass (no blocking findings).

export default {
  type: "master",
  step: 5,
  stage: "S6 质量与发布",
  title: "成片 · 质检发布",
  icon: "📦",
  init() {
    return { state: "" };
  },
  render() {
    return `<div class="qcrow pass">叙事 QC<span class="qi">✓</span></div><div class="qcrow pass">连续性 QC<span class="qi">✓</span></div><div class="qcrow wait">技术 QC<span class="qi">待</span></div><div class="qcrow wait">权利/来源 QC<span class="qi">待</span></div><button class="nrun ghost" data-run>发布 / 导出成片</button>`;
  },
  run(node, ctx) {
    // S6 Gate: release requires ALL QC to pass. In this mockup 技术/权利 QC are
    // still pending, so the release is refused rather than submitted.
    ctx.toast("技术/权利 QC 未通过，无法发布（S6 Gate 需 QC 全通过）");
  },
  next: [],
};

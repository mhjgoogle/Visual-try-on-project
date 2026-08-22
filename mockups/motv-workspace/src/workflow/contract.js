// L0–S7 stage / step I/O contract data.
//
// This mirrors docs/design/workflow-stage-step-io-contract.md (§2 层级关系,
// §3–10 步骤, §11 Gate). It is the SINGLE source the inspector reads so node
// definitions never invent contract fields. Keep it a faithful, read-only
// projection of the doc — do not add fields the doc does not authorize.

export const STAGES = {
  S1: {
    name: "剧本",
    lock: "screenplay lock",
    in: ["concept lock"],
    gate: "screenplay lock approved；load/narrative reviews 无阻断",
    steps: [
      ["S1-T04", "剧本初稿", "required", "bible；beats；arc；format", "screenplay 版本"],
      ["S1-T07", "剧本锁定", "required", "screenplay；load review；narrative QC", "screenplay lock"],
    ],
  },
  S2: {
    name: "视听设计",
    lock: "AV design lock",
    in: ["screenplay lock", "concept lock"],
    gate: "format 与 AV design locks approved；三类代表镜头 probe 通过",
    steps: [
      ["S2-T03", "设计登记", "required", "screenplay lock；visual bible；可复用资产 refs", "design registry（角色/场景/道具）"],
      ["S2-T07", "视听锁定", "required", "bibles/guides/registry；probe QC", "AV design lock"],
    ],
  },
  S3: {
    name: "生产设计",
    lock: "production lock",
    in: ["screenplay lock", "AV design lock"],
    gate: "production lock approved；task packets、Provider、P50/P90 与预算预检有效",
    steps: [
      ["S3-T01", "镜头拆分", "required", "screenplay/AV/format lock", "shot list（11 镜头）"],
      ["S3-T07", "生产锁定", "required", "shot list/cards；routes；plan；budget；preflight", "production lock；task packets"],
    ],
  },
  S4: {
    name: "素材制造",
    lock: "asset selection manifest",
    in: ["production lock"],
    gate: "asset selection approved；required 媒体齐备；付费 operation 已结算或对账",
    steps: [
      ["S4-T02", "母资产生成", "required", "design registry；visual bible；references", "master assets"],
      ["S4-T05", "视频镜头生成", "required", "task packet；prompt；references/keyframes；provider plan；reservation", "candidate VideoAssets；成本事实"],
      ["S4-T08", "素材选择批准", "required", "全部候选；QC；成本事实", "asset selection manifest"],
    ],
  },
  S5: {
    name: "装配后期",
    lock: "master candidate",
    in: ["asset selection manifest"],
    gate: "master candidate、mix/subtitle、final load review 通过并绑定当前输入",
    steps: [
      ["S5-T02", "粗剪", "required", "assembly timeline；assets；screenplay", "rough cut"],
      ["S5-T05", "字幕/修复/调色", "required", "fine cut；mix；transcript；format", "master candidate"],
    ],
  },
  S6: {
    name: "质量与发布",
    lock: "release package / result",
    in: ["master candidate"],
    gate: "narrative/continuity/technical/rights QC 无阻断；付费 operation 已结算或人工对账；release result 或 termination 已记录",
    steps: [
      ["S6-T03", "技术 QC", "required", "master candidate；format；audio/subtitle", "technical QC 版本"],
      ["S6-T05", "发布包", "required", "master；passed QC；delivery；title/cover/metadata", "platform package manifests"],
    ],
  },
};

/** Stage code from a node's `stage` field like "S4 素材制造". */
export function stageCode(stage) {
  return (stage || "").split(" ")[0];
}
export function stageOf(stage) {
  return STAGES[stageCode(stage)] || null;
}

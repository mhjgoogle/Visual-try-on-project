"""Read-only L0-S7 workflow step definitions (TASK-025 / WQ-01).

A versioned, in-code transcription of the approved
``docs/design/workflow-stage-step-io-contract.md`` step tables and §11
stage gates. This is the *plan definition* source: it lets WQ-01 return the
complete Project/L0-S7 step plan — stable id, level, execution class,
required input types, logical output types, responsibility, completion
condition, and gate — for any project, run or unrun (query contract §5.1).

It carries no run facts and authorizes no physical path or schema; the
query layer overlays real approval/run facts where WFM1 implements them and
marks every other step's *run instance* as unavailable (query contract
§5.3). Changing these definitions tracks the doc, not code behaviour, so
the module is versioned independently.
"""

from __future__ import annotations

from dataclasses import dataclass

# Bump when the transcribed contract content changes (tracks the doc).
IO_CONTRACT_VERSION = 1

# Execution classes (I/O contract §1.3).
REQUIRED = "required"
CONDITIONAL = "conditional"
OPTIONAL_DATA = "optional-data"


@dataclass(frozen=True, slots=True)
class StepDef:
    """One logical workflow step's definition (never its run instance)."""

    step_id: str
    level: str  # Project / L0 / S1..S7
    title: str
    execution: str
    required_inputs: tuple[str, ...]
    logical_outputs: tuple[str, ...]
    responsibility: str
    completion: str


# Each step transcribes one row of the I/O contract tables (§3-§10). Input
# and output entries are logical types, never physical paths.
_STEPS: tuple[StepDef, ...] = (
    StepDef(
        "Project-Init",
        "Project",
        "项目初始化",
        REQUIRED,
        (
            "user goals",
            "audience",
            "narrative/style goals",
            "quality bar",
            "budget/delivery targets",
            "forbidden items",
            "success criteria",
        ),
        ("project profile/goals version",),
        "用户定义；CLI 校验",
        "profile schema/引用/预算约束有效，形成不可变版本",
    ),
    StepDef(
        "L0-01",
        "L0",
        "灵感捕捉",
        REQUIRED,
        ("project goals", "raw idea/imagery/conflict"),
        ("idea card version",),
        "Agent 整理；用户确认",
        "核心吸引点、人物/冲突线索和未知项可定位",
    ),
    StepDef(
        "L0-02",
        "L0",
        "强概念提炼",
        REQUIRED,
        ("current idea card", "project goals"),
        ("logline candidate set",),
        "Agent 生成候选；用户选择方向",
        "候选互有区分，均说明主角、目标、阻力和独特机制",
    ),
    StepDef(
        "L0-03",
        "L0",
        "载荷声明",
        REQUIRED,
        ("idea card", "logline candidates", "project goals"),
        ("load declaration version",),
        "Agent 分析；用户锁定",
        "一项主载荷、至多一项次载荷，二者不得相同",
    ),
    StepDef(
        "L0-04",
        "L0",
        "短篇适配",
        REQUIRED,
        ("selected/shortlisted logline", "load declaration", "duration target"),
        ("short-form test version",),
        "Agent 分析；用户判断",
        "开场、升级、转折、余味完整，存在不可逆变化",
    ),
    StepDef(
        "L0-05",
        "L0",
        "可行性判断",
        REQUIRED,
        (
            "short-form test",
            "candidate concepts",
            "project budget",
            "provider/catalog capability snapshot",
            "asset/delivery constraints",
        ),
        ("feasibility report", "cost estimate/assumptions"),
        "application service 估算；用户裁决降复杂度",
        "P50/P90、主要风险和降级方案明确，P90 不越硬上限",
    ),
    StepDef(
        "L0-06",
        "L0",
        "概念试制",
        REQUIRED,
        (
            "shortlisted concept",
            "load declaration",
            "format assumptions",
            "feasibility/cost",
            "three representative shot definitions",
        ),
        ("concept probe plan", "probe generation batches/assets", "probe evaluation"),
        "Agent/Provider 产候选；Orchestrator 登记；用户评价",
        "三类代表镜头有结果，至少一个方案通过内容、视觉和成本检查",
    ),
    StepDef(
        "L0-07",
        "L0",
        "创意定稿",
        REQUIRED,
        (
            "selected logline",
            "load declaration",
            "short-form test",
            "feasibility",
            "probe evaluation",
            "open items",
        ),
        ("concept lock version", "decision evidence"),
        "用户最终批准",
        "主/次载荷、logline、结尾、机制、允许的未决项均被 digest 锁定",
    ),
    StepDef(
        "S1-T01",
        "S1",
        "作品圣经",
        REQUIRED,
        ("approved concept lock", "project goals"),
        ("story bible version",),
        "Agent 起草；用户修订/确认",
        "世界、人物、规则、主题和禁止项与 concept lock 一致",
    ),
    StepDef(
        "S1-T02",
        "S1",
        "节拍设计",
        REQUIRED,
        ("concept lock", "story bible", "duration target"),
        ("beat sheet version",),
        "Agent 起草；用户判断",
        "开场、升级、转折、结尾余味均有时间/叙事责任",
    ),
    StepDef(
        "S1-T03",
        "S1",
        "人物变化",
        REQUIRED,
        ("concept lock", "story bible", "beat sheet"),
        ("character arc version",),
        "Agent 起草；用户判断",
        "欲望、选择、代价和变化能由镜头行动表现",
    ),
    StepDef(
        "S1-T04",
        "S1",
        "剧本初稿",
        REQUIRED,
        ("story bible", "beat sheet", "character arc", "project/format assumptions"),
        ("screenplay version",),
        "Agent 起草；用户修订",
        "时长和结构可执行，所有关键行为可映射至既定节拍",
    ),
    StepDef(
        "S1-T05",
        "S1",
        "主载荷审核",
        REQUIRED,
        ("screenplay version", "load declaration", "concept lock", "project goals"),
        ("load review version",),
        "Agent 辅助检查；用户结论",
        "主载荷 Checklist 有逐项证据、问题和处置结论",
    ),
    StepDef(
        "S1-T06",
        "S1",
        "叙事风险审核",
        REQUIRED,
        ("screenplay version", "story bible", "beat sheet", "character arc"),
        ("narrative QC version",),
        "Agent 辅助检查；用户结论",
        "逻辑、信息、公平性和说教风险均有结构化结论",
    ),
    StepDef(
        "S1-T07",
        "S1",
        "剧本锁定",
        REQUIRED,
        (
            "selected screenplay",
            "load review",
            "narrative QC",
            "resolved change requests",
        ),
        ("screenplay lock version", "approval target"),
        "用户最终批准",
        "阻断问题关闭，锁定 screenplay 及全部依赖 digest",
    ),
    StepDef(
        "S2-T01",
        "S2",
        "格式锁定",
        REQUIRED,
        (
            "approved screenplay lock",
            "delivery/platform targets",
            "budget/technical constraints",
        ),
        ("format lock version",),
        "application service 校验；用户批准",
        "平台、画幅、分辨率、帧率、时长和交付约束明确",
    ),
    StepDef(
        "S2-T02",
        "S2",
        "视觉圣经",
        REQUIRED,
        ("concept lock", "screenplay lock", "load declaration", "format lock"),
        ("visual bible version",),
        "Agent 起草；用户锁定",
        "风格、反例、色彩、材质和一致性规则可执行",
    ),
    StepDef(
        "S2-T03",
        "S2",
        "设计登记",
        REQUIRED,
        ("screenplay lock", "visual bible", "approved reusable asset refs"),
        ("design registry version",),
        "Agent/用户设计；application service 登记",
        "角色、服装、场景、道具均有稳定 ref 和版本策略",
    ),
    StepDef(
        "S2-T04",
        "S2",
        "摄影规则",
        REQUIRED,
        ("format lock", "visual bible", "design registry", "load declaration"),
        ("cinematography guide version",),
        "Agent 起草；用户锁定",
        "构图、光线、镜头运动、连续性和禁用模式明确",
    ),
    StepDef(
        "S2-T05",
        "S2",
        "声音圣经",
        REQUIRED,
        ("screenplay lock", "concept/load", "format/delivery targets"),
        ("audio bible version",),
        "Agent 起草；用户锁定",
        "对白、旁白、音乐、环境声、音效和响度意图明确",
    ),
    StepDef(
        "S2-T06",
        "S2",
        "代表镜头试制",
        REQUIRED,
        (
            "format/visual/design/cinematography/audio versions",
            "probe shot definitions",
            "provider/catalog/budget approval",
        ),
        ("visual probe plan", "generation batches/assets", "probe QC/evaluation"),
        "Provider/外部工具产候选；Orchestrator 登记；用户选择",
        "人物近景、中景、最难镜头均通过内容/一致性/成本门槛",
    ),
    StepDef(
        "S2-T07",
        "S2",
        "视听锁定",
        REQUIRED,
        (
            "selected bibles/guides/registry",
            "probe results/QC",
            "user selection rationale",
        ),
        ("AV design lock version", "approval target"),
        "用户最终批准",
        "视听规则、正式资产版本和允许偏差被 digest 锁定",
    ),
    StepDef(
        "S3-T01",
        "S3",
        "镜头拆分",
        REQUIRED,
        ("approved screenplay lock", "AV design lock", "format lock"),
        ("shot list version",),
        "Agent 起草；用户确认；CLI 校验",
        "镜头顺序、时长、叙事责任和连续性引用完整",
    ),
    StepDef(
        "S3-T02",
        "S3",
        "镜头任务卡",
        REQUIRED,
        ("shot list", "screenplay/AV refs", "project goals"),
        ("shot card versions",),
        "planning service 编译；用户检查",
        "每镜头输入、prompt intent、验收标准和返工边界明确",
    ),
    StepDef(
        "S3-T03",
        "S3",
        "生产路线",
        REQUIRED,
        ("shot cards", "feasibility", "asset refs", "provider capability catalog"),
        ("production route version",),
        "planning service 建议；用户批准",
        "每镜头静帧/2.5D/i2v/t2v/人工路线及备用策略明确",
    ),
    StepDef(
        "S3-T04",
        "S3",
        "Provider 计划",
        REQUIRED,
        (
            "production route",
            "locked provider/model catalog",
            "credential availability",
            "project preferences",
        ),
        ("provider plan version",),
        "registry/selection service；用户批准",
        "主/备 Provider 与模型可用、可审计且不绑定错误厂商 schema",
    ),
    StepDef(
        "S3-T05",
        "S3",
        "镜头预算",
        REQUIRED,
        (
            "shot cards",
            "provider plan",
            "locked prices/FX",
            "project/episode/month limits",
        ),
        ("shot budget version", "episode P50/P90 preview"),
        "budget service",
        "尝试次数、单镜/单集/月度额度和 fallback 影响均不过硬门槛",
    ),
    StepDef(
        "S3-T06",
        "S3",
        "生产预检",
        REQUIRED,
        (
            "shot list/cards",
            "routes",
            "provider plan",
            "budgets",
            "approved upstream digests",
        ),
        ("preflight report version",),
        "application service",
        "连续性、可生成性、输入版本、审批、Provider 和预算无阻断",
    ),
    StepDef(
        "S3-T07",
        "S3",
        "生产锁定",
        REQUIRED,
        (
            "shot list/cards",
            "routes",
            "provider plan",
            "shot budget",
            "passed preflight",
        ),
        ("production lock version", "compiled task packets"),
        "用户批准；planning service 编译",
        "每镜头方法、输入、模型、预算、验收标准和 digest 全部锁定",
    ),
    StepDef(
        "S4-T01",
        "S4",
        "参考资料登记",
        REQUIRED,
        ("production lock", "approved external/reusable refs", "source/rights info"),
        ("reference asset records/versions",),
        "用户选择；asset service 校验登记",
        "每项参考有来源、digest、适用范围和权利状态",
    ),
    StepDef(
        "S4-T02",
        "S4",
        "母资产生成",
        REQUIRED,
        (
            "design registry",
            "visual bible",
            "reference assets",
            "approved generation spec/budget",
        ),
        ("master asset batches", "candidate assets", "selection decision"),
        "Provider/外部工具生成；Orchestrator 登记；用户选择",
        "required 角色/场景/道具各有通过 QC 的锁定版本",
    ),
    StepDef(
        "S4-T03",
        "S4",
        "关键帧生成",
        REQUIRED,
        (
            "shot cards",
            "master assets",
            "cinematography guide",
            "reference assets",
            "approved generation spec/budget",
        ),
        ("keyframe batches/assets", "selection decision"),
        "Provider/外部工具生成；Orchestrator 登记；用户选择",
        "生产路线要求的首/尾/关键帧齐备且与母资产一致",
    ),
    StepDef(
        "S4-T04",
        "S4",
        "对白与旁白",
        CONDITIONAL,
        (
            "screenplay/shot cards",
            "audio bible",
            "voice authorization/reference",
            "approved generation/import spec",
        ),
        ("dialogue/narration assets", "transcript/timing refs"),
        "Audio Provider 或用户提供；asset service 登记；用户批准",
        "有对白/旁白的镜头具备可剪辑、可追溯且权利明确的音频",
    ),
    StepDef(
        "S4-T05",
        "S4",
        "视频镜头生成",
        REQUIRED,
        (
            "task packet",
            "prompt version",
            "selected references/keyframes",
            "provider plan",
            "approval/budget/reservation",
        ),
        ("video operation/attempt records", "candidate VideoAssets", "cost facts"),
        "VideoProvider；协调器/Orchestrator 写事实；用户选择",
        "每个 required 镜头至少一个正式、校验通过且成本已结算/对账的版本",
    ),
    StepDef(
        "S4-T06",
        "S4",
        "音乐/环境/音效",
        CONDITIONAL,
        (
            "audio bible",
            "shot/timeline intent",
            "rights constraints",
            "approved generation/import spec/budget",
        ),
        ("music/ambience/SFX assets", "cost/rights records"),
        "Audio Provider/用户提供；asset service 登记；用户批准",
        "profile/AV lock 要求的声音层齐备、可剪辑且权利明确",
    ),
    StepDef(
        "S4-T07",
        "S4",
        "代理与预览",
        REQUIRED,
        ("approved image/video/audio assets", "format/proxy profile"),
        ("proxy assets", "preview manifest"),
        "media application service",
        "代理可播放、引用源 digest、可删除重建且不替代正式资产",
    ),
    StepDef(
        "S4-T08",
        "S4",
        "素材选择批准",
        REQUIRED,
        (
            "all candidate batches/assets",
            "project goals",
            "shot acceptance/QC",
            "cost facts",
        ),
        ("asset selection manifest", "approval targets", "redo/change decisions"),
        "用户最终选择；application service 记录",
        "required 素材均 selected/approved；未选结果、理由和返工关系保留",
    ),
    StepDef(
        "S5-T01",
        "S5",
        "初始时间线",
        REQUIRED,
        ("approved asset selection", "shot list", "format lock", "proxy profile"),
        ("assembly timeline version", "assembly preview"),
        "composition/edit service",
        "镜头、音频槽位、转场和源引用完整，可确定性重建",
    ),
    StepDef(
        "S5-T02",
        "S5",
        "粗剪",
        REQUIRED,
        ("assembly timeline", "selected assets", "project goals/screenplay"),
        ("rough cut version", "rough-cut decision/evaluation"),
        "编辑工具/用户；application service 导入登记",
        "故事可理解，缺口和返工对象有精确版本绑定",
    ),
    StepDef(
        "S5-T03",
        "S5",
        "精剪",
        REQUIRED,
        ("approved rough cut", "feedback/decisions", "selected source assets"),
        ("fine cut version", "edit decision list"),
        "编辑工具/用户；application service 导入登记",
        "节奏、情绪和镜头连续性达到锁定目标，历史版本保留",
    ),
    StepDef(
        "S5-T04",
        "S5",
        "混音",
        REQUIRED,
        (
            "fine-cut timeline",
            "dialogue/music/SFX assets",
            "audio bible",
            "format target",
        ),
        ("audio mix version", "mix manifest"),
        "audio/composition service + 用户检查",
        "required 声音层、增益/响度和源谱系完整，输出通过技术校验",
    ),
    StepDef(
        "S5-T05",
        "S5",
        "字幕/修复/调色",
        REQUIRED,
        (
            "fine cut",
            "audio mix",
            "screenplay/transcript",
            "format/cinematography rules",
        ),
        (
            "subtitle asset/version or not_applicable decision",
            "grade/repair record",
            "master candidate version",
        ),
        "media tools + 用户；application service 登记",
        "有对白时字幕与音频同步；无字幕需求时依据可审计；画面/编码符合锁定格式",
    ),
    StepDef(
        "S5-T06",
        "S5",
        "主载荷终检",
        REQUIRED,
        (
            "master candidate",
            "concept/load declaration",
            "project goals",
            "screenplay lock",
        ),
        ("final load review", "creative decision"),
        "Agent 辅助；用户最终判断",
        "主载荷有证据成立，阻断问题关闭或明确退回目标步骤",
    ),
    StepDef(
        "S6-T01",
        "S6",
        "叙事 QC",
        REQUIRED,
        ("master candidate", "screenplay/concept/project goals", "final load review"),
        ("narrative QC version",),
        "Agent/检查包辅助；用户结论",
        "理解、节奏、信息和主载荷无阻断问题",
    ),
    StepDef(
        "S6-T02",
        "S6",
        "连续性 QC",
        REQUIRED,
        ("master candidate", "shot list", "design registry", "selected asset lineage"),
        ("continuity QC version",),
        "application/Agent 辅助；用户结论",
        "角色、场景、道具、动作和镜头连接问题均有证据/处置",
    ),
    StepDef(
        "S6-T03",
        "S6",
        "技术 QC",
        REQUIRED,
        ("master candidate", "format lock", "audio/subtitle requirements"),
        ("technical QC version",),
        "media inspector/application service",
        "音画、字幕、编码、分辨率、帧率和响度通过硬检查",
    ),
    StepDef(
        "S6-T04",
        "S6",
        "权利与来源 QC",
        REQUIRED,
        (
            "master/media asset lineage",
            "provider/operation records",
            "license/source declarations",
        ),
        ("rights QC version",),
        "application service 汇总；用户确认",
        "所有正式媒体可追溯，未知权利或来源问题均阻断",
    ),
    StepDef(
        "S6-T05",
        "S6",
        "发布包",
        REQUIRED,
        (
            "approved master",
            "passed QC set",
            "delivery targets",
            "title/cover/metadata versions",
        ),
        ("versioned platform package manifests/assets",),
        "release service",
        "每个平台包引用精确母版/元数据 digest，离线可检查且不覆盖",
    ),
    StepDef(
        "S6-T06",
        "S6",
        "发布结果",
        REQUIRED,
        ("approved release package", "user publish/terminate decision"),
        ("release result manifest", "external publication refs 或 termination"),
        "用户执行/确认；release service 记录",
        "成功、失败、延期或终止明确，外部引用不以临时 URL 作为唯一身份",
    ),
    StepDef(
        "S7-T01",
        "S7",
        "QCD 复盘",
        REQUIRED,
        (
            "release/termination result",
            "QCD events",
            "operations",
            "stage audit",
            "evaluation/Action facts",
        ),
        ("postmortem version",),
        "analytics service 派生；用户补充结论",
        "时间、成本、返工、失败、未解决问题均可追溯并可重算",
    ),
    StepDef(
        "S7-T02",
        "S7",
        "Provider 表现",
        REQUIRED,
        (
            "generation attempts/costs",
            "QC/evaluations",
            "selection/redo/fallback decisions",
        ),
        ("provider/model scorecard version",),
        "analytics service 派生；用户解释",
        "质量、稳定性、成本效率和样本范围明确，不跨币种错误相加",
    ),
    StepDef(
        "S7-T03",
        "S7",
        "观众数据",
        OPTIONAL_DATA,
        ("release result", "explicit stat window", "available platform/manual data"),
        ("performance metrics snapshot 或 unavailable record",),
        "用户导入；application service 校验",
        "缺失与零分离，来源、范围、时间和局限明确",
    ),
    StepDef(
        "S7-T04",
        "S7",
        "复用候选",
        REQUIRED,
        (
            "postmortem",
            "scorecard",
            "performance",
            "evaluation/experiment/Action",
            "formal assets/templates",
        ),
        ("reuse candidate set",),
        "analytics/Agent 提议；用户审查",
        "每项候选有来源 refs、适用条件、失败证据和推荐处置",
    ),
    StepDef(
        "S7-T05",
        "S7",
        "经验提升",
        CONDITIONAL,
        (
            "user-approved reuse candidate",
            "current knowledge/template version",
            "conflict check",
        ),
        ("new reusable knowledge/template/checklist version", "promotion decision"),
        "用户批准；知识 application service 发布",
        "产生新不可变版本并保留来源；不得自动改写既有项目或替代用户决定",
    ),
)


# §11 stage gate minimum checks, keyed by the gate label.
_GATES: dict[str, str] = {
    "L0 -> S1": "concept lock approved；目标/载荷/可行性/probe refs digest 有效",
    "S1 -> S2": "screenplay lock approved；load/narrative reviews 无阻断项",
    "S2 -> S3": "format 与 AV design locks approved；三类代表镜头 probe 通过",
    "S3 -> S4": (
        "production lock approved；task packets、Provider/catalog、P50/P90 "
        "与预算预检有效"
    ),
    "S4 -> S5": (
        "asset selection approved；required 媒体齐备；付费 operation 已结算或"
        "进入显式 reconciliation"
    ),
    "S5 -> S6": "master candidate、mix/subtitle、final load review 通过并绑定当前输入",
    "S6 -> S7": (
        "narrative/continuity/technical/rights QC 无阻断；全部付费 operation "
        "已结算或人工对账关闭；release result 或 termination decision 已记录"
    ),
    "Project complete": (
        "postmortem/scorecard/reuse candidates 已生成；optional performance "
        "明确 available/unavailable；归档引用完整"
    ),
}


# Which I/O steps have a WFM1 run-fact source (else run instance is
# unavailable, query contract §5.3). Maps step_id -> the implemented
# approval stage id, or a sentinel run source for non-approval steps.
_RUN_SOURCE: dict[str, str] = {
    "Project-Init": "profile",
    "L0-07": "concept_lock",
    "S1-T07": "screenplay_lock",
    "S2-T07": "av_design_lock",
    "S3-T07": "production_lock",
    "S4-T05": "paid_generation",
    "S4-T08": "assets_ready",
    "S5-T01": "assembly_done",
    "S6-T03": "qc_release",
    "S7-T01": "retrospective",
}


def steps() -> tuple[StepDef, ...]:
    """The full ordered L0-S7 step plan (Project first, then L0..S7)."""
    return _STEPS


def gate_for(step_id: str) -> str | None:
    """The §11 gate label whose approval this step's completion feeds, if any."""
    gate_by_step = {
        "L0-07": "L0 -> S1",
        "S1-T07": "S1 -> S2",
        "S2-T07": "S2 -> S3",
        "S3-T07": "S3 -> S4",
        "S4-T08": "S4 -> S5",
        "S5-T06": "S5 -> S6",
        "S6-T06": "S6 -> S7",
        "S7-T05": "Project complete",
    }
    label = gate_by_step.get(step_id)
    return _GATES.get(label) if label is not None else None


def run_source(step_id: str) -> str | None:
    """The WFM1 run-fact source for a step, or None if execution-unavailable."""
    return _RUN_SOURCE.get(step_id)

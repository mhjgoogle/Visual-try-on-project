"""The WFM2 L0/S1/S2/S3 creative & audiovisual step catalog (TASK-034).

A data-driven refinement of the approved semantic I/O baseline
(``docs/design/workflow-stage-step-io-contract.md`` §3–§6) into a queryable
catalog: for every step it fixes the producing owner, execution class, the
logical output artifact kind, the upstream step inputs, the completion
condition, the authoritative on-disk surface, and — for the four locked
stages — the WFM1 approval gate it targets. It refines, never deletes or
merges, the baseline steps and keeps every existing stage/step id unchanged
(ADR-0037 P6). The full plan is derivable before any step runs, satisfying
"the plan is queryable when unrun" (ADR-0037 P2).

This module is pure data + accessors: no IO, no Provider, no approval.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Where a step's authoritative output identity lives.
SURFACE_CREATIVE = "creative_index"  # this task's structured index tree
SURFACE_WFM1_PROFILE = "wfm1_profile"  # profile/project_profile_v<N>.json
SURFACE_WFM1_PLANNING = "wfm1_planning"  # planning/*.json (brief/story/shot_plan/...)
SURFACE_WFM1_APPROVAL = "wfm1_approval"  # approval/<stage>.json marker

# The four human stage-lock gates (existing WFM1 approval stage ids, unchanged).
CONCEPT_LOCK = "concept_lock"
SCREENPLAY_LOCK = "screenplay_lock"
AV_DESIGN_LOCK = "av_design_lock"
PRODUCTION_LOCK = "production_lock"


@dataclass(frozen=True, slots=True)
class CatalogStep:
    """One L0/S1/S2/S3 step's refined identity/owner/completion contract."""

    step_id: str
    stage: str  # project | l0 | s1 | s2 | s3
    title: str
    execution: str  # required | conditional
    owner: str
    kind: str  # logical output artifact kind (creative index kind slug)
    inputs: tuple[str, ...]  # upstream step ids
    completion: str
    surface: str
    is_lock: bool = False
    approval_stage: str | None = None
    wfm1_compat: str | None = field(default=None)  # legacy minimal equivalent, if any


_ROWS: tuple[CatalogStep, ...] = (
    # --- Project / L0 --------------------------------------------------------
    CatalogStep(
        "Project-Init",
        "project",
        "项目初始化",
        "required",
        "用户定义；CLI 校验",
        "project_profile",
        (),
        "profile schema/引用/预算约束有效，形成不可变版本",
        SURFACE_WFM1_PROFILE,
        wfm1_compat="profile/project_profile",
    ),
    CatalogStep(
        "L0-01",
        "l0",
        "灵感捕捉",
        "required",
        "Agent 整理；用户确认",
        "idea_card",
        ("Project-Init",),
        "核心吸引点、人物/冲突线索和未知项可定位",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "L0-02",
        "l0",
        "强概念提炼",
        "required",
        "Agent 生成候选；用户选择",
        "logline_set",
        ("L0-01", "Project-Init"),
        "候选互有区分，均说明主角、目标、阻力和独特机制",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "L0-03",
        "l0",
        "载荷声明",
        "required",
        "Agent 分析；用户锁定",
        "load_declaration",
        ("L0-01", "L0-02", "Project-Init"),
        "一项主载荷、至多一项次载荷，二者不得相同",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "L0-04",
        "l0",
        "短篇适配",
        "required",
        "Agent 分析；用户判断",
        "short_form_test",
        ("L0-02", "L0-03"),
        "开场、升级、转折、余味完整，存在不可逆变化",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "L0-05",
        "l0",
        "可行性判断",
        "required",
        "application service 估算；用户裁决",
        "feasibility_report",
        ("L0-04", "L0-02"),
        "P50/P90、主要风险和降级方案明确，P90 不越硬上限",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "L0-06",
        "l0",
        "概念试制",
        "required",
        "Agent/Provider 产候选；Orchestrator 登记；用户评价",
        "concept_probe",
        ("L0-03", "L0-04", "L0-05"),
        "三类代表镜头有结果，至少一个方案通过内容、视觉和成本检查",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "L0-07",
        "l0",
        "创意定稿",
        "required",
        "用户最终批准",
        "concept_lock",
        ("L0-02", "L0-03", "L0-04", "L0-05", "L0-06"),
        "主/次载荷、logline、结尾、机制、允许的未决项均被 digest 锁定",
        SURFACE_CREATIVE,
        is_lock=True,
        approval_stage=CONCEPT_LOCK,
        wfm1_compat="planning/brief",
    ),
    # --- S1 叙事设计 ---------------------------------------------------------
    CatalogStep(
        "S1-T01",
        "s1",
        "作品圣经",
        "required",
        "Agent 起草；用户修订",
        "story_bible",
        ("L0-07", "Project-Init"),
        "世界、人物、规则、主题和禁止项与 concept lock 一致",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S1-T02",
        "s1",
        "节拍设计",
        "required",
        "Agent 起草；用户判断",
        "beat_sheet",
        ("L0-07", "S1-T01"),
        "开场、升级、转折、结尾余味均有时间/叙事责任",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S1-T03",
        "s1",
        "人物变化",
        "required",
        "Agent 起草；用户判断",
        "character_arc",
        ("L0-07", "S1-T01", "S1-T02"),
        "欲望、选择、代价和变化能由镜头行动表现",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S1-T04",
        "s1",
        "剧本初稿",
        "required",
        "Agent 起草；用户修订",
        "screenplay",
        ("S1-T01", "S1-T02", "S1-T03"),
        "时长和结构可执行，所有关键行为可映射至既定节拍",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S1-T05",
        "s1",
        "主载荷审核",
        "required",
        "Agent 辅助检查；用户结论",
        "load_review",
        ("S1-T04", "L0-03", "L0-07"),
        "主载荷 Checklist 有逐项证据、问题和处置结论",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S1-T06",
        "s1",
        "叙事风险审核",
        "required",
        "Agent 辅助检查；用户结论",
        "narrative_qc",
        ("S1-T04", "S1-T01", "S1-T02", "S1-T03"),
        "逻辑、信息、公平性和说教风险均有结构化结论",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S1-T07",
        "s1",
        "剧本锁定",
        "required",
        "用户最终批准",
        "screenplay_lock",
        ("S1-T04", "S1-T05", "S1-T06"),
        "阻断问题关闭，锁定 screenplay 及全部依赖 digest",
        SURFACE_CREATIVE,
        is_lock=True,
        approval_stage=SCREENPLAY_LOCK,
        wfm1_compat="planning/story",
    ),
    # --- S2 视听设计 ---------------------------------------------------------
    CatalogStep(
        "S2-T01",
        "s2",
        "格式锁定",
        "required",
        "application service 校验；用户批准",
        "format_lock",
        ("S1-T07",),
        "平台、画幅、分辨率、帧率、时长和交付约束明确",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S2-T02",
        "s2",
        "视觉圣经",
        "required",
        "Agent 起草；用户锁定",
        "visual_bible",
        ("L0-07", "S1-T07", "L0-03", "S2-T01"),
        "风格、反例、色彩、材质和一致性规则可执行",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S2-T03",
        "s2",
        "设计登记",
        "required",
        "Agent/用户设计；application service 登记",
        "design_registry",
        ("S1-T07", "S2-T02"),
        "角色、服装、场景、道具均有稳定 ref 和版本策略",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S2-T04",
        "s2",
        "摄影规则",
        "required",
        "Agent 起草；用户锁定",
        "cinematography_guide",
        ("S2-T01", "S2-T02", "S2-T03", "L0-03"),
        "构图、光线、镜头运动、连续性和禁用模式明确",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S2-T05",
        "s2",
        "声音圣经",
        "required",
        "Agent 起草；用户锁定",
        "audio_bible",
        ("S1-T07", "L0-03", "S2-T01"),
        "对白、旁白、音乐、环境声、音效和响度意图明确",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S2-T06",
        "s2",
        "代表镜头试制",
        "required",
        "Provider/外部工具产候选；Orchestrator 登记；用户选择",
        "visual_probe",
        ("S2-T01", "S2-T02", "S2-T03", "S2-T04", "S2-T05"),
        "人物近景、中景、最难镜头均通过内容/一致性/成本门槛",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S2-T07",
        "s2",
        "视听锁定",
        "required",
        "用户最终批准",
        "av_design_lock",
        ("S2-T01", "S2-T02", "S2-T03", "S2-T04", "S2-T05", "S2-T06"),
        "视听规则、正式资产版本和允许偏差被 digest 锁定",
        SURFACE_CREATIVE,
        is_lock=True,
        approval_stage=AV_DESIGN_LOCK,
    ),
    # --- S3 生产设计 ---------------------------------------------------------
    CatalogStep(
        "S3-T01",
        "s3",
        "镜头拆分",
        "required",
        "Agent 起草；用户确认；CLI 校验",
        "shot_list",
        ("S1-T07", "S2-T07", "S2-T01"),
        "镜头顺序、时长、叙事责任和连续性引用完整",
        SURFACE_CREATIVE,
        wfm1_compat="planning/shot_plan",
    ),
    CatalogStep(
        "S3-T02",
        "s3",
        "镜头任务卡",
        "required",
        "planning service 编译；用户检查",
        "shot_card",
        ("S3-T01", "S1-T07", "S2-T07"),
        "每镜头输入、prompt intent、验收标准和返工边界明确",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S3-T03",
        "s3",
        "生产路线",
        "required",
        "planning service 建议；用户批准",
        "production_route",
        ("S3-T02", "L0-05"),
        "每镜头静帧/2.5D/i2v/t2v/人工路线及备用策略明确",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S3-T04",
        "s3",
        "Provider 计划",
        "required",
        "registry/selection service；用户批准",
        "provider_plan",
        ("S3-T03",),
        "主/备 Provider 与模型可用、可审计且不绑定错误厂商 schema",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S3-T05",
        "s3",
        "镜头预算",
        "required",
        "budget service",
        "shot_budget",
        ("S3-T02", "S3-T04"),
        "尝试次数、单镜/单集/月度额度和 fallback 影响均不过硬门槛",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S3-T06",
        "s3",
        "生产预检",
        "required",
        "application service",
        "preflight_report",
        ("S3-T01", "S3-T02", "S3-T03", "S3-T04", "S3-T05"),
        "连续性、可生成性、输入版本、审批、Provider 和预算无阻断",
        SURFACE_CREATIVE,
    ),
    CatalogStep(
        "S3-T07",
        "s3",
        "生产锁定",
        "required",
        "用户批准；planning service 编译",
        "production_design_lock",
        ("S3-T01", "S3-T02", "S3-T03", "S3-T04", "S3-T05", "S3-T06"),
        "每镜头方法、输入、模型、预算、验收标准和 digest 全部锁定",
        # The S3 production DESIGN lock is a creative index (binds all S3 design
        # indexes); the WFM1 packet compile + production_lock approval stay on the
        # planning/approval surface (wfm1_compat).
        SURFACE_CREATIVE,
        is_lock=True,
        approval_stage=PRODUCTION_LOCK,
        wfm1_compat="planning/packets",
    ),
)

_BY_ID = {row.step_id: row for row in _ROWS}
STAGE_ORDER: tuple[str, ...] = ("project", "l0", "s1", "s2", "s3")


def steps(stage: str | None = None) -> tuple[CatalogStep, ...]:
    """All catalog steps, optionally filtered to one stage, in baseline order."""
    if stage is None:
        return _ROWS
    return tuple(row for row in _ROWS if row.stage == stage)


def step(step_id: str) -> CatalogStep:
    """The catalog row for ``step_id`` (raises KeyError if unknown)."""
    return _BY_ID[step_id]


def stages() -> tuple[str, ...]:
    return STAGE_ORDER


def lock_steps() -> tuple[CatalogStep, ...]:
    """The four human stage-lock steps, in order."""
    return tuple(row for row in _ROWS if row.is_lock)

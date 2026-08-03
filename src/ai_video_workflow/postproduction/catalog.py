"""The WFM2 S5/S6/S7 post-production, QC, release & archive step catalog
(TASK-036 / ADR-0039).

A data-driven refinement of the approved semantic I/O baseline
(``docs/design/workflow-stage-step-io-contract.md`` §8–§10) into a queryable
catalog. For every S5–S7 step it fixes: the producing owner, the execution class
(``required`` / ``conditional`` / ``optional-data``), the logical output artifact
kind, the FACT DOMAIN whose unique writer produces it (ADR-0039 P5: technical QC,
subjective QC, stage approval, release and post-mortem are separate domains that
never reuse one another's state), the upstream step inputs, the completion
condition, and whether the step ends in a human final judgement (ADR-0039 P7).

It refines, never deletes or merges, the baseline steps and keeps every existing
stage/step id unchanged. This module is pure data + accessors: no IO, no Provider,
no approval, no QC computation.
"""

from __future__ import annotations

from dataclasses import dataclass

# Execution classes (drive completion + missing-data semantics).
EXEC_REQUIRED = "required"
EXEC_CONDITIONAL = "conditional"  # may legitimately be not_applicable
EXEC_OPTIONAL_DATA = "optional-data"  # may legitimately be unavailable
_EXECUTIONS = frozenset({EXEC_REQUIRED, EXEC_CONDITIONAL, EXEC_OPTIONAL_DATA})

# Fact domains (ADR-0039 P5 — each has a UNIQUE writer; states never cross).
FD_POST_MEDIA = "post_media"  # assembly/rough/fine cut, mix, master candidate
FD_LOAD_REVIEW = "load_review"  # S5 主载荷终检 (user final judgement)
FD_QC_NARRATIVE = "qc_narrative"
FD_QC_CONTINUITY = "qc_continuity"
FD_QC_TECHNICAL = "qc_technical"
FD_QC_RIGHTS = "qc_rights"
FD_RELEASE = "release"  # platform package + release/termination result
FD_POSTMORTEM = "postmortem"
FD_SCORECARD = "scorecard"
FD_PERFORMANCE = "performance"
FD_REUSE = "reuse"
FD_KNOWLEDGE = "knowledge"
_FACT_DOMAINS = frozenset(
    {
        FD_POST_MEDIA,
        FD_LOAD_REVIEW,
        FD_QC_NARRATIVE,
        FD_QC_CONTINUITY,
        FD_QC_TECHNICAL,
        FD_QC_RIGHTS,
        FD_RELEASE,
        FD_POSTMORTEM,
        FD_SCORECARD,
        FD_PERFORMANCE,
        FD_REUSE,
        FD_KNOWLEDGE,
    }
)

STAGES: tuple[str, ...] = ("s5", "s6", "s7")


@dataclass(frozen=True, slots=True)
class CatalogStep:
    """One S5/S6/S7 step's refined identity/owner/domain/completion contract."""

    step_id: str
    stage: str  # s5 | s6 | s7
    title: str
    execution: str  # required | conditional | optional-data
    owner: str
    kind: str  # logical output artifact kind slug
    fact_domain: str  # the unique writer's fact domain (P5)
    inputs: tuple[str, ...]  # upstream POST-PRODUCTION step ids (intra lineage)
    completion: str
    human_gate: bool = False  # ends in a user final judgement (P7)
    # Cross-surface source provenance a PRODUCED artifact of this step MUST bind
    # (≥1 input_ref per listed surface), e.g. the media assets a mix/master/rights
    # conclusion is derived from — so cross-surface source lineage can never be
    # omitted (ADR-0039 P6, Invariant 5). Empty = no cross-surface requirement.
    required_input_surfaces: tuple[str, ...] = ()


_ROWS: tuple[CatalogStep, ...] = (
    # --- S5 装配后期 --------------------------------------------------------
    CatalogStep(
        "S5-T01",
        "s5",
        "初始时间线",
        EXEC_REQUIRED,
        "composition/edit service",
        "assembly_timeline",
        FD_POST_MEDIA,
        (),
        "镜头、音频槽位、转场和源引用完整，可确定性重建",
    ),
    CatalogStep(
        "S5-T02",
        "s5",
        "粗剪",
        EXEC_REQUIRED,
        "编辑工具/用户；application service 导入登记",
        "rough_cut",
        FD_POST_MEDIA,
        ("S5-T01",),
        "故事可理解，缺口和返工对象有精确版本绑定",
    ),
    CatalogStep(
        "S5-T03",
        "s5",
        "精剪",
        EXEC_REQUIRED,
        "编辑工具/用户；application service 导入登记",
        "fine_cut",
        FD_POST_MEDIA,
        ("S5-T02",),
        "节奏、情绪和镜头连续性达到锁定目标，历史版本保留",
    ),
    CatalogStep(
        "S5-T04",
        "s5",
        "混音",
        EXEC_REQUIRED,
        "audio/composition service + 用户检查（TASK-008）",
        "audio_mix",
        FD_POST_MEDIA,
        ("S5-T03",),
        "required 声音层、增益/响度和源谱系完整，输出通过技术校验",
        required_input_surfaces=("media",),
    ),
    CatalogStep(
        "S5-T05",
        "s5",
        "字幕/修复/调色 → 母版候选",
        EXEC_REQUIRED,
        "media tools + 用户；application service 登记（TASK-008 集成）",
        "master_candidate",
        FD_POST_MEDIA,
        ("S5-T03", "S5-T04"),
        "有对白时字幕与音频同步（无字幕记 not_applicable+依据）；"
        "画面/编码符合锁定格式；产出版本化母版候选",
        required_input_surfaces=("media",),
    ),
    CatalogStep(
        "S5-T06",
        "s5",
        "主载荷终检",
        EXEC_REQUIRED,
        "Agent 辅助；用户最终判断",
        "final_load_review",
        FD_LOAD_REVIEW,
        ("S5-T05",),
        "主载荷有证据成立，阻断问题关闭或明确退回目标步骤",
        human_gate=True,
    ),
    # --- S6 质量与发布 ------------------------------------------------------
    CatalogStep(
        "S6-T01",
        "s6",
        "叙事 QC",
        EXEC_REQUIRED,
        "Agent/检查包辅助；用户结论",
        "narrative_qc",
        FD_QC_NARRATIVE,
        ("S5-T06",),
        "理解、节奏、信息和主载荷无阻断问题",
        human_gate=True,
    ),
    CatalogStep(
        "S6-T02",
        "s6",
        "连续性 QC",
        EXEC_REQUIRED,
        "application/Agent 辅助；用户结论",
        "continuity_qc",
        FD_QC_CONTINUITY,
        ("S5-T06",),
        "角色、场景、道具、动作和镜头连接问题均有证据/处置",
        human_gate=True,
    ),
    CatalogStep(
        "S6-T03",
        "s6",
        "技术 QC",
        EXEC_REQUIRED,
        "media inspector/application service",
        "technical_qc",
        FD_QC_TECHNICAL,
        ("S5-T06",),
        "音画、字幕、编码、分辨率、帧率和响度通过硬检查",
    ),
    CatalogStep(
        "S6-T04",
        "s6",
        "权利与来源 QC",
        EXEC_REQUIRED,
        "application service 汇总；用户确认",
        "rights_qc",
        FD_QC_RIGHTS,
        ("S5-T06",),
        "所有正式媒体可追溯，未知权利或来源问题均阻断",
        human_gate=True,
        required_input_surfaces=("media",),
    ),
    CatalogStep(
        "S6-T05",
        "s6",
        "发布包",
        EXEC_REQUIRED,
        "release service",
        "release_package",
        FD_RELEASE,
        ("S6-T01", "S6-T02", "S6-T03", "S6-T04"),
        "每个平台包引用精确母版/元数据 digest，离线可检查且不覆盖",
    ),
    CatalogStep(
        "S6-T06",
        "s6",
        "发布结果",
        EXEC_REQUIRED,
        "用户执行/确认；release service 记录",
        "release_result",
        FD_RELEASE,
        ("S6-T05",),
        "成功、失败、延期或终止明确，外部引用不以临时 URL 作为唯一身份",
        human_gate=True,
    ),
    # --- S7 复盘归档 --------------------------------------------------------
    CatalogStep(
        "S7-T01",
        "s7",
        "QCD 复盘",
        EXEC_REQUIRED,
        "analytics service 派生；用户补充结论",
        "postmortem",
        FD_POSTMORTEM,
        ("S6-T06",),
        "时间、成本、返工、失败、未解决问题均可追溯并可重算",
    ),
    CatalogStep(
        "S7-T02",
        "s7",
        "Provider 表现",
        EXEC_REQUIRED,
        "analytics service 派生；用户解释",
        "provider_scorecard",
        FD_SCORECARD,
        ("S7-T01",),
        "质量、稳定性、成本效率和样本范围明确，不跨币种错误相加",
    ),
    CatalogStep(
        "S7-T03",
        "s7",
        "观众数据",
        EXEC_OPTIONAL_DATA,
        "用户导入；application service 校验",
        "performance_snapshot",
        FD_PERFORMANCE,
        ("S6-T06",),
        "缺失与零分离（缺失记 unavailable），来源、范围、时间和局限明确",
    ),
    CatalogStep(
        "S7-T04",
        "s7",
        "复用候选",
        EXEC_REQUIRED,
        "analytics/Agent 提议；用户审查",
        "reuse_candidate",
        FD_REUSE,
        ("S7-T01", "S7-T02"),
        "每项候选有来源 refs、适用条件、失败证据和推荐处置",
    ),
    CatalogStep(
        "S7-T05",
        "s7",
        "经验提升",
        EXEC_CONDITIONAL,
        "用户批准；知识 application service 发布",
        "knowledge_promotion",
        FD_KNOWLEDGE,
        ("S7-T04",),
        "产生新不可变版本并保留来源；不得自动改写既有项目或替代用户决定",
        human_gate=True,
    ),
)

_BY_ID = {row.step_id: row for row in _ROWS}


def steps(stage: str | None = None) -> tuple[CatalogStep, ...]:
    """All catalog steps, optionally filtered to one stage, in baseline order."""
    if stage is None:
        return _ROWS
    return tuple(row for row in _ROWS if row.stage == stage)


def step(step_id: str) -> CatalogStep:
    """The catalog row for ``step_id`` (raises KeyError if unknown)."""
    return _BY_ID[step_id]


def stages() -> tuple[str, ...]:
    return STAGES


def human_gate_steps() -> tuple[CatalogStep, ...]:
    """Every step that ends in a user final judgement (P7), in order."""
    return tuple(row for row in _ROWS if row.human_gate)


def fact_domains() -> frozenset[str]:
    return _FACT_DOMAINS


def executions() -> frozenset[str]:
    return _EXECUTIONS

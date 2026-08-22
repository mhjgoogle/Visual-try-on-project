"""WFM1 approved Gateway command registry (TASK-031 / ADR-0033/0034/0035).

Maps the workspace's controlled creative-write operations to approved
application services, each registered as a Command Gateway spec so the UI drives
them ONLY through the Gateway (version binding, preflight, idempotent receipts,
fail-closed admission) — never a direct service or Provider call.

Scope under the current no-spend posture: the creative FACT-write closed-loop
(evaluation / feedback / action). These are low-risk (no Provider, no money);
the paid core operations (start / retry / new-parameters / resume) are NOT
registered here — their high-risk preflight+confirmation mechanism is proven at
the Gateway level (TASK-030) and they are wired only when paid usage is
authorized.

Each spec validates its params in the READ-ONLY ``preview`` and surfaces bad
input as a fail-closed BLOCKER (a retryable refusal), so ``apply`` runs only on
valid input and an ``apply`` exception is a genuine unknown side effect
(AMBIGUOUS), never mere input validation.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from ai_video_workflow.app.clock import utc_now
from ai_video_workflow.gateway.commands import (
    CommandEnvelope,
    CommandRegistry,
    CommandRisk,
    CommandSpec,
    Preview,
)
from ai_video_workflow.project_data import owning_project_id

# The command names the workspace UI may submit (approved operations only).
RECORD_EVALUATION = "record-evaluation"
CREATE_FEEDBACK = "create-feedback"
CREATE_ACTION = "create-action"
ACTION_TRANSITION = "action-transition"


def build_gateway(project_root, clock):
    """Construct a CommandGateway over the approved WFM1 registry for a project.

    Single factory the workspace shell uses, so the shell's only core write-path
    imports are this module + the public Gateway package — it never reaches a
    Provider, Orchestrator internal, or business writer.
    """
    from ai_video_workflow.action import WorkflowTargetResolver
    from ai_video_workflow.gateway import CommandGateway

    return CommandGateway(
        project_root,
        registry=build_wfm1_registry(),
        target_resolver=WorkflowTargetResolver(),
        clock=clock,
    )


def build_wfm1_registry() -> CommandRegistry:
    """Build the approved WFM1 creative-write command registry."""
    registry = CommandRegistry()
    registry.register(
        CommandSpec(RECORD_EVALUATION, CommandRisk.LOW, _eval_preview, _eval_apply)
    )
    registry.register(
        CommandSpec(
            CREATE_FEEDBACK, CommandRisk.LOW, _feedback_preview, _feedback_apply
        )
    )
    registry.register(
        CommandSpec(CREATE_ACTION, CommandRisk.LOW, _action_preview, _action_apply)
    )
    registry.register(
        CommandSpec(
            ACTION_TRANSITION,
            CommandRisk.LOW,
            _transition_preview,
            _transition_apply,
            requires_target=False,  # acts on an existing Action, not a fresh target
        )
    )
    return registry


# --- shared helpers -----------------------------------------------------------


def _missing(params: Mapping, required: tuple[str, ...]) -> list[str]:
    return [f"missing param {k!r}" for k in required if params.get(k) in (None, "")]


def _preview(
    params: Mapping, required: tuple[str, ...], blockers_extra: list[str] | None = None
) -> Preview:
    blockers = _missing(params, required) + (blockers_extra or [])
    return Preview(
        inputs={k: params.get(k) for k in required},
        estimated_cost=None,  # creative fact-writes spend nothing
        downstream=(),
        blockers=tuple(blockers),
    )


def _require_owner(project_root: Path) -> str:
    owner = owning_project_id(project_root)
    if owner is None:
        # apply-time guard; preview already blocks on a missing project below
        raise ValueError("project identity unresolved")
    return owner


# --- record-evaluation --------------------------------------------------------


def _eval_preview(project_root: Path, envelope: CommandEnvelope) -> Preview:
    p = envelope.params
    extra: list[str] = []
    if owning_project_id(project_root) is None:
        extra.append("no project identity (project.json missing)")
    if envelope.actor not in ("user", "ai"):
        extra.append("actor must be 'user' or 'ai'")
    if not isinstance(p.get("pass"), bool):
        extra.append("param 'pass' must be a bool")
    return _preview(p, ("evaluation_id", "criterion", "rationale"), extra)


def _eval_apply(project_root: Path, envelope: CommandEnvelope) -> dict:
    from ai_video_workflow.evaluation import (
        EvaluationActor,
        EvaluationService,
        WorkflowAuthoritativeFacts,
    )

    p = envelope.params
    svc = EvaluationService(
        project_root,
        _require_owner(project_root),
        facts=WorkflowAuthoritativeFacts(),
        clock=utc_now,
    )
    record = svc.record_evaluation(
        actor=EvaluationActor(envelope.actor),
        target=dict(envelope.target),
        evaluation_id=p["evaluation_id"],
        criterion=p["criterion"],
        score=p.get("score"),
        tag=p.get("tag"),
        passed=bool(p["pass"]),
        rationale=p["rationale"],
    )
    return {"kind": "evaluation", "record_id": record.record_id}


# --- create-feedback ----------------------------------------------------------


def _feedback_preview(project_root: Path, envelope: CommandEnvelope) -> Preview:
    p = envelope.params
    extra: list[str] = []
    if owning_project_id(project_root) is None:
        extra.append("no project identity (project.json missing)")
    if envelope.actor not in ("user", "agent", "system"):
        extra.append("actor must be 'user', 'agent', or 'system'")
    if p.get("context") is not None and not isinstance(p.get("context"), dict):
        extra.append("param 'context' must be an object")
    return _preview(p, ("feedback_id", "summary", "detail"), extra)


def _feedback_apply(project_root: Path, envelope: CommandEnvelope) -> dict:
    from ai_video_workflow.action import (
        ActionActor,
        ActionService,
        WorkflowTargetResolver,
    )

    p = envelope.params
    svc = ActionService(
        project_root,
        _require_owner(project_root),
        resolver=WorkflowTargetResolver(),
        clock=utc_now,
    )
    record = svc.create_feedback(
        actor=ActionActor(envelope.actor),
        feedback_id=p["feedback_id"],
        target=dict(envelope.target),
        context=dict(p.get("context") or {}),
        summary=p["summary"],
        detail=p["detail"],
    )
    return {"kind": "feedback", "record_id": record.record_id}


# --- create-action ------------------------------------------------------------


def _action_preview(project_root: Path, envelope: CommandEnvelope) -> Preview:
    p = envelope.params
    extra: list[str] = []
    if owning_project_id(project_root) is None:
        extra.append("no project identity (project.json missing)")
    if envelope.actor not in ("user", "agent", "system"):
        extra.append("actor must be 'user', 'agent', or 'system'")
    if p.get("context") is not None and not isinstance(p.get("context"), dict):
        extra.append("param 'context' must be an object")
    return _preview(p, ("action_id", "intent"), extra)


def _action_apply(project_root: Path, envelope: CommandEnvelope) -> dict:
    from ai_video_workflow.action import (
        ActionActor,
        ActionService,
        WorkflowTargetResolver,
    )

    p = envelope.params
    svc = ActionService(
        project_root,
        _require_owner(project_root),
        resolver=WorkflowTargetResolver(),
        clock=utc_now,
    )
    record = svc.create_action(
        actor=ActionActor(envelope.actor),
        action_id=p["action_id"],
        feedback_id=p.get("feedback_id"),
        target=dict(envelope.target),
        context=dict(p.get("context") or {}),
        intent=p["intent"],
    )
    return {"kind": "action", "record_id": record.record_id}


# --- action-transition --------------------------------------------------------


def _transition_preview(project_root: Path, envelope: CommandEnvelope) -> Preview:
    p = envelope.params
    extra: list[str] = []
    if owning_project_id(project_root) is None:
        extra.append("no project identity (project.json missing)")
    if envelope.actor not in ("user", "agent", "system"):
        extra.append("actor must be 'user', 'agent', or 'system'")
    return _preview(p, ("event_id", "action_id", "to_state"), extra)


def _transition_apply(project_root: Path, envelope: CommandEnvelope) -> dict:
    from ai_video_workflow.action import (
        ActionActor,
        ActionService,
        WorkflowTargetResolver,
    )

    p = envelope.params
    svc = ActionService(
        project_root,
        _require_owner(project_root),
        resolver=WorkflowTargetResolver(),
        clock=utc_now,
    )
    record = svc.transition(
        actor=ActionActor(envelope.actor),
        event_id=p["event_id"],
        action_id=p["action_id"],
        to_state=p["to_state"],
    )
    return {"kind": "transition", "record_id": record.record_id}

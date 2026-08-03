"""Evaluation-domain application service: binding, stale, and actor policy.

The single approved write path for evaluation / experiment / creative-decision
facts before the Command Gateway (ADR-0034 / ADR-0032). It sits above the
append-only log (:mod:`ai_video_workflow.evaluation.log`) and enforces the
boundary policy the raw record model cannot:

- **Target + goals binding (fail-closed at write).** Every record binds a
  ``target`` (ref + version + content_digest) and the current project-goals
  version. On write the service verifies the supplied target resolves to an
  authoritative fact with a matching digest and binds the *current* goals
  version itself — it never silently fills a missing digest and never records
  an evaluation of a target that does not currently exist (ADR-0034 P3;
  mirroring ``release.delivery.record_final_review``).
- **Stale derivation (read time).** The log only stores facts; staleness is
  *derived* on read by re-resolving each record's target and goals against the
  current authoritative facts. Goals drift, a newer target version, a drifted
  digest, or a vanished target each mark the record ``stale`` with a structured
  reason — the log is never rewritten (ADR-0034 P4; mirroring
  ``approval.gate.require_stage_approved`` and ``release.delivery.package_release``).
- **Actor separation / user final judgement.** AI output is advisory evidence
  only: the service refuses an ``ai``-authored evaluation with ``pass=true`` and
  an ``ai``-authored ``select`` (auto-winner) creative decision. The final pass
  and the winning creative decision must be ``actor = user`` (ADR-0034 P5).

The service holds no persistent projection: goals and targets are resolved on
demand through an injected :class:`AuthoritativeFacts` resolver, so it never
couples the evaluation domain to any other state domain (ADR-0010 decision 7)
and "delete the projection, rebuild" stays trivially satisfied. The clock is
injected so ``occurred_at`` is deterministic under test (the TASK-004
time-authority rule carried into WFM1).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol

from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.evaluation.log import append_record, read_records
from ai_video_workflow.evaluation.records import (
    EvaluationActor,
    EvaluationRecord,
    EvaluationRecordType,
    build_creative_decision_record,
    build_evaluation_record,
    build_experiment_record,
)
from ai_video_workflow.manifest import JsonCompatibleValue

# The one creative-decision type that expresses a winner (ADR-0034 §5.3): an AI
# actor may not form it (auto-winner), just as it may not form pass=true.
_WINNER_DECISION_TYPE = "select"


class EvaluationServiceError(AiVideoWorkflowError):
    """Base error for the evaluation-domain application service."""


class EvaluationActorError(EvaluationServiceError):
    """Raised when an AI actor would form a final pass or an auto-winner."""


class StaleTargetError(EvaluationServiceError):
    """Raised when a write's target or goals do not match authoritative facts."""


class MissingGoalsBaselineError(EvaluationServiceError):
    """Raised when a write is attempted with no project-goals baseline to bind."""


@dataclass(frozen=True, slots=True)
class TargetFact:
    """The authoritative snapshot of one evaluation target, as resolved now.

    ``exists`` is whether ``(ref, version)`` currently resolves to an
    authoritative fact; ``content_digest`` is that fact's digest (``None`` when
    it does not exist); ``latest_version`` is the newest authoritative version
    of the same ``ref`` (``None`` when the resolver does not track cross-version
    drift), used only to derive the "a newer version exists" stale reason.
    """

    exists: bool
    content_digest: str | None
    latest_version: int | None = None


class AuthoritativeFacts(Protocol):
    """Read-only resolver of the authoritative facts an evaluation references.

    The evaluation domain is a separate state domain and only *references*
    existing facts (ADR-0034 P2). This protocol is the single seam through
    which the service reaches them; concrete resolvers (see
    :mod:`ai_video_workflow.evaluation.resolvers`) read authoritative sources
    read-only and never write or copy them.
    """

    def current_goals_version(self, project_root: Path) -> int | None:
        """Return the current project-goals baseline version, or ``None``."""
        ...

    def resolve_target(
        self, project_root: Path, *, ref: str, version: int
    ) -> TargetFact:
        """Resolve one target ``(ref, version)`` to its authoritative snapshot."""
        ...


@dataclass(frozen=True, slots=True)
class Staleness:
    """A record's derived staleness: ``is_stale`` plus structured reasons."""

    is_stale: bool
    reasons: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class EvaluationView:
    """One record paired with its read-time derived staleness."""

    record: EvaluationRecord
    staleness: Staleness


class EvaluationService:
    """The approved binding/stale/actor-checked write path for one project."""

    def __init__(
        self,
        project_root: Path,
        project_id: str,
        *,
        facts: AuthoritativeFacts,
        clock: Callable[[], datetime],
    ) -> None:
        self._project_root = project_root
        self._project_id = project_id
        self._facts = facts
        self._clock = clock

    # --- write path (bind + actor policy + atomic append) ----------------

    def record_evaluation(
        self,
        *,
        actor: EvaluationActor,
        target: Mapping[str, JsonCompatibleValue],
        evaluation_id: str,
        criterion: str,
        score: int | None,
        tag: str | None,
        passed: bool,
        rationale: str,
        occurred_at: datetime | None = None,
    ) -> EvaluationRecord:
        """Record one scored/tagged assessment, bound to authoritative facts.

        Refuses an AI-authored ``pass=true`` (final pass is the user's), binds
        the current goals version, verifies the target, then appends.
        """
        if actor is EvaluationActor.AI and passed:
            raise EvaluationActorError(
                "an AI actor cannot form a pass=true evaluation; the final pass "
                "must be actor=user (ADR-0034 P5)"
            )
        goals_version = self._bind_goals()
        self._verify_target(target)
        record = build_evaluation_record(
            project_id=self._project_id,
            actor=actor,
            target=target,
            goals_version=goals_version,
            evaluation_id=evaluation_id,
            criterion=criterion,
            score=score,
            tag=tag,
            passed=passed,
            rationale=rationale,
            occurred_at=self._at(occurred_at),
        )
        append_record(self._project_root, record)
        return record

    def record_experiment(
        self,
        *,
        actor: EvaluationActor,
        target: Mapping[str, JsonCompatibleValue],
        experiment_id: str,
        variants: list,
        changed_factor: str,
        expected_improvement: str,
        actual_result: str | None,
        reuse_conclusion: str | None,
        occurred_at: datetime | None = None,
    ) -> EvaluationRecord:
        """Record one variant comparison, binding the subject and every variant.

        The subject ``target`` and each compared variant must resolve to an
        authoritative fact with a matching digest (a comparison cannot be bound
        to a variant that does not exist).
        """
        goals_version = self._bind_goals()
        self._verify_target(target)
        for index, variant in enumerate(variants):
            self._verify_target(variant, label=f"variant[{index}]")
        record = build_experiment_record(
            project_id=self._project_id,
            actor=actor,
            target=target,
            goals_version=goals_version,
            experiment_id=experiment_id,
            variants=variants,
            changed_factor=changed_factor,
            expected_improvement=expected_improvement,
            actual_result=actual_result,
            reuse_conclusion=reuse_conclusion,
            occurred_at=self._at(occurred_at),
        )
        append_record(self._project_root, record)
        return record

    def record_creative_decision(
        self,
        *,
        actor: EvaluationActor,
        target: Mapping[str, JsonCompatibleValue],
        decision_id: str,
        decision_type: str,
        changed: str,
        why: str,
        expected: str,
        actual: str | None,
        occurred_at: datetime | None = None,
    ) -> EvaluationRecord:
        """Record one creative decision (select/abandon/redo/...), bound + checked.

        Refuses an AI-authored ``select`` (auto-winner); the winning creative
        decision is the user's (ADR-0034 P5).
        """
        if actor is EvaluationActor.AI and decision_type == _WINNER_DECISION_TYPE:
            raise EvaluationActorError(
                "an AI actor cannot form a 'select' (auto-winner) creative "
                "decision; the winning decision must be actor=user (ADR-0034 P5)"
            )
        goals_version = self._bind_goals()
        self._verify_target(target)
        record = build_creative_decision_record(
            project_id=self._project_id,
            actor=actor,
            target=target,
            goals_version=goals_version,
            decision_id=decision_id,
            decision_type=decision_type,
            changed=changed,
            why=why,
            expected=expected,
            actual=actual,
            occurred_at=self._at(occurred_at),
        )
        append_record(self._project_root, record)
        return record

    # --- read path (raw facts + derived staleness) -----------------------

    def read(self) -> tuple[EvaluationRecord, ...]:
        """Return every record, de-duplicated first-wins (raw, no derivation)."""
        return read_records(self._project_root)

    def read_views(self) -> tuple[EvaluationView, ...]:
        """Return every record paired with its read-time derived staleness.

        Staleness is derived here, never persisted: a record whose goals
        baseline moved, whose target digest drifted, whose target gained a newer
        version, or whose target vanished is marked ``stale`` with a structured
        reason. The log is not read a second time or rewritten.
        """
        current_goals = self._facts.current_goals_version(self._project_root)
        return tuple(
            EvaluationView(record, self._staleness(record, current_goals))
            for record in self.read()
        )

    # --- internals -------------------------------------------------------

    def _at(self, occurred_at: datetime | None) -> datetime:
        return occurred_at if occurred_at is not None else self._clock()

    def _bind_goals(self) -> int:
        version = self._facts.current_goals_version(self._project_root)
        if version is None:
            raise MissingGoalsBaselineError(
                "no project-goals baseline to bind; record a project profile "
                "before evaluating (ADR-0034 P3)"
            )
        return version

    def _verify_target(
        self, target: Mapping[str, JsonCompatibleValue], *, label: str = "target"
    ) -> None:
        """Fail-closed unless ``target`` resolves to a matching authoritative fact.

        The full target (ref + version + content_digest) must be supplied by the
        caller; the service verifies it and never fills a missing digest
        (ADR-0034: never silently fill). ``build_*`` still runs the structural
        target validation, so here we only need ref/version/digest to index the
        resolver and compare.
        """
        ref = target["ref"]
        version = target["version"]
        digest = target["content_digest"]
        fact = self._facts.resolve_target(
            self._project_root, ref=str(ref), version=int(version)
        )
        if not fact.exists:
            raise StaleTargetError(
                f"{label} {ref!r} v{version} does not resolve to an authoritative "
                "fact; refusing to bind an evaluation to a missing target"
            )
        if fact.content_digest != digest:
            recorded = str(digest)[:12]
            raise StaleTargetError(
                f"{label} {ref!r} v{version} content_digest {recorded}… does not "
                "match the authoritative digest; refusing to bind to a wrong "
                "version (re-evaluate the current target)"
            )

    def _staleness(
        self, record: EvaluationRecord, current_goals: int | None
    ) -> Staleness:
        return staleness_of(
            record,
            facts=self._facts,
            project_root=self._project_root,
            current_goals=current_goals,
        )


def staleness_of(
    record: EvaluationRecord,
    *,
    facts: AuthoritativeFacts,
    project_root: Path,
    current_goals: int | None,
) -> Staleness:
    """Derive one record's staleness against the current authoritative facts.

    The single source of the stale rule, shared by the write service and the
    read-only query layer so both agree (ADR-0034 P3/P4). ``current_goals`` is
    the resolver's current goals version, resolved once by the caller and passed
    in so a batch read makes a single goals lookup. The record and the log are
    never mutated — staleness is purely derived.
    """
    reasons: list[str] = []
    if current_goals is None:
        reasons.append("project-goals baseline is missing")
    elif current_goals != record.goals_version:
        reasons.append(
            f"goals baseline moved from v{record.goals_version} to v{current_goals}"
        )
    for target, label in _targets_of(record):
        reasons.extend(_target_reasons(target, label, facts=facts, root=project_root))
    return Staleness(bool(reasons), tuple(reasons))


def _target_reasons(
    target: Mapping[str, JsonCompatibleValue],
    label: str,
    *,
    facts: AuthoritativeFacts,
    root: Path,
) -> list[str]:
    ref = target["ref"]
    version = target["version"]
    digest = target["content_digest"]
    fact = facts.resolve_target(root, ref=str(ref), version=int(version))
    if not fact.exists:
        return [f"{label} {ref!r} v{version} no longer resolves (target missing)"]
    reasons: list[str] = []
    if fact.content_digest != digest:
        reasons.append(f"{label} {ref!r} v{version} content_digest drifted")
    if fact.latest_version is not None and fact.latest_version > int(version):
        reasons.append(
            f"{label} {ref!r} has a newer authoritative version v{fact.latest_version}"
        )
    return reasons


def _targets_of(
    record: EvaluationRecord,
) -> list[tuple[Mapping[str, JsonCompatibleValue], str]]:
    """Every target a record binds: its subject plus, for experiments, variants."""
    targets: list[tuple[Mapping[str, JsonCompatibleValue], str]] = [
        (record.target, "target")
    ]
    if record.record_type is EvaluationRecordType.EXPERIMENT:
        variants = record.payload["variants"]
        for index, variant in enumerate(variants):
            targets.append((variant, f"variant[{index}]"))
    return targets

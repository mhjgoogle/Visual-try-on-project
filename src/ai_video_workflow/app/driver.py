"""WorkflowDriver: the caller-side of the orchestration lifecycle (TASK-007).

The driver reads the clock and mints operation identities (the core does
neither), loads the task / shot / project / manifest by id (no directory
scan), assembles the OrchestrationContext through the
ProviderRequestFactory, invokes the public ProviderOrchestrator, and
maps an APPLIED status change to a task_status_changed QCD event. It
holds no session state; every call reloads from disk. status is
ResumeAssessment-only (no asset/composition inference, no private
executor access, no new record accessor).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from ai_video_workflow.app.clock import utc_now
from ai_video_workflow.app.contracts import staging_ref_for
from ai_video_workflow.app.ids import (
    new_attempt_id,
    new_operation_id,
    new_rating_id,
)
from ai_video_workflow.app.requests import ProviderRequestFactory
from ai_video_workflow.assets.policy import ValidationPolicy
from ai_video_workflow.assets.step import (
    ValidationStepOutcome,
    record_manual_quality_rating,
    run_validation_step,
)
from ai_video_workflow.composition.step import (
    CompositionStepOutcome,
    run_composition_step,
)
from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.manifest import StepManifest
from ai_video_workflow.models import GenerationTask, Project, Scene, Shot
from ai_video_workflow.orchestration import (
    OrchestrationAction,
    OrchestrationContext,
    OrchestrationOutcome,
    OutcomeKind,
    ProviderOrchestrator,
    ResumeAssessment,
)
from ai_video_workflow.persistence import read_model_json
from ai_video_workflow.providers.base import VideoProvider
from ai_video_workflow.providers.models import (
    ArtifactLocation,
    ArtifactOrigin,
    ArtifactReference,
)
from ai_video_workflow.qcd.events import (
    build_manual_attempt_recorded_event,
    build_task_status_changed_event,
)
from ai_video_workflow.qcd.log import append_event


class StagedFileMissingError(AiVideoWorkflowError):
    """Raised when a declared staged artifact path does not exist."""


@dataclass(frozen=True, slots=True)
class DriverOutcome:
    task_id: str
    action: OrchestrationAction
    operation_id: str
    outcome: OrchestrationOutcome
    emitted_event_ids: tuple[str, ...]
    instruction_path: str | None
    staged_path: str | None


class WorkflowDriver:
    """Stateless caller wrapper over one ProviderOrchestrator."""

    __slots__ = (
        "_provider_id",
        "_orchestrator",
        "_request_factory",
        "_project_root",
        "_inspector",
        "_composer",
        "_clock",
    )

    def __init__(
        self,
        *,
        provider_id: str,
        provider: VideoProvider,
        request_factory: ProviderRequestFactory,
        project_root: Path,
        inspector,
        composer,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._provider_id = provider_id
        self._orchestrator = ProviderOrchestrator(provider)
        self._request_factory = request_factory
        self._project_root = project_root
        self._inspector = inspector
        self._composer = composer
        self._clock = clock

    # --- orchestration lifecycle ---

    def prepare(self, task_id: str) -> DriverOutcome:
        return self._drive(OrchestrationAction.PREPARE, task_id)

    def submit(self, task_id: str) -> DriverOutcome:
        return self._drive(OrchestrationAction.SUBMIT, task_id)

    def poll(self, task_id: str) -> DriverOutcome:
        return self._drive(OrchestrationAction.POLL, task_id)

    def report_artifact(self, task_id: str, staged_path: str) -> DriverOutcome:
        self._require_staged(staged_path)
        return self._drive(
            OrchestrationAction.REPORT_ARTIFACT, task_id, staged_path=staged_path
        )

    def collect(self, task_id: str) -> DriverOutcome:
        staged = staging_ref_for(task_id)
        self._require_staged(staged)
        return self._drive(OrchestrationAction.COLLECT, task_id, staged_path=staged)

    def resume(self, task_id: str) -> ResumeAssessment:
        context = self._context(task_id)
        return self._orchestrator.resume(context)

    def status(self, task_id: str) -> ResumeAssessment:
        # status is a read-only ResumeAssessment view only (no asset or
        # composition inference, no private executor access).
        return self.resume(task_id)

    # --- validation / composition steps (use the injected inspector/composer) ---

    def validate(
        self, task_id: str, *, policy: ValidationPolicy | None = None
    ) -> ValidationStepOutcome:
        task = self._load_task(task_id)
        shot = self._load_shot(task.shot_id)
        scene = self._load_scene(shot.scene_id)
        return run_validation_step(
            project_root=self._project_root,
            shot=shot,
            scene=scene,
            task=task,
            artifact=self._artifact(staging_ref_for(task_id)),
            inspector=self._inspector,
            policy=policy or ValidationPolicy(),
            observed_at=self._clock(),
        )

    def compose(self, data, *, profile=None) -> CompositionStepOutcome:
        return run_composition_step(
            project_root=self._project_root,
            data=data,
            composer=self._composer,
            profile=profile,
            observed_at=self._clock(),
        )

    # --- QCD recording entries ---

    def record_attempt(self, task_id: str, note: str | None) -> str:
        task = self._load_task(task_id)
        project = self._load_project()
        now = self._clock()
        event = build_manual_attempt_recorded_event(
            project_id=project.project_id,
            shot_id=task.shot_id,
            task_id=task.task_id,
            attempt_id=new_attempt_id(),
            provider_id=self._provider_id,
            outcome="produced_candidate",
            occurred_at=now,
            note=note,
        )
        append_event(self._project_root, event)
        return event.event_id

    def record_rating(
        self, *, shot_id: str, task_id: str | None, score: int, note: str | None
    ) -> str:
        project = self._load_project()
        return record_manual_quality_rating(
            self._project_root,
            project_id=project.project_id,
            shot_id=shot_id,
            task_id=task_id,
            rating_id=new_rating_id(),
            score=score,
            asset_id=None,
            occurred_at=self._clock(),
            note=note,
        )

    # --- internals ---

    def _drive(
        self,
        action: OrchestrationAction,
        task_id: str,
        *,
        staged_path: str | None = None,
    ) -> DriverOutcome:
        context = self._context(task_id)
        before_status = context.task.status
        operation_id = new_operation_id()
        now = self._clock()

        if action is OrchestrationAction.PREPARE:
            outcome = self._orchestrator.prepare(
                context, operation_id=operation_id, observed_at=now
            )
        elif action is OrchestrationAction.SUBMIT:
            outcome = self._orchestrator.submit(
                context, operation_id=operation_id, observed_at=now
            )
        elif action is OrchestrationAction.POLL:
            outcome = self._orchestrator.poll(
                context, operation_id=operation_id, observed_at=now
            )
        elif action is OrchestrationAction.REPORT_ARTIFACT:
            outcome = self._orchestrator.report_artifact(
                context,
                operation_id=operation_id,
                artifact=self._artifact(staged_path),
                observed_at=now,
            )
        else:  # COLLECT
            outcome = self._orchestrator.collect(
                context,
                operation_id=operation_id,
                observed_at=now,
                artifact=self._artifact(staged_path),
                completed_at=now,
            )

        emitted = self._emit_status_change(
            outcome, before_status, task_id, action, operation_id, now
        )
        instruction_path = (
            f"tasks/instructions/{task_id}.md"
            if action is OrchestrationAction.PREPARE
            and outcome.kind is OutcomeKind.APPLIED
            else None
        )
        return DriverOutcome(
            task_id=task_id,
            action=action,
            operation_id=operation_id,
            outcome=outcome,
            emitted_event_ids=emitted,
            instruction_path=instruction_path,
            staged_path=staged_path
            if action is OrchestrationAction.REPORT_ARTIFACT
            else None,
        )

    def _emit_status_change(
        self,
        outcome: OrchestrationOutcome,
        before_status,
        task_id: str,
        action: OrchestrationAction,
        operation_id: str,
        now: datetime,
    ) -> tuple[str, ...]:
        if outcome.kind is not OutcomeKind.APPLIED:
            return ()
        updated = outcome.updated_task
        if updated is None or updated.status == before_status:
            return ()
        event = build_task_status_changed_event(
            project_id=self._load_project().project_id,
            shot_id=updated.shot_id,
            task_id=task_id,
            previous_status=before_status.value,
            new_status=updated.status.value,
            orchestration_action=action.value,
            operation_id=operation_id,
            occurred_at=now,
        )
        append_event(self._project_root, event)
        return (event.event_id,)

    def _context(self, task_id: str) -> OrchestrationContext:
        task = self._load_task(task_id)
        shot = self._load_shot(task.shot_id)
        project = self._load_project()
        manifest = self._load_manifest(task_id)
        request = self._request_factory.build(
            project=project, shot=shot, task=task, provider_id=self._provider_id
        )
        return OrchestrationContext(
            project_root=self._project_root,
            request=request,
            task=task,
            manifest=manifest,
        )

    def _artifact(self, staged_path: str | None) -> ArtifactReference:
        assert staged_path is not None
        return ArtifactReference(
            reference=staged_path,
            origin=ArtifactOrigin.USER,
            location=ArtifactLocation.STAGING,
        )

    def _require_staged(self, staged_path: str) -> None:
        # explicit lstat only (no scan, no glob); reject a symlink target
        path = self._project_root / staged_path
        if not path.is_file() or path.is_symlink():
            raise StagedFileMissingError(
                f"staged artifact is missing or not a regular file: {staged_path}"
            )

    def _load_task(self, task_id: str) -> GenerationTask:
        return read_model_json(
            self._project_root / "records" / "generation-tasks" / f"{task_id}.json",
            GenerationTask,
        )

    def _load_shot(self, shot_id: str) -> Shot:
        return read_model_json(
            self._project_root / "records" / "shots" / f"{shot_id}.json", Shot
        )

    def _load_scene(self, scene_id: str) -> Scene:
        return read_model_json(
            self._project_root / "records" / "scenes" / f"{scene_id}.json", Scene
        )

    def _load_project(self) -> Project:
        return read_model_json(self._project_root / "project.json", Project)

    def _load_manifest(self, task_id: str) -> StepManifest:
        return read_model_json(
            self._project_root / "manifests" / f"generation-{task_id}.json",
            StepManifest,
        )

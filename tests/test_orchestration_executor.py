import json
import os
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import pytest

import ai_video_workflow.orchestration as orchestration_package
import ai_video_workflow.orchestration.executor as executor_module
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.models import GenerationTask, GenerationTaskStatus
from ai_video_workflow.orchestration import (
    BaselineMismatchError,
    InvalidRecoveryRecordError,
    MissingProjectStateError,
    MissingRecoveryRecordError,
    OrchestrationAction,
    PartialCommitConflictError,
    PersistenceExecutionError,
    RecordPhase,
    RecoveryDisposition,
    UnknownProviderSideEffectError,
)
from ai_video_workflow.orchestration._models import (
    ABSENT,
    _build_envelope,
)
from ai_video_workflow.orchestration.executor import _FileOrchestrationExecutor
from ai_video_workflow.orchestration.planning import _OrchestrationPlanner
from ai_video_workflow.orchestration.recovery import (
    _classify_orchestration_traces,
    _parse_stable_wrapper,
    _restore_generation_task,
    _restore_step_manifest,
)
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.providers.models import (
    ArtifactLocation,
    ArtifactOrigin,
    ArtifactReference,
    ProviderInstruction,
    ProviderRequest,
    ProviderResult,
    ProviderStatus,
)

T0 = datetime(2026, 7, 26, 9, 0, 0, tzinfo=timezone.utc)
T1 = datetime(2026, 7, 26, 10, 0, 0, tzinfo=timezone.utc)
T2 = datetime(2026, 7, 26, 11, 0, 0, tzinfo=timezone.utc)

RUNNING_AS_ROOT = hasattr(os, "geteuid") and os.geteuid() == 0

PLANNER = _OrchestrationPlanner()

REQUEST = ProviderRequest(
    provider_id="manual",
    task_id="task-1",
    shot_id="shot-1",
    prompt="a cat",
    duration_seconds=4.0,
    width=1280,
    height=720,
    frame_rate=24.0,
    staging_ref="staging/task-1",
    provider_parameters={"style": "anime"},
)
INSTRUCTION = ProviderInstruction(
    provider_id="manual",
    task_id="task-1",
    shot_id="shot-1",
    prompt="a cat",
    expected_duration_seconds=4.0,
    expected_width=1280,
    expected_height=720,
    expected_frame_rate=24.0,
    staging_ref="staging/task-1",
    steps=("open tool", "generate"),
    suggested_parameters={"style": "anime"},
)
PREPARE_RESULT = ProviderResult(
    provider_id="manual",
    task_id="task-1",
    shot_id="shot-1",
    status=ProviderStatus.NOT_SUBMITTED,
    observed_at=T1,
    instruction=INSTRUCTION,
)
SUBMIT_RESULT = ProviderResult(
    provider_id="manual",
    task_id="task-1",
    shot_id="shot-1",
    status=ProviderStatus.WAITING_FOR_USER,
    observed_at=T2,
    external_task_ref="ext-1",
)


def _write_task(root: Path, **overrides) -> None:
    base = dict(
        task_id="task-1",
        shot_id="shot-1",
        status=GenerationTaskStatus.PENDING,
        created_at=T0,
        updated_at=T0,
    )
    base.update(overrides)
    write_model_json(
        root / "records/generation-tasks/task-1.json",
        GenerationTask(**base),
        overwrite=True,
    )


def _write_manifest(root: Path, **overrides) -> None:
    base = dict(
        step_name="generation:task-1",
        input_digest="digest-1",
        relevant_config_digest="config-1",
        status=ManifestStatus.PENDING,
        created_at=T0,
    )
    base.update(overrides)
    write_model_json(
        root / "manifests/generation-task-1.json",
        StepManifest(**base),
        overwrite=True,
    )


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    (root / "records/generation-tasks").mkdir(parents=True)
    (root / "manifests").mkdir()
    _write_task(root)
    _write_manifest(root)
    return root


@pytest.fixture
def executor(project: Path) -> _FileOrchestrationExecutor:
    return _FileOrchestrationExecutor(project)


def _record(root: Path) -> dict:
    return json.loads((root / "records/orchestration/task-1.json").read_text())


def first_prepare_plan(executor: _FileOrchestrationExecutor):
    obs = executor.read_project_state("task-1")
    return PLANNER.plan(
        action=OrchestrationAction.PREPARE,
        operation_id="op-1",
        request=REQUEST,
        task=obs.task,
        manifest=obs.manifest,
        stable=None,
        result=PREPARE_RESULT,
        observed_at=T1,
        task_before_fingerprint=obs.task_fingerprint,
        manifest_before_fingerprint=obs.manifest_fingerprint,
        instruction_before_fingerprint=obs.instruction_fingerprint,
        instruction_before_text=obs.instruction_text,
    )


def subsequent_submit_plan(executor: _FileOrchestrationExecutor):
    obs = executor.read_project_state("task-1")
    stable = obs.record.stable
    return PLANNER.plan(
        action=OrchestrationAction.SUBMIT,
        operation_id="op-2",
        request=REQUEST,
        task=obs.task,
        manifest=obs.manifest,
        stable=stable,
        result=SUBMIT_RESULT,
        observed_at=T2,
        task_before_fingerprint=obs.task_fingerprint,
        manifest_before_fingerprint=obs.manifest_fingerprint,
        instruction_before_fingerprint=obs.instruction_fingerprint,
        instruction_before_text=obs.instruction_text,
    )


# --- §22 25/27: first prepare record + successful commit --------------------


class TestFirstPrepareCommit:
    def test_first_prepare_applying_intent_shape(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = first_prepare_plan(executor)
        executor.write_apply_intent("task-1", None, plan)
        record = _record(project)
        assert record["phase"] == "applying"
        assert record["stable"] is None
        assert record["pending"]["variant"] == "apply"
        assert record["pending"]["baseline_version"] == 0
        assert record["pending"]["before_fingerprints"]["stable_record"] == (ABSENT)

    def test_first_successful_commit_stable_version_one(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = first_prepare_plan(executor)
        executor.commit_apply(plan)
        record = _record(project)
        assert record["phase"] == "stable"
        assert record["pending"] is None
        payload = record["stable"]["payload"]
        assert payload["version"] == 1
        assert payload["last_committed_operation"]["operation_id"] == "op-1"
        assert payload["committed_task_fingerprint"]
        assert payload["committed_instruction_fingerprint"] != ABSENT
        # self fingerprint recomputes and verifies on read
        stable = _parse_stable_wrapper(record["stable"])
        assert stable.version == 1
        # instruction file written, task updated
        assert (project / "tasks/instructions/task-1.md").exists()
        obs = executor.read_project_state("task-1")
        assert obs.task.provider_id == "manual"

    def test_commit_is_idempotent_via_recovery(
        self,
        executor: _FileOrchestrationExecutor,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        outcome = executor.recover("task-1")
        assert outcome.disposition is RecoveryDisposition.NONE
        assert outcome.committed is False


# --- §22 26/77: first partial-apply recovery branches -----------------------


class TestFirstPartialApplyRecovery:
    def _land_intent(self, executor, project):
        plan = first_prepare_plan(executor)
        executor.write_apply_intent("task-1", None, plan)
        return plan

    def test_recover_task_not_written(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        self._land_intent(executor, project)
        outcome = executor.recover("task-1")
        assert outcome.disposition is RecoveryDisposition.SAFE_AUTO_RETRY
        assert outcome.committed
        assert _record(project)["phase"] == "stable"

    def test_recover_task_written_manifest_not(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = self._land_intent(executor, project)
        after_task = _restore_generation_task(plan.pending_apply.task_after_snapshot)
        write_model_json(
            project / "records/generation-tasks/task-1.json",
            after_task,
            overwrite=True,
        )
        outcome = executor.recover("task-1")
        assert outcome.committed
        assert _record(project)["phase"] == "stable"

    def test_recover_instruction_written_stable_not(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = self._land_intent(executor, project)
        pending = plan.pending_apply
        write_model_json(
            project / "records/generation-tasks/task-1.json",
            _restore_generation_task(pending.task_after_snapshot),
            overwrite=True,
        )
        write_model_json(
            project / "manifests/generation-task-1.json",
            _restore_step_manifest(pending.manifest_after_snapshot),
            overwrite=True,
        )
        (project / "tasks/instructions").mkdir(parents=True, exist_ok=True)
        (project / "tasks/instructions/task-1.md").write_bytes(
            plan.instruction_after_bytes
        )
        outcome = executor.recover("task-1")
        assert outcome.committed
        assert _record(project)["phase"] == "stable"

    def test_partial_commit_recovery_end_to_end(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        self._land_intent(executor, project)
        # first recovery commits
        assert executor.recover("task-1").committed
        # second recovery is a clean no-op
        assert executor.recover("task-1").disposition is (RecoveryDisposition.NONE)


# --- §22 29: subsequent pending preserves previous stable -------------------


class TestSubsequentApply:
    def test_subsequent_applying_intent_carries_previous_stable(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        plan = subsequent_submit_plan(executor)
        # the subsequent applying intent must carry (not null) the
        # previous stable snapshot
        executor.write_apply_intent(
            "task-1",
            _parse_stable_wrapper(_record(project)["stable"]),
            plan,
        )
        applying = _record(project)
        assert applying["phase"] == "applying"
        assert applying["stable"] is not None
        assert applying["stable"]["payload"]["version"] == 1

    def test_subsequent_commit_replaces_stable_with_next_version(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        plan = subsequent_submit_plan(executor)
        executor.commit_apply(plan)
        committed = _record(project)
        assert committed["phase"] == "stable"
        assert committed["stable"]["payload"]["version"] == 2

    def test_subsequent_partial_write_redrive(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        plan = subsequent_submit_plan(executor)
        stable = _parse_stable_wrapper(_record(project)["stable"])
        executor.write_apply_intent("task-1", stable, plan)
        # write only the after task, crash before manifest
        write_model_json(
            project / "records/generation-tasks/task-1.json",
            _restore_generation_task(plan.pending_apply.task_after_snapshot),
            overwrite=True,
        )
        outcome = executor.recover("task-1")
        assert outcome.committed
        assert _record(project)["stable"]["payload"]["version"] == 2

    def test_subsequent_requires_existing_stable(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        plan = subsequent_submit_plan(executor)
        (project / "records/orchestration/task-1.json").unlink()
        with pytest.raises(MissingRecoveryRecordError):
            executor.commit_apply(plan)


# --- §22 56: phase transition rows ------------------------------------------


class TestPhaseTransitions:
    def test_applying_envelope_atomic_and_reparseable(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = first_prepare_plan(executor)
        executor.write_apply_intent("task-1", None, plan)
        record = _record(project)
        assert record["record_schema"] == {
            "kind": "orchestration_record",
            "version": 1,
        }
        assert record["phase"] == "applying"

    def test_stable_envelope_has_null_pending(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        record = _record(project)
        assert record["phase"] == "stable"
        assert record["pending"] is None

    def test_intent_envelope_never_has_provider_call_without_stable(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        # first prepare produces an APPLYING (direct) envelope, never an
        # INTENT with a null stable; the executor writes exactly what the
        # plan/pending dictate.
        plan = first_prepare_plan(executor)
        executor.write_apply_intent("task-1", None, plan)
        assert _record(project)["phase"] == "applying"


# --- §22 64/86: CAS before fingerprints + baseline --------------------------


class TestCompareAndSet:
    def test_first_prepare_absent_stable_baseline(
        self,
        executor: _FileOrchestrationExecutor,
    ) -> None:
        plan = first_prepare_plan(executor)
        # commit succeeds precisely because before.stable_record is ABSENT
        assert plan.pending_apply.before_fingerprints["stable_record"] == (ABSENT)
        executor.commit_apply(plan)

    def test_task_changed_since_planning_is_conflict(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = first_prepare_plan(executor)
        # mutate the task file after planning so before-fp no longer matches
        _write_task(project, updated_at=T0, input_parameters_ref="drifted")
        with pytest.raises(PartialCommitConflictError):
            executor.commit_apply(plan)

    def test_manifest_changed_since_planning_is_conflict(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = first_prepare_plan(executor)
        _write_manifest(project, input_digest="drifted")
        with pytest.raises(PartialCommitConflictError):
            executor.commit_apply(plan)

    def test_baseline_version_mismatch(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        plan = subsequent_submit_plan(executor)
        # apply the plan (bumps the on-disk stable to version 2)
        executor.commit_apply(plan)
        # re-committing the same plan (baseline 1) against the version-2
        # on-disk stable is a baseline mismatch
        with pytest.raises((BaselineMismatchError, PartialCommitConflictError)):
            executor.commit_apply(plan)


# --- §22 66/67/114: file-fingerprint judgment and conflicts -----------------


class TestFileFingerprintJudgment:
    def test_confirmed_writes_hint_not_trusted_uses_fingerprints(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = first_prepare_plan(executor)
        executor.write_apply_intent("task-1", None, plan)
        # apply all files to the "after" state manually, without ever
        # updating confirmed_writes/phase; recovery must judge by
        # fingerprints and commit STABLE.
        pending = plan.pending_apply
        write_model_json(
            project / "records/generation-tasks/task-1.json",
            _restore_generation_task(pending.task_after_snapshot),
            overwrite=True,
        )
        write_model_json(
            project / "manifests/generation-task-1.json",
            _restore_step_manifest(pending.manifest_after_snapshot),
            overwrite=True,
        )
        (project / "tasks/instructions").mkdir(parents=True, exist_ok=True)
        (project / "tasks/instructions/task-1.md").write_bytes(
            plan.instruction_after_bytes
        )
        outcome = executor.recover("task-1")
        assert outcome.committed
        assert _record(project)["phase"] == "stable"

    def test_task_neither_before_nor_after_is_conflict(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = first_prepare_plan(executor)
        executor.write_apply_intent("task-1", None, plan)
        # externally mutate the task to a valid but third distinct state
        _write_task(
            project,
            provider_id="tampered",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=T2,
            external_task_ref="ghost",
        )
        with pytest.raises(PartialCommitConflictError):
            executor.recover("task-1")

    def test_instruction_conflict_overwrite_is_rejected(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = first_prepare_plan(executor)
        executor.write_apply_intent("task-1", None, plan)
        write_model_json(
            project / "records/generation-tasks/task-1.json",
            _restore_generation_task(plan.pending_apply.task_after_snapshot),
            overwrite=True,
        )
        write_model_json(
            project / "manifests/generation-task-1.json",
            _restore_step_manifest(plan.pending_apply.manifest_after_snapshot),
            overwrite=True,
        )
        (project / "tasks/instructions").mkdir(parents=True, exist_ok=True)
        (project / "tasks/instructions/task-1.md").write_bytes(
            b"# tampered instruction that is neither before nor after\n"
        )
        with pytest.raises(PartialCommitConflictError):
            executor.recover("task-1")


# --- §22 71/73: STABLE committed fingerprint verification -------------------


class TestCommittedFingerprintVerification:
    def test_committed_task_fingerprint_mismatch(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        # build a valid subsequent plan first, then externally tamper the
        # task file so the executor's committed-fingerprint baseline check
        # detects the drift at commit time
        plan = subsequent_submit_plan(executor)
        _write_task(
            project,
            provider_id="manual",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=T2,
            external_task_ref="ghost",
        )
        with pytest.raises(PartialCommitConflictError):
            executor.commit_apply(plan)

    def test_committed_instruction_fingerprint_mismatch(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        plan = subsequent_submit_plan(executor)
        (project / "tasks/instructions/task-1.md").write_bytes(
            b"# externally replaced instruction\n"
        )
        with pytest.raises(PartialCommitConflictError):
            executor.commit_apply(plan)


# --- §22 106/107/108: directory creation ------------------------------------


class TestApprovedParentCreation:
    def test_creates_only_approved_parents(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        layout = executor.read_project_state("task-1").layout
        executor.create_approved_parents(layout)
        assert (project / "records/orchestration").is_dir()
        assert (project / "tasks/instructions").is_dir()
        assert (project / "manifests").is_dir()
        # non-approved directories are never created
        assert not (project / "staging").exists()
        assert not (project / "assets").exists()
        assert not (project / "records/video-assets").exists()

    def test_empty_approved_directory_may_remain(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        layout = executor.read_project_state("task-1").layout
        executor.create_approved_parents(layout)
        # no files written yet; empty approved dirs are safe residue
        assert list((project / "records/orchestration").iterdir()) == []
        # a second call is idempotent and does not fail
        executor.create_approved_parents(layout)

    @pytest.mark.skipif(
        RUNNING_AS_ROOT,
        reason="permission errors do not apply when running as root",
    )
    def test_directory_creation_failure_raises(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        os.chmod(project, 0o500)
        try:
            layout = executor.read_project_state("task-1").layout
            with pytest.raises(PersistenceExecutionError):
                executor.create_approved_parents(layout)
        finally:
            os.chmod(project, 0o700)


# --- §22 109: task/manifest existence ---------------------------------------


class TestProjectStateExistence:
    def test_missing_task_file(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        (project / "records/generation-tasks/task-1.json").unlink()
        with pytest.raises(MissingProjectStateError):
            executor.read_project_state("task-1")

    def test_missing_manifest_file(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        (project / "manifests/generation-task-1.json").unlink()
        with pytest.raises(MissingProjectStateError):
            executor.read_project_state("task-1")


# --- §22 110: I/O whitelist / tripwire --------------------------------------


class TestIoWhitelist:
    def test_executor_only_touches_the_four_derived_paths(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        before = _snapshot_tree(project)
        executor.commit_apply(first_prepare_plan(executor))
        after = _snapshot_tree(project)
        created = after - before
        allowed = {
            str(project / "records/orchestration"),
            str(project / "records/orchestration/task-1.json"),
            str(project / "tasks"),
            str(project / "tasks/instructions"),
            str(project / "tasks/instructions/task-1.md"),
        }
        assert created <= allowed, created - allowed

    def test_executor_never_creates_media_or_artifact_dirs(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        assert not (project / "assets").exists()
        assert not (project / "staging").exists()
        assert not (project / "outputs").exists()


def _snapshot_tree(root: Path) -> set:
    return {str(p) for p in root.rglob("*")}


# --- §22 128: orchestration trace classification ----------------------------


class TestTraceClassification:
    def test_clean_initial_state_has_no_trace(self) -> None:
        task = GenerationTask(
            task_id="task-1",
            shot_id="shot-1",
            status=GenerationTaskStatus.PENDING,
            created_at=T0,
            updated_at=T0,
        )
        manifest = StepManifest(
            step_name="generation:task-1",
            input_digest="d",
            relevant_config_digest="c",
            status=ManifestStatus.PENDING,
            created_at=T0,
        )
        assert (
            _classify_orchestration_traces(
                task=task, manifest=manifest, instruction_exists=False
            )
            is False
        )

    def _clean_manifest(self) -> StepManifest:
        return StepManifest(
            step_name="generation:task-1",
            input_digest="d",
            relevant_config_digest="c",
            status=ManifestStatus.PENDING,
            created_at=T0,
        )

    def _clean_task(self, **overrides) -> GenerationTask:
        base = dict(
            task_id="task-1",
            shot_id="shot-1",
            status=GenerationTaskStatus.PENDING,
            created_at=T0,
            updated_at=T0,
        )
        base.update(overrides)
        return GenerationTask(**base)

    def test_provider_id_trace(self) -> None:
        assert _classify_orchestration_traces(
            task=self._clean_task(provider_id="manual"),
            manifest=self._clean_manifest(),
            instruction_exists=False,
        )

    def test_status_trace(self) -> None:
        assert _classify_orchestration_traces(
            task=self._clean_task(
                status=GenerationTaskStatus.IN_PROGRESS, updated_at=T1
            ),
            manifest=self._clean_manifest(),
            instruction_exists=False,
        )

    def test_reference_traces(self) -> None:
        assert _classify_orchestration_traces(
            task=self._clean_task(external_task_ref="ext-1"),
            manifest=self._clean_manifest(),
            instruction_exists=False,
        )
        assert _classify_orchestration_traces(
            task=self._clean_task(current_artifact_ref="staging/x.mp4"),
            manifest=self._clean_manifest(),
            instruction_exists=False,
        )

    def test_manifest_orchestration_key_trace(self) -> None:
        manifest = StepManifest(
            step_name="generation:task-1",
            input_digest="d",
            relevant_config_digest="c",
            status=ManifestStatus.PENDING,
            created_at=T0,
            output_metadata={"orchestration": {"v": 1}},
        )
        assert _classify_orchestration_traces(
            task=self._clean_task(),
            manifest=manifest,
            instruction_exists=False,
        )

    def test_instruction_file_trace(self) -> None:
        assert _classify_orchestration_traces(
            task=self._clean_task(),
            manifest=self._clean_manifest(),
            instruction_exists=True,
        )


# --- recovery classification of provider-call unknowns ----------------------


class TestProviderCallUnknownRecovery:
    def test_may_have_started_raises_unknown_side_effect(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        stable = _parse_stable_wrapper(_record(project)["stable"])
        pending_call = _build_pending_call(
            stable, RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED
        )
        envelope = _build_envelope(
            RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED, stable, pending_call
        )
        executor._write_record(executor.read_project_state("task-1").layout, envelope)
        with pytest.raises(UnknownProviderSideEffectError):
            executor.recover("task-1")

    def test_intent_phase_is_safe_auto_retry_without_commit(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        stable = _parse_stable_wrapper(_record(project)["stable"])
        pending_call = _build_pending_call(stable, RecordPhase.PROVIDER_CALL_INTENT)
        envelope = _build_envelope(
            RecordPhase.PROVIDER_CALL_INTENT, stable, pending_call
        )
        executor._write_record(executor.read_project_state("task-1").layout, envelope)
        outcome = executor.recover("task-1")
        assert outcome.disposition is RecoveryDisposition.SAFE_AUTO_RETRY
        assert outcome.committed is False


def _build_pending_call(
    stable,
    call_phase,
    operation_id="op-9",
    artifact_ref="staging/task-1/clip.mp4",
    started_at=T2,
):
    from ai_video_workflow.orchestration._models import _PendingProviderCall
    from ai_video_workflow.orchestration.canonical import (
        _fingerprint,
        _make_snapshot_wrapper,
    )

    request_wrapper = _make_snapshot_wrapper("provider_request", REQUEST.to_json_dict())
    artifact = ArtifactReference(
        reference=artifact_ref,
        origin=ArtifactOrigin.USER,
        location=ArtifactLocation.STAGING,
    )
    action_input = _make_snapshot_wrapper(
        "action_input",
        {
            "observed_at": T2.isoformat(timespec="microseconds"),
            "artifact": {
                "snapshot_kind": "artifact_reference",
                "snapshot_version": 1,
                "payload": artifact.to_json_dict(),
            },
            "completed_at": None,
            "result_fingerprint": None,
        },
    )
    return _PendingProviderCall(
        operation_id=operation_id,
        action=OrchestrationAction.COLLECT,
        baseline_version=stable.version,
        request_snapshot=request_wrapper,
        request_fingerprint=_fingerprint(request_wrapper),
        action_input_snapshot=action_input,
        action_input_fingerprint=_fingerprint(action_input),
        original_observed_at=T2,
        original_completed_at=None,
        artifact_input=_make_snapshot_wrapper(
            "artifact_reference", artifact.to_json_dict()
        ),
        call_phase=call_phase,
        call_may_have_started=(call_phase is not RecordPhase.PROVIDER_CALL_INTENT),
        started_at=started_at,
        recovery_policy=RecoveryDisposition.MANUAL_RECONCILIATION,
    )


# --- malformed record / corruption ------------------------------------------


class TestMalformedRecord:
    def test_malformed_record_json_is_rejected(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        (project / "records/orchestration").mkdir(parents=True)
        (project / "records/orchestration/task-1.json").write_bytes(b"{ not json")
        with pytest.raises(InvalidRecoveryRecordError):
            executor.recover("task-1")

    def test_record_top_level_not_object_is_rejected(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        (project / "records/orchestration").mkdir(parents=True)
        (project / "records/orchestration/task-1.json").write_bytes(b"[1, 2]")
        with pytest.raises(InvalidRecoveryRecordError):
            executor.recover("task-1")


# --- boundaries and exports -------------------------------------------------


# --- blocker 2: read_project_state strict-parses the record ----------------


class TestStrictRecordParsing:
    def test_read_project_state_rejects_unknown_schema_record(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        (project / "records/orchestration").mkdir(parents=True)
        (project / "records/orchestration/task-1.json").write_bytes(
            b'{"unknown": "schema"}'
        )
        with pytest.raises(InvalidRecoveryRecordError):
            executor.read_project_state("task-1")

    def test_corrupt_stable_self_fingerprint_is_rejected(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        record = _record(project)
        # corrupt one committed field without recomputing the self fingerprint
        record["stable"]["payload"]["committed_task_fingerprint"] = "0" * 64
        (project / "records/orchestration/task-1.json").write_text(json.dumps(record))
        with pytest.raises(InvalidRecoveryRecordError):
            executor.read_project_state("task-1")


# --- blocker 3: STABLE recovery re-verifies committed fingerprints (S1) ------


class TestStableRecoveryS1:
    def _commit(self, executor):
        executor.commit_apply(first_prepare_plan(executor))

    def test_stable_recover_detects_task_drift(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        self._commit(executor)
        _write_task(
            project,
            provider_id="manual",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=T2,
            external_task_ref="ghost",
        )
        with pytest.raises(PartialCommitConflictError):
            executor.recover("task-1")

    def test_stable_recover_detects_manifest_drift(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        self._commit(executor)
        _write_manifest(project, input_digest="externally-changed")
        with pytest.raises(PartialCommitConflictError):
            executor.recover("task-1")

    def test_stable_recover_detects_instruction_drift(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        self._commit(executor)
        (project / "tasks/instructions/task-1.md").write_bytes(
            b"# externally replaced instruction\n"
        )
        with pytest.raises(PartialCommitConflictError):
            executor.recover("task-1")

    def test_stable_recover_clean_is_noop(
        self,
        executor: _FileOrchestrationExecutor,
    ) -> None:
        self._commit(executor)
        outcome = executor.recover("task-1")
        assert outcome.disposition is RecoveryDisposition.NONE
        assert outcome.committed is False


# --- blocker 1: durable intent CAS / identity / replay ----------------------


class TestIntentWritePreconditions:
    def _commit_stable(self, executor, project):
        executor.commit_apply(first_prepare_plan(executor))
        return _parse_stable_wrapper(_record(project)["stable"])

    def test_call_intent_requires_existing_stable_record(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        # a provider-call intent with no record on disk is rejected
        self._commit_stable(executor, project)
        stable = _parse_stable_wrapper(_record(project)["stable"])
        (project / "records/orchestration/task-1.json").unlink()
        pending_call = _build_pending_call(stable, RecordPhase.PROVIDER_CALL_INTENT)
        with pytest.raises(MissingRecoveryRecordError):
            executor.write_pending_call_intent("task-1", stable, pending_call)

    def test_call_intent_lands_from_stable(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        stable = self._commit_stable(executor, project)
        pending_call = _build_pending_call(stable, RecordPhase.PROVIDER_CALL_INTENT)
        executor.write_pending_call_intent("task-1", stable, pending_call)
        assert _record(project)["phase"] == "provider_call_intent"

    def test_call_intent_different_operation_does_not_overwrite(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        stable = self._commit_stable(executor, project)
        first = _build_pending_call(
            stable, RecordPhase.PROVIDER_CALL_INTENT, operation_id="op-a"
        )
        executor.write_pending_call_intent("task-1", stable, first)
        second = _build_pending_call(
            stable, RecordPhase.PROVIDER_CALL_INTENT, operation_id="op-b"
        )
        with pytest.raises(PartialCommitConflictError):
            executor.write_pending_call_intent("task-1", stable, second)
        # the first intent is preserved
        assert _record(project)["pending"]["operation_id"] == "op-a"

    def test_call_intent_same_operation_replay_is_idempotent(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        stable = self._commit_stable(executor, project)
        pending_call = _build_pending_call(
            stable, RecordPhase.PROVIDER_CALL_INTENT, operation_id="op-a"
        )
        executor.write_pending_call_intent("task-1", stable, pending_call)
        # replaying the exact same operation must not raise
        executor.write_pending_call_intent("task-1", stable, pending_call)
        assert _record(project)["pending"]["operation_id"] == "op-a"

    def test_call_intent_stale_baseline_is_rejected(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        stable = self._commit_stable(executor, project)
        # advance the on-disk stable to version 2
        executor.commit_apply(subsequent_submit_plan(executor))
        # an intent built on the stale version-1 stable must be rejected
        pending_call = _build_pending_call(stable, RecordPhase.PROVIDER_CALL_INTENT)
        with pytest.raises(BaselineMismatchError):
            executor.write_pending_call_intent("task-1", stable, pending_call)


class TestApplyIntentComposesWithCommit:
    def test_apply_intent_then_commit_same_plan(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = first_prepare_plan(executor)
        executor.write_apply_intent("task-1", None, plan)
        # committing the same plan continues the already-landed applying intent
        executor.commit_apply(plan)
        record = _record(project)
        assert record["phase"] == "stable"
        assert record["stable"]["payload"]["version"] == 1


# --- blocker 4: execution-time state-target symlink rejection ---------------


class TestSymlinkTargetRejection:
    def test_record_symlink_is_rejected_on_read(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        (project / "records/orchestration").mkdir(parents=True)
        outside = project / "outside-record.json"
        outside.write_bytes(b"{}")
        os.symlink(outside, project / "records/orchestration/task-1.json")
        with pytest.raises(PersistenceExecutionError):
            executor.read_project_state("task-1")

    def test_instruction_symlink_is_rejected_on_write(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = first_prepare_plan(executor)
        (project / "tasks/instructions").mkdir(parents=True)
        outside = project / "outside-instruction.md"
        outside.write_bytes(b"seed\n")
        os.symlink(outside, project / "tasks/instructions/task-1.md")
        with pytest.raises(PersistenceExecutionError):
            executor.commit_apply(plan)


# --- blocker 5: RECOVERY_REQUIRED landing + phase-row/coverage completeness --


class TestRecoveryRequiredLanding:
    def test_apply_conflict_lands_durable_recovery_required(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = first_prepare_plan(executor)
        executor.write_apply_intent("task-1", None, plan)
        _write_task(
            project,
            provider_id="tampered",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=T2,
            external_task_ref="ghost",
        )
        with pytest.raises(PartialCommitConflictError):
            executor.recover("task-1")
        # the durable record is now a manual-reconciliation evaluation state
        assert _record(project)["phase"] == "recovery_required"

    def test_recovery_required_record_stays_manual_on_reentry(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = first_prepare_plan(executor)
        executor.write_apply_intent("task-1", None, plan)
        _write_task(
            project,
            provider_id="tampered",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=T2,
            external_task_ref="ghost",
        )
        with pytest.raises(PartialCommitConflictError):
            executor.recover("task-1")
        # re-running recovery on a RECOVERY_REQUIRED record stays manual
        with pytest.raises(PartialCommitConflictError):
            executor.recover("task-1")
        assert _record(project)["phase"] == "recovery_required"


class TestConfirmedWritesProgress:
    def test_commit_writes_confirmed_writes_progress_hint(
        self,
        executor: _FileOrchestrationExecutor,
    ) -> None:
        seen: list[tuple[str, list]] = []
        original = _FileOrchestrationExecutor._write_record

        def _spy(self, layout, envelope):
            pending = envelope.get("pending")
            confirmed = None if pending is None else pending.get("confirmed_writes")
            seen.append((envelope["phase"], confirmed))
            return original(self, layout, envelope)

        with mock.patch.object(_FileOrchestrationExecutor, "_write_record", _spy):
            executor.commit_apply(first_prepare_plan(executor))
        applying = [c for phase, c in seen if phase == "applying"]
        # the advisory hint grows monotonically as each file is confirmed
        assert ["task"] in applying
        assert ["task", "manifest"] in applying
        assert ["task", "manifest", "instruction"] in applying
        assert seen[-1][0] == "stable"


class TestAllPhaseTransitionRows:
    """§11.5: each of the eight rows lands its atomic record content."""

    def _stable(self, executor, project):
        executor.commit_apply(first_prepare_plan(executor))
        return _parse_stable_wrapper(_record(project)["stable"])

    def test_row1_stable_to_call_intent(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        stable = self._stable(executor, project)
        executor.write_pending_call_intent(
            "task-1",
            stable,
            _build_pending_call(stable, RecordPhase.PROVIDER_CALL_INTENT),
        )
        assert _record(project)["phase"] == "provider_call_intent"

    def _advance_call(self, executor, stable, target, operation_id="op-c"):
        order = (
            RecordPhase.PROVIDER_CALL_INTENT,
            RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
            RecordPhase.PROVIDER_RESULT_UNKNOWN,
        )
        for phase in order[: order.index(target) + 1]:
            executor.write_pending_call_intent(
                "task-1",
                stable,
                _build_pending_call(stable, phase, operation_id=operation_id),
            )

    def test_row2_intent_to_may_have_started(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        stable = self._stable(executor, project)
        self._advance_call(executor, stable, RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED)
        record = _record(project)
        assert record["phase"] == "provider_call_may_have_started"
        assert record["pending"]["call_may_have_started"] is True

    def test_row3_may_have_started_to_result_unknown(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        stable = self._stable(executor, project)
        self._advance_call(executor, stable, RecordPhase.PROVIDER_RESULT_UNKNOWN)
        assert _record(project)["phase"] == "provider_result_unknown"

    def test_stable_to_may_have_started_direct_is_rejected(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        stable = self._stable(executor, project)
        with pytest.raises(PartialCommitConflictError):
            executor.write_pending_call_intent(
                "task-1",
                stable,
                _build_pending_call(stable, RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED),
            )

    def test_may_have_started_to_intent_regression_is_rejected(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        stable = self._stable(executor, project)
        self._advance_call(executor, stable, RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED)
        with pytest.raises(PartialCommitConflictError):
            executor.write_pending_call_intent(
                "task-1",
                stable,
                _build_pending_call(
                    stable,
                    RecordPhase.PROVIDER_CALL_INTENT,
                    operation_id="op-c",
                ),
            )
        assert _record(project)["phase"] == "provider_call_may_have_started"

    def test_row4_5_stable_to_applying(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        stable = self._stable(executor, project)
        plan = subsequent_submit_plan(executor)
        executor.write_apply_intent("task-1", stable, plan)
        assert _record(project)["phase"] == "applying"
        assert _record(project)["stable"] is not None

    def test_row7_applying_to_stable(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        assert _record(project)["phase"] == "stable"
        assert _record(project)["pending"] is None

    def test_row8_non_stable_to_recovery_required(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        stable = self._stable(executor, project)
        # drive INTENT -> MAY_HAVE_STARTED through the formal sequence; a
        # MAY_HAVE_STARTED provider call is unresolved, so recovery lands a
        # durable RECOVERY_REQUIRED evaluation state and raises
        self._advance_call(executor, stable, RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED)
        with pytest.raises(UnknownProviderSideEffectError):
            executor.recover("task-1")
        assert _record(project)["phase"] == "recovery_required"


class TestCommittedManifestFingerprintAtCommit:
    def test_committed_manifest_fingerprint_mismatch(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        executor.commit_apply(first_prepare_plan(executor))
        plan = subsequent_submit_plan(executor)
        _write_manifest(project, input_digest="externally-changed")
        with pytest.raises(PartialCommitConflictError):
            executor.commit_apply(plan)


# --- blocker 1: full-content CAS on intents and apply plans -----------------


def _alt_first_prepare_plan(executor, steps):
    obs = executor.read_project_state("task-1")
    alt_instruction = ProviderInstruction(
        provider_id="manual",
        task_id="task-1",
        shot_id="shot-1",
        prompt="a cat",
        expected_duration_seconds=4.0,
        expected_width=1280,
        expected_height=720,
        expected_frame_rate=24.0,
        staging_ref="staging/task-1",
        steps=steps,
        suggested_parameters={"style": "anime"},
    )
    alt_result = ProviderResult(
        provider_id="manual",
        task_id="task-1",
        shot_id="shot-1",
        status=ProviderStatus.NOT_SUBMITTED,
        observed_at=T1,
        instruction=alt_instruction,
    )
    return PLANNER.plan(
        action=OrchestrationAction.PREPARE,
        operation_id="op-1",
        request=REQUEST,
        task=obs.task,
        manifest=obs.manifest,
        stable=None,
        result=alt_result,
        observed_at=T1,
        task_before_fingerprint=obs.task_fingerprint,
        manifest_before_fingerprint=obs.manifest_fingerprint,
        instruction_before_fingerprint=obs.instruction_fingerprint,
        instruction_before_text=obs.instruction_text,
    )


class TestCallIntentContentCas:
    def _stable(self, executor, project):
        executor.commit_apply(first_prepare_plan(executor))
        return _parse_stable_wrapper(_record(project)["stable"])

    def test_same_operation_changed_artifact_input_conflicts(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        stable = self._stable(executor, project)
        first = _build_pending_call(
            stable,
            RecordPhase.PROVIDER_CALL_INTENT,
            operation_id="op-a",
            artifact_ref="staging/task-1/first.mp4",
        )
        executor.write_pending_call_intent("task-1", stable, first)
        # same operation and phase, but a different artifact/action input
        changed = _build_pending_call(
            stable,
            RecordPhase.PROVIDER_CALL_INTENT,
            operation_id="op-a",
            artifact_ref="staging/task-1/second.mp4",
        )
        with pytest.raises(PartialCommitConflictError):
            executor.write_pending_call_intent("task-1", stable, changed)
        # the original intent is preserved
        assert (
            "first.mp4"
            in _record(project)["pending"]["artifact_input"]["payload"]["reference"]
        )

    def test_same_phase_replay_changed_started_at_conflicts(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        stable = self._stable(executor, project)
        first = _build_pending_call(
            stable,
            RecordPhase.PROVIDER_CALL_INTENT,
            operation_id="op-a",
            started_at=T2,
        )
        executor.write_pending_call_intent("task-1", stable, first)
        # a same-phase replay that only differs in the non-advisory
        # started_at field is not an exact replay and must conflict
        changed = _build_pending_call(
            stable,
            RecordPhase.PROVIDER_CALL_INTENT,
            operation_id="op-a",
            started_at=T1,
        )
        with pytest.raises(PartialCommitConflictError):
            executor.write_pending_call_intent("task-1", stable, changed)
        assert _record(project)["pending"]["started_at"] == (
            T2.isoformat(timespec="microseconds")
        )


class TestApplyPlanCas:
    def test_same_operation_different_plan_conflicts(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan_a = first_prepare_plan(executor)
        executor.write_apply_intent("task-1", None, plan_a)
        # a distinct plan for the same operation (different plan_id and
        # different content) must not continue the pre-landed APPLYING
        plan_b = _alt_first_prepare_plan(executor, ("open tool", "render alt"))
        assert plan_b.plan_id != plan_a.plan_id
        assert plan_b.pending_apply.instruction_after_fingerprint != (
            plan_a.pending_apply.instruction_after_fingerprint
        )
        with pytest.raises(PartialCommitConflictError):
            executor.commit_apply(plan_b)

    def test_pre_landed_plan_a_then_commit_plan_b_conflicts(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan_a = first_prepare_plan(executor)
        executor.write_apply_intent("task-1", None, plan_a)
        plan_b = _alt_first_prepare_plan(executor, ("open tool", "render alt"))
        with pytest.raises(PartialCommitConflictError):
            executor.commit_apply(plan_b)
        # the durable APPLYING intent for plan A is untouched
        assert _record(project)["phase"] == "applying"

    def test_apply_over_mismatched_provider_call_conflicts(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        # §11.5 row 4 (MAY_HAVE_STARTED -> APPLYING) must strictly compare the
        # pending provider call against the plan: an apply whose operation
        # does not continue the pending call must not overwrite it.
        executor.commit_apply(first_prepare_plan(executor))
        submit_plan = subsequent_submit_plan(executor)
        stable = _parse_stable_wrapper(_record(project)["stable"])
        for phase in (
            RecordPhase.PROVIDER_CALL_INTENT,
            RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
        ):
            executor.write_pending_call_intent(
                "task-1",
                stable,
                _build_pending_call(stable, phase, operation_id="op-c"),
            )
        with pytest.raises(PartialCommitConflictError):
            executor.commit_apply(submit_plan)
        assert _record(project)["phase"] == "provider_call_may_have_started"


# --- blocker 3: RECOVERY_REQUIRED is terminal (no automatic exit) -----------


class TestRecoveryRequiredIsTerminal:
    def _into_recovery_required(self, executor, project):
        executor.commit_apply(first_prepare_plan(executor))
        plan = subsequent_submit_plan(executor)
        stable = _parse_stable_wrapper(_record(project)["stable"])
        executor.write_apply_intent("task-1", stable, plan)
        _write_task(
            project,
            provider_id="tampered",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=T2,
            external_task_ref="ghost",
        )
        with pytest.raises(PartialCommitConflictError):
            executor.recover("task-1")
        assert _record(project)["phase"] == "recovery_required"
        return stable, plan

    def test_commit_apply_over_recovery_required_is_rejected(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        _stable, plan = self._into_recovery_required(executor, project)
        with pytest.raises(PartialCommitConflictError):
            executor.commit_apply(plan)
        assert _record(project)["phase"] == "recovery_required"

    def test_call_intent_over_recovery_required_is_rejected(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        stable, _plan = self._into_recovery_required(executor, project)
        with pytest.raises(PartialCommitConflictError):
            executor.write_pending_call_intent(
                "task-1",
                stable,
                _build_pending_call(stable, RecordPhase.PROVIDER_CALL_INTENT),
            )
        assert _record(project)["phase"] == "recovery_required"


class TestPreLandedApplyThirdStateLandsRecoveryRequired:
    def test_pre_landed_applying_third_state_lands_recovery_required(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        plan = first_prepare_plan(executor)
        executor.write_apply_intent("task-1", None, plan)
        # a pre-landed APPLYING whose task file drifts to a third state must
        # transition to a durable RECOVERY_REQUIRED at commit, not stay APPLYING
        _write_task(
            project,
            provider_id="tampered",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=T2,
            external_task_ref="ghost",
        )
        with pytest.raises(PartialCommitConflictError):
            executor.commit_apply(plan)
        assert _record(project)["phase"] == "recovery_required"


# --- blocker 2: parent-component symlink escape / write-side guards ----------


class TestParentComponentContainment:
    def test_parent_component_symlink_escape_is_rejected(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        import shutil

        layout = executor.read_project_state("task-1").layout
        outside = project.parent / "escape"
        outside.mkdir()
        # replace the `records` parent component with a symlink out of root
        shutil.rmtree(project / "records")
        os.symlink(outside, project / "records")
        with pytest.raises(PersistenceExecutionError):
            executor.create_approved_parents(layout)
        assert not (outside / "orchestration").exists()

    def test_parent_component_symlink_escape_is_rejected_on_read(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        import shutil

        # Genuine TOCTOU: resolve a valid layout *first* (records intact),
        # then swap the `records` parent component for a symlink to an
        # outside tree holding a valid task JSON, then read through the
        # already-resolved layout. The read guard (not the resolver) must
        # reject the escape; the leaf task file is itself a real file, so a
        # leaf-only check would read it from outside the root.
        layout = executor.read_project_state("task-1").layout
        outside = project.parent / "escape-read"
        outside.mkdir()
        (outside / "generation-tasks").mkdir()
        shutil.copy(
            project / "records/generation-tasks/task-1.json",
            outside / "generation-tasks/task-1.json",
        )
        shutil.rmtree(project / "records")
        os.symlink(outside, project / "records")
        assert not layout.task_path.is_symlink()
        with pytest.raises(PersistenceExecutionError):
            executor._read_state_file(layout.task_path, "task", required=True)

    def test_atomic_write_rejects_leaf_symlink_target_directly(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        (project / "records/orchestration").mkdir(parents=True)
        outside = project / "outside.bin"
        outside.write_bytes(b"seed")
        target = project / "records/orchestration/probe.bin"
        os.symlink(outside, target)
        with pytest.raises(PersistenceExecutionError):
            executor._atomic_write_bytes(target, b"payload")
        assert outside.read_bytes() == b"seed"


# --- important: record invalid UTF-8 maps to InvalidRecoveryRecordError ------


class TestRecordInvalidUtf8:
    def test_non_utf8_record_is_invalid_recovery_record(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        (project / "records/orchestration").mkdir(parents=True)
        (project / "records/orchestration/task-1.json").write_bytes(b"\xff\xfe")
        with pytest.raises(InvalidRecoveryRecordError):
            executor.read_project_state("task-1")


class TestBoundariesAndExports:
    def test_no_public_symbols_added(self) -> None:
        for name in (
            "_FileOrchestrationExecutor",
            "_ProjectStateObservation",
            "_atomic_write_bytes",
        ):
            assert name not in orchestration_package.__all__
            assert not hasattr(orchestration_package, name)

    def test_executor_module_has_no_provider_reference(self) -> None:
        assert not hasattr(executor_module, "VideoProvider")
        assert not hasattr(executor_module, "ManualVideoProvider")

    def test_atomic_write_is_byte_exact_and_deterministic(
        self,
        executor: _FileOrchestrationExecutor,
        project: Path,
    ) -> None:
        target = project / "records/orchestration/probe.bin"
        (project / "records/orchestration").mkdir(parents=True)
        payload = "中文 payload\n".encode()
        executor._atomic_write_bytes(target, payload)
        assert target.read_bytes() == payload
        # no leftover temp files
        leftovers = [
            p
            for p in (project / "records/orchestration").iterdir()
            if p.name.startswith(".")
        ]
        assert leftovers == []

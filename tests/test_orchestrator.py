"""Step G tests: the public ProviderOrchestrator facade and integration.

Covers the §22 entries assigned to Step G (1-9, 57-63, 74, 75,
78-84, 87, 115-118, 127, 129-131) plus failure-injection: durable
call ordering, at-most-once Provider calls, outcome-unknown handling,
NO_OP zero-side-effect, replay/idempotency, the §17.2 admission
matrix, recovery routing, resume, public-model contracts, and the
fixed-boundary tripwires.
"""

import inspect
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

import ai_video_workflow.orchestration as orchestration_package
import ai_video_workflow.orchestration.orchestrator as orchestrator_module
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.models import GenerationTask, GenerationTaskStatus
from ai_video_workflow.orchestration import (
    ConflictingProviderResultError,
    IdempotencyConflictError,
    InvalidOrchestrationInputError,
    InvalidOrchestrationStateError,
    MissingProjectStateError,
    OrchestrationAction,
    OrchestrationContext,
    OrchestrationPlan,
    OrchestrationRecord,
    OutcomeKind,
    PartialCommitConflictError,
    PersistenceExecutionError,
    ProviderOrchestrator,
    RecordPhase,
    RecoveryDisposition,
    ResumeAssessment,
    UnknownProviderSideEffectError,
)
from ai_video_workflow.orchestration.executor import _FileOrchestrationExecutor
from ai_video_workflow.persistence import read_model_json, write_model_json
from ai_video_workflow.providers import ManualVideoProvider, VideoProvider
from ai_video_workflow.providers.errors import ProviderOperationError
from ai_video_workflow.providers.models import (
    ArtifactLocation,
    ArtifactOrigin,
    ArtifactReference,
    ProviderInstruction,
    ProviderRequest,
    ProviderResult,
    ProviderStatus,
)

T0 = datetime(2026, 7, 26, 8, 0, 0, tzinfo=timezone.utc)


def _t(hour: int) -> datetime:
    return datetime(2026, 7, 26, hour, 0, 0, tzinfo=timezone.utc)


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
ARTIFACT = ArtifactReference(
    reference="staging/task-1/clip.mp4",
    origin=ArtifactOrigin.USER,
    location=ArtifactLocation.STAGING,
)
ARTIFACT_OTHER = ArtifactReference(
    reference="staging/task-1/other.mp4",
    origin=ArtifactOrigin.USER,
    location=ArtifactLocation.STAGING,
)


def _instruction() -> ProviderInstruction:
    return ProviderInstruction(
        provider_id="manual",
        task_id="task-1",
        shot_id="shot-1",
        prompt="a cat",
        expected_duration_seconds=4.0,
        expected_width=1280,
        expected_height=720,
        expected_frame_rate=24.0,
        staging_ref="staging/task-1",
        steps=("open", "generate"),
        suggested_parameters={"style": "anime"},
    )


def _result(
    status,
    *,
    observed_at,
    artifact=None,
    completed_at=None,
    error=None,
    instruction=None,
    external=None,
):
    return ProviderResult(
        provider_id="manual",
        task_id="task-1",
        shot_id="shot-1",
        status=status,
        observed_at=observed_at,
        external_task_ref=external,
        artifact=artifact,
        instruction=instruction,
        error_summary=error,
        completed_at=completed_at,
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


def _ctx(root: Path) -> OrchestrationContext:
    task = read_model_json(
        root / "records/generation-tasks/task-1.json", GenerationTask
    )
    manifest = read_model_json(root / "manifests/generation-task-1.json", StepManifest)
    return OrchestrationContext(
        project_root=root, request=REQUEST, task=task, manifest=manifest
    )


def _record_json(root: Path) -> dict:
    return json.loads(
        (root / "records/orchestration/task-1.json").read_text(encoding="utf-8")
    )


# --- provider test doubles --------------------------------------------------


class _RecordingProvider(VideoProvider):
    """Spy that wraps a real provider, records calls, and can inject faults."""

    def __init__(self, inner=None, provider_id="manual"):
        self._inner = inner if inner is not None else ManualVideoProvider()
        self._pid = provider_id
        self.calls: list[tuple[str, datetime]] = []
        self.raises: dict[str, Exception] = {}
        self.returns: dict[str, ProviderResult] = {}

    @property
    def provider_id(self) -> str:
        return self._pid

    def _handle(self, name, make):
        if name in self.raises:
            raise self.raises[name]
        if name in self.returns:
            return self.returns[name]
        return make()

    def prepare(self, request, *, observed_at):
        self.calls.append(("prepare", observed_at))
        return self._handle(
            "prepare", lambda: self._inner.prepare(request, observed_at=observed_at)
        )

    def submit(self, request, prepared, *, observed_at):
        self.calls.append(("submit", observed_at))
        return self._handle(
            "submit",
            lambda: self._inner.submit(request, prepared, observed_at=observed_at),
        )

    def poll(self, request, current, *, observed_at, reported_artifact=None):
        self.calls.append(("poll", observed_at))
        return self._handle(
            "poll",
            lambda: self._inner.poll(
                request,
                current,
                observed_at=observed_at,
                reported_artifact=reported_artifact,
            ),
        )

    def collect(
        self, request, current, *, artifact=None, observed_at, completed_at=None
    ):
        self.calls.append(("collect", observed_at))
        return self._handle(
            "collect",
            lambda: self._inner.collect(
                request,
                current,
                artifact=artifact,
                observed_at=observed_at,
                completed_at=completed_at,
            ),
        )

    def count(self, name) -> int:
        return sum(1 for call in self.calls if call[0] == name)

    @property
    def total(self) -> int:
        return len(self.calls)


class _ReachedProvider(Exception):
    pass


class _TripwireProvider(VideoProvider):
    """Every method records the call and raises immediately.

    Used to prove whether routing reaches the Provider (admission
    matrix) without needing valid return values.
    """

    def __init__(self, provider_id="manual"):
        self._pid = provider_id
        self.calls: list[str] = []

    @property
    def provider_id(self) -> str:
        return self._pid

    def prepare(self, request, *, observed_at):
        self.calls.append("prepare")
        raise _ReachedProvider("prepare")

    def submit(self, request, prepared, *, observed_at):
        self.calls.append("submit")
        raise _ReachedProvider("submit")

    def poll(self, request, current, *, observed_at, reported_artifact=None):
        self.calls.append("poll")
        raise _ReachedProvider("poll")

    def collect(
        self, request, current, *, artifact=None, observed_at, completed_at=None
    ):
        self.calls.append("collect")
        raise _ReachedProvider("collect")


# --- driving helpers --------------------------------------------------------


def _prepare(project, orch=None, *, op="op-prepare", at=9):
    orch = orch or ProviderOrchestrator(ManualVideoProvider())
    return orch.prepare(_ctx(project), operation_id=op, observed_at=_t(at))


def _seed_status(project, status: ProviderStatus) -> None:
    """Seed a committed STABLE state at the given provider status."""
    orch = ProviderOrchestrator(ManualVideoProvider())
    orch.prepare(_ctx(project), operation_id="seed-prepare", observed_at=_t(9))
    if status is ProviderStatus.NOT_SUBMITTED:
        return
    factory = {
        ProviderStatus.WAITING_FOR_USER: _result(
            ProviderStatus.WAITING_FOR_USER, observed_at=_t(10), external="ext-1"
        ),
        ProviderStatus.PROCESSING: _result(
            ProviderStatus.PROCESSING, observed_at=_t(10), external="ext-1"
        ),
        ProviderStatus.ARTIFACT_AVAILABLE: _result(
            ProviderStatus.ARTIFACT_AVAILABLE, observed_at=_t(10), artifact=ARTIFACT
        ),
        ProviderStatus.SUCCEEDED: _result(
            ProviderStatus.SUCCEEDED,
            observed_at=_t(10),
            artifact=ARTIFACT,
            completed_at=_t(10),
        ),
        ProviderStatus.FAILED: _result(
            ProviderStatus.FAILED,
            observed_at=_t(10),
            error="boom",
            completed_at=_t(10),
        ),
        ProviderStatus.CANCELLED: _result(
            ProviderStatus.CANCELLED, observed_at=_t(10), completed_at=_t(10)
        ),
    }[status]
    orch.replay_result(_ctx(project), factory, operation_id="seed-replay")


_CALL_PHASE_ORDER = (
    RecordPhase.PROVIDER_CALL_INTENT,
    RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
    RecordPhase.PROVIDER_RESULT_UNKNOWN,
)


def _build_call_pending(
    stable, call_phase, operation_id="op-call", artifact_ref="staging/task-1/clip.mp4"
):
    """Build a collect _PendingProviderCall at the given call phase."""
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
            "observed_at": _t(12).isoformat(timespec="microseconds"),
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
        original_observed_at=_t(12),
        original_completed_at=None,
        artifact_input=_make_snapshot_wrapper(
            "artifact_reference", artifact.to_json_dict()
        ),
        call_phase=call_phase,
        call_may_have_started=(call_phase is not RecordPhase.PROVIDER_CALL_INTENT),
        started_at=_t(12),
        recovery_policy=RecoveryDisposition.MANUAL_RECONCILIATION,
    )


def _land_call_phase(project, phase, operation_id="op-call"):
    """Seed a waiting STABLE then advance a durable call record to `phase`.

    Advances through the formal INTENT -> MAY_HAVE_STARTED -> RESULT_UNKNOWN
    sequence so the landed record genuinely has the requested call phase.
    """
    from ai_video_workflow.orchestration.recovery import _parse_stable_wrapper

    _prepare(project)
    ProviderOrchestrator(ManualVideoProvider()).submit(
        _ctx(project), operation_id="op-s", observed_at=_t(11)
    )
    stable = _parse_stable_wrapper(_record_json(project)["stable"])
    executor = _FileOrchestrationExecutor(project)
    for step in _CALL_PHASE_ORDER[: _CALL_PHASE_ORDER.index(phase) + 1]:
        executor.write_pending_call_intent(
            "task-1", stable, _build_call_pending(stable, step, operation_id)
        )
    assert _record_json(project)["phase"] == phase.value


def _land_applying(project):
    """Seed a STABLE then land a durable APPLYING intent (not yet committed)."""
    from ai_video_workflow.orchestration.planning import _OrchestrationPlanner

    _prepare(project)
    obs = _FileOrchestrationExecutor(project).read_project_state("task-1")
    stable = obs.record.stable
    plan = _OrchestrationPlanner().plan(
        action=OrchestrationAction.SUBMIT,
        operation_id="op-s",
        request=REQUEST,
        task=obs.task,
        manifest=obs.manifest,
        stable=stable,
        # a manual submit produces waiting WITHOUT an external_task_ref, so a
        # subsequent manual poll of the recovered state is valid
        result=_result(ProviderStatus.WAITING_FOR_USER, observed_at=_t(11)),
        observed_at=_t(11),
        task_before_fingerprint=obs.task_fingerprint,
        manifest_before_fingerprint=obs.manifest_fingerprint,
        instruction_before_fingerprint=obs.instruction_fingerprint,
        instruction_before_text=obs.instruction_text,
    )
    _FileOrchestrationExecutor(project).write_apply_intent("task-1", stable, plan)
    assert _record_json(project)["phase"] == "applying"


def _land_recovery_required_record(project):
    """Land a durable RECOVERY_REQUIRED record via an APPLYING third-state P9."""
    _land_applying(project)
    _write_task(
        project,
        provider_id="manual",
        status=GenerationTaskStatus.IN_PROGRESS,
        updated_at=_t(20),
        external_task_ref="ghost",
    )
    with pytest.raises(PartialCommitConflictError):
        _FileOrchestrationExecutor(project).recover("task-1")
    assert _record_json(project)["phase"] == "recovery_required"


# ===========================================================================
# §22 1-9: public API / models / NO_OP / no-hidden-state
# ===========================================================================


class TestPublicApiContract:
    def test_facade_signatures_are_exact(self) -> None:  # entry 1
        # exact per-method signature lock for all seven public entrypoints:
        # parameter names, order, kind, defaults, and no *args/**kwargs.
        _KW = inspect.Parameter.KEYWORD_ONLY
        _POS = inspect.Parameter.POSITIONAL_OR_KEYWORD
        _MISSING = inspect.Parameter.empty
        expected = {
            "prepare": [
                ("self", _POS, _MISSING),
                ("context", _POS, _MISSING),
                ("operation_id", _KW, _MISSING),
                ("observed_at", _KW, _MISSING),
            ],
            "submit": [
                ("self", _POS, _MISSING),
                ("context", _POS, _MISSING),
                ("operation_id", _KW, _MISSING),
                ("observed_at", _KW, _MISSING),
            ],
            "poll": [
                ("self", _POS, _MISSING),
                ("context", _POS, _MISSING),
                ("operation_id", _KW, _MISSING),
                ("observed_at", _KW, _MISSING),
            ],
            "report_artifact": [
                ("self", _POS, _MISSING),
                ("context", _POS, _MISSING),
                ("operation_id", _KW, _MISSING),
                ("artifact", _KW, _MISSING),
                ("observed_at", _KW, _MISSING),
            ],
            "collect": [
                ("self", _POS, _MISSING),
                ("context", _POS, _MISSING),
                ("operation_id", _KW, _MISSING),
                ("observed_at", _KW, _MISSING),
                ("artifact", _KW, None),
                ("completed_at", _KW, None),
            ],
            "replay_result": [
                ("self", _POS, _MISSING),
                ("context", _POS, _MISSING),
                ("result", _POS, _MISSING),
                ("operation_id", _KW, _MISSING),
            ],
            "resume": [
                ("self", _POS, _MISSING),
                ("context", _POS, _MISSING),
            ],
        }
        for name, params in expected.items():
            sig = inspect.signature(getattr(ProviderOrchestrator, name))
            actual = [(p.name, p.kind, p.default) for p in sig.parameters.values()]
            assert actual == params, name
            # no *args / **kwargs
            for p in sig.parameters.values():
                assert p.kind not in (
                    inspect.Parameter.VAR_POSITIONAL,
                    inspect.Parameter.VAR_KEYWORD,
                ), name
        # the seven public methods and no undeclared extras
        public = {
            n
            for n in vars(ProviderOrchestrator)
            if callable(getattr(ProviderOrchestrator, n)) and not n.startswith("_")
        }
        assert public == set(expected)

    def test_export_set_is_exact_28(self) -> None:  # entry 2
        assert len(orchestration_package.__all__) == 28
        for name in (
            "ProviderOrchestrator",
            "OrchestrationContext",
            "OrchestrationOutcome",
            "OrchestrationPlan",
            "ResumeAssessment",
            "OrchestrationRecord",
            "OrchestrationAction",
            "OutcomeKind",
            "RecordPhase",
            "RecoveryDisposition",
            "OrchestrationError",
        ):
            assert name in orchestration_package.__all__
        for internal in (
            "_OrchestrationPlanner",
            "_FileOrchestrationExecutor",
            "_ExecutablePlan",
            "_LayoutResolver",
            "_StateLayout",
            "_PendingApply",
            "_PendingProviderCall",
        ):
            assert internal not in orchestration_package.__all__
            assert not hasattr(orchestration_package, internal)

    def test_public_plan_hides_model_instances(self, project) -> None:  # entry 3
        outcome = _prepare(project)
        assert isinstance(outcome.plan, OrchestrationPlan)
        assert isinstance(outcome.plan.task_after_snapshot, dict) is False
        # snapshot is a read-only Mapping wrapper, not a GenerationTask
        assert not isinstance(outcome.plan.task_after_snapshot, GenerationTask)
        assert not isinstance(outcome.plan.manifest_after_snapshot, StepManifest)

    def test_updated_task_manifest_new_instance_each_access(self, project) -> None:
        outcome = _prepare(project)  # entry 4
        a, b = outcome.updated_task, outcome.updated_task
        assert isinstance(a, GenerationTask) and a is not b and a == b
        m1, m2 = outcome.updated_manifest, outcome.updated_manifest
        assert isinstance(m1, StepManifest) and m1 is not m2 and m1 == m2

    def test_public_snapshot_defensive_copy(self, project) -> None:  # entry 5
        outcome = _prepare(project)
        d1 = outcome.plan.to_json_dict()
        d1["task_after_snapshot"]["mutated"] = True
        d2 = outcome.plan.to_json_dict()
        assert "mutated" not in d2["task_after_snapshot"]
        rec = outcome.record.to_json_dict()
        rec["injected"] = 1
        assert "injected" not in outcome.record.to_json_dict()

    def test_new_models_are_frozen_slots_unhashable(self, project) -> None:  # entry 6
        import dataclasses

        outcome = _prepare(project)
        for obj in (outcome, outcome.plan, outcome.record, _ctx(project)):
            assert type(obj).__hash__ is None
            with pytest.raises(TypeError):
                hash(obj)
            # slots: no per-instance __dict__
            assert not hasattr(obj, "__dict__")
            # frozen: normal attribute assignment is refused
            field_name = dataclasses.fields(obj)[0].name
            with pytest.raises(dataclasses.FrozenInstanceError):
                setattr(obj, field_name, None)

    def test_nested_mutable_input_defensive_copy(self, project) -> None:  # entry 7
        outcome = _prepare(project)
        # mutating the returned before_fingerprints view must not leak
        j = outcome.plan.to_json_dict()
        j["before_fingerprints"]["task"] = "x"
        assert outcome.plan.to_json_dict()["before_fingerprints"]["task"] != "x"

    def test_noop_invariants(self, project) -> None:  # entry 8
        orch = ProviderOrchestrator(ManualVideoProvider())
        orch.prepare(_ctx(project), operation_id="op-1", observed_at=_t(9))
        before = _record_json(project)
        out = orch.prepare(_ctx(project), operation_id="op-2", observed_at=_t(10))
        assert out.kind is OutcomeKind.NO_OP
        assert out.plan is None
        assert out.no_op_reason == "repeated_prepare"
        assert out.record.stable_version == 1
        assert _record_json(project) == before  # zero writes

    def test_no_hidden_time_or_state(self) -> None:  # entry 9
        src = inspect.getsource(orchestrator_module)
        assert "datetime.now" not in src
        assert "utcnow" not in src
        # orchestrator holds only the three declared slots
        assert ProviderOrchestrator.__slots__ == ("_provider", "_executor", "_planner")


# ===========================================================================
# §22 57-63: durable call ordering, WAL, outcome unknown, redrive
# ===========================================================================


class TestDurableCallOrdering:
    def test_submit_intent_then_may_then_call(self, project) -> None:  # entry 57
        _prepare(project)
        spy = _RecordingProvider()
        orch = ProviderOrchestrator(spy)
        out = orch.submit(_ctx(project), operation_id="op-s", observed_at=_t(11))
        assert out.kind is OutcomeKind.APPLIED
        assert spy.count("submit") == 1
        assert out.record.provider_status is ProviderStatus.WAITING_FOR_USER

    def test_intent_write_failure_calls_provider_zero_times(
        self, project, monkeypatch
    ) -> None:
        _prepare(project)
        spy = _RecordingProvider()
        orch = ProviderOrchestrator(spy)

        def _boom(self, *a, **k):
            raise PartialCommitConflictError("intent write failed")

        monkeypatch.setattr(
            _FileOrchestrationExecutor, "write_pending_call_intent", _boom
        )
        with pytest.raises(PartialCommitConflictError):
            orch.submit(_ctx(project), operation_id="op-s", observed_at=_t(11))
        assert spy.count("submit") == 0

    def test_may_have_started_write_failure_calls_provider_zero(
        self, project, monkeypatch
    ) -> None:
        _prepare(project)
        spy = _RecordingProvider()
        orch = ProviderOrchestrator(spy)
        real = _FileOrchestrationExecutor.write_pending_call_intent
        state = {"n": 0}

        def _fail_second(self, task_id, stable, pending_call):
            state["n"] += 1
            if state["n"] == 2:  # the MAY_HAVE_STARTED write
                raise PartialCommitConflictError("may-have-started write failed")
            return real(self, task_id, stable, pending_call)

        monkeypatch.setattr(
            _FileOrchestrationExecutor, "write_pending_call_intent", _fail_second
        )
        with pytest.raises(PartialCommitConflictError):
            orch.submit(_ctx(project), operation_id="op-s", observed_at=_t(11))
        assert spy.count("submit") == 0

    def test_submit_provider_exception_lands_result_unknown(self, project) -> None:
        _prepare(project)  # entries 59
        spy = _RecordingProvider()
        spy.raises["submit"] = ProviderOperationError("network down")
        orch = ProviderOrchestrator(spy)
        with pytest.raises(UnknownProviderSideEffectError) as exc:
            orch.submit(_ctx(project), operation_id="op-s", observed_at=_t(11))
        assert isinstance(exc.value.__cause__, ProviderOperationError)
        assert spy.count("submit") == 1
        assert _record_json(project)["phase"] == "provider_result_unknown"

    def test_may_have_started_never_resubmits(self, project) -> None:  # entry 59
        _prepare(project)
        spy = _RecordingProvider()
        spy.raises["submit"] = ProviderOperationError("network down")
        orch = ProviderOrchestrator(spy)
        with pytest.raises(UnknownProviderSideEffectError):
            orch.submit(_ctx(project), operation_id="op-s", observed_at=_t(11))
        # a subsequent submit must not call the provider again (E-unknown)
        with pytest.raises(UnknownProviderSideEffectError):
            orch.submit(_ctx(project), operation_id="op-s2", observed_at=_t(12))
        assert spy.count("submit") == 1

    def test_collect_provider_exception_manual(self, project) -> None:  # entry 60
        _prepare(project)
        ProviderOrchestrator(ManualVideoProvider()).submit(
            _ctx(project), operation_id="op-s", observed_at=_t(11)
        )
        spy = _RecordingProvider()
        spy.raises["collect"] = ProviderOperationError("crash")
        orch = ProviderOrchestrator(spy)
        with pytest.raises(UnknownProviderSideEffectError):
            orch.collect(
                _ctx(project),
                operation_id="op-c",
                observed_at=_t(12),
                artifact=ARTIFACT,
            )
        assert _record_json(project)["phase"] == "provider_result_unknown"
        assert orch.resume(_ctx(project)).requires_manual_reconciliation is True

    def test_intent_redrive_same_identity_and_conflict(self, project) -> None:
        _prepare(project)  # entry 61
        ProviderOrchestrator(ManualVideoProvider()).submit(
            _ctx(project), operation_id="op-s", observed_at=_t(11)
        )
        # crash a collect at the provider -> MAY_HAVE_STARTED... instead craft INTENT
        # by having the provider raise, then rewrite to INTENT via executor.
        spy = _RecordingProvider()
        spy.raises["collect"] = ProviderOperationError("x")
        # land an INTENT then verify redrive semantics through resume
        # (a genuine INTENT: intercept before the MAY write)
        # simplest: different-operation redrive after INTENT is a conflict
        # We build the INTENT with the executor directly.
        from ai_video_workflow.orchestration._models import _PendingProviderCall
        from ai_video_workflow.orchestration.canonical import (
            _fingerprint,
            _make_snapshot_wrapper,
        )
        from ai_video_workflow.orchestration.recovery import _parse_stable_wrapper

        stable = _parse_stable_wrapper(_record_json(project)["stable"])
        req_wrap = _make_snapshot_wrapper("provider_request", REQUEST.to_json_dict())
        action_input = _make_snapshot_wrapper(
            "action_input",
            {
                "observed_at": _t(12).isoformat(timespec="microseconds"),
                "artifact": {
                    "snapshot_kind": "artifact_reference",
                    "snapshot_version": 1,
                    "payload": ARTIFACT.to_json_dict(),
                },
                "completed_at": None,
                "result_fingerprint": None,
            },
        )
        pending = _PendingProviderCall(
            operation_id="op-c",
            action=OrchestrationAction.COLLECT,
            baseline_version=stable.version,
            request_snapshot=req_wrap,
            request_fingerprint=_fingerprint(req_wrap),
            action_input_snapshot=action_input,
            action_input_fingerprint=_fingerprint(action_input),
            original_observed_at=_t(12),
            original_completed_at=None,
            artifact_input=_make_snapshot_wrapper(
                "artifact_reference", ARTIFACT.to_json_dict()
            ),
            call_phase=RecordPhase.PROVIDER_CALL_INTENT,
            call_may_have_started=False,
            started_at=_t(12),
            recovery_policy=RecoveryDisposition.MANUAL_RECONCILIATION,
        )
        executor = _FileOrchestrationExecutor(project)
        executor.write_pending_call_intent("task-1", stable, pending)
        # a POLL (different action) over the INTENT is E-state
        orch = ProviderOrchestrator(ManualVideoProvider())
        with pytest.raises(InvalidOrchestrationStateError):
            orch.poll(_ctx(project), operation_id="op-c", observed_at=_t(12))
        # a same-action collect with a DIFFERENT operation is an idempotency conflict
        with pytest.raises(IdempotencyConflictError):
            orch.collect(
                _ctx(project),
                operation_id="op-other",
                observed_at=_t(12),
                artifact=ARTIFACT,
            )

    def test_same_identity_intent_redrive_executes_to_applied(self, project) -> None:
        # entry 61 positive branch: a retry after a crash between the durable
        # INTENT write and the Provider call, with the SAME operation_id, the
        # SAME action, and the SAME full call inputs, re-enters through
        # _route_call_phase, re-validates admission, calls the Provider
        # exactly once, advances the WAL, and commits APPLIED/STABLE.
        _land_call_phase(project, RecordPhase.PROVIDER_CALL_INTENT)
        record = _record_json(project)
        assert record["phase"] == "provider_call_intent"
        assert record["pending"]["operation_id"] == "op-call"
        assert record["pending"]["action"] == "collect"
        baseline_version = record["stable"]["payload"]["version"]

        # phase 2: redrive with the identical identity via the public facade
        spy = _RecordingProvider()
        out = ProviderOrchestrator(spy).collect(
            _ctx(project), operation_id="op-call", observed_at=_t(12), artifact=ARTIFACT
        )
        assert spy.total == 1  # exactly one Provider call, no conflict raised
        assert spy.count("collect") == 1
        assert out.kind is OutcomeKind.APPLIED
        assert out.provider_result.status is ProviderStatus.SUCCEEDED
        assert out.artifact_handoff.reference == ARTIFACT.reference
        assert out.record.last_completed_action is OrchestrationAction.COLLECT
        after = _record_json(project)
        assert after["phase"] == "stable"
        assert after["pending"] is None
        assert after["stable"]["payload"]["version"] == baseline_version + 1

    def test_direct_path_to_applying_boundary(self, project, monkeypatch) -> None:
        # entry 62: a direct-path poll on a WAITING_FOR_USER baseline returns a
        # Provider result, the apply intent lands, the task is written, and a
        # crash is injected BEFORE the manifest is written — a genuine PARTIAL
        # business commit (task = after, manifest = before). The record is
        # APPLYING with a "task" confirmed hint; the Provider was called once;
        # a subsequent resume performs only the LOCAL fingerprint-authoritative
        # recovery (Provider not re-called), landing the EXACT planned STABLE:
        # the recovered task/manifest equal the plan after-snapshots, the
        # instruction bytes equal the committed carry-over bytes, and the whole
        # committed stable record (version, last_completed_action, authoritative
        # artifact, every fingerprint) equals the planned stable wrapper.
        from ai_video_workflow.orchestration.canonical import _thaw_mapping
        from ai_video_workflow.orchestration.recovery import (
            _restore_generation_task,
            _restore_step_manifest,
        )

        # a genuine manual submit yields a WAITING_FOR_USER stable with no
        # external_task_ref, so the subsequent manual poll is valid.
        _prepare(project)
        ProviderOrchestrator(ManualVideoProvider()).submit(
            _ctx(project), operation_id="op-s", observed_at=_t(11)
        )
        assert _record_json(project)["phase"] == "stable"  # initial phase
        task_before = (project / "records/generation-tasks/task-1.json").read_bytes()
        manifest_before = (project / "manifests/generation-task-1.json").read_bytes()
        instruction_before = (project / "tasks/instructions/task-1.md").read_bytes()
        spy = _RecordingProvider()

        def _boom_apply_manifest(self, *a, **k):
            # fail AFTER _apply_task wrote the task, BEFORE the manifest write
            raise PersistenceExecutionError("crash mid-apply, after the task write")

        monkeypatch.setattr(
            _FileOrchestrationExecutor, "_apply_manifest", _boom_apply_manifest
        )
        with pytest.raises(PersistenceExecutionError):
            ProviderOrchestrator(spy).poll(
                _ctx(project), operation_id="op-poll", observed_at=_t(12)
            )
        assert spy.count("poll") == 1  # Provider called exactly once

        # genuine partial commit: task advanced to the after-state, manifest not
        pending = (
            _FileOrchestrationExecutor(project)
            .read_project_state("task-1")
            .record.pending
        )
        expected_task = _restore_generation_task(pending.task_after_snapshot)
        expected_manifest = _restore_step_manifest(pending.manifest_after_snapshot)
        expected_stable_wrapper = _thaw_mapping(pending.planned_stable_state_snapshot)
        expected_instruction_fp = pending.instruction_after_fingerprint
        expected_version = pending.baseline_version + 1
        mid = _record_json(project)
        assert mid["phase"] == "applying"
        assert mid["pending"]["confirmed_writes"] == ["task"]
        assert (
            project / "records/generation-tasks/task-1.json"
        ).read_bytes() != task_before  # task was written (after)
        assert (
            project / "manifests/generation-task-1.json"
        ).read_bytes() == manifest_before  # manifest not yet written (before)

        # local recovery re-drives APPLYING -> STABLE and calls no Provider
        monkeypatch.undo()
        resume_spy = _RecordingProvider()
        a = ProviderOrchestrator(resume_spy).resume(_ctx(project))
        assert a.phase is RecordPhase.STABLE
        assert a.disposition is RecoveryDisposition.SAFE_AUTO_RETRY
        assert resume_spy.total == 0

        # field-level: the recovered files equal the plan after-state, the whole
        # committed stable record equals the planned stable wrapper, the
        # instruction bytes equal the committed carry-over bytes, and the
        # committed fingerprints match the actual files.
        executor = _FileOrchestrationExecutor(project)
        obs = executor.read_project_state("task-1")
        assert obs.record.phase is RecordPhase.STABLE
        assert obs.record.stable.version == expected_version
        assert _record_json(project)["stable"] == expected_stable_wrapper
        assert obs.task == expected_task
        assert obs.manifest == expected_manifest
        assert (
            project / "tasks/instructions/task-1.md"
        ).read_bytes() == instruction_before  # instruction bytes are carry-over
        assert obs.instruction_fingerprint == expected_instruction_fp
        executor.verify_committed_state(obs.record.stable, obs)

    def test_direct_path_crash_before_provider_is_safe_to_retry(
        self, project
    ) -> None:  # entry 63 (crash point A: a real pre-call validation failure)
        # A genuine pre-call validation failure (a stale caller context whose
        # snapshot no longer matches disk) — NOT a Provider spy exception —
        # rejects before the Provider call. Disk still equals the committed
        # baseline, so re-reading a fresh context is a safe retry.
        _prepare(project)  # v1 not_submitted
        stale_context = _ctx(project)  # captures the v1 task snapshot
        ProviderOrchestrator(ManualVideoProvider()).submit(
            _ctx(project), operation_id="op-s", observed_at=_t(11)
        )  # v2 waiting; the on-disk task advances past the stale snapshot
        before = _record_json(project)
        assert before["phase"] == "stable"  # initial phase
        spy = _RecordingProvider()
        with pytest.raises(InvalidOrchestrationInputError):
            ProviderOrchestrator(spy).poll(
                stale_context, operation_id="op-poll", observed_at=_t(12)
            )
        assert spy.total == 0  # Provider not called
        assert _record_json(project) == before  # final phase == initial; no WAL
        # resume of the clean committed state (fresh context): exact assessment
        assess = ProviderOrchestrator(_RecordingProvider()).resume(_ctx(project))
        assert assess.phase is RecordPhase.STABLE
        assert assess.disposition is RecoveryDisposition.NONE
        assert assess.legal_actions == (
            OrchestrationAction.POLL,
            OrchestrationAction.REPORT_ARTIFACT,
            OrchestrationAction.COLLECT,
        )
        assert assess.preferred_next_action is OrchestrationAction.POLL
        assert assess.requires_manual_reconciliation is False
        assert assess.is_terminal is False
        # repeated invocation with a corrected (fresh) context is safe
        ok = ProviderOrchestrator(ManualVideoProvider()).poll(
            _ctx(project), operation_id="op-poll-2", observed_at=_t(13)
        )
        assert ok.kind is OutcomeKind.APPLIED

    def test_direct_path_crash_after_provider_before_apply_intent_is_safe(
        self, project, monkeypatch
    ) -> None:  # entry 63 (crash point B: after the Provider, before apply)
        # manual-pollable WAITING_FOR_USER stable (no external_task_ref)
        _prepare(project)
        ProviderOrchestrator(ManualVideoProvider()).submit(
            _ctx(project), operation_id="op-s", observed_at=_t(11)
        )
        before = _record_json(project)
        assert before["phase"] == "stable"  # initial phase
        task_before = (project / "records/generation-tasks/task-1.json").read_bytes()
        manifest_before = (project / "manifests/generation-task-1.json").read_bytes()
        spy = _RecordingProvider()

        def _boom_write_apply_intent(self, *a, **k):
            raise PersistenceExecutionError("crash before the apply intent lands")

        monkeypatch.setattr(
            _FileOrchestrationExecutor, "write_apply_intent", _boom_write_apply_intent
        )
        with pytest.raises(PersistenceExecutionError):
            ProviderOrchestrator(spy).poll(
                _ctx(project), operation_id="op-poll", observed_at=_t(12)
            )
        # Provider called once; no durable state changed at all (record and
        # business files byte-identical) -> final phase == initial
        assert spy.count("poll") == 1
        assert _record_json(project) == before
        assert (
            project / "records/generation-tasks/task-1.json"
        ).read_bytes() == task_before
        assert (
            project / "manifests/generation-task-1.json"
        ).read_bytes() == manifest_before
        monkeypatch.undo()
        # resume finds a clean STABLE (no WAL landed): exact assessment
        assess = ProviderOrchestrator(_RecordingProvider()).resume(_ctx(project))
        assert assess.phase is RecordPhase.STABLE
        assert assess.disposition is RecoveryDisposition.NONE
        assert assess.legal_actions == (
            OrchestrationAction.POLL,
            OrchestrationAction.REPORT_ARTIFACT,
            OrchestrationAction.COLLECT,
        )
        assert assess.preferred_next_action is OrchestrationAction.POLL
        assert assess.requires_manual_reconciliation is False
        assert assess.is_terminal is False
        # repeated invocation is safe (a fresh direct poll applies)
        ok = ProviderOrchestrator(ManualVideoProvider()).poll(
            _ctx(project), operation_id="op-poll-2", observed_at=_t(13)
        )
        assert ok.kind is OutcomeKind.APPLIED

    def test_direct_path_crash_after_apply_intent_partial_commit(
        self, project, monkeypatch
    ) -> None:  # entry 63 (crash point C: apply intent landed, partial write)
        # A genuine partial commit: the apply intent landed and the task was
        # written, but the manifest write crashed. The record is APPLYING with a
        # "task" confirmed hint; task = after, manifest = before. Resume performs
        # only local recovery (Provider not re-called) and lands STABLE.
        _prepare(project)
        ProviderOrchestrator(ManualVideoProvider()).submit(
            _ctx(project), operation_id="op-s", observed_at=_t(11)
        )
        assert _record_json(project)["phase"] == "stable"  # initial phase
        task_before = (project / "records/generation-tasks/task-1.json").read_bytes()
        manifest_before = (project / "manifests/generation-task-1.json").read_bytes()
        spy = _RecordingProvider()

        def _boom_apply_manifest(self, *a, **k):
            raise PersistenceExecutionError("crash mid-apply, after the task write")

        monkeypatch.setattr(
            _FileOrchestrationExecutor, "_apply_manifest", _boom_apply_manifest
        )
        with pytest.raises(PersistenceExecutionError):
            ProviderOrchestrator(spy).poll(
                _ctx(project), operation_id="op-poll", observed_at=_t(12)
            )
        assert spy.count("poll") == 1  # Provider called once
        # partial durable commit: phase APPLYING, task written, manifest not
        assert _record_json(project)["phase"] == "applying"
        assert (
            project / "records/generation-tasks/task-1.json"
        ).read_bytes() != task_before
        assert (
            project / "manifests/generation-task-1.json"
        ).read_bytes() == manifest_before
        monkeypatch.undo()
        # resume: local recovery only (Provider 0), lands STABLE with the exact
        # assessment for the recovered WAITING_FOR_USER state
        resume_spy = _RecordingProvider()
        assess = ProviderOrchestrator(resume_spy).resume(_ctx(project))
        assert resume_spy.total == 0
        assert assess.phase is RecordPhase.STABLE
        assert assess.disposition is RecoveryDisposition.SAFE_AUTO_RETRY
        assert assess.legal_actions == (
            OrchestrationAction.POLL,
            OrchestrationAction.REPORT_ARTIFACT,
            OrchestrationAction.COLLECT,
        )
        assert assess.preferred_next_action is OrchestrationAction.POLL
        assert assess.requires_manual_reconciliation is False
        assert assess.is_terminal is False
        assert _record_json(project)["phase"] == "stable"
        # repeated resume over the recovered STABLE is a normal NONE, unchanged
        after_recover = _state_dir_snapshot(project)
        repeat = ProviderOrchestrator(_RecordingProvider()).resume(_ctx(project))
        assert repeat.phase is RecordPhase.STABLE
        assert repeat.disposition is RecoveryDisposition.NONE
        assert _state_dir_snapshot(project) == after_recover


# ===========================================================================
# §22 74/75/127/129/130/131: record loss + first-write traces
# ===========================================================================


class TestRecordLossAndTraces:
    def test_missing_record_with_trace(self, project) -> None:  # entry 74
        _prepare(project)
        (project / "records/orchestration/task-1.json").unlink()
        with pytest.raises(Exception) as exc:
            ProviderOrchestrator(ManualVideoProvider()).poll(
                _ctx(project), operation_id="op-x", observed_at=_t(12)
            )
        from ai_video_workflow.orchestration import MissingRecoveryRecordError

        assert isinstance(exc.value, MissingRecoveryRecordError)

    def test_missing_record_no_trace_is_prepare(self, project) -> None:  # entry 75
        out = ProviderOrchestrator(ManualVideoProvider()).prepare(
            _ctx(project), operation_id="op-1", observed_at=_t(9)
        )
        assert out.kind is OutcomeKind.APPLIED
        assert out.record.stable_version == 1

    def test_provider_id_set_without_record_is_trace(self, project) -> None:  # 127
        _write_task(project, provider_id="manual", updated_at=_t(9))
        from ai_video_workflow.orchestration import MissingRecoveryRecordError

        with pytest.raises(MissingRecoveryRecordError):
            ProviderOrchestrator(ManualVideoProvider()).prepare(
                _ctx(project), operation_id="op-1", observed_at=_t(10)
            )

    def test_first_task_written_then_record_lost(self, project) -> None:  # 129
        _prepare(project)
        (project / "records/orchestration/task-1.json").unlink()
        (project / "manifests/generation-task-1.json").unlink()
        (project / "tasks/instructions/task-1.md").unlink()
        # only the task carries a trace now (provider_id set)
        _write_manifest(project)
        from ai_video_workflow.orchestration import MissingRecoveryRecordError

        with pytest.raises(MissingRecoveryRecordError):
            ProviderOrchestrator(ManualVideoProvider()).prepare(
                _ctx(project), operation_id="op-2", observed_at=_t(12)
            )

    def test_first_manifest_written_then_record_lost(self, project) -> None:  # 130
        _prepare(project)
        (project / "records/orchestration/task-1.json").unlink()
        (project / "tasks/instructions/task-1.md").unlink()
        _write_task(
            project
        )  # clear provider_id trace; manifest keeps orchestration key
        from ai_video_workflow.orchestration import MissingRecoveryRecordError

        with pytest.raises(MissingRecoveryRecordError):
            ProviderOrchestrator(ManualVideoProvider()).prepare(
                _ctx(project), operation_id="op-2", observed_at=_t(12)
            )

    def test_first_instruction_written_then_record_lost(self, project) -> None:  # 131
        _prepare(project)
        (project / "records/orchestration/task-1.json").unlink()
        _write_task(project)
        _write_manifest(project)
        from ai_video_workflow.orchestration import MissingRecoveryRecordError

        with pytest.raises(MissingRecoveryRecordError):
            ProviderOrchestrator(ManualVideoProvider()).prepare(
                _ctx(project), operation_id="op-2", observed_at=_t(12)
            )


# ===========================================================================
# §22 78-84: operation identity / idempotency / NO_OP
# ===========================================================================


class TestOperationIdentity:
    def test_response_loss_same_identity_noop(self, project) -> None:  # entry 78
        _prepare(project)
        orch = ProviderOrchestrator(ManualVideoProvider())
        first = orch.submit(_ctx(project), operation_id="op-s", observed_at=_t(11))
        assert first.kind is OutcomeKind.APPLIED
        # response lost: retry the exact same submit identity
        spy = _RecordingProvider()
        again = ProviderOrchestrator(spy).submit(
            _ctx(project), operation_id="op-s", observed_at=_t(11)
        )
        assert again.kind is OutcomeKind.NO_OP
        assert again.no_op_reason == "committed_operation_replay"
        assert spy.count("submit") == 0

    def test_response_loss_different_op_no_resubmit(self, project) -> None:  # entry 79
        _prepare(project)
        ProviderOrchestrator(ManualVideoProvider()).submit(
            _ctx(project), operation_id="op-s", observed_at=_t(11)
        )
        # state is now waiting; a fresh submit is E-state and never calls provider
        spy = _RecordingProvider()
        with pytest.raises(InvalidOrchestrationStateError):
            ProviderOrchestrator(spy).submit(
                _ctx(project), operation_id="op-s2", observed_at=_t(12)
            )
        assert spy.count("submit") == 0

    def test_same_op_different_input_conflict(self, project) -> None:  # entry 80
        _prepare(project)
        ProviderOrchestrator(ManualVideoProvider()).submit(
            _ctx(project), operation_id="op-s", observed_at=_t(11)
        )
        spy = _RecordingProvider()
        with pytest.raises(IdempotencyConflictError):
            ProviderOrchestrator(spy).poll(
                _ctx(project), operation_id="op-s", observed_at=_t(12)
            )
        assert spy.total == 0

    def test_poll_new_op_new_observation(self, project) -> None:  # entry 81
        _prepare(project)
        ProviderOrchestrator(ManualVideoProvider()).submit(
            _ctx(project), operation_id="op-s", observed_at=_t(11)
        )
        out = ProviderOrchestrator(ManualVideoProvider()).poll(
            _ctx(project), operation_id="op-p", observed_at=_t(12)
        )
        assert out.kind is OutcomeKind.APPLIED
        assert out.record.stable_version == 3

    def test_repeated_prepare_noop(self, project) -> None:  # entry 82
        _prepare(project)
        out = ProviderOrchestrator(ManualVideoProvider()).prepare(
            _ctx(project), operation_id="op-2", observed_at=_t(10)
        )
        assert out.kind is OutcomeKind.NO_OP and out.no_op_reason == "repeated_prepare"

    def test_terminal_replay_noop(self, project) -> None:  # entry 83
        _seed_status(project, ProviderStatus.SUCCEEDED)
        terminal = _result(
            ProviderStatus.SUCCEEDED,
            observed_at=_t(10),
            artifact=ARTIFACT,
            completed_at=_t(10),
        )
        out = ProviderOrchestrator(ManualVideoProvider()).replay_result(
            _ctx(project), terminal, operation_id="op-replay"
        )
        assert out.kind is OutcomeKind.NO_OP and out.no_op_reason == "terminal_replay"

    def test_collect_succeeded_same_artifact_noop_conflict(self, project) -> None:
        _seed_status(project, ProviderStatus.SUCCEEDED)  # entry 84
        orch = ProviderOrchestrator(ManualVideoProvider())
        same = orch.collect(
            _ctx(project), operation_id="op-c", observed_at=_t(11), artifact=ARTIFACT
        )
        assert (
            same.kind is OutcomeKind.NO_OP and same.no_op_reason == "already_collected"
        )
        with pytest.raises(ConflictingProviderResultError):
            orch.collect(
                _ctx(project),
                operation_id="op-c2",
                observed_at=_t(11),
                artifact=ARTIFACT_OTHER,
            )


# ===========================================================================
# §22 87: full §17.2 admission matrix (13 states x 7 actions = 91)
# ===========================================================================

_MATRIX_STATES = [
    "empty",
    ProviderStatus.NOT_SUBMITTED,
    ProviderStatus.WAITING_FOR_USER,
    ProviderStatus.PROCESSING,
    ProviderStatus.ARTIFACT_AVAILABLE,
    ProviderStatus.SUCCEEDED,
    ProviderStatus.FAILED,
    ProviderStatus.CANCELLED,
    RecordPhase.PROVIDER_CALL_INTENT,
    RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
    RecordPhase.PROVIDER_RESULT_UNKNOWN,
    RecordPhase.APPLYING,
    RecordPhase.RECOVERY_REQUIRED,
]

_MATRIX_ACTIONS = [
    OrchestrationAction.PREPARE,
    OrchestrationAction.SUBMIT,
    OrchestrationAction.POLL,
    OrchestrationAction.REPORT_ARTIFACT,
    OrchestrationAction.COLLECT,
    OrchestrationAction.REPLAY_RESULT,
    OrchestrationAction.RESUME,
]

# category per (state, action): call / e_state / noop / replay / e_unknown /
# idem_conflict / repair_stale / e_recovery / assessment
_PREP, _SUB, _POLL, _REP, _COL, _RPL, _RES = _MATRIX_ACTIONS
_FULL_MATRIX = {
    "empty": {
        _PREP: "call",
        _SUB: "e_state",
        _POLL: "e_state",
        _REP: "e_state",
        _COL: "e_state",
        _RPL: "e_state",
        _RES: "assessment",
    },
    ProviderStatus.NOT_SUBMITTED: {
        _PREP: "noop",
        _SUB: "call",
        _POLL: "e_state",
        _REP: "e_state",
        _COL: "e_state",
        _RPL: "replay",
        _RES: "assessment",
    },
    ProviderStatus.WAITING_FOR_USER: {
        _PREP: "e_state",
        _SUB: "e_state",
        _POLL: "call",
        _REP: "call",
        _COL: "call",
        _RPL: "replay",
        _RES: "assessment",
    },
    ProviderStatus.PROCESSING: {
        _PREP: "e_state",
        _SUB: "e_state",
        _POLL: "call",
        _REP: "call",
        _COL: "e_state",
        _RPL: "replay",
        _RES: "assessment",
    },
    ProviderStatus.ARTIFACT_AVAILABLE: {
        _PREP: "e_state",
        _SUB: "e_state",
        _POLL: "call",
        _REP: "call",
        _COL: "call",
        _RPL: "replay",
        _RES: "assessment",
    },
    ProviderStatus.SUCCEEDED: {
        _PREP: "e_state",
        _SUB: "e_state",
        _POLL: "e_state",
        _REP: "e_state",
        _COL: "noop",
        _RPL: "replay",
        _RES: "assessment",
    },
    ProviderStatus.FAILED: {
        _PREP: "e_state",
        _SUB: "e_state",
        _POLL: "e_state",
        _REP: "e_state",
        _COL: "e_state",
        _RPL: "replay",
        _RES: "assessment",
    },
    ProviderStatus.CANCELLED: {
        _PREP: "e_state",
        _SUB: "e_state",
        _POLL: "e_state",
        _REP: "e_state",
        _COL: "e_state",
        _RPL: "replay",
        _RES: "assessment",
    },
    RecordPhase.PROVIDER_CALL_INTENT: {
        _PREP: "e_state",
        _SUB: "e_state",
        _POLL: "e_state",
        _REP: "e_state",
        _COL: "idem_conflict",
        _RPL: "e_state",
        _RES: "assessment",
    },
    RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED: {
        _PREP: "e_unknown",
        _SUB: "e_unknown",
        _POLL: "e_unknown",
        _REP: "e_unknown",
        _COL: "e_unknown",
        _RPL: "e_unknown",
        _RES: "assessment",
    },
    RecordPhase.PROVIDER_RESULT_UNKNOWN: {
        _PREP: "e_unknown",
        _SUB: "e_unknown",
        _POLL: "e_unknown",
        _REP: "e_unknown",
        _COL: "e_unknown",
        _RPL: "e_unknown",
        _RES: "assessment",
    },
    RecordPhase.APPLYING: {
        _PREP: "repair_stale",
        _SUB: "repair_stale",
        _POLL: "repair_stale",
        _REP: "repair_stale",
        _COL: "repair_stale",
        _RPL: "repair_stale",
        _RES: "assessment",
    },
    RecordPhase.RECOVERY_REQUIRED: {
        _PREP: "e_recovery",
        _SUB: "e_recovery",
        _POLL: "e_recovery",
        _REP: "e_recovery",
        _COL: "e_recovery",
        _RPL: "e_recovery",
        _RES: "assessment",
    },
}


def _setup_matrix_state(root, state):
    if state == "empty":
        return
    if isinstance(state, ProviderStatus):
        _seed_status(root, state)
    elif state in _CALL_PHASE_ORDER:
        _land_call_phase(root, state)
    elif state is RecordPhase.APPLYING:
        _land_applying(root)
    else:  # RECOVERY_REQUIRED
        _land_recovery_required_record(root)


def _matrix_invoke(orch, root, action):
    if action is OrchestrationAction.PREPARE:
        return orch.prepare(_ctx(root), operation_id="op-a", observed_at=_t(15))
    if action is OrchestrationAction.SUBMIT:
        return orch.submit(_ctx(root), operation_id="op-a", observed_at=_t(15))
    if action is OrchestrationAction.POLL:
        return orch.poll(_ctx(root), operation_id="op-a", observed_at=_t(15))
    if action is OrchestrationAction.REPORT_ARTIFACT:
        return orch.report_artifact(
            _ctx(root), operation_id="op-a", artifact=ARTIFACT, observed_at=_t(15)
        )
    if action is OrchestrationAction.COLLECT:
        return orch.collect(
            _ctx(root), operation_id="op-a", observed_at=_t(15), artifact=ARTIFACT
        )
    if action is OrchestrationAction.REPLAY_RESULT:
        return orch.replay_result(
            _ctx(root),
            _result(
                ProviderStatus.SUCCEEDED,
                observed_at=_t(15),
                artifact=ARTIFACT,
                completed_at=_t(15),
            ),
            operation_id="op-a",
        )
    return orch.resume(_ctx(root))


_EXPECTED_INITIAL_PHASE = {
    "empty": None,
    ProviderStatus.NOT_SUBMITTED: "stable",
    ProviderStatus.WAITING_FOR_USER: "stable",
    ProviderStatus.PROCESSING: "stable",
    ProviderStatus.ARTIFACT_AVAILABLE: "stable",
    ProviderStatus.SUCCEEDED: "stable",
    ProviderStatus.FAILED: "stable",
    ProviderStatus.CANCELLED: "stable",
    RecordPhase.PROVIDER_CALL_INTENT: "provider_call_intent",
    RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED: "provider_call_may_have_started",
    RecordPhase.PROVIDER_RESULT_UNKNOWN: "provider_result_unknown",
    RecordPhase.APPLYING: "applying",
    RecordPhase.RECOVERY_REQUIRED: "recovery_required",
}

# The (state, action) cells whose "call" route is a pre-call WAL (intent) path:
# a tripwire Provider crash there lands PROVIDER_RESULT_UNKNOWN.
_INTENT_CALL_CELLS = {
    (ProviderStatus.NOT_SUBMITTED, OrchestrationAction.SUBMIT),
    (ProviderStatus.WAITING_FOR_USER, OrchestrationAction.COLLECT),
    (ProviderStatus.ARTIFACT_AVAILABLE, OrchestrationAction.COLLECT),
}

_NON_TERMINAL_STABLE = {
    ProviderStatus.NOT_SUBMITTED,
    ProviderStatus.WAITING_FOR_USER,
    ProviderStatus.PROCESSING,
    ProviderStatus.ARTIFACT_AVAILABLE,
}

_MATRIX_BUSINESS_FILES = (
    "records/generation-tasks/task-1.json",
    "manifests/generation-task-1.json",
    "tasks/instructions/task-1.md",
)


def _record_phase_or_none(root):
    path = root / "records/orchestration/task-1.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))["phase"]


def _state_dir_snapshot(root):
    """Snapshot the four durable state files (record + business) as bytes."""
    rels = ("records/orchestration/task-1.json", *_MATRIX_BUSINESS_FILES)
    return {
        rel: (root / rel).read_bytes() if (root / rel).exists() else None
        for rel in rels
    }


def _cell_expectation(state, action, category):
    """Return the single exact expectation for one §17.2 admission cell.

    Tuple: (exception_class_or_None, outcome_kind_or_"assessment"_or_None,
    provider_call_count, final_durable_phase, state_files_mutate). There is
    exactly one expected result per cell — no tolerant alternatives.
    ``state_files_mutate`` covers ALL four durable state files (the
    orchestration record AND the three business files), so an illegal
    same-phase record/WAL rewrite is caught even when the business files
    and phase are unchanged.
    """
    initial_phase = _EXPECTED_INITIAL_PHASE[state]
    if category == "e_state":
        return (InvalidOrchestrationStateError, None, 0, initial_phase, False)
    if category == "e_unknown":
        return (UnknownProviderSideEffectError, None, 0, initial_phase, False)
    if category == "idem_conflict":
        return (IdempotencyConflictError, None, 0, initial_phase, False)
    if category == "noop":
        return (None, OutcomeKind.NO_OP, 0, initial_phase, False)
    if category == "assessment":
        # resume: APPLYING auto-repairs to STABLE (record + business mutate);
        # every other state is a report-only assessment (no mutation).
        if state is RecordPhase.APPLYING:
            return (None, "assessment", 0, "stable", True)
        return (None, "assessment", 0, initial_phase, False)
    if category == "repair_stale":
        # APPLYING + non-resume: local recovery lands STABLE (business mutates)
        # then the now-stale original context is rejected (§17.2 REPAIR + §9).
        return (InvalidOrchestrationInputError, None, 0, "stable", True)
    if category == "e_recovery":
        # RECOVERY_REQUIRED (P9 origin) + non-resume: recover re-classifies the
        # P9 and re-lands RECOVERY_REQUIRED, raising PartialCommitConflictError;
        # the business files (in the drifted third state) are not applied.
        return (PartialCommitConflictError, None, 0, "recovery_required", False)
    if category == "call":
        if (state, action) in _INTENT_CALL_CELLS:
            # pre-call WAL path: the record advances STABLE -> INTENT ->
            # MAY_HAVE_STARTED, then the tripwire crash lands RESULT_UNKNOWN —
            # the record file mutates (business files do not).
            return (
                UnknownProviderSideEffectError,
                None,
                1,
                "provider_result_unknown",
                True,
            )
        # direct path: the tripwire raises before any write (no state mutation)
        return (_ReachedProvider, None, 1, initial_phase, False)
    if category == "replay":
        if state in _NON_TERMINAL_STABLE:
            return (None, OutcomeKind.APPLIED, 0, "stable", True)
        # terminal (succeeded / failed / cancelled): the matrix replays a
        # SUCCEEDED@t15 result that differs from the seeded committed result,
        # so it is a conflicting terminal replay (§17.2④), never a match.
        return (ConflictingProviderResultError, None, 0, "stable", False)
    raise AssertionError(f"unclassified cell category: {category}")


class TestAdmissionMatrix:
    """§22 87: full §17.2 admission matrix, 13 states x 7 actions = 91.

    Every cell asserts the six-tuple required by the strengthened entry
    87: initial durable phase/state, the public entry, the exact
    outcome/exception category, the Provider total call count, the final
    durable phase, and whether a filesystem mutation of the durable state
    (the orchestration record AND the three business files) occurred.
    """

    @pytest.mark.parametrize("state", _MATRIX_STATES)
    @pytest.mark.parametrize("action", _MATRIX_ACTIONS)
    def test_cell(self, tmp_path, state, action) -> None:
        root = tmp_path / "project"
        root.mkdir()
        (root / "records/generation-tasks").mkdir(parents=True)
        (root / "manifests").mkdir()
        _write_task(root)
        _write_manifest(root)
        _setup_matrix_state(root, state)
        category = _FULL_MATRIX[state][action]
        tripwire = _TripwireProvider()
        orch = ProviderOrchestrator(tripwire)

        # exactly one expectation per cell (no tolerant alternatives):
        exc, kind, calls, final_phase, state_mutates = _cell_expectation(
            state, action, category
        )

        # (initial) the setup landed the durable phase/state this cell claims
        assert _record_phase_or_none(root) == _EXPECTED_INITIAL_PHASE[state]
        # snapshot ALL four durable state files (record + 3 business files)
        before_state = _state_dir_snapshot(root)

        # (public entry + exact outcome / exception)
        if exc is not None:
            with pytest.raises(exc):
                _matrix_invoke(orch, root, action)
        elif kind == "assessment":
            assert isinstance(_matrix_invoke(orch, root, action), ResumeAssessment)
        else:
            assert _matrix_invoke(orch, root, action).kind is kind

        # (exact Provider call count)
        assert len(tripwire.calls) == calls
        # (exact final durable phase)
        assert _record_phase_or_none(root) == final_phase
        # (exact filesystem mutation over record + business files) — asserted
        # for every cell, e_recovery included; catches an illegal record/WAL
        # rewrite even when business files and phase are unchanged
        assert (_state_dir_snapshot(root) != before_state) is state_mutates

    def test_matrix_locks_all_91_cells(self) -> None:
        assert len(_MATRIX_STATES) == 13
        assert len(_MATRIX_ACTIONS) == 7
        assert sum(len(row) for row in _FULL_MATRIX.values()) == 91
        for state in _MATRIX_STATES:
            assert set(_FULL_MATRIX[state]) == set(_MATRIX_ACTIONS)


# ===========================================================================
# §22 115/116: end-to-end + resume across states
# ===========================================================================


class TestEndToEndAndResume:
    def test_manual_provider_full_lifecycle(self, project) -> None:  # entry 115
        orch = ProviderOrchestrator(ManualVideoProvider())
        p = orch.prepare(_ctx(project), operation_id="op-1", observed_at=_t(9))
        assert (
            p.record.stable_version == 1
            and (project / "tasks/instructions/task-1.md").exists()
        )
        s = orch.submit(_ctx(project), operation_id="op-2", observed_at=_t(10))
        assert s.provider_result.status is ProviderStatus.WAITING_FOR_USER
        r = orch.report_artifact(
            _ctx(project), operation_id="op-3", artifact=ARTIFACT, observed_at=_t(11)
        )
        assert r.provider_result.status is ProviderStatus.ARTIFACT_AVAILABLE
        c = orch.collect(
            _ctx(project), operation_id="op-4", observed_at=_t(12), artifact=ARTIFACT
        )
        assert c.kind is OutcomeKind.APPLIED
        assert c.provider_result.status is ProviderStatus.SUCCEEDED
        assert c.artifact_handoff.reference == ARTIFACT.reference
        assert c.record.stable_version == 4
        assert c.updated_task.status is GenerationTaskStatus.DONE

    def test_resume_empty_state(self, project) -> None:  # entry 116 (∅)
        a = ProviderOrchestrator(ManualVideoProvider()).resume(_ctx(project))
        assert a.phase is None
        assert a.legal_actions == (OrchestrationAction.PREPARE,)
        assert a.disposition is RecoveryDisposition.NONE
        assert a.is_terminal is False

    @pytest.mark.parametrize(
        "status,terminal",
        [
            (ProviderStatus.NOT_SUBMITTED, False),
            (ProviderStatus.WAITING_FOR_USER, False),
            (ProviderStatus.PROCESSING, False),
            (ProviderStatus.ARTIFACT_AVAILABLE, False),
            (ProviderStatus.SUCCEEDED, True),
            (ProviderStatus.FAILED, True),
            (ProviderStatus.CANCELLED, True),
        ],
    )
    def test_resume_stable_states(self, project, status, terminal) -> None:  # 116
        _seed_status(project, status)
        a = ProviderOrchestrator(ManualVideoProvider()).resume(_ctx(project))
        assert a.phase is RecordPhase.STABLE
        assert a.is_terminal is terminal
        assert a.disposition is RecoveryDisposition.NONE
        if terminal:
            assert a.legal_actions == ()

    def test_resume_applying_auto_repairs(self, project) -> None:  # 116 APPLYING
        _prepare(project)
        from ai_video_workflow.orchestration.planning import _OrchestrationPlanner

        obs = _FileOrchestrationExecutor(project).read_project_state("task-1")
        planner = _OrchestrationPlanner()
        submit_result = _result(
            ProviderStatus.WAITING_FOR_USER, observed_at=_t(11), external="ext-1"
        )
        plan = planner.plan(
            action=OrchestrationAction.SUBMIT,
            operation_id="op-s",
            request=REQUEST,
            task=obs.task,
            manifest=obs.manifest,
            stable=obs.record.stable,
            result=submit_result,
            observed_at=_t(11),
            task_before_fingerprint=obs.task_fingerprint,
            manifest_before_fingerprint=obs.manifest_fingerprint,
            instruction_before_fingerprint=obs.instruction_fingerprint,
            instruction_before_text=obs.instruction_text,
        )
        _FileOrchestrationExecutor(project).write_apply_intent(
            "task-1", obs.record.stable, plan
        )
        assert _record_json(project)["phase"] == "applying"
        # entry 116 APPLYING: the auto-repair mutates the record to STABLE and
        # is locked on the FULL field set + Provider=0 + durable mutation.
        spy = _RecordingProvider()
        a = ProviderOrchestrator(spy).resume(_ctx(project))
        assert spy.total == 0
        assert a.phase is RecordPhase.STABLE
        assert a.disposition is RecoveryDisposition.SAFE_AUTO_RETRY
        assert a.legal_actions == (
            OrchestrationAction.POLL,
            OrchestrationAction.REPORT_ARTIFACT,
            OrchestrationAction.COLLECT,
        )
        assert a.preferred_next_action is OrchestrationAction.POLL
        assert a.requires_manual_reconciliation is False
        assert a.is_terminal is False
        assert _record_json(project)["phase"] == "stable"  # durable mutation

        # repeated resume over the now-STABLE record: same fields, no further
        # durable mutation, zero Provider calls.
        after_repair = _state_dir_snapshot(project)
        repeat_spy = _RecordingProvider()
        b = ProviderOrchestrator(repeat_spy).resume(_ctx(project))
        assert repeat_spy.total == 0
        assert b.phase is RecordPhase.STABLE
        assert b.disposition is RecoveryDisposition.NONE
        assert b.legal_actions == (
            OrchestrationAction.POLL,
            OrchestrationAction.REPORT_ARTIFACT,
            OrchestrationAction.COLLECT,
        )
        assert b.preferred_next_action is OrchestrationAction.POLL
        assert b.requires_manual_reconciliation is False
        assert b.is_terminal is False
        assert _state_dir_snapshot(project) == after_repair

    def test_resume_intent_is_safe_auto_retry(self, project) -> None:  # 116 INTENT
        _prepare(project)
        ProviderOrchestrator(ManualVideoProvider()).submit(
            _ctx(project), operation_id="op-s", observed_at=_t(11)
        )
        from ai_video_workflow.orchestration._models import _PendingProviderCall
        from ai_video_workflow.orchestration.canonical import (
            _fingerprint,
            _make_snapshot_wrapper,
        )
        from ai_video_workflow.orchestration.recovery import _parse_stable_wrapper

        stable = _parse_stable_wrapper(_record_json(project)["stable"])
        req_wrap = _make_snapshot_wrapper("provider_request", REQUEST.to_json_dict())
        action_input = _make_snapshot_wrapper(
            "action_input",
            {
                "observed_at": _t(12).isoformat(timespec="microseconds"),
                "artifact": None,
                "completed_at": None,
                "result_fingerprint": None,
            },
        )
        pending = _PendingProviderCall(
            operation_id="op-c",
            action=OrchestrationAction.COLLECT,
            baseline_version=stable.version,
            request_snapshot=req_wrap,
            request_fingerprint=_fingerprint(req_wrap),
            action_input_snapshot=action_input,
            action_input_fingerprint=_fingerprint(action_input),
            original_observed_at=_t(12),
            original_completed_at=None,
            artifact_input=None,
            call_phase=RecordPhase.PROVIDER_CALL_INTENT,
            call_may_have_started=False,
            started_at=_t(12),
            recovery_policy=RecoveryDisposition.MANUAL_RECONCILIATION,
        )
        _FileOrchestrationExecutor(project).write_pending_call_intent(
            "task-1", stable, pending
        )
        a = ProviderOrchestrator(ManualVideoProvider()).resume(_ctx(project))
        assert a.phase is RecordPhase.PROVIDER_CALL_INTENT
        assert a.disposition is RecoveryDisposition.SAFE_AUTO_RETRY
        assert a.legal_actions == (OrchestrationAction.COLLECT,)

    @pytest.mark.parametrize(
        "phase",
        [
            RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
            RecordPhase.PROVIDER_RESULT_UNKNOWN,
        ],
    )
    def test_resume_may_started_and_result_unknown_manual(
        self, project, phase
    ) -> None:  # 116 MAY_HAVE_STARTED / RESULT_UNKNOWN
        _land_call_phase(project, phase)
        spy = _RecordingProvider()
        a = ProviderOrchestrator(spy).resume(_ctx(project))
        assert a.phase is phase
        assert a.disposition is RecoveryDisposition.MANUAL_RECONCILIATION
        assert a.requires_manual_reconciliation is True
        assert a.legal_actions == ()
        assert a.preferred_next_action is None
        assert spy.total == 0
        # no durable mutation; a repeated resume is identical
        before = _record_json(project)
        b = ProviderOrchestrator(_RecordingProvider()).resume(_ctx(project))
        assert b.disposition is RecoveryDisposition.MANUAL_RECONCILIATION
        assert _record_json(project) == before

    def test_resume_malformed_record_is_manual(self, project) -> None:  # 116 malformed
        (project / "records/orchestration").mkdir(parents=True)
        (project / "records/orchestration/task-1.json").write_bytes(b'{"bad":1}')
        a = ProviderOrchestrator(ManualVideoProvider()).resume(_ctx(project))
        assert a.requires_manual_reconciliation is True
        # §14 E1/S0 (schema-invalid / corrupt) is MANUAL_RECONCILIATION, not
        # CONFLICT (which is reserved for external drift P9/S1/R3)
        assert a.disposition is RecoveryDisposition.MANUAL_RECONCILIATION
        # a malformed record is a manual state, NOT the clean-∅ None (§6.2/§13.2)
        assert a.phase is RecordPhase.RECOVERY_REQUIRED

    def test_resume_recovery_required_two_phase_disposition(self, project) -> None:
        # an APPLYING record whose files drifted to a third state cannot be
        # re-driven (§14 P9): resume auto-repair fails, executor lands
        # RECOVERY_REQUIRED, and the assessment reports CONFLICT (not the
        # E1/S0 MANUAL_RECONCILIATION).
        _prepare(project)
        from ai_video_workflow.orchestration.planning import _OrchestrationPlanner

        obs = _FileOrchestrationExecutor(project).read_project_state("task-1")
        planner = _OrchestrationPlanner()
        submit_result = _result(
            ProviderStatus.WAITING_FOR_USER, observed_at=_t(11), external="ext-1"
        )
        plan = planner.plan(
            action=OrchestrationAction.SUBMIT,
            operation_id="op-s",
            request=REQUEST,
            task=obs.task,
            manifest=obs.manifest,
            stable=obs.record.stable,
            result=submit_result,
            observed_at=_t(11),
            task_before_fingerprint=obs.task_fingerprint,
            manifest_before_fingerprint=obs.manifest_fingerprint,
            instruction_before_fingerprint=obs.instruction_fingerprint,
            instruction_before_text=obs.instruction_text,
        )
        _FileOrchestrationExecutor(project).write_apply_intent(
            "task-1", obs.record.stable, plan
        )
        # drift the task file to a third state so the redrive is a P9 conflict
        _write_task(
            project,
            provider_id="manual",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=_t(20),
            external_task_ref="ghost",
        )
        # Phase 1: this resume DIRECTLY observes the P9 conflict during
        # auto-repair -> CONFLICT (the current-observation cause).
        a = ProviderOrchestrator(ManualVideoProvider()).resume(_ctx(project))
        assert a.phase is RecordPhase.RECOVERY_REQUIRED
        assert a.requires_manual_reconciliation is True
        assert a.disposition is RecoveryDisposition.CONFLICT
        # the conflict has been landed durably as RECOVERY_REQUIRED
        assert _record_json(project)["phase"] == "recovery_required"

        # Phase 2: a subsequent resume over the ALREADY-landed
        # RECOVERY_REQUIRED does NOT skip S1 (§1). The committed files are
        # still drifted (the "ghost" task was never restored), so S1 fails and
        # the assessment is CONFLICT — a current observation of drift, not a
        # re-derivation of the original §14 cause. Report-only: zero Provider
        # calls, zero durable mutation.
        record_bytes = (project / "records/orchestration/task-1.json").read_bytes()
        task_bytes = (project / "records/generation-tasks/task-1.json").read_bytes()
        manifest_bytes = (project / "manifests/generation-task-1.json").read_bytes()
        instr_bytes = (project / "tasks/instructions/task-1.md").read_bytes()
        spy = _RecordingProvider()
        b = ProviderOrchestrator(spy).resume(_ctx(project))
        assert b.phase is RecordPhase.RECOVERY_REQUIRED
        assert b.requires_manual_reconciliation is True
        assert b.disposition is RecoveryDisposition.CONFLICT
        assert spy.total == 0
        assert (
            project / "records/orchestration/task-1.json"
        ).read_bytes() == record_bytes
        assert (
            project / "records/generation-tasks/task-1.json"
        ).read_bytes() == task_bytes
        assert (
            project / "manifests/generation-task-1.json"
        ).read_bytes() == manifest_bytes
        assert (project / "tasks/instructions/task-1.md").read_bytes() == instr_bytes

    def test_resume_recovery_required_matching_committed_is_manual(
        self, project
    ) -> None:  # 116 RECOVERY_REQUIRED with clean committed files
        # A RECOVERY_REQUIRED landed from an unknown-side-effect provider call
        # (MAY_HAVE_STARTED) leaves the committed files intact. §1 still runs
        # S1 first; S1 passes, so the assessment is the uniform
        # MANUAL_RECONCILIATION. Zero Provider calls, zero mutation; a repeated
        # resume is identical.
        _land_call_phase(project, RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED)
        with pytest.raises(UnknownProviderSideEffectError):
            _FileOrchestrationExecutor(project).recover("task-1")
        assert _record_json(project)["phase"] == "recovery_required"
        before = _record_json(project)
        spy = _RecordingProvider()
        a = ProviderOrchestrator(spy).resume(_ctx(project))
        assert a.phase is RecordPhase.RECOVERY_REQUIRED
        assert a.disposition is RecoveryDisposition.MANUAL_RECONCILIATION
        assert a.requires_manual_reconciliation is True
        assert spy.total == 0
        assert _record_json(project) == before
        b = ProviderOrchestrator(_RecordingProvider()).resume(_ctx(project))
        assert b.disposition is RecoveryDisposition.MANUAL_RECONCILIATION
        assert _record_json(project) == before

    def test_resume_missing_record_with_trace_is_manual(self, project) -> None:  # 116
        _prepare(project)
        (project / "records/orchestration/task-1.json").unlink()
        a = ProviderOrchestrator(ManualVideoProvider()).resume(_ctx(project))
        # §13.5: record lost + traces -> RECOVERY_REQUIRED manual assessment,
        # never collapsed to the clean-∅ phase=None
        assert a.phase is RecordPhase.RECOVERY_REQUIRED
        assert a.requires_manual_reconciliation is True
        assert a.disposition is RecoveryDisposition.MANUAL_RECONCILIATION

    def test_resume_phase_none_only_for_clean_empty_state(self, project) -> None:
        # phase is None exclusively for the no-record no-trace ∅ initial state
        clean = ProviderOrchestrator(ManualVideoProvider()).resume(_ctx(project))
        assert clean.phase is None
        assert clean.requires_manual_reconciliation is False
        assert clean.disposition is RecoveryDisposition.NONE

    def test_resume_never_calls_provider(self, project) -> None:
        _seed_status(project, ProviderStatus.WAITING_FOR_USER)
        spy = _RecordingProvider()
        ProviderOrchestrator(spy).resume(_ctx(project))
        assert spy.total == 0


# ===========================================================================
# §22 116: exact resume assessment table for every formal state
# ===========================================================================

_A = OrchestrationAction
_RP = RecordPhase
_RD = RecoveryDisposition


def _setup_resume_state(project, name) -> None:
    if name == "empty":
        return
    stable_states = {
        "stable_not_submitted": ProviderStatus.NOT_SUBMITTED,
        "stable_waiting": ProviderStatus.WAITING_FOR_USER,
        "stable_processing": ProviderStatus.PROCESSING,
        "stable_artifact_available": ProviderStatus.ARTIFACT_AVAILABLE,
        "stable_succeeded": ProviderStatus.SUCCEEDED,
        "stable_failed": ProviderStatus.FAILED,
        "stable_cancelled": ProviderStatus.CANCELLED,
    }
    if name in stable_states:
        _seed_status(project, stable_states[name])
        return
    if name == "intent":
        _land_call_phase(project, _RP.PROVIDER_CALL_INTENT)
        return
    if name == "may_have_started":
        _land_call_phase(project, _RP.PROVIDER_CALL_MAY_HAVE_STARTED)
        return
    if name == "result_unknown":
        _land_call_phase(project, _RP.PROVIDER_RESULT_UNKNOWN)
        return
    if name == "recovery_required_matching":
        _land_call_phase(project, _RP.PROVIDER_CALL_MAY_HAVE_STARTED)
        with pytest.raises(UnknownProviderSideEffectError):
            _FileOrchestrationExecutor(project).recover("task-1")
        return
    if name == "malformed":
        _seed_status(project, ProviderStatus.WAITING_FOR_USER)
        (project / "records/orchestration/task-1.json").write_bytes(b'{"bad": 1}')
        return
    if name == "missing_with_trace":
        _prepare(project)
        (project / "records/orchestration/task-1.json").unlink()
        return
    raise AssertionError(name)


# name -> (phase, disposition, legal_actions, preferred, requires_manual, terminal)
_RESUME_TABLE = {
    "empty": (None, _RD.NONE, (_A.PREPARE,), _A.PREPARE, False, False),
    "stable_not_submitted": (
        _RP.STABLE,
        _RD.NONE,
        (_A.SUBMIT,),
        _A.SUBMIT,
        False,
        False,
    ),
    "stable_waiting": (
        _RP.STABLE,
        _RD.NONE,
        (_A.POLL, _A.REPORT_ARTIFACT, _A.COLLECT),
        _A.POLL,
        False,
        False,
    ),
    "stable_processing": (
        _RP.STABLE,
        _RD.NONE,
        (_A.POLL, _A.REPORT_ARTIFACT),
        _A.POLL,
        False,
        False,
    ),
    "stable_artifact_available": (
        _RP.STABLE,
        _RD.NONE,
        (_A.POLL, _A.REPORT_ARTIFACT, _A.COLLECT),
        _A.COLLECT,
        False,
        False,
    ),
    "stable_succeeded": (_RP.STABLE, _RD.NONE, (), None, False, True),
    "stable_failed": (_RP.STABLE, _RD.NONE, (), None, False, True),
    "stable_cancelled": (_RP.STABLE, _RD.NONE, (), None, False, True),
    "intent": (
        _RP.PROVIDER_CALL_INTENT,
        _RD.SAFE_AUTO_RETRY,
        (_A.COLLECT,),
        _A.COLLECT,
        False,
        False,
    ),
    "may_have_started": (
        _RP.PROVIDER_CALL_MAY_HAVE_STARTED,
        _RD.MANUAL_RECONCILIATION,
        (),
        None,
        True,
        False,
    ),
    "result_unknown": (
        _RP.PROVIDER_RESULT_UNKNOWN,
        _RD.MANUAL_RECONCILIATION,
        (),
        None,
        True,
        False,
    ),
    "recovery_required_matching": (
        _RP.RECOVERY_REQUIRED,
        _RD.MANUAL_RECONCILIATION,
        (),
        None,
        True,
        False,
    ),
    "malformed": (
        _RP.RECOVERY_REQUIRED,
        _RD.MANUAL_RECONCILIATION,
        (),
        None,
        True,
        False,
    ),
    "missing_with_trace": (
        _RP.RECOVERY_REQUIRED,
        _RD.MANUAL_RECONCILIATION,
        (),
        None,
        True,
        False,
    ),
}


class TestResumeExactTable:
    """§22 116: one exact assessment per formal resumable state.

    Every report-only state (every state except APPLYING, whose resume
    auto-repairs and is locked separately) is asserted through the public
    resume() on the full field set — phase, disposition, legal_actions,
    preferred_next_action, requires_manual_reconciliation, is_terminal —
    plus zero Provider calls, no durable mutation, and a byte-identical
    repeated resume. ResumeAssessment carries no message field; the CLI
    diagnostic is derived from exactly these fields.
    """

    @pytest.mark.parametrize("name", list(_RESUME_TABLE))
    def test_resume_state(self, project, name) -> None:
        _setup_resume_state(project, name)
        phase, disp, legal, preferred, manual, terminal = _RESUME_TABLE[name]
        before = _state_dir_snapshot(project)

        spy = _RecordingProvider()
        a = ProviderOrchestrator(spy).resume(_ctx(project))
        assert a.phase is phase
        assert a.disposition is disp
        assert a.legal_actions == legal
        assert a.preferred_next_action is preferred
        assert a.requires_manual_reconciliation is manual
        assert a.is_terminal is terminal
        assert spy.total == 0
        # report-only: zero durable mutation
        assert _state_dir_snapshot(project) == before
        # repeated resume is byte-identical in state and returns the same fields
        b = ProviderOrchestrator(_RecordingProvider()).resume(_ctx(project))
        assert (
            b.phase is phase
            and b.disposition is disp
            and b.legal_actions == legal
            and b.preferred_next_action is preferred
            and b.requires_manual_reconciliation is manual
            and b.is_terminal is terminal
        )
        assert _state_dir_snapshot(project) == before

    def test_resume_table_covers_every_formal_state(self) -> None:
        # empty (1) + 7 STABLE provider statuses (8) + INTENT (9) +
        # MAY_HAVE_STARTED (10) + RESULT_UNKNOWN (11) + RECOVERY_REQUIRED (12)
        # + malformed (13) + missing-with-trace (14) = 14 report-only rows.
        # APPLYING is locked separately in test_resume_applying_auto_repairs
        # (it mutates via auto-repair, so it is not a report-only row here).
        assert len(_RESUME_TABLE) == 14


# ===========================================================================
# §22 117/118: fixed asset boundary + static audit
# ===========================================================================


class TestFixedBoundaryAndAudit:
    def test_no_video_asset_ffmpeg_qcd(self) -> None:  # entry 117
        src = inspect.getsource(orchestrator_module)
        for banned in ("VideoAsset", "ffmpeg", "ffprobe", "QCD", "subprocess"):
            assert banned not in src

    def test_orchestrator_never_does_direct_filesystem_io(self) -> None:  # 118 audit
        src = inspect.getsource(orchestrator_module)
        for banned in (
            "open(",
            ".read_text",
            ".write_text",
            ".read_bytes",
            ".write_bytes",
            "os.replace",
            ".mkdir(",
            "glob(",
            "rglob",
            "iterdir",
            "listdir",
            "os.walk",
            "os.environ",
            "getenv",
            "getcwd",
            "Path.home",
            "uuid4",
            "random",
        ):
            assert banned not in src, banned

    def test_no_import_cycle_and_clean_package_import(self) -> None:
        import importlib

        importlib.import_module("ai_video_workflow.orchestration")
        importlib.import_module("ai_video_workflow.orchestration.orchestrator")

    def test_provider_boundary_no_direct_provider_types(self) -> None:
        # the module references VideoProvider only for the injected contract
        assert not hasattr(orchestrator_module, "ManualVideoProvider")


# ===========================================================================
# public model contracts + input isolation
# ===========================================================================


class TestModelContracts:
    def test_record_json_has_exactly_11_keys(self, project) -> None:
        out = _prepare(project)
        j = out.record.to_json_dict()
        assert len(j) == 11
        assert j["exists"] is True
        assert j["phase"] == "stable"
        assert j["stable_version"] == 1
        assert j["pending_operation_id"] is None
        # enums serialized as value
        assert j["last_completed_action"] == "prepare"

    def test_record_invariants_stable(self, project) -> None:
        out = _prepare(project)
        rec = out.record
        assert rec.exists is True and rec.phase is RecordPhase.STABLE
        assert rec.pending_operation_id is None
        assert rec.pending_action is None
        assert rec.pending_plan_id is None
        assert rec.provider_status is ProviderStatus.NOT_SUBMITTED

    def test_record_invariants_empty_state(self, project) -> None:
        rec = ProviderOrchestrator(ManualVideoProvider()).resume(_ctx(project))
        assert rec.phase is None
        # the ∅ OrchestrationRecord is exposed via the outcome path; verify via
        # a NO_OP-free empty resume already covered; check field defaults here
        empty = OrchestrationRecord(
            exists=False,
            phase=None,
            task_id="t",
            shot_id=None,
            provider_id=None,
            stable_version=None,
            last_completed_action=None,
            provider_status=None,
            pending_operation_id=None,
            pending_action=None,
            pending_plan_id=None,
        )
        assert empty.to_json_dict()["exists"] is False

    def test_context_input_is_not_mutated(self, project) -> None:
        ctx = _ctx(project)
        task_id_before = ctx.task.task_id
        ProviderOrchestrator(ManualVideoProvider()).prepare(
            ctx, operation_id="op-1", observed_at=_t(9)
        )
        assert ctx.task.task_id == task_id_before
        assert ctx.request.provider_id == "manual"

    def test_context_rejects_wrong_types(self, project) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            ProviderOrchestrator(ManualVideoProvider()).prepare(
                object(), operation_id="op-1", observed_at=_t(9)
            )

    def test_snapshot_vs_disk_mismatch_rejected(self, project) -> None:
        ctx = _ctx(project)
        _write_task(project, input_parameters_ref="drifted")
        with pytest.raises(InvalidOrchestrationInputError):
            ProviderOrchestrator(ManualVideoProvider()).prepare(
                ctx, operation_id="op-1", observed_at=_t(9)
            )

    def test_missing_task_file(self, project) -> None:
        ctx = _ctx(project)
        (project / "records/generation-tasks/task-1.json").unlink()
        with pytest.raises(MissingProjectStateError):
            ProviderOrchestrator(ManualVideoProvider()).prepare(
                ctx, operation_id="op-1", observed_at=_t(9)
            )

    def test_wrong_provider_identity_rejected(self, project) -> None:
        class _Other(ManualVideoProvider):
            @property
            def provider_id(self):
                return "other"

        with pytest.raises(InvalidOrchestrationInputError):
            ProviderOrchestrator(_Other()).prepare(
                _ctx(project), operation_id="op-1", observed_at=_t(9)
            )

    def test_constructor_rejects_non_provider(self) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            ProviderOrchestrator(object())


class TestStaleAndConflict:
    def test_stale_observation_rejected(self, project) -> None:
        _prepare(project)
        ProviderOrchestrator(ManualVideoProvider()).submit(
            _ctx(project), operation_id="op-s", observed_at=_t(11)
        )
        # replay an older observation -> StaleResultError
        from ai_video_workflow.orchestration import StaleResultError

        older = _result(
            ProviderStatus.WAITING_FOR_USER, observed_at=_t(10), external="e"
        )
        with pytest.raises(StaleResultError):
            ProviderOrchestrator(ManualVideoProvider()).replay_result(
                _ctx(project), older, operation_id="op-old"
            )


# ===========================================================================
# Blocker 1: full entry validation MUST precede any Provider call (§6.1/§7.1)
# ===========================================================================


class TestPreCallValidation:
    def test_wrong_task_provider_id_rejected_before_provider_call(
        self, project
    ) -> None:
        _seed_status(project, ProviderStatus.WAITING_FOR_USER)
        # the on-disk task provider_id no longer matches the request identity
        _write_task(
            project,
            provider_id="other-provider",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=_t(10),
            external_task_ref="ext-1",
        )
        spy = _RecordingProvider()
        with pytest.raises(InvalidOrchestrationInputError):
            ProviderOrchestrator(spy).poll(
                _ctx(project), operation_id="op-a", observed_at=_t(15)
            )
        assert spy.total == 0

    def test_instruction_bytes_drift_is_s1_conflict_before_call(self, project) -> None:
        # §1: the S1 committed-state verifier runs BEFORE the instruction
        # carry-over check, so an externally drifted instruction file is a
        # PartialCommitConflictError (not an InvalidOrchestrationInputError),
        # with zero Provider calls and no WAL write.
        _seed_status(project, ProviderStatus.WAITING_FOR_USER)
        (project / "tasks/instructions/task-1.md").write_bytes(
            b"# externally replaced instruction\n"
        )
        spy = _RecordingProvider()
        with pytest.raises(PartialCommitConflictError):
            ProviderOrchestrator(spy).collect(
                _ctx(project),
                operation_id="op-a",
                observed_at=_t(15),
                artifact=ARTIFACT,
            )
        assert spy.total == 0
        assert _record_json(project)["phase"] == "stable"

    def test_invalid_context_reaches_provider_zero_times_for_intent_path(
        self, project
    ) -> None:
        # a submit (pre-call WAL/intent path) on an identity-mismatched context
        # must reject before landing any intent or calling the Provider
        _prepare(project)  # state = not_submitted (submit is a call cell)
        _write_task(project, provider_id="wrong", status=GenerationTaskStatus.PENDING)
        spy = _RecordingProvider()
        with pytest.raises(InvalidOrchestrationInputError):
            ProviderOrchestrator(spy).submit(
                _ctx(project), operation_id="op-a", observed_at=_t(11)
            )
        assert spy.total == 0
        # no INTENT was landed either
        assert _record_json(project)["phase"] == "stable"

    def test_external_manifest_completion_is_committed_state_conflict(
        self, project
    ) -> None:
        # An external/subsequent asset task marking the generation manifest
        # COMPLETED while the orchestration stable is still (e.g.)
        # artifact_available drifts a committed file. Because §1 runs the
        # single §13.2 S1 committed-state verifier before any Provider call or
        # WAL write, this surfaces as an S1 committed-state CONFLICT
        # (PartialCommitConflictError) rather than the generic terminal-manifest
        # guard — a more precise classification of external drift — and still
        # guarantees zero Provider calls and no WAL.
        _seed_status(project, ProviderStatus.ARTIFACT_AVAILABLE)
        write_model_json(
            project / "manifests/generation-task-1.json",
            StepManifest(
                step_name="generation:task-1",
                input_digest="digest-1",
                relevant_config_digest="config-1",
                status=ManifestStatus.COMPLETED,
                created_at=T0,
                output_paths=("outputs/task-1.mp4",),
                completed_at=_t(10),
            ),
            overwrite=True,
        )
        spy = _RecordingProvider()
        with pytest.raises(PartialCommitConflictError):
            ProviderOrchestrator(spy).collect(
                _ctx(project),
                operation_id="op-a",
                observed_at=_t(15),
                artifact=ARTIFACT,
            )
        assert spy.total == 0
        # no INTENT/WAL was landed either; the record phase is untouched
        assert _record_json(project)["phase"] == "stable"

    def test_terminal_manifest_guard_rejects_non_pending_update(self, project) -> None:
        # §17.5 defense-in-depth: even if the S1 committed-state check were
        # bypassed, a Provider-calling apply must never update a terminal
        # manifest. The guard is now unreachable through the facade (S1 fires
        # first on any committed drift), so it is exercised directly on a
        # terminal-manifest observation.
        import dataclasses

        from ai_video_workflow.orchestration.orchestrator import (
            _require_updatable_manifest,
        )

        _seed_status(project, ProviderStatus.ARTIFACT_AVAILABLE)
        executor = _FileOrchestrationExecutor(project)
        observation = executor.read_project_state("task-1")
        # a genuinely non-PENDING (terminal) manifest observation is rejected
        terminal = StepManifest(
            step_name="generation:task-1",
            input_digest="digest-1",
            relevant_config_digest="config-1",
            status=ManifestStatus.FAILED,
            created_at=T0,
            output_paths=("outputs/task-1.mp4",),
            completed_at=_t(10),
            error_summary="external failure",
        )
        terminal_observation = dataclasses.replace(observation, manifest=terminal)
        with pytest.raises(InvalidOrchestrationStateError):
            _require_updatable_manifest(terminal_observation)
        # a PENDING manifest observation passes the guard (returns None)
        assert _require_updatable_manifest(observation) is None


# ===========================================================================
# Blocker 2: resume validates context/request/identity and STABLE S1
# ===========================================================================


class TestResumeValidation:
    def test_resume_stale_context_rejected(self, project) -> None:
        _seed_status(project, ProviderStatus.WAITING_FOR_USER)
        stale_context = _ctx(project)  # snapshot BEFORE the disk drift
        # the on-disk task drifts after the context snapshot was captured
        _write_task(
            project,
            provider_id="manual",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=_t(20),
            external_task_ref="ext-1",
            current_artifact_ref="staging/task-1/late.mp4",
        )
        with pytest.raises(InvalidOrchestrationInputError):
            ProviderOrchestrator(ManualVideoProvider()).resume(stale_context)

    def test_resume_committed_file_drift_is_conflict(self, project) -> None:
        _seed_status(project, ProviderStatus.WAITING_FOR_USER)
        # drift the committed task file (context == disk, identity preserved),
        # so §14 S1 applies: a CONFLICT manual assessment, phase stays STABLE
        _write_task(
            project,
            provider_id="manual",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=_t(20),
            external_task_ref="ext-1",
            input_parameters_ref="drifted",
        )
        a = ProviderOrchestrator(ManualVideoProvider()).resume(_ctx(project))
        assert a.phase is RecordPhase.STABLE
        assert a.requires_manual_reconciliation is True
        assert a.disposition is RecoveryDisposition.CONFLICT
        assert a.legal_actions == ()

    def test_resume_request_drift_rejected(self, project) -> None:
        _seed_status(project, ProviderStatus.WAITING_FOR_USER)
        drifted_request = ProviderRequest(
            provider_id="manual",
            task_id="task-1",
            shot_id="shot-1",
            prompt="a different prompt",
            duration_seconds=4.0,
            width=1280,
            height=720,
            frame_rate=24.0,
            staging_ref="staging/task-1",
            provider_parameters={"style": "anime"},
        )
        base = _ctx(project)
        context = OrchestrationContext(
            project_root=base.project_root,
            request=drifted_request,
            task=base.task,
            manifest=base.manifest,
        )
        from ai_video_workflow.orchestration import ConflictingRequestError

        with pytest.raises(ConflictingRequestError):
            ProviderOrchestrator(ManualVideoProvider()).resume(context)

    def test_resume_clean_stable_still_none_disposition(self, project) -> None:
        # a clean STABLE (no drift) still returns a normal NONE assessment
        _seed_status(project, ProviderStatus.WAITING_FOR_USER)
        a = ProviderOrchestrator(ManualVideoProvider()).resume(_ctx(project))
        assert a.phase is RecordPhase.STABLE
        assert a.disposition is RecoveryDisposition.NONE
        assert a.requires_manual_reconciliation is False

    @pytest.mark.parametrize(
        "phase",
        [
            RecordPhase.PROVIDER_CALL_INTENT,
            RecordPhase.PROVIDER_CALL_MAY_HAVE_STARTED,
            RecordPhase.PROVIDER_RESULT_UNKNOWN,
        ],
    )
    def test_resume_stable_bearing_call_phase_drift_is_conflict(
        self, project, phase
    ) -> None:
        # A stable-bearing provider-call phase (INTENT / MAY_HAVE_STARTED /
        # RESULT_UNKNOWN) does not bypass §14 S1: an externally drifted
        # committed file is a CONFLICT (report only), taking precedence over
        # the clean-phase SAFE_AUTO_RETRY (INTENT) / MANUAL (MAY/UNKNOWN)
        # disposition. The Provider is never called and the record phase is
        # preserved (no durable mutation).
        _land_call_phase(project, phase)
        _write_task(
            project,
            provider_id="manual",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=_t(20),
            external_task_ref="ext-1",
            input_parameters_ref="drifted",
        )
        spy = _RecordingProvider()
        a = ProviderOrchestrator(spy).resume(_ctx(project))
        assert a.phase is phase
        assert a.disposition is RecoveryDisposition.CONFLICT
        assert a.requires_manual_reconciliation is True
        assert a.legal_actions == ()
        assert spy.total == 0
        assert _record_json(project)["phase"] == phase.value

    def test_resume_stale_context_priority_over_malformed_record(self, project) -> None:
        # ordering: the caller snapshot-vs-disk staleness check runs BEFORE the
        # strict record parse, so a stale context is rejected (raise) with
        # priority over a malformed record being reported as a manual state.
        _seed_status(project, ProviderStatus.WAITING_FOR_USER)
        stale_context = _ctx(project)  # snapshot before both drifts
        (project / "records/orchestration/task-1.json").write_bytes(b'{"bad": 1}')
        _write_task(
            project,
            provider_id="manual",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=_t(20),
            external_task_ref="ext-1",
            input_parameters_ref="late",
        )
        with pytest.raises(InvalidOrchestrationInputError):
            ProviderOrchestrator(ManualVideoProvider()).resume(stale_context)

    def test_resume_current_context_malformed_record_is_manual(self, project) -> None:
        # a current (non-stale) context over a malformed record is a manual
        # RECOVERY_REQUIRED assessment, not a raise; zero Provider calls.
        _seed_status(project, ProviderStatus.WAITING_FOR_USER)
        (project / "records/orchestration/task-1.json").write_bytes(b'{"bad": 1}')
        spy = _RecordingProvider()
        a = ProviderOrchestrator(spy).resume(_ctx(project))
        assert a.phase is RecordPhase.RECOVERY_REQUIRED
        assert a.disposition is RecoveryDisposition.MANUAL_RECONCILIATION
        assert a.requires_manual_reconciliation is True
        assert spy.total == 0

    def test_resume_transient_io_error_propagates(self, project, monkeypatch) -> None:
        # an ordinary filesystem read failure propagates as a
        # PersistenceExecutionError; it is never reclassified as a CONFLICT or
        # a MANUAL_RECONCILIATION assessment.
        _seed_status(project, ProviderStatus.WAITING_FOR_USER)

        def _boom(self, path, name, *, required):
            raise PersistenceExecutionError("disk read failure")

        monkeypatch.setattr(_FileOrchestrationExecutor, "_read_state_file", _boom)
        with pytest.raises(PersistenceExecutionError):
            ProviderOrchestrator(ManualVideoProvider()).resume(_ctx(project))


# ===========================================================================
# §1: single executor-owned committed-state S1 verifier on all action paths
# ===========================================================================


class TestCommittedStateS1Centralization:
    def test_committed_state_verifier_is_single_and_executor_owned(self) -> None:
        # the orchestrator no longer maintains a duplicate three-fingerprint
        # committed-state comparison; the single verifier lives on the executor
        assert not hasattr(ProviderOrchestrator, "_committed_state_matches")
        assert hasattr(_FileOrchestrationExecutor, "verify_committed_state")
        assert hasattr(_FileOrchestrationExecutor, "committed_state_matches")
        src = inspect.getsource(orchestrator_module)
        assert "_snapshot_file_fingerprint" not in src

    def test_direct_poll_committed_task_drift_rejected_before_provider(
        self, project
    ) -> None:
        # a direct-path poll on a WAITING_FOR_USER baseline: an externally
        # drifted committed task (context == disk, identity preserved) is
        # rejected by S1 BEFORE the Provider call, with zero Provider calls and
        # no durable write.
        _seed_status(project, ProviderStatus.WAITING_FOR_USER)
        _write_task(
            project,
            provider_id="manual",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=_t(20),
            external_task_ref="ext-1",
            input_parameters_ref="drifted",
        )
        spy = _RecordingProvider()
        with pytest.raises(PartialCommitConflictError):
            ProviderOrchestrator(spy).poll(
                _ctx(project), operation_id="op-a", observed_at=_t(21)
            )
        assert spy.total == 0
        assert _record_json(project)["phase"] == "stable"

    def test_direct_report_artifact_committed_manifest_drift_rejected(
        self, project
    ) -> None:
        # a direct-path report_artifact: an externally drifted committed
        # manifest is rejected by S1 before the Provider call.
        _seed_status(project, ProviderStatus.WAITING_FOR_USER)
        _write_manifest(project, output_metadata={"externally": "drifted"})
        spy = _RecordingProvider()
        with pytest.raises(PartialCommitConflictError):
            ProviderOrchestrator(spy).report_artifact(
                _ctx(project),
                operation_id="op-a",
                artifact=ARTIFACT,
                observed_at=_t(21),
            )
        assert spy.total == 0
        assert _record_json(project)["phase"] == "stable"

    def test_intent_redrive_committed_drift_rejected_before_provider(
        self, project
    ) -> None:
        # §1 INTENT same-identity redrive: after a durable INTENT is landed, a
        # same-identity redrive must run S1 before the redriven Provider call;
        # an externally drifted committed task is rejected with zero Provider
        # calls and no WAL advance.
        _land_call_phase(project, RecordPhase.PROVIDER_CALL_INTENT)  # collect op-call
        _write_task(
            project,
            provider_id="manual",
            status=GenerationTaskStatus.IN_PROGRESS,
            updated_at=_t(20),
            external_task_ref="ext-1",
            input_parameters_ref="drifted",
        )
        clip = ArtifactReference(
            reference="staging/task-1/clip.mp4",
            origin=ArtifactOrigin.USER,
            location=ArtifactLocation.STAGING,
        )
        spy = _RecordingProvider()
        with pytest.raises(PartialCommitConflictError):
            ProviderOrchestrator(spy).collect(
                _ctx(project),
                operation_id="op-call",
                observed_at=_t(12),
                artifact=clip,
            )
        assert spy.total == 0
        assert _record_json(project)["phase"] == "provider_call_intent"


# ===========================================================================
# §17.2 REPAIR⑥: repair-then-revalidate (approved semantics)
# ===========================================================================


class TestApplyingRepairRetry:
    def test_repair_completes_locally_stale_caller_retries_with_fresh_context(
        self, project
    ) -> None:
        # Phase 1: an action on an APPLYING record performs the local recovery
        # (record advances to STABLE), then re-runs full admission with the
        # ORIGINAL caller context. Because the recovery fast-forwarded the
        # business state, that context is now stale (§9) -> the action is
        # rejected; the Provider is never called and no new call/apply intent
        # is landed. The completed local recovery is NOT rolled back.
        _land_applying(project)  # durable APPLYING (submit apply, uncommitted)
        stale_context = _ctx(project)  # snapshot while the task is not_submitted
        assert _record_json(project)["phase"] == "applying"

        spy = _RecordingProvider()
        with pytest.raises(InvalidOrchestrationInputError):
            ProviderOrchestrator(spy).poll(
                stale_context, operation_id="op-a", observed_at=_t(15)
            )
        assert spy.total == 0
        record = _record_json(project)
        assert record["phase"] == "stable"  # local recovery preserved
        assert record["pending"] is None
        version_after_repair = record["stable"]["payload"]["version"]

        # Phase 2: the caller re-reads task/manifest, builds a FRESH context,
        # and retries the same business action. It now proceeds normally
        # against the new STABLE (no second APPLYING recovery, no loop). The
        # orchestrator never silently rebuilt the context itself.
        fresh_context = _ctx(project)
        out = ProviderOrchestrator(ManualVideoProvider()).poll(
            fresh_context, operation_id="op-a2", observed_at=_t(16)
        )
        assert out.kind is OutcomeKind.APPLIED
        after = _record_json(project)
        assert after["phase"] == "stable"
        assert after["stable"]["payload"]["version"] == version_after_repair + 1

    def test_repair_continues_when_only_record_changed(self, project) -> None:
        # §9/§17.2 clause 8: when the local recovery changes only the durable
        # record (the business task/manifest were already at their after
        # state, e.g. a partially-applied APPLYING) and the caller context
        # still matches disk, the action continues in the same call against
        # the new STABLE.
        from ai_video_workflow.orchestration.planning import _OrchestrationPlanner
        from ai_video_workflow.orchestration.recovery import (
            _restore_generation_task,
            _restore_step_manifest,
        )

        _prepare(project)
        obs = _FileOrchestrationExecutor(project).read_project_state("task-1")
        plan = _OrchestrationPlanner().plan(
            action=OrchestrationAction.SUBMIT,
            operation_id="op-s",
            request=REQUEST,
            task=obs.task,
            manifest=obs.manifest,
            stable=obs.record.stable,
            result=_result(ProviderStatus.WAITING_FOR_USER, observed_at=_t(11)),
            observed_at=_t(11),
            task_before_fingerprint=obs.task_fingerprint,
            manifest_before_fingerprint=obs.manifest_fingerprint,
            instruction_before_fingerprint=obs.instruction_fingerprint,
            instruction_before_text=obs.instruction_text,
        )
        executor = _FileOrchestrationExecutor(project)
        executor.write_apply_intent("task-1", obs.record.stable, plan)
        # pre-apply the after task/manifest so recovery only needs to commit
        # the STABLE record (business files already at the after state)
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
        assert _record_json(project)["phase"] == "applying"
        # the caller context reflects the after (waiting) business state
        fresh_context = _ctx(project)
        out = ProviderOrchestrator(ManualVideoProvider()).poll(
            fresh_context, operation_id="op-p", observed_at=_t(15)
        )
        # repair committed the STABLE (submit, v2) then the poll proceeded
        assert out.kind is OutcomeKind.APPLIED
        assert _record_json(project)["phase"] == "stable"
        assert _record_json(project)["stable"]["payload"]["version"] == 3

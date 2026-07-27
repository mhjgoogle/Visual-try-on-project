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
    ProviderOrchestrator,
    RecordPhase,
    RecoveryDisposition,
    ResumeAssessment,
    StaleResultError,
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
    return json.loads((root / "records/orchestration/task-1.json").read_text())


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

    def test_direct_path_to_applying(self, project) -> None:  # entry 62
        out = _prepare(project)
        assert out.kind is OutcomeKind.APPLIED
        assert _record_json(project)["phase"] == "stable"

    def test_direct_path_crash_is_safe_to_retry(self, project) -> None:  # entry 63
        spy = _RecordingProvider()
        spy.raises["prepare"] = ProviderOperationError("transient")
        orch = ProviderOrchestrator(spy)
        with pytest.raises(ProviderOperationError):
            orch.prepare(_ctx(project), operation_id="op-1", observed_at=_t(9))
        # no record was created; a clean retry succeeds
        assert not (project / "records/orchestration/task-1.json").exists()
        ok = ProviderOrchestrator(ManualVideoProvider()).prepare(
            _ctx(project), operation_id="op-1", observed_at=_t(9)
        )
        assert ok.kind is OutcomeKind.APPLIED


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


class TestAdmissionMatrix:
    """§22 87: full §17.2 admission matrix, 13 states x 7 actions = 91."""

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

        if category == "call":
            # routing reaches the provider (direct path raises _ReachedProvider;
            # the intent path converts it to UnknownProviderSideEffectError)
            with pytest.raises((_ReachedProvider, UnknownProviderSideEffectError)):
                _matrix_invoke(orch, root, action)
            assert len(tripwire.calls) == 1
        elif category == "e_state":
            with pytest.raises(InvalidOrchestrationStateError):
                _matrix_invoke(orch, root, action)
            assert len(tripwire.calls) == 0
        elif category == "noop":
            out = _matrix_invoke(orch, root, action)
            assert out.kind is OutcomeKind.NO_OP
            assert len(tripwire.calls) == 0
        elif category == "replay":
            # replay never calls the Provider; on a terminal state a
            # non-matching replay is a ConflictingProviderResultError (§17.2④),
            # on a non-terminal state it applies. Either way: zero calls.
            try:
                _matrix_invoke(orch, root, action)
            except (
                ConflictingProviderResultError,
                StaleResultError,
            ):
                pass
            assert len(tripwire.calls) == 0
        elif category == "e_unknown":
            with pytest.raises(UnknownProviderSideEffectError):
                _matrix_invoke(orch, root, action)
            assert len(tripwire.calls) == 0
        elif category == "idem_conflict":
            with pytest.raises(IdempotencyConflictError):
                _matrix_invoke(orch, root, action)
            assert len(tripwire.calls) == 0
        elif category == "repair_stale":
            # an action on APPLYING first auto-repairs to STABLE, then rejects
            # the now-stale caller context (§17.2 REPAIR + §9); the provider is
            # never called and the durable record has advanced to STABLE.
            with pytest.raises(InvalidOrchestrationInputError):
                _matrix_invoke(orch, root, action)
            assert len(tripwire.calls) == 0
            assert _record_json(root)["phase"] == "stable"
        elif category == "e_recovery":
            with pytest.raises(
                (PartialCommitConflictError, InvalidOrchestrationStateError)
            ):
                _matrix_invoke(orch, root, action)
            assert len(tripwire.calls) == 0
        else:  # assessment (resume over every one of the 13 states)
            a = _matrix_invoke(orch, root, action)
            assert isinstance(a, ResumeAssessment)
            assert len(tripwire.calls) == 0

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
        a = ProviderOrchestrator(ManualVideoProvider()).resume(_ctx(project))
        assert a.phase is RecordPhase.STABLE
        assert a.disposition is RecoveryDisposition.SAFE_AUTO_RETRY
        assert _record_json(project)["phase"] == "stable"

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
        # RECOVERY_REQUIRED reports the uniform MANUAL_RECONCILIATION — the
        # original §14 cause is not persisted and is not re-derived
        # (design-authority decision B). Zero Provider calls, zero mutation.
        record_bytes = (project / "records/orchestration/task-1.json").read_bytes()
        task_bytes = (project / "records/generation-tasks/task-1.json").read_bytes()
        manifest_bytes = (project / "manifests/generation-task-1.json").read_bytes()
        instr_bytes = (project / "tasks/instructions/task-1.md").read_bytes()
        spy = _RecordingProvider()
        b = ProviderOrchestrator(spy).resume(_ctx(project))
        assert b.phase is RecordPhase.RECOVERY_REQUIRED
        assert b.requires_manual_reconciliation is True
        assert b.disposition is RecoveryDisposition.MANUAL_RECONCILIATION
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

    def test_instruction_carry_over_drift_rejected_before_call(self, project) -> None:
        _seed_status(project, ProviderStatus.WAITING_FOR_USER)
        # the committed instruction file drifted externally
        (project / "tasks/instructions/task-1.md").write_bytes(
            b"# externally replaced instruction\n"
        )
        spy = _RecordingProvider()
        with pytest.raises(InvalidOrchestrationInputError):
            ProviderOrchestrator(spy).collect(
                _ctx(project),
                operation_id="op-a",
                observed_at=_t(15),
                artifact=ARTIFACT,
            )
        assert spy.total == 0

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

    def test_terminal_manifest_rejected_before_provider_call(self, project) -> None:
        # §17.5: a terminal manifest cannot be updated. Reachable when an
        # external/subsequent asset task marks the manifest COMPLETED while
        # the orchestration stable is still (e.g.) artifact_available. The
        # collect call cell must reject BEFORE the Provider is invoked.
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
        with pytest.raises(InvalidOrchestrationStateError):
            ProviderOrchestrator(spy).collect(
                _ctx(project),
                operation_id="op-a",
                observed_at=_t(15),
                artifact=ARTIFACT,
            )
        assert spy.total == 0
        # no INTENT/WAL was landed either
        assert _record_json(project)["phase"] == "stable"


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

"""Tests for the validation policy, rule engine, and report rendering."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.assets.policy import (
    M1_VALIDATION_CONFIG_SCHEMA,
    ValidationPolicy,
    policy_digest,
)
from ai_video_workflow.assets.reports import (
    report_json_bytes,
    report_markdown_bytes,
    report_to_json_dict,
)
from ai_video_workflow.assets.validation import (
    ValidationCheckStatus,
    ValidationCheckType,
    staged_relative_path,
    validate_artifact,
)
from ai_video_workflow.errors import InvariantViolationError
from ai_video_workflow.inspection.base import MediaProbeResult
from ai_video_workflow.inspection.errors import UndecodableMediaError
from ai_video_workflow.models import GenerationTask, GenerationTaskStatus, Shot
from ai_video_workflow.providers.models import (
    ArtifactLocation,
    ArtifactOrigin,
    ArtifactReference,
)
from tests.media_fakes import FakeMediaInspector
from tests.symlink_support import symlink_or_skip

T0 = datetime(2026, 7, 29, 8, 0, 0, tzinfo=timezone.utc)


def _shot(**overrides) -> Shot:
    base = dict(
        shot_id="shot-1",
        scene_id="scene-1",
        sequence=3,
        description="a cat",
        prompt="a cat playing",
        duration_seconds=4.0,
        width=1280,
        height=720,
        frame_rate=24.0,
        created_at=T0,
    )
    base.update(overrides)
    return Shot(**base)


def _task(task_id: str = "task-shot-1-1") -> GenerationTask:
    return GenerationTask(
        task_id=task_id,
        shot_id="shot-1",
        status=GenerationTaskStatus.PENDING,
        created_at=T0,
        updated_at=T0,
    )


def _artifact(reference: str) -> ArtifactReference:
    return ArtifactReference(
        reference=reference,
        origin=ArtifactOrigin.USER,
        location=ArtifactLocation.STAGING,
    )


def _good_probe() -> MediaProbeResult:
    return MediaProbeResult("mov,mp4,m4a", 4.0, 1280, 720, 24.0)


def _stage(project: Path, task: GenerationTask, data: bytes = b"media-bytes") -> str:
    rel = staged_relative_path(task)
    path = project / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return rel


def _run(project, *, probe=None, error=None, policy=None, task=None, shot=None):
    task = task or _task()
    shot = shot or _shot()
    rel = staged_relative_path(task)
    inspector = FakeMediaInspector(result=probe, error=error)
    return validate_artifact(
        project_root=project,
        shot=shot,
        task=task,
        artifact=_artifact(rel),
        inspector=inspector,
        policy=policy or ValidationPolicy(),
        observed_at=T0,
    )


def _status(report, check_type):
    return next(c for c in report.checks if c.check_type is check_type).status


# --- policy ---------------------------------------------------------------


def test_policy_digest_stable_and_schema_owned() -> None:
    p = ValidationPolicy()
    assert policy_digest(p) == policy_digest(ValidationPolicy())
    assert p.to_config_value()["schema"] == M1_VALIDATION_CONFIG_SCHEMA


def test_policy_digest_changes_with_tolerance() -> None:
    assert policy_digest(ValidationPolicy()) != policy_digest(
        ValidationPolicy(duration_tolerance_ratio=0.2)
    )


def test_policy_rejects_empty_containers() -> None:
    with pytest.raises(InvariantViolationError):
        ValidationPolicy(allowed_containers=())


# --- happy path -----------------------------------------------------------


def test_all_checks_pass(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    report = _run(tmp_path, probe=_good_probe(), task=task)
    assert report.passed is True
    assert len(report.checks) == len(ValidationCheckType)
    assert all(c.status is ValidationCheckStatus.PASSED for c in report.checks)
    assert report.probe == _good_probe()


# --- per-rule failures (short-circuit -> SKIPPED thereafter) --------------


def test_missing_file_fails_first_check(tmp_path) -> None:
    report = _run(tmp_path, probe=_good_probe())  # nothing staged
    assert report.passed is False
    assert _status(report, ValidationCheckType.FILE_EXISTS) is (
        ValidationCheckStatus.FAILED
    )
    assert _status(report, ValidationCheckType.PATH_ALLOWED) is (
        ValidationCheckStatus.SKIPPED
    )


def test_wrong_naming_fails_path_allowed(tmp_path) -> None:
    task = _task()
    # stage at a non-contract path and point the artifact at it
    wrong = tmp_path / "staging" / "shots" / "other.mp4"
    wrong.parent.mkdir(parents=True, exist_ok=True)
    wrong.write_bytes(b"x")
    inspector = FakeMediaInspector(result=_good_probe())
    report = validate_artifact(
        project_root=tmp_path,
        shot=_shot(),
        task=task,
        artifact=_artifact("staging/shots/other.mp4"),
        inspector=inspector,
        policy=ValidationPolicy(),
        observed_at=T0,
    )
    assert report.passed is False
    assert _status(report, ValidationCheckType.FILE_EXISTS) is (
        ValidationCheckStatus.PASSED
    )
    assert _status(report, ValidationCheckType.PATH_ALLOWED) is (
        ValidationCheckStatus.FAILED
    )
    assert inspector.calls == []  # probe never reached


def test_empty_file_fails_non_empty(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task, data=b"")
    report = _run(tmp_path, probe=_good_probe(), task=task)
    assert _status(report, ValidationCheckType.FILE_NON_EMPTY) is (
        ValidationCheckStatus.FAILED
    )
    assert _status(report, ValidationCheckType.SHA256_COMPUTED) is (
        ValidationCheckStatus.SKIPPED
    )


def test_undecodable_fails_metadata(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    report = _run(tmp_path, error=UndecodableMediaError("bad"), task=task)
    assert _status(report, ValidationCheckType.METADATA_PARSED) is (
        ValidationCheckStatus.FAILED
    )
    assert _status(report, ValidationCheckType.CONTAINER_ACCEPTED) is (
        ValidationCheckStatus.SKIPPED
    )


def test_container_mismatch(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    probe = MediaProbeResult("avi", 4.0, 1280, 720, 24.0)
    report = _run(tmp_path, probe=probe, task=task)
    assert _status(report, ValidationCheckType.CONTAINER_ACCEPTED) is (
        ValidationCheckStatus.FAILED
    )


def test_duration_out_of_tolerance(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    probe = MediaProbeResult("mp4", 6.0, 1280, 720, 24.0)  # 4.0 +/- 10%
    report = _run(tmp_path, probe=probe, task=task)
    assert _status(report, ValidationCheckType.DURATION_WITHIN_TOLERANCE) is (
        ValidationCheckStatus.FAILED
    )


def test_duration_within_tolerance_passes(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    probe = MediaProbeResult("mp4", 4.3, 1280, 720, 24.0)  # within 4.0 * 1.1
    report = _run(tmp_path, probe=probe, task=task)
    assert _status(report, ValidationCheckType.DURATION_WITHIN_TOLERANCE) is (
        ValidationCheckStatus.PASSED
    )


def test_resolution_mismatch(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    probe = MediaProbeResult("mp4", 4.0, 1920, 1080, 24.0)
    report = _run(tmp_path, probe=probe, task=task)
    assert _status(report, ValidationCheckType.RESOLUTION_MATCHES) is (
        ValidationCheckStatus.FAILED
    )


def test_frame_rate_out_of_tolerance(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    probe = MediaProbeResult("mp4", 4.0, 1280, 720, 30.0)  # 24 +/- 0.5
    report = _run(tmp_path, probe=probe, task=task)
    assert _status(report, ValidationCheckType.FRAME_RATE_WITHIN_TOLERANCE) is (
        ValidationCheckStatus.FAILED
    )


def test_error_code_equals_check_type_value(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    probe = MediaProbeResult("avi", 4.0, 1280, 720, 24.0)
    report = _run(tmp_path, probe=probe, task=task)
    failed = next(
        c
        for c in report.checks
        if c.check_type is ValidationCheckType.CONTAINER_ACCEPTED
    )
    assert failed.error_code == "container_accepted"


# --- report rendering -----------------------------------------------------


def test_report_json_is_deterministic(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    report = _run(tmp_path, probe=_good_probe(), task=task)
    assert report_json_bytes(report) == report_json_bytes(report)
    data = report_to_json_dict(report)
    assert data["report_schema_version"] == 1
    assert len(data["checks"]) == len(ValidationCheckType)


def test_report_markdown_is_deterministic(tmp_path) -> None:
    task = _task()
    _stage(tmp_path, task)
    report = _run(tmp_path, probe=_good_probe(), task=task)
    assert report_markdown_bytes(report) == report_markdown_bytes(report)
    assert report_markdown_bytes(report).startswith(b"# Validation Report")


def test_symlink_escape_fails_path_allowed(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    task = _task()
    outside = tmp_path / "outside.mp4"  # OUTSIDE the project root
    outside.write_bytes(b"secret")
    staged = project / staged_relative_path(task)
    staged.parent.mkdir(parents=True, exist_ok=True)
    symlink_or_skip(staged, outside)
    report = _run(project, probe=_good_probe(), task=task)
    assert _status(report, ValidationCheckType.PATH_ALLOWED) is (
        ValidationCheckStatus.FAILED
    )

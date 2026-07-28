"""File-level validation rule engine (TASK-005).

``validate_artifact`` runs a fixed, ordered sequence of typed checks
against a staged media file, using only the ``MediaInspector``
abstraction for metadata. The report lists every check in the declared
``ValidationCheckType`` order; once one check FAILS the remaining checks
are SKIPPED, and the report passes iff every check PASSED. Business
decisions depend only on ``check_type`` / ``status`` / ``error_code`` —
never on the human-readable ``message``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path

from ai_video_workflow.assets.policy import ValidationPolicy, policy_digest
from ai_video_workflow.digests import file_sha256
from ai_video_workflow.errors import FieldTypeError
from ai_video_workflow.inspection.base import MediaInspector, MediaProbeResult
from ai_video_workflow.inspection.errors import MediaInspectionError
from ai_video_workflow.models import GenerationTask, Shot
from ai_video_workflow.providers.models import ArtifactReference
from ai_video_workflow.validation import validate_utc_datetime

REPORT_SCHEMA_VERSION = 1


class ValidationCheckType(str, Enum):
    """Fixed check set; declaration order == report order."""

    FILE_EXISTS = "file_exists"
    PATH_ALLOWED = "path_allowed"
    FILE_READABLE = "file_readable"
    FILE_NON_EMPTY = "file_non_empty"
    SHA256_COMPUTED = "sha256_computed"
    METADATA_PARSED = "metadata_parsed"
    CONTAINER_ACCEPTED = "container_accepted"
    DURATION_WITHIN_TOLERANCE = "duration_within_tolerance"
    RESOLUTION_MATCHES = "resolution_matches"
    FRAME_RATE_WITHIN_TOLERANCE = "frame_rate_within_tolerance"


class ValidationCheckStatus(str, Enum):
    PASSED = "passed"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass(frozen=True, slots=True)
class ValidationCheck:
    check_type: ValidationCheckType
    status: ValidationCheckStatus
    observed: str | None
    expected: str | None
    error_code: str | None
    message: str | None


@dataclass(frozen=True, slots=True)
class ValidationReport:
    task_id: str
    shot_id: str
    checked_path: str
    passed: bool
    checks: tuple[ValidationCheck, ...]
    probe: MediaProbeResult | None
    policy_digest: str
    observed_at: datetime


def _fmt(value: object) -> str:
    if isinstance(value, float):
        return f"{value:.6f}"
    return str(value)


def staged_relative_path(task: GenerationTask) -> str:
    """Return the fixed staging contract path for a task's media."""
    return f"staging/shots/{task.task_id}.mp4"


def validate_artifact(
    *,
    project_root: Path,
    shot: Shot,
    task: GenerationTask,
    artifact: ArtifactReference,
    inspector: MediaInspector,
    policy: ValidationPolicy,
    observed_at: datetime,
) -> ValidationReport:
    """Run the ordered file-level checks and return a typed report."""
    if not isinstance(inspector, MediaInspector):
        raise FieldTypeError("inspector: expected a MediaInspector")
    if type(artifact) is not ArtifactReference:
        raise FieldTypeError("artifact: expected an ArtifactReference")
    validate_utc_datetime(observed_at, field_name="observed_at")

    staged_rel = artifact.reference
    staged_path = project_root / staged_rel
    expected_staging = staged_relative_path(task)

    checks: list[ValidationCheck] = []
    probe: MediaProbeResult | None = None
    state = {"aborted": False}

    def record(
        check_type: ValidationCheckType,
        ok: bool,
        *,
        observed: object | None,
        expected: object | None,
        message: str | None,
    ) -> bool:
        if state["aborted"]:
            checks.append(
                ValidationCheck(
                    check_type,
                    ValidationCheckStatus.SKIPPED,
                    None,
                    None if expected is None else _fmt(expected),
                    None,
                    None,
                )
            )
            return False
        if ok:
            checks.append(
                ValidationCheck(
                    check_type,
                    ValidationCheckStatus.PASSED,
                    None if observed is None else _fmt(observed),
                    None if expected is None else _fmt(expected),
                    None,
                    None,
                )
            )
            return True
        state["aborted"] = True
        checks.append(
            ValidationCheck(
                check_type,
                ValidationCheckStatus.FAILED,
                None if observed is None else _fmt(observed),
                None if expected is None else _fmt(expected),
                check_type.value,
                message,
            )
        )
        return False

    # 1 FILE_EXISTS
    file_exists = _is_regular_file(staged_path)
    record(
        ValidationCheckType.FILE_EXISTS,
        file_exists,
        observed=staged_rel,
        expected="regular-file",
        message="staged file is missing or not a regular file",
    )
    # 2 PATH_ALLOWED (naming + containment + symlink safety)
    record(
        ValidationCheckType.PATH_ALLOWED,
        (not state["aborted"])
        and _path_allowed(project_root, staged_rel, staged_path, expected_staging),
        observed=staged_rel,
        expected=expected_staging,
        message="staged path is not the allowed, contained staging path",
    )
    # 3 FILE_READABLE
    record(
        ValidationCheckType.FILE_READABLE,
        (not state["aborted"]) and _is_readable(staged_path),
        observed=staged_rel,
        expected="readable",
        message="staged file is not readable",
    )
    # 4 FILE_NON_EMPTY
    size = _file_size(staged_path) if not state["aborted"] else None
    record(
        ValidationCheckType.FILE_NON_EMPTY,
        (not state["aborted"]) and (size is not None and size > 0),
        observed="0" if size is None else str(size),
        expected=">0",
        message="staged file is empty",
    )
    # 5 SHA256_COMPUTED
    if not state["aborted"]:
        try:
            sha = file_sha256(staged_path)
        except Exception:  # noqa: BLE001 — any read failure is a check failure
            sha = None
    else:
        sha = None
    record(
        ValidationCheckType.SHA256_COMPUTED,
        (not state["aborted"]) and sha is not None,
        observed=sha,
        expected="sha-256",
        message="could not compute the file SHA-256",
    )
    # 6 METADATA_PARSED
    if not state["aborted"]:
        try:
            probe = inspector.probe(staged_path)
        except MediaInspectionError:
            probe = None
    record(
        ValidationCheckType.METADATA_PARSED,
        (not state["aborted"]) and probe is not None,
        observed="parsed" if probe is not None else "unparsable",
        expected="parsed",
        message="media metadata could not be parsed",
    )
    # 7 CONTAINER_ACCEPTED
    container_ok = probe is not None and _container_accepted(probe, policy)
    record(
        ValidationCheckType.CONTAINER_ACCEPTED,
        (not state["aborted"]) and container_ok,
        observed=None if probe is None else probe.container_format,
        expected=",".join(policy.allowed_containers),
        message="container format is not accepted",
    )
    # 8 DURATION_WITHIN_TOLERANCE
    duration_ok = probe is not None and _within_ratio(
        probe.duration_seconds, shot.duration_seconds, policy.duration_tolerance_ratio
    )
    record(
        ValidationCheckType.DURATION_WITHIN_TOLERANCE,
        (not state["aborted"]) and duration_ok,
        observed=None if probe is None else probe.duration_seconds,
        expected=f"{shot.duration_seconds:.6f}+-{policy.duration_tolerance_ratio:.6f}",
        message="duration is outside the allowed tolerance",
    )
    # 9 RESOLUTION_MATCHES
    resolution_ok = probe is not None and _resolution_ok(probe, shot, policy)
    record(
        ValidationCheckType.RESOLUTION_MATCHES,
        (not state["aborted"]) and resolution_ok,
        observed=None if probe is None else f"{probe.width}x{probe.height}",
        expected=f"{shot.width}x{shot.height}",
        message="resolution does not match the shot specification",
    )
    # 10 FRAME_RATE_WITHIN_TOLERANCE
    frame_rate_ok = probe is not None and _within_abs(
        probe.frame_rate, shot.frame_rate, policy.frame_rate_tolerance
    )
    record(
        ValidationCheckType.FRAME_RATE_WITHIN_TOLERANCE,
        (not state["aborted"]) and frame_rate_ok,
        observed=None if probe is None else probe.frame_rate,
        expected=f"{shot.frame_rate:.6f}+-{policy.frame_rate_tolerance:.6f}",
        message="frame rate is outside the allowed tolerance",
    )

    passed = all(c.status is ValidationCheckStatus.PASSED for c in checks)
    return ValidationReport(
        task_id=task.task_id,
        shot_id=shot.shot_id,
        checked_path=staged_rel,
        passed=passed,
        checks=tuple(checks),
        probe=probe,
        policy_digest=policy_digest(policy),
        observed_at=observed_at,
    )


def _is_regular_file(path: Path) -> bool:
    try:
        return path.is_file()
    except OSError:
        return False


def _path_allowed(
    project_root: Path, staged_rel: str, staged_path: Path, expected: str
) -> bool:
    if staged_rel != expected:
        return False
    rel = Path(staged_rel)
    if rel.is_absolute() or ".." in rel.parts:
        return False
    try:
        real_root = project_root.resolve()
        real_path = staged_path.resolve()
    except OSError:
        return False
    return real_path == real_root or real_root in real_path.parents


def _is_readable(path: Path) -> bool:
    try:
        with path.open("rb") as stream:
            stream.read(1)
        return True
    except OSError:
        return False


def _file_size(path: Path) -> int | None:
    try:
        return path.stat().st_size
    except OSError:
        return None


def _container_accepted(probe: MediaProbeResult, policy: ValidationPolicy) -> bool:
    observed = {
        part.strip() for part in probe.container_format.split(",") if part.strip()
    }
    return bool(observed & set(policy.allowed_containers))


def _within_ratio(observed: float, expected: float, ratio: float) -> bool:
    return abs(observed - expected) <= expected * ratio


def _within_abs(observed: float, expected: float, tolerance: float) -> bool:
    return abs(observed - expected) <= tolerance


def _resolution_ok(
    probe: MediaProbeResult, shot: Shot, policy: ValidationPolicy
) -> bool:
    if not policy.require_exact_resolution:
        return True
    return probe.width == shot.width and probe.height == shot.height

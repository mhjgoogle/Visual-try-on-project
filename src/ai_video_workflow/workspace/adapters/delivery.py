"""QC / final review / release / archive source adapters (read-only, TASK-025)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.release.delivery import (
    FINAL_REVIEW_SCHEMA_VERSION,
    TECHNICAL_QC_SCHEMA_VERSION,
    _latest_version,
    _load_version,
    latest_final_output,
)
from ai_video_workflow.release.errors import QcError, ReleaseError
from ai_video_workflow.workspace.adapters.base import corrupt, schema_supported
from ai_video_workflow.workspace.envelope import Problem

_QC_SCHEMAS = frozenset({TECHNICAL_QC_SCHEMA_VERSION})
_REVIEW_SCHEMAS = frozenset({FINAL_REVIEW_SCHEMA_VERSION})


@dataclass(frozen=True, slots=True)
class DeliverySources:
    technical_qc: dict | None
    final_review: dict | None
    release: dict | None
    final_output: tuple[int, str] | None
    problems: tuple[Problem, ...]


def _latest(project_root: Path, directory: str, prefix: str, err) -> dict | None:
    version = _latest_version(project_root, directory, prefix)
    if version is None:
        return None
    return _load_version(project_root, directory, prefix, version, err)


def read_delivery(project_root: Path) -> DeliverySources:
    problems: list[Problem] = []

    technical_qc: dict | None = None
    try:
        technical_qc = _latest(project_root, "qc", "technical_qc", QcError)
    except (QcError, ReleaseError) as exc:
        problems.append(corrupt("technical_qc", str(exc), readiness_failed=False))
    if technical_qc is not None:
        p = schema_supported(
            technical_qc.get("schema_version"),
            _QC_SCHEMAS,
            source="technical_qc",
            readiness_failed=False,
        )
        if p is not None:
            problems.append(p)  # old v1 QC surfaces as a problem, not silently used
            technical_qc = None

    final_review: dict | None = None
    try:
        final_review = _latest(project_root, "qc", "final_review", QcError)
    except (QcError, ReleaseError) as exc:
        problems.append(corrupt("final_review", str(exc), readiness_failed=False))
    if final_review is not None:
        p = schema_supported(
            final_review.get("schema_version"),
            _REVIEW_SCHEMAS,
            source="final_review",
            readiness_failed=False,
        )
        if p is not None:
            problems.append(p)
            final_review = None

    release: dict | None = None
    try:
        release = _latest(project_root, "release", "release", ReleaseError)
    except (QcError, ReleaseError) as exc:
        problems.append(corrupt("release", str(exc), readiness_failed=False))

    final_output = latest_final_output(project_root)

    return DeliverySources(
        technical_qc=technical_qc,
        final_review=final_review,
        release=release,
        final_output=final_output,
        problems=tuple(problems),
    )

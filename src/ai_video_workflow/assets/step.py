"""The validation step: validate, register, report, emit QCD, and commit.

``run_validation_step`` is the independently runnable, resumable step
that ties the pieces together. It selects the logical version from the
staged content digest, validates the artifact, publishes the JSON +
Markdown reports, imports the media and registers the VideoAsset on a
pass, emits the QCD events, and commits the StepManifest last. Re-runs
are idempotent: an already-COMPLETED manifest whose input/config digests
match and whose every output_path is present and valid is a no-op; a
partial commit is completed in place (reuse-if-equal, conflict on
differing content); a changed staged digest registers a new version and
retains the old one (TASK-005 / ADR-0001 §9).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from ai_video_workflow.assets.policy import ValidationPolicy, policy_digest
from ai_video_workflow.assets.registration import (
    asset_record_relative_path,
    import_media,
    publish_bytes,
    register_video_asset,
)
from ai_video_workflow.assets.reports import report_json_bytes, report_markdown_bytes
from ai_video_workflow.assets.validation import ValidationReport, validate_artifact
from ai_video_workflow.digests import file_sha256
from ai_video_workflow.errors import DataFileError, FieldTypeError
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.models import GenerationTask, Scene, Shot, VideoAsset
from ai_video_workflow.persistence import read_model_json, write_model_json
from ai_video_workflow.providers.models import ArtifactReference
from ai_video_workflow.qcd.events import (
    build_asset_imported_event,
    build_manual_quality_rating_event,
    build_validation_completed_event,
)
from ai_video_workflow.qcd.log import append_event
from ai_video_workflow.validation import validate_utc_datetime

_ABSENT_STAGED_SHA = "0" * 64


@dataclass(frozen=True, slots=True)
class ValidationStepOutcome:
    report: ValidationReport
    registered_asset: VideoAsset | None
    manifest: StepManifest
    emitted_event_ids: tuple[str, ...]
    skipped: bool


def validation_manifest_path(project_root: Path, task: GenerationTask) -> Path:
    return project_root / "manifests" / f"validation-{task.task_id}.json"


def report_relative_paths(task: GenerationTask, version: int) -> tuple[str, str]:
    stem = f"reports/validation/{task.task_id}_v{version}"
    return f"{stem}.json", f"{stem}.md"


def run_validation_step(
    *,
    project_root: Path,
    shot: Shot,
    scene: Scene,
    task: GenerationTask,
    artifact: ArtifactReference,
    inspector,
    policy: ValidationPolicy,
    observed_at: datetime,
) -> ValidationStepOutcome:
    """Run the resumable validation + registration step for one task."""
    if type(artifact) is not ArtifactReference:
        raise FieldTypeError("artifact: expected an ArtifactReference")
    if task.shot_id != shot.shot_id or shot.scene_id != scene.scene_id:
        raise FieldTypeError("shot/scene/task identity mismatch")
    validate_utc_datetime(observed_at, field_name="observed_at")

    staged_path = project_root / artifact.reference
    input_sha = _staged_sha(staged_path)
    config_digest = policy_digest(policy)

    existing = _read_manifest(project_root, task)
    version = _select_version(existing, input_sha)

    report = validate_artifact(
        project_root=project_root,
        shot=shot,
        task=task,
        artifact=artifact,
        inspector=inspector,
        policy=policy,
        observed_at=observed_at,
    )

    if _is_noop(project_root, existing, input_sha, config_digest):
        asset = _load_asset_if_any(project_root, existing)
        return ValidationStepOutcome(
            report=report,
            registered_asset=asset,
            manifest=existing,
            emitted_event_ids=(),
            skipped=True,
        )

    report_json_rel, report_md_rel = report_relative_paths(task, version)
    publish_bytes(project_root / report_json_rel, report_json_bytes(report))
    publish_bytes(project_root / report_md_rel, report_markdown_bytes(report))

    emitted: list[str] = []
    registered_asset: VideoAsset | None = None
    project_id = scene.project_id

    if report.passed:
        assert report.probe is not None
        media_rel, media_sha, size_bytes = import_media(
            project_root=project_root,
            staged_path=staged_path,
            scene=scene,
            shot=shot,
            version=version,
        )
        registered_asset, asset_rel = register_video_asset(
            project_root=project_root,
            task=task,
            shot=shot,
            version=version,
            media_relative=media_rel,
            probe=report.probe,
            validated_at=observed_at,
        )
        duration_ms = int(round(report.probe.duration_seconds * 1000))
        emitted.append(
            _emit(
                project_root,
                build_asset_imported_event(
                    project_id=project_id,
                    shot_id=shot.shot_id,
                    task_id=task.task_id,
                    asset_id=registered_asset.asset_id,
                    sha256=media_sha,
                    size_bytes=size_bytes,
                    path=media_rel,
                    version=version,
                    duration_ms=duration_ms,
                    source_attempt_id=None,
                    occurred_at=observed_at,
                ),
            )
        )
        output_paths: tuple[str, ...] = (
            report_json_rel,
            report_md_rel,
            media_rel,
            asset_rel,
        )
    else:
        output_paths = (report_json_rel, report_md_rel)

    checks_failed = sum(1 for c in report.checks if c.status.value == "failed")
    emitted.append(
        _emit(
            project_root,
            build_validation_completed_event(
                project_id=project_id,
                shot_id=shot.shot_id,
                task_id=task.task_id,
                passed=report.passed,
                report_path=report_json_rel,
                report_version=version,
                checks_total=len(report.checks),
                checks_failed=checks_failed,
                input_sha256=input_sha,
                asset_id=(
                    None if registered_asset is None else registered_asset.asset_id
                ),
                occurred_at=observed_at,
            ),
        )
    )

    manifest = _build_manifest(
        task=task,
        version=version,
        input_sha=input_sha,
        config_digest=config_digest,
        passed=report.passed,
        checks_failed=checks_failed,
        output_paths=output_paths,
        registered_asset=registered_asset,
        report_json_rel=report_json_rel,
        observed_at=observed_at,
    )
    manifest_path = validation_manifest_path(project_root, task)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    write_model_json(manifest_path, manifest, overwrite=True)

    return ValidationStepOutcome(
        report=report,
        registered_asset=registered_asset,
        manifest=manifest,
        emitted_event_ids=tuple(emitted),
        skipped=False,
    )


def record_manual_quality_rating(
    project_root: Path,
    *,
    project_id: str,
    shot_id: str,
    task_id: str | None,
    rating_id: str,
    score: int,
    asset_id: str | None,
    occurred_at: datetime,
    note: str | None = None,
) -> str:
    """Record a manual quality rating as a QCD event; return its event_id.

    The library-level rating entry (the CLI entry is TASK-007). The
    rating_id and occurred_at are supplied by the caller (the core never
    reads the clock or generates randomness).
    """
    event = build_manual_quality_rating_event(
        project_id=project_id,
        shot_id=shot_id,
        task_id=task_id,
        rating_id=rating_id,
        score=score,
        asset_id=asset_id,
        occurred_at=occurred_at,
        note=note,
    )
    append_event(project_root, event)
    return event.event_id


def _staged_sha(staged_path: Path) -> str:
    try:
        return file_sha256(staged_path)
    except DataFileError:
        return _ABSENT_STAGED_SHA


def _read_manifest(project_root: Path, task: GenerationTask) -> StepManifest | None:
    path = validation_manifest_path(project_root, task)
    if not path.exists():
        return None
    return read_model_json(path, StepManifest)


def _manifest_version(manifest: StepManifest) -> int:
    value = manifest.output_metadata.get("asset_version")
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _select_version(existing: StepManifest | None, input_sha: str) -> int:
    if existing is None:
        return 1
    if existing.input_digest == input_sha:
        return _manifest_version(existing) or 1
    return (_manifest_version(existing) or 0) + 1


def _is_noop(
    project_root: Path,
    existing: StepManifest | None,
    input_sha: str,
    config_digest: str,
) -> bool:
    if existing is None or existing.status is not ManifestStatus.COMPLETED:
        return False
    if existing.input_digest != input_sha:
        return False
    if existing.relevant_config_digest != config_digest:
        return False
    for rel in existing.output_paths:
        if not (project_root / rel).exists():
            return False
    asset = _load_asset_if_any(project_root, existing)
    passed = bool(existing.output_metadata.get("passed"))
    if passed and asset is None:
        return False
    return True


def _load_asset_if_any(
    project_root: Path, existing: StepManifest | None
) -> VideoAsset | None:
    if existing is None:
        return None
    asset_id = existing.output_metadata.get("asset_id")
    if not isinstance(asset_id, str) or not asset_id:
        return None
    path = project_root / asset_record_relative_path(asset_id)
    if not path.exists():
        return None
    return read_model_json(path, VideoAsset)


def _emit(project_root: Path, event) -> str:
    append_event(project_root, event)
    return event.event_id


def _build_manifest(
    *,
    task: GenerationTask,
    version: int,
    input_sha: str,
    config_digest: str,
    passed: bool,
    checks_failed: int,
    output_paths: tuple[str, ...],
    registered_asset: VideoAsset | None,
    report_json_rel: str,
    observed_at: datetime,
) -> StepManifest:
    metadata: dict[str, object] = {
        "asset_version": version,
        "passed": passed,
        "asset_id": None if registered_asset is None else registered_asset.asset_id,
        "report_json": report_json_rel,
    }
    if passed:
        return StepManifest(
            step_name=f"validation:{task.task_id}",
            input_digest=input_sha,
            relevant_config_digest=config_digest,
            status=ManifestStatus.COMPLETED,
            created_at=observed_at,
            output_paths=output_paths,
            output_metadata=metadata,
            completed_at=observed_at,
        )
    return StepManifest(
        step_name=f"validation:{task.task_id}",
        input_digest=input_sha,
        relevant_config_digest=config_digest,
        status=ManifestStatus.FAILED,
        created_at=observed_at,
        output_paths=output_paths,
        output_metadata=metadata,
        completed_at=observed_at,
        error_summary=f"validation failed: {checks_failed} check(s) failed",
    )

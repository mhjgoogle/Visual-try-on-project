"""The validation step: validate, register, report, emit QCD, and commit.

``run_validation_step`` is the independently runnable, resumable step
that ties the pieces together. It selects the logical version, validates
the artifact, publishes the JSON + Markdown reports, imports the media
and registers the VideoAsset on a pass, emits the QCD events, and
commits the StepManifest last.

Version is keyed to the **shot**, not to the task in isolation: the
media/asset version is the shot's next unused version, and identical
staged content already published for the shot reuses that version — so
a redo task with genuinely new content registers a new version instead
of colliding on the original (TASK-013 / ADR-0001 §9). Re-runs are
byte-stable: a completed manifest whose input/config digests match, whose
outputs all exist, whose report identity and media SHA verify is a no-op;
a partial commit is completed in place by reusing the already-written
report's ``observed_at`` (ADR-0005) so re-rendered bytes are identical.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from ai_video_workflow.assets.policy import ValidationPolicy, policy_digest
from ai_video_workflow.assets.registration import (
    AssetConflictError,
    asset_record_relative_path,
    import_media,
    media_relative_path,
    publish_bytes,
    register_video_asset,
)
from ai_video_workflow.assets.reports import report_json_bytes, report_markdown_bytes
from ai_video_workflow.assets.validation import (
    ValidationReport,
    validate_artifact,
)
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
from ai_video_workflow.security import resolve_within_root
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
    return resolve_within_root(
        project_root, Path("manifests") / f"validation-{task.task_id}.json"
    )


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

    staged_path = resolve_within_root(project_root, artifact.reference)
    input_sha = _staged_sha(staged_path)
    config_digest = policy_digest(policy)

    existing = _read_manifest(project_root, task)
    version = _select_version(project_root, existing, scene, shot, input_sha)

    report_json_rel, report_md_rel = report_relative_paths(task, version)
    # one time value per logical operation: reuse the already-written
    # report's observed_at on a partial-commit replay (ADR-0005).
    effective_at = _existing_report_time(project_root, report_json_rel) or observed_at

    report = validate_artifact(
        project_root=project_root,
        shot=shot,
        task=task,
        artifact=artifact,
        inspector=inspector,
        policy=policy,
        observed_at=effective_at,
    )
    json_bytes = report_json_bytes(report)
    md_bytes = report_markdown_bytes(report)

    if _is_noop(
        project_root,
        existing,
        input_sha,
        config_digest,
        report_json_rel,
        report_md_rel,
        json_bytes,
        md_bytes,
    ):
        asset = _load_asset_if_any(project_root, existing)
        return ValidationStepOutcome(
            report=report,
            registered_asset=asset,
            manifest=existing,
            emitted_event_ids=(),
            skipped=True,
        )

    publish_bytes(resolve_within_root(project_root, report_json_rel), json_bytes)
    publish_bytes(resolve_within_root(project_root, report_md_rel), md_bytes)

    emitted: list[str] = []
    registered_asset: VideoAsset | None = None
    media_sha: str | None = None
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
            validated_at=effective_at,
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
                    occurred_at=effective_at,
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
                occurred_at=effective_at,
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
        media_sha=media_sha,
        observed_at=effective_at,
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


def _select_version(
    project_root: Path,
    existing: StepManifest | None,
    scene: Scene,
    shot: Shot,
    input_sha: str,
) -> int:
    """Select the shot's logical version for this staged content.

    1. a replay of *this task* with the same staged content reuses the
       version its manifest already recorded;
    2. otherwise, if the shot already has published media with the same
       SHA-256, that version is reused (idempotent cross-task import);
    3. otherwise the next unused shot version is allocated.

    Version discovery probes explicit per-version media paths only — no
    directory scan.
    """
    if existing is not None and existing.input_digest == input_sha:
        recorded = _manifest_version(existing)
        if recorded:
            return recorded
    version = 1
    while True:
        media_path = resolve_within_root(
            project_root, media_relative_path(scene, shot, version)
        )
        if not media_path.exists():
            return version
        try:
            if file_sha256(media_path) == input_sha:
                return version
        except DataFileError:
            return version
        version += 1


def _is_noop(
    project_root: Path,
    existing: StepManifest | None,
    input_sha: str,
    config_digest: str,
    report_json_rel: str,
    report_md_rel: str,
    json_bytes: bytes,
    md_bytes: bytes,
) -> bool:
    if existing is None or existing.status is not ManifestStatus.COMPLETED:
        return False
    if existing.input_digest != input_sha:
        return False
    if existing.relevant_config_digest != config_digest:
        return False
    for rel in existing.output_paths:
        if not resolve_within_root(project_root, rel).exists():
            return False
    # the on-disk reports must byte-match the freshly rendered reports:
    # this verifies the full report identity (task/shot/path/policy/checks)
    # and the deterministic Markdown, not just the schema version. Any
    # tampered or drifted report is therefore not a no-op.
    try:
        if (
            resolve_within_root(project_root, report_json_rel).read_bytes()
            != json_bytes
        ):
            return False
        if resolve_within_root(project_root, report_md_rel).read_bytes() != md_bytes:
            return False
    except OSError:
        return False
    # ADR-0005: a committed operation uses one time value, so the report's
    # observed_at must equal the manifest's committed created_at/completed_at.
    # A drift means the durable report was altered after commit -> a conflict,
    # never a silent no-op skip.
    observed = _existing_report_time(project_root, report_json_rel)
    if observed is None:
        return False
    if observed != existing.created_at or (
        existing.completed_at is not None and observed != existing.completed_at
    ):
        raise AssetConflictError(
            "validation: report observed_at drifted from the committed manifest time"
        )
    # a passing report must retain its asset and undrifted media
    passed = bool(existing.output_metadata.get("passed"))
    asset = _load_asset_if_any(project_root, existing)
    if passed:
        if asset is None:
            return False
        # the registered asset's validated_at is the same committed time value
        if asset.validated_at != observed:
            raise AssetConflictError(
                "validation: asset validated_at drifted from the report time"
            )
        recorded_media = existing.output_metadata.get("media_sha256")
        if not isinstance(recorded_media, str):
            return False
        media_path = resolve_within_root(project_root, str(asset.path))
        if not media_path.exists():
            return False
        try:
            if file_sha256(media_path) != recorded_media:
                return False
        except DataFileError:
            return False
    return True


def _existing_report_time(project_root: Path, report_json_rel: str) -> datetime | None:
    try:
        report = json.loads(
            resolve_within_root(project_root, report_json_rel).read_text("utf-8")
        )
    except Exception:  # noqa: BLE001 — no readable prior report
        return None
    value = report.get("observed_at")
    if not isinstance(value, str):
        return None
    try:
        return validate_utc_datetime(
            datetime.fromisoformat(value), field_name="observed_at"
        )
    except Exception:  # noqa: BLE001 — an unparsable time is treated as absent
        return None


def _load_asset_if_any(
    project_root: Path, existing: StepManifest | None
) -> VideoAsset | None:
    if existing is None:
        return None
    asset_id = existing.output_metadata.get("asset_id")
    if not isinstance(asset_id, str) or not asset_id:
        return None
    path = resolve_within_root(project_root, asset_record_relative_path(asset_id))
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
    media_sha: str | None,
    observed_at: datetime,
) -> StepManifest:
    metadata: dict[str, object] = {
        "asset_version": version,
        "passed": passed,
        "asset_id": None if registered_asset is None else registered_asset.asset_id,
        "report_json": report_json_rel,
        "media_sha256": media_sha,
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

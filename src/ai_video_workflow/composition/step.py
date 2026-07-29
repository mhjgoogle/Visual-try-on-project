"""The composition step: plan, intent, compose, publish, emit, commit.

``run_composition_step`` composes the project's shots into one final
MP4 in a fixed, resumable order (TASK-006):

1. determine the logical version and every target path;
2. write the CompositionPublishIntent (durable, before composing);
3. normalize each input into staging/composition/v<N>/;
4. concatenate to a same-directory temp file;
5. atomically no-replace publish the final MP4;
6. write the JSON report from the final MP4's actual hash;
7. write the deterministic Markdown report;
8. append the composition_completed QCD event;
9. commit the StepManifest;
10. best-effort remove the intent.

Recovery (A–F): a matching intent + published MP4 + missing report
completes the reports without re-composing (A); a matching intent + no
MP4 re-composes the same version (B); an MP4 with no matching intent is
a conflict (C); an intent whose identity/digest/path differs is a
conflict (D); a stale intent after a completed manifest is cleaned up
best-effort, including on the no-op path (E); a report present but the
media missing is a conflict (F). Report/QCD/manifest all use one
per-operation time: if the JSON report already exists (partial commit),
its ``observed_at`` is reused so re-rendered bytes are byte-identical
(ADR-0005). A composer/ffmpeg failure records a FAILED manifest before
propagating. The CompositionPublishIntent is an independent journal and
never touches the TASK-004 WAL.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from ai_video_workflow.composition.composer import VideoComposer
from ai_video_workflow.composition.errors import (
    CompositionConflictError,
    CompositionError,
)
from ai_video_workflow.composition.intent import (
    CompositionPublishIntent,
    intent_path,
    read_intent,
    write_intent,
)
from ai_video_workflow.composition.plan import (
    CompositionPlan,
    build_composition_plan,
)
from ai_video_workflow.composition.profile import CompositionProfile, profile_digest
from ai_video_workflow.digests import config_digest, file_sha256
from ai_video_workflow.errors import FieldTypeError
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.persistence import read_model_json, write_model_json
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.qcd.events import build_composition_completed_event
from ai_video_workflow.qcd.log import append_event
from ai_video_workflow.security import resolve_within_root
from ai_video_workflow.validation import validate_utc_datetime

COMPOSITION_REPORT_SCHEMA_VERSION = 1
_INPUT_SCHEMA = "m1-composition-input-v1"


@dataclass(frozen=True, slots=True)
class CompositionStepOutcome:
    output_path: str
    version: int
    manifest: StepManifest
    report: dict[str, object]
    emitted_event_ids: tuple[str, ...]
    skipped: bool


def composition_manifest_path(project_root: Path, project_id: str) -> Path:
    return resolve_within_root(
        project_root, Path("manifests") / f"composition-{project_id}.json"
    )


def run_composition_step(
    *,
    project_root: Path,
    data: ProjectData,
    composer: VideoComposer,
    profile: CompositionProfile | None,
    observed_at: datetime,
) -> CompositionStepOutcome:
    if not isinstance(composer, VideoComposer):
        raise FieldTypeError("composer: expected a VideoComposer")
    validate_utc_datetime(observed_at, field_name="observed_at")

    plan = build_composition_plan(data=data, profile=profile)
    project_id = plan.project_id
    config_digest_value = profile_digest(plan.profile)
    input_entries = _input_entries(project_root, plan)
    input_digest = config_digest({"schema": _INPUT_SCHEMA, "assets": input_entries})

    existing = _read_manifest(project_root, project_id)
    version = _select_version(existing, input_digest, config_digest_value)

    media_rel = f"outputs/final_v{version}.mp4"
    json_rel = f"reports/composition/final_v{version}.json"
    md_rel = f"reports/composition/final_v{version}.md"
    media_path = resolve_within_root(project_root, media_rel)

    if _is_noop(
        project_root,
        existing,
        input_digest,
        config_digest_value,
        plan=plan,
        input_entries=input_entries,
        version=version,
        media_rel=media_rel,
        json_rel=json_rel,
        md_rel=md_rel,
    ):
        # E: a completed manifest leaves no live intent behind.
        _remove_intent(project_root, project_id, version)
        return CompositionStepOutcome(
            output_path=media_rel,
            version=version,
            manifest=existing,
            report=_load_json(resolve_within_root(project_root, json_rel)),
            emitted_event_ids=(),
            skipped=True,
        )

    existing_intent = read_intent(project_root, project_id, version)
    media_exists = media_path.exists()
    json_exists = resolve_within_root(project_root, json_rel).exists()

    # F: a report is present but the media is missing -> conflict
    if json_exists and not media_exists:
        raise CompositionConflictError(
            f"composition: report present but final media missing: {media_rel}"
        )
    # C: a final MP4 exists with no matching intent -> conflict
    if media_exists and existing_intent is None:
        raise CompositionConflictError(
            f"composition: final media exists with no matching intent: {media_rel}"
        )

    intent = CompositionPublishIntent(
        project_id=project_id,
        logical_version=version,
        input_digest=input_digest,
        profile_digest=config_digest_value,
        media_path=media_rel,
        json_report_path=json_rel,
        markdown_report_path=md_rel,
    )
    write_intent(project_root, intent)  # D: differing identity -> conflict

    # one time value for the whole operation: reuse the existing report's
    # observed_at on a partial-commit replay so re-rendered bytes match.
    effective_at = _existing_report_time(project_root, json_rel) or observed_at

    try:
        if media_exists:
            output_sha = file_sha256(media_path)  # A/B reuse of the published MP4
        else:
            output_sha = _compose(project_root, plan, version, composer, media_path)
    except CompositionError as exc:
        _write_failed_manifest(
            project_root,
            project_id=project_id,
            input_digest=input_digest,
            config_digest_value=config_digest_value,
            version=version,
            created_at=effective_at,
            error_summary=str(exc),
        )
        raise

    report = _build_report(
        project_id=project_id,
        plan=plan,
        input_entries=input_entries,
        version=version,
        media_rel=media_rel,
        output_sha=output_sha,
        config_digest_value=config_digest_value,
        observed_at=effective_at,
    )
    _publish_bytes(
        resolve_within_root(project_root, json_rel), _report_json_bytes(report)
    )
    _publish_bytes(
        resolve_within_root(project_root, md_rel), _report_markdown_bytes(report)
    )

    event = build_composition_completed_event(
        project_id=project_id,
        output_path=media_rel,
        output_version=version,
        output_sha256=output_sha,
        input_asset_ids=tuple(entry.asset_id for entry in plan.entries),
        profile_digest=config_digest_value,
        occurred_at=effective_at,
        output_duration_ms=None,
    )
    append_event(project_root, event)

    manifest = StepManifest(
        step_name=f"composition:{project_id}",
        input_digest=input_digest,
        relevant_config_digest=config_digest_value,
        status=ManifestStatus.COMPLETED,
        created_at=effective_at,
        output_paths=(media_rel, json_rel, md_rel),
        output_metadata={
            "output_version": version,
            "output_sha256": output_sha,
            "entry_count": len(plan.entries),
        },
        completed_at=effective_at,
    )
    manifest_path = composition_manifest_path(project_root, project_id)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    write_model_json(manifest_path, manifest, overwrite=True)

    # E: best-effort cleanup of the now-committed intent
    _remove_intent(project_root, project_id, version)

    return CompositionStepOutcome(
        output_path=media_rel,
        version=version,
        manifest=manifest,
        report=report,
        emitted_event_ids=(event.event_id,),
        skipped=False,
    )


def _input_digest(project_root: Path, plan: CompositionPlan) -> str:
    return config_digest(
        {"schema": _INPUT_SCHEMA, "assets": _input_entries(project_root, plan)}
    )


def _input_entries(
    project_root: Path, plan: CompositionPlan
) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    for entry in plan.entries:
        media = resolve_within_root(project_root, entry.asset_path)
        try:
            sha = file_sha256(media)
        except Exception as exc:  # noqa: BLE001 — a missing asset media file
            raise CompositionError(
                f"composition: asset media file is missing: {entry.asset_path}"
            ) from exc
        entries.append(
            {
                "asset_id": entry.asset_id,
                "version": entry.asset_version,
                "file_sha256": sha,
            }
        )
    return entries


def _read_manifest(project_root: Path, project_id: str) -> StepManifest | None:
    path = composition_manifest_path(project_root, project_id)
    if not path.exists():
        return None
    return read_model_json(path, StepManifest)


def _select_version(
    existing: StepManifest | None, input_digest: str, config_digest_value: str
) -> int:
    if existing is None:
        return 1
    prev_version = existing.output_metadata.get("output_version")
    prev_version = (
        prev_version
        if isinstance(prev_version, int) and not isinstance(prev_version, bool)
        else 0
    )
    same = (
        existing.input_digest == input_digest
        and existing.relevant_config_digest == config_digest_value
    )
    # a completed OR failed manifest for the same inputs retries the same
    # version; a genuine input change advances to the next version.
    return prev_version if same and prev_version else (prev_version + 1)


def _is_noop(
    project_root: Path,
    existing: StepManifest | None,
    input_digest: str,
    config_digest_value: str,
    *,
    plan: CompositionPlan,
    input_entries: list[dict[str, object]],
    version: int,
    media_rel: str,
    json_rel: str,
    md_rel: str,
) -> bool:
    if existing is None or existing.status is not ManifestStatus.COMPLETED:
        return False
    if existing.input_digest != input_digest:
        return False
    if existing.relevant_config_digest != config_digest_value:
        return False
    for rel in (media_rel, json_rel, md_rel):
        if not resolve_within_root(project_root, rel).exists():
            return False
    recorded = existing.output_metadata.get("output_sha256")
    if not isinstance(recorded, str):
        return False
    if file_sha256(resolve_within_root(project_root, media_rel)) != recorded:
        return False
    # the on-disk reports must byte-match the report rebuilt from the plan
    # + recorded output hash + the report's own observed_at. This verifies
    # the full report identity (project/output_path/profile/entries) and
    # the deterministic Markdown, so a tampered report is not a no-op.
    observed = _existing_report_time(project_root, json_rel)
    if observed is None:
        return False
    rebuilt = _build_report(
        project_id=plan.project_id,
        plan=plan,
        input_entries=input_entries,
        version=version,
        media_rel=media_rel,
        output_sha=recorded,
        config_digest_value=config_digest_value,
        observed_at=observed,
    )
    try:
        json_path = resolve_within_root(project_root, json_rel)
        md_path = resolve_within_root(project_root, md_rel)
        if json_path.read_bytes() != _report_json_bytes(rebuilt):
            return False
        if md_path.read_bytes() != _report_markdown_bytes(rebuilt):
            return False
    except OSError:
        return False
    return True


def _existing_report_time(project_root: Path, json_rel: str) -> datetime | None:
    try:
        report = _load_json(resolve_within_root(project_root, json_rel))
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


def _compose(
    project_root: Path,
    plan: CompositionPlan,
    version: int,
    composer: VideoComposer,
    media_path: Path,
) -> str:
    staging_dir = resolve_within_root(
        project_root, Path("staging") / "composition" / f"v{version}"
    )
    staging_dir.mkdir(parents=True, exist_ok=True)
    normalized: list[Path] = []
    for index, entry in enumerate(plan.entries):
        source = resolve_within_root(project_root, entry.asset_path)
        target = staging_dir / f"{index:03d}_{entry.shot_id}.mp4"
        composer.normalize(source, target, plan.profile)
        normalized.append(target)
    temp_final = staging_dir / "_final.mp4"
    if temp_final.exists():
        temp_final.unlink()
    composer.concatenate(tuple(normalized), temp_final)
    media_path.parent.mkdir(parents=True, exist_ok=True)
    _publish_bytes(media_path, temp_final.read_bytes())
    return file_sha256(media_path)


def _write_failed_manifest(
    project_root: Path,
    *,
    project_id: str,
    input_digest: str,
    config_digest_value: str,
    version: int,
    created_at: datetime,
    error_summary: str,
) -> None:
    manifest = StepManifest(
        step_name=f"composition:{project_id}",
        input_digest=input_digest,
        relevant_config_digest=config_digest_value,
        status=ManifestStatus.FAILED,
        created_at=created_at,
        output_paths=(),
        output_metadata={"output_version": version},
        completed_at=created_at,
        error_summary=error_summary[:500],
    )
    manifest_path = composition_manifest_path(project_root, project_id)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    write_model_json(manifest_path, manifest, overwrite=True)


def _remove_intent(project_root: Path, project_id: str, version: int) -> None:
    try:
        intent_path(project_root, project_id, version).unlink()
    except OSError:
        pass


def _build_report(
    *,
    project_id: str,
    plan: CompositionPlan,
    input_entries: list[dict[str, object]],
    version: int,
    media_rel: str,
    output_sha: str,
    config_digest_value: str,
    observed_at: datetime,
) -> dict[str, object]:
    sha_by_asset = {e["asset_id"]: e["file_sha256"] for e in input_entries}
    return {
        "report_schema_version": COMPOSITION_REPORT_SCHEMA_VERSION,
        "project_id": project_id,
        "output_path": media_rel,
        "output_version": version,
        "output_sha256": output_sha,
        "profile_digest": config_digest_value,
        "profile": plan.profile.to_config_value()["profile"],
        "observed_at": observed_at.isoformat(timespec="microseconds"),
        "entries": [
            {
                "scene_id": entry.scene_id,
                "shot_id": entry.shot_id,
                "asset_id": entry.asset_id,
                "asset_version": entry.asset_version,
                "asset_path": entry.asset_path,
                "file_sha256": sha_by_asset.get(entry.asset_id),
            }
            for entry in plan.entries
        ],
    }


def _report_json_bytes(report: dict[str, object]) -> bytes:
    text = (
        json.dumps(
            report, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False
        )
        + "\n"
    )
    return text.encode("utf-8")


def _report_markdown_bytes(report: dict[str, object]) -> bytes:
    lines = [
        "# Composition Report",
        "",
        f"- project_id: {report['project_id']}",
        f"- output_path: {report['output_path']}",
        f"- output_version: {report['output_version']}",
        f"- output_sha256: {report['output_sha256']}",
        f"- profile_digest: {report['profile_digest']}",
        f"- observed_at: {report['observed_at']}",
        "",
        "## Inputs (ordered)",
        "",
        "| # | scene | shot | asset | version | file_sha256 |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for index, entry in enumerate(report["entries"]):  # type: ignore[arg-type]
        lines.append(
            f"| {index} | {entry['scene_id']} | {entry['shot_id']} "
            f"| {entry['asset_id']} | {entry['asset_version']} "
            f"| {entry['file_sha256']} |"
        )
    lines.append("")
    return ("\n".join(lines) + "\n").encode("utf-8")


def _load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def _publish_bytes(path: Path, data: bytes) -> None:
    if path.exists():
        if path.read_bytes() == data:
            return
        raise CompositionConflictError(
            f"composition: existing file has conflicting content: {path}"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_no_replace_write(path, data)


def _atomic_no_replace_write(path: Path, data: bytes) -> None:
    temporary_path: Path | None = None
    raw_fd: int | None = None
    try:
        raw_fd, temporary_name = tempfile.mkstemp(
            dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
        )
        temporary_path = Path(temporary_name)
        stream = os.fdopen(raw_fd, "wb")
        raw_fd = None
        with stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary_path, path)
        except FileExistsError as exc:
            raise CompositionConflictError(
                f"composition: file appeared during publish: {path}"
            ) from exc
    except CompositionConflictError:
        raise
    except OSError as exc:
        raise CompositionError(f"composition: unable to publish file: {path}") from exc
    finally:
        if raw_fd is not None:
            try:
                os.close(raw_fd)
            except OSError:
                pass
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except OSError:
                pass

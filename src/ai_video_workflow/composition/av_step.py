"""The audio-visual mux step: resolve, plan, mux, publish, emit, commit (TASK-008).

``run_audiovisual_step`` mounts registered voice-over / sfx / subtitle assets onto
an existing M1 composition master and publishes a NEW versioned
``outputs/final_av_v<N>.mp4`` — the video-only ``outputs/final_v<N>.mp4`` and the
frozen M1 composition step/profile are never touched (ADR-0039 clause 9, S5-T04/
T05).

The caller MUST state ``base_has_audio`` — the step probes video, not audio
streams, so it cannot itself tell whether the M1 master carries an audio track.
There is deliberately NO default: a wrong ``True`` on a silent master would make
ffmpeg map a non-existent ``[0:a]`` and fail. Callers that don't already know can
compute it with :func:`detect_base_audio` (an ffprobe-backed AudioInspector).

It mirrors the M1 composition step's durability model exactly:

1. resolve every input (base video by path+digest; each audio/subtitle by media
   asset ref+version, whose bound file is digest-verified on load) and derive the
   input digest + the profile config digest;
2. select the logical version from the durable manifest (same inputs+recipe retry
   the same version; a change advances it);
3. write the durable publish intent BEFORE muxing;
4. mux to a staging temp file, inspect + hash it BEFORE publishing (a bad mux
   never reaches outputs/), then atomically no-replace publish;
5. write the JSON + deterministic Markdown reports from the published file's hash;
6. append the distinct ``audiovisual_completed`` QCD event (a separate type from
   the video-only ``composition_completed``, so M1 counters are never inflated);
7. commit the StepManifest, then best-effort remove the intent.

Recovery A–F match the composition step: a matching intent + published mp4 +
missing report completes reports without re-muxing; a published mp4 with no
matching intent, or a differing intent, is a conflict; a FAILED manifest is
recorded on any mux/probe error before propagating.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from ai_video_workflow.audio.errors import AudioValidationError
from ai_video_workflow.audio.inspect import AudioInspector
from ai_video_workflow.composition.audiovisual import (
    SUBTITLE_MODE_NONE,
    AudioVisualComposer,
    MuxAudioInput,
    MuxPlan,
)
from ai_video_workflow.composition.av_profile import (
    AudioVisualProfile,
    av_profile_digest,
)
from ai_video_workflow.composition.errors import (
    CompositionConflictError,
    CompositionError,
    CompositionToolError,
)
from ai_video_workflow.digests import config_digest, file_sha256
from ai_video_workflow.errors import FieldTypeError, JsonDataError
from ai_video_workflow.inspection.base import MediaInspector
from ai_video_workflow.inspection.errors import (
    MediaInspectionError,
    MediaToolNotAvailableError,
)
from ai_video_workflow.manifest import ManifestStatus, StepManifest
from ai_video_workflow.media.assets import MediaAsset, load_asset
from ai_video_workflow.persistence import read_model_json, write_model_json
from ai_video_workflow.qcd.events import build_audiovisual_completed_event
from ai_video_workflow.qcd.log import append_event
from ai_video_workflow.security import resolve_within_root
from ai_video_workflow.security.paths import PathEscapeError
from ai_video_workflow.validation import validate_stable_id, validate_utc_datetime

AV_REPORT_SCHEMA_VERSION = 1
AV_INTENT_SCHEMA_VERSION = 1
_INPUT_SCHEMA = "wfm2-audiovisual-input-v1"
_COPY_CHUNK_BYTES = 1024 * 1024

_INTENT_KEYS = frozenset(
    {
        "schema_version",
        "project_id",
        "logical_version",
        "input_digest",
        "profile_digest",
        "media_path",
        "json_report_path",
        "markdown_report_path",
    }
)


@dataclass(frozen=True, slots=True)
class AudioVisualStepOutcome:
    output_path: str
    version: int
    manifest: StepManifest
    report: dict[str, object]
    emitted_event_ids: tuple[str, ...]
    skipped: bool


@dataclass(frozen=True, slots=True)
class _ResolvedInput:
    base_video_rel: str
    base_video_sha: str
    base_has_audio: bool
    audio: tuple[tuple[MuxAudioInput, MediaAsset], ...]
    subtitle_asset: MediaAsset | None
    subtitle_mode: str


def detect_base_audio(audio_inspector: AudioInspector, base_video: Path) -> bool:
    """Return whether ``base_video`` carries a usable audio stream.

    A convenience for computing ``base_has_audio`` from a real audio probe (an
    :class:`~ai_video_workflow.audio.inspect.FfprobeAudioInspector`). A
    "no audio stream" result maps to ``False``; a genuine TOOL failure (e.g.
    ffprobe missing) propagates rather than being silently treated as "silent",
    so a broken probe never quietly drops the original audio.
    """
    try:
        audio_inspector.probe(base_video)
        return True
    except AudioValidationError:
        return False


def audiovisual_manifest_path(project_root: Path, project_id: str) -> Path:
    return resolve_within_root(
        project_root, Path("manifests") / f"audiovisual-{project_id}.json"
    )


def _intent_path(project_root: Path, project_id: str, version: int) -> Path:
    return resolve_within_root(
        project_root,
        Path("records")
        / "step-intents"
        / "audiovisual"
        / project_id
        / f"{version}.json",
    )


def run_audiovisual_step(
    *,
    project_root: Path,
    project_id: str,
    base_video_relpath: str,
    profile: AudioVisualProfile,
    composer: AudioVisualComposer,
    inspector: MediaInspector,
    observed_at: datetime,
    base_has_audio: bool,
) -> AudioVisualStepOutcome:
    validate_stable_id(project_id, field_name="project_id")
    if not isinstance(profile, AudioVisualProfile):
        raise FieldTypeError("profile: expected an AudioVisualProfile")
    if not isinstance(composer, AudioVisualComposer):
        raise FieldTypeError("composer: expected an AudioVisualComposer")
    if not isinstance(inspector, MediaInspector):
        raise FieldTypeError("inspector: expected a MediaInspector")
    if not isinstance(base_has_audio, bool):
        raise FieldTypeError("base_has_audio: expected a bool")
    validate_utc_datetime(observed_at, field_name="observed_at")

    resolved = _resolve_inputs(
        project_root, base_video_relpath, profile, base_has_audio
    )
    input_entries = _input_entries(resolved, profile)
    input_digest = config_digest({"schema": _INPUT_SCHEMA, "inputs": input_entries})
    config_digest_value = av_profile_digest(profile)

    existing = _read_manifest(project_root, project_id)
    version = _select_version(existing, input_digest, config_digest_value)

    media_rel = f"outputs/final_av_v{version}.mp4"
    json_rel = f"reports/audiovisual/final_av_v{version}.json"
    md_rel = f"reports/audiovisual/final_av_v{version}.md"
    media_path = resolve_within_root(project_root, media_rel)

    if _is_noop(
        project_root,
        existing,
        input_digest,
        config_digest_value,
        project_id=project_id,
        resolved=resolved,
        profile=profile,
        input_entries=input_entries,
        version=version,
        media_rel=media_rel,
        json_rel=json_rel,
        md_rel=md_rel,
    ):
        _remove_intent(project_root, project_id, version)
        return AudioVisualStepOutcome(
            output_path=media_rel,
            version=version,
            manifest=existing,  # type: ignore[arg-type]
            report=_load_json(resolve_within_root(project_root, json_rel)),
            emitted_event_ids=(),
            skipped=True,
        )

    existing_intent = _read_intent(project_root, project_id, version)
    media_exists = media_path.exists()
    json_exists = resolve_within_root(project_root, json_rel).exists()

    # F: a report is present but the media is missing -> conflict
    if json_exists and not media_exists:
        raise CompositionConflictError(
            f"audiovisual: report present but final media missing: {media_rel}"
        )
    # C: a final mp4 exists with no matching intent -> conflict
    if media_exists and existing_intent is None:
        raise CompositionConflictError(
            f"audiovisual: final media exists with no matching intent: {media_rel}"
        )

    intent = {
        "schema_version": AV_INTENT_SCHEMA_VERSION,
        "project_id": project_id,
        "logical_version": version,
        "input_digest": input_digest,
        "profile_digest": config_digest_value,
        "media_path": media_rel,
        "json_report_path": json_rel,
        "markdown_report_path": md_rel,
    }
    _write_intent(project_root, project_id, version, intent)  # D: differing -> conflict

    effective_at = _existing_report_time(project_root, json_rel) or observed_at

    try:
        if media_exists:
            output_duration_ms = _inspect_final(inspector, media_path)
            output_sha = file_sha256(media_path)
        else:
            temp_final = _mux(
                project_root, resolved, profile, version, composer, inspector
            )
            output_duration_ms = _inspect_final(inspector, temp_final)
            output_sha = file_sha256(temp_final)
            # Publish the (potentially large) final by a streamed copy into
            # outputs/ — never read the whole MP4 into memory, and produce a file
            # independent of the mutable staging file.
            _publish_media_file(media_path, temp_final, output_sha)
    except (CompositionError, MediaToolNotAvailableError) as exc:
        # MediaToolNotAvailableError (ffmpeg/ffprobe absent) is NOT a
        # CompositionError, so it is caught explicitly here: a missing external
        # tool must still record a FAILED manifest, per this step's contract.
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
        resolved=resolved,
        profile=profile,
        input_entries=input_entries,
        version=version,
        media_rel=media_rel,
        output_sha=output_sha,
        output_duration_ms=output_duration_ms,
        config_digest_value=config_digest_value,
        input_digest=input_digest,
        observed_at=effective_at,
    )
    _publish_bytes(
        resolve_within_root(project_root, json_rel), _report_json_bytes(report)
    )
    _publish_bytes(
        resolve_within_root(project_root, md_rel), _report_markdown_bytes(report)
    )

    event = build_audiovisual_completed_event(
        project_id=project_id,
        output_path=media_rel,
        output_version=version,
        output_sha256=output_sha,
        base_video_path=resolved.base_video_rel,
        base_video_sha256=resolved.base_video_sha,
        audio_refs=tuple(
            (asset.media_kind, asset.ref, asset.version) for _, asset in resolved.audio
        ),
        subtitle_ref=(
            (
                resolved.subtitle_asset.ref,
                resolved.subtitle_asset.version,
                resolved.subtitle_mode,
            )
            if resolved.subtitle_asset is not None
            else None
        ),
        profile_digest=config_digest_value,
        occurred_at=effective_at,
        output_duration_ms=output_duration_ms,
    )
    append_event(project_root, event)

    manifest = StepManifest(
        step_name=f"audiovisual:{project_id}",
        input_digest=input_digest,
        relevant_config_digest=config_digest_value,
        status=ManifestStatus.COMPLETED,
        created_at=effective_at,
        output_paths=(media_rel, json_rel, md_rel),
        output_metadata={
            "output_version": version,
            "output_sha256": output_sha,
            "output_duration_ms": output_duration_ms,
            "audio_track_count": len(resolved.audio),
            "has_subtitles": resolved.subtitle_asset is not None,
        },
        completed_at=effective_at,
    )
    manifest_path = audiovisual_manifest_path(project_root, project_id)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    write_model_json(manifest_path, manifest, overwrite=True)

    _remove_intent(project_root, project_id, version)

    return AudioVisualStepOutcome(
        output_path=media_rel,
        version=version,
        manifest=manifest,
        report=report,
        emitted_event_ids=(event.event_id,),
        skipped=False,
    )


# --- input resolution --------------------------------------------------------


def _resolve_inputs(
    project_root: Path,
    base_video_relpath: str,
    profile: AudioVisualProfile,
    base_has_audio: bool,
) -> _ResolvedInput:
    if not (isinstance(base_video_relpath, str) and base_video_relpath.strip()):
        raise CompositionError("base_video_relpath must be a non-empty string")
    try:
        base_path = resolve_within_root(project_root, base_video_relpath)
    except PathEscapeError as exc:
        raise CompositionError(
            f"audiovisual: base video escapes the project root: {base_video_relpath!r}"
        ) from exc
    if not base_path.is_file():
        raise CompositionError(
            f"audiovisual: base video does not exist: {base_video_relpath!r}"
        )
    base_sha = file_sha256(base_path)

    audio: list[tuple[MuxAudioInput, MediaAsset]] = []
    for track in profile.tracks:
        # load_asset re-verifies the bound media file's digest + size (fail-closed)
        asset = load_asset(project_root, track.media_kind, track.ref, track.version)
        audio_path = resolve_within_root(project_root, asset.media_path)
        audio.append(
            (
                MuxAudioInput(path=audio_path, gain_db=track.gain_db, role=track.role),
                asset,
            )
        )

    subtitle_asset: MediaAsset | None = None
    subtitle_mode = SUBTITLE_MODE_NONE
    if profile.subtitles is not None:
        subtitle_asset = load_asset(
            project_root, "subtitle", profile.subtitles.ref, profile.subtitles.version
        )
        subtitle_mode = profile.subtitles.mode

    return _ResolvedInput(
        base_video_rel=base_video_relpath,
        base_video_sha=base_sha,
        base_has_audio=base_has_audio,
        audio=tuple(audio),
        subtitle_asset=subtitle_asset,
        subtitle_mode=subtitle_mode,
    )


def _input_entries(
    resolved: _ResolvedInput, profile: AudioVisualProfile
) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = [
        {
            "role": "base_video",
            "path": resolved.base_video_rel,
            "file_sha256": resolved.base_video_sha,
            "has_audio": resolved.base_has_audio,
        }
    ]
    for mux_input, asset in resolved.audio:
        entries.append(
            {
                "role": mux_input.role,
                "media_kind": asset.media_kind,
                "ref": asset.ref,
                "version": asset.version,
                "content_digest": asset.content_digest,
                "media_sha256": asset.media_sha256,
            }
        )
    if resolved.subtitle_asset is not None:
        entries.append(
            {
                "role": "subtitle",
                "media_kind": "subtitle",
                "ref": resolved.subtitle_asset.ref,
                "version": resolved.subtitle_asset.version,
                "content_digest": resolved.subtitle_asset.content_digest,
                "media_sha256": resolved.subtitle_asset.media_sha256,
                "mode": resolved.subtitle_mode,
            }
        )
    return entries


# --- version + no-op ---------------------------------------------------------


def _read_manifest(project_root: Path, project_id: str) -> StepManifest | None:
    path = audiovisual_manifest_path(project_root, project_id)
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
    return prev_version if same and prev_version else (prev_version + 1)


def _is_noop(
    project_root: Path,
    existing: StepManifest | None,
    input_digest: str,
    config_digest_value: str,
    *,
    project_id: str,
    resolved: _ResolvedInput,
    profile: AudioVisualProfile,
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
    observed = _existing_report_time(project_root, json_rel)
    if observed is None:
        return False
    if observed != existing.created_at or (
        existing.completed_at is not None and observed != existing.completed_at
    ):
        raise CompositionConflictError(
            "audiovisual: report observed_at drifted from the committed manifest time"
        )
    recorded_duration = existing.output_metadata.get("output_duration_ms")
    if not (recorded_duration is None or isinstance(recorded_duration, int)):
        return False
    rebuilt = _build_report(
        project_id=project_id,
        resolved=resolved,
        profile=profile,
        input_entries=input_entries,
        version=version,
        media_rel=media_rel,
        output_sha=recorded,
        output_duration_ms=recorded_duration,
        config_digest_value=config_digest_value,
        input_digest=input_digest,
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


# --- mux ---------------------------------------------------------------------


def _mux(
    project_root: Path,
    resolved: _ResolvedInput,
    profile: AudioVisualProfile,
    version: int,
    composer: AudioVisualComposer,
    inspector: MediaInspector,
) -> Path:
    staging_dir = resolve_within_root(
        project_root, Path("staging") / "audiovisual" / f"v{version}"
    )
    staging_dir.mkdir(parents=True, exist_ok=True)
    temp_final = staging_dir / "_final_av.mp4"
    if temp_final.exists():
        temp_final.unlink()

    base_abs = resolve_within_root(project_root, resolved.base_video_rel)
    # the output is capped to the base video's duration, so probe it up front
    # (a decode failure records a FAILED manifest via the caller's handler).
    base_duration = _probe_duration_seconds(inspector, base_abs)
    audio_inputs = tuple(
        MuxAudioInput(
            path=resolve_within_root(project_root, asset.media_path),
            gain_db=mux_input.gain_db,
            role=mux_input.role,
        )
        for mux_input, asset in resolved.audio
    )
    subtitle_abs = (
        resolve_within_root(project_root, resolved.subtitle_asset.media_path)
        if resolved.subtitle_asset is not None
        else None
    )
    plan = MuxPlan(
        base_video=base_abs,
        audio_inputs=audio_inputs,
        include_original_audio=profile.include_original_audio,
        original_audio_gain_db=profile.original_audio_gain_db,
        subtitle=subtitle_abs,
        subtitle_mode=resolved.subtitle_mode,
        audio_codec=profile.audio_codec,
        audio_bitrate_kbps=profile.audio_bitrate_kbps,
        subtitle_soft_codec=profile.subtitle_soft_codec,
        video_codec_burn_in=profile.video_codec_burn_in,
        base_has_audio=resolved.base_has_audio,
        base_duration_seconds=base_duration,
    )
    composer.mux(plan, temp_final)
    if not temp_final.is_file():
        raise CompositionToolError("audiovisual: mux produced no output file")

    # The audio/subtitle inputs are immutable, content-addressed media assets that
    # load_asset already digest-verified; the base video is the one MUTABLE input,
    # so re-hash it and refuse to publish if it changed under us during the mux.
    if file_sha256(base_abs) != resolved.base_video_sha:
        raise CompositionError(
            "audiovisual: base video changed during mux; refusing to publish"
        )
    return temp_final


def _inspect_final(inspector: MediaInspector, media_path: Path) -> int | None:
    try:
        probe = inspector.probe(media_path)
    except MediaInspectionError as exc:
        raise CompositionToolError(
            f"audiovisual: final media failed inspection: {media_path}"
        ) from exc
    return int(round(probe.duration_seconds * 1000))


def _probe_duration_seconds(inspector: MediaInspector, media_path: Path) -> float:
    try:
        probe = inspector.probe(media_path)
    except MediaInspectionError as exc:
        raise CompositionToolError(
            f"audiovisual: base video failed inspection: {media_path}"
        ) from exc
    return float(probe.duration_seconds)


# --- reports -----------------------------------------------------------------


def _build_report(
    *,
    project_id: str,
    resolved: _ResolvedInput,
    profile: AudioVisualProfile,
    input_entries: list[dict[str, object]],
    version: int,
    media_rel: str,
    output_sha: str,
    output_duration_ms: int | None,
    config_digest_value: str,
    input_digest: str,
    observed_at: datetime,
) -> dict[str, object]:
    return {
        "report_schema_version": AV_REPORT_SCHEMA_VERSION,
        "project_id": project_id,
        "output_path": media_rel,
        "output_kind": "audiovisual",
        "output_version": version,
        "output_sha256": output_sha,
        "output_duration_ms": output_duration_ms,
        "profile_digest": config_digest_value,
        "input_digest": input_digest,
        "subtitle_mode": resolved.subtitle_mode,
        "include_original_audio": profile.include_original_audio,
        "base_has_audio": resolved.base_has_audio,
        "observed_at": observed_at.isoformat(timespec="microseconds"),
        "inputs": input_entries,
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
        "# Audio-Visual Mux Report",
        "",
        f"- project_id: {report['project_id']}",
        f"- output_path: {report['output_path']}",
        f"- output_version: {report['output_version']}",
        f"- output_sha256: {report['output_sha256']}",
        f"- profile_digest: {report['profile_digest']}",
        f"- subtitle_mode: {report['subtitle_mode']}",
        f"- include_original_audio: {report['include_original_audio']}",
        f"- observed_at: {report['observed_at']}",
        "",
        "## Inputs",
        "",
        "| role | ref/path | version | digest |",
        "| --- | --- | --- | --- |",
    ]
    for entry in report["inputs"]:  # type: ignore[union-attr]
        role = entry.get("role")
        if role == "base_video":
            lines.append(
                f"| base_video | {entry.get('path')} | - | {entry.get('file_sha256')} |"
            )
        else:
            lines.append(
                f"| {role} | {entry.get('ref')} | {entry.get('version')} "
                f"| {entry.get('content_digest')} |"
            )
    lines.append("")
    return ("\n".join(lines) + "\n").encode("utf-8")


# --- intent + manifest + IO --------------------------------------------------


def _read_intent(
    project_root: Path, project_id: str, version: int
) -> dict[str, object] | None:
    path = _intent_path(project_root, project_id, version)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None
    try:
        obj = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise JsonDataError(f"audiovisual intent is not valid JSON: {path}") from exc
    if not isinstance(obj, dict) or frozenset(obj) != _INTENT_KEYS:
        raise JsonDataError(f"audiovisual intent has an unexpected key set: {path}")
    if obj["schema_version"] != AV_INTENT_SCHEMA_VERSION:
        raise JsonDataError(f"audiovisual intent schema_version unsupported: {path}")
    return obj


def _write_intent(
    project_root: Path, project_id: str, version: int, intent: dict[str, object]
) -> None:
    path = _intent_path(project_root, project_id, version)
    data = (
        json.dumps(
            intent, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False
        )
        + "\n"
    ).encode("utf-8")
    if path.exists():
        if path.read_bytes() == data:
            return
        raise CompositionConflictError(
            f"audiovisual intent conflicts with existing content: {path}"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_no_replace_write(path, data)


def _remove_intent(project_root: Path, project_id: str, version: int) -> None:
    try:
        _intent_path(project_root, project_id, version).unlink()
    except OSError:
        pass


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
        step_name=f"audiovisual:{project_id}",
        input_digest=input_digest,
        relevant_config_digest=config_digest_value,
        status=ManifestStatus.FAILED,
        created_at=created_at,
        output_paths=(),
        output_metadata={"output_version": version},
        completed_at=created_at,
        error_summary=error_summary[:500],
    )
    manifest_path = audiovisual_manifest_path(project_root, project_id)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    write_model_json(manifest_path, manifest, overwrite=True)


def _load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def _publish_media_file(dest: Path, src: Path, expected_sha: str) -> None:
    """Publish the large final media by a streamed, atomic no-replace copy.

    ``src`` (a staged, already-inspected+hashed file) is stream-copied in fixed
    chunks into a temp file in ``dest``'s directory, then atomically linked into
    place — so the whole MP4 is never read into memory, and the published master
    is an INDEPENDENT file (not a hard-link alias of the mutable staging file, so
    later staging writes cannot silently alter the immutable output). If ``dest``
    already exists it is a conflict UNLESS byte-identical (idempotent replay),
    verified by a streaming digest.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    raw_fd, tmp_name = tempfile.mkstemp(
        dir=dest.parent, prefix=f".{dest.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(raw_fd, "wb") as out, src.open("rb") as inp:
            while True:
                chunk = inp.read(_COPY_CHUNK_BYTES)
                if not chunk:
                    break
                out.write(chunk)
            out.flush()
            os.fsync(out.fileno())
        try:
            os.link(tmp, dest)
        except FileExistsError:
            if file_sha256(dest) == expected_sha:
                return
            raise CompositionConflictError(
                f"audiovisual: existing final has conflicting content: {dest}"
            ) from None
    except CompositionConflictError:
        raise
    except OSError as exc:
        raise CompositionError(
            f"audiovisual: unable to publish final media: {dest}"
        ) from exc
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _publish_bytes(path: Path, data: bytes) -> None:
    if path.exists():
        if path.read_bytes() == data:
            return
        raise CompositionConflictError(
            f"audiovisual: existing file has conflicting content: {path}"
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
                f"audiovisual: file appeared during publish: {path}"
            ) from exc
    except CompositionConflictError:
        raise
    except OSError as exc:
        raise CompositionError(f"audiovisual: unable to publish file: {path}") from exc
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

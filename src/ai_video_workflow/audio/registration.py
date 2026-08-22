"""Registration of user-provided voice-over / sfx / subtitle assets (TASK-008).

These are IMPORT-ONLY multimedia assets (never provider-generated): a user drops
a voice-over WAV, a sound-effect WAV or a subtitle SRT into the project and it is
registered as an immutable, versioned, digest-bound media asset via the frozen
TASK-035 :mod:`ai_video_workflow.media.assets` index (ADR-0038/0039 clause 9).
Reusing that index means audio/subtitle assets inherit the SAME identity, linear
versioning, anti-overwrite, content-digest self-verification and lineage rules as
every other media asset — no second asset system is invented.

Every import is validated fail-closed BEFORE it becomes a fact, and validated
against the EXACT bytes that get registered: the source file is read once, those
bytes are validated (voice-over/sfx must probe as structurally valid audio,
subtitle files must parse as valid SRT), and the same bytes are hashed and copied
into the immutable index-owned location — so a source file swapped mid-registration
can never sneak unvalidated bytes into the index. The asset ``ref`` is validated
before any path is built from it. Re-registering the byte-identical file for the
same ref is idempotent (the existing version is returned); registering a *changed*
file over an existing ref requires an explicit ``change_reason`` and produces a new
linear version — a silent overwrite is impossible (AGENTS.md 13).
"""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.audio.errors import AudioError
from ai_video_workflow.audio.inspect import (
    AudioInspector,
    AudioProbeResult,
    WavStructuralInspector,
)
from ai_video_workflow.audio.subtitle import (
    SubtitleValidationResult,
    validate_srt_bytes,
)
from ai_video_workflow.media.assets import (
    MediaAsset,
    build_asset,
    latest_version,
    load_asset,
    publish_asset,
)
from ai_video_workflow.media.provider import MEDIA_KIND_EXT
from ai_video_workflow.security.paths import PathEscapeError, resolve_within_root

VOICEOVER_KIND = "voiceover"
SFX_KIND = "sfx"
SUBTITLE_KIND = "subtitle"

# Index-owned, immutable in-project location for a registered import's bound file
# (never a pointer to the mutable user source). ADR-0001 eighth amendment.
IMPORTED_MEDIA_DIR = "media/imported"

# Defensive read caps: the source size is checked BEFORE the file is loaded into
# memory, so an implausibly large import is rejected rather than exhausting RAM.
MAX_AUDIO_IMPORT_BYTES = 512 * 1024 * 1024
MAX_SUBTITLE_IMPORT_BYTES = 32 * 1024 * 1024

# The asset ref grammar (identical to media/assets._REF_RE): no dots or slashes,
# so a ref can never introduce path traversal when interpolated into a path.
_REF_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


@dataclass(frozen=True, slots=True)
class AudioRegistration:
    """The registered audio asset plus its validated probe result."""

    asset: MediaAsset
    probe: AudioProbeResult


@dataclass(frozen=True, slots=True)
class SubtitleRegistration:
    """The registered subtitle asset plus its structural validation summary."""

    asset: MediaAsset
    validation: SubtitleValidationResult


def register_voiceover_asset(
    project_root: Path,
    *,
    ref: str,
    media_relpath: str,
    inspector: AudioInspector | None = None,
    input_refs: Sequence[Mapping] = (),
    change_reason: str | None = None,
    note: str = "user-provided voice-over",
) -> AudioRegistration:
    """Validate and register a voice-over audio file as an immutable asset."""
    _validate_ref(ref)
    data = _read_source(project_root, media_relpath, MAX_AUDIO_IMPORT_BYTES)
    probe = _probe_bytes(project_root, VOICEOVER_KIND, data, inspector)
    asset = _register_import(
        project_root,
        media_kind=VOICEOVER_KIND,
        ref=ref,
        data=data,
        input_refs=input_refs,
        note=note,
        change_reason=change_reason,
    )
    return AudioRegistration(asset=asset, probe=probe)


def register_sfx_asset(
    project_root: Path,
    *,
    ref: str,
    media_relpath: str,
    inspector: AudioInspector | None = None,
    input_refs: Sequence[Mapping] = (),
    change_reason: str | None = None,
    note: str = "user-provided sound effect",
) -> AudioRegistration:
    """Validate and register a sound-effect audio file as an immutable asset."""
    _validate_ref(ref)
    data = _read_source(project_root, media_relpath, MAX_AUDIO_IMPORT_BYTES)
    probe = _probe_bytes(project_root, SFX_KIND, data, inspector)
    asset = _register_import(
        project_root,
        media_kind=SFX_KIND,
        ref=ref,
        data=data,
        input_refs=input_refs,
        note=note,
        change_reason=change_reason,
    )
    return AudioRegistration(asset=asset, probe=probe)


def register_subtitle_asset(
    project_root: Path,
    *,
    ref: str,
    media_relpath: str,
    input_refs: Sequence[Mapping] = (),
    change_reason: str | None = None,
    note: str = "user-provided subtitles (SRT)",
) -> SubtitleRegistration:
    """Validate and register a subtitle (SRT) file as an immutable asset."""
    _validate_ref(ref)
    data = _read_source(project_root, media_relpath, MAX_SUBTITLE_IMPORT_BYTES)
    validation = validate_srt_bytes(data)  # validates the exact bytes registered
    asset = _register_import(
        project_root,
        media_kind=SUBTITLE_KIND,
        ref=ref,
        data=data,
        input_refs=input_refs,
        note=note,
        change_reason=change_reason,
    )
    return SubtitleRegistration(asset=asset, validation=validation)


# --- internals ---------------------------------------------------------------


def _validate_ref(ref: object) -> None:
    """Reject a bad ref BEFORE it is ever interpolated into a path."""
    if not (isinstance(ref, str) and _REF_RE.match(ref)):
        raise AudioError(f"invalid asset ref: {ref!r}")


def _read_source(project_root: Path, media_relpath: str, max_bytes: int) -> bytes:
    """Read the user's source file ONCE; those exact bytes are validated,
    hashed and copied, so a mid-registration swap cannot inject unvalidated
    content into the index. The size is checked BEFORE the read so an
    implausibly large import is rejected without loading it into memory."""
    if not (isinstance(media_relpath, str) and media_relpath.strip()):
        raise AudioError("media_relpath must be a non-empty string")
    try:
        path = resolve_within_root(project_root, media_relpath)
    except PathEscapeError as exc:
        raise AudioError(
            f"media_relpath escapes the project root: {media_relpath!r}"
        ) from exc
    if not path.is_file():
        raise AudioError(f"media file does not exist: {media_relpath!r}")
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise AudioError(f"media file is unreadable: {media_relpath!r}") from exc
    if size > max_bytes:
        raise AudioError(
            f"import is too large ({size} bytes > {max_bytes}): {media_relpath!r}"
        )
    try:
        # cap the read defensively too, in case the file grows between stat and
        # read; anything beyond the cap means the file changed and is refused.
        with path.open("rb") as stream:
            data = stream.read(max_bytes + 1)
    except OSError as exc:
        raise AudioError(f"media file is unreadable: {media_relpath!r}") from exc
    if len(data) > max_bytes:
        raise AudioError(f"import grew beyond the size cap: {media_relpath!r}")
    return data


def _probe_bytes(
    project_root: Path,
    media_kind: str,
    data: bytes,
    inspector: AudioInspector | None,
) -> AudioProbeResult:
    """Probe the exact ``data`` bytes by materializing them to a private temp
    file (the ffprobe inspector needs a real path); the temp is always removed."""
    ins = inspector or WavStructuralInspector()
    base = resolve_within_root(project_root, IMPORTED_MEDIA_DIR)
    base.mkdir(parents=True, exist_ok=True)
    ext = MEDIA_KIND_EXT.get(media_kind, "bin")
    raw_fd, tmp_name = tempfile.mkstemp(dir=base, prefix=".probe.", suffix=f".{ext}")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(raw_fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        return ins.probe(tmp)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _import_relpath(media_kind: str, ref: str, version: int) -> str:
    ext = MEDIA_KIND_EXT.get(media_kind, "bin")
    return f"{IMPORTED_MEDIA_DIR}/{media_kind}/{ref}_v{version}.{ext}"


def _write_immutable(project_root: Path, data: bytes, dest_relpath: str) -> None:
    """Write ``data`` to an immutable, versioned in-project file (create-only).

    The bound media file of a registered asset must persist unchanged even if the
    user later replaces or deletes their source file, so the import is stored at
    an index-owned path. An existing identical copy is reused; a conflicting copy
    is refused rather than overwritten.
    """
    dest = resolve_within_root(project_root, dest_relpath)
    if dest.exists():
        if dest.read_bytes() == data:
            return
        raise AudioError(
            f"an import copy already exists with different content: {dest_relpath}"
        )
    dest.parent.mkdir(parents=True, exist_ok=True)
    raw_fd, tmp_name = tempfile.mkstemp(
        dir=dest.parent, prefix=f".{dest.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(raw_fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(tmp, dest)
        except FileExistsError as exc:
            raise AudioError(
                f"import copy appeared during publish: {dest_relpath}"
            ) from exc
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _register_import(
    project_root: Path,
    *,
    media_kind: str,
    ref: str,
    data: bytes,
    input_refs: Sequence[Mapping],
    note: str,
    change_reason: str | None,
) -> MediaAsset:
    sha = hashlib.sha256(data).hexdigest()
    size = len(data)
    if size <= 0:
        raise AudioError("media file is empty")

    tip = latest_version(project_root, media_kind, ref)
    if tip is not None:
        existing = load_asset(project_root, media_kind, ref, tip)
        # Idempotency is defined on the BYTES alone (the stated contract): the
        # bound media file is content-addressed by its sha, so re-registering the
        # byte-identical import for the same ref returns the existing version and
        # never churns versions on incidental note/input_refs differences.
        if existing.media_sha256 == sha:
            return existing
        if not (isinstance(change_reason, str) and change_reason.strip()):
            raise AudioError(
                f"registering a changed {media_kind} over ref {ref!r} "
                "requires a change_reason"
            )
        version = tip + 1
        parent_version: int | None = tip
    else:
        if change_reason is not None:
            raise AudioError(
                f"change_reason is only allowed for a new version of {ref!r}"
            )
        version = 1
        parent_version = None

    dest_relpath = _import_relpath(media_kind, ref, version)
    _write_immutable(project_root, data, dest_relpath)
    asset = build_asset(
        media_kind=media_kind,
        ref=ref,
        version=version,
        producer={"source": "external", "note": note},
        media_path=dest_relpath,
        media_sha256=sha,
        size_bytes=size,
        input_refs=input_refs,
        parent_version=parent_version,
        change_reason=change_reason,
    )
    publish_asset(project_root, asset)
    return asset

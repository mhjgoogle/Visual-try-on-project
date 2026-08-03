"""Generation batch + selection records (TASK-035 / ADR-0038).

A generation operation produces a BATCH that retains ALL candidate results
(``media/batches/<batch_id>.json``); a user SELECTION references exactly one
candidate (``media/selections/<selection_id>.json``) and never deletes the
unselected ones (ADR-0038 P6). Both are immutable create-only records. The
selected candidate is later published as a formal :class:`~.assets.MediaAsset`
whose ``batch_id`` points back here, giving the candidate → selection → consumer
lineage the Workspace rebuilds from authoritative records.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.digests import config_digest, file_sha256
from ai_video_workflow.errors import OverwriteRefusedError
from ai_video_workflow.media.errors import (
    MediaError,
    MediaNotFoundError,
    MediaValidationError,
)
from ai_video_workflow.security.paths import PathEscapeError, resolve_within_root

MEDIA_BATCHES_DIR = "media/batches"
MEDIA_SELECTIONS_DIR = "media/selections"
BATCH_SCHEMA_VERSION = 1
SELECTION_SCHEMA_VERSION = 1

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class Candidate:
    """One retained candidate result in a batch."""

    candidate_id: str
    staging_path: str
    media_sha256: str
    size_bytes: int

    def to_dict(self) -> dict:
        return {
            "candidate_id": self.candidate_id,
            "staging_path": self.staging_path,
            "media_sha256": self.media_sha256,
            "size_bytes": self.size_bytes,
        }


@dataclass(frozen=True, slots=True)
class GenerationBatch:
    """An immutable batch retaining all candidate results of one operation."""

    schema_version: int
    batch_id: str
    operation_id: str
    provider_id: str
    model_id: str
    capability: str
    media_kind: str
    prompt: str
    parameters: Mapping[str, object]
    candidates: tuple[Candidate, ...]
    input_refs: tuple[Mapping[str, object], ...] = ()

    def _identity(self) -> dict:
        return {
            "schema_version": self.schema_version,
            "batch_id": self.batch_id,
            "operation_id": self.operation_id,
            "provider_id": self.provider_id,
            "model_id": self.model_id,
            "capability": self.capability,
            "media_kind": self.media_kind,
            "prompt": self.prompt,
            "parameters": dict(self.parameters),
            "candidates": [c.to_dict() for c in self.candidates],
            "input_refs": [dict(r) for r in self.input_refs],
        }

    @property
    def content_digest(self) -> str:
        return config_digest(self._identity())

    def to_dict(self) -> dict:
        data = self._identity()
        data["content_digest"] = self.content_digest
        return data

    def candidate(self, candidate_id: str) -> Candidate:
        for c in self.candidates:
            if c.candidate_id == candidate_id:
                return c
        raise MediaNotFoundError(
            f"candidate {candidate_id!r} not in batch {self.batch_id!r}"
        )


@dataclass(frozen=True, slots=True)
class Selection:
    """An immutable user selection of exactly one batch candidate."""

    schema_version: int
    selection_id: str
    batch_id: str
    selected_candidate_id: str
    actor: str
    rationale: str

    def _identity(self) -> dict:
        return {
            "schema_version": self.schema_version,
            "selection_id": self.selection_id,
            "batch_id": self.batch_id,
            "selected_candidate_id": self.selected_candidate_id,
            "actor": self.actor,
            "rationale": self.rationale,
        }

    @property
    def content_digest(self) -> str:
        return config_digest(self._identity())

    def to_dict(self) -> dict:
        data = self._identity()
        data["content_digest"] = self.content_digest
        return data


def build_batch(
    *,
    batch_id: str,
    operation_id: str,
    provider_id: str,
    model_id: str,
    capability: str,
    media_kind: str,
    prompt: str,
    candidates: Sequence[Mapping],
    parameters: Mapping[str, object] = {},
    input_refs: Sequence[Mapping] = (),
) -> GenerationBatch:
    from ai_video_workflow.media.assets import _parse_input_ref
    from ai_video_workflow.media.provider import (
        MEDIA_CAPABILITIES,
        MEDIA_KIND_EXT,
        MEDIA_KINDS,
        capability_allows_kind,
    )

    for name, value in (
        ("batch_id", batch_id),
        ("operation_id", operation_id),
        ("provider_id", provider_id),
        ("model_id", model_id),
    ):
        if not (isinstance(value, str) and _ID_RE.match(value)):
            raise MediaError(f"{name} invalid: {value!r}")
    if capability not in MEDIA_CAPABILITIES:
        raise MediaValidationError(f"unknown media capability: {capability!r}")
    if media_kind not in MEDIA_KINDS:
        raise MediaValidationError(f"unknown media kind: {media_kind!r}")
    if not capability_allows_kind(capability, media_kind):
        raise MediaValidationError(
            f"capability {capability!r} cannot produce media kind {media_kind!r}"
        )
    if not (isinstance(prompt, str) and prompt.strip()):
        raise MediaValidationError("prompt must be a non-empty string")
    if not isinstance(parameters, Mapping):
        raise MediaValidationError("parameters must be an object")
    parsed = tuple(_parse_candidate(c) for c in candidates)
    if not parsed:
        raise MediaValidationError("a batch must retain at least one candidate")
    ids = [c.candidate_id for c in parsed]
    if len(set(ids)) != len(ids):
        raise MediaValidationError("candidate ids must be unique within a batch")
    # Every candidate must sit at its CANONICAL staging path so a forged batch
    # can never reference an arbitrary in-project file as a candidate.
    ext = MEDIA_KIND_EXT[media_kind]
    for c in parsed:
        expected = f"staging/media/{batch_id}/{c.candidate_id}.{ext}"
        if c.staging_path != expected:
            raise MediaValidationError(
                f"candidate {c.candidate_id!r} staging_path must be {expected!r}"
            )
    # Validate each declared generation input's shape (resolution happens when
    # the selected candidate is promoted to a formal asset).
    parsed_inputs = tuple(_parse_input_ref(r).to_dict() for r in input_refs)
    return GenerationBatch(
        schema_version=BATCH_SCHEMA_VERSION,
        batch_id=batch_id,
        operation_id=operation_id,
        provider_id=provider_id,
        model_id=model_id,
        capability=capability,
        media_kind=media_kind,
        prompt=prompt,
        parameters=dict(parameters),
        candidates=parsed,
        input_refs=parsed_inputs,
    )


def publish_batch(project_root: Path, batch: GenerationBatch) -> Path:
    return _publish_json(
        project_root, f"{MEDIA_BATCHES_DIR}/{batch.batch_id}.json", batch.to_dict()
    )


def load_batch(project_root: Path, batch_id: str) -> GenerationBatch:
    if not _ID_RE.match(batch_id):
        raise MediaError(f"invalid batch_id: {batch_id!r}")
    raw = _load_json(project_root, f"{MEDIA_BATCHES_DIR}/{batch_id}.json", "batch")
    if not isinstance(raw, dict) or raw.get("schema_version") != BATCH_SCHEMA_VERSION:
        raise MediaError("unsupported or malformed batch record")
    if raw.get("batch_id") != batch_id:
        raise MediaValidationError("batch_id does not match its record path")
    try:
        batch = build_batch(
            batch_id=raw["batch_id"],
            operation_id=raw["operation_id"],
            provider_id=raw["provider_id"],
            model_id=raw["model_id"],
            capability=raw["capability"],
            media_kind=raw["media_kind"],
            prompt=raw["prompt"],
            candidates=raw["candidates"],
            parameters=raw.get("parameters", {}),
            input_refs=raw.get("input_refs", ()),
        )
    except KeyError as exc:
        raise MediaError(f"batch missing field: {exc.args[0]!r}") from exc
    if raw.get("content_digest") != batch.content_digest:
        raise MediaValidationError(
            "batch content_digest mismatch: record tampered or corrupt"
        )
    # Verify each candidate's staged file exists and its digest/size match the
    # record — a tampered batch cannot claim a candidate that isn't really there.
    for c in batch.candidates:
        try:
            path = resolve_within_root(project_root, c.staging_path)
        except PathEscapeError as exc:
            raise MediaValidationError(str(exc)) from exc
        if not path.is_file():
            raise MediaValidationError(
                f"candidate {c.candidate_id!r} staged file is missing"
            )
        if file_sha256(path) != c.media_sha256 or path.stat().st_size != c.size_bytes:
            raise MediaValidationError(
                f"candidate {c.candidate_id!r} staged file does not match the record"
            )
    return batch


def record_selection(
    project_root: Path,
    *,
    selection_id: str,
    batch_id: str,
    selected_candidate_id: str,
    actor: str = "user",
    rationale: str = "",
) -> Selection:
    """Record a user selection; the batch (with all candidates) is unchanged."""
    if not _ID_RE.match(selection_id):
        raise MediaError(f"invalid selection_id: {selection_id!r}")
    if actor != "user":
        raise MediaValidationError("a selection is the user's; actor must be 'user'")
    batch = load_batch(project_root, batch_id)  # must exist
    batch.candidate(selected_candidate_id)  # must be a real candidate
    selection = Selection(
        schema_version=SELECTION_SCHEMA_VERSION,
        selection_id=selection_id,
        batch_id=batch_id,
        selected_candidate_id=selected_candidate_id,
        actor=actor,
        rationale=rationale if isinstance(rationale, str) else "",
    )
    _publish_json(
        project_root, f"{MEDIA_SELECTIONS_DIR}/{selection_id}.json", selection.to_dict()
    )
    return selection


def load_selection(project_root: Path, selection_id: str) -> Selection:
    if not _ID_RE.match(selection_id):
        raise MediaError(f"invalid selection_id: {selection_id!r}")
    raw = _load_json(
        project_root, f"{MEDIA_SELECTIONS_DIR}/{selection_id}.json", "selection"
    )
    if (
        not isinstance(raw, dict)
        or raw.get("schema_version") != SELECTION_SCHEMA_VERSION
    ):
        raise MediaError("unsupported or malformed selection record")
    try:
        rec_selection_id = raw["selection_id"]
        batch_id = raw["batch_id"]
        candidate_id = raw["selected_candidate_id"]
        actor = raw["actor"]
    except KeyError as exc:
        raise MediaError(f"selection missing field: {exc.args[0]!r}") from exc
    # Re-validate the persisted invariant on load: ids well-formed, actor is the
    # user, and the selected candidate really belongs to the referenced batch —
    # a corrupted record cannot bypass the user-selection contract on promotion.
    for name, value in (
        ("selection_id", rec_selection_id),
        ("batch_id", batch_id),
        ("selected_candidate_id", candidate_id),
    ):
        if not (isinstance(value, str) and _ID_RE.match(value)):
            raise MediaValidationError(f"selection {name} invalid: {value!r}")
    if rec_selection_id != selection_id:
        raise MediaValidationError("selection_id does not match its record path")
    if actor != "user":
        raise MediaValidationError("a selection's actor must be 'user'")
    load_batch(project_root, batch_id).candidate(candidate_id)  # membership
    selection = Selection(
        schema_version=SELECTION_SCHEMA_VERSION,
        selection_id=rec_selection_id,
        batch_id=batch_id,
        selected_candidate_id=candidate_id,
        actor=actor,
        rationale=raw.get("rationale", "")
        if isinstance(raw.get("rationale"), str)
        else "",
    )
    if raw.get("content_digest") != selection.content_digest:
        raise MediaValidationError(
            "selection content_digest mismatch: record tampered or corrupt"
        )
    return selection


# --- internals ---------------------------------------------------------------


def _parse_candidate(raw: object) -> Candidate:
    if not isinstance(raw, Mapping):
        raise MediaError("candidate must be an object")
    cid = raw.get("candidate_id")
    staging = raw.get("staging_path")
    digest = raw.get("media_sha256")
    size = raw.get("size_bytes")
    if not (isinstance(cid, str) and _ID_RE.match(cid)):
        raise MediaError(f"candidate.candidate_id invalid: {cid!r}")
    if not (isinstance(staging, str) and staging.strip()):
        raise MediaError("candidate.staging_path must be a non-empty string")
    if not (isinstance(digest, str) and _SHA256_RE.match(digest)):
        raise MediaError(f"candidate.media_sha256 invalid: {digest!r}")
    if not (isinstance(size, int) and not isinstance(size, bool) and size > 0):
        raise MediaError(f"candidate.size_bytes invalid: {size!r}")
    return Candidate(cid, staging, digest, size)


def _load_json(project_root: Path, relpath: str, what: str) -> object:
    path = resolve_within_root(project_root, relpath)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise MediaNotFoundError(f"{what} does not exist: {path}") from exc
    except (OSError, UnicodeError) as exc:
        raise MediaError(f"unable to read {what}: {path}") from exc
    try:
        return json.loads(text)
    except ValueError as exc:
        raise MediaError(f"{what} is not valid JSON: {path}") from exc


def _publish_json(project_root: Path, relpath: str, payload_dict: dict) -> Path:
    path = resolve_within_root(project_root, relpath)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (
        json.dumps(
            payload_dict, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False
        )
        + "\n"
    ).encode("utf-8")
    raw_fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(raw_fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(tmp, path)
        except FileExistsError as exc:
            raise OverwriteRefusedError(f"refusing to overwrite: {path}") from exc
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    return path

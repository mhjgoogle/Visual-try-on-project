"""The WFM2 multimedia asset identity + lineage index (TASK-035 / ADR-0038).

Every formal media version (reference / master / keyframe / generated image /
audio generation) is a fact only through a structured index at
``media/assets/<media_kind>/<ref>_v<N>.json`` (ADR-0001 seventh amendment). It
carries a stable ``ref`` + immutable linear ``version`` + ``content_digest``, the
producer (a generation operation with provider/model/parameters, or a manual /
external import), fully-qualified ``input_refs`` (media OR creative domain, each
resolved and digest-verified at publish), an optional ``batch_id``, and the bound
media file's ``media_path`` + ``media_sha256`` (re-verified on load). Publish is
create-only and immutable; a revision is a new linear version with parent +
reason. Providers never write this — an authorized writer publishes it. Signed /
temporary URLs are never an identity.
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
from ai_video_workflow.media.provider import MEDIA_KINDS
from ai_video_workflow.security.paths import PathEscapeError, resolve_within_root

MEDIA_ASSETS_DIR = "media/assets"
MEDIA_ASSET_SCHEMA_VERSION = 1

_REF_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PRODUCER_SOURCES = frozenset({"generation", "manual", "external"})


@dataclass(frozen=True, slots=True)
class MediaInputRef:
    """A precise, digest-bound reference to an upstream fact.

    ``domain`` is ``media`` (an upstream media asset, keyed by ``container`` =
    media_kind) or ``creative`` (an ADR-0037 creative artifact, keyed by
    ``container`` = stage). Both are resolved and digest-verified at publish.
    """

    domain: str
    container: str
    ref: str
    version: int
    content_digest: str

    def to_dict(self) -> dict:
        return {
            "domain": self.domain,
            "container": self.container,
            "ref": self.ref,
            "version": self.version,
            "content_digest": self.content_digest,
        }


@dataclass(frozen=True, slots=True)
class MediaAsset:
    """One formal media asset index version."""

    schema_version: int
    media_kind: str
    ref: str
    version: int
    producer: Mapping[str, object]
    input_refs: tuple[MediaInputRef, ...]
    batch_id: str | None
    media_path: str
    media_sha256: str
    size_bytes: int
    parent_version: int | None
    change_reason: str | None

    def _identity_dict(self) -> dict:
        return {
            "schema_version": self.schema_version,
            "media_kind": self.media_kind,
            "ref": self.ref,
            "version": self.version,
            "producer": dict(self.producer),
            "input_refs": [r.to_dict() for r in self.input_refs],
            "batch_id": self.batch_id,
            "media_path": self.media_path,
            "media_sha256": self.media_sha256,
            "size_bytes": self.size_bytes,
            "parent_version": self.parent_version,
            "change_reason": self.change_reason,
        }

    @property
    def content_digest(self) -> str:
        return config_digest(self._identity_dict())

    def to_dict(self) -> dict:
        data = self._identity_dict()
        data["content_digest"] = self.content_digest
        return data

    def as_input_ref(self) -> MediaInputRef:
        return MediaInputRef(
            "media", self.media_kind, self.ref, self.version, self.content_digest
        )


def asset_relpath(media_kind: str, ref: str, version: int) -> str:
    _require_kind(media_kind)
    if not _REF_RE.match(ref):
        raise MediaError(f"invalid media ref: {ref!r}")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise MediaError(f"invalid media version: {version!r}")
    return f"{MEDIA_ASSETS_DIR}/{media_kind}/{ref}_v{version}.json"


def build_asset(
    *,
    media_kind: str,
    ref: str,
    version: int,
    producer: Mapping[str, object],
    media_path: str,
    media_sha256: str,
    size_bytes: int,
    input_refs: Sequence[Mapping] = (),
    batch_id: str | None = None,
    parent_version: int | None = None,
    change_reason: str | None = None,
) -> MediaAsset:
    """Validate and construct a :class:`MediaAsset` (no IO)."""
    _require_kind(media_kind)
    if not _REF_RE.match(ref):
        raise MediaError(f"invalid media ref: {ref!r}")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise MediaError(f"invalid version: {version!r}")
    if version > 1 and parent_version is None:
        raise MediaError(f"version {version} requires a parent_version + change_reason")
    if parent_version is not None:
        if (
            not isinstance(parent_version, int)
            or isinstance(parent_version, bool)
            or parent_version < 1
            or parent_version >= version
        ):
            raise MediaError(f"parent_version {parent_version!r} must be < {version}")
        if not (isinstance(change_reason, str) and change_reason.strip()):
            raise MediaError("change_reason is required when parent_version is set")
    elif change_reason is not None:
        raise MediaError("change_reason is only allowed when parent_version is set")

    if not (isinstance(media_sha256, str) and _SHA256_RE.match(media_sha256)):
        raise MediaError(f"media_sha256 must be a sha256 hex digest: {media_sha256!r}")
    if not (
        isinstance(size_bytes, int)
        and not isinstance(size_bytes, bool)
        and size_bytes > 0
    ):
        raise MediaError(f"size_bytes must be a positive int: {size_bytes!r}")
    if not (isinstance(media_path, str) and media_path.strip()):
        raise MediaError("media_path must be a non-empty string")
    if batch_id is not None and not (isinstance(batch_id, str) and batch_id):
        raise MediaError("batch_id must be a non-empty string when set")

    return MediaAsset(
        schema_version=MEDIA_ASSET_SCHEMA_VERSION,
        media_kind=media_kind,
        ref=ref,
        version=version,
        producer=_validate_producer(producer),
        input_refs=tuple(_parse_input_ref(r) for r in input_refs),
        batch_id=batch_id,
        media_path=media_path,
        media_sha256=media_sha256,
        size_bytes=size_bytes,
        parent_version=parent_version,
        change_reason=change_reason,
    )


def publish_asset(project_root: Path, asset: MediaAsset) -> Path:
    """Publish an immutable media asset version, fail-closed on every check."""
    # linear chain
    tip = latest_version(project_root, asset.media_kind, asset.ref)
    if tip is None:
        if asset.version != 1 or asset.parent_version is not None:
            raise MediaValidationError(
                f"first version of {asset.ref!r} must be v1 with no parent"
            )
    else:
        if asset.version != tip + 1 or asset.parent_version != tip:
            raise MediaValidationError(
                f"next version of {asset.ref!r} must be v{tip + 1} parenting v{tip}"
            )
        load_asset(project_root, asset.media_kind, asset.ref, tip)  # parent must load
    # bound media file must exist with the exact digest + size
    _verify_media_file(project_root, asset)
    # every declared input must resolve + digest-match (media or creative domain)
    for iref in asset.input_refs:
        _resolve_input(project_root, iref)
    # a generation asset must prove its batch + user selection provenance
    if asset.producer.get("source") == "generation":
        _verify_generation_provenance(project_root, asset)

    return _publish_json(
        project_root,
        asset_relpath(asset.media_kind, asset.ref, asset.version),
        asset.to_dict(),
    )


def load_asset(
    project_root: Path, media_kind: str, ref: str, version: int
) -> MediaAsset:
    relpath = asset_relpath(media_kind, ref, version)
    path = resolve_within_root(project_root, relpath)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise MediaNotFoundError(f"media asset does not exist: {path}") from exc
    except (OSError, UnicodeError) as exc:
        raise MediaError(f"unable to read media asset: {path}") from exc
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise MediaError(f"media asset is not valid JSON: {path}") from exc
    asset = asset_from_dict(raw, expected=(media_kind, ref, version))
    _verify_media_file(project_root, asset)  # re-verify bound media on load
    return asset


def latest_version(project_root: Path, media_kind: str, ref: str) -> int | None:
    _require_kind(media_kind)
    if not _REF_RE.match(ref):
        raise MediaError(f"invalid media ref: {ref!r}")
    try:
        base = resolve_within_root(project_root, f"{MEDIA_ASSETS_DIR}/{media_kind}")
    except PathEscapeError as exc:  # pragma: no cover - defensive
        raise MediaError(str(exc)) from exc
    if not base.is_dir():
        return None
    name_re = re.compile(rf"^{re.escape(ref)}_v([1-9][0-9]*)\.json$")
    versions = [int(m.group(1)) for p in base.iterdir() if (m := name_re.match(p.name))]
    return max(versions) if versions else None


def load_latest(project_root: Path, media_kind: str, ref: str) -> MediaAsset | None:
    version = latest_version(project_root, media_kind, ref)
    if version is None:
        return None
    return load_asset(project_root, media_kind, ref, version)


def assets_of_kind(project_root: Path, media_kind: str) -> tuple[MediaAsset, ...]:
    """Latest version of every distinct ref of ``media_kind`` (any ref)."""
    _require_kind(media_kind)
    try:
        base = resolve_within_root(project_root, f"{MEDIA_ASSETS_DIR}/{media_kind}")
    except PathEscapeError as exc:  # pragma: no cover - defensive
        raise MediaError(str(exc)) from exc
    if not base.is_dir():
        return ()
    name_re = re.compile(r"^(?P<ref>.+)_v([1-9][0-9]*)\.json$")
    latest: dict[str, int] = {}
    for p in base.iterdir():
        m = name_re.match(p.name)
        if m:
            latest[m.group("ref")] = max(latest.get(m.group("ref"), 0), int(m.group(2)))
    return tuple(
        load_asset(project_root, media_kind, ref, v)
        for ref, v in sorted(latest.items())
    )


def asset_from_dict(
    raw: object, *, expected: tuple[str, str, int] | None = None
) -> MediaAsset:
    if not isinstance(raw, dict):
        raise MediaError("media asset must be a JSON object")
    if raw.get("schema_version") != MEDIA_ASSET_SCHEMA_VERSION:
        raise MediaError(
            f"unsupported media schema_version: {raw.get('schema_version')!r}"
        )
    stored = raw.get("content_digest")
    try:
        asset = build_asset(
            media_kind=raw["media_kind"],
            ref=raw["ref"],
            version=raw["version"],
            producer=raw["producer"],
            media_path=raw["media_path"],
            media_sha256=raw["media_sha256"],
            size_bytes=raw["size_bytes"],
            input_refs=raw.get("input_refs") or (),
            batch_id=raw.get("batch_id"),
            parent_version=raw.get("parent_version"),
            change_reason=raw.get("change_reason"),
        )
    except KeyError as exc:
        raise MediaError(f"media asset missing field: {exc.args[0]!r}") from exc
    if stored != asset.content_digest:
        raise MediaValidationError(
            f"media asset content_digest mismatch for {asset.ref!r} v{asset.version}"
        )
    if (
        expected is not None
        and (asset.media_kind, asset.ref, asset.version) != expected
    ):
        raise MediaValidationError("media asset identity does not match its path")
    return asset


# --- internals ---------------------------------------------------------------


def _require_kind(media_kind: object) -> None:
    if media_kind not in MEDIA_KINDS:
        raise MediaError(f"unknown media kind: {media_kind!r}")


def _validate_producer(raw: object) -> dict:
    if not isinstance(raw, Mapping):
        raise MediaError("producer must be an object")
    source = raw.get("source")
    if source not in _PRODUCER_SOURCES:
        raise MediaError(f"producer.source invalid: {source!r}")
    out: dict[str, object] = {"source": source}
    if source == "generation":
        # selection_id + candidate_id make a generated asset trace to the exact
        # user selection that authorized it (a batch may have several selections).
        for key in (
            "operation_id",
            "provider_id",
            "model_id",
            "selection_id",
            "candidate_id",
        ):
            val = raw.get(key)
            if not (isinstance(val, str) and val):
                raise MediaError(f"producer.{key} required for generation")
            out[key] = val
        params = raw.get("parameters", {})
        if not isinstance(params, Mapping):
            raise MediaError("producer.parameters must be an object")
        out["parameters"] = dict(params)
    else:
        note = raw.get("note", "")
        if not isinstance(note, str):
            raise MediaError("producer.note must be a string")
        out["note"] = note
    return out


def _parse_input_ref(raw: object) -> MediaInputRef:
    if not isinstance(raw, Mapping):
        raise MediaError("input_ref must be an object")
    domain = raw.get("domain")
    container = raw.get("container")
    ref = raw.get("ref")
    version = raw.get("version")
    digest = raw.get("content_digest")
    if domain not in ("media", "creative"):
        raise MediaError(f"input_ref.domain invalid: {domain!r}")
    if not (isinstance(container, str) and container):
        raise MediaError(f"input_ref.container invalid: {container!r}")
    if not (isinstance(ref, str) and _REF_RE.match(ref)):
        raise MediaError(f"input_ref.ref invalid: {ref!r}")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise MediaError(f"input_ref.version invalid: {version!r}")
    if not (isinstance(digest, str) and _SHA256_RE.match(digest)):
        raise MediaError(f"input_ref.content_digest invalid: {digest!r}")
    return MediaInputRef(domain, container, ref, version, digest)


def _resolve_input(project_root: Path, iref: MediaInputRef) -> None:
    """Resolve an input ref to a real published fact with a matching digest."""
    if iref.domain == "media":
        try:
            upstream = load_asset(project_root, iref.container, iref.ref, iref.version)
        except MediaNotFoundError as exc:
            raise MediaValidationError(
                f"input media {iref.container}/{iref.ref} v{iref.version} "
                "does not exist"
            ) from exc
        actual = upstream.content_digest
    else:  # creative
        from ai_video_workflow.creative import index as creative_index

        try:
            upstream = creative_index.load_artifact(
                project_root, iref.container, iref.ref, iref.version
            )
        except Exception as exc:  # noqa: BLE001 - any creative load failure fails closed
            raise MediaValidationError(
                f"input creative {iref.container}/{iref.ref} v{iref.version} "
                f"does not resolve: {type(exc).__name__}"
            ) from exc
        actual = upstream.content_digest
    if actual != iref.content_digest:
        raise MediaValidationError(
            f"input {iref.domain} {iref.container}/{iref.ref} v{iref.version} digest "
            "does not match (forged or stale lineage)"
        )


def _verify_generation_provenance(project_root: Path, asset: MediaAsset) -> None:
    """Cross-check a generation asset against the persisted batch + selection.

    A generated asset can only claim to be user-selected if its batch and
    selection records actually exist, the selection belongs to that batch and
    names the producer's candidate, the bound media IS that candidate's staged
    file, and the producer's operation/provider/model match the batch. This
    prevents publishing a forged "user-selected" generated asset.
    """
    from ai_video_workflow.media.batch import load_batch, load_selection

    prod = asset.producer
    if asset.batch_id is None:
        raise MediaValidationError("a generation asset must carry a batch_id")
    batch = load_batch(project_root, asset.batch_id)  # exists + id-match
    selection = load_selection(project_root, str(prod["selection_id"]))
    if selection.batch_id != asset.batch_id:
        raise MediaValidationError("selection does not belong to the asset's batch")
    if selection.selected_candidate_id != prod["candidate_id"]:
        raise MediaValidationError("producer candidate does not match the selection")
    candidate = batch.candidate(str(prod["candidate_id"]))
    if (
        asset.media_path != candidate.staging_path
        or asset.media_sha256 != candidate.media_sha256
        or asset.size_bytes != candidate.size_bytes
    ):
        raise MediaValidationError(
            "asset media does not match the selected candidate's staged file"
        )
    if (
        prod.get("operation_id") != batch.operation_id
        or prod.get("provider_id") != batch.provider_id
        or prod.get("model_id") != batch.model_id
    ):
        raise MediaValidationError("producer generation fields do not match the batch")
    if dict(prod.get("parameters") or {}) != dict(batch.parameters):
        raise MediaValidationError("producer parameters do not match the batch")
    # every input the batch declared for the generation must survive on the asset
    asset_refs = {_ref_key(r.to_dict()) for r in asset.input_refs}
    for bref in batch.input_refs:
        if _ref_key(dict(bref)) not in asset_refs:
            raise MediaValidationError(
                "asset drops or alters a batch-declared generation input ref"
            )


def _ref_key(ref: Mapping) -> tuple:
    return tuple(sorted((str(k), str(v)) for k, v in ref.items()))


def _verify_media_file(project_root: Path, asset: MediaAsset) -> None:
    try:
        media_path = resolve_within_root(project_root, asset.media_path)
    except PathEscapeError as exc:
        raise MediaValidationError(
            f"media_path escapes the project root: {asset.media_path!r}"
        ) from exc
    if not media_path.is_file():
        raise MediaValidationError(f"media file does not exist: {asset.media_path!r}")
    if file_sha256(media_path) != asset.media_sha256:
        raise MediaValidationError(
            f"media file digest mismatch for {asset.ref!r}: content changed "
            "without a new asset version"
        )
    if media_path.stat().st_size != asset.size_bytes:
        raise MediaValidationError(
            f"media file size mismatch for {asset.ref!r} (declared {asset.size_bytes})"
        )


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
            raise OverwriteRefusedError(
                f"refusing to overwrite existing media asset: {path}"
            ) from exc
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    return path

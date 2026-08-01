"""Account-level reusable asset packs and project reuse references (TASK-018).

A reusable asset (character, scene, prop, or style) is published to the
account-level read-only pack as an **immutable version document** at
``reuse/<asset_id>/v<N>.json`` (ADR-0011). A project references it from
``profile/reuse_refs.json`` by ``asset_id + version + content_digest`` —
never a mutable "latest" — so publishing a newer version can never
silently change what an older project consumes.

Resolution is fail-closed: a missing pack version, a version mismatch,
or a content-digest drift is a typed ``ReuseRefError``. All paths are
containment-checked; ``asset_id`` must be a safe single path component.

The account root follows the existing normative rule (TASK-014 contract
4 / ADR-0001 WFM1 amendment): the parent directory of project roots.
``reuse/`` carries no ``config/wfm1.json``, so the budget layer's
project discovery skips it and the monthly-ledger semantics are
untouched.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.digests import config_digest
from ai_video_workflow.errors import OverwriteRefusedError
from ai_video_workflow.profile.errors import ReuseError, ReuseRefError
from ai_video_workflow.security.paths import resolve_within_root

REUSE_DIR = "reuse"
REUSE_PACK_SCHEMA_VERSION = 1
REUSE_REFS_RELPATH = "profile/reuse_refs.json"
REUSE_REFS_SCHEMA_VERSION = 1

REUSE_KINDS = frozenset({"character", "scene", "prop", "style"})

_PACK_KEYS = frozenset({"schema_version", "asset_id", "version", "kind", "content"})
_REFS_KEYS = frozenset({"schema_version", "refs"})
_REF_KEYS = frozenset({"asset_id", "version", "content_digest"})
_SHA256_LEN = 64


@dataclass(frozen=True, slots=True)
class ReuseAssetVersion:
    """One immutable published version of a reusable asset."""

    schema_version: int
    asset_id: str
    version: int
    kind: str
    content: dict

    @property
    def content_digest(self) -> str:
        return config_digest(pack_to_dict(self))


@dataclass(frozen=True, slots=True)
class ReuseRef:
    """One project-side reference, locked by version AND content digest."""

    asset_id: str
    version: int
    content_digest: str


def pack_relpath(asset_id: str, version: int) -> str:
    """Return the account-relative path of one pack version."""
    _require_asset_id(asset_id)
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ReuseError("version: expected a positive int")
    return f"{REUSE_DIR}/{asset_id}/v{version}.json"


def parse_pack(raw: object) -> ReuseAssetVersion:
    """Build a ``ReuseAssetVersion`` from already-parsed JSON data."""
    if not isinstance(raw, dict):
        raise ReuseError(f"pack: expected a JSON object, got {type(raw).__name__}")
    actual = frozenset(raw)
    missing = _PACK_KEYS - actual
    if missing:
        raise ReuseError(f"pack: missing keys {sorted(missing)}")
    unknown = actual - _PACK_KEYS
    if unknown:
        raise ReuseError(f"pack: unknown keys {sorted(unknown)}")

    schema_version = raw["schema_version"]
    if (
        isinstance(schema_version, bool)
        or not isinstance(schema_version, int)
        or schema_version != REUSE_PACK_SCHEMA_VERSION
    ):
        raise ReuseError(f"pack: unsupported schema_version {schema_version!r}")
    asset_id = _require_asset_id(raw["asset_id"])
    version = raw["version"]
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ReuseError("pack: version must be a positive int")
    kind = raw["kind"]
    if kind not in REUSE_KINDS:
        raise ReuseError(f"pack: unknown kind {kind!r}")
    content = raw["content"]
    if not isinstance(content, dict) or not content:
        raise ReuseError("pack: content must be a non-empty JSON object")
    return ReuseAssetVersion(
        schema_version=schema_version,
        asset_id=asset_id,
        version=version,
        kind=kind,
        content=content,
    )


def pack_to_dict(pack: ReuseAssetVersion) -> dict:
    return {
        "schema_version": pack.schema_version,
        "asset_id": pack.asset_id,
        "version": pack.version,
        "kind": pack.kind,
        "content": pack.content,
    }


def publish_pack_version(account_root: Path, pack: ReuseAssetVersion) -> Path:
    """Publish one immutable pack version; refuse to overwrite.

    Any update is a NEW version number — projects referencing older
    versions are never affected.
    """
    path = resolve_within_root(account_root, pack_relpath(pack.asset_id, pack.version))
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (
        json.dumps(
            pack_to_dict(pack),
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")
    _atomic_create(path, payload, "reuse pack version")
    return path


def load_pack_version(
    account_root: Path, asset_id: str, version: int
) -> ReuseAssetVersion:
    """Load one published pack version (fail-closed on absence/corruption)."""
    path = resolve_within_root(account_root, pack_relpath(asset_id, version))
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ReuseRefError(
            f"reuse asset {asset_id!r} has no published version {version}"
        ) from exc
    except (OSError, UnicodeError) as exc:
        raise ReuseError(f"unable to read pack version: {path}") from exc
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise ReuseError(f"pack version is not valid JSON: {path}") from exc
    pack = parse_pack(raw)
    if pack.asset_id != asset_id or pack.version != version:
        raise ReuseRefError(
            f"pack file {path} declares ({pack.asset_id!r}, v{pack.version}), "
            f"expected ({asset_id!r}, v{version})"
        )
    return pack


# --- project-side references ----------------------------------------------


def load_reuse_refs(project_root: Path) -> tuple[ReuseRef, ...]:
    """Load the project's reuse references (empty when the file is absent)."""
    path = resolve_within_root(project_root, REUSE_REFS_RELPATH)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ()
    except (OSError, UnicodeError) as exc:
        raise ReuseError(f"unable to read reuse refs: {path}") from exc
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise ReuseError(f"reuse refs file is not valid JSON: {path}") from exc
    return _parse_refs(raw)


def add_reuse_ref(
    project_root: Path, account_root: Path, asset_id: str, version: int
) -> ReuseRef:
    """Add one version+digest-locked reference to the project.

    The digest is computed from the published pack at add time, so the
    project is pinned to exactly that content. A reference for the same
    ``asset_id`` may exist only once per project (an explicit replace is
    a later task); duplicates are rejected, never silently mutated.
    """
    pack = load_pack_version(account_root, asset_id, version)
    new_ref = ReuseRef(
        asset_id=pack.asset_id,
        version=pack.version,
        content_digest=pack.content_digest,
    )
    existing = load_reuse_refs(project_root)
    if any(ref.asset_id == asset_id for ref in existing):
        raise ReuseRefError(
            f"project already references reuse asset {asset_id!r}; "
            "explicit replacement is not part of this task"
        )
    _write_refs(project_root, (*existing, new_ref))
    return new_ref


def resolve_reuse_refs(
    project_root: Path, account_root: Path
) -> tuple[ReuseAssetVersion, ...]:
    """Resolve every project reference, fail-closed on any drift.

    A missing version, a version mismatch inside the file, or a content
    digest that no longer matches the reference raises ``ReuseRefError``.
    """
    resolved = []
    for ref in load_reuse_refs(project_root):
        pack = load_pack_version(account_root, ref.asset_id, ref.version)
        if pack.content_digest != ref.content_digest:
            raise ReuseRefError(
                f"reuse asset {ref.asset_id!r} v{ref.version} content has "
                f"drifted from the project's locked digest"
            )
        resolved.append(pack)
    return tuple(resolved)


def _parse_refs(raw: object) -> tuple[ReuseRef, ...]:
    if not isinstance(raw, dict):
        raise ReuseError("reuse refs: expected a JSON object")
    actual = frozenset(raw)
    if actual != _REFS_KEYS:
        raise ReuseError(
            f"reuse refs: expected keys {sorted(_REFS_KEYS)}, got {sorted(actual)}"
        )
    schema_version = raw["schema_version"]
    if schema_version != REUSE_REFS_SCHEMA_VERSION:
        raise ReuseError(f"reuse refs: unsupported version {schema_version!r}")
    entries = raw["refs"]
    if not isinstance(entries, list):
        raise ReuseError("reuse refs: refs must be a JSON array")
    refs: list[ReuseRef] = []
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or frozenset(entry) != _REF_KEYS:
            raise ReuseError(f"reuse refs: each ref needs exactly {sorted(_REF_KEYS)}")
        asset_id = _require_asset_id(entry["asset_id"])
        version = entry["version"]
        if isinstance(version, bool) or not isinstance(version, int) or version < 1:
            raise ReuseError("reuse refs: version must be a positive int")
        digest = entry["content_digest"]
        if (
            not isinstance(digest, str)
            or len(digest) != _SHA256_LEN
            or any(c not in "0123456789abcdef" for c in digest)
        ):
            raise ReuseError("reuse refs: content_digest must be a sha256 hex")
        if asset_id in seen:
            raise ReuseError(f"reuse refs: duplicate asset {asset_id!r}")
        seen.add(asset_id)
        refs.append(ReuseRef(asset_id, version, digest))
    return tuple(refs)


def _write_refs(project_root: Path, refs: tuple[ReuseRef, ...]) -> None:
    path = resolve_within_root(project_root, REUSE_REFS_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (
        json.dumps(
            {
                "schema_version": REUSE_REFS_SCHEMA_VERSION,
                "refs": [
                    {
                        "asset_id": ref.asset_id,
                        "version": ref.version,
                        "content_digest": ref.content_digest,
                    }
                    for ref in refs
                ],
            },
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")
    # atomic replace: the refs file is an additive table rewritten as a whole
    raw_fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(raw_fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _atomic_create(path: Path, payload: bytes, what: str) -> None:
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
                f"refusing to overwrite existing {what}: {path}"
            ) from exc
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _require_asset_id(value: object) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ReuseError("asset_id: expected a non-empty, trimmed string")
    if "/" in value or "\\" in value or value in (".", "..") or value.startswith("."):
        raise ReuseError(f"asset_id: {value!r} is not a safe path component")
    return value

"""The WFM2 creative/audiovisual locked-artifact structured index (TASK-034).

ADR-0037 decides "structured index over prose/media": full creative and
audiovisual bodies may live as Markdown/media, but every *locked* L0/S1/S2/S3
artifact is a formal fact only through a stable structured index that carries
its identity (``ref`` + immutable ``version`` + ``content_digest``), producing
step, precise input refs, parent version + change reason, checklist evidence,
and an optional in-project ``body_ref`` prose/media path bound by ``body_digest``.

The index is published create-only and immutable (temp → fsync → os.link,
refuse-if-exists), exactly like the WFM1 ``planning`` documents; a change to a
locked artifact is a NEW version with ``parent_version`` + ``change_reason``,
never an in-place overwrite. On load the stored ``content_digest`` is recomputed
and compared, so a tampered index fails closed. Files live under
``creative/<stage>/<ref>_v<N>.json`` (ADR-0001 sixth amendment / ADR-0012 WFM2
addition). This module defines the identity/versioning/lineage contract only; it
never calls a Provider, never approves anything, and writes no other business
state.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.creative.errors import (
    CreativeError,
    CreativeNotFoundError,
    CreativeValidationError,
)
from ai_video_workflow.digests import config_digest, file_sha256
from ai_video_workflow.errors import OverwriteRefusedError
from ai_video_workflow.security.paths import PathEscapeError, resolve_within_root

CREATIVE_DIR = "creative"
CREATIVE_INDEX_SCHEMA_VERSION = 1
STAGES: frozenset[str] = frozenset({"l0", "s1", "s2", "s3"})

_REF_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_STEP_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class InputRef:
    """A precise, digest-bound reference to an upstream locked artifact.

    Fully qualified by ``stage`` as well as ``ref``/``version``: refs are only
    stage-unique and catalog dependencies cross stages, so the stage is required
    to resolve/verify a lineage reference unambiguously.
    """

    stage: str
    ref: str
    version: int
    content_digest: str

    def to_dict(self) -> dict:
        return {
            "stage": self.stage,
            "ref": self.ref,
            "version": self.version,
            "content_digest": self.content_digest,
        }


@dataclass(frozen=True, slots=True)
class ChecklistItem:
    """One human/agent-assisted checklist result carried as lineage evidence."""

    item: str
    verdict: str
    note: str

    def to_dict(self) -> dict:
        return {"item": self.item, "verdict": self.verdict, "note": self.note}


@dataclass(frozen=True, slots=True)
class CreativeArtifact:
    """One locked creative/audiovisual artifact index version.

    ``content_digest`` is the canonical digest of every identity/lineage field
    below (it is stored in the file for downstream binding and recomputed on
    load). ``ref`` is a stage-unique stable slug; ``kind`` is a classification
    (many refs may share a kind, e.g. per-shot ``shot_card``).
    """

    schema_version: int
    stage: str
    step_id: str
    kind: str
    ref: str
    version: int
    input_refs: tuple[InputRef, ...]
    parent_version: int | None
    change_reason: str | None
    checklist: tuple[ChecklistItem, ...]
    body_ref: str | None
    body_digest: str | None

    def _identity_dict(self) -> dict:
        """The digest pre-image: everything but ``content_digest`` itself."""
        return {
            "schema_version": self.schema_version,
            "stage": self.stage,
            "step_id": self.step_id,
            "kind": self.kind,
            "ref": self.ref,
            "version": self.version,
            "input_refs": [r.to_dict() for r in self.input_refs],
            "parent_version": self.parent_version,
            "change_reason": self.change_reason,
            "checklist": [c.to_dict() for c in self.checklist],
            "body_ref": self.body_ref,
            "body_digest": self.body_digest,
        }

    @property
    def content_digest(self) -> str:
        return config_digest(self._identity_dict())

    def to_dict(self) -> dict:
        data = self._identity_dict()
        data["content_digest"] = self.content_digest
        return data

    def as_input_ref(self) -> InputRef:
        return InputRef(self.stage, self.ref, self.version, self.content_digest)


def index_relpath(stage: str, ref: str, version: int) -> str:
    """The ``creative/<stage>/<ref>_v<N>.json`` project-relative path."""
    _require_stage(stage)
    if not _REF_RE.match(ref):
        raise CreativeError(f"invalid creative ref: {ref!r}")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise CreativeError(f"invalid creative version: {version!r}")
    return f"{CREATIVE_DIR}/{stage}/{ref}_v{version}.json"


def build_artifact(
    *,
    stage: str,
    step_id: str,
    kind: str,
    ref: str,
    version: int,
    input_refs: Sequence[Mapping] = (),
    parent_version: int | None = None,
    change_reason: str | None = None,
    checklist: Sequence[Mapping] = (),
    body_ref: str | None = None,
    body_digest: str | None = None,
) -> CreativeArtifact:
    """Validate and construct a :class:`CreativeArtifact` (no IO)."""
    _require_stage(stage)
    if not _STEP_RE.match(step_id):
        raise CreativeError(f"invalid step_id: {step_id!r}")
    if not _REF_RE.match(kind):
        raise CreativeError(f"invalid kind: {kind!r}")
    if not _REF_RE.match(ref):
        raise CreativeError(f"invalid ref: {ref!r}")
    # (stage, step_id, kind) must be a valid catalog triple: a malformed index
    # published at a canonical ref is immutable and would block the legitimate
    # artifact, so reject it at construction (and on load) rather than persist it.
    from ai_video_workflow.creative import catalog as _catalog

    try:
        row = _catalog.step(step_id)
    except KeyError as exc:
        raise CreativeValidationError(f"unknown catalog step_id: {step_id!r}") from exc
    if row.stage != stage or row.kind != kind:
        raise CreativeValidationError(
            f"(stage,step_id,kind)=({stage!r},{step_id!r},{kind!r}) is not a valid "
            f"catalog triple; step {step_id} is stage {row.stage!r}/kind {row.kind!r}"
        )
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise CreativeError(f"invalid version: {version!r}")
    if version > 1 and parent_version is None:
        raise CreativeError(
            f"version {version} requires a parent_version + change_reason; a revision "
            "must link its predecessor (immutable lineage)"
        )

    if parent_version is not None:
        if (
            not isinstance(parent_version, int)
            or isinstance(parent_version, bool)
            or parent_version < 1
            or parent_version >= version
        ):
            raise CreativeError(
                f"parent_version {parent_version!r} must be a prior version < {version}"
            )
        if not (isinstance(change_reason, str) and change_reason.strip()):
            raise CreativeError("change_reason is required when parent_version is set")
    elif change_reason is not None:
        raise CreativeError("change_reason is only allowed when parent_version is set")

    parsed_inputs = tuple(_parse_input_ref(r) for r in input_refs)
    parsed_checklist = tuple(_parse_checklist_item(c) for c in checklist)

    if body_ref is not None:
        if not (isinstance(body_ref, str) and body_ref.strip()):
            raise CreativeError("body_ref must be a non-empty string when set")
        if not (isinstance(body_digest, str) and _SHA256_RE.match(body_digest or "")):
            raise CreativeError("body_digest (sha256) is required when body_ref is set")
    elif body_digest is not None:
        raise CreativeError("body_digest is only allowed when body_ref is set")

    return CreativeArtifact(
        schema_version=CREATIVE_INDEX_SCHEMA_VERSION,
        stage=stage,
        step_id=step_id,
        kind=kind,
        ref=ref,
        version=version,
        input_refs=parsed_inputs,
        parent_version=parent_version,
        change_reason=change_reason,
        checklist=parsed_checklist,
        body_ref=body_ref,
        body_digest=body_digest,
    )


def publish_artifact(project_root: Path, artifact: CreativeArtifact) -> Path:
    """Publish an immutable creative index version (create-only, fail-closed).

    Refuses to overwrite an existing version; verifies the declared parent
    version, that every declared input ref actually resolves to a published
    artifact with the exact declared digest, and that the referenced body file's
    digest matches — a locked artifact never references an absent parent, a
    nonexistent/digest-forged input, or an unbound prose body.
    """
    # Enforce a linear immutable chain: a new version must be exactly tip+1 and
    # parent the current tip, so a revision cannot skip its predecessor.
    tip = latest_version(project_root, artifact.stage, artifact.ref)
    if tip is None:
        if artifact.version != 1 or artifact.parent_version is not None:
            raise CreativeValidationError(
                f"first version of {artifact.ref!r} must be v1 with no parent"
            )
    else:
        if artifact.version != tip + 1:
            raise CreativeValidationError(
                f"next version of {artifact.ref!r} must be v{tip + 1}, "
                f"got v{artifact.version}"
            )
        if artifact.parent_version != tip:
            raise CreativeValidationError(
                f"v{artifact.version} of {artifact.ref!r} must parent the current "
                f"tip v{tip}, not v{artifact.parent_version}"
            )
        # Load (not just stat) the parent so a corrupt/tampered parent fails
        # closed instead of anchoring a seemingly-valid descendant lineage.
        load_artifact(project_root, artifact.stage, artifact.ref, tip)
    covered: set[tuple[str, str]] = set()
    for iref in artifact.input_refs:
        # Every declared input must resolve to a real published artifact whose
        # digest matches — forged or dangling lineage is never persisted.
        try:
            upstream = load_artifact(project_root, iref.stage, iref.ref, iref.version)
        except CreativeNotFoundError as exc:
            raise CreativeValidationError(
                f"input ref {iref.stage}/{iref.ref} v{iref.version} does not exist; "
                f"cannot publish {artifact.ref!r} v{artifact.version}"
            ) from exc
        if upstream.content_digest != iref.content_digest:
            raise CreativeValidationError(
                f"input ref {iref.stage}/{iref.ref} v{iref.version} digest does not "
                f"match the published artifact (forged or stale lineage)"
            )
        covered.add((upstream.stage, upstream.kind))
    # Require EVERY catalog-declared creative input to be present + digest-bound,
    # so no locked artifact can omit its lineage (an omitted input would leave
    # upstream changes untracked). Cross-stage prerequisites are included.
    from ai_video_workflow.creative import catalog as _catalog

    for input_id in _catalog.step(artifact.step_id).inputs:
        irow = _catalog.step(input_id)
        if irow.surface != _catalog.SURFACE_CREATIVE:
            continue
        if (irow.stage, irow.kind) not in covered:
            raise CreativeValidationError(
                f"{artifact.step_id} must declare and bind its required input "
                f"{irow.kind} ({input_id}); it is missing from input_refs"
            )
    if artifact.body_ref is not None:
        _verify_body_digest(project_root, artifact)

    relpath = index_relpath(artifact.stage, artifact.ref, artifact.version)
    return _publish_json(project_root, relpath, artifact.to_dict())


def load_artifact(
    project_root: Path, stage: str, ref: str, version: int
) -> CreativeArtifact:
    """Load one index version, recomputing and verifying its content digest."""
    relpath = index_relpath(stage, ref, version)
    path = resolve_within_root(project_root, relpath)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise CreativeNotFoundError(
            f"creative artifact does not exist: {path}"
        ) from exc
    except (OSError, UnicodeError) as exc:
        raise CreativeError(f"unable to read creative artifact: {path}") from exc
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise CreativeError(f"creative artifact is not valid JSON: {path}") from exc
    artifact = artifact_from_dict(raw, expected=(stage, ref, version))
    # A locked artifact's prose/media body stays bound: re-verify the body
    # digest on every load, so a body edited AFTER publication fails closed
    # rather than being silently accepted by loads and lock validation.
    if artifact.body_ref is not None:
        _verify_body_digest(project_root, artifact)
    return artifact


def latest_version(project_root: Path, stage: str, ref: str) -> int | None:
    """Highest published version of ``ref`` in ``stage`` (None if none)."""
    _require_stage(stage)
    if not _REF_RE.match(ref):
        raise CreativeError(f"invalid ref: {ref!r}")
    try:
        base = resolve_within_root(project_root, f"{CREATIVE_DIR}/{stage}")
    except PathEscapeError as exc:  # pragma: no cover - defensive
        raise CreativeError(str(exc)) from exc
    if not base.is_dir():
        return None
    # Anchor the whole filename to THIS ref: an unanchored prefix/regex would
    # let ``foo_v1_v2.json`` (ref ``foo_v1``) be mis-read as ``foo`` v2, so refs
    # sharing a prefix collide.
    name_re = re.compile(rf"^{re.escape(ref)}_v([1-9][0-9]*)\.json$")
    versions = [
        int(match.group(1))
        for path in base.iterdir()
        if (match := name_re.match(path.name)) is not None
    ]
    return max(versions) if versions else None


def load_latest(project_root: Path, stage: str, ref: str) -> CreativeArtifact | None:
    """Load the highest published version of ``ref`` in ``stage`` (None if none)."""
    version = latest_version(project_root, stage, ref)
    if version is None:
        return None
    return load_artifact(project_root, stage, ref, version)


_ANY_VERSION_RE = re.compile(r"^(?P<ref>.+)_v([1-9][0-9]*)\.json$")


def latest_artifacts(project_root: Path, stage: str) -> tuple[CreativeArtifact, ...]:
    """Load the latest version of every distinct ref in ``stage`` (sorted by ref).

    Unlike :func:`load_latest`, this does not assume ``ref == kind``: it enumerates
    every published ref, so a kind with multiple refs (e.g. per-shot ``shot_card``)
    is fully surfaced. Each artifact is digest/identity/body verified on load.
    """
    _require_stage(stage)
    try:
        base = resolve_within_root(project_root, f"{CREATIVE_DIR}/{stage}")
    except PathEscapeError as exc:  # pragma: no cover - defensive
        raise CreativeError(str(exc)) from exc
    if not base.is_dir():
        return ()
    latest: dict[str, int] = {}
    for path in base.iterdir():
        match = _ANY_VERSION_RE.match(path.name)
        if match is None:
            continue
        ref = match.group("ref")
        version = int(match.group(2))
        if version > latest.get(ref, 0):
            latest[ref] = version
    return tuple(
        load_artifact(project_root, stage, ref, version)
        for ref, version in sorted(latest.items())
    )


def artifacts_of_kind(
    project_root: Path, stage: str, kind: str, step_id: str | None = None
) -> tuple[CreativeArtifact, ...]:
    """Latest published artifacts of ``kind`` in ``stage`` (any ref).

    Resolution is by kind, not by ``ref == kind``: a stable ref may differ from
    its kind (e.g. per-shot ``shot_card`` or a custom-named lock), so callers
    that need "the artifact(s) of this kind" must look them up this way.
    """
    return tuple(
        a
        for a in latest_artifacts(project_root, stage)
        if a.kind == kind and (step_id is None or a.step_id == step_id)
    )


def artifact_from_dict(
    raw: object, *, expected: tuple[str, str, int] | None = None
) -> CreativeArtifact:
    """Parse + validate an index dict, verifying its stored content digest."""
    if not isinstance(raw, dict):
        raise CreativeError("creative artifact must be a JSON object")
    if raw.get("schema_version") != CREATIVE_INDEX_SCHEMA_VERSION:
        raise CreativeError(
            f"unsupported creative schema_version: {raw.get('schema_version')!r}"
        )
    stored_digest = raw.get("content_digest")
    try:
        artifact = build_artifact(
            stage=raw["stage"],
            step_id=raw["step_id"],
            kind=raw["kind"],
            ref=raw["ref"],
            version=raw["version"],
            input_refs=raw.get("input_refs") or (),
            parent_version=raw.get("parent_version"),
            change_reason=raw.get("change_reason"),
            checklist=raw.get("checklist") or (),
            body_ref=raw.get("body_ref"),
            body_digest=raw.get("body_digest"),
        )
    except KeyError as exc:
        raise CreativeError(
            f"creative artifact missing field: {exc.args[0]!r}"
        ) from exc
    if stored_digest != artifact.content_digest:
        raise CreativeValidationError(
            f"creative artifact content_digest mismatch for {artifact.ref!r} "
            f"v{artifact.version}: index is corrupt or tampered"
        )
    if (
        expected is not None
        and (
            artifact.stage,
            artifact.ref,
            artifact.version,
        )
        != expected
    ):
        content = (artifact.stage, artifact.ref, artifact.version)
        raise CreativeValidationError(
            "creative artifact identity does not match its path "
            f"(path {expected}, content {content})"
        )
    return artifact


# --- internals ---------------------------------------------------------------


def _require_stage(stage: object) -> None:
    if stage not in STAGES:
        raise CreativeError(f"unknown creative stage: {stage!r}")


def _parse_input_ref(raw: object) -> InputRef:
    if not isinstance(raw, Mapping):
        raise CreativeError("input_ref must be an object")
    stage = raw.get("stage")
    ref = raw.get("ref")
    version = raw.get("version")
    digest = raw.get("content_digest")
    if stage not in STAGES:
        raise CreativeError(f"input_ref.stage invalid: {stage!r}")
    if not (isinstance(ref, str) and _REF_RE.match(ref)):
        raise CreativeError(f"input_ref.ref invalid: {ref!r}")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise CreativeError(f"input_ref.version invalid: {version!r}")
    if not (isinstance(digest, str) and _SHA256_RE.match(digest)):
        raise CreativeError(f"input_ref.content_digest invalid: {digest!r}")
    return InputRef(stage, ref, version, digest)


def _parse_checklist_item(raw: object) -> ChecklistItem:
    if not isinstance(raw, Mapping):
        raise CreativeError("checklist item must be an object")
    item = raw.get("item")
    verdict = raw.get("verdict")
    note = raw.get("note", "")
    if not (isinstance(item, str) and item.strip()):
        raise CreativeError("checklist.item must be a non-empty string")
    if not (isinstance(verdict, str) and verdict.strip()):
        raise CreativeError("checklist.verdict must be a non-empty string")
    if not isinstance(note, str):
        raise CreativeError("checklist.note must be a string")
    return ChecklistItem(item, verdict, note)


def _verify_body_digest(project_root: Path, artifact: CreativeArtifact) -> None:
    try:
        body_path = resolve_within_root(project_root, artifact.body_ref)
    except PathEscapeError as exc:
        raise CreativeValidationError(
            f"body_ref escapes the project root: {artifact.body_ref!r}"
        ) from exc
    if not body_path.is_file():
        raise CreativeValidationError(
            f"body_ref file does not exist: {artifact.body_ref!r}"
        )
    actual = file_sha256(body_path)
    if actual != artifact.body_digest:
        raise CreativeValidationError(
            f"body_ref digest mismatch for {artifact.ref!r}: prose/media changed "
            "without a new index version"
        )


def _publish_json(project_root: Path, relpath: str, payload_dict: dict) -> Path:
    path = resolve_within_root(project_root, relpath)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (
        json.dumps(
            payload_dict,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
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
                f"refusing to overwrite existing creative artifact: {path}"
            ) from exc
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    return path

"""The WFM2 S5–S7 post-production / QC / release / archive artifact index
(TASK-036 / ADR-0039).

Every formal S5–S7 fact — assembly/rough/fine cut, audio mix, master candidate,
final load review, the four QC conclusions, release package/result, post-mortem,
scorecard, performance snapshot, reuse candidate and knowledge promotion — is a
fact only through a stable structured index that carries its identity (``ref`` +
immutable ``version`` + ``content_digest``), its FACT DOMAIN (ADR-0039 P5 — a
unique writer per domain, states never crossing), producing step, precise
cross-surface input refs, parent version + change reason, checklist evidence, and
an optional in-project ``body_ref`` bound by ``body_digest``.

Missing-vs-zero semantics are first-class (ADR-0039 P7): a ``conditional`` step
that does not fire is recorded as ``not_applicable`` with a reason (not a fake
produced artifact); an ``optional-data`` datum that is not yet available is
recorded as ``unavailable`` with a reason — never as a zero.

Published create-only + immutable (temp → fsync → os.link, refuse-if-exists),
exactly like the creative/media indices; a change is a NEW version with parent +
change reason. On load the stored digest is recomputed and compared, so a tampered
index fails closed. Files live under ``postproduction/<stage>/<ref>_v<N>.json``
(ADR-0001 ninth amendment). This module defines the identity/versioning/lineage/
fact-domain/status contract only — it computes no QC, calls no Provider, approves
nothing, and writes no other business state.
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
from ai_video_workflow.postproduction import catalog as _catalog
from ai_video_workflow.postproduction.errors import (
    PostProductionError,
    PostProductionNotFoundError,
    PostProductionValidationError,
)
from ai_video_workflow.security.paths import PathEscapeError, resolve_within_root

POSTPRODUCTION_DIR = "postproduction"
POSTPRODUCTION_INDEX_SCHEMA_VERSION = 1
STAGES: frozenset[str] = frozenset(_catalog.STAGES)

# Where a declared input's authoritative identity lives.
SURFACE_POSTPRODUCTION = "postproduction"  # this module's index (resolved)
SURFACE_CREATIVE = "creative"  # ADR-0037 creative index (resolved)
SURFACE_MEDIA = "media"  # ADR-0038 media asset index (resolved)
SURFACE_EXTERNAL = "external"  # QCD/operation/evaluation fact (declared, by digest)
_SURFACES = frozenset(
    {SURFACE_POSTPRODUCTION, SURFACE_CREATIVE, SURFACE_MEDIA, SURFACE_EXTERNAL}
)

# Status of a step's outcome (ADR-0039 P7).
STATUS_PRODUCED = "produced"
STATUS_NOT_APPLICABLE = "not_applicable"  # conditional step did not fire
STATUS_UNAVAILABLE = "unavailable"  # optional-data not (yet) available
_STATUSES = frozenset({STATUS_PRODUCED, STATUS_NOT_APPLICABLE, STATUS_UNAVAILABLE})

_REF_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# container ids of resolvable surfaces are their own slug rules; we only need a
# loose non-empty token here since each surface's loader re-validates.
_CONTAINER_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


@dataclass(frozen=True, slots=True)
class InputRef:
    """A precise, digest-bound reference to an upstream fact on any surface.

    ``surface`` selects the authority: ``postproduction`` / ``creative`` / ``media``
    are resolved and digest-verified at publish; ``external`` (a QCD/operation/
    evaluation fact that lives in its own append-only authority, not a versioned
    artifact) is carried as a declared, digest-bound reference only.
    ``container`` is the surface's sub-namespace (a stage for postproduction/
    creative, a media_kind for media, a free token for external).
    """

    surface: str
    container: str
    ref: str
    version: int
    content_digest: str

    def to_dict(self) -> dict:
        return {
            "surface": self.surface,
            "container": self.container,
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
class PostProductionArtifact:
    """One S5–S7 post-production artifact index version."""

    schema_version: int
    stage: str
    step_id: str
    fact_domain: str
    kind: str
    ref: str
    version: int
    status: str
    status_reason: str | None
    input_refs: tuple[InputRef, ...]
    parent_version: int | None
    change_reason: str | None
    checklist: tuple[ChecklistItem, ...]
    body_ref: str | None
    body_digest: str | None

    def _identity_dict(self) -> dict:
        return {
            "schema_version": self.schema_version,
            "stage": self.stage,
            "step_id": self.step_id,
            "fact_domain": self.fact_domain,
            "kind": self.kind,
            "ref": self.ref,
            "version": self.version,
            "status": self.status,
            "status_reason": self.status_reason,
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
        return InputRef(
            SURFACE_POSTPRODUCTION,
            self.stage,
            self.ref,
            self.version,
            self.content_digest,
        )


def index_relpath(stage: str, ref: str, version: int) -> str:
    """The ``postproduction/<stage>/<ref>_v<N>.json`` project-relative path."""
    _require_stage(stage)
    if not _REF_RE.match(ref):
        raise PostProductionError(f"invalid post-production ref: {ref!r}")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise PostProductionError(f"invalid post-production version: {version!r}")
    return f"{POSTPRODUCTION_DIR}/{stage}/{ref}_v{version}.json"


def build_artifact(
    *,
    stage: str,
    step_id: str,
    kind: str,
    ref: str,
    version: int,
    fact_domain: str | None = None,
    status: str = STATUS_PRODUCED,
    status_reason: str | None = None,
    input_refs: Sequence[Mapping] = (),
    parent_version: int | None = None,
    change_reason: str | None = None,
    checklist: Sequence[Mapping] = (),
    body_ref: str | None = None,
    body_digest: str | None = None,
) -> PostProductionArtifact:
    """Validate and construct a :class:`PostProductionArtifact` (no IO)."""
    _require_stage(stage)
    if not _REF_RE.match(kind):
        raise PostProductionError(f"invalid kind: {kind!r}")
    if not _REF_RE.match(ref):
        raise PostProductionError(f"invalid ref: {ref!r}")

    # (stage, step_id, kind, fact_domain) must be a valid catalog quadruple — a
    # malformed index published at a canonical ref is immutable and would block
    # the legitimate artifact, so reject it here (and on load) rather than persist.
    try:
        row = _catalog.step(step_id)
    except KeyError as exc:
        raise PostProductionValidationError(
            f"unknown catalog step_id: {step_id!r}"
        ) from exc
    if row.stage != stage or row.kind != kind:
        raise PostProductionValidationError(
            f"(stage,step_id,kind)=({stage!r},{step_id!r},{kind!r}) is not a valid "
            f"catalog triple; step {step_id} is stage {row.stage!r}/kind {row.kind!r}"
        )
    if fact_domain is None:
        fact_domain = row.fact_domain
    elif fact_domain != row.fact_domain:
        raise PostProductionValidationError(
            f"fact_domain {fact_domain!r} does not match step {step_id}'s domain "
            f"{row.fact_domain!r} (fact domains have a unique writer, ADR-0039 P5)"
        )

    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise PostProductionError(f"invalid version: {version!r}")
    if version > 1 and parent_version is None:
        raise PostProductionError(
            f"version {version} requires a parent_version + change_reason"
        )
    if parent_version is not None:
        if (
            not isinstance(parent_version, int)
            or isinstance(parent_version, bool)
            or parent_version < 1
            or parent_version >= version
        ):
            raise PostProductionError(
                f"parent_version {parent_version!r} must be a prior version < {version}"
            )
        if not (isinstance(change_reason, str) and change_reason.strip()):
            raise PostProductionError(
                "change_reason is required when parent_version is set"
            )
    elif change_reason is not None:
        raise PostProductionError(
            "change_reason is only allowed when parent_version is set"
        )

    status = _validate_status(status, status_reason, row, body_ref)

    parsed_inputs = tuple(_parse_input_ref(r) for r in input_refs)
    parsed_checklist = tuple(_parse_checklist_item(c) for c in checklist)

    if body_ref is not None:
        if not (isinstance(body_ref, str) and body_ref.strip()):
            raise PostProductionError("body_ref must be a non-empty string when set")
        if not (isinstance(body_digest, str) and _SHA256_RE.match(body_digest or "")):
            raise PostProductionError(
                "body_digest (sha256) is required when body_ref is set"
            )
    elif body_digest is not None:
        raise PostProductionError("body_digest is only allowed when body_ref is set")

    return PostProductionArtifact(
        schema_version=POSTPRODUCTION_INDEX_SCHEMA_VERSION,
        stage=stage,
        step_id=step_id,
        fact_domain=fact_domain,
        kind=kind,
        ref=ref,
        version=version,
        status=status,
        status_reason=status_reason,
        input_refs=parsed_inputs,
        parent_version=parent_version,
        change_reason=change_reason,
        checklist=parsed_checklist,
        body_ref=body_ref,
        body_digest=body_digest,
    )


def publish_artifact(project_root: Path, artifact: PostProductionArtifact) -> Path:
    """Publish an immutable post-production index version (create-only, fail-closed).

    Refuses to overwrite; enforces a linear immutable chain; verifies every
    declared resolvable input ref actually resolves to a published fact with the
    exact declared digest; requires a ``produced`` artifact to bind every
    catalog-declared post-production input; verifies the body digest.
    """
    # Re-validate through build_artifact's full rules: a ``PostProductionArtifact``
    # is a public dataclass, so a caller could construct an INVALID one directly
    # (bad step/kind/status/fact_domain, wrong schema_version). Publishing such an
    # artifact — immutable + create-only — would poison its canonical ref/version:
    # it would fail every subsequent load and could never be replaced. Rebuilding
    # here rejects it before anything is written, and the digest round-trip proves
    # the rebuilt (validated) artifact is byte-identical to the one supplied.
    _revalidate(artifact)

    tip = latest_version(project_root, artifact.stage, artifact.ref)
    if tip is None:
        if artifact.version != 1 or artifact.parent_version is not None:
            raise PostProductionValidationError(
                f"first version of {artifact.ref!r} must be v1 with no parent"
            )
    else:
        if artifact.version != tip + 1:
            raise PostProductionValidationError(
                f"next version of {artifact.ref!r} must be v{tip + 1}, "
                f"got v{artifact.version}"
            )
        if artifact.parent_version != tip:
            raise PostProductionValidationError(
                f"v{artifact.version} of {artifact.ref!r} must parent the current "
                f"tip v{tip}, not v{artifact.parent_version}"
            )
        # Load (not just stat) the parent so a corrupt parent fails closed, and
        # require the (stage, ref) identity to keep the SAME step/kind/fact_domain
        # across versions — a revision may not silently repurpose a ref (e.g.
        # assembly_timeline -> rough_cut), which would corrupt lineage and the
        # unique-writer fact-domain separation.
        parent = _load_shallow(project_root, artifact.stage, artifact.ref, tip)
        if (
            parent.step_id != artifact.step_id
            or parent.kind != artifact.kind
            or parent.fact_domain != artifact.fact_domain
        ):
            raise PostProductionValidationError(
                f"v{artifact.version} of {artifact.ref!r} changes its identity "
                f"(step/kind/fact_domain) from its parent v{tip}; a ref's meaning is "
                "immutable across versions"
            )

    covered: set[tuple[str, str]] = set()
    for iref in artifact.input_refs:
        upstream = _resolve_input(project_root, iref)
        if upstream is not None:
            covered.add((upstream.stage, upstream.kind))

    # A PRODUCED artifact must bind every catalog-declared post-production input,
    # so no formal fact can omit its intra-stage lineage. not_applicable /
    # unavailable outcomes produced nothing, so this completeness rule is waived.
    if artifact.status == STATUS_PRODUCED:
        row = _catalog.step(artifact.step_id)
        for input_id in row.inputs:
            irow = _catalog.step(input_id)
            if (irow.stage, irow.kind) not in covered:
                raise PostProductionValidationError(
                    f"{artifact.step_id} must declare and bind its required "
                    f"post-production input {input_id} ({irow.kind}); it is missing "
                    "from input_refs"
                )
        # Cross-surface source provenance (e.g. the media assets a mix/master/
        # rights conclusion is derived from) must be bound — a produced artifact
        # cannot claim to exist without the source lineage its step requires.
        present_surfaces = {iref.surface for iref in artifact.input_refs}
        for surface in row.required_input_surfaces:
            if surface not in present_surfaces:
                raise PostProductionValidationError(
                    f"{artifact.step_id} must bind at least one {surface} input "
                    "(cross-surface source provenance is required for this step)"
                )

    if artifact.body_ref is not None:
        _verify_body_digest(project_root, artifact)

    relpath = index_relpath(artifact.stage, artifact.ref, artifact.version)
    return _publish_json(project_root, relpath, artifact.to_dict())


def load_artifact(
    project_root: Path, stage: str, ref: str, version: int
) -> PostProductionArtifact:
    """Load one index version, verifying its own digest/body AND re-resolving each
    declared input ref's digest.

    Re-resolving inputs on load means a resolvable upstream (postproduction /
    creative / media) that was tampered AND had its digest recomputed after this
    artifact was published is detected here (the stored input digest no longer
    matches the upstream's current digest) — digest-bound lineage stays fail-closed
    on load, not just at publish. The upstreams are loaded shallowly (their own
    digest/body only), so verification is one level deep and does not recurse the
    whole ancestry on a single load; ``external`` refs live in their own authority
    and are declared-only.
    """
    artifact = _load_shallow(project_root, stage, ref, version)
    for iref in artifact.input_refs:
        _resolve_input(project_root, iref)
    return artifact


def _load_shallow(
    project_root: Path, stage: str, ref: str, version: int
) -> PostProductionArtifact:
    """Load + verify one index version's OWN content digest and body only (no
    input re-resolution) — the primitive used by resolution to avoid recursion."""
    relpath = index_relpath(stage, ref, version)
    path = resolve_within_root(project_root, relpath)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise PostProductionNotFoundError(
            f"post-production artifact does not exist: {path}"
        ) from exc
    except (OSError, UnicodeError) as exc:
        raise PostProductionError(
            f"unable to read post-production artifact: {path}"
        ) from exc
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise PostProductionError(
            f"post-production artifact is not valid JSON: {path}"
        ) from exc
    artifact = artifact_from_dict(raw, expected=(stage, ref, version))
    if artifact.body_ref is not None:
        _verify_body_digest(project_root, artifact)
    return artifact


def latest_version(project_root: Path, stage: str, ref: str) -> int | None:
    """Highest published version of ``ref`` in ``stage`` (None if none)."""
    _require_stage(stage)
    if not _REF_RE.match(ref):
        raise PostProductionError(f"invalid ref: {ref!r}")
    try:
        base = resolve_within_root(project_root, f"{POSTPRODUCTION_DIR}/{stage}")
    except PathEscapeError as exc:  # pragma: no cover - defensive
        raise PostProductionError(str(exc)) from exc
    if not base.is_dir():
        return None
    name_re = re.compile(rf"^{re.escape(ref)}_v([1-9][0-9]*)\.json$")
    versions = [
        int(match.group(1))
        for path in base.iterdir()
        if (match := name_re.match(path.name)) is not None
    ]
    return max(versions) if versions else None


def load_latest(
    project_root: Path, stage: str, ref: str
) -> PostProductionArtifact | None:
    version = latest_version(project_root, stage, ref)
    if version is None:
        return None
    return load_artifact(project_root, stage, ref, version)


_ANY_VERSION_RE = re.compile(r"^(?P<ref>.+)_v([1-9][0-9]*)\.json$")


def latest_artifacts(
    project_root: Path, stage: str
) -> tuple[PostProductionArtifact, ...]:
    """Load the latest version of every distinct ref in ``stage`` (sorted by ref)."""
    _require_stage(stage)
    try:
        base = resolve_within_root(project_root, f"{POSTPRODUCTION_DIR}/{stage}")
    except PathEscapeError as exc:  # pragma: no cover - defensive
        raise PostProductionError(str(exc)) from exc
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


def artifacts_of_domain(
    project_root: Path, stage: str, fact_domain: str
) -> tuple[PostProductionArtifact, ...]:
    """Latest published artifacts of ``fact_domain`` in ``stage`` (any ref)."""
    return tuple(
        a for a in latest_artifacts(project_root, stage) if a.fact_domain == fact_domain
    )


def artifact_from_dict(
    raw: object, *, expected: tuple[str, str, int] | None = None
) -> PostProductionArtifact:
    """Parse + validate an index dict, verifying its stored content digest."""
    if not isinstance(raw, dict):
        raise PostProductionError("post-production artifact must be a JSON object")
    if raw.get("schema_version") != POSTPRODUCTION_INDEX_SCHEMA_VERSION:
        raise PostProductionError(
            f"unsupported post-production schema_version: {raw.get('schema_version')!r}"
        )
    stored_digest = raw.get("content_digest")
    try:
        artifact = build_artifact(
            stage=raw["stage"],
            step_id=raw["step_id"],
            kind=raw["kind"],
            ref=raw["ref"],
            version=raw["version"],
            fact_domain=raw.get("fact_domain"),
            status=raw.get("status", STATUS_PRODUCED),
            status_reason=raw.get("status_reason"),
            input_refs=raw.get("input_refs") or (),
            parent_version=raw.get("parent_version"),
            change_reason=raw.get("change_reason"),
            checklist=raw.get("checklist") or (),
            body_ref=raw.get("body_ref"),
            body_digest=raw.get("body_digest"),
        )
    except KeyError as exc:
        raise PostProductionError(
            f"post-production artifact missing field: {exc.args[0]!r}"
        ) from exc
    if stored_digest != artifact.content_digest:
        raise PostProductionValidationError(
            f"post-production artifact content_digest mismatch for {artifact.ref!r} "
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
        raise PostProductionValidationError(
            "post-production artifact identity does not match its path "
            f"(path {expected}, content {content})"
        )
    return artifact


# --- internals ---------------------------------------------------------------


def _require_stage(stage: object) -> None:
    if stage not in STAGES:
        raise PostProductionError(f"unknown post-production stage: {stage!r}")


def _revalidate(artifact: PostProductionArtifact) -> None:
    """Re-run build_artifact's validation on a supplied artifact (fail-closed).

    A directly-constructed, invalid artifact must never reach the immutable store.
    Rebuilding replays every field check; the digest round-trip additionally
    guards against a tampered schema_version or a bypassed constructor.
    """
    if artifact.schema_version != POSTPRODUCTION_INDEX_SCHEMA_VERSION:
        raise PostProductionValidationError(
            f"unsupported schema_version: {artifact.schema_version!r}"
        )
    rebuilt = build_artifact(
        stage=artifact.stage,
        step_id=artifact.step_id,
        kind=artifact.kind,
        ref=artifact.ref,
        version=artifact.version,
        fact_domain=artifact.fact_domain,
        status=artifact.status,
        status_reason=artifact.status_reason,
        input_refs=[r.to_dict() for r in artifact.input_refs],
        parent_version=artifact.parent_version,
        change_reason=artifact.change_reason,
        checklist=[c.to_dict() for c in artifact.checklist],
        body_ref=artifact.body_ref,
        body_digest=artifact.body_digest,
    )
    if rebuilt.content_digest != artifact.content_digest:
        raise PostProductionValidationError(
            "artifact failed re-validation (fields inconsistent with a built artifact)"
        )


def _validate_status(
    status: object,
    status_reason: object,
    row: _catalog.CatalogStep,
    body_ref: object,
) -> str:
    if status not in _STATUSES:
        raise PostProductionError(f"invalid status: {status!r}")
    if status == STATUS_PRODUCED:
        if status_reason is not None:
            raise PostProductionValidationError(
                "status_reason is only allowed for not_applicable / unavailable"
            )
        return status
    # non-produced outcomes must carry a reason and produce no body
    if not (isinstance(status_reason, str) and status_reason.strip()):
        raise PostProductionValidationError(
            f"status {status!r} requires a non-empty status_reason (missing != zero)"
        )
    if body_ref is not None:
        raise PostProductionValidationError(
            f"status {status!r} must not carry a body_ref (nothing was produced)"
        )
    if status == STATUS_NOT_APPLICABLE and row.execution != _catalog.EXEC_CONDITIONAL:
        raise PostProductionValidationError(
            f"not_applicable is only valid for a conditional step; {row.step_id} is "
            f"{row.execution!r}"
        )
    if status == STATUS_UNAVAILABLE and row.execution != _catalog.EXEC_OPTIONAL_DATA:
        raise PostProductionValidationError(
            f"unavailable is only valid for an optional-data step; {row.step_id} is "
            f"{row.execution!r}"
        )
    return status


def _parse_input_ref(raw: object) -> InputRef:
    if not isinstance(raw, Mapping):
        raise PostProductionError("input_ref must be an object")
    surface = raw.get("surface")
    container = raw.get("container")
    ref = raw.get("ref")
    version = raw.get("version")
    digest = raw.get("content_digest")
    if surface not in _SURFACES:
        raise PostProductionError(f"input_ref.surface invalid: {surface!r}")
    if not (isinstance(container, str) and _CONTAINER_RE.match(container)):
        raise PostProductionError(f"input_ref.container invalid: {container!r}")
    if not (isinstance(ref, str) and _REF_RE.match(ref)):
        raise PostProductionError(f"input_ref.ref invalid: {ref!r}")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise PostProductionError(f"input_ref.version invalid: {version!r}")
    if not (isinstance(digest, str) and _SHA256_RE.match(digest)):
        raise PostProductionError(f"input_ref.content_digest invalid: {digest!r}")
    return InputRef(surface, container, ref, version, digest)


def _resolve_input(project_root: Path, iref: InputRef) -> PostProductionArtifact | None:
    """Resolve a resolvable input to a published fact with a matching digest.

    Returns the upstream post-production artifact when the surface is
    ``postproduction`` (so the caller can enforce intra-stage input completeness),
    else ``None``. ``external`` refs live in their own append-only authority
    (QCD/operation/evaluation) and are carried as declared, digest-bound refs only.
    """
    if iref.surface == SURFACE_EXTERNAL:
        return None
    if iref.surface == SURFACE_POSTPRODUCTION:
        try:
            upstream = _load_shallow(
                project_root, iref.container, iref.ref, iref.version
            )
        except PostProductionNotFoundError as exc:
            raise PostProductionValidationError(
                f"input {iref.container}/{iref.ref} v{iref.version} does not exist"
            ) from exc
        if upstream.content_digest != iref.content_digest:
            raise PostProductionValidationError(
                f"input postproduction {iref.container}/{iref.ref} v{iref.version} "
                "digest does not match (forged or stale lineage)"
            )
        return upstream
    if iref.surface == SURFACE_CREATIVE:
        from ai_video_workflow.creative import index as creative_index

        try:
            upstream_digest = creative_index.load_artifact(
                project_root, iref.container, iref.ref, iref.version
            ).content_digest
        except Exception as exc:  # noqa: BLE001 - any creative load failure fails closed
            raise PostProductionValidationError(
                f"input creative {iref.container}/{iref.ref} v{iref.version} does not "
                f"resolve: {type(exc).__name__}"
            ) from exc
    else:  # SURFACE_MEDIA
        from ai_video_workflow.media import assets as media_assets

        try:
            upstream_digest = media_assets.load_asset(
                project_root, iref.container, iref.ref, iref.version
            ).content_digest
        except Exception as exc:  # noqa: BLE001 - any media load failure fails closed
            raise PostProductionValidationError(
                f"input media {iref.container}/{iref.ref} v{iref.version} does not "
                f"resolve: {type(exc).__name__}"
            ) from exc
    if upstream_digest != iref.content_digest:
        raise PostProductionValidationError(
            f"input {iref.surface} {iref.container}/{iref.ref} v{iref.version} digest "
            "does not match (forged or stale lineage)"
        )
    return None


def _parse_checklist_item(raw: object) -> ChecklistItem:
    if not isinstance(raw, Mapping):
        raise PostProductionError("checklist item must be an object")
    item = raw.get("item")
    verdict = raw.get("verdict")
    note = raw.get("note", "")
    if not (isinstance(item, str) and item.strip()):
        raise PostProductionError("checklist.item must be a non-empty string")
    if not (isinstance(verdict, str) and verdict.strip()):
        raise PostProductionError("checklist.verdict must be a non-empty string")
    if not isinstance(note, str):
        raise PostProductionError("checklist.note must be a string")
    return ChecklistItem(item, verdict, note)


def _verify_body_digest(project_root: Path, artifact: PostProductionArtifact) -> None:
    try:
        body_path = resolve_within_root(project_root, artifact.body_ref)
    except PathEscapeError as exc:
        raise PostProductionValidationError(
            f"body_ref escapes the project root: {artifact.body_ref!r}"
        ) from exc
    if not body_path.is_file():
        raise PostProductionValidationError(
            f"body_ref file does not exist: {artifact.body_ref!r}"
        )
    if file_sha256(body_path) != artifact.body_digest:
        raise PostProductionValidationError(
            f"body_ref digest mismatch for {artifact.ref!r}: body changed without a "
            "new index version"
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
                f"refusing to overwrite existing post-production artifact: {path}"
            ) from exc
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    return path

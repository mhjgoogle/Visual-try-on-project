"""Creative-approval gate with content binding (TASK-014 contract 1).

WFM1 keeps one human decision in code: a *stage* (e.g. ``concept_lock``)
must be **approved**, and the approval is **bound to the exact content**
it approved. Each approved target records its content digest; the gate
recomputes the current digest and, if it differs, the approval is
**automatically invalidated** (``StaleApprovalError``) — an edited shot
or story file can never silently keep an old approval.

Markers live per stage at ``<project-root>/approval/<stage>.json`` and
are read through the ADR-0004 containment resolver. The gate fails
**closed**: missing marker, non-approved status, missing target, or a
digest mismatch all block the caller.

Digests reuse the M1 ``digests.file_sha256`` (raw file bytes). A target
of kind ``"file"`` or ``"asset"`` both resolve to a project-relative
file (assets are stored as JSON records); ``version`` is recorded for
audit and is not part of the digest.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.approval.errors import (
    ApprovalError,
    NotApprovedError,
    StaleApprovalError,
)
from ai_video_workflow.digests import file_sha256
from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.security.paths import resolve_within_root

APPROVAL_DIR = "approval"
APPROVAL_SCHEMA_VERSION = 2

APPROVED = "approved"
# The workflow spec's creative states (§2), lower-cased. Only APPROVED
# opens the gate; every other state blocks.
_ALLOWED_STATUSES = frozenset(
    {"draft", "review_needed", "revision", "approved", "rejected"}
)
_ALLOWED_REF_KINDS = frozenset({"file", "asset"})
_MARKER_KEYS = frozenset(
    {
        "schema_version",
        "stage",
        "status",
        "approved_at",
        "approved_by",
        "approved_targets",
        "note",
    }
)
_TARGET_KEYS = frozenset({"ref_kind", "ref", "version", "content_digest"})
_SHA256_HEX_LEN = 64


@dataclass(frozen=True, slots=True)
class ApprovalTarget:
    """One content item an approval is bound to."""

    ref_kind: str
    ref: str
    version: int | None
    content_digest: str


@dataclass(frozen=True, slots=True)
class ApprovalMarker:
    """The human-maintained, content-bound stage approval marker."""

    schema_version: int
    stage: str
    status: str
    approved_at: str | None
    approved_by: str | None
    approved_targets: tuple[ApprovalTarget, ...]
    note: str | None


def marker_relpath(stage: str) -> str:
    """Return the project-relative path of a stage's approval marker."""
    _require_stage(stage)
    return f"{APPROVAL_DIR}/{stage}.json"


def load_approval(project_root: Path, stage: str) -> ApprovalMarker:
    """Read and validate a stage's approval marker (no digest check).

    Raises ``NotApprovedError`` if the marker is absent and
    ``ApprovalError`` if it exists but is malformed.
    """
    path = resolve_within_root(project_root, marker_relpath(stage))
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise NotApprovedError(
            f"no approval marker for stage {stage!r} at {path}; not approved"
        ) from exc
    except (OSError, UnicodeError) as exc:
        raise ApprovalError(f"unable to read approval marker: {path}") from exc
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise ApprovalError(f"approval marker is not valid JSON: {path}") from exc
    marker = parse_approval(raw)
    if marker.stage != stage:
        raise ApprovalError(
            f"approval marker stage {marker.stage!r} does not match "
            f"requested stage {stage!r}"
        )
    return marker


def require_stage_approved(project_root: Path, stage: str) -> ApprovalMarker:
    """Return the marker only if the stage is approved and content unchanged.

    Blocks (``NotApprovedError``) on a missing marker or non-approved
    status; blocks (``StaleApprovalError``) if any approved target's
    current content digest differs from the recorded one.
    """
    marker = load_approval(project_root, stage)
    if marker.status != APPROVED:
        raise NotApprovedError(
            f"stage {stage!r} status is {marker.status!r}, not {APPROVED!r}; "
            "generation is blocked"
        )
    for target in marker.approved_targets:
        current = _current_target_digest(project_root, target)
        if current != target.content_digest:
            raise StaleApprovalError(
                f"stage {stage!r} approval is stale: target {target.ref!r} content "
                f"changed since approval (recorded {target.content_digest[:12]}…, "
                f"now {current[:12]}…); re-approval required"
            )
    return marker


def parse_approval(raw: object) -> ApprovalMarker:
    """Build an ``ApprovalMarker`` from already-parsed JSON data."""
    if not isinstance(raw, dict):
        raise ApprovalError(
            f"approval marker: expected a JSON object, got {type(raw).__name__}"
        )
    _require_exact_keys(raw, _MARKER_KEYS, "approval marker")

    version = raw["schema_version"]
    if isinstance(version, bool) or not isinstance(version, int):
        raise ApprovalError("approval marker: schema_version must be an int")
    if version != APPROVAL_SCHEMA_VERSION:
        raise ApprovalError(f"approval marker: unsupported version {version}")

    stage = _require_stage(raw["stage"])

    status = raw["status"]
    if status not in _ALLOWED_STATUSES:
        raise ApprovalError(f"approval marker: unknown status {status!r}")

    approved_at = _optional_str(raw["approved_at"], "approved_at")
    approved_by = _optional_str(raw["approved_by"], "approved_by")
    note = _optional_str(raw["note"], "note")
    targets = _parse_targets(raw["approved_targets"])

    if status == APPROVED and (
        approved_at is None or approved_by is None or not targets
    ):
        raise ApprovalError(
            "approval marker: approved_at, approved_by, and a non-empty "
            "approved_targets are required when status is 'approved'"
        )

    return ApprovalMarker(
        schema_version=version,
        stage=stage,
        status=status,
        approved_at=approved_at,
        approved_by=approved_by,
        approved_targets=targets,
        note=note,
    )


# --- helpers --------------------------------------------------------------


def _current_target_digest(project_root: Path, target: ApprovalTarget) -> str:
    path = resolve_within_root(project_root, target.ref)
    try:
        return file_sha256(path)
    except AiVideoWorkflowError as exc:
        # A missing or unreadable approved target invalidates the approval.
        raise StaleApprovalError(
            f"approved target {target.ref!r} is missing or unreadable: {exc}"
        ) from exc


def _parse_targets(raw: object) -> tuple[ApprovalTarget, ...]:
    if not isinstance(raw, list):
        raise ApprovalError("approval marker: approved_targets must be a JSON array")
    targets: list[ApprovalTarget] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ApprovalError("approval marker: each target must be a JSON object")
        _require_exact_keys(item, _TARGET_KEYS, "approval target")
        ref_kind = item["ref_kind"]
        if ref_kind not in _ALLOWED_REF_KINDS:
            raise ApprovalError(f"approval target: unknown ref_kind {ref_kind!r}")
        ref = _require_nonempty_str(item["ref"], "ref")
        version = item["version"]
        if version is not None and (
            isinstance(version, bool) or not isinstance(version, int) or version < 1
        ):
            raise ApprovalError(
                "approval target: version must be a positive int or null"
            )
        digest = _require_nonempty_str(item["content_digest"], "content_digest")
        if len(digest) != _SHA256_HEX_LEN or any(
            c not in "0123456789abcdef" for c in digest
        ):
            raise ApprovalError(
                "approval target: content_digest must be a lowercase hex SHA-256"
            )
        targets.append(ApprovalTarget(ref_kind, ref, version, digest))
    return tuple(targets)


def _require_exact_keys(mapping: dict, allowed: frozenset[str], ctx: str) -> None:
    actual = frozenset(mapping)
    missing = allowed - actual
    if missing:
        raise ApprovalError(f"{ctx}: missing keys {sorted(missing)}")
    unknown = actual - allowed
    if unknown:
        raise ApprovalError(f"{ctx}: unknown keys {sorted(unknown)}")


def _require_stage(value: object) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ApprovalError(
            "approval marker: stage must be a non-empty, trimmed string"
        )
    if "/" in value or "\\" in value or value in (".", ".."):
        raise ApprovalError(f"approval marker: invalid stage name {value!r}")
    return value


def _require_nonempty_str(value: object, ctx: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ApprovalError(
            f"approval target: {ctx} must be a non-empty, trimmed string"
        )
    return value


def _optional_str(value: object, ctx: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value or value != value.strip():
        raise ApprovalError(
            f"approval marker: {ctx} must be a non-empty, trimmed string"
        )
    return value

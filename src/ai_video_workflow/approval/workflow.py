"""WFM1 stage registry, transitions, and change control (TASK-019).

Builds the L0/S1–S7 workflow states ON TOP of the TASK-015 approval-v2
markers (``approval/<stage>.json``) without changing their schema and
without touching GenerationTask / Manifest / Provider / QCD state.

- A fixed **stage registry** (ids, labels, prerequisites) lets a brand
  new project derive its complete stage plan before anything has run.
- **Transitions** follow the workflow spec §2 state machine
  (draft → review_needed → revision → approved; any → rejected), are
  validated against a fixed legality table, update the marker atomically,
  and append a structured record to the append-only audit log
  (``approval/audit.jsonl``, ADR-0012).
- **Approval** recomputes and locks the target digests (the TASK-015
  gate semantics are unchanged); approving a stage requires every
  prerequisite stage to be approved AND fresh, so an upstream content
  change automatically blocks downstream progress (StaleApprovalError).
- ``require_stage_ready`` is the downstream entry point: it feeds the
  SAME ``require_stage_approved`` gate the paid coordinator already
  uses — no second approval checkpoint is introduced.

Nothing here reads the clock: callers supply ``now``/``at`` strings.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.approval.errors import ApprovalError, NotApprovedError
from ai_video_workflow.approval.gate import (
    APPROVAL_SCHEMA_VERSION,
    ApprovalMarker,
    ApprovalTarget,
    load_approval,
    marker_relpath,
    parse_approval,
    require_stage_approved,
)
from ai_video_workflow.digests import file_sha256
from ai_video_workflow.security.paths import resolve_within_root

AUDIT_RELPATH = "approval/audit.jsonl"

# The WFM1 stage registry: one gate per workflow phase (L0, S1..S7),
# a linear prerequisite chain for the minimal single-episode flow.
_STAGE_ROWS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("concept_lock", "L0 创意定稿", ()),
    ("screenplay_lock", "S1 叙事设计", ("concept_lock",)),
    ("av_design_lock", "S2 视听设计", ("screenplay_lock",)),
    ("production_lock", "S3 生产设计", ("av_design_lock",)),
    ("assets_ready", "S4 素材制造", ("production_lock",)),
    ("assembly_done", "S5 装配后期", ("assets_ready",)),
    ("qc_release", "S6 质量与发布", ("assembly_done",)),
    ("retrospective", "S7 复盘归档", ("qc_release",)),
)

STAGE_IDS: tuple[str, ...] = tuple(row[0] for row in _STAGE_ROWS)

# status transition legality (workflow spec §2). key: (from, action) -> to
_TRANSITIONS: dict[tuple[str, str], str] = {
    ("draft", "review"): "review_needed",
    ("revision", "review"): "review_needed",
    ("review_needed", "approve"): "approved",
    ("revision", "approve"): "approved",
    ("review_needed", "revise"): "revision",
    ("rejected", "revise"): "revision",
    ("draft", "reject"): "rejected",
    ("review_needed", "reject"): "rejected",
    ("revision", "reject"): "rejected",
    ("approved", "reject"): "rejected",
}


@dataclass(frozen=True, slots=True)
class StageInfo:
    """One registry entry: identity + prerequisites (plan definition)."""

    stage_id: str
    label: str
    prerequisites: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class StageState:
    """One stage's derived current state."""

    stage_id: str
    label: str
    prerequisites: tuple[str, ...]
    status: str  # draft/review_needed/revision/approved/rejected
    stale: bool  # approved but a target's content has changed
    blocked_by: tuple[str, ...]  # prerequisites that are not approved+fresh


def stage_plan() -> tuple[StageInfo, ...]:
    """Return the full fixed stage plan (derivable before any run)."""
    return tuple(StageInfo(*row) for row in _STAGE_ROWS)


def _stage_info(stage_id: str) -> StageInfo:
    for row in _STAGE_ROWS:
        if row[0] == stage_id:
            return StageInfo(*row)
    raise ApprovalError(f"unknown stage {stage_id!r}; known: {list(STAGE_IDS)}")


def _current_marker(project_root: Path, stage_id: str) -> ApprovalMarker | None:
    try:
        return load_approval(project_root, stage_id)
    except NotApprovedError:
        return None  # absent marker == draft


def _is_fresh_approved(project_root: Path, stage_id: str) -> bool:
    try:
        require_stage_approved(project_root, stage_id)
        return True
    except NotApprovedError:
        return False


def stage_status(project_root: Path) -> tuple[StageState, ...]:
    """Derive every stage's current state from the authoritative markers."""
    states: list[StageState] = []
    for info in stage_plan():
        marker = _current_marker(project_root, info.stage_id)
        status = marker.status if marker is not None else "draft"
        stale = False
        if status == "approved":
            stale = not _is_fresh_approved(project_root, info.stage_id)
        blocked_by = tuple(
            pre
            for pre in info.prerequisites
            if not _is_fresh_approved(project_root, pre)
        )
        states.append(
            StageState(
                stage_id=info.stage_id,
                label=info.label,
                prerequisites=info.prerequisites,
                status=status,
                stale=stale,
                blocked_by=blocked_by,
            )
        )
    return tuple(states)


def require_stage_ready(project_root: Path, stage_id: str) -> None:
    """Downstream gate: the stage AND all its prerequisites must be
    approved with fresh digests (feeds the same TASK-015 gate the paid
    coordinator uses; upstream drift fails closed here)."""
    info = _stage_info(stage_id)
    for pre in info.prerequisites:
        require_stage_approved(project_root, pre)
    require_stage_approved(project_root, stage_id)


# --- transitions ------------------------------------------------------------


def transition_stage(
    project_root: Path,
    stage_id: str,
    action: str,
    *,
    at: str,
    by: str,
    reason: str | None = None,
    targets: tuple[str, ...] = (),
) -> ApprovalMarker:
    """Apply one legal transition, persist the marker, append the audit.

    ``approve`` recomputes and locks the digests of ``targets`` (project-
    relative files) and requires every prerequisite stage to be approved
    and fresh. Illegal transitions, unknown stages, and missing targets
    are typed errors; nothing is written on failure.
    """
    info = _stage_info(stage_id)
    if action not in ("review", "approve", "revise", "reject"):
        raise ApprovalError(f"unknown action {action!r}")
    marker = _current_marker(project_root, stage_id)
    from_status = marker.status if marker is not None else "draft"
    to_status = _TRANSITIONS.get((from_status, action))
    if to_status is None:
        raise ApprovalError(
            f"illegal transition: {stage_id} {from_status} --{action}--> ?"
        )
    if not by or not isinstance(by, str):
        raise ApprovalError("by: a non-empty actor is required")

    if action == "approve":
        # upstream must be approved AND fresh before anything downstream
        # is approved — this is the automatic upstream-change invalidation.
        for pre in info.prerequisites:
            require_stage_approved(project_root, pre)
        if not targets:
            raise ApprovalError("approve: at least one target is required")
        locked = tuple(
            ApprovalTarget(
                ref_kind="file",
                ref=target,
                version=None,
                content_digest=file_sha256(resolve_within_root(project_root, target)),
            )
            for target in targets
        )
        new_marker = ApprovalMarker(
            schema_version=APPROVAL_SCHEMA_VERSION,
            stage=stage_id,
            status="approved",
            approved_at=at,
            approved_by=by,
            approved_targets=locked,
            note=reason,
        )
    else:
        new_marker = ApprovalMarker(
            schema_version=APPROVAL_SCHEMA_VERSION,
            stage=stage_id,
            status=to_status,
            approved_at=None,
            approved_by=None,
            approved_targets=(),
            note=reason,
        )

    _write_marker(project_root, new_marker)
    _append_audit(
        project_root,
        {
            "stage": stage_id,
            "action": action,
            "from_status": from_status,
            "to_status": to_status,
            "at": at,
            "by": by,
            "reason": reason,
            "targets": [t.ref for t in new_marker.approved_targets],
        },
    )
    return new_marker


def _write_marker(project_root: Path, marker: ApprovalMarker) -> None:
    # validate through the same parser used by the gate, so a written
    # marker is always readable (no schema drift between writer and reader)
    payload_dict = {
        "schema_version": marker.schema_version,
        "stage": marker.stage,
        "status": marker.status,
        "approved_at": marker.approved_at,
        "approved_by": marker.approved_by,
        "approved_targets": [
            {
                "ref_kind": t.ref_kind,
                "ref": t.ref,
                "version": t.version,
                "content_digest": t.content_digest,
            }
            for t in marker.approved_targets
        ],
        "note": marker.note,
    }
    parse_approval(payload_dict)
    path = resolve_within_root(project_root, marker_relpath(marker.stage))
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
    import tempfile

    raw_fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(raw_fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)  # a status file: atomic replace by design
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _append_audit(project_root: Path, record: dict) -> None:
    path = resolve_within_root(project_root, AUDIT_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = (
        json.dumps(record, ensure_ascii=False, sort_keys=True, allow_nan=False) + "\n"
    ).encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, line)
        os.fsync(fd)
    finally:
        os.close(fd)


def read_audit(project_root: Path) -> tuple[dict, ...]:
    """Read the append-only transition audit (strict; torn tail tolerated)."""
    path = resolve_within_root(project_root, AUDIT_RELPATH)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ()
    except (OSError, UnicodeError) as exc:
        raise ApprovalError(f"unable to read approval audit: {path}") from exc
    segments = raw.split("\n")
    segments.pop()  # trailing newline -> empty; torn tail -> dropped fragment
    records = []
    for index, segment in enumerate(segments, start=1):
        try:
            record = json.loads(segment)
        except ValueError as exc:
            raise ApprovalError(f"approval audit line {index}: invalid JSON") from exc
        if not isinstance(record, dict):
            raise ApprovalError(f"approval audit line {index}: not an object")
        records.append(record)
    return tuple(records)

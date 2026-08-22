"""Tests for the content-bound creative-approval gate (TASK-014 c1)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ai_video_workflow.approval import (
    ApprovalError,
    NotApprovedError,
    StaleApprovalError,
    load_approval,
    marker_relpath,
    parse_approval,
    require_stage_approved,
)
from ai_video_workflow.digests import file_sha256
from ai_video_workflow.security.paths import PathEscapeError
from tests.symlink_support import symlink_or_skip

STAGE = "concept_lock"
REPO_ROOT = Path(__file__).resolve().parents[2]
EXAMPLE_MARKER = (
    REPO_ROOT
    / "examples"
    / "projects"
    / "minimal"
    / "approval"
    / "concept_lock.example.json"
)


def _setup_target(project_root: Path, rel: str = "records/shots/s.json") -> str:
    """Write a target file and return its digest."""
    path = project_root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"shot": 1}', encoding="utf-8")
    return file_sha256(path)


def _marker(
    digest: str, rel: str = "records/shots/s.json", *, status="approved"
) -> dict:
    return {
        "schema_version": 2,
        "stage": STAGE,
        "status": status,
        "approved_at": "2026-08-01T09:00:00+00:00" if status == "approved" else None,
        "approved_by": "owner" if status == "approved" else None,
        "approved_targets": [
            {
                "ref_kind": "file",
                "ref": rel,
                "version": 1,
                "content_digest": digest,
            }
        ]
        if status == "approved"
        else [],
        "note": None,
    }


def _write_marker(project_root: Path, marker: dict) -> None:
    path = project_root / marker_relpath(STAGE)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(marker), encoding="utf-8")


# --- happy path -----------------------------------------------------------


def test_approved_with_matching_digest_opens_gate(tmp_path: Path) -> None:
    digest = _setup_target(tmp_path)
    _write_marker(tmp_path, _marker(digest))
    marker = require_stage_approved(tmp_path, STAGE)
    assert marker.status == "approved"
    assert marker.approved_targets[0].content_digest == digest


def test_shipped_example_is_approved_and_bound() -> None:
    raw = json.loads(EXAMPLE_MARKER.read_text(encoding="utf-8"))
    marker = parse_approval(raw)
    assert marker.status == "approved"
    assert marker.stage == "concept_lock"
    assert len(marker.approved_targets) == 2


# --- auto-invalidation on content change ----------------------------------


def test_changed_content_invalidates_approval(tmp_path: Path) -> None:
    digest = _setup_target(tmp_path)
    _write_marker(tmp_path, _marker(digest))
    # edit the approved file after approval
    (tmp_path / "records/shots/s.json").write_text('{"shot": 2}', encoding="utf-8")
    with pytest.raises(StaleApprovalError, match="stale"):
        require_stage_approved(tmp_path, STAGE)


def test_missing_target_invalidates_approval(tmp_path: Path) -> None:
    digest = _setup_target(tmp_path)
    _write_marker(tmp_path, _marker(digest))
    (tmp_path / "records/shots/s.json").unlink()
    with pytest.raises(StaleApprovalError, match="missing or unreadable"):
        require_stage_approved(tmp_path, STAGE)


# --- fail-closed ----------------------------------------------------------


def test_missing_marker_blocks(tmp_path: Path) -> None:
    with pytest.raises(NotApprovedError, match="no approval marker"):
        require_stage_approved(tmp_path, STAGE)


def test_non_approved_status_blocks(tmp_path: Path) -> None:
    _write_marker(tmp_path, _marker("0" * 64, status="draft"))
    with pytest.raises(NotApprovedError, match="not 'approved'"):
        require_stage_approved(tmp_path, STAGE)


def test_stale_is_a_not_approved_error(tmp_path: Path) -> None:
    # StaleApprovalError subclasses NotApprovedError, so callers that catch
    # NotApprovedError still block.
    digest = _setup_target(tmp_path)
    _write_marker(tmp_path, _marker(digest))
    (tmp_path / "records/shots/s.json").write_text("changed", encoding="utf-8")
    with pytest.raises(NotApprovedError):
        require_stage_approved(tmp_path, STAGE)


def test_symlinked_approval_component_rejected(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "root"
    root.mkdir()
    symlink_or_skip(root / "approval", outside, target_is_directory=True)
    with pytest.raises(PathEscapeError):
        require_stage_approved(root, STAGE)


def test_stage_mismatch_rejected(tmp_path: Path) -> None:
    marker = _marker("0" * 64)
    marker["stage"] = "other_stage"
    _write_marker(tmp_path, marker)
    with pytest.raises(ApprovalError, match="does not match"):
        load_approval(tmp_path, STAGE)


# --- malformed marker -----------------------------------------------------


def test_approved_without_targets_rejected() -> None:
    marker = _marker("0" * 64)
    marker["approved_targets"] = []
    with pytest.raises(ApprovalError, match="approved_targets"):
        parse_approval(marker)


def test_bad_target_digest_rejected() -> None:
    marker = _marker("nothex")
    with pytest.raises(ApprovalError, match="content_digest"):
        parse_approval(marker)


def test_unknown_target_ref_kind_rejected() -> None:
    marker = _marker("0" * 64)
    marker["approved_targets"][0]["ref_kind"] = "spell"
    with pytest.raises(ApprovalError, match="ref_kind"):
        parse_approval(marker)


def test_unknown_marker_key_rejected() -> None:
    marker = _marker("0" * 64)
    marker["extra"] = 1
    with pytest.raises(ApprovalError, match="unknown keys"):
        parse_approval(marker)


def test_wrong_schema_version_rejected() -> None:
    marker = _marker("0" * 64)
    marker["schema_version"] = 1
    with pytest.raises(ApprovalError, match="unsupported version"):
        parse_approval(marker)


def test_invalid_stage_name_rejected() -> None:
    marker = _marker("0" * 64)
    marker["stage"] = "a/b"
    with pytest.raises(ApprovalError, match="invalid stage"):
        parse_approval(marker)

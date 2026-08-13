"""Containment/symlink admission tests (ADR-0004, TASK-013 blocker 1)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.composition.errors import CompositionToolError
from ai_video_workflow.composition.ffmpeg import _concat_quote
from ai_video_workflow.qcd.events import build_task_created_event
from ai_video_workflow.qcd.log import append_event, log_path
from ai_video_workflow.security import PathEscapeError, resolve_within_root
from tests.symlink_support import symlink_or_skip

T0 = datetime(2026, 7, 29, 8, 0, 0, tzinfo=timezone.utc)


def test_resolve_within_root_accepts_plain_relative(tmp_path) -> None:
    target = resolve_within_root(tmp_path, "a/b/c.json")
    assert target == tmp_path / "a" / "b" / "c.json"


def test_resolve_within_root_rejects_absolute(tmp_path) -> None:
    with pytest.raises(PathEscapeError):
        resolve_within_root(tmp_path, "/etc/passwd")


def test_resolve_within_root_rejects_parent_traversal(tmp_path) -> None:
    with pytest.raises(PathEscapeError):
        resolve_within_root(tmp_path, "../outside.json")


def test_resolve_within_root_rejects_symlinked_component(tmp_path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "project"
    root.mkdir()
    # a subdirectory of the project root is a symlink pointing outside
    symlink_or_skip(root / "qcd", outside, target_is_directory=True)
    with pytest.raises(PathEscapeError):
        resolve_within_root(root, "qcd/events/log.jsonl")


def test_resolve_within_root_allows_symlinked_ancestor_of_root(tmp_path) -> None:
    # the project root itself living under a symlink is not an escape
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    symlink_or_skip(link, real, target_is_directory=True)
    target = resolve_within_root(link, "reports/x.json")
    assert target == link / "reports" / "x.json"


def test_qcd_append_refuses_symlinked_log_dir(tmp_path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "project"
    root.mkdir()
    symlink_or_skip(root / "qcd", outside, target_is_directory=True)
    event = build_task_created_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id="task-shot-1-1",
        configured_provider_id="manual",
        origin="bootstrap",
        redo_of_task_id=None,
        occurred_at=T0,
    )
    with pytest.raises(PathEscapeError):
        append_event(root, event)
    # nothing was written outside the project root
    assert not (outside / "events" / "log.jsonl").exists()


def test_log_path_is_contained(tmp_path) -> None:
    assert log_path(tmp_path) == tmp_path / "qcd" / "events" / "log.jsonl"


def test_bootstrap_refuses_symlinked_records_dir(tmp_path) -> None:
    # a project subdirectory that bootstrap writes into is a symlink to an
    # external directory; bootstrap must refuse rather than write outside.
    from ai_video_workflow.app.bootstrap import bootstrap_generation_tasks
    from ai_video_workflow.models import Project, Scene, Shot
    from ai_video_workflow.project_data import ProjectData

    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "project"
    (root / "records").mkdir(parents=True)
    symlink_or_skip(
        root / "records" / "generation-tasks", outside, target_is_directory=True
    )
    data = ProjectData(
        project=Project("proj-1", "Demo", T0),
        scenes=(Scene("scene-1", "proj-1", 1, "S1", "d", T0),),
        shots=(
            Shot(
                shot_id="shot-1",
                scene_id="scene-1",
                sequence=1,
                description="d",
                prompt="p",
                duration_seconds=4.0,
                width=1280,
                height=720,
                frame_rate=24.0,
                created_at=T0,
            ),
        ),
    )
    with pytest.raises(PathEscapeError):
        bootstrap_generation_tasks(
            project_root=root, data=data, provider_id="manual", now=T0
        )
    assert not any(outside.iterdir())  # nothing written outside the root


def test_concat_quote_escapes_single_quote(tmp_path) -> None:
    tricky = tmp_path / "a'b.mp4"
    assert _concat_quote(tricky).endswith("a'\\''b.mp4")


def test_concat_quote_rejects_newline() -> None:
    with pytest.raises(CompositionToolError):
        _concat_quote(Path("/tmp/a\nb.mp4"))

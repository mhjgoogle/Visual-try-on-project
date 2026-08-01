"""Tests for WFM1 QC, release packaging, and archive (TASK-022)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import ai_video_workflow.cli as cli
from ai_video_workflow.app.contracts import staging_ref_for
from ai_video_workflow.profile import parse_project_profile, write_project_profile
from ai_video_workflow.release import (
    ArchiveError,
    QcError,
    ReleaseError,
    archive_project,
    package_release,
    record_final_review,
    run_technical_qc,
)
from tests.paid_fakes import FakeProvider
from tests.test_paid_lifecycle import TASK, _paid_submit, _seed_project, _use_fakes

AT = "2026-08-02T12:00:00+00:00"

_PROFILE = {
    "schema_version": 1,
    "version": 1,
    "title": "Demo Episode",
    "genre": "human-warmth short drama",
    "audience": "short-video viewers",
    "duration_target_seconds": 60,
    "aspect_ratio": "9:16",
    "language": "zh",
    "visual_style": "cinematic stylized",
    "release_targets": ["short-video-platform"],
    "budget_ref": "config/wfm1.json",
    "intent": "one irreversible kindness",
    "narrative_goals": ["fast open"],
    "quality_bar": ["face consistency"],
    "forbidden_issues": [],
    "success_criteria": ["watchable 60s cut"],
}


def _run(root, catalog_dir, *args) -> int:
    return cli.main(
        ["--project-root", str(root), "--catalog-dir", str(catalog_dir), *args]
    )


def _finished_episode(tmp_path: Path, monkeypatch) -> tuple[Path, Path]:
    """paid shot-1 + manual shot-2 -> validated assets -> composed final."""
    root, catalog_dir = _seed_project(tmp_path)
    fake = FakeProvider(provider_id="fake-a")
    _use_fakes(monkeypatch, fake)
    write_project_profile(root, parse_project_profile(_PROFILE))

    assert _run(root, catalog_dir, "init-tasks") == 0
    assert _paid_submit(root, catalog_dir, TASK, "shot-1") == 0
    assert _run(root, catalog_dir, "paid-integrate", TASK) == 0
    staged2 = root / staging_ref_for("task-shot-2-1")
    staged2.parent.mkdir(parents=True, exist_ok=True)
    staged2.write_bytes(b"user-media-2")
    for step in ("prepare", "submit", "report-artifact", "collect"):
        assert _run(root, catalog_dir, step, "task-shot-2-1") == 0
    assert _run(root, catalog_dir, "validate", "task-shot-2-1") == 0
    assert _run(root, catalog_dir, "compose") == 0
    return root, catalog_dir


def _load_project_data(root: Path):
    return cli._load_project_data(root)


# --- technical QC ------------------------------------------------------------


def test_technical_qc_passes_and_is_idempotent(tmp_path: Path, monkeypatch) -> None:
    root, _ = _finished_episode(tmp_path, monkeypatch)
    first = run_technical_qc(root, _load_project_data(root))
    assert first["passed"] is True
    assert first["created"] is True
    second = run_technical_qc(root, _load_project_data(root))
    assert second["version"] == first["version"]  # identical facts reused
    assert second["created"] is False
    # audio/subtitles are declared out of scope, not faked
    scope = [c for c in first["checks"] if c["check_id"] == "audio_subtitles"]
    assert "out of WFM1 scope" in scope[0]["detail"]


def test_technical_qc_fails_on_missing_media(tmp_path: Path, monkeypatch) -> None:
    root, _ = _finished_episode(tmp_path, monkeypatch)
    # remove one registered asset's media
    (root / "assets" / "media" / "s01_sh001_v1.mp4").unlink()
    outcome = run_technical_qc(root, _load_project_data(root))
    assert outcome["passed"] is False
    failing = [c for c in outcome["checks"] if not c["passed"]]
    assert any(c["check_id"] == "asset_media_present" for c in failing)


# --- final review + release ----------------------------------------------------


def test_release_requires_passing_fresh_review(tmp_path: Path, monkeypatch) -> None:
    root, _ = _finished_episode(tmp_path, monkeypatch)
    run_technical_qc(root, _load_project_data(root))

    # no review yet -> blocked
    with pytest.raises(ReleaseError, match="final review"):
        package_release(root)

    # failing verdict -> blocked
    record_final_review(
        root,
        verdict="fail",
        by="owner",
        at=AT,
        decision_reason="pacing drags in the middle",
        issue_tags=("pacing",),
    )
    with pytest.raises(ReleaseError, match="not 'pass'"):
        package_release(root)

    # passing verdict -> release, bound to the exact final digest
    review = record_final_review(
        root,
        verdict="pass",
        by="owner",
        at=AT,
        decision_reason="meets the goals baseline",
        compared_versions=("final_v1",),
        ai_assisted=True,
    )
    assert review["profile_ref"]["version"] == 1
    release = package_release(root)
    assert release["final_mp4"]["ref"] == "outputs/final_v1.mp4"
    assert release["metadata"]["title"] == "Demo Episode"
    # idempotent repackage
    again = package_release(root)
    assert again["version"] == release["version"]
    assert again["created"] is False


def test_stale_review_blocks_release(tmp_path: Path, monkeypatch) -> None:
    root, _ = _finished_episode(tmp_path, monkeypatch)
    run_technical_qc(root, _load_project_data(root))
    record_final_review(
        root,
        verdict="pass",
        by="owner",
        at=AT,
        decision_reason="ok",
    )
    # the final media changes AFTER the review (new composition version is
    # simulated by replacing the file content)
    (root / "outputs" / "final_v1.mp4").write_bytes(b"different-final")
    with pytest.raises(ReleaseError, match="stale approval never releases"):
        package_release(root)


def test_review_requires_reason_and_actor(tmp_path: Path, monkeypatch) -> None:
    root, _ = _finished_episode(tmp_path, monkeypatch)
    with pytest.raises(QcError, match="decision_reason"):
        record_final_review(
            root,
            verdict="pass",
            by="owner",
            at=AT,
            decision_reason="",
        )
    with pytest.raises(QcError, match="'pass' or 'fail'"):
        record_final_review(
            root,
            verdict="maybe",
            by="owner",
            at=AT,
            decision_reason="x",
        )


# --- archive + postmortem -------------------------------------------------------


def test_archive_inventory_and_recomputable_postmortem(
    tmp_path: Path, monkeypatch
) -> None:
    root, _ = _finished_episode(tmp_path, monkeypatch)
    run_technical_qc(root, _load_project_data(root))
    record_final_review(
        root,
        verdict="pass",
        by="owner",
        at=AT,
        decision_reason="ok",
    )
    package_release(root)

    outcome = archive_project(root, _load_project_data(root))
    manifest = json.loads(
        (root / "archive" / "archive_manifest_v1.json").read_text(encoding="utf-8")
    )
    # every reference is a relative POSIX path inside the project with a
    # digest that verifies against the actual file
    from ai_video_workflow.digests import file_sha256

    assert manifest["references"], "archive must reference key artifacts"
    for ref in manifest["references"]:
        assert not ref["ref"].startswith("/") and ".." not in ref["ref"]
        assert file_sha256(root / ref["ref"]) == ref["content_digest"]

    # postmortem derives from events and is recomputable: re-archiving
    # reuses the same version (identical derived content)
    again = archive_project(root, _load_project_data(root))
    assert again["postmortem_version"] == outcome["postmortem_version"]
    assert again["archive_manifest_version"] == outcome["archive_manifest_version"]
    pm = outcome["postmortem"]
    assert pm["cost_by_currency"].get("USD") == 10  # cloud cost, not copied
    assert "audio" in pm["out_of_scope"]


def test_archive_requires_release(tmp_path: Path, monkeypatch) -> None:
    root, _ = _finished_episode(tmp_path, monkeypatch)
    with pytest.raises(ArchiveError, match="no release package"):
        archive_project(root, _load_project_data(root))


def test_cli_qc_release_archive_flow(tmp_path: Path, monkeypatch) -> None:
    root, catalog_dir = _finished_episode(tmp_path, monkeypatch)
    assert _run(root, catalog_dir, "qc-run") == 0
    assert (
        _run(
            root,
            catalog_dir,
            "qc-review",
            "--verdict",
            "pass",
            "--by",
            "owner",
            "--reason",
            "meets goals",
        )
        == 0
    )
    assert _run(root, catalog_dir, "package-release") == 0
    assert _run(root, catalog_dir, "archive-project") == 0
    assert (root / "release" / "release_v1.json").is_file()
    assert (root / "archive" / "postmortem_v1.json").is_file()

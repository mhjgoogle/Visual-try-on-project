"""CLI tests for the evaluation-domain write path (TASK-028 / ADR-0034).

Exercises the eval-record / experiment-record / decision-record subcommands
wired to EvaluationService + WorkflowAuthoritativeFacts: happy-path append,
actor refusals (AI pass / AI select), and fail-closed binding (digest mismatch,
missing goals baseline). No provider, no network, no payment.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

import ai_video_workflow.cli as cli
from ai_video_workflow.evaluation import read_records
from ai_video_workflow.models import Project
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.profile.project_profile import (
    parse_project_profile,
    write_project_profile,
)
from ai_video_workflow.qcd.events import build_asset_imported_event
from ai_video_workflow.qcd.log import append_event

T0 = datetime(2026, 8, 3, 8, 0, 0, tzinfo=timezone.utc)
_DIGEST = "a" * 64
_DIGEST2 = "b" * 64

REPO_ROOT = Path(__file__).resolve().parents[2]
_PROFILE_EXAMPLE = (
    REPO_ROOT
    / "examples"
    / "projects"
    / "minimal"
    / "profile"
    / "project_profile_v1.example.json"
)


def _clock() -> datetime:
    return T0


def _import_asset(root: Path, *, asset_id: str, version: int, sha: str) -> None:
    append_event(
        root,
        build_asset_imported_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            asset_id=asset_id,
            sha256=sha,
            size_bytes=1024,
            path=f"assets/{asset_id}.mp4",
            version=version,
            duration_ms=2000,
            source_attempt_id=None,
            occurred_at=T0,
        ),
    )


@pytest.fixture
def project(tmp_path, monkeypatch):
    root = tmp_path / "project"
    root.mkdir()
    write_model_json(root / "project.json", Project("proj-1", "Demo", T0))
    raw = json.loads(_PROFILE_EXAMPLE.read_text(encoding="utf-8"))
    raw["version"] = 1
    write_project_profile(root, parse_project_profile(raw))
    _import_asset(root, asset_id="asset-a", version=1, sha=_DIGEST)
    _import_asset(root, asset_id="asset-b", version=2, sha=_DIGEST2)
    monkeypatch.setattr(cli, "utc_now", _clock)
    return root


def _run(project_root, *args) -> int:
    return cli.main(["--project-root", str(project_root), *args])


def _target_args(ref="asset-a", version=1, digest=_DIGEST) -> list[str]:
    return [
        "--target-ref",
        ref,
        "--target-version",
        str(version),
        "--target-digest",
        digest,
    ]


# --- eval-record -------------------------------------------------------------


def test_eval_record_user_pass_appends(project, capsys) -> None:
    code = _run(
        project,
        "eval-record",
        "--actor",
        "user",
        *_target_args(),
        "--id",
        "e-1",
        "--criterion",
        "clarity",
        "--score",
        "5",
        "--pass",
        "--rationale",
        "the user confirms the pass",
    )
    assert code == 0
    assert "pass=True" in capsys.readouterr().out
    records = read_records(project)
    assert len(records) == 1
    assert records[0].record_id == "evaluation:proj-1:e-1"
    assert records[0].goals_version == 1


def test_eval_record_ai_pass_is_refused(project, capsys) -> None:
    code = _run(
        project,
        "eval-record",
        "--actor",
        "ai",
        *_target_args(),
        "--id",
        "e-1",
        "--criterion",
        "clarity",
        "--pass",
        "--rationale",
        "AI cannot pass",
    )
    assert code == 1
    assert "EvaluationActorError" in capsys.readouterr().err
    assert read_records(project) == ()


def test_eval_record_ai_without_pass_appends(project) -> None:
    code = _run(
        project,
        "eval-record",
        "--actor",
        "ai",
        *_target_args(),
        "--id",
        "e-1",
        "--criterion",
        "clarity",
        "--rationale",
        "advisory only",
    )
    assert code == 0
    (record,) = read_records(project)
    assert record.payload["pass"] is False


def test_eval_record_digest_mismatch_fails_closed(project, capsys) -> None:
    code = _run(
        project,
        "eval-record",
        "--actor",
        "user",
        *_target_args(digest=_DIGEST2),  # wrong digest for asset-a v1
        "--id",
        "e-1",
        "--criterion",
        "clarity",
        "--pass",
        "--rationale",
        "digest does not match",
    )
    assert code == 1
    assert "StaleTargetError" in capsys.readouterr().err
    assert read_records(project) == ()


def test_eval_record_without_profile_fails_closed(tmp_path, monkeypatch, capsys):
    root = tmp_path / "noprofile"
    root.mkdir()
    write_model_json(root / "project.json", Project("proj-1", "Demo", T0))
    _import_asset(root, asset_id="asset-a", version=1, sha=_DIGEST)
    monkeypatch.setattr(cli, "utc_now", _clock)
    code = _run(
        root,
        "eval-record",
        "--actor",
        "user",
        *_target_args(),
        "--id",
        "e-1",
        "--criterion",
        "clarity",
        "--pass",
        "--rationale",
        "no goals baseline",
    )
    assert code == 1
    assert "MissingGoalsBaselineError" in capsys.readouterr().err


# --- experiment-record -------------------------------------------------------


def test_experiment_record_appends(project, capsys) -> None:
    code = _run(
        project,
        "experiment-record",
        "--actor",
        "user",
        *_target_args(),
        "--id",
        "x-1",
        "--variant",
        "asset-a",
        "1",
        _DIGEST,
        "--variant",
        "asset-b",
        "2",
        _DIGEST2,
        "--changed-factor",
        "prompt wording",
        "--expected-improvement",
        "tighter framing",
    )
    assert code == 0
    assert "2 variants" in capsys.readouterr().out
    (record,) = read_records(project)
    assert record.record_id == "experiment:proj-1:x-1"
    assert len(record.payload["variants"]) == 2


def test_experiment_record_unknown_variant_fails_closed(project, capsys) -> None:
    code = _run(
        project,
        "experiment-record",
        "--actor",
        "user",
        *_target_args(),
        "--id",
        "x-1",
        "--variant",
        "asset-a",
        "1",
        _DIGEST,
        "--variant",
        "asset-missing",
        "9",
        _DIGEST2,
        "--changed-factor",
        "prompt wording",
        "--expected-improvement",
        "tighter framing",
    )
    assert code == 1
    assert "StaleTargetError" in capsys.readouterr().err
    assert read_records(project) == ()


def test_experiment_record_non_integer_variant_version_is_clean_error(project, capsys):
    code = _run(
        project,
        "experiment-record",
        "--actor",
        "user",
        *_target_args(),
        "--id",
        "x-1",
        "--variant",
        "asset-a",
        "not-an-int",
        _DIGEST,
        "--variant",
        "asset-b",
        "2",
        _DIGEST2,
        "--changed-factor",
        "prompt wording",
        "--expected-improvement",
        "tighter framing",
    )
    # a malformed version is a normal validation error (exit 1), not a crash
    assert code == 1
    assert "FieldTypeError" in capsys.readouterr().err
    assert read_records(project) == ()


# --- decision-record ---------------------------------------------------------


def test_decision_record_user_select_appends(project, capsys) -> None:
    code = _run(
        project,
        "decision-record",
        "--actor",
        "user",
        *_target_args(),
        "--id",
        "d-1",
        "--decision-type",
        "select",
        "--changed",
        "picked asset-a",
        "--why",
        "clearest framing",
        "--expected",
        "ship it",
    )
    assert code == 0
    assert "select" in capsys.readouterr().out
    (record,) = read_records(project)
    assert record.record_id == "creative_decision:proj-1:d-1"


def test_decision_record_ai_select_is_refused(project, capsys) -> None:
    code = _run(
        project,
        "decision-record",
        "--actor",
        "ai",
        *_target_args(),
        "--id",
        "d-1",
        "--decision-type",
        "select",
        "--changed",
        "AI picks asset-a",
        "--why",
        "AI auto-winner",
        "--expected",
        "n/a",
    )
    assert code == 1
    assert "EvaluationActorError" in capsys.readouterr().err
    assert read_records(project) == ()


def test_decision_record_ai_abandon_appends(project) -> None:
    code = _run(
        project,
        "decision-record",
        "--actor",
        "ai",
        *_target_args(),
        "--id",
        "d-1",
        "--decision-type",
        "abandon",
        "--changed",
        "drop asset-a",
        "--why",
        "advisory suggestion",
        "--expected",
        "no gain",
    )
    assert code == 0
    (record,) = read_records(project)
    assert record.payload["decision_type"] == "abandon"

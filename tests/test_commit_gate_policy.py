"""Regression coverage for the local commit-gate risk classifier."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_POLICY_PATH = Path(__file__).parents[1] / ".claude" / "hooks" / "commit_gate_policy.py"
_SPEC = importlib.util.spec_from_file_location("commit_gate_policy", _POLICY_PATH)
assert _SPEC and _SPEC.loader
_POLICY = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _POLICY
_SPEC.loader.exec_module(_POLICY)


def test_docs_only_change_skips_test_execution() -> None:
    decision = _POLICY.classify(
        ["docs/tasks/TASK-063-risk-based-commit-gate.md", "README.md"]
    )

    assert decision.tier == "lint"


def test_workspace_change_runs_the_conservative_workspace_regression_set() -> None:
    decision = _POLICY.classify(
        [
            "src/ai_video_workflow/workspace/queries.py",
            "tests/test_workspace_queries.py",
        ]
    )

    assert decision.tier == "workspace"
    assert "tests/test_workspace_wfm1_acceptance.py" in decision.pytest_targets
    assert "tests/test_workspace_write.py" in decision.pytest_targets


def test_frontend_only_change_runs_frontend_suite() -> None:
    decision = _POLICY.classify(["mockups/motv-workspace/assets/app.js"])

    assert decision.tier == "frontend"


def test_test_only_change_runs_its_changed_test_file() -> None:
    decision = _POLICY.classify(["tests/test_validation.py"])

    assert decision.tier == "pytest-targeted"
    assert decision.pytest_targets == ("tests/test_validation.py",)


def test_conventional_source_runs_its_matching_test_file() -> None:
    decision = _POLICY.classify(["src/ai_video_workflow/validation.py"])

    assert decision.tier == "pytest-targeted"
    assert decision.pytest_targets == ("tests/test_validation.py",)


def test_persistence_and_mixed_surfaces_are_never_fast_laned() -> None:
    assert _POLICY.classify(["src/ai_video_workflow/persistence.py"]).tier == "full"
    assert (
        _POLICY.classify(
            ["src/workspace_shell/server.py", "mockups/motv-workspace/assets/app.js"]
        ).tier
        == "full"
    )


def test_deleted_high_risk_path_is_not_hidden_from_full_validation() -> None:
    decision = _POLICY.classify(
        [
            "docs/adr/ADR-0060-risk-based-local-commit-gate.md",
            "src/ai_video_workflow/persistence.py",
        ]
    )

    assert decision.tier == "full"

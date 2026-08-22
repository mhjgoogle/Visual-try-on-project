"""Guard tests for the WFM1 acceptance example (TASK-023).

The shipped ``examples/projects/wfm1-demo`` is a gate deliverable with a
deterministic runbook. These tests pin it against drift: the example must
keep compiling through the REAL CLI with exactly the packet counts and
yen preview its runbook promises (pinned below), and its locked catalog
digest must keep matching the repository's shipped catalog. No provider
is ever called
(compilation stops before any paid step).
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import ai_video_workflow.cli as cli
from ai_video_workflow.config import compute_catalog_digest

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
EXAMPLE_ROOT = REPOSITORY_ROOT / "examples" / "projects" / "wfm1-demo"
REUSE_ROOT = REPOSITORY_ROOT / "examples" / "reuse"
CATALOG_DIR = REPOSITORY_ROOT / "config" / "providers"

_APPROVALS = (
    ("concept_lock", "planning/brief_v1.json"),
    ("screenplay_lock", "planning/story_v1.json"),
    ("av_design_lock", "planning/prompts/p-mia-night/v1.json"),
    ("production_lock", "planning/shot_plan_v1.json"),
)


def _run(root: Path, *args: str) -> int:
    return cli.main(
        ["--project-root", str(root), "--catalog-dir", str(CATALOG_DIR), *args]
    )


def test_demo_config_digest_matches_shipped_catalog() -> None:
    config = json.loads(
        (EXAMPLE_ROOT / "config" / "wfm1.json").read_text(encoding="utf-8")
    )
    raw = json.loads((CATALOG_DIR / "wfm1-default.json").read_text(encoding="utf-8"))
    assert config["catalog_id"] == "wfm1-default"
    assert config["catalog_digest"] == compute_catalog_digest(raw)


def test_demo_example_compiles_exactly_as_its_runbook_promises(
    tmp_path: Path,
) -> None:
    # the runbook layout: a copied project + an account root holding reuse/
    account = tmp_path / "account"
    root = account / "demo"
    shutil.copytree(EXAMPLE_ROOT, root)
    shutil.copytree(REUSE_ROOT, account / "reuse")

    for stage, target in _APPROVALS:
        assert _run(root, "stage-review", stage, "--by", "ci") == 0
        assert _run(root, "stage-approve", stage, "--by", "ci", "--target", target) == 0
    assert _run(root, "init-tasks") == 0
    assert _run(root, "plan-compile", "--account-root", str(account)) == 0

    packets = sorted((root / "planning" / "packets").glob("shot-*_v1.json"))
    assert len(packets) == 8  # runbook: packets: 8
    parsed = [json.loads(p.read_text(encoding="utf-8")) for p in packets]
    assert sum(p["p50_jpy"] for p in parsed) == 128  # runbook: p50=128 JPY
    assert sum(p["p90_jpy"] for p in parsed) == 256  # runbook: p90=256 JPY
    # every packet locks the reuse asset by version + content digest
    for p in parsed:
        (ref,) = p["reuse_assets"]
        assert ref["asset_id"] == "character-mia"
        assert ref["version"] == 1
        assert len(ref["content_digest"]) == 64

    # the shipped example itself was never written to
    assert not (EXAMPLE_ROOT / "approval").exists()
    assert not (EXAMPLE_ROOT / "planning" / "packets").exists()
    assert not (EXAMPLE_ROOT / "records" / "generation-tasks").exists()

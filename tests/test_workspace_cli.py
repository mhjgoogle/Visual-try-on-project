"""Read-only workspace CLI harness tests (TASK-025 / ws-* subcommands)."""

from __future__ import annotations

import json
from pathlib import Path

import ai_video_workflow.cli as cli
from tests.test_wfm1_e2e import _paid_all_shots, _run, _setup


def _ws(root: Path, *args: str, capsys) -> dict:
    capsys.readouterr()  # drain any prior (setup) output first
    code = cli.main(["--project-root", str(root), *args])
    assert code == 0
    out = capsys.readouterr().out
    return json.loads(out)


def test_ws_subcommands_emit_dto(tmp_path, monkeypatch, capsys):
    root, catalog_dir, _ = _setup(tmp_path, monkeypatch)
    _paid_all_shots(root, catalog_dir)
    assert _run(root, catalog_dir, "compose") == 0

    plan = _ws(root, "ws-plan", capsys=capsys)
    assert plan["query_id"] == "WQ-01"
    assert plan["contract_version"] == "1.5"
    assert "contains_unavailable" in plan["markers"]
    # every item field carries a provenance tag (the read-only DTO shape)
    step = next(it for it in plan["items"] if it["step_id"]["value"] == "L0-07")
    assert step["step_id"]["provenance"] == "authoritative"
    assert step["run_status"]["provenance"] == "authoritative"  # implemented

    cost = _ws(root, "ws-cost", capsys=capsys)
    assert cost["query_id"] == "WQ-07"
    actual = cost["items"][0]["actual_by_currency"]
    assert actual["provenance"] == "derived"  # currency rollup is derived
    assert actual["value"]["USD"] == 60  # 6 shots x 10 minor units
    per_op = cost["items"][0]["per_operation"]
    assert per_op["provenance"] == "authoritative"  # raw per-op facts

    index = _ws(root, "ws-index", capsys=capsys)
    assert index["query_id"] == "WQ-11"
    assert any(it["project"]["value"] == "wfm1-demo" for it in index["items"])

    shot = _ws(root, "ws-shot", "--shot", "shot-1", capsys=capsys)
    assert shot["items"][0]["status"]["value"] == "committed"

    rebuild = _ws(root, "ws-rebuild-check", "--query", "WQ-07", capsys=capsys)
    assert rebuild["items"][0]["deterministic"]["value"] is True
    assert rebuild["items"][0]["read_only"]["value"] is True


def test_ws_reuse_and_budget(tmp_path, monkeypatch, capsys):
    root, catalog_dir, _ = _setup(tmp_path, monkeypatch)
    _paid_all_shots(root, catalog_dir)

    reuse = _ws(
        root, "ws-reuse", "--asset-id", "character-mia", "--version", "1", capsys=capsys
    )
    assert reuse["query_id"] == "WQ-12"
    assert reuse["items"]  # the demo references the reuse asset

    budget = _ws(root, "ws-budget", capsys=capsys)
    assert budget["items"][0]["budgets_jpy"]["value"]["episode_soft"] == 1200

"""motv creativeShotId ↔ server shot_id bridge — checkpoint M4c.

STRICTLY OFFLINE, no spend. Tests the server-side additive bridge helper
directly (pure), wraps the frontend M4c units, and guards the client/server
contract additions.

Covers the M4c guarantees:

- the server echoes the client's creative shot identities onto each official
  locked record (zipped by SEQUENCE, authoritative at lock time), separate from
  the server ``shot_id``; malformed / length-mismatched / duplicate bridges
  fail SAFE to ``creativeShotId = None``;
- the client sends ``creativeShotIds`` as a PARALLEL array and the server strips
  it before building the Core envelope (Core contract untouched);
- the frontend bridge builder + paid-op read-state join resolve by
  creativeShotId, never by draft sequence (via ``node --test``).
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
from pathlib import Path

import pytest

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"
_SERVER_PATH = _MOCKUP_DIR / "server.py"
_SRC = _MOCKUP_DIR / "src"


@pytest.fixture(scope="module")
def server_module():
    spec = importlib.util.spec_from_file_location(
        "motv_server_bridge_m4c", _SERVER_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _outcome(*seqs):
    return {
        "plan_version": 3,
        "shots": [{"shot_id": f"shot-p3-{s}", "sequence": s} for s in seqs],
    }


def test_bridge_echoes_creative_ids_by_sequence(server_module):
    b = server_module._bridge_creative_shot_ids
    out = b(_outcome(1, 2), ["shot-a", "shot-b"])
    assert out["shots"][0] == {
        "shot_id": "shot-p3-1",
        "sequence": 1,
        "creativeShotId": "shot-a",
    }
    assert out["shots"][1] == {
        "shot_id": "shot-p3-2",
        "sequence": 2,
        "creativeShotId": "shot-b",
    }
    # the official shot_id is never touched
    assert out["shots"][0]["shot_id"] == "shot-p3-1"


def test_bridge_maps_by_the_record_sequence_field_not_raw_index(server_module):
    b = server_module._bridge_creative_shot_ids
    # records arriving out of order still bind to the creative id at their sequence
    out = b(
        {"shots": [{"shot_id": "x2", "sequence": 2}, {"shot_id": "x1", "sequence": 1}]},
        ["c1", "c2"],
    )
    by_sid = {r["shot_id"]: r["creativeShotId"] for r in out["shots"]}
    assert by_sid == {"x1": "c1", "x2": "c2"}


def test_bridge_fails_safe_on_conflicts_and_mismatch(server_module):
    b = server_module._bridge_creative_shot_ids
    # duplicate creative id → all null (not a 1:1 bridge)
    dup = b(_outcome(1, 2), ["shot-a", "shot-a"])
    assert [r["creativeShotId"] for r in dup["shots"]] == [None, None]
    # length mismatch → all null
    mism = b(_outcome(1, 2), ["shot-a"])
    assert [r["creativeShotId"] for r in mism["shots"]] == [None, None]
    # non-string entries are simply absent for that sequence
    partial = b(_outcome(1, 2), ["shot-a", None])
    assert partial["shots"][0]["creativeShotId"] == "shot-a"
    assert partial["shots"][1]["creativeShotId"] is None


def test_bridge_fails_safe_on_malformed_sequences(server_module):
    b = server_module._bridge_creative_shot_ids
    # duplicate sequence → null EVERY mapping (not a partial bridge)
    dup_seq = b(
        {"shots": [{"shot_id": "x1", "sequence": 1}, {"shot_id": "x2", "sequence": 1}]},
        ["shot-a", "shot-b"],
    )
    assert [r["creativeShotId"] for r in dup_seq["shots"]] == [None, None]
    # missing / out-of-range sequence (not a 1..N permutation) → all null
    gap = b(
        {"shots": [{"shot_id": "x1", "sequence": 1}, {"shot_id": "x3", "sequence": 3}]},
        ["shot-a", "shot-b"],
    )
    assert [r["creativeShotId"] for r in gap["shots"]] == [None, None]
    # a non-int (or bool) sequence → all null
    bad = b(
        {
            "shots": [
                {"shot_id": "x1", "sequence": True},
                {"shot_id": "x2", "sequence": 2},
            ]
        },
        ["shot-a", "shot-b"],
    )
    assert [r["creativeShotId"] for r in bad["shots"]] == [None, None]
    # but every record still carries the KEY (null) so the client marks it M4c
    assert all("creativeShotId" in r for r in dup_seq["shots"])


def test_bridge_passes_through_unexpected_shapes(server_module):
    b = server_module._bridge_creative_shot_ids
    assert b({"shots": "nope"}, ["c1"]) == {"shots": "nope"}  # not a list → untouched
    assert b("not-a-dict", ["c1"]) == "not-a-dict"
    assert b(_outcome(1), None) == _outcome(1)  # no parallel array → untouched


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_bridge_units_via_node() -> None:
    """creativeShotId↔server 桥 + 付费读状态按身份联结 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/shot_bridge.test.mjs", "tests/workspaces.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_client_sends_creative_ids_and_server_strips_before_core() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    assert "creativeShotIds" in app  # client sends the parallel array at lock time
    server = _SERVER_PATH.read_text("utf-8")
    # server strips it from params before building the Core envelope
    assert 'k != "creativeShotIds"' in server
    assert "_bridge_creative_shot_ids" in server


def test_paid_op_join_uses_the_bridge_not_sequence() -> None:
    ws = (_SRC / "ui" / "workspaces.js").read_text("utf-8")
    assert "serverShotIdForShot" in ws
    assert "buildServerBridge" in ws
    # the old positional helper is gone from the read model
    assert "shots[seq - 1]" not in ws


def test_core_contracts_untouched_by_m4c() -> None:
    core = Path(__file__).resolve().parents[1] / "src" / "ai_video_workflow"
    assert core_files_containing("creativeShotId", core) == []

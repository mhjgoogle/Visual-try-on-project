"""motv canvas persistence — schema-version dispatch (checkpoint M1).

Drives the mockup backend (``mockups/motv-workspace/server.py`` ``_App``)
directly — no sockets, no browser, STRICTLY OFFLINE, no spend.

Covers the persistence-only M1 guarantees:

- a corrupt ``data/<name>.json`` is never served as an empty project: GET
  answers 409 ``corrupt_save`` and copies the corrupt bytes aside (idempotent,
  digest-named backup; the original file is never moved or deleted);
- PUT over an unparseable existing save secures the same backup before the
  atomic replace, so the only copy of recoverable creator data cannot be
  destroyed by an autosave;
- absent / valid saves keep their existing behavior (200 ``{}`` / 200 doc);
- the frontend dispatcher units (version read, sequential migration chain,
  fail-safe newer/invalid handling, save blocking, unknown-field round-trip)
  via ``node --test``;
- the app serializer emits the authoritative schema version constant and the
  load path actually routes through the dispatcher (source-level guard).
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

import pytest

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"
_SERVER_PATH = _MOCKUP_DIR / "server.py"


@pytest.fixture(scope="module")
def server_module():
    spec = importlib.util.spec_from_file_location("motv_server_canvas_m1", _SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def data_dir(server_module, tmp_path: Path, monkeypatch) -> Path:
    d = tmp_path / "mockdata"
    d.mkdir()
    monkeypatch.setattr(server_module, "DATA_DIR", d)
    return d


def _get(app, name: str):
    resp = app.handle(f"/api/canvas/{name}")
    return resp.status, json.loads(resp.body.decode("utf-8"))


def _put(app, name: str, body: bytes):
    resp = app.handle_put(f"/api/canvas/{name}", body, "application/json")
    return resp.status, json.loads(resp.body.decode("utf-8"))


V1_DOC = {
    "v": 1,
    "project": "p1",
    "scriptDoc": None,
    "nodes": [],
    "edges": [],
    "pan": {"x": 0, "y": 0},
}


# --- GET: absent / valid keep existing behavior ------------------------------


def test_get_absent_canvas_is_empty_object(server_module, data_dir):
    app = server_module._App(None, None)
    status, body = _get(app, "nosuch")
    assert status == 200
    assert body == {}


def test_get_valid_v1_canvas_roundtrips(server_module, data_dir):
    (data_dir / "p1.json").write_text(json.dumps(V1_DOC), "utf-8")
    app = server_module._App(None, None)
    status, body = _get(app, "p1")
    assert status == 200
    assert body == V1_DOC


# --- GET: corrupt save fails safe, never collapses to {} ---------------------


def test_get_corrupt_canvas_is_409_with_idempotent_backup(server_module, data_dir):
    corrupt = b'{"v": 1, "nodes": [truncated'
    (data_dir / "p1.json").write_bytes(corrupt)
    app = server_module._App(None, None)

    status, body = _get(app, "p1")
    assert status == 409
    assert body["error"]["category"] == "corrupt_save"

    # original untouched, digest-named backup created exactly once
    assert (data_dir / "p1.json").read_bytes() == corrupt
    backups = sorted(data_dir.glob("p1.json.corrupt-*"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == corrupt

    # repeated GETs (page reloads) do not accumulate backups
    status, _ = _get(app, "p1")
    assert status == 409
    assert len(sorted(data_dir.glob("p1.json.corrupt-*"))) == 1


def test_backup_name_cannot_be_served_as_a_canvas(server_module, data_dir):
    # names disallow dots, so ``p1.json.corrupt-xxx`` is unreachable via the API
    app = server_module._App(None, None)
    status, body = _get(app, "p1.json.corrupt-abc")
    assert status == 400


# --- PUT: overwriting a corrupt save secures the backup first ----------------


def test_put_over_corrupt_canvas_backs_up_then_writes(server_module, data_dir):
    corrupt = b"not json at all"
    (data_dir / "p1.json").write_bytes(corrupt)
    app = server_module._App(None, None)

    status, body = _put(app, "p1", json.dumps(V1_DOC).encode("utf-8"))
    assert status == 200
    assert body == {"ok": True}

    backups = sorted(data_dir.glob("p1.json.corrupt-*"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == corrupt  # recoverable copy preserved
    assert json.loads((data_dir / "p1.json").read_text("utf-8")) == V1_DOC


def test_put_over_valid_canvas_creates_no_backup(server_module, data_dir):
    (data_dir / "p1.json").write_text(json.dumps(V1_DOC), "utf-8")
    app = server_module._App(None, None)
    status, _ = _put(
        app, "p1", json.dumps({**V1_DOC, "pan": {"x": 5, "y": 5}}).encode("utf-8")
    )
    assert status == 200
    assert list(data_dir.glob("p1.json.corrupt-*")) == []


# --- source-level guards ------------------------------------------------------


def test_serializer_emits_authoritative_version_and_load_dispatches() -> None:
    app_src = (_MOCKUP_DIR / "src" / "app.js").read_text("utf-8")
    assert "v: CANVAS_SCHEMA_VERSION" in app_src  # save emits the constant
    # the serializer itself carries no hardcoded schema version
    serializer = app_src.split("function serializeGraph()")[1].split(
        "function restoreGraph"
    )[0]
    assert "v: 1" not in serializer
    persist_src = (_MOCKUP_DIR / "src" / "services" / "persist.js").read_text("utf-8")
    assert "migrateToCurrent" in persist_src  # every load routes the dispatcher


# --- frontend dispatcher units (node --test) ---------------------------------


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_persistence_units_via_node() -> None:
    """版本读取/顺序迁移/过新拒绝/坏档阻断保存/未知字段往返 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/persistence.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr

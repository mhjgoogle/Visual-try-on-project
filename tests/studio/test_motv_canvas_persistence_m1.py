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
- absent / valid saves keep their existing behavior (200 ``{}`` / 200 doc).

The source-level guard (the app serializer emits the authoritative schema
version constant and the load path routes through the dispatcher) reads
``app.js`` and moved to
``tests/contract/test_frontend_write_path_invariants.py`` (TASK-102 批次 E).

The frontend dispatcher units live in
``mockups/motv-workspace/tests/persistence.test.mjs`` and run in the frontend
suite directly (TASK-102 批次 B removed the subprocess wrapper).
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
_SERVER_PATH = _MOCKUP_DIR / "server.py"
# server.py imports its sibling `rootadmit`; without this the module only loads
# when some OTHER test file happens to have put the mockup dir on sys.path first
if str(_MOCKUP_DIR) not in sys.path:
    sys.path.insert(0, str(_MOCKUP_DIR))


@pytest.fixture(scope="module")
def server_module():
    spec = importlib.util.spec_from_file_location("motv_server_canvas_m1", _SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def data_dir(server_module, tmp_path: Path, monkeypatch) -> Path:
    """The canvas now lives at ``<ProjectRoot>/studio/canvas.json`` (ADR-0053),
    so these persistence guarantees are exercised against a REAL project root.
    The returned directory is that project's ``studio/`` folder — the same
    place the old ``data/<name>.json`` used to be, one layer in."""
    legacy = tmp_path / "mockdata"
    legacy.mkdir()
    monkeypatch.setattr(server_module, "DATA_DIR", legacy)
    monkeypatch.setattr(server_module, "APP_DATA_DIR", tmp_path / "app-data")
    account = tmp_path / "account"
    (account / "p1").mkdir(parents=True)
    (account / "p1" / "project.json").write_text(
        json.dumps({"project_id": "p1", "name": "p1"}), "utf-8"
    )
    (account / "nosuch-not-created").mkdir(parents=True, exist_ok=True)
    d = account / "p1" / "studio"
    d.mkdir()
    return d


def _app(server_module, data_dir: Path):
    """An app that knows about project ``p1``.

    Project discovery needs the workspace query service, which is not loaded in
    this unit-level suite, so the mapping discovery WOULD produce is registered
    directly — the canvas path is derived from it either way (ADR-0053).
    """
    account = data_dir.parents[1]
    app = server_module._App(account)
    app._projects["p1"] = account / "p1"
    return app


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


# --- 并发读者：保存不许因为「有人正在读」而失败 -------------------------------


def test_replace_retries_while_a_reader_still_holds_the_file(server_module) -> None:
    """机制：被读者挡住时**重试**，而不是把他打的字丢掉。

    Windows 上 `os.replace` 覆盖一个正被打开读的文件抛 `PermissionError`
    （本机确定性复现）；POSIX 上允许。canvas.json 的读者到处都是 —— 服务端为
    运行中的 run 组装事实要读它、`_canvas_get` 要读它、备份/同步软件也可能开着。
    冲突是**短暂**的，所以重试；注入的 `sleep` 在第一次间歇里把读者放掉，
    于是这条用例断言的是「**它确实重试过并因此成功**」，不是「它睡了多久」。
    """
    import tempfile

    d = Path(tempfile.mkdtemp(prefix="motv-replace-"))
    target = d / "canvas.json"
    target.write_text("{}", encoding="utf-8")
    fd, tmp = tempfile.mkstemp(dir=str(d), suffix=".tmp")
    import os as _os

    with _os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write('{"kept": 1}')

    reader = target.open("r", encoding="utf-8")
    reader.read(1)
    naps = []

    def _release(_seconds):
        naps.append(_seconds)
        reader.close()  # 读者读完就松手 —— 现实里也是这样

    try:
        attempts = server_module._replace_retrying(tmp, target, sleep=_release)
    finally:
        reader.close()

    if _os.name == "nt":
        assert naps, "读者在场时第一次就成功了？那这条守卫没驱动到重试"
        assert attempts >= 1, "没有重试就成功了"
    assert json.loads(target.read_text("utf-8"))["kept"] == 1


def test_a_save_is_not_lost_because_someone_is_reading_the_file(
    server_module, data_dir
) -> None:
    """接线：整条 PUT 走下来，读者在场也不许把他打的字丢掉（§6.12 的根因）。

    实测（旅程 e2e，干净树上 8 跑 2 红）：服务端**收到了**带着那段字的 PUT，
    却返回 `500 write_failed`，客户端拿到非 200 之后一声不吭地塞进 localStorage
    —— 屏幕上有字、盘上没有、控制台没声音。
    """
    app = _app(server_module, data_dir)
    target = data_dir / "canvas.json"
    status, _ = _put(app, "p1", json.dumps(V1_DOC).encode())
    assert status == 200

    kept = dict(V1_DOC)
    kept["story"] = {"core": "雨夜，一个人走进了旧屋。"}
    reader = target.open("r", encoding="utf-8")
    reader.read(1)
    import time as _t

    real_sleep = _t.sleep
    try:
        _t.sleep = lambda _s: reader.close()  # 第一次间歇里读者松手
        status, body = _put(app, "p1", json.dumps(kept).encode())
    finally:
        _t.sleep = real_sleep
        reader.close()

    assert status == 200, body  # 500 = 他刚打的字被丢掉了，而且没人告诉他
    saved = json.loads(target.read_text("utf-8"))
    assert saved["story"]["core"], "返回了 200，盘上却没有那段字"


def test_a_save_that_really_cannot_be_written_says_why(server_module, data_dir) -> None:
    """重试之后仍然失败时，**原因要照带**，不许压成一句「could not save」。

    第一版把 `OSError` 整个咽掉了：跨卷、只读目录、磁盘满、被杀毒软件锁住 ——
    全都长成同一句话，下一个人无从查起（同 §10643 那条已经吃过一次的亏）。
    """
    app = _app(server_module, data_dir)
    import os as _os

    def _always_denied(*_a, **_k):
        raise PermissionError(13, "测试专用：磁盘满了")

    real = _os.replace
    _os.replace = _always_denied
    try:
        status, body = _put(app, "p1", json.dumps(V1_DOC).encode())
    finally:
        _os.replace = real
    assert status == 500
    detail = body["error"]["detail"]
    # 断言**原因真的活下来了**，不是只断言「不等于旧那句话」——
    # 后者在 detail 变成任何一句新的固定文案时同样成立，等于没查
    # （codex 2026-09-06 判 NOT_EVIDENCED，说得对）。
    assert "PermissionError" in detail, detail  # 异常类型
    assert "测试专用：磁盘满了" in detail, detail  # 异常自己那句话
    assert detail != "could not save"


# --- GET: absent / valid keep existing behavior ------------------------------


def test_get_absent_canvas_is_empty_object(server_module, data_dir):
    """A KNOWN project with nothing saved yet is an empty document."""
    app = _app(server_module, data_dir)
    status, body = _get(app, "p1")
    assert status == 200
    assert body == {}


def test_get_canvas_of_an_unknown_project_is_404(server_module, data_dir):
    """ADR-0053: there is no scratch file to fall back to — an unknown project
    must not resolve to one."""
    app = _app(server_module, data_dir)
    status, _ = _get(app, "nosuch")
    assert status == 404


def test_get_valid_v1_canvas_roundtrips(server_module, data_dir):
    (data_dir / "canvas.json").write_text(json.dumps(V1_DOC), "utf-8")
    app = _app(server_module, data_dir)
    status, body = _get(app, "p1")
    assert status == 200
    assert body == V1_DOC


# --- GET: corrupt save fails safe, never collapses to {} ---------------------


def test_get_corrupt_canvas_is_409_with_idempotent_backup(server_module, data_dir):
    corrupt = b'{"v": 1, "nodes": [truncated'
    (data_dir / "canvas.json").write_bytes(corrupt)
    app = _app(server_module, data_dir)

    status, body = _get(app, "p1")
    assert status == 409
    assert body["error"]["category"] == "corrupt_save"

    # original untouched, digest-named backup created exactly once
    assert (data_dir / "canvas.json").read_bytes() == corrupt
    backups = sorted(data_dir.glob("canvas.json.corrupt-*"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == corrupt

    # repeated GETs (page reloads) do not accumulate backups
    status, _ = _get(app, "p1")
    assert status == 409
    assert len(sorted(data_dir.glob("canvas.json.corrupt-*"))) == 1


def test_backup_name_cannot_be_served_as_a_canvas(server_module, data_dir):
    # names disallow dots, so ``p1.json.corrupt-xxx`` is unreachable via the API
    app = _app(server_module, data_dir)
    status, body = _get(app, "p1.json.corrupt-abc")
    # not a known project, so it cannot be served at all
    assert status == 404


# --- PUT: overwriting a corrupt save secures the backup first ----------------


def test_put_over_corrupt_canvas_backs_up_then_writes(server_module, data_dir):
    corrupt = b"not json at all"
    (data_dir / "canvas.json").write_bytes(corrupt)
    app = _app(server_module, data_dir)

    status, body = _put(app, "p1", json.dumps(V1_DOC).encode("utf-8"))
    assert status == 200
    assert body == {"ok": True}

    backups = sorted(data_dir.glob("canvas.json.corrupt-*"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == corrupt  # recoverable copy preserved
    assert json.loads((data_dir / "canvas.json").read_text("utf-8")) == V1_DOC


def test_put_over_valid_canvas_creates_no_backup(server_module, data_dir):
    (data_dir / "canvas.json").write_text(json.dumps(V1_DOC), "utf-8")
    app = _app(server_module, data_dir)
    status, _ = _put(
        app, "p1", json.dumps({**V1_DOC, "pan": {"x": 5, "y": 5}}).encode("utf-8")
    )
    assert status == 200
    assert list(data_dir.glob("canvas.json.corrupt-*")) == []

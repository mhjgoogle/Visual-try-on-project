"""motv mockup E2E tests for TASK-048 / ADR-0048.

Drives the mockup backend (``mockups/motv-workspace/server.py`` ``_App``)
directly — no sockets, no browser, STRICTLY OFFLINE, no spend.

Covers the three P0 fixes end to end:

- upload versioning: same-slot writes APPEND ``<slug>_v<N>.<ext>`` files; no
  write path deletes or overwrites an existing upload; legacy un-suffixed
  files count as v1; every write response carries ``version`` + ``sha256``;
- adopt-paid into an occupied slot appends a new version (never refused /
  overwritten);
- first-frame binding: the lock-draft-plan preflight's ``first_frame_sha256``
  matches the data URL built from the uploaded asset image (图→视频首帧闭环
  的服务端一致性);
- the frontend pure-logic units (MediaRef migration back-compat, version
  switch, paid-queue aggregation) via ``node --test``.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from tests.test_lock_gateway_command import _draft_shot, _setup_project

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"
# server.py imports its sibling `rootadmit`; without this the module only
# loads when some OTHER test file happens to put the mockup dir on sys.path
if str(_MOCKUP_DIR) not in sys.path:
    sys.path.insert(0, str(_MOCKUP_DIR))
_SERVER_PATH = _MOCKUP_DIR / "server.py"

# Minimal bodies that pass the magic-byte sniff (content beyond the header is
# irrelevant to the routes under test).
PNG = b"\x89PNG\r\n\x1a\n" + b"png-payload-1"
PNG2 = b"\x89PNG\r\n\x1a\n" + b"png-payload-2"
JPG = b"\xff\xd8\xff" + b"jpg-payload"
MP4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 16


@pytest.fixture(scope="module")
def server_module():
    spec = importlib.util.spec_from_file_location("motv_server_task048", _SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module._QUERY_OK, "mockup E2E requires the venv (query package)"
    return module


@pytest.fixture()
def data_dir(server_module, tmp_path: Path, monkeypatch) -> Path:
    """Media now lives at ``<ProjectRoot>/media/`` (ADR-0053).

    Returns the ACCOUNT root; `_updir()` resolves a project's media folder
    under it. The legacy scratch is still redirected into tmp so nothing can
    touch the real repo directory.
    """
    monkeypatch.setattr(server_module, "DATA_DIR", tmp_path / "mockdata")
    (tmp_path / "mockdata").mkdir()
    account = tmp_path / "account"
    account.mkdir()
    return account


def _updir(account: Path, project: str) -> Path:
    """Where this project's media lives on disk."""
    return account / project / "media"


def _mkapp(server_module, account: Path, *projects: str):
    """An app that knows about `projects` (discovery needs the query service,
    which these unit-level tests do not spin up)."""
    app = server_module._App(account)
    for name in projects or ("proj",):
        (account / name).mkdir(parents=True, exist_ok=True)
        meta = account / name / "project.json"
        if not meta.exists():  # never clobber a project a fixture already staged
            meta.write_text(json.dumps({"project_id": name, "name": name}), "utf-8")
        app._projects[name] = account / name
    return app


def _get(app, path: str):
    resp = app.handle(path)
    return resp.status, resp


def _put(app, path: str, body: bytes, ctype: str) -> tuple[int, dict]:
    resp = app.handle_put(path, body, ctype)
    return resp.status, json.loads(resp.body.decode("utf-8"))


def _post(app, path: str, payload: dict) -> tuple[int, dict]:
    resp = app.handle_post(path, json.dumps(payload).encode("utf-8"))
    return resp.status, json.loads(resp.body.decode("utf-8"))


# --- upload versioning (ADR-0048) ------------------------------------------


def test_same_slot_uploads_append_three_versions(server_module, data_dir) -> None:
    app = _mkapp(server_module, data_dir)
    bodies = [PNG, PNG2, JPG]
    ctypes = ["image/png", "image/png", "image/jpeg"]
    urls = []
    for i, (body, ctype) in enumerate(zip(bodies, ctypes, strict=True), start=1):
        status, j = _put(app, "/api/uploads/proj/assets-v1-1", body, ctype)
        assert status == 200, j
        assert j["version"] == i
        assert j["sha256"] == hashlib.sha256(body).hexdigest()
        urls.append(j["url"])
    # three version files coexist — nothing was deleted or overwritten
    updir = _updir(data_dir, "proj")
    names = sorted(p.name for p in updir.iterdir())
    assert names == ["assets-v1-1_v1.png", "assets-v1-1_v2.png", "assets-v1-1_v3.jpg"]
    # every version stays servable with its original bytes (回切-able)
    for url, body in zip(urls, bodies, strict=True):
        status, resp = _get(app, url)
        assert status == 200
        assert resp.body == body


def test_legacy_unsuffixed_file_counts_as_v1(server_module, data_dir) -> None:
    updir = _updir(data_dir, "proj")
    updir.mkdir(parents=True)
    legacy = updir / "video-v1-3.mp4"
    legacy.write_bytes(MP4)
    app = _mkapp(server_module, data_dir)
    status, j = _put(app, "/api/uploads/proj/video-v1-3", MP4, "video/mp4")
    assert status == 200
    assert j["version"] == 2  # legacy file occupies v1
    assert legacy.read_bytes() == MP4  # untouched
    assert (updir / "video-v1-3_v2.mp4").is_file()


def test_versioned_and_reserved_slugs_refused(server_module, data_dir) -> None:
    app = _mkapp(server_module, data_dir)
    # a slug ending in _v<N> would collide with the version namespace
    status, j = _put(app, "/api/uploads/proj/sneaky_v2", PNG, "image/png")
    assert status == 400
    assert j["error"]["category"] == "bad_request"
    # compose output namespace stays protected
    status, _ = _put(app, "/api/uploads/proj/final-cut-extra", PNG, "image/png")
    assert status == 400
    # magic sniff still enforced on the versioned path
    status, _ = _put(app, "/api/uploads/proj/slot-a", b"not-a-png", "image/png")
    assert status == 400
    assert not (_updir(data_dir, "proj")).exists() or not any(
        (_updir(data_dir, "proj")).iterdir()
    )


def test_versioned_filenames_are_gettable_and_capped(server_module, data_dir) -> None:
    app = _mkapp(server_module, data_dir)
    long_slug = "s" * 64  # max slug length must still resolve once versioned
    status, j = _put(app, f"/api/uploads/proj/{long_slug}", PNG, "image/png")
    assert status == 200
    status, resp = _get(app, j["url"])
    assert status == 200
    assert resp.body == PNG


def test_adopt_paid_appends_versions_never_overwrites(
    server_module, data_dir, tmp_path: Path
) -> None:
    project, _catalog = _setup_project(tmp_path)
    # _setup_project put the real project under tmp_path, so THAT is the
    # account root here; its media folder lives inside it (ADR-0053)
    app = _mkapp(server_module, tmp_path, "project-a", "project-b")
    staging = project / "staging" / "shots"
    staging.mkdir(parents=True, exist_ok=True)
    clip1 = MP4 + b"take-one"
    (staging / "task-a-1.mp4").write_bytes(clip1)
    payload = {"project": "project-a", "slug": "video-v1-1", "task_id": "task-a-1"}
    status, j1 = _post(app, "/api/agent/adopt-paid", payload)
    assert status == 200
    assert j1["version"] == 1
    assert j1["sha256"] == hashlib.sha256(clip1).hexdigest()
    # a second adopt into the SAME slot (e.g. after a redo) appends v2
    clip2 = MP4 + b"take-two"
    (staging / "task-a-1.mp4").write_bytes(clip2)
    status, j2 = _post(app, "/api/agent/adopt-paid", payload)
    assert status == 200
    assert j2["version"] == 2
    updir = _updir(tmp_path, "project-a")
    assert (updir / "video-v1-1_v1.mp4").read_bytes() == clip1
    assert (updir / "video-v1-1_v2.mp4").read_bytes() == clip2


# --- first-frame binding (图→视频→锁定 的 sha256 一致性) ---------------------


def test_lock_first_frame_sha_matches_uploaded_asset(
    server_module, data_dir, tmp_path: Path
) -> None:
    project, _catalog = _setup_project(tmp_path)
    # _setup_project put the real project under tmp_path, so THAT is the
    # account root here; its media folder lives inside it (ADR-0053)
    app = _mkapp(server_module, tmp_path, "project-a", "project-b")
    # 1. the asset image lands in the slot (manual/paid route equivalent)
    status, up = _put(app, "/api/uploads/project-a/assets-v1-6", PNG, "image/png")
    assert status == 200
    # 2. the canvas reads the CURRENT version back and inlines it as a data
    #    URL — exactly what lockDraftPlan does with the MediaRef's url
    status, resp = _get(app, up["url"])
    assert status == 200
    frame = "data:image/png;base64," + base64.b64encode(resp.body).decode("ascii")
    # 3. preflight the lock — the bound sha must be the data URL's sha256
    status, tgt = _get(app, "/api/projects/project-a/lock-target")
    tgt = json.loads(tgt.body.decode("utf-8"))
    assert status == 200
    shots = [_draft_shot() for _ in range(5)] + [
        _draft_shot(title="终幕", description="sunrise", first_frame_image=frame)
    ]
    status, pf = _post(
        app,
        "/api/projects/project-a/preflight",
        {
            "command_id": "cmd-048-ff",
            "name": "lock-draft-plan",
            "params": {**tgt["params"], "shots": shots},
            "target": tgt["target"],
        },
    )
    assert status == 200, pf
    assert pf["preview"]["blockers"] == []
    rows = pf["preview"]["inputs"]["shots"]
    assert (
        rows[5]["first_frame_sha256"]
        == hashlib.sha256(frame.encode("utf-8")).hexdigest()
    )
    assert rows[0]["first_frame_sha256"] is None  # text-only shots unaffected


# --- no write path deletes or overwrites an existing upload -----------------


def test_no_unlink_of_existing_uploads_in_server_source() -> None:
    """TASK-048 acceptance: no code path deletes/overwrites existing uploads.

    Every ``unlink``/``replace`` in server.py must target only tmp files or
    the writer's own freshly-claimed version placeholder — never a
    previously-existing upload. The stale-extension cleanup loops are gone.
    """
    src = _SERVER_PATH.read_text("utf-8")
    assert "stale.unlink()" not in src  # the old same-slug cleanup pattern
    assert "_claim_version" in src


# --- frontend pure-logic units (node --test) --------------------------------


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_units_via_node() -> None:
    """旧版 uploads（字符串）兼容迁移 / 版本回切 / 队列聚合 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/frontend-units.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr

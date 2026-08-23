"""Project-rooted studio storage (ADR-0053).

The studio's creative domain and every project media file now live INSIDE the
project folder:

    <ProjectRoot>/project.json      core, untouched
    <ProjectRoot>/studio/canvas.json
    <ProjectRoot>/media/

The old ``mockups/motv-workspace/data/`` tree is read-only legacy. These tests
pin the properties that make that safe: connected mode never writes to the repo
scratch again, a legacy project cannot be edited until it is explicitly and
COMPLETELY migrated, projects are isolated from each other, and the usual
traversal / symlink / atomicity guarantees still hold.

STRICTLY OFFLINE — a loopback server on an ephemeral port, no network, no spend.
"""

from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

import pytest

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP_DIR))

import server as srv  # noqa: E402  - path injected above

from tests.symlink_support import junction_or_skip, symlink_or_skip  # noqa: E402

# a 1x1 PNG — real bytes, so the magic-byte sniff accepts it
_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6360000002000100ffff03000006000557bfabd400"
    "00000049454e44ae426082"
)


@pytest.fixture()
def backend(tmp_path, monkeypatch):
    """A loopback server whose legacy scratch and account root are isolated."""
    data_dir = tmp_path / "repo-scratch"
    data_dir.mkdir()
    monkeypatch.setattr(srv, "DATA_DIR", data_dir)
    app_data = tmp_path / "app-data"
    app_data.mkdir()
    monkeypatch.setattr(srv, "APP_DATA_DIR", app_data)
    account_root = tmp_path / "MotvProjects"
    account_root.mkdir()

    httpd = srv.build_server(account_root, host="127.0.0.1", port=0)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{port}", tmp_path, data_dir, account_root
    finally:
        httpd.shutdown()
        httpd.server_close()


def _req(base, path, *, method="GET", body=None, raw=None, ctype=None):
    # the request LINE must be ASCII, and these projects have Chinese names —
    # quote the path exactly as a browser would (the server unquotes it back)
    url = f"{base}{quote(path, safe='/?=&%')}"
    headers = {"Host": base.split("//", 1)[1]}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Origin"] = base
    elif raw is not None:
        data = raw
        headers["Content-Type"] = ctype or "application/octet-stream"
        headers["Origin"] = base
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:  # noqa: S310 - loopback, fixed scheme
            payload = r.read()
            try:
                return r.status, json.loads(payload.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return r.status, payload
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload.decode("utf-8") or "{}")
        except ValueError:
            return e.code, payload


def _upload(base, project, slug, data=None):
    """Upload and return the URL the server minted (uploads are versioned as
    ``<slug>_v<N>.<ext>``, so the caller must not guess the filename)."""
    status, body = _req(
        base,
        f"/api/uploads/{project}/{slug}",
        method="PUT",
        raw=data if data is not None else _PNG,
        ctype="image/png",
    )
    assert status == 200, body
    return body["url"]


def _make_project(base, root, name):
    status, body = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": name, "root": str(root), "confirm": True},
    )
    assert status == 201, body
    return root / name


# --- layout ------------------------------------------------------------------ #


def test_a_new_project_gets_the_documented_layout(backend):
    base, _tmp, scratch, account = backend
    proj = _make_project(base, account, "雨夜")

    status, _ = _req(base, "/api/canvas/雨夜", method="PUT", body={"v": 9, "nodes": []})
    assert status == 200
    url = _upload(base, "雨夜", "shot01")

    assert (proj / "project.json").is_file(), "core schema untouched"
    assert (proj / "studio" / "canvas.json").is_file()
    assert (proj / "media" / url.rsplit("/", 1)[1]).is_file()
    # and NOTHING was written into the repo scratch
    assert not (scratch / "雨夜.json").exists()
    assert not (scratch / "uploads").exists()


def test_reload_returns_exactly_what_was_saved(backend):
    base, _tmp, _scratch, account = backend
    _make_project(base, account, "雨夜")
    doc = {"v": 9, "nodes": [{"id": "n1"}], "assets": {"images": {}}}
    assert _req(base, "/api/canvas/雨夜", method="PUT", body=doc)[0] == 200
    status, back = _req(base, "/api/canvas/雨夜")
    assert status == 200
    assert back == doc


def test_two_projects_are_isolated(backend):
    base, _tmp, _scratch, account = backend
    a = _make_project(base, account, "雨夜")
    b = _make_project(base, account, "白日")
    _req(base, "/api/canvas/雨夜", method="PUT", body={"who": "a"})
    _req(base, "/api/canvas/白日", method="PUT", body={"who": "b"})
    url = _upload(base, "雨夜", "one")
    fname = url.rsplit("/", 1)[1]

    assert _req(base, "/api/canvas/雨夜")[1] == {"who": "a"}
    assert _req(base, "/api/canvas/白日")[1] == {"who": "b"}
    assert (a / "media" / fname).is_file()
    assert not (b / "media" / fname).exists()
    # one project's media is not reachable through the other's URL
    assert _req(base, f"/api/uploads/白日/{fname}")[0] == 404


def test_media_is_served_back_byte_for_byte(backend):
    base, _tmp, _scratch, account = backend
    _make_project(base, account, "雨夜")
    url = _upload(base, "雨夜", "shot01")
    status, payload = _req(base, url)
    assert status == 200
    assert payload == _PNG, "the UI must get the real bytes back"


def test_an_unknown_project_is_refused_not_scratch_backed(backend):
    base, _tmp, scratch, _account = backend
    status, body = _req(base, "/api/canvas/ghost", method="PUT", body={"x": 1})
    assert status == 404
    assert body["error"]["category"] == "not_found"
    assert not (scratch / "ghost.json").exists(), "no scratch fallback on write"
    assert _req(base, "/api/canvas/ghost")[0] == 404


# --- legacy: read-only, and migration is explicit + complete ----------------- #


def _seed_legacy(scratch, name, *, canvas=True, media=True):
    if canvas:
        (scratch / f"{name}.json").write_text(
            json.dumps({"v": 9, "legacy": True}), encoding="utf-8"
        )
    if media:
        d = scratch / "uploads" / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "old01.png").write_bytes(_PNG)


def test_a_legacy_project_is_readable_but_not_writable(backend):
    base, _tmp, scratch, account = backend
    proj = _make_project(base, account, "旧项目")
    # ADR-0055 决策 5: creation scaffolds studio/ + media/, so their EXISTENCE
    # no longer distinguishes "migrated" from "not migrated" — emptiness does.
    assert list((proj / "studio").iterdir()) == []  # nothing migrated yet
    _seed_legacy(scratch, "旧项目")

    # readable, and flagged so the UI can offer migration
    status, body = _req(base, "/api/canvas/旧项目")
    assert status == 200
    assert body["legacy"] is True and body["_legacy"] is True
    # legacy media is still served
    assert _req(base, "/api/uploads/旧项目/old01.png")[0] == 200

    # but every write is refused
    status, body = _req(base, "/api/canvas/旧项目", method="PUT", body={"v": 9})
    assert status == 409
    assert body["error"]["category"] == "migration_required"
    status, body = _req(
        base, "/api/uploads/旧项目/new", method="PUT", raw=_PNG, ctype="image/png"
    )
    assert status == 409
    assert body["error"]["category"] == "migration_required"
    # and nothing was WRITTEN in the project NOR in the scratch (the scaffolded
    # studio/ + media/ folders stay empty — a refused write creates no file)
    assert list((proj / "studio").iterdir()) == []
    assert list((proj / "media").iterdir()) == []
    assert not (scratch / "uploads" / "旧项目" / "new.png").exists()


def test_media_writing_agent_routes_are_gated_too(backend):
    base, _tmp, scratch, account = backend
    _make_project(base, account, "旧项目")
    _seed_legacy(scratch, "旧项目")
    for route in (
        "/api/agent/tts",
        "/api/agent/compose",
        "/api/agent/image-gen",
        "/api/agent/adopt-paid",
        "/api/agent/render-episode",
        "/api/assets/delete-file",
    ):
        status, body = _req(base, route, method="POST", body={"project": "旧项目"})
        assert status == 409, route
        assert body["error"]["category"] == "migration_required", route


def test_migration_moves_canvas_AND_media_together(backend):
    base, _tmp, scratch, account = backend
    proj = _make_project(base, account, "旧项目")
    _seed_legacy(scratch, "旧项目")

    status, body = _req(
        base, "/api/projects/migrate-legacy", method="POST", body={"project": "旧项目"}
    )
    assert status == 200, body
    assert body["migrated"] is True

    assert (proj / "studio" / "canvas.json").is_file()
    assert (proj / "media" / "old01.png").read_bytes() == _PNG
    # the legacy tree is KEPT, never deleted
    assert (scratch / "旧项目.json").is_file()
    assert (scratch / "uploads" / "旧项目" / "old01.png").is_file()

    # writes work again, and now land in the project
    assert (
        _req(base, "/api/canvas/旧项目", method="PUT", body={"v": 9, "new": 1})[0]
        == 200
    )
    assert json.loads((proj / "studio" / "canvas.json").read_text("utf-8"))["new"] == 1
    # the legacy copy is NOT the one being updated
    assert "new" not in json.loads((scratch / "旧项目.json").read_text("utf-8"))


def test_after_migration_the_legacy_tree_is_invisible(backend):
    """No half-migrated reads: once the project canvas exists, media resolves
    ONLY from the project, so a file left behind in the scratch cannot surface."""
    base, _tmp, scratch, account = backend
    proj = _make_project(base, account, "旧项目")
    _seed_legacy(scratch, "旧项目")
    _req(
        base, "/api/projects/migrate-legacy", method="POST", body={"project": "旧项目"}
    )

    (scratch / "uploads" / "旧项目" / "sneaky.png").write_bytes(_PNG)
    assert _req(base, "/api/uploads/旧项目/sneaky.png")[0] == 404
    (proj / "media" / "old01.png").unlink()
    assert _req(base, "/api/uploads/旧项目/old01.png")[0] == 404, "no fallback"


def test_migration_never_overwrites_media_already_in_the_project(backend):
    base, _tmp, scratch, account = backend
    proj = _make_project(base, account, "旧项目")
    # media/ is scaffolded at creation (ADR-0055 决策 5) — no mkdir needed
    (proj / "media" / "old01.png").write_bytes(b"mine, not the legacy one")
    _seed_legacy(scratch, "旧项目")

    status, _ = _req(
        base, "/api/projects/migrate-legacy", method="POST", body={"project": "旧项目"}
    )
    assert status == 200
    assert (proj / "media" / "old01.png").read_bytes() == b"mine, not the legacy one"


def test_migrating_a_project_with_no_legacy_data_is_refused(backend):
    base, _tmp, _scratch, account = backend
    _make_project(base, account, "干净")
    status, body = _req(
        base, "/api/projects/migrate-legacy", method="POST", body={"project": "干净"}
    )
    assert status == 404
    assert body["error"]["category"] == "not_found"


def test_migrating_twice_is_a_no_op(backend):
    base, _tmp, scratch, account = backend
    _make_project(base, account, "旧项目")
    _seed_legacy(scratch, "旧项目")
    assert (
        _req(
            base,
            "/api/projects/migrate-legacy",
            method="POST",
            body={"project": "旧项目"},
        )[1]["migrated"]
        is True
    )
    status, body = _req(
        base, "/api/projects/migrate-legacy", method="POST", body={"project": "旧项目"}
    )
    assert status == 200
    assert body["migrated"] is False


def test_migration_refuses_an_unknown_project(backend):
    base, _tmp, _scratch, _account = backend
    status, body = _req(
        base, "/api/projects/migrate-legacy", method="POST", body={"project": "ghost"}
    )
    assert status == 404
    assert body["error"]["category"] == "not_found"


def test_legacy_media_only_still_blocks_writes(backend):
    """Legacy state is not just the canvas: media alone must gate writes too, or
    the first upload would strand new bytes beside an unmigrated media tree."""
    base, _tmp, scratch, account = backend
    _make_project(base, account, "旧项目")
    _seed_legacy(scratch, "旧项目", canvas=False, media=True)
    status, body = _req(base, "/api/canvas/旧项目", method="PUT", body={"v": 9})
    assert status == 409
    assert body["error"]["category"] == "migration_required"


def test_migration_does_not_follow_a_symlink_out_of_the_scratch(backend):
    base, tmp, scratch, account = backend
    proj = _make_project(base, account, "旧项目")
    _seed_legacy(scratch, "旧项目", canvas=True, media=False)
    d = scratch / "uploads" / "旧项目"
    d.mkdir(parents=True, exist_ok=True)
    outside = tmp / "secret.png"
    outside.write_bytes(b"not yours")
    symlink_or_skip(d / "linked.png", outside)

    _req(
        base, "/api/projects/migrate-legacy", method="POST", body={"project": "旧项目"}
    )
    assert not (proj / "media" / "linked.png").exists(), "a link is not media to copy"


# --- containment ------------------------------------------------------------- #


@pytest.mark.parametrize(
    "name", ["../escape", "..%2Fescape", "a/b", "..", ".", "with space"]
)
def test_canvas_names_cannot_traverse(backend, name):
    base, _tmp, _scratch, _account = backend
    status, _ = _req(base, f"/api/canvas/{name}", method="PUT", body={"x": 1})
    assert status in (400, 404), f"{name} must never resolve to a real path"


@pytest.mark.parametrize("fname", ["../../project.json", "..", "a/b.png", "x.exe"])
def test_media_filenames_cannot_traverse(backend, fname):
    base, _tmp, _scratch, account = backend
    _make_project(base, account, "雨夜")
    status, _ = _req(base, f"/api/uploads/雨夜/{fname}")
    assert status in (400, 404), fname


def test_media_read_never_follows_a_symlink_out_of_the_project(backend):
    base, tmp, _scratch, account = backend
    proj = _make_project(base, account, "雨夜")
    (proj / "media").mkdir(exist_ok=True)
    outside = tmp / "secret.png"
    outside.write_bytes(_PNG)
    symlink_or_skip(proj / "media" / "leak.png", outside)
    assert _req(base, "/api/uploads/雨夜/leak.png")[0] == 404


def test_a_saved_canvas_survives_a_restart(backend):
    base, _tmp, _scratch, account = backend
    proj = _make_project(base, account, "雨夜")
    _req(base, "/api/canvas/雨夜", method="PUT", body={"v": 9, "keep": "me"})
    # a fresh app instance rediscovers the project and reads the same document
    app = srv._App(account)
    assert app._canvas_path("雨夜") == proj / "studio" / "canvas.json"
    assert (
        json.loads((proj / "studio" / "canvas.json").read_text("utf-8"))["keep"] == "me"
    )


def test_no_temp_files_are_left_behind_by_a_save(backend):
    base, _tmp, _scratch, account = backend
    proj = _make_project(base, account, "雨夜")
    for i in range(3):
        _req(base, "/api/canvas/雨夜", method="PUT", body={"v": 9, "i": i})
    leftovers = [p.name for p in (proj / "studio").iterdir() if p.suffix == ".tmp"]
    assert leftovers == []


def test_a_symlinked_studio_dir_cannot_capture_the_canvas(backend, tmp_path):
    """`resolve()` FOLLOWS a link, so containment has to be re-checked against
    the project root — otherwise a swapped-in studio/ redirects every canvas
    read and write out of the project."""
    base, tmp, _scratch, account = backend
    proj = _make_project(base, account, "雨夜")
    outside = tmp / "elsewhere"
    outside.mkdir()
    # creation scaffolds a REAL studio/ (ADR-0055 决策 5); the attack this test
    # models is that directory being swapped for a link, so remove it first
    (proj / "studio").rmdir()
    symlink_or_skip(proj / "studio", outside, target_is_directory=True)

    status, _ = _req(base, "/api/canvas/雨夜", method="PUT", body={"v": 9, "x": 1})
    assert status in (400, 404), "a linked studio/ must not be written through"
    assert not (outside / "canvas.json").exists()


def test_a_symlinked_media_dir_cannot_capture_uploads(backend, tmp_path):
    base, tmp, _scratch, account = backend
    proj = _make_project(base, account, "雨夜")
    outside = tmp / "elsewhere"
    outside.mkdir()
    (proj / "media").rmdir()  # swap the scaffolded real folder for a link
    symlink_or_skip(proj / "media", outside, target_is_directory=True)

    status, _ = _req(
        base, "/api/uploads/雨夜/shot01", method="PUT", raw=_PNG, ctype="image/png"
    )
    assert status in (400, 404)
    assert not any(outside.iterdir()), "nothing may be written outside the project"


def test_migrating_media_only_leaves_the_project_writable(backend):
    """A legacy project with media but no saved canvas used to migrate
    'successfully' and stay write-blocked forever."""
    base, _tmp, scratch, account = backend
    proj = _make_project(base, account, "旧项目")
    _seed_legacy(scratch, "旧项目", canvas=False, media=True)

    status, body = _req(
        base, "/api/projects/migrate-legacy", method="POST", body={"project": "旧项目"}
    )
    assert status == 200, body
    assert body["migrated"] is True
    assert (proj / "media" / "old01.png").is_file()
    assert (proj / "studio" / "canvas.json").is_file(), "migrated marker must exist"

    # and the project is genuinely editable now
    status, _ = _req(base, "/api/canvas/旧项目", method="PUT", body={"v": 9, "ok": 1})
    assert status == 200


def test_a_junctioned_studio_dir_cannot_capture_the_canvas(backend, tmp_path):
    """The junction variant of the studio-link test. It needs no elevation, so
    unlike the symlink one it actually RUNS on the native-Windows target — and
    Python does not even report a junction as a link, so only a real
    containment re-check can catch it."""
    base, tmp, _scratch, account = backend
    proj = _make_project(base, account, "雨夜")
    outside = tmp / "elsewhere-j"
    outside.mkdir()
    junction_or_skip(proj / "studio", outside)
    assert (proj / "studio").is_symlink() is False  # Python cannot see it

    status, _ = _req(base, "/api/canvas/雨夜", method="PUT", body={"v": 9, "x": 1})
    assert status in (400, 404)
    assert not (outside / "canvas.json").exists()


def test_a_junctioned_media_dir_cannot_capture_uploads(backend, tmp_path):
    base, tmp, _scratch, account = backend
    proj = _make_project(base, account, "雨夜")
    outside = tmp / "elsewhere-j"
    outside.mkdir()
    junction_or_skip(proj / "media", outside)

    status, _ = _req(
        base, "/api/uploads/雨夜/shot01", method="PUT", raw=_PNG, ctype="image/png"
    )
    assert status in (400, 404)
    assert not any(outside.iterdir())

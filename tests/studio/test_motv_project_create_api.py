"""Project creation + directory browsing over the loopback backend (ADR-0051).

The studio can now name a root and have the backend write there, so these
tests exercise the HTTP surface that decides it: the read-only directory
listing, the first-use confirmation gate, the deny-list, and the scaffolding
that must never overwrite an existing folder.

STRICTLY OFFLINE — a loopback server on an ephemeral port, no network, no spend.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP_DIR))

import server as srv  # noqa: E402  - path injected above

from tests.symlink_support import symlink_or_skip  # noqa: E402


@pytest.fixture()
def backend(tmp_path, monkeypatch):
    """A running loopback server whose data/ and account-root are isolated."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(srv, "DATA_DIR", data_dir)
    app_data = tmp_path / "app-data"
    app_data.mkdir()
    monkeypatch.setattr(srv, "APP_DATA_DIR", app_data)
    account_root = tmp_path / "account"
    account_root.mkdir()

    httpd = srv.build_server(account_root, host="127.0.0.1", port=0)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{port}", tmp_path
    finally:
        httpd.shutdown()
        httpd.server_close()


def _req(base, path, *, method="GET", body=None):
    url = f"{base}{path}"
    data = None
    headers = {"Host": base.split("//", 1)[1]}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Origin"] = base
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:  # noqa: S310 - loopback, fixed scheme
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


# --- directory browsing ----------------------------------------------------- #


def test_fs_default_reports_the_account_root(backend):
    base, tmp = backend
    status, body = _req(base, "/api/fs/default")
    assert status == 200
    assert body["root"] == str(tmp / "account")
    assert body["sep"]


def test_fs_list_returns_directories_only(backend):
    base, tmp = backend
    d = tmp / "account"
    (d / "alpha").mkdir()
    (d / "beta").mkdir()
    (d / ".hidden").mkdir()
    (d / "a-file.txt").write_text("x", encoding="utf-8")
    status, body = _req(base, f"/api/fs/list?path={d}")
    assert status == 200
    names = [e["name"] for e in body["entries"]]
    assert names == ["alpha", "beta"]  # sorted, no file, no dotted entry
    assert body["parent"] == str(d.parent)
    assert all("path" in e for e in body["entries"])


def test_fs_list_refuses_a_relative_path(backend):
    base, _ = backend
    status, body = _req(base, "/api/fs/list?path=relative/dir")
    assert status == 400
    assert body["error"]["category"] == "bad_path"


def test_fs_list_404s_on_a_file(backend):
    base, tmp = backend
    f = tmp / "account" / "f.txt"
    f.write_text("x", encoding="utf-8")
    status, _ = _req(base, f"/api/fs/list?path={f}")
    assert status == 404


# --- creation --------------------------------------------------------------- #


def test_a_new_root_must_be_confirmed_once(backend):
    base, tmp = backend
    target = tmp / "media"
    target.mkdir()
    status, body = _req(
        base, "/api/projects", method="POST", body={"name": "雨夜", "root": str(target)}
    )
    assert status == 409
    assert body["error"]["category"] == "root_unconfirmed"
    # nothing was created by the refusal
    assert not (target / "雨夜").exists()


def test_confirmed_creation_scaffolds_and_registers(backend):
    base, tmp = backend
    target = tmp / "media"
    target.mkdir()
    status, body = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "雨夜", "root": str(target), "confirm": True},
    )
    assert status == 201, body
    proj = target / "雨夜"
    assert (proj / "project.json").is_file()
    meta = json.loads((proj / "project.json").read_text(encoding="utf-8"))
    assert meta["name"] == "雨夜" and meta["project_id"] == "雨夜"
    assert body["project_path"] == str(proj)

    # it now appears in the project list, alongside account-root discoveries
    status, listing = _req(base, "/api/projects")
    assert status == 200
    assert "雨夜" in [p["name"] for p in listing["projects"]]

    # and the root is remembered, so a SECOND project there needs no confirm
    status, _ = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "第二部", "root": str(target)},
    )
    assert status == 201


def test_creation_never_overwrites_a_non_empty_folder(backend):
    base, tmp = backend
    target = tmp / "media"
    (target / "雨夜").mkdir(parents=True)
    (target / "雨夜" / "keep.txt").write_text("mine", encoding="utf-8")
    status, body = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "雨夜", "root": str(target), "confirm": True},
    )
    assert status == 409
    assert body["error"]["category"] == "exists"
    assert (target / "雨夜" / "keep.txt").read_text(encoding="utf-8") == "mine"


def test_the_repository_is_refused_even_when_confirmed(backend):
    base, _ = backend
    status, body = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "x", "root": str(srv.REPO_ROOT), "confirm": True},
    )
    assert status == 400
    assert body["error"]["category"] == "denied"


@pytest.mark.parametrize("name", ["", "a/b", "CON", "nul", "trailing.", "x" * 61])
def test_invalid_project_names_are_refused_server_side(backend, name):
    base, tmp = backend
    target = tmp / "media"
    target.mkdir()
    status, body = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": name, "root": str(target), "confirm": True},
    )
    assert status == 400
    assert body["error"]["category"] == "bad_name"


def test_the_registry_survives_a_restart(backend, tmp_path, monkeypatch):
    base, tmp = backend
    target = tmp / "media"
    target.mkdir()
    status, _ = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "雨夜", "root": str(target), "confirm": True},
    )
    assert status == 201
    # a fresh app instance reads the registry back
    app = srv._App(tmp / "account")
    assert app._projects.get("雨夜") == target / "雨夜"


def test_a_registered_project_whose_folder_vanished_is_dropped(backend, tmp_path):
    base, tmp = backend
    target = tmp / "media"
    target.mkdir()
    _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "雨夜", "root": str(target), "confirm": True},
    )
    import shutil

    shutil.rmtree(target / "雨夜")
    app = srv._App(tmp / "account")
    assert "雨夜" not in app._projects  # never served as a phantom


def test_a_symlinked_project_folder_cannot_smuggle_writes_outside(backend, tmp_path):
    """An EMPTY symlink named like the project used to pass the emptiness check,
    and project.json would then be written through it, outside the root."""
    base, tmp = backend
    target = tmp / "media"
    target.mkdir()
    outside = tmp / "outside"
    outside.mkdir()
    symlink_or_skip(target / "雨夜", outside, target_is_directory=True)
    status, body = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "雨夜", "root": str(target), "confirm": True},
    )
    assert status == 400
    assert body["error"]["category"] == "symlink_escape"
    assert not (outside / "project.json").exists()  # nothing escaped


def test_a_registry_write_failure_rolls_the_project_folder_back(
    backend, tmp_path, monkeypatch
):
    """A half-applied create would leave a folder that blocks every retry while
    the project stays invisible after a restart."""
    base, tmp = backend
    target = tmp / "media"
    target.mkdir()
    monkeypatch.setattr(srv, "_save_project_registry", lambda reg: False)
    status, body = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "雨夜", "root": str(target), "confirm": True},
    )
    assert status == 500
    assert body["error"]["category"] == "write_failed"
    assert not (target / "雨夜").exists()  # rolled back, so a retry can succeed


def _junction_or_skip(link: Path, target: Path) -> None:
    """Create a Windows directory JUNCTION, or skip.

    Junctions need no elevation (unlike symlinks), so this covers the escape
    path on the very platform ADR-0049 targets — where the POSIX symlink test
    can only skip. Python reports a junction as ``is_symlink() == False`` while
    ``resolve()`` still follows it, which is precisely why the create route
    also checks that the resolved project directory stays under the root.
    """
    if os.name != "nt":
        pytest.skip("junctions are Windows-only; the POSIX symlink test covers this")
    # NOT text=True: cmd writes its banner in the OEM codepage, and letting
    # subprocess decode it as UTF-8 raises inside its reader thread.
    res = subprocess.run(  # noqa: S603 - fixed argv, no shell interpolation
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
    )
    if res.returncode != 0:
        out = (res.stdout + res.stderr).decode("utf-8", "replace")
        pytest.skip(f"could not create a junction: {out}")


def test_a_junction_named_like_the_project_cannot_escape_the_root(backend, tmp_path):
    base, tmp = backend
    target = tmp / "media"
    target.mkdir()
    outside = tmp / "outside"
    outside.mkdir()
    _junction_or_skip(target / "雨夜", outside)
    # Python does NOT report this as a symlink, so only the containment check
    # can catch it
    assert (target / "雨夜").is_symlink() is False
    status, body = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "雨夜", "root": str(target), "confirm": True},
    )
    assert status == 400
    assert body["error"]["category"] == "symlink_escape"
    assert not (outside / "project.json").exists()  # nothing escaped


def test_a_scaffold_write_failure_leaves_nothing_behind(backend, tmp_path, monkeypatch):
    """An OSError while writing project.json must not strand a folder that
    makes every retry fail as 'already exists'."""
    base, tmp = backend
    target = tmp / "media"
    target.mkdir()

    # project.json is created through os.open with O_EXCL (never write_text), so
    # the fault has to be injected where the write actually happens
    real_open = os.open

    def boom(path, *a, **kw):
        if str(path).endswith("project.json"):
            raise OSError("disk full")
        return real_open(path, *a, **kw)

    monkeypatch.setattr(os, "open", boom)
    status, body = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "雨夜", "root": str(target), "confirm": True},
    )
    assert status == 500
    assert body["error"]["category"] == "write_failed"
    assert not (target / "雨夜").exists()  # rolled back

    # and a retry after the fault clears now succeeds
    monkeypatch.setattr(os, "open", real_open)
    status, _ = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "雨夜", "root": str(target), "confirm": True},
    )
    assert status == 201


@pytest.mark.parametrize("name", ["a\u0000b", "tab\there", "bell\u0007"])
def test_control_characters_get_a_clean_400_not_a_dropped_connection(backend, name):
    """A NUL reaches Path() and raises ValueError -- NOT an OSError -- so without
    an explicit check the handler would die instead of answering."""
    base, tmp = backend
    target = tmp / "media"
    target.mkdir()
    status, body = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": name, "root": str(target), "confirm": True},
    )
    assert status == 400
    assert body["error"]["category"] == "bad_name"


def test_project_json_is_created_exclusively_not_written_through_a_link(
    backend, tmp_path
):
    """A link left where project.json goes must never capture the write.

    project.json is created with O_EXCL (+O_NOFOLLOW where the platform has
    it), which refuses to follow a link on the final component. WHICH guard
    refuses is platform-dependent and both are correct — a symlink inside the
    project folder also makes that folder non-empty, so the earlier emptiness
    check may refuse first. The invariant under test is not the status code:
    it is that nothing is ever written through the link.
    """
    base, tmp = backend
    target = tmp / "media"
    target.mkdir()
    proj = target / "雨夜"
    proj.mkdir()
    outside = tmp / "outside"
    outside.mkdir()
    symlink_or_skip(proj / "project.json", outside / "stolen.json")
    status, body = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "雨夜", "root": str(target), "confirm": True},
    )
    assert status in (409, 500), body
    assert body["error"]["category"] in ("exists", "write_failed")
    assert not (outside / "stolen.json").exists()  # nothing was written through it


def test_a_name_differing_only_in_case_is_refused(backend):
    """The landing page merges names case-insensitively, so allowing both `Foo`
    and `foo` on a case-sensitive filesystem would hide one of them forever."""
    base, tmp = backend
    target = tmp / "media"
    target.mkdir()
    status, _ = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "NightShift", "root": str(target), "confirm": True},
    )
    assert status == 201
    status, body = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "nightshift", "root": str(target), "confirm": True},
    )
    assert status == 409
    assert body["error"]["category"] == "exists"
    # WHICH guard refuses depends on the filesystem, and both are correct:
    # a case-insensitive one (NTFS) resolves the path onto the existing folder
    # and the non-empty check fires; a case-sensitive one reaches the registry
    # check, which compares case-folded. What must never happen is a 201.
    assert (
        not (target / "nightshift" / "project.json").is_file()
        or (target / "NightShift" / "project.json").is_file()
    )


def test_fs_list_survives_a_nul_in_the_path(backend):
    """A NUL reaches Path()/resolve() and raises ValueError -- not an OSError --
    so without an explicit guard the handler dies instead of answering."""
    base, _ = backend
    status, body = _req(base, "/api/fs/list?path=%2Ftmp%2F%00evil")
    assert status == 400
    assert body["error"]["category"] == "bad_path"

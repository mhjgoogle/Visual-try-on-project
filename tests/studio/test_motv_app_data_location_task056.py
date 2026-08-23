"""TASK-056 — the account-level registries live OUTSIDE the repository.

`projects.json` (name -> admitted root) and `runs.json` (the Run registry) are
account-level facts: they span projects and describe this machine's backend, not
the checkout. They used to be written into `mockups/motv-workspace/data/`, so a
clone carried someone else's project list and a `git clean` deleted a live run
journal.

What is pinned here:

* where the default lands on each platform (Windows and POSIX, both, on either
  host — the resolver is pure and takes the platform as data);
* that the old location is READ-ONLY: it is still read when the new one is
  empty, and never written, renamed or deleted;
* that the explicit migration COPIES and never overwrites;
* that a failed journal write does not leave a `runs.json.tmp<pid>` blob behind
  (the debris this task found in the repo — TASK-087 §6.2).
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

_MOCKUP = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP))

import runstore  # noqa: E402 - path injected above


@pytest.fixture()
def srv(tmp_path, monkeypatch):
    """A fresh server module whose BOTH locations are throwaway."""
    spec = importlib.util.spec_from_file_location(
        f"motv_server_056_{tmp_path.name}", _MOCKUP / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "APP_DATA_DIR", tmp_path / "app-data")
    monkeypatch.setattr(module, "DATA_DIR", tmp_path / "legacy")
    monkeypatch.setattr(module, "_RUNS", None)
    return module


# --- where the default goes ------------------------------------------------- #


# `windows=` is passed explicitly rather than faking `os.name`: `pathlib` reads
# `os.name` when it BUILDS a path, so a faked "posix" makes `Path()` return a
# `PosixPath` the Windows host cannot instantiate at all. Both branches then run
# on both targets, which is what ADR-0062 asks for.


# `tmp_path` rather than a literal, for BOTH platform branches: only the
# variable is being faked here, not the host, and "absolute" is host-specific —
# `D:/x` is not absolute to a PosixPath and `/home/x` is not absolute to a
# WindowsPath. A literal would make each branch pass on exactly one target,
# which is the opposite of what these tests are for.


def test_the_windows_default_is_under_localappdata(srv, monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    assert srv._default_app_data_dir(windows=True) == tmp_path / "Local" / "motv"


def test_the_windows_default_falls_back_to_the_home_profile(srv, monkeypatch):
    """`LOCALAPPDATA` is normally set, but a service account or a stripped
    environment can lack it — and "no app data dir" must not become "the repo"."""
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: Path("D:/Users/mo")))
    assert srv._default_app_data_dir(windows=True) == Path(
        "D:/Users/mo/AppData/Local/motv"
    )


def test_the_posix_default_honours_xdg_data_home(srv, monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / ".share"))
    assert srv._default_app_data_dir(windows=False) == tmp_path / ".share" / "motv"


def test_the_posix_default_without_xdg_is_the_documented_share_dir(srv, monkeypatch):
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: Path("/home/mo")))
    assert srv._default_app_data_dir(windows=False) == Path(
        "/home/mo/.local/share/motv"
    )


def test_an_explicit_location_beats_the_env_var_which_beats_the_default(
    srv, monkeypatch
):
    monkeypatch.setenv("MOTV_APP_DATA_DIR", str(Path("D:/FromEnv")))
    assert srv.resolve_app_data_dir(str(Path("D:/Explicit"))) == Path("D:/Explicit")
    assert srv.resolve_app_data_dir() == Path("D:/FromEnv")
    monkeypatch.delenv("MOTV_APP_DATA_DIR")
    assert srv.resolve_app_data_dir() == srv._default_app_data_dir()


@pytest.mark.parametrize("channel", ["flag", "env"])
def test_both_override_channels_go_through_root_admission(
    srv, tmp_path, monkeypatch, capsys, channel
):
    """The flag and the environment variable are the same act — an operator
    relocating the account's registries — so they get the same admission
    (ADR-0051). Admitting only the flag left the env var able to name a
    RELATIVE path, or one inside the checkout, i.e. exactly what this task
    retires (codex review, round 1)."""
    inside_the_repo = str(srv.REPO_ROOT / "mockups" / "motv-workspace" / "data")
    argv = ["--port", "0"]
    if channel == "flag":
        argv += ["--app-data-dir", inside_the_repo]
        monkeypatch.delenv("MOTV_APP_DATA_DIR", raising=False)
    else:
        monkeypatch.setenv("MOTV_APP_DATA_DIR", inside_the_repo)

    with pytest.raises(SystemExit):
        srv.main(argv)

    err = capsys.readouterr().err
    assert "rejected (denied)" in err
    assert ("--app-data-dir" if channel == "flag" else "MOTV_APP_DATA_DIR") in err


def test_neither_registry_path_is_inside_the_repository(srv, monkeypatch):
    """The whole point of the task, stated as an invariant rather than a path."""
    monkeypatch.setattr(srv, "APP_DATA_DIR", srv.resolve_app_data_dir())
    for path in (srv._registry_path(), srv._runs_path()):
        resolved = path.resolve()
        assert srv.REPO_ROOT.resolve() not in resolved.parents, resolved


def test_the_suite_never_runs_against_a_real_application_data_directory(srv):
    """The guard in `tests/conftest.py`, checked from the inside.

    It is the only thing standing between this suite and the developer's live
    `projects.json` — and the first version of it was fail-OPEN in two ways at
    once: it stood down when `MOTV_APP_DATA_DIR` was already set (which is
    exactly what an operator who relocated their real data would have), and it
    silently left the variable unset when the directory could not be made
    (unset means "use the platform default", i.e. the live location). Both
    failures are invisible until someone reads their own registry and finds
    pytest's temp projects in it. That happened once already.
    """
    configured = os.environ.get("MOTV_APP_DATA_DIR")
    assert configured, "conftest must always set it — unset means the REAL dir"
    assert Path(configured) != srv._default_app_data_dir()
    assert Path(configured).name.startswith("motv-pytest-app-data-"), (
        "a throwaway made by this run, not a reused or operator-supplied path"
    )


# --- the legacy location is read-only --------------------------------------- #


def _legacy_registry(module, projects):
    module.DATA_DIR.mkdir(parents=True, exist_ok=True)
    (module.DATA_DIR / "projects.json").write_text(
        json.dumps({"version": 1, "projects": projects, "confirmedRoots": []}),
        encoding="utf-8",
    )


def test_an_old_install_still_reads_its_registry(srv, tmp_path):
    _legacy_registry(srv, [{"name": "旧项目", "root": str(tmp_path / "old")}])
    assert [p["name"] for p in srv._load_registry_projects()] == ["旧项目"]


def test_the_new_location_wins_once_it_exists(srv, tmp_path):
    """Not "merge", not "prefer the older file": one authority, and it is the new
    one. A half-read registry would resurrect projects the creator removed."""
    _legacy_registry(srv, [{"name": "旧项目", "root": str(tmp_path / "old")}])
    srv.APP_DATA_DIR.mkdir(parents=True)
    (srv.APP_DATA_DIR / "projects.json").write_text(
        json.dumps(
            {
                "version": 1,
                "projects": [{"name": "新项目", "root": str(tmp_path / "new")}],
                "confirmedRoots": [],
            }
        ),
        encoding="utf-8",
    )
    assert [p["name"] for p in srv._load_registry_projects()] == ["新项目"]


def test_a_save_writes_the_new_location_and_leaves_the_old_file_untouched(
    srv, tmp_path
):
    _legacy_registry(srv, [{"name": "旧项目", "root": str(tmp_path / "old")}])
    before = (srv.DATA_DIR / "projects.json").read_bytes()

    assert srv._save_project_registry(
        {
            "version": 1,
            "projects": [{"name": "旧项目", "root": str(tmp_path / "old")}],
            "confirmedRoots": [],
        }
    )

    assert (srv.APP_DATA_DIR / "projects.json").is_file()
    assert (srv.DATA_DIR / "projects.json").read_bytes() == before, (
        "the old file is READ-ONLY legacy: nothing of the creator's is rewritten "
        "or removed on our initiative (AGENTS.md §13)"
    )


def test_a_save_creates_the_whole_app_data_path(srv):
    """`%LOCALAPPDATA%/motv` is several levels deep and, unlike the old in-repo
    `data/`, nothing else has necessarily created it first."""
    deep = srv.APP_DATA_DIR / "a" / "b" / "c"
    srv.APP_DATA_DIR = deep
    assert srv._save_project_registry(
        {"version": 1, "projects": [], "confirmedRoots": []}
    )
    assert (deep / "projects.json").is_file()


def test_the_run_journal_boots_from_the_legacy_file_and_writes_the_new_one(
    srv, tmp_path
):
    srv.DATA_DIR.mkdir(parents=True)
    (srv.DATA_DIR / "runs.json").write_text(
        json.dumps(
            {
                "v": 1,
                "runs": [
                    {
                        "runId": "run-legacy",
                        "status": "succeeded",
                        "queueSeq": 1,
                        "projectId": "P1",
                        "executor": "manual",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    legacy_before = (srv.DATA_DIR / "runs.json").read_bytes()

    store = srv.runs()
    assert store.get("run-legacy", project="P1")["runId"] == "run-legacy"

    store.create(
        kind="skill",
        task_type="skill.story-development",
        executor="manual",
        project_id="P1",
        params={"prompt": "p"},
        provider="local_subscription",
    )
    assert (srv.APP_DATA_DIR / "runs.json").is_file()
    assert (srv.DATA_DIR / "runs.json").read_bytes() == legacy_before


def test_a_corrupt_legacy_journal_is_not_quarantined(tmp_path):
    """The quarantine rename is for OUR file. Renaming the operator's old journal
    would destroy their evidence in a directory we were told not to write to."""
    legacy = tmp_path / "legacy" / "runs.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_text("{not json", encoding="utf-8")

    store = runstore.RunStore(tmp_path / "app" / "runs.json", legacy_path=legacy)

    assert store.list(project="P1") == []
    assert legacy.read_text(encoding="utf-8") == "{not json"
    assert not list(legacy.parent.glob("runs.json.corrupt-*"))


# --- the explicit migration -------------------------------------------------- #


def test_migration_copies_both_registries_and_keeps_the_originals(srv, tmp_path):
    srv.DATA_DIR.mkdir(parents=True)
    (srv.DATA_DIR / "projects.json").write_text('{"version": 1}', encoding="utf-8")
    (srv.DATA_DIR / "runs.json").write_text('{"v": 1, "runs": []}', encoding="utf-8")

    report = srv.migrate_app_data()

    assert report["copied"] == ["projects.json", "runs.json"]
    assert (srv.APP_DATA_DIR / "projects.json").read_text(encoding="utf-8") == (
        '{"version": 1}'
    )
    assert (srv.DATA_DIR / "projects.json").is_file(), "COPY, never move"
    assert (srv.DATA_DIR / "runs.json").is_file()


def test_migration_never_overwrites_what_the_new_location_already_learned(
    srv, tmp_path
):
    """Re-running the migration is a no-op, not a rollback: the new registry has
    been the authority since the first write, and the old file is frozen history."""
    srv.DATA_DIR.mkdir(parents=True)
    (srv.DATA_DIR / "projects.json").write_text('{"version": 1}', encoding="utf-8")
    srv.APP_DATA_DIR.mkdir(parents=True)
    (srv.APP_DATA_DIR / "projects.json").write_text('{"version": 2}', encoding="utf-8")

    report = srv.migrate_app_data()

    assert report["copied"] == []
    assert {i["name"] for i in report["skipped"]} == {"projects.json"}
    assert report["missing"] == ["runs.json"]
    assert (srv.APP_DATA_DIR / "projects.json").read_text(encoding="utf-8") == (
        '{"version": 2}'
    )


def test_migration_leaves_nothing_behind_when_it_cannot_finish(
    srv, tmp_path, monkeypatch
):
    """Not even an EMPTY destination.

    The first fix for the race below claimed the name with `O_CREAT|O_EXCL`
    and filled it afterwards. That window is worse than the race it closed: an
    empty `projects.json` left by a crash both suppresses the legacy read-only
    fallback AND makes every later migration answer "already_present", so the
    project list is gone with nothing reporting a failure (codex review,
    round 2). Filling first and claiming the name with `os.link` has no such
    window — the destination never exists without its content.
    """
    srv.DATA_DIR.mkdir(parents=True)
    (srv.DATA_DIR / "projects.json").write_text('{"version": 1}', encoding="utf-8")
    real_link = os.link

    def boom(src, dst, *a, **kw):
        if str(dst).endswith("projects.json"):
            raise OSError("disk full")
        return real_link(src, dst, *a, **kw)

    monkeypatch.setattr(os, "link", boom)
    report = srv.migrate_app_data()

    assert report["copied"] == []
    assert report["skipped"][0]["reason"].startswith("error:")
    assert list(srv.APP_DATA_DIR.glob("*.migrating")) == []
    assert not (srv.APP_DATA_DIR / "projects.json").exists()


def test_migration_cannot_overwrite_a_destination_that_appears_mid_copy(
    srv, tmp_path, monkeypatch
):
    """`dst.exists()` then `os.replace` is check-then-act, and `os.replace`
    overwrites unconditionally — so a registry created in the window (a second
    migration, or a backend that had started writing) was replaced by the
    OLDER legacy copy (codex review, round 1). `os.link` refuses instead."""
    srv.DATA_DIR.mkdir(parents=True)
    (srv.DATA_DIR / "projects.json").write_text('{"legacy": true}', encoding="utf-8")
    srv.APP_DATA_DIR.mkdir(parents=True)
    real_link = os.link

    def racing_link(src, dst, *a, **kw):
        # another writer lands its newer registry a hair before our claim
        if str(dst).endswith("projects.json"):
            Path(dst).write_text('{"newer": true}', encoding="utf-8")
        return real_link(src, dst, *a, **kw)

    monkeypatch.setattr(os, "link", racing_link)
    report = srv.migrate_app_data()

    assert report["copied"] == []
    assert {i["name"] for i in report["skipped"]} == {"projects.json"}
    assert (srv.APP_DATA_DIR / "projects.json").read_text(encoding="utf-8") == (
        '{"newer": true}'
    ), "the legacy copy must never win over data that is already there"


def test_migration_deletes_nothing_it_does_not_own(srv, tmp_path):
    """The obvious tidy-up — glob `*.migrating` and unlink the matches — was
    written and then removed (codex review, round 3).

    It deletes by NAME PATTERN in a directory this function does not own: a
    creator's own file that happens to end in `.migrating` goes, and so does a
    CONCURRENT migration's in-flight temp file. Rare inert debris is the
    cheaper problem (AGENTS.md §13).
    """
    srv.DATA_DIR.mkdir(parents=True)
    (srv.DATA_DIR / "projects.json").write_text('{"version": 1}', encoding="utf-8")
    srv.APP_DATA_DIR.mkdir(parents=True)
    not_ours = srv.APP_DATA_DIR / "someone-elses-notes.migrating"
    not_ours.write_text("the creator's bytes", encoding="utf-8")

    srv.migrate_app_data()

    assert not_ours.read_text(encoding="utf-8") == "the creator's bytes"
    assert (srv.APP_DATA_DIR / "projects.json").is_file()


def test_a_successful_migration_leaves_no_temp_file_of_its_own(srv, tmp_path):
    srv.DATA_DIR.mkdir(parents=True)
    (srv.DATA_DIR / "projects.json").write_text('{"version": 1}', encoding="utf-8")

    srv.migrate_app_data()

    assert list(srv.APP_DATA_DIR.glob("*.migrating")) == []


@pytest.mark.parametrize("windows", [True, False])
def test_a_platform_variable_pointing_into_the_checkout_is_refused(
    srv, monkeypatch, windows
):
    """The registries never land inside the repository — that is the whole
    task, so it is enforced on the DEFAULT too, not only on what an operator
    types (codex review, round 3).

    Deliberately a containment comparison and not full `admit_root`: admission
    creates the directory and proves writability BY WRITING, and this resolver
    runs at import time. See `_outside_the_repo` for the scope call.
    """
    var = "LOCALAPPDATA" if windows else "XDG_DATA_HOME"
    monkeypatch.setenv(var, str(srv.REPO_ROOT / "mockups" / "motv-workspace"))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: Path("/home/mo")))

    resolved = srv._default_app_data_dir(windows=windows)

    assert srv.REPO_ROOT.resolve() not in resolved.resolve().parents
    assert resolved == (
        Path("/home/mo/AppData/Local/motv")
        if windows
        else Path("/home/mo/.local/share/motv")
    )


def test_a_relative_platform_variable_is_ignored_not_obeyed(srv, monkeypatch):
    """A relative `XDG_DATA_HOME` / `LOCALAPPDATA` would make the registries
    land wherever the working directory happened to be — including back inside
    the checkout (codex review, round 2). The XDG spec says to ignore it; there
    is no argument for treating the Windows variable differently."""
    monkeypatch.setenv("XDG_DATA_HOME", "relative/share")
    monkeypatch.setenv("LOCALAPPDATA", "relative/local")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: Path("/home/mo")))
    assert srv._default_app_data_dir(windows=False) == Path(
        "/home/mo/.local/share/motv"
    )
    assert srv._default_app_data_dir(windows=True) == Path(
        "/home/mo/AppData/Local/motv"
    )


# --- the temp-file debris this task found ------------------------------------ #


def test_a_failed_journal_write_leaves_no_temp_file_behind(tmp_path, monkeypatch):
    """Two orphaned `runs.json.tmp<pid>` blobs — 219 KB and 27 B — were sitting
    next to the live journal in the repo. Each is a FULL copy of the registry,
    and it outlives the process that made it (TASK-087 §6.2)."""
    path = tmp_path / "runs.json"
    store = runstore.RunStore(path)
    real_replace = os.replace

    def boom(src, dst, *a, **kw):
        if str(dst).endswith("runs.json"):
            raise OSError("disk full")
        return real_replace(src, dst, *a, **kw)

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(runstore.PersistFailed):
        store.create(
            kind="skill",
            task_type="skill.story-development",
            executor="manual",
            project_id="P1",
            params={"prompt": "p"},
            provider="local_subscription",
        )

    assert list(tmp_path.glob("runs.json.tmp*")) == []

"""Asset-root admission policy (ADR-0051 / TASK-053).

This is the security boundary the studio's "pick any folder" feature rests on:
after this change the backend writes into roots the PAGE named, so every
rejection rule here is load-bearing. STRICTLY OFFLINE — filesystem only, no
server, no network, no spend.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from tests.symlink_support import symlink_or_skip

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP_DIR))

from rootadmit import (  # noqa: E402  - path injected above
    AdmittedRoot,
    RootRejected,
    admit_root,
    denied_roots,
)


def _admit(path, **kw):
    """admit_root with the confirmation gate satisfied unless a test opts out."""
    kw.setdefault("confirm", True)
    return admit_root(str(path), **kw)


# --- shape ----------------------------------------------------------------- #


def test_admits_a_plain_writable_directory(tmp_path: Path) -> None:
    target = tmp_path / "media"
    target.mkdir()
    got = _admit(target)
    assert isinstance(got, AdmittedRoot)
    assert got.resolved == target.resolve()
    assert got.created is False


def test_creates_a_missing_directory_and_reports_it(tmp_path: Path) -> None:
    target = tmp_path / "new" / "media"
    got = _admit(target)
    assert got.created is True
    assert target.is_dir()


def test_refuses_to_create_when_create_is_off(tmp_path: Path) -> None:
    with pytest.raises(RootRejected) as exc:
        _admit(tmp_path / "nope", create=False)
    assert exc.value.code == "missing"


# --- basic rejections ------------------------------------------------------- #


@pytest.mark.parametrize("raw", ["", "   "])
def test_empty_is_refused(raw: str) -> None:
    with pytest.raises(RootRejected) as exc:
        admit_root(raw, confirm=True)
    assert exc.value.code == "empty"


def test_relative_and_traversal_paths_are_refused() -> None:
    for raw in ("media", os.path.join("..", "media")):
        with pytest.raises(RootRejected) as exc:
            admit_root(raw, confirm=True)
        assert exc.value.code == "not_absolute"


def test_filesystem_root_is_refused() -> None:
    root = Path(Path.cwd().anchor or "/")
    with pytest.raises(RootRejected) as exc:
        admit_root(str(root), confirm=True)
    assert exc.value.code == "fs_root"


def test_a_file_is_not_a_directory(tmp_path: Path) -> None:
    f = tmp_path / "notadir"
    f.write_text("x", encoding="utf-8")
    with pytest.raises(RootRejected) as exc:
        _admit(f)
    assert exc.value.code == "not_a_directory"


# --- deny-list -------------------------------------------------------------- #


def test_the_repository_tree_is_denied(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / "sub" / "deeper").mkdir(parents=True)
    # the repo itself…
    with pytest.raises(RootRejected) as exc:
        _admit(repo, repo_root=repo)
    assert exc.value.code == "denied"
    # …and anything inside it: generated media never lands in the repo (§23)
    with pytest.raises(RootRejected) as exc:
        _admit(repo / "sub" / "deeper", repo_root=repo)
    assert exc.value.code == "denied"


def test_a_sibling_of_the_repo_is_fine(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    sibling = tmp_path / "media"
    sibling.mkdir()
    assert _admit(sibling, repo_root=repo).resolved == sibling.resolve()


def test_home_itself_is_denied_but_its_subdirectories_are_not(tmp_path: Path) -> None:
    trees, exact = denied_roots(None)
    assert Path.home().resolve() in exact
    assert Path.home().resolve() not in trees
    with pytest.raises(RootRejected) as exc:
        _admit(Path.home())
    assert exc.value.code == "denied"


def test_system_directories_are_denied_as_whole_trees() -> None:
    trees, _ = denied_roots(None)
    assert trees, "the running system must contribute at least one denied tree"
    for d in trees:
        with pytest.raises(RootRejected) as exc:
            _admit(d)
        assert exc.value.code == "denied", d


# --- symlinks: judged AFTER resolution -------------------------------------- #


def test_a_symlinked_root_is_admitted_as_its_RESOLVED_location(tmp_path: Path) -> None:
    """ADR-0004 §4: living under a symlink is not an escape.

    What matters is that we admit — and later show — the location the OS will
    really write to, never the link the creator happened to type.
    """
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    symlink_or_skip(link, real, target_is_directory=True)
    got = _admit(link / "media")
    assert got.resolved == (real / "media").resolve()
    assert (real / "media").is_dir()  # created through the link, at the real place


def test_a_symlink_pointing_into_a_DENIED_tree_is_refused(tmp_path: Path) -> None:
    """The deny-list is applied to the resolved path, so a link cannot smuggle
    a project into the repository."""
    repo = tmp_path / "repo"
    (repo / "inside").mkdir(parents=True)
    link = tmp_path / "innocent-looking"
    symlink_or_skip(link, repo / "inside", target_is_directory=True)
    with pytest.raises(RootRejected) as exc:
        _admit(link, repo_root=repo)
    assert exc.value.code == "denied"


# --- writability ------------------------------------------------------------ #


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits; NTFS ACLs differ")
def test_a_read_only_directory_is_refused(tmp_path: Path) -> None:
    ro = tmp_path / "ro"
    ro.mkdir()
    ro.chmod(0o500)
    try:
        with pytest.raises(RootRejected) as exc:
            _admit(ro)
        assert exc.value.code == "not_writable"
    finally:
        ro.chmod(0o700)


def test_writability_is_proven_by_writing_not_by_reading_bits(tmp_path: Path) -> None:
    """The probe must leave nothing behind."""
    target = tmp_path / "media"
    target.mkdir()
    _admit(target)
    assert list(target.iterdir()) == []


# --- confirmation gate ------------------------------------------------------ #


def test_a_new_root_requires_one_explicit_confirmation(tmp_path: Path) -> None:
    target = tmp_path / "media"
    target.mkdir()
    with pytest.raises(RootRejected) as exc:
        admit_root(str(target), confirmed_roots=set())
    assert exc.value.code == "root_unconfirmed"
    assert str(target.resolve()) in exc.value.detail


def test_an_already_confirmed_root_does_not_ask_again(tmp_path: Path) -> None:
    target = tmp_path / "media"
    target.mkdir()
    known = {str(target.resolve())}
    got = admit_root(str(target), confirmed_roots=known)  # no confirm= flag
    assert got.resolved == target.resolve()


def test_confirmation_never_bypasses_the_deny_list(tmp_path: Path) -> None:
    """A yes from the user does not unlock a protected directory."""
    repo = tmp_path / "repo"
    repo.mkdir()
    with pytest.raises(RootRejected) as exc:
        admit_root(
            str(repo),
            repo_root=repo,
            confirm=True,
            confirmed_roots={str(repo.resolve())},
        )
    assert exc.value.code == "denied"


def test_an_unconfirmed_request_creates_NOTHING(tmp_path: Path) -> None:
    """The confirmation gate runs BEFORE mkdir.

    Otherwise merely SENDING an unconfirmed request would scatter directory
    trees across the filesystem.
    """
    target = tmp_path / "brand" / "new" / "place"
    with pytest.raises(RootRejected) as exc:
        admit_root(str(target), confirmed_roots=set())
    assert exc.value.code == "root_unconfirmed"
    assert not target.exists()
    assert not (tmp_path / "brand").exists()

    # and once confirmed, it is created
    got = admit_root(str(target), confirmed_roots=set(), confirm=True)
    assert got.created is True
    assert target.is_dir()

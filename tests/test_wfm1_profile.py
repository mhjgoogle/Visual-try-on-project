"""Tests for the project instance profile (TASK-018)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ai_video_workflow.errors import OverwriteRefusedError
from ai_video_workflow.profile import (
    ProfileError,
    ProfileNotFoundError,
    load_project_profile,
    parse_project_profile,
    profile_digest,
    write_project_profile,
)
from ai_video_workflow.security.paths import PathEscapeError
from tests.symlink_support import symlink_or_skip

REPO_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = (
    REPO_ROOT
    / "examples"
    / "projects"
    / "minimal"
    / "profile"
    / "project_profile_v1.example.json"
)


def _raw(version: int = 1, **overrides) -> dict:
    raw = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    raw["version"] = version
    raw.update(overrides)
    return raw


def test_shipped_example_parses() -> None:
    profile = parse_project_profile(json.loads(EXAMPLE.read_text(encoding="utf-8")))
    assert profile.version == 1
    assert profile.duration_target_seconds == 60
    assert profile.budget_ref == "config/wfm1.json"


def test_write_load_roundtrip_and_digest_stability(tmp_path: Path) -> None:
    profile = parse_project_profile(_raw())
    path = write_project_profile(tmp_path, profile)
    assert path == tmp_path / "profile" / "project_profile_v1.json"
    loaded = load_project_profile(tmp_path)
    assert loaded == profile
    # (version, digest) is a precise, stable goal baseline
    assert profile_digest(loaded) == profile_digest(profile)


def test_versions_are_immutable_no_overwrite(tmp_path: Path) -> None:
    profile = parse_project_profile(_raw())
    write_project_profile(tmp_path, profile)
    with pytest.raises(OverwriteRefusedError):
        write_project_profile(tmp_path, profile)


def test_revision_is_a_new_version_file(tmp_path: Path) -> None:
    write_project_profile(tmp_path, parse_project_profile(_raw(version=1)))
    v2 = parse_project_profile(_raw(version=2, intent="sharper irreversible choice"))
    write_project_profile(tmp_path, v2)
    # default load returns the highest version; v1 remains on disk
    assert load_project_profile(tmp_path).version == 2
    assert load_project_profile(tmp_path, version=1).version == 1


def test_absent_profile_is_a_typed_error_and_optional(tmp_path: Path) -> None:
    # an M1 project without any profile: loading is a typed error, and
    # nothing else in the system requires the file (structural optionality
    # is covered by the whole existing suite passing untouched).
    with pytest.raises(ProfileNotFoundError):
        load_project_profile(tmp_path)


def test_unknown_and_missing_keys_rejected() -> None:
    raw = _raw()
    raw["surprise"] = 1
    with pytest.raises(ProfileError, match="unknown keys"):
        parse_project_profile(raw)
    raw = _raw()
    del raw["intent"]
    with pytest.raises(ProfileError, match="missing keys"):
        parse_project_profile(raw)


def test_empty_goal_lists_rejected() -> None:
    with pytest.raises(ProfileError, match="success_criteria"):
        parse_project_profile(_raw(success_criteria=[]))


def test_version_mismatch_between_name_and_content(tmp_path: Path) -> None:
    profile = parse_project_profile(_raw(version=2))
    write_project_profile(tmp_path, profile)
    # rename to a wrong version slot to simulate a corrupted layout
    (tmp_path / "profile" / "project_profile_v2.json").rename(
        tmp_path / "profile" / "project_profile_v1.json"
    )
    with pytest.raises(ProfileError, match="declares version"):
        load_project_profile(tmp_path, version=1)


def test_symlinked_profile_dir_rejected(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "root"
    root.mkdir()
    symlink_or_skip(root / "profile", outside, target_is_directory=True)
    with pytest.raises(PathEscapeError):
        write_project_profile(root, parse_project_profile(_raw()))

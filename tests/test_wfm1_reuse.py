"""Tests for account-level reuse packs and project references (TASK-018)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ai_video_workflow.errors import OverwriteRefusedError
from ai_video_workflow.profile import (
    ReuseError,
    ReuseRefError,
    add_reuse_ref,
    load_pack_version,
    load_reuse_refs,
    parse_pack,
    publish_pack_version,
    resolve_reuse_refs,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_PACK = REPO_ROOT / "examples" / "reuse" / "character-mia" / "v1.json"
EXAMPLE = (
    REPO_ROOT
    / "examples"
    / "projects"
    / "minimal"
    / "profile"
    / "project_profile_v1.example.json"
)


def _pack(version: int = 1, **content_overrides):
    raw = json.loads(EXAMPLE_PACK.read_text(encoding="utf-8"))
    raw["version"] = version
    raw["content"] = {**raw["content"], **content_overrides}
    return parse_pack(raw)


def _project(account: Path, name: str) -> Path:
    root = account / name
    root.mkdir(parents=True, exist_ok=True)
    return root


def test_shipped_example_pack_parses() -> None:
    pack = parse_pack(json.loads(EXAMPLE_PACK.read_text(encoding="utf-8")))
    assert pack.asset_id == "character-mia"
    assert pack.kind == "character"
    assert len(pack.content_digest) == 64


def test_publish_load_roundtrip(tmp_path: Path) -> None:
    pack = _pack()
    path = publish_pack_version(tmp_path, pack)
    assert path == tmp_path / "reuse" / "character-mia" / "v1.json"
    loaded = load_pack_version(tmp_path, "character-mia", 1)
    assert loaded == pack


def test_published_versions_are_immutable(tmp_path: Path) -> None:
    publish_pack_version(tmp_path, _pack())
    with pytest.raises(OverwriteRefusedError):
        publish_pack_version(tmp_path, _pack())


def test_two_projects_share_one_immutable_version(tmp_path: Path) -> None:
    publish_pack_version(tmp_path, _pack())
    a = _project(tmp_path, "project-a")
    b = _project(tmp_path, "project-b")
    ref_a = add_reuse_ref(a, tmp_path, "character-mia", 1)
    ref_b = add_reuse_ref(b, tmp_path, "character-mia", 1)
    assert ref_a == ref_b
    # publishing v2 does NOT change what either project resolves
    publish_pack_version(tmp_path, _pack(version=2, look="now with red scarf"))
    for project in (a, b):
        (resolved,) = resolve_reuse_refs(project, tmp_path)
        assert resolved.version == 1
        assert "red scarf" not in json.dumps(resolved.content)


def test_digest_drift_fails_closed(tmp_path: Path) -> None:
    publish_pack_version(tmp_path, _pack())
    project = _project(tmp_path, "project-a")
    add_reuse_ref(project, tmp_path, "character-mia", 1)
    # someone edits the published version in place (contract violation)
    pack_path = tmp_path / "reuse" / "character-mia" / "v1.json"
    raw = json.loads(pack_path.read_text(encoding="utf-8"))
    raw["content"]["look"] = "tampered"
    pack_path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ReuseRefError, match="drifted"):
        resolve_reuse_refs(project, tmp_path)


def test_missing_version_fails_closed(tmp_path: Path) -> None:
    project = _project(tmp_path, "project-a")
    with pytest.raises(ReuseRefError, match="no published version"):
        add_reuse_ref(project, tmp_path, "character-mia", 1)


def test_duplicate_project_ref_rejected(tmp_path: Path) -> None:
    publish_pack_version(tmp_path, _pack())
    publish_pack_version(tmp_path, _pack(version=2))
    project = _project(tmp_path, "project-a")
    add_reuse_ref(project, tmp_path, "character-mia", 1)
    with pytest.raises(ReuseRefError, match="already references"):
        add_reuse_ref(project, tmp_path, "character-mia", 2)


def test_no_latest_reference_exists() -> None:
    # the ref schema has no place for a mutable "latest": version and
    # digest are both mandatory.
    from ai_video_workflow.profile.reuse import _parse_refs

    with pytest.raises(ReuseError):
        _parse_refs(
            {
                "schema_version": 1,
                "refs": [{"asset_id": "a", "version": "latest"}],
            }
        )


def test_unsafe_asset_id_rejected(tmp_path: Path) -> None:
    raw = json.loads(EXAMPLE_PACK.read_text(encoding="utf-8"))
    for bad in ("../escape", "a/b", ".hidden", "..", ""):
        raw["asset_id"] = bad
        with pytest.raises(ReuseError):
            parse_pack(raw)


def test_refs_file_absent_means_no_refs(tmp_path: Path) -> None:
    project = _project(tmp_path, "project-a")
    assert load_reuse_refs(project) == ()
    assert resolve_reuse_refs(project, tmp_path) == ()


def test_corrupt_refs_file_is_typed_error(tmp_path: Path) -> None:
    project = _project(tmp_path, "project-a")
    refs = project / "profile" / "reuse_refs.json"
    refs.parent.mkdir(parents=True)
    refs.write_text("[not an object]", encoding="utf-8")
    with pytest.raises(ReuseError):
        load_reuse_refs(project)


def test_reuse_dir_is_not_seen_as_a_project(tmp_path: Path) -> None:
    # the account-level reuse/ dir has no config/wfm1.json, so the budget
    # layer's project discovery skips it — monthly-ledger semantics intact.
    from ai_video_workflow.budget.account import read_account_month_spent

    publish_pack_version(tmp_path, _pack())
    ledger = read_account_month_spent(tmp_path, "2026-08")
    assert ledger.total_jpy == 0
    assert ledger.per_project_jpy == {}


# --- CLI wiring -------------------------------------------------------------


def test_cli_profile_and_reuse_flow(tmp_path: Path) -> None:
    import ai_video_workflow.cli as cli

    account = tmp_path
    project = _project(account, "project-a")

    profile_src = tmp_path / "profile-src.json"
    profile_src.write_text(EXAMPLE.read_text(encoding="utf-8"), encoding="utf-8")
    pack_src = tmp_path / "pack-src.json"
    pack_src.write_text(EXAMPLE_PACK.read_text(encoding="utf-8"), encoding="utf-8")

    base = ["--project-root", str(project)]
    assert cli.main([*base, "profile-init", "--from-file", str(profile_src)]) == 0
    # repeat init must fail closed (no overwrite)
    assert cli.main([*base, "profile-init", "--from-file", str(profile_src)]) == 1
    assert cli.main([*base, "reuse-publish", "--from-file", str(pack_src)]) == 0
    assert (
        cli.main(
            [*base, "reuse-add-ref", "--asset-id", "character-mia", "--version", "1"]
        )
        == 0
    )
    assert cli.main([*base, "reuse-verify"]) == 0
    # digest drift -> verify fails closed
    pack_path = account / "reuse" / "character-mia" / "v1.json"
    raw = json.loads(pack_path.read_text(encoding="utf-8"))
    raw["content"]["look"] = "tampered"
    pack_path.write_text(json.dumps(raw), encoding="utf-8")
    assert cli.main([*base, "reuse-verify"]) == 1

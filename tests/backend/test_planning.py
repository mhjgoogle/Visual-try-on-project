"""Tests for WFM1 production planning and task packets (TASK-020)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ai_video_workflow.app.paid_coordinator import _build_spec
from ai_video_workflow.approval import transition_stage
from ai_video_workflow.budget.estimate import estimate_generation_cost
from ai_video_workflow.config import parse_catalog, parse_project_config
from ai_video_workflow.errors import OverwriteRefusedError
from ai_video_workflow.models import Shot
from ai_video_workflow.planning import (
    PacketError,
    PlanningError,
    compile_task_packets,
    load_packet,
    packet_to_generation_spec,
    packet_to_paid_request,
    parse_brief,
    parse_prompt,
    publish_brief,
    publish_prompt,
    publish_shot_plan,
    publish_story,
)
from ai_video_workflow.profile import add_reuse_ref, parse_pack, publish_pack_version

AT = "2026-08-02T00:00:00+00:00"
T0 = __import__("datetime").datetime(
    2026, 8, 2, tzinfo=__import__("datetime").timezone.utc
)


def _catalog():
    return parse_catalog(
        {
            "schema_version": 1,
            "catalog_id": "test",
            "version": 1,
            "providers": {
                "fake-a": {
                    "display_name": "A",
                    "capabilities": ["image_to_video", "text_to_video"],
                    "credential_env_vars": [],
                    "models": {
                        "m1": {
                            "billing_mode": "per_clip",
                            "currency": "USD",
                            "clip_prices": [
                                {
                                    "resolution": "512p",
                                    "duration_seconds": 10,
                                    "amount_minor_units": 10,
                                }
                            ],
                            "per_second_minor_units": {},
                        }
                    },
                }
            },
        }
    )


def _config():
    return parse_project_config(
        {
            "schema_version": 2,
            "default_provider": "fake-a",
            "fallback_provider": None,
            "shot_overrides": {},
            "budgets_jpy": {
                "episode_soft": 1200,
                "episode_hard": 1500,
                "monthly_hard": 5000,
                "per_shot": 400,
            },
            "fx": {"base_currency": "JPY", "rates": {"USD": 160}},
            "catalog_id": "test",
            "catalog_version": 1,
            "catalog_digest": "0" * 64,
        }
    )


def _prompt(prompt_id="p-main", version=1, previous=None, reason=None) -> dict:
    return {
        "schema_version": 1,
        "prompt_id": prompt_id,
        "version": version,
        "text": f"a cinematic shot v{version}",
        "previous_version": previous,
        "change_reason": reason,
        "reference_assets": ["character-mia"],
    }


def _plan_dict(n_shots: int = 6, seconds_each: int = 10, version: int = 1) -> dict:
    return {
        "schema_version": 1,
        "version": version,
        "shots": [
            {
                "shot_id": f"shot-{i}",
                "sequence": i,
                "prompt_ref": {"prompt_id": "p-main", "version": 1},
                "duration_seconds": seconds_each,
                "resolution": "512p",
                "capability": "text_to_video",
                "model_id": "m1",
                "width": 512,
                "height": 512,
                "frame_rate": 24.0,
                "reuse_assets": ["character-mia"],
                "first_frame_image": None,
            }
            for i in range(1, n_shots + 1)
        ],
    }


def _pack_dict() -> dict:
    return {
        "schema_version": 1,
        "asset_id": "character-mia",
        "version": 1,
        "kind": "character",
        "content": {"name": "Mia", "look": "grey coat"},
    }


def _setup(tmp_path: Path, *, approve: bool = True) -> Path:
    account = tmp_path
    project = account / "project-a"
    project.mkdir()
    publish_pack_version(account, parse_pack(_pack_dict()))
    add_reuse_ref(project, account, "character-mia", 1)
    publish_prompt(project, _prompt())
    publish_brief(
        project,
        {
            "schema_version": 1,
            "version": 1,
            "logline": "one act of kindness, one irreversible cost",
            "primary_load": "人性光辉",
            "secondary_load": None,
            "synopsis": "a stranger pays a debt no one asked her to pay",
        },
    )
    publish_story(
        project,
        {
            "schema_version": 1,
            "version": 1,
            "beats": [
                {"beat_id": "open", "description": "fast open"},
                {"beat_id": "turn", "description": "irreversible choice"},
                {"beat_id": "after", "description": "quiet afterglow"},
            ],
            "screenplay_md": None,
        },
    )
    publish_shot_plan(project, _plan_dict())
    if approve:
        # approve the whole chain up to production_lock, each stage bound
        # to the planning documents it governs
        targets = {
            "concept_lock": "planning/brief_v1.json",
            "screenplay_lock": "planning/story_v1.json",
            "av_design_lock": "planning/prompts/p-main/v1.json",
            "production_lock": "planning/shot_plan_v1.json",
        }
        for stage, target in targets.items():
            transition_stage(project, stage, "review", at=AT, by="o")
            transition_stage(
                project, stage, "approve", at=AT, by="o", targets=(target,)
            )
    return project


# --- documents ---------------------------------------------------------------


def test_brief_load_rules() -> None:
    with pytest.raises(PlanningError, match="unknown load"):
        parse_brief(
            {
                "schema_version": 1,
                "version": 1,
                "logline": "x",
                "primary_load": "爽剧",
                "secondary_load": None,
                "synopsis": "y",
            }
        )
    with pytest.raises(PlanningError, match="differ"):
        parse_brief(
            {
                "schema_version": 1,
                "version": 1,
                "logline": "x",
                "primary_load": "唯美",
                "secondary_load": "唯美",
                "synopsis": "y",
            }
        )


def test_shot_plan_constraints(tmp_path: Path) -> None:
    from ai_video_workflow.planning import parse_shot_plan

    with pytest.raises(PlanningError, match="6-10 shots"):
        parse_shot_plan(_plan_dict(n_shots=5))
    with pytest.raises(PlanningError, match="total duration"):
        parse_shot_plan(_plan_dict(n_shots=6, seconds_each=20))  # 120s
    bad = _plan_dict()
    bad["shots"][0]["sequence"] = 3  # duplicate/gap
    with pytest.raises(PlanningError, match="sequences"):
        parse_shot_plan(bad)


def test_prompt_lineage_rules(tmp_path: Path) -> None:
    project = tmp_path / "p"
    project.mkdir()
    publish_prompt(project, _prompt())
    # v2 must link v1 and give a reason
    with pytest.raises(PlanningError, match="change_reason"):
        parse_prompt(_prompt(version=2, previous=1, reason=None))
    with pytest.raises(PlanningError, match="only allowed"):
        parse_prompt(_prompt(version=2, previous=None, reason="why?"))
    publish_prompt(project, _prompt(version=2, previous=1, reason="tighter mood"))
    # publishing v3 that links a NON-existent v5 fails closed
    with pytest.raises(PlanningError):
        publish_prompt(project, _prompt(version=6, previous=5, reason="x"))
    # immutability
    with pytest.raises(OverwriteRefusedError):
        publish_prompt(project, _prompt())


def test_local_path_first_frame_rejected_in_plan() -> None:
    from ai_video_workflow.planning import parse_shot_plan

    bad = _plan_dict()
    bad["shots"][0]["first_frame_image"] = "/etc/passwd"
    with pytest.raises(PlanningError, match="first_frame_image"):
        parse_shot_plan(bad)


# --- packet compilation --------------------------------------------------------


def test_compile_produces_traceable_packets(tmp_path: Path) -> None:
    project = _setup(tmp_path)
    packets = compile_task_packets(project, tmp_path, _catalog(), _config())
    assert len(packets) == 6
    packet = packets[0]
    # traceable to approved content, asset version, quote, and parameters
    assert packet.prompt_id == "p-main" and packet.prompt_version == 1
    assert len(packet.prompt_digest) == 64
    assert packet.reuse_assets[0]["asset_id"] == "character-mia"
    assert packet.quote_minor_units == 10 and packet.quote_currency == "USD"
    assert packet.estimate_jpy == 16
    assert packet.p50_jpy == 16 and packet.p90_jpy == 32
    # unpaid budget preview for the whole episode
    assert sum(p.p90_jpy for p in packets) == 6 * 32  # well under 1200


def test_recompile_is_idempotent_and_change_makes_new_version(
    tmp_path: Path,
) -> None:
    project = _setup(tmp_path)
    first = compile_task_packets(project, tmp_path, _catalog(), _config())
    second = compile_task_packets(project, tmp_path, _catalog(), _config())
    assert [p.packet_version for p in first] == [p.packet_version for p in second]
    assert [p.input_digest for p in first] == [p.input_digest for p in second]
    # change an input (new plan version with a new prompt version) -> new
    # packet version; the old packet file is untouched
    publish_prompt(project, _prompt(version=2, previous=1, reason="sharper"))
    plan2 = _plan_dict(version=2)
    for shot in plan2["shots"]:
        shot["prompt_ref"]["version"] = 2
    publish_shot_plan(project, plan2)
    transition_stage(project, "production_lock", "reject", at=AT, by="o")
    transition_stage(project, "production_lock", "revise", at=AT, by="o")
    transition_stage(project, "production_lock", "review", at=AT, by="o")
    transition_stage(
        project,
        "production_lock",
        "approve",
        at=AT,
        by="o",
        targets=("planning/shot_plan_v2.json",),
    )
    third = compile_task_packets(project, tmp_path, _catalog(), _config())
    assert all(p.packet_version == 2 for p in third)
    assert load_packet(project, "shot-1", 1).prompt_version == 1  # preserved


def test_unapproved_inputs_block_compilation(tmp_path: Path) -> None:
    from ai_video_workflow.approval import NotApprovedError

    project = _setup(tmp_path, approve=False)
    with pytest.raises(NotApprovedError):
        compile_task_packets(project, tmp_path, _catalog(), _config())


def test_stale_upstream_blocks_compilation(tmp_path: Path) -> None:
    from ai_video_workflow.approval import StaleApprovalError

    project = _setup(tmp_path)
    # tamper with the approved brief -> concept approval stale -> compile blocked
    brief = project / "planning" / "brief_v1.json"
    raw = json.loads(brief.read_text(encoding="utf-8"))
    raw["logline"] = "changed after approval"
    brief.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(StaleApprovalError):
        compile_task_packets(project, tmp_path, _catalog(), _config())


def test_reuse_digest_drift_blocks_compilation(tmp_path: Path) -> None:
    project = _setup(tmp_path)
    pack_path = tmp_path / "reuse" / "character-mia" / "v1.json"
    raw = json.loads(pack_path.read_text(encoding="utf-8"))
    raw["content"]["look"] = "tampered"
    pack_path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(PacketError, match="drifted"):
        compile_task_packets(project, tmp_path, _catalog(), _config())


def test_unreferenced_reuse_asset_blocks(tmp_path: Path) -> None:
    project = _setup(tmp_path)
    plan2 = _plan_dict(version=2)
    plan2["shots"][0]["reuse_assets"] = ["ghost-asset"]
    publish_shot_plan(project, plan2)
    transition_stage(project, "production_lock", "reject", at=AT, by="o")
    transition_stage(project, "production_lock", "revise", at=AT, by="o")
    transition_stage(project, "production_lock", "review", at=AT, by="o")
    transition_stage(
        project,
        "production_lock",
        "approve",
        at=AT,
        by="o",
        targets=("planning/shot_plan_v2.json",),
    )
    with pytest.raises(PacketError, match="not\\s+referenced"):
        compile_task_packets(project, tmp_path, _catalog(), _config())


# --- bridge to TASK-016 ---------------------------------------------------------


def test_packet_builds_identical_generation_spec_and_quote(tmp_path: Path) -> None:
    project = _setup(tmp_path)
    packet = compile_task_packets(project, tmp_path, _catalog(), _config())[0]

    request = packet_to_paid_request(
        packet, task_id="task-1", operation_id="op-1", stage="production_lock"
    )
    shot = Shot(
        shot_id=packet.shot_id,
        scene_id="scene-1",
        sequence=1,
        description="d",
        prompt=packet.prompt_text,
        duration_seconds=float(packet.duration_seconds),
        width=packet.width,
        height=packet.height,
        frame_rate=packet.frame_rate,
        created_at=T0,
    )
    # the coordinator's own spec builder produces the identical spec
    assert _build_spec(shot, request) == packet_to_generation_spec(packet)
    # and the packet's stored quote equals a fresh estimate
    estimate = estimate_generation_cost(
        _catalog(),
        _config().fx,
        packet.provider_primary,
        packet.model_id,
        resolution=packet.resolution,
        duration_seconds=packet.duration_seconds,
    )
    assert estimate.original_amount_minor_units == packet.quote_minor_units
    assert estimate.jpy == packet.estimate_jpy


def test_cli_plan_compile(tmp_path: Path, monkeypatch) -> None:
    import ai_video_workflow.cli as cli
    from ai_video_workflow.config import compute_catalog_digest

    # write a real locked catalog + project config so the CLI path works
    catalog_dir = tmp_path / "catalog"
    catalog_dir.mkdir()
    raw_catalog = {
        "schema_version": 1,
        "catalog_id": "test",
        "version": 1,
        "providers": {
            "fake-a": {
                "display_name": "A",
                "capabilities": ["image_to_video", "text_to_video"],
                "credential_env_vars": [],
                "models": {
                    "m1": {
                        "billing_mode": "per_clip",
                        "currency": "USD",
                        "clip_prices": [
                            {
                                "resolution": "512p",
                                "duration_seconds": 10,
                                "amount_minor_units": 10,
                            }
                        ],
                        "per_second_minor_units": {},
                    }
                },
            }
        },
    }
    (catalog_dir / "test.json").write_text(json.dumps(raw_catalog), encoding="utf-8")
    project = _setup(tmp_path)
    config_raw = {
        "schema_version": 2,
        "default_provider": "fake-a",
        "fallback_provider": None,
        "shot_overrides": {},
        "budgets_jpy": {
            "episode_soft": 1200,
            "episode_hard": 1500,
            "monthly_hard": 5000,
            "per_shot": 400,
        },
        "fx": {"base_currency": "JPY", "rates": {"USD": 160}},
        "catalog_id": "test",
        "catalog_version": 1,
        "catalog_digest": compute_catalog_digest(raw_catalog),
    }
    (project / "config").mkdir()
    (project / "config" / "wfm1.json").write_text(
        json.dumps(config_raw), encoding="utf-8"
    )
    code = cli.main(
        [
            "--project-root",
            str(project),
            "--catalog-dir",
            str(catalog_dir),
            "plan-compile",
        ]
    )
    assert code == 0
    assert (project / "planning" / "packets" / "shot-1_v1.json").is_file()

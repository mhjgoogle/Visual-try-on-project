"""Command Gateway 锁定场景的共享构造器。

被 backend gateway 测试（tests/backend/test_lock_gateway_command.py）与
e2e Studio 测试（tests/e2e/test_motv_lock_e2e.py、
tests/e2e/test_motv_task048_e2e.py）共用。名字保持原样。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from ai_video_workflow.approval import transition_stage
from ai_video_workflow.config import compute_catalog_digest
from ai_video_workflow.models import Project
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.planning import (
    publish_brief,
    publish_prompt,
    publish_shot_plan,
    publish_story,
)

AT = "2026-08-07T00:00:00+00:00"
T0 = datetime(2026, 8, 7, tzinfo=timezone.utc)
FRAME = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="


def _clock() -> datetime:
    return T0


# --- staging (mirrors tests/test_paid_gateway_command.py) ---------------------


def _catalog_raw() -> dict:
    return {
        "schema_version": 1,
        "catalog_id": "wfm1-test",
        "version": 1,
        "providers": {
            "prov": {
                "display_name": "P",
                "capabilities": ["image_to_video", "text_to_video"],
                "credential_env_vars": [],
                "models": {
                    "m1": {
                        "billing_mode": "per_clip",
                        "currency": "USD",
                        "clip_prices": [
                            {
                                "resolution": "512p",
                                "duration_seconds": 6,
                                "amount_minor_units": 10,
                            },
                            {
                                "resolution": "512p",
                                "duration_seconds": 10,
                                "amount_minor_units": 15,
                            },
                        ],
                        "per_second_minor_units": {},
                    }
                },
            }
        },
    }


def _config_dict(digest: str) -> dict:
    return {
        "schema_version": 2,
        "default_provider": "prov",
        "fallback_provider": None,
        "shot_overrides": {},
        "budgets_jpy": {
            "episode_soft": 1200,
            "episode_hard": 1500,
            "monthly_hard": 5000,
            "per_shot": 400,
        },
        "fx": {"base_currency": "JPY", "rates": {"USD": 160}},
        "catalog_id": "wfm1-test",
        "catalog_version": 1,
        "catalog_digest": digest,
    }


def _plan_v1() -> dict:
    return {
        "schema_version": 1,
        "version": 1,
        "shots": [
            {
                "shot_id": f"shot-{i}",
                "sequence": i,
                "prompt_ref": {"prompt_id": "p-main", "version": 1},
                "duration_seconds": 10,
                "resolution": "512p",
                "capability": "text_to_video",
                "model_id": "m1",
                "width": 512,
                "height": 512,
                "frame_rate": 24.0,
                "reuse_assets": [],
                "first_frame_image": None,
            }
            for i in range(1, 7)
        ],
    }


def _setup_project(
    tmp_path: Path, *, approve: bool = True, approve_production: bool = True
) -> tuple[Path, Path]:
    """Stage a project with an approved shot plan v1 (no packets compiled)."""
    account = tmp_path
    project = account / "project-a"
    project.mkdir()
    catalog_dir = account / "catalog"
    catalog_dir.mkdir()
    raw = _catalog_raw()
    (catalog_dir / "wfm1-test.json").write_text(json.dumps(raw), encoding="utf-8")
    (project / "config").mkdir()
    (project / "config" / "wfm1.json").write_text(
        json.dumps(_config_dict(compute_catalog_digest(raw))), encoding="utf-8"
    )
    write_model_json(
        project / "project.json",
        Project(project_id="proj-a", name="T", created_at=T0),
    )
    publish_prompt(
        project,
        {
            "schema_version": 1,
            "prompt_id": "p-main",
            "version": 1,
            "text": "a cinematic shot v1",
            "previous_version": None,
            "change_reason": None,
            "reference_assets": [],
        },
    )
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
    publish_shot_plan(project, _plan_v1())
    if approve:
        targets = {
            "concept_lock": "planning/brief_v1.json",
            "screenplay_lock": "planning/story_v1.json",
            "av_design_lock": "planning/prompts/p-main/v1.json",
        }
        if approve_production:
            targets["production_lock"] = "planning/shot_plan_v1.json"
        for stage, target in targets.items():
            transition_stage(project, stage, "review", at=AT, by="o")
            transition_stage(
                project, stage, "approve", at=AT, by="o", targets=(target,)
            )
    return project, catalog_dir


# --- envelope helpers ----------------------------------------------------------


def _draft_shot(**overrides) -> dict:
    shot = {
        "title": "开场",
        "description": "a calm sunrise over the sea",
        "duration_seconds": 10,
        "first_frame_image": None,
    }
    shot.update(overrides)
    return shot

#!/usr/bin/env python3
"""Stage the TASK-041 evidence project (offline, zero cost).

Creates a self-contained account under ``data/evidence-account/`` (gitignored)
holding ONE project staged all the way to an approved ``production_lock`` with a
compiled task packet for a single shot, plus a locked catalog carrying the REAL
MiniMax price row (MiniMax-Hailuo-02 · 768P · 6s · per-clip USD 0.28 → 45 JPY at
the locked FX, under the 400 JPY per-shot cap). Staging itself never calls a
provider and spends nothing — it only writes local files, exactly like the
pytest fixture this mirrors (tests/backend/test_paid_gateway_command.py).

Run inside the venv:  python mockups/motv-workspace/stage_evidence.py
Then start the UI backend in paid mode (see the printed instructions). The one
real generation still requires WFM1_MINIMAX_API_KEY + the deployment env flag +
an explicit user confirmation of the ~USD 0.28 spend.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

MOCKUP_DIR = Path(__file__).resolve().parent
DEFAULT_ACCOUNT = MOCKUP_DIR / "data" / "evidence-account"

AT = "2026-08-07T00:00:00+00:00"
T0 = datetime(2026, 8, 7, tzinfo=timezone.utc)

CATALOG_ID = "minimax-real"
MODEL = "MiniMax-Hailuo-02"
RESOLUTION = "768P"
DURATION = 6  # seconds; per-clip billed
PRICE_USD_MINOR = 28  # USD 0.28 — TASK-017 documented real price


def _catalog_raw() -> dict:
    return {
        "schema_version": 1,
        "catalog_id": CATALOG_ID,
        "version": 1,
        "providers": {
            "minimax": {
                "display_name": "MiniMax",
                "capabilities": ["text_to_video", "image_to_video"],
                # ADR-0009: exactly this one credential env var, fail-closed.
                "credential_env_vars": ["WFM1_MINIMAX_API_KEY"],
                "models": {
                    MODEL: {
                        "billing_mode": "per_clip",
                        "currency": "USD",
                        "clip_prices": [
                            {
                                "resolution": RESOLUTION,
                                "duration_seconds": DURATION,
                                "amount_minor_units": PRICE_USD_MINOR,
                            }
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
        "default_provider": "minimax",
        "fallback_provider": None,
        "shot_overrides": {},
        "budgets_jpy": {
            "episode_soft": 1200,
            "episode_hard": 1500,
            "monthly_hard": 5000,
            "per_shot": 400,
        },
        "fx": {"base_currency": "JPY", "rates": {"USD": 160}},
        "catalog_id": CATALOG_ID,
        "catalog_version": 1,
        "catalog_digest": digest,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="stage the TASK-041 evidence account")
    ap.add_argument("--account-root", type=Path, default=DEFAULT_ACCOUNT)
    ap.add_argument(
        "--force",
        action="store_true",
        help="replace an existing staged account (never silently overwrites)",
    )
    args = ap.parse_args()

    # heavy imports after argparse so --help works anywhere
    from ai_video_workflow.app.paid_gateway import ShotRecordTargetResolver
    from ai_video_workflow.approval import transition_stage
    from ai_video_workflow.config import compute_catalog_digest
    from ai_video_workflow.config.catalog_lock import load_locked_catalog
    from ai_video_workflow.config.project_config import load_project_config
    from ai_video_workflow.models import Project, Scene, Shot
    from ai_video_workflow.persistence import write_model_json
    from ai_video_workflow.planning import (
        compile_task_packets,
        publish_brief,
        publish_prompt,
        publish_shot_plan,
        publish_story,
    )
    from ai_video_workflow.profile import (
        add_reuse_ref,
        parse_pack,
        publish_pack_version,
    )

    account: Path = args.account_root.resolve()
    if account.exists():
        if not args.force:
            print(f"refusing to overwrite existing {account} (use --force)")
            return 1
        # --force may only delete a staged account INSIDE this mockup's data/
        # scratch dir — never an arbitrary user directory (rmtree is recursive
        # and unrecoverable). Anything else must be removed manually.
        data_dir = (MOCKUP_DIR / "data").resolve()
        if data_dir not in account.parents:
            print(
                f"refusing --force outside {data_dir}: {account}\n"
                "delete it manually if that is really what you want"
            )
            return 1
        shutil.rmtree(account)
    project = account / "evidence-demo"
    project.mkdir(parents=True)

    # -- locked catalog with the real MiniMax price row ----------------------
    catalog_dir = account / "catalog"
    catalog_dir.mkdir()
    raw = _catalog_raw()
    (catalog_dir / f"{CATALOG_ID}.json").write_text(
        json.dumps(raw, indent=2), encoding="utf-8"
    )
    digest = compute_catalog_digest(raw)
    (project / "config").mkdir()
    (project / "config" / "wfm1.json").write_text(
        json.dumps(_config_dict(digest), indent=2), encoding="utf-8"
    )

    # -- planning chain to an approved production_lock ------------------------
    publish_pack_version(
        account,
        parse_pack(
            {
                "schema_version": 1,
                "asset_id": "character-mia",
                "version": 1,
                "kind": "character",
                "content": {"name": "Mia", "look": "grey coat"},
            }
        ),
    )
    add_reuse_ref(project, account, "character-mia", 1)
    publish_prompt(
        project,
        {
            "schema_version": 1,
            "prompt_id": "p-main",
            "version": 1,
            "text": "a calm sunrise over the sea, cinematic, gentle waves",
            "previous_version": None,
            "change_reason": None,
            "reference_assets": ["character-mia"],
        },
    )
    publish_brief(
        project,
        {
            "schema_version": 1,
            "version": 1,
            "logline": "one quiet sunrise proves the night ends",
            "primary_load": "人性光辉",
            "secondary_load": None,
            "synopsis": "a single calm shot of the sea at dawn",
        },
    )
    publish_story(
        project,
        {
            "schema_version": 1,
            "version": 1,
            "beats": [
                {"beat_id": "open", "description": "dark sea"},
                {"beat_id": "turn", "description": "first light"},
                {"beat_id": "after", "description": "full sunrise"},
            ],
            "screenplay_md": None,
        },
    )
    # The plan contract requires 6-10 shots totalling 45-75s; 8 x 6s = 48s. Only
    # shot-1 is ever generated in the evidence run — the rest cost nothing.
    publish_shot_plan(
        project,
        {
            "schema_version": 1,
            "version": 1,
            "shots": [
                {
                    "shot_id": f"shot-{i}",
                    "sequence": i,
                    "prompt_ref": {"prompt_id": "p-main", "version": 1},
                    "duration_seconds": DURATION,
                    "resolution": RESOLUTION,
                    "capability": "text_to_video",
                    "model_id": MODEL,
                    "width": 1366,
                    "height": 768,
                    "frame_rate": 24.0,
                    "reuse_assets": ["character-mia"],
                    "first_frame_image": None,
                }
                for i in range(1, 9)
            ],
        },
    )
    targets = {
        "concept_lock": "planning/brief_v1.json",
        "screenplay_lock": "planning/story_v1.json",
        "av_design_lock": "planning/prompts/p-main/v1.json",
        "production_lock": "planning/shot_plan_v1.json",
    }
    for stage, target in targets.items():
        transition_stage(project, stage, "review", at=AT, by="user")
        transition_stage(project, stage, "approve", at=AT, by="user", targets=(target,))
    config = load_project_config(project)
    catalog = load_locked_catalog(config, catalog_dir)
    compile_task_packets(project, account, catalog, config)

    # -- records ---------------------------------------------------------------
    write_model_json(
        project / "project.json",
        Project(project_id="evidence-demo", name="TASK-041 evidence", created_at=T0),
    )
    (project / "records" / "scenes").mkdir(parents=True)
    (project / "records" / "shots").mkdir(parents=True)
    write_model_json(
        project / "records" / "scenes" / "scene-1.json",
        Scene(
            scene_id="scene-1",
            project_id="evidence-demo",
            sequence=1,
            title="dawn",
            description="the sea at dawn",
            created_at=T0,
        ),
    )
    for i in range(1, 9):
        write_model_json(
            project / "records" / "shots" / f"shot-{i}.json",
            Shot(
                shot_id=f"shot-{i}",
                scene_id="scene-1",
                sequence=i,
                description="calm sunrise over the sea",
                prompt="a calm sunrise over the sea, cinematic, gentle waves",
                duration_seconds=float(DURATION),
                width=1366,
                height=768,
                frame_rate=24.0,
                created_at=T0,
            ),
        )

    # -- print the generation coordinates -------------------------------------
    resolved = ShotRecordTargetResolver().resolve_target(
        project, ref="shot-1", version=1
    )
    record = project / "records" / "shots" / "shot-1.json"
    assert resolved.exists, "staged shot record must resolve"
    assert resolved.content_digest == hashlib.sha256(record.read_bytes()).hexdigest()

    print("staged evidence account (offline, zero cost):")
    print(f"  account root : {account}")
    print(f"  project      : {project.name}")
    print(f"  shot target  : ref=shot-1 version=1 digest={resolved.content_digest}")
    print("  params       : task_id=task-shot-1-1 shot_id=shot-1 packet_version=1")
    print(f"  quote        : USD 0.{PRICE_USD_MINOR:02d} ≈ 45 JPY (per_shot cap 400)")
    print()
    print("start the UI backend in paid mode (still no spend until confirmed):")
    print("  export AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1")
    print("  python mockups/motv-workspace/server.py \\")
    print(f"    --account-root {account} \\")
    print(f"    --catalog-dir {catalog_dir} --enable-paid")
    return 0


if __name__ == "__main__":
    sys.exit(main())

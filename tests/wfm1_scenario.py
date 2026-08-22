"""Shared WFM1 end-to-end scenario builders (test support layer).

One episode — one character, one scene, 6 shots, 60 seconds — seeded and
driven through the REAL CLI/driver coordination chain with a fake paid
provider and fake media tools (no network, no payment, no ffmpeg).

This module is test infrastructure, not a test file: it lives at the
tests/ root next to ``media_fakes`` / ``paid_fakes`` and is shared by the
backend workspace tests (``tests/backend/test_workspace_*``) and the e2e
acceptance suites (``tests/e2e/test_wfm1_e2e.py``,
``tests/e2e/test_workspace_wfm1_acceptance.py``). Names keep their
original spelling (including the leading underscore) so consumers only
change the import path.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import ai_video_workflow.cli as cli
from ai_video_workflow.config import compute_catalog_digest
from ai_video_workflow.inspection.base import MediaProbeResult
from ai_video_workflow.models import Project, Scene, Shot
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.providers.registry import ProviderRegistry
from tests.media_fakes import FakeMediaInspector, FakeVideoComposer
from tests.paid_fakes import FakeFetcher, FakeProvider

T0 = datetime(2026, 8, 2, 9, 0, 0, tzinfo=timezone.utc)
SHOTS = 6
SECONDS_EACH = 10  # 6 x 10s = 60s episode


class _Clock:
    def __init__(self) -> None:
        self._n = 0

    def __call__(self) -> datetime:
        self._n += 1
        return T0 + timedelta(minutes=self._n)


def _catalog_raw() -> dict:
    return {
        "schema_version": 1,
        "catalog_id": "demo",
        "version": 1,
        "providers": {
            "fake-a": {
                "display_name": "Fake paid provider",
                "capabilities": ["image_to_video", "text_to_video"],
                "credential_env_vars": [],
                "models": {
                    "m1": {
                        "billing_mode": "per_clip",
                        "currency": "USD",
                        "clip_prices": [
                            {
                                "resolution": "512p",
                                "duration_seconds": SECONDS_EACH,
                                "amount_minor_units": 10,
                            }
                        ],
                        "per_second_minor_units": {},
                    }
                },
            }
        },
    }


def _seed_episode(account: Path, name: str = "wfm1-demo") -> Path:
    root = account / name
    (root / "records" / "scenes").mkdir(parents=True)
    (root / "records" / "shots").mkdir(parents=True)
    write_model_json(root / "project.json", Project("proj-demo", "Demo", T0))
    write_model_json(
        root / "records" / "scenes" / "scene-1.json",
        Scene("scene-1", "proj-demo", 1, "S1", "one location", T0),
    )
    for i in range(1, SHOTS + 1):
        write_model_json(
            root / "records" / "shots" / f"shot-{i}.json",
            Shot(
                shot_id=f"shot-{i}",
                scene_id="scene-1",
                sequence=i,
                description=f"shot {i}",
                prompt=f"a cinematic shot {i}",
                duration_seconds=float(SECONDS_EACH),
                width=512,
                height=512,
                frame_rate=24.0,
                created_at=T0,
            ),
        )
    return root


def _write_config(root: Path, catalog_digest: str) -> None:
    (root / "config").mkdir()
    (root / "config" / "wfm1.json").write_text(
        json.dumps(
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
                "catalog_id": "demo",
                "catalog_version": 1,
                "catalog_digest": catalog_digest,
            }
        ),
        encoding="utf-8",
    )


def _author_creative(root: Path) -> None:
    prompts = {
        "schema_version": 1,
        "prompt_id": "p-main",
        "version": 1,
        "text": "a young woman with short black hair, cinematic lighting",
        "previous_version": None,
        "change_reason": None,
        "reference_assets": ["character-mia"],
    }
    brief = {
        "schema_version": 1,
        "version": 1,
        "logline": "one act of kindness, one irreversible cost",
        "primary_load": "人性光辉",
        "secondary_load": None,
        "synopsis": "a stranger pays a debt no one asked her to pay",
    }
    story = {
        "schema_version": 1,
        "version": 1,
        "beats": [
            {"beat_id": "open", "description": "fast open"},
            {"beat_id": "turn", "description": "irreversible choice"},
            {"beat_id": "after", "description": "quiet afterglow"},
        ],
        "screenplay_md": None,
    }
    plan = {
        "schema_version": 1,
        "version": 1,
        "shots": [
            {
                "shot_id": f"shot-{i}",
                "sequence": i,
                "prompt_ref": {"prompt_id": "p-main", "version": 1},
                "duration_seconds": SECONDS_EACH,
                "resolution": "512p",
                "capability": "text_to_video",
                "model_id": "m1",
                "width": 512,
                "height": 512,
                "frame_rate": 24.0,
                "reuse_assets": ["character-mia"],
                "first_frame_image": None,
            }
            for i in range(1, SHOTS + 1)
        ],
    }
    profile = {
        "schema_version": 1,
        "version": 1,
        "title": "Demo Episode",
        "genre": "human-warmth short drama",
        "audience": "short-video viewers",
        "duration_target_seconds": 60,
        "aspect_ratio": "9:16",
        "language": "zh",
        "visual_style": "cinematic stylized",
        "release_targets": ["short-video-platform"],
        "budget_ref": "config/wfm1.json",
        "intent": "one irreversible kindness, shown not told",
        "narrative_goals": ["fast open", "quiet afterglow"],
        "quality_bar": ["face consistency"],
        "forbidden_issues": ["preachy dialogue"],
        "success_criteria": ["watchable 60s cut", "episode cost <= 1200 JPY"],
    }
    from ai_video_workflow.planning import (
        publish_brief,
        publish_prompt,
        publish_shot_plan,
        publish_story,
    )
    from ai_video_workflow.profile import parse_project_profile, write_project_profile

    publish_prompt(root, prompts)
    publish_brief(root, brief)
    publish_story(root, story)
    publish_shot_plan(root, plan)
    write_project_profile(root, parse_project_profile(profile))


def _use_fakes(monkeypatch, provider: FakeProvider) -> None:
    from ai_video_workflow.providers.manual import ManualVideoProvider

    monkeypatch.setattr(cli, "utc_now", _Clock())
    monkeypatch.setattr(
        cli,
        "FfprobeMediaInspector",
        lambda: FakeMediaInspector(
            result=MediaProbeResult("mp4", float(SECONDS_EACH), 512, 512, 24.0)
        ),
    )
    monkeypatch.setattr(cli, "FfmpegVideoComposer", FakeVideoComposer)
    monkeypatch.setattr(cli, "UrllibMediaFetcher", FakeFetcher)

    def _registry():
        reg = ProviderRegistry()
        reg.register(provider.provider_id, lambda entry: provider)
        reg.register("manual", lambda entry: ManualVideoProvider())
        return reg

    monkeypatch.setattr(cli, "default_registry", _registry)


def _run(root, catalog_dir, *args) -> int:
    return cli.main(
        ["--project-root", str(root), "--catalog-dir", str(catalog_dir), *args]
    )


def _approve(root, catalog_dir, stage: str, target: str) -> None:
    assert _run(root, catalog_dir, "stage-review", stage, "--by", "owner") == 0
    assert (
        _run(
            root,
            catalog_dir,
            "stage-approve",
            stage,
            "--by",
            "owner",
            "--target",
            target,
        )
        == 0
    )


def _setup(tmp_path: Path, monkeypatch) -> tuple[Path, Path, FakeProvider]:
    account = tmp_path
    catalog_dir = tmp_path / "catalog"
    catalog_dir.mkdir()
    raw = _catalog_raw()
    (catalog_dir / "demo.json").write_text(json.dumps(raw), encoding="utf-8")

    root = _seed_episode(account)
    _write_config(root, compute_catalog_digest(raw))

    # one reusable character published at the account level
    from ai_video_workflow.profile import parse_pack, publish_pack_version

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
    fake = FakeProvider(provider_id="fake-a")
    _use_fakes(monkeypatch, fake)
    assert (
        _run(
            root,
            catalog_dir,
            "reuse-add-ref",
            "--asset-id",
            "character-mia",
            "--version",
            "1",
        )
        == 0
    )
    _author_creative(root)
    _approve(root, catalog_dir, "concept_lock", "planning/brief_v1.json")
    _approve(root, catalog_dir, "screenplay_lock", "planning/story_v1.json")
    _approve(root, catalog_dir, "av_design_lock", "planning/prompts/p-main/v1.json")
    _approve(root, catalog_dir, "production_lock", "planning/shot_plan_v1.json")
    return root, catalog_dir, fake


def _compile(root, catalog_dir) -> None:
    assert _run(root, catalog_dir, "init-tasks") == 0
    assert _run(root, catalog_dir, "plan-compile") == 0


def _packet_submit(root, catalog_dir, task_id: str, shot: str, op: str) -> int:
    """The WFM1 paid entry: the request comes from the verified packet."""
    return _run(
        root,
        catalog_dir,
        "paid-submit",
        task_id,
        "--shot",
        shot,
        "--operation-id",
        op,
        "--packet-version",
        "1",
    )


def _paid_all_shots(root, catalog_dir) -> None:
    _compile(root, catalog_dir)
    for i in range(1, SHOTS + 1):
        task_id = f"task-shot-{i}-1"
        assert _packet_submit(root, catalog_dir, task_id, f"shot-{i}", f"op-{i}") == 0
        assert _run(root, catalog_dir, "paid-integrate", task_id) == 0

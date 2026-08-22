"""付费生命周期场景的共享构造器，被 paid 生命周期与 release/delivery 测试共用。

名字保持原样（自 tests/backend/test_paid_lifecycle.py 抽取，TASK-102）。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import ai_video_workflow.cli as cli
from ai_video_workflow.config import compute_catalog_digest
from ai_video_workflow.digests import file_sha256
from ai_video_workflow.inspection.base import MediaProbeResult
from ai_video_workflow.models import Project, Scene, Shot
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.providers.registry import ProviderRegistry
from tests.media_fakes import FakeMediaInspector, FakeVideoComposer
from tests.paid_fakes import FakeFetcher, FakeProvider

T0 = datetime(2026, 8, 2, 8, 0, 0, tzinfo=timezone.utc)
TASK = "task-shot-1-1"


class _Clock:
    def __init__(self) -> None:
        self._n = 0

    def __call__(self) -> datetime:
        self._n += 1
        return T0 + timedelta(minutes=self._n)


def _catalog_raw() -> dict:
    return {
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
                                "duration_seconds": 4,
                                "amount_minor_units": 10,
                            }
                        ],
                        "per_second_minor_units": {},
                    }
                },
            }
        },
    }


def _seed_project(tmp_path: Path, shots: int = 2) -> tuple[Path, Path]:
    catalog_dir = tmp_path / "catalog"
    catalog_dir.mkdir()
    raw = _catalog_raw()
    (catalog_dir / "test.json").write_text(json.dumps(raw), encoding="utf-8")

    root = tmp_path / "project"
    (root / "records" / "scenes").mkdir(parents=True)
    (root / "records" / "shots").mkdir(parents=True)
    write_model_json(root / "project.json", Project("proj-1", "Demo", T0))
    write_model_json(
        root / "records" / "scenes" / "scene-1.json",
        Scene("scene-1", "proj-1", 1, "S1", "d", T0),
    )
    for i in range(shots):
        write_model_json(
            root / "records" / "shots" / f"shot-{i + 1}.json",
            Shot(
                shot_id=f"shot-{i + 1}",
                scene_id="scene-1",
                sequence=i + 1,
                description="d",
                prompt="p",
                duration_seconds=4.0,
                width=1280,
                height=720,
                frame_rate=24.0,
                created_at=T0,
            ),
        )
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
                "catalog_id": "test",
                "catalog_version": 1,
                "catalog_digest": compute_catalog_digest(raw),
            }
        ),
        encoding="utf-8",
    )
    # approve concept_lock bound to shot-1's record
    shot_rel = "records/shots/shot-1.json"
    digest = file_sha256(root / shot_rel)
    (root / "approval").mkdir()
    (root / "approval" / "concept_lock.json").write_text(
        json.dumps(
            {
                "schema_version": 2,
                "stage": "concept_lock",
                "status": "approved",
                "approved_at": "2026-08-02T00:00:00+00:00",
                "approved_by": "owner",
                "approved_targets": [
                    {
                        "ref_kind": "file",
                        "ref": shot_rel,
                        "version": 1,
                        "content_digest": digest,
                    }
                ],
                "note": None,
            }
        ),
        encoding="utf-8",
    )
    return root, catalog_dir


def _use_fakes(monkeypatch, provider: FakeProvider) -> None:
    monkeypatch.setattr(cli, "utc_now", _Clock())
    monkeypatch.setattr(
        cli,
        "FfprobeMediaInspector",
        lambda: FakeMediaInspector(
            result=MediaProbeResult("mp4", 4.0, 1280, 720, 24.0)
        ),
    )
    monkeypatch.setattr(cli, "FfmpegVideoComposer", FakeVideoComposer)
    monkeypatch.setattr(cli, "UrllibMediaFetcher", FakeFetcher)

    # keep the real manual factory for the M1 integration path
    from ai_video_workflow.providers.manual import ManualVideoProvider

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


def _paid_submit(root, catalog_dir, task_id: str, shot: str, op: str = "op-1") -> int:
    return _run(
        root,
        catalog_dir,
        "paid-submit",
        task_id,
        "--unplanned",
        "--shot",
        shot,
        "--operation-id",
        op,
        "--capability",
        "text_to_video",
        "--model",
        "m1",
        "--resolution",
        "512p",
        "--duration",
        "4",
    )

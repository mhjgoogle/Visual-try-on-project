"""CLI wiring tests for the paid path (TASK-016)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import ai_video_workflow.cli as cli
from ai_video_workflow.config import compute_catalog_digest
from ai_video_workflow.digests import file_sha256
from ai_video_workflow.models import Project, Scene, Shot
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.providers.registry import ProviderRegistry
from ai_video_workflow.qcd.events import QcdEventType
from ai_video_workflow.qcd.log import read_events
from tests.paid_fakes import FakeFetcher, FakeProvider

T0 = datetime(2026, 8, 1, tzinfo=timezone.utc)


def _catalog_raw() -> dict:
    return {
        "schema_version": 1,
        "catalog_id": "wfm1-test",
        "version": 1,
        "providers": {
            "fake-a": {
                "display_name": "A",
                "capabilities": ["image_to_video"],
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
                            }
                        ],
                        "per_second_minor_units": {},
                    }
                },
            }
        },
    }


def _setup_project(tmp_path: Path) -> tuple[Path, Path]:
    catalog_dir = tmp_path / "catalog"
    catalog_dir.mkdir()
    raw = _catalog_raw()
    (catalog_dir / "wfm1-test.json").write_text(json.dumps(raw), encoding="utf-8")
    digest = compute_catalog_digest(raw)

    root = tmp_path / "proj"
    (root / "records" / "scenes").mkdir(parents=True)
    (root / "records" / "shots").mkdir(parents=True)
    (root / "config").mkdir()
    (root / "approval").mkdir()

    write_model_json(
        root / "project.json",
        Project(project_id="proj-1", name="Test", created_at=T0),
    )
    write_model_json(
        root / "records" / "scenes" / "scene-1.json",
        Scene(
            scene_id="scene-1",
            project_id="proj-1",
            sequence=1,
            title="S",
            description="d",
            created_at=T0,
        ),
    )
    write_model_json(
        root / "records" / "shots" / "shot-1.json",
        Shot(
            shot_id="shot-1",
            scene_id="scene-1",
            sequence=1,
            description="d",
            prompt="a shot",
            duration_seconds=6.0,
            width=512,
            height=512,
            frame_rate=24.0,
            created_at=T0,
        ),
    )
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
                "catalog_id": "wfm1-test",
                "catalog_version": 1,
                "catalog_digest": digest,
            }
        ),
        encoding="utf-8",
    )
    # approve concept_lock bound to the shot record
    shot_digest = file_sha256(root / "records" / "shots" / "shot-1.json")
    (root / "approval" / "concept_lock.json").write_text(
        json.dumps(
            {
                "schema_version": 2,
                "stage": "concept_lock",
                "status": "approved",
                "approved_at": "2026-08-01T00:00:00+00:00",
                "approved_by": "owner",
                "approved_targets": [
                    {
                        "ref_kind": "file",
                        "ref": "records/shots/shot-1.json",
                        "version": 1,
                        "content_digest": shot_digest,
                    }
                ],
                "note": None,
            }
        ),
        encoding="utf-8",
    )
    return root, catalog_dir


def _patch_fakes(monkeypatch, provider: FakeProvider) -> None:
    def _registry():
        reg = ProviderRegistry()
        reg.register(provider.provider_id, lambda entry: provider)
        return reg

    monkeypatch.setattr(cli, "default_registry", _registry)
    monkeypatch.setattr(cli, "UrllibMediaFetcher", FakeFetcher)


def test_paid_submit_happy_path(tmp_path: Path, monkeypatch) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    _patch_fakes(monkeypatch, FakeProvider(provider_id="fake-a"))
    code = cli.main(
        [
            "--project-root",
            str(root),
            "--catalog-dir",
            str(catalog_dir),
            "paid-submit",
            "task-1",
            "--shot",
            "shot-1",
            "--operation-id",
            "op-1",
            "--model",
            "m1",
            "--resolution",
            "512p",
            "--duration",
            "6",
            "--first-frame-image",
            "https://example.com/frame.png",
        ]
    )
    assert code == 0
    cost_events = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert len(cost_events) == 1


def test_non_manual_provider_id_not_silently_manual(tmp_path: Path) -> None:
    root, catalog_dir = _setup_project(tmp_path)
    # a non-manual id absent from the locked catalog must fail closed,
    # never silently construct the manual provider.
    code = cli.main(
        [
            "--project-root",
            str(root),
            "--provider-id",
            "ghost",
            "--catalog-dir",
            str(catalog_dir),
            "status",
            "task-1",
        ]
    )
    assert code == 1


def test_m1_submit_path_rejects_paid_provider(tmp_path: Path) -> None:
    # the M1 driver path (submit) is manual-only, even for a valid catalog
    # provider — paid providers must go through paid-submit.
    root, catalog_dir = _setup_project(tmp_path)
    code = cli.main(
        [
            "--project-root",
            str(root),
            "--provider-id",
            "fake-a",
            "--catalog-dir",
            str(catalog_dir),
            "submit",
            "task-1",
        ]
    )
    assert code == 1


def test_poll_media_after_submit(tmp_path: Path, monkeypatch) -> None:
    # paid-submit commits; poll-media then re-fetches media without re-paying.
    root, catalog_dir = _setup_project(tmp_path)
    _patch_fakes(monkeypatch, FakeProvider(provider_id="fake-a"))
    common = [
        "--project-root",
        str(root),
        "--catalog-dir",
        str(catalog_dir),
    ]
    submit_tail = [
        "task-1",
        "--shot",
        "shot-1",
        "--operation-id",
        "op-1",
        "--model",
        "m1",
        "--resolution",
        "512p",
        "--duration",
        "6",
        "--first-frame-image",
        "https://example.com/frame.png",
    ]
    # poll-media rebuilds from the record: only ids + shot are supplied.
    resume_tail = ["task-1", "--shot", "shot-1", "--operation-id", "op-1"]
    assert cli.main([*common, "paid-submit", *submit_tail]) == 0
    assert cli.main([*common, "poll-media", *resume_tail]) == 0
    cost = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert len(cost) == 1  # poll-media did not re-book

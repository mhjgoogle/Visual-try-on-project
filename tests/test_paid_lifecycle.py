"""Tests for the paid→M1 lifecycle adapter and QCD cost rollup (TASK-021)."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import ai_video_workflow.cli as cli
from ai_video_workflow.app.contracts import staging_ref_for
from ai_video_workflow.app.paid_lifecycle import (
    PaidLifecycleError,
    build_lineage,
    committed_operation,
)
from ai_video_workflow.budget.ledger import build_ledger
from ai_video_workflow.budget.reservation import (
    hold_reservation,
    mark_needs_reconciliation,
    release_reservation,
)
from ai_video_workflow.config import compute_catalog_digest
from ai_video_workflow.config.project_config import FxConfig
from ai_video_workflow.digests import file_sha256
from ai_video_workflow.inspection.base import MediaProbeResult
from ai_video_workflow.models import Project, Scene, Shot
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.providers.registry import ProviderRegistry
from ai_video_workflow.qcd import aggregate_events
from ai_video_workflow.qcd.log import read_events
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


# --- the single authoritative path -----------------------------------------


def test_paid_to_formal_asset_single_path(tmp_path: Path, monkeypatch) -> None:
    root, catalog_dir = _seed_project(tmp_path)
    fake = FakeProvider(provider_id="fake-a")
    _use_fakes(monkeypatch, fake)

    assert _run(root, catalog_dir, "init-tasks") == 0
    assert _paid_submit(root, catalog_dir, TASK, "shot-1") == 0
    # settled: cost committed + trusted staged media
    assert (root / staging_ref_for(TASK)).is_file()

    assert _run(root, catalog_dir, "paid-integrate", TASK) == 0
    # the formal asset exists at the EXISTING asset path (no second path)
    assert (root / "records" / "video-assets" / f"asset-{TASK}-v1.json").is_file()
    assert (root / "assets" / "media" / "s01_sh001_v1.mp4").is_file()

    # idempotent: integrating again is a no-op, not a re-pay or overwrite
    submits_before = fake.calls["submit"]
    assert _run(root, catalog_dir, "paid-integrate", TASK) == 0
    assert fake.calls["submit"] == submits_before

    # stage the second (manual) shot so composition can close the loop
    staged2 = root / staging_ref_for("task-shot-2-1")
    staged2.parent.mkdir(parents=True, exist_ok=True)
    staged2.write_bytes(b"user-media-2")
    for step in ("prepare", "submit", "report-artifact", "collect"):
        assert _run(root, catalog_dir, step, "task-shot-2-1") == 0
    assert _run(root, catalog_dir, "validate", "task-shot-2-1") == 0
    assert _run(root, catalog_dir, "compose") == 0
    assert (root / "outputs" / "final_v1.mp4").is_file()


# --- money-safety guards -----------------------------------------------------


def test_integrate_requires_committed_reservation(tmp_path: Path, monkeypatch) -> None:
    root, catalog_dir = _seed_project(tmp_path)
    fake = FakeProvider(provider_id="fake-a")
    _use_fakes(monkeypatch, fake)
    assert _run(root, catalog_dir, "init-tasks") == 0

    # no paid operation at all
    with pytest.raises(PaidLifecycleError, match="no paid operations"):
        committed_operation(root, TASK)

    # a held operation must go through poll-media, never re-submit
    hold_reservation(
        root,
        project_id="proj-1",
        task_id=TASK,
        operation_id="op-1",
        shot_id="shot-1",
        provider_id="fake-a",
        model_id="m1",
        estimate_jpy=16,
        created_at=T0.isoformat(),
    )
    with pytest.raises(PaidLifecycleError, match="poll-media"):
        committed_operation(root, TASK)

    # needs_reconciliation is a human decision
    mark_needs_reconciliation(root, TASK, "op-1", note="ambiguous")
    with pytest.raises(PaidLifecycleError, match="manual reconciliation"):
        committed_operation(root, TASK)


def test_released_only_requires_new_task(tmp_path: Path, monkeypatch) -> None:
    root, catalog_dir = _seed_project(tmp_path)
    hold_reservation(
        root,
        project_id="proj-1",
        task_id=TASK,
        operation_id="op-1",
        shot_id="shot-1",
        provider_id="fake-a",
        model_id="m1",
        estimate_jpy=16,
        created_at=T0.isoformat(),
    )
    release_reservation(root, TASK, "op-1", resolved_at=T0.isoformat())
    with pytest.raises(PaidLifecycleError, match="create-redo-task"):
        committed_operation(root, TASK)


def test_tampered_media_refused(tmp_path: Path, monkeypatch) -> None:
    root, catalog_dir = _seed_project(tmp_path)
    fake = FakeProvider(provider_id="fake-a")
    _use_fakes(monkeypatch, fake)
    assert _run(root, catalog_dir, "init-tasks") == 0
    assert _paid_submit(root, catalog_dir, TASK, "shot-1") == 0
    # tamper with the staged media after the trusted download
    (root / staging_ref_for(TASK)).write_bytes(b"tampered")
    assert _run(root, catalog_dir, "paid-integrate", TASK) == 1  # refused


# --- QCD rollup (ADR-0020) ----------------------------------------------------


def test_cloud_cost_joins_official_aggregation(tmp_path: Path, monkeypatch) -> None:
    root, catalog_dir = _seed_project(tmp_path)
    fake = FakeProvider(provider_id="fake-a")
    _use_fakes(monkeypatch, fake)
    assert _run(root, catalog_dir, "init-tasks") == 0
    assert _paid_submit(root, catalog_dir, TASK, "shot-1") == 0
    assert _run(root, catalog_dir, "paid-integrate", TASK) == 0

    from ai_video_workflow.cli import _load_project_data

    data = _load_project_data(root)
    events = read_events(root)
    summary = aggregate_events(events, data=data)
    task_metrics = {t.task_id: t for t in summary.per_task}
    # the cloud authoritative cost (10 USD cents) is in the official rollup
    assert task_metrics[TASK].cost_by_currency.get("USD") == 10
    assert summary.per_project.cost_by_currency.get("USD") == 10

    # aggregation and the budget ledger agree on the same event stream
    fx = FxConfig(base_currency="JPY", rates={"USD": 160})
    ledger = build_ledger(events, fx)
    assert ledger.project_total_jpy == 16  # ceil(10c * 1.6)

    # replay: appending the identical cost event again is deduped
    from ai_video_workflow.qcd.events import build_provider_cost_recorded_event
    from ai_video_workflow.qcd.log import append_event

    cost_events = [e for e in events if e.event_type.value == "provider_cost_recorded"]
    dup = build_provider_cost_recorded_event(
        project_id="proj-1",
        shot_id="shot-1",
        task_id=TASK,
        provider_id=cost_events[0].payload["provider_id"],
        model_id=cost_events[0].payload["model_id"],
        operation_id=cost_events[0].payload["operation_id"],
        cost_minor_units=cost_events[0].payload["cost_minor_units"],
        currency=cost_events[0].payload["currency"],
        billing_source=cost_events[0].payload["billing_source"],
        occurred_at=cost_events[0].occurred_at,
        observed_amount=cost_events[0].payload["observed_amount"],
        observed_unit=cost_events[0].payload["observed_unit"],
    )
    append_event(root, dup)
    summary2 = aggregate_events(read_events(root), data=_load_project_data(root))
    assert summary2.per_project.cost_by_currency.get("USD") == 10  # exactly once


# --- lineage ------------------------------------------------------------------


def test_lineage_is_reconstructable_read_only(tmp_path: Path, monkeypatch) -> None:
    root, catalog_dir = _seed_project(tmp_path)
    fake = FakeProvider(provider_id="fake-a")
    _use_fakes(monkeypatch, fake)
    assert _run(root, catalog_dir, "init-tasks") == 0
    assert _paid_submit(root, catalog_dir, TASK, "shot-1") == 0
    assert _run(root, catalog_dir, "paid-integrate", TASK) == 0

    before = sorted(str(p) for p in root.rglob("*") if p.is_file())
    lineage = build_lineage(root, TASK)
    after = sorted(str(p) for p in root.rglob("*") if p.is_file())
    assert before == after  # pure projection: nothing written

    assert lineage["task"]["shot_id"] == "shot-1"
    ops = {o["operation_id"]: o for o in lineage["operations"]}
    assert ops["op-1"]["status"] == "committed"
    assert ops["op-1"]["external_task_ref"] == "ext-1"
    kinds = {e["event_type"] for e in lineage["events"]}
    assert "provider_cost_recorded" in kinds
    assert "asset_imported" in kinds
    # from the formal asset, the operation/provider/model chain is derivable
    assert ops["op-1"]["provider_id"] == "fake-a"
    assert ops["op-1"]["model_id"] == "m1"

    assert _run(root, catalog_dir, "lineage", TASK) == 0

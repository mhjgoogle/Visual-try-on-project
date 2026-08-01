"""Integration tests for the paid coordination chain (TASK-016)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from ai_video_workflow.app.paid_coordinator import (
    PaidGenerationCoordinator,
    PaidRequest,
)
from ai_video_workflow.budget.reservation import load_reservation
from ai_video_workflow.config import (
    parse_catalog,
    parse_project_config,
    write_project_config,
)
from ai_video_workflow.digests import file_sha256
from ai_video_workflow.models import Project, Shot
from ai_video_workflow.providers.registry import ProviderRegistry
from ai_video_workflow.qcd.events import QcdEventType
from ai_video_workflow.qcd.log import read_events
from tests.paid_fakes import FakeFetcher, FakeProvider

T0 = datetime(2026, 8, 1, 0, 0, 0, tzinfo=timezone.utc)


def _clock():
    return T0


def _catalog() -> object:
    def entry(price: int) -> dict:
        return {
            "display_name": "p",
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
                            "amount_minor_units": price,
                        }
                    ],
                    "per_second_minor_units": {},
                }
            },
        }

    return parse_catalog(
        {
            "schema_version": 1,
            "catalog_id": "test",
            "version": 1,
            "providers": {"fake-a": entry(10), "fake-b": entry(8)},
        }
    )


def _config_dict(**overrides) -> dict:
    raw = {
        "schema_version": 2,
        "default_provider": "fake-a",
        "fallback_provider": "fake-b",
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
    raw.update(overrides)
    return raw


def _project() -> Project:
    return Project(project_id="proj-1", name="Test", created_at=T0)


def _shot(shot_id="shot-1") -> Shot:
    return Shot(
        shot_id=shot_id,
        scene_id="scene-1",
        sequence=1,
        description="d",
        prompt="a cinematic shot",
        duration_seconds=6.0,
        width=512,
        height=512,
        frame_rate=24.0,
        created_at=T0,
    )


def _approve(project_root: Path, stage="concept_lock") -> None:
    target = project_root / "records" / "shots" / "shot-1.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('{"shot": 1}', encoding="utf-8")
    digest = file_sha256(target)
    marker = project_root / "approval" / f"{stage}.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    import json

    marker.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "stage": stage,
                "status": "approved",
                "approved_at": "2026-08-01T00:00:00+00:00",
                "approved_by": "owner",
                "approved_targets": [
                    {
                        "ref_kind": "file",
                        "ref": "records/shots/shot-1.json",
                        "version": 1,
                        "content_digest": digest,
                    }
                ],
                "note": None,
            }
        ),
        encoding="utf-8",
    )


def _setup(tmp_path: Path, *, providers, config_overrides=None, approve=True):
    project_root = tmp_path / "proj"
    project_root.mkdir()
    config = parse_project_config(_config_dict(**(config_overrides or {})))
    write_project_config(project_root, config)
    if approve:
        _approve(project_root)
    registry = ProviderRegistry()
    for provider in providers:
        registry.register(provider.provider_id, lambda entry, p=provider: p)
    fetcher = FakeFetcher()
    coordinator = PaidGenerationCoordinator(
        project_root=project_root,
        config=config,
        catalog=_catalog(),
        registry=registry,
        project=_project(),
        fetcher=fetcher,
        clock=_clock,
    )
    return project_root, coordinator, fetcher


def _request(**overrides) -> PaidRequest:
    base = dict(
        task_id="task-1",
        shot_id="shot-1",
        operation_id="op-1",
        stage="concept_lock",
        capability="image_to_video",
        model_id="m1",
        resolution="512p",
        duration_seconds=6,
    )
    base.update(overrides)
    return PaidRequest(**base)


# --- success + cost booking ----------------------------------------------


def test_success_books_cost_once(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, fetcher = _setup(tmp_path, providers=[fake])
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "success"
    # authoritative cost is the provider's reported amount in original
    # currency (0.10 USD -> 10 cents), not the JPY estimate (ADR-0008).
    assert outcome.cost_minor_units == 10
    assert outcome.currency == "USD"
    assert fetcher.fetched  # media fetched to staging
    events = read_events(root)
    cost_events = [
        e for e in events if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert len(cost_events) == 1
    assert cost_events[0].payload["cost_minor_units"] == 10
    assert cost_events[0].payload["currency"] == "USD"
    assert cost_events[0].payload["billing_source"] == "float_boundary_conversion"


def test_rerun_is_idempotent_no_double_charge(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, _ = _setup(tmp_path, providers=[fake])
    coord.submit_paid(_shot(), _request())
    calls_after_first = fake.total_calls
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "already_committed"
    assert fake.total_calls == calls_after_first  # no new provider calls
    cost_events = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert len(cost_events) == 1  # booked exactly once


# --- gates block provider calls ------------------------------------------


def test_approval_failure_zero_provider_calls(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, _ = _setup(tmp_path, providers=[fake], approve=False)
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "approval_blocked"
    assert fake.total_calls == 0
    assert load_reservation(root, "task-1", "op-1") is None


def test_budget_denial_zero_provider_calls(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, _ = _setup(
        tmp_path,
        providers=[fake],
        config_overrides={
            "budgets_jpy": {
                "episode_soft": 1,
                "episode_hard": 5,
                "monthly_hard": 5000,
                "per_shot": 5,
            }
        },
    )
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "budget_denied"
    assert outcome.stop_scope == "episode"
    assert fake.total_calls == 0


def test_stale_approval_blocks(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, _ = _setup(tmp_path, providers=[fake])
    # edit the approved target after approval
    (root / "records" / "shots" / "shot-1.json").write_text("changed", encoding="utf-8")
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "approval_blocked"
    assert fake.total_calls == 0


# --- crash safety ---------------------------------------------------------


def test_held_reservation_is_not_resubmitted(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, _ = _setup(tmp_path, providers=[fake])
    # simulate a crash: a hold exists but was never settled
    from ai_video_workflow.budget.reservation import hold_reservation

    hold_reservation(
        root,
        project_id="proj-1",
        task_id="task-1",
        operation_id="op-1",
        shot_id="shot-1",
        provider_id="fake-a",
        model_id="m1",
        estimate_jpy=16,
        created_at=T0.isoformat(),
    )
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "needs_reconciliation"
    assert fake.total_calls == 0  # never re-submitted
    assert load_reservation(root, "task-1", "op-1").status == "needs_reconciliation"


def test_ambiguous_after_submit_needs_reconciliation(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a", behavior="ambiguous_after_submit")
    root, coord, _ = _setup(tmp_path, providers=[fake])
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "needs_reconciliation"
    assert load_reservation(root, "task-1", "op-1").status == "needs_reconciliation"
    # no cost booked for an ambiguous result
    cost_events = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert cost_events == []


# --- fallback -------------------------------------------------------------


def test_technical_failure_falls_back_and_rebudgets(tmp_path: Path) -> None:
    primary = FakeProvider(provider_id="fake-a", behavior="fail_before_submit")
    fallback = FakeProvider(provider_id="fake-b")
    root, coord, _ = _setup(tmp_path, providers=[primary, fallback])
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "success"
    assert outcome.fell_back is True
    assert outcome.provider_id == "fake-b"
    # primary reservation released, fallback committed
    assert load_reservation(root, "task-1", "op-1").status == "released"
    assert load_reservation(root, "task-1", "op-1:fallback").status == "committed"
    # fallback cost (8c) booked
    cost_events = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert len(cost_events) == 1
    # fallback provider's reported cost (0.10 USD -> 10 cents), authoritative
    assert cost_events[0].payload["cost_minor_units"] == 10
    assert cost_events[0].payload["provider_id"] == "fake-b"


def test_budget_denial_does_not_fall_back(tmp_path: Path) -> None:
    primary = FakeProvider(provider_id="fake-a")
    fallback = FakeProvider(provider_id="fake-b")
    root, coord, _ = _setup(
        tmp_path,
        providers=[primary, fallback],
        config_overrides={
            "budgets_jpy": {
                "episode_soft": 1,
                "episode_hard": 5,
                "monthly_hard": 5000,
                "per_shot": 5,
            }
        },
    )
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "budget_denied"
    assert primary.total_calls == 0
    assert fallback.total_calls == 0  # never tried the cheaper fallback


# --- shot-level provider switch ------------------------------------------


def test_shot_level_provider_override(tmp_path: Path) -> None:
    fake_a = FakeProvider(provider_id="fake-a")
    fake_b = FakeProvider(provider_id="fake-b")
    root, coord, _ = _setup(
        tmp_path,
        providers=[fake_a, fake_b],
        config_overrides={"shot_overrides": {"shot-1": "fake-b"}},
    )
    outcome = coord.submit_paid(_shot("shot-1"), _request())
    assert outcome.kind == "success"
    assert outcome.provider_id == "fake-b"
    assert fake_b.total_calls > 0
    assert fake_a.total_calls == 0

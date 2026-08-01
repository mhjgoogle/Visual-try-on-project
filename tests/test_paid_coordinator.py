"""Integration tests for the paid coordination chain (TASK-016)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from ai_video_workflow.app.paid_coordinator import (
    PaidGenerationCoordinator,
    PaidRequest,
)
from ai_video_workflow.budget.reservation import (
    hold_reservation,
    list_reservations,
    load_reservation,
    record_external_task_ref,
)
from ai_video_workflow.config import (
    parse_catalog,
    parse_project_config,
    write_project_config,
)
from ai_video_workflow.digests import file_sha256
from ai_video_workflow.models import Project, Shot
from ai_video_workflow.providers.registry import (
    ProviderRegistry,
    ProviderRegistryError,
)
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
        sleeper=lambda _seconds: None,
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
        first_frame_image="https://example.com/frame.png",
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


# ============================================================================
# Money-safety correction batch (TASK-015/016 fix)
# ============================================================================


def test_submit_timeout_after_dispatch_needs_reconciliation(tmp_path: Path) -> None:
    # a submit-phase timeout may have been received/charged -> ambiguous,
    # never released, never fallback, never re-submitted.
    primary = FakeProvider(provider_id="fake-a", behavior="timeout_after_dispatch")
    fallback = FakeProvider(provider_id="fake-b")
    root, coord, _ = _setup(tmp_path, providers=[primary, fallback])
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "needs_reconciliation"
    assert outcome.fell_back is False
    assert fallback.total_calls == 0  # no fallback on ambiguous
    assert load_reservation(root, "task-1", "op-1").status == "needs_reconciliation"
    cost = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert cost == []


def test_generic_network_after_dispatch_is_ambiguous(tmp_path: Path) -> None:
    primary = FakeProvider(provider_id="fake-a", behavior="network_after_dispatch")
    fallback = FakeProvider(provider_id="fake-b")
    root, coord, _ = _setup(tmp_path, providers=[primary, fallback])
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "needs_reconciliation"
    assert fallback.total_calls == 0


def test_undeclared_vendor_failure_needs_reconciliation(tmp_path: Path) -> None:
    primary = FakeProvider(provider_id="fake-a", behavior="fail_vendor")
    fallback = FakeProvider(provider_id="fake-b")
    root, coord, _ = _setup(tmp_path, providers=[primary, fallback])
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "needs_reconciliation"
    assert fallback.total_calls == 0
    assert load_reservation(root, "task-1", "op-1").status == "needs_reconciliation"


def test_declared_no_charge_releases_and_falls_back(tmp_path: Path) -> None:
    primary = FakeProvider(provider_id="fake-a", behavior="vendor_no_charge")
    fallback = FakeProvider(provider_id="fake-b")
    root, coord, _ = _setup(tmp_path, providers=[primary, fallback])
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "success"
    assert outcome.fell_back is True
    assert outcome.provider_id == "fake-b"
    assert load_reservation(root, "task-1", "op-1").status == "released"
    assert load_reservation(root, "task-1", "op-1:fallback").status == "committed"


def test_two_operations_near_cap_only_one_reserves(tmp_path: Path) -> None:
    # episode_hard=20, each estimate 16: op-1 fits, op-2 (seeing op-1's hold) denied.
    fake = FakeProvider(provider_id="fake-a", behavior="ambiguous_after_submit")
    root, coord, _ = _setup(
        tmp_path,
        providers=[fake],
        config_overrides={
            "budgets_jpy": {
                "episode_soft": 1,
                "episode_hard": 20,
                "monthly_hard": 5000,
                "per_shot": 20,
            }
        },
    )
    # op-1 holds (ambiguous keeps the hold as needs_reconciliation -> outstanding)
    o1 = coord.submit_paid(_shot(), _request(operation_id="op-1"))
    assert o1.kind == "needs_reconciliation"
    # op-2 must be denied: 0 + outstanding hold(16) + estimate(16) = 32 > 20
    o2 = coord.submit_paid(_shot(), _request(operation_id="op-2"))
    assert o2.kind == "budget_denied"
    held = [
        r
        for r in list_reservations(root)
        if r.status in ("held", "needs_reconciliation")
    ]
    assert len(held) == 1


def test_monthly_budget_includes_other_project_hold(tmp_path: Path) -> None:
    # project-a has an outstanding hold near the monthly cap; project-b's
    # monthly check must see it and deny.
    account = tmp_path
    a = account / "project-a"
    a.mkdir()
    write_project_config(a, parse_project_config(_config_dict()))
    hold_reservation(
        a,
        project_id="proj-a",
        task_id="t",
        operation_id="op",
        shot_id="s",
        provider_id="fake-a",
        model_id="m1",
        estimate_jpy=4990,
        created_at=T0.isoformat(),
    )
    b = account / "project-b"
    b.mkdir()
    config = parse_project_config(_config_dict())
    write_project_config(b, config)
    _approve(b)
    fake = FakeProvider(provider_id="fake-a")
    registry = ProviderRegistry()
    registry.register("fake-a", lambda entry: fake)
    coord = PaidGenerationCoordinator(
        project_root=b,
        config=config,
        catalog=_catalog(),
        registry=registry,
        project=Project(project_id="proj-b", name="B", created_at=T0),
        fetcher=FakeFetcher(),
        clock=_clock,
        account_root=account,
    )
    outcome = coord.submit_paid(_shot(), _request())
    # monthly = other project's 4990 hold + estimate 16 > 5000
    assert outcome.kind == "budget_denied"
    assert outcome.stop_scope == "monthly"
    assert fake.total_calls == 0


def test_same_operation_stays_idempotent(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, _ = _setup(tmp_path, providers=[fake])
    coord.submit_paid(_shot(), _request())
    coord.submit_paid(_shot(), _request())  # same op
    assert len(list_reservations(root)) == 1


def test_quote_payload_duration_mismatch_fails_closed(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, _ = _setup(tmp_path, providers=[fake])
    # request duration (10) diverges from the shot's duration (6)
    outcome = coord.submit_paid(_shot(), _request(duration_seconds=10))
    assert outcome.kind == "spec_invalid"
    assert fake.total_calls == 0
    assert load_reservation(root, "task-1", "op-1") is None


def test_provider_build_failure_leaves_no_hold(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    root.mkdir()
    config = parse_project_config(_config_dict())
    write_project_config(root, config)
    _approve(root)
    registry = ProviderRegistry()

    def _boom(entry):
        raise ProviderRegistryError("cannot build provider")

    registry.register("fake-a", _boom)
    coord = PaidGenerationCoordinator(
        project_root=root,
        config=config,
        catalog=_catalog(),
        registry=registry,
        project=_project(),
        fetcher=FakeFetcher(),
        clock=_clock,
    )
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "provider_unavailable"
    assert load_reservation(root, "task-1", "op-1") is None  # no leaked hold


def test_credential_secret_never_reaches_files_or_outcome(
    tmp_path: Path, monkeypatch
) -> None:
    from ai_video_workflow.providers.cloud_minimax import (
        MinimaxPoll,
        MinimaxTransport,
        MinimaxVideoProvider,
    )

    secret = "sk-leak-canary-123"
    monkeypatch.setenv("WFM1_MINIMAX_API_KEY", secret)

    class _Stub(MinimaxTransport):
        def submit(self, *, api_key, payload, idempotency_key=None):
            assert api_key == secret  # received, but must not be persisted
            return "ext-1"

        def poll(self, *, api_key, external_task_ref):
            return MinimaxPoll(
                state="succeeded",
                artifact_url="https://vendor.example/out.mp4",
                cost_amount=0.10,
                cost_unit="USD",
            )

    root = tmp_path / "proj"
    root.mkdir()
    config = parse_project_config(
        _config_dict(default_provider="minimax", fallback_provider=None)
    )
    write_project_config(root, config)
    _approve(root)
    catalog = parse_catalog(
        {
            "schema_version": 1,
            "catalog_id": "test",
            "version": 1,
            "providers": {
                "minimax": {
                    "display_name": "M",
                    "capabilities": ["image_to_video"],
                    "credential_env_vars": ["WFM1_MINIMAX_API_KEY"],
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
    )
    registry = ProviderRegistry()
    registry.register(
        "minimax",
        lambda entry: MinimaxVideoProvider(
            transport=_Stub(), credential_env_var="WFM1_MINIMAX_API_KEY"
        ),
    )
    coord = PaidGenerationCoordinator(
        project_root=root,
        config=config,
        catalog=catalog,
        registry=registry,
        project=_project(),
        fetcher=FakeFetcher(),
        clock=_clock,
    )
    outcome = coord.submit_paid(_shot(), _request(model_id="m1"))
    assert outcome.kind == "success"
    assert secret not in repr(outcome)
    # no reservation file, QCD log line, or staged file contains the secret
    for path in root.rglob("*"):
        if path.is_file():
            assert secret not in path.read_text(encoding="utf-8", errors="ignore")


# ============================================================================
# TASK-017: catalog fixed-price booking, external task id, resume_media
# ============================================================================


def test_catalog_fixed_price_booking(tmp_path: Path) -> None:
    # a provider that bills at the fixed catalog price and returns no cost
    # observation -> the coordinator books the locked catalog price.
    fake = FakeProvider(
        provider_id="fake-a", cost_amount=None, bills_at_catalog_price=True
    )
    root, coord, _ = _setup(tmp_path, providers=[fake])
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "success"
    assert outcome.cost_minor_units == 10  # catalog fixed price (USD cents)
    assert outcome.currency == "USD"
    cost = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert len(cost) == 1
    assert cost[0].payload["billing_source"] == "catalog_fixed_price"


def test_no_cost_and_not_fixed_price_needs_reconciliation(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a", cost_amount=None)  # no billing signal
    root, coord, _ = _setup(tmp_path, providers=[fake])
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "needs_reconciliation"


def test_external_task_ref_persisted_on_success(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, _ = _setup(tmp_path, providers=[fake])
    coord.submit_paid(_shot(), _request())
    assert load_reservation(root, "task-1", "op-1").external_task_ref == "ext-1"


def test_resume_media_resumes_held_operation(tmp_path: Path) -> None:
    # simulate: submit succeeded (ref persisted) but process crashed before
    # collect. resume_media polls/collects and settles without re-submitting.
    fake = FakeProvider(provider_id="fake-a")
    root, coord, _ = _setup(tmp_path, providers=[fake])
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
    record_external_task_ref(root, "task-1", "op-1", "ext-1")
    outcome = coord.resume_media(_shot(), "task-1", "op-1")
    assert outcome.kind == "success"
    assert fake.calls["submit"] == 0  # never re-submitted
    assert load_reservation(root, "task-1", "op-1").status == "committed"
    cost = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert len(cost) == 1


def test_resume_media_committed_only_refetches(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, fetcher = _setup(tmp_path, providers=[fake])
    coord.submit_paid(_shot(), _request())  # committed, 1 cost event
    outcome = coord.resume_media(_shot(), "task-1", "op-1")
    assert outcome.kind == "success"
    cost = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert len(cost) == 1  # no second booking
    assert fake.calls["submit"] == 1  # from the original only


def test_resume_media_without_external_ref_needs_reconciliation(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, _ = _setup(tmp_path, providers=[fake])
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
    outcome = coord.resume_media(_shot(), "task-1", "op-1")
    assert outcome.kind == "needs_reconciliation"
    assert fake.total_calls == 0


# ============================================================================
# TASK-017 review fixes: request-rejected, first-frame validation
# ============================================================================


def test_request_rejected_does_not_fall_back(tmp_path: Path) -> None:
    primary = FakeProvider(provider_id="fake-a", behavior="request_rejected")
    fallback = FakeProvider(provider_id="fake-b")
    root, coord, _ = _setup(tmp_path, providers=[primary, fallback])
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "request_rejected"
    assert fallback.total_calls == 0  # invalid request must not try fallback
    assert load_reservation(root, "task-1", "op-1").status == "released"


def test_i2v_without_first_frame_is_spec_invalid(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, _ = _setup(tmp_path, providers=[fake])
    outcome = coord.submit_paid(
        _shot(), _request(capability="image_to_video", first_frame_image=None)
    )
    assert outcome.kind == "spec_invalid"
    assert fake.total_calls == 0
    assert load_reservation(root, "task-1", "op-1") is None


def test_first_frame_local_path_is_spec_invalid(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, _ = _setup(tmp_path, providers=[fake])
    outcome = coord.submit_paid(_shot(), _request(first_frame_image="/etc/passwd"))
    assert outcome.kind == "spec_invalid"
    assert fake.total_calls == 0


# ============================================================================
# TASK-017 second review batch: v2 compat, escape-path, media validity
# ============================================================================


def _write_v2_reservation(root: Path, *, status="held", external_ref="ext-1"):
    import json as _json

    path = root / "budget" / "reservations" / "task-1" / "op-1.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        _json.dumps(
            {
                "schema_version": 2,
                "reservation_id": "resv:task-1:op-1",
                "project_id": "proj-1",
                "task_id": "task-1",
                "operation_id": "op-1",
                "shot_id": "shot-1",
                "provider_id": "fake-a",
                "model_id": "m1",
                "estimate_jpy": 16,
                "status": status,
                "created_at": T0.isoformat(),
                "resolved_at": None,
                "note": None,
                "external_task_ref": external_ref,
            }
        ),
        encoding="utf-8",
    )


def test_v2_reservation_is_readable_and_scannable(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, _ = _setup(tmp_path, providers=[fake])
    _write_v2_reservation(root)
    loaded = load_reservation(root, "task-1", "op-1")
    assert loaded is not None
    assert loaded.schema_version == 2
    assert loaded.external_task_ref == "ext-1"
    assert loaded.quote_minor_units is None  # v2 had no stored quote
    # budget scans over mixed-version records must not fail
    assert len(list_reservations(root)) == 1


def test_v2_resume_recovers_media_but_never_auto_books(tmp_path: Path) -> None:
    # an old v2 hold has an external task id but no stored quote: media is
    # recovered, but booking requires a human (no automatic fixed-price).
    fake = FakeProvider(provider_id="fake-a", cost_amount=None)
    root, coord, fetcher = _setup(tmp_path, providers=[fake])
    _write_v2_reservation(root)
    outcome = coord.resume_media(_shot(), "task-1", "op-1")
    assert outcome.kind == "needs_reconciliation"
    assert fake.calls["submit"] == 0  # never re-submitted
    assert fetcher.fetched  # media WAS recovered
    cost = [
        e
        for e in read_events(root)
        if e.event_type is QcdEventType.PROVIDER_COST_RECORDED
    ]
    assert cost == []  # nothing auto-booked
    # the rewrite upgraded the record to the current schema
    assert load_reservation(root, "task-1", "op-1").schema_version == 3


def test_oversized_data_url_is_spec_invalid_before_hold(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, _ = _setup(tmp_path, providers=[fake])
    huge = "data:image/png;base64," + "A" * (9 * 1024 * 1024)
    outcome = coord.submit_paid(_shot(), _request(first_frame_image=huge))
    assert outcome.kind == "spec_invalid"
    assert fake.total_calls == 0
    assert load_reservation(root, "task-1", "op-1") is None


def test_provider_request_validation_error_releases_hold(tmp_path: Path) -> None:
    # a provider-boundary InvalidProviderRequestError at submit must not
    # escape and leave a held reservation: it becomes request_rejected
    # (no charge, no fallback) and the hold is released.
    primary = FakeProvider(provider_id="fake-a", behavior="invalid_request_at_submit")
    fallback = FakeProvider(provider_id="fake-b")
    root, coord, _ = _setup(tmp_path, providers=[primary, fallback])
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "request_rejected"
    assert fallback.total_calls == 0
    assert load_reservation(root, "task-1", "op-1").status == "released"


def test_preexisting_unverified_media_is_pending_not_success(tmp_path: Path) -> None:
    # an arbitrary pre-existing staged file is neither trusted nor
    # overwritten: the outcome is success_media_pending.
    fake = FakeProvider(provider_id="fake-a")
    root, coord, fetcher = _setup(tmp_path, providers=[fake])
    staged = root / "staging" / "shots" / "task-1.mp4"
    staged.parent.mkdir(parents=True, exist_ok=True)
    staged.write_bytes(b"who wrote this?")
    outcome = coord.submit_paid(_shot(), _request())
    assert outcome.kind == "success_media_pending"
    assert staged.read_bytes() == b"who wrote this?"  # untouched
    assert fetcher.fetched == []  # no overwrite attempt


def test_receipted_media_is_trusted_idempotent(tmp_path: Path) -> None:
    fake = FakeProvider(provider_id="fake-a")
    root, coord, fetcher = _setup(tmp_path, providers=[fake])
    assert coord.submit_paid(_shot(), _request()).kind == "success"
    fetch_count = len(fetcher.fetched)
    # resume: receipt matches, so no re-download and still success
    outcome = coord.resume_media(_shot(), "task-1", "op-1")
    assert outcome.kind == "success"
    assert len(fetcher.fetched) == fetch_count

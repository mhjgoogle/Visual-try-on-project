"""Tests for the MiniMax cloud provider adapter (TASK-016)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ai_video_workflow.providers.cloud_errors import (
    ProviderAuthError,
    ProviderResponseError,
    ProviderVendorError,
)
from ai_video_workflow.providers.cloud_minimax import (
    MinimaxPoll,
    MinimaxTransport,
    MinimaxVideoProvider,
)
from ai_video_workflow.providers.models import (
    ArtifactLocation,
    ProviderRequest,
    ProviderStatus,
)

T0 = datetime(2026, 8, 1, tzinfo=timezone.utc)
ENV = "WFM1_MINIMAX_API_KEY"
SECRET = "sk-super-secret-value"


class StubTransport(MinimaxTransport):
    def __init__(self, *, poll_states, submit_ref="ext-1"):
        self._poll_states = list(poll_states)
        self._submit_ref = submit_ref
        self.received_api_key = None

    def submit(self, *, api_key, payload, idempotency_key=None):
        self.received_api_key = api_key
        return self._submit_ref

    def poll(self, *, api_key, external_task_ref):
        return self._poll_states.pop(0)


def _provider(transport) -> MinimaxVideoProvider:
    return MinimaxVideoProvider(transport=transport, credential_env_var=ENV)


def _request() -> ProviderRequest:
    return ProviderRequest(
        provider_id="minimax",
        task_id="task-1",
        shot_id="shot-1",
        prompt="a shot",
        duration_seconds=6.0,
        width=512,
        height=512,
        frame_rate=24.0,
        staging_ref="staging/shots/task-1.mp4",
    )


def _run_lifecycle(provider, request):
    r0 = provider.prepare(request, observed_at=T0)
    r1 = provider.submit(request, r0, observed_at=T0)
    current = r1
    while current.status is ProviderStatus.PROCESSING:
        current = provider.poll(request, current, observed_at=T0)
    return provider.collect(
        request, current, artifact=current.artifact, observed_at=T0, completed_at=T0
    )


def test_full_success_lifecycle(monkeypatch) -> None:
    monkeypatch.setenv(ENV, SECRET)
    transport = StubTransport(
        poll_states=[
            MinimaxPoll(state="processing"),
            MinimaxPoll(
                state="succeeded",
                artifact_url="https://vendor.example/out.mp4",
                cost_amount=0.10,
                cost_unit="USD",
            ),
        ]
    )
    final = _run_lifecycle(_provider(transport), _request())
    assert final.status is ProviderStatus.SUCCEEDED
    assert final.artifact.location is ArtifactLocation.EXTERNAL
    assert final.artifact.reference == "https://vendor.example/out.mp4"
    assert final.cost_observation.amount == 0.10
    assert final.cost_observation.unit == "USD"
    assert transport.received_api_key == SECRET


def test_missing_credential_names_var_not_value(monkeypatch) -> None:
    monkeypatch.delenv(ENV, raising=False)
    provider = _provider(StubTransport(poll_states=[]))
    with pytest.raises(ProviderAuthError) as exc:
        provider.submit(
            _request(),
            provider.prepare(_request(), observed_at=T0),
            observed_at=T0,
        )
    assert ENV in str(exc.value)
    assert SECRET not in str(exc.value)


def test_credential_value_not_leaked_in_result(monkeypatch) -> None:
    monkeypatch.setenv(ENV, SECRET)
    transport = StubTransport(
        poll_states=[
            MinimaxPoll(
                state="succeeded",
                artifact_url="https://vendor.example/out.mp4",
                cost_amount=0.10,
                cost_unit="USD",
            )
        ]
    )
    final = _run_lifecycle(_provider(transport), _request())
    assert SECRET not in repr(final)
    assert SECRET not in str(
        final.to_json_dict() if hasattr(final, "to_json_dict") else final
    )


def test_vendor_failure_is_typed(monkeypatch) -> None:
    monkeypatch.setenv(ENV, SECRET)
    provider = _provider(
        StubTransport(poll_states=[MinimaxPoll(state="failed", error="bad prompt")])
    )
    request = _request()
    r1 = provider.submit(
        request, provider.prepare(request, observed_at=T0), observed_at=T0
    )
    with pytest.raises(ProviderVendorError, match="bad prompt"):
        provider.poll(request, r1, observed_at=T0)


def test_empty_submit_reference_rejected(monkeypatch) -> None:
    monkeypatch.setenv(ENV, SECRET)
    provider = _provider(StubTransport(poll_states=[], submit_ref=""))
    request = _request()
    with pytest.raises(ProviderResponseError, match="no task reference"):
        provider.submit(
            request, provider.prepare(request, observed_at=T0), observed_at=T0
        )


def test_succeeded_without_artifact_rejected(monkeypatch) -> None:
    monkeypatch.setenv(ENV, SECRET)
    provider = _provider(
        StubTransport(poll_states=[MinimaxPoll(state="succeeded", artifact_url=None)])
    )
    request = _request()
    r1 = provider.submit(
        request, provider.prepare(request, observed_at=T0), observed_at=T0
    )
    with pytest.raises(ProviderResponseError, match="without an artifact"):
        provider.poll(request, r1, observed_at=T0)


def test_bills_at_catalog_price_is_true() -> None:
    # MiniMax returns no cost field, so the coordinator books the catalog
    # fixed price (ADR-0009).
    provider = _provider(StubTransport(poll_states=[]))
    assert provider.bills_at_catalog_price is True


def test_local_path_first_frame_rejected(monkeypatch) -> None:
    from ai_video_workflow.providers.errors import InvalidProviderRequestError

    monkeypatch.setenv(ENV, SECRET)
    provider = _provider(StubTransport(poll_states=[]))
    request = ProviderRequest(
        provider_id="minimax",
        task_id="task-1",
        shot_id="shot-1",
        prompt="a shot",
        duration_seconds=6.0,
        width=768,
        height=768,
        frame_rate=24.0,
        staging_ref="staging/shots/task-1.mp4",
        provider_parameters={"first_frame_image": "/etc/passwd"},
    )
    with pytest.raises(InvalidProviderRequestError, match="local paths"):
        provider.submit(
            request, provider.prepare(request, observed_at=T0), observed_at=T0
        )

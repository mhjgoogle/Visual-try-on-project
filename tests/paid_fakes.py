"""Fake paid provider + fetcher for TASK-016 coordinator tests."""

from __future__ import annotations

from collections import Counter
from datetime import datetime
from pathlib import Path

from ai_video_workflow.providers.base import VideoProvider
from ai_video_workflow.providers.cloud_errors import (
    ProviderNetworkError,
    ProviderNoChargeFailureError,
    ProviderNotDispatchedError,
    ProviderRequestRejectedError,
    ProviderTimeoutError,
    ProviderVendorError,
)
from ai_video_workflow.providers.models import (
    ArtifactLocation,
    ArtifactOrigin,
    ArtifactReference,
    ProviderCostObservation,
    ProviderRequest,
    ProviderResult,
    ProviderStatus,
)


class FakeProvider(VideoProvider):
    """A configurable, call-counting fake cloud provider."""

    __slots__ = (
        "_pid",
        "calls",
        "behavior",
        "_cost_amount",
        "_cost_unit",
        "_bills_at_catalog_price",
    )

    def __init__(
        self,
        *,
        provider_id: str,
        behavior: str = "succeed",
        cost_amount: float | None = 0.10,
        cost_unit: str = "USD",
        bills_at_catalog_price: bool = False,
    ) -> None:
        self._pid = provider_id
        self.calls: Counter = Counter()
        self.behavior = behavior
        self._cost_amount = cost_amount
        self._cost_unit = cost_unit
        self._bills_at_catalog_price = bills_at_catalog_price

    @property
    def provider_id(self) -> str:
        return self._pid

    @property
    def bills_at_catalog_price(self) -> bool:
        return self._bills_at_catalog_price

    @property
    def total_calls(self) -> int:
        return sum(self.calls.values())

    def prepare(self, request: ProviderRequest, *, observed_at: datetime):
        self.calls["prepare"] += 1
        return ProviderResult(
            provider_id=self._pid,
            task_id=request.task_id,
            shot_id=request.shot_id,
            status=ProviderStatus.NOT_SUBMITTED,
            observed_at=observed_at,
        )

    def submit(self, request, prepared, *, observed_at: datetime):
        self.calls["submit"] += 1
        if self.behavior == "fail_before_submit":
            # provably not dispatched -> technical (safe to release + fallback)
            raise ProviderNotDispatchedError("connection refused")
        if self.behavior == "request_rejected":
            # invalid params / no balance -> no charge, but must not fall back
            raise ProviderRequestRejectedError("invalid parameters")
        if self.behavior == "invalid_request_at_submit":
            # provider-boundary request validation (client-side, pre-dispatch)
            from ai_video_workflow.providers.errors import (
                InvalidProviderRequestError,
            )

            raise InvalidProviderRequestError("first_frame_image: data URL too large")
        if self.behavior == "timeout_after_dispatch":
            # request may have been received -> ambiguous
            raise ProviderTimeoutError("submit timed out; delivery unknown")
        if self.behavior == "network_after_dispatch":
            # generic network error mid-submit -> ambiguous (unknown side-effect)
            raise ProviderNetworkError("connection reset")
        return ProviderResult(
            provider_id=self._pid,
            task_id=request.task_id,
            shot_id=request.shot_id,
            status=ProviderStatus.PROCESSING,
            observed_at=observed_at,
            external_task_ref="ext-1",
        )

    def poll(self, request, current, *, observed_at: datetime, reported_artifact=None):
        self.calls["poll"] += 1
        if self.behavior == "fail_vendor":
            # undeclared vendor failure -> charge unknown -> ambiguous
            raise ProviderVendorError("generation failed vendor-side")
        if self.behavior == "vendor_no_charge":
            # provider asserts no charge -> technical (release + fallback)
            raise ProviderNoChargeFailureError("rejected before billing")
        if self.behavior == "ambiguous_after_submit":
            raise ProviderNetworkError("network dropped mid-poll")
        cost = None
        if self._cost_amount is not None:
            cost = ProviderCostObservation(
                amount=self._cost_amount, unit=self._cost_unit
            )
        return ProviderResult(
            provider_id=self._pid,
            task_id=request.task_id,
            shot_id=request.shot_id,
            status=ProviderStatus.ARTIFACT_AVAILABLE,
            observed_at=observed_at,
            external_task_ref="ext-1",
            artifact=ArtifactReference(
                reference="https://fake.example/artifact.mp4",
                origin=ArtifactOrigin.PROVIDER,
                location=ArtifactLocation.EXTERNAL,
            ),
            cost_observation=cost,
        )

    def collect(
        self,
        request,
        current,
        *,
        artifact=None,
        observed_at: datetime,
        completed_at=None,
    ):
        self.calls["collect"] += 1
        return ProviderResult(
            provider_id=self._pid,
            task_id=request.task_id,
            shot_id=request.shot_id,
            status=ProviderStatus.SUCCEEDED,
            observed_at=observed_at,
            external_task_ref="ext-1",
            artifact=artifact or current.artifact,
            completed_at=completed_at or observed_at,
            cost_observation=current.cost_observation,
        )


class FakeFetcher:
    """Records fetches and writes a placeholder file."""

    def __init__(self) -> None:
        self.fetched: list[tuple[str, Path]] = []

    def fetch(self, reference: str, dest: Path) -> None:
        self.fetched.append((reference, dest))
        dest.write_bytes(b"fake-media")

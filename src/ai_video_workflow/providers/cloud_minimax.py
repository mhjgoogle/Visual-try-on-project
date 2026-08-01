"""First cloud video provider: MiniMax / Hailuo adapter (TASK-016).

Implements the frozen ``VideoProvider`` contract for a real paid
image-to-video API. The provider stays **stateless and filesystem-free**
(base contract): its ``collect`` returns an *external* artifact reference
(the download URL), and the application layer fetches it — the provider
never writes the media itself.

All network I/O goes through an injected ``MinimaxTransport`` so tests
stub every request; the real HTTP transport is opt-in and refuses to run
until its endpoint is configured (vendor endpoints are deferred to the
vendor decision, ADR-0006 §5). Credentials are read only from the
environment variable named in the catalog and never appear in a field,
log, or error message.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime

from ai_video_workflow.providers.base import VideoProvider
from ai_video_workflow.providers.cloud_errors import (
    ProviderAuthError,
    ProviderNetworkError,
    ProviderResponseError,
    ProviderVendorError,
)
from ai_video_workflow.providers.errors import (
    InvalidProviderStateError,
    MissingArtifactReferenceError,
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

MINIMAX_PROVIDER_ID = "minimax"
MINIMAX_ENDPOINT_ENV = "WFM1_MINIMAX_API_BASE"


@dataclass(frozen=True, slots=True)
class MinimaxPoll:
    """Normalized transport poll outcome (vendor-neutral shape)."""

    state: str  # "processing" | "succeeded" | "failed"
    artifact_url: str | None = None
    cost_amount: float | None = None
    cost_unit: str | None = None
    error: str | None = None


class MinimaxTransport(ABC):
    """Network port for the MiniMax API (fully stubbable)."""

    @abstractmethod
    def submit(self, *, api_key: str, payload: dict) -> str:
        """Submit a generation job; return the external task reference."""

    @abstractmethod
    def poll(self, *, api_key: str, external_task_ref: str) -> MinimaxPoll:
        """Query a job's status."""


class MinimaxVideoProvider(VideoProvider):
    """MiniMax / Hailuo image-to-video provider."""

    __slots__ = ("_provider_id", "_credential_env_var", "_transport")

    def __init__(
        self,
        *,
        transport: MinimaxTransport,
        credential_env_var: str,
        provider_id: str = MINIMAX_PROVIDER_ID,
    ) -> None:
        self._provider_id = provider_id
        self._credential_env_var = credential_env_var
        self._transport = transport

    @property
    def provider_id(self) -> str:
        return self._provider_id

    def prepare(
        self, request: ProviderRequest, *, observed_at: datetime
    ) -> ProviderResult:
        result = ProviderResult(
            provider_id=self._provider_id,
            task_id=request.task_id,
            shot_id=request.shot_id,
            status=ProviderStatus.NOT_SUBMITTED,
            observed_at=observed_at,
        )
        self._validate_alignment(request, result)
        return result

    def submit(
        self,
        request: ProviderRequest,
        prepared: ProviderResult,
        *,
        observed_at: datetime,
    ) -> ProviderResult:
        self._validate_alignment(request, prepared)
        external_ref = self._transport.submit(
            api_key=self._api_key(), payload=self._payload(request)
        )
        if not isinstance(external_ref, str) or not external_ref:
            raise ProviderResponseError("submit: transport returned no task reference")
        result = ProviderResult(
            provider_id=self._provider_id,
            task_id=request.task_id,
            shot_id=request.shot_id,
            status=ProviderStatus.PROCESSING,
            observed_at=observed_at,
            external_task_ref=external_ref,
        )
        self._validate_alignment(request, result)
        return result

    def poll(
        self,
        request: ProviderRequest,
        current: ProviderResult,
        *,
        observed_at: datetime,
        reported_artifact: ArtifactReference | None = None,
    ) -> ProviderResult:
        self._validate_alignment(request, current)
        if current.external_task_ref is None:
            raise InvalidProviderStateError("poll: no external task reference to query")
        outcome = self._transport.poll(
            api_key=self._api_key(), external_task_ref=current.external_task_ref
        )
        if outcome.state == "processing":
            result = ProviderResult(
                provider_id=self._provider_id,
                task_id=request.task_id,
                shot_id=request.shot_id,
                status=ProviderStatus.PROCESSING,
                observed_at=observed_at,
                external_task_ref=current.external_task_ref,
            )
        elif outcome.state == "succeeded":
            if not outcome.artifact_url:
                raise ProviderResponseError("poll: succeeded without an artifact URL")
            result = ProviderResult(
                provider_id=self._provider_id,
                task_id=request.task_id,
                shot_id=request.shot_id,
                status=ProviderStatus.ARTIFACT_AVAILABLE,
                observed_at=observed_at,
                external_task_ref=current.external_task_ref,
                artifact=ArtifactReference(
                    reference=outcome.artifact_url,
                    origin=ArtifactOrigin.PROVIDER,
                    location=ArtifactLocation.EXTERNAL,
                ),
                cost_observation=self._cost(outcome),
            )
        elif outcome.state == "failed":
            raise ProviderVendorError(
                f"generation failed: {outcome.error or 'unknown vendor error'}"
            )
        else:
            raise ProviderResponseError(f"poll: unknown state {outcome.state!r}")
        self._validate_alignment(request, result)
        return result

    def collect(
        self,
        request: ProviderRequest,
        current: ProviderResult,
        *,
        artifact: ArtifactReference | None = None,
        observed_at: datetime,
        completed_at: datetime | None = None,
    ) -> ProviderResult:
        self._validate_alignment(request, current)
        final_artifact = artifact or current.artifact
        if final_artifact is None:
            raise MissingArtifactReferenceError(
                "collect: no artifact reference available"
            )
        result = ProviderResult(
            provider_id=self._provider_id,
            task_id=request.task_id,
            shot_id=request.shot_id,
            status=ProviderStatus.SUCCEEDED,
            observed_at=observed_at,
            external_task_ref=current.external_task_ref,
            artifact=final_artifact,
            completed_at=completed_at or observed_at,
            cost_observation=current.cost_observation,
        )
        self._validate_alignment(request, result)
        return result

    # --- internals --------------------------------------------------------

    def _api_key(self) -> str:
        key = os.environ.get(self._credential_env_var)
        if not key:
            # name only — never the value
            raise ProviderAuthError(
                f"missing credential: set env var {self._credential_env_var!r}"
            )
        return key

    def _payload(self, request: ProviderRequest) -> dict:
        return {
            "prompt": request.prompt,
            "duration_seconds": request.duration_seconds,
            "width": request.width,
            "height": request.height,
            "frame_rate": request.frame_rate,
            "parameters": dict(request.provider_parameters),
        }

    @staticmethod
    def _cost(outcome: MinimaxPoll) -> ProviderCostObservation | None:
        if outcome.cost_amount is None or outcome.cost_unit is None:
            return None
        return ProviderCostObservation(
            amount=float(outcome.cost_amount), unit=outcome.cost_unit
        )


class RealMinimaxTransport(MinimaxTransport):
    """Real HTTP transport (opt-in; unconfigured by default).

    The concrete vendor endpoints/auth shape are deferred to the vendor
    decision (ADR-0006 §5). Until ``WFM1_MINIMAX_API_BASE`` is set this
    transport refuses to run, so the default registry never performs a
    real paid call in tests or CI.
    """

    def _base(self) -> str:
        base = os.environ.get(MINIMAX_ENDPOINT_ENV)
        if not base:
            raise ProviderNetworkError(
                "real MiniMax endpoint is not configured; set "
                f"{MINIMAX_ENDPOINT_ENV} to enable real calls"
            )
        return base

    def submit(self, *, api_key: str, payload: dict) -> str:  # pragma: no cover
        del api_key, payload
        self._base()
        raise ProviderNetworkError(
            "real MiniMax transport is a vendor-pending skeleton; "
            "configure the vendor endpoint and request shape before use"
        )

    def poll(
        self, *, api_key: str, external_task_ref: str
    ) -> MinimaxPoll:  # pragma: no cover
        del api_key, external_task_ref
        self._base()
        raise ProviderNetworkError(
            "real MiniMax transport is a vendor-pending skeleton; "
            "configure the vendor endpoint and request shape before use"
        )

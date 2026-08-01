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

import json
import os
import socket
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime

from ai_video_workflow.providers.base import VideoProvider
from ai_video_workflow.providers.cloud_errors import (
    ProviderAuthError,
    ProviderNetworkError,
    ProviderNotDispatchedError,
    ProviderResponseError,
    ProviderTimeoutError,
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
    def submit(
        self, *, api_key: str, payload: dict, idempotency_key: str | None = None
    ) -> str:
        """Submit a generation job; return the external task reference.

        ``idempotency_key`` is sent best-effort (MiniMax has no idempotency
        field); the authoritative no-double-submit guarantee is the
        coordinator's reservation, not this key.
        """

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

    @property
    def bills_at_catalog_price(self) -> bool:
        """MiniMax returns no cost field; it bills a fixed price per spec.

        The coordinator therefore books the locked catalog fixed price as
        the authoritative cost when this provider returns no cost
        observation (ADR-0009).
        """
        return True

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
        params = dict(request.provider_parameters)
        idempotency_key = params.get("operation_id")
        external_ref = self._transport.submit(
            api_key=self._api_key(),
            payload=self._payload(request),
            idempotency_key=idempotency_key
            if isinstance(idempotency_key, str)
            else None,
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
        # MiniMax /v1/video_generation body (ADR-0009). Only defined vendor
        # fields are sent; a first_frame_image (image-to-video) is included
        # only if the caller supplies one in provider_parameters.
        params = dict(request.provider_parameters)
        body: dict = {
            "model": params.get("model"),
            "prompt": request.prompt,
            "duration": int(request.duration_seconds),
            "resolution": params.get("resolution"),
        }
        first_frame_image = params.get("first_frame_image")
        if isinstance(first_frame_image, str) and first_frame_image:
            body["first_frame_image"] = first_frame_image
        return {key: value for key, value in body.items() if value is not None}

    @staticmethod
    def _cost(outcome: MinimaxPoll) -> ProviderCostObservation | None:
        if outcome.cost_amount is None or outcome.cost_unit is None:
            return None
        return ProviderCostObservation(
            amount=float(outcome.cost_amount), unit=outcome.cost_unit
        )


_DEFAULT_BASE = "https://api.minimax.io"
_PROCESSING_STATES = frozenset({"preparing", "queueing", "processing"})
_FAILED_STATES = frozenset({"failed", "cancelled", "expired"})


class RealMinimaxTransport(MinimaxTransport):
    """Real HTTP transport for the MiniMax video API (ADR-0009).

    Endpoints (base ``WFM1_MINIMAX_API_BASE``, default
    ``https://api.minimax.io``):

    - submit: ``POST /v1/video_generation`` -> ``task_id``;
    - poll:   ``GET /v2/query/video_generation/{task_id}`` ->
      ``task.status`` + ``task.content.url`` on success.

    Errors are classified by charge state (TASK-016): a connection that
    was never established is ``ProviderNotDispatchedError`` (safe); a
    timeout or malformed response is ambiguous. Credentials are only ever
    sent in the ``Authorization`` header and never appear in an error
    message.
    """

    def __init__(self, *, timeout_seconds: float = 30.0) -> None:
        self._timeout = timeout_seconds

    def _base(self) -> str:
        return os.environ.get(MINIMAX_ENDPOINT_ENV) or _DEFAULT_BASE

    def submit(
        self, *, api_key: str, payload: dict, idempotency_key: str | None = None
    ) -> str:
        headers = {"Content-Type": "application/json"}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key  # best-effort
        body = json.dumps(payload).encode("utf-8")
        data = self._request(
            "POST", f"{self._base()}/v1/video_generation", api_key, headers, body
        )
        base_resp = data.get("base_resp") or {}
        status_code = base_resp.get("status_code")
        if status_code not in (0, None):
            self._raise_base_resp(status_code, base_resp.get("status_msg"))
        task_id = data.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            raise ProviderResponseError("submit: response missing task_id")
        return task_id

    def poll(self, *, api_key: str, external_task_ref: str) -> MinimaxPoll:
        data = self._request(
            "GET",
            f"{self._base()}/v2/query/video_generation/{external_task_ref}",
            api_key,
            {},
            None,
        )
        task = data.get("task") or data
        status = str(task.get("status", "")).lower()
        if status in _PROCESSING_STATES or status == "":
            return MinimaxPoll(state="processing")
        if status in _FAILED_STATES:
            return MinimaxPoll(state="failed", error=f"task status {status!r}")
        if status == "succeeded":
            content = task.get("content") or {}
            url = content.get("url")
            if not isinstance(url, str) or not url:
                raise ProviderResponseError("poll: succeeded without content.url")
            # MiniMax returns no cost field (ADR-0009); the coordinator books
            # the locked catalog fixed price.
            return MinimaxPoll(state="succeeded", artifact_url=url)
        raise ProviderResponseError(f"poll: unknown status {status!r}")

    def _request(
        self, method: str, url: str, api_key: str, headers: dict, body: bytes | None
    ) -> dict:
        request = urllib.request.Request(url, data=body, method=method)
        request.add_header("Authorization", f"Bearer {api_key}")
        for key, value in headers.items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            # an HTTP status was returned -> the request WAS received
            if exc.code in (401, 403):
                raise ProviderAuthError("MiniMax rejected the credentials") from None
            raise ProviderVendorError(f"MiniMax HTTP {exc.code}") from None
        except urllib.error.URLError as exc:
            reason = exc.reason
            if isinstance(reason, TimeoutError):
                raise ProviderTimeoutError("MiniMax request timed out") from None
            if isinstance(reason, (ConnectionRefusedError, socket.gaierror)):
                # DNS failure / connection refused -> provably never dispatched
                raise ProviderNotDispatchedError("MiniMax connection failed") from None
            # any other network condition may have been received -> ambiguous
            raise ProviderNetworkError("MiniMax network error") from None
        except TimeoutError:
            raise ProviderTimeoutError("MiniMax request timed out") from None
        except OSError:
            raise ProviderNetworkError("MiniMax network error") from None
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError) as exc:
            raise ProviderResponseError(
                "MiniMax returned a malformed response"
            ) from exc
        if not isinstance(parsed, dict):
            raise ProviderResponseError("MiniMax response was not a JSON object")
        return parsed

    @staticmethod
    def _raise_base_resp(status_code, status_msg) -> None:
        # auth-family MiniMax status codes are rejected pre-generation
        if status_code in (1004, 1008, 2013):  # invalid key / insufficient balance
            raise ProviderAuthError(f"MiniMax auth/quota error {status_code}")
        raise ProviderVendorError(f"MiniMax error {status_code}: {status_msg!r}")

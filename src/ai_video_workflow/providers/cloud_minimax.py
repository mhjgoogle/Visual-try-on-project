"""First cloud video provider: MiniMax / Hailuo adapter (TASK-016).

Implements the frozen ``VideoProvider`` contract for a real paid
image-to-video API. The provider stays **stateless and filesystem-free**
(base contract): its ``collect`` returns an *external* artifact reference
(the download URL), and the application layer fetches it — the provider
never writes the media itself.

All network I/O goes through an injected ``MinimaxTransport`` so tests
stub every request; ``RealMinimaxTransport`` implements the official
three-step contract (submit -> query -> files/retrieve, ADR-0009).
Credentials are read only from the sanctioned environment variable
(``WFM1_MINIMAX_API_KEY``) and never appear in a field, log, or error
message.
"""

from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime

from ai_video_workflow.providers.base import VideoProvider
from ai_video_workflow.providers.cloud_errors import (
    ProviderAuthError,
    ProviderNetworkError,
    ProviderNotDispatchedError,
    ProviderRequestRejectedError,
    ProviderResponseError,
    ProviderTimeoutError,
    ProviderVendorError,
)
from ai_video_workflow.providers.errors import (
    InvalidProviderRequestError,
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
MINIMAX_CREDENTIAL_ENV = "WFM1_MINIMAX_API_KEY"

# A first-frame image (image-to-video) must be a public URL or an inline
# image data URL — never a local path (which could exfiltrate local files
# or leak a path). Capped to keep an inline image from ballooning a request.
_MAX_DATA_URL_LEN = 8 * 1024 * 1024


def _validate_first_frame_image(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise InvalidProviderRequestError("first_frame_image: expected a non-empty str")
    if value.startswith(("http://", "https://")):
        return value
    if value.startswith("data:image/"):
        if len(value) > _MAX_DATA_URL_LEN:
            raise InvalidProviderRequestError("first_frame_image: data URL too large")
        return value
    raise InvalidProviderRequestError(
        "first_frame_image: must be a public http(s) URL or an image data URL "
        "(local paths are not allowed)"
    )


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
        if first_frame_image is not None:
            body["first_frame_image"] = _validate_first_frame_image(first_frame_image)
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


_INT64_MAX = 2**63 - 1


def _is_valid_file_id(value: object) -> bool:
    """A MiniMax file_id is a positive int64, or its ASCII-decimal string.

    ``str.isdigit`` is deliberately NOT used: it accepts Unicode digits
    (``１２３``, ``²``) that are not a valid vendor identifier. Negative
    and beyond-int64 values are rejected too.
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return 0 < value <= _INT64_MAX
    if isinstance(value, str):
        if not value or any(c < "0" or c > "9" for c in value):
            return False
        # bound the length BEFORE int(): int64 has at most 19 decimal
        # digits, and a huge digit string would otherwise raise ValueError
        # from Python's int-conversion limit (an unclassified escape).
        # convert the significant digits only, so a long run of leading
        # zeros can never reach the conversion limit either.
        significant = value.lstrip("0")
        if not significant or len(significant) > 19:
            return False
        return 0 < int(significant) <= _INT64_MAX
    return False


class RealMinimaxTransport(MinimaxTransport):
    """Real HTTP transport for the MiniMax video API (ADR-0009).

    Endpoints (base ``WFM1_MINIMAX_API_BASE``, default
    ``https://api.minimax.io``):

    - submit:   ``POST /v1/video_generation`` -> ``task_id``;
    - query:    ``GET /v1/query/video_generation?task_id=`` -> top-level
      ``status`` (Preparing/Queueing/Processing/Success/Fail) + ``file_id``;
    - retrieve: ``GET /v1/files/retrieve?file_id=`` -> ``file.download_url``.

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
        self._require_ok_base_resp(data, "submit")
        task_id = data.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            raise ProviderResponseError("submit: response missing task_id")
        return task_id

    def poll(self, *, api_key: str, external_task_ref: str) -> MinimaxPoll:
        # Official contract (ADR-0009): GET /v1/query/video_generation?task_id
        # returns a top-level `status` (Preparing/Queueing/Processing/Success/
        # Fail) and, on Success, a `file_id`. The download URL is then a
        # separate GET /v1/files/retrieve?file_id -> file.download_url.
        base = urllib.parse.quote(external_task_ref, safe="")
        data = self._request(
            "GET",
            f"{self._base()}/v1/query/video_generation?task_id={base}",
            api_key,
            {},
            None,
        )
        self._require_ok_base_resp(data, "query")
        # correlation check: a crossed-wire or wrong response must never let
        # this operation adopt another task's status or media.
        returned_task = data.get("task_id")
        if not isinstance(returned_task, str) or returned_task != external_task_ref:
            raise ProviderResponseError(
                "query: response task_id does not match the queried task"
            )
        status = data.get("status")
        if not isinstance(status, str) or not status:
            raise ProviderResponseError("query: response missing status")
        normalized = status.lower()
        if normalized in _PROCESSING_STATES:
            return MinimaxPoll(state="processing")
        if normalized == "fail":
            return MinimaxPoll(state="failed", error=f"task status {status!r}")
        if normalized == "success":
            file_id = data.get("file_id")
            if not _is_valid_file_id(file_id):
                raise ProviderResponseError("query: malformed or missing file_id")
            url = self._retrieve_download_url(api_key, file_id)
            # MiniMax returns no cost field (ADR-0009); the coordinator books
            # the locked catalog fixed price.
            return MinimaxPoll(state="succeeded", artifact_url=url)
        raise ProviderResponseError(f"query: unknown status {status!r}")

    def _retrieve_download_url(self, api_key: str, file_id) -> str:
        fid = urllib.parse.quote(str(file_id), safe="")
        data = self._request(
            "GET", f"{self._base()}/v1/files/retrieve?file_id={fid}", api_key, {}, None
        )
        self._require_ok_base_resp(data, "retrieve")
        file_obj = data.get("file")
        if not isinstance(file_obj, dict):
            raise ProviderResponseError("retrieve: malformed file object")
        # correlation check: the retrieved file must be the one we asked for.
        returned_fid = file_obj.get("file_id")
        if not _is_valid_file_id(returned_fid) or str(returned_fid) != str(file_id):
            raise ProviderResponseError(
                "retrieve: file.file_id does not match the requested file"
            )
        url = file_obj.get("download_url")
        if not isinstance(url, str) or not url:
            raise ProviderResponseError("retrieve: response missing file.download_url")
        return url

    def _require_ok_base_resp(self, data: dict, ctx: str) -> None:
        """Strictly validate ``base_resp`` and require an explicit success.

        Any legal-JSON-but-wrong shape (array, string, missing object,
        missing/non-int status code) is a malformed response — never an
        implicit success and never an unclassified ``AttributeError``.
        """
        base_resp = data.get("base_resp")
        if not isinstance(base_resp, dict):
            raise ProviderResponseError(f"{ctx}: malformed or missing base_resp")
        code = base_resp.get("status_code")
        if isinstance(code, bool) or not isinstance(code, int):
            raise ProviderResponseError(f"{ctx}: missing base_resp.status_code")
        if code != 0:
            status_msg = base_resp.get("status_msg")
            self._raise_base_resp(
                code, status_msg if isinstance(status_msg, str) else None
            )

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
        # Official error codes (ADR-0009): 1004 not authorized, 2049 invalid
        # API key -> auth (no charge, fallback ok). 2013 invalid params, 1008
        # insufficient balance -> request rejected pre-generation (no charge,
        # but do NOT fall back). Everything else -> vendor error (ambiguous).
        if status_code in (1004, 2049):
            raise ProviderAuthError("MiniMax rejected the credentials")
        if status_code == 2013:
            raise ProviderRequestRejectedError("MiniMax rejected invalid parameters")
        if status_code == 1008:
            raise ProviderRequestRejectedError("MiniMax reported insufficient balance")
        raise ProviderVendorError(f"MiniMax error {status_code}: {status_msg!r}")

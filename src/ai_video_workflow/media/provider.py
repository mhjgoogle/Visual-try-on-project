"""Capability-declaring multimedia Provider registry (TASK-035 / ADR-0038).

A media Provider layer that runs PARALLEL to the frozen ``VideoProvider`` — it
never generalizes or touches it (ADR-0038 P2 / AGENTS.md 3.9). Image and audio
generators attach through a registry keyed by DECLARED capability; the registry
fails closed on an unknown provider id or an undeclared capability (P1/P5). A
provider is stateless and filesystem-free: it returns a structured
:class:`MediaResult` (inline ``content`` for local synthesis, or an
``external_ref`` for a cloud fetch) and NEVER writes business facts — the
authorized media staging/asset layer materializes and publishes them.

The only provider shipped here is the local, offline, zero-cost
:class:`LocalStubMediaProvider`. Real paid image/audio providers stay explicit
opt-in under the ADR-0006/0009 credential discipline and are not implemented.
"""

from __future__ import annotations

import binascii
import struct
import zlib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import Enum

from ai_video_workflow.digests import config_digest
from ai_video_workflow.media.errors import MediaProviderError, MediaValidationError
from ai_video_workflow.providers.models import ProviderCostObservation

# Declared media capabilities (parallel to the catalog's video capability
# allowlist, which stays frozen). The registry is fail-closed against this set.
MEDIA_CAPABILITIES: frozenset[str] = frozenset(
    {"text_to_image", "image_to_image", "text_to_audio"}
)

# Formal media asset kinds an operation may produce.
MEDIA_KINDS: frozenset[str] = frozenset(
    {"reference", "master", "keyframe", "generated_image", "audio_generation"}
)

# The staging file extension each kind uses (inert bytes; format is not probed).
MEDIA_KIND_EXT: dict[str, str] = {
    "reference": "bin",
    "master": "bin",
    "keyframe": "png",
    "generated_image": "png",
    "audio_generation": "wav",
}

# Which media kinds each capability may produce. ``reference`` / ``master`` are
# format-generic; ``audio_generation`` is audio-only and the image kinds are
# image-only, so an audio capability can never emit an image kind (or vice versa).
_CAPABILITY_KINDS: dict[str, frozenset[str]] = {
    "text_to_image": frozenset({"generated_image", "keyframe", "reference", "master"}),
    "image_to_image": frozenset({"generated_image", "keyframe", "reference", "master"}),
    "text_to_audio": frozenset({"audio_generation", "reference", "master"}),
}


def capability_allows_kind(capability: str, media_kind: str) -> bool:
    """True if ``capability`` may legitimately produce ``media_kind``."""
    return media_kind in _CAPABILITY_KINDS.get(capability, frozenset())


class MediaStatus(str, Enum):
    """Terminal media generation outcomes (drive money-safety classification)."""

    SUCCEEDED = "succeeded"
    FAILED = "failed"  # no-charge technical failure -> release + fallback
    REJECTED = "rejected"  # invalid request -> release, no fallback
    AUTH_ERROR = "auth_error"  # not dispatched -> release + fallback
    NOT_DISPATCHED = "not_dispatched"  # never reached provider -> release


@dataclass(frozen=True, slots=True)
class MediaRequest:
    """An immutable media generation request (media-shaped, not video-shaped)."""

    provider_id: str
    operation_id: str
    capability: str
    media_kind: str
    prompt: str
    model_id: str
    parameters: Mapping[str, object]
    input_refs: Sequence[Mapping[str, object]]

    def __post_init__(self) -> None:
        if self.capability not in MEDIA_CAPABILITIES:
            raise MediaValidationError(f"unknown media capability: {self.capability!r}")
        if self.media_kind not in MEDIA_KINDS:
            raise MediaValidationError(f"unknown media kind: {self.media_kind!r}")
        if not capability_allows_kind(self.capability, self.media_kind):
            raise MediaValidationError(
                f"capability {self.capability!r} cannot produce media kind "
                f"{self.media_kind!r}"
            )
        if not (isinstance(self.operation_id, str) and self.operation_id):
            raise MediaValidationError("operation_id must be a non-empty string")
        if not (isinstance(self.prompt, str) and self.prompt.strip()):
            raise MediaValidationError("prompt must be a non-empty string")

    def identity_digest(self) -> str:
        """Deterministic digest of the request identity (for reproducible stubs)."""
        return config_digest(
            {
                "provider_id": self.provider_id,
                "operation_id": self.operation_id,
                "capability": self.capability,
                "media_kind": self.media_kind,
                "prompt": self.prompt,
                "model_id": self.model_id,
                "parameters": dict(self.parameters),
                "input_refs": [dict(r) for r in self.input_refs],
            }
        )


@dataclass(frozen=True, slots=True)
class MediaResult:
    """A provider's structured result — never a business fact by itself."""

    provider_id: str
    operation_id: str
    status: MediaStatus
    content: bytes | None = None
    external_ref: str | None = None
    cost_observation: ProviderCostObservation | None = None
    message: str = ""


class MediaProvider:
    """Base class for a capability-declaring media provider (stateless)."""

    provider_id: str = ""

    def declared_capabilities(self) -> frozenset[str]:  # pragma: no cover - abstract
        raise NotImplementedError

    def generate(
        self, request: MediaRequest, *, observed_at: datetime
    ) -> MediaResult:  # pragma: no cover - abstract
        raise NotImplementedError


class LocalStubMediaProvider(MediaProvider):
    """A local, offline, zero-cost provider producing deterministic media bytes.

    It declares all media capabilities, never touches the network, and reports
    no cost — the default no-spend backend for tests and offline runs.
    """

    provider_id = "local-stub"

    def declared_capabilities(self) -> frozenset[str]:
        return MEDIA_CAPABILITIES

    def generate(self, request: MediaRequest, *, observed_at: datetime) -> MediaResult:
        # Deterministic, format-VALID placeholder bytes from the request identity
        # — no randomness/clock/network/cost. A real image decoder accepts the
        # PNG and an audio decoder the WAV.
        digest = request.identity_digest()
        if request.media_kind in ("generated_image", "keyframe"):
            content = _stub_png(digest)
        elif request.media_kind == "audio_generation":
            content = _stub_wav(digest)
        else:  # reference / master: format-neutral inert bytes
            content = f"STUBMEDIA:{request.media_kind}:{digest}\n".encode()
        return MediaResult(
            provider_id=self.provider_id,
            operation_id=request.operation_id,
            status=MediaStatus.SUCCEEDED,
            content=content,
            cost_observation=None,
            message="local stub media (offline, zero cost)",
        )


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", binascii.crc32(tag + data) & 0xFFFFFFFF)
    )


def _stub_png(digest: str) -> bytes:
    """A valid 1x1 RGB PNG; the pixel + a tEXt chunk carry the digest so distinct
    requests yield distinct, still-decodable bytes."""
    rgb = bytes.fromhex(digest[:6])
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)  # 1x1, 8-bit, RGB
    idat = zlib.compress(bytes([0]) + rgb)  # filter byte 0 + one RGB pixel
    text = b"id\x00" + digest.encode("ascii")
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"tEXt", text)
        + _png_chunk(b"IDAT", idat)
        + _png_chunk(b"IEND", b"")
    )


def _stub_wav(digest: str) -> bytes:
    """A valid 8-bit PCM mono WAV whose samples carry the digest bytes."""
    samples = bytes.fromhex(digest)
    n = len(samples)
    return (
        b"RIFF"
        + struct.pack("<I", 36 + n)
        + b"WAVE"
        + b"fmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 8000, 1, 8)
        + b"data"
        + struct.pack("<I", n)
        + samples
    )


MediaProviderFactory = Callable[[], MediaProvider]


class MediaProviderRegistry:
    """Fail-closed registry of media providers keyed by id, gated by capability."""

    __slots__ = ("_factories",)

    def __init__(self) -> None:
        self._factories: dict[str, MediaProviderFactory] = {}

    def register(self, provider_id: str, factory: MediaProviderFactory) -> None:
        if not (isinstance(provider_id, str) and provider_id):
            raise MediaProviderError("provider_id must be a non-empty string")
        self._factories[provider_id] = factory

    def known(self) -> frozenset[str]:
        return frozenset(self._factories)

    def build(self, provider_id: str) -> MediaProvider:
        """Build a provider by id, failing closed on an unknown id."""
        factory = self._factories.get(provider_id)
        if factory is None:
            raise MediaProviderError(f"unknown media provider: {provider_id!r}")
        provider = factory()
        if provider.provider_id != provider_id:
            raise MediaProviderError(
                f"provider id mismatch: expected {provider_id!r}, "
                f"built {provider.provider_id!r}"
            )
        return provider

    def resolve(self, provider_id: str, capability: str) -> MediaProvider:
        """Build a provider and verify it DECLARES ``capability`` (fail-closed)."""
        if capability not in MEDIA_CAPABILITIES:
            raise MediaProviderError(f"unknown media capability: {capability!r}")
        provider = self.build(provider_id)
        if capability not in provider.declared_capabilities():
            raise MediaProviderError(
                f"provider {provider_id!r} does not declare capability {capability!r}"
            )
        return provider


def default_media_registry() -> MediaProviderRegistry:
    """A registry with only the offline local stub registered (no-spend default)."""
    registry = MediaProviderRegistry()
    registry.register(
        LocalStubMediaProvider.provider_id, lambda: LocalStubMediaProvider()
    )
    return registry

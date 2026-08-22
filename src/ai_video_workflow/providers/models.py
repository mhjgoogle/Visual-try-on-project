"""Provider contract data structures, enums, and JSON freezing helpers."""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from ipaddress import ip_address
from types import MappingProxyType
from typing import TypeAlias
from urllib.parse import urlsplit

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.providers.errors import (
    InvalidProviderRequestError,
    InvalidProviderStateError,
)
from ai_video_workflow.validation import (
    validate_json_compatible,
    validate_stable_id,
    validate_utc_datetime,
)

JsonInputValue: TypeAlias = (
    None
    | bool
    | int
    | float
    | str
    | list["JsonInputValue"]
    | dict[str, "JsonInputValue"]
)
FrozenJsonValue: TypeAlias = (
    None
    | bool
    | int
    | float
    | str
    | tuple["FrozenJsonValue", ...]
    | Mapping[str, "FrozenJsonValue"]
)


class ArtifactOrigin(str, Enum):
    """Which actor produced a generation artifact."""

    USER = "user"
    PROVIDER = "provider"


class ArtifactLocation(str, Enum):
    """Which reference mechanism locates a generation artifact."""

    EXTERNAL = "external"
    STAGING = "staging"


class ProviderStatus(str, Enum):
    """Normalized provider-side status of one generation lifecycle."""

    NOT_SUBMITTED = "not_submitted"
    WAITING_FOR_USER = "waiting_for_user"
    PROCESSING = "processing"
    ARTIFACT_AVAILABLE = "artifact_available"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def is_terminal(self) -> bool:
        """Return True for succeeded, failed, and cancelled."""
        return self in _TERMINAL_PROVIDER_STATUSES

    @property
    def requires_user_action(self) -> bool:
        """Return True only while waiting for user action."""
        return self is ProviderStatus.WAITING_FOR_USER


_TERMINAL_PROVIDER_STATUSES = frozenset(
    {
        ProviderStatus.SUCCEEDED,
        ProviderStatus.FAILED,
        ProviderStatus.CANCELLED,
    }
)


@dataclass(frozen=True, slots=True)
class ArtifactReference:
    """One normalized reference to a generation artifact."""

    reference: str
    origin: ArtifactOrigin
    location: ArtifactLocation

    def __post_init__(self) -> None:
        _validate_opaque_reference(self.reference, field_name="reference")
        if not isinstance(self.origin, ArtifactOrigin):
            raise FieldTypeError(
                f"origin: expected ArtifactOrigin, got {type(self.origin).__name__}"
            )
        if not isinstance(self.location, ArtifactLocation):
            raise FieldTypeError(
                "location: expected ArtifactLocation, "
                f"got {type(self.location).__name__}"
            )

    def to_json_dict(self) -> dict[str, JsonInputValue]:
        """Return a new JSON-compatible dictionary for this reference."""
        return {
            "reference": self.reference,
            "origin": self.origin.value,
            "location": self.location.value,
        }


@dataclass(frozen=True, slots=True)
class ProviderCostObservation:
    """One optional single-operation provider cost observation."""

    amount: float
    unit: str

    def __post_init__(self) -> None:
        if type(self.amount) is not float:
            raise FieldTypeError(
                f"amount: expected float, got {type(self.amount).__name__}"
            )
        if not math.isfinite(self.amount) or self.amount < 0:
            raise InvariantViolationError("amount: must be finite and non-negative")
        _validate_opaque_reference(self.unit, field_name="unit")

    def to_json_dict(self) -> dict[str, JsonInputValue]:
        """Return a new JSON-compatible dictionary for this observation."""
        return {"amount": self.amount, "unit": self.unit}


@dataclass(frozen=True, slots=True, init=False)
class ProviderInstruction:
    """Structured provider instructions a caller can show to a user."""

    provider_id: str
    task_id: str
    shot_id: str
    prompt: str
    expected_duration_seconds: float
    expected_width: int
    expected_height: int
    expected_frame_rate: float
    staging_ref: str
    steps: tuple[str, ...]
    _suggested_parameters: Mapping[str, FrozenJsonValue]

    __hash__ = None

    def __init__(
        self,
        provider_id: str,
        task_id: str,
        shot_id: str,
        prompt: str,
        expected_duration_seconds: float,
        expected_width: int,
        expected_height: int,
        expected_frame_rate: float,
        staging_ref: str,
        steps: tuple[str, ...],
        suggested_parameters: dict[str, JsonInputValue] | None = None,
    ) -> None:
        set_field = object.__setattr__
        set_field(
            self,
            "provider_id",
            validate_stable_id(provider_id, field_name="provider_id"),
        )
        set_field(self, "task_id", validate_stable_id(task_id, field_name="task_id"))
        set_field(self, "shot_id", validate_stable_id(shot_id, field_name="shot_id"))
        set_field(self, "prompt", _validate_text(prompt, field_name="prompt"))
        set_field(
            self,
            "expected_duration_seconds",
            _validate_strict_positive_float(
                expected_duration_seconds,
                field_name="expected_duration_seconds",
            ),
        )
        set_field(
            self,
            "expected_width",
            _validate_strict_positive_int(
                expected_width,
                field_name="expected_width",
            ),
        )
        set_field(
            self,
            "expected_height",
            _validate_strict_positive_int(
                expected_height,
                field_name="expected_height",
            ),
        )
        set_field(
            self,
            "expected_frame_rate",
            _validate_strict_positive_float(
                expected_frame_rate,
                field_name="expected_frame_rate",
            ),
        )
        set_field(
            self,
            "staging_ref",
            _validate_opaque_reference(staging_ref, field_name="staging_ref"),
        )
        set_field(self, "steps", _validate_steps(steps))
        set_field(
            self,
            "_suggested_parameters",
            _freeze_parameters(
                suggested_parameters,
                field_name="suggested_parameters",
            ),
        )

    @property
    def suggested_parameters(self) -> Mapping[str, FrozenJsonValue]:
        """Return the read-only frozen suggested parameters mapping."""
        return self._suggested_parameters

    def to_json_dict(self) -> dict[str, JsonInputValue]:
        """Return a new JSON-compatible dictionary for this instruction."""
        return {
            "provider_id": self.provider_id,
            "task_id": self.task_id,
            "shot_id": self.shot_id,
            "prompt": self.prompt,
            "expected_duration_seconds": self.expected_duration_seconds,
            "expected_width": self.expected_width,
            "expected_height": self.expected_height,
            "expected_frame_rate": self.expected_frame_rate,
            "staging_ref": self.staging_ref,
            "steps": list(self.steps),
            "suggested_parameters": _thaw_json_mapping(self._suggested_parameters),
        }


#: Hostnames that always name the fetcher itself or its local network.
_LOCAL_HOST_NAMES = frozenset({"localhost", "localhost.localdomain", "ip6-localhost"})
_LOCAL_HOST_SUFFIXES = (".localhost", ".local", ".internal", ".localdomain")

#: Per-image inline data-URL ceiling. The same 8 MiB the first-frame boundaries use
#: (ADR-0047 sizing: <=5.5 MB original -> ~7.34 MB base64).
MAX_INLINE_IMAGE_LEN = 8 * 1024 * 1024

#: Ceiling on the WHOLE ordered set's inline bytes. N images that each pass the
#: per-image cap can still be a payload nobody wants to serialize into every WAL
#: snapshot, so the set is bounded as well as its members.
MAX_INLINE_IMAGE_SET_LEN = 24 * 1024 * 1024


#: One DNS label: letters / digits / hyphen, not starting or ending with a hyphen.
_DNS_LABEL_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")

#: A label that is a NUMBER in some base rather than a name: `127`, `0x7f`, `0X1A`.
_NUMERIC_LABEL_RE = re.compile(r"^(?:0[xX][0-9a-fA-F]+|[0-9]+)$")


def normalize_url_host(host: str) -> str:
    """Lower-case, drop the root dot, and punycode an internationalised name.

    ONE NORMALISATION, DONE FIRST (codex round 5). `foo.localhost.` slipped past the
    local-name check because that check ran on the raw string and the trailing root dot
    made `endswith(".localhost")` false -- the check was right, the input had simply
    not been normalised yet. Every later test now runs on this output.

    IDNA is applied rather than refused (codex round 5, P2): an earlier draft required
    ASCII, which would have rejected `https://例え.jp/a.png` -- a public URL that used
    to work. A name that cannot be IDNA-encoded at all comes back unchanged and fails
    the shape test below, which is the honest outcome for something we cannot read.
    """
    text = (host or "").strip().lower().rstrip(".")
    if not text or text.isascii():
        return text
    try:
        return text.encode("idna").decode("ascii")
    except (UnicodeError, ValueError):
        return text


def _is_dns_name(host: str) -> bool:
    """Is this a syntactically valid DNS name rather than an address in disguise?

    TESTING THE SHAPE OF A NAME, NOT LISTING THE DISGUISES. Rounds 2-5 each found a
    spelling the previous fix missed -- scheme-only, then decimal/hex/octal integers,
    then dotted hex `0x7f.0.0.1`, then all-hex-labels `0x7f.0x0.0x0.0x1`. The set of
    spellings is unbounded, so the check is inverted: a name must LOOK like a name,
    and every numeric form fails that regardless of who thought of it.
    """
    if not host or len(host) > 253:
        return False
    labels = host.split(".")
    if len(labels) < 2:
        # a single label cannot be a public name (`http://intranet/`), and it is
        # exactly the shape that resolves to something internal
        return False
    if not all(_DNS_LABEL_RE.match(label) for label in labels):
        return False
    # A NUMERIC FINAL LABEL MEANS THIS IS AN ADDRESS: `127.1`, `0x7f.0.0.1`.
    # ALL-NUMERIC LABELS mean the same thing even when each one has letters in it:
    # `0x7f.0x0.0x0.0x1` is loopback with every octet written in hex.
    #
    # The final-label test is deliberately only "numeric literal", never "parses as
    # hex": an earlier draft refused any hex-parseable TLD, which would have rejected
    # `example.ca` and `example.de` -- many real ccTLDs are pure a-f letters. A guard
    # that blocks legitimate domains gets worked around, and then protects nothing.
    if _NUMERIC_LABEL_RE.match(labels[-1]):
        return False
    return not all(_NUMERIC_LABEL_RE.match(label) for label in labels)


def _literal_address(host: str):
    """The IP this host names, in ANY notation, or None if it is not a literal.

    ``ip_address`` only reads the canonical spellings, so the integer / hex / octal
    forms of an address (all of which real resolvers accept) come back as "not an
    address" and would then be treated as a DNS name. This tries the other spellings
    too, so ``2130706433``, ``0x7f000001`` and ``017700000001`` are all recognised as
    127.0.0.1 and refused by the caller.
    """
    try:
        return ip_address(host)
    except ValueError:
        pass
    # a bare integer in decimal / hex / octal — the classic loopback disguises
    for base in (10, 16, 8):
        try:
            packed = int(host, base)
        except ValueError:
            continue
        if 0 <= packed <= 0xFFFFFFFF:
            try:
                return ip_address(packed)
            except ValueError:
                continue
    return None


def validate_public_media_url(value: object, *, field_name: str) -> str:
    """A媒体 URL we hand to a PROVIDER to fetch, or an inline image data URL.

    THE CHECK NOW MATCHES ITS OWN CLAIM (codex round 2, P1). Both this and the
    first-frame validator said "must be a public http(s) URL" while checking only the
    scheme, so ``http://localhost/admin`` and ``http://192.168.1.1/`` passed. The
    provider is the one that dereferences the URL, so such a value asks a cloud
    service to fetch something on ITS network — and an error message that asserts
    "public" without enforcing it is the same shape of untruth this whole audit is
    about.

    What is refused: a non-http(s) scheme, a missing host, embedded credentials, a
    literal loopback / private / link-local / reserved IP **in any notation**, and the
    hostnames that always mean "the fetcher itself".

    "IN ANY NOTATION" IS THE PART ROUND 2 GOT WRONG (codex round 3, P1).
    ``http://2130706433/`` is 127.0.0.1 written as a decimal integer, and many HTTP
    clients and resolvers accept it; ``0x7f000001`` and ``017700000001`` are the same
    address again. ``ip_address("2130706433")`` raises, so those all fell through the
    "it must be a DNS name" branch and were returned unchecked. The claim was
    "literal addresses are checked", so the check has to cover the ways a literal can
    be spelled -- a host with NO letter in it is a number, not a name, and is only
    accepted if it parses as a public address.

    WHAT IS NOT ATTEMPTED, AND WHY IT IS NOT A GAP TO CLOSE HERE (raised and declined
    in codex rounds 3, 5 and 7 -- recorded so the next reader does not re-litigate it):

    DNS RESOLUTION. ``https://attacker.example/`` can resolve to 169.254.169.254, and
    this function will not stop it. Resolving here would not either:

      * the fetch happens on the PROVIDER's host, with the provider's resolver and
        the provider's network view. What we resolve to says nothing about what they
        resolve to.
      * a name can re-resolve between our check and their fetch (DNS rebinding), so
        resolve-then-hand-over is a TOCTOU by construction.
      * implementing it would therefore READ as a guarantee while providing none --
        the exact shape of untruth this whole audit exists to remove.

    The defence that works against a hostile name is on the fetching side: an egress
    allowlist or a resolver policy where the request is actually made. That is the
    provider's boundary, not this validator's, and pretending otherwise here would
    make the code look safer than it is.

    So this function's claim is deliberately narrow and exactly true: it refuses
    literal addresses in any notation, and names that always mean the fetcher itself.
    """
    if not isinstance(value, str) or not value.strip():
        raise InvalidProviderRequestError(f"{field_name}: expected a non-empty string")
    if value.startswith("data:image/"):
        # A CEILING HERE TOO (codex round 3, P1). `first_frame_image` has had one for
        # a while; the reference set had none, and it holds SEVERAL images that are
        # then serialized into the request and into every WAL snapshot of it. The
        # per-image cap matches the first-frame one; `validate_reference_images`
        # additionally caps the SET, because N images under the individual limit can
        # still be an unreasonable payload.
        if len(value) > MAX_INLINE_IMAGE_LEN:
            raise InvalidProviderRequestError(f"{field_name}: data URL too large")
        return value
    if not value.startswith(("http://", "https://")):
        raise InvalidProviderRequestError(
            f"{field_name}: must be a public http(s) URL or an image data URL "
            "(local paths are not allowed)"
        )
    # `urlsplit` RAISES on a malformed bracketed host such as `https://[::1`
    # (codex round 7, P2). An unhandled ValueError here would surface as a coordinator
    # crash where a plain validation refusal belongs -- the same class of defect as the
    # over-long ordinal: malformed input must be classified, not escape as an
    # exception.
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise InvalidProviderRequestError(
            f"{field_name}: not a parseable URL ({exc})"
        ) from exc
    if parsed.username or parsed.password:
        raise InvalidProviderRequestError(
            f"{field_name}: must not embed credentials in the URL"
        )
    # NORMALISE ONCE, THEN TEST (codex round 5): trailing root dot removed, lower-cased,
    # IDNA-encoded. Every check below reads this value, so none of them can be fooled by
    # a spelling the previous one already handled.
    host = normalize_url_host(parsed.hostname or "")
    if not host:
        raise InvalidProviderRequestError(f"{field_name}: URL has no host")
    if host in _LOCAL_HOST_NAMES or host.endswith(_LOCAL_HOST_SUFFIXES):
        raise InvalidProviderRequestError(
            f"{field_name}: {host!r} names the fetcher's own machine, not a public "
            "address"
        )
    address = _literal_address(host)
    if address is None:
        # ALLOWLIST THE ONE SHAPE WE UNDERSTAND, rather than enumerating disguises
        # (codex rounds 2-4). Three rounds went by patching notations one at a time --
        # scheme-only, then decimal/hex/octal integers, then dotted-hex `0x7f.0.0.1`
        # -- because a denylist of spellings is unbounded. A DNS NAME has a known
        # shape and a non-numeric last label; every numeric disguise fails that test,
        # including the ones nobody has thought of yet.
        if not _is_dns_name(host):
            raise InvalidProviderRequestError(
                f"{field_name}: {host!r} is neither a public address nor a valid "
                "hostname -- refusing rather than letting the provider's resolver "
                "decide what it means"
            )
        return value  # a DNS name; see the docstring on why it is not resolved
    # ONE PROPERTY, MAINTAINED BY THE STDLIB (codex round 6, P1). An enumeration of
    # loopback / private / link-local / reserved / multicast / unspecified missed
    # 100.64.0.0/10 (CGNAT), which is none of those and is still not public -- and
    # would have kept missing whatever range comes next. `is_global` is exactly the
    # question being asked, and it is somebody else's job to keep it current.
    if not address.is_global:
        raise InvalidProviderRequestError(
            f"{field_name}: {host} is not a globally routable address (loopback / "
            "private / link-local / carrier-NAT addresses would point the provider "
            "at its own network)"
        )
    return value


@dataclass(frozen=True, slots=True)
class ReferenceImage:
    """One reference image handed to a generation, at a known ordinal.

    ADR-0071 decision 1 / decision 3. The ordinal is AUTHORITATIVE: it is the
    number the prompt refers to as ``[[ref:N]]``, so it must be 1-based and the
    set must be contiguous. The caller normalises the set (the studio does this in
    ``workflow/refset.js``); this type refuses an ordinal that could not be part of
    such a set.

    ``version`` + ``content_digest`` are MANDATORY, the same discipline
    ``reuse_assets`` already carries: a paid generation must bind the exact version
    it used, or "re-run with the same parameters" has no definition afterwards.

    ``role`` is one of the ADR-0061 decision 4 reference roles. It says WHAT the
    image is, for the Skill and for capability matching -- it is no longer a slot.
    """

    ordinal: int
    url_or_data: str
    role: str
    asset_id: str
    version: int
    content_digest: str

    def __post_init__(self) -> None:
        if isinstance(self.ordinal, bool) or not isinstance(self.ordinal, int):
            raise InvalidProviderRequestError(
                "reference_images[].ordinal: expected int"
            )
        if self.ordinal < 1:
            raise InvalidProviderRequestError(
                "reference_images[].ordinal: must be >= 1 (it is the number the "
                "prompt points at)"
            )
        if isinstance(self.version, bool) or not isinstance(self.version, int):
            raise InvalidProviderRequestError(
                "reference_images[].version: expected int"
            )
        if self.version < 1:
            raise InvalidProviderRequestError(
                "reference_images[].version: must be >= 1"
            )
        for field_name in ("url_or_data", "role", "asset_id", "content_digest"):
            value = getattr(self, field_name)
            if not isinstance(value, str) or not value.strip():
                raise InvalidProviderRequestError(
                    f"reference_images[].{field_name}: expected a non-empty string"
                )
        # NEVER A LOCAL PATH, AND NEVER A LOCAL ADDRESS. Same rule as
        # first_frame_image, now sharing one implementation with it.
        validate_public_media_url(
            self.url_or_data, field_name="reference_images[].url_or_data"
        )

    def to_json_dict(self) -> dict[str, JsonInputValue]:
        """Return a new JSON-compatible dictionary for this reference image."""
        return {
            "ordinal": self.ordinal,
            "url_or_data": self.url_or_data,
            "role": self.role,
            "asset_id": self.asset_id,
            "version": self.version,
            "content_digest": self.content_digest,
        }


def validate_reference_images(value: object) -> tuple[ReferenceImage, ...]:
    """Normalise and CHECK a reference-image set (ADR-0071 decision 1).

    The ordinals must be exactly 1..N with no holes and no repeats. A hole makes
    every ``[[ref:N]]`` after it name a different picture, and a repeat makes one
    number ambiguous -- both are the silent-rebinding failure the studio side
    (``refset.js``) refuses, checked again here so the provider boundary cannot be
    reached around.
    """
    if value is None:
        return ()
    if isinstance(value, (str, bytes)) or not isinstance(value, (list, tuple)):
        raise InvalidProviderRequestError("reference_images: expected a sequence")
    images = tuple(value)
    for image in images:
        if not isinstance(image, ReferenceImage):
            raise InvalidProviderRequestError(
                "reference_images: expected ReferenceImage entries"
            )
    ordinals = [image.ordinal for image in images]
    if ordinals != list(range(1, len(images) + 1)):
        raise InvalidProviderRequestError(
            f"reference_images: ordinals must be exactly 1..N in order (got {ordinals})"
        )
    # THE SET IS BOUNDED, NOT ONLY ITS MEMBERS (codex round 3, P1). N images that each
    # pass the per-image ceiling can still be a payload that gets serialized into the
    # request AND into every WAL snapshot of it.
    inline = sum(
        len(image.url_or_data)
        for image in images
        if image.url_or_data.startswith("data:image/")
    )
    if inline > MAX_INLINE_IMAGE_SET_LEN:
        raise InvalidProviderRequestError(
            f"reference_images: inline image data totals {inline} bytes, over the "
            f"{MAX_INLINE_IMAGE_SET_LEN}-byte ceiling for one request"
        )
    return images


@dataclass(frozen=True, slots=True, init=False)
class ProviderRequest:
    """One immutable generation request handed to a provider."""

    provider_id: str
    task_id: str
    shot_id: str
    prompt: str
    duration_seconds: float
    width: int
    height: int
    frame_rate: float
    staging_ref: str | None
    # ADR-0071 decision 3: ADDITIVE, default empty. Every existing provider and
    # every existing packet keeps working untouched; `first_frame_image` stays
    # exactly where it is, because a condition frame is not "reference image 0" --
    # merging the two would blur both concepts at once.
    reference_images: tuple[ReferenceImage, ...]
    _provider_parameters: Mapping[str, FrozenJsonValue]

    __hash__ = None

    def __init__(
        self,
        provider_id: str,
        task_id: str,
        shot_id: str,
        prompt: str,
        duration_seconds: float,
        width: int,
        height: int,
        frame_rate: float,
        staging_ref: str | None = None,
        provider_parameters: dict[str, JsonInputValue] | None = None,
        reference_images: object = None,
    ) -> None:
        set_field = object.__setattr__
        set_field(
            self,
            "provider_id",
            validate_stable_id(provider_id, field_name="provider_id"),
        )
        set_field(self, "task_id", validate_stable_id(task_id, field_name="task_id"))
        set_field(self, "shot_id", validate_stable_id(shot_id, field_name="shot_id"))
        set_field(self, "prompt", _validate_text(prompt, field_name="prompt"))
        set_field(
            self,
            "duration_seconds",
            _validate_strict_positive_float(
                duration_seconds,
                field_name="duration_seconds",
            ),
        )
        set_field(
            self,
            "width",
            _validate_strict_positive_int(width, field_name="width"),
        )
        set_field(
            self,
            "height",
            _validate_strict_positive_int(height, field_name="height"),
        )
        set_field(
            self,
            "frame_rate",
            _validate_strict_positive_float(frame_rate, field_name="frame_rate"),
        )
        if staging_ref is not None:
            _validate_opaque_reference(staging_ref, field_name="staging_ref")
        set_field(self, "staging_ref", staging_ref)
        set_field(
            self,
            "reference_images",
            validate_reference_images(reference_images),
        )
        set_field(
            self,
            "_provider_parameters",
            _freeze_parameters(
                provider_parameters,
                field_name="provider_parameters",
            ),
        )

    @property
    def provider_parameters(self) -> Mapping[str, FrozenJsonValue]:
        """Return the read-only frozen provider parameters mapping."""
        return self._provider_parameters

    def to_json_dict(self) -> dict[str, JsonInputValue]:
        """Return a new JSON-compatible dictionary for this request."""
        return {
            "provider_id": self.provider_id,
            "task_id": self.task_id,
            "shot_id": self.shot_id,
            "prompt": self.prompt,
            "duration_seconds": self.duration_seconds,
            "width": self.width,
            "height": self.height,
            "frame_rate": self.frame_rate,
            "staging_ref": self.staging_ref,
            "reference_images": [
                image.to_json_dict() for image in self.reference_images
            ],
            "provider_parameters": _thaw_json_mapping(self._provider_parameters),
        }


@dataclass(frozen=True, slots=True)
class ProviderResult:
    """One immutable provider-side result snapshot for one request."""

    provider_id: str
    task_id: str
    shot_id: str
    status: ProviderStatus
    observed_at: datetime
    external_task_ref: str | None = None
    artifact: ArtifactReference | None = None
    instruction: ProviderInstruction | None = None
    message: str | None = None
    error_summary: str | None = None
    completed_at: datetime | None = None
    elapsed_seconds: float | None = None
    cost_observation: ProviderCostObservation | None = None

    def __post_init__(self) -> None:
        validate_stable_id(self.provider_id, field_name="provider_id")
        validate_stable_id(self.task_id, field_name="task_id")
        validate_stable_id(self.shot_id, field_name="shot_id")
        if not isinstance(self.status, ProviderStatus):
            raise FieldTypeError(
                f"status: expected ProviderStatus, got {type(self.status).__name__}"
            )
        validate_utc_datetime(self.observed_at, field_name="observed_at")
        if self.external_task_ref is not None:
            _validate_opaque_reference(
                self.external_task_ref,
                field_name="external_task_ref",
            )
        if self.artifact is not None and not isinstance(
            self.artifact, ArtifactReference
        ):
            raise FieldTypeError(
                "artifact: expected ArtifactReference, "
                f"got {type(self.artifact).__name__}"
            )
        if self.instruction is not None and not isinstance(
            self.instruction, ProviderInstruction
        ):
            raise FieldTypeError(
                "instruction: expected ProviderInstruction, "
                f"got {type(self.instruction).__name__}"
            )
        if self.message is not None:
            _validate_text(self.message, field_name="message")
        if self.error_summary is not None:
            _validate_text(self.error_summary, field_name="error_summary")
        if self.completed_at is not None:
            validate_utc_datetime(self.completed_at, field_name="completed_at")
            if self.completed_at > self.observed_at:
                raise InvariantViolationError(
                    "completed_at: must not be later than observed_at"
                )
        if self.elapsed_seconds is not None:
            _validate_non_negative_float(
                self.elapsed_seconds,
                field_name="elapsed_seconds",
            )
        if self.cost_observation is not None and not isinstance(
            self.cost_observation, ProviderCostObservation
        ):
            raise FieldTypeError(
                "cost_observation: expected ProviderCostObservation, "
                f"got {type(self.cost_observation).__name__}"
            )
        self._validate_status_matrix()
        self._validate_instruction_alignment()

    def _validate_instruction_alignment(self) -> None:
        if self.instruction is None:
            return
        for field_name in ("provider_id", "task_id", "shot_id"):
            if getattr(self.instruction, field_name) != getattr(self, field_name):
                raise InvalidProviderRequestError(
                    f"instruction.{field_name}: must match the result {field_name}"
                )

    def _validate_status_matrix(self) -> None:
        status = self.status
        if status is ProviderStatus.NOT_SUBMITTED:
            _forbid(self.artifact, field_name="artifact", status=status)
            _forbid(
                self.external_task_ref,
                field_name="external_task_ref",
                status=status,
            )
            _forbid(self.error_summary, field_name="error_summary", status=status)
            _forbid(self.completed_at, field_name="completed_at", status=status)
            return
        _forbid(self.instruction, field_name="instruction", status=status)
        if status in (ProviderStatus.WAITING_FOR_USER, ProviderStatus.PROCESSING):
            _forbid(self.artifact, field_name="artifact", status=status)
            _forbid(self.error_summary, field_name="error_summary", status=status)
            _forbid(self.completed_at, field_name="completed_at", status=status)
        elif status is ProviderStatus.ARTIFACT_AVAILABLE:
            _require(self.artifact, field_name="artifact", status=status)
            _forbid(self.error_summary, field_name="error_summary", status=status)
            _forbid(self.completed_at, field_name="completed_at", status=status)
        elif status is ProviderStatus.SUCCEEDED:
            _require(self.artifact, field_name="artifact", status=status)
            _forbid(self.error_summary, field_name="error_summary", status=status)
            _require(self.completed_at, field_name="completed_at", status=status)
        elif status is ProviderStatus.FAILED:
            _forbid(self.artifact, field_name="artifact", status=status)
            _require(self.error_summary, field_name="error_summary", status=status)
            _require(self.completed_at, field_name="completed_at", status=status)
        else:
            _forbid(self.artifact, field_name="artifact", status=status)
            _forbid(self.error_summary, field_name="error_summary", status=status)
            _require(self.completed_at, field_name="completed_at", status=status)

    @property
    def is_terminal(self) -> bool:
        """Return the terminal flag derived from the provider status."""
        return self.status.is_terminal

    @property
    def requires_user_action(self) -> bool:
        """Return the user-action flag derived from the provider status."""
        return self.status.requires_user_action

    def to_json_dict(self) -> dict[str, JsonInputValue]:
        """Return a new JSON-compatible dictionary for this result."""
        return {
            "provider_id": self.provider_id,
            "task_id": self.task_id,
            "shot_id": self.shot_id,
            "status": self.status.value,
            "observed_at": _format_utc_datetime(self.observed_at),
            "external_task_ref": self.external_task_ref,
            "artifact": (
                None if self.artifact is None else self.artifact.to_json_dict()
            ),
            "instruction": (
                None if self.instruction is None else self.instruction.to_json_dict()
            ),
            "message": self.message,
            "error_summary": self.error_summary,
            "completed_at": (
                None
                if self.completed_at is None
                else _format_utc_datetime(self.completed_at)
            ),
            "elapsed_seconds": self.elapsed_seconds,
            "cost_observation": (
                None
                if self.cost_observation is None
                else self.cost_observation.to_json_dict()
            ),
        }


def _forbid(value: object, *, field_name: str, status: ProviderStatus) -> None:
    if value is not None:
        raise InvalidProviderStateError(
            f"{field_name}: not allowed for provider status {status.value}"
        )


def _require(value: object, *, field_name: str, status: ProviderStatus) -> None:
    if value is None:
        raise InvalidProviderStateError(
            f"{field_name}: required for provider status {status.value}"
        )


def _validate_opaque_reference(value: object, *, field_name: str) -> str:
    if type(value) is not str:
        raise FieldTypeError(
            f"{field_name}: expected string, got {type(value).__name__}"
        )
    if not value or value.isspace():
        raise InvariantViolationError(f"{field_name}: must not be empty or blank")
    if value != value.strip():
        raise InvariantViolationError(
            f"{field_name}: must not contain leading or trailing whitespace"
        )
    if any(unicodedata.category(character) == "Cc" for character in value):
        raise InvariantViolationError(
            f"{field_name}: must not contain control characters"
        )
    return value


def _validate_text(value: object, *, field_name: str) -> str:
    if type(value) is not str:
        raise FieldTypeError(
            f"{field_name}: expected string, got {type(value).__name__}"
        )
    if not value or value.isspace():
        raise InvariantViolationError(f"{field_name}: must not be empty or blank")
    if value != value.strip():
        raise InvariantViolationError(
            f"{field_name}: must not contain leading or trailing whitespace"
        )
    return value


def _validate_strict_positive_float(value: object, *, field_name: str) -> float:
    if type(value) is not float:
        raise FieldTypeError(
            f"{field_name}: expected float, got {type(value).__name__}"
        )
    if not math.isfinite(value) or value <= 0:
        raise InvariantViolationError(
            f"{field_name}: must be finite and greater than zero"
        )
    return value


def _validate_strict_positive_int(value: object, *, field_name: str) -> int:
    if type(value) is not int:
        raise FieldTypeError(f"{field_name}: expected int, got {type(value).__name__}")
    if value <= 0:
        raise InvariantViolationError(f"{field_name}: must be greater than zero")
    return value


def _validate_non_negative_float(value: object, *, field_name: str) -> float:
    if type(value) is not float:
        raise FieldTypeError(
            f"{field_name}: expected float, got {type(value).__name__}"
        )
    if not math.isfinite(value) or value < 0:
        raise InvariantViolationError(f"{field_name}: must be finite and non-negative")
    return value


def _validate_steps(value: object) -> tuple[str, ...]:
    if type(value) is not tuple:
        raise FieldTypeError(f"steps: expected tuple, got {type(value).__name__}")
    if not value:
        raise InvariantViolationError("steps: must contain at least one step")
    for index, step in enumerate(value):
        _validate_text(step, field_name=f"steps[{index}]")
    return value


def _freeze_parameters(
    value: object,
    *,
    field_name: str,
) -> Mapping[str, FrozenJsonValue]:
    if value is None:
        value = {}
    if type(value) is not dict:
        raise FieldTypeError(f"{field_name}: expected dict, got {type(value).__name__}")
    validate_json_compatible(value, path=field_name)
    return _freeze_json_mapping(value, field_name=field_name)


def _freeze_json_mapping(
    value: dict[str, object],
    *,
    field_name: str,
) -> Mapping[str, FrozenJsonValue]:
    return MappingProxyType(
        {
            key: _freeze_json_value(item, field_name=field_name)
            for key, item in value.items()
        }
    )


def _freeze_json_value(value: object, *, field_name: str) -> FrozenJsonValue:
    if value is None or type(value) in {bool, int, float, str}:
        return value
    if type(value) is list:
        return tuple(_freeze_json_value(item, field_name=field_name) for item in value)
    if type(value) is dict:
        return _freeze_json_mapping(value, field_name=field_name)
    raise FieldTypeError(
        f"{field_name}: expected plain dict/list JSON input, got {type(value).__name__}"
    )


def _thaw_json_mapping(
    value: Mapping[str, FrozenJsonValue],
) -> dict[str, JsonInputValue]:
    return {key: _thaw_json_value(item) for key, item in value.items()}


def _thaw_json_value(value: object) -> JsonInputValue:
    if isinstance(value, Mapping):
        return {key: _thaw_json_value(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw_json_value(item) for item in value]
    return value


def _format_utc_datetime(value: datetime) -> str:
    return value.isoformat(timespec="microseconds")

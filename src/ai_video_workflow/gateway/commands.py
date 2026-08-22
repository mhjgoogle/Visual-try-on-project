"""Command envelope, spec, and approved-command registry (ADR-0033 / TASK-030).

A write command enters the core through exactly one application path: the
Command Gateway. This module defines the transport-agnostic command envelope,
the spec that declares how one approved command is preflighted and applied, and
the registry that admits ONLY approved application/Orchestrator operations —
anything not registered is refused fail-closed (no bypass).

The Gateway never calls a Provider or writes business files directly; a spec's
``apply`` handler is an already-approved application/Orchestrator entry, and its
``preview`` is a read-only preflight. TASK-030 wires NO real write command
(ADR-0033: "不接入任何真实写命令"); it builds the foundation + registry, exercised
with registered stub commands, so real commands can be registered later
(TASK-031 / TASK-038) without a new write path.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.gateway.errors import UnregisteredCommandError
from ai_video_workflow.manifest import JsonCompatibleValue
from ai_video_workflow.validation import (
    validate_stable_id,
    validate_utc_datetime,
)

_TARGET_KEYS = frozenset({"ref", "version", "content_digest"})
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class CommandRisk(str, Enum):
    """A command's risk tier. HIGH commands require a bound secondary confirmation."""

    LOW = "low"
    HIGH = "high"


@dataclass(frozen=True, slots=True)
class Preview:
    """The read-only preflight facts a command spec computes (ADR-0033 P4).

    ``blockers`` is empty when the command may proceed; a non-empty list is a
    fail-closed reason set (unapproved / over-budget / provider-unavailable /
    already-running / ...). ``estimated_cost`` and ``downstream`` are advisory
    read-only facts shown before a high-risk confirmation.
    """

    inputs: Mapping[str, JsonCompatibleValue]
    estimated_cost: Mapping[str, JsonCompatibleValue] | None
    downstream: tuple[str, ...]
    blockers: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class CommandEnvelope:
    """One transport-agnostic write-command request.

    ``command_id`` is the caller-supplied idempotency key: a resubmitted or
    concurrent command with the same id returns its existing receipt rather than
    re-executing (ADR-0033 P5). ``target`` binds the exact object version the
    command acts on (ref + version + content_digest); it is required unless the
    command spec declares ``requires_target=False``.
    """

    command_id: str
    name: str
    actor: str
    params: Mapping[str, JsonCompatibleValue]
    occurred_at: datetime
    target: Mapping[str, JsonCompatibleValue] | None = None

    def __post_init__(self) -> None:
        validate_stable_id(self.command_id, field_name="command_id")
        validate_stable_id(self.name, field_name="name")
        validate_stable_id(self.actor, field_name="actor")
        validate_utc_datetime(self.occurred_at, field_name="occurred_at")
        if not isinstance(self.params, dict):
            raise FieldTypeError("params: expected dict")
        if self.target is not None:
            _validate_target(self.target)


def _validate_target(target: object) -> None:
    if not isinstance(target, dict) or frozenset(target) != _TARGET_KEYS:
        raise InvariantViolationError(
            f"target: expected exactly {sorted(_TARGET_KEYS)}"
        )
    validate_stable_id(target["ref"], field_name="target.ref")
    version = target["version"]
    if isinstance(version, bool) or not isinstance(version, int) or version <= 0:
        raise InvariantViolationError("target.version: expected a positive int")
    digest = target["content_digest"]
    if not isinstance(digest, str) or _SHA256_RE.match(digest) is None:
        raise InvariantViolationError(
            "target.content_digest: expected a lowercase hex SHA-256 digest"
        )


@dataclass(frozen=True, slots=True)
class CommandSpec:
    """How one approved command is previewed and applied.

    ``preview(project_root, envelope) -> Preview`` is READ-ONLY (preflight).
    ``apply(project_root, envelope) -> Mapping`` performs the command by calling
    an already-approved application/Orchestrator entry and returns a
    JSON-compatible outcome. ``requires_target`` gates version binding;
    ``risk`` gates the secondary-confirmation requirement.
    """

    name: str
    risk: CommandRisk
    preview: Callable[..., Preview]
    apply: Callable[..., Mapping[str, JsonCompatibleValue]]
    requires_target: bool = True

    def __post_init__(self) -> None:
        validate_stable_id(self.name, field_name="spec.name")
        if not isinstance(self.risk, CommandRisk):
            raise FieldTypeError("spec.risk: expected CommandRisk")
        if not callable(self.preview) or not callable(self.apply):
            raise FieldTypeError("spec.preview/apply: expected callables")


@dataclass(frozen=True, slots=True)
class CommandRegistry:
    """The approved-command registry — the ONLY commands the Gateway will run."""

    _specs: dict[str, CommandSpec] = field(default_factory=dict)

    def register(self, spec: CommandSpec) -> None:
        if spec.name in self._specs:
            raise InvariantViolationError(
                f"command {spec.name!r} is already registered"
            )
        self._specs[spec.name] = spec

    def get(self, name: str) -> CommandSpec:
        spec = self._specs.get(name)
        if spec is None:
            raise UnregisteredCommandError(
                f"command {name!r} is not in the approved registry (refused)"
            )
        return spec

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._specs))

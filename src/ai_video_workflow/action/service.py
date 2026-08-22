"""Feedback/Action application service: binding, state machine, stale (ADR-0035).

The single approved pre-Gateway write path for feedback/action facts (ADR-0035 /
ADR-0032). It sits above the append-only log and enforces the boundary policy
the raw record model cannot:

- **Version binding (fail-closed).** feedback / action / rebind bind a target
  (ref + version + content_digest); the service verifies the supplied target
  resolves to a matching authoritative fact and never silently fills a digest.
- **Independent state machine.** The current Action state is folded from its
  append-only events; transitions are validated against the legal-transition
  graph and refused on a terminal Action. Verification is the user's and only
  from ``waiting_for_user``.
- **Stale fail-closed.** A target whose digest drifted makes the Action
  ``stale``: it cannot be transitioned (except cancelled), handled, or verified
  until an explicit ``rebind`` re-points it — never acting on the wrong version.
- **No second writer / no Provider.** This writes only feedback/action FACTS;
  any real change an Action implies is applied elsewhere through the Command
  Gateway (ADR-0033). The clock is injected for deterministic ``occurred_at``.

Concurrency model: WFM1 is local single-user with a single pre-Gateway writer,
so the duplicate-id and state checks are sequential-consistent by convention;
they are not a cross-process critical section (adding cross-host locking is out
of scope — TASK-030 明确不做). Even under accidental concurrent writers the log
never corrupts: the reader de-duplicates first-wins and the fold replays in
append order, so the outcome stays deterministic. Logical concurrency control
for Action-triggered changes is the Command Gateway's job (ADR-0033 / TASK-030).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol

from ai_video_workflow.action.log import append_record, read_records
from ai_video_workflow.action.records import (
    ActionActor,
    ActionRecord,
    ActionRecordType,
    build_action_record,
    build_feedback_record,
    build_handling_record,
    build_rebind_record,
    build_transition_record,
    build_verification_record,
)
from ai_video_workflow.action.state import (
    FoldedAction,
    fold,
    is_terminal,
    transition_allowed,
)
from ai_video_workflow.errors import (
    AiVideoWorkflowError,
    FieldTypeError,
    ReferenceValidationError,
)
from ai_video_workflow.manifest import JsonCompatibleValue


class ActionServiceError(AiVideoWorkflowError):
    """Base error for the feedback/action application service."""


class ActionActorError(ActionServiceError):
    """Raised when an actor is not permitted for an operation (e.g. non-user verify)."""


class ActionStateError(ActionServiceError):
    """Raised on an illegal or terminal-state transition."""


class StaleTargetError(ActionServiceError):
    """Raised when a write's bound target does not match authoritative facts."""


class StaleActionError(ActionServiceError):
    """Raised when a stale Action is operated on before an explicit rebind."""


class DuplicateRecordError(ActionServiceError):
    """Raised when a write would reuse an existing record_id.

    The reader de-duplicates by record_id first-wins, so silently appending a
    duplicate would report write success while every reader ignores it. The
    service refuses it fail-closed instead.
    """


@dataclass(frozen=True, slots=True)
class ResolvedTarget:
    exists: bool
    content_digest: str | None


class TargetResolver(Protocol):
    """Read-only resolver of a target's authoritative content digest."""

    def resolve_target(
        self, project_root: Path, *, ref: str, version: int
    ) -> ResolvedTarget: ...


@dataclass(frozen=True, slots=True)
class ActionView:
    """One Action's folded lifecycle + derived stale overlay + its events."""

    action: ActionRecord
    folded: FoldedAction
    effective_state: str
    target_stale: bool
    stale_reason: str | None
    events: tuple[ActionRecord, ...]


@dataclass(frozen=True, slots=True)
class FeedbackView:
    """One feedback fact + derived target staleness."""

    feedback: ActionRecord
    target_stale: bool
    stale_reason: str | None


class ActionService:
    """The approved binding/state/stale-checked feedback/action write path."""

    def __init__(
        self,
        project_root: Path,
        project_id: str,
        *,
        resolver: TargetResolver,
        clock: Callable[[], datetime],
    ) -> None:
        self._project_root = project_root
        self._project_id = project_id
        self._resolver = resolver
        self._clock = clock

    # --- write: feedback / action creation -------------------------------

    def create_feedback(
        self,
        *,
        actor: ActionActor,
        feedback_id: str,
        target: Mapping[str, JsonCompatibleValue],
        context: Mapping[str, JsonCompatibleValue],
        summary: str,
        detail: str,
        occurred_at: datetime | None = None,
    ) -> ActionRecord:
        """Record a problem report bound to an exact object version."""
        self._verify_target(target)
        record = build_feedback_record(
            project_id=self._project_id,
            actor=actor,
            feedback_id=feedback_id,
            target=target,
            context=context,
            summary=summary,
            detail=detail,
            occurred_at=self._at(occurred_at),
        )
        self._reject_duplicate(record.record_id)
        append_record(self._project_root, record)
        return record

    def create_action(
        self,
        *,
        actor: ActionActor,
        action_id: str,
        feedback_id: str | None,
        target: Mapping[str, JsonCompatibleValue],
        context: Mapping[str, JsonCompatibleValue],
        intent: str,
        occurred_at: datetime | None = None,
    ) -> ActionRecord:
        """Create a controlled-handling commitment (initial state pending)."""
        self._verify_target(target)
        if feedback_id is not None and not self._feedback_exists(feedback_id):
            raise ReferenceValidationError(
                f"feedback_id {feedback_id!r} does not resolve to a feedback record"
            )
        record = build_action_record(
            project_id=self._project_id,
            actor=actor,
            action_id=action_id,
            feedback_id=feedback_id,
            target=target,
            context=context,
            intent=intent,
            occurred_at=self._at(occurred_at),
        )
        self._reject_duplicate(record.record_id)
        append_record(self._project_root, record)
        return record

    # --- write: lifecycle events -----------------------------------------

    def transition(
        self,
        *,
        actor: ActionActor,
        event_id: str,
        action_id: str,
        to_state: str,
        occurred_at: datetime | None = None,
    ) -> ActionRecord:
        """Move an Action to ``to_state`` if the transition is legal and fresh."""
        view = self._require_view(action_id)
        current = view.folded.lifecycle_state
        if is_terminal(current):
            raise ActionStateError(
                f"action {action_id!r} is terminal ({current}); no transition"
            )
        if not transition_allowed(current, to_state):
            raise ActionStateError(
                f"illegal transition {current} -> {to_state} for {action_id!r}"
            )
        if view.target_stale and to_state != "cancelled":
            raise StaleActionError(
                f"action {action_id!r} is stale ({view.stale_reason}); rebind before "
                "continuing (only 'cancelled' is allowed while stale)"
            )
        ts = self._at(occurred_at)
        self._reject_backdated(view, ts)
        record = build_transition_record(
            project_id=self._project_id,
            actor=actor,
            event_id=event_id,
            action_id=action_id,
            to_state=to_state,
            occurred_at=ts,
        )
        self._reject_duplicate(record.record_id)
        append_record(self._project_root, record)
        return record

    def record_handling(
        self,
        *,
        actor: ActionActor,
        event_id: str,
        action_id: str,
        execution_note: str,
        old_artifact: Mapping[str, JsonCompatibleValue] | None = None,
        new_artifact: Mapping[str, JsonCompatibleValue] | None = None,
        cost_change: Mapping[str, int] | None = None,
        occurred_at: datetime | None = None,
    ) -> ActionRecord:
        """Record who processed the Action, old/new artifacts, and cost change."""
        view = self._require_view(action_id)
        if is_terminal(view.folded.lifecycle_state):
            raise ActionStateError(
                f"action {action_id!r} is terminal; no handling record"
            )
        if view.target_stale:
            raise StaleActionError(
                f"action {action_id!r} is stale ({view.stale_reason}); rebind before "
                "recording handling"
            )
        ts = self._at(occurred_at)
        self._reject_backdated(view, ts)
        record = build_handling_record(
            project_id=self._project_id,
            actor=actor,
            event_id=event_id,
            action_id=action_id,
            execution_note=execution_note,
            old_artifact=old_artifact,
            new_artifact=new_artifact,
            cost_change=cost_change,
            occurred_at=ts,
        )
        self._reject_duplicate(record.record_id)
        append_record(self._project_root, record)
        return record

    def record_verification(
        self,
        *,
        actor: ActionActor,
        event_id: str,
        action_id: str,
        verdict: str,
        note: str,
        occurred_at: datetime | None = None,
    ) -> ActionRecord:
        """Record the user's verification (resolved/continue) from waiting_for_user."""
        if actor is not ActionActor.USER:
            raise ActionActorError(
                "verification is the user's; actor must be 'user' (ADR-0035)"
            )
        view = self._require_view(action_id)
        if view.folded.lifecycle_state != "waiting_for_user":
            raise ActionStateError(
                f"action {action_id!r} is {view.folded.lifecycle_state}; verification "
                "is only from 'waiting_for_user'"
            )
        if view.target_stale:
            raise StaleActionError(
                f"action {action_id!r} is stale ({view.stale_reason}); rebind before "
                "verifying"
            )
        ts = self._at(occurred_at)
        self._reject_backdated(view, ts)
        record = build_verification_record(
            project_id=self._project_id,
            actor=actor,
            event_id=event_id,
            action_id=action_id,
            verdict=verdict,
            note=note,
            occurred_at=ts,
        )
        self._reject_duplicate(record.record_id)
        append_record(self._project_root, record)
        return record

    def rebind(
        self,
        *,
        actor: ActionActor,
        event_id: str,
        action_id: str,
        target: Mapping[str, JsonCompatibleValue],
        occurred_at: datetime | None = None,
    ) -> ActionRecord:
        """Explicitly re-point an Action to a new current target; resets to pending."""
        view = self._require_view(action_id)
        if is_terminal(view.folded.lifecycle_state):
            raise ActionStateError(
                f"action {action_id!r} is terminal; create a new action instead of "
                "rebinding"
            )
        self._verify_target(target)
        ts = self._at(occurred_at)
        self._reject_backdated(view, ts)
        record = build_rebind_record(
            project_id=self._project_id,
            actor=actor,
            event_id=event_id,
            action_id=action_id,
            target=target,
            occurred_at=ts,
        )
        self._reject_duplicate(record.record_id)
        append_record(self._project_root, record)
        return record

    # --- read: raw + derived ---------------------------------------------

    def read(self) -> tuple[ActionRecord, ...]:
        return read_records(self._project_root)

    def read_feedback(self) -> tuple[FeedbackView, ...]:
        return self.feedback_views(self.read())

    def read_actions(self) -> tuple[ActionView, ...]:
        return self.action_views(self.read())

    def _own(self, records: tuple[ActionRecord, ...]) -> tuple[ActionRecord, ...]:
        """Keep only records belonging to THIS service's project_id.

        A project's log holds only its own records by construction (the write
        path stamps ``self._project_id``). Filtering defensively means an
        out-of-band foreign-project record placed in this log cannot be grouped
        by ``action_id`` into — and thereby alter — a local Action's derived
        state (cross-project integrity).
        """
        return tuple(r for r in records if r.project_id == self._project_id)

    def feedback_views(
        self, records: tuple[ActionRecord, ...]
    ) -> tuple[FeedbackView, ...]:
        """Derive feedback views from an already-read record set (pure)."""
        views: list[FeedbackView] = []
        for r in self._own(records):
            if r.record_type is ActionRecordType.FEEDBACK:
                stale, reason = self._target_stale(r.payload["target"])
                views.append(FeedbackView(r, stale, reason))
        return tuple(views)

    def action_views(self, records: tuple[ActionRecord, ...]) -> tuple[ActionView, ...]:
        """Derive folded Action views from an already-read record set (pure).

        Reading the log once and passing the records in lets the read-only query
        layer fail-close a corrupt log to a structured problem via its adapter
        without this method re-reading (and re-raising) it.

        An event is folded into an Action ONLY if it appears AFTER that Action's
        creation record in append order. The service always writes the creation
        first, so a legitimate event is always positioned after it; an
        out-of-band event pre-appended before (or without) the creation cannot
        forge the Action's initial derived state.
        """
        own = self._own(records)
        creation_index: dict[str, int] = {}
        for i, r in enumerate(own):
            if r.record_type is ActionRecordType.ACTION:
                creation_index.setdefault(r.payload["action_id"], i)
        events_by_action: dict[str, list[ActionRecord]] = {}
        for i, r in enumerate(own):
            if r.record_type not in _EVENT_TYPES:
                continue
            pos = creation_index.get(r.payload["action_id"])
            if pos is not None and i > pos:
                events_by_action.setdefault(r.payload["action_id"], []).append(r)
        views: list[ActionView] = []
        for r in own:
            if r.record_type is not ActionRecordType.ACTION:
                continue
            events = tuple(events_by_action.get(r.payload["action_id"], ()))
            views.append(self._view(r, events))
        return tuple(views)

    def get_action(self, action_id: str) -> ActionView | None:
        for view in self.read_actions():
            if view.folded.action_id == action_id:
                return view
        return None

    # --- internals -------------------------------------------------------

    def _view(
        self, action: ActionRecord, events: tuple[ActionRecord, ...]
    ) -> ActionView:
        folded = fold(action, list(events))
        stale, reason = self._target_stale(folded.effective_target)
        effective = (
            "stale"
            if stale and not is_terminal(folded.lifecycle_state)
            else folded.lifecycle_state
        )
        return ActionView(
            action=action,
            folded=folded,
            effective_state=effective,
            target_stale=stale,
            stale_reason=reason,
            events=events,
        )

    def _require_view(self, action_id: str) -> ActionView:
        view = self.get_action(action_id)
        if view is None:
            raise ReferenceValidationError(
                f"action_id {action_id!r} does not resolve to an action record"
            )
        return view

    def _feedback_exists(self, feedback_id: str) -> bool:
        for r in self._own(self.read()):
            if (
                r.record_type is ActionRecordType.FEEDBACK
                and r.payload["feedback_id"] == feedback_id
            ):
                return True
        return False

    def _at(self, occurred_at: datetime | None) -> datetime:
        return occurred_at if occurred_at is not None else self._clock()

    def _reject_duplicate(self, record_id: str) -> None:
        if any(r.record_id == record_id for r in self.read()):
            raise DuplicateRecordError(
                f"record_id {record_id!r} already exists; refusing to append a "
                "duplicate (the reader would silently ignore it)"
            )

    def _reject_backdated(self, view: ActionView, occurred_at: datetime) -> None:
        latest = view.action.occurred_at
        for e in view.events:
            if e.occurred_at > latest:
                latest = e.occurred_at
        if occurred_at < latest:
            raise ActionStateError(
                f"occurred_at {occurred_at.isoformat()} is before the action's "
                f"latest event {latest.isoformat()}; events must be appended in "
                "non-decreasing time order"
            )

    def _verify_target(self, target: Mapping[str, JsonCompatibleValue]) -> None:
        # Validate the target SHAPE first so malformed direct-API input (e.g.
        # {} or {"version": "x"}) is a controlled domain error, not an uncaught
        # KeyError/ValueError. build_* runs the full structural validation later;
        # here we only need well-typed ref/version/digest to index the resolver.
        if not isinstance(target, dict):
            raise FieldTypeError(f"target: expected dict, got {type(target).__name__}")
        ref = target.get("ref")
        version = target.get("version")
        digest = target.get("content_digest")
        if (
            not isinstance(ref, str)
            or isinstance(version, bool)
            or not isinstance(version, int)
            or not isinstance(digest, str)
        ):
            raise FieldTypeError(
                "target: expected {ref: str, version: int, content_digest: str}"
            )
        fact = self._resolver.resolve_target(
            self._project_root, ref=ref, version=version
        )
        if not fact.exists:
            raise StaleTargetError(
                f"target {ref!r} v{version} does not resolve to an authoritative "
                "fact; refusing to bind to a missing target"
            )
        if fact.content_digest != digest:
            raise StaleTargetError(
                f"target {ref!r} v{version} content_digest does not match the "
                "authoritative digest; refusing to bind to a wrong version"
            )

    def _target_stale(
        self, target: Mapping[str, JsonCompatibleValue]
    ) -> tuple[bool, str | None]:
        ref = target["ref"]
        version = target["version"]
        fact = self._resolver.resolve_target(
            self._project_root, ref=str(ref), version=int(version)
        )
        if not fact.exists:
            return True, f"target {ref!r} v{version} no longer resolves (missing)"
        if fact.content_digest != target["content_digest"]:
            return True, f"target {ref!r} v{version} content_digest drifted"
        return False, None


# The append-only lifecycle events an Action accumulates. Folded in APPEND (log)
# order — the order each was validated against the then-current state — never by
# caller-supplied occurred_at (which a backdated event could game). Monotonic
# occurred_at is enforced at write; append-position-after-creation is enforced in
# action_views so out-of-band events cannot forge state.
_EVENT_TYPES = frozenset(
    {
        ActionRecordType.TRANSITION,
        ActionRecordType.VERIFICATION,
        ActionRecordType.REBIND,
        ActionRecordType.HANDLING,
    }
)

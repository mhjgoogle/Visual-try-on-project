"""Action lifecycle state machine: pure fold + legal-transition table (ADR-0035).

The append-only log stores immutable facts; an Action's CURRENT lifecycle state
is DERIVED by folding its events in chronological order. This module holds that
fold and the legal-transition graph (the transition rules ADR-0035 left to
TASK-029), with no IO and no resolver — target staleness is overlaid by the
caller (service/query), which owns the authoritative-fact resolver.

State domain (ADR-0010 decision 7): these states never reuse workflow/approval/
Provider/reservation state. ``stale`` is a DERIVED overlay (target digest
drift), not a stored transition, so it never appears as a folded lifecycle
state — only as the effective state the service/query computes.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from ai_video_workflow.action.records import (
    ActionActor,
    ActionRecord,
    ActionRecordType,
)
from ai_video_workflow.manifest import JsonCompatibleValue

INITIAL_STATE = "pending"
TERMINAL_STATES = frozenset({"completed", "cancelled"})

# The legal explicit transitions (transition records). `stale` is never a
# target here (it is derived); `pending` is only re-entered via a rebind.
LEGAL_TRANSITIONS: dict[str, frozenset[str]] = {
    "pending": frozenset({"in_progress", "blocked", "cancelled"}),
    "in_progress": frozenset({"waiting_for_user", "completed", "blocked", "cancelled"}),
    "waiting_for_user": frozenset({"in_progress", "completed", "cancelled"}),
    "blocked": frozenset({"in_progress", "cancelled"}),
    "completed": frozenset(),
    "cancelled": frozenset(),
}

# A verification from `waiting_for_user` drives the loop's tail deterministically.
_VERIFICATION_TARGET = {"resolved": "completed", "continue": "in_progress"}


@dataclass(frozen=True, slots=True)
class FoldedAction:
    """The derived lifecycle view of one Action from its append-only events."""

    action_id: str
    feedback_id: str | None
    intent: str
    lifecycle_state: str
    effective_target: Mapping[str, JsonCompatibleValue]
    rebind_count: int


def fold(action: ActionRecord, events: list[ActionRecord]) -> FoldedAction:
    """Fold an Action's creation record + its append-ordered events into state.

    ``events`` are this Action's TRANSITION / VERIFICATION / REBIND / HANDLING
    records in append (log) order. Handling records carry no state change; a
    rebind resets the lifecycle to ``pending`` and re-points the effective
    target.

    The fold is DEFENSIVE, not trusting: each event is re-validated against the
    current derived state and an illegal one is IGNORED. So a schema-valid but
    state-illegal record appended out-of-band (bypassing the service via the
    low-level ``append_record`` API) can never forge a state or revive a
    terminal Action — WQ-16 always shows a legally reachable state. Legitimate
    service-written sequences pass these same checks and fold identically.
    """
    state = INITIAL_STATE
    target = action.payload["target"]
    rebinds = 0
    for e in events:
        if e.record_type is ActionRecordType.TRANSITION:
            to_state = e.payload["to_state"]
            if not is_terminal(state) and transition_allowed(state, to_state):
                state = to_state
        elif e.record_type is ActionRecordType.VERIFICATION:
            # verification is the USER's (ADR-0035 P5); a forged agent/system
            # verification appended out-of-band must not drive the loop's tail.
            if state == "waiting_for_user" and e.actor is ActionActor.USER:
                state = _VERIFICATION_TARGET[e.payload["verdict"]]
        elif e.record_type is ActionRecordType.REBIND:
            if not is_terminal(state):
                state = INITIAL_STATE
                target = e.payload["target"]
                rebinds += 1
        # HANDLING: evidence only, no state change
    return FoldedAction(
        action_id=action.payload["action_id"],
        feedback_id=action.payload["feedback_id"],
        intent=action.payload["intent"],
        lifecycle_state=state,
        effective_target=target,
        rebind_count=rebinds,
    )


def is_terminal(state: str) -> bool:
    return state in TERMINAL_STATES


def transition_allowed(current: str, to_state: str) -> bool:
    """Whether an explicit transition ``current -> to_state`` is legal."""
    return to_state in LEGAL_TRANSITIONS.get(current, frozenset())

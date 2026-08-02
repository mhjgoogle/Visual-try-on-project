"""Shared adapter helpers (TASK-025 / WSM1-A).

Each source adapter reads exactly one authoritative domain, declares the
schema versions it supports, and — on an unsupported version, a corrupt
source, or a missing required file — returns a structured ``Problem``
rather than raising or guessing (query contract §4, ADR-0031 decision 3).
Cross-domain composition happens only in the query layer, never here.
"""

from __future__ import annotations

from ai_video_workflow.workspace.envelope import Problem, ProblemCategory


def schema_supported(
    got: object,
    supported: frozenset[int],
    *,
    source: str,
    readiness_failed: bool = False,
    **context: str,
) -> Problem | None:
    """Return a ``schema_unsupported`` problem if ``got`` is not supported.

    ``got`` is the source document's ``schema_version``. An adapter that
    cannot parse a version it does not know must surface this and skip that
    document — never crash, never guess (query contract §6).
    """
    if isinstance(got, int) and not isinstance(got, bool) and got in supported:
        return None
    return Problem.of(
        ProblemCategory.SCHEMA_UNSUPPORTED,
        f"{source}: schema_version {got!r} not in supported {sorted(supported)}",
        source=source,
        readiness_failed=readiness_failed,
        **context,
    )


def corrupt(
    source: str, detail: str, *, readiness_failed: bool = True, **ctx
) -> Problem:
    """Build a ``source_corrupt`` problem (fail-closed by default)."""
    return Problem.of(
        ProblemCategory.SOURCE_CORRUPT,
        f"{source}: {detail}",
        source=source,
        readiness_failed=readiness_failed,
        **ctx,
    )

"""Read-only query result envelope and problem model (TASK-025 / WSM1-A).

Every workspace query returns a :class:`QueryResult` — a UI/DB-agnostic,
read-only value object. Its fields carry no physical serialization
commitment; the CLI/harness decides encoding. The three-way provenance
tagging (authoritative / derived / unavailable) and the structured
``problems`` list implement the query contract (workspace-query-contract.md
§1.3, §2, §4) and the observability requirements' fail-closed rules (§7).

Nothing in this module reads or writes files. It only shapes results.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Provenance(str, Enum):
    """Where a returned value comes from (query contract §1.3)."""

    AUTHORITATIVE = "authoritative"  # a unique writer's persisted fact
    DERIVED = "derived"  # deterministically recomputable (JPY, rollups, ...)
    UNAVAILABLE = "unavailable"  # WFM1 not-implemented or legacy-missing


class ProblemCategory(str, Enum):
    """Structured failure categories (query contract §4)."""

    MISSING_REF = "missing_ref"
    VERSION_ABSENT = "version_absent"
    DIGEST_MISMATCH = "digest_mismatch"
    ORPHAN_LINEAGE = "orphan_lineage"
    COST_UNRECONCILED = "cost_unreconciled"
    PROJECTION_CONFLICT = "projection_conflict"
    SCHEMA_UNSUPPORTED = "schema_unsupported"
    SOURCE_CORRUPT = "source_corrupt"
    NOT_FOUND = "not_found"


@dataclass(frozen=True, slots=True)
class Problem:
    """One structured, fail-closed problem bound to a locatable context.

    ``context`` locates the issue (project / stage / step / task /
    operation / object refs) as plain strings — never credential values,
    Authorization headers, private URLs, or raw responses (query contract
    §4, requirements §3.6). ``readiness_failed`` marks a problem that makes
    the whole readiness judgement fail (requirements §7).
    """

    category: ProblemCategory
    detail: str
    context: tuple[tuple[str, str], ...] = ()
    readiness_failed: bool = False

    @staticmethod
    def of(
        category: ProblemCategory,
        detail: str,
        *,
        readiness_failed: bool = False,
        **context: str,
    ) -> Problem:
        return Problem(
            category=category,
            detail=detail,
            context=tuple(sorted(context.items())),
            readiness_failed=readiness_failed,
        )


@dataclass(frozen=True, slots=True)
class Field:
    """One returned value tagged with its provenance."""

    value: object
    provenance: Provenance

    @staticmethod
    def authoritative(value: object) -> Field:
        return Field(value, Provenance.AUTHORITATIVE)

    @staticmethod
    def derived(value: object) -> Field:
        return Field(value, Provenance.DERIVED)

    @staticmethod
    def unavailable(reason: str = "out of WFM1 scope") -> Field:
        return Field(reason, Provenance.UNAVAILABLE)


@dataclass(frozen=True, slots=True)
class QueryResult:
    """The envelope every workspace query returns (query contract §2).

    ``items`` are plain read-only dicts of {name: Field}; the query decides
    their shape. ``markers`` are query-level flags (e.g. contains_unavailable,
    projection_conflict, readiness_failed). ``generated_at`` is a UTC ISO
    string supplied by the caller's clock (never wall-clock here, so results
    stay deterministic under a fixed clock).
    """

    query_id: str
    contract_version: str
    generated_at: str
    scope: dict[str, object]
    items: tuple[dict[str, Field], ...] = ()
    problems: tuple[Problem, ...] = ()
    markers: frozenset[str] = field(default_factory=frozenset)

    @property
    def readiness_failed(self) -> bool:
        return any(p.readiness_failed for p in self.problems)

    def with_markers(self) -> QueryResult:
        """Return a copy whose markers reflect its contents (idempotent)."""
        marks = set(self.markers)
        if any(
            f.provenance is Provenance.UNAVAILABLE
            for item in self.items
            for f in item.values()
        ):
            marks.add("contains_unavailable")
        if self.problems:
            marks.add("has_problems")
        if self.readiness_failed:
            marks.add("readiness_failed")
        if any(
            p.category is ProblemCategory.PROJECTION_CONFLICT for p in self.problems
        ):
            marks.add("projection_conflict")
        return QueryResult(
            query_id=self.query_id,
            contract_version=self.contract_version,
            generated_at=self.generated_at,
            scope=self.scope,
            items=self.items,
            problems=self.problems,
            markers=frozenset(marks),
        )


# The query contract's own version (workspace-query-contract.md §1.6, §6).
# Additive query/field changes bump the minor; removals/renames need a new
# ADR. WQ-01..WQ-14 are the frozen WSM1 baseline.
QUERY_CONTRACT_VERSION = "1.0"


def to_jsonable(result: QueryResult) -> dict:
    """Serialize a QueryResult to a plain JSON-compatible dict.

    This is the versioned read-only DTO boundary (TASK-025): each field
    keeps its provenance tag, problems keep their category/context, and
    markers are sorted for deterministic output. Nothing here is a physical
    storage schema — it is the read-only wire shape for CLI/tests/UI.
    """
    return {
        "query_id": result.query_id,
        "contract_version": result.contract_version,
        "generated_at": result.generated_at,
        "scope": result.scope,
        "items": [
            {
                name: {"value": f.value, "provenance": f.provenance.value}
                for name, f in item.items()
            }
            for item in result.items
        ],
        "problems": [
            {
                "category": p.category.value,
                "detail": p.detail,
                "context": dict(p.context),
                "readiness_failed": p.readiness_failed,
            }
            for p in result.problems
        ],
        "markers": sorted(result.markers),
        "readiness_failed": result.readiness_failed,
    }

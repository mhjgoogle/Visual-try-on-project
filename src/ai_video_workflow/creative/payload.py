"""Payload (载荷) continuity across the WFM2 creative chain (TASK-034).

Two fail-closed checks refining the baseline rule "一项主载荷、至多一项次载荷，
二者不得相同" and "一主至多一次载荷贯穿剧本、视听设计、QC 与评价引用":

- :func:`validate_load_pair` — the load declaration's primary is a known load,
  the optional secondary is a different known load.
- :func:`payload_threads` — the L0-03 load_declaration artifact is threaded, by
  digest-bound ``input_refs``, into the downstream artifacts that must carry the
  payload (S1-T05 load review, S1-T07 screenplay lock, S2-T07 AV design lock).
  Threading is verified on the authoritative lineage graph, not invented prose
  fields.
"""

from __future__ import annotations

from pathlib import Path

from ai_video_workflow.creative.errors import CreativeValidationError
from ai_video_workflow.creative.index import CreativeArtifact, artifacts_of_kind
from ai_video_workflow.planning.documents import PRIMARY_LOADS

# The artifacts whose catalog inputs directly consume the load declaration, so
# the primary payload is carried into the review and audiovisual design layers
# (stage, kind, step). Publish-time input binding (ADR-0037 lineage) makes these
# bindings mandatory; this query surfaces them for the read-only --payload check.
_PAYLOAD_CARRIERS: tuple[tuple[str, str, str], ...] = (
    ("s1", "load_review", "S1-T05"),
    ("s2", "visual_bible", "S2-T02"),
    ("s2", "cinematography_guide", "S2-T04"),
    ("s2", "audio_bible", "S2-T05"),
)

_LOAD_DECL = ("l0", "load_declaration", "L0-03")


def validate_load_pair(primary: object, secondary: object = None) -> None:
    """Fail closed unless (primary, secondary) is a legal load pair."""
    if primary not in PRIMARY_LOADS:
        raise CreativeValidationError(f"unknown primary load: {primary!r}")
    if secondary is not None:
        if secondary not in PRIMARY_LOADS:
            raise CreativeValidationError(f"unknown secondary load: {secondary!r}")
        if secondary == primary:
            raise CreativeValidationError(
                "secondary load must differ from the primary load"
            )


def _threaded(carrier: CreativeArtifact, source: CreativeArtifact) -> bool:
    """True if ``carrier`` binds the exact source stage+ref+version+digest."""
    return any(
        r.stage == source.stage
        and r.ref == source.ref
        and r.version == source.version
        and r.content_digest == source.content_digest
        for r in carrier.input_refs
    )


def payload_threads(
    project_root: Path,
    carriers: tuple[tuple[str, str, str], ...] = _PAYLOAD_CARRIERS,
) -> tuple[str, ...]:
    """Problems (empty == ok) with payload threading through ``carriers``.

    The load_declaration and carriers are resolved by KIND (a stable ref may
    differ from its kind). The declaration must be bound by input_refs into each
    present carrier; a missing carrier or an unthreaded one is reported.
    ``carriers`` defaults to the full chain; a lock may pass its own subset.
    """
    decls = artifacts_of_kind(project_root, *_LOAD_DECL)
    if not decls:
        return ("load_declaration (L0-03) has not been published",)
    if len(decls) > 1:
        return ("load_declaration is ambiguous: multiple artifacts published",)
    decl = decls[0]
    problems: list[str] = []
    for stage, kind, step_id in carriers:
        carrier_arts = artifacts_of_kind(project_root, stage, kind, step_id)
        if not carrier_arts:
            problems.append(f"{kind} ({stage.upper()}) has not been published")
            continue
        if not any(_threaded(c, decl) for c in carrier_arts):
            problems.append(
                f"{kind} ({stage.upper()}) does not bind the current "
                f"load_declaration v{decl.version} (payload not threaded)"
            )
    return tuple(problems)


def require_payload_threads(project_root: Path) -> None:
    problems = payload_threads(project_root)
    if problems:
        raise CreativeValidationError(
            "payload continuity failed: " + "; ".join(problems)
        )

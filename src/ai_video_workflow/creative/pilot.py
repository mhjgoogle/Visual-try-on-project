"""The three-representative-shot pilot gate (TASK-034).

The baseline requires that concept probing (L0-06) and audiovisual probing
(S2-T06) each produce three representative shots that pass content / visual /
cost (and consistency) checks before formal material production may begin
(baseline §11: 三个代表镜头未通过时不得进入正式素材制造). This module refines
that gate at the contract layer: a probe artifact must carry at least three
checklist items, all with a passing verdict — evidence recorded on the
authoritative index, not inferred from a Provider or a log. It does not run any
Provider or produce media (that is ADR-0038 / TASK-035).
"""

from __future__ import annotations

from pathlib import Path

from ai_video_workflow.creative.errors import CreativeValidationError
from ai_video_workflow.creative.index import (
    CreativeArtifact,
    artifacts_of_kind,
    load_artifact,
)

_PASS_VERDICTS: frozenset[str] = frozenset({"pass", "passed", "ok", "approved"})

# The three baseline representative shot classes (人物近景 / 中景 / 最难镜头) and
# the three dimensions each must clear (内容 / 视觉·一致性 / 成本). The gate
# requires a passing checklist item keyed ``<shot>:<dimension>`` for EVERY
# (shot, dimension) pair, so a single bare "pass" per class — or a shot that
# failed a required dimension — cannot unlock production (baseline §11 /
# L0-06 / S2-T06 completion conditions).
REPRESENTATIVE_SHOTS: tuple[str, ...] = ("character_closeup", "medium", "hardest")
REQUIRED_DIMENSIONS: tuple[str, ...] = ("content", "visual", "cost")


def _required_keys() -> set[str]:
    return {
        f"{shot}:{dim}" for shot in REPRESENTATIVE_SHOTS for dim in REQUIRED_DIMENSIONS
    }


def _cleared(artifact: CreativeArtifact) -> bool:
    """True if the probe clears every required <shot>:<dimension> check with no
    conflicting failing entry."""
    verdicts: dict[str, list[str]] = {}
    for c in artifact.checklist:
        verdicts.setdefault(c.item.strip().lower(), []).append(
            c.verdict.strip().lower()
        )
    return all(
        verdicts.get(key) and all(v in _PASS_VERDICTS for v in verdicts[key])
        for key in _required_keys()
    )


def _probe_problems(
    project_root: Path, stage: str, kind: str, step_id: str
) -> list[str]:
    # Resolve the probe by KIND (its stable ref may differ from its kind); at
    # least one probe of this kind must clear all representative-shot checks.
    probes = artifacts_of_kind(project_root, stage, kind, step_id)
    if not probes:
        return [f"{step_id} probe ({kind}) has not been published"]
    if any(_cleared(p) for p in probes):
        return []
    return [
        f"{step_id} probe has no representative shot set clearing all "
        "content/visual/cost checks (人物近景/中景/最难镜头)"
    ]


def concept_probe_problems(project_root: Path) -> tuple[str, ...]:
    return tuple(_probe_problems(project_root, "l0", "concept_probe", "L0-06"))


def visual_probe_problems(project_root: Path) -> tuple[str, ...]:
    return tuple(_probe_problems(project_root, "s2", "visual_probe", "S2-T06"))


def bound_probe_problems(
    project_root: Path,
    lock_art: CreativeArtifact,
    *,
    stage: str,
    kind: str,
    step_id: str,
) -> list[str]:
    """The SPECIFIC probe a lock binds (via its input_refs) must clear the gate.

    Checking a project-wide "any probe passes" would let a lock be admitted while
    the exact pilot evidence it references is failing, so validate the bound one.
    """
    for r in lock_art.input_refs:
        if r.stage != stage:
            continue
        probe = load_artifact(project_root, r.stage, r.ref, r.version)
        if probe.kind == kind and probe.step_id == step_id:
            if _cleared(probe):
                return []
            return [
                f"{step_id} pilot probe {r.ref!r} bound by the lock does not clear "
                "all representative-shot content/visual/cost checks"
            ]
    return [f"{step_id} probe is not bound by the lock"]


def pilot_gate_problems(project_root: Path) -> tuple[str, ...]:
    """All problems blocking entry to formal production (empty == ready)."""
    return concept_probe_problems(project_root) + visual_probe_problems(project_root)


def require_pilot_gate(project_root: Path) -> None:
    problems = pilot_gate_problems(project_root)
    if problems:
        raise CreativeValidationError(
            "three-representative-shot pilot gate not passed: " + "; ".join(problems)
        )

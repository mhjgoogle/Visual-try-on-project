"""Vendor-neutral provider selection resolver (TASK-014 contract 2).

Resolves, for one shot, which provider is the *primary* and which (if
any) is the *fallback*, from the project config's ``default_provider``,
``shot_overrides``, and ``fallback_provider``.

The required **capability** and **model_id** are supplied *by the task*,
not fixed to any one capability: WFM1 image-to-video is only the common
case. The chosen primary provider must exist in the locked catalog,
advertise the requested capability, and offer the requested model. The
fallback (if any) must exist and advertise the same capability; its own
model is resolved when a real fallback occurs, not here.

This layer returns a neutral *description* of the choice. It does not
construct or call a provider, read a credential, look up a price, or
touch the orchestrator.

Provider binding is immutable: once a GenerationTask has a durable
provider binding (formed on first successful PREPARE, TASK-007), a
different provider for that shot must go through ``create-redo-task`` (a
new task), never a mutated binding. The fallback is a **failure-only**
switch — it must never be used to bypass an approval or budget denial.
"""

from __future__ import annotations

from dataclasses import dataclass

from ai_video_workflow.config._parsing import require_str
from ai_video_workflow.config.catalog import ProviderCatalog, ProviderEntry
from ai_video_workflow.config.errors import SelectionError
from ai_video_workflow.config.project_config import ProjectConfig


@dataclass(frozen=True, slots=True)
class ProviderSelection:
    """The resolved provider choice for one shot.

    ``fallback_provider_id`` is ``None`` when the project declares no
    fallback, or when a shot override makes the primary equal to the
    configured fallback (a provider cannot fall back to itself).
    ``source`` records where the primary came from: ``"override"`` or
    ``"default"``.
    """

    shot_id: str
    capability: str
    primary_provider_id: str
    primary_model_id: str
    fallback_provider_id: str | None
    source: str


def resolve_provider_selection(
    config: ProjectConfig,
    catalog: ProviderCatalog,
    shot_id: str,
    *,
    capability: str,
    model_id: str,
) -> ProviderSelection:
    """Resolve the primary and fallback provider for ``shot_id``.

    ``capability`` and ``model_id`` are the task's requirements.
    """
    require_str(shot_id, "shot_id", SelectionError)
    require_str(capability, "capability", SelectionError)
    require_str(model_id, "model_id", SelectionError)

    if shot_id in config.shot_overrides:
        primary = config.shot_overrides[shot_id]
        source = "override"
    else:
        primary = config.default_provider
        source = "default"
    primary_entry = _require_capable(catalog, primary, capability, "primary provider")
    _require_model(primary_entry, model_id, "primary provider")

    fallback = config.fallback_provider
    if fallback is not None:
        _require_capable(catalog, fallback, capability, "fallback provider")
        if fallback == primary:
            # An override can point a shot at the configured fallback; a
            # provider cannot fall back to itself, so there is no distinct
            # backup for this shot.
            fallback = None

    return ProviderSelection(
        shot_id=shot_id,
        capability=capability,
        primary_provider_id=primary,
        primary_model_id=model_id,
        fallback_provider_id=fallback,
        source=source,
    )


def _require_capable(
    catalog: ProviderCatalog, provider_id: str, capability: str, role: str
) -> ProviderEntry:
    entry = catalog.providers.get(provider_id)
    if entry is None:
        raise SelectionError(f"{role} {provider_id!r} is not in the catalog")
    if capability not in entry.capabilities:
        raise SelectionError(
            f"{role} {provider_id!r} lacks the {capability!r} capability"
        )
    return entry


def _require_model(entry: ProviderEntry, model_id: str, role: str) -> None:
    if model_id not in entry.models:
        raise SelectionError(
            f"{role} {entry.provider_id!r} has no model {model_id!r} in the catalog"
        )

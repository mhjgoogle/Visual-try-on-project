"""Provider registry / factory (TASK-016).

Builds a ``VideoProvider`` from a provider id plus its catalog entry. The
registry itself is vendor-neutral — it holds a registration table of
``provider_id -> factory``; the concrete vendor knowledge lives in each
factory. Building an unregistered provider id fails **closed** (so the
CLI can never silently fall back to the manual provider for an unknown
id). Credentials are never read here; each factory wires only the
credential *env var name* from the catalog into its provider.
"""

from __future__ import annotations

from collections.abc import Callable

from ai_video_workflow.config.catalog import ProviderEntry
from ai_video_workflow.providers.base import VideoProvider
from ai_video_workflow.providers.cloud_minimax import (
    MINIMAX_PROVIDER_ID,
    MinimaxVideoProvider,
    RealMinimaxTransport,
)
from ai_video_workflow.providers.errors import ProviderError
from ai_video_workflow.providers.manual import ManualVideoProvider

ProviderFactory = Callable[[ProviderEntry], VideoProvider]


class ProviderRegistryError(ProviderError):
    """Raised when a provider id cannot be built from the registry."""


class ProviderRegistry:
    """A registration table mapping provider ids to provider factories."""

    __slots__ = ("_factories",)

    def __init__(self) -> None:
        self._factories: dict[str, ProviderFactory] = {}

    def register(self, provider_id: str, factory: ProviderFactory) -> None:
        if not isinstance(provider_id, str) or not provider_id:
            raise ProviderRegistryError("provider_id: expected a non-empty string")
        self._factories[provider_id] = factory

    def known(self) -> frozenset[str]:
        return frozenset(self._factories)

    def build(self, provider_id: str, entry: ProviderEntry) -> VideoProvider:
        factory = self._factories.get(provider_id)
        if factory is None:
            raise ProviderRegistryError(
                f"no provider registered for id {provider_id!r}; "
                f"known: {sorted(self._factories)}"
            )
        provider = factory(entry)
        if provider.provider_id != provider_id:
            raise ProviderRegistryError(
                f"provider factory for {provider_id!r} built a provider with id "
                f"{provider.provider_id!r}"
            )
        return provider


def _first_credential_env_var(entry: ProviderEntry) -> str:
    if not entry.credential_env_vars:
        raise ProviderRegistryError(
            f"provider {entry.provider_id!r} declares no credential env var"
        )
    return entry.credential_env_vars[0]


def default_registry() -> ProviderRegistry:
    """Return a registry with the built-in providers (manual + MiniMax).

    The MiniMax factory wires the real HTTP transport, which is opt-in and
    refuses to run until its endpoint is configured — so constructing the
    default registry never performs a real paid call.
    """
    registry = ProviderRegistry()
    registry.register("manual", lambda entry: ManualVideoProvider())
    registry.register(
        MINIMAX_PROVIDER_ID,
        lambda entry: MinimaxVideoProvider(
            transport=RealMinimaxTransport(),
            credential_env_var=_first_credential_env_var(entry),
            provider_id=entry.provider_id,
        ),
    )
    return registry

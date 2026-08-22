"""Tests for the provider registry / factory (TASK-016)."""

from __future__ import annotations

import pytest

from ai_video_workflow.config.catalog import ProviderEntry
from ai_video_workflow.providers.cloud_minimax import MinimaxVideoProvider
from ai_video_workflow.providers.manual import ManualVideoProvider
from ai_video_workflow.providers.registry import (
    ProviderRegistry,
    ProviderRegistryError,
    default_registry,
)

_MANUAL_ENTRY = ProviderEntry(
    provider_id="manual",
    display_name="Manual",
    capabilities=("image_to_video",),
    credential_env_vars=(),
    models={},
)
_MINIMAX_ENTRY = ProviderEntry(
    provider_id="minimax",
    display_name="MiniMax",
    capabilities=("image_to_video",),
    credential_env_vars=("WFM1_MINIMAX_API_KEY",),
    models={},
)


def test_default_registry_builds_manual() -> None:
    provider = default_registry().build("manual", _MANUAL_ENTRY)
    assert isinstance(provider, ManualVideoProvider)
    assert provider.provider_id == "manual"


def test_default_registry_builds_minimax() -> None:
    provider = default_registry().build("minimax", _MINIMAX_ENTRY)
    assert isinstance(provider, MinimaxVideoProvider)
    assert provider.provider_id == "minimax"


def test_unknown_provider_fails_closed() -> None:
    with pytest.raises(ProviderRegistryError, match="no provider registered"):
        default_registry().build("ghost", _MANUAL_ENTRY)


def test_minimax_without_credential_env_var_rejected() -> None:
    entry = ProviderEntry(
        provider_id="minimax",
        display_name="MiniMax",
        capabilities=("image_to_video",),
        credential_env_vars=(),
        models={},
    )
    with pytest.raises(ProviderRegistryError, match="requires credential_env_vars"):
        default_registry().build("minimax", entry)


def test_minimax_wrong_credential_env_var_rejected() -> None:
    entry = ProviderEntry(
        provider_id="minimax",
        display_name="MiniMax",
        capabilities=("image_to_video",),
        credential_env_vars=("SOME_OTHER_SECRET",),
        models={},
    )
    with pytest.raises(ProviderRegistryError, match="requires credential_env_vars"):
        default_registry().build("minimax", entry)


def test_id_mismatch_rejected() -> None:
    registry = ProviderRegistry()
    registry.register(
        "claims-a",
        lambda entry: ManualVideoProvider(),  # builds id "manual"
    )
    with pytest.raises(ProviderRegistryError, match="built a provider with id"):
        registry.build("claims-a", _MANUAL_ENTRY)


def test_known_lists_registered() -> None:
    assert default_registry().known() == frozenset({"manual", "minimax"})

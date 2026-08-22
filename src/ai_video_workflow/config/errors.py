"""Typed errors for the vendor-neutral configuration layer (TASK-B1).

All configuration failures are ``AiVideoWorkflowError`` subclasses so
callers keep the project's existing typed-error discipline; no bare
exceptions leak out of the loaders or the creation-time writer.
"""

from __future__ import annotations

from ai_video_workflow.errors import AiVideoWorkflowError


class ConfigError(AiVideoWorkflowError):
    """Base error for the WFM1 configuration layer."""


class CatalogConfigError(ConfigError):
    """Raised when the global provider catalog is missing or invalid."""


class ProjectConfigError(ConfigError):
    """Raised when a project-level WFM1 config is missing or invalid."""


class SelectionError(ConfigError):
    """Raised when a provider selection cannot be resolved against the catalog."""


class CatalogLockError(ConfigError):
    """Raised when the on-disk catalog does not match a project's locked
    catalog id / version / content digest (price-drift protection)."""

"""Vendor-neutral WFM1 configuration layer (TASK-014/TASK-015).

Public API:

- global provider catalog: id + version, capabilities, models, prices,
  billing rules, and credential *environment-variable names* (no
  endpoints, no secrets);
- catalog lock: resolve a project's locked catalog by id and verify
  version + content digest (no price drift);
- per-project config: provider selection, yen budgets, locked FX, and
  the locked catalog id/version/digest;
- typed errors under ``AiVideoWorkflowError``.

Consumers (selection resolver, budget layer) read these structures only;
nothing here constructs a provider, reads a credential value, emits a
QCD event, or writes business state.
"""

from __future__ import annotations

from ai_video_workflow.config.catalog import (
    CATALOG_SCHEMA_VERSION,
    ClipPrice,
    ModelCatalogEntry,
    ProviderCatalog,
    ProviderEntry,
    compute_catalog_digest,
    load_catalog,
    parse_catalog,
)
from ai_video_workflow.config.catalog_lock import (
    catalog_filename,
    load_locked_catalog,
)
from ai_video_workflow.config.errors import (
    CatalogConfigError,
    CatalogLockError,
    ConfigError,
    ProjectConfigError,
    SelectionError,
)
from ai_video_workflow.config.project_config import (
    PROJECT_CONFIG_RELPATH,
    PROJECT_CONFIG_SCHEMA_VERSION,
    BudgetsJpy,
    FxConfig,
    ProjectConfig,
    load_project_config,
    parse_project_config,
    write_project_config,
)
from ai_video_workflow.config.selection import (
    ProviderSelection,
    resolve_provider_selection,
)

__all__ = [
    "CATALOG_SCHEMA_VERSION",
    "PROJECT_CONFIG_RELPATH",
    "PROJECT_CONFIG_SCHEMA_VERSION",
    "BudgetsJpy",
    "CatalogConfigError",
    "CatalogLockError",
    "ClipPrice",
    "ConfigError",
    "FxConfig",
    "ModelCatalogEntry",
    "ProjectConfig",
    "ProjectConfigError",
    "ProviderCatalog",
    "ProviderEntry",
    "ProviderSelection",
    "SelectionError",
    "catalog_filename",
    "compute_catalog_digest",
    "load_catalog",
    "load_locked_catalog",
    "load_project_config",
    "parse_catalog",
    "parse_project_config",
    "resolve_provider_selection",
    "write_project_config",
]

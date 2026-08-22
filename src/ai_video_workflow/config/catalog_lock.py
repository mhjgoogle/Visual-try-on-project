"""Locked catalog resolution: id + version + digest, no drift (TASK-015).

A project locks the exact catalog it was priced against by
``catalog_id`` + ``catalog_version`` + ``catalog_digest`` (see
``project_config``). This module resolves the catalog **by id** from a
fixed catalog directory (never an arbitrary project-supplied path) and
verifies its version and content digest match the lock. Any mismatch —
a bumped version, an edited price, a swapped file — fails **closed** with
``CatalogLockError``, so prices can never drift underneath a project.
"""

from __future__ import annotations

import json
from pathlib import Path

from ai_video_workflow.config.catalog import (
    ProviderCatalog,
    compute_catalog_digest,
    parse_catalog,
)
from ai_video_workflow.config.errors import CatalogConfigError, CatalogLockError
from ai_video_workflow.config.project_config import ProjectConfig
from ai_video_workflow.security.paths import PathEscapeError, resolve_within_root


def catalog_filename(catalog_id: str) -> str:
    """Return the on-disk filename for a catalog id."""
    return f"{catalog_id}.json"


def load_locked_catalog(config: ProjectConfig, catalog_dir: Path) -> ProviderCatalog:
    """Load the catalog the project locked, verifying id/version/digest.

    ``catalog_dir`` is the fixed directory holding published catalogs
    (e.g. ``config/providers``); the file is addressed by the project's
    locked ``catalog_id`` alone. Version or digest mismatch raises
    ``CatalogLockError``.
    """
    filename = catalog_filename(config.catalog_id)
    # Admit the filename through the containment resolver so a crafted id
    # cannot escape the catalog directory.
    try:
        path = resolve_within_root(catalog_dir, filename)
    except PathEscapeError as exc:
        raise CatalogLockError(
            f"invalid catalog id {config.catalog_id!r}: {exc}"
        ) from exc

    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise CatalogLockError(
            f"locked catalog {config.catalog_id!r} not found at {path}"
        ) from exc
    except (OSError, UnicodeError) as exc:
        raise CatalogLockError(f"unable to read catalog: {path}") from exc
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise CatalogLockError(f"catalog is not valid JSON: {path}") from exc

    digest = compute_catalog_digest(raw)
    try:
        catalog = parse_catalog(raw)
    except CatalogConfigError as exc:
        raise CatalogLockError(f"catalog {path} is invalid: {exc}") from exc

    if catalog.catalog_id != config.catalog_id:
        raise CatalogLockError(
            f"catalog id mismatch: file has {catalog.catalog_id!r}, "
            f"project locked {config.catalog_id!r}"
        )
    if catalog.version != config.catalog_version:
        raise CatalogLockError(
            f"catalog version mismatch for {config.catalog_id!r}: file is "
            f"v{catalog.version}, project locked v{config.catalog_version}"
        )
    if digest != config.catalog_digest:
        raise CatalogLockError(
            f"catalog digest mismatch for {config.catalog_id!r} "
            f"v{config.catalog_version}: content has drifted since it was locked"
        )
    return catalog

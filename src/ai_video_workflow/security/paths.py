"""Project-root containment and symlink admission (ADR-0004).

Every durable read/write path and every path handed to an external tool
(ffprobe / ffmpeg) must be constructed through ``resolve_within_root``
instead of a bare ``project_root / relative`` join. The resolver refuses
absolute paths, ``..`` components, any *existing* symlinked component
below the project root, and any target whose resolved location escapes
the resolved project root. It returns the un-resolved
``project_root / relative`` join so callers keep their existing
``mkdir`` / atomic-publish logic unchanged — the check is admission
only, never a rewrite of the write location.
"""

from __future__ import annotations

from pathlib import Path

from ai_video_workflow.errors import AiVideoWorkflowError


class PathEscapeError(AiVideoWorkflowError):
    """Raised when a relative path is not safely contained in the root."""


def resolve_within_root(project_root: Path, relative: str | Path) -> Path:
    """Return ``project_root / relative`` after containment/symlink checks.

    Raises ``PathEscapeError`` if ``relative`` is absolute, contains a
    ``..`` component, traverses an existing symlinked component below the
    root, or resolves outside the resolved project root.
    """
    rel = Path(relative)
    if rel.is_absolute():
        raise PathEscapeError(f"path must be relative, not absolute: {relative}")
    if any(part == ".." for part in rel.parts):
        raise PathEscapeError(f"path must not contain '..': {relative}")

    target = project_root / rel
    # Reject any existing symlinked component *below* the project root.
    # Components that do not exist yet are fine (they will be created as
    # real directories/files); the project root's own ancestors are not
    # our concern (the root itself may legitimately live under a symlink).
    current = project_root
    for part in rel.parts:
        current = current / part
        if current.is_symlink():
            raise PathEscapeError(f"symlinked path component is not allowed: {current}")

    root_real = project_root.resolve()
    target_real = target.resolve()
    if target_real != root_real and root_real not in target_real.parents:
        raise PathEscapeError(f"path resolves outside the project root: {relative}")
    return target

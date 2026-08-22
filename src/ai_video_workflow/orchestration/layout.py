"""Deterministic state-path derivation and path safety (§8.1/§8.3).

`_LayoutResolver` derives the four state target paths for one task from
an explicit project data root and validates path safety: lexical
containment inside the root, per-component symlink resolution that must
not escape the root, and a whole-directory protection boundary that
rejects any local artifact comparison path equal to or under the four
protected state directories. It performs no filesystem mutation: only
component-level ``lstat`` and controlled ``resolve`` are used, never
``open``, ``mkdir``, writes, or directory scanning. Directory creation
and file I/O belong to the executor (Step F).
"""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.errors import FieldTypeError
from ai_video_workflow.orchestration.errors import (
    InvalidOrchestrationInputError,
    PersistenceExecutionError,
)
from ai_video_workflow.validation import validate_stable_id

_TASK_RECORD_DIR = ("records", "generation-tasks")
_MANIFEST_DIR = ("manifests",)
_ORCHESTRATION_RECORD_DIR = ("records", "orchestration")
_INSTRUCTION_DIR = ("tasks", "instructions")

_PROTECTED_STATE_DIRS = (
    _TASK_RECORD_DIR,
    _MANIFEST_DIR,
    _ORCHESTRATION_RECORD_DIR,
    _INSTRUCTION_DIR,
)


@dataclass(frozen=True, slots=True)
class _StateLayout:
    """The four derived, root-contained state target paths for one task."""

    project_root: Path
    task_id: str
    task_path: Path
    manifest_path: Path
    record_path: Path
    instruction_path: Path

    def targets(self) -> tuple[Path, Path, Path, Path]:
        """Return the four state target paths in a fixed order."""
        return (
            self.task_path,
            self.manifest_path,
            self.record_path,
            self.instruction_path,
        )


class _LayoutResolver:
    """Pure path-deriving and path-safety component (no I/O mutation)."""

    __slots__ = ("_project_root",)

    def __init__(self, project_root: str | Path) -> None:
        self._project_root = _normalize_root(project_root)

    @property
    def project_root(self) -> Path:
        """Return the absolutized, lexically normalized project root."""
        return self._project_root

    def resolve_state_layout(self, task_id: str) -> _StateLayout:
        """Derive and safety-check the four state target paths.

        Path names are derived from the validated single-component
        task_id; every target must be lexically inside the root, the
        four targets must be mutually distinct, and no existing symlink
        on any target may resolve outside the project root.
        """
        validated = _validate_task_id(task_id)
        task_path = self._derive(_TASK_RECORD_DIR, f"{validated}.json")
        manifest_path = self._derive(_MANIFEST_DIR, f"generation-{validated}.json")
        record_path = self._derive(_ORCHESTRATION_RECORD_DIR, f"{validated}.json")
        instruction_path = self._derive(_INSTRUCTION_DIR, f"{validated}.md")
        targets = (task_path, manifest_path, record_path, instruction_path)
        if len({str(target) for target in targets}) != len(targets):
            raise InvalidOrchestrationInputError(
                "state layout: derived target paths are not mutually distinct"
            )
        real_root = self._resolve_for_safety(self._project_root)
        for target in targets:
            resolved = self._resolve_for_safety(target)
            if not _is_within_or_equal(resolved, real_root):
                raise PersistenceExecutionError(
                    "state target: an existing symlink resolves outside the "
                    "project root"
                )
        return _StateLayout(
            project_root=self._project_root,
            task_id=validated,
            task_path=task_path,
            manifest_path=manifest_path,
            record_path=record_path,
            instruction_path=instruction_path,
        )

    def resolve_local_artifact_comparison(
        self,
        reference: str,
        *,
        is_local: bool,
    ) -> Path | None:
        """Return the safe comparison path for a local artifact, or None.

        Non-local references are never given a local-directory judgement
        and return None. For a local reference the comparison path is
        computed with per-component ``lstat``/controlled ``resolve`` and
        is rejected only when it equals or falls under any of the four
        protected state directories.

        Interpretation of the "escapes the allowed root" re-check
        (§8.3 rule 4): the sole rejection condition enforced here is
        collision with a protected state directory. A comparison path
        that resolves outside the project root is not itself a
        collision and is returned (consistent with absolute references
        pointing outside the root); because both the comparison path
        and the protected directories are resolved through the same
        controlled per-component walk, this does not weaken state
        directory protection. The §8.3 wording will be reconciled in
        the Step E docs-sync round.
        """
        if type(is_local) is not bool:
            raise FieldTypeError(
                f"is_local: expected bool, got {type(is_local).__name__}"
            )
        if not is_local:
            return None
        if type(reference) is not str:
            raise FieldTypeError(
                f"reference: expected string, got {type(reference).__name__}"
            )
        if not reference or reference.isspace():
            raise InvalidOrchestrationInputError(
                "reference: local artifact reference must not be empty"
            )
        if "\x00" in reference:
            raise InvalidOrchestrationInputError(
                "reference: must not contain a NUL character"
            )
        if os.path.isabs(reference):
            start = Path(reference)
        else:
            start = self._project_root / reference
        comparison = self._resolve_for_safety(start)
        for forbidden in self._forbidden_state_dirs():
            if _is_within_or_equal(comparison, forbidden):
                raise PersistenceExecutionError(
                    "artifact comparison path equals or falls under a "
                    "protected state directory"
                )
        return comparison

    def _derive(self, subdir: tuple[str, ...], file_name: str) -> Path:
        target = self._project_root.joinpath(*subdir, file_name)
        if not _is_strictly_within(target, self._project_root):
            raise InvalidOrchestrationInputError(
                "state target: derived path escapes the project root"
            )
        return target

    def _forbidden_state_dirs(self) -> tuple[Path, ...]:
        return tuple(
            self._resolve_for_safety(self._project_root.joinpath(*subdir))
            for subdir in _PROTECTED_STATE_DIRS
        )

    def _resolve_for_safety(self, path: Path) -> Path:
        """Return the per-component resolved real path.

        Each component is inspected in order (never pre-collapsed
        lexically): ``.`` is skipped, ``..`` steps to the resolved
        real parent, existing components are ``lstat``-ed and existing
        symlinks are resolved via controlled ``resolve`` before any
        later ``..`` applies, and the first nonexistent component
        onward is lexically normalized against the resolved real
        parent. Any existing component that cannot be safely inspected
        (permission errors, symlink loops) causes a conservative
        rejection.
        """
        parts = path.parts
        current = Path(parts[0])
        trailing = list(parts[1:])
        index = 0
        while index < len(trailing):
            part = trailing[index]
            if part == ".":
                index += 1
                continue
            if part == "..":
                current = current.parent
                index += 1
                continue
            candidate = current / part
            try:
                mode = os.lstat(candidate).st_mode
            except FileNotFoundError:
                remaining = trailing[index:]
                return Path(os.path.normpath(str(current.joinpath(*remaining))))
            except (OSError, RuntimeError) as exc:
                raise PersistenceExecutionError(
                    "path safety: an existing path component could not be "
                    "safely resolved"
                ) from exc
            if stat.S_ISLNK(mode):
                try:
                    current = candidate.resolve()
                except (OSError, RuntimeError) as exc:
                    raise PersistenceExecutionError(
                        "path safety: a symlink component could not be safely resolved"
                    ) from exc
            else:
                current = candidate
            index += 1
        return current


def _normalize_root(project_root: str | Path) -> Path:
    if isinstance(project_root, Path):
        raw = str(project_root)
    elif type(project_root) is str:
        raw = project_root
    else:
        raise FieldTypeError(
            f"project_root: expected str or Path, got {type(project_root).__name__}"
        )
    if not raw or raw.isspace():
        raise InvalidOrchestrationInputError("project_root: must not be empty")
    if "\x00" in raw:
        raise InvalidOrchestrationInputError(
            "project_root: must not contain a NUL character"
        )
    if not os.path.isabs(raw):
        raise InvalidOrchestrationInputError(
            "project_root: must be an absolute path (no working-directory "
            "default is applied)"
        )
    return Path(os.path.normpath(raw))


def _validate_task_id(task_id: str) -> str:
    validate_stable_id(task_id, field_name="task_id")
    if "\x00" in task_id:
        raise InvalidOrchestrationInputError(
            "task_id: must not contain a NUL character"
        )
    if "/" in task_id or "\\" in task_id:
        raise InvalidOrchestrationInputError(
            "task_id: must not contain a path separator"
        )
    if task_id in (".", ".."):
        raise InvalidOrchestrationInputError(
            "task_id: must not be a relative path component"
        )
    if os.path.isabs(task_id) or os.path.basename(task_id) != task_id:
        raise InvalidOrchestrationInputError(
            "task_id: must be a single relative path component"
        )
    return task_id


def _is_strictly_within(path: Path, root: Path) -> bool:
    path_parts = path.parts
    root_parts = root.parts
    return (
        len(path_parts) > len(root_parts)
        and path_parts[: len(root_parts)] == root_parts
    )


def _is_within_or_equal(path: Path, ancestor: Path) -> bool:
    path_parts = path.parts
    ancestor_parts = ancestor.parts
    return path_parts[: len(ancestor_parts)] == ancestor_parts

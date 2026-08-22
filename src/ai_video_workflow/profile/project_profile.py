"""Project instance profile: versioned creative-goal baseline (TASK-018).

One immutable JSON document per profile version at
``profile/project_profile_v<N>.json`` (ADR-0011). The profile captures a
single episode's runtime parameters and creative goals — genre,
audience, duration, aspect ratio, language, style, release targets, the
budget reference, intent, narrative goals, the quality bar, forbidden
issues, and success criteria — as a closed-key schema with a canonical
content digest, so ``(version, digest)`` is a precise baseline for later
evaluation.

Profiles are entirely optional: no existing M1/WFM1 flow reads them, so
a project without any profile keeps working unchanged. A revision is a
NEW version file; existing versions are never overwritten.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.digests import config_digest
from ai_video_workflow.errors import OverwriteRefusedError
from ai_video_workflow.profile.errors import ProfileError, ProfileNotFoundError
from ai_video_workflow.security.paths import resolve_within_root

PROFILE_DIR = "profile"
PROFILE_SCHEMA_VERSION = 1

_KEYS = frozenset(
    {
        "schema_version",
        "version",
        "title",
        "genre",
        "audience",
        "duration_target_seconds",
        "aspect_ratio",
        "language",
        "visual_style",
        "release_targets",
        "budget_ref",
        "intent",
        "narrative_goals",
        "quality_bar",
        "forbidden_issues",
        "success_criteria",
    }
)
_PROFILE_FILE_RE = re.compile(r"^project_profile_v([1-9][0-9]*)\.json$")


@dataclass(frozen=True, slots=True)
class ProjectProfile:
    """One immutable project instance profile version."""

    schema_version: int
    version: int
    title: str
    genre: str
    audience: str
    duration_target_seconds: int
    aspect_ratio: str
    language: str
    visual_style: str
    release_targets: tuple[str, ...]
    budget_ref: str
    intent: str
    narrative_goals: tuple[str, ...]
    quality_bar: tuple[str, ...]
    forbidden_issues: tuple[str, ...]
    success_criteria: tuple[str, ...]


def profile_relpath(version: int) -> str:
    """Return the project-relative path of one profile version."""
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ProfileError("version: expected a positive int")
    return f"{PROFILE_DIR}/project_profile_v{version}.json"


def parse_project_profile(raw: object) -> ProjectProfile:
    """Build a ``ProjectProfile`` from already-parsed JSON data."""
    if not isinstance(raw, dict):
        raise ProfileError(f"profile: expected a JSON object, got {type(raw).__name__}")
    actual = frozenset(raw)
    missing = _KEYS - actual
    if missing:
        raise ProfileError(f"profile: missing keys {sorted(missing)}")
    unknown = actual - _KEYS
    if unknown:
        raise ProfileError(f"profile: unknown keys {sorted(unknown)}")

    schema_version = _require_int(raw["schema_version"], "schema_version", minimum=1)
    if schema_version != PROFILE_SCHEMA_VERSION:
        raise ProfileError(f"profile: unsupported version {schema_version}")

    return ProjectProfile(
        schema_version=schema_version,
        version=_require_int(raw["version"], "version", minimum=1),
        title=_require_str(raw["title"], "title"),
        genre=_require_str(raw["genre"], "genre"),
        audience=_require_str(raw["audience"], "audience"),
        duration_target_seconds=_require_int(
            raw["duration_target_seconds"], "duration_target_seconds", minimum=1
        ),
        aspect_ratio=_require_str(raw["aspect_ratio"], "aspect_ratio"),
        language=_require_str(raw["language"], "language"),
        visual_style=_require_str(raw["visual_style"], "visual_style"),
        release_targets=_require_str_tuple(raw["release_targets"], "release_targets"),
        budget_ref=_require_str(raw["budget_ref"], "budget_ref"),
        intent=_require_str(raw["intent"], "intent"),
        narrative_goals=_require_str_tuple(raw["narrative_goals"], "narrative_goals"),
        quality_bar=_require_str_tuple(raw["quality_bar"], "quality_bar"),
        forbidden_issues=_require_str_tuple(
            raw["forbidden_issues"], "forbidden_issues", allow_empty=True
        ),
        success_criteria=_require_str_tuple(
            raw["success_criteria"], "success_criteria"
        ),
    )


def profile_to_dict(profile: ProjectProfile) -> dict:
    return {
        "schema_version": profile.schema_version,
        "version": profile.version,
        "title": profile.title,
        "genre": profile.genre,
        "audience": profile.audience,
        "duration_target_seconds": profile.duration_target_seconds,
        "aspect_ratio": profile.aspect_ratio,
        "language": profile.language,
        "visual_style": profile.visual_style,
        "release_targets": list(profile.release_targets),
        "budget_ref": profile.budget_ref,
        "intent": profile.intent,
        "narrative_goals": list(profile.narrative_goals),
        "quality_bar": list(profile.quality_bar),
        "forbidden_issues": list(profile.forbidden_issues),
        "success_criteria": list(profile.success_criteria),
    }


def profile_digest(profile: ProjectProfile) -> str:
    """Canonical content digest; ``(version, digest)`` is the goal baseline."""
    return config_digest(profile_to_dict(profile))


def write_project_profile(project_root: Path, profile: ProjectProfile) -> Path:
    """Publish one immutable profile version; refuse to overwrite."""
    path = resolve_within_root(project_root, profile_relpath(profile.version))
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (
        json.dumps(
            profile_to_dict(profile),
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")
    _atomic_create(path, payload, "project profile")
    return path


def load_project_profile(
    project_root: Path, version: int | None = None
) -> ProjectProfile:
    """Load one profile version (default: the highest on disk).

    Raises ``ProfileNotFoundError`` when the project has no profile —
    profiles are optional and their absence never breaks other flows.
    """
    if version is None:
        version = _highest_version(project_root)
        if version is None:
            raise ProfileNotFoundError(
                f"project has no profile versions: {project_root}"
            )
    path = resolve_within_root(project_root, profile_relpath(version))
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ProfileNotFoundError(f"no profile version {version}: {path}") from exc
    except (OSError, UnicodeError) as exc:
        raise ProfileError(f"unable to read profile: {path}") from exc
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise ProfileError(f"profile is not valid JSON: {path}") from exc
    profile = parse_project_profile(raw)
    if profile.version != version:
        raise ProfileError(
            f"profile file {path.name} declares version {profile.version}"
        )
    return profile


def _highest_version(project_root: Path) -> int | None:
    directory = resolve_within_root(project_root, PROFILE_DIR)
    if not directory.is_dir():
        return None
    versions = [
        int(match.group(1))
        for path in directory.iterdir()
        if (match := _PROFILE_FILE_RE.match(path.name)) is not None
    ]
    return max(versions) if versions else None


# --- helpers ---------------------------------------------------------------


def _atomic_create(path: Path, payload: bytes, what: str) -> None:
    raw_fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(raw_fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(tmp, path)
        except FileExistsError as exc:
            raise OverwriteRefusedError(
                f"refusing to overwrite existing {what}: {path}"
            ) from exc
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _require_str(value: object, name: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ProfileError(f"profile: {name} must be a non-empty, trimmed string")
    return value


def _require_int(value: object, name: str, *, minimum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ProfileError(f"profile: {name} must be an int >= {minimum}")
    return value


def _require_str_tuple(
    value: object, name: str, *, allow_empty: bool = False
) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise ProfileError(f"profile: {name} must be a JSON array")
    if not value and not allow_empty:
        raise ProfileError(f"profile: {name} must not be empty")
    items = tuple(_require_str(item, f"{name}[]") for item in value)
    if len(set(items)) != len(items):
        raise ProfileError(f"profile: {name} must not contain duplicates")
    return items

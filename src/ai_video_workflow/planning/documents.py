"""L0–S3 planning documents and prompt versions (TASK-020, ADR-0012).

Immutable, versioned JSON documents under ``planning/``:

- ``brief_v<N>.json`` — logline + a single primary payload (at most one
  secondary), per the workflow spec's L0 rules;
- ``story_v<N>.json`` — beat structure (creative long-form text stays in
  Markdown referenced by relpath);
- ``shot_plan_v<N>.json`` — the ordered 6–10 shot plan (~60s total) with
  per-shot prompt references and generation parameters;
- ``prompts/<prompt_id>/v<N>.json`` — immutable prompt versions with a
  previous-version link and a change reason (prompts are never
  overwritten into a single "latest value").

Documents are human-authored (the creative layer stays human in WFM1);
this module validates, publishes (create-only), and loads them.
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
from ai_video_workflow.planning.errors import PlanningError
from ai_video_workflow.security.paths import resolve_within_root

PLANNING_DIR = "planning"
PLANNING_SCHEMA_VERSION = 1

PRIMARY_LOADS = frozenset({"人性光辉", "放松之笑", "唯美", "精妙叹服"})

MIN_SHOTS = 6
MAX_SHOTS = 10
MIN_TOTAL_SECONDS = 45
MAX_TOTAL_SECONDS = 75

_BRIEF_KEYS = frozenset(
    {
        "schema_version",
        "version",
        "logline",
        "primary_load",
        "secondary_load",
        "synopsis",
    }
)
_STORY_KEYS = frozenset({"schema_version", "version", "beats", "screenplay_md"})
_BEAT_KEYS = frozenset({"beat_id", "description"})
_PLAN_KEYS = frozenset({"schema_version", "version", "shots"})
_PLAN_SHOT_KEYS = frozenset(
    {
        "shot_id",
        "sequence",
        "prompt_ref",
        "duration_seconds",
        "resolution",
        "capability",
        "model_id",
        "width",
        "height",
        "frame_rate",
        "reuse_assets",
        "first_frame_image",
    }
)
_PROMPT_KEYS = frozenset(
    {
        "schema_version",
        "prompt_id",
        "version",
        "text",
        "previous_version",
        "change_reason",
        "reference_assets",
    }
)
_VERSION_FILE_RE = re.compile(r"_v([1-9][0-9]*)\.json$")


@dataclass(frozen=True, slots=True)
class PromptVersion:
    """One immutable prompt version with its lineage."""

    schema_version: int
    prompt_id: str
    version: int
    text: str
    previous_version: int | None
    change_reason: str | None
    reference_assets: tuple[str, ...]

    @property
    def digest(self) -> str:
        return config_digest(prompt_to_dict(self))


@dataclass(frozen=True, slots=True)
class PlannedShot:
    """One shot row of the shot plan."""

    shot_id: str
    sequence: int
    prompt_id: str
    prompt_version: int
    duration_seconds: int
    resolution: str
    capability: str
    model_id: str
    width: int
    height: int
    frame_rate: float
    reuse_assets: tuple[str, ...]
    first_frame_image: str | None


@dataclass(frozen=True, slots=True)
class ShotPlan:
    """One immutable shot-plan version."""

    schema_version: int
    version: int
    shots: tuple[PlannedShot, ...]

    @property
    def total_duration_seconds(self) -> int:
        return sum(shot.duration_seconds for shot in self.shots)


# --- generic versioned publish/load -----------------------------------------


def _publish(project_root: Path, relpath: str, payload_dict: dict) -> Path:
    path = resolve_within_root(project_root, relpath)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (
        json.dumps(
            payload_dict,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")
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
                f"refusing to overwrite existing planning document: {path}"
            ) from exc
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    return path


def _load_json(project_root: Path, relpath: str, what: str) -> object:
    path = resolve_within_root(project_root, relpath)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise PlanningError(f"{what} does not exist: {path}") from exc
    except (OSError, UnicodeError) as exc:
        raise PlanningError(f"unable to read {what}: {path}") from exc
    try:
        return json.loads(text)
    except ValueError as exc:
        raise PlanningError(f"{what} is not valid JSON: {path}") from exc


def _highest_version(project_root: Path, directory: str, prefix: str) -> int | None:
    base = resolve_within_root(project_root, directory)
    if not base.is_dir():
        return None
    versions = [
        int(match.group(1))
        for path in base.iterdir()
        if path.name.startswith(prefix)
        and (match := _VERSION_FILE_RE.search(path.name)) is not None
    ]
    return max(versions) if versions else None


# --- brief -------------------------------------------------------------------


def parse_brief(raw: object) -> dict:
    data = _require_object(raw, _BRIEF_KEYS, "brief")
    _require_schema_version(data, "brief")
    _require_positive_int(data["version"], "brief.version")
    _require_text(data["logline"], "brief.logline")
    _require_text(data["synopsis"], "brief.synopsis")
    primary = data["primary_load"]
    if primary not in PRIMARY_LOADS:
        raise PlanningError(f"brief.primary_load: unknown load {primary!r}")
    secondary = data["secondary_load"]
    if secondary is not None:
        if secondary not in PRIMARY_LOADS:
            raise PlanningError(f"brief.secondary_load: unknown load {secondary!r}")
        if secondary == primary:
            raise PlanningError("brief.secondary_load: must differ from primary")
    return data


def publish_brief(project_root: Path, raw: object) -> Path:
    data = parse_brief(raw)
    return _publish(project_root, f"{PLANNING_DIR}/brief_v{data['version']}.json", data)


def load_brief(project_root: Path, version: int | None = None) -> dict:
    if version is None:
        version = _highest_version(project_root, PLANNING_DIR, "brief_v")
        if version is None:
            raise PlanningError(f"project has no brief: {project_root}")
    return parse_brief(
        _load_json(project_root, f"{PLANNING_DIR}/brief_v{version}.json", "brief")
    )


# --- story -------------------------------------------------------------------


def parse_story(raw: object) -> dict:
    data = _require_object(raw, _STORY_KEYS, "story")
    _require_schema_version(data, "story")
    _require_positive_int(data["version"], "story.version")
    beats = data["beats"]
    if not isinstance(beats, list) or not beats:
        raise PlanningError("story.beats: expected a non-empty array")
    seen = set()
    for beat in beats:
        entry = _require_object(beat, _BEAT_KEYS, "story.beats[]")
        _require_text(entry["beat_id"], "story.beats[].beat_id")
        _require_text(entry["description"], "story.beats[].description")
        if entry["beat_id"] in seen:
            raise PlanningError(f"story.beats: duplicate {entry['beat_id']!r}")
        seen.add(entry["beat_id"])
    md = data["screenplay_md"]
    if md is not None:
        _require_text(md, "story.screenplay_md")
        if md.startswith("/") or ".." in md.split("/"):
            raise PlanningError("story.screenplay_md: must be a relative path")
    return data


def publish_story(project_root: Path, raw: object) -> Path:
    data = parse_story(raw)
    return _publish(project_root, f"{PLANNING_DIR}/story_v{data['version']}.json", data)


def load_story(project_root: Path, version: int | None = None) -> dict:
    if version is None:
        version = _highest_version(project_root, PLANNING_DIR, "story_v")
        if version is None:
            raise PlanningError(f"project has no story: {project_root}")
    return parse_story(
        _load_json(project_root, f"{PLANNING_DIR}/story_v{version}.json", "story")
    )


# --- shot plan ----------------------------------------------------------------


def parse_shot_plan(raw: object) -> ShotPlan:
    data = _require_object(raw, _PLAN_KEYS, "shot plan")
    _require_schema_version(data, "shot plan")
    version = _require_positive_int(data["version"], "shot plan.version")
    entries = data["shots"]
    if not isinstance(entries, list):
        raise PlanningError("shot plan.shots: expected an array")
    if not MIN_SHOTS <= len(entries) <= MAX_SHOTS:
        raise PlanningError(
            f"shot plan: expected {MIN_SHOTS}-{MAX_SHOTS} shots, got {len(entries)}"
        )
    shots: list[PlannedShot] = []
    seen_ids: set[str] = set()
    for entry in entries:
        row = _require_object(entry, _PLAN_SHOT_KEYS, "shot plan.shots[]")
        shot_id = _require_text(row["shot_id"], "shots[].shot_id")
        if shot_id in seen_ids:
            raise PlanningError(f"shot plan: duplicate shot {shot_id!r}")
        seen_ids.add(shot_id)
        prompt_ref = _require_object(
            row["prompt_ref"], frozenset({"prompt_id", "version"}), "prompt_ref"
        )
        first_frame = row["first_frame_image"]
        if first_frame is not None:
            _require_first_frame(first_frame)
        reuse = row["reuse_assets"]
        if not isinstance(reuse, list) or not all(
            isinstance(item, str) and item for item in reuse
        ):
            raise PlanningError("shots[].reuse_assets: expected string array")
        shots.append(
            PlannedShot(
                shot_id=shot_id,
                sequence=_require_positive_int(row["sequence"], "shots[].sequence"),
                prompt_id=_require_text(prompt_ref["prompt_id"], "prompt_id"),
                prompt_version=_require_positive_int(
                    prompt_ref["version"], "prompt_ref.version"
                ),
                duration_seconds=_require_positive_int(
                    row["duration_seconds"], "shots[].duration_seconds"
                ),
                resolution=_require_text(row["resolution"], "shots[].resolution"),
                capability=_require_text(row["capability"], "shots[].capability"),
                model_id=_require_text(row["model_id"], "shots[].model_id"),
                width=_require_positive_int(row["width"], "shots[].width"),
                height=_require_positive_int(row["height"], "shots[].height"),
                frame_rate=_require_positive_number(
                    row["frame_rate"], "shots[].frame_rate"
                ),
                reuse_assets=tuple(reuse),
                first_frame_image=first_frame,
            )
        )
    sequences = sorted(shot.sequence for shot in shots)
    if sequences != list(range(1, len(shots) + 1)):
        raise PlanningError("shot plan: sequences must be 1..N without gaps")
    plan = ShotPlan(
        schema_version=PLANNING_SCHEMA_VERSION, version=version, shots=tuple(shots)
    )
    total = plan.total_duration_seconds
    if not MIN_TOTAL_SECONDS <= total <= MAX_TOTAL_SECONDS:
        raise PlanningError(
            f"shot plan: total duration {total}s outside "
            f"{MIN_TOTAL_SECONDS}-{MAX_TOTAL_SECONDS}s"
        )
    return plan


def shot_plan_to_dict(plan: ShotPlan) -> dict:
    return {
        "schema_version": plan.schema_version,
        "version": plan.version,
        "shots": [
            {
                "shot_id": shot.shot_id,
                "sequence": shot.sequence,
                "prompt_ref": {
                    "prompt_id": shot.prompt_id,
                    "version": shot.prompt_version,
                },
                "duration_seconds": shot.duration_seconds,
                "resolution": shot.resolution,
                "capability": shot.capability,
                "model_id": shot.model_id,
                "width": shot.width,
                "height": shot.height,
                "frame_rate": shot.frame_rate,
                "reuse_assets": list(shot.reuse_assets),
                "first_frame_image": shot.first_frame_image,
            }
            for shot in plan.shots
        ],
    }


def publish_shot_plan(project_root: Path, raw: object) -> Path:
    plan = parse_shot_plan(raw)
    return _publish(
        project_root,
        f"{PLANNING_DIR}/shot_plan_v{plan.version}.json",
        shot_plan_to_dict(plan),
    )


def load_shot_plan(project_root: Path, version: int | None = None) -> ShotPlan:
    if version is None:
        version = _highest_version(project_root, PLANNING_DIR, "shot_plan_v")
        if version is None:
            raise PlanningError(f"project has no shot plan: {project_root}")
    return parse_shot_plan(
        _load_json(
            project_root, f"{PLANNING_DIR}/shot_plan_v{version}.json", "shot plan"
        )
    )


# --- prompts -------------------------------------------------------------------


def parse_prompt(raw: object) -> PromptVersion:
    data = _require_object(raw, _PROMPT_KEYS, "prompt")
    _require_schema_version(data, "prompt")
    prompt_id = _require_safe_component(data["prompt_id"], "prompt.prompt_id")
    version = _require_positive_int(data["version"], "prompt.version")
    text = _require_text(data["text"], "prompt.text")
    previous = data["previous_version"]
    if previous is not None:
        previous = _require_positive_int(previous, "prompt.previous_version")
        if previous >= version:
            raise PlanningError("prompt.previous_version: must be earlier")
    reason = data["change_reason"]
    if previous is not None and (not isinstance(reason, str) or not reason):
        raise PlanningError(
            "prompt.change_reason: required when previous_version is set"
        )
    if previous is None and reason is not None:
        raise PlanningError(
            "prompt.change_reason: only allowed with a previous_version"
        )
    refs = data["reference_assets"]
    if not isinstance(refs, list) or not all(
        isinstance(item, str) and item for item in refs
    ):
        raise PlanningError("prompt.reference_assets: expected string array")
    return PromptVersion(
        schema_version=PLANNING_SCHEMA_VERSION,
        prompt_id=prompt_id,
        version=version,
        text=text,
        previous_version=previous,
        change_reason=reason if previous is not None else None,
        reference_assets=tuple(refs),
    )


def prompt_to_dict(prompt: PromptVersion) -> dict:
    return {
        "schema_version": prompt.schema_version,
        "prompt_id": prompt.prompt_id,
        "version": prompt.version,
        "text": prompt.text,
        "previous_version": prompt.previous_version,
        "change_reason": prompt.change_reason,
        "reference_assets": list(prompt.reference_assets),
    }


def publish_prompt(project_root: Path, raw: object) -> Path:
    prompt = parse_prompt(raw)
    if prompt.previous_version is not None:
        # lineage must point at a really-published earlier version
        load_prompt(project_root, prompt.prompt_id, prompt.previous_version)
    return _publish(
        project_root,
        f"{PLANNING_DIR}/prompts/{prompt.prompt_id}/v{prompt.version}.json",
        prompt_to_dict(prompt),
    )


def load_prompt(project_root: Path, prompt_id: str, version: int) -> PromptVersion:
    _require_safe_component(prompt_id, "prompt_id")
    prompt = parse_prompt(
        _load_json(
            project_root,
            f"{PLANNING_DIR}/prompts/{prompt_id}/v{version}.json",
            "prompt version",
        )
    )
    if prompt.prompt_id != prompt_id or prompt.version != version:
        raise PlanningError(
            f"prompt file declares ({prompt.prompt_id!r}, v{prompt.version}), "
            f"expected ({prompt_id!r}, v{version})"
        )
    return prompt


# --- helpers -------------------------------------------------------------------


def _require_object(raw: object, keys: frozenset[str], what: str) -> dict:
    if not isinstance(raw, dict):
        raise PlanningError(f"{what}: expected a JSON object")
    actual = frozenset(raw)
    missing = keys - actual
    if missing:
        raise PlanningError(f"{what}: missing keys {sorted(missing)}")
    unknown = actual - keys
    if unknown:
        raise PlanningError(f"{what}: unknown keys {sorted(unknown)}")
    return raw


def _require_schema_version(data: dict, what: str) -> None:
    value = data["schema_version"]
    if value != PLANNING_SCHEMA_VERSION:
        raise PlanningError(f"{what}: unsupported schema_version {value!r}")


def _require_text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise PlanningError(f"{name}: expected a non-empty, trimmed string")
    return value


def _require_positive_int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise PlanningError(f"{name}: expected a positive int")
    return value


def _require_positive_number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise PlanningError(f"{name}: expected a positive number")
    return float(value)


def _require_safe_component(value: object, name: str) -> str:
    text = _require_text(value, name)
    if "/" in text or "\\" in text or text in (".", "..") or text.startswith("."):
        raise PlanningError(f"{name}: {text!r} is not a safe path component")
    return text


_MAX_FIRST_FRAME_DATA_URL = 8 * 1024 * 1024


def _require_first_frame(value: object) -> str:
    # same trust rule as the paid coordinator: public http(s) URL or a
    # bounded inline image data URL; local paths are never passed through.
    if not isinstance(value, str) or not value:
        raise PlanningError("first_frame_image: expected a non-empty string")
    if value.startswith(("http://", "https://")):
        return value
    if value.startswith("data:image/"):
        if len(value) > _MAX_FIRST_FRAME_DATA_URL:
            raise PlanningError("first_frame_image: data URL too large")
        return value
    raise PlanningError(
        "first_frame_image: must be a public http(s) URL or an image data URL"
    )

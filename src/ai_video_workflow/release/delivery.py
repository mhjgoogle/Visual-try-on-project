"""S4–S7 minimal QC, release packaging, and archive (TASK-022, ADR-0012).

The WFM1 minimal subset of the workflow spec's S4–S7:

- **technical QC** (``qc/technical_qc_v<N>.json``): machine-derived facts
  from existing validation/composition outputs — final MP4 present,
  composition report present, every registered asset's media present,
  every source task's latest validation passed. Idempotent: identical
  facts reuse the latest version.
- **final review** (``qc/final_review_v<N>.json``): the HUMAN verdict,
  bound to the exact final MP4 digest and the exact project-goals
  baseline (profile version + digest). AI input may only ever be marked
  as assistance; the verdict is the user's.
- **release package** (``release/release_v<N>.json``): an offline-
  checkable manifest referencing (never copying) the final MP4 with its
  digest, plus metadata from the profile and the QC/review provenance.
  Gated on a passing, digest-fresh final review.
- **archive** (``archive/archive_manifest_v<N>.json`` +
  ``archive/postmortem_v<N>.json``): a digest-locked inventory of the
  episode's key artifacts and a postmortem DERIVED from the QCD events
  (recomputable, never a second source of cost truth). Audio/subtitles
  are explicitly recorded as out of WFM1 scope, not faked as done.

Everything is versioned, immutable, containment-checked JSON; nothing
here deletes history, copies cost facts, or touches M1 outputs.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from ai_video_workflow.digests import config_digest, file_sha256
from ai_video_workflow.profile.project_profile import (
    load_project_profile,
    profile_digest,
)
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.qcd.aggregation import aggregate_events
from ai_video_workflow.qcd.log import read_events
from ai_video_workflow.release.errors import ArchiveError, QcError, ReleaseError
from ai_video_workflow.security.paths import resolve_within_root

QC_SCHEMA_VERSION = 1
RELEASE_SCHEMA_VERSION = 1
ARCHIVE_SCHEMA_VERSION = 1

_V_RE = re.compile(r"_v([1-9][0-9]*)\.json$")
_FINAL_RE = re.compile(r"^final_v([1-9][0-9]*)\.mp4$")


# --- shared versioned-doc helpers -------------------------------------------


def _publish_new_version(
    project_root: Path, directory: str, prefix: str, content: dict
) -> tuple[int, Path]:
    version = (_latest_version(project_root, directory, prefix) or 0) + 1
    payload = {**content, "version": version}
    relpath = f"{directory}/{prefix}_v{version}.json"
    path = resolve_within_root(project_root, relpath)
    path.parent.mkdir(parents=True, exist_ok=True)
    import os
    import tempfile

    raw_fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(raw_fd, "wb") as stream:
            stream.write(
                (
                    json.dumps(
                        payload,
                        ensure_ascii=False,
                        sort_keys=True,
                        indent=2,
                        allow_nan=False,
                    )
                    + "\n"
                ).encode("utf-8")
            )
            stream.flush()
            os.fsync(stream.fileno())
        os.link(tmp, path)  # create-only: versions are immutable
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    return version, path


def _latest_version(project_root: Path, directory: str, prefix: str) -> int | None:
    base = resolve_within_root(project_root, directory)
    if not base.is_dir():
        return None
    versions = [
        int(match.group(1))
        for path in base.iterdir()
        if path.name.startswith(prefix) and (match := _V_RE.search(path.name))
    ]
    return max(versions) if versions else None


def _load_version(
    project_root: Path, directory: str, prefix: str, version: int, error_type
) -> dict:
    path = resolve_within_root(project_root, f"{directory}/{prefix}_v{version}.json")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise error_type(f"{prefix} v{version} does not exist") from exc
    except (OSError, ValueError) as exc:
        raise error_type(f"{prefix} v{version} is unreadable: {exc}") from exc
    if not isinstance(raw, dict):
        raise error_type(f"{prefix} v{version} is not a JSON object")
    return raw


def _content_digest_without_version(doc: dict) -> str:
    return config_digest({k: v for k, v in doc.items() if k != "version"})


def _publish_idempotent(
    project_root: Path, directory: str, prefix: str, content: dict, error_type
) -> tuple[int, bool]:
    """Publish a version, reusing the latest if the content is identical."""
    latest = _latest_version(project_root, directory, prefix)
    new_digest = _content_digest_without_version(content)
    if latest is not None:
        existing = _load_version(project_root, directory, prefix, latest, error_type)
        if _content_digest_without_version(existing) == new_digest:
            return latest, False
    version, _ = _publish_new_version(project_root, directory, prefix, content)
    return version, True


def latest_final_output(project_root: Path) -> tuple[int, str] | None:
    outputs = resolve_within_root(project_root, "outputs")
    if not outputs.is_dir():
        return None
    best: tuple[int, str] | None = None
    for path in outputs.iterdir():
        match = _FINAL_RE.match(path.name)
        if match is not None:
            version = int(match.group(1))
            if best is None or version > best[0]:
                best = (version, f"outputs/{path.name}")
    return best


# --- S6 technical QC ---------------------------------------------------------


def run_technical_qc(project_root: Path, data: ProjectData) -> dict:
    """Derive the technical QC facts and publish them (idempotent)."""
    checks: list[dict] = []

    final = latest_final_output(project_root)
    checks.append(
        {
            "check_id": "final_output_present",
            "passed": final is not None,
            "detail": final[1] if final else "no outputs/final_v<N>.mp4",
        }
    )
    if final is not None:
        report_rel = f"reports/composition/final_v{final[0]}.json"
        report_ok = resolve_within_root(project_root, report_rel).is_file()
        checks.append(
            {
                "check_id": "composition_report_present",
                "passed": report_ok,
                "detail": report_rel,
            }
        )

    for asset in data.video_assets:
        media_ok = resolve_within_root(project_root, str(asset.path)).is_file()
        checks.append(
            {
                "check_id": "asset_media_present",
                "passed": media_ok,
                "detail": f"{asset.asset_id}: {asset.path}",
            }
        )
        validation_version = _latest_version(
            project_root, "reports/validation", asset.source_task_id
        )
        passed = False
        if validation_version is not None:
            report = _load_version(
                project_root,
                "reports/validation",
                asset.source_task_id,
                validation_version,
                QcError,
            )
            passed = report.get("passed") is True
        checks.append(
            {
                "check_id": "validation_passed",
                "passed": passed,
                "detail": f"{asset.source_task_id} v{validation_version}",
            }
        )

    # WFM1 scope statement: not faked as done, explicitly unavailable
    checks.append(
        {
            "check_id": "audio_subtitles",
            "passed": True,
            "detail": "out of WFM1 scope (video-only acceptance); not implemented",
        }
    )

    content = {
        "schema_version": QC_SCHEMA_VERSION,
        "checks": checks,
        "passed": all(c["passed"] for c in checks),
        "final_output": final[1] if final else None,
    }
    version, created = _publish_idempotent(
        project_root, "qc", "technical_qc", content, QcError
    )
    return {**content, "version": version, "created": created}


# --- S6 human final review ----------------------------------------------------


def record_final_review(
    project_root: Path,
    *,
    verdict: str,
    by: str,
    at: str,
    decision_reason: str,
    issue_tags: tuple[str, ...] = (),
    compared_versions: tuple[str, ...] = (),
    ai_assisted: bool = False,
) -> dict:
    """Record the human final-review verdict, bound to exact digests."""
    if verdict not in ("pass", "fail"):
        raise QcError(f"verdict must be 'pass' or 'fail', got {verdict!r}")
    if not by or not decision_reason:
        raise QcError("final review requires 'by' and a decision_reason")
    final = latest_final_output(project_root)
    if final is None:
        raise QcError("no final output to review; run compose first")
    final_digest = file_sha256(resolve_within_root(project_root, final[1]))
    profile = load_project_profile(project_root)  # goals baseline is REQUIRED
    content = {
        "schema_version": QC_SCHEMA_VERSION,
        "verdict": verdict,
        "by": by,
        "at": at,
        "decision_reason": decision_reason,
        "issue_tags": list(issue_tags),
        "compared_versions": list(compared_versions),
        "ai_assisted": bool(ai_assisted),
        "target": {"ref": final[1], "content_digest": final_digest},
        "profile_ref": {
            "version": profile.version,
            "content_digest": profile_digest(profile),
        },
    }
    version, _ = _publish_new_version(project_root, "qc", "final_review", content)
    return {**content, "version": version}


# --- S6 release package --------------------------------------------------------


def package_release(project_root: Path) -> dict:
    """Produce the offline-checkable release manifest (gated, idempotent)."""
    qc_version = _latest_version(project_root, "qc", "technical_qc")
    if qc_version is None:
        raise ReleaseError("no technical QC; run qc-run first")
    technical = _load_version(
        project_root, "qc", "technical_qc", qc_version, ReleaseError
    )
    if technical.get("passed") is not True:
        raise ReleaseError("technical QC did not pass; release is blocked")

    review_version = _latest_version(project_root, "qc", "final_review")
    if review_version is None:
        raise ReleaseError("no final review; release requires the human verdict")
    review = _load_version(
        project_root, "qc", "final_review", review_version, ReleaseError
    )
    if review.get("verdict") != "pass":
        raise ReleaseError("final review verdict is not 'pass'; release blocked")

    final = latest_final_output(project_root)
    if final is None:
        raise ReleaseError("no final output present")
    final_digest = file_sha256(resolve_within_root(project_root, final[1]))
    target = review.get("target") or {}
    if target.get("ref") != final[1] or target.get("content_digest") != final_digest:
        raise ReleaseError(
            "the approved final review is bound to different final media; "
            "re-review before packaging (stale approval never releases)"
        )

    profile = load_project_profile(project_root)
    content = {
        "schema_version": RELEASE_SCHEMA_VERSION,
        "final_mp4": {"ref": final[1], "content_digest": final_digest},
        "metadata": {
            "title": profile.title,
            "language": profile.language,
            "aspect_ratio": profile.aspect_ratio,
            "duration_target_seconds": profile.duration_target_seconds,
        },
        "cover_placeholder": None,
        "created_from": {
            "composition_version": final[0],
            "technical_qc_version": qc_version,
            "final_review_version": review_version,
            "profile_version": profile.version,
        },
    }
    version, created = _publish_idempotent(
        project_root, "release", "release", content, ReleaseError
    )
    return {**content, "version": version, "created": created}


# --- S7 archive + postmortem ----------------------------------------------------


_ARCHIVE_GLOBS = (
    "outputs/final_v*.mp4",
    "release/release_v*.json",
    "qc/technical_qc_v*.json",
    "qc/final_review_v*.json",
    "profile/project_profile_v*.json",
    "profile/reuse_refs.json",
    "planning/brief_v*.json",
    "planning/story_v*.json",
    "planning/shot_plan_v*.json",
    "planning/packets/*.json",
    "approval/*.json",
)


def archive_project(project_root: Path, data: ProjectData) -> dict:
    """Digest-locked archive inventory + a QCD-derived postmortem."""
    if _latest_version(project_root, "release", "release") is None:
        raise ArchiveError("no release package; archive after packaging")

    references: list[dict] = []
    for pattern in _ARCHIVE_GLOBS:
        directory, _, name = pattern.rpartition("/")
        base = resolve_within_root(project_root, directory or ".")
        if not base.is_dir():
            continue
        for path in sorted(base.glob(name)):
            if not path.is_file():
                continue
            rel = f"{directory}/{path.name}" if directory else path.name
            references.append({"ref": rel, "content_digest": file_sha256(path)})
    manifest_content = {
        "schema_version": ARCHIVE_SCHEMA_VERSION,
        "references": references,
    }
    manifest_version, _ = _publish_idempotent(
        project_root, "archive", "archive_manifest", manifest_content, ArchiveError
    )

    events = read_events(project_root)
    summary = aggregate_events(events, data=data)
    occurred = [e.occurred_at for e in events]
    postmortem_content = {
        "schema_version": ARCHIVE_SCHEMA_VERSION,
        "derived_from": "qcd-event-log (recomputable; not a second source)",
        "cost_by_currency": dict(summary.per_project.cost_by_currency),
        "event_count": summary.event_count,
        "task_count": len(summary.per_task),
        "validation_failures": sum(
            1
            for e in events
            if e.event_type.value == "validation_completed"
            and e.payload.get("passed") is False
        ),
        "redo_tasks": sum(
            1
            for e in events
            if e.event_type.value == "task_created"
            and e.payload.get("origin") == "redo"
        ),
        "first_event_at": min(occurred).isoformat() if occurred else None,
        "last_event_at": max(occurred).isoformat() if occurred else None,
        "reconciliation_gaps": len(summary.reconciliation),
        "reuse_suggestions": [],  # human-curated; the final judgement is the user's
        "out_of_scope": ["audio", "subtitles", "publishing platforms"],
    }
    postmortem_version, _ = _publish_idempotent(
        project_root, "archive", "postmortem", postmortem_content, ArchiveError
    )
    return {
        "archive_manifest_version": manifest_version,
        "postmortem_version": postmortem_version,
        "references": len(references),
        "postmortem": {**postmortem_content, "version": postmortem_version},
    }

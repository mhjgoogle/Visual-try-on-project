"""Deterministic validation-report rendering: JSON fact source + Markdown.

Pure rendering only (no IO): the JSON dict is the fact source with a
fixed key set and ``report_schema_version``; the Markdown is a
deterministic human-readable view. Byte-level publishing (no-replace,
reuse-if-equal, conflict) is handled by the step via ``registration``.
"""

from __future__ import annotations

import json

from ai_video_workflow.assets.validation import (
    REPORT_SCHEMA_VERSION,
    ValidationReport,
)


def report_to_json_dict(report: ValidationReport) -> dict[str, object]:
    """Return the fixed-key JSON-compatible dict for a validation report."""
    probe = None
    if report.probe is not None:
        probe = {
            "container_format": report.probe.container_format,
            "duration_seconds": report.probe.duration_seconds,
            "width": report.probe.width,
            "height": report.probe.height,
            "frame_rate": report.probe.frame_rate,
        }
    return {
        "report_schema_version": REPORT_SCHEMA_VERSION,
        "task_id": report.task_id,
        "shot_id": report.shot_id,
        "checked_path": report.checked_path,
        "passed": report.passed,
        "policy_digest": report.policy_digest,
        "observed_at": report.observed_at.isoformat(timespec="microseconds"),
        "probe": probe,
        "checks": [
            {
                "check_type": check.check_type.value,
                "status": check.status.value,
                "observed": check.observed,
                "expected": check.expected,
                "error_code": check.error_code,
                "message": check.message,
            }
            for check in report.checks
        ],
    }


def report_json_bytes(report: ValidationReport) -> bytes:
    """Return the deterministic JSON bytes (sorted keys, trailing newline)."""
    text = (
        json.dumps(
            report_to_json_dict(report),
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        )
        + "\n"
    )
    return text.encode("utf-8")


def report_markdown_bytes(report: ValidationReport) -> bytes:
    """Return a deterministic Markdown rendering of the report."""
    lines = [
        "# Validation Report",
        "",
        f"- task_id: {report.task_id}",
        f"- shot_id: {report.shot_id}",
        f"- checked_path: {report.checked_path}",
        f"- passed: {str(report.passed).lower()}",
        f"- policy_digest: {report.policy_digest}",
        f"- observed_at: {report.observed_at.isoformat(timespec='microseconds')}",
        "",
        "## Checks",
        "",
        "| check | status | observed | expected | error_code |",
        "| --- | --- | --- | --- | --- |",
    ]
    for check in report.checks:
        lines.append(
            f"| {check.check_type.value} | {check.status.value} "
            f"| {_cell(check.observed)} | {_cell(check.expected)} "
            f"| {_cell(check.error_code)} |"
        )
    lines.append("")
    return ("\n".join(lines) + "\n").encode("utf-8")


def _cell(value: str | None) -> str:
    return "" if value is None else value.replace("|", "\\|")

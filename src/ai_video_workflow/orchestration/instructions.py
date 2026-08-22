"""Deterministic byte-exact instruction rendering.

This module renders one ProviderInstruction plus explicit identity
inputs into the exact UTF-8 bytes of the approved instruction
Markdown contract: fixed template order, LF line endings, no BOM,
exactly one trailing newline, and a canonical-JSON fenced parameter
block. It is a pure function layer: no filesystem access, no path
handling, no clocks, and no Provider calls. Writing the rendered
bytes to disk is a later, separate concern.
"""

from __future__ import annotations

import re

from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.orchestration.canonical import _canonical_json_bytes
from ai_video_workflow.providers.models import ProviderInstruction
from ai_video_workflow.validation import validate_stable_id

INSTRUCTION_SCHEMA_VERSION = 1

_HEX64_PATTERN = re.compile(r"^[0-9a-f]{64}$")

_ABSENT_VALUE_TEXT = "none"


def _render_instruction_bytes(
    instruction: ProviderInstruction,
    *,
    operation_id: str,
    plan_id: str,
    request_fingerprint: str,
) -> bytes:
    """Render the exact instruction Markdown bytes for one instruction.

    The caller provides the already-computed plan_id and request
    fingerprint; this function never computes plans, reads state, or
    touches the filesystem. Equal logical inputs always produce
    identical bytes.
    """
    if type(instruction) is not ProviderInstruction:
        raise FieldTypeError(
            "instruction: expected ProviderInstruction, "
            f"got {type(instruction).__name__}"
        )
    validate_stable_id(operation_id, field_name="operation_id")
    _validate_hex64(plan_id, field_name="plan_id")
    _validate_hex64(request_fingerprint, field_name="request_fingerprint")
    _validate_lf_only(instruction.prompt, field_name="prompt")
    for index, step in enumerate(instruction.steps):
        _validate_lf_only(step, field_name=f"steps[{index}]")
    parameters_json = _canonical_json_bytes(instruction.suggested_parameters).decode(
        "utf-8"
    )
    lines = [
        "# Manual Video Generation Task",
        "",
        f"- schema_version: {INSTRUCTION_SCHEMA_VERSION}",
        f"- task_id: {instruction.task_id}",
        f"- shot_id: {instruction.shot_id}",
        f"- provider_id: {instruction.provider_id}",
        f"- operation_id: {operation_id}",
        f"- plan_id: {plan_id}",
        f"- request_fingerprint: {request_fingerprint}",
        "",
        "## Prompt",
        "",
        instruction.prompt,
        "",
        "## Expected Output",
        "",
        f"- duration_seconds: {_format_value(instruction.expected_duration_seconds)}",
        f"- width: {_format_value(instruction.expected_width)}",
        f"- height: {_format_value(instruction.expected_height)}",
        f"- frame_rate: {_format_value(instruction.expected_frame_rate)}",
        f"- staging_ref: {_format_value(instruction.staging_ref)}",
        "",
        "## Steps",
        "",
    ]
    lines.extend(
        f"{number}. {step}" for number, step in enumerate(instruction.steps, start=1)
    )
    lines.extend(
        [
            "",
            "## Suggested Parameters",
            "",
            "```json",
            parameters_json,
            "```",
        ]
    )
    text = "\n".join(lines) + "\n"
    return text.encode("utf-8")


def _format_value(value: object) -> str:
    """Return the fixed textual form of one template value.

    A missing optional value renders as the literal ``none`` per the
    instruction contract; present values use their deterministic
    string form.
    """
    if value is None:
        return _ABSENT_VALUE_TEXT
    return str(value)


def _validate_hex64(value: object, *, field_name: str) -> None:
    if type(value) is not str:
        raise FieldTypeError(
            f"{field_name}: expected string, got {type(value).__name__}"
        )
    if _HEX64_PATTERN.fullmatch(value) is None:
        raise InvariantViolationError(
            f"{field_name}: expected a lowercase 64-character hex digest"
        )


def _validate_lf_only(value: str, *, field_name: str) -> None:
    """Reject carriage returns that would break the LF-only contract.

    Prompt and step text is otherwise rendered verbatim: internal
    newlines and internal trailing whitespace are legal instruction
    content and pass through byte-for-byte.
    """
    if "\r" in value:
        raise InvariantViolationError(
            f"{field_name}: must not contain carriage returns"
        )

"""SubRip (SRT) subtitle structural validation (TASK-008).

Subtitle timing is authored by the user (or an optional shot-derived skeleton);
this module does NOT invent or realign timings (out of scope per TASK-008). It
only fails closed on a structurally invalid SRT so a malformed file can never be
registered as a subtitle asset or reach the mux step.

Validation rules (deliberately strict but format-standard):

* cues are separated by a blank line; each cue is ``index`` / ``timing`` /
  one-or-more text lines;
* ``index`` is a positive integer, strictly increasing across the file;
* ``timing`` is ``HH:MM:SS,mmm --> HH:MM:SS,mmm`` with ``end > start``;
* cue start times are non-decreasing (monotonic);
* every cue has at least one non-empty text line.

UTF-8 with or without a BOM is accepted; CRLF and LF line endings are both
accepted. The parser is pure and deterministic (no clock, no external tool).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ai_video_workflow.audio.errors import SubtitleValidationError

_TIMING_RE = re.compile(
    r"^(?P<sh>\d{2,}):(?P<sm>\d{2}):(?P<ss>\d{2}),(?P<sms>\d{3})"
    r"\s*-->\s*"
    r"(?P<eh>\d{2,}):(?P<em>\d{2}):(?P<es>\d{2}),(?P<ems>\d{3})"
    r"(?:\s.*)?$"  # trailing position coordinates are tolerated, then ignored
)
_MAX_SUBTITLE_BYTES = 32 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class SubtitleValidationResult:
    """Structural summary of a validated SRT file."""

    cue_count: int
    first_start_ms: int
    last_end_ms: int


def _timecode_ms(hours: str, minutes: str, seconds: str, millis: str) -> int:
    mm = int(minutes)
    ss = int(seconds)
    if mm >= 60 or ss >= 60:
        raise SubtitleValidationError(
            f"subtitle timecode out of range: {hours}:{minutes}:{seconds},{millis}"
        )
    return ((int(hours) * 60 + mm) * 60 + ss) * 1000 + int(millis)


def validate_srt_bytes(raw: bytes) -> SubtitleValidationResult:
    """Validate raw SRT bytes, returning a structural summary or raising."""
    if len(raw) > _MAX_SUBTITLE_BYTES:
        raise SubtitleValidationError("subtitle file is implausibly large")
    try:
        # utf-8-sig transparently strips a leading BOM if present.
        text = raw.decode("utf-8-sig")
    except UnicodeError as exc:
        raise SubtitleValidationError("subtitle file is not valid UTF-8") from exc
    if not text.strip():
        raise SubtitleValidationError("subtitle file is empty")

    # Normalize line endings, then split into blank-line-separated cue blocks.
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in lines:
        if line.strip() == "":
            if current:
                blocks.append(current)
                current = []
        else:
            current.append(line)
    if current:
        blocks.append(current)
    if not blocks:
        raise SubtitleValidationError("subtitle file has no cues")

    prev_index: int | None = None
    prev_start_ms: int | None = None
    first_start_ms: int | None = None
    last_end_ms = 0
    for position, block in enumerate(blocks, start=1):
        if len(block) < 3:
            raise SubtitleValidationError(
                f"subtitle cue #{position} is missing index, timing or text"
            )
        index_line, timing_line, *text_lines = block
        try:
            index = int(index_line.strip())
        except ValueError as exc:
            raise SubtitleValidationError(
                f"subtitle cue #{position} has a non-integer index: {index_line!r}"
            ) from exc
        if index <= 0:
            raise SubtitleValidationError(
                f"subtitle cue #{position} index must be positive: {index}"
            )
        if prev_index is not None and index <= prev_index:
            raise SubtitleValidationError(
                f"subtitle cue indices must strictly increase (#{position}: {index})"
            )
        match = _TIMING_RE.match(timing_line.strip())
        if match is None:
            raise SubtitleValidationError(
                f"subtitle cue #{position} has a malformed timing line: {timing_line!r}"
            )
        start_ms = _timecode_ms(match["sh"], match["sm"], match["ss"], match["sms"])
        end_ms = _timecode_ms(match["eh"], match["em"], match["es"], match["ems"])
        if end_ms <= start_ms:
            raise SubtitleValidationError(
                f"subtitle cue #{position} end is not after its start"
            )
        if prev_start_ms is not None and start_ms < prev_start_ms:
            raise SubtitleValidationError(
                f"subtitle cue #{position} starts before the previous cue"
            )
        if not any(line.strip() for line in text_lines):
            raise SubtitleValidationError(
                f"subtitle cue #{position} has no non-empty text"
            )
        if first_start_ms is None:
            first_start_ms = start_ms
        prev_index = index
        prev_start_ms = start_ms
        last_end_ms = max(last_end_ms, end_ms)

    assert first_start_ms is not None  # at least one block validated above
    return SubtitleValidationResult(
        cue_count=len(blocks),
        first_start_ms=first_start_ms,
        last_end_ms=last_end_ms,
    )

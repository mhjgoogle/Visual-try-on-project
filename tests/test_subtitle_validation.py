"""Tests for SRT subtitle structural validation (TASK-008)."""

from __future__ import annotations

import pytest

from ai_video_workflow.audio.errors import SubtitleValidationError
from ai_video_workflow.audio.subtitle import validate_srt_bytes
from tests.audio_fakes import make_srt_bytes


def test_valid_srt_summary() -> None:
    result = validate_srt_bytes(make_srt_bytes(3))
    assert result.cue_count == 3
    assert result.first_start_ms == 0
    assert result.last_end_ms == 5000  # 3rd cue: 00:00:04 --> 00:00:05


def test_bom_is_tolerated() -> None:
    result = validate_srt_bytes(make_srt_bytes(1, bom=True))
    assert result.cue_count == 1


def test_crlf_line_endings_are_tolerated() -> None:
    raw = make_srt_bytes(2).replace(b"\n", b"\r\n")
    assert validate_srt_bytes(raw).cue_count == 2


def test_empty_file_is_rejected() -> None:
    with pytest.raises(SubtitleValidationError):
        validate_srt_bytes(b"   \n\n")


def test_non_increasing_index_is_rejected() -> None:
    raw = (
        b"1\n00:00:00,000 --> 00:00:01,000\nA\n\n1\n00:00:01,000 --> 00:00:02,000\nB\n"
    )
    with pytest.raises(SubtitleValidationError):
        validate_srt_bytes(raw)


def test_end_before_start_is_rejected() -> None:
    raw = b"1\n00:00:02,000 --> 00:00:01,000\nA\n"
    with pytest.raises(SubtitleValidationError):
        validate_srt_bytes(raw)


def test_malformed_timing_is_rejected() -> None:
    raw = b"1\n00:00:00 -> 00:00:01\nA\n"
    with pytest.raises(SubtitleValidationError):
        validate_srt_bytes(raw)


def test_missing_text_is_rejected() -> None:
    raw = b"1\n00:00:00,000 --> 00:00:01,000\n \n"
    with pytest.raises(SubtitleValidationError):
        validate_srt_bytes(raw)


def test_out_of_range_seconds_rejected() -> None:
    raw = b"1\n00:00:61,000 --> 00:00:62,000\nA\n"
    with pytest.raises(SubtitleValidationError):
        validate_srt_bytes(raw)


def test_non_utf8_is_rejected() -> None:
    with pytest.raises(SubtitleValidationError):
        validate_srt_bytes(b"\xff\xfe1\n00:00:00,000 --> 00:00:01,000\nA\n")

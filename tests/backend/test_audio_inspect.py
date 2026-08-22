"""Tests for the audio inspection layer (TASK-008)."""

from __future__ import annotations

import struct

import pytest

from ai_video_workflow.audio.errors import AudioValidationError
from ai_video_workflow.audio.inspect import AudioProbeResult, WavStructuralInspector
from tests.audio_fakes import make_wav_bytes


def test_wav_structural_probe_reports_duration(tmp_path) -> None:
    path = tmp_path / "vo.wav"
    path.write_bytes(make_wav_bytes(samples=16000, sample_rate=8000))
    probe = WavStructuralInspector().probe(path)
    assert probe.channels == 1
    assert probe.sample_rate == 8000
    assert probe.duration_seconds == pytest.approx(2.0)
    assert probe.codec == "pcm"


def test_probe_result_rejects_non_positive_duration() -> None:
    with pytest.raises(AudioValidationError):
        AudioProbeResult(
            codec="pcm", duration_seconds=0.0, channels=1, sample_rate=8000
        )


def test_probe_result_rejects_bad_channels() -> None:
    with pytest.raises(AudioValidationError):
        AudioProbeResult(
            codec="pcm", duration_seconds=1.0, channels=0, sample_rate=8000
        )


def test_not_riff_is_rejected(tmp_path) -> None:
    path = tmp_path / "bad.wav"
    path.write_bytes(b"NOTAWAVEFILE............")
    with pytest.raises(AudioValidationError):
        WavStructuralInspector().probe(path)


def test_missing_data_chunk_is_rejected(tmp_path) -> None:
    # RIFF/WAVE + fmt but no data chunk
    fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 8000, 1, 8)
    body = b"WAVE" + fmt
    raw = b"RIFF" + struct.pack("<I", len(body)) + body
    path = tmp_path / "nodata.wav"
    path.write_bytes(raw)
    with pytest.raises(AudioValidationError):
        WavStructuralInspector().probe(path)


def test_truncated_riff_size_is_rejected(tmp_path) -> None:
    raw = bytearray(make_wav_bytes(samples=100))
    struct.pack_into("<I", raw, 4, len(raw) * 4)  # claim far more than present
    path = tmp_path / "trunc.wav"
    path.write_bytes(bytes(raw))
    with pytest.raises(AudioValidationError):
        WavStructuralInspector().probe(path)


def test_extensible_fmt_without_extension_is_rejected(tmp_path) -> None:
    # WAVE_FORMAT_EXTENSIBLE (0xFFFE) with only a 16-byte fmt chunk is malformed
    fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 0xFFFE, 1, 8000, 8000, 1, 8)
    data = b"data" + struct.pack("<I", 4) + b"\x00\x01\x02\x03"
    body = b"WAVE" + fmt + data
    raw = b"RIFF" + struct.pack("<I", len(body)) + body
    path = tmp_path / "ext.wav"
    path.write_bytes(raw)
    with pytest.raises(AudioValidationError):
        WavStructuralInspector().probe(path)


_KS_TAIL = bytes((0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71))


def _extensible_wav(guid: bytes) -> bytes:
    fmt_payload = (
        struct.pack("<HHIIHH", 0xFFFE, 1, 8000, 8000, 1, 8)  # base 16 bytes
        + struct.pack("<H", 22)  # cbSize
        + struct.pack("<H", 8)  # wValidBitsPerSample
        + struct.pack("<I", 0x3)  # dwChannelMask
        + guid
    )
    fmt = b"fmt " + struct.pack("<I", len(fmt_payload)) + fmt_payload
    data = b"data" + struct.pack("<I", 8) + b"\x00" * 8
    body = b"WAVE" + fmt + data
    return b"RIFF" + struct.pack("<I", len(body)) + body


def test_extensible_fmt_with_pcm_subformat_is_accepted(tmp_path) -> None:
    # canonical KSDATAFORMAT_SUBTYPE_PCM GUID: Data1=1, Data2=0, Data3=0x10, tail
    guid = struct.pack("<IHH", 1, 0x0000, 0x0010) + _KS_TAIL
    path = tmp_path / "ext_ok.wav"
    path.write_bytes(_extensible_wav(guid))
    assert WavStructuralInspector().probe(path).codec == "pcm"


def test_extensible_fmt_with_bad_guid_is_rejected(tmp_path) -> None:
    # right format code (1) but a corrupted GUID tail must be refused
    guid = struct.pack("<IHH", 1, 0x0000, 0x0010) + b"\x00" * 8
    path = tmp_path / "ext_bad.wav"
    path.write_bytes(_extensible_wav(guid))
    with pytest.raises(AudioValidationError):
        WavStructuralInspector().probe(path)


def test_zero_sample_rate_is_rejected(tmp_path) -> None:
    fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, 0, 0, 1, 8)
    data = b"data" + struct.pack("<I", 4) + b"\x00\x01\x02\x03"
    body = b"WAVE" + fmt + data
    raw = b"RIFF" + struct.pack("<I", len(body)) + body
    path = tmp_path / "zerorate.wav"
    path.write_bytes(raw)
    with pytest.raises(AudioValidationError):
        WavStructuralInspector().probe(path)

"""Tests for user-provided audio/subtitle asset registration (TASK-008)."""

from __future__ import annotations

import pytest

from ai_video_workflow.audio.errors import (
    AudioError,
    AudioValidationError,
    SubtitleValidationError,
)
from ai_video_workflow.audio.registration import (
    register_sfx_asset,
    register_subtitle_asset,
    register_voiceover_asset,
)
from ai_video_workflow.media.assets import load_asset, load_latest
from ai_video_workflow.media.errors import MediaValidationError
from tests.audio_fakes import make_srt_bytes, write_srt, write_wav


def test_register_voiceover_is_versioned_and_digest_bound(tmp_path) -> None:
    write_wav(tmp_path / "audio" / "vo.wav", samples=8000)
    reg = register_voiceover_asset(
        tmp_path, ref="narration", media_relpath="audio/vo.wav"
    )
    assert reg.asset.media_kind == "voiceover"
    assert reg.asset.version == 1
    assert reg.probe.duration_seconds == pytest.approx(1.0)
    loaded = load_asset(tmp_path, "voiceover", "narration", 1)
    assert loaded.media_sha256 == reg.asset.media_sha256
    assert loaded.producer["source"] == "external"


def test_reregister_identical_file_is_idempotent(tmp_path) -> None:
    write_wav(tmp_path / "sfx.wav", samples=4000)
    a = register_sfx_asset(tmp_path, ref="whoosh", media_relpath="sfx.wav")
    b = register_sfx_asset(tmp_path, ref="whoosh", media_relpath="sfx.wav")
    assert a.asset.version == 1
    assert b.asset.version == 1  # no new version for the same bytes
    assert load_latest(tmp_path, "sfx", "whoosh").version == 1


def test_same_bytes_different_note_is_still_idempotent(tmp_path) -> None:
    # idempotency is defined on the bytes alone: same file, different metadata,
    # returns the existing version (no churn, no change_reason needed).
    write_wav(tmp_path / "vo.wav", samples=8000)
    a = register_voiceover_asset(
        tmp_path, ref="narration", media_relpath="vo.wav", note="take one"
    )
    b = register_voiceover_asset(
        tmp_path, ref="narration", media_relpath="vo.wav", note="a different note"
    )
    assert a.asset.version == 1
    assert b.asset.version == 1
    assert b.asset.producer["note"] == "take one"  # existing version returned


def test_changed_file_requires_change_reason(tmp_path) -> None:
    write_wav(tmp_path / "vo.wav", samples=8000)
    register_voiceover_asset(tmp_path, ref="narration", media_relpath="vo.wav")
    write_wav(tmp_path / "vo.wav", samples=12000)  # different bytes
    with pytest.raises(AudioError):
        register_voiceover_asset(tmp_path, ref="narration", media_relpath="vo.wav")


def test_changed_file_with_reason_makes_new_version(tmp_path) -> None:
    write_wav(tmp_path / "vo.wav", samples=8000)
    register_voiceover_asset(tmp_path, ref="narration", media_relpath="vo.wav")
    write_wav(tmp_path / "vo.wav", samples=12000)
    reg2 = register_voiceover_asset(
        tmp_path,
        ref="narration",
        media_relpath="vo.wav",
        change_reason="re-recorded take 2",
    )
    assert reg2.asset.version == 2
    assert reg2.asset.parent_version == 1
    assert reg2.asset.change_reason == "re-recorded take 2"


def test_change_reason_rejected_on_first_version(tmp_path) -> None:
    write_wav(tmp_path / "vo.wav")
    with pytest.raises(AudioError):
        register_voiceover_asset(
            tmp_path, ref="narration", media_relpath="vo.wav", change_reason="nope"
        )


def test_register_subtitle(tmp_path) -> None:
    write_srt(tmp_path / "subs.srt", cues=3)
    reg = register_subtitle_asset(tmp_path, ref="en", media_relpath="subs.srt")
    assert reg.asset.media_kind == "subtitle"
    assert reg.validation.cue_count == 3


def test_malformed_audio_is_not_registered(tmp_path) -> None:
    (tmp_path / "bad.wav").write_bytes(b"not a wav at all........")
    with pytest.raises(AudioValidationError):
        register_voiceover_asset(tmp_path, ref="narration", media_relpath="bad.wav")
    assert load_latest(tmp_path, "voiceover", "narration") is None


def test_malformed_subtitle_is_not_registered(tmp_path) -> None:
    (tmp_path / "bad.srt").write_bytes(b"1\nnot a timing line\ntext\n")
    with pytest.raises(SubtitleValidationError):
        register_subtitle_asset(tmp_path, ref="en", media_relpath="bad.srt")
    assert load_latest(tmp_path, "subtitle", "en") is None


def test_missing_file_is_rejected(tmp_path) -> None:
    with pytest.raises(AudioError):
        register_voiceover_asset(tmp_path, ref="narration", media_relpath="ghost.wav")


def test_oversized_import_is_rejected(tmp_path, monkeypatch) -> None:
    import ai_video_workflow.audio.registration as reg

    monkeypatch.setattr(reg, "MAX_AUDIO_IMPORT_BYTES", 1024)
    write_wav(tmp_path / "big.wav", samples=8000)  # ~8 KB > 1 KB cap
    with pytest.raises(AudioError):
        register_voiceover_asset(tmp_path, ref="narration", media_relpath="big.wav")
    assert load_latest(tmp_path, "voiceover", "narration") is None


def test_bad_ref_is_rejected_before_any_write(tmp_path) -> None:
    write_wav(tmp_path / "vo.wav", samples=8000)
    for bad in ("../evil", "a/b", "Narration", "", "with.dot"):
        with pytest.raises(AudioError):
            register_voiceover_asset(tmp_path, ref=bad, media_relpath="vo.wav")
    # nothing was created outside the expected (never-reached) index location
    assert not (tmp_path / "media" / "imported").exists()


def test_import_is_copied_to_immutable_internal_path(tmp_path) -> None:
    write_wav(tmp_path / "vo.wav", samples=8000)
    reg = register_voiceover_asset(tmp_path, ref="narration", media_relpath="vo.wav")
    # the bound file is an index-owned copy, NOT the mutable user source
    assert reg.asset.media_path == "media/imported/voiceover/narration_v1.wav"
    assert (tmp_path / reg.asset.media_path).is_file()
    # replacing the user's source does not disturb the registered version
    write_wav(tmp_path / "vo.wav", samples=9000)
    assert load_asset(tmp_path, "voiceover", "narration", 1).version == 1


def test_tampered_internal_copy_fails_closed_on_load(tmp_path) -> None:
    write_wav(tmp_path / "vo.wav", samples=8000)
    register_voiceover_asset(tmp_path, ref="narration", media_relpath="vo.wav")
    # tampering with the index-owned copy is caught by digest self-verification
    internal = tmp_path / "media" / "imported" / "voiceover" / "narration_v1.wav"
    write_wav(internal, samples=9000)
    with pytest.raises(MediaValidationError):
        load_asset(tmp_path, "voiceover", "narration", 1)


def test_subtitle_bytes_helper_valid() -> None:
    assert make_srt_bytes(1).startswith(b"1\n")

"""Shared in-memory test doubles for the media boundary (ADR-0002).

These fakes let the validation and composition steps be exercised end to
end without ffprobe/ffmpeg. They are test infrastructure only.
"""

from __future__ import annotations

from pathlib import Path

from ai_video_workflow.composition.composer import VideoComposer
from ai_video_workflow.composition.profile import CompositionProfile
from ai_video_workflow.inspection.base import MediaInspector, MediaProbeResult


class FakeMediaInspector(MediaInspector):
    """Return a canned probe result (or raise a canned error), recording calls."""

    def __init__(
        self,
        *,
        result: MediaProbeResult | None = None,
        error: Exception | None = None,
    ) -> None:
        self._result = result
        self._error = error
        self.calls: list[Path] = []

    def probe(self, path: Path) -> MediaProbeResult:
        self.calls.append(path)
        if self._error is not None:
            raise self._error
        if self._result is None:
            raise AssertionError("FakeMediaInspector has no result configured")
        return self._result


class FakeVideoComposer(VideoComposer):
    """Compose by copying/concatenating bytes; records calls (no ffmpeg)."""

    def __init__(self, *, error: Exception | None = None) -> None:
        self._error = error
        self.normalize_calls: list[tuple[Path, Path]] = []
        self.concatenate_calls: list[tuple[tuple[Path, ...], Path]] = []

    def normalize(
        self, source: Path, target: Path, profile: CompositionProfile
    ) -> None:
        self.normalize_calls.append((source, target))
        if self._error is not None:
            raise self._error
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"normalized:" + source.read_bytes())

    def concatenate(self, sources: tuple[Path, ...], target: Path) -> None:
        self.concatenate_calls.append((sources, target))
        if self._error is not None:
            raise self._error
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = b"concat"
        for source in sources:
            payload += b"|" + source.read_bytes()
        target.write_bytes(payload)

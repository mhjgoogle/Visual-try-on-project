"""Shared in-memory test doubles for the media boundary (ADR-0002).

These fakes let the validation and composition steps be exercised end to
end without ffprobe/ffmpeg. They are test infrastructure only.
"""

from __future__ import annotations

from pathlib import Path

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

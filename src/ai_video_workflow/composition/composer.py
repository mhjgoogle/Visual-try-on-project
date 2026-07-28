"""VideoComposer abstraction (ADR-0002).

The composition step depends only on ``VideoComposer``; ffmpeg is
confined to ``FfmpegVideoComposer``. The two-stage compose is
``normalize`` each input to the profile, then ``concatenate`` the
normalized inputs into one output.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from ai_video_workflow.composition.profile import CompositionProfile


class VideoComposer(ABC):
    """Abstract two-stage composer: normalize then concatenate."""

    __slots__ = ()

    @abstractmethod
    def normalize(
        self, source: Path, target: Path, profile: CompositionProfile
    ) -> None:
        """Transcode ``source`` into ``target`` to the given profile."""

    @abstractmethod
    def concatenate(self, sources: tuple[Path, ...], target: Path) -> None:
        """Concatenate the ordered normalized ``sources`` into ``target``."""

"""Real media fetcher for external artifact references (TASK-016).

Downloads a provider's external artifact URL to a local staging path.
This is the only component that performs the media download — providers
stay filesystem-free and return an external reference; the coordinator
fetches it here. Used by the CLI paid path; tests inject a fake fetcher.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from pathlib import Path

from ai_video_workflow.errors import AiVideoWorkflowError


class MediaFetchError(AiVideoWorkflowError):
    """Raised when an external artifact cannot be fetched to staging."""


class UrllibMediaFetcher:
    """Fetch an ``http(s)`` artifact URL to ``dest`` via the standard library."""

    _ALLOWED_SCHEMES = ("http://", "https://")

    def fetch(self, reference: str, dest: Path) -> None:
        if not reference.startswith(self._ALLOWED_SCHEMES):
            raise MediaFetchError(
                f"unsupported artifact reference scheme: {reference.split(':', 1)[0]!r}"
            )
        try:
            with urllib.request.urlopen(reference) as response:  # noqa: S310
                data = response.read()
        except (urllib.error.URLError, OSError) as exc:
            raise MediaFetchError(f"failed to fetch artifact: {exc}") from exc
        dest.write_bytes(data)

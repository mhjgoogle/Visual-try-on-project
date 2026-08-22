"""Real media fetcher for external artifact references (TASK-016/017).

Downloads a provider's external artifact URL to a local staging path.
This is the only component that performs the media download — providers
stay filesystem-free and return an external reference; the coordinator
fetches it here. Used by the CLI paid path; tests inject a fake fetcher.

Hardened (TASK-017 review): a request timeout, a streamed download with a
size cap (never buffers an unbounded body in memory), validation of the
final (post-redirect) URL scheme and content type, and an **atomic,
non-overwriting** publish (temp file in the same dir + link) so a failed
or oversized download can never corrupt or silently overwrite an existing
staged file.
"""

from __future__ import annotations

import os
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from ai_video_workflow.errors import AiVideoWorkflowError

_ALLOWED_SCHEMES = ("http://", "https://")
_CHUNK = 1024 * 1024
_DEFAULT_MAX_BYTES = 512 * 1024 * 1024  # 512 MiB safety cap
_DEFAULT_TIMEOUT = 60.0


class MediaFetchError(AiVideoWorkflowError):
    """Raised when an external artifact cannot be fetched to staging."""


class UrllibMediaFetcher:
    """Fetch an ``http(s)`` artifact URL to ``dest`` via the standard library."""

    def __init__(
        self,
        *,
        timeout_seconds: float = _DEFAULT_TIMEOUT,
        max_bytes: int = _DEFAULT_MAX_BYTES,
    ) -> None:
        self._timeout = timeout_seconds
        self._max_bytes = max_bytes

    def fetch(self, reference: str, dest: Path) -> None:
        if not reference.startswith(_ALLOWED_SCHEMES):
            raise MediaFetchError(
                f"unsupported artifact reference scheme: {reference.split(':', 1)[0]!r}"
            )
        dest.parent.mkdir(parents=True, exist_ok=True)
        raw_fd, tmp_name = tempfile.mkstemp(
            dir=dest.parent, prefix=f".{dest.name}.", suffix=".part"
        )
        tmp_path = Path(tmp_name)
        try:
            self._stream_to(reference, raw_fd)
            try:
                os.link(tmp_path, dest)  # atomic, refuses to overwrite
            except FileExistsError as exc:
                raise MediaFetchError(
                    f"refusing to overwrite existing media: {dest}"
                ) from exc
        finally:
            try:
                tmp_path.unlink()
            except OSError:
                pass

    def _stream_to(self, reference: str, raw_fd: int) -> None:
        try:
            with urllib.request.urlopen(  # noqa: S310 - scheme checked above
                reference, timeout=self._timeout
            ) as response:
                final_url = response.geturl()
                if not final_url.startswith(_ALLOWED_SCHEMES):
                    raise MediaFetchError(
                        f"artifact redirected to a non-http(s) URL: {final_url!r}"
                    )
                content_type = (response.headers.get("Content-Type") or "").lower()
                if content_type and not content_type.startswith(
                    ("video/", "application/octet-stream", "binary/")
                ):
                    raise MediaFetchError(
                        f"unexpected media content type: {content_type!r}"
                    )
                written = 0
                with os.fdopen(raw_fd, "wb") as stream:
                    raw_fd = -1  # ownership transferred to `stream`
                    while True:
                        chunk = response.read(_CHUNK)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > self._max_bytes:
                            raise MediaFetchError(
                                f"media exceeds size cap of {self._max_bytes} bytes"
                            )
                        stream.write(chunk)
                if written == 0:
                    # an empty body is never a valid video; do not publish it
                    raise MediaFetchError("empty media download")
        except (urllib.error.URLError, OSError) as exc:
            raise MediaFetchError(f"failed to fetch artifact: {exc}") from exc
        finally:
            if raw_fd != -1:
                try:
                    os.close(raw_fd)
                except OSError:
                    pass

"""Cross-platform helper for the motv "core contract untouched" tests.

These tests assert that a mockup-domain identifier never appears in the core
package. They previously shelled out to ``grep -rl`` (absent on native Windows,
ADR-0049); this pure-Python scan is the portable equivalent.
"""

from __future__ import annotations

from pathlib import Path

_CORE = Path(__file__).resolve().parents[1] / "src" / "ai_video_workflow"


def core_files_containing(needle: str, root: Path | None = None) -> list[str]:
    """Return the UTF-8 text files under ``root`` (default: the core package)
    that contain ``needle`` — the portable equivalent of ``grep -rl``."""
    base = root or _CORE
    hits: list[str] = []
    for path in base.rglob("*"):
        if not path.is_file():
            continue
        try:
            if needle in path.read_text(encoding="utf-8"):
                hits.append(str(path))
        except (UnicodeDecodeError, OSError):
            continue  # binary or unreadable file — cannot contain the needle
    return hits

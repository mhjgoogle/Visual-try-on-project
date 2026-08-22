"""motv 演示服务器的启动横幅不得能杀死服务器 —— ADR-0062 / ADR-0049.

STRICTLY OFFLINE, no spend, no sockets.

原生 Windows 是权威环境（ADR-0062 决策 1），而 Windows 控制台并不一定是 UTF-8：
在 cp932（日文）控制台上，`serve.py` 的启动横幅里有 `⚪` 和中文，`print` 会抛
`UnicodeEncodeError`，而且抛在 `serve_forever` **之前** —— 于是演示服务器带着
traceback 启动失败，而不是开始服务。

横幅只是一句提示。它不该有能力阻止服务器启动。
"""

from __future__ import annotations

import importlib.util
import io
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SERVE = _REPO / "mockups" / "motv-workspace" / "serve.py"

# The exact banner `main()` prints. Kept here verbatim so a change to it that
# reintroduces an unencodable character is caught by this test rather than by a
# creator whose server will not start.
_BANNER = "motv demo (⚪ 演示模式) → http://127.0.0.1:8123/  (Ctrl+C 退出)"


def _load_serve():
    spec = importlib.util.spec_from_file_location("motv_serve", _SERVE)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_serve_module_exists() -> None:
    assert _SERVE.is_file(), "serve.py is the documented demo-mode launcher"


@pytest.mark.parametrize("encoding", ["cp932", "cp1252", "ascii", "utf-8"])
def test_banner_never_raises_on_a_narrow_console(encoding: str) -> None:
    """The banner survives every console encoding, including ones that cannot
    represent it. `utf-8` is in the list to prove the fix did not degrade the
    normal case."""
    serve = _load_serve()
    buffer = io.TextIOWrapper(io.BytesIO(), encoding=encoding, errors="strict")
    original = sys.stdout
    sys.stdout = buffer
    try:
        serve._banner(_BANNER)  # must not raise
    finally:
        sys.stdout = original


def test_banner_keeps_what_the_console_can_show() -> None:
    """A narrow console still gets a recognisable line — the characters it CAN
    encode are preserved rather than the whole banner being dropped."""
    serve = _load_serve()
    raw = io.BytesIO()
    buffer = io.TextIOWrapper(raw, encoding="cp932", errors="strict")
    original = sys.stdout
    sys.stdout = buffer
    try:
        serve._banner(_BANNER)
    finally:
        sys.stdout = original
        buffer.flush()
    written = raw.getvalue().decode("cp932", errors="replace")
    # the ASCII spine of the line survives, so the creator can still read the URL
    assert "motv demo" in written
    assert "http://127.0.0.1:8123/" in written
    assert "Ctrl+C" in written


def test_utf8_console_gets_the_banner_verbatim() -> None:
    """Nothing is mangled where the console can actually take it."""
    serve = _load_serve()
    raw = io.BytesIO()
    buffer = io.TextIOWrapper(raw, encoding="utf-8", errors="strict")
    original = sys.stdout
    sys.stdout = buffer
    try:
        serve._banner(_BANNER)
    finally:
        sys.stdout = original
        buffer.flush()
    assert raw.getvalue().decode("utf-8").strip() == _BANNER


def test_banner_is_the_only_thing_between_bind_and_serve() -> None:
    """Guard the SHAPE of main(): the banner must sit after the bind and before
    `serve_forever`, and it must go through `_banner` rather than a bare `print`.

    A bare `print` there is precisely the defect this test exists for, and it is
    the kind of thing a later edit reintroduces without noticing.
    """
    source = _SERVE.read_text("utf-8")
    body = source[source.index("def main()") :]
    assert "_banner(" in body, "main() must print its banner through _banner"
    banner_at = body.index("_banner(")
    # `httpd.serve_forever`, not the bare word: main()'s comments mention
    # `serve_forever` while explaining this very bug, and matching prose instead
    # of the call made this assertion compare a comment's position.
    serve_at = body.index("httpd.serve_forever")
    assert banner_at < serve_at, "the banner is printed before serving starts"
    # no bare print() of a non-ASCII literal anywhere in main()
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("print(") and not stripped.isascii():
            pytest.fail(f"non-ASCII bare print() in main(): {stripped}")

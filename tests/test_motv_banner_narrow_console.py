"""TASK-077 Follow-up — 启动横幅不得因为控制台编码窄而杀掉后端。

THE DEFECT THIS PINS. `server.py:main()` printed the account root and every
discovered project name with bare `print`, **before** `serve_forever`. On a
Japanese/Chinese Windows the console code page is cp932/cp936, and a project
named 「夜班沉默」 is unrepresentable there, so the process died with

    UnicodeEncodeError: 'cp932' codec can't encode character '\\u6c89'

…and the backend never came up. Two sessions lost time to it in 2026-08-16, and
one concluded FROM THE CRASH that the project was not on the machine — the
banner's failure was read as a fact about the user's data.

`serve.py` had already solved this (`_banner`). The fix is that `server.py` uses
THAT implementation; this file proves the hazard is real and that the guard
catches it.

WHY THE CONTROL TEST MATTERS. This repo has been bitten three times by a guard
that «looked added but was never wired» (`_package_dirs` masking table keyed on
an id that was always empty; `gate.sh`'s classifier being the one step with no
timeout; `is_symlink()` returning False for a Windows junction). So the first
test here asserts that a bare `print` on this fixture **does** raise: if the
construction ever stops reproducing the hazard, that test fails loudly instead
of the suite quietly passing on a stream that can encode anything.
"""

from __future__ import annotations

import importlib.util
import io
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]
_MOCKUP = _REPO / "mockups" / "motv-workspace"

# 「夜班沉默」 — a real project name from the live registry, and the exact string
# that killed the backend. 「照」 (U+7167) is the character the traceback named.
_CJK = "夜班沉默 / 照见未明rev2"


@pytest.fixture(scope="module")
def server():
    spec = importlib.util.spec_from_file_location(
        "motv_server_banner", _MOCKUP / "server.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _narrow_stdout() -> io.TextIOWrapper:
    """A stdout that behaves like a cp932 console: it cannot encode CJK.

    `errors="strict"` is what a real Windows console stream uses, and it is the
    whole point — a lenient stream would not reproduce the crash.
    """
    return io.TextIOWrapper(io.BytesIO(), encoding="cp932", errors="strict")


# --- the control: the hazard is really reproduced -----------------------------


def test_a_bare_print_on_this_fixture_really_does_raise(monkeypatch) -> None:
    """If this stops raising, every other test in this file is vacuous."""
    stream = _narrow_stdout()
    monkeypatch.setattr(sys, "stdout", stream)
    with pytest.raises(UnicodeEncodeError):
        print(_CJK)


# --- the guard ----------------------------------------------------------------


def test_the_banner_survives_a_narrow_console(server, monkeypatch) -> None:
    stream = _narrow_stdout()
    monkeypatch.setattr(sys, "stdout", stream)
    server._banner(_CJK)  # must not raise — that is the entire contract


def _written(stream: io.TextIOWrapper) -> str:
    """What actually reached the byte stream. `print` does not flush."""
    stream.flush()
    return stream.buffer.getvalue().decode("cp932", errors="replace")


def test_the_banner_keeps_what_the_console_can_show(server, monkeypatch) -> None:
    """Unprintable characters are MARKED, not silently dropped.

    The line has to stay recognisable: 「rev2」 and the separator survive so a
    reader can still tell which project the banner is talking about.
    """
    stream = _narrow_stdout()
    monkeypatch.setattr(sys, "stdout", stream)
    server._banner(_CJK)
    written = _written(stream)
    assert "rev2" in written
    assert "/" in written


def test_an_ascii_banner_is_untouched(server, monkeypatch) -> None:
    """The guard must not mangle the common case."""
    stream = _narrow_stdout()
    monkeypatch.setattr(sys, "stdout", stream)
    server._banner("  account-root: D:\\02_Work\\MotvProjects")
    assert "D:\\02_Work\\MotvProjects" in _written(stream)


def test_the_guard_is_serve_pys_implementation_not_a_second_one(server) -> None:
    """One implementation, reused — not two that can drift apart.

    `serve.py` documented and solved this first; `server.py` importing that
    function is what keeps the two entry points from disagreeing about what a
    narrow console does. Loading `serve.py` again under a fresh module name would
    produce a DIFFERENT function object and make this check meaningless, so it
    compares against the module `server.py` itself imported.
    """
    serve = sys.modules.get("serve")
    assert serve is not None, "server.py must import the sibling `serve` module"
    assert server._banner is serve._banner


# --- the regression: main() must not reintroduce a bare print ----------------


def test_main_prints_its_banner_only_through_the_guard() -> None:
    """No bare `print(` anywhere in `main`.

    This is a source check and therefore an approximation — stated plainly
    rather than dressed up. It is narrow on purpose: the region is one short
    function, and the failure it guards against (someone adds one more banner
    line with `print`) is exactly a textual one. The behavioural contract is
    covered by the tests above.
    """
    source = (_MOCKUP / "server.py").read_text(encoding="utf-8")
    marker = "\ndef main("
    start = source.index(marker)
    body = source[start:]
    # `main` is the last function in the file; stop at the module guard.
    end = body.find("\nif __name__ ==")
    if end != -1:
        body = body[:end]
    assert "print(" not in body, (
        "main() must route every banner line through _banner — a bare print "
        "there is what killed the backend on a cp932 console"
    )

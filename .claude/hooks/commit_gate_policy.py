"""Classify changed paths for the local commit gate.

The policy intentionally grants a fast lane only to an explicit, small
allowlist.  Everything else is a full Python regression run.  Both hook
implementations invoke this file so their risk decisions cannot drift.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

_DOC_PREFIXES = ("docs/",)
_DOC_FILES = {"AGENTS.md", "README.md", "LICENSE"}
_WORKSPACE_PREFIXES = (
    "src/ai_video_workflow/workspace/",
    "src/workspace_shell/",
)
_WORKSPACE_TESTS = (
    "tests/test_workspace_action_query.py",
    "tests/test_workspace_cli.py",
    "tests/test_workspace_evaluation_query.py",
    "tests/test_workspace_multimedia.py",
    "tests/test_workspace_queries.py",
    "tests/test_workspace_shell.py",
    "tests/test_workspace_wfm1_acceptance.py",
    "tests/test_workspace_write.py",
)
_FRONTEND_PREFIX = "mockups/motv-workspace/"
_FRONTEND_SUFFIXES = (".css", ".html", ".js", ".mjs")
_HIGH_RISK_PREFIXES = (
    "src/ai_video_workflow/security/",
    "src/ai_video_workflow/config/",
    "src/ai_video_workflow/assets/registration.py",
    "src/ai_video_workflow/audio/registration.py",
    "src/ai_video_workflow/composition/",
    "src/ai_video_workflow/media/",
    "src/ai_video_workflow/orchestration/",
)
_HIGH_RISK_FILES = {
    "src/ai_video_workflow/appendlog.py",
    "src/ai_video_workflow/persistence.py",
    "src/ai_video_workflow/models.py",
    "src/ai_video_workflow/serialization.py",
    "conftest.py",
    "pyproject.toml",
}


@dataclass(frozen=True)
class Decision:
    """The checks the gate must run for one candidate commit."""

    tier: str
    reason: str
    pytest_targets: tuple[str, ...] = ()


def _normalise(path: str) -> str:
    return path.replace("\\", "/").lstrip("./")


def _is_docs(path: str) -> bool:
    return path in _DOC_FILES or path.startswith(_DOC_PREFIXES)


def _is_workspace_path(path: str) -> bool:
    return path.startswith(_WORKSPACE_PREFIXES) or path in _WORKSPACE_TESTS


def _is_frontend_path(path: str) -> bool:
    return path.startswith(_FRONTEND_PREFIX) and path.endswith(_FRONTEND_SUFFIXES)


def _is_pytest_file(path: str) -> bool:
    return (
        path.startswith("tests/")
        and path.rsplit("/", 1)[-1].startswith("test_")
        and path.endswith(".py")
    )


def _is_high_risk(path: str) -> bool:
    return path in _HIGH_RISK_FILES or path.startswith(_HIGH_RISK_PREFIXES)


def _test_for_source(path: str) -> str | None:
    """Return a conventional, existing unit-test counterpart when available."""

    if not (path.startswith("src/") and path.endswith(".py")):
        return None
    target = f"tests/test_{Path(path).stem}.py"
    return target if Path(target).is_file() else None


def _motv_server_tests() -> tuple[str, ...]:
    return tuple(
        sorted(
            str(path).replace("\\", "/")
            for path in Path("tests").glob("test_motv_*.py")
        )
    )


def classify(paths: list[str]) -> Decision:
    """Return the conservative validation tier for *paths*.

    A fast lane is valid only when every non-document path is explicitly
    bounded and has a known test target.  High-risk and unknown changes stay
    full by default.
    """

    changed = tuple(sorted({_normalise(path) for path in paths if path.strip()}))
    if not changed:
        return Decision("full", "no changed paths were available")

    non_docs = tuple(path for path in changed if not _is_docs(path))
    if not non_docs:
        return Decision("lint", "documentation-only change")

    if any(_is_high_risk(path) for path in non_docs):
        return Decision(
            "full", "high-risk persistence, security, schema, or render path"
        )

    if all(_is_workspace_path(path) for path in non_docs):
        return Decision(
            "workspace", "bounded workspace read-model surface", _WORKSPACE_TESTS
        )

    if all(_is_frontend_path(path) for path in non_docs):
        return Decision("frontend", "bounded frontend-only surface")

    if all(_is_pytest_file(path) for path in non_docs):
        return Decision("pytest-targeted", "test-only change", tuple(non_docs))

    if non_docs == ("mockups/motv-workspace/server.py",):
        return Decision(
            "motv-server", "bounded motv server surface", _motv_server_tests()
        )

    targets = tuple(
        sorted({target for path in non_docs if (target := _test_for_source(path))})
    )
    if len(targets) == len(non_docs):
        return Decision(
            "pytest-targeted", "conventional source-to-test mapping", targets
        )

    return Decision("full", "path has no conservative targeted-test mapping")


def main() -> int:
    # Git supplies NUL-separated names on Bash.  PowerShell normalises its
    # pipeline input to newlines; accepting both formats is safe on supported
    # Windows filenames and keeps the two hook runners on one policy.
    if len(sys.argv) > 1:
        paths = sys.argv[1:]
    else:
        raw = sys.stdin.buffer.read()
        separator = b"\0" if b"\0" in raw else b"\n"
        paths = [
            part.decode("utf-8", "surrogateescape") for part in raw.split(separator)
        ]
    print(json.dumps(asdict(classify(paths)), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""motv Story development & episode planning — checkpoint M9.

STRICTLY OFFLINE, no spend. Guards the wiring contract that lives in
DOM-bound closures and the server endpoint posture (storydoc transitions,
v7→v8 migration, v8 validation, story/plan view models are covered by the
frontend suite, ``tests/story.test.mjs``):
- both agent endpoints follow the ADR-0042 posture (local ``claude -p``,
  fail-closed strict parse, zero server-side writes);
- the Core contract is untouched (all of this is mockup/client-side).

The two guards that read ``app.js``（入口编排层）—— scripts are PER-EPISODE since
v8 (no second script source of truth), and the outline never auto-creates
Production Bible entities —— 已随 TASK-102 批次 E 移到
``tests/contract/test_frontend_write_path_invariants.py``。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"


def _server_module():
    spec = importlib.util.spec_from_file_location(
        "motv_server_m9", _MOCKUP_DIR / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_agent_endpoints_are_fail_closed_and_write_free() -> None:
    server = _server_module()
    with pytest.raises(ValueError):
        server._parse_story_outline("no json")
    with pytest.raises(ValueError):
        server._parse_story_outline('{"world": "x"}')  # no premise/logline
    out = server._parse_story_outline('围栏 {"premise": "社畜穿越"} 后记')
    assert out["premise"] == "社畜穿越"
    with pytest.raises(ValueError):
        server._parse_episode_plan('{"episodes": []}')
    with pytest.raises(ValueError):
        server._parse_episode_plan('{"episodes": [{"noTitle": 1}]}')
    eps = server._parse_episode_plan('{"episodes": [{"title": "殿前成诗"}]}')
    assert eps[0]["title"] == "殿前成诗"
    src = (_MOCKUP_DIR / "server.py").read_text("utf-8")
    for name in ("_agent_story_develop", "_agent_episode_plan"):
        handler = src[src.index(f"def {name}") :]
        handler = handler[: handler.index("\n    def ")]
        # The endpoint no longer fences user text itself: it compiles its prompt
        # from the Skill package, and `compile_prompt` puts every context value
        # inside `<数据 键="…">` with `</` neutralised (TASK-075 §3c decision A).
        # One fence for every runtime instead of one per endpoint.
        assert "_skill_prompt" in handler
        assert "prompt = (" not in handler, "the endpoint must not carry its own prompt"
        assert "open(" not in handler and ".write(" not in handler


def test_core_contracts_untouched_by_m9() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    for needle in (
        "storydoc",
        "approveOutline",
        "confirmPlan",
        "story-develop",
        "episode-plan",
    ):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"

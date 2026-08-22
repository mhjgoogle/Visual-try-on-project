"""motv Production studio UI reconstruction — checkpoint M8.

STRICTLY OFFLINE, no spend. Guards the server endpoint posture
(storyboard/shot-detail models, AI Director model, creative-facet passthrough,
bible breakdown parse/match/merge semantics, derived appearances are covered by
the frontend suite, ``tests/studio.test.mjs``):

- the bible breakdown endpoint follows the ADR-0042 agent posture (local
  ``claude -p``, fail-closed strict parse, writes nothing server-side) and
  everything it returns is a PROPOSAL — application is an explicit user act;
- the Core contract is untouched (all of this is mockup/client-side).

The four guards that read ``app.js``（入口编排层）—— studio 是 VIEW：不新增持久化
字段、媒体动作复用唯一写路径、镜头编辑追加不可变草稿版本、提案只能经既有
bibledoc 操作落地 —— 已随 TASK-102 批次 E 移到
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
        "motv_server_m8", _MOCKUP_DIR / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_breakdown_endpoint_is_fail_closed_and_write_free() -> None:
    server = _server_module()
    # strict parse: junk raises, well-formed passes
    with pytest.raises(ValueError):
        server._parse_bible_breakdown("no json here")
    with pytest.raises(ValueError):
        server._parse_bible_breakdown('{"characters": [{"noname": 1}]}')
    with pytest.raises(ValueError):
        server._parse_bible_breakdown('{"characters": [], "locations": []}')
    raw = '前言 {"characters": [{"name": "李昭"}], "locations": [{"name": "殿"}]} 后记'
    out = server._parse_bible_breakdown(raw)
    assert [c["name"] for c in out["characters"]] == ["李昭"]
    src = (_MOCKUP_DIR / "server.py").read_text("utf-8")
    handler = src[
        src.index("def _agent_bible_breakdown") : src.index("def _agent_script_draft")
    ]
    # the endpoint writes nothing server-side and embeds the script as data
    # The endpoint no longer fences user text itself: it compiles its prompt
    # from the Skill package, and `compile_prompt` puts every context value
    # inside `<数据 键="…">` with `</` neutralised (TASK-075 §3c decision A).
    # One fence for every runtime instead of one per endpoint.
    assert "_skill_prompt" in handler
    assert "prompt = (" not in handler, "the endpoint must not carry its own prompt"
    assert "open(" not in handler and ".write(" not in handler


def test_core_contracts_untouched_by_m8() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    for needle in (
        "storyboardModel",
        "directorModel",
        "parseBreakdown",
        "bible-breakdown",
    ):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"

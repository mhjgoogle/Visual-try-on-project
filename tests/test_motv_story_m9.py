"""motv Story development & episode planning — checkpoint M9.

STRICTLY OFFLINE, no spend. Runs the frontend units (storydoc transitions,
v7→v8 migration, v8 validation, story/plan view models) via ``node --test``
and guards the wiring contract:

- the creator path is Idea → AI story development → Story Outline (versioned,
  APPROVED) → Episode Plan (versioned, CONFIRMED) → per-episode scripts; the
  old idea→script shortcut is gone from the story workspace;
- AI output is a PROPOSAL first (apply/revise, versions preserved);
- scripts are PER-EPISODE (v8 ``scripts`` map; the legacy single scriptDoc
  moves to the active episode; a malformed one fails safe, never dropped);
- the outline never auto-creates Production Bible entities (bible sync stays
  driven by actual episode scripts, M8);
- both agent endpoints follow the ADR-0042 posture (local ``claude -p``,
  fail-closed strict parse, zero server-side writes);
- the Core contract is untouched (all of this is mockup/client-side).
"""

from __future__ import annotations

import importlib.util
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from tests._scan import core_files_containing

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


def _server_module():
    spec = importlib.util.spec_from_file_location(
        "motv_server_m9", _MOCKUP_DIR / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_story_units_via_node() -> None:
    """M9 故事域 / v7→v8 迁移 / v8 校验 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/story.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_story_is_a_dedicated_domain_module() -> None:
    src = (_SRC / "workflow" / "storydoc.js").read_text("utf-8")
    for fn in (
        "createStory",
        "beginDevelop",
        "completeDevelop",
        "applyProposal",
        "approveOutline",
        "confirmPlan",
        "applyManualOutline",
    ):
        assert f"export function {fn}" in src
    # ids are MINTED, never derived
    assert 'mintId("so")' in src
    assert 'mintId("plan")' in src


def test_scripts_are_per_episode_since_v8() -> None:
    schema = (_SRC / "services" / "canvasschema.js").read_text("utf-8")
    # the schema has moved past v8 (v10 = TASK-057 upstream canon, v11+ = later
    # migrations); this test pins the v8 per-episode-scripts mechanics, NOT the
    # current version number, so a legitimate later migration cannot break it
    match = re.search(r"CANVAS_SCHEMA_VERSION = (\d+)", schema)
    assert match is not None
    assert int(match.group(1)) >= 8
    assert "function migrateV7ToV8" in schema
    assert "7: migrateV7ToV8" in schema
    assert "missing its scripts map" in schema
    assert "missing its story document" in schema
    # a leftover legacy scriptDoc is rejected — no second script source of truth
    assert "retains scriptDoc" in schema
    app = (_SRC / "app.js").read_text("utf-8")
    assert "scriptForEpisode" in app
    assert "syncActiveScript" in app


def test_no_direct_idea_to_script_shortcut() -> None:
    ws = (_SRC / "ui" / "workspaces.js").read_text("utf-8")
    story_section = ws[
        ws.index("export function renderStory") : ws.index("export function bindStory")
    ]
    # the story workspace routes through outline+plan — never straight to script
    assert "创意 → 大纲 → 剧集规划 → 分集剧本" in story_section
    assert "去剧本工作区生成" not in story_section
    assert 'data-goto="script"' not in story_section


def test_outline_never_writes_bible_entities() -> None:
    story = (_SRC / "workflow" / "storydoc.js").read_text("utf-8")
    for forbidden in ("addCharacter", "addLocation", "bibledoc"):
        assert forbidden not in story, f"outline must not touch the bible ({forbidden})"
    # the confirm-plan orchestration touches only proddoc episode ops
    app = (_SRC / "app.js").read_text("utf-8")
    block = app[app.index("confirmPlan: (v) =>") : app.index("openEpisodeScript")]
    assert "bibledoc" not in block


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
        assert "_data_embed" in handler
        assert "open(" not in handler and ".write(" not in handler


def test_core_contracts_untouched_by_m9() -> None:
    core = Path(__file__).resolve().parents[1] / "src" / "ai_video_workflow"
    for needle in (
        "storydoc",
        "approveOutline",
        "confirmPlan",
        "story-develop",
        "episode-plan",
    ):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"

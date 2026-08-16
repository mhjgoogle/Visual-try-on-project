"""TASK-078 §1.b/§2.1 — the directing facets survive the whole path.

THE DEFECT THIS PINS. The live project 「照见未明rev2」 drafted 60 shots with
``shotSize`` 0/60, ``angle`` 0/60, ``cameraMotion`` 0/60. Three independent
causes stacked, and fixing any one alone would have changed nothing:

1. ``output.schema.json`` marked every facet optional, so the model skipped them;
2. ``server.py:_parse_shots`` rebuilt each shot from FOUR keys, so a facet the
   model *did* answer was discarded at the HTTP boundary;
3. the editing form had no input for 景别 / 角度 / 情绪 at all.

(3) is asserted by the frontend suite. This file holds the two server-side
halves, plus the agreement between the three lists that have to name the same
fields — the client's ``ADDITIVE_SHOT_FIELDS``, the server's ``_SHOT_FACETS``
and the Skill package's schema. A comment saying they agree is not a check.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]
_MOCKUP = _REPO / "mockups" / "motv-workspace"
_PACKAGE = _REPO / "product-skills" / "builtin" / "storyboard-director"


@pytest.fixture(scope="module")
def server():
    spec = importlib.util.spec_from_file_location(
        "motv_server_task078", _MOCKUP / "server.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def shot_schema():
    raw = json.loads((_PACKAGE / "output.schema.json").read_bytes().decode("utf-8"))
    return raw["fields"]["shots"]["of"]


# --- 1. the contract asks for what the pipeline needs ----------------------- #


def test_shot_size_and_camera_motion_are_required(shot_schema) -> None:
    """Optional meant 「模型可以不写」, and it didn't — 0/60, twice over."""
    required = set(shot_schema["required"])
    assert {"shotSize", "cameraMotion"} <= required
    # …and non-empty, or 「」 satisfies a presence check and lands in canon blank
    assert shot_schema["fields"]["shotSize"]["nonEmpty"] is True
    assert shot_schema["fields"]["cameraMotion"]["nonEmpty"] is True


def test_the_revision_carries_a_version_bump(shot_schema) -> None:
    """ADR-0067 决策 3: content moved, so the version must have. A historical Run
    records ``(skillId, skillVersion, skillDigest)``; leaving the version at 1
    would make the loader refuse the package outright (digest conflict)."""
    manifest = json.loads((_PACKAGE / "manifest.json").read_bytes().decode("utf-8"))
    assert manifest["skillVersion"] >= 2


def test_lighting_is_offered_but_never_forced(shot_schema) -> None:
    """光影氛围 is additive: new field, no migration, and a draft written before
    it existed stays valid (AGENTS.md 第 13 条)."""
    assert "lighting" in shot_schema["fields"]
    assert "lighting" not in shot_schema["required"]


# --- 2. the transport stops deleting them ----------------------------------- #


def _answer(**facets) -> str:
    shot = {
        "title": "S1-01",
        "description": "白天，算法实验室",
        "shotSize": "中近景",
        "cameraMotion": "固定机位",
        "duration_seconds": 6,
    }
    shot.update(facets)
    return json.dumps([shot], ensure_ascii=False)


def test_a_facet_the_model_answered_reaches_the_client(server) -> None:
    """The whole point. Before this card the response was built from four keys,
    so the answer 「中近景 · 低角度仰拍」 was thrown away one layer below the UI —
    which is why raising the schema alone would have fixed nothing."""
    out = server._parse_shots(
        _answer(angle="低角度仰拍", lighting="冷白顶光", emotion="克制的紧张")
    )
    assert out[0]["shotSize"] == "中近景"
    assert out[0]["angle"] == "低角度仰拍"
    assert out[0]["lighting"] == "冷白顶光"
    assert out[0]["emotion"] == "克制的紧张"
    assert out[0]["cameraMotion"] == "固定机位"


def test_an_absent_facet_is_OMITTED_not_blanked(server) -> None:
    """Additive means additive: a shot with no 情绪 carries no ``emotion`` key,
    so 「从来没填过」 and 「填了又清空」 do not persist as the same shape."""
    out = server._parse_shots(_answer())
    assert "emotion" not in out[0]
    assert "angle" not in out[0]
    # a whitespace-only answer is not an answer
    assert "angle" not in server._parse_shots(_answer(angle="   "))[0]
    # …and a non-string is refused rather than coerced into plausible text
    assert "angle" not in server._parse_shots(_answer(angle=7))[0]


def test_facets_are_truncated_like_every_other_agent_string(server) -> None:
    out = server._parse_shots(_answer(action="动" * 900))
    assert len(out[0]["action"]) == 500


def test_the_four_original_keys_are_unchanged(server) -> None:
    """§1.6 「响应契约不变」: this change is purely additive, so an un-migrated
    caller reading the old four keys sees exactly what it always saw."""
    out = server._parse_shots(_answer(angle="仰拍"))
    assert out[0]["sequence"] == 1
    assert out[0]["title"] == "S1-01"
    assert out[0]["description"] == "白天，算法实验室"
    assert out[0]["duration_seconds"] == 6.0


# --- 3. the three lists name the same fields -------------------------------- #


def test_the_server_carries_every_optional_facet_the_schema_declares(
    server, shot_schema
) -> None:
    """The server's list must be a SUPERSET of the schema's optional strings.

    A facet the package invites the model to produce and the transport drops is
    invisible to everyone: the run succeeds, the field is blank, and nothing
    anywhere reports a loss. That is the failure mode this whole card exists to
    remove, so it is checked rather than commented."""
    optional_strings = {
        key
        for key, spec in shot_schema["fields"].items()
        if spec.get("type") == "string" and key not in shot_schema["required"]
    }
    carried = set(server._SHOT_FACETS)
    assert optional_strings <= carried, optional_strings - carried
    # the two REQUIRED strings ride the same path (they are not in the four
    # hardcoded keys either), so they must be carried too
    assert {"shotSize", "cameraMotion"} <= carried


def test_the_client_and_the_server_agree_on_what_is_additive() -> None:
    """`ADDITIVE_SHOT_FIELDS` (src/ui/shoteditor.js) and `_SHOT_FACETS`
    (server.py) cannot share a constant across two languages, so the agreement
    is enforced instead of hoped for — the same posture
    `MAX_SHOTS_PER_EPISODE` already takes.

    The client list is deliberately the LARGER one: it also carries fields the
    Skill never produces (`environmentMotion`, the row `color` mark), which a
    creator types and which must survive a save. What must not happen is the
    reverse — the server carrying something the client then deletes."""
    js = (_MOCKUP / "src" / "ui" / "shoteditor.js").read_text("utf-8")
    match = re.search(r"export const ADDITIVE_SHOT_FIELDS = \[(.*?)\];", js, re.DOTALL)
    assert match, "ADDITIVE_SHOT_FIELDS is gone or was renamed"
    client = set(re.findall(r'"([A-Za-z_]+)"', match.group(1)))
    assert client, "the client list parsed empty — the guard would pass vacuously"

    spec = importlib.util.spec_from_file_location(
        "motv_server_facets", _MOCKUP / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    # every facet the server carries must be one the client keeps on save
    assert set(module._SHOT_FACETS) <= client, set(module._SHOT_FACETS) - client

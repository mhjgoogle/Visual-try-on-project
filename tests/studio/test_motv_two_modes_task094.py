"""TASK-094 批次 0：「写 / 改」这个形状只有一份实现。

`script-draft` 已经把这件事做对了一次（TWO MODES, TWO CAPABILITIES）。089 / 088
两处要同样的形状，于是它变成一张表 `_TWO_MODES`，由 `_is_revision` /
`_skill_id_for` / `_extra_fenced` 三个读者共用 —— 三份拷贝正是其中一份会跟另两份
不一致的成因。

本批次不改任何端点的行为：它把 `script-draft` 用新机制重新表达一遍，并把
「writer 模式的 steer 不得被丢掉」这条规则钉住，因为接下来两段依赖它。
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP = _REPO / "mockups" / "motv-workspace"


@pytest.fixture()
def srv(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location(
        f"motv_server_094_{tmp_path.name}", _MOCKUP / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "_RUNS_PATH", tmp_path / "runs.json")
    monkeypatch.setattr(module, "_RUNS", None)
    monkeypatch.setattr(module, "_executor_argv", lambda n: (["fake", n], "path"))
    return module


def _stub(module, monkeypatch, answer):
    seen: list[str] = []

    def fake(name, prompt, timeout, on_spawn=None):
        seen.append(prompt)
        return answer, None

    monkeypatch.setattr(module, "_run_executor", fake)
    return seen


def _post(app, path, payload, headers=None):
    resp = app.handle_post(path, json.dumps(payload).encode("utf-8"), headers or {})
    return resp.status, json.loads(resp.body.decode("utf-8"))


# --- the table is the only definition of the mode ---------------------------- #


def test_an_endpoint_with_no_second_mode_never_reports_a_revision(srv) -> None:
    """`_is_revision` answers for the endpoint it is asked about.

    Guessing from a key that happens to be present is how `shots-draft` would
    start selecting a reviser that does not exist for it.
    """
    for slug in ("shots-draft", "bible-breakdown"):
        assert srv._is_revision(slug, {"instruction": "改一下"}) is False
        assert (
            srv._skill_id_for(slug, {"instruction": "改一下"})
            == (srv._AGENT_SKILL_IDS[slug])
        )


def test_script_draft_keeps_its_own_rule_exactly(srv) -> None:
    """`base_decides=False`: on THIS endpoint a non-empty instruction alone means
    revision, and a missing base script is refused rather than quietly written
    over (the documented decision at `_TwoModes`)."""
    assert srv._is_revision("script-draft", {"idea": "一句创意"}) is False
    assert srv._is_revision("script-draft", {"instruction": "   "}) is False
    assert srv._is_revision("script-draft", {"instruction": "结尾加反转"}) is True
    # …with no base script either — still revision mode, so `missingInputs`
    # refuses instead of the writer inventing a script
    assert srv._skill_id_for("script-draft", {"instruction": "结尾加反转"}) == (
        "script-reviser"
    )
    assert srv._skill_id_for("script-draft", {"idea": "i"}) == "script-writer"


def test_base_decides_endpoints_treat_an_absent_base_as_writer_mode(srv) -> None:
    """The flag exists because 「重新规划」 legitimately sends a steer with no base.

    Registered under a scratch slug so this asserts the MECHANISM (批次 0), not a
    particular endpoint's registration — those arrive with 批次 A / C.
    """
    mode = srv._TwoModes(
        writer="w",
        reviser="r",
        steer_key="instruction",
        base_key="current",
        base_decides=True,
    )
    srv._TWO_MODES["_probe"] = mode
    srv._AGENT_SKILL_IDS["_probe"] = "w"
    try:
        assert srv._is_revision("_probe", {"instruction": "改"}) is False
        assert srv._is_revision("_probe", {"instruction": "改", "current": {}}) is False
        assert srv._is_revision("_probe", {"current": {"a": 1}}) is False
        assert srv._is_revision("_probe", {"instruction": "改", "current": {"a": 1}})
        assert srv._skill_id_for("_probe", {"instruction": "改"}) == "w"
        assert (
            srv._skill_id_for("_probe", {"instruction": "改", "current": {"a": 1}})
            == "r"
        )
    finally:
        del srv._TWO_MODES["_probe"]
        del srv._AGENT_SKILL_IDS["_probe"]


def test_a_writer_mode_steer_is_still_fenced_and_a_reviser_one_is_not(srv) -> None:
    """The rule the next two batches rest on.

    Dropping the `_EXTRA_FENCED` entry outright — which is what `script-draft`
    could safely do — would silently discard the steer on an endpoint whose
    writer mode legitimately carries one. Fencing it in revision mode would send
    the same creator text twice, under two different headings.
    """
    mode = srv._TwoModes(
        writer="w",
        reviser="r",
        steer_key="instruction",
        base_key="current",
        base_decides=True,
    )
    srv._TWO_MODES["_probe"] = mode
    srv._EXTRA_FENCED["_probe"] = (("instruction", "修改要求"),)
    try:
        # writer mode: the steer has no home among the writer's declared inputs
        assert srv._extra_fenced("_probe", {"instruction": "偏权谋"}) == (
            ("instruction", "修改要求"),
        )
        # revision mode: it IS a declared input now, so it is not fenced again
        assert (
            srv._extra_fenced("_probe", {"instruction": "偏权谋", "current": {"a": 1}})
            == ()
        )
    finally:
        del srv._TWO_MODES["_probe"]
        del srv._EXTRA_FENCED["_probe"]


def test_every_two_mode_endpoint_stops_double_fencing_its_steer(srv) -> None:
    """The rule 批次 0 established, now asserted for EVERY registered endpoint.

    This started as 「`story-develop` / `episode-plan` still behave exactly as
    before」 — a deliberately temporary guard, and it did its job twice: registering
    `episode-plan` (批次 A) and then `story-develop` (批次 C) each made it fail
    rather than letting the change pass unnoticed. What survives is the invariant
    that outlives the migration: in writer mode the steer is fenced, in reviser
    mode it is a declared input and must not be fenced a second time.
    """
    assert set(srv._TWO_MODES) == {"script-draft", "episode-plan", "story-develop"}
    for slug, base_key in (
        ("story-develop", "current"),
        ("episode-plan", "current_plan"),
    ):
        mode = srv._TWO_MODES[slug]
        assert mode.steer_key == "instruction"
        # writer mode: no base, so the steer has no declared home → fenced
        assert srv._extra_fenced(slug, {"instruction": "改"}) == (
            ("instruction", "修改要求"),
        )
        # reviser mode: it IS a declared input now → not fenced again
        base = [{"epNumber": 1}] if base_key == "current_plan" else {"storyCore": "x"}
        assert srv._extra_fenced(slug, {"instruction": "改", base_key: base}) == ()
        assert (
            srv._skill_id_for(slug, {"instruction": "改", base_key: base})
            == mode.reviser
        )


# --- and the endpoint behaviour is unchanged end-to-end ---------------------- #


def test_script_revision_still_carries_its_base_script_as_domain_context(
    srv, monkeypatch
) -> None:
    """The behaviour `script-draft`'s comment was written for, re-asserted through
    the new mechanism: the base script reaches the prompt (it is DOMAIN CONTEXT,
    not a steer) and the reviser is the package that answers."""
    seen = _stub(srv, monkeypatch, '{"script":"改好的正文"}')
    app = srv._App(None, None)
    status, body = _post(
        app,
        "/api/agent/script-draft",
        {"base_script": "原稿正文", "instruction": "结尾加一个反转"},
    )
    assert status == 200, body
    assert "原稿正文" in seen[0], "修订失去了它要修订的东西"
    assert "结尾加一个反转" in seen[0]
    # ONE fence for the revision request, not two (the steer is declared now)
    assert seen[0].count("结尾加一个反转") == 1


def test_a_writer_mode_plan_steer_still_reaches_the_prompt(srv, monkeypatch) -> None:
    """「🪄 重新规划」 sends a steer with NO current plan. That is writer mode, and the
    steer must still arrive — this is exactly what `base_decides=True` protects."""
    seen = _stub(
        srv,
        monkeypatch,
        '{"episodes":[{"epNumber":1,"title":"t","coreGoal":"g","keyEvents":["e"]}]}',
    )
    app = srv._App(None, None)
    status, body = _post(
        app,
        "/api/agent/episode-plan",
        {"outline": {"logline": "l"}, "instruction": "偏权谋"},
    )
    assert status == 200, body
    assert "偏权谋" in seen[0]
    assert srv._skill_id_for("episode-plan", {"instruction": "偏权谋"}) == (
        "episode-planner"
    )

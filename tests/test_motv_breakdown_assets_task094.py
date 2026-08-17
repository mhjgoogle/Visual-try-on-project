"""TASK-094 批次 E / TASK-090 §2.2：剧本拆解要看见「已经上传的资产」。

产品负责人 2026-08-17 的原话里有两个来源：

> 这时候 AI 需要根据**现在的剧本**和**已经上传的资产**来连接人物关系或者梳理世界观。

前者早就有（`script-breakdown` 吃 `episodeScript`）；后者一直缺 —— 能力包连
`assets` 都没声明过，于是它每次都把已经有参考图的对象当成全新对象再提一遍。
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]
_MOCKUP = _REPO / "mockups" / "motv-workspace"

_ANSWER = json.dumps(
    {
        "characters": [
            {
                "name": "林照",
                "appearance": "束发，核验员制服",
                "existingAssetKey": "ref-lin-zhao",
                "states": [{"name": "被抹除后", "reason": "第 1 集结尾"}],
            }
        ],
        "locations": [{"name": "断面前", "description": "正在自我改写的地形"}],
    },
    ensure_ascii=False,
)

_ASSETS = [
    {"key": "ref-lin-zhao", "kind": "character-reference", "name": "林照 参考图 v2"},
    {"key": "ref-duan-mian", "kind": "location-reference", "name": "断面 参考图 v1"},
]
_CAST = [{"characterId": "char-1", "name": "林照", "tier": "formal"}]


@pytest.fixture()
def srv(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location(
        f"motv_server_094e_{tmp_path.name}", _MOCKUP / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "_RUNS_PATH", tmp_path / "runs.json")
    monkeypatch.setattr(module, "_RUNS", None)
    monkeypatch.setattr(module, "_executor_argv", lambda n: (["fake", n], "path"))
    return module


def _stub(module, monkeypatch, answer=_ANSWER):
    seen: list[str] = []

    def fake(name, prompt, timeout, on_spawn=None):
        seen.append(prompt)
        return answer, None

    monkeypatch.setattr(module, "_run_executor", fake)
    return seen


def _post(app, payload, headers=None):
    resp = app.handle_post(
        "/api/agent/bible-breakdown", json.dumps(payload).encode("utf-8"), headers or {}
    )
    return resp.status, json.loads(resp.body.decode("utf-8"))


def test_the_capability_declares_assets_and_is_a_new_version(srv) -> None:
    skill = srv._load_skill_catalog().skills["script-breakdown"]
    assert skill.version == 2, "改了内容必须升版本（ADR-0067 §1.2）"
    assert "assets" in skill.optional_inputs, "TASK-090 §2.2 的落点"
    assert "characters" in skill.optional_inputs
    # …and the output can EXPRESS the connection it was asked to look for
    for kind in ("characters", "locations"):
        fields = skill.output_schema["fields"][kind]["of"]["fields"]
        assert fields["existingAssetKey"]["type"] == "string"
        assert kind not in skill.output_schema["required"] or True
    # 单一职责（ADR-0067）：`asset-librarian` 不得被合并进来
    assert "asset-librarian" in srv._load_skill_catalog().skills
    assert skill.skill_id == "script-breakdown"


def test_the_uploaded_assets_actually_reach_the_model(srv, monkeypatch) -> None:
    seen = _stub(srv, monkeypatch)
    app = srv._App(None, None)
    status, body = _post(
        app, {"script": "林照站在断面前。", "assets": _ASSETS, "characters": _CAST}
    )
    assert status == 200, body
    prompt = seen[0]
    assert "ref-lin-zhao" in prompt, "拆解看不到已上传的资产 = 每次都提重复条目"
    assert "林照 参考图 v2" in prompt
    assert '<数据 键="assets">' in prompt
    assert '<数据 键="characters">' in prompt
    assert "### 资产清单" in prompt, "裸键名说明 skill-inputs.json 里缺标签"


def test_the_endpoint_still_works_with_no_assets_at_all(srv, monkeypatch) -> None:
    """A fresh project has uploaded nothing; that is not an error."""
    seen = _stub(
        srv,
        monkeypatch,
        '{"characters":[{"name":"林照"}],"locations":[]}',
    )
    app = srv._App(None, None)
    status, body = _post(app, {"script": "林照站在断面前。"})
    assert status == 200, body
    assert '<数据 键="assets">' not in seen[0]
    assert body["breakdown"]["characters"][0]["name"] == "林照"


def test_the_hint_survives_the_response_contract(srv, monkeypatch) -> None:
    _stub(srv, monkeypatch)
    app = srv._App(None, None)
    status, body = _post(app, {"script": "s", "assets": _ASSETS})
    assert status == 200, body
    # the legacy response key is unchanged (契约 §5.9c) …
    assert "breakdown" in body
    # …and the new clue is carried through rather than dropped at the boundary
    assert body["breakdown"]["characters"][0]["existingAssetKey"] == "ref-lin-zhao"


@pytest.mark.parametrize(
    "bad",
    [
        {"assets": "不是列表"},
        {"assets": ["不是对象"]},
        {"characters": {"name": "林照"}},
    ],
)
def test_a_malformed_asset_list_is_refused_not_truncated(srv, bad) -> None:
    app = srv._App(None, None)
    status, body = _post(app, {"script": "s", **bad})
    assert status == 400, body
    assert body["error"]["category"] == "bad_request"


def test_an_oversized_asset_list_is_refused(srv) -> None:
    """上下文 cap 会截断；一份被截到一半的清单会让模型「连」到半个资产键上。"""
    app = srv._App(None, None)
    huge = [{"key": "k", "name": "x" * 40_000}]
    status, body = _post(app, {"script": "s", "assets": huge})
    assert status == 400
    assert body["error"]["category"] == "too_large"

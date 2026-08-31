"""体检自己要经得起检（2026-08-31）。

产品负责人同意先做体检（`docs/design/active/proposal-one-surface-list.md` 第一步）。
写它的过程里它**喊了三次狼**：把镜头域输入、把 `subtitles`/`generations`、
把由调用方传入的 `revisionRequest` 各报成一次「没有映射」。

**一个喊狼的体检比没有体检更糟** —— 它教人忽略红字。所以这几条各留一个测试：
四种「已提供」的写法都要认得。
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
DOCTOR = REPO / ".claude" / "tools" / "motv_doctor.py"


@pytest.fixture(scope="module")
def doc():
    spec = importlib.util.spec_from_file_location("motv_doctor", DOCTOR)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def test_it_finds_the_surfaces_a_project_really_has(doc):
    """只列**写过东西的**面：空的面不出现在事实里是正常的（那正是「还没写」）。"""
    canvas = {
        "story": {
            "work": {
                "core": "有内容",
                "outline": {"nodes": [{"id": "on-1", "text": "开端"}]},
                "plan": {
                    "rows": [{"id": "sp-1"}, {"id": "sp-2", "hidden": {"at": "T"}}]
                },
                "units": [{"no": 1, "body": "正文"}, {"no": 2, "body": ""}],
                "finalized": {"core": [{"v": 1, "body": "定稿"}]},
            }
        },
        "production": {
            "characters": [{"name": "林晚"}],
            "locations": [],
            "episodes": [],
        },
    }
    names = {s["名字"]: s for s in doc.surfaces_of(canvas)}
    assert set(names) == {
        "故事核心",
        "故事大纲",
        "结构规划",
        "正文",
        "定稿版本",
        "人物",
    }
    assert names["结构规划"]["量"] == "1 行", "删掉的行不算"
    assert names["正文"]["量"] == "1 章/集有字", "空的那一章不算"
    assert "场景地" not in names, "一个都没有的面不该出现"


def test_every_way_of_providing_an_input_is_recognised(doc):
    """四种写法都算「已提供」—— 每一种都对应它曾经喊过的一次狼。"""
    rows = doc.check_skill_inputs()
    bad = [r for r in rows if r["state"] == doc.BAD]
    assert not bad, "体检说这些输入没人提供：" + "、".join(r["名字"] for r in bad)


def test_a_stub_write_path_is_RED_not_a_warning(doc):
    """「接了但返回『尚未接线』」必须是红的。

    它在每一处静态检查里都表现为「已实现」，而他看到的是「写好了」之后什么都没发生 ——
    2026-08-30 的大纲、08-31 的正文，都是这一种。
    """
    rows = doc.check_write_paths()
    stub_rows = [r for r in rows if "尚未接线" in str(r.get("名字", ""))]
    for r in stub_rows:
        assert r["state"] == doc.BAD


def test_it_fails_closed_when_it_cannot_tell(doc):
    """判不了的判「未知」，不判「通过」：一个假的 ✓ 比一个诚实的 ⚠ 危险得多。"""
    surfaces = doc.surfaces_of(
        {"production": {"blocking": {"sh1": {"actors": [{"name": "甲"}]}}}}
    )
    blocking = [s for s in surfaces if s["名字"] == "白膜"]
    assert blocking, "摆过位的镜头要被列出来"
    assert blocking[0]["probe"], "它必须有探针 —— 没有探针就说不了它在不在事实里"


def test_the_report_renders_without_a_project(doc, tmp_path, monkeypatch, capsys):
    """空目录不该炸 —— 它只是「这里没有项目」。"""
    monkeypatch.setattr(sys, "argv", ["motv_doctor", "--root", str(tmp_path)])
    code = doc.main()
    out = capsys.readouterr().out
    assert "没有找到项目" in out
    assert code == 0, "没有项目不是缺陷，是一个真实状态"


def test_json_mode_is_machine_readable(doc, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["motv_doctor", "--root", str(tmp_path), "--json"])
    doc.main()
    payload = json.loads(capsys.readouterr().out)
    assert payload["worst"] in (doc.OK, doc.WARN, doc.BAD)
    assert isinstance(payload["sections"], list)

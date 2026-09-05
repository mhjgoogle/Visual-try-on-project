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
    assert "没找到项目" in out
    assert code == 0, "没有项目不是缺陷，是一个真实状态"


def test_json_mode_is_machine_readable(doc, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["motv_doctor", "--root", str(tmp_path), "--json"])
    doc.main()
    payload = json.loads(capsys.readouterr().out)
    assert payload["worst"] in (doc.OK, doc.WARN, doc.BAD)
    assert isinstance(payload["sections"], list)


def test_it_looks_where_the_launcher_actually_puts_projects(doc):
    """体检默认查的目录，必须是启动器默认写的那个。

    2026-08-31：它默认查 `~/MotvProjects`，那里是空的，于是报「0 个项目」就收工 ——
    挂在提交闸门上、一路绿、**什么都没检查**。而 `studio.ps1` 的默认 `-AssetRoot`
    是**仓库的父目录**。查错地方的体检不会报错，只会一直绿，那是最坏的一种。
    """
    cands = [str(c) for c in doc.root_candidates()]
    assert str(REPO.parent) in cands, "启动器的默认位置不在候选里"
    assert str(REPO.parent / "MotvProjects") in cands
    # 有项目的那个优先 —— 否则第一个候选就把后面的挡住了
    picked, looked = doc.default_root()
    assert looked, "没有记录找过哪些地方"
    if any(doc.projects_in(Path(c)) for c in cands):
        assert doc.projects_in(picked), f"选了一个空目录：{picked}"


def test_no_project_says_where_it_looked(doc, tmp_path, monkeypatch, capsys):
    """「0 个项目」必须带上找过的地方。

    不然它看着像「他还没建项目」，实际是「我查错了地方」—— 这两件事的处置完全相反。
    """
    monkeypatch.setattr(sys, "argv", ["motv_doctor.py", "--root", str(tmp_path)])
    doc.main()
    out = capsys.readouterr().out
    assert "没找到项目" in out


def test_the_report_survives_a_non_utf8_console(doc, tmp_path, monkeypatch, capsys):
    """体检自己不许因为编码崩掉。

    这台机器的控制台是 cp932，报告里的 `⚠` 编不出去 —— 体检抛 `UnicodeEncodeError`、
    退出码非零。它现在挂在提交闸门上，那等于**每一个前端提交都被一个没检查完的
    体检挡住**（2026-08-31 实测）。因为自己崩掉而报红，比不检查更糟。
    """
    assert hasattr(doc, "_utf8_stdout"), "输出没有做编码兜底"
    doc._utf8_stdout()  # 不许抛
    monkeypatch.setattr(sys, "argv", ["motv_doctor.py", "--root", str(tmp_path)])
    assert doc.main() == 0
    assert "⚠" in capsys.readouterr().out


def test_the_plan_probe_matches_what_the_facts_actually_report(doc):
    """探针必须挑**事实真的会报出来的那一行**。

    `_conv_facts` 只给前 20 行结构规划。上一版拿 `rows[-1]` 当探针 —— 于是超过
    20 行的项目一律判 BAD，**而这个体检挂在提交闸门上，会挡住所有前端提交**
    （codex 补审 2026-09-05 块 1）。一个喊狼的体检比没有体检更糟。
    """
    rows = [{"id": f"sp-{i}", "unitNo": str(i)} for i in range(30)]
    surfaces = doc.surfaces_of({"story": {"work": {"plan": {"rows": rows}}}})
    plan = next((s for s in surfaces if s["名字"] == "结构规划"), None)
    assert plan is not None, "30 行的结构规划没有被认出来"
    assert plan["probe"] == "sp-19", (
        f"探针挑了 {plan['probe']} —— 事实只报前 20 行，第 21 行往后不会出现"
    )


def test_a_handler_that_mentions_no_write_is_a_warning_not_a_pass(doc):
    """「接了」不等于「会写」。

    上一版只认一种坏法（`return { ok: false, error: "…尚未接线" }`），别的空实现
    一律算 OK —— 体检给出一个它其实没验过的通过。静态地证明「它真的写了」做不到，
    但**能证明它连一处写都没提到**：那时报 WARN 并说清是「看不出」，
    不是「坏了」。**体检可以不知道，但不可以假装知道。**
    """
    rows = doc.check_write_paths()
    named = {r["名字"]: r for r in rows}
    assert "接了但看不出它写了什么" in named, "这一类根本没有被查"
    assert named["接了但看不出它写了什么"]["state"] == doc.WARN, (
        "把「看不出」判成了 BAD —— 那会变成喊狼"
    )

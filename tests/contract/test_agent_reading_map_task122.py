"""改了页面，Agent 的读取清单必须跟着改 —— 这条由测试强制（TASK-122）。

产品负责人 2026-08-30：

    「所以前端服务是看哪里的内容来进行创作的呢。首先我在对话框的文字要看吧。然后
     既定资产看哪里。这要写在 skill 里面吗。你每次改内容的时候必须要结合这个设计做
     修改才不会短线。」

他说中了当天三个 bug 的**同一个根因**：页面改了，喂给 Agent 的那份「世界观」没跟着改。

    · 他写了 869 字故事核心 → Agent 说「故事核心和创意简报都还是空的」
    · 他问「什么是创意简报」 → 那一页早就不在左栏了
    · 能力就绪提示说「还缺 创意 Brief」 → 因为它读的还是旧的创意简报文档

**Agent 读四样东西**（这份测试守的就是这四条与界面同步）：

    1. 他在对话框里打的那句话          —— 直接传给模型
    2. 项目当前事实 `_conv_facts`      —— 服务端读 canvas.json
    3. 它能做的动作 `convactions`      —— 前端的动作表（他能点的 = 它能做的）
    4. 既定资产（canon 输入）`skillctl` —— 能力运行时的上游材料

skill 本身**不**是这份清单：manifest 只声明它要 `brief` / `outline` 这些**名字**，
名字落到哪份数据由第 4 条决定。今天的 bug 正是名字还在、数据换了地方。

这份测试是跨 py↔js 的合同（ADR-0080 决策 3：跨边界验证只住 tests/contract/）。
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
MOCKUP = REPO / "mockups" / "motv-workspace"
SERVER = MOCKUP / "server.py"

#: 故事开发左栏画出来的四页 → 它的数据住在 canvas.json 的哪里。
#: **这张表就是那份「设计」**：改页面就要改这里，改这里就会有测试提醒你去改别处。
STORY_SURFACES = {
    "故事核心": "story.work.core",
    "故事大纲": "story.work.outline",
    "结构规划": "story.work.plan",
    "正文创作": "story.work.units",
}

#: 已经不存在的说法。Agent 一旦提起，他就会像 2026-08-30 那样问「什么是创意简报」。
RETIRED_NAMES = ("创意简报", "项目与创意", "分集规划", "本集剧本")


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location("motv_server_reading_map", SERVER)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _rail_labels() -> list[str]:
    """左栏真正画出来的那几行 —— 从 shell.js 的 NAV 读，不手抄。"""
    text = (MOCKUP / "src" / "ui" / "shell.js").read_text("utf-8")
    block = text[
        text.index("export const NAV = [") : text.index("export const EPISODE_NAV")
    ]
    rows = re.findall(r'\["([a-z]+)",\s*"[^"]*",\s*"([^"]+)"(,\s*\{[^}]*\})?\]', block)
    return [label for _key, label, opts in rows if "hidden" not in (opts or "")]


# --- 1. 界面与 Agent 的页面地图必须一致 -------------------------------------- #


def test_every_page_on_screen_is_in_the_map_the_agent_gets(srv):
    for label in _rail_labels():
        assert label in srv._CONV_PAGE_MAP, (
            f"左栏有「{label}」，但 Agent 拿到的页面地图里没有 —— 它会用旧地图给他指路"
        )


def test_the_map_names_no_page_that_no_longer_exists(srv):
    drawn = _rail_labels()
    body = srv._CONV_PAGE_MAP.split("**这些名字已经没有了")[0]
    for name in RETIRED_NAMES:
        assert name not in body or name in drawn, (
            f"页面地图仍在介绍已经没有的「{name}」"
        )


def test_the_retired_names_are_explicitly_forbidden(srv):
    for name in RETIRED_NAMES:
        assert name in srv._CONV_PAGE_MAP, f"「{name}」没有被显式禁掉，模型还会说它"


# --- 2. 屏幕上有的内容，事实里必须也有 --------------------------------------- #


def _canvas_with_everything() -> dict:
    return {
        "schemaVersion": 19,
        "story": {
            "idea": "",
            "brief": {"versions": [], "draft": {}, "active": 0},
            "versions": [],
            "work": {
                "form": "novel",
                "core": "核心那一篇的内容",
                "outline": {
                    "nodes": [{"id": "on-x1", "kind": "para", "text": "开端那一段"}]
                },
                "plan": {
                    "rows": [
                        {
                            "id": "sp-r01",
                            "unitNo": "1",
                            "scene": "表里那一格",
                            "outlineRefs": ["on-x1"],
                            "hidden": None,
                        }
                    ]
                },
                "planned": {"novel": 2, "episode": 0},
                "units": [
                    {
                        "id": "u-1",
                        "kind": "novel",
                        "no": 1,
                        "title": "",
                        "body": "正文那一段",
                        "finalized": [],
                    }
                ],
            },
        },
        "production": {"episodes": [], "characters": []},
        "nodes": [],
    }


def test_each_surface_reaches_the_facts(tmp_path, srv):
    account = tmp_path / "MotvProjects"
    root = account / "作品"
    (root / "studio").mkdir(parents=True)
    (root / "studio" / "canvas.json").write_text(
        json.dumps(_canvas_with_everything(), ensure_ascii=False), "utf-8"
    )
    app = srv._App(account)
    app._projects["作品"] = root
    facts = app._conv_facts("作品")
    for probe, where in (
        ("核心那一篇的内容", "story.work.core"),
        ("开端那一段", "story.work.outline"),
        ("on-x1", "大纲节点的稳定 id（结构规划靠它引用）"),
        ("表里那一格", "story.work.plan"),
        ("sp-r01", "结构规划的行 id（Agent 要能指名改哪一行）"),
        ("正文那一段", "story.work.units"),
    ):
        assert probe in facts, (
            f"屏幕上有 {where}，事实里没有 —— Agent 只能否认他刚做的事"
        )


# --- 3. 既定资产：能力从他真正写的地方取 ------------------------------------- #


def test_canon_inputs_read_where_he_actually_writes():
    """`skillctl` 的 canon 输入必须读 `story.work`，不是只读旧的简报/版本链。"""
    src = (MOCKUP / "src" / "controllers" / "skillctl.js").read_text("utf-8")
    assert "canonBrief(" in src and "canonOutline(" in src, (
        "canon 输入还是直接读 activeBrief/approvedOutline —— "
        "他写在故事核心里的东西对能力就不算数"
    )
    assert "work.core" in src, "canonBrief 没有读故事核心"
    assert "work.outline" in src, "canonOutline 没有读新大纲"


def test_the_upstream_label_matches_the_page_he_sees():
    labels = (MOCKUP / "src" / "workflow" / "canondoc.js").read_text("utf-8")
    block = labels[labels.index("export const UPSTREAM_LABEL") :][:400]
    # 只看**值**，不看注释 —— 注释里保留旧名字是为了记住为什么改（那正是 ADR 的作用）
    values = [m for m in block.splitlines() if ":" in m and "//" not in m]
    assert not any("创意 Brief" in v for v in values), (
        "就绪提示还在说一个左栏上没有的名字"
    )
    assert "故事核心" in block


# --- 4. 动作表：他能点的，Agent 就能做 --------------------------------------- #


def test_the_agent_can_write_every_surface_it_can_read():
    """读得到却改不了，就是 2026-08-30 那句「这个前端的 agent 还是改不了」。"""
    actions = (MOCKUP / "src" / "workflow" / "convactions.js").read_text("utf-8")
    for action, surface in (
        ("work.core", "故事核心"),
        ("work.outline", "故事大纲"),
        ("plan.row.edit", "结构规划"),
        ("unit.write", "正文创作"),
    ):
        assert f'id: "{action}"' in actions, (
            f"{surface} 读得到但改不了：缺动作 {action}"
        )

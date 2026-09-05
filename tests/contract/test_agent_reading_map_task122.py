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


# --- 定稿的东西：看得见，也改得动（2026-08-31）------------------------------ #
#
# 产品负责人 2026-08-31：「你要保证服务端的 agent 可以看到所有我定稿的东西
# 然后也可以根据我的意见修改。」
#
# 「保证」这个词落到代码里就是这两条测试：**每一样能定稿的东西，事实里必须出现，
# 动作表里必须有对应的写路径**。少了任何一半，他说「按定稿那版改」时都会落空 ——
# 看不见的改不了，改不了的看见也没用。

#: 他能主动「定稿」的四样，以及各自定稿版本存在文档的哪里。
FINALIZABLE = {
    "故事核心": "story.work.finalized.core",
    "故事大纲": "story.work.finalized.outline",
    "结构规划": "story.work.finalized.plan",
    "正文": "story.work.units[].finalized",
}


def _canvas_with_finalized() -> dict:
    doc = _canvas_with_everything()
    work = doc["story"]["work"]
    work["finalized"] = {
        "core": [
            {
                "v": 1,
                "at": "2026-08-30T01:00:00Z",
                "note": "第一稿",
                "body": "定稿的故事核心一",
            },
            {
                "v": 2,
                "at": "2026-08-31T02:00:00Z",
                "note": "改完悬念",
                "body": "定稿的故事核心二",
            },
        ],
        "outline": [
            {"v": 1, "at": "2026-08-30T03:00:00Z", "note": "", "body": "定稿的大纲"}
        ],
        "plan": [{"v": 1, "at": "2026-08-30T04:00:00Z", "note": "", "body": "[]"}],
    }
    work["units"][0]["finalized"] = [
        {
            "v": 1,
            "at": "2026-08-30T05:00:00Z",
            "note": "",
            "title": "",
            "body": "定稿的第一章正文",
        }
    ]
    return doc


def test_every_finalized_version_reaches_the_agent(tmp_path, srv):
    account = tmp_path / "MotvProjects"
    root = account / "作品"
    (root / "studio").mkdir(parents=True)
    (root / "studio" / "canvas.json").write_text(
        json.dumps(_canvas_with_finalized(), ensure_ascii=False), "utf-8"
    )
    app = srv._App(account)
    app._projects["作品"] = root
    facts = app._conv_facts("作品")

    assert "已定稿的版本" in facts, "定稿这件事必须在事实里有名字"
    # 最新那一版给全文 —— 他说「定稿的那版」通常就是指它
    assert "定稿的故事核心二" in facts
    assert "定稿的大纲" in facts
    assert "定稿的第一章正文" in facts
    # 更早的版本至少要报出来，否则他说「回到 v1」时 Agent 不知道有 v1
    assert "v1" in facts and "第一稿" in facts


def test_no_finalized_version_says_so_instead_of_staying_silent(tmp_path, srv):
    account = tmp_path / "MotvProjects"
    root = account / "作品"
    (root / "studio").mkdir(parents=True)
    (root / "studio" / "canvas.json").write_text(
        json.dumps(_canvas_with_everything(), ensure_ascii=False), "utf-8"
    )
    app = srv._App(account)
    app._projects["作品"] = root
    facts = app._conv_facts("作品")
    assert "已定稿的版本：还没有" in facts, "沉默会被读成「没有这回事」"


def test_the_agent_can_write_every_finalizable_surface():
    """看得见还不够 —— 他说「按定稿那版改」「把 v2 删了」时要能落成真动作。"""
    actions = (MOCKUP / "src" / "workflow" / "convactions.js").read_text("utf-8")
    for action, why in (
        ("work.finalize", "存一版定稿"),
        ("work.restoreVersion", "恢复到某一版定稿"),
        ("work.deleteVersion", "删掉某一版定稿"),
    ):
        assert f'id: "{action}"' in actions, f"缺动作 {action}（{why}）"


def test_the_agent_can_write_the_base_assets_too():
    """人物 / 人物关系 / 世界观是「基础财产」—— 他在那三页能改的，Agent 也要能改。"""
    actions = (MOCKUP / "src" / "workflow" / "convactions.js").read_text("utf-8")
    for action, surface in (
        ("character.fields", "人物"),
        ("relationship.fields", "人物关系"),
        ("world.fields", "世界观"),
    ):
        assert f'id: "{action}"' in actions, f"{surface} 改不了：缺动作 {action}"


def test_the_recycle_bin_is_readable_because_undelete_is_writable(tmp_path, srv):
    """他删掉的版本要报进事实 —— 只报「有哪一版」，不复述内容。

    删版本在 2026-09-05 改成了软删除：界面上有「拿回来」，动作表里有
    `work.undeleteVersion`。补审第四轮指出，facts 把删掉的版本整个滤掉之后，
    **Agent 无从得知那一版存在** —— 一条读不到目标的写动作，正是 CA §6 要防的
    读写错位（他能拿回来，Agent 不能）。

    另一半同样重要：**不复述内容**。他删掉的东西不该在回答里作为还在用的素材出现。
    """
    doc = _canvas_with_finalized()
    core = doc["story"]["work"]["finalized"]["core"]
    core[0]["deleted"] = {"at": "2026-09-05T00:00:00Z"}

    account = tmp_path / "MotvProjects"
    root = account / "作品"
    (root / "studio").mkdir(parents=True)
    (root / "studio" / "canvas.json").write_text(
        json.dumps(doc, ensure_ascii=False), "utf-8"
    )
    app = srv._App(account)
    app._projects["作品"] = root
    facts = app._conv_facts("作品")

    assert "回收区" in facts, "删掉的版本一个字都没报 —— Agent 不知道它存在"
    assert "work.undeleteVersion" in facts, "没说怎么把它拿回来"
    assert core[0]["body"] not in facts, "删掉的内容被当成还在用的素材复述了"
    assert core[1]["body"] in facts, "还在的那一版反而不见了"


def test_truncation_says_how_much_is_missing_and_keeps_the_current_page(tmp_path, srv):
    """事实过长时：说清还剩多少，且**「现在在看」那一行不许被切掉**。

    它是最后追加的，于是一刀切尾时它第一个消失 —— 而它恰恰是 Agent 判断「他此刻
    在说哪一页的事」的唯一依据（codex 补审 2026-09-05 块 1）。上一版还只说
    「已截断」，Agent 无从判断自己少看了一句还是少看了一半。
    """
    doc = _canvas_with_everything()
    doc["story"]["work"]["core"] = "长" * 40000  # 远超聚合上限

    account = tmp_path / "MotvProjects"
    root = account / "作品"
    (root / "studio").mkdir(parents=True)
    (root / "studio" / "canvas.json").write_text(
        json.dumps(doc, ensure_ascii=False), "utf-8"
    )
    app = srv._App(account)
    app._projects["作品"] = root
    facts = app._conv_facts("作品", {"page": "story/brief"})

    assert "被截断了，后面还有" in facts, "截断了却没说还剩多少"
    assert re.search(r"后面还有 \d+ 字没给你", facts), "没有给出具体的字数"
    assert facts.rstrip().splitlines()[-1].startswith("现在在看："), (
        "「现在在看」被截断切掉了 —— Agent 于是不知道他在说哪一页"
    )


def test_the_plan_says_how_many_rows_it_left_out(tmp_path, srv):
    """只报前 20 行时要说还有多少行没报 —— 省略不许是静默的。"""
    doc = _canvas_with_everything()
    doc["story"]["work"]["plan"] = {
        "rows": [
            {"id": f"sp-{i}", "unitNo": str(i), "scene": f"第 {i} 场"}
            for i in range(30)
        ]
    }
    account = tmp_path / "MotvProjects"
    root = account / "作品"
    (root / "studio").mkdir(parents=True)
    (root / "studio" / "canvas.json").write_text(
        json.dumps(doc, ensure_ascii=False), "utf-8"
    )
    app = srv._App(account)
    app._projects["作品"] = root
    facts = app._conv_facts("作品")
    assert "后面还有 10 行没给" in facts, "少报了 10 行却一个字都没说"

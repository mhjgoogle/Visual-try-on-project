"""product-loop Skill：前端 Agent 与后端 Agent 之间那条回路的固定动作。

产品负责人 2026-08-29：「是不是需要建立一个前端agent和后端agent交互的skill呢。」

Skill 是**给 Agent 读的说明书**，所以它最容易烂的地方是：里面写的命令早就不存在了，
而没有任何东西会喊。这份测试守的就是那件事 —— 它提到的每个命令都真的能跑，
它引用的每份文档都真的在。
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SKILL = _REPO / ".claude" / "skills" / "product-loop" / "SKILL.md"


@pytest.fixture(scope="module")
def text() -> str:
    return _SKILL.read_text(encoding="utf-8")


def test_the_skill_is_where_the_loader_looks(text):
    assert _SKILL.is_file()
    assert text.startswith("---\n")
    head = text.split("---", 2)[1]
    assert "name: product-loop" in head
    assert "description:" in head


def test_every_flag_it_teaches_really_exists(text):
    """它教的那些命令行开关必须真的在工具里。"""
    tool = _REPO / ".claude" / "tools" / "read_feedback.py"
    assert tool.is_file()
    # PYTHONIOENCODING：帮助文本是中文，而 Windows 控制台默认 cp932 —— 不指定的话
    # argparse 打印时就崩了（真机上这条测试第一次跑就撞见）。
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    helped = subprocess.run(
        [sys.executable, str(tool), "--help"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        check=True,
    ).stdout
    # `--[a-z]…` 而不是 `--[a-z-]…`：frontmatter 的 `---` 会被后者当成一个开关
    flags = {f for f in re.findall(r"--[a-z][a-z-]*", text)}
    # `--body` 之类都在 help 里；`--path` 是给测试用的，也在
    for flag in flags:
        assert flag in helped, f"SKILL.md 教了 {flag}，但工具没有这个开关"


def test_it_points_at_documents_that_exist(text):
    for rel in re.findall(r"\]\((\.\./[^)]+)\)", text):
        target = (_SKILL.parent / rel.split("#", 1)[0]).resolve()
        assert target.exists(), f"SKILL.md 指向的 {rel} 不存在"


def test_it_states_the_three_boundaries(text):
    """三条边界守的是这条回路本身 —— 少一条都会变成另一个东西。"""
    assert "应用不自己改自己的源码" in text
    assert "作品的改动不走台账" in text
    assert "台账里的条目不删" in text


def test_it_says_execution_and_deploy_are_part_of_the_loop(text):
    """产品负责人 2026-08-29 两句话：

    「肯定要执行修改的…这是个反复的流程」「最终…要进入实际运用」。

    第一版把边界写成了「三条不许」，读起来像「谁都不许改前端」——那不是意图，
    而一条读错的规则会让下一次会话停在方案上。
    """
    assert "「执行」是这条回路的一环，不是被禁的动作" in text
    assert "重启 studio 服务" in text
    assert "他刷新之后多半有新意见" in text


def test_it_tells_the_agent_what_each_verdict_means(text):
    for verdict in ("approved", "changes", "rejected"):
        assert verdict in text
    # `changes` 里那句话是新的需求 —— 这条最容易被当成「已经同意了」
    assert "`note` 里那句话是新的需求" in text


def test_it_carries_the_lesson_from_two_agents_on_one_tree(text):
    """2026-08-29 的实测：两个会话同改三个文件，各漏半句话，合进去一个已知 P1。"""
    assert "「绿了」不等于「可以合」" in text
    assert "一次提交、双方署名" in text
    # 通配路径扫走别人未提交文件的那一课
    assert "路径要精确到文件" in text

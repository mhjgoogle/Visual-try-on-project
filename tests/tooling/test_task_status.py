"""`task_status.py` —— 任务状态语法的唯一源（ADR-0105 / TASK-150）。

五个工具都 import 它，所以它的每一条边界都值得单独钉住：一条正则漂了，
「进行中的有哪些」会在五个地方同时给出错误答案。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TOOLS = REPO_ROOT / ".claude" / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import task_status  # noqa: E402


@pytest.mark.parametrize("state", task_status.STATES)
def test_each_enum_word_is_read(state: str) -> None:
    assert task_status.state_of_text(f"# T\n\n- 状态：{state}\n") == state


@pytest.mark.parametrize(
    "line",
    [
        "- 状态：**进行中**",
        "- 状态：进行中 · **实现完成**（2026-09-14）",
        "- 状态: 进行中（英文冒号）",
        "-  状态：进行中",
        "- Status: 进行中",
    ],
)
def test_wrapping_and_trailing_prose_are_tolerated(line: str) -> None:
    """枚举词可以包在 `**` 里、后面可以接任何散文 —— 迁移时原文一字不丢就靠这条。"""

    assert task_status.state_of_text(f"# T\n\n{line}\n") == "进行中"


def test_a_crlf_card_is_read_the_same() -> None:
    """**Windows 工作树上的卡是 `\\r\\n`。** 按字节读的调用方（`agent_harness`）
    拿到的正是这个形状；`$` 只认 `\\n`，少了 `\\r` 一张都认不出来 ——
    `resume` 会说「没有在办的卡」（TASK-150 迁移当天实测）。"""

    assert task_status.state_of_text("# T\r\n\r\n- 状态：**进行中**\r\n") == "进行中"
    assert task_status.state_of_text("# T\r\n\r\n- 状态：完成 · 交付了\r\n") == "完成"


@pytest.mark.parametrize(
    "line",
    [
        "- 状态：完成度 80%",  # 「完成」是「完成度」的前缀，不是枚举
        "- 状态：已完成（2026-08-26）",  # 迁移前的旧写法，必须被迁移器前置枚举
        "- 状态：**实现完成**",
        "- 状态：",
        "- 目标：进行中",  # 不是状态行
    ],
)
def test_near_misses_are_not_states(line: str) -> None:
    assert task_status.state_of_text(f"# T\n\n{line}\n") is None


def test_only_the_first_state_line_counts() -> None:
    """正文里再出现一行「- 状态：完成」（比如引用别的卡）不改变卡头的判定。"""

    text = "# T\n\n- 状态：进行中\n\n## 正文\n\n- 状态：完成 —— 说的是 TASK-001\n"
    assert task_status.state_of_text(text) == "进行中"


def test_a_missing_state_raises_instead_of_guessing(tmp_path: Path) -> None:
    card = tmp_path / "TASK-001-x.md"
    card.write_text("# TASK-001\n\n- 类型：Refactor\n", encoding="utf-8")

    with pytest.raises(task_status.MissingState):
        task_status.task_state(card)


def test_cards_are_read_from_the_flat_folder_with_letter_suffixes(
    tmp_path: Path,
) -> None:
    tasks = tmp_path / "docs" / "tasks"
    tasks.mkdir(parents=True)
    (tasks / "TASK-051-a.md").write_text("# a\n\n- 状态：完成\n", encoding="utf-8")
    (tasks / "TASK-051A-b.md").write_text("# b\n\n- 状态：进行中\n", encoding="utf-8")
    (tasks / "TASK-051B-c.md").write_text("# c\n\n- 状态：待办\n", encoding="utf-8")
    (tasks / "review-record-TASK-051.md").write_text("# 不是卡\n", encoding="utf-8")

    cards = task_status.cards(tmp_path)
    assert set(cards) == {"TASK-051", "TASK-051A", "TASK-051B"}
    groups = task_status.by_state(tmp_path)
    assert [c.task for c in groups["进行中"]] == ["TASK-051A"]
    assert [c.task for c in groups["待办"]] == ["TASK-051B"]


def test_two_cards_with_one_id_raise(tmp_path: Path) -> None:
    tasks = tmp_path / "docs" / "tasks"
    tasks.mkdir(parents=True)
    (tasks / "TASK-102-a.md").write_text("# a\n\n- 状态：完成\n", encoding="utf-8")
    (tasks / "TASK-102-b.md").write_text("# b\n\n- 状态：完成\n", encoding="utf-8")

    with pytest.raises(ValueError):
        task_status.cards(tmp_path)


def test_the_real_repository_has_exactly_one_legal_state_per_card() -> None:
    """**对着真仓库跑。** 每张卡一行合法状态、每个任务号一张卡 —— 缺一条都会让
    「在办的有哪些」静默少一张。"""

    cards = task_status.cards(REPO_ROOT)
    assert len(cards) >= 140
    assert all(c.state in task_status.STATES for c in cards.values())
    assert not [p for p in (REPO_ROOT / "docs" / "tasks").iterdir() if p.is_dir()]

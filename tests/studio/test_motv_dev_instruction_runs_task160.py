"""TASK-160 / REQ-011 / ADR-0107：开发指令那一轮有工具、在仓库里跑。

这条路之所以敢开，全部理由只有一条：**它的提示词里没有作品内容**。
ADR-0056 决策 2A 那条注入面讲的是「剧本文本 + 能读文件的执行器」——
这条路把等式左边的第一项去掉了，所以右边不成立。

因此这份测试盯的是三件**会静默出大事**的事：

1. **创作能力那条路一个字节没变**（验收 4）。`claude-code` 仍然带 `--tools ""`，
   仍然在中性临时目录跑。它变了，注入面就回来了。
2. **能写仓库的执行器只有开发指令拿得到**（验收 1/2）。白名单在解析 argv 之前判，
   所以一次写错的组合走不到 spawn。
3. **仓库根绝不会被 rmtree**。`_run_executor` 原来无条件删 workdir；
   开发指令那一轮的 workdir 就是仓库根 —— 这一行写错一次，一次开发指令删掉整个仓库。
"""

from __future__ import annotations

import importlib.util
import inspect
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SERVER = _REPO / "mockups" / "motv-workspace" / "server.py"


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location("motv_server_dev_160", _SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- 1. 创作能力那条路一个字节没变 -------------------------------------------- #


def test_the_creative_executor_still_has_every_tool_disabled(srv) -> None:
    """ADR-0056 决策 2 保持 Accepted。它的提示词里带着他写的剧本正文，
    那条路上的工具必须是全关的 —— 这一条红了，说明注入面回来了。"""
    assert srv._EXECUTORS["claude-code"]["args"] == ["-p", "--tools", ""]
    assert not srv._EXECUTORS["claude-code"].get("writes_repo")
    assert srv._EXECUTORS["claude-code"].get("cwd") != "repo"


def test_the_dev_executor_is_a_separate_entry_not_a_flag(srv) -> None:
    """两个条目并存，不是一个带布尔开关的条目：传错一个布尔值是静默的，
    而且错的方向恰好是「作品内容 + 工具」（ADR-0107 决策 1）。"""
    dev = srv._EXECUTORS["claude-dev"]
    assert dev["bin"] == "claude"
    assert "--tools" not in dev["args"], "开发指令那一轮要工具，但不该自己关掉它"
    assert dev["cwd"] == "repo"
    assert dev["writes_repo"] is True


# --- 2. 能写仓库的执行器只有开发指令拿得到 ------------------------------------ #


@pytest.mark.parametrize(
    "task_type",
    ["skill.run", "dev.proposal", "story.develop", "", "dev.implement.x"],
)
def test_a_repo_writing_executor_is_refused_to_everything_else(srv, task_type) -> None:
    why = srv._executor_allowed_for("claude-dev", task_type)
    assert why, f"「{task_type}」竟然拿得到能写仓库的执行器"
    assert "ADR-0107" in why, "拒绝要说得出依据"


def test_the_dev_instruction_may_use_it(srv) -> None:
    assert srv._executor_allowed_for("claude-dev", "dev.implement") == ""


@pytest.mark.parametrize("task_type", ["skill.run", "dev.proposal", "dev.implement"])
def test_the_tool_free_executor_is_allowed_everywhere(srv, task_type) -> None:
    """白名单只收紧「能写仓库」的那些。无工具执行器照旧谁都能用 ——
    收紧它会把创作能力一起挡掉。"""
    assert srv._executor_allowed_for("claude-code", task_type) == ""


def test_the_whitelist_is_a_set_of_task_types_not_a_boolean(srv) -> None:
    assert "dev.implement" in srv._REPO_WRITING_TASK_TYPES
    # 创作能力那一侧一个都不许在里面
    for creative in ("skill.run", "dev.proposal"):
        assert creative not in srv._REPO_WRITING_TASK_TYPES


# --- 2b. 作品内容一个字都不进它的提示词（ADR-0107 决策 2） -------------------- #


def test_the_implement_prompt_takes_no_project_facts(srv) -> None:
    """**这条路敢带工具的全部理由。**

    ADR-0056 决策 2A 的注入面是「剧本文本 + 能读文件的执行器」。这一轮把等式左边
    的第一项去掉，所以右边不成立 —— 前提是它**拿不到**作品事实。

    断言签名：给它加一个 facts 入参，这条当场红。
    """
    sig = inspect.signature(srv._dev_implement_prompt)
    assert list(sig.parameters) == ["ask", "page"], (
        f"开发指令的提示词多了入参：{list(sig.parameters)} —— "
        "作品内容不许有任何一条进得来的路"
    )


def test_the_implement_prompt_body_never_embeds_a_work(srv) -> None:
    """组装出来的提示词里只有他这句话和页面名 —— 拿一段像模像样的作品文字
    当输入，它不该在提示词里出现（除非它就是他说的那句话本身）。"""
    prose = "林照站在潜水舱前，舷窗外多了一个人影。"
    out = srv._dev_implement_prompt("把表头改成登场人物", "故事开发 · 结构规划")
    assert "把表头改成登场人物" in out
    assert "故事开发 · 结构规划" in out
    assert prose not in out
    # 它必须明确要求那一轮走仓库规程，并且不碰 main
    assert "dev-workflow" in out
    assert "main" in out and "不碰" in out


def test_the_proposal_prompt_still_carries_facts(srv) -> None:
    """**写方案**那一轮（无工具）照旧带项目事实 —— 收紧它会让方案变瞎。
    两条路的区别不在「带不带事实」这一项上随意，而是与「带不带工具」严格配对。"""
    sig = inspect.signature(srv._dev_prompt)
    assert "facts" in sig.parameters


# --- 2c. 「要方案」与「真的改」不许被一个含糊的值混掉 ------------------------- #


def _dev_edit(srv, raw):
    """把模型那一轮的输出过一遍真实的净化，取出那条 dev.request。"""
    out = srv._adapt_conversation(
        '{"reply":"好","edits":[{"kind":"dev.request","text":"改表头"'
        + (f',"build":{raw}' if raw is not None else "")
        + "}]}"
    )
    return next(e for e in out["edits"] if e["kind"] == "dev.request")


@pytest.mark.parametrize("raw", ["true", '"true"', '"True"'])
def test_build_true_in_any_spelling_means_build(srv, raw) -> None:
    assert _dev_edit(srv, raw)["build"] is True


@pytest.mark.parametrize("raw", [None, "false", '"false"', "null", "0", '""', "[]"])
def test_anything_else_means_write_a_plan(srv, raw) -> None:
    """**错的方向要特别小心**：`"false"` 是个非空字符串，`if e.get("build")`
    对它为真 —— 那会让一句「先给个方案」跑成一次真实的代码改动。"""
    assert _dev_edit(srv, raw)["build"] is False, f"build={raw} 被当成了「真的改」"


# --- 3. 仓库根绝不会被 rmtree ------------------------------------------------- #


def test_the_repo_root_is_never_deleted(srv) -> None:
    """`_run_executor` 原来无条件 `shutil.rmtree(workdir)`，而开发指令那一轮的
    workdir 就是仓库根。**这一行写错一次，一次开发指令删掉整个仓库。**

    断言的是源码里那个条件真的在（这是少数几处「只能读源码」的守卫之一 ——
    真跑一次 `_run_executor` 就会 spawn 一个真实的 claude 进程）。
    读的是**执行构造**：`rmtree` 必须在 `owns_workdir` 的条件之内。
    """
    src = _SERVER.read_text("utf-8")
    body = inspect.getsource(srv._run_executor)
    assert "owns_workdir" in body, "删不删 workdir 的那个判断没了"
    # **每一处** rmtree 都要被守着，不只是第一处。
    #
    # 这条守卫第一次跑就抓到了第二处：spawn 失败那条 `except OSError` 分支上还有
    # 一个无条件的 `rmtree(workdir)`。只检查第一处的守卫会放它过去 —— 而那条路
    # 同样删仓库根。
    lines = body.splitlines()
    idx = [i for i, ln in enumerate(lines) if "rmtree(workdir" in ln]
    assert idx, "找不到 rmtree(workdir) —— 这条守卫失去了对象"
    for i in idx:
        guard = "\n".join(lines[max(0, i - 4) : i])
        assert "if owns_workdir" in guard, (
            f"第 {i} 行的 rmtree(workdir) 不在 owns_workdir 的条件里：\n{guard}"
        )
    # 而 owns_workdir 必须由「是不是在仓库里跑」决定
    assert "owns_workdir = not in_repo" in body
    assert 'cwd") == "repo"' in body or "cwd'] == 'repo'" in body
    # 仓库根只在这一个地方成为 workdir
    assert src.count("workdir = str(REPO_ROOT)") == 1

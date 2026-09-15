"""接续证据的**身份**：旧结论不能冒充新结论。

守的不是「tip 变没变」，而是「上一轮那句验证是在什么东西上跑出来的」。
`tip` 只是其中一个输入 —— 同一个 HEAD 下改完文件，旧的「pytest 通过」原来照样
显示为仍然成立，那是最省事也最危险的一种自欺（TASK-147 切片 B）。

每条用例都写成**「这个输入变了，结论必须失效」**，而不是断言某句文案，
因为文案会改而不变量不会（AGENTS §20「断言性质，不要断言写法」）。
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_TOOL = _ROOT / ".claude" / "tools" / "agent_harness.py"


@pytest.fixture(scope="module")
def ah():
    spec = importlib.util.spec_from_file_location("agent_harness_ident", _TOOL)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _git(root: Path, *args: str) -> None:
    exe = shutil.which("git")
    if not exe:
        pytest.skip("本机没有 git")
    subprocess.run(  # noqa: S603 - 固定 argv，无 shell
        [exe, "-C", str(root), *args], capture_output=True, check=True
    )


def _repo(root: Path) -> Path:
    """一棵最小的真仓库 —— `resume` 读真 git，假的证不了任何事。"""
    (root / "docs" / "tasks" / "active").mkdir(parents=True)
    (root / "docs" / "tasks" / "active" / "TASK-900-x.md").write_text(
        "# TASK-900：一张卡\n\n- 状态：**进行中**\n", encoding="utf-8"
    )
    (root / ".gitignore").write_text("**/.claude/tmp/\n", encoding="utf-8")
    (root / "src.py").write_text("x = 1\n", encoding="utf-8")
    (root / "tests").mkdir(exist_ok=True)
    (root / "tests" / "conftest.py").write_text("# conftest\n", encoding="utf-8")
    (root / "pyproject.toml").write_text('[project]\nname = "t"\n', encoding="utf-8")
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "t@example.invalid")
    _git(root, "config", "user.name", "t")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "one")
    return root


def _snap_of(ah, root: Path) -> dict:
    state = ah.run_resume(root)
    return next(s for s in state["snapshots"] if s["task"] == "TASK-900")


def test_a_fresh_snapshot_on_an_untouched_tree_is_valid(ah, tmp_path: Path) -> None:
    """基线。没有这一条，下面每一条「失效了」都可能只是因为它从来没有效过。"""
    root = _repo(tmp_path)
    ah.write_snapshot(root, "TASK-900", "pytest tests/tooling 通过", "下一步")
    snap = _snap_of(ah, root)
    assert snap["state"] == "VALID"
    assert snap["stale"] is False


def test_editing_a_tracked_file_under_the_same_head_invalidates_it(
    ah, tmp_path: Path
) -> None:
    """**这一条是整片的理由。** HEAD 没动，但验证跑过的那份代码已经不在了。"""
    root = _repo(tmp_path)
    ah.write_snapshot(root, "TASK-900", "pytest 通过", "下一步")
    head_before = ah._git(root, "rev-parse", "HEAD")

    (root / "src.py").write_text("x = 2\n", encoding="utf-8")

    snap = _snap_of(ah, root)
    assert ah._git(root, "rev-parse", "HEAD") == head_before, "前提：HEAD 必须没变"
    assert snap["state"] == "STALE"
    assert snap["stale"] is True


def test_a_new_untracked_file_invalidates_it(ah, tmp_path: Path) -> None:
    """未跟踪文件照样会被 import —— 它不在 `git diff` 里，但它在验证的输入里。"""
    root = _repo(tmp_path)
    ah.write_snapshot(root, "TASK-900", "pytest 通过", "下一步")
    (root / "brand_new.py").write_text("y = 1\n", encoding="utf-8")
    assert _snap_of(ah, root)["state"] == "STALE"


def test_a_non_ascii_untracked_filename_does_not_break_the_identity(
    ah, tmp_path: Path
) -> None:
    """中文文件名必须照常参与摘要，而不是让整个计算失败。

    回归守卫（codex 轮 1 的 BLOCKING）：`git ls-files --others` 默认会把非 ASCII
    路径 **C-quote** 成 `"docs/\\344\\270\\255..."`。那个字符串不是路径，于是读盘
    失败、摘要算不出、快照**永远** UNKNOWN —— 一条永远报警的警报等于没有警报。
    本仓库的文档大量是中文名，所以这是常态不是边缘情形。修法是 `-z`。
    """
    root = _repo(tmp_path)
    ah.write_snapshot(root, "TASK-900", "pytest 通过", "下一步")
    assert _snap_of(ah, root)["state"] == "VALID", "前提：动手前是有效的"

    (root / "中文笔记.md").write_text("内容\n", encoding="utf-8")

    snap = _snap_of(ah, root)
    assert snap["state"] == "STALE", f"应当因为新文件失效，而不是算不出：{snap['why']}"

    (root / "中文笔记.md").unlink()
    assert _snap_of(ah, root)["state"] == "VALID", (
        "删掉之后必须回到有效 —— 摘要是内容的函数"
    )


def test_changing_the_test_config_invalidates_it(ah, tmp_path: Path) -> None:
    """改 `pyproject.toml` / `conftest.py`：同一份代码，测试范围与行为都可能变。"""
    root = _repo(tmp_path)
    ah.write_snapshot(root, "TASK-900", "pytest 通过", "下一步")
    (root / "tests" / "conftest.py").write_text("# changed\n", encoding="utf-8")
    assert _snap_of(ah, root)["state"] == "STALE"


def test_switching_branch_invalidates_it(ah, tmp_path: Path) -> None:
    """换分支就是换对象，即使内容此刻恰好相同。"""
    root = _repo(tmp_path)
    ah.write_snapshot(root, "TASK-900", "pytest 通过", "下一步")
    _git(root, "checkout", "-q", "-b", "other")
    assert _snap_of(ah, root)["state"] == "STALE"


def test_a_corrupt_snapshot_is_unknown_not_silently_absent(ah, tmp_path: Path) -> None:
    """写坏的快照必须**出声**。

    原来 `read_snapshot` 把「没有」和「读坏了」都返回 `None`，于是一份被截断的
    快照看起来和「还没人写」一模一样。损坏绝不能表现为「没有异常」。
    """
    root = _repo(tmp_path)
    p = ah.write_snapshot(root, "TASK-900", "pytest 通过", "下一步")
    p.write_text("{ not json", encoding="utf-8")

    snap = _snap_of(ah, root)
    assert snap["state"] == "UNKNOWN"
    assert snap["stale"] is True, "UNKNOWN 必须和 STALE 一样阻止复用"


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda d: d.pop("verified"), id="missing"),
        pytest.param(lambda d: d.update(verified=""), id="empty"),
        pytest.param(lambda d: d.update(verified="   "), id="whitespace"),
        pytest.param(lambda d: d.update(verified=None), id="null"),
        pytest.param(lambda d: d.update(verified=123), id="wrong-type"),
        pytest.param(lambda d: d.update(next=""), id="empty-next"),
        pytest.param(lambda d: d.update(tip=""), id="empty-tip"),
        pytest.param(lambda d: d.update(inputs_version="1"), id="version-as-string"),
        pytest.param(lambda d: d.update(inputs_version=True), id="version-as-bool"),
    ],
)
def test_a_snapshot_without_real_content_is_not_valid(
    ah, tmp_path: Path, mutate
) -> None:
    """**一条没有内容的验证记录被判为有效，比没有记录更糟。**

    没有记录会让人去重新验证；「有效但空」会让人跳过验证。

    回归守卫（codex 轮 4 + 轮 5 的 BLOCKING）：轮 4 报「只检查是个 dict」，我补了
    「键在不在」，轮 5 立刻报回 `""` 与 `null` —— 同一机理的更窄拼法。所以断言的是
    **性质**（存在 + 类型对 + 非空），而不是逐个拼法。
    """
    root = _repo(tmp_path)
    p = ah.write_snapshot(root, "TASK-900", "pytest 通过", "下一步")
    data = json.loads(p.read_text(encoding="utf-8"))
    mutate(data)
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    snap = _snap_of(ah, root)
    assert snap["state"] == "UNKNOWN"
    assert snap["stale"] is True


def test_an_old_format_snapshot_is_unknown_not_valid(ah, tmp_path: Path) -> None:
    """只记了 tip 的旧快照：tip 相等**不等于**输入没变，所以判 UNKNOWN 而不是 VALID。"""
    root = _repo(tmp_path)
    p = ah.write_snapshot(root, "TASK-900", "pytest 通过", "下一步")
    data = json.loads(p.read_text(encoding="utf-8"))
    data.pop("inputs", None)
    data.pop("inputs_version", None)
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    snap = _snap_of(ah, root)
    assert snap["state"] == "UNKNOWN"


def test_when_the_identity_cannot_be_computed_it_is_unknown_not_valid(
    ah, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """git 不可用时必须是 UNKNOWN。

    **这是原来的 fail-open。** 旧写法是 `moved = bool(tip) and ...` —— git 拿不到
    tip 时 `moved` 为假，于是渲染成「tip 没变，仍然对得上这棵树」。
    「没发现变化」被当成了「没有变化」。
    """
    root = _repo(tmp_path)
    ah.write_snapshot(root, "TASK-900", "pytest 通过", "下一步")

    monkeypatch.setattr(ah, "_git", lambda *a, **k: None)
    state = ah.run_resume(root)
    snap = next(s for s in state["snapshots"] if s["task"] == "TASK-900")
    assert snap["state"] == "UNKNOWN"
    assert snap["stale"] is True


def test_the_brief_speaks_up_for_unknown_too(ah, tmp_path: Path) -> None:
    """`resume --brief` 进每个会话的上下文 —— UNKNOWN 不出声等于没有这条防线。"""
    root = _repo(tmp_path)
    p = ah.write_snapshot(root, "TASK-900", "pytest 通过", "下一步")
    p.write_text("{ not json", encoding="utf-8")
    brief = ah.render_resume_brief(ah.run_resume(root))
    assert "TASK-900" in brief
    assert "判不了" in brief or "没有结论" in brief


def test_an_unchanged_tree_does_not_drift_between_two_reads(ah, tmp_path: Path) -> None:
    """摘要必须是**内容**的函数，不是时间的函数。

    否则每次 resume 都判 STALE，而「永远报警的警报」等于没有警报 —— 它会被忽略，
    然后真的那次也一起被忽略。
    """
    root = _repo(tmp_path)
    first, why1 = ah.verification_inputs(root)
    second, why2 = ah.verification_inputs(root)
    assert first is not None and first == second
    assert why1 == why2 == "ok"

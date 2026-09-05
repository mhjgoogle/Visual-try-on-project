"""依赖方向契约（`pyproject.toml` 的 `[tool.importlinter]`）的形状与接线（TASK-134）。

这里**不重跑** `lint-imports` —— 那是闸门的事（`commit_gate_policy.decide` 的
`import_contracts` 为真时，gate.ps1 / gate.sh 各自跑一次）。本文件守的是**契约本身
不会悄悄退化成不咬人的空壳**，以及两个 shell 对它给出相同判定。

一次性的反向验证（往三个包各注入一条被禁的 import，确认三条契约分别转红，再逐字
还原源码）在 TASK-134 实施时跑过，结论记在卡的验证一节。它要改真实源码，不适合
留在测试里反复跑。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).parents[2]
_PYPROJECT = _ROOT / "pyproject.toml"

_POLICY_PATH = _ROOT / ".claude" / "hooks" / "commit_gate_policy.py"
_SPEC = importlib.util.spec_from_file_location("commit_gate_policy", _POLICY_PATH)
assert _SPEC and _SPEC.loader
_POLICY = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _POLICY
_SPEC.loader.exec_module(_POLICY)

#: 按**设计**就该看见具体厂商的子包，因此不在「核心工作流」契约的 source 里。
#: `providers.registry` 的 docstring 写明了理由：注册表本身厂商中立，具体厂商知识
#: 住在各 factory 里。把它放进 source 再用 baseline 放行，等于让契约声明一件它此刻
#: 并不成立的事 —— 那比没有契约更糟。
_EXEMPT_SUBPACKAGES = {"providers"}

_CORE_CONTRACT = "core workflow must not import a concrete video vendor"


def _contracts() -> list[dict]:
    tomllib = pytest.importorskip(
        "tomllib", reason="tomllib is 3.11+; the venv and CI both run newer"
    )
    data = tomllib.loads(_PYPROJECT.read_text(encoding="utf-8"))
    return data["tool"]["importlinter"]["contracts"]


def _core_contract() -> dict:
    for contract in _contracts():
        if contract["name"] == _CORE_CONTRACT:
            return contract
    raise AssertionError(f"契约 {_CORE_CONTRACT!r} 不见了")


def test_every_core_subpackage_is_covered_or_explicitly_exempt() -> None:
    """新增一个子包时，这条会红 —— 强制作者决定：纳入契约，还是显式豁免。

    `source_modules` 是一张手写表，新包不会自动进去。不守这一条，第 8 条就会
    随着新子包的出现被静默地一点点掏空：契约仍然全绿，覆盖面却在缩小。
    """
    on_disk = {
        p.name
        for p in (_ROOT / "src" / "ai_video_workflow").iterdir()
        if p.is_dir() and (p / "__init__.py").exists()
    }
    covered = {m.rsplit(".", 1)[-1] for m in _core_contract()["source_modules"]}
    unaccounted = on_disk - covered - _EXEMPT_SUBPACKAGES
    assert not unaccounted, (
        f"这些子包既不在契约 source 里也没被显式豁免：{sorted(unaccounted)}。"
        "把它们加进 pyproject.toml 的 source_modules，或加进本文件的 "
        "_EXEMPT_SUBPACKAGES 并写明为什么它按设计该看见厂商。"
    )
    # 豁免表也不许长出不存在的名字，否则它会掩盖一次真实的改名。
    assert _EXEMPT_SUBPACKAGES <= on_disk, (
        f"豁免表里有磁盘上不存在的子包：{sorted(_EXEMPT_SUBPACKAGES - on_disk)}"
    )


def test_contracts_are_not_hollow() -> None:
    """空的 forbidden 列表是一条永远绿的契约 —— 比没有契约更能骗人。"""
    for contract in _contracts():
        assert contract["source_modules"], f"{contract['name']}: source 为空"
        assert contract["forbidden_modules"], f"{contract['name']}: forbidden 为空"


def test_contract_names_stay_ascii() -> None:
    """契约 name 走 rich 渲染，Windows legacy console 的活动代码页编码不了中文。

    实测：cp932 下中文 name 让 `lint-imports` 直接 UnicodeEncodeError 崩掉，而崩溃
    经管道时退出码会被下游命令盖住（`| tail` 后 exit=0）—— 闸门会把「崩了」读成
    「过了」。Windows 是权威环境（AGENTS.md 第 2 条），所以这是硬约束不是风格。
    """
    for contract in _contracts():
        assert contract["name"].isascii(), f"契约名必须是 ASCII：{contract['name']!r}"


@pytest.mark.parametrize(
    ("paths", "expected"),
    [
        (["src/ai_video_workflow/planning/packets.py"], True),
        (["src/workspace_shell/app.py"], True),
        (["pyproject.toml"], True),
        (["docs/STATUS.md"], False),
        (["mockups/motv-workspace/src/app.js"], False),
    ],
)
def test_policy_flags_only_what_can_change_dependency_direction(
    paths: list[str], expected: bool
) -> None:
    assert _POLICY.classify(paths).import_contracts is expected


def _executable_lines(path: Path) -> str:
    """去掉整行注释后的文本。

    审查发现（codex，2026-09-05）：原先直接对全文断言「出现 lint-imports」，而这
    两个字符串在**注释里本来就有** —— 把可执行接线整段删掉，守卫照样绿。一条能被
    散文满足的守卫守不住任何东西。判定只看真正会执行的行。
    """
    return "\n".join(
        line
        for line in path.read_text(encoding="utf-8").splitlines()
        if not line.strip().startswith("#")
    )


def test_both_gates_consume_the_flag() -> None:
    """两个实现必须给出相同判定（AGENTS.md 第 4 条 / ADR-0062 决策 3）。

    只接一边，另一个平台上契约就是静默不跑的 —— 而不跑的闸门看起来和通过一样。
    """
    # 认的是**真正导致 lint-imports 被执行**的那个结构，不是路径字符串。
    # 第二次审查发现（2026-09-05）：只查 lint-imports 出现在可执行行仍然不够 ——
    # gate.sh 里 linter="$ROOT/.venv/bin/lint-imports" 这条赋值也含它，把真正的
    # run_check 调用整条删掉，守卫照样绿。断言必须落在执行动作上。
    for shell, executes in (
        ("gate.ps1", "Label = 'lint-imports'"),  # 进 $checks 数组才会被跑
        ("gate.sh", 'run_check "lint-imports"'),  # run_check 才是执行
    ):
        code = _executable_lines(_ROOT / ".claude" / "hooks" / shell)
        assert "import_contracts" in code, (
            f"{shell} 的可执行部分没有读 import_contracts"
        )
        assert executes in code, (
            f"{shell} 的可执行部分没有真正执行契约检查（找 {executes!r}）"
        )


def test_ci_runs_the_contracts_on_both_platforms() -> None:
    """判据 1 要的是「CI **与** 本地 commit gate 里跑」，不是只有本地。

    Windows 是权威环境、Ubuntu 是受支持目标（ADR-0062），少接一个 job，那个平台上
    的依赖方向就没人守。
    """
    code = _executable_lines(_ROOT / ".github" / "workflows" / "ci.yml")
    assert code.count("run: lint-imports") == 2, (
        "ci.yml 的两个 job（windows / linux）都必须跑 lint-imports，"
        f"当前只有 {code.count('run: lint-imports')} 处"
    )


def test_nothing_invokes_the_module_form() -> None:
    """`python -m importlinter.cli` 打印零字节然后 exit 0（实测 2026-09-05）。

    接成那样的闸门会把每一条契约都报成「通过」，而且永远如此。必须走 console script。
    CI 与两个 shell 一视同仁 —— 三处任意一处退化，那个入口就静默失效。
    """
    for rel in (
        Path(".claude") / "hooks" / "gate.ps1",
        Path(".claude") / "hooks" / "gate.sh",
        Path(".github") / "workflows" / "ci.yml",
    ):
        code = _executable_lines(_ROOT / rel)
        assert "importlinter.cli" not in code, (
            f"{rel.as_posix()} 的可执行部分用了模块形式调用，那是静默假绿"
        )

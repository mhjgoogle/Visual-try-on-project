"""架构依存关系从代码派生（TASK-151）。

守四条判据：每条内部 import 边都被读出且每个模块归到一层（1）· `impact` 是反向传递
闭包、按层分组、无人依赖时答「无」（2）· `check` 验 CA §2 方向且对着真仓库跑（3）·
一个解析失败的文件让整张图拒绝出（4）。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TOOLS = REPO_ROOT / ".claude" / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import arch_deps  # noqa: E402


def _write(root: Path, rel: str, text: str = "") -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """三层各一点：core 里 a ← b ← c，shell 依赖 core，studio 依赖 core 与自己。"""

    _write(tmp_path, "src/ai_video_workflow/__init__.py")
    _write(tmp_path, "src/ai_video_workflow/a.py", "x = 1\n")
    _write(tmp_path, "src/ai_video_workflow/b.py", "from ai_video_workflow import a\n")
    _write(tmp_path, "src/ai_video_workflow/c.py", "from . import b\nimport json\n")
    _write(tmp_path, "src/ai_video_workflow/sub/__init__.py")
    _write(tmp_path, "src/ai_video_workflow/sub/d.py", "from ..b import something\n")
    _write(tmp_path, "src/workspace_shell/__init__.py")
    _write(tmp_path, "src/workspace_shell/app.py", "import ai_video_workflow.c\n")
    _write(tmp_path, "mockups/motv-workspace/runstore.py", "import os\n")
    _write(
        tmp_path,
        "mockups/motv-workspace/server.py",
        "import runstore\nfrom ai_video_workflow.a import x\nimport requests\n",
    )
    return tmp_path


# --------------------------------------------------------------------------
# 判据 1：边与层
# --------------------------------------------------------------------------


def test_internal_edges_are_read_and_third_party_is_not(repo: Path) -> None:
    graph = arch_deps.build(repo)

    assert graph.edges() == [
        ("ai_video_workflow.b", "ai_video_workflow.a"),
        ("ai_video_workflow.c", "ai_video_workflow.b"),
        ("ai_video_workflow.sub.d", "ai_video_workflow.b"),
        ("server", "ai_video_workflow.a"),
        ("server", "runstore"),
        ("workspace_shell.app", "ai_video_workflow.c"),
    ]
    # `json` / `os` / `requests` 不是架构，是依赖清单 —— 不进图。
    assert all(b in graph.modules for _a, b in graph.edges())


def test_relative_imports_resolve_against_the_importing_package(repo: Path) -> None:
    """`from . import b` 与 `from ..b import x` 都要落到 `ai_video_workflow.b`。"""

    graph = arch_deps.build(repo)
    assert "ai_video_workflow.b" in graph.modules["ai_video_workflow.c"].imports
    assert "ai_video_workflow.b" in graph.modules["ai_video_workflow.sub.d"].imports


def test_every_module_lands_in_exactly_one_layer(repo: Path) -> None:
    graph = arch_deps.build(repo)

    layers = {name: m.layer for name, m in graph.modules.items()}
    assert layers["ai_video_workflow.a"] == "core"
    assert layers["workspace_shell.app"] == "shell"
    assert layers["server"] == "studio"
    assert graph.unplaced() == []


# --------------------------------------------------------------------------
# 判据 2：impact 是反向传递闭包
# --------------------------------------------------------------------------


def test_impact_is_the_transitive_reverse_closure_grouped_by_layer(repo: Path) -> None:
    """改 `a`：b 直接依赖，c 与 sub.d 经 b 间接依赖，shell.app 经 c，server 直接。"""

    graph = arch_deps.build(repo)
    grouped = graph.impact("ai_video_workflow.a")

    assert grouped["core"] == [
        "ai_video_workflow.b",
        "ai_video_workflow.c",
        "ai_video_workflow.sub.d",
    ]
    assert grouped["shell"] == ["workspace_shell.app"]
    assert grouped["studio"] == ["server"]


def test_impact_of_a_leaf_nobody_imports_is_empty(repo: Path) -> None:
    graph = arch_deps.build(repo)
    grouped = graph.impact("workspace_shell.app")
    assert all(not names for names in grouped.values())


def test_impact_accepts_a_file_path_as_well_as_a_module_name(repo: Path) -> None:
    graph = arch_deps.build(repo)
    by_path = arch_deps.module_for(graph, "src/ai_video_workflow/a.py")
    assert by_path == "ai_video_workflow.a"
    assert arch_deps.module_for(graph, "ai_video_workflow.a") == "ai_video_workflow.a"
    assert arch_deps.module_for(graph, "nothing/here.py") is None


# --------------------------------------------------------------------------
# 判据 3：check 验 CA §2 的方向
# --------------------------------------------------------------------------


def test_a_core_module_importing_the_shell_is_a_violation(repo: Path) -> None:
    _write(repo, "src/ai_video_workflow/leak.py", "import workspace_shell.app\n")

    graph = arch_deps.build(repo)
    assert any("leak" in v and "CA §2" in v for v in graph.violations())


def test_a_core_module_importing_the_studio_is_a_violation(repo: Path) -> None:
    _write(repo, "src/ai_video_workflow/leak2.py", "import server\n")

    graph = arch_deps.build(repo)
    assert any("leak2" in v for v in graph.violations())


def test_shell_and_studio_may_import_core(repo: Path) -> None:
    """方向是单向的：上层看下层可以，下层看上层不行。"""

    assert arch_deps.build(repo).violations() == []


def test_the_real_repository_respects_the_dependency_direction() -> None:
    """**对着真仓库跑。** CA §2 那张手画的图，代码里还成立吗。"""

    graph = arch_deps.build(REPO_ROOT)
    assert graph.violations() == []
    assert graph.unplaced() == []
    assert len(graph.modules) > 100
    assert len(graph.edges()) > 100


# --------------------------------------------------------------------------
# 判据 4：解析失败拒绝出图
# --------------------------------------------------------------------------


def test_a_file_that_does_not_parse_refuses_the_whole_graph(repo: Path) -> None:
    """少了一个文件，影响范围就少一片，而少的那一片恰好是看不见的。"""

    _write(repo, "src/ai_video_workflow/broken.py", "def (\n")

    with pytest.raises(arch_deps.ParseFailure):
        arch_deps.build(repo)

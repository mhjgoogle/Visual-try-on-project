"""架构依存关系，从代码派生（TASK-151）。

CA §2 画了一张图：前端 → Studio 后端 → 核心库，「核心库永远不 import 上面任何一层」。
那张图是**手写的合同**；本工具用 `ast` 从 `import` 语句里长出一面镜子，回答三个问题：

- `graph`        仓库内部有哪些 import 边（第三方与标准库不算：那是依赖清单，不是架构）
- `layers`       每个模块归哪一层：`core` / `shell` / `studio`；归不进去的**报出来**
- `impact <X>`   改了 X（模块名或文件路径），谁会跟着受影响 —— 反向传递闭包，按层分组
- `check`        CA §2 那条方向约束在代码里还成立吗

## 范围

| 层 | 位置 | 模块名的样子 |
| --- | --- | --- |
| `core` | `src/ai_video_workflow/` | `ai_video_workflow.gateway.service` |
| `shell` | `src/workspace_shell/` | `workspace_shell.app` |
| `studio` | `mockups/motv-workspace/*.py`（顶层文件） | `server` · `runstore` · … |

前端 JS 的 import 图是另一套解析器，不在这里（TASK-151 OUT OF SCOPE）。
`src/ui-gap-audit/` 目录名带连字符、不是可导入的包，不扫。

## `impact` 给的是范围，不是结论

「谁 import 了 X，谁又 import 了那些谁」回答的是**改 X 的接口最多要看哪些文件**。
它不判改动是否真的破坏 —— 那是测试的事。影响范围大也不等于该先做。

## fail-closed 在解析上

一个文件 `ast` 解析失败 → 整张图拒绝出。少了一个文件，影响范围就少一片，
而少的那一片恰好是看不见的。
"""

from __future__ import annotations

import argparse
import ast
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

LAYERS = ("core", "shell", "studio")

#: 顶层包 / 目录 → 层。层的划分**由 CA §2 的三个盒子派生**，不另造分类。
PACKAGE_LAYER = {"ai_video_workflow": "core", "workspace_shell": "shell"}
STUDIO_DIR = Path("mockups") / "motv-workspace"

#: CA §2：「核心库 ← 永远不 import 上面任何一层」。这是本工具唯一验的方向约束；
#: import-linter 那三条已经在闸门里跑，不重复实现。
FORBIDDEN_DIRECTIONS = {("core", "shell"), ("core", "studio")}


class ParseFailure(RuntimeError):
    """有文件解析不了。拒绝出图 —— 一张少了一片的图比没有图更糟。"""


@dataclass
class Module:
    name: str
    path: Path
    layer: str
    imports: set[str] = field(default_factory=set)


@dataclass
class Graph:
    modules: dict[str, Module]
    root: Path

    def edges(self) -> list[tuple[str, str]]:
        return sorted(
            (a, b)
            for a, m in self.modules.items()
            for b in m.imports
            if b in self.modules
        )

    def dependents(self) -> dict[str, set[str]]:
        """反向邻接：被谁 import。"""

        out: dict[str, set[str]] = defaultdict(set)
        for a, b in self.edges():
            out[b].add(a)
        return out

    def impact(self, target: str) -> dict[str, list[str]]:
        """改了 *target*，谁受影响 —— 反向传递闭包，按层分组，层内按名字。"""

        rev = self.dependents()
        seen: set[str] = set()
        frontier = [target]
        while frontier:
            node = frontier.pop()
            for dep in rev.get(node, ()):
                if dep not in seen:
                    seen.add(dep)
                    frontier.append(dep)
        grouped: dict[str, list[str]] = {layer: [] for layer in LAYERS}
        for name in sorted(seen):
            grouped.setdefault(self.modules[name].layer, []).append(name)
        return grouped

    def violations(self) -> list[str]:
        """CA §2 方向约束的违规边。"""

        out = []
        for a, b in self.edges():
            pair = (self.modules[a].layer, self.modules[b].layer)
            if pair in FORBIDDEN_DIRECTIONS:
                out.append(
                    f"{a} ({pair[0]}) → {b} ({pair[1]})："
                    "核心库不得 import 上层（CA §2）"
                )
        return out

    def unplaced(self) -> list[str]:
        return sorted(name for name, m in self.modules.items() if m.layer not in LAYERS)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _module_name(path: Path, base: Path) -> str:
    rel = path.relative_to(base).with_suffix("")
    parts = list(rel.parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def discover(root: Path | None = None) -> dict[str, Module]:
    """找出范围内每个模块（还没解析 import）。"""

    root = root or repo_root()
    found: dict[str, Module] = {}
    src = root / "src"
    for package, layer in PACKAGE_LAYER.items():
        base = src / package
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            name = _module_name(path, src)
            found[name] = Module(name=name, path=path, layer=layer)
    studio = root / STUDIO_DIR
    if studio.is_dir():
        for path in sorted(studio.glob("*.py")):
            name = path.stem
            found[name] = Module(name=name, path=path, layer="studio")
    return found


def _resolve(imported: str, known: set[str]) -> str | None:
    """`a.b.c` 在图里对应哪个模块：先找最长前缀 —— `from a.b import c` 里的 `c`
    可能是模块也可能是名字，只有前者在图里。"""

    parts = imported.split(".")
    for cut in range(len(parts), 0, -1):
        candidate = ".".join(parts[:cut])
        if candidate in known:
            return candidate
    return None


def _with_ancestors(hit: str, known: set[str]) -> set[str]:
    """命中的模块**加上它所有已知的祖先包**。

    import `a.b.c` 会执行 `a/__init__.py` 与 `a.b/__init__.py` —— 调用方因此也依赖
    那两个包。只记最长匹配的版本在两处少报（codex 2026-09-17）：① `from a.b import c`
    在 `a.b/__init__` 也定义了 `c` 时，真正被用的是包属性，边却只落到子模块 `a.b.c`；
    ② 改 `a.b/__init__` 会影响每一个 import 了 `a.b.*` 的人，`impact a.b` 却看不见他们。
    少报比多报糟：`impact` 给的是范围，范围少一片就是看不见那一片。
    """

    out = {hit}
    parts = hit.split(".")
    for cut in range(1, len(parts)):
        prefix = ".".join(parts[:cut])
        if prefix in known:
            out.add(prefix)
    return out


def _imports_of(module: Module, known: set[str]) -> set[str]:
    try:
        tree = ast.parse(
            module.path.read_text(encoding="utf-8"), filename=str(module.path)
        )
    except (SyntaxError, UnicodeDecodeError, OSError) as exc:
        raise ParseFailure(f"{module.path.as_posix()} 解析失败：{exc}") from exc

    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                hit = _resolve(alias.name, known)
                if hit:
                    out |= _with_ancestors(hit, known)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                # 相对导入：按 level 往上走，再接 module。
                base_parts = module.name.split(".")
                if module.path.name != "__init__.py":
                    base_parts = base_parts[:-1]
                base_parts = base_parts[: len(base_parts) - (node.level - 1)]
                prefix = ".".join(base_parts)
            else:
                prefix = ""
            stem = ".".join(p for p in (prefix, node.module or "") if p)
            for alias in node.names:
                hit = _resolve(f"{stem}.{alias.name}" if stem else alias.name, known)
                if hit is None and stem:
                    hit = _resolve(stem, known)
                if hit:
                    out |= _with_ancestors(hit, known)
                # `from a.b import c`：`c` 可能是子模块，也可能是 `a.b/__init__` 里的
                # 名字 —— 两种读法都记，`_with_ancestors` 已把 `a.b` 加进来了。
    out.discard(module.name)
    return out


def build(root: Path | None = None) -> Graph:
    root = root or repo_root()
    modules = discover(root)
    known = set(modules)
    for module in modules.values():
        module.imports = _imports_of(module, known)
    return Graph(modules=modules, root=root)


def module_for(graph: Graph, target: str) -> str | None:
    """`impact` 的参数可以是模块名，也可以是文件路径。"""

    if target in graph.modules:
        return target
    candidate = Path(target)
    if not candidate.is_absolute():
        candidate = graph.root / candidate
    try:
        resolved = candidate.resolve()
    except OSError:
        return None
    for name, module in graph.modules.items():
        if module.path.resolve() == resolved:
            return name
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="架构依存关系，从代码派生")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("graph", help="仓库内部的每条 import 边")
    sub.add_parser("layers", help="每个模块归哪一层；归不进去的报出来")
    p = sub.add_parser("impact", help="改了 X，谁受影响（反向传递闭包，按层分组）")
    p.add_argument("target", help="模块名（ai_video_workflow.gateway）或文件路径")
    sub.add_parser("check", help="CA §2 方向约束在代码里还成立吗")
    args = ap.parse_args(argv)

    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    try:
        graph = build()
    except ParseFailure as exc:
        sys.stderr.write(f"拒绝出图：{exc}\n")
        return 1

    if args.cmd == "graph":
        for a, b in graph.edges():
            sys.stdout.write(f"{a} → {b}\n")
        sys.stdout.write(
            f"（{len(graph.modules)} 个模块，{len(graph.edges())} 条边）\n"
        )
        return 0

    if args.cmd == "layers":
        by_layer: dict[str, list[str]] = defaultdict(list)
        for m in graph.modules.values():
            by_layer[m.layer].append(m.name)
        for layer in LAYERS:
            names = sorted(by_layer.get(layer, []))
            sys.stdout.write(f"## {layer}（{len(names)}）\n")
            for name in names:
                sys.stdout.write(f"- {name}\n")
        stray = graph.unplaced()
        if stray:
            sys.stdout.write(f"## 归不进任何层（{len(stray)}）—— 这是问题，不是分类\n")
            for name in stray:
                sys.stdout.write(f"- {name}\n")
            return 1
        return 0

    if args.cmd == "impact":
        name = module_for(graph, args.target)
        if name is None:
            sys.stderr.write(f"图里没有 {args.target}（不在范围内，或路径不对）。\n")
            return 1
        grouped = graph.impact(name)
        total = sum(len(v) for v in grouped.values())
        if not total:
            sys.stdout.write(f"{name}：没有谁 import 它 —— 改它的接口只影响它自己。\n")
            return 0
        sys.stdout.write(f"改 {name}，最多要看 {total} 个模块：\n")
        for layer in LAYERS:
            names = grouped.get(layer, [])
            if names:
                sys.stdout.write(f"## {layer}（{len(names)}）\n")
                for n in names:
                    sys.stdout.write(f"- {n}\n")
        sys.stdout.write("（这是范围，不是结论 —— 破没破由测试说。）\n")
        return 0

    problems = graph.violations() + [f"{n}：归不进任何层" for n in graph.unplaced()]
    for line in problems:
        sys.stderr.write(line + "\n")
    sys.stdout.write(
        "CA §2 方向约束在代码里成立。\n"
        if not problems
        else f"{len(problems)} 条问题。\n"
    )
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())

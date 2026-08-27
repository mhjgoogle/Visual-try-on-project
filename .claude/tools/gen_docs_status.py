"""Generate `docs/STATUS.md` from the docs tree itself.

WHY THIS IS DERIVED AND NOT HAND-WRITTEN. A hand-maintained index is the exact
defect this file exists to remove: on 2026-08-23 five separate status claims in
`docs/` were found stale, and one of them (TASK-052's "待开始") had hidden two
real defects for ten days. An index that must be remembered will not be
remembered. So the overview is GENERATED from the directory a document lives in
plus the document's own status line, and `tests/tooling/test_docs_status.py`
fails when the checked-in file no longer matches -- a doc added or moved without
regenerating turns the suite red instead of silently drifting (ADR-0083).

Run: python .claude/tools/gen_docs_status.py            (rewrite docs/STATUS.md)
     python .claude/tools/gen_docs_status.py --check    (exit 1 if out of date)
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
OUT = DOCS / "STATUS.md"

_STATUS = re.compile(r"^[->\s*]*(?:状态|Status)[:：]\s*(.+)$", re.M)
_TITLE = re.compile(r"^#\s+(.+)$", re.M)

_PREAMBLE = """# 文档状态总览

> **本文件是生成的，不要手改。** 来源是 `docs/` 的目录结构与各文档自己的状态行；
> 重新生成：`python .claude/tools/gen_docs_status.py`。
> `tests/tooling/test_docs_status.py` 会在它与目录不一致时转红 —— 手写索引一定
> 会漂移，这正是本文件要消除的缺陷（2026-08-23 一天查出五处过期状态，其中一处
> 错标签把两条真缺陷藏了十天）。

## 怎么读这份文档

| 位置 | 含义 |
| --- | --- |
| `docs/tasks/active/` · `docs/design/active/` | **还没做完**，需要有人接手 |
| `docs/tasks/backlog/` | **没人在做**：已立卡但未排期（默认不读） |
| `docs/tasks/done/` · `docs/design/done/` | **已经做完**，只作历史查阅 |
| `docs/adr/` | **决策记录**，没有「完成」这一维；被取代的写明取代者 |
| `docs/design/` 根 | **稳定合同与参考**，合同不会「做完」 |
| `docs/requirements/` | 需求记录：DRAFT / CONFIRMED / SUPERSEDED |
| `docs/reports/` | 阶段性工作报告 —— **历史证据**，默认不读 |
| `docs/auto-push/` · `docs/skill-evolution/` | 工具维护的数据，不手改 |

**当前**：{n_active} 在办 · {n_backlog} 待排期 · {n_done} 已完成 · {n_adr} 条 ADR。

**找待办只看 `active/` 两个目录**，加上
[TASK-087 欠账总账](tasks/active/TASK-087-followup-ledger.md)。

## 默认加载什么（AGENTS.md 第 25 条 · ADR-0087 决策 5）

**默认读**：[AGENTS.md](../AGENTS.md) · 本次 Change 关联的 REQ ·
[当前架构合同](current-architecture.md) 里相关的那几行 ·
`docs/tasks/active/` 里**本次**这一张卡 · 本文件 · 影响范围内的代码与测试。

**默认不读**：`tasks/done/` · `design/done/` · `tasks/backlog/` · `reports/` ·
未被当前架构合同指向的历史 ADR · 被取代的 REQ 版本 · 历史 Change 清单。
只有**回归调查 / 架构理由 / 历史冲突 / 需求演化 / 复现旧决策边界**这五种情形
才按需去读 —— 历史存在，但历史不占日常开发上下文。

---
"""

_TRAILER = """## 稳定参考（没有「完成」这一维）

合同不会「做完」，决策只要 Accepted 就一直有效 —— 所以它们不进 active/done。

| 位置 | 放什么 |
| --- | --- |
| [当前架构合同](current-architecture.md) | **现在**成立的边界与约束（NOW） |
| [`docs/adr/`](adr/) | {n_adr} 条决策记录（ADR-0001 … {last}）—— WHY / HISTORY |
| [`docs/design/`](design/) 根 | 系统合同、产品信息架构、L0–S7 I/O 合同 |
| [项目背景与路线](project-context.md) | 这个项目是什么、走到哪了 |
| [实施规划](implementation_plan.md) | 阶段与里程碑路线图 |
| [产品规格](product_spec.md) · [架构](architecture.md) | 规格与架构基线 |
"""

_SECTIONS = [
    (
        "在办 · 任务卡",
        "tasks/active",
        "还没做完的任务卡。「部分完成」也在这里 —— 只要还有人要接着做，它就是在办。",
    ),
    (
        "在办 · 设计与验收文档",
        "design/active",
        "仍有未闭合项的设计、验收 runbook 与活账清单。",
    ),
    (
        "待排期 · 任务卡",
        "tasks/backlog",
        "已立卡但**没人在做**：需求成立、优先级未排。`active/` 只放正在进行的工作，"
        "否则「待办 = ls active/」会把没人做的也读成待办（ADR-0087 决策 2）。",
    ),
    (
        "已完成 · 任务卡",
        "tasks/done",
        "已完成、已验收或已退役。**退役**指目标被后续决策取代，不是被放弃。",
    ),
    (
        "已完成 · 设计与验收记录",
        "design/done",
        "已通过的里程碑评审、已落地的实施记录，及其任务卡已收口的设计文档。",
    ),
]


def _first_clause(raw: str, limit: int = 92) -> str:
    """The verdict is the FIRST clause. Everything after 「——」 is the reason or
    the superseded wording, and strikethrough is always history."""
    text = re.sub(r"~~.*?~~", "", raw)
    text = re.split(r"——|。|；", text)[0]
    # 状态行里的相对链接是按它自己那份文档的位置写的，抄进 STATUS.md 就指错了 ——
    # 压成纯文本（表格格子里本来也不该再挂链接）。
    text = re.sub(r"\[([^]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[*`]", "", text).strip()
    if len(text) > limit:
        return text[: limit - 1] + "…"
    return text


def _describe(path: Path) -> tuple[str, str]:
    text = path.read_text("utf-8")
    title_m = _TITLE.search(text)
    title = re.sub(r"[*`]", "", title_m.group(1)).strip() if title_m else path.stem
    status_m = _STATUS.search(text)
    status = _first_clause(status_m.group(1)) if status_m else "—"
    return title, status


def _section(heading: str, rel_folder: str, blurb: str) -> list[str]:
    folder = DOCS / rel_folder
    if not folder.is_dir():
        return []
    rows = [f"## {heading}", "", blurb, ""]
    rows.append("| 文档 | 标题 | 状态行（首句） |")
    rows.append("| --- | --- | --- |")
    for path in sorted(folder.iterdir()):
        if path.suffix.lower() not in {".md", ".patch"}:
            continue
        rel = path.relative_to(DOCS).as_posix()
        if path.suffix.lower() == ".patch":
            rows.append(f"| [{path.name}]({rel}) | （patch 留痕） | — |")
            continue
        title, status = _describe(path)
        rows.append(f"| [{path.name}]({rel}) | {title} | {status} |")
    rows.append("")
    return rows


def render() -> str:
    adr = sorted((DOCS / "adr").glob("ADR-*.md"))
    n_active = len(list((DOCS / "tasks" / "active").glob("*.md")))
    n_backlog = len(list((DOCS / "tasks" / "backlog").glob("*.md")))
    n_done = len(list((DOCS / "tasks" / "done").glob("*")))
    lines = _PREAMBLE.format(
        n_active=n_active, n_backlog=n_backlog, n_done=n_done, n_adr=len(adr)
    ).splitlines()
    for heading, folder, blurb in _SECTIONS:
        lines += _section(heading, folder, blurb)
    last = adr[-1].name[:8] if adr else "—"
    lines += _TRAILER.format(n_adr=len(adr), last=last).splitlines()
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = render()
    if args.check:
        current = OUT.read_text("utf-8") if OUT.exists() else ""
        if current != text:
            print("docs/STATUS.md is out of date -- regenerate it")
            return 1
        print("docs/STATUS.md up to date")
        return 0
    OUT.write_text(text, "utf-8")
    print(f"wrote {OUT.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

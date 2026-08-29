#!/usr/bin/env python3
"""读取创作者在应用里提的意见（REQ-006 的后端一半）。

产品负责人 2026-08-29：「可以给后端反馈意见。比如页面不合适了把意见收集起来。
你在后端接收到反馈以后提出修改方案。」

**为什么需要这个工具**：意见由 studio 后端写进**账户级应用数据**
（`%LOCALAPPDATA%\\motv\\feedback.json`），那是运行期数据，不进仓库。开发 Agent
（Claude Code / Codex）看不见运行期目录里发生了什么，除非有人去读它 —— 这就是那个人。

这条回路是**双向**的（产品负责人 2026-08-29：「我还希望前端的agent能够看到你的修改
提案然后告诉我，我通过前端agent来告诉你是否批准和修改意见」）：

    他 → 开发   对话里说「这个页面不合适」→ `items`
    开发 → 他   `--propose` 写一条修改提案 → 前端 agent 在对话里主动告诉他
    他 → 开发   他在对话里说「同意 / 不要 / 要改成…」→ 提案上的 `decision`

用法::

    python .claude/tools/read_feedback.py              # 只看还没处理的意见
    python .claude/tools/read_feedback.py --all        # 全部
    python .claude/tools/read_feedback.py --done 3 7   # 标成已处理
    python .claude/tools/read_feedback.py --json       # 给别的工具吃

    # 开发 → 他
    python .claude/tools/read_feedback.py --propose "把版本行收起来" \
        --body "只显示最新版，其余收进「历史版本」，随时展开。不删任何版本。"
    python .claude/tools/read_feedback.py --proposals  # 提案与他的答复

标记「已处理」写回同一个文件；**不删除**任何一条（AGENTS.md 第 13 条：不静默丢用户
的东西）。开发时的正确姿势是：读 → 立卡/实现 → `--done` 标掉并在卡里写清对应的是哪条。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def default_path() -> Path:
    """与 server.py 的 `resolve_app_data_dir()` 同一套规则。

    平台中立（AGENTS.md §3）：不硬编码分隔符，也不硬编码某个用户目录。
    """
    override = os.environ.get("MOTV_APP_DATA_DIR")
    if override:
        return Path(override) / "feedback.json"
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        if base:
            return Path(base) / "motv" / "feedback.json"
        return Path.home() / "AppData" / "Local" / "motv" / "feedback.json"
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "motv" / "feedback.json"


def load(path: Path) -> dict:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"version": 1, "items": []}
    except (OSError, ValueError) as exc:
        raise SystemExit(f"读不了 {path}：{exc}") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("items"), list):
        raise SystemExit(f"{path} 的形状不对（缺 items 数组）")
    if not isinstance(raw.get("proposals"), list):
        raw["proposals"] = []
    return raw


def save(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def render(items: list) -> str:
    if not items:
        return "没有待处理的意见。"
    out = []
    for it in items:
        when = str(it.get("createdAt", ""))[:19]
        head = f"#{it.get('id')} [{it.get('status', 'new')}] {when}"
        w = it.get("where") if isinstance(it.get("where"), dict) else {}
        head_where = " · ".join(
            x for x in (it.get("project"), w.get("page") or it.get("page")) if x
        )
        out.append(f"{head}{('  —— ' + head_where) if head_where else ''}")
        out.append(f"  说的是：{it.get('text', '')}")
        if it.get("expect"):
            out.append(f"  他要的是：{it['expect']}")
        # 定位情报：省掉「先找到那一页在哪」这一步
        spot = " · ".join(
            x
            for x in (
                w.get("section") and f"节：{w['section']}",
                w.get("episodeLabel"),
                w.get("shotTitle") and f"选中镜头：{w['shotTitle']}",
            )
            if x
        )
        if spot:
            out.append(f"  在哪：{spot}")
        if w.get("source"):
            out.append(f"  画它的文件：mockups/motv-workspace/{w['source']}")
        if w.get("route"):
            out.append(f"  打开它：{w['route']}")
        out.append("")
    return "\n".join(out).rstrip()


VERDICT_ZH = {"approved": "同意", "rejected": "不要", "changes": "要改"}


def render_proposals(rows: list) -> str:
    if not rows:
        return "还没有提案。"
    out = []
    for x in rows:
        d = x.get("decision") if isinstance(x.get("decision"), dict) else None
        state = (
            f"{VERDICT_ZH.get(d.get('verdict'), d.get('verdict'))}" if d else "等他答复"
        )
        out.append(f"#{x.get('id')} [{state}] {x.get('title', '')}")
        if x.get("body"):
            out.append(f"  提案：{x['body']}")
        if d and d.get("note"):
            out.append(f"  他说：{d['note']}")
        out.append("")
    return "\n".join(out).rstrip()


def add_proposal(doc: dict, title: str, body: str, now: str) -> dict:
    item = {
        "id": len(doc["proposals"]) + 1,
        "createdAt": now,
        "title": title.strip()[:200],
        "body": (body or "").strip()[:4000],
        "decision": None,
    }
    doc["proposals"].append(item)
    return item


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--path", type=Path, default=None, help="feedback.json 的位置")
    ap.add_argument("--all", action="store_true", help="连已处理的一起列出")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument(
        "--done",
        nargs="+",
        type=int,
        default=None,
        metavar="ID",
        help="把这些标成已处理",
    )
    ap.add_argument(
        "--propose", metavar="TITLE", default=None, help="给他写一条修改提案"
    )
    ap.add_argument("--body", default="", help="提案正文（配合 --propose）")
    ap.add_argument("--proposals", action="store_true", help="列出提案与他的答复")
    args = ap.parse_args(argv)

    path = args.path or default_path()
    doc = load(path)
    items = doc["items"]

    if args.propose:
        # 时间戳由这里生成：提案是**开发**写的，署的是写它的那一刻
        from datetime import datetime, timezone

        item = add_proposal(
            doc, args.propose, args.body, datetime.now(timezone.utc).isoformat()
        )
        save(path, doc)
        print(f"已写下第 {item['id']} 号提案 —— 他下次在对话里就会看到它")
        return 0

    if args.proposals:
        if args.json:
            print(
                json.dumps(
                    {"path": str(path), "proposals": doc["proposals"]},
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        open_n = len(
            [x for x in doc["proposals"] if not isinstance(x.get("decision"), dict)]
        )
        print(
            f"台账：{path}（提案 {len(doc['proposals'])} 条，等他答复 {open_n} 条）\n"
        )
        print(render_proposals(doc["proposals"]))
        return 0

    if args.done:
        wanted = set(args.done)
        seen = set()
        for it in items:
            if it.get("id") in wanted:
                it["status"] = "done"
                seen.add(it["id"])
        missing = wanted - seen
        save(path, doc)
        print(f"已标记：{sorted(seen) or '（无）'}")
        if missing:
            print(f"没找到：{sorted(missing)}")
        return 0

    shown = items if args.all else [x for x in items if x.get("status") != "done"]
    if args.json:
        print(
            json.dumps(
                {"path": str(path), "items": shown}, ensure_ascii=False, indent=2
            )
        )
        return 0
    pending = len([x for x in items if x.get("status") != "done"])
    print(f"台账：{path}（共 {len(items)} 条，待处理 {pending} 条）\n")
    print(render(shown))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

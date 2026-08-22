"""skill-evolution 的确定性操作 CLI（ADR-0078 决策 3）。

registry / 计数 / 状态机 / 同步在这里；语义判断（反馈内容、recurrence 归组、
severe 判定、提案）由模型完成。数据住在 docs/skill-evolution/（决策 2）：
放 docs/ 而不是 .claude/，是因为 commit gate 把 docs/ 归 lint 档 —— feedback
是高频小追加，不该每条都背一次全量 pytest。

单实现、双 shell 同一条调用：
    python .claude/skills/skill-evolution/scripts/evolution.py <command> ...
所有输出是单行紧凑 JSON —— 给 agent 读的，不是给人读的；人看 backlog 文件本身。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1
REVIEW_THRESHOLD = 3
SKILL_ROOTS = (".claude/skills",)

#: skill 名会被嵌进可写路径（backlog/archive 文件名），必须消毒：只接受
#: 目录名字符集，拒绝 `..`、分隔符与任何路径语义（codex 独立审查 round 1
#: 的 blocking finding：`../` 形状的名字可以逃出数据目录写文件）。
_SKILL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _bad_name(skill: str) -> str | None:
    # fullmatch，不是 match+$：`$` 允许结尾换行，白名单会被 "name\n" 绕过，
    # 且该文件名在 Windows/Ubuntu 上行为分歧（codex round 2）。
    if _SKILL_NAME_RE.fullmatch(skill) and ".." not in skill:
        return None
    return f"invalid skill name '{skill}'"


CATEGORIES = (
    "FRICTION",
    "MISSING_CAPABILITY",
    "INCORRECT_BEHAVIOR",
    "TOKEN_WASTE",
    "WORKFLOW_GAP",
    "OUTPUT_QUALITY",
    "REGRESSION",
    "POSITIVE_SIGNAL",
    "SKILL_BLOAT",
    "OTHER",
)
SEVERITIES = ("low", "medium", "high", "severe")
#: 开放状态 = 还没走完生命周期；其中只有 EVIDENCE_STATUSES 参与阈值计数——
#: 已进提案管道（PROPOSED/APPROVED）的条目不再作为触发证据，否则提案存在
#: 期间每条新反馈都会再触发一次重复的 Evolution Review（codex round 1）。
#: 终态不参与任何计数，compact 时移入 archive。
OPEN_STATUSES = frozenset({"OBSERVING", "CANDIDATE", "PROPOSED", "APPROVED"})
EVIDENCE_STATUSES = frozenset({"OBSERVING", "CANDIDATE"})
TERMINAL_STATUSES = frozenset({"RESOLVED", "REJECTED", "ARCHIVED"})
ALL_STATUSES = tuple(sorted(OPEN_STATUSES | TERMINAL_STATUSES))


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def default_root() -> Path:
    # <root>/.claude/skills/skill-evolution/scripts/evolution.py
    return Path(__file__).resolve().parents[4]


def data_dir(root: Path) -> Path:
    return root / "docs" / "skill-evolution"


def index_path(root: Path) -> Path:
    return data_dir(root) / "index.json"


def backlog_path(root: Path, skill: str) -> Path:
    return data_dir(root) / "backlogs" / f"{skill}.jsonl"


def archive_path(root: Path, skill: str) -> Path:
    return data_dir(root) / "archive" / f"{skill}.jsonl"


def _rel(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def load_index(root: Path) -> dict:
    path = index_path(root)
    if not path.is_file():
        return {"version": SCHEMA_VERSION, "skills": {}}
    return json.loads(path.read_text("utf-8"))


def save_index(root: Path, index: dict) -> None:
    path = index_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    # tmp 名带 pid：本 CLI 假定单写者（一次一个 agent 命令），但两个会话
    # 并行时共享 tmp 名会互相覆盖半成品；pid 后缀让 os.replace 仍然原子。
    # 计数器本身的并发丢失更新仍是已知限制（TASK-100 Follow-up）。
    tmp = path.with_suffix(f".json.tmp{os.getpid()}")
    tmp.write_text(
        json.dumps(index, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
        "utf-8",
    )
    os.replace(tmp, path)


def skill_md_digest(skill_md: Path) -> str | None:
    if not skill_md.is_file():
        return None
    return hashlib.sha256(skill_md.read_bytes()).hexdigest()[:12]


def find_skill_dir(root: Path, skill: str) -> Path | None:
    for skills_root in SKILL_ROOTS:
        candidate = root / skills_root / skill
        if (candidate / "SKILL.md").is_file():
            return candidate
    return None


def discover_skills(root: Path) -> dict[str, Path]:
    """全量发现（只有 sync 用；正常流程禁止调用 —— 需求原文第 14 节）。"""
    found: dict[str, Path] = {}
    for skills_root in SKILL_ROOTS:
        base = root / skills_root
        if not base.is_dir():
            continue
        for entry in sorted(base.iterdir()):
            if entry.is_dir() and (entry / "SKILL.md").is_file():
                found[entry.name] = entry
    return found


def read_backlog(root: Path, skill: str) -> list[dict]:
    path = backlog_path(root, skill)
    if not path.is_file():
        return []
    entries = []
    for line in path.read_text("utf-8").splitlines():
        if line.strip():
            entries.append(json.loads(line))
    return entries


def _write_jsonl(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "".join(
        json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n"
        for entry in entries
    )
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    tmp.write_text(body, "utf-8")
    os.replace(tmp, path)


def _append_jsonl(path: Path, entry: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")


def _recompute(root: Path, skill: str, entry: dict, backlog: list[dict]) -> dict:
    """从 backlog 重算 index 条目的派生字段（计数永远可重建，不会漂移）。"""
    open_entries = [e for e in backlog if e.get("status") in OPEN_STATUSES]
    evidence = [e for e in open_entries if e.get("status") in EVIDENCE_STATUSES]
    keys: dict[str, int] = {}
    for item in evidence:
        key = item.get("key") or ""
        if key and item.get("category") != "POSITIVE_SIGNAL":
            keys[key] = keys.get(key, 0) + 1
    severe_open = sum(1 for e in evidence if e.get("severity") == "severe")
    proposals = sorted(
        {
            e["proposal"]
            for e in backlog
            if e.get("proposal") and e.get("status") in ("PROPOSED", "APPROVED")
        }
    )
    entry["open"] = len(open_entries)
    entry["repeated"] = {k: c for k, c in sorted(keys.items()) if c >= 2}
    entry["severe_open"] = severe_open
    entry["pending_proposals"] = proposals
    if backlog:
        entry["last_feedback_at"] = max(e.get("ts", "") for e in backlog)
    if entry.get("status") != "MISSING":
        if proposals:
            entry["status"] = "PROPOSAL_PENDING"
        elif severe_open or any(c >= REVIEW_THRESHOLD for c in keys.values()):
            entry["status"] = "REVIEW_CANDIDATE"
        elif open_entries:
            entry["status"] = "OBSERVING"
        elif backlog:
            entry["status"] = "HEALTHY"
        else:
            entry["status"] = "REGISTERED"
    return entry


def _review_due(entry: dict) -> tuple[bool, list[str]]:
    reasons = []
    for key, count in entry.get("repeated", {}).items():
        if count >= REVIEW_THRESHOLD:
            reasons.append(f"recurrence {key} x{count}")
    if entry.get("severe_open"):
        reasons.append(f"severe_open x{entry['severe_open']}")
    return bool(reasons), reasons


def register(root: Path, skill: str) -> dict:
    """懒注册：只取最小 metadata，不读 references（需求原文第 11 节）。"""
    if error := _bad_name(skill):
        return {"registered": False, "error": error}
    index = load_index(root)
    entry = index["skills"].get(skill)
    now = _now()
    skill_dir = find_skill_dir(root, skill)
    if entry is None:
        if skill_dir is None:
            return {"registered": False, "error": f"no SKILL.md found for '{skill}'"}
        entry = {
            "path": _rel(root, skill_dir),
            "registered_at": now,
            "revision": skill_md_digest(skill_dir / "SKILL.md"),
            "backlog": _rel(root, backlog_path(root, skill)),
            "feedback_seq": 0,
            "protected": [],
            "last_review_at": None,
            "status": "REGISTERED",
        }
        index["skills"][skill] = entry
        path = backlog_path(root, skill)
        if not path.is_file():
            _write_jsonl(path, [])
    if skill_dir is not None:
        entry["revision"] = skill_md_digest(skill_dir / "SKILL.md")
    entry["last_seen_at"] = now
    _recompute(root, skill, entry, read_backlog(root, skill))
    save_index(root, index)
    return {"registered": True, "skill": skill, "entry": entry}


def status(root: Path, skill: str) -> dict:
    """Fast Loop 的第一步：一次调用回答「注册了吗 + 现有 key + 热点」。"""
    if error := _bad_name(skill):
        return {"registered": False, "skill": skill, "error": error}
    index = load_index(root)
    entry = index["skills"].get(skill)
    if entry is None:
        return {"registered": False, "skill": skill}
    skill_dir = find_skill_dir(root, skill)
    if skill_dir is not None:
        revision = skill_md_digest(skill_dir / "SKILL.md")
        if revision != entry.get("revision"):
            # 文档合同：revision 在 register/status/sync 三处刷新（codex
            # round 1 non-blocking：不刷会让复审/提案引用过期 revision）。
            entry["revision"] = revision
            save_index(root, index)
    backlog = read_backlog(root, skill)
    open_keys: dict[str, int] = {}
    for item in backlog:
        if item.get("status") in OPEN_STATUSES and item.get("key"):
            open_keys[item["key"]] = open_keys.get(item["key"], 0) + 1
    due, reasons = _review_due(entry)
    return {
        "registered": True,
        "skill": skill,
        "entry": entry,
        "open_keys": dict(sorted(open_keys.items())),
        "review_due": due,
        "review_reasons": reasons,
    }


def record(
    root: Path,
    skill: str,
    category: str,
    severity: str,
    key: str,
    note: str,
    task: str | None = None,
) -> dict:
    """一次调用完成：查注册 → 懒注册 → 追加 → 重算 → 阈值判定。"""
    if error := _bad_name(skill):
        return {"recorded": False, "error": error}
    if category not in CATEGORIES:
        return {"recorded": False, "error": f"unknown category '{category}'"}
    if severity not in SEVERITIES:
        return {"recorded": False, "error": f"unknown severity '{severity}'"}
    index = load_index(root)
    auto_registered = False
    if skill not in index["skills"]:
        result = register(root, skill)
        if not result.get("registered"):
            return {"recorded": False, "error": result.get("error")}
        auto_registered = True
        index = load_index(root)
    entry = index["skills"][skill]
    entry["feedback_seq"] = int(entry.get("feedback_seq", 0)) + 1
    feedback = {
        "id": f"fb-{skill}-{entry['feedback_seq']:04d}",
        "ts": _now(),
        "category": category,
        "severity": severity,
        "key": key,
        "note": note,
        "status": "OBSERVING",
    }
    if task:
        feedback["task"] = task
    _append_jsonl(backlog_path(root, skill), feedback)
    _recompute(root, skill, entry, read_backlog(root, skill))
    save_index(root, index)
    due, reasons = _review_due(entry)
    repeated = entry["repeated"].get(key, 1 if key else 0)
    return {
        "recorded": True,
        "id": feedback["id"],
        "skill": skill,
        "auto_registered": auto_registered,
        "recurrence_count": repeated,
        "review_due": due,
        "review_reasons": reasons,
        "note_over_budget": len(note) > 300,
    }


def set_status(
    root: Path,
    skill: str,
    new_status: str,
    ids: list[str] | None = None,
    key: str | None = None,
    proposal: str | None = None,
) -> dict:
    if error := _bad_name(skill):
        return {"updated": 0, "error": error}
    if new_status not in ALL_STATUSES:
        return {"updated": 0, "error": f"unknown status '{new_status}'"}
    if not ids and not key:
        return {"updated": 0, "error": "need --ids or --key"}
    index = load_index(root)
    entry = index["skills"].get(skill)
    if entry is None:
        return {"updated": 0, "error": f"'{skill}' is not registered"}
    backlog = read_backlog(root, skill)
    wanted = set(ids or [])
    updated = 0
    for item in backlog:
        if item.get("id") in wanted or (key and item.get("key") == key):
            item["status"] = new_status
            if proposal:
                item["proposal"] = proposal
            updated += 1
    if updated:
        _write_jsonl(backlog_path(root, skill), backlog)
        _recompute(root, skill, entry, backlog)
        save_index(root, index)
    return {"updated": updated, "skill": skill, "status_now": entry["status"]}


def protect(root: Path, skill: str, key: str, note: str) -> dict:
    if error := _bad_name(skill):
        return {"protected": False, "error": error}
    index = load_index(root)
    entry = index["skills"].get(skill)
    if entry is None:
        return {"protected": False, "error": f"'{skill}' is not registered"}
    protected = entry.setdefault("protected", [])
    for item in protected:
        if item.get("key") == key:
            item["note"] = note
            break
    else:
        protected.append({"key": key, "note": note, "since": _now()})
    save_index(root, index)
    return {"protected": True, "skill": skill, "count": len(protected)}


def review_context(
    root: Path, skill: str, key: str | None = None, include_closed: bool = False
) -> dict:
    """慢循环的读取口：只给目标问题 + severe 的条目，不给整个 backlog。"""
    if error := _bad_name(skill):
        return {"registered": False, "skill": skill, "error": error}
    index = load_index(root)
    entry = index["skills"].get(skill)
    if entry is None:
        return {"registered": False, "skill": skill}
    selected = []
    for item in read_backlog(root, skill):
        if not include_closed and item.get("status") not in OPEN_STATUSES:
            continue
        if key and item.get("key") != key and item.get("severity") != "severe":
            continue
        selected.append(item)
    entry["last_review_at"] = _now()
    save_index(root, index)
    return {
        "skill": skill,
        "path": entry.get("path"),
        "revision": entry.get("revision"),
        "protected": entry.get("protected", []),
        "entries": selected,
    }


def sync(root: Path) -> dict:
    """Manual Full Sync：registry 同步，不是质量审计（需求原文第 39 节）。"""
    index = load_index(root)
    discovered = discover_skills(root)
    known = index["skills"]
    now = _now()
    new_names = [name for name in discovered if name not in known]
    gone = [name for name in known if name not in discovered]

    renamed: list[dict] = []
    for old in list(gone):
        old_revision = known[old].get("revision")
        match = next(
            (
                name
                for name in new_names
                if old_revision
                and skill_md_digest(discovered[name] / "SKILL.md") == old_revision
            ),
            None,
        )
        if match is None:
            continue
        entry = known.pop(old)
        entry.setdefault("previous_names", []).append(old)
        entry["path"] = _rel(root, discovered[match])
        entry["last_seen_at"] = now
        for path_of in (backlog_path, archive_path):
            old_file = path_of(root, old)
            if old_file.is_file():
                new_file = path_of(root, match)
                new_file.parent.mkdir(parents=True, exist_ok=True)
                os.replace(old_file, new_file)
        entry["backlog"] = _rel(root, backlog_path(root, match))
        known[match] = entry
        gone.remove(old)
        new_names.remove(match)
        renamed.append({"from": old, "to": match})

    for name in gone:
        known[name]["status"] = "MISSING"
        known[name]["missing_since"] = known[name].get("missing_since", now)

    for name, entry in known.items():
        if name in discovered:
            entry["last_seen_at"] = now
            entry["revision"] = skill_md_digest(discovered[name] / "SKILL.md")
            if entry.get("status") == "MISSING":
                # 路径复活 = 软删除撤销：先离开 MISSING，_recompute 才会重新派生。
                entry.pop("missing_since", None)
                entry["status"] = "REGISTERED"
            _recompute(root, name, entry, read_backlog(root, name))
    save_index(root, index)

    registered = []
    for name in new_names:
        register(root, name)
        registered.append(name)
    return {
        "discovered": len(discovered),
        "registered_new": registered,
        "renamed": renamed,
        "missing": gone,
    }


def compact(root: Path, skill: str) -> dict:
    """把终态条目移入 archive；正常使用不加载 archive（需求原文第 26 节）。"""
    if error := _bad_name(skill):
        return {"compacted": 0, "error": error}
    index = load_index(root)
    entry = index["skills"].get(skill)
    if entry is None:
        return {"compacted": 0, "error": f"'{skill}' is not registered"}
    backlog = read_backlog(root, skill)
    keep = [e for e in backlog if e.get("status") not in TERMINAL_STATUSES]
    closed = [e for e in backlog if e.get("status") in TERMINAL_STATUSES]
    # 先查 archive 已有的 id：追加在 backlog 重写之前发生，中断后重试不该
    # 把同一条归档两次（codex round 1 non-blocking）。
    archive = archive_path(root, skill)
    archived_ids = set()
    if archive.is_file():
        for line in archive.read_text("utf-8").splitlines():
            if line.strip():
                archived_ids.add(json.loads(line).get("id"))
    for item in closed:
        if item.get("id") not in archived_ids:
            _append_jsonl(archive, item)
    if closed:
        _write_jsonl(backlog_path(root, skill), keep)
        entry["archived"] = int(entry.get("archived", 0)) + len(closed)
        entry["last_compacted_at"] = _now()
        _recompute(root, skill, entry, keep)
        save_index(root, index)
    return {"compacted": len(closed), "remaining_open": len(keep)}


def _emit(payload: dict) -> int:
    sys.stdout.buffer.write(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8") + b"\n"
    )
    return 0 if not payload.get("error") else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="evolution")
    parser.add_argument("--root", type=Path, default=None)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("status")
    p.add_argument("skill")

    p = sub.add_parser("register")
    p.add_argument("skill")

    p = sub.add_parser("record")
    p.add_argument("skill")
    p.add_argument("--category", required=True, choices=CATEGORIES)
    p.add_argument("--severity", required=True, choices=SEVERITIES)
    p.add_argument("--key", required=True)
    p.add_argument("--note", required=True)
    p.add_argument("--task", default=None)

    p = sub.add_parser("set-status")
    p.add_argument("skill")
    p.add_argument("--status", required=True, choices=ALL_STATUSES)
    p.add_argument("--ids", default=None)
    p.add_argument("--key", default=None)
    p.add_argument("--proposal", default=None)

    p = sub.add_parser("protect")
    p.add_argument("skill")
    p.add_argument("--key", required=True)
    p.add_argument("--note", required=True)

    p = sub.add_parser("review-context")
    p.add_argument("skill")
    p.add_argument("--key", default=None)
    p.add_argument("--include-closed", action="store_true")

    sub.add_parser("sync")

    p = sub.add_parser("compact")
    p.add_argument("skill")

    args = parser.parse_args(argv)
    root = (args.root or default_root()).resolve()

    if args.command == "status":
        return _emit(status(root, args.skill))
    if args.command == "register":
        return _emit(register(root, args.skill))
    if args.command == "record":
        return _emit(
            record(
                root,
                args.skill,
                args.category,
                args.severity,
                args.key,
                args.note,
                args.task,
            )
        )
    if args.command == "set-status":
        ids = [i for i in (args.ids or "").split(",") if i]
        return _emit(
            set_status(root, args.skill, args.status, ids, args.key, args.proposal)
        )
    if args.command == "protect":
        return _emit(protect(root, args.skill, args.key, args.note))
    if args.command == "review-context":
        return _emit(review_context(root, args.skill, args.key, args.include_closed))
    if args.command == "sync":
        return _emit(sync(root))
    if args.command == "compact":
        return _emit(compact(root, args.skill))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

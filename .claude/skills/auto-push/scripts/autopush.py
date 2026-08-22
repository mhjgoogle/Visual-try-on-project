"""auto-push 的确定性 Git 执行 CLI（TASK-101 / ADR-0079）。

branch 校验 / diff 归属 / stage / push / sync / merge / cleanup 在这里；
语义判断（Task 是否完成、semantic conflict、Merge Gate）由 dev-workflow 完成。
数据住在 docs/auto-push/changes/（一个 Change 一个 JSON 清单）：放 docs/ 而不是
.claude/，与 skill-evolution 同理 —— commit gate 把 docs/ 归 lint 档，高频元数据
回写不该每次都背全量 pytest。

两条硬边界，都是刻意的：

1. 本脚本**永不执行 `git commit`**。它只把归属于当前 Task 的 diff stage 好，
   然后把该运行的 commit 命令交回 agent 在 shell 里执行 —— PreToolUse 的
   commit gate（ADR-0060/0068）拦截的是 shell 命令文本，脚本内 commit 会让
   质量闸门整个失明。
2. 本脚本**永不构造 force push**。非 fast-forward 一律以状态码交回，
   由人决定是否改写远端历史。

单实现、双 shell 同一条调用：
    python .claude/skills/auto-push/scripts/autopush.py <command> ...
所有输出是单行紧凑 JSON —— 给 agent 读的，不是给人读的。
被拦下的场景（BLOCKED_*）是**合法结果**，exit 0；只有用法/环境错误 exit 1。
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

SCHEMA_VERSION = 1
CHANGES_DIR = Path("docs") / "auto-push" / "changes"

#: 宽 diff 守卫（需求 §31）：超过阈值即要求显式 --allow-wide，由 dev-workflow
#: 重查 Impact / Change Scope 后再放行。阈值是保守起点，不是精确科学。
WIDE_MAX_FILES = 25
WIDE_MAX_TOP_DIRS = 6

#: Change/Task id 会被嵌进可写路径（清单文件名），必须消毒 —— 与
#: skill-evolution 的 _SKILL_NAME_RE 同一防线：只接受目录名字符集，
#: 拒绝 `..`、分隔符与任何路径语义。
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

#: 疑似 secret 的新增行模式（需求 §29）。轻量、保守：宁可误报交回人工，
#: 不可帮用户把凭据推上远端。只扫 **新增** 行（diff 的 `+` 行）。
_SECRET_LINE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("aws-access-key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("github-token", re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}")),
    ("github-fine-grained", re.compile(r"github_pat_[A-Za-z0-9_]{22,}")),
    ("slack-token", re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("private-key-block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    (
        "generic-credential",
        re.compile(
            r"(?i)\b(api[_-]?key|secret[_-]?key|access[_-]?token"
            r"|auth[_-]?token|client[_-]?secret|password|passwd)\b"
            r"\s*[:=]\s*['\"][^'\"]{8,}['\"]"
        ),
    ),
    (
        "bearer-header",
        re.compile(r"(?i)authorization\s*:\s*bearer\s+[A-Za-z0-9._-]{20,}"),
    ),
)

#: 文件名本身就危险的东西：不看内容直接拒绝 stage。
#: .env.example/.env.template 是文档化惯例，放行。
_SECRET_NAME_PATTERNS = (
    ".env",
    ".env.*",
    "*.pem",
    "*.p12",
    "*.pfx",
    "id_rsa",
    "id_rsa.*",
    "id_ed25519",
    "id_ed25519.*",
)
_SECRET_NAME_ALLOWED = ("*.example", "*.template", "*.sample")


class AutoPushError(Exception):
    """用法/环境错误：exit 1。业务性拦截（BLOCKED_*）不用异常，用返回值。"""


# ---------------------------------------------------------------------------
# git 基础设施
# ---------------------------------------------------------------------------


def _git_exe() -> str:
    # AGENTS.md 规则 6：外部工具经 shutil.which 解析，失败即 fail-closed。
    exe = shutil.which("git")
    if not exe:
        raise AutoPushError("git not found on PATH (fail-closed, AGENTS.md rule 6)")
    return exe


def _git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        [_git_exe(), "-C", str(root), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and proc.returncode != 0:
        raise AutoPushError(
            f"git {' '.join(args)} failed ({proc.returncode}): "
            f"{(proc.stderr or proc.stdout).strip()}"
        )
    return proc


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _current_branch(root: Path) -> str:
    return _git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()


def _head_hash(root: Path) -> str:
    return _git(root, "rev-parse", "HEAD").stdout.strip()


def _has_remote(root: Path) -> bool:
    remotes = _git(root, "remote").stdout.split()
    return "origin" in remotes


def _remote_ref(root: Path, branch: str) -> str | None:
    """Change branch 的对端**定义上就是** origin/<branch>。

    不用 `@{u}`：`git switch -c X origin/main` 会把 upstream 自动设成
    origin/main（branch.autoSetupMerge 默认），据它比对会把「main 没动」
    误读成「远端没动」——实测正是这样漏掉 remote-ahead 的。
    """

    ref = f"origin/{branch}"
    return ref if _ref_exists(root, ref) else None


def _ref_exists(root: Path, ref: str) -> bool:
    return (
        _git(root, "rev-parse", "--verify", "--quiet", ref, check=False).returncode == 0
    )


def _is_ancestor(root: Path, ancestor: str, descendant: str) -> bool:
    return (
        _git(
            root, "merge-base", "--is-ancestor", ancestor, descendant, check=False
        ).returncode
        == 0
    )


# ---------------------------------------------------------------------------
# 清单（Change manifest）
# ---------------------------------------------------------------------------


def _bad_id(value: str, label: str) -> None:
    if not (_ID_RE.fullmatch(value) and ".." not in value):
        raise AutoPushError(f"invalid {label} '{value}'")


def _manifest_path(root: Path, change: str) -> Path:
    _bad_id(change, "change id")
    return root / CHANGES_DIR / f"{change}.json"


def _load_manifest(root: Path, change: str) -> dict:
    path = _manifest_path(root, change)
    if not path.is_file():
        raise AutoPushError(
            f"no Change manifest at {path.as_posix()} — run init-change first"
        )
    return json.loads(path.read_text("utf-8"))


def _save_manifest(root: Path, change: str, data: dict) -> None:
    path = _manifest_path(root, change)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")
    tmp.replace(path)


def _manifest_rel(change: str) -> str:
    return (CHANGES_DIR / f"{change}.json").as_posix()


# ---------------------------------------------------------------------------
# 工作树盘点与归属
# ---------------------------------------------------------------------------


def _worktree_entries(root: Path) -> list[tuple[str, str]]:
    """[(XY, path)]，含 untracked；`-z` 使非 ASCII 路径不被 C-quote。"""

    out = _git(
        root,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
    ).stdout
    entries: list[tuple[str, str]] = []
    for record in out.split("\0"):
        if not record:
            continue
        status, path = record[:2], record[3:]
        entries.append((status, path))
    return entries


def _conflicted(entries: list[tuple[str, str]]) -> list[str]:
    return sorted(
        path for status, path in entries if "U" in status or status in ("AA", "DD")
    )


def _staged_paths(root: Path) -> list[str]:
    out = _git(root, "diff", "--cached", "--name-only", "--no-renames", "-z").stdout
    return sorted(p for p in out.split("\0") if p)


def _norm(path: str) -> str:
    return path.replace("\\", "/")


def _matches(path: str, patterns: list[str]) -> bool:
    p = _norm(path)
    for raw in patterns:
        pat = _norm(raw)
        if pat.endswith("/"):
            if p.startswith(pat):
                return True
        elif p == pat or fnmatch.fnmatch(p, pat):
            return True
    return False


def _attribute(
    manifest: dict, task: str, entries: list[tuple[str, str]]
) -> tuple[list[str], list[str], list[str]]:
    """把工作树改动分为：mine / mixed（同时命中别的 Task）/ foreign。

    清单目录（docs/auto-push/changes/）不参与归属：它是本 skill 的回写产物，
    随每次 task commit 一起带走，不算 foreign。
    """

    my_patterns = manifest["tasks"][task]["paths"]
    other_patterns: list[str] = []
    for tid, tdata in manifest["tasks"].items():
        if tid != task:
            other_patterns.extend(tdata["paths"])

    mine: list[str] = []
    mixed: list[str] = []
    foreign: list[str] = []
    for _status, path in entries:
        p = _norm(path)
        if p.startswith("docs/auto-push/changes/"):
            continue
        in_mine = _matches(p, my_patterns)
        in_other = _matches(p, other_patterns)
        if in_mine and in_other:
            mixed.append(p)
        elif in_mine:
            mine.append(p)
        else:
            foreign.append(p)
    return sorted(set(mine)), sorted(set(mixed)), sorted(set(foreign))


def _wide_guard(files: list[str]) -> dict | None:
    top_dirs = {PurePosixPath(f).parts[0] for f in files if PurePosixPath(f).parts}
    if len(files) > WIDE_MAX_FILES or len(top_dirs) > WIDE_MAX_TOP_DIRS:
        return {
            "files": len(files),
            "top_dirs": sorted(top_dirs),
            "limits": {"files": WIDE_MAX_FILES, "top_dirs": WIDE_MAX_TOP_DIRS},
        }
    return None


# ---------------------------------------------------------------------------
# secret 扫描
# ---------------------------------------------------------------------------


def _scan_added_lines(text: str) -> list[dict]:
    hits: list[dict] = []
    for line in text.splitlines():
        if not line.startswith("+") or line.startswith("+++"):
            continue
        for name, pattern in _SECRET_LINE_PATTERNS:
            if pattern.search(line):
                # 只报规则名，绝不回显命中内容：命中行本身就是疑似凭据，
                # 任何回显（console / agent 上下文 / CI 日志）都是二次泄露面
                # （codex 审查轮 1，blocking）。
                hits.append({"rule": name})
    return hits


def _scan_secret_names(files: list[str]) -> list[str]:
    flagged: list[str] = []
    for f in files:
        base = PurePosixPath(f).name
        if any(fnmatch.fnmatch(base, allow) for allow in _SECRET_NAME_ALLOWED):
            continue
        if any(fnmatch.fnmatch(base, pat) for pat in _SECRET_NAME_PATTERNS):
            flagged.append(f)
    return flagged


def _scan_worktree_secrets(
    root: Path, files: list[str]
) -> tuple[list[dict], list[str]]:
    """stage 之前扫（tracked 走 diff，untracked 直接读文件的全文当新增行）。

    返回 (hits, unscanned)：二进制/超大的 untracked 文件做不了行扫描，
    **如实上报**而不是静默跳过——调用方把它们摆到结果里让人看见。
    """

    if not files:
        return [], []  # `git diff --` 无 pathspec 会扫全树 —— 别人的 diff 不归我们管
    hits: list[dict] = []
    unscanned: list[str] = []
    tracked_diff = _git(root, "diff", "--no-color", "--", *files, check=False).stdout
    hits.extend(_scan_added_lines(tracked_diff))
    for f in files:
        full = root / f
        if not full.is_file():
            continue
        proc = _git(root, "ls-files", "--error-unmatch", f, check=False)
        if proc.returncode == 0:
            continue  # tracked：diff 已覆盖
        try:
            raw = full.read_bytes()
        except OSError:
            unscanned.append(f)
            continue
        if b"\0" in raw[:8000] or len(raw) > 1_000_000:
            unscanned.append(f)  # 文件名扫描仍然有效，但行扫描缺席要可见
            continue
        text = raw.decode("utf-8", errors="replace")
        hits.extend(
            _scan_added_lines("\n".join("+" + line for line in text.splitlines()))
        )
    return hits, unscanned


# ---------------------------------------------------------------------------
# 命令实现（每个返回 dict，由 main 打成单行 JSON）
# ---------------------------------------------------------------------------


def init_change(
    root: Path,
    change: str,
    branch: str,
    base: str = "origin/main",
    chain: bool = False,
    adopt: bool = False,
) -> dict:
    """登记一个 Change 并确保 branch 存在且被检出。

    adopt=True 允许收养一条已存在的分支（含当前分支）；否则分支必须能从
    base 新建。分支身份来自调用方（dev-workflow），本脚本不发明分支名。
    """

    _bad_id(change, "change id")
    path = _manifest_path(root, change)
    if path.is_file():
        raise AutoPushError(f"change '{change}' already registered")
    if _git(root, "check-ref-format", "--branch", branch, check=False).returncode != 0:
        raise AutoPushError(f"invalid branch name '{branch}'")
    if branch in ("main", "master"):
        # 否则 --adopt main 之后的每次 push 都直写 origin/main，Merge Gate
        # 整个被绕过（codex 审查轮 1，blocking）。
        raise AutoPushError("a Change branch must not be 'main'/'master'")

    current = _current_branch(root)
    branch_exists = _ref_exists(root, f"refs/heads/{branch}")
    if branch_exists or current == branch:
        if not adopt:
            raise AutoPushError(
                f"branch '{branch}' already exists — pass --adopt to take ownership"
            )
        if current != branch:
            entries = _worktree_entries(root)
            dirty = [p for s, p in entries if s.strip() and not s.startswith("?")]
            if dirty:
                return _blocked(
                    "BLOCKED_DIRTY_SWITCH",
                    "cannot switch branches over uncommitted tracked changes",
                    files=dirty[:20],
                )
            _git(root, "switch", branch)
    else:
        if _has_remote(root) and base.startswith("origin/"):
            _git(root, "fetch", "origin", check=False)
        start = base if _ref_exists(root, base) else "HEAD"
        _git(root, "switch", "-c", branch, start)

    manifest = {
        "schema": SCHEMA_VERSION,
        "change_id": change,
        "branch": branch,
        "status": "open",
        "created": _now(),
        "chain_mode": bool(chain),
        "tasks": {},
        "merge_gate": {"status": "PENDING"},
        "merge": None,
        "cleanup": None,
    }
    _save_manifest(root, change, manifest)
    return {
        "status": "OK",
        "change": change,
        "branch": branch,
        "adopted": branch_exists or current == branch,
        "manifest": _manifest_rel(change),
    }


def task_ready(
    root: Path,
    change: str,
    task: str,
    verification: str,
    paths: list[str],
    ref: str = "",
) -> dict:
    """dev-workflow 申报：Task 完成、验证结果、预期 diff 范围（pathspec）。"""

    _bad_id(task, "task id")
    if verification not in ("PASS", "FAIL"):
        raise AutoPushError("verification must be PASS or FAIL")
    if not paths:
        raise AutoPushError("at least one path pattern is required")
    manifest = _load_manifest(root, change)
    entry = manifest["tasks"].setdefault(task, {"commits": []})
    entry.update(
        {
            "paths": sorted(paths),
            "verification": verification,
            "verification_ref": ref,
            "declared": _now(),
        }
    )
    _save_manifest(root, change, manifest)
    return {
        "status": "OK",
        "change": change,
        "task": task,
        "verification": verification,
    }


def _blocked(status: str, reason: str, **extra) -> dict:
    return {"status": status, "reason": reason, **extra}


def _dirty_gate(root: Path, change: str, operation: str) -> dict | None:
    """sync / premerge-sync / merge 都需要干净的 tracked 工作树。

    唯一的例外形状：只有本 Change 的清单脏（record-commit / push 的回写）——
    这不该把流程卡死，返回 NEEDS_WRITEBACK_COMMIT 让 agent 先提交它
    （docs-only，commit gate 归 lint 档，便宜）。
    """

    entries = _worktree_entries(root)
    dirty = [p for s, p in entries if s.strip() and not s.startswith("?")]
    if not dirty:
        return None
    rel = _manifest_rel(change)
    if [_norm(p) for p in dirty] == [rel]:
        return _blocked(
            "NEEDS_WRITEBACK_COMMIT",
            f"the manifest has unrecorded updates — commit it before {operation}",
            suggested=(
                f"git add -A -- {rel} && git commit -m "
                f'"chore(auto-push): {change} 元数据回写"'
            ),
        )
    return _blocked(
        "BLOCKED_DIRTY",
        f"{operation} needs a clean tracked worktree — commit or hand back first",
        files=dirty[:20],
    )


def _plan_guards(root: Path, manifest: dict, task: str) -> dict | None:
    if task not in manifest["tasks"]:
        raise AutoPushError(f"task '{task}' not declared — run task-ready first")
    tdata = manifest["tasks"][task]
    if tdata.get("verification") != "PASS":
        return _blocked(
            "PUSH_BLOCKED_BY_VERIFICATION",
            f"task '{task}' verification is "
            f"'{tdata.get('verification', 'UNDECLARED')}' — nothing gets committed "
            "until dev-workflow declares PASS",
        )
    current = _current_branch(root)
    if current != manifest["branch"]:
        return _blocked(
            "BLOCKED_BRANCH",
            f"on '{current}' but change '{manifest['change_id']}' owns "
            f"'{manifest['branch']}'",
        )
    return None


def plan(root: Path, change: str, task: str) -> dict:
    manifest = _load_manifest(root, change)
    guard = _plan_guards(root, manifest, task)
    if guard:
        return guard
    entries = _worktree_entries(root)
    conflicts = _conflicted(entries)
    if conflicts:
        return _blocked(
            "BLOCKED_CONFLICT", "unresolved merge conflicts", files=conflicts
        )
    staged = _staged_paths(root)
    if staged:
        return _blocked(
            "BLOCKED_DIRTY_INDEX",
            "index already has staged entries — auto-push refuses to mix them in",
            files=staged[:20],
        )
    mine, mixed, foreign = _attribute(manifest, task, entries)
    if not mine and not mixed:
        return _blocked(
            "NOTHING_TO_COMMIT", f"no worktree change matches task '{task}' paths"
        )
    result: dict = {
        "status": "READY" if not mixed else "MIXED",
        "stage": mine,
        "mixed": mixed,
        "foreign": foreign,
    }
    wide = _wide_guard(mine + mixed)
    if wide:
        result["status"] = "BLOCKED_WIDE"
        result["reason"] = (
            "diff is wider than the declared task shape — re-check Change Scope "
            "in dev-workflow, then re-run with --allow-wide if it is legitimate"
        )
        result["wide"] = wide
    return result


def stage(
    root: Path,
    change: str,
    task: str,
    message: str,
    patch_file: str | None = None,
    allow_wide: bool = False,
) -> dict:
    manifest = _load_manifest(root, change)
    guard = _plan_guards(root, manifest, task)
    if guard:
        return guard
    planned = plan(root, change, task)
    if planned["status"] == "BLOCKED_WIDE" and allow_wide:
        planned["status"] = "MIXED" if planned["mixed"] else "READY"
    if planned["status"] not in ("READY", "MIXED"):
        return planned
    if planned["status"] == "MIXED" and not patch_file:
        return _blocked(
            "BLOCKED_MIXED",
            "these files also match another declared task; stage them by hunk "
            "(--patch-file) or hand back to dev-workflow to untangle the edits",
            files=planned["mixed"],
        )

    to_stage = planned["stage"]
    named = _scan_secret_names(to_stage + planned["mixed"])
    if named:
        return _blocked(
            "BLOCKED_SECRET",
            "file names look like credentials — refuse to stage",
            files=named,
        )
    hits, unscanned = _scan_worktree_secrets(root, to_stage)
    if hits:
        return _blocked(
            "BLOCKED_SECRET",
            "suspected secrets in the diff — commit manually only after a human "
            "confirms these are not credentials",
            hits=hits[:10],
        )

    # 逐文件 `git add -A -- <path>`：捕捉修改/新增/删除，且永不出现 `git add .`。
    for f in to_stage:
        _git(root, "add", "-A", "--", f)

    if patch_file:
        patch_path = Path(patch_file)
        if not patch_path.is_file():
            _git(root, "reset", "-q", "--", *to_stage, check=False)
            raise AutoPushError(f"patch file '{patch_file}' not found")
        patch_text = patch_path.read_text("utf-8")
        patch_hits = _scan_added_lines(patch_text)
        if patch_hits:
            _git(root, "reset", "-q", "--", *to_stage, check=False)
            return _blocked(
                "BLOCKED_SECRET",
                "suspected secrets in the patch",
                hits=patch_hits[:10],
            )
        check = _git(root, "apply", "--cached", "--check", str(patch_path), check=False)
        if check.returncode != 0:
            _git(root, "reset", "-q", "--", *to_stage, check=False)
            return _blocked(
                "BLOCKED_PATCH",
                f"patch does not apply to the index: {check.stderr.strip()[:300]}",
            )
        _git(root, "apply", "--cached", str(patch_path))

    staged_now = _staged_paths(root)
    my_patterns = manifest["tasks"][task]["paths"]
    out_of_scope = [
        p
        for p in staged_now
        if not _matches(p, my_patterns) and not p.startswith("docs/auto-push/changes/")
    ]
    if out_of_scope:
        _git(root, "reset", "-q")
        return _blocked(
            "BLOCKED_SCOPE",
            "staging escaped the declared task paths — nothing was left staged",
            files=out_of_scope,
        )
    if planned["mixed"]:
        uncovered = [p for p in planned["mixed"] if p not in staged_now]
        if uncovered:
            _git(root, "reset", "-q")
            return _blocked(
                "BLOCKED_MIXED",
                "patch did not cover every mixed file — nothing was left staged",
                files=uncovered,
            )

    # 清单自身如有改动一并带走（它是本 Change 的记录，属于每个 task commit）。
    rel = _manifest_rel(change)
    if any(_norm(p) == rel for _s, p in _worktree_entries(root)):
        _git(root, "add", "-A", "--", rel)
        staged_now = _staged_paths(root)

    if not staged_now:
        return _blocked("NOTHING_TO_COMMIT", "staging produced an empty index")

    subject = message if task in message else f"{message}（{task} · {change}）"
    # 消息进文件、命令用固定 ASCII 路径：`-m "内嵌"` 在 bash 里挡不住 $()/
    # 反引号展开，在 PowerShell 里 `\"` 又不是转义——两种 shell 没有共同的
    # 安全内嵌法，不内嵌才是安全的（codex 审查轮 1，blocking）。
    msg_file = root / ".claude" / "tmp" / "autopush-commit-msg.txt"
    msg_file.parent.mkdir(parents=True, exist_ok=True)
    msg_file.write_text(subject + "\n", "utf-8")
    result = {
        "status": "STAGED",
        "staged": staged_now,
        "commit_command": "git commit -F .claude/tmp/autopush-commit-msg.txt",
        "message": subject,
        # ADR-0068 决策 7：链式令牌必须由 agent 逐次手写在提交命令最前面，
        # 任何脚本都不得存储或拼接它 —— 这里只提示，不生成。
        "chain_mode": bool(manifest.get("chain_mode")),
        "note": (
            "run commit_command as a normal shell command so the commit gate "
            "hook can intercept it; then call record-commit"
        ),
    }
    if unscanned:
        result["unscanned"] = unscanned
    return result


def record_commit(root: Path, change: str, task: str) -> dict:
    manifest = _load_manifest(root, change)
    if task not in manifest["tasks"]:
        raise AutoPushError(f"task '{task}' not declared")
    head = _head_hash(root)
    for commit in manifest["tasks"][task]["commits"]:
        if commit["hash"] == head:
            return {"status": "OK", "hash": head, "already_recorded": True}
    subject = _git(root, "show", "-s", "--format=%s", "HEAD").stdout.strip()
    files = [
        p
        for p in _git(
            root,
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "--no-renames",
            "-r",
            "-z",
            "--root",
            "HEAD",
        ).stdout.split("\0")
        if p
    ]
    my_patterns = manifest["tasks"][task]["paths"]
    violations = [
        p
        for p in files
        if not _matches(_norm(p), my_patterns)
        and not _norm(p).startswith("docs/auto-push/changes/")
    ]
    manifest["tasks"][task]["commits"].append(
        {
            "hash": head,
            "subject": subject,
            "time": _now(),
            "branch": _current_branch(root),
            "pushed": False,
            "scope_violation": sorted(violations) or None,
        }
    )
    _save_manifest(root, change, manifest)
    result = {"status": "OK", "hash": head, "files": len(files)}
    if violations:
        result["status"] = "WARN_SCOPE_VIOLATION"
        result["out_of_scope"] = sorted(violations)
    return result


def push(root: Path, change: str) -> dict:
    manifest = _load_manifest(root, change)
    branch = manifest["branch"]
    if _current_branch(root) != branch:
        return _blocked("BLOCKED_BRANCH", f"not on '{branch}'")
    # push 自己复查安全 Gate，不假设提交都经过 stage 走进来（codex 审查轮 1，
    # blocking）：验证状态被撤回、或 record-commit 记下过越界文件的提交，
    # 都不得离开本机。
    for tid, tdata in manifest["tasks"].items():
        unpushed = [c for c in tdata.get("commits", []) if not c.get("pushed")]
        if not unpushed:
            continue
        if tdata.get("verification") != "PASS":
            return _blocked(
                "PUSH_BLOCKED_BY_VERIFICATION",
                f"task '{tid}' has unpushed commits but verification is "
                f"'{tdata.get('verification', 'UNDECLARED')}'",
            )
        violating = [c["hash"][:12] for c in unpushed if c.get("scope_violation")]
        if violating:
            return _blocked(
                "BLOCKED_SCOPE",
                f"task '{tid}' has unpushed commits with recorded out-of-scope "
                "files — dev-workflow must resolve them before push",
                commits=violating,
            )
    if not _has_remote(root):
        return _blocked("BLOCKED_NO_REMOTE", "no 'origin' remote configured")
    _git(root, "fetch", "origin", check=False)
    remote_ref = _remote_ref(root, branch)
    if remote_ref:
        counts = _git(
            root, "rev-list", "--left-right", "--count", f"{branch}...{remote_ref}"
        ).stdout.split()
        ahead, behind = int(counts[0]), int(counts[1])
        if behind:
            return _blocked(
                "NEEDS_SYNC",
                f"remote is {behind} commit(s) ahead — run sync, re-verify, "
                "then push again (force push is forbidden)",
                ahead=ahead,
                behind=behind,
            )
        if not ahead:
            return {"status": "OK", "pushed": False, "note": "nothing to push"}
    # `-u` 永远带上：把 upstream 钉在 origin/<branch>，覆盖 switch -c 从
    # origin/main 起步时 git 自动设下的错误 upstream。
    proc = _git(root, "push", "-u", "origin", branch, check=False)
    if proc.returncode != 0:
        return _blocked("PUSH_FAILED", (proc.stderr or proc.stdout).strip()[:500])
    head = _head_hash(root)
    for tdata in manifest["tasks"].values():
        for commit in tdata["commits"]:
            if _is_ancestor(root, commit["hash"], head):
                commit["pushed"] = True
    _save_manifest(root, change, manifest)
    return {"status": "OK", "pushed": True, "head": head}


def sync(root: Path, change: str) -> dict:
    """remote ahead 时的安全同步：rebase 本地未推送提交到 upstream 之上。

    只改写**本地**历史（未推送部分），远端历史永不改写。冲突即中止并交回。
    """

    manifest = _load_manifest(root, change)
    branch = manifest["branch"]
    if _current_branch(root) != branch:
        return _blocked("BLOCKED_BRANCH", f"not on '{branch}'")
    gate = _dirty_gate(root, change, "sync")
    if gate:
        return gate
    _git(root, "fetch", "origin", check=False)
    remote_ref = _remote_ref(root, branch)
    if not remote_ref:
        return {"status": "OK", "needs_verification": False, "note": "no remote ref"}
    proc = _git(root, "rebase", remote_ref, check=False)
    if proc.returncode != 0:
        conflicts = _conflicted(_worktree_entries(root))
        _git(root, "rebase", "--abort", check=False)
        return _blocked(
            "CONFLICT",
            "rebase hit conflicts and was aborted — hand back to dev-workflow",
            files=conflicts,
        )
    # rebase 改写了本地未推送提交的 hash：清单必须跟着改，否则追溯链指向
    # 已被丢弃的对象（codex 审查轮 1，blocking）。按 subject 顺序重映射；
    # 在新历史里找不到的提交 = rebase 判定其内容已在远端（空提交被丢弃），
    # 如实标注 rebased_away 并视为已上远端。
    recorded = [
        c
        for tdata in manifest["tasks"].values()
        for c in tdata.get("commits", [])
        if not c.get("pushed")
    ]
    if recorded:
        out = _git(root, "log", "--format=%H%x1f%s", f"{remote_ref}..HEAD").stdout
        pool = [line.split("\x1f", 1) for line in out.splitlines() if "\x1f" in line]
        pool.reverse()  # 最旧在前，与记录顺序一致
        for commit in recorded:
            idx = next(
                (i for i, (_h, s) in enumerate(pool) if s == commit.get("subject")),
                None,
            )
            if idx is None:
                commit["rebased_away"] = True
                commit["pushed"] = True
            else:
                new_hash, _s = pool.pop(idx)
                if new_hash != commit["hash"]:
                    commit["rebased_from"] = commit["hash"]
                    commit["hash"] = new_hash
        _save_manifest(root, change, manifest)
    return {
        "status": "OK",
        "needs_verification": True,
        "note": "re-run targeted verification before pushing",
    }


def set_merge_gate(root: Path, change: str, status: str, by: str) -> dict:
    if status not in ("PASS", "FAIL"):
        raise AutoPushError("merge gate status must be PASS or FAIL")
    if not by.strip():
        raise AutoPushError(
            "--by is required: record the basis (user's words / date) for the gate"
        )
    manifest = _load_manifest(root, change)
    if _current_branch(root) != manifest["branch"]:
        return _blocked(
            "BLOCKED_BRANCH",
            f"set the merge gate from '{manifest['branch']}' — the gate binds "
            "to that branch's verified tip",
        )
    if status == "PASS":
        not_passed = [
            tid
            for tid, tdata in manifest["tasks"].items()
            if tdata.get("verification") != "PASS"
        ]
        if not_passed:
            return _blocked(
                "BLOCKED_TASKS_NOT_PASSED",
                "merge gate cannot PASS while tasks lack verification PASS",
                tasks=not_passed,
            )
    # tip 把 PASS 钉在「验证通过的那个提交」上：之后 HEAD 一动（premerge-sync
    # 或新提交），merge 必须先重验证（codex 审查轮 1，blocking）。
    manifest["merge_gate"] = {
        "status": status,
        "by": by,
        "time": _now(),
        "tip": _head_hash(root),
    }
    _save_manifest(root, change, manifest)
    return {"status": "OK", "merge_gate": status}


def premerge_sync(root: Path, change: str) -> dict:
    """merge 前把 latest main 合进 Change branch；冲突时留在原地交回 agent。"""

    manifest = _load_manifest(root, change)
    branch = manifest["branch"]
    if _current_branch(root) != branch:
        return _blocked("BLOCKED_BRANCH", f"not on '{branch}'")
    gate = _dirty_gate(root, change, "premerge-sync")
    if gate:
        return gate
    main_ref = "origin/main" if _has_remote(root) else "main"
    if _has_remote(root):
        _git(root, "fetch", "origin", check=False)
    if _is_ancestor(root, main_ref, "HEAD"):
        return {"status": "UP_TO_DATE", "needs_verification": False}
    proc = _git(root, "merge", main_ref, "--no-edit", check=False)
    if proc.returncode != 0:
        conflicts = _conflicted(_worktree_entries(root))
        return _blocked(
            "CONFLICT",
            "merge from main hit conflicts — resolve per the skill's conflict "
            "rules or run merge-abort and hand back",
            files=conflicts,
        )
    return {
        "status": "OK",
        "merged": _head_hash(root),
        "needs_verification": True,
        "note": "re-run targeted verification, then merge",
    }


def merge_abort(root: Path, change: str) -> dict:
    _load_manifest(root, change)
    proc = _git(root, "merge", "--abort", check=False)
    if proc.returncode != 0:
        return _blocked("NO_MERGE_IN_PROGRESS", proc.stderr.strip()[:200])
    return {"status": "OK"}


def merge(root: Path, change: str, reverified: bool = False) -> dict:
    """Merge Gate = PASS 后把 Change branch 以 --no-ff 合入 main 并 push。"""

    manifest = _load_manifest(root, change)
    branch = manifest["branch"]
    if _current_branch(root) != branch:
        return _blocked("BLOCKED_BRANCH", f"merge runs from '{branch}'")
    gate = manifest.get("merge_gate") or {}
    if gate.get("status") != "PASS":
        return _blocked(
            "BLOCKED_MERGE_GATE",
            f"merge gate is '{gate.get('status', 'PENDING')}' — only dev-workflow "
            "sets PASS, and only on the user's explicit merge instruction",
        )
    gate_dirty = _dirty_gate(root, change, "merge")
    if gate_dirty:
        return gate_dirty
    main_ref = "origin/main" if _has_remote(root) else "main"
    if _has_remote(root):
        _git(root, "fetch", "origin", check=False)
    if not _is_ancestor(root, main_ref, branch):
        return _blocked(
            "BLOCKED_NOT_SYNCED",
            "latest main is not an ancestor of the change branch — run "
            "premerge-sync (and re-verify) first",
        )
    if gate.get("tip") and _head_hash(root) != gate["tip"] and not reverified:
        # PASS 绑定的是验证过的 tip；premerge-sync / 新提交移动 HEAD 之后，
        # 必须在当前 tip 上重跑定向验证再带 --reverified 进来。
        return _blocked(
            "BLOCKED_STALE_GATE",
            "HEAD moved since the merge gate passed — re-run targeted "
            "verification on the current tip, then pass --reverified",
            gate_tip=gate["tip"],
        )
    if _has_remote(root):
        # 远端 Change 分支必须如实反映将被合并的 tip（writeback / premerge-sync
        # 的提交也在内），否则 merge 后 cleanup 的 -d 会因 upstream 落后而拒绝。
        tip_push = _git(root, "push", "-u", "origin", branch, check=False)
        if tip_push.returncode != 0:
            return _blocked(
                "PUSH_FAILED",
                "could not push the final change-branch tip before merging",
                detail=(tip_push.stderr or tip_push.stdout).strip()[:300],
            )
        local_main = _git(root, "rev-parse", "main", check=False)
        remote_main = _git(root, "rev-parse", "origin/main", check=False)
        if (
            local_main.returncode == 0
            and remote_main.returncode == 0
            and local_main.stdout.strip() != remote_main.stdout.strip()
        ):
            ff = _git(root, "fetch", "origin", "main:main", check=False)
            if ff.returncode != 0:
                return _blocked(
                    "BLOCKED_MAIN_DIVERGED",
                    "local main and origin/main diverged — a human must decide",
                )
    _git(root, "switch", "main")
    proc = _git(root, "merge", "--no-ff", "--no-edit", branch, check=False)
    if proc.returncode != 0:
        _git(root, "merge", "--abort", check=False)
        _git(root, "switch", branch, check=False)
        return _blocked(
            "MERGE_FAILED",
            "merge into main failed even after premerge-sync — investigate",
            detail=(proc.stderr or proc.stdout).strip()[:300],
        )
    merge_hash = _head_hash(root)
    pushed = False
    if _has_remote(root):
        push_proc = _git(root, "push", "origin", "main", check=False)
        pushed = push_proc.returncode == 0
        if not pushed:
            manifest["merge"] = {"hash": merge_hash, "time": _now(), "pushed": False}
            _save_manifest(root, change, manifest)
            return _blocked(
                "MAIN_PUSH_FAILED",
                "merge landed locally but pushing main failed (never forced); "
                "fetch, inspect, and retry push manually",
                merge=merge_hash,
                detail=(push_proc.stderr or push_proc.stdout).strip()[:300],
            )
    manifest["merge"] = {"hash": merge_hash, "time": _now(), "pushed": pushed}
    manifest["status"] = "merged"
    _save_manifest(root, change, manifest)
    return {"status": "OK", "merge": merge_hash, "pushed_main": pushed}


def cleanup(root: Path, change: str, keep_remote: bool = False) -> dict:
    manifest = _load_manifest(root, change)
    branch = manifest["branch"]
    merged = manifest.get("merge") or {}
    if not merged.get("hash"):
        return _blocked("BLOCKED_NOT_MERGED", "no recorded merge — nothing to clean")
    confirm_ref = "origin/main" if _has_remote(root) else "main"
    if _has_remote(root):
        _git(root, "fetch", "origin", check=False)
    if not _is_ancestor(root, merged["hash"], confirm_ref):
        return _blocked(
            "BLOCKED_MERGE_NOT_CONFIRMED",
            f"merge {merged['hash'][:12]} is not on {confirm_ref} — refuse to "
            "delete the branch",
        )
    if _current_branch(root) == branch:
        return _blocked("BLOCKED_BRANCH", "switch off the change branch first")
    local_deleted = False
    if _ref_exists(root, f"refs/heads/{branch}"):
        proc = _git(root, "branch", "-d", branch, check=False)  # 永不 -D
        if proc.returncode != 0:
            return _blocked(
                "BLOCKED_UNMERGED_COMMITS",
                f"git branch -d refused: {proc.stderr.strip()[:200]}",
            )
        local_deleted = True
    remote_deleted = False
    remote_error = None
    if _has_remote(root) and not keep_remote:
        remote_branch = f"origin/{branch}"
        if not _ref_exists(root, remote_branch):
            remote_deleted = True  # 远端本来就没有 —— 无事可删
        elif not _is_ancestor(root, remote_branch, "origin/main"):
            # 远端分支 tip 有 origin/main 里没有的提交（并发的 merge 后推送）：
            # 删了它那些提交就永久丢失（codex 审查轮 1，blocking）。
            remote_error = (
                "remote branch tip has commits not contained in origin/main — "
                "refused to delete; inspect the concurrent push first"
            )
        else:
            proc = _git(root, "push", "origin", "--delete", branch, check=False)
            remote_deleted = proc.returncode == 0
            if not remote_deleted:
                remote_error = (proc.stderr or proc.stdout).strip()[:200]
    manifest["cleanup"] = {
        "local_deleted": local_deleted,
        "remote_deleted": remote_deleted,
        "time": _now(),
    }
    manifest["status"] = "closed"
    _save_manifest(root, change, manifest)
    result = {
        # 远端没删干净不是 OK：如实报 WARN，调用方不得当成功上报
        # （codex 审查轮 1，non-blocking #2）。
        "status": "OK"
        if (remote_deleted or keep_remote or not _has_remote(root))
        else "WARN_REMOTE_CLEANUP",
        "local_deleted": local_deleted,
        "remote_deleted": remote_deleted,
    }
    if remote_error:
        result["remote_error"] = remote_error
    return result


def change_status(root: Path, change: str) -> dict:
    manifest = _load_manifest(root, change)
    return {
        "status": "OK",
        "change": manifest["change_id"],
        "branch": manifest["branch"],
        "state": manifest["status"],
        "merge_gate": manifest.get("merge_gate", {}).get("status", "PENDING"),
        "tasks": {
            tid: {
                "verification": tdata.get("verification", "UNDECLARED"),
                "commits": len(tdata.get("commits", [])),
                "pushed": all(c.get("pushed") for c in tdata.get("commits", []))
                if tdata.get("commits")
                else False,
            }
            for tid, tdata in manifest["tasks"].items()
        },
        "merge": manifest.get("merge"),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _repo_root(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).resolve()
    proc = subprocess.run(
        [_git_exe(), "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        raise AutoPushError("not inside a git repository (pass --root)")
    return Path(proc.stdout.strip())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="autopush")
    parser.add_argument("--root", default=None, help="repo root (default: discover)")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init-change")
    p.add_argument("--change", required=True)
    p.add_argument("--branch", required=True)
    p.add_argument("--base", default="origin/main")
    p.add_argument("--chain", action="store_true")
    p.add_argument("--adopt", action="store_true")

    p = sub.add_parser("task-ready")
    p.add_argument("--change", required=True)
    p.add_argument("--task", required=True)
    p.add_argument("--verification", required=True)
    p.add_argument("--ref", default="")
    p.add_argument("--paths", nargs="+", required=True)

    for name in ("plan",):
        p = sub.add_parser(name)
        p.add_argument("--change", required=True)
        p.add_argument("--task", required=True)

    p = sub.add_parser("stage")
    p.add_argument("--change", required=True)
    p.add_argument("--task", required=True)
    p.add_argument("--message", required=True)
    p.add_argument("--patch-file", default=None)
    p.add_argument("--allow-wide", action="store_true")

    p = sub.add_parser("record-commit")
    p.add_argument("--change", required=True)
    p.add_argument("--task", required=True)

    for name in ("push", "sync", "premerge-sync", "merge-abort", "status"):
        p = sub.add_parser(name)
        p.add_argument("--change", required=True)

    p = sub.add_parser("merge")
    p.add_argument("--change", required=True)
    p.add_argument("--reverified", action="store_true")

    p = sub.add_parser("set-merge-gate")
    p.add_argument("--change", required=True)
    p.add_argument("--gate", required=True, choices=("PASS", "FAIL"))
    p.add_argument("--by", required=True)

    p = sub.add_parser("cleanup")
    p.add_argument("--change", required=True)
    p.add_argument("--keep-remote", action="store_true")

    args = parser.parse_args(argv)
    try:
        root = _repo_root(args.root)
        if args.command == "init-change":
            result = init_change(
                root, args.change, args.branch, args.base, args.chain, args.adopt
            )
        elif args.command == "task-ready":
            result = task_ready(
                root, args.change, args.task, args.verification, args.paths, args.ref
            )
        elif args.command == "plan":
            result = plan(root, args.change, args.task)
        elif args.command == "stage":
            result = stage(
                root,
                args.change,
                args.task,
                args.message,
                args.patch_file,
                args.allow_wide,
            )
        elif args.command == "record-commit":
            result = record_commit(root, args.change, args.task)
        elif args.command == "push":
            result = push(root, args.change)
        elif args.command == "sync":
            result = sync(root, args.change)
        elif args.command == "set-merge-gate":
            result = set_merge_gate(root, args.change, args.gate, args.by)
        elif args.command == "premerge-sync":
            result = premerge_sync(root, args.change)
        elif args.command == "merge-abort":
            result = merge_abort(root, args.change)
        elif args.command == "merge":
            result = merge(root, args.change, args.reverified)
        elif args.command == "cleanup":
            result = cleanup(root, args.change, args.keep_remote)
        elif args.command == "status":
            result = change_status(root, args.change)
        else:  # pragma: no cover - argparse enforces choices
            raise AutoPushError(f"unknown command {args.command}")
    except AutoPushError as exc:
        # ensure_ascii=True（默认）：Windows 控制台可能是 cp932/cp936，
        # 非 ASCII 直出会 UnicodeEncodeError——JSON 转义对 agent 无损。
        print(json.dumps({"error": str(exc)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())

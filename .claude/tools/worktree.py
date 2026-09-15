"""一个会话一棵工作树：创建 / 查看 / 回收。

**这不是一套新治理系统，是三条 git 命令的安全外壳。** 登记表就是
`git worktree list`，没有第二份状态文件、没有锁、没有调度进程
（TASK-143 OUT OF SCOPE 已经写死这一点）。

为什么值得有这个文件，而不是把四条命令写进文档：

1. **venv 不能漏。** 闸门用的是 `<工作树>/.venv/Scripts/python.exe`
   （`gate.ps1` 从 `git rev-parse --show-toplevel` 解析）。树里没有 venv 时闸门
   fail-closed，报的却是「could not run the risk classifier」—— 正确但难诊断。
2. **共享 venv 会安静地测错代码。** `pip install -e .` 写进 site-packages 的
   `__editable__*.pth` 是**绝对路径**；把一份 venv 共享给多棵树，
   `import ai_video_workflow` 会解析到建它的那棵树的 `src/`，测试全绿而测的是
   别人的代码。所以每棵树必须有自己的 venv，而这一步必须自动做。
3. **回收要挡住没交付的工作。** `git worktree remove` 自己只看工作区脏不脏，
   不看分支上有没有还没推出去的提交。

解释器：用**跑本脚本的这个解释器**去建 venv。从某棵树的 `.venv/Scripts/python.exe`
调用它，新树就拿到同一个基础 Python —— 不需要版本探测，也就没有
「`python` 在 PATH 上解析到哪一个」这种静默漂移（pyproject 里 `requires-python`
上方记的就是这条）。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

#: 工作树放在仓库**外面**的这个兄弟目录里。放仓库内会被主树的
#: `ruff format --check .`、`lifecycle_check` 和文档链接检查当成自己的内容扫进去，
#: 那正好是这套隔离要消掉的病。
WT_DIRNAME = "motv-wt"

#: change-id 允许的形状。放行路径分隔符会让 `new ../../x` 写到仓库外任意位置。
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class Refused(Exception):
    """拒绝执行，并说明为什么。退出码 2，与闸门的「挡住」同义。"""


def repo_root() -> Path:
    """从**脚本自己的位置**解析，不问 cwd。

    与 agent_harness / gate_dispatch 同一条纪律：从子目录调用时 cwd 会骗人。
    """

    return Path(__file__).resolve().parents[2]


def branch_name(change_id: str) -> str:
    return f"change/{change_id}"


def resolve_target(root: Path, change_id: str) -> Path:
    """`<仓库的父目录>/motv-wt/<change-id>`，并挡住两类坏输入。

    纯函数，测试直接调它 —— 不需要真的建一棵树，也因此对**含空格的仓库路径**
    可测（Windows 上那是常态，不是边缘情形）。
    """

    if not _ID_RE.match(change_id or ""):
        raise Refused(
            f"change-id 不合法：{change_id!r}。"
            "只允许字母数字开头、其后字母数字与 . _ -，不含路径分隔符。"
        )
    target = (root.parent / WT_DIRNAME / change_id).resolve()
    # 仓库内不许建。`is_relative_to` 是 3.9+，本仓库 requires-python >=3.10。
    if target == root or target.is_relative_to(root):
        raise Refused(f"工作树不能建在仓库内部：{target}")
    return target


def _git(root: Path, *args: str, check: bool = False) -> subprocess.CompletedProcess:
    """`git -C <root> ...`。**永远走列表形式**，所以含空格的路径不需要引号学。"""

    return subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=check,
    )


def parse_worktree_list(porcelain: str, exists: object = None) -> list[dict]:
    """把 `git worktree list --porcelain` 解析成表。**这就是登记表本身。**

    纯函数（`exists` 可注入），因为解析是唯一会出错的部分，而它不需要真工作树。
    """

    # **NUL 优先。** `git worktree list --porcelain`（不带 `-z`）会把含非 ASCII 或
    # 特殊字符的路径 C-quote 成 `"D:/…/\344\270\255\346\226\207"`，那个字符串不是
    # 路径 —— 拿它去 `Path()` 会算出一个不存在的地方，主树基准与 new/drop 一起错。
    # `-z` 的格式实测过（2026-09-15）：属性之间一个 `\0`，条目之间两个。
    # 换行形式仍然认，因为纯函数测试用它写夹具更好读。
    # 这是 codex 轮 1 那条 `ls-files` 引号缺陷的**同一个失效机理**（ADR-0081 §2b），
    # 所以一次把这个类扫完，而不是再补一处。
    records = porcelain.split("\0") if "\0" in porcelain else porcelain.splitlines()
    rows: list[dict] = []
    cur: dict = {}
    for line in records:
        if not line.strip():
            if cur:
                rows.append(cur)
            cur = {}
            continue
        key, _, val = line.partition(" ")
        cur[key] = val
    if cur:
        rows.append(cur)
    for r in rows:
        p = Path(r.get("worktree", ""))
        r["path"] = str(p)
        r["branch"] = (r.get("branch") or "").replace("refs/heads/", "") or "(detached)"
        if exists is None:
            r["venv"] = (p / ".venv" / "Scripts" / "python.exe").is_file() or (
                p / ".venv" / "bin" / "python"
            ).is_file()
        else:
            r["venv"] = bool(exists(p))
    return rows


def main_root_from(porcelain: str) -> Path | None:
    """`git worktree list --porcelain` 的**第一条就是主工作树**（git 的文档行为）。

    这一步不能省，也不能用「脚本所在的树」代替。**本工具会从某棵 worktree 里被
    调用**，那时 `repo_root()` 是 `…/motv-wt/<id>`，它的父目录已经是 `motv-wt`，
    再拼一层就得到 `motv-wt/motv-wt/<id>` —— 一个不存在的地方。
    （自测当场抓到：在 l4-loop 里跑 `drop l4-loop`，它去找一棵双层路径的树。）
    """

    rows = parse_worktree_list(porcelain, exists=lambda _p: False)
    return Path(rows[0]["path"]) if rows else None


def worktrees(root: Path) -> list[dict]:
    return parse_worktree_list(
        _git(root, "worktree", "list", "--porcelain", "-z").stdout
    )


def main_root(root: Path) -> Path:
    """工作树目录的基准 —— 永远是主树，不是「我此刻在哪棵树里」。"""

    got = main_root_from(_git(root, "worktree", "list", "--porcelain", "-z").stdout)
    if got is None:
        raise Refused("读不出 git worktree list —— 判不了基准就不动手")
    return got


def undelivered_reasons(
    dirty_rc: int, dirty_out: str, unpushed_rc: int, unpushed_out: str
) -> list[str]:
    """回收前必须为空的那张清单。纯函数 —— 两个 git 的结果进来，理由出去。

    「没提交」和「没交付」是两件事，都要挡：`git worktree remove` 只看第一件，
    第二件（分支上有提交但哪个 remote 都没有）它不看，而那恰恰是
    「删掉就真的没了」的那一种。

    **读不出来也算理由。** 判不了就不删 —— 这是 fail-closed，不是谨慎过头：
    另一种写法是「没发现问题所以删」，那正是本仓库反复付账的那一类。
    """

    reasons: list[str] = []
    if dirty_rc != 0:
        reasons.append(f"读不出工作区状态（git 退出 {dirty_rc}）—— 判不了就不删")
    elif dirty_out.strip():
        n = len([ln for ln in dirty_out.splitlines() if ln.strip()])
        reasons.append(f"工作区有 {n} 条未提交改动")
    if unpushed_rc != 0:
        reasons.append("读不出未推送提交 —— 判不了就不删")
    elif unpushed_out.strip():
        n = len([ln for ln in unpushed_out.splitlines() if ln.strip()])
        reasons.append(f"有 {n} 个提交还没推到任何 remote")
    return reasons


def undelivered(root: Path, path: Path, branch: str) -> list[str]:
    """两个 git 的结果喂给纯判断。

    **未推送检查从这棵树自己的 `HEAD` 起算，分支有没有名字都一样。** 第一版在
    detached 时整个跳过这一步（codex 轮 1 的 BLOCKING）：一棵 detached 的树上
    做了提交却没推，回收掉它的工作树引用之后，那些提交就只剩 reflog 兜着，
    等一次 gc 就真的没了 —— 而「删掉就真没了」正是这道闸要挡的那一种。
    `HEAD --not --remotes` 对两种情形都成立，所以这里不需要两条路径。
    """

    dirty = _git(path, "status", "--porcelain")
    unpushed = _git(path, "log", "--oneline", "HEAD", "--not", "--remotes")
    return undelivered_reasons(
        dirty.returncode, dirty.stdout, unpushed.returncode, unpushed.stdout
    )


def resolve_base(base: str, resolved_in_caller: str | None) -> str:
    """基准**一律在调用者那棵树里先解析成具体 sha**，再交给主树执行。

    纯函数，因为这一条错起来是**无声的**（codex 轮 3 + 轮 4 的 BLOCKING）：
    git 命令统一以主树为执行根（那是对的 —— `worktree add` 要从那里发），
    于是任何**相对量**都会在主树上解析。从一棵已经有若干提交的 feature 树里
    `new` 一棵新树时，新分支会安静地少掉那些提交，而命令看起来完全成功。

    轮 3 我只修了字面量 `HEAD`，轮 4 立刻报回 `HEAD~1` —— **同一个机理的另一个
    拼法**。所以这里不再枚举哪些 ref 是相对的（`HEAD` / `HEAD~1` / `HEAD^` /
    `@{-1}` / `HEAD@{2}` / `@{u}`…枚举不完），改为**一个都不透传**：
    全部先解析成 sha。分支名与 sha 本来就在两棵树上同解，多解析一次无害。
    """

    if not resolved_in_caller:
        raise Refused(
            f"在当前树里解析不出基准 {base!r} —— 基准判不了就不建树"
            "（别让它默认落到主树上）"
        )
    return resolved_in_caller


def cmd_new(root: Path, here: Path, change_id: str, base: str, make_venv: bool) -> int:
    # `^{commit}`：让 tag 与 annotated ref 也落到提交上，解析不出即空串 → 拒绝。
    got = _git(here, "rev-parse", "--verify", "--quiet", f"{base}^{{commit}}")
    base = resolve_base(base, (got.stdout or "").strip() if got.returncode == 0 else "")
    target = resolve_target(root, change_id)
    if target.exists():
        raise Refused(f"已存在：{target}（要重来先 drop）")
    br = branch_name(change_id)
    if _git(root, "rev-parse", "--verify", "--quiet", br).returncode == 0:
        raise Refused(f"分支已存在：{br} —— 一个 change 一棵树，不重开第二棵")
    target.parent.mkdir(parents=True, exist_ok=True)
    add = _git(root, "worktree", "add", str(target), "-b", br, base)
    sys.stdout.write(add.stdout + add.stderr)
    if add.returncode != 0:
        return add.returncode
    if make_venv:
        # sys.executable：从某棵树的 venv 调用本脚本，新树就拿到同一个基础 Python。
        venv = subprocess.run(
            [sys.executable, "-m", "venv", str(target / ".venv")],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if venv.returncode != 0:
            sys.stdout.write(venv.stdout + venv.stderr)
            raise Refused(
                "venv 建不出来 —— 树留着，装好 venv 再用；没有 venv 的树上闸门跑不了"
            )
        rel = "Scripts/python.exe" if sys.platform == "win32" else "bin/python"
        py = target / ".venv" / rel
        pip = subprocess.run(
            [str(py), "-m", "pip", "install", "--quiet", "-e", ".[dev,e2e]"],
            cwd=str(target),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        sys.stdout.write(pip.stdout + pip.stderr)
        if pip.returncode != 0:
            raise Refused("依赖装不上 —— 同上，别在半成品树上提交")
    print(f"\n工作树就绪：{target}")
    print(f"分支：{br}")
    print("下一步：让会话以这棵树为 project root（EnterWorktree），再动手。")
    return 0


def cmd_list(root: Path) -> int:
    for r in worktrees(root):
        mark = "venv" if r["venv"] else "NO-VENV"
        print(f"{r['branch']:<34} {mark:<8} {r['path']}")
    return 0


def cmd_drop(root: Path, change_id: str, force: bool) -> int:
    target = resolve_target(root, change_id)
    row = next((r for r in worktrees(root) if Path(r["path"]) == target), None)
    if row is None:
        raise Refused(f"不在 git worktree list 里：{target}")
    reasons = undelivered(root, target, row["branch"])
    if reasons and not force:
        raise Refused(
            "拒绝回收，因为这棵树还有没交付的东西：\n  - "
            + "\n  - ".join(reasons)
            + "\n确认要丢弃就加 --force（它会连未提交内容一起删掉）。"
        )
    rm = _git(root, "worktree", "remove", *(["--force"] if force else []), str(target))
    sys.stdout.write(rm.stdout + rm.stderr)
    if rm.returncode != 0:
        return rm.returncode
    print(f"已回收：{target}（分支 {row['branch']} 保留 —— 删分支是另一个决定）")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="一个会话一棵工作树")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("new", help="建树 + 建 venv + 装依赖")
    p.add_argument("change_id")
    p.add_argument("--base", default="HEAD", help="从哪个 ref 分出来（默认 HEAD）")
    p.add_argument(
        "--no-venv", action="store_true", help="只建树，不建 venv（之后不能直接提交）"
    )
    sub.add_parser("list", help="现有工作树（登记表就是 git 自己）")
    sub.add_parser("json", help="机读：工作树表")
    p = sub.add_parser("drop", help="回收一棵树（有未交付内容时拒绝）")
    p.add_argument("change_id")
    p.add_argument("--force", action="store_true", help="明确丢弃未交付内容")
    args = ap.parse_args(argv)
    # Windows 控制台默认不是 UTF-8：不重配就会把中文的拒绝理由打成乱码，
    # 而一条读不懂的拒绝理由等于没有理由（自测当场撞到）。
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    here = repo_root()
    try:
        # 基准锚在主工作树上，不是「脚本此刻在哪棵树里」。
        root = main_root(here)
        if args.cmd == "new":
            return cmd_new(root, here, args.change_id, args.base, not args.no_venv)
        if args.cmd == "list":
            return cmd_list(root)
        if args.cmd == "json":
            print(json.dumps(worktrees(root), ensure_ascii=False, indent=2))
            return 0
        if args.cmd == "drop":
            return cmd_drop(root, args.change_id, args.force)
    except Refused as exc:
        print(f"拒绝：{exc}", file=sys.stderr)
        return 2
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

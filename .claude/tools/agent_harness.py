#!/usr/bin/env python3
"""开发工装体检：技能读得到吗、两个客户端都找得到吗、接线指得着吗、真跑过吗。

TASK-131 切片 A。要消除的是一类**静默失效**：规则写了却没被加载、hook 配了却
从没触发、技能只有 Claude 找得到而 Codex 找不到 —— 这三种失败都不报错，它们
只是安静地什么也不做，然后下一个人对着一份「明明配好了」的仓库debug 半天。

`motv_doctor.py` 体检的是**真实创作项目**（他看得见什么、Agent 改得动什么），
那是产品合同。这一份体检的是**开发工装自己**，两者不混（TASK-131 §2）。

四个维度，各回答一个问题::

  1. source     技能源文件读得到、frontmatter 解析得开、引用的文件都在吗
  2. discovery  Claude 侧和 Codex 侧**找到的是不是同一套**技能
  3. wiring     settings.json 里配的 hook，目标文件和解释器指得着吗
  4. evidence   它**真的跑过**吗 —— 拿不到证据就写 UNKNOWN，不写 PASS

用法::

    python .claude/tools/agent_harness.py doctor
    python .claude/tools/agent_harness.py doctor --json
    python .claude/tools/agent_harness.py doctor --root <fixture>   # 测试用
    python .claude/tools/agent_harness.py doctor --strict           # UNKNOWN 也算不过

**只读。** 不写文件、不联网、不启动模型，也**不执行**从配置里读到的任何命令 ——
体检一个「这条命令是什么」的问题，不该靠把它跑一遍来回答。

判词四种：`PASS` / `FAIL` / `UNKNOWN` / `NOT_APPLICABLE`。
**没观察到就不许写 PASS**（TASK-131 §4A）—— 一个假的 ✓ 比一个诚实的 ? 危险得多，
这条纪律和 `motv_doctor` 是同一条。零输入同理：一个技能都没找到时必须转红，
不能因为「没有东西可查」而一路绿 —— 那正是 `motv_doctor` 2026-08-31 栽过的坑
（查错了地方的体检不会报错，只会一路绿）。

退出码：有 FAIL → 1；`--strict` 时 UNKNOWN 也 → 1；其余 0。
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

PASS, FAIL, UNKNOWN, NA = "PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"
MARK = {PASS: "✓", FAIL: "✗", UNKNOWN: "?", NA: "—"}

#: 维度顺序即报告顺序：先证源文件在，再证客户端找得到，再证接线指得着，
#: 最后才问「真跑过吗」。倒过来问没有意义 —— 源文件都不在的东西谈不上跑过。
DIMENSIONS = ("source", "discovery", "wiring", "evidence")

#: `.claude/skills/` 是**唯一实现源**（TASK-131 §2）。这里不写死技能名单：
#: 写死名单的体检在有人加了第六个技能的那天会安静地漏掉它，而漏掉恰恰是本工具
#: 要消除的那种失效。名单从目录里发现，缺什么由 discovery 维度去比。
CLAUDE_SKILLS = Path(".claude") / "skills"
#: Codex 的仓库级发现路径（官方 Build skills 文档）。今天它不存在 —— 那正是
#: 切片 B 要补的缺口，本切片的职责是**把这个差异摆出来**，不是顺手补上。
CODEX_SKILLS = Path(".agents") / "skills"

SETTINGS = Path(".claude") / "settings.json"

#: markdown 链接里的相对路径。锚点、mailto 与 http(s) 不是文件，跳过。
_LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_NOT_A_FILE = re.compile(r"^(https?:|mailto:|#)")


class Finding:
    """一条检查结论。`required` 的 FAIL 才让退出码转红。"""

    def __init__(
        self,
        dimension: str,
        check: str,
        verdict: str,
        detail: str,
        path: str | None = None,
        required: bool = True,
    ) -> None:
        self.dimension = dimension
        self.check = check
        self.verdict = verdict
        self.detail = detail
        self.path = path
        self.required = required

    def as_dict(self) -> dict:
        return {
            "dimension": self.dimension,
            "check": self.check,
            "verdict": self.verdict,
            "detail": self.detail,
            "path": self.path,
            "required": self.required,
        }


def _read_text(p: Path) -> tuple[str | None, str | None]:
    """读一个文本文件，返回 `(内容, 出错原因)`。

    **BOM 单独报**：`\\ufeff` 会跟在 `---` 前面，把 frontmatter 的第一行变成
    `﻿---`，于是解析器认为这个文件根本没有 frontmatter —— 文件看着好好的、
    肉眼一模一样，技能却加载不上。这正是本工具存在的理由那一类失败。
    """
    try:
        raw = p.read_bytes()
    except OSError as e:  # 权限、目录、坏链接
        return None, f"读不了：{e.__class__.__name__}"
    if raw.startswith(b"\xef\xbb\xbf"):
        return None, "文件带 UTF-8 BOM —— frontmatter 的 `---` 前面多了一个不可见字符"
    try:
        return raw.decode("utf-8"), None
    except UnicodeDecodeError:
        return None, "不是 UTF-8"


def parse_frontmatter(text: str) -> tuple[dict[str, str] | None, str | None]:
    """解析 SKILL.md 顶部的 YAML frontmatter。

    只认这份格式实际用到的那点子集：`key: value` 与 `key: >-` 折叠块。
    **故意不引入 PyYAML** —— 体检工具多一个第三方依赖，就多一种「它自己装不上
    所以没跑」的静默失效，而那恰恰是它要检查的东西。
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, "开头没有 `---` frontmatter"
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        return None, "frontmatter 没有收尾的 `---`"

    data: dict[str, str] = {}
    key: str | None = None
    folded: list[str] = []
    for line in lines[1:end]:
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if m and not line.startswith((" ", "\t")):
            if key is not None:
                data[key] = " ".join(folded).strip()
            key, rest = m.group(1), m.group(2).strip()
            folded = [] if rest in (">-", ">", "|", "|-", "") else [rest]
        elif key is not None:
            folded.append(line.strip())
    if key is not None:
        data[key] = " ".join(folded).strip()
    return data, None


def discover_skills(root: Path, where: Path) -> list[str]:
    """`where` 下面有 `SKILL.md` 的那些目录名（排序，便于两侧对比）。"""
    base = root / where
    if not base.is_dir():
        return []
    return sorted(d.name for d in base.iterdir() if (d / "SKILL.md").is_file())


# --- 维度 1：源文件读得到吗 ------------------------------------------------


def check_source(root: Path, skills: list[str]) -> list[Finding]:
    out: list[Finding] = []
    if not skills:
        # **零输入必须转红。** 「一个技能都没找到」和「所有技能都健康」在报告上
        # 长得太像了，而它们的含义正好相反。
        out.append(
            Finding(
                "source",
                "skills-present",
                FAIL,
                f"{CLAUDE_SKILLS.as_posix()} 下一个带 SKILL.md 的目录都没有 —— "
                "这不是「没问题」，是没东西可查",
                CLAUDE_SKILLS.as_posix(),
            )
        )
        return out

    for name in skills:
        rel = CLAUDE_SKILLS / name / "SKILL.md"
        text, err = _read_text(root / rel)
        if err:
            out.append(Finding("source", f"{name}/readable", FAIL, err, rel.as_posix()))
            continue
        fm, ferr = parse_frontmatter(text)
        if ferr:
            out.append(
                Finding("source", f"{name}/frontmatter", FAIL, ferr, rel.as_posix())
            )
            continue
        missing = [k for k in ("name", "description") if not fm.get(k)]
        if missing:
            out.append(
                Finding(
                    "source",
                    f"{name}/frontmatter",
                    FAIL,
                    f"frontmatter 缺 {'、'.join(missing)}",
                    rel.as_posix(),
                )
            )
        elif fm["name"] != name:
            # 目录名才是调用时用的那个词。对不上时，SKILL.md 里那个 name 是谎话。
            out.append(
                Finding(
                    "source",
                    f"{name}/frontmatter",
                    FAIL,
                    f"frontmatter 的 name 是 `{fm['name']}`，目录名却是 `{name}`",
                    rel.as_posix(),
                )
            )
        else:
            out.append(
                Finding(
                    "source",
                    f"{name}/frontmatter",
                    PASS,
                    "name / description 齐全"
                    f"（description {len(fm['description'])} 字）",
                    rel.as_posix(),
                )
            )
        out.extend(_check_links(root, name, rel, text))
    return out


def _check_links(root: Path, name: str, rel: Path, text: str) -> list[Finding]:
    """SKILL.md 里指出去的相对路径，文件真的在吗。

    技能正文靠 `[xxx](references/yyy.md)` 把细则分出去（渐进加载）。链接断了的
    表现不是报错，是 Agent 读到一句「细则见 references/yyy.md」然后什么也读不到 ——
    规则事实上没生效，而没有任何东西会喊。`tests/tooling/test_docs_links.py`
    管的是 `docs/`，管不到这里。
    """
    broken: list[str] = []
    seen: set[str] = set()
    for target in _LINK.findall(text):
        target = target.split("#", 1)[0].strip()
        if not target or _NOT_A_FILE.match(target) or target in seen:
            continue
        seen.add(target)
        resolved = (root / rel.parent / target).resolve()
        try:
            resolved.relative_to(root.resolve())
        except ValueError:
            # 指到仓库外面去了 —— 不判它在不在（可能是别人机器上的路径），
            # 只说这条不归本工具管。判不了的不判。
            continue
        if not resolved.exists():
            broken.append(target)
    if not seen:
        return [
            Finding(
                "source",
                f"{name}/references",
                NA,
                "这份 SKILL.md 没有指向仓库内文件的链接",
                rel.as_posix(),
                required=False,
            )
        ]
    if broken:
        return [
            Finding(
                "source",
                f"{name}/references",
                FAIL,
                f"{len(broken)} 条链接指向不存在的文件："
                + "、".join(sorted(broken)[:5]),
                rel.as_posix(),
            )
        ]
    return [
        Finding(
            "source",
            f"{name}/references",
            PASS,
            f"{len(seen)} 条仓库内链接全部指得着",
            rel.as_posix(),
        )
    ]


# --- 维度 2：两个客户端找到的是同一套吗 ------------------------------------


def check_discovery(root: Path, claude: list[str], codex: list[str]) -> list[Finding]:
    """把两侧的差异摆出来 —— 这是本切片的主交付（TASK-131 §4A 验收第一条）。"""
    out: list[Finding] = []
    cset, xset = set(claude), set(codex)

    out.append(
        Finding(
            "discovery",
            "claude/entries",
            PASS if claude else FAIL,
            (
                f"Claude 侧发现 {len(claude)} 个：{'、'.join(claude)}"
                if claude
                else f"{CLAUDE_SKILLS.as_posix()} 下没有技能"
            ),
            CLAUDE_SKILLS.as_posix(),
        )
    )

    if not (root / CODEX_SKILLS).exists():
        out.append(
            Finding(
                "discovery",
                "codex/entries",
                FAIL,
                f"{CODEX_SKILLS.as_posix()} 不存在 —— Codex 一个技能都发现不了；"
                f"Claude 侧那 {len(claude)} 个它全都看不见（TASK-131 切片 B 补这个）",
                CODEX_SKILLS.as_posix(),
            )
        )
        return out

    only_claude = sorted(cset - xset)
    only_codex = sorted(xset - cset)
    if only_claude or only_codex:
        bits = []
        if only_claude:
            bits.append(f"只有 Claude 找得到：{'、'.join(only_claude)}")
        if only_codex:
            bits.append(f"只有 Codex 找得到：{'、'.join(only_codex)}")
        out.append(
            Finding(
                "discovery",
                "codex/entries",
                FAIL,
                "两侧发现的不是同一套 —— " + "；".join(bits),
                CODEX_SKILLS.as_posix(),
            )
        )
    else:
        out.append(
            Finding(
                "discovery",
                "codex/entries",
                PASS,
                f"两侧都发现同样 {len(claude)} 个：{'、'.join(claude)}",
                CODEX_SKILLS.as_posix(),
            )
        )
    return out


# --- 维度 3：接线指得着吗 --------------------------------------------------

#: hook command 里可能出现的仓库变量。展开它才能判断目标文件在不在。
_PROJECT_VAR = re.compile(r"\$\{?CLAUDE_PROJECT_DIR\}?|%CLAUDE_PROJECT_DIR%")


def check_wiring(root: Path) -> list[Finding]:
    out: list[Finding] = []
    text, err = _read_text(root / SETTINGS)
    if err:
        out.append(
            Finding("wiring", "settings/readable", FAIL, err, SETTINGS.as_posix())
        )
        return out
    try:
        cfg = json.loads(text)
    except json.JSONDecodeError as e:
        out.append(
            Finding(
                "wiring",
                "settings/parse",
                FAIL,
                f"JSON 解析失败：第 {e.lineno} 行 {e.msg}",
                SETTINGS.as_posix(),
            )
        )
        return out
    if not isinstance(cfg, dict):
        out.append(
            Finding(
                "wiring", "settings/parse", FAIL, "顶层不是对象", SETTINGS.as_posix()
            )
        )
        return out

    hooks = cfg.get("hooks")
    if not isinstance(hooks, dict) or not hooks:
        # 没配 hook 是**合法状态**，不是缺陷 —— 但也不能报成 PASS，否则
        # 「配了且都指得着」和「压根没配」在报告上一样绿。
        out.append(
            Finding(
                "wiring",
                "hooks/declared",
                NA,
                "项目级 settings.json 没有配任何 hook",
                SETTINGS.as_posix(),
                required=False,
            )
        )
        return out

    n = 0
    for event, entries in sorted(hooks.items()):
        for entry in entries if isinstance(entries, list) else []:
            for hook in (entry or {}).get("hooks", []) or []:
                n += 1
                out.extend(_check_hook(root, event, hook, n))
    out.append(
        Finding(
            "wiring",
            "hooks/declared",
            PASS if n else NA,
            f"项目级配了 {n} 条 hook",
            SETTINGS.as_posix(),
            required=False,
        )
    )
    return out


def _check_hook(root: Path, event: str, hook: dict, n: int) -> list[Finding]:
    """一条 hook：解释器解析得到吗、目标脚本在不在。

    **只读不跑。** 这里刻意不执行 command —— 「这条命令能不能跑」这个问题不该
    靠在体检时把它跑一遍来回答（它可能有副作用，而体检承诺无副作用）。
    """
    label = f"{event}#{n}"
    if (hook or {}).get("type") != "command":
        return [
            Finding(
                "wiring",
                f"{label}/type",
                UNKNOWN,
                f"不是 command 型 hook（type={hook.get('type')!r}），本工具不解析它",
                required=False,
            )
        ]
    command = str(hook.get("command") or "").strip()
    if not command:
        return [Finding("wiring", f"{label}/command", FAIL, "command 是空的")]

    tokens = _split_command(command)
    if not tokens:
        return [
            Finding(
                "wiring",
                f"{label}/command",
                UNKNOWN,
                "命令拆不成词（引号不成对？），本工具不猜它的意思",
            )
        ]

    out: list[Finding] = []
    exe = tokens[0]
    resolved = shutil.which(exe)
    out.append(
        Finding(
            "wiring",
            f"{label}/interpreter",
            PASS if resolved else FAIL,
            (
                f"`{exe}` 在 PATH 上解析得到"
                if resolved
                # 路径本身不打印 —— 它可能带用户名。装没装是事实，装在哪不是。
                else f"`{exe}` 在 PATH 上解析不到 —— 这条 hook 触发时会直接失败"
            ),
        )
    )

    targets = [t for t in tokens[1:] if _PROJECT_VAR.search(t) or _looks_like_path(t)]
    if not targets:
        out.append(
            Finding(
                "wiring",
                f"{label}/target",
                UNKNOWN,
                "命令里看不出它指向仓库内的哪个文件，本工具不猜",
                required=False,
            )
        )
        return out
    for t in targets:
        rel = _PROJECT_VAR.sub("", t).lstrip("/\\").replace("\\", "/")
        target = root / rel
        out.append(
            Finding(
                "wiring",
                f"{label}/target",
                PASS if target.is_file() else FAIL,
                (f"目标在：{rel}" if target.is_file() else f"目标文件不存在：{rel}"),
                rel,
            )
        )
    return out


def _split_command(command: str) -> list[str] | None:
    """按 shell 词法拆命令。拆不开就返回 None（判不了的不判）。"""
    import shlex

    try:
        # POSIX 模式会把 Windows 路径里的反斜杠吃掉，所以关掉它，再自己剥引号。
        return [t.strip('"').strip("'") for t in shlex.split(command, posix=False)]
    except ValueError:
        return None


def _looks_like_path(token: str) -> bool:
    return ("/" in token or "\\" in token) and not token.startswith("-")


# --- 维度 4：它真的跑过吗 --------------------------------------------------


def check_evidence(root: Path, wiring: list[Finding]) -> list[Finding]:
    """有没有**观察到**这些接线真的触发过。

    今天的诚实答案是 UNKNOWN，理由要写清楚而不是含糊过去：仓库里没有任何东西
    记录「某条 hook 在某时被调用了」。看着像证据的那个 —— `.claude/hooks/`
    下的 `__pycache__` —— 靠不住：`tests/tooling/test_commit_gate_policy.py`
    import 同一个模块也会生成它，所以它证明的是「有进程 import 过这个模块」，
    不是「hook 被客户端触发过」。**拿这种东西当 PASS，就是本工具要消除的那种
    假绿。** 真事件证据是切片 C 的事（那时才谈得上写落地记录）。
    """
    wired = [f for f in wiring if f.check.endswith("/target") and f.verdict == PASS]
    if not wired:
        return [
            Finding(
                "evidence",
                "hooks/fired",
                NA,
                "没有指得着目标的 hook，谈不上「它跑过没有」",
                required=False,
            )
        ]
    return [
        Finding(
            "evidence",
            "hooks/fired",
            UNKNOWN,
            f"{len(wired)} 条 hook 接线是通的，"
            "但仓库里没有任何记录能证明它**被触发过** "
            "—— `__pycache__` 不算（测试 import 同一模块也会生成它）。"
            "真实事件证据由 TASK-131 切片 C 落地，在那之前这一格只能是 UNKNOWN",
        )
    ]


# --- 组装与输出 ------------------------------------------------------------


def run_doctor(root: Path) -> list[Finding]:
    claude = discover_skills(root, CLAUDE_SKILLS)
    codex = discover_skills(root, CODEX_SKILLS)
    findings = check_source(root, claude)
    findings += check_discovery(root, claude, codex)
    wiring = check_wiring(root)
    findings += wiring
    findings += check_evidence(root, wiring)
    return findings


def exit_code(findings: list[Finding], strict: bool) -> int:
    bad = {FAIL, UNKNOWN} if strict else {FAIL}
    return 1 if any(f.required and f.verdict in bad for f in findings) else 0


def render(findings: list[Finding], root: Path) -> str:
    lines = [f"开发工装体检 · {root}", ""]
    titles = {
        "source": "① 源文件      技能读得到、frontmatter 解析得开、引用都在",
        "discovery": "② 客户端发现  Claude 与 Codex 找到的是不是同一套",
        "wiring": "③ 接线        配的 hook，解释器与目标指得着吗",
        "evidence": "④ 真实证据    它到底跑过没有（没观察到就写 ?）",
    }
    for dim in DIMENSIONS:
        rows = [f for f in findings if f.dimension == dim]
        if not rows:
            continue
        lines.append(titles[dim])
        for f in rows:
            lines.append(f"   {MARK[f.verdict]} {f.check}: {f.detail}")
        lines.append("")
    tally = {v: sum(1 for f in findings if f.verdict == v) for v in MARK}
    lines.append(
        f"合计：{tally[PASS]} 通过 · {tally[FAIL]} 未通过 · "
        f"{tally[UNKNOWN]} 未知 · {tally[NA]} 不适用"
    )
    return "\n".join(lines)


def _utf8_stdout() -> None:
    """把 stdout/stderr 切到 UTF-8，否则这份报告在**日文/中文 Windows 控制台上
    自己就会崩**。

    实测：本机控制台码页是 cp932，`print()` 第一个中文字就抛 `UnicodeEncodeError`、
    退出码 1 —— 一个因为自己崩掉而报红的体检比没有体检更糟，它把「哪里坏了」
    变成噪音。`motv_doctor.py` 2026-08-31 栽过同一个坑（那次它还挂在提交闸门上，
    于是每个前端提交都被一个根本没跑完的体检挡住）。同一条纪律，同一种写法。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def main(argv: list[str] | None = None) -> int:
    _utf8_stdout()
    ap = argparse.ArgumentParser(
        prog="agent_harness.py", description="开发工装体检（只读）"
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    doc = sub.add_parser("doctor", help="体检一遍并报告")
    doc.add_argument(
        "--root",
        help="仓库根（默认由本脚本位置解析，可从任意子目录调用）",
    )
    doc.add_argument("--json", action="store_true", help="输出 JSON")
    doc.add_argument(
        "--strict", action="store_true", help="UNKNOWN 也算不过（退出码 1）"
    )
    args = ap.parse_args(argv)

    # 默认根由**脚本位置**解析，不是 cwd —— 从子目录调用时 cwd 会骗人。
    root = (
        Path(args.root).resolve() if args.root else Path(__file__).resolve().parents[2]
    )
    if not root.is_dir():
        print(f"根目录不存在：{root}", file=sys.stderr)
        return 2

    findings = run_doctor(root)
    code = exit_code(findings, args.strict)
    if args.json:
        print(
            json.dumps(
                {
                    "root": str(root),
                    "strict": args.strict,
                    "exit_code": code,
                    "findings": [f.as_dict() for f in findings],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(render(findings, root))
    return code


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""开发工装：技能读得到吗、两个客户端找到的是不是同一套、接线指得着吗、真跑过吗。

TASK-131 切片 A（`doctor`）与切片 B（`check` / `apply`）。要消除的是一类**静默
失效**：规则写了却没被加载、hook 配了却从没触发、技能只有 Claude 找得到而 Codex
找不到 —— 这三种失败都不报错，它们只是安静地什么也不做，然后下一个人对着一份
「明明配好了」的仓库 debug 半天。

`motv_doctor.py` 体检的是**真实创作项目**（他看得见什么、Agent 改得动什么），
那是产品合同。这一份管的是**开发工装自己**，两者不混（TASK-131 §2）。

三个子命令，只有一个会写盘::

    doctor   体检并报告                       **只读**
    check    薄入口同步了吗（不同步即非零）    **只读**
    apply    渲染薄入口                        **会写** .agents/skills/ 与台账

`doctor` 的四个维度，各回答一个问题::

  1. source     技能源文件读得到、frontmatter 解析得开、引用的文件都在吗
  2. discovery  Claude 侧和 Codex 侧**找到的是不是同一套**技能
  3. wiring     settings.json 里配的 hook，目标文件和解释器指得着吗
  4. evidence   它**真的跑过**吗 —— 拿不到证据就写 UNKNOWN，不写 PASS

用法::

    python .claude/tools/agent_harness.py doctor [--json] [--strict]
    python .claude/tools/agent_harness.py check  [--json]
    python .claude/tools/agent_harness.py apply  [--only NAME] [--prune]
    python .claude/tools/agent_harness.py doctor --root <fixture>   # 测试用

`doctor` 与 `check` **不写文件、不联网、不启动模型**，也**不执行**从配置里读到的
任何命令 —— 体检一个「这条命令是什么」的问题，不该靠把它跑一遍来回答。
`apply` 只写它自己台账（`.claude/agent-entries.json`）认得的入口：别人的同名文件、
被手改过的入口、链接目标一律**拒绝并报差异**，不覆盖（AGENTS.md 第 13 条 /
[ADR-0097](../../docs/adr/ADR-0097-one-skill-source-generated-client-entries.md)）。

判词四种：`PASS` / `FAIL` / `UNKNOWN` / `NOT_APPLICABLE`。
**没观察到就不许写 PASS**（TASK-131 §4A）—— 一个假的 ✓ 比一个诚实的 ? 危险得多，
这条纪律和 `motv_doctor` 是同一条。零输入同理：一个技能都没找到时必须转红，
不能因为「没有东西可查」而一路绿 —— 那正是 `motv_doctor` 2026-08-31 栽过的坑
（查错了地方的体检不会报错，只会一路绿）。

退出码：`doctor` 有 FAIL → 1（`--strict` 时 UNKNOWN 也算）；`check` 不同步 → 1；
`apply` 有拒绝 → 1；根目录无效或台账坏了 → 2。
"""

from __future__ import annotations

import argparse
import hashlib
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


# --- 接回来：上一轮做到哪了，哪一条还算数（TASK-131 切片 C） ----------------

#: 机械状态快照。**按任务隔离，放在 gitignore 掉的 `.claude/tmp/` 里**，
#: 因为它是一次性产物（ADR-0087 决策 6）。长期结论属于任务卡，不属于这里。
RESUME_DIR = Path(".claude") / "tmp" / "resume"

#: 快照里只放**机器能核对的东西**：tip、分支、跑过哪些验证、下一条可执行动作。
#: 刻意不放「进度百分比」「已完成」这类语义判断 —— 一个脚本写下的「done」会在
#: 下一次被当成事实读走，而它没有资格宣告任务完成（TASK-131 §4C）。
_RESUME_FIELDS = ("task", "branch", "tip", "verified", "next", "at")


def _git(root: Path, *args: str) -> str | None:
    """跑一条 git，失败就返回 None（不是空串 —— 两者含义不同）。"""
    import subprocess

    exe = shutil.which("git")
    if not exe:
        return None
    try:
        out = subprocess.run(  # noqa: S603 - 固定 argv，无 shell
            [exe, "-C", str(root), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def active_cards(root: Path) -> list[tuple[str, str]]:
    """`docs/tasks/active/` 里的卡：`(文件名, 状态行首句)`。

    **目录即状态**（ADR-0083）：在 `active/` 就是还没做完。这里不去猜「做到哪了」，
    只把卡摆出来 —— 猜出来的进度会被下一个人当成事实。
    """
    base = root / "docs" / "tasks" / "active"
    if not base.is_dir():
        return []
    out = []
    for p in sorted(base.glob("TASK-*.md")):
        text, err = _read_text(p)
        line = ""
        if not err:
            for raw in (text or "").splitlines():
                if raw.startswith("- 状态："):
                    line = raw[len("- 状态：") :].strip()
                    break
        out.append((p.name, line))
    return out


def read_snapshot(root: Path, task: str) -> dict | None:
    p = root / RESUME_DIR / f"{task}.json"
    if not p.is_file():
        return None
    text, err = _read_text(p)
    if err:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def write_snapshot(root: Path, task: str, verified: str, nxt: str) -> Path:
    import datetime

    p = root / RESUME_DIR / f"{task}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        json.dumps(
            {
                "task": task,
                "branch": _git(root, "rev-parse", "--abbrev-ref", "HEAD") or "",
                "tip": _git(root, "rev-parse", "HEAD") or "",
                "verified": verified,
                "next": nxt,
                "at": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return p


def run_resume(root: Path) -> dict:
    """接回来时先回答三件事：现在树是什么样、哪些卡还开着、上一轮那句验证还算数吗。

    **「还算数吗」是这一片存在的全部理由。** 把「上次测试 PASS」带到一棵内容已经
    变了的树上，是最省事也最危险的一种自欺 —— 它让人跳过验证却以为验过了。
    tip 一动，那条记录就只是历史，不是结论。
    """
    tip = _git(root, "rev-parse", "HEAD")
    dirty = _git(root, "status", "--porcelain")
    cards = active_cards(root)
    snaps = []
    for name, _line in cards:
        task = name.split("-")[0] + "-" + name.split("-")[1]
        snap = read_snapshot(root, task)
        if not snap:
            continue
        moved = bool(tip) and snap.get("tip") not in (None, "", tip)
        snaps.append(
            {
                **{k: snap.get(k, "") for k in _RESUME_FIELDS},
                "stale": moved,
                "why": (
                    "tip 变了 —— 这条验证记录只是历史，要重新评估"
                    if moved
                    else "tip 没变 —— 这条验证记录仍然对得上这棵树"
                ),
            }
        )
    return {
        "branch": _git(root, "rev-parse", "--abbrev-ref", "HEAD") or "(未知)",
        "tip": tip or "(未知)",
        "dirty": [ln for ln in (dirty or "").splitlines() if ln.strip()],
        "active_cards": [{"card": n, "status": s} for n, s in cards],
        "snapshots": snaps,
    }


def _porcelain_path(line: str) -> str:
    """`git status --porcelain` 一行里的路径部分（重命名取箭头右边的新名字）。"""
    body = line[2:].lstrip()
    return body.split(" -> ", 1)[-1].strip().strip('"')


def render_resume_brief(state: dict) -> str:
    """开工时那一小段。**没话说就一个字都不说。**

    这一段会进每个会话的上下文，所以它的成本是永久的、而收益只在「确实有事」时
    出现。干净的树 + 没有过期快照 = 沉默；有事才开口。

    要说的只有两件，都是**这一天真的发生过**的事：
    1. 工作树里有别人没提交的改动 —— 本会话 2026-09-05 差点覆盖掉同仓另一个
       会话正在写的补审修复，当时没有任何东西提醒（AGENTS §14/§16）。
    2. 某条「上次跑过什么」的记录所依据的 tip 已经变了 —— 那条记录只是历史。
    """
    dirty = state["dirty"]
    stale = [s for s in state["snapshots"] if s["stale"]]
    if not dirty and not stale:
        return ""
    lines = []
    if dirty:
        lines.append(
            f"⚠ 工作树有 {len(dirty)} 个未提交改动。**动手前先确认哪些不是你的**"
            "（AGENTS §14/§16：一个任务只能有一个实施 Agent）："
        )
        # porcelain 是 `XY<空格>PATH`，两列状态位固定宽度 —— 但**别写死切 3 个字符**：
        # 少切一个就把 `.claude/...` 显示成 `claude/...`，一个看起来只是难看、
        # 实际上指错了地方的路径（自测抓到）。
        lines.append("   " + "、".join(_porcelain_path(ln) for ln in dirty[:8]))
        if len(dirty) > 8:
            lines.append(f"   …… 还有 {len(dirty) - 8} 个（`git status`）")
    for s in stale:
        lines.append(
            f"⚠ {s['task']} 记着「跑过：{s['verified']}」，但那是在另一个 tip 上 —— "
            "**要重新评估，别把它当成这棵树的结论**"
        )
    lines.append("   细节：`python .claude/tools/agent_harness.py resume`")
    return "\n".join(lines)


def render_resume(state: dict) -> str:
    lines = [f"接回来 · {state['branch']} @ {state['tip'][:8]}", ""]
    dirty = state["dirty"]
    lines.append(f"未提交（{len(dirty)} 条）——**先确认哪些不是你的**（AGENTS §16）：")
    for ln in dirty[:20]:
        lines.append(f"   {ln}")
    if len(dirty) > 20:
        lines.append(f"   …… 还有 {len(dirty) - 20} 条")
    if not dirty:
        lines.append("   （干净）")
    lines.append("")
    lines.append("在办的卡（目录即状态，在这儿就是还没做完）：")
    for c in state["active_cards"]:
        lines.append(f"   · {c['card']}：{c['status'] or '（没有状态行）'}")
    lines.append("")
    if not state["snapshots"]:
        lines.append("没有机械状态快照 —— 目标与下一步只能从卡上读，别从这里猜。")
    for s in state["snapshots"]:
        mark = "⚠" if s["stale"] else "✓"
        lines.append(f"{mark} {s['task']}（记于 {s['at']}）")
        lines.append(f"   跑过：{s['verified'] or '（没写）'}")
        lines.append(f"   下一步：{s['next'] or '（没写）'}")
        lines.append(f"   {s['why']}")
    return "\n".join(lines)


# --- 薄入口：一份源，生成物单向渲染（ADR-0097） ----------------------------

#: 台账。谁生成的、从哪生成的、当时源长什么样 —— 只有它登记过的入口才归本工具管。
ENTRY_MANIFEST = Path(".claude") / "agent-entries.json"
#: 渲染器版本。入口模板变了就升号，`check` 因此会要求重渲染。
RENDERER = "agent_harness/1"

#: 算摘要时跳过的东西：它们是构建产物，按 Python 版本和平台变，
#: 算进去只会得到一个每台机器都不一样的「不同步」。
_DIGEST_SKIP = {"__pycache__", ".git"}
_DIGEST_SKIP_SUFFIX = {".pyc", ".pyo"}

_ENTRY_TEMPLATE = """---
name: {name}
description: >-
{description}
---

# {name}

**这是入口，不是实现。** 这个技能的规范源是仓库里的：

    {source}

**先完整读那份文件，再按它说的做。** 这里不复制它的正文、`references/` 或
`scripts/` —— 复制多少字，就是往后要对齐多少字（[ADR-0097]({adr}) 决策 1）。

<!-- 由 .claude/tools/agent_harness.py apply 生成，台账在 .claude/agent-entries.json。
     不要手改：手改会被 check 当场发现并拒绝覆盖，你的改动不会丢，但也不会生效。
     要改内容，改上面那份规范源。 -->
"""

#: 从 `.agents/skills/<name>/SKILL.md` 数回仓库根要**三层**，不是两层
#: （`<name>` → `skills` → `.agents` → 根）。第一版写成两层，链接指进
#: `.agents/docs/` —— 一个不存在的地方。`tests/tooling/test_docs_links.py`
#: 扫全仓库的 markdown，所以这种错会被抓到；这里留个数，免得下次再数错。
_ADR_REL = "../../../docs/adr/ADR-0097-one-skill-source-generated-client-entries.md"


def _normalise(raw: bytes) -> bytes:
    """文本归一行尾后再哈希，二进制原字节。

    ADR-0062：Windows 是权威环境、Ubuntu 是受支持目标，**同样的内容在两个平台上
    必须得到同一个摘要**。不归一的话，`core.autocrlf` 一开，CI 就会为了行尾报一个
    假的「不同步」，而假红和假绿一样会让人把检查关掉。
    """
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw
    return text.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")


def digest_tree(base: Path) -> str:
    """一个技能目录的内容摘要：**路径 + 内容**，全部文件，不只 SKILL.md。

    只哈希 SKILL.md 是不够的 —— 改了 `references/` 却没动正文时 `check` 会是绿的，
    而那恰恰是最容易漂的一种改动。`skill-evolution` 的 `_revision` 只哈希 SKILL.md，
    它回答的是别的问题；共用一个字段会让两边都说不清自己在保证什么（ADR-0097 决策 4）。
    """
    h = hashlib.sha256()
    for p in sorted(base.rglob("*"), key=lambda x: x.as_posix()):
        if any(part in _DIGEST_SKIP for part in p.relative_to(base).parts):
            continue
        if p.suffix.lower() in _DIGEST_SKIP_SUFFIX or not p.is_file():
            continue
        h.update(p.relative_to(base).as_posix().encode("utf-8"))
        h.update(b"\x00")
        h.update(_normalise(p.read_bytes()))
        h.update(b"\x00")
    return "sha256:" + h.hexdigest()


def digest_bytes(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(_normalise(raw)).hexdigest()


def render_entry(name: str, description: str, source_rel: str) -> str:
    """薄入口的正文。缩进的 description 保持 YAML 折叠块的形状。"""
    body = " ".join(description.split())
    wrapped = []
    line = ""
    for word in body.split(" "):
        if line and len(line) + 1 + len(word) > 76:
            wrapped.append("  " + line)
            line = word
        else:
            line = f"{line} {word}".strip()
    if line:
        wrapped.append("  " + line)
    return _ENTRY_TEMPLATE.format(
        name=name,
        description="\n".join(wrapped),
        source=source_rel,
        adr=_ADR_REL,
    )


def _escapes(root: Path, target: Path, allowed_parent: Path) -> bool:
    """`target` 是不是跑出了 `allowed_parent`（CA §5.5 的围栏）。

    三条，缺一条这道围栏就形同虚设 —— 前两条都是 codex 2026-09-05 审出来的 P1：

    1. **用 `is_relative_to` 判归属，不用字符串前缀。** `str(x).startswith(str(base))`
       会把 `.agents/skills-other` 判成 `.agents/skills` 的内部路径 —— 差一个连字符，
       围栏就在旁边开了个门（当场复现过）。
    2. **整条路径逐段查，不只看末端。** 中间某一段是 junction 时，末端文件自己
       既不是 symlink 也在「正确」的名义路径上；只查末端等于没查。
    3. **靠解析后的包含判断兜底 junction。** `Path.is_symlink()` 在 Windows 上对
       junction 返回 `False`（ADR-0049 记过，本仓库为它栽过一次），但 `.resolve()`
       会跟着它走出去 —— 于是「解析之后还在不在 base 里面」才是真正管用的那一条。

    `base` 一律拿 `root / allowed_parent` 算：`allowed_parent` 是相对路径，直接
    `.resolve()` 会按 **cwd** 解析。cwd 恰好等于仓库根时看不出错，从别处调用就会
    把每一个入口都判成越界（测试抓到过，真仓库里没暴露）。
    """
    try:
        root_real = root.resolve()
        rel = target.relative_to(root / allowed_parent)
    except (OSError, ValueError):
        return True
    # **锚点是仓库根，不是 `allowed_parent`。** 拿 `allowed_parent` 当锚点时，
    # 它自己就是那个 junction 的情况会反过来：`base.resolve()` 跟着链接走出去，
    # 于是外面成了「里面」，围栏对准了它本该拦住的地方（自测抓到）。
    # 逐段比「解析之后 == 它名义上该在的位置」，这样每一段自己是不是链接都不用问。
    cur = root
    for part in (*allowed_parent.parts, *rel.parts):
        cur = cur / part
        if cur.is_symlink():
            return True
        if not cur.exists():
            # 还没建出来的那几段无从解析 —— 它们会由本工具创建在已经查过的路径下面。
            break
        try:
            if cur.resolve() != root_real / cur.relative_to(root):
                return True
        except OSError:
            return True
    return False


def load_manifest(root: Path) -> tuple[dict, str | None]:
    p = root / ENTRY_MANIFEST
    if not p.is_file():
        return {"renderer": RENDERER, "entries": {}}, None
    text, err = _read_text(p)
    if err:
        return {"renderer": RENDERER, "entries": {}}, err
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        return {"renderer": RENDERER, "entries": {}}, f"台账 JSON 坏了：{e.msg}"
    if not isinstance(data, dict) or not isinstance(data.get("entries"), dict):
        return {"renderer": RENDERER, "entries": {}}, "台账形状不对"
    return data, None


class EntryPlan:
    """一个技能的入口该怎么办。`ok=False` 时 `apply` **不写**，只报差异。"""

    def __init__(self, name: str, action: str, reason: str, ok: bool = True) -> None:
        self.name = name
        self.action = action  # create / update / unchanged / refuse / orphan
        self.reason = reason
        self.ok = ok

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "action": self.action,
            "reason": self.reason,
            "ok": self.ok,
        }


def plan_entries(root: Path) -> tuple[list[EntryPlan], str | None]:
    """算出 `apply` 会做什么 —— `check` 就是「只算不做」。"""
    manifest, merr = load_manifest(root)
    if merr:
        return [], merr
    known = manifest.get("entries", {})
    plans: list[EntryPlan] = []

    sources = discover_skills(root, CLAUDE_SKILLS)
    for name in sources:
        src_dir = root / CLAUDE_SKILLS / name
        text, err = _read_text(src_dir / "SKILL.md")
        if err:
            plans.append(EntryPlan(name, "refuse", f"源读不了：{err}", ok=False))
            continue
        fm, ferr = parse_frontmatter(text)
        if ferr or not fm.get("description"):
            plans.append(
                EntryPlan(
                    name,
                    "refuse",
                    f"源的 frontmatter 用不了：{ferr or '缺 description'}",
                    ok=False,
                )
            )
            continue

        target = root / CODEX_SKILLS / name / "SKILL.md"
        if _escapes(root, target, CODEX_SKILLS):
            plans.append(
                EntryPlan(
                    name, "refuse", "入口位置是链接或跑出了 .agents/skills", ok=False
                )
            )
            continue

        want = render_entry(
            name, fm["description"], (CLAUDE_SKILLS / name / "SKILL.md").as_posix()
        )
        src_digest = digest_tree(src_dir)
        rec = known.get(name)

        if target.exists():
            got, gerr = _read_text(target)
            if gerr:
                plans.append(EntryPlan(name, "refuse", f"入口读不了：{gerr}", ok=False))
                continue
            if rec is None:
                # 别人的同名文件。不写、不删、不覆盖 —— 它不归本工具管。
                plans.append(
                    EntryPlan(
                        name, "refuse", "入口已存在但不在台账里（别人的文件）", ok=False
                    )
                )
                continue
            if digest_bytes(got.encode("utf-8")) != rec.get("entry_digest"):
                # 手改是信息，不是障碍：说出来，别悄悄盖掉（AGENTS.md 第 13 条）。
                plans.append(
                    EntryPlan(
                        name,
                        "refuse",
                        "入口被手改过 —— 不覆盖；要改请改规范源",
                        ok=False,
                    )
                )
                continue
            if (
                got == want
                and rec.get("source_digest") == src_digest
                and rec.get("renderer") == RENDERER
            ):
                plans.append(EntryPlan(name, "unchanged", "已同步"))
                continue
            plans.append(EntryPlan(name, "update", "源或渲染器变了，入口要重渲染"))
            continue
        plans.append(EntryPlan(name, "create", "还没有入口"))

    for name in sorted(set(known) - set(sources)):
        # 源没了，入口还在。删是不可逆的，所以在删之前要回答同一个问题：
        # **这份文件还是我生成的那份吗？** 上一版的 `--prune` 不问就 `unlink()` ——
        # 于是「源被删掉」这一个动作顺手把他手写在入口里的内容永久抹掉了
        # （codex 2026-09-05 P1）。ADR-0097 决策 3 对**写**已经定了「手改过就拒绝」，
        # 删比写更不可逆，没有理由更宽松（AGENTS.md 第 13 条 / CA §5.2 / §5.5）。
        #
        # 不做回收区：只有与本工具生成的一字不差时才删，而那种文件 Git 里就有一份，
        # 回收区是多余的第二套历史（ADR-0087 决策 6）。一旦不一样，它就不再是
        # 生成物 —— 那就不归本工具处置，交回给人。
        rec = known[name]
        stale = root / str(rec.get("entry") or "")
        if stale.exists() and _escapes(root, stale, CODEX_SKILLS):
            plans.append(
                EntryPlan(
                    name, "orphan", "孤儿入口位置越界 —— 一个字节都不碰", ok=False
                )
            )
            continue
        if stale.is_file():
            got, gerr = _read_text(stale)
            if gerr or digest_bytes((got or "").encode("utf-8")) != rec.get(
                "entry_digest"
            ):
                plans.append(
                    EntryPlan(
                        name,
                        "orphan",
                        "孤儿入口被手改过 —— `--prune` 也不删它，要删请自己删",
                        ok=False,
                    )
                )
                continue
        plans.append(EntryPlan(name, "orphan", "源没了，入口还在（`--prune` 才删）"))
    return plans, None


def write_entries(root: Path, plans: list[EntryPlan], prune: bool) -> list[str]:
    """真正落盘。**只写 plan 说可以写的**，一条都不多。"""
    manifest, _ = load_manifest(root)
    entries = dict(manifest.get("entries", {}))
    done: list[str] = []
    for plan in plans:
        if plan.action in ("create", "update"):
            src_dir = root / CLAUDE_SKILLS / plan.name
            text, _e = _read_text(src_dir / "SKILL.md")
            fm, _f = parse_frontmatter(text or "")
            body = render_entry(
                plan.name,
                (fm or {}).get("description", ""),
                (CLAUDE_SKILLS / plan.name / "SKILL.md").as_posix(),
            )
            target = root / CODEX_SKILLS / plan.name / "SKILL.md"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body, encoding="utf-8", newline="\n")
            entries[plan.name] = {
                "entry": (CODEX_SKILLS / plan.name / "SKILL.md").as_posix(),
                "source": (CLAUDE_SKILLS / plan.name).as_posix(),
                "renderer": RENDERER,
                "source_digest": digest_tree(src_dir),
                "entry_digest": digest_bytes(body.encode("utf-8")),
            }
            done.append(f"{plan.action} {plan.name}")
        elif plan.action == "orphan" and plan.ok and prune:
            # `plan.ok` 才走到这里 —— 手改过或越界的孤儿由 `plan_entries` 判成
            # 不可处置，这里一个字节都不动（见那边的注释）。
            rec = entries.pop(plan.name, None)
            if not rec:
                continue
            stale = root / rec["entry"]
            if stale.is_file():
                stale.unlink()
                parent = stale.parent
                if parent.is_dir() and not any(parent.iterdir()):
                    parent.rmdir()
            done.append(f"prune {plan.name}")
    if done:
        out = root / ENTRY_MANIFEST
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {"renderer": RENDERER, "entries": dict(sorted(entries.items()))},
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
            newline="\n",
        )
    return done


def entries_exit_code(plans: list[EntryPlan], applying: bool) -> int:
    """`check`：不同步就红。`apply`：只有**拒绝**才红（做完的不算红）。"""
    if not plans:
        return 1  # 零输入非零退出（ADR-0097 决策 5）
    if any(not p.ok for p in plans):
        return 1
    if applying:
        return 0
    return 1 if any(p.action != "unchanged" for p in plans) else 0


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


def _add_root(p: argparse.ArgumentParser) -> None:
    p.add_argument("--root", help="仓库根（默认由本脚本位置解析，可从任意子目录调用）")
    p.add_argument("--json", action="store_true", help="输出 JSON")


def main(argv: list[str] | None = None) -> int:
    _utf8_stdout()
    ap = argparse.ArgumentParser(
        prog="agent_harness.py", description="开发工装体检与 Codex 薄入口"
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    doc = sub.add_parser("doctor", help="体检一遍并报告（只读）")
    _add_root(doc)
    doc.add_argument(
        "--strict", action="store_true", help="UNKNOWN 也算不过（退出码 1）"
    )

    chk = sub.add_parser("check", help="薄入口同步了吗（只读，不同步即非零）")
    _add_root(chk)

    app = sub.add_parser("apply", help="渲染薄入口（**会写盘**，只写台账认得的）")
    _add_root(app)
    app.add_argument("--prune", action="store_true", help="源已删除的孤儿入口一并删掉")
    # 「先做一个原型证实客户端真的发现得了，再扩到其余的」（TASK-131 §4B）。
    # 一次生成五份没被验证过的入口，等于把一个未经证实的假设复制五遍。
    app.add_argument("--only", action="append", help="只渲染这个技能（可给多次）")

    res = sub.add_parser(
        "resume", help="接回来：树是什么样、哪些卡开着、哪条验证还算数"
    )
    _add_root(res)
    res.add_argument(
        "--brief", action="store_true", help="只在确实有事时开口（SessionStart 用）"
    )

    hnd = sub.add_parser(
        "handoff", help="交接/压缩前留一条机械状态快照（写 .claude/tmp/）"
    )
    _add_root(hnd)
    hnd.add_argument("--task", required=True, help="任务号，如 TASK-131")
    hnd.add_argument("--verified", default="", help="这一轮真的跑过什么")
    hnd.add_argument("--next", dest="nxt", default="", help="下一条**可执行**动作")

    args = ap.parse_args(argv)

    # 默认根由**脚本位置**解析，不是 cwd —— 从子目录调用时 cwd 会骗人。
    root = (
        Path(args.root).resolve() if args.root else Path(__file__).resolve().parents[2]
    )
    if not root.is_dir():
        print(f"根目录不存在：{root}", file=sys.stderr)
        return 2

    if args.cmd == "doctor":
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

    if args.cmd == "resume":
        state = run_resume(root)
        if args.json:
            print(json.dumps(state, ensure_ascii=False, indent=2))
        elif args.brief:
            text = render_resume_brief(state)
            if text:  # 没话说就一个字都不说 —— 这一段会进每个会话的上下文
                print(text)
        else:
            print(render_resume(state))
        # **恒为 0。** 「有未提交文件」「有卡开着」都是正常状态，不是失败；
        # 让接回来这一步能报红，等于给日常开工加了一道会被绕过去的闸。
        return 0

    if args.cmd == "handoff":
        p = write_snapshot(root, args.task, args.verified, args.nxt)
        print(f"记下了：{p.relative_to(root).as_posix()}")
        if not (args.verified and args.nxt):
            # 空的快照比没有快照更坏：它看起来像「有记录」。
            print("   ⚠ `--verified` / `--next` 有一个是空的 —— 空记录不如没有记录")
        return 0

    plans, err = plan_entries(root)
    if err:
        print(f"台账用不了：{err}", file=sys.stderr)
        return 2
    applying = args.cmd == "apply"
    only = set(getattr(args, "only", None) or [])
    if only:
        unknown = sorted(only - {p.name for p in plans})
        if unknown:
            print(f"没有这些技能：{'、'.join(unknown)}", file=sys.stderr)
            return 2
    writable = [p for p in plans if not only or p.name in only]
    done = (
        write_entries(root, writable, getattr(args, "prune", False)) if applying else []
    )
    if applying:
        # 写完重算一遍：报告的是**落盘之后**的状态，不是打算做的事。
        plans, err = plan_entries(root)
        if err:
            print(f"台账用不了：{err}", file=sys.stderr)
            return 2
    code = entries_exit_code(plans, applying)
    if args.json:
        print(
            json.dumps(
                {
                    "root": str(root),
                    "command": args.cmd,
                    "exit_code": code,
                    "written": done,
                    "plans": [p.as_dict() for p in plans],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        head = "薄入口 apply" if applying else "薄入口 check"
        print(f"{head} · {root}\n")
        if not plans:
            print("   ✗ 一个技能源都没有 —— 这不是「没问题」，是没东西可渲染")
        for p in plans:
            mark = (
                "✓" if p.ok and p.action == "unchanged" else ("✗" if not p.ok else "•")
            )
            print(f"   {mark} {p.name}: {p.action} —— {p.reason}")
        if done:
            print("\n写了：" + "、".join(done))
    return code


if __name__ == "__main__":
    raise SystemExit(main())

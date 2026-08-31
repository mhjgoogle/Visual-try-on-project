#!/usr/bin/env python3
"""对着**真实项目**体检一遍：Agent 看得见吗、改得动吗、能力读得到吗、执行器能跑吗。

产品负责人 2026-08-31 同意先做这一步。理由写在
`docs/design/active/proposal-one-surface-list.md`：2026-08-30 到 08-31 的六个缺陷
**全部是他在真实项目上撞到的**，而 2039 条前端测试全绿 —— 那些测试守的是**代码形状**，
不是「他打开会看到什么」。这件事该由机器做。

四项检查，各对应他撞到的一类：

  1. 目录完整   屏幕上有的东西，Agent 的事实里有没有   ←「我明明写了你怎么看不到」
  2. 写路径     每个声明过的写动作，指不指得到真地方   ←「写好了却还是空的」
  3. 能力输入   manifest 要的名字，解析得到数据吗       ←「还缺 创意 Brief」
  4. 执行器     真的跑得起来吗（降级要注明）           ←「本机没有可用的执行器」

用法::

    python .claude/tools/motv_doctor.py                    # 默认账户根目录
    python .claude/tools/motv_doctor.py --root D:/.../MotvProjects
    python .claude/tools/motv_doctor.py --json             # 给别的工具吃

**有一项红就以退出码 1 结束** —— 它可以当闸门用。判不了的不判（fail-closed 到
「未知」而不是「通过」）：一个假的 ✓ 比一个诚实的 ⚠ 危险得多。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MOCKUP = REPO / "mockups" / "motv-workspace"
SERVER = MOCKUP / "server.py"
SRC = MOCKUP / "src"
SKILLS = REPO / "product-skills" / "builtin"

OK, WARN, BAD = "OK", "WARN", "BAD"
MARK = {OK: "✓", WARN: "⚠", BAD: "✗"}


def projects_in(root: Path) -> list[tuple[str, Path, Path]]:
    """`root` 下面的项目（每个项目就是一个带 `studio/canvas.json` 的目录）。"""
    found = []
    if root.is_dir():
        for child in sorted(root.iterdir()):
            canvas = child / "studio" / "canvas.json"
            if canvas.is_file():
                found.append((child.name, child, canvas))
    return found


def root_candidates() -> list[Path]:
    """按**启动器实际用的那条规则**去找，不是按某个我以为的默认值。

    2026-08-31：体检默认看 `~/MotvProjects`，那里是空的，于是它报「0 个项目」
    就收工了 —— 挂在提交闸门上、绿着、**什么都没检查**。而 `studio.ps1` 的默认
    `-AssetRoot` 是**仓库的父目录**（第 167 行），他的项目一直在那儿。

    一个查错了地方的体检不会报错，只会一路绿 —— 那正是最坏的一种。
    """
    out = []
    env = os.environ.get("MOTV_ACCOUNT_ROOT")
    if env:
        out.append(Path(env))
    # `studio.ps1` 的默认：`$AssetRoot = Split-Path -Parent $root`
    out.append(REPO.parent)
    out.append(REPO.parent / "MotvProjects")
    out.append(Path.home() / "MotvProjects")
    seen, uniq = set(), []
    for r in out:
        key = str(r)
        if key not in seen:
            seen.add(key)
            uniq.append(r)
    return uniq


def default_root() -> tuple[Path, list[Path]]:
    """第一个**真的装着项目**的候选目录，外加找过的全部地方。"""
    cands = root_candidates()
    for r in cands:
        if projects_in(r):
            return r, cands
    return cands[0], cands


def load_server():
    spec = importlib.util.spec_from_file_location("motv_server_doctor", SERVER)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


# --- 1. 目录完整：屏幕上有的，事实里有没有 ---------------------------------- #


def _n(x) -> int:
    return len(x) if isinstance(x, (list, str)) else 0


def surfaces_of(doc: dict) -> list[dict]:
    """这个项目里**他写过东西的**那些面，以及各自拿什么去事实里找。

    只列**有内容**的：一个空的面在事实里不出现是正常的（那正是「还没写」）。
    """
    story = doc.get("story") or {}
    work = story.get("work") or {}
    prod = doc.get("production") or {}
    out = []

    core = (work.get("core") or "").strip()
    if core:
        out.append({"名字": "故事核心", "量": f"{len(core)} 字", "probe": core[-24:]})

    nodes = ((work.get("outline") or {}).get("nodes")) or []
    if nodes:
        last = str((nodes[-1] or {}).get("text") or "")[:24]
        out.append({"名字": "故事大纲", "量": f"{len(nodes)} 个节点", "probe": last})

    rows = [
        r
        for r in ((work.get("plan") or {}).get("rows") or [])
        if not (r or {}).get("hidden")
    ]
    if rows:
        probe = str((rows[-1] or {}).get("id") or "")
        out.append({"名字": "结构规划", "量": f"{len(rows)} 行", "probe": probe})

    units = [
        u for u in (work.get("units") or []) if str((u or {}).get("body") or "").strip()
    ]
    if units:
        probe = str(units[-1].get("body") or "")[:24]
        out.append({"名字": "正文", "量": f"{len(units)} 章/集有字", "probe": probe})

    fin = work.get("finalized") or {}
    n_fin = sum(_n(fin.get(k)) for k in ("core", "outline", "plan"))
    n_fin += sum(_n((u or {}).get("finalized")) for u in (work.get("units") or []))
    if n_fin:
        out.append({"名字": "定稿版本", "量": f"{n_fin} 版", "probe": "已定稿的版本"})

    chars = prod.get("characters") or []
    if chars:
        probe = str((chars[0] or {}).get("name") or "")
        out.append({"名字": "人物", "量": f"{len(chars)} 个", "probe": probe})

    locs = prod.get("locations") or []
    if locs:
        probe = str((locs[0] or {}).get("name") or "")
        out.append({"名字": "场景地", "量": f"{len(locs)} 个", "probe": probe})

    eps = prod.get("episodes") or []
    if eps:
        out.append(
            {"名字": "分集", "量": f"{len(eps)} 集", "probe": "生产文档里的分集"}
        )

    blocking = prod.get("blocking") or {}
    used = [k for k, v in blocking.items() if (v or {}).get("actors")]
    if used:
        out.append(
            {"名字": "白膜", "量": f"{len(used)} 镜", "probe": "白膜（3D 导演台"}
        )

    return out


def check_visible(srv, name: str, root: Path, doc: dict) -> list[dict]:
    app = srv._App(root.parent)
    app._projects[name] = root
    facts = app._conv_facts(name)
    rows = []
    for s in surfaces_of(doc):
        probe = s.get("probe")
        if not probe:
            state, why = WARN, "这一面还没有可查的探针 —— 体检说不了它在不在"
        elif probe in facts:
            state, why = OK, ""
        else:
            state, why = BAD, "屏幕上有，Agent 的事实里没有"
        rows.append({**s, "state": state, "why": why})
    return rows


# --- 2. 写路径：声明过的动作指不指得到真地方 -------------------------------- #


def check_write_paths() -> list[dict]:
    vocab = (SRC / "workflow" / "actions.js").read_text("utf-8")
    app = (SRC / "app.js").read_text("utf-8")
    declared = set(
        re.findall(r"^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*\{\s*args:", vocab, re.M)
    )
    handled = set(re.findall(r'case "([a-zA-Z][a-zA-Z0-9]*)":', app))
    # 「接了，但 return 的是『尚未接线』」—— 与根本没接一样糟，而且更难发现：
    # 它在每一处静态检查里都表现为「已实现」。
    # 「接了，但 return 的是『尚未接线』」—— 与根本没接一样糟，而且更难发现：
    # 它在每一处静态检查里都表现为「已实现」。
    stub_pattern = (
        r'case "([a-zA-Z0-9]+)":[^\n]*\n?\s*'
        r'return \{ ok: false, error: "[^"]*尚未接线'
    )
    stubs = set(re.findall(stub_pattern, app))

    rows = []
    missing = sorted(declared - handled)
    if missing:
        rows.append(
            {
                "名字": "声明了却没接",
                "量": f"{len(missing)} 个",
                "state": WARN,
                "why": "、".join(missing) + "（可能由门面实现，人工确认一次）",
            }
        )
    if stubs:
        rows.append(
            {
                "名字": "接了但明说「尚未接线」",
                "量": f"{len(stubs)} 个",
                "state": BAD,
                "why": "、".join(sorted(stubs))
                + " —— 能力会说「写好了」，点了什么都不发生",
            }
        )
    if not rows:
        rows.append(
            {"名字": "写路径", "量": f"{len(declared)} 个动作", "state": OK, "why": ""}
        )
    return rows


# --- 3. 能力输入：manifest 要的名字，解析得到数据吗 ------------------------- #


def check_skill_inputs() -> list[dict]:
    ctl = (SRC / "controllers" / "skillctl.js").read_text("utf-8")
    # 花括号配对着切，不能找第一个 `};` —— 这张表里有嵌套的箭头函数，
    # 第一个 `};` 在它们里面，于是后半张表被切掉，subtitles / shotAudio /
    # generations 全被报成「没有映射」。**第二次喊狼。**
    start = ctl.index("const available = {")
    depth, end = 0, start
    for i in range(start, len(ctl)):
        if ctl[i] == "{":
            depth += 1
        elif ctl[i] == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    block = ctl[start:end]
    # **两种写法都要数**：对象字面量里的 `shotContext: …`，以及后面按镜头范围补上的
    # `available.shotContext = …`。第一版只数了前者，于是九个镜头域的输入被报成
    # 「没有映射」—— 一个喊狼的体检没人会再看它，比没有体检更糟。
    # 三种写法都要数：`x: …`、简写的 `x,`、以及后面补的 `available.x = …`。
    # 前两次喊狼分别是漏了后两种 —— 体检自己写错，比没有体检更伤，
    # 因为它教人忽略红字。
    provided = set(re.findall(r"^\s+([a-zA-Z][a-zA-Z0-9]*):", block, re.M))
    provided |= set(re.findall(r"^\s+([a-zA-Z][a-zA-Z0-9]*),\s*$", block, re.M))
    provided |= set(re.findall(r"available\.([a-zA-Z][a-zA-Z0-9]*)\s*=", ctl))
    # 第四条路：**由调用方在 `extra` 里传进来**（`revisionRequest` 就是这样 ——
    # 他说的那句话本身就是「修订要求」）。只认真正建上下文的那两处文件，
    # 不去全仓库模糊匹配 —— 那会把不相干的同名属性也算成「有」。
    for extra_src in ("ui/production.js", "controllers/skillctl.js"):
        text = (SRC / extra_src).read_text("utf-8")
        # 认整行，不认「`extra:` 后面必须紧跟 `{`」—— 真实写法里它是个三元
        # （`extra: request ? { revisionRequest: request } : {}`）。第三次喊狼。
        for m in re.finditer(r"^\s*extra:\s*(.+)$", text, re.M):
            provided |= set(re.findall(r"([a-zA-Z][a-zA-Z0-9]*)\s*:", m.group(1)))

    wanted: dict[str, list[str]] = {}
    for man in sorted(SKILLS.glob("*/manifest.json")):
        try:
            m = json.loads(man.read_text("utf-8"))
        except ValueError:
            continue
        for key in list(m.get("inputs") or []) + list(m.get("optionalInputs") or []):
            wanted.setdefault(str(key), []).append(m.get("skillId") or man.parent.name)

    rows = []
    unmapped = sorted(k for k in wanted if k not in provided)
    if unmapped:
        for key in unmapped:
            rows.append(
                {
                    "名字": f"输入「{key}」",
                    "量": f"{len(wanted[key])} 个能力要它",
                    "state": BAD,
                    "why": "没有映射到任何数据 —— 那些能力会说「还缺 " + key + "」",
                }
            )
    else:
        rows.append(
            {
                "名字": "能力输入",
                "量": f"{len(wanted)} 个名字",
                "state": OK,
                "why": "全部解析得到",
            }
        )
    return rows


# --- 4. 执行器：真的跑得起来吗 ---------------------------------------------- #


def check_executors(srv) -> list[dict]:
    rows = []
    review_ok = False
    for name in ("claude-code", "codex-cli"):
        try:
            probe = srv._probe_executor(name)
        except Exception as exc:  # noqa: BLE001 - 体检不该因为一个探针炸掉整页
            rows.append(
                {"名字": name, "量": "探不到", "state": WARN, "why": str(exc)[:80]}
            )
            continue
        state = probe.get("state")
        good = state in ("ready", "installed")
        if name == "codex-cli" and good:
            review_ok = True
        rows.append(
            {
                "名字": name,
                "量": probe.get("version") or state,
                "state": OK if good else WARN,
                "why": "" if good else str(probe.get("detail") or "")[:90],
            }
        )
    if not review_ok:
        rows.append(
            {
                "名字": "复核（检查问题）",
                "量": "会退回 Claude Code",
                "state": WARN,
                "why": "独立性降级 —— 界面上必须注明（AGENTS.md 第 20 条）",
            }
        )
    return rows


# --- 报告 -------------------------------------------------------------------- #


def render(sections: list[tuple[str, list[dict]]]) -> str:
    out = []
    width = 0
    for _t, rows in sections:
        for r in rows:
            width = max(width, len(str(r.get("名字", ""))))
    for title, rows in sections:
        out.append(title)
        for r in rows:
            name = str(r.get("名字", "")).ljust(width)
            amount = str(r.get("量", "")).ljust(12)
            line = f"  {MARK[r['state']]} {name}  {amount}"
            if r.get("why"):
                line += f"  {r['why']}"
            out.append(line.rstrip())
        out.append("")
    return "\n".join(out)


def _utf8_stdout() -> None:
    """让输出别在日文/中文 Windows 上崩掉。

    这台机器的控制台代码页是 cp932，`⚠` 编不出去 —— 体检**自己**会抛
    `UnicodeEncodeError`、退出码非零。它现在挂在提交闸门上，那就等于
    **每一个前端提交都会被一个根本没检查完的体检挡住**（2026-08-31 实测）。

    一个会因为自己崩掉而报红的检查，比没有检查更糟：它把「哪里坏了」变成噪音。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def main() -> int:
    _utf8_stdout()
    ap = argparse.ArgumentParser(
        description="MOTV 体检：Agent 看得见 / 改得动 / 能力读得到 / 跑得起来"
    )
    ap.add_argument("--root", help="账户根目录（放项目的那个文件夹）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()

    looked: list[Path] = []
    if args.root:
        root = Path(args.root)
    else:
        root, looked = default_root()
    srv = load_server()

    sections: list[tuple[str, list[dict]]] = []
    worst = OK

    projects = projects_in(root)

    if not projects:
        # 找过哪些地方**要说出来**：不然「0 个项目」看着像「他还没建项目」，
        # 其实是「我查错了地方」—— 两件事的处置完全相反。
        where = "、".join(str(r) for r in looked) if looked else str(root)
        sections.append(
            (
                f"{root}",
                [
                    {
                        "名字": "项目",
                        "量": "0 个",
                        "state": WARN,
                        "why": f"没找到项目。找过：{where}",
                    }
                ],
            )
        )
        worst = WARN
    for name, child, canvas in projects:
        try:
            doc = json.loads(canvas.read_text("utf-8"))
        except ValueError as exc:
            sections.append(
                (
                    name,
                    [
                        {
                            "名字": "canvas.json",
                            "量": "读不了",
                            "state": BAD,
                            "why": str(exc)[:80],
                        }
                    ],
                )
            )
            worst = BAD
            continue
        rows = check_visible(srv, name, child, doc)
        if not rows:
            rows = [
                {
                    "名字": "内容",
                    "量": "空",
                    "state": WARN,
                    "why": "这个项目还什么都没写",
                }
            ]
        sections.append((f"{name}（Agent 看得见吗）", rows))

    sections.append(("写路径（改得动吗）", check_write_paths()))
    sections.append(("能力输入（读得到吗）", check_skill_inputs()))
    sections.append(("执行器（跑得起来吗）", check_executors(srv)))

    for _t, rows in sections:
        for r in rows:
            if r["state"] == BAD:
                worst = BAD
            elif r["state"] == WARN and worst != BAD:
                worst = WARN

    if args.json:
        print(
            json.dumps(
                {"worst": worst, "sections": sections}, ensure_ascii=False, indent=2
            )
        )
    else:
        print(render(sections))
        print(
            {
                OK: "全部通过。",
                WARN: "有需要看一眼的地方（⚠）。",
                BAD: "有红的（✗）—— 先修它。",
            }[worst]
        )
    return 1 if worst == BAD else 0


if __name__ == "__main__":
    raise SystemExit(main())

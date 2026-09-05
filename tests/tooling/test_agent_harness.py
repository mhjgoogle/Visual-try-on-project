"""开发工装体检（TASK-131 切片 A）必须**真的拦住**它声称要拦的东西。

本仓库反复吃过同一族亏：守卫看起来加了、其实没接上，于是它永远绿。所以每一条
检查这里都写**两个方向** —— 干净的 fixture 必须绿，只破坏那一处之后必须红。

还有两条纪律各有一个用例守着，它们比单条检查更要紧：

* **零输入不许全绿**（`test_an_empty_fixture_is_red_not_green`）。一个查错了地方
  的体检不会报错，只会一路绿 —— `motv_doctor` 2026-08-31 就是这么在提交闸门上
  绿着什么也没检查。
* **只读**（`test_the_doctor_writes_nothing`）。体检承诺无副作用；承诺要有东西
  兑现，否则它只是文档里的一句话。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_TOOL = _ROOT / ".claude" / "tools" / "agent_harness.py"

_SKILL = """---
name: {name}
description: >-
  一句话说明它是干什么的，够长到像真的。
---

# {name}

细则见 [references](references/detail.md)。
"""

_SETTINGS = {
    "hooks": {
        "PreToolUse": [
            {
                "matcher": "Bash",
                "hooks": [
                    {
                        "type": "command",
                        "command": (
                            'python "$CLAUDE_PROJECT_DIR'
                            '/.claude/hooks/gate_dispatch.py"'
                        ),
                        "timeout": 1000,
                    }
                ],
            }
        ]
    }
}


def _load():
    spec = importlib.util.spec_from_file_location("agent_harness", _TOOL)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def ah():
    return _load()


def _build(root: Path, names: tuple[str, ...] = ("dev-workflow", "auto-push")) -> Path:
    """一棵**最小合规**的假仓库：两侧技能一致、hook 目标在、解释器解析得到。"""
    for side in (Path(".claude") / "skills", Path(".agents") / "skills"):
        for name in names:
            d = root / side / name
            (d / "references").mkdir(parents=True)
            (d / "SKILL.md").write_text(_SKILL.format(name=name), encoding="utf-8")
            (d / "references" / "detail.md").write_text("细则", encoding="utf-8")
    hooks = root / ".claude" / "hooks"
    hooks.mkdir(parents=True, exist_ok=True)
    (hooks / "gate_dispatch.py").write_text("# gate\n", encoding="utf-8")
    (root / ".claude" / "settings.json").write_text(
        json.dumps(_SETTINGS, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return root


def _by(findings, check: str):
    hits = [f for f in findings if f.check == check]
    assert hits, f"没有名为 {check} 的检查：{sorted({f.check for f in findings})}"
    return hits[0]


def _verdicts(findings) -> dict[str, str]:
    return {f.check: f.verdict for f in findings}


# --- 干净的树必须绿 --------------------------------------------------------


def test_a_clean_fixture_has_no_failures(ah, tmp_path: Path) -> None:
    root = _build(tmp_path)
    findings = ah.run_doctor(root)
    bad = [f"{f.check}={f.verdict}" for f in findings if f.verdict == ah.FAIL]
    assert not bad, bad
    assert ah.exit_code(findings, strict=False) == 0
    assert _by(findings, "codex/entries").verdict == ah.PASS


def test_unknown_only_turns_red_under_strict(ah, tmp_path: Path) -> None:
    """真实事件证据今天拿不到 —— 它必须是 UNKNOWN，而 UNKNOWN 只在严格模式下转红。

    默认就把 UNKNOWN 当红，会逼着下一个人去把它改成一个假的 PASS，那正好走反。
    """
    root = _build(tmp_path)
    findings = ah.run_doctor(root)
    assert _by(findings, "hooks/fired").verdict == ah.UNKNOWN
    assert ah.exit_code(findings, strict=False) == 0
    assert ah.exit_code(findings, strict=True) == 1


# --- 零输入：不许因为「没东西可查」而全绿 ----------------------------------


def test_an_empty_fixture_is_red_not_green(ah, tmp_path: Path) -> None:
    findings = ah.run_doctor(tmp_path)
    assert _by(findings, "skills-present").verdict == ah.FAIL
    assert ah.exit_code(findings, strict=False) == 1


# --- 维度 1：源文件 --------------------------------------------------------


def test_a_bom_is_reported_as_its_own_cause(ah, tmp_path: Path) -> None:
    """BOM 要**单独报**，不能混成「没有 frontmatter」——那会把人引到错的地方去查。"""
    root = _build(tmp_path)
    p = root / ".claude" / "skills" / "auto-push" / "SKILL.md"
    p.write_bytes(b"\xef\xbb\xbf" + p.read_bytes())
    v = _by(ah.run_doctor(root), "auto-push/readable")
    assert v.verdict == ah.FAIL
    assert "BOM" in v.detail


def test_a_missing_frontmatter_key_is_red(ah, tmp_path: Path) -> None:
    root = _build(tmp_path)
    p = root / ".claude" / "skills" / "auto-push" / "SKILL.md"
    p.write_text("---\nname: auto-push\n---\n\n正文\n", encoding="utf-8")
    v = _by(ah.run_doctor(root), "auto-push/frontmatter")
    assert v.verdict == ah.FAIL
    assert "description" in v.detail


def test_a_name_that_disagrees_with_its_directory_is_red(ah, tmp_path: Path) -> None:
    """目录名才是调用时用的那个词；对不上时 SKILL.md 里那个 name 是谎话。"""
    root = _build(tmp_path)
    p = root / ".claude" / "skills" / "auto-push" / "SKILL.md"
    p.write_text(_SKILL.format(name="autopush"), encoding="utf-8")
    v = _by(ah.run_doctor(root), "auto-push/frontmatter")
    assert v.verdict == ah.FAIL
    assert "autopush" in v.detail


def test_a_broken_reference_link_is_red(ah, tmp_path: Path) -> None:
    """链接断了不会报错，只会让 Agent 读到一句「细则见 X」然后什么也读不到。"""
    root = _build(tmp_path)
    (root / ".claude" / "skills" / "auto-push" / "references" / "detail.md").unlink()
    v = _by(ah.run_doctor(root), "auto-push/references")
    assert v.verdict == ah.FAIL
    assert "detail.md" in v.detail


def test_links_pointing_outside_the_repo_are_not_judged(ah, tmp_path: Path) -> None:
    """判不了的不判：仓库外的路径可能只在别人机器上存在，不拿它当缺陷。"""
    root = _build(tmp_path)
    p = root / ".claude" / "skills" / "auto-push" / "SKILL.md"
    p.write_text(
        _SKILL.format(name="auto-push") + "\n[外面](../../../../nope.md)\n",
        encoding="utf-8",
    )
    assert _by(ah.run_doctor(root), "auto-push/references").verdict == ah.PASS


def test_a_url_is_not_treated_as_a_file(ah, tmp_path: Path) -> None:
    root = _build(tmp_path)
    p = root / ".claude" / "skills" / "auto-push" / "SKILL.md"
    p.write_text(
        _SKILL.format(name="auto-push") + "\n[官方](https://example.invalid/x.md)\n",
        encoding="utf-8",
    )
    assert _by(ah.run_doctor(root), "auto-push/references").verdict == ah.PASS


# --- 维度 2：两个客户端找到的是不是同一套 ----------------------------------


def test_a_skill_missing_on_the_codex_side_is_red(ah, tmp_path: Path) -> None:
    """这是本切片的主交付：把两侧的差异摆出来，并且**指名道姓**。"""
    root = _build(tmp_path)
    import shutil as _sh

    _sh.rmtree(root / ".agents" / "skills" / "auto-push")
    v = _by(ah.run_doctor(root), "codex/entries")
    assert v.verdict == ah.FAIL
    assert "auto-push" in v.detail


def test_no_codex_root_at_all_says_so_explicitly(ah, tmp_path: Path) -> None:
    root = _build(tmp_path)
    import shutil as _sh

    _sh.rmtree(root / ".agents")
    v = _by(ah.run_doctor(root), "codex/entries")
    assert v.verdict == ah.FAIL
    assert ".agents/skills" in v.detail


def test_a_skill_only_codex_has_is_also_a_difference(ah, tmp_path: Path) -> None:
    """差异是双向的。只报「Codex 少了什么」会漏掉一份没人维护的影子入口。"""
    root = _build(tmp_path)
    extra = root / ".agents" / "skills" / "ghost"
    extra.mkdir(parents=True)
    (extra / "SKILL.md").write_text(_SKILL.format(name="ghost"), encoding="utf-8")
    v = _by(ah.run_doctor(root), "codex/entries")
    assert v.verdict == ah.FAIL
    assert "ghost" in v.detail


# --- 维度 3：接线 ----------------------------------------------------------


def test_a_hook_target_that_does_not_exist_is_red(ah, tmp_path: Path) -> None:
    root = _build(tmp_path)
    (root / ".claude" / "hooks" / "gate_dispatch.py").unlink()
    assert _by(ah.run_doctor(root), "PreToolUse#1/target").verdict == ah.FAIL


def test_an_unresolvable_interpreter_is_red(ah, tmp_path: Path) -> None:
    root = _build(tmp_path)
    cfg = json.loads((root / ".claude" / "settings.json").read_text(encoding="utf-8"))
    cfg["hooks"]["PreToolUse"][0]["hooks"][0]["command"] = (
        'definitely-not-on-path "$CLAUDE_PROJECT_DIR/.claude/hooks/gate_dispatch.py"'
    )
    (root / ".claude" / "settings.json").write_text(
        json.dumps(cfg, ensure_ascii=False), encoding="utf-8"
    )
    v = _by(ah.run_doctor(root), "PreToolUse#1/interpreter")
    assert v.verdict == ah.FAIL
    # 解析不到时不许打印 PATH 或用户目录 —— 装没装是事实，装在哪不是。
    assert "definitely-not-on-path" in v.detail


def test_broken_settings_json_is_reported_as_a_parse_failure(
    ah, tmp_path: Path
) -> None:
    root = _build(tmp_path)
    (root / ".claude" / "settings.json").write_text("{ not json", encoding="utf-8")
    v = _by(ah.run_doctor(root), "settings/parse")
    assert v.verdict == ah.FAIL


def test_a_settings_file_with_a_bom_is_reported(ah, tmp_path: Path) -> None:
    root = _build(tmp_path)
    p = root / ".claude" / "settings.json"
    p.write_bytes(b"\xef\xbb\xbf" + p.read_bytes())
    v = _by(ah.run_doctor(root), "settings/readable")
    assert v.verdict == ah.FAIL
    assert "BOM" in v.detail


def test_no_hooks_is_not_applicable_rather_than_pass(ah, tmp_path: Path) -> None:
    """没配 hook 是合法状态，但也不能报 PASS —— 那会让「配了」和「压根没配」一样绿。"""
    root = _build(tmp_path)
    (root / ".claude" / "settings.json").write_text("{}", encoding="utf-8")
    findings = ah.run_doctor(root)
    assert _by(findings, "hooks/declared").verdict == ah.NA
    assert _by(findings, "hooks/fired").verdict == ah.NA
    assert ah.exit_code(findings, strict=True) == 0


def test_an_unparseable_command_is_unknown_not_pass(ah, tmp_path: Path) -> None:
    """判不了的不判，但也**绝不**因为判不了就放行成 PASS。"""
    root = _build(tmp_path)
    cfg = json.loads((root / ".claude" / "settings.json").read_text(encoding="utf-8"))
    cfg["hooks"]["PreToolUse"][0]["hooks"][0]["command"] = 'python "未闭合'
    (root / ".claude" / "settings.json").write_text(
        json.dumps(cfg, ensure_ascii=False), encoding="utf-8"
    )
    v = _by(ah.run_doctor(root), "PreToolUse#1/command")
    assert v.verdict == ah.UNKNOWN


# --- 维度 4：真实证据 ------------------------------------------------------


def test_pycache_is_never_accepted_as_proof_that_a_hook_fired(
    ah, tmp_path: Path
) -> None:
    """`__pycache__` 证明的是「有进程 import 过这个模块」，测试自己也会生成它。

    拿它当 PASS 就是本工具要消除的那种假绿，所以这里把它造出来，断言判词不动。
    """
    root = _build(tmp_path)
    cache = root / ".claude" / "hooks" / "__pycache__"
    cache.mkdir()
    (cache / "gate_dispatch.cpython-313.pyc").write_bytes(b"\x00" * 16)
    assert _by(ah.run_doctor(root), "hooks/fired").verdict == ah.UNKNOWN


# --- 无副作用与可移植性 ----------------------------------------------------


def _tree_digest(root: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        h.update(str(p.relative_to(root)).replace("\\", "/").encode("utf-8"))
        h.update(b"\x00" if p.is_dir() else p.read_bytes())
    return h.hexdigest()


def test_the_doctor_writes_nothing(ah, tmp_path: Path) -> None:
    root = _build(tmp_path)
    before = _tree_digest(root)
    ah.run_doctor(root)
    assert _tree_digest(root) == before, "体检承诺只读 —— 它动了 fixture"


def test_a_path_with_spaces_and_chinese_still_works(ah, tmp_path: Path) -> None:
    """AGENTS §3：平台中立。中文与空格路径在 Windows 上是常态，不是边缘情况。"""
    root = _build(tmp_path / "我的 项目 dir")
    findings = ah.run_doctor(root)
    assert not [f for f in findings if f.verdict == ah.FAIL]


def test_crlf_sources_parse_the_same_as_lf(ah, tmp_path: Path) -> None:
    """NTFS 上 CRLF 是常态。行尾不该改变任何一条判词。"""
    lf = _build(tmp_path / "lf")
    crlf = _build(tmp_path / "crlf")
    for p in (crlf / ".claude" / "skills").rglob("SKILL.md"):
        p.write_bytes(p.read_text(encoding="utf-8").replace("\n", "\r\n").encode())
    assert _verdicts(ah.run_doctor(lf)) == _verdicts(ah.run_doctor(crlf))


# --- 命令行：从子目录调用、退出码、JSON ------------------------------------


def _run(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    return subprocess.run(
        [sys.executable, str(_TOOL), *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        check=False,
    )


def test_it_runs_from_any_working_directory(tmp_path: Path) -> None:
    """根由**脚本位置**解析，不是 cwd —— 从子目录调用时 cwd 会骗人（AGENTS §3）。"""
    deep = _ROOT / "tests" / "tooling"
    out = _run(["doctor", "--json"], cwd=deep)
    payload = json.loads(out.stdout)
    assert Path(payload["root"]) == _ROOT


def test_json_output_carries_every_finding(tmp_path: Path) -> None:
    root = _build(tmp_path)
    out = _run(["doctor", "--root", str(root), "--json"], cwd=tmp_path)
    assert out.returncode == 0, out.stderr
    payload = json.loads(out.stdout)
    assert payload["exit_code"] == 0
    dims = {f["dimension"] for f in payload["findings"]}
    assert dims == {"source", "discovery", "wiring", "evidence"}
    for f in payload["findings"]:
        assert f["verdict"] in {"PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"}


def test_a_broken_fixture_exits_nonzero(tmp_path: Path) -> None:
    root = _build(tmp_path)
    (root / ".claude" / "hooks" / "gate_dispatch.py").unlink()
    out = _run(["doctor", "--root", str(root)], cwd=tmp_path)
    assert out.returncode == 1, out.stdout


def test_a_missing_root_is_an_error_not_a_green_run(tmp_path: Path) -> None:
    out = _run(["doctor", "--root", str(tmp_path / "nope")], cwd=tmp_path)
    assert out.returncode == 2


def test_the_report_survives_a_non_utf8_console(tmp_path: Path) -> None:
    """cp932 控制台上 `print()` 第一个中文字就会抛 —— 一个因为自己崩掉而报红的
    体检比没有体检更糟（`motv_doctor` 2026-08-31 实测）。"""
    root = _build(tmp_path)
    env = dict(os.environ, PYTHONIOENCODING="cp932")
    out = subprocess.run(
        [sys.executable, str(_TOOL), "doctor", "--root", str(root)],
        cwd=tmp_path,
        capture_output=True,
        env=env,
        check=False,
    )
    assert out.returncode == 0, out.stderr.decode("utf-8", "replace")
    assert b"Traceback" not in out.stderr


# --- 接到现实上的那根线 ----------------------------------------------------


def test_the_real_repository_is_described_honestly(ah) -> None:
    """真实仓库这一条不断言「全绿」—— 今天它本来就不是。

    `.agents/skills/` 还不存在（切片 B 才补），真实事件证据也还拿不到（切片 C）。
    这条守的是**别的东西**：源文件维度必须全绿（技能读得到、引用不断），而那两个
    已知缺口必须**以缺口的形状**出现，不能哪天被人悄悄改成 PASS 蒙混过去。
    """
    findings = ah.run_doctor(_ROOT)
    source = [f for f in findings if f.dimension == "source"]
    assert source, "真实仓库里一个技能都没发现 —— 那本身就是缺陷"
    bad = [f"{f.check}: {f.detail}" for f in source if f.verdict == ah.FAIL]
    assert not bad, bad
    assert _by(findings, "hooks/fired").verdict == ah.UNKNOWN

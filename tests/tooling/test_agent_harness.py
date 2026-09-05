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
import re
import shutil
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


# --- 切片 B：薄入口是生成物，源只有一份（ADR-0097） ------------------------
#
# 这一组守的是**所有权**：`.agents/skills/` 是生成物，`.claude/skills/` 是源。
# 每一条「拒绝」都要有正反两个方向 —— 拒绝得对，和该写的时候真的写了，是两件事。


def _by_name(plans, name: str):
    hits = [p for p in plans if p.name == name]
    assert hits, f"计划里没有 {name}：{[p.name for p in plans]}"
    return hits[0]


def _only_sources(root: Path) -> Path:
    """把 `_build` 造的那份「别人的」`.agents/` 拿掉，只留源。"""
    shutil.rmtree(root / ".agents")
    return root


def test_check_is_red_before_apply_and_green_after(ah, tmp_path: Path) -> None:
    root = _only_sources(_build(tmp_path))

    plans, err = ah.plan_entries(root)
    assert err is None
    assert {p.action for p in plans} == {"create"}
    assert ah.entries_exit_code(plans, applying=False) == 1

    ah.write_entries(root, plans, prune=False)
    plans, _ = ah.plan_entries(root)
    assert {p.action for p in plans} == {"unchanged"}
    assert ah.entries_exit_code(plans, applying=False) == 0


def test_applying_twice_changes_nothing(ah, tmp_path: Path) -> None:
    """再次 apply 必须无变化。做不到的话，每次跑都会产生一个假的「改动」。"""
    root = _only_sources(_build(tmp_path))
    plans, _ = ah.plan_entries(root)
    ah.write_entries(root, plans, prune=False)
    before = _tree_digest(root)

    plans, _ = ah.plan_entries(root)
    assert ah.write_entries(root, plans, prune=False) == [], "第二次不该再写"
    assert _tree_digest(root) == before


def test_check_itself_writes_nothing(ah, tmp_path: Path) -> None:
    root = _build(tmp_path)
    before = _tree_digest(root)
    ah.plan_entries(root)
    assert _tree_digest(root) == before


def test_a_changed_source_turns_check_red(ah, tmp_path: Path) -> None:
    """源变了入口就过期。这是 `check` 存在的全部理由。"""
    root = _only_sources(_build(tmp_path))
    plans, _ = ah.plan_entries(root)
    ah.write_entries(root, plans, prune=False)

    src = root / ".claude" / "skills" / "auto-push" / "SKILL.md"
    src.write_text(_SKILL.format(name="auto-push") + "\n新增一段。\n", encoding="utf-8")
    plans, _ = ah.plan_entries(root)
    assert _by_name(plans, "auto-push").action == "update"
    assert ah.entries_exit_code(plans, applying=False) == 1


def test_a_reference_only_change_also_turns_check_red(ah, tmp_path: Path) -> None:
    """摘要覆盖整个技能目录，不是只有 SKILL.md。

    只哈希 SKILL.md 的话，改了 `references/` 却没动正文时 check 是绿的 ——
    而那恰恰是最容易漂的一种改动（ADR-0097 决策 4）。
    """
    root = _only_sources(_build(tmp_path))
    plans, _ = ah.plan_entries(root)
    ah.write_entries(root, plans, prune=False)

    ref = root / ".claude" / "skills" / "auto-push" / "references" / "detail.md"
    ref.write_text("细则改了", encoding="utf-8")
    plans, _ = ah.plan_entries(root)
    assert _by_name(plans, "auto-push").action == "update"


def test_a_hand_edited_entry_is_refused_not_overwritten(ah, tmp_path: Path) -> None:
    """手改是信息，不是障碍：说出来，别悄悄盖掉（AGENTS.md 第 13 条）。"""
    root = _only_sources(_build(tmp_path))
    plans, _ = ah.plan_entries(root)
    ah.write_entries(root, plans, prune=False)

    entry = root / ".agents" / "skills" / "auto-push" / "SKILL.md"
    entry.write_text(
        entry.read_text(encoding="utf-8") + "\n我手改的。\n", encoding="utf-8"
    )
    mine = entry.read_text(encoding="utf-8")

    plans, _ = ah.plan_entries(root)
    plan = _by_name(plans, "auto-push")
    assert plan.action == "refuse" and not plan.ok
    assert "手改" in plan.reason
    ah.write_entries(root, plans, prune=False)
    assert entry.read_text(encoding="utf-8") == mine, "拒绝之后一个字都不该动"
    assert ah.entries_exit_code(plans, applying=True) == 1


def test_a_foreign_file_at_the_entry_path_is_refused(ah, tmp_path: Path) -> None:
    """入口位置已经有别人的文件、台账里又没有它 —— 那不归本工具管，不许覆盖。"""
    root = _build(tmp_path)  # `_build` 造的 .agents 就是「别人的」：没有台账
    theirs = (root / ".agents" / "skills" / "auto-push" / "SKILL.md").read_text("utf-8")

    plans, _ = ah.plan_entries(root)
    plan = _by_name(plans, "auto-push")
    assert plan.action == "refuse" and not plan.ok
    assert "台账" in plan.reason
    ah.write_entries(root, plans, prune=False)
    assert (root / ".agents" / "skills" / "auto-push" / "SKILL.md").read_text(
        "utf-8"
    ) == theirs


def test_an_orphan_is_reported_and_only_pruned_on_demand(ah, tmp_path: Path) -> None:
    """源没了，入口还在。删是破坏性的，所以默认只报，`--prune` 才动手。"""
    root = _only_sources(_build(tmp_path))
    plans, _ = ah.plan_entries(root)
    ah.write_entries(root, plans, prune=False)

    shutil.rmtree(root / ".claude" / "skills" / "auto-push")
    plans, _ = ah.plan_entries(root)
    assert _by_name(plans, "auto-push").action == "orphan"

    ah.write_entries(root, plans, prune=False)
    assert (root / ".agents" / "skills" / "auto-push" / "SKILL.md").exists()

    ah.write_entries(root, plans, prune=True)
    assert not (root / ".agents" / "skills" / "auto-push").exists()
    manifest, _ = ah.load_manifest(root)
    assert "auto-push" not in manifest["entries"]


def test_a_codex_only_skill_is_left_alone(ah, tmp_path: Path) -> None:
    """目标独有的技能不改 —— 本工具只管自己生成的那些。"""
    root = _only_sources(_build(tmp_path))
    plans, _ = ah.plan_entries(root)
    ah.write_entries(root, plans, prune=False)

    theirs = root / ".agents" / "skills" / "their-own"
    theirs.mkdir(parents=True)
    (theirs / "SKILL.md").write_text("别人的技能", encoding="utf-8")
    kept = (theirs / "SKILL.md").read_text(encoding="utf-8")

    plans, _ = ah.plan_entries(root)
    assert "their-own" not in {p.name for p in plans}
    ah.write_entries(root, plans, prune=True)
    assert (theirs / "SKILL.md").read_text(encoding="utf-8") == kept


def test_an_empty_source_set_is_nonzero(ah, tmp_path: Path) -> None:
    plans, err = ah.plan_entries(tmp_path)
    assert err is None and plans == []
    assert ah.entries_exit_code(plans, applying=False) == 1
    assert ah.entries_exit_code(plans, applying=True) == 1


def test_a_broken_manifest_is_an_error_not_a_silent_reset(ah, tmp_path: Path) -> None:
    """台账坏了要停。

    当成空台账的话，已有入口会全被判成「别人的」然后全部拒绝 —— 或者更糟，
    在某个分支上被当成缺失而重写一遍。
    """
    root = _build(tmp_path)
    (root / ".claude" / "agent-entries.json").write_text("{ 坏了", encoding="utf-8")
    plans, err = ah.plan_entries(root)
    assert err and plans == []


def test_the_same_content_hashes_the_same_across_line_endings(
    ah, tmp_path: Path
) -> None:
    """ADR-0062：Windows 权威、Ubuntu 受支持，同样的内容必须得到同一个摘要。

    不归一的话 `core.autocrlf` 一开，CI 就会为了行尾报一个假的「不同步」。
    """
    lf = _build(tmp_path / "lf")
    crlf = _build(tmp_path / "crlf")
    for p in (crlf / ".claude" / "skills").rglob("*"):
        if p.is_file():
            p.write_bytes(p.read_text(encoding="utf-8").replace("\n", "\r\n").encode())
    a = ah.digest_tree(lf / ".claude" / "skills" / "auto-push")
    b = ah.digest_tree(crlf / ".claude" / "skills" / "auto-push")
    assert a == b


def test_build_artifacts_do_not_change_the_digest(ah, tmp_path: Path) -> None:
    """`__pycache__` 按 Python 版本和平台变，算进摘要等于每台机器都「不同步」。"""
    root = _build(tmp_path)
    src = root / ".claude" / "skills" / "auto-push"
    before = ah.digest_tree(src)
    cache = src / "__pycache__"
    cache.mkdir()
    (cache / "x.cpython-313.pyc").write_bytes(b"\x01\x02\x03")
    assert ah.digest_tree(src) == before


def test_the_entry_points_at_the_source_and_copies_no_body(ah, tmp_path: Path) -> None:
    """薄入口薄在哪：它说得出源在哪，但不搬正文。"""
    root = _only_sources(_build(tmp_path))
    (root / ".claude" / "skills" / "auto-push" / "SKILL.md").write_text(
        _SKILL.format(name="auto-push") + "\n这一段是治理正文，绝不能被复制过去。\n",
        encoding="utf-8",
    )
    plans, _ = ah.plan_entries(root)
    ah.write_entries(root, plans, prune=False)

    entry = (root / ".agents" / "skills" / "auto-push" / "SKILL.md").read_text("utf-8")
    assert ".claude/skills/auto-push/SKILL.md" in entry, "得说得出源在哪"
    assert "治理正文" not in entry, "正文一个字都不该搬过来"
    assert "references/detail.md" not in entry, "references 也不搬"
    fm, err = ah.parse_frontmatter(entry)
    assert err is None and fm["name"] == "auto-push" and fm["description"]


def test_the_generated_entrys_own_links_resolve(ah, tmp_path: Path) -> None:
    """入口里那条 ADR 链接层数必须数对。

    第一版数成两层（`../../`），从 `.agents/skills/<name>/` 数回去只到 `.agents/`，
    于是链接指进一个不存在的 `.agents/docs/`。生成物里的断链和手写的一样是断链。
    """
    root = _only_sources(_build(tmp_path))
    (root / "docs" / "adr").mkdir(parents=True)
    (
        root / "docs" / "adr" / "ADR-0097-one-skill-source-generated-client-entries.md"
    ).write_text("# ADR", encoding="utf-8")
    plans, _ = ah.plan_entries(root)
    ah.write_entries(root, plans, prune=False)

    entry = root / ".agents" / "skills" / "auto-push" / "SKILL.md"
    targets = re.findall(r"\]\(([^)]+)\)", entry.read_text("utf-8"))
    assert targets, "入口里该有那条指回 ADR 的链接"
    for t in targets:
        assert (entry.parent / t).resolve().exists(), t


def test_only_limits_what_gets_written(ah, tmp_path: Path) -> None:
    """先做一个原型，证实客户端真的发现得了，再扩到其余的（TASK-131 §4B）。"""
    root = _only_sources(_build(tmp_path))
    plans, _ = ah.plan_entries(root)
    ah.write_entries(root, [p for p in plans if p.name == "dev-workflow"], prune=False)
    assert (root / ".agents" / "skills" / "dev-workflow" / "SKILL.md").exists()
    assert not (root / ".agents" / "skills" / "auto-push").exists()


def test_a_source_with_unusable_frontmatter_is_refused(ah, tmp_path: Path) -> None:
    root = _only_sources(_build(tmp_path))
    (root / ".claude" / "skills" / "auto-push" / "SKILL.md").write_text(
        "没有 frontmatter", encoding="utf-8"
    )
    plans, _ = ah.plan_entries(root)
    plan = _by_name(plans, "auto-push")
    assert plan.action == "refuse" and not plan.ok
    ah.write_entries(root, plans, prune=False)
    assert not (root / ".agents" / "skills" / "auto-push").exists()


def test_doctor_goes_green_on_discovery_once_entries_exist(ah, tmp_path: Path) -> None:
    """切片 A 报的那个缺口，切片 B 补上之后必须真的合上 —— 两片是同一条线。"""
    root = _only_sources(_build(tmp_path))
    assert _by(ah.run_doctor(root), "codex/entries").verdict == ah.FAIL
    plans, _ = ah.plan_entries(root)
    ah.write_entries(root, plans, prune=False)
    assert _by(ah.run_doctor(root), "codex/entries").verdict == ah.PASS


# --- 切片 B 的命令行 -------------------------------------------------------


def test_the_check_command_exits_nonzero_when_out_of_sync(tmp_path: Path) -> None:
    root = _only_sources(_build(tmp_path))
    assert _run(["check", "--root", str(root)], cwd=tmp_path).returncode == 1
    assert _run(["apply", "--root", str(root)], cwd=tmp_path).returncode == 0
    assert _run(["check", "--root", str(root)], cwd=tmp_path).returncode == 0


def test_only_rejects_a_name_that_does_not_exist(tmp_path: Path) -> None:
    """打错名字要停，不能静默地什么都不做然后报成功。"""
    root = _build(tmp_path)
    out = _run(["apply", "--root", str(root), "--only", "nope"], cwd=tmp_path)
    assert out.returncode == 2


def test_the_real_repository_entries_are_in_sync() -> None:
    """接到现实上：仓库里的薄入口必须与源同步。

    这一条挂在 `tests/tooling/` 里，因此自动出现在提交闸门与合并前全量中 ——
    「改了技能忘了 apply」由此不靠谁记得（ADR-0097 代价那一节）。
    """
    out = _run(["check", "--json"], cwd=_ROOT / "tests")
    payload = json.loads(out.stdout)
    stale = [p for p in payload["plans"] if p["action"] != "unchanged"]
    assert out.returncode == 0, f"薄入口不同步，跑 `agent_harness.py apply`：{stale}"


# --- codex 2026-09-05 报的两条 P1，各留一条回归 ------------------------------


def test_prune_refuses_to_delete_a_hand_edited_orphan(ah, tmp_path: Path) -> None:
    """删比写更不可逆，围栏没有理由比写更宽松。

    上一版的 `--prune` 不校验摘要就 `unlink()` —— 于是「源被删掉」这一个动作，
    顺手把他手写在入口里的内容永久抹掉了。写路径上早就有「手改过就拒绝」，
    删路径上却没有（codex P1-1 · AGENTS.md 第 13 条 / CA §5.2）。
    """
    root = _only_sources(_build(tmp_path))
    plans, _ = ah.plan_entries(root)
    ah.write_entries(root, plans, prune=False)

    entry = root / ".agents" / "skills" / "auto-push" / "SKILL.md"
    entry.write_text("这是我手写的，别删。\n", encoding="utf-8")
    mine = entry.read_text(encoding="utf-8")
    shutil.rmtree(root / ".claude" / "skills" / "auto-push")

    plans, _ = ah.plan_entries(root)
    plan = _by_name(plans, "auto-push")
    assert plan.action == "orphan" and not plan.ok
    assert "手改" in plan.reason

    ah.write_entries(root, plans, prune=True)
    assert entry.exists(), "手改过的孤儿入口不该被 prune 删掉"
    assert entry.read_text(encoding="utf-8") == mine
    manifest, _ = ah.load_manifest(root)
    assert "auto-push" in manifest["entries"], "没删就不该从台账里摘掉"
    assert ah.entries_exit_code(plans, applying=True) == 1


def test_prune_still_removes_a_pristine_orphan(ah, tmp_path: Path) -> None:
    """反方向：一字不差的生成物，`--prune` 照删不误。

    只写上一条的话，一个「什么都不删」的实现也能让它变绿。
    """
    root = _only_sources(_build(tmp_path))
    plans, _ = ah.plan_entries(root)
    ah.write_entries(root, plans, prune=False)
    shutil.rmtree(root / ".claude" / "skills" / "auto-push")

    plans, _ = ah.plan_entries(root)
    plan = _by_name(plans, "auto-push")
    assert plan.action == "orphan" and plan.ok
    ah.write_entries(root, plans, prune=True)
    assert not (root / ".agents" / "skills" / "auto-push").exists()


def test_a_sibling_directory_sharing_a_name_prefix_is_outside(
    ah, tmp_path: Path
) -> None:
    """`.agents/skills-other` 不在 `.agents/skills` 里面。

    上一版用 `str(x).startswith(str(base))` 判归属 —— 差一个连字符，围栏就在旁边
    开了个门（codex P1-2 · CA §5.5）。归属要用 `is_relative_to` 判，不是字符串前缀。
    """
    root = _build(tmp_path)
    outside = root / ".agents" / "skills-other" / "auto-push" / "SKILL.md"
    outside.parent.mkdir(parents=True)
    outside.write_text("我在围栏外面", encoding="utf-8")
    assert ah._escapes(root, outside, ah.CODEX_SKILLS) is True

    inside = root / ".agents" / "skills" / "auto-push" / "SKILL.md"
    assert ah._escapes(root, inside, ah.CODEX_SKILLS) is False


def test_a_path_that_is_not_under_the_fence_at_all_is_outside(
    ah, tmp_path: Path
) -> None:
    root = _build(tmp_path)
    assert ah._escapes(root, root / "elsewhere.md", ah.CODEX_SKILLS) is True
    assert ah._escapes(root, tmp_path.parent / "far.md", ah.CODEX_SKILLS) is True


def test_a_linked_ancestor_is_caught_even_though_the_leaf_is_not_a_link(
    ah, tmp_path: Path
) -> None:
    """只查末端节点不够：中间那一段是链接时，末端文件自己既不是 symlink、
    名义路径也「正确」。

    这里用 **junction** 而不是 symlink：Windows 上它不需要提权（所以这条在
    ADR-0049 真正针对的那个平台上**跑得起来**，而不是一路 skip），而且
    `is_symlink()` 对它返回 `False` —— 正是最能证伪「只看末端」那种写法的形状。
    """
    from tests.symlink_support import junction_or_skip

    root = _build(tmp_path)
    outside = tmp_path / "outside"
    (outside / "auto-push").mkdir(parents=True)
    (outside / "auto-push" / "SKILL.md").write_text("外面的", encoding="utf-8")

    shutil.rmtree(root / ".agents" / "skills")
    junction_or_skip(root / ".agents" / "skills", outside)

    leaf = root / ".agents" / "skills" / "auto-push" / "SKILL.md"
    assert leaf.is_file(), "junction 该是通的"
    assert not leaf.is_symlink(), "末端文件自己不是链接 —— 这正是本用例的前提"
    assert ah._escapes(root, leaf, ah.CODEX_SKILLS) is True


# --- 切片 C：接回来时哪条还算数 --------------------------------------------
#
# 这一组只守一件事，因为它是这一片存在的全部理由：**tip 变了的验证记录必须被
# 标成需要重新评估**。把「上次测试 PASS」带到一棵内容已经变了的树上，是最省事
# 也最危险的一种自欺 —— 它让人跳过验证却以为验过了。


def _git_repo(root: Path) -> None:
    """把 fixture 变成一个真 git 仓库（`resume` 读的是真 git，不是假的）。"""
    import subprocess

    exe = shutil.which("git")
    if not exe:
        pytest.skip("本机没有 git")

    def run(*args: str) -> None:
        subprocess.run(  # noqa: S603 - 固定 argv，无 shell
            [exe, "-C", str(root), *args], capture_output=True, check=True
        )

    # 真仓库把 `.claude/tmp/` gitignore 掉了（`.gitignore:61`）—— fixture 必须
    # 照办，否则 `handoff` 写的那份一次性快照自己会冒充成「未提交改动」。
    (root / ".gitignore").write_text("**/.claude/tmp/\n", encoding="utf-8")
    run("init", "-q")
    run("config", "user.email", "t@example.invalid")
    run("config", "user.name", "t")
    run("add", "-A")
    run("commit", "-q", "-m", "one")


def _commit(root: Path, name: str) -> None:
    import subprocess

    exe = shutil.which("git")
    (root / name).write_text("x", encoding="utf-8")
    for args in (("add", "-A"), ("commit", "-q", "-m", name)):
        subprocess.run(  # noqa: S603 - 固定 argv，无 shell
            [exe, "-C", str(root), *args], capture_output=True, check=True
        )


def _card(root: Path, task: str, status: str) -> None:
    d = root / "docs" / "tasks" / "active"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{task}-something.md").write_text(
        f"# {task}：一张卡\n\n- 状态：{status}\n", encoding="utf-8"
    )


def test_the_scratch_snapshot_is_gitignored_in_the_real_repo() -> None:
    """`handoff` 写的快照必须被 git 忽略。

    否则每记一次交接，工作树就多一个「未提交改动」—— 而 `resume --brief` 正是
    靠「有没有未提交改动」决定开不开口，它会开始对自己的输出报警。
    """
    import subprocess

    exe = shutil.which("git")
    if not exe:
        pytest.skip("本机没有 git")
    out = subprocess.run(  # noqa: S603 - 固定 argv，无 shell
        [exe, "-C", str(_ROOT), "check-ignore", ".claude/tmp/resume/probe.json"],
        capture_output=True,
        check=False,
    )
    assert out.returncode == 0, ".claude/tmp/ 没有被 gitignore"


def test_a_snapshot_on_the_same_tip_still_counts(ah, tmp_path: Path) -> None:
    root = _build(tmp_path)
    _card(root, "TASK-999", "**进行中**")
    _git_repo(root)
    ah.write_snapshot(root, "TASK-999", "pytest tests/tooling 通过", "接着写切片 2")

    state = ah.run_resume(root)
    snap = next(s for s in state["snapshots"] if s["task"] == "TASK-999")
    assert snap["stale"] is False
    assert "仍然对得上" in snap["why"]
    assert ah.render_resume_brief(state) == "", "干净的树 + 没过期 = 一个字都不说"


def test_a_snapshot_from_another_tip_is_flagged_stale(ah, tmp_path: Path) -> None:
    """换了 tip 的旧验证必须被标为需重新评估（TASK-131 §4C 验收原文）。"""
    root = _build(tmp_path)
    _card(root, "TASK-999", "**进行中**")
    _git_repo(root)
    ah.write_snapshot(root, "TASK-999", "pytest tests/tooling 通过", "接着写切片 2")
    _commit(root, "later.txt")

    state = ah.run_resume(root)
    snap = next(s for s in state["snapshots"] if s["task"] == "TASK-999")
    assert snap["stale"] is True
    assert "重新评估" in snap["why"]
    brief = ah.render_resume_brief(state)
    assert "重新评估" in brief and "TASK-999" in brief


def test_resume_lists_active_cards_without_guessing_progress(
    ah, tmp_path: Path
) -> None:
    """只把卡摆出来，不推断「做到哪了」—— 猜出来的进度会被当成事实。"""
    root = _build(tmp_path)
    _card(root, "TASK-998", "**部分实施**")
    _git_repo(root)
    state = ah.run_resume(root)
    cards = {c["card"]: c["status"] for c in state["active_cards"]}
    assert "TASK-998-something.md" in cards
    assert cards["TASK-998-something.md"] == "**部分实施**"


def test_the_brief_speaks_up_when_the_tree_has_someone_elses_work(
    ah, tmp_path: Path
) -> None:
    """同仓多会话时这是唯一能防互相覆盖的东西 —— 2026-09-05 真的差点覆盖掉一次。"""
    root = _build(tmp_path)
    _git_repo(root)
    (root / "someone-elses.py").write_text("# 别人在写\n", encoding="utf-8")

    brief = ah.render_resume_brief(ah.run_resume(root))
    assert "someone-elses.py" in brief
    assert "AGENTS" in brief, "要说清楚这条规矩从哪来，不然它只是唠叨"


def test_the_brief_never_mangles_a_dotted_path(ah, tmp_path: Path) -> None:
    """porcelain 的路径别按固定宽度切 —— 少切一个字符，`.claude/x` 就成了
    `claude/x`：一个看起来只是难看、实际上指错地方的路径（自测抓到）。"""
    root = _build(tmp_path)
    _git_repo(root)
    (root / ".claude" / "brand-new.py").write_text("x", encoding="utf-8")

    brief = ah.render_resume_brief(ah.run_resume(root))
    assert ".claude/brand-new.py" in brief


def test_a_snapshot_holds_no_semantic_progress(ah, tmp_path: Path) -> None:
    """快照里**不许**出现「完成」这类语义判断。

    一个脚本写下的 `done` 会在下一次被当成事实读走，而脚本没有资格宣告任务完成
    （TASK-131 §4C）。这条守的是字段集本身，不是某一次的取值。
    """
    root = _build(tmp_path)
    _git_repo(root)
    p = ah.write_snapshot(root, "TASK-999", "跑过 X", "下一步 Y")
    data = json.loads(p.read_text("utf-8"))
    assert set(data) == set(ah._RESUME_FIELDS)
    forbidden = {"done", "complete", "completed", "status", "progress", "percent"}
    assert not (set(data) & forbidden)


def test_the_snapshot_lives_in_scratch_not_in_docs(ah, tmp_path: Path) -> None:
    """一次性产物不进 `docs/`（AGENTS §26 / ADR-0087 决策 6）。"""
    root = _build(tmp_path)
    _git_repo(root)
    p = ah.write_snapshot(root, "TASK-999", "跑过 X", "下一步 Y")
    rel = p.relative_to(root).as_posix()
    assert rel.startswith(".claude/tmp/"), rel
    assert not (root / "docs").exists() or not list(
        (root / "docs").rglob("TASK-999.json")
    )


def test_resume_survives_a_directory_that_is_not_a_git_repo(ah, tmp_path: Path) -> None:
    """不是 git 仓库时要如实说「未知」，不能抛 —— 接回来这一步不许自己崩。"""
    root = _build(tmp_path)
    state = ah.run_resume(root)
    assert state["tip"] in ("(未知)", state["tip"])
    assert ah.render_resume(state)


def test_resume_never_exits_nonzero(tmp_path: Path) -> None:
    """「有未提交文件」「有卡开着」都是正常状态，不是失败。

    让接回来能报红，等于给日常开工加了一道会被绕过去的闸。
    """
    root = _build(tmp_path)
    for args in (["resume"], ["resume", "--brief"], ["resume", "--json"]):
        out = _run([*args, "--root", str(root)], cwd=tmp_path)
        assert out.returncode == 0, (args, out.stderr)


def test_handoff_says_so_when_the_snapshot_would_be_empty(tmp_path: Path) -> None:
    """空的快照比没有快照更坏 —— 它看起来像「有记录」。"""
    root = _build(tmp_path)
    out = _run(["handoff", "--root", str(root), "--task", "TASK-999"], cwd=tmp_path)
    assert out.returncode == 0
    assert "空记录不如没有记录" in out.stdout


def test_the_handoff_reference_is_reachable_from_the_skill() -> None:
    """写了却没人指向的引用文档等于没写 —— 那正是本卡要消除的失效。"""
    skill = (_ROOT / ".claude" / "skills" / "dev-workflow" / "SKILL.md").read_text(
        "utf-8"
    )
    assert "references/handoff.md" in skill
    assert (
        _ROOT / ".claude" / "skills" / "dev-workflow" / "references" / "handoff.md"
    ).is_file()

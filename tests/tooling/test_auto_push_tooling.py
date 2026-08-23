"""auto-push 确定性 CLI 的行为合同（TASK-101 / ADR-0079）。

覆盖需求原文第 39 节的可脚本化场景：A（单 Task 全流程 stage→commit→push→
回写）、B（无关 Task 的 diff 不被带走）、C（混合文件按 hunk 只 stage 当前
Task）、D（无法区分即拒绝并交回）、E（验证 FAIL 不 commit 不 push）、
F（remote ahead 安全 sync 后再 push）、G（疑似 secret 阻止）、H（宽 diff
守卫）、I（一个 Change 三个 Task 三个 commit）、J（Merge Gate 非 PASS 不
merge）、K（PASS 后 sync→merge→push main→cleanup）、L（文本冲突如实交回）、
N（merge 未上远端不删分支）。M（semantic conflict 归 dev-workflow）是语义
规则，住在 SKILL.md，不在脚本层。

真实仓库里 `git commit` 由 agent 在 shell 执行（让 commit gate 拦截）；
这里的临时仓库没有 hook，直接跑 git commit 等价于「gate 放行后」的状态。
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

_MODULE_PATH = (
    Path(__file__).resolve().parents[2]
    / ".claude"
    / "skills"
    / "auto-push"
    / "scripts"
    / "autopush.py"
)
_SPEC = importlib.util.spec_from_file_location("auto_push_cli", _MODULE_PATH)
ap = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(ap)


def _g(cwd: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert proc.returncode == 0, f"git {args}: {proc.stderr}"
    return proc.stdout.strip()


def _configure(repo: Path) -> None:
    _g(repo, "config", "user.email", "test@example.invalid")
    _g(repo, "config", "user.name", "autopush-test")
    _g(repo, "config", "core.autocrlf", "false")


def _commit_all(repo: Path, message: str) -> str:
    _g(repo, "add", "-A")
    _g(repo, "commit", "-m", message)
    return _g(repo, "rev-parse", "HEAD")


@pytest.fixture()
def rig(tmp_path: Path) -> dict:
    """bare origin + 工作 clone `work` + 第二个 clone `other`（模拟他人推送）。"""

    origin = tmp_path / "origin.git"
    _g(tmp_path, "init", "--bare", "-b", "main", str(origin))
    seed = tmp_path / "seed"
    _g(tmp_path, "clone", str(origin), str(seed))
    _configure(seed)
    (seed / "README.md").write_text("seed\n", "utf-8")
    (seed / "app.py").write_text(
        "\n".join(f"line{i}" for i in range(40)) + "\n", "utf-8"
    )
    _g(seed, "add", "-A")
    _g(seed, "commit", "-m", "seed")
    _g(seed, "push", "-u", "origin", "main")

    work = tmp_path / "work"
    _g(tmp_path, "clone", str(origin), str(work))
    _configure(work)
    other = tmp_path / "other"
    _g(tmp_path, "clone", str(origin), str(other))
    _configure(other)
    return {"origin": origin, "work": work, "other": other}


def _new_change(work: Path, change: str = "CHG-1", branch: str = "change/CHG-1-demo"):
    result = ap.init_change(work, change, branch)
    assert result["status"] == "OK"
    return result


def _declare(work: Path, change: str, task: str, paths: list[str], verification="PASS"):
    return ap.task_ready(work, change, task, verification, paths, ref="pytest ok")


# ---------------------------------------------------------------------------
# Scenario A + I：单 Task 全流程；一个 Change 多 Task 多 commit
# ---------------------------------------------------------------------------


def test_scenario_a_single_task_stage_commit_push_writeback(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("VALUE = 1\n", "utf-8")

    planned = ap.plan(work, "CHG-1", "TASK-001")
    assert planned["status"] == "READY"
    assert planned["stage"] == ["feature/a.py"]

    staged = ap.stage(work, "CHG-1", "TASK-001", "add feature value")
    assert staged["status"] == "STAGED"
    assert "feature/a.py" in staged["staged"]
    # 清单自身被自动带走，不算 foreign
    assert any(p.startswith("docs/auto-push/") for p in staged["staged"])
    # 消息进文件（-F），不内嵌进命令 —— 两种 shell 没有共同的安全内嵌法
    assert (
        staged["commit_command"] == "git commit -F .claude/tmp/autopush-commit-msg.txt"
    )
    assert "TASK-001" in staged["message"]
    msg = (work / ".claude" / "tmp" / "autopush-commit-msg.txt").read_text("utf-8")
    assert msg.strip() == staged["message"]

    _g(work, "commit", "-m", "add feature value（TASK-001 · CHG-1）")
    recorded = ap.record_commit(work, "CHG-1", "TASK-001")
    assert recorded["status"] == "OK"

    pushed = ap.push(work, "CHG-1")
    assert pushed["status"] == "OK" and pushed["pushed"]
    assert _g(rig["origin"], "rev-parse", "change/CHG-1-demo") == pushed["head"]

    status = ap.change_status(work, "CHG-1")
    assert status["tasks"]["TASK-001"] == {
        "verification": "PASS",
        "commits": 1,
        "pushed": True,
    }


def test_scenario_i_one_change_three_tasks_three_commits(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    for n in (1, 2, 3):
        task = f"TASK-00{n}"
        _declare(work, "CHG-1", task, [f"mod{n}/"])
        (work / f"mod{n}").mkdir()
        (work / f"mod{n}" / "x.py").write_text(f"N = {n}\n", "utf-8")
        staged = ap.stage(work, "CHG-1", task, f"add mod{n}")
        assert staged["status"] == "STAGED"
        _g(work, "commit", "-m", f"add mod{n}（{task} · CHG-1）")
        assert ap.record_commit(work, "CHG-1", task)["status"] == "OK"
        assert ap.push(work, "CHG-1")["status"] == "OK"
    status = ap.change_status(work, "CHG-1")
    assert all(t["commits"] == 1 and t["pushed"] for t in status["tasks"].values())
    subjects = _g(work, "log", "--format=%s", "origin/main..HEAD").splitlines()
    assert len(subjects) == 3


# ---------------------------------------------------------------------------
# Scenario B / C / D：diff 归属
# ---------------------------------------------------------------------------


def test_scenario_b_unrelated_diff_stays_behind(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    (work / "unrelated.txt").write_text("someone else's work\n", "utf-8")

    planned = ap.plan(work, "CHG-1", "TASK-001")
    assert planned["stage"] == ["feature/a.py"]
    assert planned["foreign"] == ["unrelated.txt"]
    staged = ap.stage(work, "CHG-1", "TASK-001", "add a")
    assert "unrelated.txt" not in staged["staged"]
    _g(work, "commit", "-m", "add a（TASK-001 · CHG-1）")
    # 无关文件仍留在工作树
    assert (work / "unrelated.txt").is_file()
    assert "unrelated.txt" in _g(work, "status", "--porcelain")


def test_scenario_c_mixed_file_staged_by_hunk(rig: dict, tmp_path: Path) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["app.py"])
    _declare(work, "CHG-1", "TASK-002", ["app.py"])
    lines = (work / "app.py").read_text("utf-8").splitlines()
    lines[2] = "line2-task1"
    lines[35] = "line35-task2"
    (work / "app.py").write_text("\n".join(lines) + "\n", "utf-8")

    planned = ap.plan(work, "CHG-1", "TASK-001")
    assert planned["status"] == "MIXED" and planned["mixed"] == ["app.py"]

    diff = subprocess.run(
        ["git", "-C", str(work), "diff", "-U1", "--", "app.py"],
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout
    header, first_hunk = diff.split("\n@@", 1)
    first_hunk = "@@" + first_hunk.split("\n@@", 1)[0]
    patch = tmp_path / "task1.patch"
    patch.write_text(header + "\n" + first_hunk + "\n", "utf-8")

    staged = ap.stage(work, "CHG-1", "TASK-001", "task1 hunk", patch_file=str(patch))
    assert staged["status"] == "STAGED"
    cached = _g(work, "diff", "--cached", "--", "app.py")
    assert "line2-task1" in cached and "line35-task2" not in cached
    # Task B 的 hunk 仍留在工作树
    assert "line35-task2" in _g(work, "diff", "--", "app.py")


def test_scenario_d_mixed_file_without_patch_is_refused(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["app.py"])
    _declare(work, "CHG-1", "TASK-002", ["app.py"])
    (work / "app.py").write_text("changed\n", "utf-8")
    result = ap.stage(work, "CHG-1", "TASK-001", "try")
    assert result["status"] == "BLOCKED_MIXED"
    assert _g(work, "diff", "--cached", "--name-only") == ""


# ---------------------------------------------------------------------------
# Scenario E / G / H：安全 Gate
# ---------------------------------------------------------------------------


def test_scenario_e_verification_fail_blocks_everything(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"], verification="FAIL")
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    for op in (ap.plan, lambda *a: ap.stage(*a, "msg")):
        result = op(work, "CHG-1", "TASK-001")
        assert result["status"] == "PUSH_BLOCKED_BY_VERIFICATION"
    assert _g(work, "diff", "--cached", "--name-only") == ""


def test_scenario_g_secret_content_blocks_stage(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    # 运行时拼接，测试源码本身不含完整模式
    fake_key = "AKIA" + "IOSFODNN7EXAMPLE"
    (work / "feature" / "cfg.py").write_text(f'KEY = "{fake_key}"\n', "utf-8")
    result = ap.stage(work, "CHG-1", "TASK-001", "add cfg")
    assert result["status"] == "BLOCKED_SECRET"
    assert _g(work, "diff", "--cached", "--name-only") == ""
    # 命中内容绝不回显 —— 输出本身不能成为二次泄露面
    import json as _json

    assert fake_key not in _json.dumps(result)


def test_scenario_g_secret_filename_blocks_stage(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / ".env").write_text("X=1\n", "utf-8")
    result = ap.stage(work, "CHG-1", "TASK-001", "oops")
    assert result["status"] == "BLOCKED_SECRET"
    assert result["files"] == ["feature/.env"]


def test_scenario_h_wide_diff_needs_explicit_allowance(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["wide/"])
    (work / "wide").mkdir()
    for i in range(ap.WIDE_MAX_FILES + 1):
        (work / "wide" / f"f{i}.py").write_text(f"V = {i}\n", "utf-8")
    assert ap.plan(work, "CHG-1", "TASK-001")["status"] == "BLOCKED_WIDE"
    blocked = ap.stage(work, "CHG-1", "TASK-001", "wide change")
    assert blocked["status"] == "BLOCKED_WIDE"
    allowed = ap.stage(work, "CHG-1", "TASK-001", "wide change", allow_wide=True)
    assert allowed["status"] == "STAGED"


def test_dirty_index_is_refused(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    (work / "stray.txt").write_text("stray\n", "utf-8")
    _g(work, "add", "stray.txt")
    result = ap.plan(work, "CHG-1", "TASK-001")
    assert result["status"] == "BLOCKED_DIRTY_INDEX"


def test_no_force_push_is_even_constructible(rig: dict) -> None:
    source = _MODULE_PATH.read_text("utf-8")
    assert "--force" not in source and "-f," not in source


# ---------------------------------------------------------------------------
# Scenario F：remote ahead → 安全 sync → 再 push
# ---------------------------------------------------------------------------


def test_push_refuses_unrecorded_commits(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "add a")
    _g(work, "commit", "-m", "add a（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")
    assert ap.push(work, "CHG-1")["status"] == "OK"
    # 绕开 auto-push 手工提交 —— 没过任何 Gate 的提交不得被代推
    (work / "feature" / "b.py").write_text("B = 2\n", "utf-8")
    _g(work, "add", "feature/b.py")
    _g(work, "commit", "-m", "manual commit")
    blocked = ap.push(work, "CHG-1")
    assert blocked["status"] == "BLOCKED_UNRECORDED_COMMITS"
    assert blocked["commits"][0]["subject"] == "manual commit"


def test_manifest_metadata_is_secret_scanned(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    fake_key = "AKIA" + "IOSFODNN7EXAMPLE"  # 运行时拼接，源码不含完整模式
    ap.task_ready(work, "CHG-1", "TASK-001", "PASS", ["feature/"], ref=fake_key)
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    result = ap.stage(work, "CHG-1", "TASK-001", "add a")
    assert result["status"] == "BLOCKED_SECRET"
    assert _g(work, "diff", "--cached", "--name-only") == ""


def test_chore_subject_alone_does_not_exempt_a_commit(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "add a")
    _g(work, "commit", "-m", "add a（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")
    assert ap.push(work, "CHG-1")["status"] == "OK"
    # 伪装成元数据回写、实际碰了代码的提交 —— 看内容不看 subject
    (work / "feature" / "evil.py").write_text("E = 1\n", "utf-8")
    _g(work, "add", "feature/evil.py")
    _g(work, "commit", "-m", "chore(auto-push): 假回写")
    blocked = ap.push(work, "CHG-1")
    assert blocked["status"] == "BLOCKED_UNRECORDED_COMMITS"


def test_init_change_refuses_backward_base(rig: dict) -> None:
    """v0.1.1 修复 1：共享工作树永不倒退（fb-auto-push-0002，TASK-102 实测）。"""

    work = rig["work"]
    assert ap.init_change(work, "CHG-1", "change/CHG-1-demo")["status"] == "OK"
    (work / "f.txt").write_text("x\n", "utf-8")
    _g(work, "add", "f.txt")
    _g(work, "commit", "-m", "ahead of origin/main")
    blocked = ap.init_change(work, "CHG-2", "change/CHG-2-x")  # 默认 base 已落后
    assert blocked["status"] == "BLOCKED_BASE_BEHIND"
    assert _g(work, "rev-parse", "--abbrev-ref", "HEAD") == "change/CHG-1-demo"
    assert (work / "f.txt").is_file()  # 树没被倒退
    assert (
        ap.init_change(work, "CHG-2", "change/CHG-2-x", base="HEAD")["status"] == "OK"
    )


def test_scope_violation_recomputed_against_current_paths(rig: dict) -> None:
    """v0.1.1 修复 2：越界按当前申报重算，不信登记时快照（fb-auto-push-0003）。"""

    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    (work / "extra.txt").write_text("extra\n", "utf-8")
    _g(work, "add", "-A")
    _g(work, "commit", "-m", "wide（TASK-001 · CHG-1）")
    assert (
        ap.record_commit(work, "CHG-1", "TASK-001")["status"] == "WARN_SCOPE_VIOLATION"
    )
    assert ap.push(work, "CHG-1")["status"] == "BLOCKED_SCOPE"
    # dev-workflow 复查后扩大申报范围 → 越界现算为空 → 放行
    _declare(work, "CHG-1", "TASK-001", ["feature/", "extra.txt"])
    assert ap.push(work, "CHG-1")["status"] == "OK"


def test_metadata_writeback_does_not_stale_the_gate(rig: dict) -> None:
    """v0.1.1 修复 3：gate 后只有元数据回写移动 HEAD → 不算 stale（fb-0004）。"""

    work = _one_committed_task(rig)
    assert (
        ap.set_merge_gate(work, "CHG-1", "PASS", by="user 2026-08-22")["status"] == "OK"
    )
    blocked = ap.merge(work, "CHG-1", ledger_checked=True)
    assert blocked["status"] == "NEEDS_WRITEBACK_COMMIT"
    _g(work, "add", "-A", "--", "docs/auto-push")
    _g(work, "commit", "-m", "chore(auto-push): CHG-1 元数据回写")
    merged = ap.merge(work, "CHG-1", ledger_checked=True)  # 不带 reverified
    assert merged["status"] == "OK" and merged["pushed_main"]


def test_cross_change_recorded_commits_are_recognised(rig: dict) -> None:
    """v0.1.1 修复 4：叠分支时父 Change 清单里的提交被认出（fb-0005）。"""

    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "add a")
    _g(work, "commit", "-m", "add a（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")  # 故意不 push CHG-1
    assert (
        ap.init_change(work, "CHG-2", "change/CHG-2-stacked", base="HEAD")["status"]
        == "OK"
    )
    ap.task_ready(work, "CHG-2", "TASK-002", "PASS", ["mod2/"], ref="ok")
    (work / "mod2").mkdir()
    (work / "mod2" / "x.py").write_text("N = 2\n", "utf-8")
    ap.stage(work, "CHG-2", "TASK-002", "add mod2")
    _g(work, "commit", "-m", "add mod2（TASK-002 · CHG-2）")
    ap.record_commit(work, "CHG-2", "TASK-002")
    assert ap.push(work, "CHG-2")["status"] == "OK"


def test_record_commit_refuses_merge_commits(rig: dict) -> None:
    """v0.1.1 复审 P1：merge 的 diff-tree（无 -m）files=[] 会让越界现算恒空——
    record-commit 直接拒登 merge，合法通道是 record-sync。"""

    work, other = rig["work"], rig["other"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["app.py"])
    (work / "app.py").write_text("mine\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "mine")
    _g(work, "commit", "-m", "mine（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")
    _g(work, "add", "-A", "--", "docs/auto-push")
    _g(work, "commit", "-m", "chore(auto-push): 回写")
    (other / "mainline.txt").write_text("main moved\n", "utf-8")
    _commit_all(other, "main moves on")
    _g(other, "push", "origin", "main")
    synced = ap.premerge_sync(work, "CHG-1")
    assert synced["status"] == "OK"
    blocked = ap.record_commit(work, "CHG-1", "TASK-001", commit_hash=synced["merged"])
    assert blocked["status"] == "BLOCKED_MERGE_COMMIT"


def test_record_commit_refuses_ALREADY_RECORDED_merge_commits(rig: dict) -> None:
    """v0.1.1 补审 P1：拒登 merge 这一关必须排在去重早退之前。

    v0.1 没有这一关，它登记下来的 merge 条目带着空的 files=[]，越界现算对
    它永久失明。守卫若排在去重之后，重跑 record-commit 会走 already_recorded
    早退答 OK，那条存量记录就被放行——守卫只盖新登记、盖不住存量。
    """

    work, other = rig["work"], rig["other"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["app.py"])
    (work / "app.py").write_text("mine\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "mine")
    _g(work, "commit", "-m", "mine（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")
    _g(work, "add", "-A", "--", "docs/auto-push")
    _g(work, "commit", "-m", "chore(auto-push): 回写")
    (other / "mainline.txt").write_text("main moved\n", "utf-8")
    _commit_all(other, "main moves on")
    _g(other, "push", "origin", "main")
    merged = ap.premerge_sync(work, "CHG-1")["merged"]

    # v0.1 时代的既成事实：merge 已经躺在 task 名下，files=[] 恒空。
    rel = work / "docs" / "auto-push" / "changes" / "CHG-1.json"
    data = json.loads(rel.read_text("utf-8"))
    data["tasks"]["TASK-001"]["commits"].append(
        {
            "hash": merged,
            "subject": "legacy merge recorded by v0.1",
            "time": "2026-08-22T00:00:00+00:00",
            "branch": "change/CHG-1-demo",
            "pushed": False,
            "files": [],
            "scope_violation": None,
        }
    )
    rel.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")

    blocked = ap.record_commit(work, "CHG-1", "TASK-001", commit_hash=merged)
    assert blocked["status"] == "BLOCKED_MERGE_COMMIT", (
        "存量 merge 条目重跑时必须仍被拒，不得被去重早退放行"
    )


def test_record_commit_refuses_double_ownership(rig: dict) -> None:
    """v0.1.1 复审 P1：同一 hash 不得在两个 task 下重复登记。"""

    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    _declare(work, "CHG-1", "TASK-002", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    _g(work, "add", "-A")
    _g(work, "commit", "-m", "shared（TASK-001 · CHG-1）")
    assert ap.record_commit(work, "CHG-1", "TASK-001")["status"] == "OK"
    blocked = ap.record_commit(work, "CHG-1", "TASK-002")
    assert blocked["status"] == "BLOCKED_ALREADY_OWNED"
    again = ap.record_commit(work, "CHG-1", "TASK-001")
    assert again["status"] == "OK" and again["already_recorded"]
    # v0.1.1 补审 non-blocking：早退漏掉回写提醒，重跑一次就把尾巴藏了。
    assert again["writeback_needed"] is True
    assert len(again["writeback_commands"]) == 2


def test_record_commit_reports_writeback_debt(rig: dict) -> None:
    """回写提醒不能只挂在 push 上：不 push 的合法流程也要看得见尾巴。"""

    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "add a")
    _g(work, "commit", "-m", "add a（TASK-001 · CHG-1）")
    rec = ap.record_commit(work, "CHG-1", "TASK-001")
    assert rec["writeback_needed"] is True
    assert len(rec["writeback_commands"]) == 2  # 两条分开跑，永不复合
    assert all("&&" not in cmd for cmd in rec["writeback_commands"])


def test_record_commit_hash_backfills_history(rig: dict) -> None:
    """v0.1.1 修复 4b：--hash 补登历史提交，不再只能记 HEAD。"""

    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    _g(work, "add", "-A")
    _g(work, "commit", "-m", "old（TASK-001 · CHG-1）")
    old = _g(work, "rev-parse", "HEAD")
    (work / "feature" / "b.py").write_text("B = 2\n", "utf-8")
    _g(work, "add", "-A")
    _g(work, "commit", "-m", "new（TASK-001 · CHG-1）")
    rec = ap.record_commit(work, "CHG-1", "TASK-001", commit_hash=old)
    assert rec["status"] == "OK" and rec["hash"] == old


def test_evil_merge_is_not_exempt(rig: dict) -> None:
    """v0.1.1 修复 5：merge 豁免走登记制——挂 main 祖先当第二亲的 evil merge
    夹带任意树也过不了闸（ba0c8e2 补审确认的 P1）。"""

    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "add a")
    _g(work, "commit", "-m", "add a（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")
    _g(work, "add", "-A", "--", "docs/auto-push")
    _g(work, "commit", "-m", "chore(auto-push): 回写")
    # 用 plumbing 构造 evil merge：树里夹带 evil.txt，第二亲挂 origin/main
    (work / "evil.txt").write_text("smuggled\n", "utf-8")
    _g(work, "add", "evil.txt")
    tree = _g(work, "write-tree")
    head = _g(work, "rev-parse", "HEAD")
    anc = _g(work, "rev-parse", "origin/main")
    evil = _g(
        work, "commit-tree", tree, "-p", head, "-p", anc, "-m", "premerge 模样的 merge"
    )
    _g(work, "reset", "--hard", evil)
    blocked = ap.push(work, "CHG-1")
    assert blocked["status"] == "BLOCKED_UNRECORDED_COMMITS"
    assert any(evil.startswith(c["hash"]) for c in blocked["commits"])


def test_record_sync_legitimises_conflict_resolution_merge(rig: dict) -> None:
    """v0.1.1 修复 5b：冲突解决后的 premerge merge 经 record-sync 显式登记放行。"""

    work, other = rig["work"], rig["other"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["app.py"])
    (work / "app.py").write_text("mine\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "mine")
    _g(work, "commit", "-m", "mine（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")
    _g(work, "add", "-A", "--", "docs/auto-push")
    _g(work, "commit", "-m", "chore(auto-push): 回写")

    (other / "app.py").write_text("theirs on main\n", "utf-8")
    _commit_all(other, "conflicting main change")
    _g(other, "push", "origin", "main")

    assert ap.premerge_sync(work, "CHG-1")["status"] == "CONFLICT"
    (work / "app.py").write_text("resolved\n", "utf-8")
    _g(work, "add", "app.py")
    _g(work, "commit", "-m", "merge main：解决 app.py 冲突")

    assert ap.push(work, "CHG-1")["status"] == "BLOCKED_UNRECORDED_COMMITS"
    assert ap.record_sync(work, "CHG-1")["status"] == "OK"
    assert ap.push(work, "CHG-1")["status"] == "OK"
    # 普通提交不能被声明成 sync
    (work / "app.py").write_text("plain\n", "utf-8")
    _g(work, "add", "app.py")
    _g(work, "commit", "-m", "plain commit")
    assert ap.record_sync(work, "CHG-1")["status"] == "BLOCKED_NOT_A_SYNC_MERGE"


def test_merge_tip_push_runs_the_same_gates(rig: dict) -> None:
    work = _one_committed_task(rig)
    assert (
        ap.set_merge_gate(work, "CHG-1", "PASS", by="user 2026-08-22")["status"] == "OK"
    )
    _g(work, "add", "-A", "--", "docs/auto-push")
    _g(work, "commit", "-m", "chore(auto-push): CHG-1 元数据回写")
    # gate 之后混进一个未登记的手工提交 —— 即便声明 reverified 也不得被 merge 代推
    (work / "feature" / "late.py").write_text("L = 1\n", "utf-8")
    _g(work, "add", "feature/late.py")
    _g(work, "commit", "-m", "manual late commit")
    blocked = ap.merge(work, "CHG-1", reverified=True, ledger_checked=True)
    assert blocked["status"] == "BLOCKED_UNRECORDED_COMMITS"


def test_unscannable_binary_needs_explicit_allowance(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "blob.bin").write_bytes(b"\x00\x01\x02" * 100)
    blocked = ap.stage(work, "CHG-1", "TASK-001", "add blob")
    assert blocked["status"] == "BLOCKED_UNSCANNABLE"
    assert blocked["files"] == ["feature/blob.bin"]
    assert _g(work, "diff", "--cached", "--name-only") == ""
    allowed = ap.stage(work, "CHG-1", "TASK-001", "add blob", allow_unscanned=True)
    assert allowed["status"] == "STAGED"
    assert allowed["unscanned"] == ["feature/blob.bin"]


def test_scenario_f_remote_ahead_sync_then_push(rig: dict) -> None:
    work, other = rig["work"], rig["other"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "add a")
    _g(work, "commit", "-m", "add a（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")
    assert ap.push(work, "CHG-1")["status"] == "OK"

    # 他人推进同一 Change branch
    _g(other, "fetch", "origin")
    _g(other, "switch", "change/CHG-1-demo")
    (other / "elsewhere.txt").write_text("other work\n", "utf-8")
    _commit_all(other, "other's commit")
    _g(other, "push", "origin", "change/CHG-1-demo")

    # 本地再做一个 task commit
    (work / "feature" / "b.py").write_text("B = 2\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "add b")
    _g(work, "commit", "-m", "add b（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")

    blocked = ap.push(work, "CHG-1")
    assert blocked["status"] == "NEEDS_SYNC" and blocked["behind"] == 1

    # record-commit 的回写让清单单独脏 → 先要求 writeback commit，不卡死流程
    needs = ap.sync(work, "CHG-1")
    assert needs["status"] == "NEEDS_WRITEBACK_COMMIT"
    _g(work, "add", "-A", "--", "docs/auto-push")
    _g(work, "commit", "-m", "chore(auto-push): CHG-1 元数据回写")

    synced = ap.sync(work, "CHG-1")
    assert synced["status"] == "OK" and synced["needs_verification"]

    # rebase 改写了未推送提交的 hash → 清单必须已重映射到新 hash
    manifest = ap._load_manifest(work, "CHG-1")
    second = manifest["tasks"]["TASK-001"]["commits"][1]
    assert second["hash"] == _g(work, "rev-parse", "HEAD~1")
    assert second["rebased_from"] != second["hash"]

    # 旧的 PASS 在新基底上不作数：重验证并重新申报之前 push 被拒
    assert synced["verification_staled"] == ["TASK-001"]
    assert ap.push(work, "CHG-1")["status"] == "PUSH_BLOCKED_BY_VERIFICATION"
    _declare(work, "CHG-1", "TASK-001", ["feature/"])  # 新基底重验证后重新申报

    pushed = ap.push(work, "CHG-1")
    assert pushed["status"] == "OK" and pushed["pushed"]
    assert "other work" in (work / "elsewhere.txt").read_text("utf-8")


def test_sync_conflict_aborts_and_hands_back(rig: dict) -> None:
    work, other = rig["work"], rig["other"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["app.py"])
    (work / "app.py").write_text("mine\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "mine")
    _g(work, "commit", "-m", "mine（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")
    assert ap.push(work, "CHG-1")["status"] == "OK"

    _g(other, "fetch", "origin")
    _g(other, "switch", "change/CHG-1-demo")
    (other / "app.py").write_text("theirs\n", "utf-8")
    _commit_all(other, "theirs")
    _g(other, "push", "origin", "change/CHG-1-demo")

    (work / "app.py").write_text("mine again\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "mine again")
    _g(work, "commit", "-m", "mine again（TASK-001 · CHG-1）")

    result = ap.sync(work, "CHG-1")
    assert result["status"] == "CONFLICT" and "app.py" in result["files"]
    # rebase 已中止，工作树可用
    assert "rebase" not in _g(work, "status")


# ---------------------------------------------------------------------------
# Scenario J / K / L / N：Merge Gate 与合并、清理
# ---------------------------------------------------------------------------


def _one_committed_task(rig: dict) -> Path:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "add a")
    _g(work, "commit", "-m", "add a（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")
    assert ap.push(work, "CHG-1")["status"] == "OK"
    return work


def test_scenario_j_merge_without_gate_pass_is_refused(rig: dict) -> None:
    work = _one_committed_task(rig)
    assert ap.merge(work, "CHG-1")["status"] == "BLOCKED_MERGE_GATE"
    gate = ap.set_merge_gate(work, "CHG-1", "FAIL", by="user 2026-08-22")
    assert gate["status"] == "OK"
    assert ap.merge(work, "CHG-1")["status"] == "BLOCKED_MERGE_GATE"


def test_merge_gate_pass_requires_all_tasks_verified(rig: dict) -> None:
    work = _one_committed_task(rig)
    _declare(work, "CHG-1", "TASK-002", ["other/"], verification="FAIL")
    result = ap.set_merge_gate(work, "CHG-1", "PASS", by="user 2026-08-22")
    assert result["status"] == "BLOCKED_TASKS_NOT_PASSED"
    assert result["tasks"] == ["TASK-002"]


def _merge_change(rig: dict) -> Path:
    """跑完 gate PASS → writeback → premerge-sync → 重验证 → merge 的公共路径。"""

    work, other = _one_committed_task(rig), rig["other"]
    # main 前进一步（无冲突文件）
    (other / "mainline.txt").write_text("main moved\n", "utf-8")
    _commit_all(other, "main moves on")
    _g(other, "push", "origin", "main")

    assert (
        ap.set_merge_gate(work, "CHG-1", "PASS", by="user 2026-08-22")["status"] == "OK"
    )

    # ledger 前置：未声明查过待复审清单 → 拒（TASK-102 的教训）
    assert ap.merge(work, "CHG-1")["status"] == "BLOCKED_LEDGER_UNCHECKED"

    # 清单有未提交回写 → merge 先要求 writeback commit
    blocked = ap.merge(work, "CHG-1", ledger_checked=True)
    assert blocked["status"] == "NEEDS_WRITEBACK_COMMIT"
    _g(work, "add", "-A", "--", "docs/auto-push")
    _g(work, "commit", "-m", "chore(auto-push): CHG-1 元数据回写")

    synced = ap.premerge_sync(work, "CHG-1")
    assert synced["status"] == "OK" and synced["needs_verification"]

    # premerge 把 merge hash 登记进 sync_commits → 清单又脏 → 再回写一次
    blocked = ap.merge(work, "CHG-1", ledger_checked=True)
    assert blocked["status"] == "NEEDS_WRITEBACK_COMMIT"
    _g(work, "add", "-A", "--", "docs/auto-push")
    _g(work, "commit", "-m", "chore(auto-push): CHG-1 sync 登记回写")

    # premerge 的 merge commit 不是元数据 → gate stale，需 reverified
    stale = ap.merge(work, "CHG-1", ledger_checked=True)
    assert stale["status"] == "BLOCKED_STALE_GATE"

    merged = ap.merge(work, "CHG-1", reverified=True, ledger_checked=True)
    assert merged["status"] == "OK" and merged["pushed_main"]
    assert _g(work, "rev-parse", "--abbrev-ref", "HEAD") == "main"
    assert _g(rig["origin"], "rev-parse", "main") == merged["merge"]
    return work


def test_scenario_k_full_merge_and_cleanup(rig: dict) -> None:
    work = _merge_change(rig)
    cleaned = ap.cleanup(work, "CHG-1")
    assert cleaned == {"status": "OK", "local_deleted": True, "remote_deleted": True}
    assert "change/CHG-1-demo" not in _g(work, "branch", "--list", "change/*")
    remote_branches = _g(rig["origin"], "branch", "--list")
    assert "change/CHG-1-demo" not in remote_branches
    status = ap.change_status(work, "CHG-1")
    assert status["state"] == "closed"


def test_cleanup_keeps_remote_branch_with_concurrent_push(rig: dict) -> None:
    work, other = _merge_change(rig), rig["other"]
    # merge 之后有人又往 Change 分支推了新提交 —— 删远端分支会永久丢弃它
    _g(other, "fetch", "origin")
    _g(other, "switch", "change/CHG-1-demo")
    (other / "late.txt").write_text("late work\n", "utf-8")
    _commit_all(other, "late concurrent commit")
    _g(other, "push", "origin", "change/CHG-1-demo")

    cleaned = ap.cleanup(work, "CHG-1")
    assert cleaned["status"] == "WARN_REMOTE_CLEANUP"
    assert cleaned["local_deleted"] and not cleaned["remote_deleted"]
    assert "refused to delete" in cleaned["remote_error"]
    assert "change/CHG-1-demo" in _g(rig["origin"], "branch", "--list")
    # 远端没清干净 → Change 停在 merged，不得标 closed
    assert ap.change_status(work, "CHG-1")["state"] == "merged"


def test_scenario_l_text_conflict_is_reported_not_resolved(rig: dict) -> None:
    work, other = rig["work"], rig["other"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["app.py"])
    (work / "app.py").write_text("mine\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "mine")
    _g(work, "commit", "-m", "mine（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")
    _g(work, "add", "-A", "--", "docs/auto-push")
    _g(work, "commit", "-m", "chore(auto-push): 回写")

    (other / "app.py").write_text("theirs on main\n", "utf-8")
    _commit_all(other, "conflicting main change")
    _g(other, "push", "origin", "main")

    result = ap.premerge_sync(work, "CHG-1")
    assert result["status"] == "CONFLICT" and result["files"] == ["app.py"]
    assert ap.merge_abort(work, "CHG-1")["status"] == "OK"
    # -uno：-F 的消息文件在无 .gitignore 的临时仓库里是 untracked，与本断言无关
    assert _g(work, "status", "--porcelain", "-uno") == ""


def test_scenario_n_cleanup_refuses_unconfirmed_merge(rig: dict) -> None:
    work = _one_committed_task(rig)
    assert ap.cleanup(work, "CHG-1")["status"] == "BLOCKED_NOT_MERGED"
    # 伪造一个不在远端的 merge 记录 → 仍拒绝删分支
    manifest = ap._load_manifest(work, "CHG-1")
    manifest["merge"] = {"hash": "0" * 40, "time": "t", "pushed": False}
    ap._save_manifest(work, "CHG-1", manifest)
    _g(work, "switch", "-c", "observer")  # 离开 Change branch，但不切到 main
    result = ap.cleanup(work, "CHG-1")
    assert result["status"] == "BLOCKED_MERGE_NOT_CONFIRMED"


# ---------------------------------------------------------------------------
# 身份与边界
# ---------------------------------------------------------------------------


def test_branch_mismatch_blocks_plan_and_push(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    _g(work, "switch", "main")
    assert ap.plan(work, "CHG-1", "TASK-001")["status"] == "BLOCKED_BRANCH"
    assert ap.push(work, "CHG-1")["status"] == "BLOCKED_BRANCH"


def test_init_change_adopts_existing_branch_only_explicitly(rig: dict) -> None:
    work = rig["work"]
    _g(work, "switch", "-c", "change/CHG-9-x")
    with pytest.raises(ap.AutoPushError, match="--adopt"):
        ap.init_change(work, "CHG-9", "change/CHG-9-x")
    result = ap.init_change(work, "CHG-9", "change/CHG-9-x", adopt=True)
    assert result["status"] == "OK" and result["adopted"]


def test_main_can_never_be_a_change_branch(rig: dict) -> None:
    work = rig["work"]
    with pytest.raises(ap.AutoPushError, match="must not be 'main'"):
        ap.init_change(work, "CHG-M", "main", adopt=True)


def test_change_and_task_ids_are_sanitised(rig: dict) -> None:
    work = rig["work"]
    with pytest.raises(ap.AutoPushError, match="invalid change id"):
        ap.init_change(work, "../evil", "change/x")
    _new_change(work)
    with pytest.raises(ap.AutoPushError, match="invalid task id"):
        ap.task_ready(work, "CHG-1", "../evil", "PASS", ["a/"])


def test_record_commit_flags_out_of_scope_files(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    (work / "sneaky.txt").write_text("out of scope\n", "utf-8")
    _g(work, "add", "-A")  # 绕过 stage，模拟越界提交
    _g(work, "commit", "-m", "sneaky（TASK-001 · CHG-1）")
    result = ap.record_commit(work, "CHG-1", "TASK-001")
    assert result["status"] == "WARN_SCOPE_VIOLATION"
    assert "sneaky.txt" in result["out_of_scope"]
    # 越界提交在解决前不得离开本机
    blocked = ap.push(work, "CHG-1")
    assert blocked["status"] == "BLOCKED_SCOPE"


def test_push_rechecks_verification_after_commit(rig: dict) -> None:
    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["feature/"])
    (work / "feature").mkdir()
    (work / "feature" / "a.py").write_text("A = 1\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "add a")
    _g(work, "commit", "-m", "add a（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")
    # 验证结论在 push 前被撤回（重验证挂了）→ push 拒绝
    _declare(work, "CHG-1", "TASK-001", ["feature/"], verification="FAIL")
    assert ap.push(work, "CHG-1")["status"] == "PUSH_BLOCKED_BY_VERIFICATION"


# ---------------------------------------------------------------------------
# TASK-087 §3.6.6 / §3.6.9：两条实测出来的工装欠账
# ---------------------------------------------------------------------------


def test_record_sync_hash_backfills_a_historical_merge(rig: dict) -> None:
    """§3.6.6：`record-sync` 只能登记 HEAD 时，旧版工具产出的 sync merge 够不着。

    实测形状（TASK-104 合并）：`premerge-sync` 由旧版产出 merge，那一版不写
    `sync_commits`；换新版后 `_push_gates` 只认登记 → `BLOCKED_UNRECORDED_COMMITS`，
    而 `record-sync` 只看 HEAD，补登不了那个 hash。唯一出路是手工编辑清单。
    """

    work, other = rig["work"], rig["other"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["app.py"])
    (work / "app.py").write_text("mine\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "mine")
    _g(work, "commit", "-m", "mine（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")
    _g(work, "add", "-A", "--", "docs/auto-push")
    _g(work, "commit", "-m", "chore(auto-push): 回写")

    (other / "README.md").write_text("moved on\n", "utf-8")
    _commit_all(other, "main moves on")
    _g(other, "push", "origin", "main")
    _g(work, "fetch", "origin")
    # 手工做一次 premerge merge（模拟旧版工具：登记没写进清单）
    _g(work, "merge", "--no-edit", "origin/main")
    merge_hash = _g(work, "rev-parse", "HEAD")
    # 再往前走一步，于是 HEAD 不再是那个 merge —— 这正是补登不了的处境
    (work / "app.py").write_text("mine again\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "mine again")
    _g(work, "commit", "-m", "mine again（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")

    rec = ap.record_sync(work, "CHG-1", hash_=merge_hash)
    assert rec["status"] == "OK", rec
    assert rec["hash"] == merge_hash


def test_record_sync_hash_still_refuses_a_non_merge(rig: dict) -> None:
    """形状校验一条不放松：`--hash` 是补登的口子，不是把普通提交声明成 sync 的口子。"""

    work = rig["work"]
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["app.py"])
    (work / "app.py").write_text("mine\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "mine")
    _g(work, "commit", "-m", "mine（TASK-001 · CHG-1）")
    ordinary = _g(work, "rev-parse", "HEAD")

    rec = ap.record_sync(work, "CHG-1", hash_=ordinary)
    assert rec["status"] == "BLOCKED_NOT_A_SYNC_MERGE", rec


def _branch_with_a_stale_upstream(work: Path) -> str:
    """A change branch whose remote upstream is BEHIND it, merged into main.

    This is the `feat/wfm1-batch-c` shape, and it is fiddly enough to be worth
    one helper: `git branch -d` asks 「merged into its upstream?」 when an
    upstream is set, so an upstream pushed from the CURRENT tip makes `-d`
    succeed and the `-D` path unreachable. Returns the branch tip.
    """
    _new_change(work)
    _declare(work, "CHG-1", "TASK-001", ["app.py"])
    (work / "app.py").write_text("first\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "first")
    _g(work, "commit", "-m", "first（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")
    _g(work, "add", "-A", "--", "docs/auto-push")
    _g(work, "commit", "-m", "chore(auto-push): 回写")

    # 上游停在**这里** —— 之后分支还会往前走，于是它是真的落后了
    _g(work, "push", "origin", "HEAD:refs/heads/stale-upstream")

    (work / "app.py").write_text("second\n", "utf-8")
    ap.stage(work, "CHG-1", "TASK-001", "second")
    _g(work, "commit", "-m", "second（TASK-001 · CHG-1）")
    ap.record_commit(work, "CHG-1", "TASK-001")
    _g(work, "add", "-A", "--", "docs/auto-push")
    _g(work, "commit", "-m", "chore(auto-push): 回写 2")
    tip = _g(work, "rev-parse", "HEAD")

    _g(work, "fetch", "origin")
    _g(work, "branch", "--set-upstream-to=origin/stale-upstream", "change/CHG-1-demo")
    return tip


def _record_merge(work: Path, merge_hash: str) -> None:
    path = work / "docs" / "auto-push" / "changes" / "CHG-1.json"
    manifest = json.loads(path.read_text("utf-8"))
    manifest["merge"] = {"hash": merge_hash, "time": "2026-01-01T00:00:00+00:00"}
    manifest["status"] = "merged"
    path.write_text(json.dumps(manifest, ensure_ascii=False), "utf-8")


def test_cleanup_deletes_a_branch_whose_every_commit_is_already_on_main(
    rig: dict,
) -> None:
    """§3.6.9：`git branch -d` 判的是「相对**上游**是否已合并」，不是「是否已在
    main 里」。两者会分歧，而分歧时 `cleanup` 从前把判断退回给人 —— 实测卡住了
    `feat/wfm1-batch-c`：7 个领先提交逐个核实都是 `origin/main` 的祖先，删除不丢
    任何提交，分支却删不掉。
    """

    work = rig["work"]
    branch_tip = _branch_with_a_stale_upstream(work)

    _g(work, "checkout", "main")
    _g(work, "merge", "--no-ff", "--no-edit", "change/CHG-1-demo")
    _g(work, "push", "origin", "main")
    _g(work, "fetch", "origin")
    _record_merge(work, _g(work, "rev-parse", "HEAD"))

    # 前提自证：`-d` 确实会拒，否则这条测试根本没走到 `-D` 那一支
    refused = subprocess.run(
        ["git", "-C", str(work), "branch", "-d", "change/CHG-1-demo"],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert refused.returncode != 0, "前提不成立：-d 没有拒绝，这条测试就没在测 -D"
    assert ap._is_ancestor(work, branch_tip, "origin/main"), "但它确实整个在 main 里"

    result = ap.cleanup(work, "CHG-1", keep_remote=True)
    assert result["status"] == "OK", result
    assert result["local_deleted"] is True
    assert not ap._ref_exists(work, "refs/heads/change/CHG-1-demo")


def test_cleanup_refuses_when_the_branch_moves_after_its_tip_was_verified(
    rig: dict, monkeypatch
) -> None:
    """§3.6.9 的 P1：检查与删除之间分支会动。

    `git branch -D <name>` 是无条件的，所以「tip 已在 main 里」这个结论一旦过时，
    被删掉的就是那个**从没进过 main** 的新提交。删除改成
    `update-ref -d <ref> <expected-oid>`：oid 对不上就失败（codex 审查轮 1）。

    **注入点必须是删除那一次调用本身。** 第一版挂在 `_is_ancestor` 上，于是新提交
    在 `cleanup` 顶部的 merge 确认时就落了下来 —— 等 tip 检查跑到时它已经在分支上，
    那道检查自己就拒了，删除那一步根本没被考验。实测：把删除换回无条件
    `branch -D`，那一版测试**照样通过**。这就是「测试的构造恰好排除了要防的
    那件事」（TASK-087 §7）。
    """

    work = rig["work"]
    _branch_with_a_stale_upstream(work)

    _g(work, "checkout", "main")
    _g(work, "merge", "--no-ff", "--no-edit", "change/CHG-1-demo")
    _g(work, "push", "origin", "main")
    _g(work, "fetch", "origin")
    _record_merge(work, _g(work, "rev-parse", "HEAD"))
    verified_tip = _g(work, "rev-parse", "change/CHG-1-demo")

    real_git = ap._git
    landed = []

    def racing_git(root, *args, **kwargs):
        # 恰好在**删除这一次调用**之前落一个 main 从没见过的提交上去
        deleting = args[:2] in (("update-ref", "-d"), ("branch", "-D"))
        if deleting and not landed:
            tree = _g(root, "rev-parse", "change/CHG-1-demo^{tree}")
            parent = _g(root, "rev-parse", "change/CHG-1-demo")
            sneaked = _g(
                root, "commit-tree", tree, "-p", parent, "-m", "landed mid-cleanup"
            )
            _g(root, "update-ref", "refs/heads/change/CHG-1-demo", sneaked)
            landed.append(sneaked)
        return real_git(root, *args, **kwargs)

    monkeypatch.setattr(ap, "_git", racing_git)
    result = ap.cleanup(work, "CHG-1", keep_remote=True)

    assert landed, "前提不成立：竞态没有被注入到删除那一步"
    assert result["status"] == "BLOCKED_UNMERGED_COMMITS", result
    assert ap._ref_exists(work, "refs/heads/change/CHG-1-demo"), (
        "那个中途落上来的提交必须还在 —— 它从没进过 main"
    )
    assert _g(work, "rev-parse", "change/CHG-1-demo") == landed[0]
    assert verified_tip != landed[0], "前提自证：分支确实动过"


def test_cleanup_refuses_to_delete_a_branch_another_worktree_has_checked_out(
    rig: dict, tmp_path: Path
) -> None:
    """`update-ref -d` 不认识 worktree，而 `branch -d/-D` 认识。

    换成前者就把那道保护一起丢了：代价是一个 linked worktree 的 HEAD 指向一个
    已经不存在的 ref（codex 审查轮 2）。所以删除前显式问一遍，问不出来也当作有。
    """

    work = rig["work"]
    _branch_with_a_stale_upstream(work)

    _g(work, "checkout", "main")
    _g(work, "merge", "--no-ff", "--no-edit", "change/CHG-1-demo")
    _g(work, "push", "origin", "main")
    _g(work, "fetch", "origin")
    _record_merge(work, _g(work, "rev-parse", "HEAD"))

    linked = tmp_path / "linked-worktree"
    _g(work, "worktree", "add", str(linked), "change/CHG-1-demo")

    result = ap.cleanup(work, "CHG-1", keep_remote=True)

    assert result["status"] == "BLOCKED_BRANCH_CHECKED_OUT", result
    assert ap._ref_exists(work, "refs/heads/change/CHG-1-demo")
    # 那个 worktree 的 HEAD 仍然解析得出来 —— 没有被删成悬空
    assert _g(linked, "rev-parse", "HEAD")


def test_cleanup_fails_closed_when_the_worktree_list_cannot_be_read(
    rig: dict, monkeypatch
) -> None:
    """问不出来 = 当作有。这条独立于上一条：上一条证明「有就拒」，
    这条证明「不知道也拒」—— 后者才是把 fail-open 写死的那一半。"""

    work = rig["work"]
    _branch_with_a_stale_upstream(work)

    _g(work, "checkout", "main")
    _g(work, "merge", "--no-ff", "--no-edit", "change/CHG-1-demo")
    _g(work, "push", "origin", "main")
    _g(work, "fetch", "origin")
    _record_merge(work, _g(work, "rev-parse", "HEAD"))

    monkeypatch.setattr(ap, "_worktrees_holding", lambda root, branch: None)
    result = ap.cleanup(work, "CHG-1", keep_remote=True)

    assert result["status"] == "BLOCKED_BRANCH_CHECKED_OUT", result
    assert "undetermined" in result["reason"]
    assert ap._ref_exists(work, "refs/heads/change/CHG-1-demo")


def test_cleanup_still_refuses_a_branch_carrying_commits_main_never_saw(
    rig: dict,
) -> None:
    """反方向：这不是放宽。分支上有 main 里没有的提交时，照旧拒绝。"""

    work = rig["work"]
    _branch_with_a_stale_upstream(work)

    _g(work, "checkout", "main")
    _g(work, "merge", "--no-ff", "--no-edit", "change/CHG-1-demo")
    _g(work, "push", "origin", "main")
    _g(work, "fetch", "origin")
    _record_merge(work, _g(work, "rev-parse", "HEAD"))

    # 合并之后分支上又多了一个提交 —— main 从没见过它
    tree = _g(work, "rev-parse", "change/CHG-1-demo^{tree}")
    parent = _g(work, "rev-parse", "change/CHG-1-demo")
    later = _g(work, "commit-tree", tree, "-p", parent, "-m", "later, never merged")
    _g(work, "update-ref", "refs/heads/change/CHG-1-demo", later)

    result = ap.cleanup(work, "CHG-1", keep_remote=True)
    assert result["status"] == "BLOCKED_UNMERGED_COMMITS", result
    assert "not contained in" in result["reason"]

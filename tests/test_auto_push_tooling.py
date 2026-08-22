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
import subprocess
from pathlib import Path

import pytest

_MODULE_PATH = (
    Path(__file__).resolve().parents[1]
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

    # 清单有未提交回写 → merge 先要求 writeback commit
    blocked = ap.merge(work, "CHG-1")
    assert blocked["status"] == "NEEDS_WRITEBACK_COMMIT"
    _g(work, "add", "-A", "--", "docs/auto-push")
    _g(work, "commit", "-m", "chore(auto-push): CHG-1 元数据回写")

    synced = ap.premerge_sync(work, "CHG-1")
    assert synced["status"] == "OK" and synced["needs_verification"]

    # HEAD 已离开 gate 绑定的 tip → 未声明重验证的 merge 被拒
    stale = ap.merge(work, "CHG-1")
    assert stale["status"] == "BLOCKED_STALE_GATE"

    merged = ap.merge(work, "CHG-1", reverified=True)
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

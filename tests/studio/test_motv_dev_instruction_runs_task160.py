"""TASK-160 / REQ-011 / ADR-0107：开发指令那一轮有工具、在仓库里跑。

这条路之所以敢开，全部理由只有一条：**它的提示词里没有作品内容**。
ADR-0056 决策 2A 那条注入面讲的是「剧本文本 + 能读文件的执行器」——
这条路把等式左边的第一项去掉了，所以右边不成立。

因此这份测试盯的是三件**会静默出大事**的事：

1. **创作能力那条路一个字节没变**（验收 4）。`claude-code` 仍然带 `--tools ""`，
   仍然在中性临时目录跑。它变了，注入面就回来了。
2. **能写仓库的执行器只有开发指令拿得到**（验收 1/2）。白名单在解析 argv 之前判，
   所以一次写错的组合走不到 spawn。
3. **仓库根绝不会被 rmtree**。`_run_executor` 原来无条件删 workdir；
   开发指令那一轮的 workdir 就是仓库根 —— 这一行写错一次，一次开发指令删掉整个仓库。
"""

from __future__ import annotations

import importlib.util
import inspect
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SERVER = _REPO / "mockups" / "motv-workspace" / "server.py"


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location("motv_server_dev_160", _SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- 1. 创作能力那条路一个字节没变 -------------------------------------------- #


def test_the_creative_executor_still_has_every_tool_disabled(srv) -> None:
    """ADR-0056 决策 2 保持 Accepted。它的提示词里带着他写的剧本正文，
    那条路上的工具必须是全关的 —— 这一条红了，说明注入面回来了。"""
    assert srv._EXECUTORS["claude-code"]["args"] == ["-p", "--tools", ""]
    assert not srv._EXECUTORS["claude-code"].get("writes_repo")
    assert srv._EXECUTORS["claude-code"].get("cwd") != "repo"


def test_the_dev_executor_is_a_separate_entry_not_a_flag(srv) -> None:
    """两个条目并存，不是一个带布尔开关的条目：传错一个布尔值是静默的，
    而且错的方向恰好是「作品内容 + 工具」（ADR-0107 决策 1）。"""
    dev = srv._EXECUTORS["claude-dev"]
    assert dev["bin"] == "claude"
    assert "--tools" not in dev["args"], "开发指令那一轮要工具，但不该自己关掉它"
    assert dev["cwd"] == "repo"
    assert dev["writes_repo"] is True


# --- 2. 能写仓库的执行器只有开发指令拿得到 ------------------------------------ #


@pytest.mark.parametrize(
    "task_type",
    ["skill.run", "dev.proposal", "story.develop", "", "dev.implement.x"],
)
def test_a_repo_writing_executor_is_refused_to_everything_else(srv, task_type) -> None:
    why = srv._executor_allowed_for("claude-dev", task_type)
    assert why, f"「{task_type}」竟然拿得到能写仓库的执行器"
    assert "ADR-0107" in why, "拒绝要说得出依据"


def test_the_dev_instruction_may_use_it(srv) -> None:
    assert srv._executor_allowed_for("claude-dev", "dev.implement") == ""


@pytest.mark.parametrize("task_type", ["skill.run", "dev.proposal", "dev.implement"])
def test_the_tool_free_executor_is_allowed_everywhere(srv, task_type) -> None:
    """白名单只收紧「能写仓库」的那些。无工具执行器照旧谁都能用 ——
    收紧它会把创作能力一起挡掉。"""
    assert srv._executor_allowed_for("claude-code", task_type) == ""


def test_the_whitelist_is_a_set_of_task_types_not_a_boolean(srv) -> None:
    assert "dev.implement" in srv._REPO_WRITING_TASK_TYPES
    # 创作能力那一侧一个都不许在里面
    for creative in ("skill.run", "dev.proposal"):
        assert creative not in srv._REPO_WRITING_TASK_TYPES


# --- 2b. 作品内容一个字都不进它的提示词（ADR-0107 决策 2） -------------------- #


def test_the_implement_prompt_takes_no_project_facts(srv) -> None:
    """**这条路敢带工具的全部理由。**

    ADR-0056 决策 2A 的注入面是「剧本文本 + 能读文件的执行器」。这一轮把等式左边
    的第一项去掉，所以右边不成立 —— 前提是它**拿不到**作品事实。

    断言签名：给它加一个 facts 入参，这条当场红。
    """
    sig = inspect.signature(srv._dev_implement_prompt)
    assert list(sig.parameters) == ["ask", "page"], (
        f"开发指令的提示词多了入参：{list(sig.parameters)} —— "
        "作品内容不许有任何一条进得来的路"
    )


def test_the_implement_prompt_body_never_embeds_a_work(srv) -> None:
    """组装出来的提示词里只有他这句话和页面名 —— 拿一段像模像样的作品文字
    当输入，它不该在提示词里出现（除非它就是他说的那句话本身）。"""
    prose = "林照站在潜水舱前，舷窗外多了一个人影。"
    out = srv._dev_implement_prompt("把表头改成登场人物", "故事开发 · 结构规划")
    assert "把表头改成登场人物" in out
    assert "故事开发 · 结构规划" in out
    assert prose not in out
    # 它必须明确要求那一轮走仓库规程，并且不碰 main
    assert "dev-workflow" in out
    assert "main" in out and "不碰" in out


def test_the_proposal_prompt_still_carries_facts(srv) -> None:
    """**写方案**那一轮（无工具）照旧带项目事实 —— 收紧它会让方案变瞎。
    两条路的区别不在「带不带事实」这一项上随意，而是与「带不带工具」严格配对。"""
    sig = inspect.signature(srv._dev_prompt)
    assert "facts" in sig.parameters


# --- 2c. 「要方案」与「真的改」不许被一个含糊的值混掉 ------------------------- #


def _dev_edit(srv, raw):
    """把模型那一轮的输出过一遍真实的净化，取出那条 dev.request。"""
    out = srv._adapt_conversation(
        '{"reply":"好","edits":[{"kind":"dev.request","text":"改表头"'
        + (f',"build":{raw}' if raw is not None else "")
        + "}]}"
    )
    return next(e for e in out["edits"] if e["kind"] == "dev.request")


@pytest.mark.parametrize("raw", ["true", '"true"', '"True"'])
def test_build_true_in_any_spelling_means_build(srv, raw) -> None:
    assert _dev_edit(srv, raw)["build"] is True


@pytest.mark.parametrize("raw", [None, "false", '"false"', "null", "0", '""', "[]"])
def test_anything_else_means_write_a_plan(srv, raw) -> None:
    """**错的方向要特别小心**：`"false"` 是个非空字符串，`if e.get("build")`
    对它为真 —— 那会让一句「先给个方案」跑成一次真实的代码改动。"""
    assert _dev_edit(srv, raw)["build"] is False, f"build={raw} 被当成了「真的改」"


# --- 3. 仓库根绝不会被 rmtree ------------------------------------------------- #


def test_the_repo_root_is_never_deleted(srv) -> None:
    """`_run_executor` 原来无条件 `shutil.rmtree(workdir)`，而开发指令那一轮的
    workdir 就是仓库根。**这一行写错一次，一次开发指令删掉整个仓库。**

    断言的是源码里那个条件真的在（这是少数几处「只能读源码」的守卫之一 ——
    真跑一次 `_run_executor` 就会 spawn 一个真实的 claude 进程）。
    读的是**执行构造**：`rmtree` 必须在 `owns_workdir` 的条件之内。
    """
    src = _SERVER.read_text("utf-8")
    body = inspect.getsource(srv._run_executor)
    assert "owns_workdir" in body, "删不删 workdir 的那个判断没了"
    # **每一处** rmtree 都要被守着，不只是第一处。
    #
    # 这条守卫第一次跑就抓到了第二处：spawn 失败那条 `except OSError` 分支上还有
    # 一个无条件的 `rmtree(workdir)`。只检查第一处的守卫会放它过去 —— 而那条路
    # 同样删仓库根。
    lines = body.splitlines()
    idx = [i for i, ln in enumerate(lines) if "rmtree(workdir" in ln]
    assert idx, "找不到 rmtree(workdir) —— 这条守卫失去了对象"
    for i in idx:
        guard = "\n".join(lines[max(0, i - 4) : i])
        assert "if owns_workdir" in guard, (
            f"第 {i} 行的 rmtree(workdir) 不在 owns_workdir 的条件里：\n{guard}"
        )
    # 而 owns_workdir 必须由「是不是在仓库里跑」决定
    assert "owns_workdir = not in_repo" in body
    assert 'cwd") == "repo"' in body or "cwd'] == 'repo'" in body
    # 仓库根只在这一个地方成为 workdir
    assert src.count("workdir = str(REPO_ROOT)") == 1


# --- 4. 三条只靠提示词的承诺，现在有代码兜底（codex 轮 1 的 BLOCKING） ------- #


def test_the_branch_limit_is_verified_not_just_asked_for(srv, monkeypatch) -> None:
    """ADR-0107 决策 4 原来**只是提示词里的一句话**，而那一轮握着仓库写权限 ——
    一句请求不是约束。

    做得到的不是「禁止」（它能 checkout、能改钩子），是**回来核对并说出来**。
    """
    before = {
        "branch": "change/x",
        "head": "aaa",
        "main": "m1",
        "mainRemote": "r1",
    }
    # 没动过 → 两类都空
    monkeypatch.setattr(srv, "_repo_guard_snapshot", lambda: dict(before))
    assert srv._repo_guard_verify(before) == {"crossed": [], "unverified": []}
    # 切走了分支 / 动了本地 main / 动了远端 main —— 每一种都进 crossed
    for key, word in (
        ("branch", "分支"),
        ("main", "本地 main"),
        ("mainRemote", "远端 main"),
    ):
        moved = dict(before)
        moved[key] = "CHANGED"
        monkeypatch.setattr(srv, "_repo_guard_snapshot", lambda m=moved: dict(m))
        res = srv._repo_guard_verify(before)
        assert res["crossed"], f"{key} 变了却没被发现"
        assert any(word in f for f in res["crossed"]), f"{res} 里没说清是 {word}"
        assert res["unverified"] == [], "真的动过却被算成了「没核实过」"


def test_an_unrecorded_snapshot_says_unverified_not_clean(srv) -> None:
    """起跑时没记下来（git 不可用之类）→ **说「没核实过」**，
    绝不说「没问题」。一句假的安全结论比没有结论更糟。"""
    for empty in ({}, {"branch": ""}, None):
        res = srv._repo_guard_verify(empty)
        assert res["unverified"] and "没核实过" in res["unverified"][0], res
        # **而且它不是越界**（codex 轮 3）：把「没核实过」算进 crossed，
        # 回执标题就会写成「越界了」—— 对它的一次诬告。
        assert res["crossed"] == [], res


def test_failure_does_not_claim_the_repo_is_clean(srv, monkeypatch) -> None:
    """原来失败时写死一句「仓库没有被改动」—— 而超时打断的是进程，
    不是它已经做过的事（codex 轮 1 的 BLOCKING）。现在去真的看一眼。"""
    src = _SERVER.read_text("utf-8")
    assert "仓库没有被改动 —— 没跑完的那一轮不会留下半个提交" not in src, (
        "那句假承诺还在"
    )
    assert "_repo_touched_since" in src
    # HEAD 动了 → 说动过
    monkeypatch.setattr(srv, "_git", lambda *a: "bbb")
    assert srv._repo_touched_since({"head": "aaa"}) is True
    # 不知道起点 → **`None`，不是 `True`**（codex 轮 2 起改成三个值）：
    # 「没核实过」与「动过了」是两句不同的话，回执里也分开说。
    assert srv._repo_touched_since({}) is None


def test_a_second_request_is_really_queued_not_discarded(srv) -> None:
    """ADR-0107 决策 6 说「第二句排队」，原来的实现是**丢弃**并让他再说一遍
    —— 那是一句把工作退回给他的话（codex 轮 1 的 BLOCKING）。

    入队与出队必须成对存在：只入不出等于换一种方式丢掉它。
    """
    src = _SERVER.read_text("utf-8")
    assert "devQueue" in src, "队列没了"
    assert "_start_next_queued_build" in src, "只入队不出队 —— 那条要求永远不会跑"
    # 出队要接在落地对账的**两条**路径上：有东西刚落地、以及本来就没有在跑的。
    # 只接一条，队列会在另一条上永远停着。
    assert src.count("self._start_next_queued_build()") >= 2, (
        "出队只接了一条路径 —— 另一条上队列会永远停着"
    )
    # 排队那句话不许再让他「再说一次」。**只看他看得到的文案**，不看注释 ——
    # 注释里留着那句旧话正是为了记住这次的账（`_strip_comments` 同一姿态）。
    #
    # **只看排队那一段**：「切到那个窗口再说一次」是窗口拒绝的文案，与排队无关 ——
    # 宽到整个文件的断言会误伤它（第一版就误伤了）。
    queued_block = src.split('queue = doc.setdefault("devQueue"', 1)[1].split(
        "_save_feedback(doc)", 2
    )[1]
    code = "\n".join(
        ln for ln in queued_block.splitlines() if not ln.lstrip().startswith("#")
    )
    assert "再说一次" not in code, "排队那条回话还在让他重复一遍"
    assert "你不用再说一遍" in code, "排队之后要明确告诉他不用重复"


# --- 5. 「读不到」不许被说成「没问题」（codex 轮 2 的 BLOCKING） -------------- #


def test_git_failure_is_distinguishable_from_empty_output(srv, monkeypatch) -> None:
    """`_git` 失败返回 `None`，成功返回输出（可能是空串）。

    这两件事合成一个 `""` 的代价是具体的：`git status --porcelain` 输出空串是
    「工作树干净」，命令跑失败也是空串 —— 于是一个读不到的仓库拿到一张
    「没有改动」的回执。
    """
    monkeypatch.setattr(srv, "_git", lambda *a: None)
    assert srv._repo_touched_since({"head": "aaa"}) is None, (
        "git 读不到时说成了「没动过」"
    )
    monkeypatch.setattr(srv, "_git", lambda *a: "")
    assert srv._repo_touched_since({"head": ""}) is None, "起点缺失时该说没核实过"


def test_every_unreadable_field_is_reported_not_skipped(srv, monkeypatch) -> None:
    """上一版写的是 `if now.get(k) and now[k] != before[k]` —— 读不到就**静默跳过**，
    他拿到的回执与「核对过、没问题」一模一样（codex 轮 2 的 BLOCKING）。"""
    before = {"branch": "change/x", "head": "aaa", "main": "m1", "mainRemote": "r1"}
    for missing, label in (
        ("branch", "分支"),
        ("main", "本地 main"),
        ("mainRemote", "远端 main"),
    ):
        now = dict(before)
        now[missing] = None
        monkeypatch.setattr(srv, "_repo_guard_snapshot", lambda n=now: dict(n))
        res = srv._repo_guard_verify(before)
        assert res["unverified"], f"{missing} 读不到却什么都没说"
        assert any(label in f for f in res["unverified"]), res
        # **读不到 ≠ 越界**（codex 轮 3 的 BLOCKING）：它不许进 crossed，
        # 否则回执会把一次「远端暂时问不到」写成「它越界了」。
        assert res["crossed"] == [], f"{missing} 读不到被算成了越界：{res}"


def test_a_clean_run_still_reports_nothing(srv, monkeypatch) -> None:
    """全都读得到且没变 → 两类都空。收紧到「永远报点什么」会让真正的越界淹掉。"""
    before = {"branch": "change/x", "head": "aaa", "main": "m1", "mainRemote": "r1"}
    monkeypatch.setattr(srv, "_repo_guard_snapshot", lambda: dict(before))
    assert srv._repo_guard_verify(before) == {"crossed": [], "unverified": []}


def test_remote_main_is_asked_of_the_remote_not_the_tracking_ref(srv) -> None:
    """`refs/remotes/origin/main` 只是上一次 fetch 留下的影子：那一轮 push 了 main
    却没更新它，检查就什么都看不见（codex 轮 2 的 BLOCKING）。"""
    src = _SERVER.read_text("utf-8")
    assert "ls-remote" in src, "远端 main 还在问本地的跟踪 ref"
    # **只看代码行，不看注释。** 注释里提到 `refs/remotes/origin/main` 是对的 ——
    # 那句话解释的正是「为什么不用它」。上一版断言它在整段源码里都不许出现，
    # 于是这条守卫要么误伤自己的注释、要么（实际发生的）因为 fixture 被裸赋值
    # 污染而拿到一个 lambda，**永远不会红**（codex 轮 3 的 BLOCKING）。
    snap = inspect.getsource(srv._repo_guard_snapshot)
    code = "\n".join(ln for ln in snap.splitlines() if not ln.lstrip().startswith("#"))
    assert "refs/remotes/origin/main" not in code, "快照又去读跟踪 ref 了"
    assert "_git_remote_main()" in code, "快照没在问远端"
    # 而且这一条必须是在**真函数**上跑的 —— 前面的测试若用裸赋值替换了它，
    # 这里拿到的会是一个 lambda，断言就变成永远绿的装饰。
    assert snap.lstrip().startswith("def _repo_guard_snapshot"), (
        "拿到的不是真函数 —— 有测试用裸赋值污染了 module 级 fixture"
    )


def test_remote_main_unreadable_is_none_not_empty(srv, monkeypatch) -> None:
    monkeypatch.setattr(srv, "_git", lambda *a: None)
    assert srv._git_remote_main() is None
    monkeypatch.setattr(srv, "_git", lambda *a: "abc123\trefs/heads/main")
    assert srv._git_remote_main() == "abc123"


# --- 6. 接下来的指令不许在出队时丢掉（codex 轮 2 的 BLOCKING） ---------------- #


def test_the_queue_head_survives_when_nothing_can_run_it() -> None:
    """一个项目都没注册时那条指令不许消失 —— 屏幕上说过「排进队了，做完自动开始」。

    读源码而不是跑：出队要真的跑起来得有整个 handler 与 runstore。
    断言的是**顺序**这一件事，它正是上一版错的地方。
    """
    body = (
        _SERVER.read_text("utf-8")
        .split("def _start_next_queued_build", 1)[1]
        .split("\n    def ", 1)[0]
    )
    check_at = body.index("_current_project_for_queue")
    drop_at = body.index('doc["devQueue"] = q[1:]')
    assert check_at < drop_at, "还是先出队再检查起不起得来 —— 起不来那条就没了"


# --- 7. 「没核实过」也不许被说成「越界了」（codex 轮 3 的 BLOCKING） --------- #


def test_unverified_alone_never_claims_a_violation(srv, monkeypatch) -> None:
    """轮 2 修的是「没核实过不许读成没问题」，轮 3 修的是它的另一端：
    **也不许读成「出事了」**。远端一次读不到，不是它越界的证据。"""
    before = {"branch": "change/x", "head": "aaa", "main": "m1", "mainRemote": "r1"}
    now = dict(before)
    now["mainRemote"] = None  # 远端问不到
    monkeypatch.setattr(srv, "_repo_guard_snapshot", lambda: dict(now))
    really, note = srv._repo_guard_tail(before)
    assert really is False, "远端读不到被当成了越界"
    assert "没核实过" in note
    assert "越过了它该有的边界" not in note


def test_a_real_violation_does_claim_one(srv, monkeypatch) -> None:
    before = {"branch": "change/x", "head": "aaa", "main": "m1", "mainRemote": "r1"}
    now = dict(before)
    now["main"] = "MOVED"
    monkeypatch.setattr(srv, "_repo_guard_snapshot", lambda: dict(now))
    really, note = srv._repo_guard_tail(before)
    assert really is True
    assert "越过了它该有的边界" in note


def test_a_clean_run_says_nothing_at_all(srv, monkeypatch) -> None:
    before = {"branch": "change/x", "head": "aaa", "main": "m1", "mainRemote": "r1"}
    monkeypatch.setattr(srv, "_repo_guard_snapshot", lambda: dict(before))
    assert srv._repo_guard_tail(before) == (False, "")


def test_the_receipt_title_is_driven_only_by_real_violations(srv) -> None:
    """标题里那句「越界了」只能由 `_repo_guard_tail` 的第一个返回值决定。
    回到 `if crossed:`（清单非空就报警）就会把「没核实过」也算进去。"""
    src = _SERVER.read_text("utf-8")
    assert "really_crossed, note = _repo_guard_tail(" in src
    assert "if really_crossed:" in src
    # 旧写法不许回来
    code = "\n".join(ln for ln in src.splitlines() if not ln.lstrip().startswith("#"))
    assert "crossed = _repo_guard_verify(" not in code, "又把两类混成一个清单了"


# --- 8. 出队发生在起跑之后（codex 轮 3 的 BLOCKING） ------------------------- #


def test_the_queue_entry_outlives_a_crash_before_the_run_exists() -> None:
    """上一版先 `pop` + 存盘，**然后**才起跑 —— 两步之间进程挂掉，那条指令
    既不在队里、也没有任何记录。

    断言顺序：`_start_dev_proposal` 的调用必须在移除队首**之前**。
    """
    body = (
        _SERVER.read_text("utf-8")
        .split("def _start_next_queued_build", 1)[1]
        .split("\n    def ", 1)[0]
    )
    start_at = body.index("self._start_dev_proposal(")
    # 移除队首的那一步（重新读台账之后）
    drop_at = body.index('doc["devQueue"] = q[1:]')
    assert start_at < drop_at, "还是先出队再起跑 —— 中途挂掉那条指令就没了"
    # 而且不许再有「先 pop 再起跑」的写法
    assert "queue.pop(0)" not in body, "又回到破坏性出队了"
    # 摘掉的必须确认是自己那一条，不能盲删队首
    assert 'q[0].get("fromRun") == head.get("fromRun")' in body

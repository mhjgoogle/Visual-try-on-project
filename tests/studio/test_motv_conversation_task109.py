"""ADR-0089 —— 对话式 turn 的后端合同。

守的是四件会静默出错的事：

1. **事实是服务端读的**（决策 0）。executor 跑 ``claude -p --tools ""``，模型没有工具，
   所以「Agent 自己去后台收集信息」只能由服务端做。Prompt 里必须真的带着这个项目的
   创意/大纲/人物/镜头，否则对话会变成一个热情但什么都不知道的机器人。
2. **对话记录是投影**（决策 4/5）。run 记录才是权威事件；线程文件是它的可读形式，
   read 时对账。浏览器关掉、进程重启，答案仍然找得到。
3. **失败要说出来**（决策 6）。一次失败的 turn 渲染成沉默，看起来就是「助理无视了我」。
4. **不代替创作者写作品**（决策 2b）。这条路径只写线程文件，创意文档由前端那条编辑
   路径落地 —— 这里断言的是：一个 turn **没有**碰 canvas.json。
"""

from __future__ import annotations

import importlib.util
import json
import time
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SERVER = _REPO / "mockups" / "motv-workspace" / "server.py"


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location("motv_server_conv_109", _SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


#: THE REAL DOCUMENT SHAPE, not a convenient one.
#:
#: Shots are NOT a top-level ``draftShots`` array in a saved canvas — the structure
#: is ``production.episodes[].scenes[].shotIds`` and the titles live in a node
#: version's ``raw`` (the frontend derives the list from there). An earlier version
#: of this fixture invented the easy shape, so the guard passed while the assembled
#: facts told the creator 「镜头：还没有」 about a project with three shots — and the
#: assistant repeated it to his face (2026-08-27).
CANVAS = {
    "story": {
        "idea": "一间深夜不打烊的酒吧，和一个不肯把录音交出去的调酒师。",
        "versions": [{"v": 1}, {"v": 2}],
        "approved": 2,
    },
    "production": {
        "characters": [{"characterId": "c-1", "name": "林晚"}],
        "episodes": [
            {
                "episodeId": "e-1",
                "title": "迷雾入城",
                "scenes": [
                    {
                        "sceneId": "sc-1",
                        "title": "S01 酒吧 · 打烊后",
                        "shotIds": ["s-1", "s-2"],
                    }
                ],
            }
        ],
    },
    "nodes": [
        {
            "id": "n-storyboard",
            "versions": [
                {
                    "v": 1,
                    "raw": [
                        {"shotId": "s-1", "title": "招牌·雨夜", "duration": 6},
                        {"shotId": "s-2", "title": "吧台·林晚擦杯子", "duration": 6},
                    ],
                }
            ],
        }
    ],
}


@pytest.fixture()
def app(srv, tmp_path: Path, monkeypatch):
    monkeypatch.setattr(srv, "DATA_DIR", tmp_path / "legacy")
    monkeypatch.setattr(srv, "APP_DATA_DIR", tmp_path / "app-data")
    # A FRESH run store per test. The module-level singleton would otherwise carry
    # one test's runs into the next test's thread reconciliation — and the bug that
    # hides is real: two projects with the same name on one machine.
    monkeypatch.setattr(srv, "_RUNS", None)
    account = tmp_path / "account"
    root = account / "夜班沉默"
    (root / "studio").mkdir(parents=True)
    (root / "project.json").write_text(
        json.dumps({"name": "夜班沉默", "project_id": "夜班沉默"}), "utf-8"
    )
    (root / "studio" / "canvas.json").write_text(
        json.dumps(CANVAS, ensure_ascii=False), "utf-8"
    )
    a = srv._App(account)
    a._projects["夜班沉默"] = root
    return a


def _post(app, srv, name, payload, header=True):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {srv._SKILL_RUN_HEADER: "1"} if header else {}
    resp = app.handle_post(f"/api/projects/{name}/conversation", body, headers=headers)
    return resp.status, json.loads(resp.body.decode("utf-8"))


def _get(app, name, thread=None):
    q = f"?thread={thread}" if thread else ""
    resp = app.handle(f"/api/projects/{name}/conversation{q}")
    return resp.status, json.loads(resp.body.decode("utf-8"))


# --- 1. the facts the server gathers ---------------------------------------- #


def test_the_server_reads_the_project_and_puts_it_in_the_prompt(app, srv):
    facts = app._conv_facts("夜班沉默")
    assert "深夜不打烊的酒吧" in facts, "核心创意没进上下文，Agent 就不知道这是什么作品"
    assert "故事大纲：2 版" in facts and "已批准 v2" in facts
    assert "林晚" in facts
    assert "镜头：2 个" in facts, "镜头数必须从 scenes[].shotIds 数出来"
    assert "S01 酒吧 · 打烊后" in facts
    assert "招牌·雨夜" in facts, "标题要从节点版本的 raw 里查出来"
    prompt = srv._conv_prompt("把第二个镜头改得更冷一点", facts)
    assert "把第二个镜头改得更冷一点" in prompt
    assert "深夜不打烊的酒吧" in prompt
    # the answer contract must be in the prompt, or the parse below is a coin flip
    assert '"reply"' in prompt and '"edits"' in prompt


def test_a_project_with_no_saved_document_says_so_instead_of_pretending(app):
    app._projects["空项目"] = app.account_root / "空项目"
    (app.account_root / "空项目").mkdir(parents=True, exist_ok=True)
    facts = app._conv_facts("空项目")
    assert "我什么都不知道" in facts


def test_where_he_is_standing_reaches_the_prompt(app, srv):
    """产品负责人 2026-08-27:「不能根据我现在点的 tab 或者所在画面自动识别的是吗」。

    它确实不能 —— 前端早就把 `{module, shotId}` 送来了，run 记录里也存着，但 prompt 只拿
    了 message + 项目事实。送到却没用上的上下文比没送更糟：屏幕上看不出差别，回答却永远
    差一层，创作者说「这一镜」时它只能反问他在哪。"""
    facts = app._conv_facts(
        "夜班沉默",
        {
            "module": "shots",
            "moduleLabel": "分镜",
            "spaceLabel": "剧集制作",
            "shotId": "s-2",
            "shotTitle": "吧台 · 林晚擦杯子",
            "episodeLabel": "EP01 迷雾入城",
        },
    )
    assert "现在在看：" in facts
    assert "剧集制作 · 分镜" in facts
    assert "EP01 迷雾入城" in facts
    assert "吧台 · 林晚擦杯子" in facts
    # and the prompt tells the model what to DO with it
    prompt = srv._conv_prompt("这一镜下一步做什么？", facts)
    assert "现在在看" in prompt
    assert "不要反问他在哪" in prompt


def test_no_context_says_so_rather_than_inventing_a_location(app):
    facts = app._conv_facts("夜班沉默", None)
    assert "现在在看" not in facts, "没有上下文时不该编一个位置出来"
    facts2 = app._conv_facts("夜班沉默", {})
    assert "界面没有报告位置" in facts2


def test_a_hostile_context_cannot_bloat_the_prompt(app):
    """It rides into a prompt, so every field is bounded."""
    hostile = {"moduleLabel": "页" * 500, "shotTitle": "镜" * 500}
    facts = app._conv_facts("夜班沉默", hostile)
    assert len(facts) < 1000


# --- 2. the answer parser ---------------------------------------------------- #


def test_the_parser_accepts_json_wrapped_in_prose_and_fences(srv):
    out = srv._adapt_conversation(
        '好的，我理解了。```json\n{"reply": "已经改好", "edits": '
        '[{"kind": "brief.idea", "text": "新的创意"}]}\n```希望这样可以。'
    )
    assert out["reply"] == "已经改好"
    assert out["edits"] == [{"kind": "brief.idea", "text": "新的创意"}]


def test_an_unsupported_edit_is_KEPT_not_dropped(srv):
    out = srv._adapt_conversation(
        '{"reply": "我想重命名项目", "edits": '
        '[{"kind": "project.rename", "text": "新名字"}]}'
    )
    assert out["edits"] == []
    assert out["unsupported"] == [{"kind": "project.rename", "text": "新名字"}]


@pytest.mark.parametrize(
    "answer",
    ["没有 JSON 的一段话", '{"edits": []}', '{"reply": ""}', '{"reply": 1}'],
)
def test_a_malformed_answer_is_a_failed_run_never_a_half_kept_one(srv, answer):
    with pytest.raises(ValueError):
        srv._adapt_conversation(answer)


# --- 3. the endpoint --------------------------------------------------------- #


def test_the_turn_needs_the_csrf_header(app, srv):
    status, out = _post(app, srv, "夜班沉默", {"message": "你好"}, header=False)
    assert status == 403
    assert out["error"]["category"] == "forbidden"


@pytest.mark.parametrize("payload", [{}, {"message": "  "}, {"message": 5}])
def test_an_empty_message_is_refused(app, srv, payload):
    status, out = _post(app, srv, "夜班沉默", payload)
    assert status == 400


def test_an_unknown_project_is_404(app, srv):
    status, _ = _post(app, srv, "不存在", {"message": "你好"})
    assert status == 404


def test_a_turn_records_what_he_said_and_hands_back_a_run(app, srv):
    status, out = _post(app, srv, "夜班沉默", {"message": "把第二个镜头改冷一点"})
    assert status == 202, out
    assert out["turn"]["role"] == "user"
    assert out["turn"]["text"] == "把第二个镜头改冷一点"
    assert out["run"]["run_id"]
    assert out["threadStored"] is True
    # and it is READABLE back, because a question whose answer arrives later must
    # still have its question on screen
    status, thread = _get(app, "夜班沉默")
    assert status == 200
    assert [x["role"] for x in thread["turns"]] == ["user"]


def test_the_turn_does_NOT_write_the_creative_document(app, srv):
    """决策 2b: this path never touches canvas.json. If it ever does, the browser's
    own copy and the file will disagree and the creator will lose an edit."""
    canvas = app._projects["夜班沉默"] / "studio" / "canvas.json"
    before = canvas.read_bytes()
    _post(app, srv, "夜班沉默", {"message": "改一下创意"})
    assert canvas.read_bytes() == before


# --- 4. the thread is a projection of the runs ------------------------------- #


def _await(srv, run_id, timeout=20.0):
    """Wait for the REAL worker to land the run. Polling the store (rather than
    calling a private finisher) is what makes this an end-to-end check of
    create → worker → parser → outputs."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        run = srv.runs().get(run_id, project="夜班沉默")
        if run.get("status") not in ("queued", "running", "cancelling"):
            return run
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} 没有在 {timeout}s 内结束")


def test_a_finished_run_lands_in_the_thread_on_READ(app, srv, monkeypatch):
    # the executor is stubbed, the WORKER is real: this is the whole path
    monkeypatch.setattr(
        srv,
        "_run_executor",
        lambda *a, **k: (
            '{"reply": "第二个镜头缺一张主帧图", "edits": '
            '[{"kind": "brief.idea", "text": "更冷的酒吧"}]}',
            "claude-x",
        ),
    )
    _, out = _post(app, srv, "夜班沉默", {"message": "帮我看看第二个镜头"})
    run_id = out["run"]["run_id"]
    run = _await(srv, run_id)
    assert run["status"] == "succeeded", run.get("error")

    status, thread = _get(app, "夜班沉默")
    assert status == 200
    assert [x["role"] for x in thread["turns"]] == ["user", "agent"], (
        "答案没有落进线程 —— 关掉页面就等于丢了"
    )
    agent = thread["turns"][-1]
    assert agent["text"] == "第二个镜头缺一张主帧图"
    assert agent["runId"] == run_id
    assert agent["edits"] == [{"kind": "brief.idea", "text": "更冷的酒吧"}]
    # reconciling again must not duplicate it
    _get(app, "夜班沉默")
    _, thread2 = _get(app, "夜班沉默")
    assert [x["role"] for x in thread2["turns"]] == ["user", "agent"]


def test_a_failed_run_says_why_instead_of_going_silent(app, srv, monkeypatch):
    def boom(*a, **k):
        raise FileNotFoundError("claude 不在 PATH 上")

    monkeypatch.setattr(srv, "_run_executor", boom)
    _, out = _post(app, srv, "夜班沉默", {"message": "试一个会失败的"})
    run_id = out["run"]["run_id"]
    run = _await(srv, run_id)
    assert run["status"] == "failed"
    _, thread = _get(app, "夜班沉默")
    agent = thread["turns"][-1]
    assert agent["role"] == "agent"
    assert agent["status"] != "succeeded"
    # The store normalises a foreign exception string into its own reason (it will
    # not echo arbitrary text), so what the thread must carry is a REAL reason and
    # its category — never just the word 「failed」（决策 6）。
    assert agent["failureCategory"] == "unavailable"
    assert agent["failure"] and agent["failure"] != agent["status"], (
        "失败必须说出原因，不能渲染成沉默、也不能只回显状态词"
    )
    assert "执行器" in agent["failure"]


def test_a_malformed_answer_reaches_the_creator_as_a_failure(app, srv, monkeypatch):
    """A model that ignores the output contract must not become a blank reply."""
    monkeypatch.setattr(
        srv, "_run_executor", lambda *a, **k: ("我觉得挺好的", "claude-x")
    )
    _, out = _post(app, srv, "夜班沉默", {"message": "随便说点什么"})
    run = _await(srv, out["run"]["run_id"])
    assert run["status"] == "failed"
    _, thread = _get(app, "夜班沉默")
    assert thread["turns"][-1]["failure"]


# --- 5. 每个页面一条对话线（REQ-004 v3 / ADR-0089 决策 4b）--------------------- #


def test_two_pages_keep_two_conversations(app, srv):
    """产品负责人 2026-08-27:「我可以打开不同的页面都有新的对话框吗。历史内容保存在
    不同对话框」。混在一条流里，越往后越读不出这句话当时在说哪一块。"""
    _post(
        app,
        srv,
        "夜班沉默",
        {"message": "分镜这边怎么排", "context": {"module": "shots"}},
    )
    _post(
        app,
        srv,
        "夜班沉默",
        {"message": "资产库里缺什么", "context": {"module": "assets"}},
    )

    status, shots = _get(app, "夜班沉默", "shots")
    assert status == 200
    assert [x["text"] for x in shots["turns"]] == ["分镜这边怎么排"]
    assert shots["thread"] == "shots"
    # and the OTHER page's history is reported, not hidden
    assert shots["threads"].get("assets") == 1

    _, assets = _get(app, "夜班沉默", "assets")
    assert [x["text"] for x in assets["turns"]] == ["资产库里缺什么"]


def test_a_turn_with_no_page_lands_in_the_project_thread(app, srv):
    _, out = _post(app, srv, "夜班沉默", {"message": "随便问问"})
    assert out["thread"] == "__project__"
    _, d = _get(app, "夜班沉默")
    assert [x["text"] for x in d["turns"]] == ["随便问问"]


def test_the_answer_lands_in_the_page_it_was_ASKED_on(app, srv, monkeypatch):
    """归线依据是 run 自己记着的 context（纪律 1），不是前端事后声称的 —— 创作者按下发送
    之后完全可能已经换了页。"""
    monkeypatch.setattr(
        srv,
        "_run_executor",
        lambda *a, **k: ('{"reply": "这一场三个镜头", "edits": []}', "claude-x"),
    )
    _, out = _post(
        app,
        srv,
        "夜班沉默",
        {"message": "这一场几个镜头", "context": {"module": "shots"}},
    )
    _await(srv, out["run"]["run_id"])
    # read a DIFFERENT page first — it must not pick up the answer
    _, assets = _get(app, "夜班沉默", "assets")
    assert assets["turns"] == []
    _, shots = _get(app, "夜班沉默", "shots")
    assert [x["role"] for x in shots["turns"]] == ["user", "agent"]
    assert shots["turns"][-1]["text"] == "这一场三个镜头"


def test_a_page_key_from_a_hostile_client_cannot_escape(app, srv):
    _, out = _post(
        app,
        srv,
        "夜班沉默",
        {"message": "x", "context": {"module": "../../etc/passwd" + "A" * 200}},
    )
    key = out["thread"]
    assert "/" not in key and ".." not in key
    assert len(key) <= 64


def test_the_conversation_from_BEFORE_per_page_threads_is_still_readable(app, srv):
    """旧数据不丢（纪律 2）：v1 的单条 turns 迁进 __legacy__，而不是被丢掉、也不是靠猜
    分配到某一页 —— 那些 turn 早于分页存在，替它们指定页面就是编造历史。"""
    conv = app._projects["夜班沉默"] / "studio" / "conversation.json"
    conv.write_text(
        json.dumps(
            {
                "version": 1,
                "turns": [
                    {"turnId": "u-old", "role": "user", "text": "分页之前说的话"}
                ],
            },
            ensure_ascii=False,
        ),
        "utf-8",
    )
    _, legacy = _get(app, "夜班沉默", "__legacy__")
    assert [x["text"] for x in legacy["turns"]] == ["分页之前说的话"]
    # and a new page starts empty rather than inheriting it
    _, shots = _get(app, "夜班沉默", "shots")
    assert shots["turns"] == []

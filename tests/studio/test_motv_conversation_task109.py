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
        # 创意简报的真实形状：不断更新的草稿 + 版本链 + 一个 active 指针。
        # 「类型」就住在这里 —— 它缺席时，助理对着一个类型写着「悬疑」的项目回答
        # 「我这边看不到类型/题材这个字段」（产品负责人 2026-08-29）。
        "brief": {
            "draft": {
                "genre": "悬疑",
                "tone": "冷",
                "form": "",
                "episodeDuration": "",
                "totalDuration": "",
                "notes": "",
                "targetEpisodes": 3,
            },
            "versions": [
                {"v": 1, "fields": {"genre": "都市", "tone": "暖", "notes": ""}},
                {
                    "v": 2,
                    "fields": {"genre": "悬疑", "tone": "冷", "targetEpisodes": 3},
                },
            ],
            "active": 2,
        },
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


def test_an_edit_is_KEPT_not_dropped_even_when_nobody_can_apply_it(srv):
    """「做得到 / 做不到」的判定搬到了前端（动作表在那儿），但**保留**这条没变：
    一个被静默丢弃的意图，看起来就是「它答应了然后什么都没干」。"""
    out = srv._adapt_conversation(
        '{"reply": "我想重命名项目", "edits": '
        '[{"kind": "project.rename", "text": "新名字"}]}'
    )
    assert out["edits"] == [{"kind": "project.rename", "text": "新名字"}]
    assert out["unsupported"] == []


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


# --- 6. 创意简报是事实的一部分（TASK-111 / 产品负责人 2026-08-29） ------------ #


def test_the_brief_fields_are_facts_the_assistant_can_see(app):
    """他问「帮我改类型」时，助理答「我这边看不到类型/题材这个字段」——
    字段就在文档里，是装配事实时漏了它。"""
    facts = app._conv_facts("夜班沉默", None)
    assert "类型/题材：悬疑" in facts
    assert "基调：冷" in facts
    assert "目标集数：3" in facts
    # 报的是 ACTIVE 那一版，不是第一版，也不是未版本化的草稿
    assert "v2" in facts
    assert "都市" not in facts


def test_a_brief_with_no_revision_yet_is_reported_as_a_draft(app, tmp_path):
    canvas = tmp_path / "account" / "夜班沉默" / "studio" / "canvas.json"
    doc = json.loads(canvas.read_text("utf-8"))
    doc["story"]["brief"]["versions"] = []
    doc["story"]["brief"]["active"] = None
    canvas.write_text(json.dumps(doc, ensure_ascii=False), "utf-8")
    facts = app._conv_facts("夜班沉默", None)
    assert "草稿" in facts
    assert "类型/题材：悬疑" in facts


def test_an_empty_brief_says_so_instead_of_going_silent(app, tmp_path):
    canvas = tmp_path / "account" / "夜班沉默" / "studio" / "canvas.json"
    doc = json.loads(canvas.read_text("utf-8"))
    doc["story"]["brief"] = {"draft": {}, "versions": [], "active": None}
    canvas.write_text(json.dumps(doc, ensure_ascii=False), "utf-8")
    facts = app._conv_facts("夜班沉默", None)
    assert "创意简报：字段都还是空的" in facts


def test_the_server_bounds_the_shape_not_the_vocabulary(srv):
    """白名单去哪了：动作表归**前端**（那些按钮在它那儿），服务端再抄一份必然漂移成
    「提示里说能做、落地却没有」。所以这里守的是**形状** —— 值有界、最多一层结构，
    任意嵌套的模型输出不许原样流进他的 canvas.json。"""
    out = srv._conv_shallow_values(
        {
            "genre": "  悬疑  ",
            "targetEpisodes": 24,
            "deep": {"who": "林照", "nested": {"太深": "不要"}},
            "big": "x" * 5000,
            "": "空键",
            7: "非字符串键",
        }
    )
    assert out["genre"] == "悬疑"
    assert out["targetEpisodes"] == 24
    assert out["deep"] == {"who": "林照"}, "第二层结构必须被摊掉"
    assert len(out["big"]) == srv._CONV_VALUE_MAX
    assert "" not in out and 7 not in out


@pytest.mark.parametrize("raw", ["不是对象", None, 7, []])
def test_a_non_object_payload_is_simply_empty(srv, raw):
    assert srv._conv_shallow_values(raw) == {}


def test_any_action_the_frontend_declared_survives_the_adapter(srv):
    """产品负责人 2026-08-29:「用户能够操作的前端的agent都应该可以操作。」

    所以适配器不再枚举 kind —— 它带着 kind 与数据原样交给前端，由前端的动作表判定。
    """
    out = srv._adapt_conversation(
        json.dumps(
            {
                "reply": "已经改好了。",
                "edits": [
                    {
                        "kind": "outline.fields",
                        "text": "把一句话故事写实",
                        "fields": {"logline": "被抹除的人在终局世界里找回自己"},
                    },
                    {
                        "kind": "plan.entry",
                        "text": "改 EP03 标题",
                        "args": {
                            "episodeId": "ep-3",
                            "field": "title",
                            "value": "价码",
                        },
                    },
                ],
            },
            ensure_ascii=False,
        )
    )
    kinds = [e["kind"] for e in out["edits"]]
    assert kinds == ["outline.fields", "plan.entry"]
    assert out["edits"][0]["fields"]["logline"].startswith("被抹除")
    assert out["edits"][1]["args"]["episodeId"] == "ep-3"


def test_note_is_still_the_cannot_do_bucket(srv):
    out = srv._adapt_conversation(
        json.dumps(
            {"reply": "做不到", "edits": [{"kind": "note", "text": "帮我发布到抖音"}]},
            ensure_ascii=False,
        )
    )
    assert out["edits"] == []
    assert out["unsupported"][0]["text"] == "帮我发布到抖音"


def test_feedback_carries_what_he_expected(srv):
    out = srv._adapt_conversation(
        json.dumps(
            {
                "reply": "记下了",
                "edits": [
                    {
                        "kind": "feedback.ui",
                        "text": "版本太多了，看不过来",
                        "expect": "只显示最新版",
                    }
                ],
            },
            ensure_ascii=False,
        )
    )
    assert out["edits"][0]["kind"] == "feedback.ui"
    assert out["edits"][0]["expect"] == "只显示最新版"


def test_the_prompt_vocabulary_comes_from_the_frontend_catalog(srv):
    """提示词里的动作表**不是服务端写死的**，是这一轮前端送来的那份。"""
    prompt = srv._conv_prompt(
        "帮我改类型",
        "项目：夜班沉默",
        [
            {
                "id": "brief.fields",
                "label": "改创意简报",
                "fields": {"genre": "类型/题材"},
            },
            {
                "id": "plan.entry",
                "label": "改分集规划的一条",
                "args": {"field": "字段名"},
            },
        ],
    )
    assert "brief.fields（改创意简报）" in prompt
    assert "genre=类型/题材" in prompt
    assert "plan.entry（改分集规划的一条）" in prompt
    # 两种服务端自己处理的仍然常驻
    assert "feedback.ui" in prompt
    assert "note（" in prompt
    # 「会被自动落到作品上」必须写在提示里：模型据此决定要不要给 edits
    assert "自动落到作品上" in prompt


def test_a_hostile_catalog_cannot_bloat_the_prompt(srv):
    actions = [
        {"id": "x" * 500, "label": "y" * 500, "fields": {"f": "z" * 500}}
        for _ in range(200)
    ]
    text = srv._conv_actions_text(actions)
    assert len(text.splitlines()) == srv._CONV_ACTIONS_MAX
    first = text.splitlines()[0]
    assert "x" * (srv._CONV_ACTION_ID_MAX + 1) not in first
    assert "y" * (srv._CONV_ACTION_LABEL_MAX + 1) not in first


def test_a_catalog_that_is_not_a_list_of_actions_is_simply_empty(srv):
    assert srv._conv_actions_text(None) == ""
    assert (
        srv._conv_actions_text(["不是对象", {"label": "没有 id"}, {"id": "  "}]) == ""
    )


# --- 8. 意见台账（REQ-006：他反馈，后端接得到） ------------------------------ #


def test_feedback_lands_in_the_account_ledger_not_the_project(app, srv, tmp_path):
    rows = [
        {"kind": "feedback.ui", "text": "这个页面版本太多了", "expect": "只看最新版"}
    ]
    landed = srv._file_feedback(
        "夜班沉默", "run-1", {"moduleLabel": "项目与创意"}, rows
    )
    assert "已记下这条意见（#1）" in landed[0]["detail"]

    doc = json.loads((srv.APP_DATA_DIR / "feedback.json").read_text("utf-8"))
    item = doc["items"][0]
    assert item["text"] == "这个页面版本太多了"
    assert item["expect"] == "只看最新版"
    assert item["page"] == "项目与创意"
    assert item["project"] == "夜班沉默"
    assert item["status"] == "new"
    # 它不进任何项目根 —— 换个项目也该看得见自己提过什么
    assert not (tmp_path / "account" / "夜班沉默" / "studio" / "feedback.json").exists()


def test_filing_the_same_run_twice_does_not_duplicate(app, srv):
    """线程是读时对账的投影 —— 同一条 run 会被反复经过。"""
    rows = [{"kind": "feedback.ui", "text": "版本太多了"}]
    a = srv._file_feedback("夜班沉默", "run-1", None, rows)
    b = srv._file_feedback("夜班沉默", "run-1", None, rows)
    doc = json.loads((srv.APP_DATA_DIR / "feedback.json").read_text("utf-8"))
    assert len(doc["items"]) == 1
    assert a == b


def test_a_hostile_feedback_row_is_bounded(app, srv):
    rows = [{"kind": "feedback.ui", "text": "x" * 9000, "expect": "y" * 9000}]
    srv._file_feedback("夜班沉默", "run-2", None, rows)
    item = json.loads((srv.APP_DATA_DIR / "feedback.json").read_text("utf-8"))["items"][
        0
    ]
    assert len(item["text"]) == srv._CONV_VALUE_MAX
    assert len(item["expect"]) == srv._CONV_VALUE_MAX


def test_an_empty_feedback_row_files_nothing(app, srv):
    assert (
        srv._file_feedback(
            "夜班沉默", "run-3", None, [{"kind": "feedback.ui", "text": "  "}]
        )
        == []
    )


def test_the_ledger_is_readable_over_http(app, srv):
    srv._file_feedback(
        "夜班沉默",
        "run-4",
        {"moduleLabel": "故事大纲"},
        [{"kind": "feedback.ui", "text": "大纲页字太小"}],
    )
    resp = app.handle("/api/feedback")
    assert resp.status == 200
    out = json.loads(resp.body.decode("utf-8"))
    assert out["total"] == 1
    assert out["items"][0]["text"] == "大纲页字太小"


# --- 9. 提案回路：开发 → 他 → 开发（REQ-006 判据 6） ------------------------- #


def _propose(srv, title, body=""):
    doc = srv._load_feedback()
    doc["proposals"].append(
        {
            "id": len(doc["proposals"]) + 1,
            "createdAt": "2026-08-29T00:00:00+00:00",
            "title": title,
            "body": body,
            "decision": None,
        }
    )
    srv._save_feedback(doc)
    return doc["proposals"][-1]["id"]


def test_open_proposals_reach_the_facts_so_it_can_bring_them_up(app, srv):
    """「Agent 能看到提案」不能靠他先问 —— 提案主动进事实。"""
    _propose(srv, "把版本行收起来", "旧版本收进「历史版本」，一个都不删")
    facts = app._conv_facts("夜班沉默", None)
    assert "开发给你的修改提案（1 条还没答复）" in facts
    assert "把版本行收起来" in facts
    assert "旧版本收进" in facts


def test_an_answered_proposal_stops_taking_up_room(app, srv):
    pid = _propose(srv, "已经答复过的那条")
    srv._decide_proposal(pid, "approved", "行", "2026-08-29T01:00:00+00:00")
    assert "开发给你的修改提案" not in app._conv_facts("夜班沉默", None)


def test_his_answer_lands_on_the_proposal(app, srv):
    pid = _propose(srv, "把版本行收起来")
    res = srv._decide_proposal(
        pid, "changes", "同意，但要能一键全展开", "2026-08-29T02:00:00+00:00"
    )
    assert res["ok"] is True
    rec = srv._load_feedback()["proposals"][0]
    assert rec["decision"]["verdict"] == "changes"
    assert rec["decision"]["note"] == "同意，但要能一键全展开"


@pytest.mark.parametrize("verdict", ["approved", "rejected", "changes"])
def test_the_three_answers_he_can_give(app, srv, verdict):
    pid = _propose(srv, f"提案 {verdict}")
    assert (
        srv._decide_proposal(pid, verdict, "", "2026-08-29T03:00:00+00:00")["ok"]
        is True
    )


def test_a_nonsense_verdict_is_refused(app, srv):
    pid = _propose(srv, "提案")
    res = srv._decide_proposal(pid, "maybe", "", "2026-08-29T03:00:00+00:00")
    assert res["ok"] is False
    assert "不认识的答复" in res["error"]


def test_answering_twice_is_refused_rather_than_overwriting_him(app, srv):
    pid = _propose(srv, "提案")
    srv._decide_proposal(pid, "approved", "行", "2026-08-29T03:00:00+00:00")
    res = srv._decide_proposal(pid, "rejected", "反悔", "2026-08-29T04:00:00+00:00")
    assert res["ok"] is False
    assert "已经答复过" in res["error"]
    assert srv._load_feedback()["proposals"][0]["decision"]["verdict"] == "approved"


def test_an_unknown_proposal_number_says_so(app, srv):
    res = srv._decide_proposal(99, "approved", "", "2026-08-29T03:00:00+00:00")
    assert res["ok"] is False
    assert "没有第 99 号提案" in res["error"]


def test_the_decision_edit_survives_the_adapter_with_its_args(srv):
    out = srv._adapt_conversation(
        json.dumps(
            {
                "reply": "已经替你答复了",
                "edits": [
                    {
                        "kind": "proposal.decide",
                        "text": "答复提案 #1",
                        "args": {"id": 1, "verdict": "changes", "note": "要能一键展开"},
                    }
                ],
            },
            ensure_ascii=False,
        )
    )
    assert out["edits"][0]["args"] == {
        "id": "1",
        "verdict": "changes",
        "note": "要能一键展开",
    }


def test_the_prompt_teaches_it_how_to_answer_a_proposal(srv):
    prompt = srv._conv_prompt("开发有什么要我拍板的", "项目：夜班沉默", [])
    assert "proposal.decide" in prompt
    assert "approved/rejected/changes" in prompt
    # 主动告诉他，而不是等他问
    assert "主动告诉他" in prompt


def test_the_ledger_endpoint_reports_how_many_await_him(app, srv):
    _propose(srv, "一")
    pid = _propose(srv, "二")
    srv._decide_proposal(pid, "approved", "", "2026-08-29T05:00:00+00:00")
    out = json.loads(app.handle("/api/feedback").body.decode("utf-8"))
    assert len(out["proposals"]) == 2
    assert out["openProposals"] == 1


# --- 10. 两个窗口：作品 / 开发（TASK-117 · REQ-006 v3 判据 7） ---------------- #


def _agent_turn(read: dict, run_id: str) -> dict:
    """那一轮的**回答**。用户那条也带着 runId（答案要挂回它的问题），所以必须挑角色。"""
    hits = [
        t for t in read["turns"] if t.get("runId") == run_id and t["role"] == "agent"
    ]
    assert hits, f"线程里没有 {run_id} 的回答"
    return hits[0]


def test_the_feedback_window_gets_a_prompt_with_no_work_actions_in_it(srv):
    """两个窗口的意义就是「在这个窗口里我的东西不会被改」，所以词汇表本身就是那道闸。"""
    catalog = [
        {"id": "brief.fields", "label": "改创意简报", "fields": {"genre": "类型"}}
    ]
    work = srv._conv_prompt("改类型", "项目：X", catalog, "work")
    fb = srv._conv_prompt("这页不好用", "项目：X", catalog, "feedback")
    assert "brief.fields" in work
    assert "brief.fields" not in fb
    assert "不许改动作品" in fb
    assert "feedback.ui" in fb and "proposal.decide" in fb


def test_intent_defaults_to_work(srv):
    assert srv._conv_intent(None) == "work"
    assert srv._conv_intent({"module": "brief"}) == "work"
    assert srv._conv_intent({"intent": "feedback"}) == "feedback"
    assert srv._conv_intent({"intent": "乱写"}) == "work"


def test_a_work_edit_from_the_feedback_window_never_lands(app, srv, monkeypatch):
    """强制在**落地**这一步，不靠模型自觉：模型仍然可能自己编一个 kind。"""
    answer = json.dumps(
        {
            "reply": "顺手把类型也改了",
            "edits": [
                {"kind": "brief.fields", "text": "改类型", "fields": {"genre": "悬疑"}},
                {"kind": "feedback.ui", "text": "这页太挤", "expect": "简约一点"},
            ],
        },
        ensure_ascii=False,
    )
    monkeypatch.setattr(srv, "_run_executor", lambda *a, **k: (answer, "claude-x"))
    status, out = _post(
        app,
        srv,
        "夜班沉默",
        {"message": "这页太挤了", "context": {"intent": "feedback", "module": "brief"}},
    )
    assert status == 202, out
    run_id = out["run"]["run_id"]
    _await(srv, run_id)
    _, read = _get(app, "夜班沉默", "__feedback__")
    turn = _agent_turn(read, run_id)
    assert [e["kind"] for e in turn["edits"]] == ["feedback.ui"]
    # 被筛掉的那条如实告诉他，而不是静默消失
    dropped = [e for e in turn["unsupported"] if e["kind"] == "brief.fields"]
    assert dropped and "切回「作品」窗口" in dropped[0]["text"]


def test_the_work_window_is_unaffected(app, srv, monkeypatch):
    answer = json.dumps(
        {
            "reply": "改好了",
            "edits": [
                {"kind": "brief.fields", "text": "改类型", "fields": {"genre": "悬疑"}}
            ],
        },
        ensure_ascii=False,
    )
    monkeypatch.setattr(srv, "_run_executor", lambda *a, **k: (answer, "claude-x"))
    status, out = _post(
        app,
        srv,
        "夜班沉默",
        {"message": "把类型改成悬疑", "context": {"module": "brief"}},
    )
    run_id = out["run"]["run_id"]
    _await(srv, run_id)
    _, read = _get(app, "夜班沉默", "brief")
    turn = _agent_turn(read, run_id)
    assert [e["kind"] for e in turn["edits"]] == ["brief.fields"]


def test_the_two_windows_keep_two_threads(app, srv, monkeypatch):
    answer = json.dumps({"reply": "好", "edits": []}, ensure_ascii=False)
    monkeypatch.setattr(srv, "_run_executor", lambda *a, **k: (answer, "claude-x"))
    _post(
        app,
        srv,
        "夜班沉默",
        {"message": "作品那边说的", "context": {"module": "brief"}},
    )
    _post(
        app,
        srv,
        "夜班沉默",
        {
            "message": "开发那边说的",
            "context": {"intent": "feedback", "module": "brief"},
        },
    )
    _, work = _get(app, "夜班沉默", "brief")
    _, fb = _get(app, "夜班沉默", "__feedback__")
    assert [t["text"] for t in work["turns"] if t["role"] == "user"] == ["作品那边说的"]
    assert [t["text"] for t in fb["turns"] if t["role"] == "user"] == ["开发那边说的"]


def test_the_feedback_window_still_knows_where_he_is(app, srv):
    """「开发」窗口里他说「这一页」也要有所指。

    开发看得到的只有这条意见，看不到他的屏幕。
    """
    prompt = srv._conv_prompt(
        "这一页左边太挤",
        app._conv_facts(
            "夜班沉默", {"moduleLabel": "故事大纲", "spaceLabel": "故事开发"}
        ),
        [],
        "feedback",
    )
    assert "现在在看：故事开发 · 故事大纲" in prompt
    assert "不要反问他在哪" in prompt
    assert "写进 text" in prompt


# --- 11. 前端触发「让开发出个方案」（TASK-118 · REQ-006 v4 判据 8） ----------- #


def test_a_dev_request_starts_a_real_run_and_shows_a_pending_proposal(app, srv):
    landed = app._start_dev_proposal(
        "夜班沉默", "run-ask", "把左侧导航精简成三个入口", {"moduleLabel": "项目与创意"}
    )
    assert landed["error"] == ""
    assert "正在写方案" in landed["detail"]
    doc = srv._load_feedback()
    item = doc["proposals"][-1]
    assert item["pending"] is True
    assert item["devRun"]
    assert item["fromRun"] == "run-ask"
    # 他立刻看得到「开发正在写方案」，而不是等一分钟看着什么都没有
    assert "开发正在写方案" in item["title"]


def test_asking_twice_from_the_same_turn_does_not_start_two_runs(app, srv):
    app._start_dev_proposal("夜班沉默", "run-ask", "精简导航", None)
    again = app._start_dev_proposal("夜班沉默", "run-ask", "精简导航", None)
    assert "已经在给方案了" in again["detail"]
    assert len(srv._load_feedback()["proposals"]) == 1


def test_an_empty_ask_is_refused_instead_of_starting_a_run(app, srv):
    out = app._start_dev_proposal("夜班沉默", "run-ask", "   ", None)
    assert out["error"] == "没说要开发做什么"
    assert srv._load_feedback()["proposals"] == []


def test_the_finished_plan_lands_on_its_placeholder(app, srv, monkeypatch):
    monkeypatch.setattr(
        srv,
        "_run_executor",
        lambda *a, **k: (
            '{"title": "左侧只留三个入口", "body": "改哪儿：故事开发的左栏…"}',
            "claude-x",
        ),
    )
    app._start_dev_proposal("夜班沉默", "run-ask", "精简导航", None)
    dev_run = srv._load_feedback()["proposals"][0]["devRun"]
    _await(srv, dev_run)
    app._land_dev_proposals()
    item = srv._load_feedback()["proposals"][0]
    assert item["pending"] is False
    assert item["title"] == "左侧只留三个入口"
    assert item["body"].startswith("改哪儿")
    # 它现在是一条正常的待拍板提案
    assert item["decision"] is None


def test_a_failed_plan_says_so_instead_of_hanging_forever(app, srv, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("claude 不见了")

    monkeypatch.setattr(srv, "_run_executor", boom)
    app._start_dev_proposal("夜班沉默", "run-ask", "精简导航", None)
    dev_run = srv._load_feedback()["proposals"][0]["devRun"]
    _await(srv, dev_run)
    app._land_dev_proposals()
    item = srv._load_feedback()["proposals"][0]
    assert item["pending"] is False
    assert "方案没写成" in item["title"]
    assert "再试一次" in item["body"]


def test_the_plan_parser_is_fail_closed(srv):
    ok = srv._adapt_dev_proposal('{"title": "标题", "body": "正文"}')
    assert ok == {"title": "标题", "body": "正文"}
    for bad in [
        '{"title": "只有标题"}',
        '{"body": "只有正文"}',
        "没有 JSON",
        '{"title": "", "body": "x"}',
    ]:
        with pytest.raises(ValueError):
            srv._adapt_dev_proposal(bad)


def test_the_feedback_window_knows_it_can_ask_for_a_plan(srv):
    prompt = srv._conv_prompt("你能让后端现在改吗", "项目：夜班沉默", [], "feedback")
    assert "dev.request" in prompt
    # 它必须知道出来的是方案而不是改动 —— 否则它会替开发承诺代码已经改了
    assert "不要承诺代码已经改了" in prompt


# --- 12. 定位情报（TASK-120）：让后端更快找到那一页 ------------------------- #


def test_an_opinion_carries_a_structured_locator(app, srv):
    """产品负责人 2026-08-29：「应该加入更详细的页面定位情报…
    让你更快的理解问题和解决问题」。

    不指望模型记得写进句子里 —— 结构化存下来。
    """
    srv._file_feedback(
        "夜班沉默",
        "run-w",
        {
            "spaceLabel": "剧集制作",
            "moduleLabel": "分镜设计",
            "module": "storyboard",
            "section": "shots",
            "route": "#/夜班沉默/episode/storyboard/shots?ep=ep-1",
            "source": "src/ui/storyboard.js",
            "episodeLabel": "EP01 迷雾入城",
            "shotTitle": "招牌 · 雨夜",
        },
        [{"kind": "feedback.ui", "text": "左边那排太挤"}],
    )
    w = srv._load_feedback()["items"][0]["where"]
    assert w["page"] == "剧集制作 · 分镜设计"
    assert w["module"] == "storyboard"
    assert w["section"] == "shots"
    assert w["source"] == "src/ui/storyboard.js"
    assert w["route"].startswith("#/")
    assert w["shotTitle"] == "招牌 · 雨夜"


def test_the_locator_is_bounded_and_survives_a_hostile_context(srv):
    w = srv._conv_where(
        {
            "moduleLabel": "页" * 500,
            "route": "#" * 5000,
            "source": "s" * 500,
            "shotId": "x" * 500,
            "bogus": "不该出现",
        }
    )
    assert len(w["moduleLabel"]) == 80
    assert len(w["route"]) == 300
    assert len(w["source"]) == 200
    assert len(w["shotId"]) == 64
    assert "bogus" not in w


def test_no_context_means_an_empty_locator_not_an_invented_one(srv):
    assert srv._conv_where(None) == {}
    assert srv._conv_where("不是对象") == {}
    # 只有页面没有空间时，page 就是页面本身
    assert srv._conv_where({"moduleLabel": "分镜设计"})["page"] == "分镜设计"


# --- 13. 方案要看得见、答过的不许再问（TASK-121） ---------------------------- #


def test_the_thread_read_carries_the_proposals_themselves(app, srv):
    """产品负责人 2026-08-30：「开发给的方案在哪里。我根本没看到」。

    方案只活在模型的转述里，他就看不到正文 —— 所以读线程时把提案本身给前端。
    """
    _propose(srv, "左栏收成 4 个工作台", "现在：一长排入口\n改完：只剩 4 个")
    srv._file_feedback(
        "夜班沉默", "run-op", None, [{"kind": "feedback.ui", "text": "左边太挤"}]
    )
    _, read = _get(app, "夜班沉默", "__feedback__")
    assert read["proposals"][0]["title"] == "左栏收成 4 个工作台"
    assert "改完：只剩 4 个" in read["proposals"][0]["body"]
    assert read["opinions"][0]["text"] == "左边太挤"
    assert read["opinions"][0]["status"] == "new"


def test_clicking_a_verdict_needs_no_model(app, srv):
    """拍板是**按钮**：模型忘了给 proposal.decide，他的话就白说了一次。"""
    pid = _propose(srv, "左栏收成 4 个工作台")
    body = json.dumps({"id": pid, "verdict": "approved"}).encode("utf-8")
    resp = app.handle_post(
        "/api/projects/夜班沉默/proposal/decide",
        body,
        headers={srv._SKILL_RUN_HEADER: "1"},
    )
    assert resp.status == 200
    assert srv._load_feedback()["proposals"][0]["decision"]["verdict"] == "approved"


def test_a_click_without_the_csrf_header_is_refused(app, srv):
    pid = _propose(srv, "提案")
    resp = app.handle_post(
        "/api/projects/夜班沉默/proposal/decide",
        json.dumps({"id": pid, "verdict": "approved"}).encode("utf-8"),
        headers={},
    )
    assert resp.status == 403


def test_a_nonsense_click_is_refused_with_a_reason(app, srv):
    pid = _propose(srv, "提案")
    resp = app.handle_post(
        "/api/projects/夜班沉默/proposal/decide",
        json.dumps({"id": pid, "verdict": "maybe"}).encode("utf-8"),
        headers={srv._SKILL_RUN_HEADER: "1"},
    )
    assert resp.status == 400
    assert "不认识的答复" in json.loads(resp.body.decode("utf-8"))["error"]["detail"]


def test_answered_proposals_reach_the_facts_so_it_stops_asking_again(app, srv):
    """产品负责人 2026-08-30：「我明明说那么清楚了为什么前端agent一直问我重复的问题」。

    他答过的必须在事实里，带着他的原话 —— 那句话就是已经定下来的事。
    """
    pid = _propose(srv, "左栏收成 4 个工作台")
    srv._decide_proposal(
        pid, "changes", "可以，但历史版本要能一键全展开", "2026-08-30T00:00:00Z"
    )
    facts = app._conv_facts("夜班沉默", None)
    assert "不要再问这些" in facts
    assert "要改" in facts
    assert "历史版本要能一键全展开" in facts

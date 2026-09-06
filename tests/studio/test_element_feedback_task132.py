"""点中一个元素写的意见，直接进台账 —— 不经模型（TASK-132 切片 A 的服务端那半）。

为什么另开一条路而不是复用 `feedback.ui`：那条要模型先跑完、再从回答里把意见摘
出来，于是「他写的那句话能不能被记下」取决于模型这一轮的表现。一条意见的原文是
**他的东西**，不该由模型的成败决定它存不存在。

这份测试守四件事，前两件是这条路开通**之前就存在**的真缺陷 —— 直接提交把它们
从「窄到看不见」变成了「每天都会撞上」：

  1. **编号唯一。** `id = len(items) + 1` 配上「只留最近 500 条」的裁剪，条数顶到
     上限后每一条新意见都拿到同一个号。屏幕上回「已记录 #501」、开发按号去找，
     而 #501 同时指着十几条。
  2. **并发不丢意见。** 两条写路径各自读—改—写，谁后写谁把对方覆盖掉，两边都回
     「已记录」。
  3. **元素定位真的到得了台账**（`_conv_where` 的白名单要开口子，否则前端送的
     `target` 被整段丢掉 —— 页面上看着记下了，开发收到的还是页面级线索）。
  4. **保存失败要说失败**，不能像成功。
"""

from __future__ import annotations

import importlib.util
import json
import threading
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SERVER = _REPO / "mockups" / "motv-workspace" / "server.py"


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location("motv_server_elemfb_132", _SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def app(srv, tmp_path: Path, monkeypatch):
    monkeypatch.setattr(srv, "DATA_DIR", tmp_path / "legacy")
    monkeypatch.setattr(srv, "APP_DATA_DIR", tmp_path / "app-data")
    monkeypatch.setattr(srv, "_RUNS", None)
    account = tmp_path / "account"
    account.mkdir(parents=True, exist_ok=True)
    return srv._App(account)


def _post(app, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    resp = app.handle_post("/api/feedback/element", body, {})
    return resp.status, json.loads(resp.body.decode("utf-8"))


def _one(text="这个按钮太靠近删除，容易误点", ann="ann-1", **kw):
    body = {
        "annotationId": ann,
        "project": "夜班沉默",
        "text": text,
        "context": {
            "module": "storyboard",
            "moduleLabel": "分镜设计",
            "spaceLabel": "剧集制作",
            "route": "#/storyboard/ep-1",
            "source": "src/ui/storyboard.js",
            "target": {
                "uiId": "shot-generate",
                "component": "shotList",
                "label": "生成",
                "selector": ".shot-row > button.primary",
                "source": "src/ui/storyboard.js",
                "shotId": "shot-2",
                "rect": {"x": 12.4, "y": 300.0, "w": 64.0, "h": 28.0},
            },
        },
    }
    body.update(kw)
    return body


# --- 原文与定位真的落到台账 -------------------------------------------------


def test_the_text_lands_verbatim_with_its_element(app, srv):
    status, out = _post(app, _one())
    assert status == 200 and out["ok"] is True
    items = srv._load_feedback()["items"]
    assert len(items) == 1
    it = items[0]
    assert it["text"] == "这个按钮太靠近删除，容易误点", "原文一个字都不许改写"
    assert it["id"] == out["id"]
    assert it["where"]["target"]["uiId"] == "shot-generate"
    assert it["where"]["target"]["label"] == "生成"
    assert it["where"]["module"] == "storyboard"
    assert it["where"]["page"] == "剧集制作 · 分镜设计"
    # 这条不是模型那一轮产生的，所以没有 runId —— 留空而不是编一个
    assert it["runId"] == ""
    assert it["annotationId"] == "ann-1"


def test_the_target_survives_the_where_whitelist(app, srv):
    """白名单必须为 `target` 开口子。

    不开的话：页面上「已记录」，而开发那边收到的还是页面级线索 —— 本卡要消除的
    正是这个缺口，而它的表现是**没有任何报错**。
    """
    _post(app, _one())
    where = srv._load_feedback()["items"][0]["where"]
    assert "target" in where, "target 被白名单整段丢掉了"
    assert where["target"]["rect"] == {"x": 12.4, "y": 300.0, "w": 64.0, "h": 28.0}


def test_a_junk_target_is_dropped_not_patched(app, srv):
    body = _one(ann="ann-junk")
    body["context"]["target"] = {"uiId": 7, "label": "", "nope": "x", "rect": "big"}
    _post(app, body)
    where = srv._load_feedback()["items"][0]["where"]
    assert "target" not in where, "一个字段都不合格时不该留一个空壳"


def test_a_source_that_is_not_repo_relative_is_dropped(app, srv):
    """`source` 只是**线索**，服务端绝不据它去读文件 —— 但形状还是要校验。

    存一条 `../../etc/passwd` 进台账，等于把一条看起来可以直接打开的路径递给
    下一个读它的人（或工具）。判形状与判可达是两件事，这里只做前者。
    """
    for bad in ("../../../etc/passwd", "/etc/passwd", "C:\\Windows\\x.js"):
        body = _one(ann=f"ann-{bad}")
        body["context"]["target"]["source"] = bad
        _post(app, body)
    for it in srv._load_feedback()["items"]:
        assert "source" not in it["where"]["target"], it["where"]["target"]


# --- 编号：真缺陷 1 ---------------------------------------------------------


def test_ids_stay_unique_after_the_ledger_is_trimmed(app, srv, monkeypatch):
    """台账顶到上限之后，新意见**不能**和旧的重号。

    `len(items) + 1` 在裁剪之后恒等于「上限 + 1」。编号是他用来指认某一条意见的
    名字，重名就没有指认。
    """
    monkeypatch.setattr(srv, "_CONV_FEEDBACK_MAX_ITEMS", 3)
    ids = []
    for i in range(6):
        status, out = _post(app, _one(text=f"第 {i} 条", ann=f"ann-{i}"))
        assert status == 200
        ids.append(out["id"])
    assert len(set(ids)) == len(ids), f"派出了重复编号：{ids}"
    assert ids == sorted(ids), "编号应当单调递增"
    kept = srv._load_feedback()["items"]
    assert len(kept) == 3, "裁剪本身还要生效"
    assert [x["id"] for x in kept] == ids[-3:]


# --- 幂等：重发不产生第二条 -------------------------------------------------


def test_resending_the_same_annotation_does_not_add_a_second_one(app, srv):
    _, first = _post(app, _one(ann="ann-same"))
    _, again = _post(app, _one(ann="ann-same"))
    assert again["duplicate"] is True
    assert again["id"] == first["id"], "重发要回原来那个编号，否则他以为记了两条"
    assert len(srv._load_feedback()["items"]) == 1


def test_two_different_annotations_are_two_opinions(app, srv):
    """反方向：幂等不能宽到把两条真的意见合成一条。"""
    _post(app, _one(text="第一条", ann="a"))
    _post(app, _one(text="第二条", ann="b"))
    assert len(srv._load_feedback()["items"]) == 2


# --- 并发：真缺陷 2 ---------------------------------------------------------


def test_concurrent_submissions_do_not_lose_opinions(app, srv):
    """两条写路径各自读—改—写，谁后写谁把对方覆盖掉，而且两边都回「已记录」。

    锁必须罩到**落盘之后**才释放：先判重、放开、再写，只是把窗口从「读到写」
    缩成「判到写」——还是同一扇窗。
    """
    n = 12
    errors = []

    def go(i):
        try:
            status, out = _post(app, _one(text=f"意见 {i}", ann=f"ann-{i}"))
            if status != 200 or not out.get("ok"):
                errors.append((status, out))
        except Exception as exc:  # noqa: BLE001 - 线程里的任何异常都要浮出来
            errors.append(exc)

    threads = [threading.Thread(target=go, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(20)

    assert not errors, errors
    items = srv._load_feedback()["items"]
    assert len(items) == n, f"{n} 条并发提交只落下 {len(items)} 条"
    assert len({x["id"] for x in items}) == n, "并发下派出了重复编号"
    assert {x["text"] for x in items} == {f"意见 {i}" for i in range(n)}


def test_the_model_path_shares_the_same_lock_and_id_source(app, srv):
    """模型那条路与直接提交**共用**同一把锁和同一个派号器。

    各写各的就会互相覆盖 —— 这条钉的是「两条路是同一份台账」，不是某一条自己对。
    """
    _post(app, _one(text="他直接提的", ann="direct"))
    srv._file_feedback(
        "夜班沉默",
        "run-1",
        {"module": "storyboard", "moduleLabel": "分镜设计"},
        [{"text": "模型摘出来的"}],
    )
    items = srv._load_feedback()["items"]
    assert len(items) == 2, "后写的那条把先写的覆盖掉了"
    assert len({x["id"] for x in items}) == 2
    assert {x["runId"] for x in items} == {"", "run-1"}


# --- 坏输入与写失败 ---------------------------------------------------------


@pytest.mark.parametrize(
    "patch",
    [
        {"text": "   "},
        {"text": 7},
        {"annotationId": ""},
    ],
)
def test_unusable_submissions_are_refused_and_write_nothing(app, srv, patch):
    body = _one()
    body.update(patch)
    status, out = _post(app, body)
    assert status == 400, out
    assert srv._load_feedback()["items"] == []


def test_a_failed_write_says_so_instead_of_reporting_success(app, srv, monkeypatch):
    """「保存失败却像成功」是这条路最不能有的行为 —— 他会以为意见记下了。"""
    monkeypatch.setattr(srv, "_save_feedback", lambda doc: False)
    status, out = _post(app, _one())
    assert status == 500
    assert "error" in out and out["error"]["category"] == "write_failed"
    assert "ok" not in out


def test_a_body_that_is_not_json_is_a_clean_400(app):
    resp = app.handle_post("/api/feedback/element", b"{ not json", {})
    assert resp.status == 400


def test_this_path_never_touches_the_project_document(app, srv, tmp_path):
    """不跑模型、不改 canvas —— 它只写账户级台账。"""
    root = tmp_path / "account" / "夜班沉默"
    (root / "studio").mkdir(parents=True)
    canvas = root / "studio" / "canvas.json"
    canvas.write_text('{"story":{}}', "utf-8")
    before = canvas.read_bytes()
    app._projects["夜班沉默"] = root
    _post(app, _one())
    assert canvas.read_bytes() == before

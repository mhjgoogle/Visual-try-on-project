"""用创作者自己账号的额度出图 —— TASK-139 / REQ-008 / ADR-0100。

**STRICTLY OFFLINE.** 每一条都通过注入的假 transport 跑，一个字节都不出机器。
这正是 ADR-0100 决策 7 把厂商报文形状拆进 `imagegen.py` 的理由：ADR-0045 那条
付费图片路至今只能靠真跑一次才知道对不对，而这里每一种失败都能被走一遍。

守的是什么：

- 报文形状（端点、header、body），且 key **不进 URL**；
- 额度耗尽是**具名**的 429，且**不产生任何文件**、**不回退到付费路**（决策 3）；
- `sideEffect` 按合同 §5.8 的白名单判：4xx 白名单 `none` / 5xx 与网络 `unknown` /
  200 但拿不到图 `applied`（额度花了、东西没拿到）；
- 同一意图在途只发一次（REQ-008 判据 5）；
- 出图落**手工上传同一个槽位**并版本化 append，旧版一字不动
  （REQ-008 判据 6 · CA §5.2）；
- 凭据只进不出：任何读接口都不回显完整 key（决策 4）。
"""

from __future__ import annotations

import base64
import importlib.util
import json
import sys
import threading
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP_DIR = _REPO / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP_DIR))

import credstore  # noqa: E402 - path injected above
import imagegen  # noqa: E402 - same

#: 一张真的（极小的）PNG：magic 校验看的是字节，不是我们说的话。
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmM"
    "IQAAAABJRU5ErkJggg=="
)
_KEY = "AIzaSy-test-key-0123456789abcdef"

#: 跨线程同步的等待上限。**它不是在断言时间，只是在兜住真的挂死。**
#:
#: 原值 5 秒：在 `-n 8`、四千多条用例的全量里，另一个会话见过这个文件里的并发用例
#: 红一次（单跑与轻负载联跑都绿）。5 秒是「一个线程多久能被调度完」的猜测，而机器
#: 忙的时候这个猜测会输 —— 于是一条断言并发行为的用例，变成了一条断言调度速度的用例。
#:
#: 放宽到 60 秒不会让任何一条正常路径变慢（事件一到就返回），只是把「真挂死」的
#: 判定推后。这与本文件里那条隔离用例的时间戳是同一族教训：**测试自己制造的不确定性
#: 比被测代码的缺陷更难查，因为它每次红的样子都不一样。**
_SYNC_TIMEOUT = 60


def _interactions_reply(png: bytes = _PNG) -> bytes:
    """文档给的那种形状（Interactions API）。"""
    return json.dumps(
        {
            "steps": [
                {
                    "content": [
                        {
                            "type": "image",
                            "data": base64.b64encode(png).decode(),
                            "mimeType": "image/png",
                        }
                    ]
                }
            ]
        }
    ).encode("utf-8")


def _generate_content_reply(png: bytes = _PNG) -> bytes:
    """同一把 key 打到经典 `generateContent` 时的形状。"""
    return json.dumps(
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "inlineData": {
                                    "mimeType": "image/png",
                                    "data": base64.b64encode(png).decode(),
                                }
                            }
                        ]
                    }
                }
            ]
        }
    ).encode("utf-8")


@pytest.fixture()
def srv(tmp_path, monkeypatch):
    """一份独立加载的 server 模块，应用数据目录隔离在 tmp 里。"""
    spec = importlib.util.spec_from_file_location(
        f"motv_server_acctimg_{tmp_path.name}", _MOCKUP_DIR / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app_data = tmp_path / "appdata"
    app_data.mkdir()
    monkeypatch.setattr(module, "APP_DATA_DIR", app_data)
    monkeypatch.setattr(module, "DATA_DIR", tmp_path / "legacy")
    monkeypatch.setattr(module, "_ACCOUNT_IMAGE_LOG", tmp_path / "acct-log.jsonl")
    # 每个测试一套干净的在途集合 —— 它是模块级状态，泄到下一个测试里会让
    # 「第二次请求被判 in_flight」变成一条随机红。
    monkeypatch.setattr(module, "_ACCOUNT_IMAGE_INFLIGHT", set())
    monkeypatch.setattr(module, "_ACCOUNT_IMAGE_UNKNOWN", set())
    monkeypatch.setattr(module, "_ACCOUNT_IMAGE_LOCK", threading.Lock())
    # **测试永远不许读到仓库根上那个真实的 `.env.local`** —— 那里面是他真的 key，
    # 而且它一存在，所有「没配凭据」的用例就会变成随机绿。
    #
    # 这份隔离的 env 文件里显式写 `IMAGE_PROVIDER=gemini`：本文件的绝大多数用例
    # 守的是**付费闸那一侧**（档位、凭据、unknown 重放），而默认来源已经是
    # pollinations（不要 key、不产生账单）。不写这一行，那些用例会静默地在
    # 另一条路上跑，然后以「没红」的样子失去意义。
    envf = tmp_path / "test.env.local"
    envf.write_text("IMAGE_PROVIDER=gemini\n", encoding="utf-8")
    monkeypatch.setattr(credstore, "DEFAULT_ENV_PATH", envf)
    # **中文 → 英文那一步默认打桩。** 不打的话每条用中文 prompt 的用例都会真的去起
    # 一次本地 claude —— 实测让这个文件从 1.5 秒变成 144 秒，而且结果不确定、还烧
    # 他的订阅。翻译本身由下面「编译成英文」那一组用例专门守。
    # 真件留一份 —— 下面那两条**就是要测它本身**，不能被自己的桩盖住
    module._real_english_image_prompt = module._english_image_prompt
    monkeypatch.setattr(module, "_english_image_prompt", lambda p: (f"EN::{p}", None))
    return module


@pytest.fixture()
def app(srv, tmp_path):
    """一个挂着真实项目根的 `_App`（media/ 真的会被写出来）。"""
    root = tmp_path / "proj"
    (root / "media").mkdir(parents=True)
    a = srv._App(tmp_path / "account")
    a._projects["作品"] = root
    return a


def _post(app, path, payload, headers=None):
    resp = app.handle_post(path, json.dumps(payload).encode("utf-8"), headers or {})
    return resp.status, json.loads(resp.body.decode("utf-8"))


def _get(app, path, headers=None):
    resp = app.handle(path, headers or {})
    return resp.status, json.loads(resp.body.decode("utf-8"))


def _fake_transport(reply, status=200, record=None):
    def transport(url, body, headers, timeout):
        if record is not None:
            record.append((url, body, headers, timeout))
        if isinstance(reply, Exception):
            raise reply
        return status, reply

    return transport


def _set_key(srv, key=_KEY, tier=credstore.TIER_FREE):
    credstore.store(srv.APP_DATA_DIR, key, tier=tier)


# --- Pollinations：默认那条路，不要 key、不产生账单 --------------------------- #


def _pollinations_env(monkeypatch, tmp_path, extra=""):
    envf = tmp_path / "poll.env.local"
    envf.write_text("IMAGE_PROVIDER=pollinations\n" + extra, encoding="utf-8")
    monkeypatch.setattr(credstore, "DEFAULT_ENV_PATH", envf)
    return envf


def test_pollinations_request_is_a_get_with_the_prompt_in_the_path():
    url, body, headers = imagegen.build_pollinations_request("一只猫 / 白纸")
    assert url.startswith(imagegen.POLLINATIONS_ENDPOINT)
    assert body is None  # body is None 就是「这是一次 GET」
    assert "x-goog-api-key" not in {k.lower() for k in headers}  # 没有鉴权
    # prompt 进的是**路径段**，`/` 必须被转义，否则请求会被打到别的路径上
    assert (
        "%2F" in url
        or "/" not in url[len(imagegen.POLLINATIONS_ENDPOINT) :].split("?")[0]
    )


def test_pollinations_returns_raw_bytes_and_costs_nothing(
    srv, app, monkeypatch, tmp_path
):
    """回来的就是图片字节本身，没有 JSON 包装 —— 而且没有可被消耗的额度。"""
    _pollinations_env(monkeypatch, tmp_path)
    srv._https_post = _fake_transport(_PNG)  # 直接给字节
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    assert status == 200, body
    assert body["billing"] == "account-quota"
    assert "usd" not in body
    assert body["model"] == "pollinations/sana"
    saved = list((app._projects["作品"] / "media").glob("hero*.png"))
    assert len(saved) == 1 and saved[0].read_bytes() == _PNG


def test_pollinations_needs_no_key_at_all(srv, app, monkeypatch, tmp_path):
    """没有 key、没有档位声明 —— 这条路照样走得通。

    Gemini 那条的 403 `billing_not_established` 守的是「可能计费」；
    这条路**结构上不可能计费**（没有账号），所以那道闸对它不适用，
    而不是被放松了（ADR-0100 决策 1：判据是会不会产生按次账单）。
    """
    _pollinations_env(monkeypatch, tmp_path)
    assert credstore.resolve(srv.APP_DATA_DIR, "gemini") == ("", "", "")
    srv._https_post = _fake_transport(_PNG)
    assert (
        _post(
            app,
            "/api/agent/image-gen-account",
            {"project": "作品", "slug": "hero", "prompt": "一只猫"},
        )[0]
        == 200
    )


def test_a_pollinations_failure_is_never_unknown(srv, app, monkeypatch, tmp_path):
    """没有账号就没有可被消耗的配额，所以重试它只花时间 —— `side_effect` 恒为 none。

    这不是漏判：`sideEffect` 记的是「有没有消耗掉会用完的东西」，而这条路上
    那样东西不存在。因此 §5.8 的「不确定不许自动重试」在这里没有保护对象。
    """
    _pollinations_env(monkeypatch, tmp_path)
    srv._https_post = _fake_transport(imagegen.TransportFailed("timeout"))
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    assert status == 504
    assert body["error"]["side_effect"] == "none"

    # 于是同一个意图可以直接再来一次，不需要显式确认
    calls = []
    srv._https_post = _fake_transport(_PNG, record=calls)
    assert (
        _post(
            app,
            "/api/agent/image-gen-account",
            {"project": "作品", "slug": "hero", "prompt": "一只猫"},
        )[0]
        == 200
    )
    assert len(calls) == 1


def test_an_unknown_provider_is_refused_by_name(srv, app, monkeypatch, tmp_path):
    _pollinations_env(monkeypatch, tmp_path)
    (tmp_path / "poll.env.local").write_text("IMAGE_PROVIDER=midjourney\n", "utf-8")
    calls = []
    srv._https_post = _fake_transport(_PNG, record=calls)
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    assert status == 400
    assert "midjourney" in body["error"]["detail"]
    assert calls == []


# --- 中文设定要先编译成英文再发出去 ------------------------------------------ #
#
# 实测（2026-09-05，同一份人物设定、同一个 seed，只改语言）：中文原样发出去回来的
# 是和服少女、暖色日式室内；换成英文之后短发 / 黑衬衫 / 冷侧光 / 眼下阴影全部对上。
# Pollinations 只有 `sana` 一个模型，换模型这条路不存在。


def test_the_chinese_setting_is_compiled_to_english_before_it_goes_out(srv, app):
    _set_key(srv)
    calls = []
    srv._https_post = _fake_transport(_interactions_reply(), record=calls)
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "【外貌】短发，黑衬衫"},
    )
    assert status == 200, body
    # 发出去的是编译后的那份
    sent_payload = json.loads(calls[0][1].decode("utf-8"))
    assert "EN::" in json.dumps(sent_payload, ensure_ascii=False)
    # **而且回执要把它给他看**：不给看就是替他换了词还不告诉他
    assert body["prompt_sent"].startswith("EN::")
    assert body["translated"] is True


def test_an_english_prompt_is_not_recompiled(srv, monkeypatch):
    """已经是英文就别白跑一次本地模型（它慢，而且每跑一次都是他的机器在算）。"""
    ran = []
    monkeypatch.setattr(
        srv, "_run_executor", lambda *a, **k: (ran.append(1), ("x", None))[1]
    )
    assert srv._real_english_image_prompt("short hair, black shirt") == (
        "short hair, black shirt",
        None,
    )
    assert ran == [], "没有汉字就不该起本地模型"


def test_a_failed_compile_generates_nothing_at_all(srv, app, monkeypatch):
    """**fail-closed**：编译不出英文就一张图都不出。

    硬发中文只会再出一张与设定无关的图，而他要从那张图反推「是设定没写清还是
    模型不行」几乎不可能 —— 那正是这次真实事故的形状。
    """
    _set_key(srv)
    monkeypatch.setattr(
        srv, "_english_image_prompt", lambda p: (None, "本地 claude 不可用")
    )
    calls = []
    srv._https_post = _fake_transport(_interactions_reply(), record=calls)
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "【外貌】短发"},
    )
    assert status == 503
    assert body["error"]["category"] == "prompt_translation_failed"
    assert body["error"]["side_effect"] == "none", "一个字节都没发出去"
    assert calls == []
    assert list((app._projects["作品"] / "media").iterdir()) == []


def test_a_compile_that_comes_back_still_chinese_is_refused(srv, monkeypatch):
    """回来还是中文 = 没照做。发出去就是白花一次额度，且图必然不对。"""
    monkeypatch.setattr(srv, "_run_executor", lambda *a, **k: ("【外貌】短发", None))
    sent, why = srv._real_english_image_prompt("【外貌】短发")
    assert sent is None
    assert "仍然是中文" in why


def test_the_ledger_keeps_both_prompts(srv, app):
    """只记一份都不够：一份对不回他改的哪句话，另一份判不了是不是编译走样。"""
    _set_key(srv)
    srv._https_post = _fake_transport(_interactions_reply())
    _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "【外貌】短发"},
    )
    line = json.loads(
        srv._ACCOUNT_IMAGE_LOG.read_text("utf-8").strip().splitlines()[-1]
    )
    assert line["prompt"].startswith("【外貌】")
    assert line["prompt_sent"].startswith("EN::")
    assert line["translated"] is True


# --- 报文形状 ---------------------------------------------------------------- #


def test_request_shape_puts_the_key_in_a_header_never_in_the_url():
    url, body, headers = imagegen.build_request("一只猫", api_key=_KEY)
    assert url == imagegen.GEMINI_ENDPOINT
    assert url.startswith("https://")
    assert _KEY not in url  # key 进 URL 就会进日志、进代理记录
    assert headers["x-goog-api-key"] == _KEY
    payload = json.loads(body.decode("utf-8"))
    assert payload["model"] == imagegen.DEFAULT_MODEL
    assert payload["input"] == [{"type": "text", "text": "一只猫"}]


def test_both_reply_shapes_are_understood():
    """两种形状都要认得 —— 猜错的代价是「出图成功却报没有图」，而额度已经花了。"""
    for reply in (_interactions_reply(), _generate_content_reply()):
        got = imagegen.generate_image(
            "一只猫", api_key=_KEY, transport=_fake_transport(reply)
        )
        assert got.data == _PNG
        assert got.side_effect == "applied"


# --- 成功路径 ---------------------------------------------------------------- #


def test_success_writes_into_the_manual_upload_slot_and_reports_no_price(srv, app):
    _set_key(srv)
    srv._https_post = _fake_transport(_interactions_reply())
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    assert status == 200, body
    assert body["billing"] == "account-quota"
    assert body["model"] == imagegen.DEFAULT_MODEL
    assert body["credential_source"] == "settings"
    # 这条路上没有金额可报，补一个 0 等于回答一个不存在的问题（ADR-0064 决策 6）
    assert "usd" not in body
    saved = list((app._projects["作品"] / "media").glob("hero*.png"))
    assert len(saved) == 1
    assert saved[0].read_bytes() == _PNG


def test_regenerating_appends_a_version_and_leaves_the_old_one_alone(srv, app):
    _set_key(srv)
    srv._https_post = _fake_transport(_interactions_reply())
    _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    first = sorted((app._projects["作品"] / "media").iterdir())[0]
    first_bytes = first.read_bytes()

    other = _PNG + b"\x00second"
    srv._https_post = _fake_transport(_interactions_reply(other))
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "另一只猫"},
    )
    assert status == 200, body
    files = sorted((app._projects["作品"] / "media").iterdir())
    assert len(files) == 2, [f.name for f in files]
    assert first.read_bytes() == first_bytes  # 旧版一字不动（CA §5.2）


# --- 失败路径：每一种都具名，副作用判定按 §5.8 ------------------------------- #


def test_quota_exhausted_is_named_and_writes_nothing_and_never_falls_back(srv, app):
    _set_key(srv)
    calls = []
    srv._https_post = _fake_transport(
        b'{"error":{"message":"RESOURCE_EXHAUSTED"}}', status=429, record=calls
    )
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    assert status == 429
    # 类别是具名的：界面据此说「额度用完了」，不是笼统的失败（ADR-0100 决策 3）
    assert body["error"]["category"] == "quota_exhausted"
    # **但副作用严格照合同 §5.8 的白名单**：429 明确在 `unknown` 那一侧。
    # 「429 是生成之前的拒绝」是在推断供应商内部行为，而白名单存在的意义正是
    # 不做那种推断（codex 补审 2026-09-05 判 P1）。
    assert body["error"]["side_effect"] == "unknown"
    # 没有第二次调用：**禁止**自动改走付费那条路（ADR-0100 决策 3）
    assert len(calls) == 1
    assert list((app._projects["作品"] / "media").iterdir()) == []


@pytest.mark.parametrize(
    ("http_status", "category", "side_effect"),
    [
        (401, "credential_rejected", "none"),
        (403, "credential_rejected", "none"),
        (400, "bad_request", "none"),
        (422, "bad_request", "none"),
        (500, "provider_unavailable", "unknown"),
        (503, "provider_unavailable", "unknown"),
        (409, "provider_unavailable", "unknown"),
    ],
)
def test_side_effect_follows_the_contract_allowlist(
    srv, app, http_status, category, side_effect
):
    """§5.8：只有那一小撮 4xx 算「确定没跑」，其余一律 `unknown`。

    409 在这里特别重要：它**不在**白名单里，所以必须落 `unknown` —— 一个
    看起来像「冲突」的码同样可能发生在请求已经送达之后。
    """
    _set_key(srv)
    srv._https_post = _fake_transport(b"{}", status=http_status)
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    assert status != 200
    assert body["error"]["category"] == category
    assert body["error"]["side_effect"] == side_effect
    assert list((app._projects["作品"] / "media").iterdir()) == []


def test_network_failure_is_unknown_not_a_clean_failure(srv, app):
    _set_key(srv)
    srv._https_post = _fake_transport(imagegen.TransportFailed("connection reset"))
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    assert status == 504
    assert body["error"]["category"] == "network_failed"
    # 请求发出去过 → 可能已经消耗了一次额度 → 不许自动重试
    assert body["error"]["side_effect"] == "unknown"


def test_a_200_without_an_image_counts_the_quota_as_spent(srv, app):
    """最容易写错的一条：拿到了回复、没拿到图 —— 额度是**花了**的。

    把它记成 `none`，下一次重试就是第二次消耗。
    """
    _set_key(srv)
    srv._https_post = _fake_transport(b'{"steps":[{"content":[]}]}')
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    assert status == 502
    assert body["error"]["category"] == "bad_output"
    assert body["error"]["side_effect"] == "applied"


def test_bytes_that_are_not_an_image_are_refused_by_magic_not_by_the_label(srv, app):
    _set_key(srv)
    lie = json.dumps(
        {
            "steps": [
                {
                    "content": [
                        {
                            "type": "image",
                            "data": base64.b64encode(b"<html>not an image").decode(),
                            "mimeType": "image/png",  # 它说自己是 PNG
                        }
                    ]
                }
            ]
        }
    ).encode("utf-8")
    srv._https_post = _fake_transport(lie)
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    assert status == 502
    assert body["error"]["category"] == "image_bad_output"
    assert list((app._projects["作品"] / "media").iterdir()) == []


# --- 幂等与凭据 -------------------------------------------------------------- #


def test_no_credential_says_where_to_set_it_and_never_calls_out(srv, app):
    calls = []
    srv._https_post = _fake_transport(_interactions_reply(), record=calls)
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    assert status == 503
    assert body["error"]["category"] == "no_credential"
    assert "设置" in body["error"]["detail"]
    assert calls == []


def test_the_same_intent_in_flight_is_not_sent_twice(srv, app):
    """重复点击不得消耗第二次额度（REQ-008 判据 5）。"""
    _set_key(srv)
    started = threading.Event()
    release = threading.Event()
    calls = []

    def slow(url, body, headers, timeout):
        calls.append(url)
        started.set()
        release.wait(_SYNC_TIMEOUT)
        return 200, _interactions_reply()

    srv._https_post = slow
    payload = {"project": "作品", "slug": "hero", "prompt": "一只猫"}
    out = {}

    def first_request():
        out["status"], out["body"] = _post(app, "/api/agent/image-gen-account", payload)

    t = threading.Thread(target=first_request)
    t.start()
    assert started.wait(_SYNC_TIMEOUT)

    status, body = _post(app, "/api/agent/image-gen-account", payload)
    assert status == 409
    assert body["error"]["category"] == "in_flight"

    release.set()
    t.join(_SYNC_TIMEOUT)
    assert out["status"] == 200
    assert len(calls) == 1  # 只出去了一次


def test_a_finished_request_releases_the_slot(srv, app):
    _set_key(srv)
    srv._https_post = _fake_transport(_interactions_reply())
    payload = {"project": "作品", "slug": "hero", "prompt": "一只猫"}
    assert _post(app, "/api/agent/image-gen-account", payload)[0] == 200
    # 同一个意图再来一次是允许的 —— 在途去重不是永久去重
    assert _post(app, "/api/agent/image-gen-account", payload)[0] == 200


def test_the_key_goes_in_but_never_comes_back_out(srv, app):
    status, body = _post(
        app, "/api/settings/credentials", {"key": _KEY, "tier": credstore.TIER_FREE}
    )
    assert status == 200
    assert body["credential"]["configured"] is True
    assert body["credential"]["last4"] == _KEY[-4:]
    assert _KEY not in json.dumps(body)

    status, body = _get(app, "/api/settings/credentials")
    assert status == 200
    assert _KEY not in json.dumps(body)
    assert body["credentials"][0]["configured"] is True
    assert body["credentials"][0]["source"] == "settings"


def test_clearing_the_key_turns_the_path_off_again(srv, app):
    _post(app, "/api/settings/credentials", {"key": _KEY, "tier": credstore.TIER_FREE})
    status, body = _post(app, "/api/settings/credentials", {"key": ""})
    assert status == 200
    assert body["credential"]["configured"] is False
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    assert status == 503
    assert body["error"]["category"] == "no_credential"


@pytest.mark.parametrize(
    "bad",
    ["short", "has space inside", "with\nnewline", "x" * 500],
)
def test_a_key_that_cannot_be_a_key_is_refused_with_a_reason_he_can_act_on(
    srv, app, bad
):
    status, body = _post(app, "/api/settings/credentials", {"key": bad})
    assert status == 400
    assert body["error"]["category"] == "bad_credential"
    assert bad not in json.dumps(body)  # 连拒绝信息里都不回显


def test_the_env_file_beats_everything_and_takes_effect_without_a_restart(
    srv, monkeypatch, tmp_path
):
    """他改哪儿，哪儿说了算 —— 而且保存即生效。

    产品负责人 2026-09-05：「每次换 API key 的时候我就不用总是找程序输入了。」
    所以 `.env.local` 压过设置页与进程环境变量，且**每次请求重读**：
    这条用例改两次文件，中间不重建任何东西。
    """
    envf = tmp_path / ".env.local"
    monkeypatch.setattr(credstore, "DEFAULT_ENV_PATH", envf)
    monkeypatch.setenv("GEMINI_API_KEY", "env-key-0123456789abcdef")
    monkeypatch.setenv("GEMINI_API_KEY_TIER", credstore.TIER_FREE)
    credstore.store(srv.APP_DATA_DIR, _KEY, tier=credstore.TIER_FREE)

    envf.write_text(
        "# 注释行\n"
        "\n"
        'export GEMINI_API_KEY="file-key-first-0123456789"\n'
        "GEMINI_API_KEY_TIER=free\n",
        encoding="utf-8",
    )
    assert credstore.resolve(srv.APP_DATA_DIR, "gemini") == (
        "file-key-first-0123456789",
        "env-file",
        credstore.TIER_FREE,
    )

    # 改一次文件就换了一把 key —— 没有重启、没有重新构造任何对象
    envf.write_text(
        "GEMINI_API_KEY=file-key-second-0123456789\nGEMINI_API_KEY_TIER=free\n",
        encoding="utf-8",
    )
    assert credstore.resolve(srv.APP_DATA_DIR, "gemini")[0] == (
        "file-key-second-0123456789"
    )

    # 文件里没有 key 时才轮到设置页
    envf.write_text("# 只有注释\n", encoding="utf-8")
    assert credstore.resolve(srv.APP_DATA_DIR, "gemini") == (
        _KEY,
        "settings",
        credstore.TIER_FREE,
    )


def test_a_file_key_does_not_inherit_a_tier_from_another_layer(
    srv, monkeypatch, tmp_path
):
    """档位必须与 key 来自同一处声明。

    否则「文件里换了一把付费 key，却继承了设置页里 free 的声明」——
    那正是 ADR-0100 决策 1 要防的那件事。
    """
    envf = tmp_path / ".env.local"
    monkeypatch.setattr(credstore, "DEFAULT_ENV_PATH", envf)
    credstore.store(srv.APP_DATA_DIR, _KEY, tier=credstore.TIER_FREE)
    envf.write_text("GEMINI_API_KEY=file-key-without-tier-01234\n", encoding="utf-8")

    key, source, tier = credstore.resolve(srv.APP_DATA_DIR, "gemini")
    assert (key, source, tier) == ("file-key-without-tier-01234", "env-file", "")


def test_a_file_key_without_a_tier_cannot_generate(srv, app, monkeypatch, tmp_path):
    """接上面那条的产品后果：没声明档位 → 403，一个字节都不出去。"""
    envf = tmp_path / ".env.local"
    monkeypatch.setattr(credstore, "DEFAULT_ENV_PATH", envf)
    envf.write_text(
        "IMAGE_PROVIDER=gemini\nGEMINI_API_KEY=file-key-without-tier-01234\n",
        encoding="utf-8",
    )
    calls = []
    srv._https_post = _fake_transport(_interactions_reply(), record=calls)
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    assert status == 403
    assert body["error"]["category"] == "billing_not_established"
    assert calls == []


def test_a_missing_or_unreadable_env_file_is_simply_absent(srv, monkeypatch, tmp_path):
    """没有那个文件不是错误 —— 大多数机器上本来就没有。"""
    monkeypatch.setattr(credstore, "DEFAULT_ENV_PATH", tmp_path / "nope.env")
    assert credstore.read_env_file(tmp_path / "nope.env") == {}
    assert credstore.read_env_file(tmp_path) == {}  # 目录也不炸
    credstore.store(srv.APP_DATA_DIR, _KEY, tier=credstore.TIER_FREE)
    assert credstore.resolve(srv.APP_DATA_DIR, "gemini")[1] == "settings"


def test_settings_beat_the_environment_variable(srv, monkeypatch):
    """界面里粘的那把是他刚亲手给的；环境变量可能是几个月前留下的。"""
    monkeypatch.setenv("GEMINI_API_KEY", "env-key-0123456789abcdef")
    monkeypatch.setenv("GEMINI_API_KEY_TIER", credstore.TIER_FREE)
    assert credstore.resolve(srv.APP_DATA_DIR, "gemini") == (
        "env-key-0123456789abcdef",
        "env",
        credstore.TIER_FREE,
    )
    credstore.store(srv.APP_DATA_DIR, _KEY, tier=credstore.TIER_FREE)
    assert credstore.resolve(srv.APP_DATA_DIR, "gemini") == (
        _KEY,
        "settings",
        credstore.TIER_FREE,
    )


def test_an_undeclared_environment_key_is_not_treated_as_free(srv, monkeypatch):
    """一个几个月前留在 CI 里的 key，不该因为「它一直能用」就被当成免费额度。"""
    monkeypatch.setenv("GEMINI_API_KEY", "env-key-0123456789abcdef")
    monkeypatch.delenv("GEMINI_API_KEY_TIER", raising=False)
    _key, source, tier = credstore.resolve(srv.APP_DATA_DIR, "gemini")
    assert (source, tier) == ("env", "")


def test_a_corrupt_credentials_file_degrades_to_unset_and_is_not_overwritten(srv):
    """坏掉的凭据文件不该让后端起不来，也不该被我们静默重写。"""
    path = srv.APP_DATA_DIR / credstore.CRED_FILENAME
    path.write_text("{ not json", encoding="utf-8")
    assert credstore.resolve(srv.APP_DATA_DIR, "gemini") == ("", "", "")
    assert path.read_text(encoding="utf-8") == "{ not json"


def test_saving_over_a_corrupt_file_keeps_the_old_bytes(srv):
    """读成 `{}` 是对的，**拿那个 `{}` 写回去**就等于把他文件里的东西删了。

    坏文件里可能有别的 key，也可能只是一个能人工救回来的手滑
    （codex 补审 2026-09-05 判 P2 · `CA §5.2` 不静默覆盖）。
    """
    path = srv.APP_DATA_DIR / credstore.CRED_FILENAME
    path.write_text('{ "other_service_key": "keep-me", broken', encoding="utf-8")
    credstore.store(srv.APP_DATA_DIR, _KEY, tier=credstore.TIER_FREE)

    # 新文件写成了
    assert credstore.resolve(srv.APP_DATA_DIR, "gemini")[0] == _KEY
    # 旧字节没被删掉，被挪到了一个带时间戳的隔离文件里
    quarantined = list(srv.APP_DATA_DIR.glob(credstore.CRED_FILENAME + ".corrupt-*"))
    assert len(quarantined) == 1
    assert "keep-me" in quarantined[0].read_text(encoding="utf-8")


def test_a_key_that_might_bill_is_refused_before_any_call_goes_out(srv, app):
    """**配了 key ≠ 这次调用不产生账单**（codex 补审 2026-09-05 判 P1）。

    一把开了结算的 Gemini key 与免费额度那把在外面完全一样，所以档位由他声明。
    声明成 paid、或者根本没声明 —— 两种都不许从这条路走，fail-closed 回付费闸
    （ADR-0100 决策 1 最后一句：拿不准就按计费处理）。
    """
    for tier in (credstore.TIER_PAID, None):
        calls = []
        srv._https_post = _fake_transport(_interactions_reply(), record=calls)
        path = srv.APP_DATA_DIR / credstore.CRED_FILENAME
        if tier is None:
            # 「配了 key 但没有档位」：老格式或手工编辑出来的文件
            path.write_text(json.dumps({"gemini_api_key": _KEY}), encoding="utf-8")
        else:
            credstore.store(srv.APP_DATA_DIR, _KEY, tier=tier)
        status, body = _post(
            app,
            "/api/agent/image-gen-account",
            {"project": "作品", "slug": "hero", "prompt": "一只猫"},
        )
        assert status == 403, (tier, body)
        assert body["error"]["category"] == "billing_not_established"
        assert calls == []  # 一个字节都没出去
        assert list((app._projects["作品"] / "media").iterdir()) == []


def test_storing_a_key_without_saying_which_tier_is_refused(srv, app):
    status, body = _post(app, "/api/settings/credentials", {"key": _KEY})
    assert status == 400
    assert body["error"]["category"] == "bad_credential"
    status, body = _post(
        app, "/api/settings/credentials", {"key": _KEY, "tier": credstore.TIER_FREE}
    )
    assert status == 200
    assert body["credential"]["quota_ready"] is True


def test_a_duplicate_during_the_save_window_does_not_generate_again(srv, app):
    """在途标记要押到**落盘之后**才放。

    上一版在 `generate_image` 返回时就放掉了，于是「生成完了、正在写文件」这段
    窗口里再来一次同样的请求会再生成一张 —— 额度花两次，而两次都对
    （codex 补审 2026-09-05 判 P1）。
    """
    _set_key(srv)
    calls = []
    srv._https_post = _fake_transport(_interactions_reply(), record=calls)

    entered = threading.Event()
    release = threading.Event()
    real_claim = srv._claim_version

    def slow_claim(d, slug, ext):
        entered.set()
        release.wait(_SYNC_TIMEOUT)
        return real_claim(d, slug, ext)

    srv._claim_version = slow_claim
    payload = {"project": "作品", "slug": "hero", "prompt": "一只猫"}
    out = {}

    def first_request():
        out["status"], out["body"] = _post(app, "/api/agent/image-gen-account", payload)

    t = threading.Thread(target=first_request)
    t.start()
    assert entered.wait(_SYNC_TIMEOUT)  # 第一次已经生成完、正卡在落盘中

    status, body = _post(app, "/api/agent/image-gen-account", payload)
    assert status == 409
    assert body["error"]["category"] == "in_flight"
    assert len(calls) == 1  # 第二次没有再去生成

    release.set()
    t.join(_SYNC_TIMEOUT)
    assert out["status"] == 200


def test_an_unknown_outcome_blocks_a_silent_replay_until_he_says_so(srv, app):
    """§5.8 第 2 条：不确定之后要**由用户显式决定**，不是再点一下就重放。"""
    _set_key(srv)
    srv._https_post = _fake_transport(imagegen.TransportFailed("timeout"))
    payload = {"project": "作品", "slug": "hero", "prompt": "一只猫"}
    status, body = _post(app, "/api/agent/image-gen-account", payload)
    assert status == 504
    assert body["error"]["side_effect"] == "unknown"

    # 同一个意图再来 —— 这次供应商是好的，但我们仍然先拦住
    calls = []
    srv._https_post = _fake_transport(_interactions_reply(), record=calls)
    status, body = _post(app, "/api/agent/image-gen-account", payload)
    assert status == 409
    assert body["error"]["category"] == "side_effect_unknown"
    assert calls == []  # 没有静默重放

    # 他显式确认「我知道可能已经消耗过，再来一次」
    status, body = _post(
        app, "/api/agent/image-gen-account", {**payload, "acknowledge_unknown": True}
    )
    assert status == 200, body
    assert len(calls) == 1


@pytest.mark.parametrize("truthy", ["false", "0", "no", 1, [1]])
def test_only_a_real_boolean_counts_as_consent(srv, app, truthy):
    """`bool("false")` 是 True —— 一个前端把复选框当字符串传就够了。

    这道闸放行的后果是再消耗一次额度，所以同意必须是**布尔真**
    （codex 补审轮 2 判 P1）。
    """
    _set_key(srv)
    srv._https_post = _fake_transport(imagegen.TransportFailed("timeout"))
    payload = {"project": "作品", "slug": "hero", "prompt": "一只猫"}
    assert _post(app, "/api/agent/image-gen-account", payload)[0] == 504

    calls = []
    srv._https_post = _fake_transport(_interactions_reply(), record=calls)
    status, body = _post(
        app, "/api/agent/image-gen-account", {**payload, "acknowledge_unknown": truthy}
    )
    assert status == 409, truthy
    assert body["error"]["category"] == "side_effect_unknown"
    assert calls == []


def test_an_unexpected_crash_still_leaves_the_uncertainty_behind(srv, app):
    """意外把在途标记放掉时**必须留下「不确定」**：请求可能已经送出去了。

    上一轮的修复只 discard 不记，于是同一条 P1 从另一个出口漏出去
    （codex 补审轮 2 判 P1）。
    """
    _set_key(srv)

    def explode(*_a, **_k):
        raise RuntimeError("boom")

    srv._https_post = explode
    payload = {"project": "作品", "slug": "hero", "prompt": "一只猫"}
    with pytest.raises(RuntimeError):
        _post(app, "/api/agent/image-gen-account", payload)

    calls = []
    srv._https_post = _fake_transport(_interactions_reply(), record=calls)
    status, body = _post(app, "/api/agent/image-gen-account", payload)
    assert status == 409
    assert body["error"]["category"] == "side_effect_unknown"
    assert calls == []


def test_quarantine_stops_instead_of_overwriting_when_names_run_out(srv, monkeypatch):
    """隔离动作自己不许删掉上一次隔离出来的证据（codex 补审轮 2 判 P1）。

    时间戳**钉死**：秒级时间戳意味着测试与被测代码可能落在不同的一秒里，
    那样名字根本不冲突，这条断言就会变成一条随机绿（它第一次跑就是这么飘的）。
    """
    monkeypatch.setattr(credstore.time, "strftime", lambda *_a, **_k: "FIXED")

    path = srv.APP_DATA_DIR / credstore.CRED_FILENAME
    path.write_text("{ broken", encoding="utf-8")
    stamp = "FIXED"
    occupied = [path.with_suffix(f"{path.suffix}.corrupt-{stamp}")]
    occupied += [
        path.with_suffix(f"{path.suffix}.corrupt-{stamp}-{i}") for i in range(1, 101)
    ]
    for p in occupied:
        p.write_text("earlier evidence", encoding="utf-8")

    with pytest.raises(credstore.CredentialError):
        credstore.store(srv.APP_DATA_DIR, _KEY, tier=credstore.TIER_FREE)

    # 一份都没被盖掉，坏文件也还在原处
    assert all(p.read_text(encoding="utf-8") == "earlier evidence" for p in occupied)
    assert path.read_text(encoding="utf-8") == "{ broken"


def test_a_write_failure_still_says_the_quota_was_spent(srv, app):
    """存不下来不是一次干净的失败：图生成出来了，额度是花了的。"""
    _set_key(srv)
    srv._https_post = _fake_transport(_interactions_reply())

    def boom(d, slug, ext):
        raise OSError("disk full")

    srv._claim_version = boom
    status, body = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    assert status == 500
    assert body["error"]["category"] == "write_failed"
    assert body["error"]["side_effect"] == "applied"


def test_the_account_path_does_not_need_the_paid_switch(srv, app):
    """ADR-0100 决策 5：复用付费开关会让他为了出图而把付费视频命令也一起打开。"""
    assert app.paid_catalog_dir is None  # 没有 --enable-paid
    _set_key(srv)
    srv._https_post = _fake_transport(_interactions_reply())
    status, _ = _post(
        app,
        "/api/agent/image-gen-account",
        {"project": "作品", "slug": "hero", "prompt": "一只猫"},
    )
    assert status == 200

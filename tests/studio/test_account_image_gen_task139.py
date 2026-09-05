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
    monkeypatch.setattr(module, "_ACCOUNT_IMAGE_LOCK", threading.Lock())
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
        release.wait(5)
        return 200, _interactions_reply()

    srv._https_post = slow
    payload = {"project": "作品", "slug": "hero", "prompt": "一只猫"}
    out = {}

    def first_request():
        out["status"], out["body"] = _post(app, "/api/agent/image-gen-account", payload)

    t = threading.Thread(target=first_request)
    t.start()
    assert started.wait(5)

    status, body = _post(app, "/api/agent/image-gen-account", payload)
    assert status == 409
    assert body["error"]["category"] == "in_flight"

    release.set()
    t.join(10)
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
        release.wait(5)
        return real_claim(d, slug, ext)

    srv._claim_version = slow_claim
    payload = {"project": "作品", "slug": "hero", "prompt": "一只猫"}
    out = {}

    def first_request():
        out["status"], out["body"] = _post(app, "/api/agent/image-gen-account", payload)

    t = threading.Thread(target=first_request)
    t.start()
    assert entered.wait(5)  # 第一次已经生成完、正卡在落盘中

    status, body = _post(app, "/api/agent/image-gen-account", payload)
    assert status == 409
    assert body["error"]["category"] == "in_flight"
    assert len(calls) == 1  # 第二次没有再去生成

    release.set()
    t.join(10)
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

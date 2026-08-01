"""Tests for RealMinimaxTransport HTTP wiring (TASK-017), network mocked."""

from __future__ import annotations

import json
import os
import urllib.error

import pytest

from ai_video_workflow.providers.cloud_errors import (
    ProviderAuthError,
    ProviderNetworkError,
    ProviderNotDispatchedError,
    ProviderResponseError,
    ProviderTimeoutError,
    ProviderVendorError,
)
from ai_video_workflow.providers.cloud_minimax import (
    MINIMAX_ENDPOINT_ENV,
    RealMinimaxTransport,
)

SECRET = "sk-canary-should-never-leak"


class _FakeResp:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read(self) -> bytes:
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _patch_urlopen(monkeypatch, *, returns=None, raises=None):
    def _fake(request, timeout=None):
        if raises is not None:
            raise raises
        return _FakeResp(json.dumps(returns).encode("utf-8"))

    monkeypatch.setattr("urllib.request.urlopen", _fake)


def test_submit_success(monkeypatch) -> None:
    _patch_urlopen(
        monkeypatch, returns={"task_id": "tid-1", "base_resp": {"status_code": 0}}
    )
    ref = RealMinimaxTransport().submit(
        api_key=SECRET, payload={"model": "MiniMax-Hailuo-02"}, idempotency_key="op-1"
    )
    assert ref == "tid-1"


def test_submit_missing_task_id(monkeypatch) -> None:
    _patch_urlopen(monkeypatch, returns={"base_resp": {"status_code": 0}})
    with pytest.raises(ProviderResponseError, match="task_id"):
        RealMinimaxTransport().submit(api_key=SECRET, payload={})


def test_submit_base_resp_auth_error(monkeypatch) -> None:
    _patch_urlopen(
        monkeypatch,
        returns={"base_resp": {"status_code": 1004, "status_msg": "bad key"}},
    )
    with pytest.raises(ProviderAuthError):
        RealMinimaxTransport().submit(api_key=SECRET, payload={})


def test_poll_processing_then_succeeded(monkeypatch) -> None:
    _patch_urlopen(monkeypatch, returns={"task": {"status": "processing"}})
    out = RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")
    assert out.state == "processing"

    _patch_urlopen(
        monkeypatch,
        returns={
            "task": {"status": "succeeded", "content": {"url": "https://x/out.mp4"}}
        },
    )
    out = RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")
    assert out.state == "succeeded"
    assert out.artifact_url == "https://x/out.mp4"
    assert out.cost_amount is None  # MiniMax returns no cost (ADR-0009)


def test_poll_failed_status(monkeypatch) -> None:
    _patch_urlopen(monkeypatch, returns={"task": {"status": "failed"}})
    out = RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")
    assert out.state == "failed"


def test_poll_succeeded_without_url(monkeypatch) -> None:
    _patch_urlopen(
        monkeypatch, returns={"task": {"status": "succeeded", "content": {}}}
    )
    with pytest.raises(ProviderResponseError, match="content.url"):
        RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")


def test_http_401_is_auth_error_without_secret(monkeypatch) -> None:
    err = urllib.error.HTTPError("url", 401, "unauth", {}, None)
    _patch_urlopen(monkeypatch, raises=err)
    with pytest.raises(ProviderAuthError) as exc:
        RealMinimaxTransport().submit(api_key=SECRET, payload={})
    assert SECRET not in str(exc.value)


def test_http_500_is_vendor_error(monkeypatch) -> None:
    err = urllib.error.HTTPError("url", 500, "boom", {}, None)
    _patch_urlopen(monkeypatch, raises=err)
    with pytest.raises(ProviderVendorError):
        RealMinimaxTransport().submit(api_key=SECRET, payload={})


def test_timeout_is_ambiguous(monkeypatch) -> None:
    _patch_urlopen(monkeypatch, raises=TimeoutError("slow"))
    with pytest.raises(ProviderTimeoutError):
        RealMinimaxTransport().submit(api_key=SECRET, payload={})


def test_url_error_timeout_reason_is_timeout(monkeypatch) -> None:
    _patch_urlopen(monkeypatch, raises=urllib.error.URLError(TimeoutError("t")))
    with pytest.raises(ProviderTimeoutError):
        RealMinimaxTransport().submit(api_key=SECRET, payload={})


def test_connection_refused_is_not_dispatched(monkeypatch) -> None:
    _patch_urlopen(monkeypatch, raises=urllib.error.URLError(ConnectionRefusedError()))
    with pytest.raises(ProviderNotDispatchedError):
        RealMinimaxTransport().submit(api_key=SECRET, payload={})


def test_generic_url_error_is_ambiguous_network(monkeypatch) -> None:
    _patch_urlopen(monkeypatch, raises=urllib.error.URLError("reset"))
    with pytest.raises(ProviderNetworkError):
        RealMinimaxTransport().submit(api_key=SECRET, payload={})


def test_malformed_response_is_response_error(monkeypatch) -> None:
    def _fake(request, timeout=None):
        return _FakeResp(b"not json")

    monkeypatch.setattr("urllib.request.urlopen", _fake)
    with pytest.raises(ProviderResponseError):
        RealMinimaxTransport().submit(api_key=SECRET, payload={})


def test_default_base_url(monkeypatch) -> None:
    monkeypatch.delenv(MINIMAX_ENDPOINT_ENV, raising=False)
    captured = {}

    def _fake(request, timeout=None):
        captured["url"] = request.full_url
        return _FakeResp(b'{"task_id": "t", "base_resp": {"status_code": 0}}')

    monkeypatch.setattr("urllib.request.urlopen", _fake)
    RealMinimaxTransport().submit(api_key=SECRET, payload={})
    assert captured["url"] == "https://api.minimax.io/v1/video_generation"


# --- opt-in real smoke (skipped unless explicitly enabled) ----------------


@pytest.mark.skipif(
    os.environ.get("AI_VIDEO_WORKFLOW_REAL_MINIMAX") != "1"
    or not os.environ.get("WFM1_MINIMAX_API_KEY"),
    reason="real MiniMax smoke: needs AI_VIDEO_WORKFLOW_REAL_MINIMAX=1 + key",
)
def test_real_minimax_smoke() -> None:  # pragma: no cover - opt-in only
    key = os.environ["WFM1_MINIMAX_API_KEY"]
    transport = RealMinimaxTransport()
    task_id = transport.submit(
        api_key=key,
        payload={
            "model": "MiniMax-Hailuo-02",
            "prompt": "a calm sunrise over the sea",
            "duration": 6,
            "resolution": "512P",
        },
    )
    assert task_id
    out = transport.poll(api_key=key, external_task_ref=task_id)
    assert out.state in {"processing", "succeeded", "failed"}

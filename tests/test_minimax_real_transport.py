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
    ProviderRequestRejectedError,
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


def _patch_routed(monkeypatch, routes: dict):
    """Route urlopen by a substring of the URL to a canned JSON response."""

    def _fake(request, timeout=None):
        url = request.full_url
        for needle, payload in routes.items():
            if needle in url:
                return _FakeResp(json.dumps(payload).encode("utf-8"))
        raise AssertionError(f"unexpected URL: {url}")

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


def test_submit_invalid_params_is_request_rejected(monkeypatch) -> None:
    _patch_urlopen(
        monkeypatch,
        returns={"base_resp": {"status_code": 2013, "status_msg": "invalid params"}},
    )
    with pytest.raises(ProviderRequestRejectedError):
        RealMinimaxTransport().submit(api_key=SECRET, payload={})


def test_submit_insufficient_balance_is_request_rejected(monkeypatch) -> None:
    _patch_urlopen(
        monkeypatch,
        returns={"base_resp": {"status_code": 1008, "status_msg": "no balance"}},
    )
    with pytest.raises(ProviderRequestRejectedError):
        RealMinimaxTransport().submit(api_key=SECRET, payload={})


def test_submit_invalid_api_key_2049_is_auth(monkeypatch) -> None:
    _patch_urlopen(
        monkeypatch,
        returns={"base_resp": {"status_code": 2049, "status_msg": "invalid key"}},
    )
    with pytest.raises(ProviderAuthError):
        RealMinimaxTransport().submit(api_key=SECRET, payload={})


def test_poll_processing(monkeypatch) -> None:
    _patch_urlopen(
        monkeypatch,
        returns={
            "task_id": "tid-1",
            "status": "Processing",
            "base_resp": {"status_code": 0},
        },
    )
    out = RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")
    assert out.state == "processing"


def test_poll_success_queries_then_retrieves(monkeypatch) -> None:
    # official 2-step: query returns file_id, retrieve returns download_url.
    _patch_routed(
        monkeypatch,
        {
            "/v1/query/video_generation": {
                "task_id": "tid-1",
                "status": "Success",
                "file_id": 12345,
                "base_resp": {"status_code": 0},
            },
            "/v1/files/retrieve": {
                "file": {"file_id": 12345, "download_url": "https://x/out.mp4"},
                "base_resp": {"status_code": 0},
            },
        },
    )
    out = RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")
    assert out.state == "succeeded"
    assert out.artifact_url == "https://x/out.mp4"
    assert out.cost_amount is None  # MiniMax returns no cost (ADR-0009)


def test_poll_failed_status(monkeypatch) -> None:
    _patch_urlopen(
        monkeypatch,
        returns={
            "task_id": "tid-1",
            "status": "Fail",
            "base_resp": {"status_code": 0},
        },
    )
    out = RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")
    assert out.state == "failed"


def test_poll_empty_status_is_response_error(monkeypatch) -> None:
    _patch_urlopen(
        monkeypatch, returns={"task_id": "tid-1", "base_resp": {"status_code": 0}}
    )
    with pytest.raises(ProviderResponseError, match="status"):
        RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")


def test_poll_success_missing_file_id(monkeypatch) -> None:
    _patch_urlopen(
        monkeypatch,
        returns={
            "task_id": "tid-1",
            "status": "Success",
            "base_resp": {"status_code": 0},
        },
    )
    with pytest.raises(ProviderResponseError, match="file_id"):
        RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")


def test_retrieve_missing_download_url(monkeypatch) -> None:
    _patch_routed(
        monkeypatch,
        {
            "/v1/query/video_generation": {
                "task_id": "tid-1",
                "status": "Success",
                "file_id": 1,
                "base_resp": {"status_code": 0},
            },
            "/v1/files/retrieve": {
                "file": {"file_id": 1},
                "base_resp": {"status_code": 0},
            },
        },
    )
    with pytest.raises(ProviderResponseError, match="download_url"):
        RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")


def test_query_base_resp_auth_error(monkeypatch) -> None:
    _patch_urlopen(
        monkeypatch, returns={"base_resp": {"status_code": 2049, "status_msg": "bad"}}
    )
    with pytest.raises(ProviderAuthError):
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


def test_base_resp_as_array_is_response_error(monkeypatch) -> None:
    # legal JSON, wrong shape: must be a classified response error, never
    # an unclassified AttributeError (which would leak a held reservation).
    _patch_urlopen(monkeypatch, returns={"task_id": "t", "base_resp": [1, 2]})
    with pytest.raises(ProviderResponseError, match="base_resp"):
        RealMinimaxTransport().submit(api_key=SECRET, payload={})


def test_missing_status_code_is_not_success(monkeypatch) -> None:
    # a response without base_resp.status_code must NOT be an implicit success
    _patch_urlopen(monkeypatch, returns={"task_id": "t", "base_resp": {}})
    with pytest.raises(ProviderResponseError, match="status_code"):
        RealMinimaxTransport().submit(api_key=SECRET, payload={})


def test_missing_base_resp_is_response_error(monkeypatch) -> None:
    _patch_urlopen(monkeypatch, returns={"task_id": "t"})
    with pytest.raises(ProviderResponseError, match="base_resp"):
        RealMinimaxTransport().submit(api_key=SECRET, payload={})


def test_query_base_resp_as_array_is_response_error(monkeypatch) -> None:
    _patch_urlopen(monkeypatch, returns={"status": "Processing", "base_resp": "x"})
    with pytest.raises(ProviderResponseError, match="base_resp"):
        RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")


def test_retrieve_file_as_array_is_response_error(monkeypatch) -> None:
    _patch_routed(
        monkeypatch,
        {
            "/v1/query/video_generation": {
                "task_id": "tid-1",
                "status": "Success",
                "file_id": 1,
                "base_resp": {"status_code": 0},
            },
            "/v1/files/retrieve": {"file": [1], "base_resp": {"status_code": 0}},
        },
    )
    with pytest.raises(ProviderResponseError, match="malformed file"):
        RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")


def test_query_task_id_mismatch_is_response_error(monkeypatch) -> None:
    # a crossed-wire response must never let this operation adopt another
    # task's status/media.
    _patch_urlopen(
        monkeypatch,
        returns={
            "task_id": "SOMEONE-ELSE",
            "status": "Success",
            "file_id": 1,
            "base_resp": {"status_code": 0},
        },
    )
    with pytest.raises(ProviderResponseError, match="task_id does not match"):
        RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")


def test_file_id_wrong_shape_is_response_error(monkeypatch) -> None:
    # file_id must be an int64 or numeric string; an array must never be
    # stringified into a retrieve request.
    _patch_urlopen(
        monkeypatch,
        returns={
            "task_id": "tid-1",
            "status": "Success",
            "file_id": ["wrong-shape"],
            "base_resp": {"status_code": 0},
        },
    )
    with pytest.raises(ProviderResponseError, match="malformed or missing file_id"):
        RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")


def test_retrieve_file_id_mismatch_is_response_error(monkeypatch) -> None:
    _patch_routed(
        monkeypatch,
        {
            "/v1/query/video_generation": {
                "task_id": "tid-1",
                "status": "Success",
                "file_id": 1,
                "base_resp": {"status_code": 0},
            },
            "/v1/files/retrieve": {
                "file": {"file_id": 999, "download_url": "https://x/out.mp4"},
                "base_resp": {"status_code": 0},
            },
        },
    )
    with pytest.raises(ProviderResponseError, match="does not match the requested"):
        RealMinimaxTransport().poll(api_key=SECRET, external_task_ref="tid-1")


# --- opt-in real smoke (skipped unless explicitly enabled) ----------------


@pytest.mark.skipif(
    os.environ.get("AI_VIDEO_WORKFLOW_REAL_MINIMAX") != "1"
    or not os.environ.get("WFM1_MINIMAX_API_KEY"),
    reason="real MiniMax smoke: needs AI_VIDEO_WORKFLOW_REAL_MINIMAX=1 + key",
)
def test_real_minimax_smoke() -> None:  # pragma: no cover - opt-in only
    import hashlib
    import json as _json
    import tempfile
    import time
    from pathlib import Path

    from ai_video_workflow.app.media_fetch import UrllibMediaFetcher

    key = os.environ["WFM1_MINIMAX_API_KEY"]
    # durable smoke record: the external task id is persisted IMMEDIATELY
    # after submit, so a crash/interrupt never orphans a paid task.
    smoke_dir = Path(os.environ.get("WFM1_SMOKE_DIR", str(Path.home() / ".wfm1-smoke")))
    smoke_dir.mkdir(parents=True, exist_ok=True)

    def _write_record(record_path: Path, payload: dict) -> None:
        # atomic + fsynced so the record survives a crash mid-write; the
        # vendor task id lives only INSIDE the JSON, never in a path.
        raw_fd, tmp_name = tempfile.mkstemp(dir=smoke_dir, suffix=".tmp")
        tmp = Path(tmp_name)
        try:
            with os.fdopen(raw_fd, "w", encoding="utf-8") as stream:
                stream.write(_json.dumps(payload) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, record_path)
        finally:
            try:
                tmp.unlink()
            except OSError:
                pass

    transport = RealMinimaxTransport()
    # MiniMax-Hailuo-02 T2V supports 768P/1080P (not 512P) -- ADR-0009.
    task_id = transport.submit(
        api_key=key,
        payload={
            "model": "MiniMax-Hailuo-02",
            "prompt": "a calm sunrise over the sea",
            "duration": 6,
            "resolution": "768P",
        },
    )
    assert task_id
    # a local digest names the files, so an unexpected vendor task id (e.g.
    # one containing '/') can neither break the write nor escape smoke_dir.
    safe = hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:16]
    record = smoke_dir / f"minimax-smoke-{safe}.json"
    assert record.resolve().parent == smoke_dir.resolve()
    _write_record(record, {"task_id": task_id, "state": "submitted"})

    # poll (with the recommended interval) to a terminal state
    deadline = time.monotonic() + 600
    out = transport.poll(api_key=key, external_task_ref=task_id)
    while out.state == "processing" and time.monotonic() < deadline:
        time.sleep(10)
        out = transport.poll(api_key=key, external_task_ref=task_id)
    _write_record(record, {"task_id": task_id, "state": out.state})

    # a failed (but paid-for) generation is a smoke FAILURE, not a pass
    assert out.state == "succeeded", (
        f"generation did not succeed: {out.state} ({out.error}); "
        f"task recorded at {record}"
    )
    assert out.artifact_url and out.artifact_url.startswith("http")

    # actually download the media (bounded, atomic, never overwriting) to
    # prove the download_url works end to end.
    dest = smoke_dir / f"minimax-smoke-{safe}.mp4"
    UrllibMediaFetcher().fetch(out.artifact_url, dest)
    assert dest.stat().st_size > 0
    _write_record(
        record,
        {"task_id": task_id, "state": "downloaded", "media": str(dest)},
    )

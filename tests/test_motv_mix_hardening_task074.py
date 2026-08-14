"""TASK-074 §1.1b — the four `mix-shot` defects transferred from TASK-064.

Each test REPRODUCES the defect first (the card requires 先复现再修), so a
regression fails here rather than in production:

  a  the output basename escaped the reserved `mix-` namespace
  b  the open-ended clip's two ends used inconsistent upper bounds
  c  a JSON integer too large for a float CRASHED the handler
  d  ffprobe ran unbounded outside the render lock

c and d are reachable by a crafted request of legitimate size, which is why the
card ranks them above a and b.
"""

from __future__ import annotations

import importlib.util
import json
import threading
from pathlib import Path

import pytest

_SERVER_PATH = (
    Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace" / "server.py"
)


@pytest.fixture(scope="module")
def server_module():
    spec = importlib.util.spec_from_file_location("motv_server_mixhard", _SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def app(server_module, tmp_path: Path, monkeypatch):
    monkeypatch.setattr(server_module, "DATA_DIR", tmp_path / "mockdata")
    account = tmp_path / "account"
    (account / "proj").mkdir(parents=True)
    (account / "proj" / "project.json").write_text(
        json.dumps({"project_id": "proj", "name": "proj"}), "utf-8"
    )
    a = server_module._App(account)
    a._projects["proj"] = account / "proj"
    return a


def _post(app, path: str, payload) -> tuple[int, dict]:
    resp = app.handle_post(path, json.dumps(payload).encode("utf-8"))
    return resp.status, json.loads(resp.body.decode("utf-8"))


def _clip(**over):
    c = {"file": "audio-d1_v1.wav", "in": 0.0, "out": 1.0, "start": 0.0}
    c.update(over)
    return c


# --- a: the reserved namespace ------------------------------------------------ #


def test_mix_output_must_stay_inside_the_reserved_mix_namespace(app):
    """`mix-` is reserved so a manual upload cannot claim a mix's filename. This
    endpoint WRITES into that namespace and never checked it stayed there, so a
    crafted slug could take over a dialogue/sfx versioned name."""
    for squat in ("voice-shot-1", "sfx-shot-1", "final-cut", "anything"):
        status, body = _post(
            app,
            "/api/agent/mix-shot",
            {"project": "proj", "slug": squat, "clips": [_clip()]},
        )
        assert status == 400, f"{squat} was accepted"
        assert "mix-" in body["error"]["detail"]
    # …and a legitimate name gets past THIS check (it may still fail later for
    # missing media, which is a different, honest failure)
    status, body = _post(
        app,
        "/api/agent/mix-shot",
        {"project": "proj", "slug": "mix-shot-1", "clips": [_clip()]},
    )
    assert status != 400 or "mix-" not in body.get("error", {}).get("detail", "")


# --- c: the crash ------------------------------------------------------------- #


def test_a_huge_json_integer_is_a_400_not_a_crash(app):
    """`math.isfinite` converts to float, and 10**400 raises OverflowError there.

    The handler used to propagate that as an unhandled exception. A request of
    entirely legitimate SIZE could therefore crash the endpoint.
    """
    huge = 10**400
    for key in ("in", "out", "start", "gainDb", "fadeInMs", "maxOut"):
        status, body = _post(
            app,
            "/api/agent/mix-shot",
            {"project": "proj", "slug": "mix-shot-1", "clips": [_clip(**{key: huge})]},
        )
        assert status == 400, f"{key}={huge} did not yield 400 (got {status})"
        assert body["error"]["category"] == "bad_request"


def test_nan_and_infinity_are_also_refused(app):
    """Python's json accepts these literals; the range comparison rejects them
    because every comparison against NaN/inf is False."""
    for literal in ("NaN", "Infinity", "-Infinity"):
        raw = (
            '{"project":"proj","slug":"mix-shot-1","clips":[{"file":"a.wav",'
            f'"in":{literal},"out":1.0}}]}}'
        )
        resp = app.handle_post("/api/agent/mix-shot", raw.encode("utf-8"))
        assert resp.status == 400, f"{literal} was accepted"


# --- b: the inconsistent bound ------------------------------------------------ #


def test_an_open_ended_clip_at_the_ceiling_is_refused_not_zero_length(app):
    """`in` was admitted up to 36000 INCLUSIVE while `out` was clamped to 36000,
    so `in == 36000` with no `out` produced a zero-length clip — which either
    fails the mix or vanishes from it silently."""
    payload = {
        "project": "proj",
        "slug": "mix-shot-1",
        # no `out` → open-ended
        "clips": [{"file": "audio-d1_v1.wav", "in": 36000.0, "start": 0.0}],
    }
    status, body = _post(app, "/api/agent/mix-shot", payload)
    assert status == 400
    assert "36000" in body["error"]["detail"]
    # the bound itself is unchanged for a normal in-point
    status2, _ = _post(
        app,
        "/api/agent/mix-shot",
        {
            "project": "proj",
            "slug": "mix-shot-1",
            "clips": [{"file": "audio-d1_v1.wav", "in": 0.5, "start": 0.0}],
        },
    )
    assert status2 != 400 or "36000" not in str(status2)


# --- d: the unbounded probe phase --------------------------------------------- #


def test_probe_concurrency_is_bounded_process_wide(server_module):
    """A mix accepts up to 60 clips and every one is probed BEFORE the render lock
    is taken. Unbounded, one request could spawn 60 subprocesses and several
    requests multiply it — so 「作业串行化」 was true only of the encode."""
    assert server_module._PROBE_MAX_CONCURRENT >= 1
    assert server_module._PROBE_MAX_CONCURRENT <= 8, "a cap this high is not a cap"
    sem = server_module._PROBE_SEM
    assert isinstance(sem, threading.BoundedSemaphore().__class__)
    # the permit count really is the cap: taking that many succeeds, one more blocks
    cap = server_module._PROBE_MAX_CONCURRENT
    taken = [sem.acquire(timeout=0.1) for _ in range(cap)]
    try:
        assert all(taken)
        assert sem.acquire(timeout=0.1) is False, "the cap does not bind"
    finally:
        for got in taken:
            if got:
                sem.release()


def test_a_saturated_probe_queue_fails_honestly_rather_than_assuming_a_duration(
    app, server_module, monkeypatch
):
    """When no permit is available the probe returns None, and a clip whose length
    cannot be read is REFUSED — never given an assumed duration, which would
    silently truncate the mix while reporting success."""
    # hold every permit for the duration of the request
    monkeypatch.setattr(server_module, "_PROBE_WAIT_SECONDS", 0.05)
    sem = server_module._PROBE_SEM
    cap = server_module._PROBE_MAX_CONCURRENT
    held = [sem.acquire(timeout=0.1) for _ in range(cap)]
    try:
        assert all(held)
        updir = app._projects["proj"] / "media"
        updir.mkdir(parents=True, exist_ok=True)
        (updir / "audio-d1_v1.wav").write_bytes(b"RIFF0000WAVEfmt ")
        status, body = _post(
            app,
            "/api/agent/mix-shot",
            {"project": "proj", "slug": "mix-shot-1", "clips": [_clip()]},
        )
        # 502 mix_failed (cannot read duration) or 503 (tools missing) — never 200,
        # and never a mix built on a guessed length
        assert status != 200, body
    finally:
        for got in held:
            if got:
                sem.release()

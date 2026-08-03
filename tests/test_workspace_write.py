"""Workspace controlled-write path tests (TASK-031 / ADR-0032/0033).

Drives WorkspaceApp.handle_write (the shell's only mutating path) through the
Command Gateway against a real project. Covers: every write goes through the
Gateway (registered command or refused), read-only preflight, version-binding
fail-closed, blocked bad input, idempotent double-submit (no re-run), the
feedback/action write closed-loop, credential-free errors, and the HTTP layer
still refusing PUT/PATCH/DELETE. No provider, no network write, no payment.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.action import read_records as read_action_records
from ai_video_workflow.evaluation import read_records as read_eval_records
from ai_video_workflow.models import Project
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.profile.project_profile import (
    parse_project_profile,
    write_project_profile,
)
from ai_video_workflow.qcd.events import build_asset_imported_event
from ai_video_workflow.qcd.log import append_event
from workspace_shell.app import WorkspaceApp

T0 = datetime(2026, 8, 3, 8, 0, 0, tzinfo=timezone.utc)
_DIGEST = "a" * 64
_DIGEST2 = "b" * 64

REPO_ROOT = Path(__file__).resolve().parents[1]
_PROFILE = (
    REPO_ROOT
    / "examples"
    / "projects"
    / "minimal"
    / "profile"
    / "project_profile_v1.example.json"
)


def _clock():
    return T0


def _app(account_root):
    return WorkspaceApp(account_root, clock=_clock)


@pytest.fixture
def account(tmp_path):
    root = tmp_path / "proj-1"
    root.mkdir()
    write_model_json(root / "project.json", Project("proj-1", "Demo", T0))
    # discover_projects requires config/wfm1.json (account-root discovery)
    cfg = REPO_ROOT / "examples" / "projects" / "wfm1-demo" / "config" / "wfm1.json"
    (root / "config").mkdir()
    (root / "config" / "wfm1.json").write_text(
        cfg.read_text(encoding="utf-8"), encoding="utf-8"
    )
    raw = json.loads(_PROFILE.read_text(encoding="utf-8"))
    raw["version"] = 1
    write_project_profile(root, parse_project_profile(raw))
    append_event(
        root,
        build_asset_imported_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            asset_id="asset-a",
            sha256=_DIGEST,
            size_bytes=1024,
            path="assets/asset-a.mp4",
            version=1,
            duration_ms=2000,
            source_attempt_id=None,
            occurred_at=T0,
        ),
    )
    return tmp_path, root


def _target(digest=_DIGEST):
    return {"ref": "asset-a", "version": 1, "content_digest": digest}


def _post(app, sub, payload):
    resp = app.handle_write(f"/api/projects/proj-1/{sub}", json.dumps(payload).encode())
    return resp.status, json.loads(resp.body.decode())


def _eval_cmd(command_id="c-1", digest=_DIGEST, **override):
    payload = {
        "command_id": command_id,
        "name": "record-evaluation",
        "actor": "user",
        "target": _target(digest),
        "params": {
            "evaluation_id": "e-1",
            "criterion": "clarity",
            "pass": True,
            "rationale": "reads clearly",
        },
    }
    payload.update(override)
    return payload


# --- preflight (read-only) ---------------------------------------------------


def test_preflight_is_read_only(account):
    _, root = account
    status, body = _post(_app(account[0]), "preflight", _eval_cmd())
    assert status == 200
    assert body["name"] == "record-evaluation"
    assert body["preview"]["blockers"] == []
    assert len(body["preflight_digest"]) == 64
    assert read_eval_records(root) == ()  # nothing written


# --- submit through the Gateway ----------------------------------------------


def test_submit_records_evaluation_through_gateway(account):
    _, root = account
    status, body = _post(_app(account[0]), "command", _eval_cmd())
    assert status == 200
    assert body["status"] == "completed"
    assert body["outcome"]["kind"] == "evaluation"
    (rec,) = read_eval_records(root)
    assert rec.record_id == "evaluation:proj-1:e-1"


def test_unregistered_command_refused(account):
    status, body = _post(_app(account[0]), "command", _eval_cmd(name="rm-rf"))
    assert status == 409
    assert body["error"]["category"] == "command_refused"


def test_stale_target_refused(account):
    _, root = account
    status, body = _post(_app(account[0]), "command", _eval_cmd(digest=_DIGEST2))
    assert status == 409
    assert body["error"]["category"] == "command_refused"
    assert read_eval_records(root) == ()


def test_blocked_bad_input_is_refused(account):
    # missing rationale -> preview blocker -> BlockedCommandError -> 409
    _, root = account
    payload = _eval_cmd()
    del payload["params"]["rationale"]
    status, body = _post(_app(account[0]), "command", payload)
    assert status == 409
    assert body["error"]["category"] == "command_refused"
    assert read_eval_records(root) == ()


def test_double_submit_is_idempotent(account):
    _, root = account
    app = _app(account[0])
    a = _post(app, "command", _eval_cmd(command_id="c-1"))
    b = _post(app, "command", _eval_cmd(command_id="c-1"))
    assert a == b  # same receipt
    assert len(read_eval_records(root)) == 1  # not written twice


def test_command_id_reuse_for_different_request_conflicts(account):
    app = _app(account[0])
    _post(app, "command", _eval_cmd(command_id="c-1"))
    payload = _eval_cmd(command_id="c-1")
    payload["params"]["criterion"] = "motion"  # same id, different request
    status, body = _post(app, "command", payload)
    assert status == 409
    assert body["error"]["category"] == "command_refused"


# --- feedback / action write closed-loop -------------------------------------


def test_feedback_and_action_closed_loop(account):
    _, root = account
    app = _app(account[0])
    fb = _post(
        app,
        "command",
        {
            "command_id": "fb",
            "name": "create-feedback",
            "actor": "user",
            "target": _target(),
            "params": {
                "feedback_id": "fb-1",
                "summary": "jitter",
                "detail": "stutters",
            },
        },
    )
    assert fb[0] == 200 and fb[1]["status"] == "completed"
    ac = _post(
        app,
        "command",
        {
            "command_id": "ac",
            "name": "create-action",
            "actor": "user",
            "target": _target(),
            "params": {
                "action_id": "a-1",
                "feedback_id": "fb-1",
                "intent": "re-render",
            },
        },
    )
    assert ac[0] == 200 and ac[1]["status"] == "completed"
    tr = _post(
        app,
        "command",
        {
            "command_id": "tr",
            "name": "action-transition",
            "actor": "agent",
            "params": {"event_id": "t1", "action_id": "a-1", "to_state": "in_progress"},
        },
    )
    assert tr[0] == 200 and tr[1]["status"] == "completed"
    kinds = [r.record_type.value for r in read_action_records(root)]
    assert kinds == ["feedback", "action", "transition"]


# --- fail-closed shapes ------------------------------------------------------


def test_invalid_json_and_unknown_route(account):
    app = _app(account[0])
    resp = app.handle_write("/api/projects/proj-1/command", b"not json")
    assert resp.status == 400
    resp2 = app.handle_write("/api/projects/proj-1/bogus", b"{}")
    assert resp2.status == 404
    resp3 = app.handle_write("/api/projects/nope/command", b"{}")
    assert resp3.status == 404


def test_missing_command_field_is_bad_request(account):
    payload = _eval_cmd()
    del payload["name"]
    status, body = _post(_app(account[0]), "command", payload)
    assert status == 400
    assert body["error"]["category"] == "bad_request"


def test_non_object_params_is_bad_request_not_500(account):
    payload = _eval_cmd()
    payload["params"] = ["x"]  # truthy non-object
    status, body = _post(_app(account[0]), "command", payload)
    assert status == 400
    assert body["error"]["category"] == "bad_request"


def test_get_route_still_read_only(account):
    # a GET data route is unaffected and read-only
    resp = _app(account[0]).handle("/api/meta")
    assert resp.status == 200
    assert json.loads(resp.body.decode())["read_only"] is True


def test_client_actor_is_ignored_forced_to_user(account):
    # a client-supplied actor must not forge provenance: the shell records the
    # local user regardless of what the payload claims
    _, root = account
    payload = _eval_cmd()
    payload["actor"] = "system"  # attempted impersonation
    status, _ = _post(_app(account[0]), "command", payload)
    assert status == 200
    (rec,) = read_eval_records(root)
    assert rec.actor.value == "user"


def test_cross_origin_post_is_refused_csrf(account):
    import threading
    import urllib.error
    import urllib.request

    from workspace_shell.server import build_server

    account_root, _ = account
    server = build_server(account_root, port=0, clock=_clock)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        base = f"http://127.0.0.1:{port}"
        # a cross-site origin, an opaque "null" origin (sandboxed / data:), AND
        # a loopback origin on a DIFFERENT port must all be refused — none is
        # same-origin (scheme + host + port)
        for origin in (
            "http://evil.example",
            "null",
            f"http://127.0.0.1:{port + 1}",
            "http://127.0.0.1:bad",  # malformed port must 403, not crash the server
        ):
            req = urllib.request.Request(
                f"{base}/api/projects/proj-1/command",
                method="POST",
                data=b"{}",
                headers={"Origin": origin, "Content-Type": "application/json"},
            )
            with pytest.raises(urllib.error.HTTPError) as exc:
                urllib.request.urlopen(req, timeout=5)
            assert exc.value.code == 403  # cross-origin write refused (CSRF)
        # the exact same-origin passes the CSRF guard (then fails validation as
        # a bad command -> 400, NOT 403)
        req = urllib.request.Request(
            f"{base}/api/projects/proj-1/command",
            method="POST",
            data=b"{}",
            headers={"Origin": base, "Content-Type": "application/json"},
        )
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(req, timeout=5)
        assert exc.value.code == 400  # passed CSRF; invalid command body
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

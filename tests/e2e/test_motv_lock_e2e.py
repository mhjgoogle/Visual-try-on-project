"""motv mockup end-to-end tests for the draft lock flow (ADR-0047 / TASK-047).

Drives the mockup backend (``mockups/motv-workspace/server.py`` ``_App``)
directly — no sockets, no browser, STRICTLY OFFLINE (registering the paid
command never contacts a Provider; nothing here submits paid generation).

Covers the UI-visible contract end to end:

- GET ``lock-target`` returns the current plan version + the digest the
  Gateway will verify;
- POST ``preflight`` for ``lock-draft-plan`` previews the full shot table;
- POST ``command`` with the bound confirmation publishes the new plan /
  records / packets (packet carries the draft's first-frame data URL);
- GET ``generation-target`` for a locked shot id points paid generation at
  the NEW record + its packet version;
- mode gating: non-paid mode accepts the no-spend lock command but refuses
  ``submit-video-generation``.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from ai_video_workflow.planning import load_packet
from tests.gateway_scenario import FRAME, _draft_shot, _setup_project

_SERVER_PATH = (
    Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace" / "server.py"
)


@pytest.fixture(scope="module")
def server_module():
    spec = importlib.util.spec_from_file_location("motv_server_e2e", _SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module._QUERY_OK, "mockup E2E requires the venv (query package)"
    return module


def _app(server_module, tmp_path: Path, *, paid: bool):
    project, catalog_dir = _setup_project(tmp_path)
    app = server_module._App(tmp_path, paid_catalog_dir=catalog_dir if paid else None)
    assert "project-a" in app._projects
    return app, project


def _get(app, path: str) -> tuple[int, dict]:
    resp = app.handle(path)
    return resp.status, json.loads(resp.body.decode("utf-8"))


def _post(app, path: str, payload: dict) -> tuple[int, dict]:
    body = json.dumps(payload).encode("utf-8")
    resp = app.handle_post(path, body)
    return resp.status, json.loads(resp.body.decode("utf-8"))


def _lock_payload(target: dict, params: dict, *, command_id: str = "cmd-e2e-1") -> dict:
    shots = [_draft_shot() for _ in range(5)] + [
        _draft_shot(title="终幕", description="full sunrise", first_frame_image=FRAME)
    ]
    return {
        "command_id": command_id,
        "name": "lock-draft-plan",
        "params": {**params, "shots": shots},
        "target": target,
    }


def test_lock_flow_end_to_end(server_module, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS", "1")
    app, project = _app(server_module, tmp_path, paid=True)

    # 1. lock coordinates: current plan version + the digest submit verifies
    status, tgt = _get(app, "/api/projects/project-a/lock-target")
    assert status == 200
    assert tgt["params"] == {"plan_version": 1}
    assert tgt["target"]["ref"] == "planning/shot_plan_v1.json"

    # 2. read-only preflight: full shot table, no blockers, bound digest
    payload = _lock_payload(tgt["target"], tgt["params"])
    status, pf = _post(app, "/api/projects/project-a/preflight", payload)
    assert status == 200
    assert pf["is_high_risk"] is True
    assert pf["preview"]["blockers"] == []
    rows = pf["preview"]["inputs"]["shots"]
    assert [r["shot_id"] for r in rows] == [f"shot-p2-{i}" for i in range(1, 7)]
    assert rows[5]["first_frame_sha256"] is not None
    assert pf["preview"]["estimated_cost"] is None  # locking never spends

    # 3. confirmed submit: COMPLETED receipt, new plan/records/packets
    status, receipt = _post(
        app,
        "/api/projects/project-a/command",
        {**payload, "confirmation": pf["preflight_digest"]},
    )
    assert status == 200
    assert receipt["status"] == "completed"
    outcome = receipt["outcome"]
    assert outcome["plan_version"] == 2
    assert outcome["production_lock"] == "re-approved"

    # the packet paid generation will re-verify carries the draft first frame
    packet = load_packet(project, "shot-p2-6", 1)
    assert packet.first_frame_image == FRAME
    assert packet.prompt_text == "full sunrise"
    assert packet.capability == "image_to_video"

    # 4. generation-target for a locked shot: NEW record + its packet version
    status, gen = _get(
        app, "/api/projects/project-a/generation-target?shot_id=shot-p2-6"
    )
    assert status == 200
    assert gen["params"] == {
        "task_id": "task-shot-p2-6-1",
        "shot_id": "shot-p2-6",
        "packet_version": 1,
    }
    assert gen["target"]["ref"] == "shot-p2-6"

    # 5. lock-target now points at the NEW plan version (a second lock
    #    supersedes v2, never edits it)
    status, tgt2 = _get(app, "/api/projects/project-a/lock-target")
    assert status == 200
    assert tgt2["params"] == {"plan_version": 2}


def test_nonpaid_mode_allows_lock_but_refuses_paid(
    server_module, tmp_path: Path
) -> None:
    app, project = _app(server_module, tmp_path, paid=False)

    # lock-target and the lock command work without --enable-paid
    status, tgt = _get(app, "/api/projects/project-a/lock-target")
    assert status == 200
    payload = _lock_payload(tgt["target"], tgt["params"], command_id="cmd-e2e-np")
    status, pf = _post(app, "/api/projects/project-a/preflight", payload)
    assert status == 200
    assert pf["preview"]["blockers"] == []
    status, receipt = _post(
        app,
        "/api/projects/project-a/command",
        {**payload, "confirmation": pf["preflight_digest"]},
    )
    assert status == 200
    assert receipt["status"] == "completed"
    assert (project / "planning" / "shot_plan_v2.json").is_file()

    # the paid command stays forbidden in non-paid mode
    status, err = _post(
        app,
        "/api/projects/project-a/preflight",
        {
            "command_id": "cmd-paid-refused",
            "name": "submit-video-generation",
            "params": {},
            "target": None,
        },
    )
    assert status == 403
    assert err["error"]["category"] == "forbidden"

    # generation-target remains a paid-mode surface
    status, _ = _get(app, "/api/projects/project-a/generation-target?shot_id=shot-p2-1")
    assert status == 403


def test_command_route_accepts_inline_first_frames(server_module) -> None:
    # the preflight/command routes share the transport ceiling so multi-MB
    # inline first-frame data URLs are not rejected as "too large" JSON
    app = server_module._App(None, None)
    big = b"x" * (server_module._GATEWAY_BODY_MAX + 1)
    resp = app.handle_post("/api/projects/p/preflight", big)
    assert resp.status != 413
    resp = app.handle_post("/api/agent/tts", big)
    assert resp.status == 413

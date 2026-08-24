"""WQ-16 Action Center read-only query + action CLI tests (TASK-029 / ADR-0035).

Drives WQ-16 through WorkspaceQueryService against a project holding
authoritative asset facts and feedback/action records, and smoke-tests the
write CLI. Covers folded lifecycle state, derived staleness (+ problem),
fail-closed corrupt log, determinism (rebuild-check), and the read-only posture.
No provider, no network, no payment.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

import ai_video_workflow.cli as cli
from ai_video_workflow.action import ActionActor, ActionService, WorkflowTargetResolver
from ai_video_workflow.action.log import log_path
from ai_video_workflow.models import Project
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.qcd.events import build_asset_imported_event
from ai_video_workflow.qcd.log import append_event
from ai_video_workflow.workspace import Provenance, WorkspaceQueryService

T0 = datetime(2026, 8, 3, 8, 0, 0, tzinfo=timezone.utc)
_DIGEST = "a" * 64
_DIGEST2 = "b" * 64


def _clock():
    return T0


def _import_asset(root, *, asset_id, version, sha):
    append_event(
        root,
        build_asset_imported_event(
            project_id="proj-1",
            shot_id="shot-1",
            task_id="task-1",
            asset_id=asset_id,
            sha256=sha,
            size_bytes=1024,
            path=f"assets/{asset_id}.mp4",
            version=version,
            duration_ms=2000,
            source_attempt_id=None,
            occurred_at=T0,
        ),
    )


def _target(ref="asset-a", version=1, digest=_DIGEST):
    return {"ref": ref, "version": version, "content_digest": digest}


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "proj-1"
    root.mkdir()
    write_model_json(root / "project.json", Project("proj-1", "Demo", T0))
    _import_asset(root, asset_id="asset-a", version=1, sha=_DIGEST)
    return root


def _svc(root):
    return ActionService(
        root, "proj-1", resolver=WorkflowTargetResolver(), clock=_clock
    )


def _query(account_root):
    return WorkspaceQueryService(account_root, clock=_clock)


def _seed(root):
    svc = _svc(root)
    svc.create_feedback(
        actor=ActionActor.USER,
        feedback_id="fb-1",
        target=_target(),
        context={"stage": "S1"},
        summary="jitter",
        detail="stutters",
        occurred_at=T0,
    )
    svc.create_action(
        actor=ActionActor.USER,
        action_id="act-1",
        feedback_id="fb-1",
        target=_target(),
        context={"stage": "S1"},
        intent="re-render",
        occurred_at=T0 + timedelta(seconds=1),
    )
    svc.transition(
        actor=ActionActor.AGENT,
        event_id="t1",
        action_id="act-1",
        to_state="in_progress",
        occurred_at=T0 + timedelta(seconds=2),
    )


# --- WQ-16 ------------------------------------------------------------------


def test_wq16_lists_feedback_and_action_with_folded_state(project):
    _seed(project)
    res = _query(project.parent).action_center(project)
    assert res.query_id == "WQ-16"
    assert res.contract_version == "1.6"
    kinds = [it["kind"].value for it in res.items]
    assert kinds == ["feedback", "action"]
    action = res.items[1]
    assert action["lifecycle_state"].value == "in_progress"
    assert action["lifecycle_state"].provenance is Provenance.DERIVED
    assert action["target_stale"].value is False
    assert action["feedback_id"].value == "fb-1"
    assert len(action["event_trail"].value) == 1


def test_wq16_stale_action_flagged_with_problem(project):
    # Write an action bound to a target the QCD facts do NOT contain, using a
    # permissive write resolver; the read query uses the real resolver, so the
    # target no longer resolves -> the action is stale -> a structured,
    # non-readiness problem is emitted alongside the (still authoritative) fact.
    from ai_video_workflow.action import ResolvedTarget

    class _Permissive:
        def resolve_target(self, root, *, ref, version):
            return ResolvedTarget(exists=True, content_digest=_DIGEST2)

    svc = ActionService(project, "proj-1", resolver=_Permissive(), clock=_clock)
    svc.create_feedback(
        actor=ActionActor.USER,
        feedback_id="fb-9",
        target=_target("asset-z", 1, _DIGEST2),
        context={},
        summary="s",
        detail="d",
        occurred_at=T0,
    )
    svc.create_action(
        actor=ActionActor.USER,
        action_id="act-9",
        feedback_id="fb-9",
        target=_target("asset-z", 1, _DIGEST2),
        context={},
        intent="fix",
        occurred_at=T0 + timedelta(seconds=1),
    )
    res = _query(project.parent).action_center(project)
    action = next(it for it in res.items if it["kind"].value == "action")
    assert action["target_stale"].value is True
    assert action["effective_state"].value == "stale"
    assert any(p.category.value == "digest_mismatch" for p in res.problems)
    assert res.readiness_failed is False


def test_wq16_empty_and_corrupt(project):
    empty = _query(project.parent).action_center(project)
    assert empty.items == ()
    assert empty.problems == ()
    log_path(project).parent.mkdir(parents=True, exist_ok=True)
    log_path(project).write_text("not json\n", encoding="utf-8")
    corrupt = _query(project.parent).action_center(project)
    assert corrupt.items == ()
    assert any(p.category.value == "source_corrupt" for p in corrupt.problems)


def test_resolver_rejects_foreign_project_asset(project):
    # a foreign-project asset_imported in this project's QCD log must not make a
    # target resolve as authoritative (cross-project target-binding integrity)
    append_event(
        project,
        build_asset_imported_event(
            project_id="other-proj",  # NOT proj-1
            shot_id="shot-1",
            task_id="task-9",
            asset_id="asset-foreign",
            sha256=_DIGEST2,
            size_bytes=1024,
            path="assets/x.mp4",
            version=1,
            duration_ms=2000,
            source_attempt_id=None,
            occurred_at=T0,
        ),
    )
    resolver = WorkflowTargetResolver()
    # the local (proj-1) asset resolves; the foreign one does not
    assert resolver.resolve_target(project, ref="asset-a", version=1).exists is True
    assert (
        resolver.resolve_target(project, ref="asset-foreign", version=1).exists is False
    )


def test_wq16_fails_closed_on_corrupt_qcd_log(project):
    # a corrupt authoritative QCD log (used for stale derivation) must not raise
    # out of the read-only query; the resolver reads it as unresolved (stale)
    _seed(project)
    from ai_video_workflow.qcd.log import log_path as qcd_log_path

    qcd_log_path(project).write_text("not-json-qcd\n", encoding="utf-8")
    res = _query(project.parent).action_center(project)  # must not raise
    assert res.query_id == "WQ-16"
    action = next(it for it in res.items if it["kind"].value == "action")
    assert action["target_stale"].value is True


def test_wq16_rebuild_check_deterministic(project):
    _seed(project)
    res = _query(project.parent).rebuild_check(project, "WQ-16")
    assert res.query_id == "WQ-10"
    assert res.readiness_failed is False


# --- write CLI smoke ---------------------------------------------------------


def _run(root, *args):
    return cli.main(["--project-root", str(root), *args])


def test_cli_feedback_and_action_flow(project, monkeypatch, capsys):
    monkeypatch.setattr(cli, "utc_now", _clock)
    tgt = [
        "--target-ref",
        "asset-a",
        "--target-version",
        "1",
        "--target-digest",
        _DIGEST,
    ]
    assert (
        _run(
            project,
            "feedback-create",
            "--actor",
            "user",
            "--id",
            "fb-1",
            *tgt,
            "--summary",
            "jitter",
            "--detail",
            "stutters",
        )
        == 0
    )
    assert (
        _run(
            project,
            "action-create",
            "--actor",
            "user",
            "--id",
            "act-1",
            "--feedback-id",
            "fb-1",
            *tgt,
            "--intent",
            "re-render",
        )
        == 0
    )
    assert (
        _run(
            project,
            "action-transition",
            "--actor",
            "agent",
            "--event-id",
            "t1",
            "--action-id",
            "act-1",
            "--to-state",
            "in_progress",
        )
        == 0
    )
    out = _run(project, "ws-action-center")
    assert out == 0
    printed = capsys.readouterr().out
    assert "WQ-16" in printed and "in_progress" in printed


def test_cli_handle_partial_new_artifact_is_rejected(project, monkeypatch, capsys):
    monkeypatch.setattr(cli, "utc_now", _clock)
    tgt = [
        "--target-ref",
        "asset-a",
        "--target-version",
        "1",
        "--target-digest",
        _DIGEST,
    ]
    _run(
        project,
        "feedback-create",
        "--actor",
        "user",
        "--id",
        "fb-1",
        *tgt,
        "--summary",
        "s",
        "--detail",
        "d",
    )
    _run(
        project,
        "action-create",
        "--actor",
        "user",
        "--id",
        "act-1",
        "--feedback-id",
        "fb-1",
        *tgt,
        "--intent",
        "fix",
    )
    _run(
        project,
        "action-transition",
        "--actor",
        "agent",
        "--event-id",
        "t1",
        "--action-id",
        "act-1",
        "--to-state",
        "in_progress",
    )
    # an empty --new-digest is "provided" but invalid: a clean error, not a
    # silently-dropped partial bundle recorded as new_artifact=None
    code = _run(
        project,
        "action-handle",
        "--actor",
        "agent",
        "--event-id",
        "h1",
        "--action-id",
        "act-1",
        "--note",
        "n",
        "--new-ref",
        "asset-a",
        "--new-version",
        "1",
        "--new-digest",
        "",
    )
    assert code == 1
    assert "FieldTypeError" in capsys.readouterr().err


def test_cli_context_credential_rejected(project, monkeypatch, capsys):
    monkeypatch.setattr(cli, "utc_now", _clock)
    tgt = [
        "--target-ref",
        "asset-a",
        "--target-version",
        "1",
        "--target-digest",
        _DIGEST,
    ]
    code = _run(
        project,
        "feedback-create",
        "--actor",
        "user",
        "--id",
        "fb-x",
        *tgt,
        "--context",
        "token=secretvalue",
        "--summary",
        "s",
        "--detail",
        "d",
    )
    assert code == 1
    assert "InvariantViolationError" in capsys.readouterr().err

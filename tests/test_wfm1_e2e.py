"""WFM1 end-to-end offline acceptance (TASK-023).

One episode — one character, one scene, 6 shots, 60 seconds — driven
through the REAL CLI/driver coordination chain with a fake paid provider
and fake media tools (no network, no payment, no ffmpeg):

profile → reuse → planning → stage approvals → task packets →
paid generation → M1 integration → composition → QC → human review →
release package → archive/postmortem.

Plus the fault/recovery matrix (stale approval, budget denial, ambiguous
submit, interrupt-resume), the two-project reuse/monthly-budget
evidence, and a projection-readiness check that rebuilds plan, progress,
lineage, and cost purely from authoritative files, deterministically.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import ai_video_workflow.cli as cli
from ai_video_workflow.app.contracts import staging_ref_for
from ai_video_workflow.app.paid_lifecycle import build_lineage
from ai_video_workflow.approval import stage_status
from ai_video_workflow.budget.ledger import build_ledger
from ai_video_workflow.budget.reservation import hold_reservation, list_reservations
from ai_video_workflow.config import compute_catalog_digest
from ai_video_workflow.config.project_config import FxConfig
from ai_video_workflow.inspection.base import MediaProbeResult
from ai_video_workflow.models import Project, Scene, Shot
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.planning import load_packet, load_shot_plan
from ai_video_workflow.providers.registry import ProviderRegistry
from ai_video_workflow.qcd import aggregate_events
from ai_video_workflow.qcd.log import read_events
from tests.media_fakes import FakeMediaInspector, FakeVideoComposer
from tests.paid_fakes import FakeFetcher, FakeProvider

T0 = datetime(2026, 8, 2, 9, 0, 0, tzinfo=timezone.utc)
SHOTS = 6
SECONDS_EACH = 10  # 6 x 10s = 60s episode


class _Clock:
    def __init__(self) -> None:
        self._n = 0

    def __call__(self) -> datetime:
        self._n += 1
        return T0 + timedelta(minutes=self._n)


def _catalog_raw() -> dict:
    return {
        "schema_version": 1,
        "catalog_id": "demo",
        "version": 1,
        "providers": {
            "fake-a": {
                "display_name": "Fake paid provider",
                "capabilities": ["image_to_video", "text_to_video"],
                "credential_env_vars": [],
                "models": {
                    "m1": {
                        "billing_mode": "per_clip",
                        "currency": "USD",
                        "clip_prices": [
                            {
                                "resolution": "512p",
                                "duration_seconds": SECONDS_EACH,
                                "amount_minor_units": 10,
                            }
                        ],
                        "per_second_minor_units": {},
                    }
                },
            }
        },
    }


def _seed_episode(account: Path, name: str = "wfm1-demo") -> Path:
    root = account / name
    (root / "records" / "scenes").mkdir(parents=True)
    (root / "records" / "shots").mkdir(parents=True)
    write_model_json(root / "project.json", Project("proj-demo", "Demo", T0))
    write_model_json(
        root / "records" / "scenes" / "scene-1.json",
        Scene("scene-1", "proj-demo", 1, "S1", "one location", T0),
    )
    for i in range(1, SHOTS + 1):
        write_model_json(
            root / "records" / "shots" / f"shot-{i}.json",
            Shot(
                shot_id=f"shot-{i}",
                scene_id="scene-1",
                sequence=i,
                description=f"shot {i}",
                prompt=f"a cinematic shot {i}",
                duration_seconds=float(SECONDS_EACH),
                width=512,
                height=512,
                frame_rate=24.0,
                created_at=T0,
            ),
        )
    return root


def _write_config(root: Path, catalog_digest: str) -> None:
    (root / "config").mkdir()
    (root / "config" / "wfm1.json").write_text(
        json.dumps(
            {
                "schema_version": 2,
                "default_provider": "fake-a",
                "fallback_provider": None,
                "shot_overrides": {},
                "budgets_jpy": {
                    "episode_soft": 1200,
                    "episode_hard": 1500,
                    "monthly_hard": 5000,
                    "per_shot": 400,
                },
                "fx": {"base_currency": "JPY", "rates": {"USD": 160}},
                "catalog_id": "demo",
                "catalog_version": 1,
                "catalog_digest": catalog_digest,
            }
        ),
        encoding="utf-8",
    )


def _author_creative(root: Path) -> None:
    prompts = {
        "schema_version": 1,
        "prompt_id": "p-main",
        "version": 1,
        "text": "a young woman with short black hair, cinematic lighting",
        "previous_version": None,
        "change_reason": None,
        "reference_assets": ["character-mia"],
    }
    brief = {
        "schema_version": 1,
        "version": 1,
        "logline": "one act of kindness, one irreversible cost",
        "primary_load": "人性光辉",
        "secondary_load": None,
        "synopsis": "a stranger pays a debt no one asked her to pay",
    }
    story = {
        "schema_version": 1,
        "version": 1,
        "beats": [
            {"beat_id": "open", "description": "fast open"},
            {"beat_id": "turn", "description": "irreversible choice"},
            {"beat_id": "after", "description": "quiet afterglow"},
        ],
        "screenplay_md": None,
    }
    plan = {
        "schema_version": 1,
        "version": 1,
        "shots": [
            {
                "shot_id": f"shot-{i}",
                "sequence": i,
                "prompt_ref": {"prompt_id": "p-main", "version": 1},
                "duration_seconds": SECONDS_EACH,
                "resolution": "512p",
                "capability": "text_to_video",
                "model_id": "m1",
                "width": 512,
                "height": 512,
                "frame_rate": 24.0,
                "reuse_assets": ["character-mia"],
                "first_frame_image": None,
            }
            for i in range(1, SHOTS + 1)
        ],
    }
    profile = {
        "schema_version": 1,
        "version": 1,
        "title": "Demo Episode",
        "genre": "human-warmth short drama",
        "audience": "short-video viewers",
        "duration_target_seconds": 60,
        "aspect_ratio": "9:16",
        "language": "zh",
        "visual_style": "cinematic stylized",
        "release_targets": ["short-video-platform"],
        "budget_ref": "config/wfm1.json",
        "intent": "one irreversible kindness, shown not told",
        "narrative_goals": ["fast open", "quiet afterglow"],
        "quality_bar": ["face consistency"],
        "forbidden_issues": ["preachy dialogue"],
        "success_criteria": ["watchable 60s cut", "episode cost <= 1200 JPY"],
    }
    from ai_video_workflow.planning import (
        publish_brief,
        publish_prompt,
        publish_shot_plan,
        publish_story,
    )
    from ai_video_workflow.profile import parse_project_profile, write_project_profile

    publish_prompt(root, prompts)
    publish_brief(root, brief)
    publish_story(root, story)
    publish_shot_plan(root, plan)
    write_project_profile(root, parse_project_profile(profile))


def _use_fakes(monkeypatch, provider: FakeProvider) -> None:
    from ai_video_workflow.providers.manual import ManualVideoProvider

    monkeypatch.setattr(cli, "utc_now", _Clock())
    monkeypatch.setattr(
        cli,
        "FfprobeMediaInspector",
        lambda: FakeMediaInspector(
            result=MediaProbeResult("mp4", float(SECONDS_EACH), 512, 512, 24.0)
        ),
    )
    monkeypatch.setattr(cli, "FfmpegVideoComposer", FakeVideoComposer)
    monkeypatch.setattr(cli, "UrllibMediaFetcher", FakeFetcher)

    def _registry():
        reg = ProviderRegistry()
        reg.register(provider.provider_id, lambda entry: provider)
        reg.register("manual", lambda entry: ManualVideoProvider())
        return reg

    monkeypatch.setattr(cli, "default_registry", _registry)


def _run(root, catalog_dir, *args) -> int:
    return cli.main(
        ["--project-root", str(root), "--catalog-dir", str(catalog_dir), *args]
    )


def _approve(root, catalog_dir, stage: str, target: str) -> None:
    assert _run(root, catalog_dir, "stage-review", stage, "--by", "owner") == 0
    assert (
        _run(
            root,
            catalog_dir,
            "stage-approve",
            stage,
            "--by",
            "owner",
            "--target",
            target,
        )
        == 0
    )


def _setup(tmp_path: Path, monkeypatch) -> tuple[Path, Path, FakeProvider]:
    account = tmp_path
    catalog_dir = tmp_path / "catalog"
    catalog_dir.mkdir()
    raw = _catalog_raw()
    (catalog_dir / "demo.json").write_text(json.dumps(raw), encoding="utf-8")

    root = _seed_episode(account)
    _write_config(root, compute_catalog_digest(raw))

    # one reusable character published at the account level
    from ai_video_workflow.profile import parse_pack, publish_pack_version

    publish_pack_version(
        account,
        parse_pack(
            {
                "schema_version": 1,
                "asset_id": "character-mia",
                "version": 1,
                "kind": "character",
                "content": {"name": "Mia", "look": "grey coat"},
            }
        ),
    )
    fake = FakeProvider(provider_id="fake-a")
    _use_fakes(monkeypatch, fake)
    assert (
        _run(
            root,
            catalog_dir,
            "reuse-add-ref",
            "--asset-id",
            "character-mia",
            "--version",
            "1",
        )
        == 0
    )
    _author_creative(root)
    _approve(root, catalog_dir, "concept_lock", "planning/brief_v1.json")
    _approve(root, catalog_dir, "screenplay_lock", "planning/story_v1.json")
    _approve(root, catalog_dir, "av_design_lock", "planning/prompts/p-main/v1.json")
    _approve(root, catalog_dir, "production_lock", "planning/shot_plan_v1.json")
    return root, catalog_dir, fake


def _compile(root, catalog_dir) -> None:
    assert _run(root, catalog_dir, "init-tasks") == 0
    assert _run(root, catalog_dir, "plan-compile") == 0


def _packet_submit(root, catalog_dir, task_id: str, shot: str, op: str) -> int:
    """The WFM1 paid entry: the request comes from the verified packet."""
    return _run(
        root,
        catalog_dir,
        "paid-submit",
        task_id,
        "--shot",
        shot,
        "--operation-id",
        op,
        "--packet-version",
        "1",
    )


def _paid_all_shots(root, catalog_dir) -> None:
    _compile(root, catalog_dir)
    for i in range(1, SHOTS + 1):
        task_id = f"task-shot-{i}-1"
        assert _packet_submit(root, catalog_dir, task_id, f"shot-{i}", f"op-{i}") == 0
        assert _run(root, catalog_dir, "paid-integrate", task_id) == 0


# =============================================================================
# 1. the full offline episode
# =============================================================================


def test_full_episode_offline(tmp_path: Path, monkeypatch) -> None:
    root, catalog_dir, fake = _setup(tmp_path, monkeypatch)

    # compile first: the planned budget preview must exist BEFORE any spend
    _compile(root, catalog_dir)
    plan = load_shot_plan(root)
    assert len(plan.shots) == SHOTS
    assert plan.total_duration_seconds == 60
    packets = [load_packet(root, f"shot-{i}", 1) for i in range(1, SHOTS + 1)]
    assert sum(p.p90_jpy for p in packets) <= 1200

    _paid_all_shots(root, catalog_dir)
    assert _run(root, catalog_dir, "compose") == 0
    assert (root / "outputs" / "final_v1.mp4").is_file()

    # S6/S7: QC -> human review -> stage approvals -> release -> archive
    assert _run(root, catalog_dir, "qc-run") == 0
    assert (
        _run(
            root,
            catalog_dir,
            "qc-review",
            "--verdict",
            "pass",
            "--by",
            "owner",
            "--reason",
            "meets the goals baseline",
        )
        == 0
    )
    _approve(root, catalog_dir, "assets_ready", "qc/technical_qc_v1.json")
    _approve(root, catalog_dir, "assembly_done", "reports/composition/final_v1.json")
    _approve(root, catalog_dir, "qc_release", "qc/final_review_v1.json")
    assert _run(root, catalog_dir, "package-release") == 0
    assert _run(root, catalog_dir, "archive-project") == 0
    _approve(root, catalog_dir, "retrospective", "archive/postmortem_v1.json")

    # every stage has explicit approved status with evidence
    states = {s.stage_id: s for s in stage_status(root)}
    assert all(s.status == "approved" for s in states.values())
    assert all(not s.stale for s in states.values())

    # actual derived cost stays inside the 1200 JPY target and is auditable
    events = read_events(root)
    summary = aggregate_events(events, data=cli._load_project_data(root))
    assert summary.per_project.cost_by_currency.get("USD") == SHOTS * 10
    fx = FxConfig(base_currency="JPY", rates={"USD": 160})
    assert build_ledger(events, fx).project_total_jpy == SHOTS * 16  # 96 <= 1200

    # exactly one cost event per shot (no double booking anywhere)
    cost_events = [e for e in events if e.event_type.value == "provider_cost_recorded"]
    assert len(cost_events) == SHOTS


# =============================================================================
# 2. fault / recovery matrix
# =============================================================================


def test_fault_matrix(tmp_path: Path, monkeypatch) -> None:
    root, catalog_dir, fake = _setup(tmp_path, monkeypatch)
    assert _run(root, catalog_dir, "init-tasks") == 0
    assert _run(root, catalog_dir, "plan-compile") == 0

    # (a) stale approval: tamper an approved target -> zero provider calls
    # (a transitively-stale prerequisite blocks the packet-gated entry)
    brief = root / "planning" / "brief_v1.json"
    original = brief.read_text(encoding="utf-8")
    brief.write_text(original.replace("kindness", "KINDNESS"), encoding="utf-8")
    calls = fake.total_calls
    assert _packet_submit(root, catalog_dir, "task-shot-1-1", "shot-1", "op-stale") == 1
    assert fake.total_calls == calls  # approval gate: zero calls
    assert list_reservations(root) == ()  # and zero reservations
    brief.write_text(original, encoding="utf-8")  # restore

    # (b) budget denial: a pre-existing hold near the episode cap -> zero calls
    hold_reservation(
        root,
        project_id="proj-demo",
        task_id="task-blocker",
        operation_id="op-big",
        shot_id="shot-9",
        provider_id="fake-a",
        model_id="m1",
        estimate_jpy=1495,
        created_at=T0.isoformat(),
    )
    calls = fake.total_calls
    assert (
        _packet_submit(root, catalog_dir, "task-shot-1-1", "shot-1", "op-denied") == 1
    )
    assert fake.total_calls == calls  # budget gate: zero calls
    from ai_video_workflow.budget.reservation import release_reservation

    release_reservation(root, "task-blocker", "op-big", resolved_at=T0.isoformat())

    # (c) ambiguous submit: needs_reconciliation, re-run does NOT re-submit
    fake.behavior = "timeout_after_dispatch"
    assert _packet_submit(root, catalog_dir, "task-shot-2-1", "shot-2", "op-amb") == 1
    submits = fake.calls["submit"]
    assert _packet_submit(root, catalog_dir, "task-shot-2-1", "shot-2", "op-amb") == 1
    assert fake.calls["submit"] == submits  # zero re-submission
    # a DIFFERENT operation id on the same task is refused outright: the
    # ambiguous charge must be reconciled, never re-paid around
    assert _packet_submit(root, catalog_dir, "task-shot-2-1", "shot-2", "op-amb2") == 1
    assert fake.calls["submit"] == submits  # operation guard: zero calls
    assert (
        len([r for r in list_reservations(root) if r.task_id == "task-shot-2-1"]) == 1
    )
    # integration is blocked pending a human decision
    assert _run(root, catalog_dir, "paid-integrate", "task-shot-2-1") == 1

    # (d) download failure: cost is committed exactly once, media stays
    # pending, and poll-media recovers WITHOUT re-submitting or re-paying
    fake.behavior = "succeed"

    class _FailingFetcher:
        def fetch(self, reference: str, dest: Path) -> None:
            raise OSError("network down during download")

    monkeypatch.setattr(cli, "UrllibMediaFetcher", _FailingFetcher)
    assert _packet_submit(root, catalog_dir, "task-shot-1-1", "shot-1", "op-ok") == 0
    # success_media_pending: paid, awaiting a re-fetch
    assert not (root / staging_ref_for("task-shot-1-1")).exists()
    # integration is blocked until receipt-verified media exists
    assert _run(root, catalog_dir, "paid-integrate", "task-shot-1-1") == 1
    # the network comes back: resume via the persisted external task ref
    monkeypatch.setattr(cli, "UrllibMediaFetcher", FakeFetcher)
    submits = fake.calls["submit"]
    assert (
        _run(
            root,
            catalog_dir,
            "poll-media",
            "task-shot-1-1",
            "--shot",
            "shot-1",
            "--operation-id",
            "op-ok",
        )
        == 0
    )
    assert fake.calls["submit"] == submits  # zero re-submission
    assert (root / staging_ref_for("task-shot-1-1")).is_file()

    # (e) interrupt/resume: integration proceeds and is idempotent
    assert _run(root, catalog_dir, "paid-integrate", "task-shot-1-1") == 0
    submits = fake.calls["submit"]
    assert _run(root, catalog_dir, "paid-integrate", "task-shot-1-1") == 0
    assert fake.calls["submit"] == submits
    # cost booked exactly once for the successful operation
    cost_events = [
        e for e in read_events(root) if e.event_type.value == "provider_cost_recorded"
    ]
    assert len(cost_events) == 1

    # (f) double-payment guard: a NEW operation id on the already-paid task
    # is refused before any hold or provider call — cost stays booked once
    assert _packet_submit(root, catalog_dir, "task-shot-1-1", "shot-1", "op-2nd") == 1
    assert fake.calls["submit"] == submits  # zero re-submission
    cost_events = [
        e for e in read_events(root) if e.event_type.value == "provider_cost_recorded"
    ]
    assert len(cost_events) == 1  # still exactly one charge


# =============================================================================
# 2b. the packet gate: only verified, approved packets can spend money
# =============================================================================


def test_packet_gate_blocks_unverified_paid_input(tmp_path: Path, monkeypatch) -> None:
    root, catalog_dir, fake = _setup(tmp_path, monkeypatch)
    _compile(root, catalog_dir)

    # free-form parameters without the explicit ad-hoc opt-in are refused
    calls = fake.total_calls
    assert (
        _run(
            root,
            catalog_dir,
            "paid-submit",
            "task-shot-1-1",
            "--shot",
            "shot-1",
            "--operation-id",
            "op-x",
            "--model",
            "m1",
            "--resolution",
            "512p",
            "--duration",
            str(SECONDS_EACH),
        )
        == 1
    )
    # mixing a packet with free-form overrides is refused
    assert (
        _run(
            root,
            catalog_dir,
            "paid-submit",
            "task-shot-1-1",
            "--shot",
            "shot-1",
            "--operation-id",
            "op-x",
            "--packet-version",
            "1",
            "--resolution",
            "768p",
        )
        == 1
    )
    # --stage is also a free-form parameter: the packet path pins the
    # stage to production_lock and refuses an explicit override
    assert (
        _run(
            root,
            catalog_dir,
            "paid-submit",
            "task-shot-1-1",
            "--shot",
            "shot-1",
            "--operation-id",
            "op-x",
            "--packet-version",
            "1",
            "--stage",
            "concept_lock",
        )
        == 1
    )
    assert fake.total_calls == calls
    assert list_reservations(root) == ()

    # a tampered packet file (stored digest kept intact) is refused: the
    # content is recomputed from authoritative inputs, never trusted
    packet_path = root / "planning" / "packets" / "shot-1_v1.json"
    raw = json.loads(packet_path.read_text(encoding="utf-8"))
    raw["prompt"]["text"] = "EVIL injected prompt"
    packet_path.write_text(json.dumps(raw), encoding="utf-8")
    assert _packet_submit(root, catalog_dir, "task-shot-1-1", "shot-1", "op-x") == 1
    assert fake.total_calls == calls
    assert list_reservations(root) == ()

    # an FX change invalidates old quotes: the stale packet cannot pay,
    # and recompiling produces a NEW version with the new conversion
    packet_path.unlink()  # drop the tampered copy
    assert _run(root, catalog_dir, "plan-compile") == 0  # regenerate v1
    config_path = root / "config" / "wfm1.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["fx"]["rates"]["USD"] = 200
    config_path.write_text(json.dumps(config), encoding="utf-8")
    assert _packet_submit(root, catalog_dir, "task-shot-1-1", "shot-1", "op-x") == 1
    assert fake.total_calls == calls
    assert _run(root, catalog_dir, "plan-compile") == 0
    from ai_video_workflow.planning import load_packet as _load_packet

    repriced = _load_packet(root, "shot-1", 2)
    assert repriced.estimate_jpy == 20  # 10 minor USD at 200 JPY/USD

    # an unapproved NEWER shot plan blocks both compilation and payment
    plan_raw = json.loads(
        (root / "planning" / "shot_plan_v1.json").read_text(encoding="utf-8")
    )
    plan_raw["version"] = 2
    plan_raw["shots"][0]["duration_seconds"] = SECONDS_EACH  # content tweak
    plan_raw["shots"][0]["resolution"] = "512p"
    from ai_video_workflow.planning import publish_shot_plan

    plan_raw["shots"] = plan_raw["shots"][:SHOTS]
    publish_shot_plan(root, plan_raw)
    assert _run(root, catalog_dir, "plan-compile") == 1
    assert _packet_submit(root, catalog_dir, "task-shot-1-1", "shot-1", "op-x") == 1
    assert fake.total_calls == calls  # nothing above ever reached a provider


# =============================================================================
# 3. two projects: reuse boundary + cross-project monthly budget
# =============================================================================


def test_two_projects_reuse_and_monthly_budget(tmp_path: Path, monkeypatch) -> None:
    root, catalog_dir, fake = _setup(tmp_path, monkeypatch)

    # second project reuses the SAME immutable asset version
    second = _seed_episode(tmp_path, name="wfm1-demo-2")
    raw = _catalog_raw()
    _write_config(second, compute_catalog_digest(raw))
    assert (
        _run(
            second,
            catalog_dir,
            "reuse-add-ref",
            "--asset-id",
            "character-mia",
            "--version",
            "1",
        )
        == 0
    )
    refs_a = json.loads(
        (root / "profile" / "reuse_refs.json").read_text(encoding="utf-8")
    )
    refs_b = json.loads(
        (second / "profile" / "reuse_refs.json").read_text(encoding="utf-8")
    )
    assert refs_a["refs"] == refs_b["refs"]  # version+digest locked, shared

    # a large outstanding hold in project A joins project B's monthly check
    hold_reservation(
        root,
        project_id="proj-demo",
        task_id="task-big",
        operation_id="op-big",
        shot_id="shot-1",
        provider_id="fake-a",
        model_id="m1",
        estimate_jpy=4990,
        created_at=T0.isoformat(),
    )
    # approve concept in project B so only the budget can block
    (second / "records").mkdir(exist_ok=True)
    shot_rel = "records/shots/shot-1.json"
    _approve_concept_direct(second, shot_rel)
    calls = fake.total_calls
    assert (
        _run(
            second,
            catalog_dir,
            "paid-submit",
            "task-shot-1-1",
            "--unplanned",  # the isolated ad-hoc path hits the same gate
            "--shot",
            "shot-1",
            "--operation-id",
            "op-1",
            "--capability",
            "text_to_video",
            "--model",
            "m1",
            "--resolution",
            "512p",
            "--duration",
            str(SECONDS_EACH),
        )
        == 1
    )
    assert fake.total_calls == calls  # monthly account-level gate: zero calls


def _approve_concept_direct(root: Path, target_rel: str) -> None:
    from ai_video_workflow.approval import transition_stage

    transition_stage(root, "concept_lock", "review", at=T0.isoformat(), by="owner")
    transition_stage(
        root,
        "concept_lock",
        "approve",
        at=T0.isoformat(),
        by="owner",
        targets=(target_rel,),
    )


# =============================================================================
# 4. projection readiness: read-only, deterministic, from authoritative files
# =============================================================================


def _readiness_projection(root: Path) -> str:
    """Rebuild plan/progress/lineage/cost purely from authoritative data."""
    stages = [
        {
            "stage": s.stage_id,
            "status": s.status,
            "stale": s.stale,
            "blocked_by": list(s.blocked_by),
        }
        for s in stage_status(root)
    ]
    events = read_events(root)
    summary = aggregate_events(events, data=cli._load_project_data(root))
    lineages = {t.task_id: build_lineage(root, t.task_id) for t in summary.per_task}
    projection = {
        "stages": stages,
        "costs": dict(summary.per_project.cost_by_currency),
        "tasks": {
            t.task_id: {"shot": t.shot_id, "status": t.latest_status}
            for t in summary.per_task
        },
        "lineage_operations": {
            task_id: [op["operation_id"] for op in lineage["operations"]]
            for task_id, lineage in lineages.items()
        },
        "problems": [
            {"kind": g.kind, "entity": g.entity_id} for g in summary.reconciliation
        ],
        "unavailable": ["images", "audio", "subtitles", "actions"],  # honest
    }
    return json.dumps(projection, sort_keys=True, ensure_ascii=False)


def test_projection_readiness(tmp_path: Path, monkeypatch) -> None:
    root, catalog_dir, fake = _setup(tmp_path, monkeypatch)
    _paid_all_shots(root, catalog_dir)
    assert _run(root, catalog_dir, "compose") == 0

    before = sorted(str(p) for p in root.rglob("*") if p.is_file())
    first = _readiness_projection(root)
    second = _readiness_projection(root)
    after = sorted(str(p) for p in root.rglob("*") if p.is_file())
    assert first == second  # byte-for-byte deterministic rebuild
    assert before == after  # strictly read-only: no cache, no writes
    parsed = json.loads(first)
    assert parsed["costs"].get("USD") == SHOTS * 10
    assert len(parsed["tasks"]) == SHOTS
    assert parsed["unavailable"] == ["images", "audio", "subtitles", "actions"]

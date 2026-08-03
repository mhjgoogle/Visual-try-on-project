"""Minimal command-line interface for the M1 workflow (TASK-007).

One console script, ``ai-video-workflow``, wires the bootstrap, driver,
validation, and composition surfaces into per-step subcommands and a
single-command ``run`` closing the loop:

    init-tasks -> prepare -> submit -> report-artifact -> collect
    -> validate -> compose

``run`` executes exactly that order. ``--project-root`` is required.
Typed workflow errors map to a non-zero exit with a human-readable
class + message; unknown exceptions propagate. The CLI reads the clock
and constructs the real FfprobeMediaInspector / FfmpegVideoComposer by
default; it performs no provider-style artifact discovery — staged
media is referenced only at its explicit contract path.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ai_video_workflow.app.bootstrap import (
    bootstrap_generation_tasks,
    create_redo_task,
    task_record_path,
)
from ai_video_workflow.app.clock import utc_now
from ai_video_workflow.app.contracts import staging_ref_for
from ai_video_workflow.app.driver import WorkflowDriver
from ai_video_workflow.app.media_fetch import UrllibMediaFetcher
from ai_video_workflow.app.paid_coordinator import (
    PaidGenerationCoordinator,
    PaidRequest,
)
from ai_video_workflow.app.paid_lifecycle import (
    build_lineage,
    drive_manual_lifecycle,
    integrate_paid_media,
)
from ai_video_workflow.app.requests import DefaultProviderRequestFactory
from ai_video_workflow.approval import (
    require_stage_ready,
    stage_plan,
    stage_status,
    transition_stage,
)
from ai_video_workflow.assets.registration import ValidationFailedError
from ai_video_workflow.composition.ffmpeg import FfmpegVideoComposer
from ai_video_workflow.config.catalog import ProviderEntry
from ai_video_workflow.config.catalog_lock import load_locked_catalog
from ai_video_workflow.config.project_config import load_project_config
from ai_video_workflow.errors import AiVideoWorkflowError, FieldTypeError
from ai_video_workflow.inspection.ffprobe import FfprobeMediaInspector
from ai_video_workflow.manifest import StepManifest
from ai_video_workflow.models import (
    Character,
    GenerationTask,
    GenerationTaskStatus,
    Project,
    Scene,
    Shot,
    VideoAsset,
)
from ai_video_workflow.orchestration import OrchestrationAction
from ai_video_workflow.persistence import read_model_json
from ai_video_workflow.planning import (
    compile_task_packets,
    load_packet,
    packet_to_paid_request,
    verify_packet,
)
from ai_video_workflow.profile import (
    add_reuse_ref,
    parse_pack,
    parse_project_profile,
    profile_digest,
    publish_pack_version,
    resolve_reuse_refs,
    write_project_profile,
)
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.providers.registry import default_registry
from ai_video_workflow.qcd.reporting import run_qcd_report_step
from ai_video_workflow.release import (
    archive_project,
    package_release,
    record_final_review,
    run_technical_qc,
)
from ai_video_workflow.security import resolve_within_root

_RUN_LIFECYCLE = (
    OrchestrationAction.PREPARE,
    OrchestrationAction.SUBMIT,
    OrchestrationAction.REPORT_ARTIFACT,
    OrchestrationAction.COLLECT,
)


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "handler", None) is None:
        parser.print_help(sys.stderr)
        return 2
    try:
        args.handler(args)
    except AiVideoWorkflowError as exc:
        print(f"ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ai-video-workflow")
    parser.add_argument("--project-root", required=True, type=Path)
    parser.add_argument("--provider-id", default="manual")
    parser.add_argument(
        "--catalog-dir",
        type=Path,
        default=Path("config/providers"),
        help="directory holding the versioned provider catalog(s)",
    )
    sub = parser.add_subparsers(dest="command")

    def _add(name: str, handler, *, staged=False, task=False, shot=False, extra=None):
        sp = sub.add_parser(name)
        if task:
            sp.add_argument("task_id")
        if shot:
            sp.add_argument("shot_id")
        if staged:
            sp.add_argument("--staged-path", default=None)
        if extra is not None:
            extra(sp)
        sp.set_defaults(handler=handler)
        return sp

    _add("init-tasks", _cmd_init_tasks)
    _add("prepare", _cmd_prepare, task=True)
    _add("submit", _cmd_submit, task=True)
    _add("report-artifact", _cmd_report_artifact, task=True, staged=True)
    _add("collect", _cmd_collect, task=True)
    _add("validate", _cmd_validate, task=True)
    _add("compose", _cmd_compose)
    _add("status", _cmd_status, task=True)
    _add("show-instruction", _cmd_show_instruction, task=True)
    _add("create-redo-task", _cmd_create_redo, shot=True)
    # `run` drives every shot through its own contract staging path; a
    # single --staged-path cannot address multiple shots, so it is not
    # offered here (use per-step report-artifact for a custom path).
    _add("run", _cmd_run)

    def _attempt_args(sp):
        sp.add_argument("--note", default=None)

    def _rate_args(sp):
        sp.add_argument("--score", type=int, required=True)
        sp.add_argument("--note", default=None)

    def _paid_args(sp):
        sp.add_argument("--shot", required=True)
        sp.add_argument("--operation-id", required=True)
        # WFM1 path: the request is rebuilt from a verified task packet and
        # the full production_lock chain is enforced.
        sp.add_argument("--packet-version", type=int, default=None)
        sp.add_argument(
            "--account-root",
            type=Path,
            default=None,
            help=(
                "affects reuse-pack resolution during packet verification "
                "ONLY; the budget account root is always the project "
                "root's parent directory"
            ),
        )
        # isolated ad-hoc path (TASK-017 mechanics; NOT the WFM1 flow):
        # free-form generation parameters, explicitly opted into.
        sp.add_argument("--unplanned", action="store_true")
        sp.add_argument("--stage", default=None)
        sp.add_argument("--capability", default=None)
        sp.add_argument("--model", default=None)
        sp.add_argument("--resolution", default=None)
        sp.add_argument("--duration", type=int, default=None)
        sp.add_argument("--first-frame-image", default=None)

    def _resume_args(sp):
        # resume rebuilds everything from the persisted reservation record
        sp.add_argument("--shot", required=True)
        sp.add_argument("--operation-id", required=True)

    def _from_file_args(sp):
        sp.add_argument("--from-file", required=True, type=Path)
        sp.add_argument("--account-root", type=Path, default=None)

    def _ref_args(sp):
        sp.add_argument("--asset-id", required=True)
        sp.add_argument("--version", type=int, required=True)
        sp.add_argument("--account-root", type=Path, default=None)

    def _verify_args(sp):
        sp.add_argument("--account-root", type=Path, default=None)

    _add("record-attempt", _cmd_record_attempt, task=True, extra=_attempt_args)
    _add("rate", _cmd_rate, shot=True, extra=_rate_args)
    _add("qcd-report", _cmd_qcd_report)
    _add("paid-submit", _cmd_paid_submit, task=True, extra=_paid_args)
    _add("poll-media", _cmd_poll_media, task=True, extra=_resume_args)
    # TASK-018: project profile + reusable asset references (ADR-0011)
    _add("profile-init", _cmd_profile_init, extra=_from_file_args)
    _add("reuse-publish", _cmd_reuse_publish, extra=_from_file_args)
    _add("reuse-add-ref", _cmd_reuse_add_ref, extra=_ref_args)
    _add("reuse-verify", _cmd_reuse_verify, extra=_verify_args)

    # TASK-019: stage approval + change control (ADR-0012)
    def _stage_args(sp):
        sp.add_argument("stage")
        sp.add_argument("--by", required=True)
        sp.add_argument("--reason", default=None)

    def _stage_approve_args(sp):
        _stage_args(sp)
        sp.add_argument("--target", action="append", required=True)

    _add("stage-plan", _cmd_stage_plan)
    _add("stage-status", _cmd_stage_status)

    # TASK-020: production planning + task packets (ADR-0012)
    _add("plan-compile", _cmd_plan_compile, extra=_verify_args)

    # TASK-021: settled paid media -> M1 lifecycle + lineage (ADR-0020)
    _add("paid-integrate", _cmd_paid_integrate, task=True)
    _add("lineage", _cmd_lineage, task=True)

    # TASK-022: QC, release package, archive (ADR-0012)
    def _review_args(sp):
        sp.add_argument("--verdict", required=True, choices=("pass", "fail"))
        sp.add_argument("--by", required=True)
        sp.add_argument("--reason", required=True)
        sp.add_argument("--issue-tag", action="append", default=[])
        sp.add_argument("--compared", action="append", default=[])
        sp.add_argument("--ai-assisted", action="store_true")

    _add("qc-run", _cmd_qc_run)
    _add("qc-review", _cmd_qc_review, extra=_review_args)
    _add("package-release", _cmd_package_release)
    _add("archive-project", _cmd_archive_project)
    _add("stage-review", _cmd_stage_review, extra=_stage_args)
    _add("stage-approve", _cmd_stage_approve, extra=_stage_approve_args)
    _add("stage-reject", _cmd_stage_reject, extra=_stage_args)
    _add("stage-revise", _cmd_stage_revise, extra=_stage_args)

    # TASK-028: evaluation / experiment / creative-decision write CLI (ADR-0034).
    # The approved pre-Gateway write path: each record binds its target
    # (ref+version+digest) and the CURRENT goals baseline and is refused when an
    # AI actor would form a pass=true or a 'select' auto-winner. Writes are
    # append-only (never overwrite); Workspace stays read-only.
    def _eval_target(sp):
        sp.add_argument("--actor", required=True, choices=("user", "ai"))
        sp.add_argument("--target-ref", required=True)
        sp.add_argument("--target-version", type=int, required=True)
        sp.add_argument("--target-digest", required=True)

    def _eval_args(sp):
        _eval_target(sp)
        sp.add_argument("--id", required=True)
        sp.add_argument("--criterion", required=True)
        sp.add_argument("--score", type=int, default=None)
        sp.add_argument("--tag", default=None)
        sp.add_argument("--pass", dest="passed", action="store_true")
        sp.add_argument("--rationale", required=True)

    def _experiment_args(sp):
        _eval_target(sp)
        sp.add_argument("--id", required=True)
        sp.add_argument(
            "--variant",
            nargs=3,
            action="append",
            required=True,
            metavar=("REF", "VERSION", "DIGEST"),
        )
        sp.add_argument("--changed-factor", required=True)
        sp.add_argument("--expected-improvement", required=True)
        sp.add_argument("--actual-result", default=None)
        sp.add_argument("--reuse-conclusion", default=None)

    def _decision_args(sp):
        _eval_target(sp)
        sp.add_argument("--id", required=True)
        sp.add_argument(
            "--decision-type",
            required=True,
            choices=(
                "select",
                "abandon",
                "change_prompt",
                "switch_model",
                "redo",
                "accept_imperfect",
            ),
        )
        sp.add_argument("--changed", required=True)
        sp.add_argument("--why", required=True)
        sp.add_argument("--expected", required=True)
        sp.add_argument("--actual", default=None)

    _add("eval-record", _cmd_eval_record, extra=_eval_args)
    _add("experiment-record", _cmd_experiment_record, extra=_experiment_args)
    _add("decision-record", _cmd_decision_record, extra=_decision_args)

    # TASK-025: read-only cross-project workspace queries (WQ-01..WQ-14).
    # These never write, never call a Provider; --account-root defaults to
    # the project root's parent (the same account semantics as the budget
    # layer). Output is the versioned read-only DTO as JSON.
    def _ws_account(sp):
        sp.add_argument("--account-root", type=Path, default=None)

    def _ws_ref(sp):
        _ws_account(sp)
        sp.add_argument("--ref", required=True)

    def _ws_shot(sp):
        _ws_account(sp)
        sp.add_argument("--shot", required=True)

    def _ws_prompt(sp):
        _ws_account(sp)
        sp.add_argument("--prompt-id", required=True)

    def _ws_reuse(sp):
        _ws_account(sp)
        sp.add_argument("--asset-id", required=True)
        sp.add_argument("--version", type=int, required=True)

    def _ws_query(sp):
        _ws_account(sp)
        sp.add_argument("--query", required=True)

    _add("ws-plan", _cmd_ws_plan, extra=_ws_account)
    _add("ws-status", _cmd_ws_status, extra=_ws_account)
    _add("ws-lineage-up", _cmd_ws_lineage_up, extra=_ws_ref)
    _add("ws-lineage-down", _cmd_ws_lineage_down, extra=_ws_ref)
    _add("ws-prompt", _cmd_ws_prompt, extra=_ws_prompt)
    _add("ws-shot", _cmd_ws_shot, extra=_ws_shot)
    _add("ws-cost", _cmd_ws_cost, extra=_ws_account)
    _add("ws-eval", _cmd_ws_eval, extra=_ws_account)
    _add("ws-eval-domain", _cmd_ws_eval_domain, extra=_ws_account)
    _add("ws-problems", _cmd_ws_problems, extra=_ws_account)
    _add("ws-rebuild-check", _cmd_ws_rebuild, extra=_ws_query)
    _add("ws-index", _cmd_ws_index, extra=_ws_account)
    _add("ws-reuse", _cmd_ws_reuse, extra=_ws_reuse)
    _add("ws-approval-audit", _cmd_ws_approval_audit, extra=_ws_account)
    _add("ws-budget", _cmd_ws_budget, extra=_ws_account)
    return parser


_PAID_SUCCESS_KINDS = frozenset(
    {"success", "already_committed", "success_media_pending"}
)


# --- shared construction ---------------------------------------------------

# A synthetic entry for the manual provider, which needs no catalog/prices.
_MANUAL_ENTRY = ProviderEntry(
    provider_id="manual",
    display_name="Manual",
    capabilities=("image_to_video",),
    credential_env_vars=(),
    models={},
)


def _build_provider(args):
    """Build the provider for the M1 driver path — manual only.

    The M1 ``prepare/submit/report-artifact/collect/run`` path drives the
    orchestrator directly and does NOT run the paid coordination chain
    (approval/budget/reservation/cost), so it must only ever build the
    manual provider. A non-manual id is rejected and routed to
    ``paid-submit``; the CLI never silently substitutes the manual
    provider for a paid one.
    """
    if args.provider_id != "manual":
        raise AiVideoWorkflowError(
            f"provider {args.provider_id!r} is a paid/cloud provider; the M1 "
            "prepare/submit/run path is manual-only — use 'paid-submit'"
        )
    return default_registry().build("manual", _MANUAL_ENTRY)


def _driver(args) -> WorkflowDriver:
    return WorkflowDriver(
        provider_id=args.provider_id,
        provider=_build_provider(args),
        request_factory=DefaultProviderRequestFactory(),
        project_root=args.project_root,
        inspector=FfprobeMediaInspector(),
        composer=FfmpegVideoComposer(),
        clock=utc_now,
    )


def _load_project_data(project_root: Path) -> ProjectData:
    """Load the ProjectData by listing the declared record directories.

    A CLI-layer explicit load over the user-selected project root (not a
    provider-style artifact discovery): it reads only the approved record
    directories and constructs the validated snapshot.
    """
    project = read_model_json(
        resolve_within_root(project_root, "project.json"), Project
    )
    return ProjectData(
        project=project,
        characters=_load_dir(project_root, "records/characters", Character),
        scenes=_load_dir(project_root, "records/scenes", Scene),
        shots=_load_dir(project_root, "records/shots", Shot),
        generation_tasks=_load_dir(
            project_root, "records/generation-tasks", GenerationTask
        ),
        video_assets=_load_dir(project_root, "records/video-assets", VideoAsset),
        manifests=_load_dir(project_root, "manifests", StepManifest),
    )


def _load_dir(project_root: Path, relative: str, model_type) -> tuple:
    # the directory itself is admitted through the ADR-0004 resolver so a
    # symlinked record directory cannot redirect reads outside the root.
    directory = resolve_within_root(project_root, relative)
    if not directory.is_dir():
        return ()
    return tuple(
        read_model_json(
            resolve_within_root(project_root, f"{relative}/{path.name}"), model_type
        )
        for path in sorted(directory.glob("*.json"))
    )


# --- subcommand handlers ---------------------------------------------------


def _cmd_init_tasks(args) -> None:
    data = _load_project_data(args.project_root)
    outcome = bootstrap_generation_tasks(
        project_root=args.project_root,
        data=data,
        provider_id=args.provider_id,
        now=utc_now(),
    )
    print(f"created: {list(outcome.created)}")
    print(f"skipped: {list(outcome.skipped)}")


def _cmd_prepare(args) -> None:
    outcome = _driver(args).prepare(args.task_id)
    _render_driver(outcome)


def _cmd_submit(args) -> None:
    _render_driver(_driver(args).submit(args.task_id))


def _cmd_report_artifact(args) -> None:
    staged = args.staged_path or staging_ref_for(args.task_id)
    _render_driver(_driver(args).report_artifact(args.task_id, staged))


def _cmd_collect(args) -> None:
    _render_driver(_driver(args).collect(args.task_id))


def _cmd_validate(args) -> None:
    outcome = _driver(args).validate(args.task_id)
    print(f"validation passed: {outcome.report.passed}")
    if outcome.registered_asset is not None:
        print(f"registered asset: {outcome.registered_asset.asset_id}")
    if not outcome.report.passed:
        raise ValidationFailedError(f"validation did not pass for {args.task_id}")


def _cmd_compose(args) -> None:
    data = _load_project_data(args.project_root)
    outcome = _driver(args).compose(data)
    print(f"composed: {outcome.output_path} (version {outcome.version})")
    print(f"skipped: {outcome.skipped}")


def _paid_coordinator(args):
    config = load_project_config(args.project_root)
    catalog = load_locked_catalog(config, args.catalog_dir)
    data = _load_project_data(args.project_root)
    shot = next((s for s in data.shots if s.shot_id == args.shot), None)
    if shot is None:
        raise AiVideoWorkflowError(f"no shot record for {args.shot!r}")
    coordinator = PaidGenerationCoordinator(
        project_root=args.project_root,
        config=config,
        catalog=catalog,
        registry=default_registry(),
        project=data.project,
        fetcher=UrllibMediaFetcher(),
        clock=utc_now,
    )
    return coordinator, shot


def _paid_setup(args):
    coordinator, shot = _paid_coordinator(args)
    freeform = {
        "--capability": args.capability,
        "--model": args.model,
        "--resolution": args.resolution,
        "--duration": args.duration,
        "--first-frame-image": args.first_frame_image,
        "--stage": args.stage,
    }
    if args.packet_version is not None:
        # WFM1 paid entry: only a verified packet may reach the coordinator.
        if args.unplanned:
            raise AiVideoWorkflowError(
                "--packet-version and --unplanned are mutually exclusive"
            )
        given = [flag for flag, value in freeform.items() if value is not None]
        if given:
            raise AiVideoWorkflowError(
                "packet-driven submit takes no free-form generation "
                f"parameters; remove {', '.join(given)} — the packet is "
                "the single source of the request"
            )
        # the FULL production chain must be approved and fresh (any stale
        # or missing transitive prerequisite blocks BEFORE any coordinator
        # state exists: zero reservations, zero provider calls)
        require_stage_ready(args.project_root, "production_lock")
        config = load_project_config(args.project_root)
        catalog = load_locked_catalog(config, args.catalog_dir)
        packet = load_packet(args.project_root, args.shot, args.packet_version)
        # nothing in the stored packet file is trusted: recompute and
        # compare everything against the approved authoritative inputs
        verify_packet(args.project_root, _account_root(args), catalog, config, packet)
        request = packet_to_paid_request(
            packet,
            task_id=args.task_id,
            operation_id=args.operation_id,
            stage="production_lock",
        )
        return coordinator, shot, request
    if not args.unplanned:
        raise AiVideoWorkflowError(
            "paid-submit requires --packet-version <N> (the WFM1 flow), or "
            "the explicit --unplanned flag for the isolated ad-hoc path"
        )
    missing = [
        flag
        for flag in ("--model", "--resolution", "--duration")
        if freeform[flag] is None
    ]
    if missing:
        raise AiVideoWorkflowError(f"--unplanned submit requires {', '.join(missing)}")
    request = PaidRequest(
        task_id=args.task_id,
        shot_id=args.shot,
        operation_id=args.operation_id,
        stage=args.stage or "concept_lock",
        capability=args.capability or "image_to_video",
        model_id=args.model,
        resolution=args.resolution,
        duration_seconds=args.duration,
        first_frame_image=args.first_frame_image,
    )
    return coordinator, shot, request


def _render_paid(outcome) -> None:
    print(f"paid outcome: {outcome.kind}")
    print(f"provider: {outcome.provider_id}")
    print(f"operation: {outcome.operation_id}")
    if outcome.cost_minor_units is not None:
        print(f"cost: {outcome.cost_minor_units} {outcome.currency}")
    if outcome.fell_back:
        print("fell_back: true")
    if outcome.kind not in _PAID_SUCCESS_KINDS:
        raise AiVideoWorkflowError(f"{outcome.kind}: {outcome.reason}")


def _cmd_paid_submit(args) -> None:
    coordinator, shot, request = _paid_setup(args)
    _render_paid(coordinator.submit_paid(shot, request))


def _cmd_poll_media(args) -> None:
    # resume an interrupted paid operation via its persisted external task
    # id: re-poll/collect only, never re-submit or re-pay. Everything is
    # rebuilt from the reservation record; only ids + shot are supplied.
    coordinator, shot = _paid_coordinator(args)
    _render_paid(coordinator.resume_media(shot, args.task_id, args.operation_id))


def _account_root(args) -> Path:
    # the normative account-root rule (TASK-014 contract 4 / ADR-0001 WFM1
    # amendment): the parent directory of the project root, unless given.
    return args.account_root or args.project_root.parent


def _read_json_file(path: Path) -> object:
    import json as _json

    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise AiVideoWorkflowError(f"unable to read {path}: {exc}") from exc
    try:
        return _json.loads(text)
    except ValueError as exc:
        raise AiVideoWorkflowError(f"{path} is not valid JSON") from exc


def _cmd_profile_init(args) -> None:
    profile = parse_project_profile(_read_json_file(args.from_file))
    path = write_project_profile(args.project_root, profile)
    print(f"profile written: {path}")
    print(f"version: {profile.version}")
    print(f"digest: {profile_digest(profile)}")


def _cmd_reuse_publish(args) -> None:
    pack = parse_pack(_read_json_file(args.from_file))
    path = publish_pack_version(_account_root(args), pack)
    print(f"published: {path}")
    print(f"asset: {pack.asset_id} v{pack.version} ({pack.kind})")
    print(f"digest: {pack.content_digest}")


def _cmd_reuse_add_ref(args) -> None:
    ref = add_reuse_ref(
        args.project_root, _account_root(args), args.asset_id, args.version
    )
    print(f"referenced: {ref.asset_id} v{ref.version}")
    print(f"digest: {ref.content_digest}")


def _cmd_reuse_verify(args) -> None:
    resolved = resolve_reuse_refs(args.project_root, _account_root(args))
    for pack in resolved:
        print(f"ok: {pack.asset_id} v{pack.version} ({pack.kind})")
    print(f"verified refs: {len(resolved)}")


def _cmd_qc_run(args) -> None:
    outcome = run_technical_qc(
        args.project_root,
        _load_project_data(args.project_root),
        FfprobeMediaInspector(),
    )
    for check in outcome["checks"]:
        state = "ok" if check["passed"] else "FAIL"
        print(f"{state}: {check['check_id']} ({check['detail']})")
    print(f"technical qc v{outcome['version']}: passed={outcome['passed']}")
    if not outcome["passed"]:
        raise AiVideoWorkflowError("technical QC did not pass")


def _cmd_qc_review(args) -> None:
    outcome = record_final_review(
        args.project_root,
        verdict=args.verdict,
        by=args.by,
        at=utc_now().isoformat(),
        decision_reason=args.reason,
        issue_tags=tuple(args.issue_tag),
        compared_versions=tuple(args.compared),
        ai_assisted=args.ai_assisted,
    )
    print(f"final review v{outcome['version']}: {outcome['verdict']}")
    print(f"bound to: {outcome['target']['ref']}")


def _cmd_package_release(args) -> None:
    outcome = package_release(args.project_root)
    print(f"release v{outcome['version']} (created={outcome['created']})")
    print(f"final: {outcome['final_mp4']['ref']}")


def _cmd_archive_project(args) -> None:
    outcome = archive_project(args.project_root, _load_project_data(args.project_root))
    print(
        f"archive manifest v{outcome['archive_manifest_version']}; "
        f"postmortem v{outcome['postmortem_version']}; "
        f"references: {outcome['references']}"
    )


# --- TASK-028: evaluation-domain write handlers (ADR-0034) -----------------


def _evaluation_service(args):
    from ai_video_workflow.evaluation import (
        EvaluationService,
        WorkflowAuthoritativeFacts,
    )

    data = _load_project_data(args.project_root)
    return EvaluationService(
        args.project_root,
        data.project.project_id,
        facts=WorkflowAuthoritativeFacts(),
        clock=utc_now,
    )


def _eval_actor(value: str):
    from ai_video_workflow.evaluation import EvaluationActor

    return EvaluationActor(value)


def _eval_target_arg(args) -> dict:
    return {
        "ref": args.target_ref,
        "version": args.target_version,
        "content_digest": args.target_digest,
    }


def _cmd_eval_record(args) -> None:
    record = _evaluation_service(args).record_evaluation(
        actor=_eval_actor(args.actor),
        target=_eval_target_arg(args),
        evaluation_id=args.id,
        criterion=args.criterion,
        score=args.score,
        tag=args.tag,
        passed=args.passed,
        rationale=args.rationale,
    )
    print(
        f"evaluation {record.record_id}: pass={record.payload['pass']} "
        f"actor={record.actor.value} goals_v{record.goals_version}"
    )


def _parse_variant(ref: str, version: str, digest: str) -> dict:
    try:
        parsed = int(version)
    except ValueError:
        raise FieldTypeError(
            f"--variant VERSION must be an integer, got {version!r}"
        ) from None
    return {"ref": ref, "version": parsed, "content_digest": digest}


def _cmd_experiment_record(args) -> None:
    variants = [
        _parse_variant(ref, version, digest) for ref, version, digest in args.variant
    ]
    record = _evaluation_service(args).record_experiment(
        actor=_eval_actor(args.actor),
        target=_eval_target_arg(args),
        experiment_id=args.id,
        variants=variants,
        changed_factor=args.changed_factor,
        expected_improvement=args.expected_improvement,
        actual_result=args.actual_result,
        reuse_conclusion=args.reuse_conclusion,
    )
    print(
        f"experiment {record.record_id}: {len(variants)} variants "
        f"actor={record.actor.value} goals_v{record.goals_version}"
    )


def _cmd_decision_record(args) -> None:
    record = _evaluation_service(args).record_creative_decision(
        actor=_eval_actor(args.actor),
        target=_eval_target_arg(args),
        decision_id=args.id,
        decision_type=args.decision_type,
        changed=args.changed,
        why=args.why,
        expected=args.expected,
        actual=args.actual,
    )
    print(
        f"decision {record.record_id}: {record.payload['decision_type']} "
        f"actor={record.actor.value} goals_v{record.goals_version}"
    )


# --- TASK-025: read-only workspace query handlers --------------------------


def _ws_service(args):
    from ai_video_workflow.workspace import WorkspaceQueryService

    account_root = args.account_root or args.project_root.parent
    return WorkspaceQueryService(account_root, clock=utc_now)


def _ws_emit(result) -> None:
    import json as _json

    from ai_video_workflow.workspace import to_jsonable

    print(
        _json.dumps(to_jsonable(result), ensure_ascii=False, sort_keys=True, indent=2)
    )


def _cmd_ws_plan(args) -> None:
    _ws_emit(_ws_service(args).project_plan(args.project_root))


def _cmd_ws_status(args) -> None:
    _ws_emit(_ws_service(args).project_status(args.project_root))


def _cmd_ws_lineage_up(args) -> None:
    _ws_emit(_ws_service(args).lineage_upstream(args.project_root, args.ref))


def _cmd_ws_lineage_down(args) -> None:
    _ws_emit(_ws_service(args).lineage_downstream(args.project_root, args.ref))


def _cmd_ws_prompt(args) -> None:
    _ws_emit(_ws_service(args).prompt_history(args.project_root, args.prompt_id))


def _cmd_ws_shot(args) -> None:
    _ws_emit(_ws_service(args).shot_attempts(args.project_root, args.shot))


def _cmd_ws_cost(args) -> None:
    _ws_emit(_ws_service(args).cost_breakdown(args.project_root))


def _cmd_ws_eval(args) -> None:
    _ws_emit(_ws_service(args).evaluation_decision(args.project_root))


def _cmd_ws_eval_domain(args) -> None:
    _ws_emit(_ws_service(args).evaluation_domain(args.project_root))


def _cmd_ws_problems(args) -> None:
    _ws_emit(_ws_service(args).recent_problems(args.project_root))


def _cmd_ws_rebuild(args) -> None:
    _ws_emit(_ws_service(args).rebuild_check(args.project_root, args.query))


def _cmd_ws_index(args) -> None:
    _ws_emit(_ws_service(args).cross_project_index())


def _cmd_ws_reuse(args) -> None:
    _ws_emit(_ws_service(args).reuse_usage(args.asset_id, args.version))


def _cmd_ws_approval_audit(args) -> None:
    _ws_emit(_ws_service(args).approval_audit(args.project_root))


def _cmd_ws_budget(args) -> None:
    _ws_emit(_ws_service(args).budget_standing(args.project_root))


def _cmd_paid_integrate(args) -> None:
    # the M1 driver here is manual-only by design: the paid work is already
    # settled; integration just drives the manual lifecycle over the staged,
    # receipt-verified media and registers the formal asset.
    args.provider_id = "manual"
    outcome = integrate_paid_media(_driver(args), args.project_root, args.task_id)
    print(f"integrated: {args.task_id}")
    print(f"validation passed: {outcome.report.passed}")
    if outcome.registered_asset is not None:
        print(f"registered asset: {outcome.registered_asset.asset_id}")


def _cmd_lineage(args) -> None:
    import json as _json

    print(_json.dumps(build_lineage(args.project_root, args.task_id), indent=2))


def _cmd_plan_compile(args) -> None:
    config = load_project_config(args.project_root)
    catalog = load_locked_catalog(config, args.catalog_dir)
    packets = compile_task_packets(
        args.project_root, _account_root(args), catalog, config
    )
    total_p50 = sum(p.p50_jpy for p in packets)
    total_p90 = sum(p.p90_jpy for p in packets)
    for packet in packets:
        print(
            f"{packet.shot_id} v{packet.packet_version}: "
            f"{packet.provider_primary}/{packet.model_id} "
            f"{packet.resolution}/{packet.duration_seconds}s "
            f"p50={packet.p50_jpy} p90={packet.p90_jpy} JPY"
        )
    print(f"packets: {len(packets)}; episode p50={total_p50} p90={total_p90} JPY")


def _cmd_stage_plan(args) -> None:
    del args
    for info in stage_plan():
        pres = ",".join(info.prerequisites) or "-"
        print(f"{info.stage_id}: {info.label} (after: {pres})")


def _cmd_stage_status(args) -> None:
    for state in stage_status(args.project_root):
        flags = []
        if state.stale:
            flags.append("STALE")
        if state.blocked_by:
            flags.append(f"blocked_by={','.join(state.blocked_by)}")
        suffix = f" [{' '.join(flags)}]" if flags else ""
        print(f"{state.stage_id}: {state.status}{suffix}")


def _stage_transition(args, action: str, targets: tuple[str, ...] = ()) -> None:
    marker = transition_stage(
        args.project_root,
        args.stage,
        action,
        at=utc_now().isoformat(),
        by=args.by,
        reason=args.reason,
        targets=targets,
    )
    print(f"{args.stage}: {marker.status}")


def _cmd_stage_review(args) -> None:
    _stage_transition(args, "review")


def _cmd_stage_approve(args) -> None:
    _stage_transition(args, "approve", tuple(args.target))


def _cmd_stage_reject(args) -> None:
    _stage_transition(args, "reject")


def _cmd_stage_revise(args) -> None:
    _stage_transition(args, "revise")


def _cmd_qcd_report(args) -> None:
    data = _load_project_data(args.project_root)
    outcome = run_qcd_report_step(
        project_root=args.project_root, data=data, observed_at=utc_now()
    )
    print(f"qcd report: {outcome.json_path} (version {outcome.version})")
    print(f"skipped: {outcome.skipped}")
    print(f"reconciliation gaps: {len(outcome.summary.reconciliation)}")


def _cmd_status(args) -> None:
    assessment = _driver(args).status(args.task_id)
    phase = None if assessment.phase is None else assessment.phase.value
    legal = [a.value for a in assessment.legal_actions]
    preferred = (
        None
        if assessment.preferred_next_action is None
        else assessment.preferred_next_action.value
    )
    print(f"phase: {phase}")
    print(f"disposition: {assessment.disposition.value}")
    print(f"legal_actions: {legal}")
    print(f"preferred_next_action: {preferred}")
    print(
        f"requires_manual_reconciliation: {assessment.requires_manual_reconciliation}"
    )


def _cmd_show_instruction(args) -> None:
    path = resolve_within_root(
        args.project_root, Path("tasks") / "instructions" / f"{args.task_id}.md"
    )
    if not path.is_file():
        raise AiVideoWorkflowError(f"no instruction document for {args.task_id}")
    print(path.read_text(encoding="utf-8"))


def _cmd_create_redo(args) -> None:
    data = _load_project_data(args.project_root)
    outcome = create_redo_task(
        project_root=args.project_root,
        data=data,
        shot_id=args.shot_id,
        provider_id=args.provider_id,
        now=utc_now(),
    )
    print(f"created: {list(outcome.created)}")


def _cmd_record_attempt(args) -> None:
    event_id = _driver(args).record_attempt(args.task_id, note=args.note)
    print(f"recorded attempt: {event_id}")


def _cmd_rate(args) -> None:
    event_id = _driver(args).record_rating(
        shot_id=args.shot_id, task_id=None, score=args.score, note=args.note
    )
    print(f"recorded rating: {event_id}")


def _cmd_run(args) -> None:
    driver = _driver(args)
    data = _load_project_data(args.project_root)
    boot = bootstrap_generation_tasks(
        project_root=args.project_root,
        data=data,
        provider_id=args.provider_id,
        now=utc_now(),
    )
    task_ids = sorted(set(boot.created) | set(boot.skipped))
    for task_id in task_ids:
        _drive_generation(driver, task_id)
        _require_done(args.project_root, task_id)
        outcome = driver.validate(task_id)
        if not outcome.report.passed:
            raise ValidationFailedError(f"validation did not pass for {task_id}")
    # reload so the just-registered assets are visible to composition
    composed = driver.compose(_load_project_data(args.project_root))
    print(f"run complete: {composed.output_path} (version {composed.version})")


def _drive_generation(driver: WorkflowDriver, task_id: str) -> None:
    """Drive one task's lifecycle (shared with the paid adapter, TASK-021)."""
    drive_manual_lifecycle(driver, task_id)


def _require_done(project_root: Path, task_id: str) -> None:
    """Reject a non-DONE terminal task before validate/compose.

    A FAILED or CANCELLED task must not be silently treated as a successful
    input to validation/composition.
    """
    task = read_model_json(task_record_path(project_root, task_id), GenerationTask)
    if task.status is not GenerationTaskStatus.DONE:
        raise AiVideoWorkflowError(
            f"task {task_id} is {task.status.value}, not done; cannot continue run"
        )


def _render_driver(outcome) -> None:
    print(f"task: {outcome.task_id}")
    print(f"action: {outcome.action.value}")
    print(f"outcome: {outcome.outcome.kind.value}")
    if outcome.instruction_path is not None:
        print(f"instruction: {outcome.instruction_path}")
    if outcome.staged_path is not None:
        print(f"staged: {outcome.staged_path}")
    if outcome.emitted_event_ids:
        print(f"events: {list(outcome.emitted_event_ids)}")


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

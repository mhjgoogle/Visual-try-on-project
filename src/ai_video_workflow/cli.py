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
from ai_video_workflow.app.requests import DefaultProviderRequestFactory
from ai_video_workflow.assets.registration import ValidationFailedError
from ai_video_workflow.composition.ffmpeg import FfmpegVideoComposer
from ai_video_workflow.config.catalog import ProviderEntry
from ai_video_workflow.config.catalog_lock import load_locked_catalog
from ai_video_workflow.config.project_config import load_project_config
from ai_video_workflow.errors import AiVideoWorkflowError
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
from ai_video_workflow.project_data import ProjectData
from ai_video_workflow.providers.registry import default_registry
from ai_video_workflow.qcd.reporting import run_qcd_report_step
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
        sp.add_argument("--stage", default="concept_lock")
        sp.add_argument("--capability", default="image_to_video")
        sp.add_argument("--model", required=True)
        sp.add_argument("--resolution", required=True)
        sp.add_argument("--duration", type=int, required=True)
        sp.add_argument("--first-frame-image", default=None)

    def _resume_args(sp):
        # resume rebuilds everything from the persisted reservation record
        sp.add_argument("--shot", required=True)
        sp.add_argument("--operation-id", required=True)

    _add("record-attempt", _cmd_record_attempt, task=True, extra=_attempt_args)
    _add("rate", _cmd_rate, shot=True, extra=_rate_args)
    _add("qcd-report", _cmd_qcd_report)
    _add("paid-submit", _cmd_paid_submit, task=True, extra=_paid_args)
    _add("poll-media", _cmd_poll_media, task=True, extra=_resume_args)
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
    request = PaidRequest(
        task_id=args.task_id,
        shot_id=args.shot,
        operation_id=args.operation_id,
        stage=args.stage,
        capability=args.capability,
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
    """Drive one task's generation lifecycle, resuming from any point.

    Each fixed lifecycle action runs only when the orchestrator reports it
    legal now (already-completed actions are simply not legal, so a resumed
    task advances without an illegal re-prepare). A task that is already
    terminal stops the drive; ``run`` always uses the contract staging path.
    """
    staged = staging_ref_for(task_id)
    for action in _RUN_LIFECYCLE:
        assessment = driver.status(task_id)
        if assessment.is_terminal:
            return
        if action not in assessment.legal_actions:
            continue
        if action is OrchestrationAction.PREPARE:
            driver.prepare(task_id)
        elif action is OrchestrationAction.SUBMIT:
            driver.submit(task_id)
        elif action is OrchestrationAction.REPORT_ARTIFACT:
            driver.report_artifact(task_id, staged)  # verifies the staged file
        else:  # COLLECT
            driver.collect(task_id)


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

"""Draft-plan lock Gateway command (ADR-0047 / TASK-047).

Registers the Command Gateway write command ``lock-draft-plan``: it turns a
canvas storyboard DRAFT (ADR-0042 draft domain — per-shot title / description /
duration, plus an optional first-frame asset image per shot) into OFFICIAL,
versioned planning artifacts through the already-approved planning APIs:

- new prompt versions (one prompt per locked shot, text = draft description);
- optionally a new brief / story version (the canvas creative state);
- a NEW shot-plan version whose rows carry the draft durations and the
  per-shot ``first_frame_image`` data URLs (image-to-video coherence);
- new immutable shot records (shot records are single-version in the WFM1
  record contract, so locked shots get FRESH shot ids — nothing is ever
  overwritten);
- a ``production_lock`` re-approval bound to the new plan file (the human
  Gate is the Gateway preview -> confirmation, per ADR-0047 "Agent 起草，
  用户确认"), followed by ``compile_task_packets`` so the new packet
  versions exist and paid generation immediately targets the draft content.

The command spends NO money and touches NO Provider: paid generation still
goes exclusively through ``submit-video-generation`` (ADR-0041/0046) with its
own confirmation chain. It is HIGH-risk (a creative production decision) so
the Gateway enforces preflight -> bound confirmation; the preflight inputs
include a sha256 per first-frame image, so a swapped image invalidates the
confirmation (fail-closed).

Like the paid command, this command is NOT in the default no-spend registry
(``build_wfm1_registry``): it is admitted only through the explicit
``register_lock_draft_command`` builder (ADR-0033 posture: real write
commands are wired deliberately, never by default). Unlike the paid command
it needs no spend authorization — registration is allowed in no-paid
deployments too (locking costs nothing).
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from ai_video_workflow.app.clock import utc_now
from ai_video_workflow.approval import (
    load_approval,
    require_stage_approved,
    transition_stage,
)
from ai_video_workflow.approval.errors import ApprovalError, NotApprovedError
from ai_video_workflow.budget.estimate import estimate_generation_cost
from ai_video_workflow.config.catalog_lock import load_locked_catalog
from ai_video_workflow.config.project_config import load_project_config
from ai_video_workflow.config.selection import resolve_provider_selection
from ai_video_workflow.errors import AiVideoWorkflowError
from ai_video_workflow.gateway.commands import (
    CommandEnvelope,
    CommandRegistry,
    CommandRisk,
    CommandSpec,
    Preview,
)
from ai_video_workflow.models import Scene, Shot
from ai_video_workflow.persistence import write_model_json
from ai_video_workflow.planning import (
    PLANNING_DIR,
    compile_task_packets,
    latest_shot_plan_version,
    load_shot_plan,
    parse_brief,
    parse_prompt,
    parse_shot_plan,
    parse_story,
    publish_brief,
    publish_prompt,
    publish_shot_plan,
    publish_story,
)

# the same package-internal versioned-file scan packets.py builds on
from ai_video_workflow.planning.documents import _highest_version
from ai_video_workflow.project_data import owning_project_id
from ai_video_workflow.security import resolve_within_root

LOCK_DRAFT_PLAN = "lock-draft-plan"

# Draft bounds (ADR-0047): the command-level sanity envelope. The planning
# layer's own shot-plan contract (6-10 shots, 45-75s total) still applies and
# surfaces as preview blockers — this envelope only rejects absurd payloads
# before any document is built.
MAX_DRAFT_SHOTS = 20
MAX_TITLE_CHARS = 80
MAX_DESCRIPTION_CHARS = 500
ALLOWED_DURATIONS = (6, 10)

# First-frame images arrive as inline data URLs from the canvas asset slots
# (never local paths / never fetched by the core). Same shape + cap as the
# planning document rule and the provider's ``_validate_first_frame_image``
# (a <=5.5MB original stays under this cap after base64).
_MAX_FIRST_FRAME_DATA_URL = 8 * 1024 * 1024

_REQUIRED = ("plan_version", "shots")
_SHOT_KEYS = frozenset(
    {"title", "description", "duration_seconds", "first_frame_image"}
)

# Read-only downstream facts shown before the high-risk confirmation.
_DOWNSTREAM = (
    "new planning document versions (prompts / shot plan / optional brief+story)",
    "new immutable shot records (fresh shot ids)",
    "production_lock re-approval bound to the new shot plan",
    "new task packet versions (paid generation then derives from this draft)",
)

_PLAN_REF_RE = re.compile(rf"^{PLANNING_DIR}/shot_plan_v([1-9][0-9]*)\.json$")


@dataclass(frozen=True, slots=True)
class _LockDeps:
    """Injected dependencies: where the locked catalog and the account live."""

    catalog_dir: Path
    account_root: Path | None
    clock: Callable[[], datetime]


def register_lock_draft_command(
    registry: CommandRegistry,
    *,
    catalog_dir: Path,
    account_root: Path | None = None,
    clock: Callable[[], datetime] = utc_now,
) -> None:
    """Register ``lock-draft-plan`` into an approved registry.

    No spend authorization is required (the command never pays and never
    reaches a Provider); packet compilation needs the SAME locked catalog and
    account root the paid flow uses, injected here so preview quotes and the
    compiled packets match what ``submit-video-generation`` will re-verify.
    """
    deps = _LockDeps(
        catalog_dir=Path(catalog_dir),
        account_root=account_root,
        clock=clock,
    )

    def _preview_closure(project_root: Path, envelope: CommandEnvelope) -> Preview:
        return _preview(project_root, envelope, deps)

    def _apply_closure(project_root: Path, envelope: CommandEnvelope) -> dict:
        return _apply(project_root, envelope, deps)

    registry.register(
        CommandSpec(
            LOCK_DRAFT_PLAN,
            CommandRisk.HIGH,
            _preview_closure,
            _apply_closure,
            requires_target=True,
        )
    )


# --- draft param validation ----------------------------------------------------


def _draft_errors(params) -> list[str]:
    """Validate the raw draft params; returns fail-closed reasons (no reads)."""
    errors = [
        f"missing param {key!r}" for key in _REQUIRED if params.get(key) in (None, "")
    ]
    if errors:
        return errors

    plan_version = params["plan_version"]
    if (
        isinstance(plan_version, bool)
        or not isinstance(plan_version, int)
        or plan_version < 1
    ):
        errors.append("plan_version: expected a positive int")

    shots = params["shots"]
    if not isinstance(shots, list) or not shots:
        return errors + ["shots: expected a non-empty array"]
    if len(shots) > MAX_DRAFT_SHOTS:
        errors.append(f"shots: at most {MAX_DRAFT_SHOTS} draft shots, got {len(shots)}")
    for index, entry in enumerate(shots, start=1):
        where = f"shots[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{where}: expected an object")
            continue
        unknown = sorted(frozenset(entry) - _SHOT_KEYS)
        if unknown:
            errors.append(f"{where}: unknown keys {unknown}")
        missing = sorted(_SHOT_KEYS - frozenset(entry))
        if missing:
            errors.append(f"{where}: missing keys {missing}")
            continue
        title = entry["title"]
        if not isinstance(title, str) or not title.strip():
            errors.append(f"{where}.title: expected a non-empty string")
        elif len(title) > MAX_TITLE_CHARS:
            errors.append(f"{where}.title: over {MAX_TITLE_CHARS} chars")
        description = entry["description"]
        if not isinstance(description, str) or not description.strip():
            errors.append(f"{where}.description: expected a non-empty string")
        elif len(description) > MAX_DESCRIPTION_CHARS:
            errors.append(f"{where}.description: over {MAX_DESCRIPTION_CHARS} chars")
        duration = entry["duration_seconds"]
        if isinstance(duration, bool) or duration not in ALLOWED_DURATIONS:
            errors.append(
                f"{where}.duration_seconds: expected one of {list(ALLOWED_DURATIONS)}"
            )
        frame = entry["first_frame_image"]
        if frame is not None:
            if not isinstance(frame, str) or not frame.startswith("data:image/"):
                errors.append(
                    f"{where}.first_frame_image: expected an image data URL "
                    "(data:image/...)"
                )
            elif len(frame) > _MAX_FIRST_FRAME_DATA_URL:
                errors.append(
                    f"{where}.first_frame_image: data URL too large "
                    "(compress the image and retry)"
                )
    return errors


def _target_binds_plan(envelope: CommandEnvelope, plan_version) -> bool:
    """The confirmed target must name exactly the plan version being superseded."""
    target = envelope.target
    if not isinstance(target, dict) or not isinstance(plan_version, int):
        return False
    ref = target.get("ref")
    if not isinstance(ref, str):
        return False
    match = _PLAN_REF_RE.match(ref)
    return (
        match is not None
        and int(match.group(1)) == plan_version
        and target.get("version") == plan_version
    )


# --- derived official content ---------------------------------------------------


@dataclass(frozen=True, slots=True)
class _LockedDraft:
    """The deterministic official content one draft lock will publish."""

    current_plan_version: int
    new_plan_version: int
    scene_id: str
    shot_ids: tuple[str, ...]
    prompts: tuple[dict, ...]
    plan_dict: dict
    brief_dict: dict | None
    story_dict: dict | None
    shots_params: tuple[dict, ...]


def _build_locked_draft(project_root: Path, params) -> _LockedDraft:
    """Derive every document the lock will publish; raises fail-closed.

    All ids are minted from the NEW plan version (``shot-p<N>-<seq>``), so a
    lock never collides with the record ids of an earlier plan and shot
    records stay immutable single-version facts.
    """
    current = latest_shot_plan_version(project_root)
    if current is None:
        raise AiVideoWorkflowError(
            "project has no shot plan; lock-draft-plan supersedes an existing "
            "approved plan version"
        )
    if current != params["plan_version"]:
        raise AiVideoWorkflowError(
            f"plan_version {params['plan_version']} is stale: the current shot "
            f"plan is v{current}; re-preview against the current plan"
        )
    # Generation parameters the draft does not decide (model / resolution /
    # geometry) are inherited from the plan version being superseded, so a
    # lock changes creative content, never the approved technical baseline.
    baseline = load_shot_plan(project_root, current).shots[0]

    new_version = current + 1
    scene_id = f"scene-p{new_version}"
    shots = params["shots"]
    shot_ids = tuple(f"shot-p{new_version}-{seq}" for seq in range(1, len(shots) + 1))

    prompts: list[dict] = []
    plan_rows: list[dict] = []
    for seq, (shot_id, entry) in enumerate(zip(shot_ids, shots, strict=True), start=1):
        prompt_id = f"p-{shot_id}"
        prompts.append(
            {
                "schema_version": 1,
                "prompt_id": prompt_id,
                "version": 1,
                "text": entry["description"],
                "previous_version": None,
                "change_reason": None,
                "reference_assets": [],
            }
        )
        first_frame = entry["first_frame_image"]
        plan_rows.append(
            {
                "shot_id": shot_id,
                "sequence": seq,
                "prompt_ref": {"prompt_id": prompt_id, "version": 1},
                "duration_seconds": entry["duration_seconds"],
                "resolution": baseline.resolution,
                # a draft with a first frame is image-to-video by definition
                "capability": (
                    "image_to_video" if first_frame is not None else "text_to_video"
                ),
                "model_id": baseline.model_id,
                "width": baseline.width,
                "height": baseline.height,
                "frame_rate": baseline.frame_rate,
                "reuse_assets": [],
                "first_frame_image": first_frame,
            }
        )
    plan_dict = {"schema_version": 1, "version": new_version, "shots": plan_rows}

    brief_dict = _next_versioned(project_root, params.get("brief"), "brief_v", "brief")
    story_dict = _next_versioned(project_root, params.get("story"), "story_v", "story")

    # Validate through the exact planning parsers that will publish, so the
    # preview surfaces the real planning-contract blockers (shot count, total
    # duration, prompt shape) without writing anything.
    for prompt in prompts:
        parse_prompt(prompt)
    parse_shot_plan(plan_dict)
    if brief_dict is not None:
        parse_brief(brief_dict)
    if story_dict is not None:
        parse_story(story_dict)

    return _LockedDraft(
        current_plan_version=current,
        new_plan_version=new_version,
        scene_id=scene_id,
        shot_ids=shot_ids,
        prompts=tuple(prompts),
        plan_dict=plan_dict,
        brief_dict=brief_dict,
        story_dict=story_dict,
        shots_params=tuple(shots),
    )


def _next_versioned(project_root: Path, payload, prefix: str, what: str) -> dict | None:
    """An optional brief/story payload becomes the next document version."""
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise AiVideoWorkflowError(f"{what}: expected an object or null")
    current = _highest_version(project_root, PLANNING_DIR, prefix)
    if current is None:
        raise AiVideoWorkflowError(
            f"project has no {what}; lock-draft-plan only versions an existing {what}"
        )
    return {
        **payload,
        "schema_version": 1,
        "version": current + 1,
    }


def _existing_paths(project_root: Path, draft: _LockedDraft) -> list[str]:
    """Any already-existing file the lock would need to create (fail-closed)."""
    relpaths = [
        f"records/scenes/{draft.scene_id}.json",
        f"{PLANNING_DIR}/shot_plan_v{draft.new_plan_version}.json",
    ]
    for shot_id in draft.shot_ids:
        relpaths.append(f"records/shots/{shot_id}.json")
        relpaths.append(f"{PLANNING_DIR}/prompts/p-{shot_id}/v1.json")
        relpaths.append(f"{PLANNING_DIR}/packets/{shot_id}_v1.json")
    return [
        relpath
        for relpath in relpaths
        if resolve_within_root(project_root, relpath).exists()
    ]


def _approval_blockers(project_root: Path) -> list[str]:
    """The production_lock prerequisite chain must be approved and fresh,
    and production_lock itself must be re-approvable after the lock."""
    blockers: list[str] = []
    for stage in ("concept_lock", "screenplay_lock", "av_design_lock"):
        try:
            require_stage_approved(project_root, stage)
        except AiVideoWorkflowError as exc:
            blockers.append(f"{type(exc).__name__}: {exc}")
    try:
        load_approval(project_root, "production_lock")
    except NotApprovedError:
        pass  # no marker yet: draft -> review -> approve is legal
    except ApprovalError as exc:
        blockers.append(f"production_lock marker unreadable: {exc}")
    return blockers


def _quote_blockers(
    project_root: Path, deps: _LockDeps, draft: _LockedDraft
) -> list[str]:
    """Every locked shot must be selectable and priceable against the locked
    catalog, or packet compilation would fail after documents were written."""
    try:
        config = load_project_config(project_root)
        catalog = load_locked_catalog(config, deps.catalog_dir)
    except AiVideoWorkflowError as exc:
        return [f"{type(exc).__name__}: {exc}"]
    blockers: list[str] = []
    for row in draft.plan_dict["shots"]:
        try:
            selection = resolve_provider_selection(
                config,
                catalog,
                row["shot_id"],
                capability=row["capability"],
                model_id=row["model_id"],
            )
            estimate_generation_cost(
                catalog,
                config.fx,
                selection.primary_provider_id,
                row["model_id"],
                resolution=row["resolution"],
                duration_seconds=row["duration_seconds"],
            )
        except AiVideoWorkflowError as exc:
            blockers.append(
                f"shot {row['shot_id']!r} not producible under the locked "
                f"catalog: {exc}"
            )
    return blockers


# --- preview (read-only) ---------------------------------------------------------


def _preview(project_root: Path, envelope: CommandEnvelope, deps: _LockDeps) -> Preview:
    params = envelope.params
    blockers = _draft_errors(params)
    if owning_project_id(project_root) is None:
        blockers.append("no project identity (project.json missing)")
    if envelope.actor != "user":
        blockers.append("actor must be 'user' (draft lock is a human Gate)")
    if not blockers and not _target_binds_plan(envelope, params.get("plan_version")):
        blockers.append(
            "target must bind the current shot plan version "
            f"(planning/shot_plan_v{params.get('plan_version')}.json)"
        )

    inputs: dict = {"plan_version": params.get("plan_version")}
    draft: _LockedDraft | None = None
    if not blockers:
        try:
            draft = _build_locked_draft(project_root, params)
        except Exception as exc:  # noqa: BLE001 - any unmet prereq is a blocker
            blockers.append(f"{type(exc).__name__}: {exc}")

    if draft is not None:
        blockers.extend(_approval_blockers(project_root))
        existing = _existing_paths(project_root, draft)
        if existing:
            blockers.append(
                "refusing to overwrite existing files: " + ", ".join(existing)
            )
        blockers.extend(_quote_blockers(project_root, deps, draft))
        # The FULL shot table the confirmation binds: text verbatim, images by
        # sha256 (a swapped first frame after preview stales the confirmation
        # without echoing megabytes of data URL back to the client).
        inputs.update(
            {
                "new_plan_version": draft.new_plan_version,
                "publishes_brief": draft.brief_dict is not None,
                "publishes_story": draft.story_dict is not None,
                "shots": [
                    {
                        "shot_id": shot_id,
                        "sequence": seq,
                        "title": entry["title"],
                        "description": entry["description"],
                        "duration_seconds": entry["duration_seconds"],
                        "first_frame_sha256": (
                            None
                            if entry["first_frame_image"] is None
                            else hashlib.sha256(
                                entry["first_frame_image"].encode("utf-8")
                            ).hexdigest()
                        ),
                        # fresh shot ids have no packet history: always v1
                        "packet_version": 1,
                    }
                    for seq, (shot_id, entry) in enumerate(
                        zip(draft.shot_ids, draft.shots_params, strict=True), start=1
                    )
                ],
            }
        )

    return Preview(
        inputs=inputs,
        estimated_cost=None,  # locking never spends; paid flow quotes its own
        downstream=_DOWNSTREAM,
        blockers=tuple(blockers),
    )


# --- apply (versioned publish + re-approval + packet compile) ---------------------


def _apply(project_root: Path, envelope: CommandEnvelope, deps: _LockDeps) -> dict:
    params = envelope.params
    errors = _draft_errors(params)
    if errors:
        raise AiVideoWorkflowError("; ".join(errors))
    if not _target_binds_plan(envelope, params.get("plan_version")):
        raise AiVideoWorkflowError(
            "target does not bind the current shot plan version; refusing to "
            "lock a draft against a drifted plan"
        )
    if envelope.actor != "user":
        raise AiVideoWorkflowError("actor must be 'user' (draft lock is a human Gate)")
    draft = _build_locked_draft(project_root, params)
    approval_blockers = _approval_blockers(project_root)
    if approval_blockers:
        raise AiVideoWorkflowError("; ".join(approval_blockers))
    existing = _existing_paths(project_root, draft)
    if existing:
        raise AiVideoWorkflowError(
            "refusing to overwrite existing files: " + ", ".join(existing)
        )
    quote_blockers = _quote_blockers(project_root, deps, draft)
    if quote_blockers:
        raise AiVideoWorkflowError("; ".join(quote_blockers))

    now = deps.clock()
    published: list[str] = []

    # 1. versioned planning documents first (create-only publishes). A failure
    #    anywhere in this apply leaves only unreferenced NEW versions behind;
    #    the next lock previews against the then-current plan version, mints
    #    fresh ids, and cannot collide with these leftovers (clean retry under
    #    a fresh command_id — never a partial overwrite).
    if draft.brief_dict is not None:
        publish_brief(project_root, draft.brief_dict)
        published.append(f"{PLANNING_DIR}/brief_v{draft.brief_dict['version']}.json")
    if draft.story_dict is not None:
        publish_story(project_root, draft.story_dict)
        published.append(f"{PLANNING_DIR}/story_v{draft.story_dict['version']}.json")
    for prompt in draft.prompts:
        publish_prompt(project_root, prompt)
        published.append(f"{PLANNING_DIR}/prompts/{prompt['prompt_id']}/v1.json")
    publish_shot_plan(project_root, draft.plan_dict)
    plan_relpath = f"{PLANNING_DIR}/shot_plan_v{draft.new_plan_version}.json"
    published.append(plan_relpath)

    # 2. immutable records for the locked shots (create-only, scene first so
    #    every written shot record always references an existing scene).
    scene_path = resolve_within_root(
        project_root, f"records/scenes/{draft.scene_id}.json"
    )
    scene_path.parent.mkdir(parents=True, exist_ok=True)
    write_model_json(
        scene_path,
        Scene(
            scene_id=draft.scene_id,
            project_id=str(owning_project_id(project_root)),
            sequence=draft.new_plan_version,
            title=f"locked draft plan v{draft.new_plan_version}",
            description="scene minted by lock-draft-plan",
            created_at=now,
        ),
    )
    published.append(f"records/scenes/{draft.scene_id}.json")
    shots_dir = resolve_within_root(project_root, "records/shots")
    shots_dir.mkdir(parents=True, exist_ok=True)
    for seq, (shot_id, entry) in enumerate(
        zip(draft.shot_ids, draft.shots_params, strict=True), start=1
    ):
        row = draft.plan_dict["shots"][seq - 1]
        write_model_json(
            shots_dir / f"{shot_id}.json",
            Shot(
                shot_id=shot_id,
                scene_id=draft.scene_id,
                sequence=seq,
                description=entry["title"],
                prompt=entry["description"],
                duration_seconds=float(entry["duration_seconds"]),
                width=row["width"],
                height=row["height"],
                frame_rate=row["frame_rate"],
                created_at=now,
            ),
        )
        published.append(f"records/shots/{shot_id}.json")

    # 3. re-approve production_lock onto the new plan version. The human Gate
    #    already happened (Gateway preview -> bound confirmation); the marker
    #    transition sequence below is the only legal path through the stage
    #    state machine and lands audited in approval/audit.jsonl.
    _approve_production_lock(project_root, plan_relpath, now, envelope.actor)

    # 4. compile the new packet versions from the freshly approved inputs.
    config = load_project_config(project_root)
    catalog = load_locked_catalog(config, deps.catalog_dir)
    account_root = deps.account_root or project_root.parent
    packets = compile_task_packets(project_root, account_root, catalog, config)
    packet_versions = {
        packet.shot_id: packet.packet_version
        for packet in packets
        if packet.shot_id in draft.shot_ids
    }

    return {
        "plan_version": draft.new_plan_version,
        "scene_id": draft.scene_id,
        "shots": [
            {"shot_id": shot_id, "packet_version": packet_versions[shot_id]}
            for shot_id in draft.shot_ids
        ],
        "published": published,
        "production_lock": "re-approved",
    }


def _approve_production_lock(
    project_root: Path, plan_relpath: str, now: datetime, actor: str
) -> None:
    at = now.isoformat()
    try:
        status = load_approval(project_root, "production_lock").status
    except NotApprovedError:
        status = "draft"
    # walk the legal state machine to "approved" from wherever the marker is
    reason = f"superseded by {LOCK_DRAFT_PLAN} ({plan_relpath})"
    if status == "approved":
        transition_stage(
            project_root, "production_lock", "reject", at=at, by=actor, reason=reason
        )
        transition_stage(
            project_root, "production_lock", "revise", at=at, by=actor, reason=reason
        )
    elif status == "draft":
        transition_stage(
            project_root, "production_lock", "review", at=at, by=actor, reason=reason
        )
    elif status == "rejected":
        transition_stage(
            project_root, "production_lock", "revise", at=at, by=actor, reason=reason
        )
    # "review_needed" and "revision" can approve directly
    transition_stage(
        project_root,
        "production_lock",
        "approve",
        at=at,
        by=actor,
        reason=reason,
        targets=(plan_relpath,),
    )


# --- shot-plan target resolver ----------------------------------------------------


class ShotPlanTargetResolver:
    """Resolve a lock target against the authoritative CURRENT shot plan file.

    ``ref`` must be exactly ``planning/shot_plan_v<N>.json`` with ``version``
    equal to ``N``; the digest is the sha256 of the plan file bytes, so a plan
    republished between preview and submit fails closed (``TargetBindingError``
    at the Gateway). Read-only and containment-checked; anything unresolvable
    reads as absent.
    """

    def resolve_target(self, project_root: Path, *, ref: str, version: int):
        from ai_video_workflow.gateway import ResolvedTarget

        if not isinstance(ref, str):
            return ResolvedTarget(exists=False, content_digest=None)
        match = _PLAN_REF_RE.match(ref)
        if match is None or int(match.group(1)) != version:
            return ResolvedTarget(exists=False, content_digest=None)
        try:
            plan_file = resolve_within_root(project_root, ref)
        except AiVideoWorkflowError:
            return ResolvedTarget(exists=False, content_digest=None)
        if not plan_file.is_file():
            return ResolvedTarget(exists=False, content_digest=None)
        try:
            digest = hashlib.sha256(plan_file.read_bytes()).hexdigest()
        except OSError:
            return ResolvedTarget(exists=False, content_digest=None)
        return ResolvedTarget(exists=True, content_digest=digest)

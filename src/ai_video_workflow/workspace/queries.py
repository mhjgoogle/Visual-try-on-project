"""The WQ-01..WQ-14 read-only queries (TASK-025 / WSM1-A).

Each function evaluates one query on demand from authoritative sources
(via the adapters) and returns a :class:`QueryResult`. No function writes
anything, calls a Provider, imports UI, reads credential values, or holds a
cache. Ordering is deterministic; missing/corrupt/unsupported sources
surface as structured problems (query contract §3/§4).
"""

from __future__ import annotations

from pathlib import Path

from ai_video_workflow.workspace import io_contract
from ai_video_workflow.workspace.adapters import (
    delivery,
    evaluation,
    execution,
    plan,
    project,
)
from ai_video_workflow.workspace.discovery import discover_projects
from ai_video_workflow.workspace.envelope import (
    QUERY_CONTRACT_VERSION,
    Field,
    Problem,
    ProblemCategory,
    QueryResult,
)

_CV = QUERY_CONTRACT_VERSION


def _result(query_id: str, now: str, scope: dict, items, problems) -> QueryResult:
    return QueryResult(
        query_id=query_id,
        contract_version=_CV,
        generated_at=now,
        scope=scope,
        items=tuple(items),
        problems=tuple(problems),
    ).with_markers()


# --- WQ-01 project-plan -------------------------------------------------------


def project_plan(project_root: Path, now: str) -> QueryResult:
    """The complete Project/L0-S7 step plan (definition always available;
    run instance authoritative only where WFM1 implements it, else
    unavailable) — query contract §5, from the I/O contract definitions."""
    src = plan.read_approvals(project_root)
    states = {s.stage_id: s for s in src.states}
    items: list[dict[str, Field]] = []
    for i, step in enumerate(io_contract.steps()):
        run = io_contract.run_source(step.step_id)
        # run-instance status: authoritative for implemented approval stages,
        # unavailable for every step WFM1 does not yet execute (§5.3)
        if run is not None and run in states:
            st = states[run]
            run_status = Field.authoritative(st.status)
            run_stale = Field.authoritative(bool(st.stale))
        elif run == "profile":
            run_status = Field.authoritative("defined")
            run_stale = Field.authoritative(False)
        elif run in ("paid_generation",):
            run_status = Field.derived("see WQ-06/WQ-07 for run facts")
            run_stale = Field.derived(False)
        else:
            run_status = Field.unavailable(
                "WFM1 does not execute this step (owner ADR-0037..0039)"
            )
            run_stale = Field.unavailable()
        gate = io_contract.gate_for(step.step_id)
        items.append(
            {
                "step_id": Field.authoritative(step.step_id),
                "level": Field.authoritative(step.level),
                "title": Field.authoritative(step.title),
                "sequence": Field.authoritative(i + 1),
                "execution": Field.authoritative(step.execution),
                "required_inputs": Field.authoritative(list(step.required_inputs)),
                "logical_outputs": Field.authoritative(list(step.logical_outputs)),
                "responsibility": Field.authoritative(step.responsibility),
                "completion": Field.authoritative(step.completion),
                "gate": (
                    Field.authoritative(gate)
                    if gate is not None
                    else Field.derived(None)
                ),
                "run_status": run_status,
                "run_stale": run_stale,
            }
        )
    scope = {
        "project_root": str(project_root),
        "io_contract_version": io_contract.IO_CONTRACT_VERSION,
        "step_count": len(items),
    }
    return _result("WQ-01", now, scope, items, src.problems)


# --- WQ-02 project-status -----------------------------------------------------


def project_status(project_root: Path, now: str) -> QueryResult:
    src = plan.read_approvals(project_root)
    approved = sum(1 for s in src.states if s.status == "approved" and not s.stale)
    total = len(src.plan)
    states = {s.stage_id: s for s in src.states}
    current = None
    for info in src.plan:
        st = states.get(info.stage_id)
        if st is None or st.status != "approved" or st.stale:
            current = info.stage_id
            break
    items: list[dict[str, Field]] = []
    for info in src.plan:
        s = states.get(info.stage_id)
        status = s.status if s is not None else "draft"
        blocked = list(s.blocked_by) if s is not None else list(info.prerequisites)
        # a non-approved/stale stage that is not yet blocked is the running one
        running = status != "approved" and not blocked
        reason = None
        if s is not None and s.stale:
            reason = "approved target content changed (stale)"
        elif blocked:
            reason = "waiting on prerequisites: " + ", ".join(blocked)
        items.append(
            {
                "stage_id": Field.authoritative(info.stage_id),
                "status": (
                    Field.authoritative(s.status)
                    if s is not None
                    else Field.derived("draft")
                ),
                "stale": (
                    Field.authoritative(bool(s.stale))
                    if s is not None
                    else Field.derived(False)
                ),
                "running": Field.derived(running),
                "blocked_by": Field.derived(blocked),
                "reason": (
                    Field.derived(reason) if reason is not None else Field.derived(None)
                ),
            }
        )
    scope = {
        "project_root": str(project_root),
        "current_stage": current or "complete",
        "approved": approved,
        "total": total,
        "progress": round(approved / total, 4) if total else 0.0,
    }
    return _result("WQ-02", now, scope, items, src.problems)


# --- WQ-03 lineage-upstream ---------------------------------------------------


def lineage_upstream(project_root: Path, artifact_ref: str, now: str) -> QueryResult:
    """Upstream inputs of a formal artifact, resolved by ref+version+digest.

    Every formal artifact must reach a producing task and a matched task
    packet; a missing producer, an unmatched packet spec, or a shot with no
    packet is a structured problem with ``readiness_failed`` (requirements
    §3.3, §7) — orphan lineage never returns a silent success.
    """
    problems: list[Problem] = []
    src = project.read_project(project_root)
    problems.extend(src.problems)
    asset = None
    if src.data is not None:
        asset = next(
            (a for a in src.data.video_assets if a.asset_id == artifact_ref), None
        )
    if asset is None:
        problems.append(
            Problem.of(
                ProblemCategory.NOT_FOUND,
                f"no video asset {artifact_ref!r}",
                readiness_failed=True,
                artifact=artifact_ref,
            )
        )
        return _result(
            "WQ-03",
            now,
            {"artifact_ref": artifact_ref, "project_root": str(project_root)},
            [],
            problems,
        )
    lin, lin_problems = execution.lineage(project_root, asset.source_task_id)
    problems.extend(lin_problems)
    if lin.get("task") is None:
        problems.append(
            Problem.of(
                ProblemCategory.ORPHAN_LINEAGE,
                f"asset {artifact_ref!r} has no producing task record",
                readiness_failed=True,
                artifact=artifact_ref,
                task=asset.source_task_id,
            )
        )
    packets = lin.get("packets", [])
    if not packets:
        problems.append(
            Problem.of(
                ProblemCategory.ORPHAN_LINEAGE,
                f"asset {artifact_ref!r} has no task packet input",
                readiness_failed=True,
                artifact=artifact_ref,
            )
        )
    elif not any(p.get("matched_operation_spec") for p in packets):
        problems.append(
            Problem.of(
                ProblemCategory.DIGEST_MISMATCH,
                f"no packet spec matches a settled operation for {artifact_ref!r}",
                readiness_failed=True,
                artifact=artifact_ref,
            )
        )
    items = [
        {
            "artifact_ref": Field.authoritative(asset.asset_id),
            "artifact_version": Field.authoritative(asset.version),
            "producing_task": Field.authoritative(asset.source_task_id),
            "packets": Field.authoritative(packets),
            "operations": Field.authoritative(lin.get("operations", [])),
            "input_events": Field.derived(lin.get("events", [])),
        }
    ]
    return _result(
        "WQ-03",
        now,
        {"artifact_ref": artifact_ref, "project_root": str(project_root)},
        items,
        problems,
    )


# --- WQ-04 lineage-downstream -------------------------------------------------


def lineage_downstream(project_root: Path, object_ref: str, now: str) -> QueryResult:
    """Direct consumers of an input (a task, prompt, reuse asset, or shot).

    Covers: task -> produced assets; prompt/reuse-asset -> task packets ->
    their tasks; shot -> its packets and reservations; and redo/fallback
    successors of a task (query contract §3 WQ-04, requirements §5).
    """
    problems: list[Problem] = []
    src = project.read_project(project_root)
    problems.extend(src.problems)
    consumers: list[dict] = []
    if src.data is not None:
        for a in src.data.video_assets:
            if a.source_task_id == object_ref:
                consumers.append({"kind": "video_asset", "ref": a.asset_id})
    psrc = plan.read_planning(project_root)
    problems.extend(psrc.problems)
    for pk in psrc.packets:
        if (
            pk.prompt_id == object_ref
            or pk.shot_id == object_ref
            or any(r.get("asset_id") == object_ref for r in pk.reuse_assets)
        ):
            consumers.append(
                {"kind": "task_packet", "ref": f"{pk.shot_id}_v{pk.packet_version}"}
            )
    esrc = execution.read_execution(project_root)
    problems.extend(esrc.problems)
    for r in esrc.reservations:
        # a redo/fallback operation is a downstream successor of the task
        if r.task_id == object_ref and r.operation_id.endswith(":fallback"):
            consumers.append({"kind": "fallback_operation", "ref": r.operation_id})
        if r.shot_id == object_ref:
            consumers.append(
                {"kind": "operation", "ref": f"{r.task_id}/{r.operation_id}"}
            )
    consumers.sort(key=lambda c: (c["kind"], c["ref"]))
    items = [
        {
            "consumer_kind": Field.authoritative(c["kind"]),
            "ref": Field.authoritative(c["ref"]),
        }
        for c in consumers
    ]
    return _result(
        "WQ-04",
        now,
        {"object_ref": object_ref, "project_root": str(project_root)},
        items,
        problems,
    )


# --- WQ-05 prompt-history -----------------------------------------------------


def prompt_history(project_root: Path, prompt_id: str, now: str) -> QueryResult:
    """A prompt's version chain with, per version: change basis, generation
    packets, ALL settled results, the selected (registered) result, and
    downstream products — for WFM1-supported video only; image/audio/
    subtitle results are explicitly unavailable (query contract §3 WQ-05)."""
    chain, cp = plan.prompt_versions(project_root, prompt_id)
    problems: list[Problem] = list(cp)
    psrc = plan.read_planning(project_root)
    problems.extend(psrc.problems)
    esrc = execution.read_execution(project_root)
    problems.extend(esrc.problems)
    proj = project.read_project(project_root)
    problems.extend(proj.problems)
    assets = proj.data.video_assets if proj.data is not None else ()

    items: list[dict[str, Field]] = []
    for pv in chain:
        packets = [
            pk
            for pk in psrc.packets
            if pk.prompt_id == prompt_id and pk.prompt_version == pv.version
        ]
        shot_ids = {pk.shot_id for pk in packets}
        # all settled results (operations) for those shots
        results = [
            {
                "task_id": r.task_id,
                "operation_id": r.operation_id,
                "status": r.status,
            }
            for r in esrc.reservations
            if r.shot_id in shot_ids
        ]
        results.sort(key=lambda x: (x["task_id"], x["operation_id"]))
        # the selected result = the registered formal VideoAsset for the shot
        selected = [
            {"asset_id": a.asset_id, "version": a.version, "shot_id": a.shot_id}
            for a in assets
            if a.shot_id in shot_ids
        ]
        selected.sort(key=lambda x: (x["shot_id"], x["version"]))
        items.append(
            {
                "prompt_id": Field.authoritative(pv.prompt_id),
                "version": Field.authoritative(pv.version),
                "digest": Field.authoritative(pv.digest),
                "previous_version": Field.authoritative(pv.previous_version),
                "change_reason": Field.authoritative(pv.change_reason),
                "reference_assets": Field.authoritative(list(pv.reference_assets)),
                "generation_packets": Field.derived(
                    sorted(f"{pk.shot_id}_v{pk.packet_version}" for pk in packets)
                ),
                "all_results": Field.authoritative(results),
                "selected_results": Field.authoritative(selected),
                "downstream_products": Field.derived(
                    sorted(s["asset_id"] for s in selected)
                ),
                "image_audio_subtitle_results": Field.unavailable(),
            }
        )
    if not chain:
        problems.append(
            Problem.of(
                ProblemCategory.NOT_FOUND,
                f"no prompt {prompt_id!r}",
                readiness_failed=True,
                prompt=prompt_id,
            )
        )
    return _result(
        "WQ-05",
        now,
        {"prompt_id": prompt_id, "project_root": str(project_root)},
        items,
        problems,
    )


# --- WQ-06 shot-attempts ------------------------------------------------------


def shot_attempts(project_root: Path, shot_id: str, now: str) -> QueryResult:
    """All attempts for a shot with their relationship kind distinguished:
    primary / fallback / redo / retry, plus each attempt's status and reason
    — skip/retry/redo/fallback/cancel are never collapsed into 'failed'
    (requirements §3.2.5, query contract §3 WQ-06)."""
    esrc = execution.read_execution(project_root)
    problems: list[Problem] = list(esrc.problems)
    # task_status_changed events give per-task status transitions + reasons
    status_events = [
        e
        for e in esrc.events
        if e.event_type.value == "task_status_changed" and e.shot_id == shot_id
    ]
    reservations = [r for r in esrc.reservations if r.shot_id == shot_id]
    reservations.sort(key=lambda r: (r.created_at, r.operation_id))
    tasks_seen: set[str] = set()
    items: list[dict[str, Field]] = []
    for r in reservations:
        if r.operation_id.endswith(":fallback"):
            kind = "fallback"
        elif r.task_id in tasks_seen:
            kind = "retry"
        else:
            kind = "primary"
        tasks_seen.add(r.task_id)
        # a redo task is a distinct task id created after a prior task for the
        # same shot (origin recorded in the task_created event)
        redo = any(
            e.event_type.value == "task_created"
            and e.task_id == r.task_id
            and e.payload.get("origin") == "redo"
            for e in esrc.events
        )
        if redo:
            kind = "redo"
        reason = r.note
        for e in status_events:
            if e.task_id == r.task_id and e.payload.get("reason"):
                reason = e.payload.get("reason")
        items.append(
            {
                "task_id": Field.authoritative(r.task_id),
                "operation_id": Field.authoritative(r.operation_id),
                "attempt_kind": Field.derived(kind),
                "status": Field.authoritative(r.status),
                "reason": Field.authoritative(reason),
                "provider_id": Field.authoritative(r.provider_id),
                "model_id": Field.authoritative(r.model_id),
                "resolution": Field.authoritative(r.resolution),
                "duration_seconds": Field.authoritative(r.duration_seconds),
                "external_task_ref": Field.authoritative(r.external_task_ref),
                "created_at": Field.authoritative(r.created_at),
                "resolved_at": Field.authoritative(r.resolved_at),
            }
        )
    return _result(
        "WQ-06",
        now,
        {"shot_id": shot_id, "project_root": str(project_root)},
        items,
        problems,
    )


# --- WQ-07 cost-breakdown -----------------------------------------------------


def cost_breakdown(project_root: Path, now: str) -> QueryResult:
    """Per-operation cost facts plus derived dimensions, with reconciliation
    checked: quote/estimate/hold/actual are distinct semantics and never
    merged; the original-currency amount is authoritative, JPY and all
    rollups are derived; a paid operation that cannot be tied to a
    quote/hold/actual — or a reservation left needing reconciliation —
    raises ``cost_unreconciled`` and fails readiness (requirements §3.4, §7).
    """
    problems: list[Problem] = []
    psrc = project.read_project(project_root)
    problems.extend(psrc.problems)
    plsrc = plan.read_planning(project_root)
    problems.extend(plsrc.problems)
    esrc = execution.read_execution(project_root)
    problems.extend(esrc.problems)

    # index actual cost events by (task, operation)
    cost_events = {
        (e.task_id, e.payload.get("operation_id")): e
        for e in esrc.events
        if e.event_type.value == "provider_cost_recorded"
    }
    packets_by_shot = {pk.shot_id: pk for pk in plsrc.packets}

    # per-operation facts: quote (packet), hold (reservation), actual (event)
    per_operation: list[dict] = []
    for r in esrc.reservations:
        ev = cost_events.get((r.task_id, r.operation_id))
        actual = None
        if ev is not None:
            actual = {
                "cost_minor_units": ev.payload.get("cost_minor_units"),
                "currency": ev.payload.get("currency"),
                "provider_id": ev.payload.get("provider_id"),
                "model_id": ev.payload.get("model_id"),
            }
        pk = packets_by_shot.get(r.shot_id)
        per_operation.append(
            {
                "task_id": r.task_id,
                "operation_id": r.operation_id,
                "shot_id": r.shot_id,
                "provider_id": r.provider_id,
                "model_id": r.model_id,
                "status": r.status,
                "quote_minor_units": r.quote_minor_units,
                "quote_currency": r.quote_currency,
                "hold_estimate_jpy": r.estimate_jpy if r.is_outstanding else None,
                "actual": actual,
                "occurred_at": (ev.occurred_at.isoformat() if ev is not None else None),
                # JST calendar month of the cost event, from the SAME helper as
                # by_time and the budget ledger — so a client filtering per-op
                # rows by month can never disagree with the monthly rollups.
                "occurred_month": (
                    execution.month_of(ev.occurred_at) if ev is not None else None
                ),
                "packet_estimate_jpy": pk.estimate_jpy if pk is not None else None,
            }
        )
        # reconciliation: committed op must have an actual cost event; a
        # needs_reconciliation reservation is by definition unreconciled
        if r.status == "needs_reconciliation":
            problems.append(
                Problem.of(
                    ProblemCategory.COST_UNRECONCILED,
                    f"operation {r.task_id}/{r.operation_id} awaits reconciliation",
                    readiness_failed=True,
                    task=r.task_id,
                    operation=r.operation_id,
                )
            )
        elif r.status == "committed" and ev is None:
            problems.append(
                Problem.of(
                    ProblemCategory.COST_UNRECONCILED,
                    f"committed operation {r.task_id}/{r.operation_id} has no "
                    "authoritative cost event",
                    readiness_failed=True,
                    task=r.task_id,
                    operation=r.operation_id,
                )
            )
    per_operation.sort(key=lambda x: (x["task_id"], x["operation_id"]))

    # The single WFM1 step/stage that owns paid-generation cost, derived from
    # the I/O contract (NOT a writer change): every paid operation is booked at
    # the paid_generation step, so cost attributes there. Deriving it from the
    # contract keeps by_step/by_stage correct if the step id ever moves.
    _paid_step = next(
        (
            s
            for s in io_contract.steps()
            if io_contract.run_source(s.step_id) == "paid_generation"
        ),
        None,
    )
    paid_step_id = _paid_step.step_id if _paid_step is not None else "unknown"
    paid_stage = _paid_step.level if _paid_step is not None else "unknown"

    # derived dimensions (rollups are DERIVED, not authoritative). Each rollup
    # keeps currencies in separate buckets — amounts of different currencies
    # are never summed. by_time buckets by JST calendar month (the budget
    # ledger's unit), so cost-over-time lines up with monthly_remaining_jpy.
    by_shot: dict[str, dict[str, int]] = {}
    by_provider: dict[str, dict[str, int]] = {}
    by_model: dict[str, dict[str, int]] = {}
    by_step: dict[str, dict[str, int]] = {}
    by_stage: dict[str, dict[str, int]] = {}
    by_time: dict[str, dict[str, int]] = {}
    for op in per_operation:
        if op["actual"] is None:
            continue
        cur = op["actual"]["currency"]
        amt = op["actual"]["cost_minor_units"]
        if not isinstance(amt, int) or not isinstance(cur, str):
            continue
        for dim, key in (
            (by_shot, op["shot_id"]),
            (by_provider, op["actual"]["provider_id"]),
            (by_model, op["actual"]["model_id"]),
            (by_step, paid_step_id),
            (by_stage, paid_stage),
        ):
            dim.setdefault(key, {}).setdefault(cur, 0)
            dim[key][cur] += amt
        ce = cost_events.get((op["task_id"], op["operation_id"]))
        if ce is not None:
            month = execution.month_of(ce.occurred_at)
            by_time.setdefault(month, {}).setdefault(cur, 0)
            by_time[month][cur] += amt

    project_total_jpy = None
    actual_by_currency: dict[str, int] = {}
    if psrc.data is not None:
        summary = execution.summarize(esrc.events, psrc.data)
        actual_by_currency = dict(summary.per_project.cost_by_currency)
        if psrc.config is not None:
            project_total_jpy = execution.ledger(
                esrc.events, psrc.config.fx
            ).project_total_jpy

    quotes = [
        {
            "shot_id": pk.shot_id,
            "quote_minor_units": pk.quote_minor_units,
            "quote_currency": pk.quote_currency,
            "estimate_jpy": pk.estimate_jpy,
            "p50_jpy": pk.p50_jpy,
            "p90_jpy": pk.p90_jpy,
        }
        for pk in plsrc.packets
    ]
    items = [
        {
            "quotes": Field.authoritative(quotes),
            "per_operation": Field.authoritative(per_operation),
            "by_shot": Field.derived(by_shot),
            "by_provider": Field.derived(by_provider),
            "by_model": Field.derived(by_model),
            "by_step": Field.derived(by_step),
            "by_stage": Field.derived(by_stage),
            "by_time": Field.derived(by_time),
            "actual_by_currency": Field.derived(actual_by_currency),
            "actual_total_jpy": (
                Field.derived(project_total_jpy)
                if project_total_jpy is not None
                else Field.unavailable("no locked FX / config")
            ),
        }
    ]
    return _result("WQ-07", now, {"project_root": str(project_root)}, items, problems)


# --- WQ-08 evaluation-decision ------------------------------------------------


def _target_version(target: object) -> int | None:
    """Extract the final-output version from a target ref like
    'outputs/final_v3.mp4' (query contract §3 WQ-08: explicit target version)."""
    if not isinstance(target, dict):
        return None
    ref = target.get("ref")
    if not isinstance(ref, str):
        return None
    marker = "_v"
    if marker in ref:
        tail = ref.rsplit(marker, 1)[1].split(".", 1)[0]
        if tail.isdigit():
            return int(tail)
    return None


def evaluation_decision(project_root: Path, now: str) -> QueryResult:
    dsrc = delivery.read_delivery(project_root)
    problems: list[Problem] = list(dsrc.problems)
    items: list[dict[str, Field]] = []
    if dsrc.final_review is not None:
        rv = dsrc.final_review
        target = rv.get("target")
        items.append(
            {
                "kind": Field.authoritative("final_review"),
                "verdict": Field.authoritative(rv.get("verdict")),
                "by": Field.authoritative(rv.get("by")),
                "decision_reason": Field.authoritative(rv.get("decision_reason")),
                "issue_tags": Field.authoritative(rv.get("issue_tags", [])),
                "compared_versions": Field.authoritative(
                    rv.get("compared_versions", [])
                ),
                "ai_assisted": Field.authoritative(rv.get("ai_assisted")),
                "target": Field.authoritative(target),
                "target_version": Field.derived(_target_version(target)),
                "profile_ref": Field.authoritative(rv.get("profile_ref")),
            }
        )
    if dsrc.technical_qc is not None:
        items.append(
            {
                "kind": Field.authoritative("technical_qc"),
                "passed": Field.authoritative(dsrc.technical_qc.get("passed")),
                "checks": Field.authoritative(dsrc.technical_qc.get("checks", [])),
                "final_output": Field.authoritative(
                    dsrc.technical_qc.get("final_output")
                ),
            }
        )
    # L0/S1/S2 creative decisions are WFM2 scope
    items.append(
        {
            "kind": Field.authoritative("_creative_decisions"),
            "detail": Field.unavailable("L0/S1/S2 creative decisions are WFM2 scope"),
        }
    )
    return _result("WQ-08", now, {"project_root": str(project_root)}, items, problems)


# --- WQ-15 evaluation-domain (ADR-0034 / TASK-028, WSM2-A) --------------------


def _stale_problem(record_id: str, reasons: tuple[str, ...]) -> Problem:
    """Map a stale record's reasons to one structured, non-readiness problem.

    A stale evaluation still returns as an authoritative fact; the problem only
    flags that its binding no longer matches the current authoritative facts
    (ADR-0034 P3) — informational, so it never fails readiness.
    """
    joined = "; ".join(reasons)
    if any("missing" in r for r in reasons):
        category = ProblemCategory.MISSING_REF
    elif any("digest" in r for r in reasons):
        category = ProblemCategory.DIGEST_MISMATCH
    else:  # goals moved / newer version
        category = ProblemCategory.VERSION_ABSENT
    return Problem.of(
        category,
        f"evaluation {record_id} is stale: {joined}",
        readiness_failed=False,
        object=record_id,
    )


def _read_qcd_events(project_root: Path):
    """Read the QCD event log for cost/time derivation; ``None`` if unreadable.

    A corrupt/unreadable event log makes cost/time simply unavailable (QCD
    integrity is surfaced by WQ-07/WQ-09, not here), so this never raises into
    the evaluation query.
    """
    from ai_video_workflow.qcd.log import QcdLogError, read_events

    try:
        return read_events(project_root)
    except QcdLogError:
        return None


def _asset_task_index(events) -> dict[tuple[str, int], str]:
    """Map each imported asset ``(asset_id, version)`` to its producing task.

    First-wins per key, matching the QCD reader's dedup, so a replayed import
    cannot change which task an evaluation variant resolves to.
    """
    from ai_video_workflow.qcd.events import QcdEventType

    index: dict[tuple[str, int], str] = {}
    for e in events:
        if e.event_type is not QcdEventType.ASSET_IMPORTED:
            continue
        key = (e.payload.get("asset_id"), e.payload.get("version"))
        source = e.payload.get("source_task_id")
        if key not in index and isinstance(source, str):
            index[key] = source
    return index


def _experiment_cost_time(record, asset_task: dict, per_task: dict) -> dict:
    """Per-variant authoritative cost/time + delta vs the first-listed variant.

    Each variant's video asset resolves through its producing task to the
    authoritative ``cost_by_currency`` (minor units) and ``attempts_elapsed_ms``
    aggregated over that task's QCD facts (ADR-0034: derived in the query layer,
    never a second cost source). Cost is only KNOWN when the variant resolves to
    an aggregated task: ``cost_known`` distinguishes a KNOWN zero (a task with no
    paid cost, e.g. a manual variant → ``cost_by_currency == {}``) from an
    UNKNOWN cost (no producing task / not aggregated → ``cost_by_currency`` is
    ``null``). A delta is emitted ONLY when BOTH sides are known — an unknown
    cost never fabricates a numeric delta against a paid baseline (the
    "never faked" contract). The elapsed delta is likewise ``null`` unless both
    elapsed values are known.
    """
    baseline = None
    variants: list[dict] = []
    for index, v in enumerate(record.payload["variants"]):
        ref = str(v["ref"])
        version = int(v["version"])
        task_id = asset_task.get((ref, version))
        metrics = per_task.get(task_id) if task_id is not None else None
        known = metrics is not None
        row = {
            "ref": ref,
            "version": version,
            "task_id": task_id,
            "cost_known": known,
            "cost_by_currency": dict(metrics.cost_by_currency) if known else None,
            "attempts_elapsed_ms": metrics.attempts_elapsed_ms if known else None,
        }
        if index == 0:
            baseline = row
        # cost delta only when BOTH this variant and the baseline have KNOWN cost
        if known and baseline["cost_known"]:
            cost = row["cost_by_currency"]
            base_cost = baseline["cost_by_currency"]
            currencies = sorted(set(cost) | set(base_cost))
            row["delta_cost_by_currency"] = {
                c: cost.get(c, 0) - base_cost.get(c, 0) for c in currencies
            }
        else:
            row["delta_cost_by_currency"] = None
        # elapsed delta only when both elapsed values are known
        base_elapsed = baseline["attempts_elapsed_ms"]
        row["delta_attempts_elapsed_ms"] = (
            row["attempts_elapsed_ms"] - base_elapsed
            if row["attempts_elapsed_ms"] is not None and base_elapsed is not None
            else None
        )
        variants.append(row)
    return {"baseline_index": 0, "variants": variants}


def evaluation_domain(project_root: Path, now: str) -> QueryResult:
    """The append-only evaluation / experiment / creative-decision facts, each
    with its bound target + goals + actor + payload (authoritative) and a
    read-time DERIVED staleness (goals/digest/version drift, vanished target).
    Experiment payloads carry their compared variants + changed factor +
    expected/actual + reuse conclusion (the comparison view); each experiment
    also gets a DERIVED per-variant incremental cost/time (authoritative
    cost_by_currency + attempts_elapsed_ms per variant, delta vs the first
    variant), or ``unavailable`` when project data is absent — never faked
    (query contract §8; ADR-0034 keeps cost/time derived, not a second source).
    Sorted by occurred_at then record_id (query contract §3 WQ-15)."""
    from ai_video_workflow.evaluation import (
        EvaluationRecordType,
        WorkflowAuthoritativeFacts,
        staleness_of,
    )

    src = evaluation.read_evaluation(project_root)
    problems: list[Problem] = list(src.problems)
    facts = WorkflowAuthoritativeFacts()
    current_goals = facts.current_goals_version(project_root)
    rows = sorted(src.records, key=lambda r: (r.occurred_at.isoformat(), r.record_id))

    # Cost/time is a SECONDARY derived add-on, and only for experiments: read
    # the QCD facts (not reservations) only when an experiment is present. When
    # project data or a readable event log is absent, cost/time is simply marked
    # unavailable per experiment (the honest three-way signal) — WQ-15's own
    # problems stay focused on the evaluation domain, never coupled to unrelated
    # cost-source health.
    has_experiment = any(r.record_type is EvaluationRecordType.EXPERIMENT for r in rows)
    per_task: dict = {}
    asset_task: dict = {}
    cost_available = False
    if has_experiment:
        data = project.read_project(project_root).data
        events = _read_qcd_events(project_root)
        if data is not None and events is not None:
            summary = execution.summarize(events, data)
            per_task = {t.task_id: t for t in summary.per_task}
            asset_task = _asset_task_index(events)
            cost_available = True

    items: list[dict[str, Field]] = []
    for record in rows:
        stale = staleness_of(
            record,
            facts=facts,
            project_root=project_root,
            current_goals=current_goals,
        )
        env = record.to_envelope()
        if record.record_type is not EvaluationRecordType.EXPERIMENT:
            cost_time = Field.unavailable(
                "incremental cost/time applies to experiments"
            )
        elif cost_available:
            cost_time = Field.derived(
                _experiment_cost_time(record, asset_task, per_task)
            )
        else:
            cost_time = Field.unavailable(
                "cost/time needs project data + QCD facts (none available)"
            )
        items.append(
            {
                "record_type": Field.authoritative(record.record_type.value),
                "record_id": Field.authoritative(record.record_id),
                "occurred_at": Field.authoritative(env["occurred_at"]),
                "actor": Field.authoritative(record.actor.value),
                "target": Field.authoritative(env["target"]),
                "goals_version": Field.authoritative(record.goals_version),
                "payload": Field.authoritative(env["payload"]),
                "stale": Field.derived(stale.is_stale),
                "stale_reasons": Field.derived(list(stale.reasons)),
                "incremental_cost_time": cost_time,
            }
        )
        if stale.is_stale:
            problems.append(_stale_problem(record.record_id, stale.reasons))
    return _result("WQ-15", now, {"project_root": str(project_root)}, items, problems)


# --- WQ-09 recent-problems ----------------------------------------------------


def recent_problems(project_root: Path, now: str) -> QueryResult:
    """Recent errors / QC problems with their project/step/task/operation/
    object context, most recent first (query contract §3 WQ-09)."""
    problems: list[Problem] = []
    psrc = project.read_project(project_root)
    problems.extend(psrc.problems)
    esrc = execution.read_execution(project_root)
    problems.extend(esrc.problems)
    dsrc = delivery.read_delivery(project_root)
    problems.extend(dsrc.problems)
    rows: list[tuple[str, dict[str, Field]]] = []
    if psrc.data is not None:
        summary = execution.summarize(esrc.events, psrc.data)
        for gap in summary.reconciliation:
            rows.append(
                (
                    "",  # reconciliation gaps have no timestamp; sort last
                    {
                        "kind": Field.authoritative(gap.kind),
                        "entity_id": Field.authoritative(gap.entity_id),
                        "detail": Field.authoritative(gap.detail),
                        "occurred_at": Field.derived(None),
                    },
                )
            )
    for e in esrc.events:
        if (
            e.event_type.value == "validation_completed"
            and e.payload.get("passed") is False
        ):
            ts = e.occurred_at.isoformat()
            rows.append(
                (
                    ts,
                    {
                        "kind": Field.authoritative("validation_failed"),
                        "task_id": Field.authoritative(e.task_id),
                        "shot_id": Field.authoritative(e.shot_id),
                        "occurred_at": Field.authoritative(ts),
                    },
                )
            )
    # QC checks that did not pass (technical QC problems)
    if dsrc.technical_qc is not None:
        for check in dsrc.technical_qc.get("checks", []):
            if check.get("passed") is False:
                rows.append(
                    (
                        "",
                        {
                            "kind": Field.authoritative("qc_check_failed"),
                            "check_id": Field.authoritative(check.get("check_id")),
                            "detail": Field.authoritative(check.get("detail")),
                            "occurred_at": Field.derived(None),
                        },
                    )
                )
    rows.sort(key=lambda r: r[0], reverse=True)  # most recent first
    items = [row for _, row in rows]
    return _result("WQ-09", now, {"project_root": str(project_root)}, items, problems)


# --- WQ-10 rebuild-check (meta) -----------------------------------------------


def rebuild_check(
    service, project_root: Path, query_id: str, now: str, **params
) -> QueryResult:
    """Evaluate a query twice; the FULL envelope (items, scope, problems,
    markers) must be semantically equal and the process must write nothing.
    The file snapshot compares path, type, symlink status, and content
    digest, so a same-size overwrite is still detected (query contract §3
    WQ-10)."""
    runner = _rebuild_runner(service, project_root, query_id, params)
    problems: list[Problem] = []
    if runner is None:
        problems.append(
            Problem.of(
                ProblemCategory.NOT_FOUND,
                f"query {query_id!r} not supported for rebuild-check",
                query=query_id,
            )
        )
        return _result("WQ-10", now, {"target_query": query_id}, [], problems)
    # account-level queries (WQ-11/WQ-12) read across every project, so their
    # read-only snapshot must cover the whole account root, not one project.
    scope_root = project_root.parent if query_id in ("WQ-11", "WQ-12") else project_root
    before = _snapshot(scope_root)
    first = _comparable(runner())
    second = _comparable(runner())
    after = _snapshot(scope_root)
    equal = first == second
    read_only = before == after
    if not equal:
        problems.append(
            Problem.of(
                ProblemCategory.PROJECTION_CONFLICT,
                f"{query_id} not deterministic across two evaluations",
                readiness_failed=True,
                query=query_id,
            )
        )
    if not read_only:
        problems.append(
            Problem.of(
                ProblemCategory.PROJECTION_CONFLICT,
                "evaluation changed the project tree",
                readiness_failed=True,
            )
        )
    items = [
        {
            "target_query": Field.authoritative(query_id),
            "deterministic": Field.derived(equal),
            "read_only": Field.derived(read_only),
        }
    ]
    return _result("WQ-10", now, {"target_query": query_id}, items, problems)


def _rebuild_runner(service, project_root: Path, query_id: str, params: dict):
    runners = {
        "WQ-01": lambda: service.project_plan(project_root),
        "WQ-02": lambda: service.project_status(project_root),
        "WQ-03": lambda: service.lineage_upstream(project_root, params["ref"]),
        "WQ-04": lambda: service.lineage_downstream(project_root, params["ref"]),
        "WQ-05": lambda: service.prompt_history(project_root, params["prompt_id"]),
        "WQ-06": lambda: service.shot_attempts(project_root, params["shot"]),
        "WQ-07": lambda: service.cost_breakdown(project_root),
        "WQ-08": lambda: service.evaluation_decision(project_root),
        "WQ-09": lambda: service.recent_problems(project_root),
        "WQ-11": lambda: service.cross_project_index(),
        "WQ-12": lambda: service.reuse_usage(params["asset_id"], params["version"]),
        "WQ-13": lambda: service.approval_audit(project_root),
        "WQ-14": lambda: service.budget_standing(project_root),
        "WQ-15": lambda: service.evaluation_domain(project_root),
    }
    return runners.get(query_id)


def _snapshot(project_root: Path) -> tuple:
    from ai_video_workflow.digests import file_sha256

    out = []
    for p in sorted(project_root.rglob("*")):
        rel = str(p.relative_to(project_root))
        if p.is_symlink():
            out.append((rel, "symlink", str(p.readlink())))
        elif p.is_dir():
            out.append((rel, "dir", ""))
        elif p.is_file():
            out.append((rel, "file", file_sha256(p)))
        else:
            out.append((rel, "other", ""))
    return tuple(out)


def _comparable(result: QueryResult):
    """A normalized, order-stable view of the FULL envelope for equality."""
    items = tuple(
        tuple((k, (repr(f.value), f.provenance.value)) for k, f in sorted(item.items()))
        for item in result.items
    )
    problems = tuple(
        (p.category.value, p.detail, p.context, p.readiness_failed)
        for p in result.problems
    )
    return (
        result.query_id,
        result.contract_version,
        tuple(sorted(result.scope.items(), key=lambda kv: kv[0])),
        items,
        problems,
        tuple(sorted(result.markers)),
    )


# --- WQ-11 cross-project-index ------------------------------------------------


def cross_project_index(
    account_root: Path, now: str, *, offset: int = 0, limit: int | None = None
) -> QueryResult:
    projects = discover_projects(account_root)
    total = len(projects)
    window = projects[offset : (offset + limit) if limit is not None else None]
    items: list[dict[str, Field]] = []
    problems: list[Problem] = []
    for dp in window:
        psrc = project.read_project(dp.root)
        problems.extend(psrc.problems)  # keep per-project source problems
        title = psrc.profile.title if psrc.profile is not None else None
        profile_version = psrc.profile.version if psrc.profile is not None else None
        asrc = plan.read_approvals(dp.root)
        problems.extend(asrc.problems)  # keep approval-adapter problems
        current = "complete"
        for info in asrc.plan:
            st = next((s for s in asrc.states if s.stage_id == info.stage_id), None)
            if st is None or st.status != "approved" or st.stale:
                current = info.stage_id
                break
        cost: dict[str, int] = {}
        outstanding = 0
        if psrc.data is not None:
            esrc = execution.read_execution(dp.root)
            problems.extend(esrc.problems)  # keep QCD/reservation problems
            cost = dict(
                execution.summarize(esrc.events, psrc.data).per_project.cost_by_currency
            )
            outstanding = sum(
                r.estimate_jpy for r in esrc.reservations if r.is_outstanding
            )
        items.append(
            {
                "project": Field.authoritative(dp.name),
                "profile_version": (
                    Field.authoritative(profile_version)
                    if profile_version is not None
                    else Field.unavailable("no profile")
                ),
                "title": (
                    Field.authoritative(title)
                    if title is not None
                    else Field.unavailable("no profile")
                ),
                "current_stage": Field.derived(current),
                "cost_by_currency": Field.derived(cost),
                "outstanding_holds_jpy": Field.derived(outstanding),
            }
        )
    scope = {
        "account_root": str(account_root),
        "total": total,
        "offset": offset,
        "limit": limit,
        "returned": len(items),
    }
    return _result("WQ-11", now, scope, items, problems)


# --- WQ-12 reuse-asset-usage --------------------------------------------------


def reuse_usage(
    account_root: Path, asset_id: str, version: int, now: str
) -> QueryResult:
    """Which projects reference a reuse asset version, each verified against
    the authoritative account pack: a missing account version or a
    project-ref digest that no longer matches the pack fails readiness
    (query contract §3 WQ-12, requirements §3.1)."""
    from ai_video_workflow.profile.errors import ReuseError
    from ai_video_workflow.profile.reuse import load_pack_version

    problems: list[Problem] = []
    # the authoritative account pack for this asset version
    pack = None
    try:
        pack = load_pack_version(account_root, asset_id, version)
    except ReuseError:
        problems.append(
            Problem.of(
                ProblemCategory.VERSION_ABSENT,
                f"account reuse pack {asset_id!r} v{version} not found",
                readiness_failed=True,
                asset=asset_id,
                version=str(version),
            )
        )
    except Exception as exc:
        problems.append(
            Problem.of(
                ProblemCategory.SOURCE_CORRUPT,
                f"account reuse pack {asset_id!r} v{version}: {exc}",
                readiness_failed=True,
                asset=asset_id,
            )
        )
    pack_digest = pack.content_digest if pack is not None else None

    projects = discover_projects(account_root)
    items: list[dict[str, Field]] = []
    for dp in projects:
        psrc = project.read_project(dp.root)
        problems.extend(psrc.problems)
        for ref in psrc.reuse_refs:
            if ref.asset_id == asset_id and ref.version == version:
                # the project's locked digest must still match the pack
                if pack_digest is not None and ref.content_digest != pack_digest:
                    problems.append(
                        Problem.of(
                            ProblemCategory.DIGEST_MISMATCH,
                            f"project {dp.name!r} ref digest drifted from the "
                            f"account pack for {asset_id!r} v{version}",
                            readiness_failed=True,
                            project=dp.name,
                            asset=asset_id,
                        )
                    )
                items.append(
                    {
                        "project": Field.authoritative(dp.name),
                        "asset_id": Field.authoritative(ref.asset_id),
                        "version": Field.authoritative(ref.version),
                        "content_digest": Field.authoritative(ref.content_digest),
                        "matches_account_pack": Field.derived(
                            pack_digest is not None
                            and ref.content_digest == pack_digest
                        ),
                    }
                )
    return _result(
        "WQ-12",
        now,
        {"account_root": str(account_root), "asset_id": asset_id, "version": version},
        items,
        problems,
    )


# --- WQ-13 approval-audit -----------------------------------------------------


def approval_audit(project_root: Path, now: str) -> QueryResult:
    """Per-stage approval status with its locked targets (ref/version/digest),
    approver, time, and stale/invalidation reason, plus the append-only audit
    trail (query contract §3 WQ-13)."""
    from ai_video_workflow.approval.errors import NotApprovedError
    from ai_video_workflow.approval.gate import load_approval

    src = plan.read_approvals(project_root)
    problems: list[Problem] = list(src.problems)
    items: list[dict[str, Field]] = []
    for s in src.states:
        # the marker carries the locked targets + approver + time
        targets: list[dict] = []
        approved_at = None
        approved_by = None
        try:
            marker = load_approval(project_root, s.stage_id)
            approved_at = marker.approved_at
            approved_by = marker.approved_by
            targets = [
                {
                    "ref_kind": t.ref_kind,
                    "ref": t.ref,
                    "version": t.version,
                    "content_digest": t.content_digest,
                }
                for t in marker.approved_targets
            ]
        except NotApprovedError:
            pass  # no marker yet (unrun stage); status already reflects it
        except Exception as exc:
            # a present-but-unreadable marker is a real problem, not silence
            problems.append(
                Problem.of(
                    ProblemCategory.SOURCE_CORRUPT,
                    f"approval marker {s.stage_id!r} unreadable: {exc}",
                    stage=s.stage_id,
                )
            )
        reason = None
        if s.stale:
            reason = "approved target content changed after approval"
        elif s.blocked_by:
            reason = "blocked by: " + ", ".join(s.blocked_by)
        items.append(
            {
                "stage_id": Field.authoritative(s.stage_id),
                "status": Field.authoritative(s.status),
                "stale": Field.authoritative(bool(s.stale)),
                "approved_by": Field.authoritative(approved_by),
                "approved_at": Field.authoritative(approved_at),
                "approved_targets": Field.authoritative(targets),
                "blocked_by": Field.derived(list(s.blocked_by)),
                "reason": Field.derived(reason),
            }
        )
    audit_items = [{"audit_entry": Field.authoritative(entry)} for entry in src.audit]
    return _result(
        "WQ-13",
        now,
        {"project_root": str(project_root), "audit_entries": len(src.audit)},
        [*items, *audit_items],
        problems,
    )


# --- WQ-14 budget-standing ----------------------------------------------------


def budget_standing(project_root: Path, account_root: Path, now: str) -> QueryResult:
    """Episode and account/monthly budget standing: budgets (authoritative
    from config), episode committed by currency and outstanding holds, plus
    account monthly committed, cross-project outstanding holds, and derived
    remaining headroom (query contract §3 WQ-14, requirements §3.4)."""
    problems: list[Problem] = []
    psrc = project.read_project(project_root)
    problems.extend(psrc.problems)
    esrc = execution.read_execution(project_root)
    problems.extend(esrc.problems)

    committed_by_currency = None
    episode_committed_jpy = None
    episode_outstanding = None
    if psrc.config is not None and psrc.data is not None:
        summary = execution.summarize(esrc.events, psrc.data)
        committed_by_currency = dict(summary.per_project.cost_by_currency)
        episode_committed_jpy = execution.ledger(
            esrc.events, psrc.config.fx
        ).project_total_jpy
        episode_outstanding = sum(
            r.estimate_jpy for r in esrc.reservations if r.is_outstanding
        )

    budgets = None
    if psrc.config is not None:
        b = psrc.config.budgets_jpy
        budgets = {
            "episode_soft": b.episode_soft,
            "episode_hard": b.episode_hard,
            "monthly_hard": b.monthly_hard,
            "per_shot": b.per_shot,
        }

    # account-level monthly standing (cross-project) — actually uses account_root
    month_committed = None
    account_holds = None
    remaining_month = None
    if esrc.events:
        occurred = [e.occurred_at for e in esrc.events]
        month = execution.month_of(max(occurred))
        try:
            month_committed, account_holds = execution.account_standing(
                account_root, month
            )
        except Exception as exc:
            problems.append(
                Problem.of(
                    ProblemCategory.SOURCE_CORRUPT,
                    f"account standing unavailable: {exc}",
                    readiness_failed=False,
                )
            )
        if (
            month_committed is not None
            and account_holds is not None
            and budgets is not None
        ):
            remaining_month = budgets["monthly_hard"] - month_committed - account_holds

    items = [
        {
            "budgets_jpy": (
                Field.authoritative(budgets)
                if budgets is not None
                else Field.unavailable("no config")
            ),
            "episode_committed_by_currency": (
                Field.derived(committed_by_currency)
                if committed_by_currency is not None
                else Field.unavailable("no config/data")
            ),
            "episode_committed_jpy": (
                Field.derived(episode_committed_jpy)
                if episode_committed_jpy is not None
                else Field.unavailable("no config/data")
            ),
            "episode_outstanding_holds_jpy": (
                Field.derived(episode_outstanding)
                if episode_outstanding is not None
                else Field.unavailable("no config/data")
            ),
            "month_committed_jpy": (
                Field.derived(month_committed)
                if month_committed is not None
                else Field.unavailable("no events this month")
            ),
            "account_outstanding_holds_jpy": (
                Field.derived(account_holds)
                if account_holds is not None
                else Field.unavailable("no events this month")
            ),
            "monthly_remaining_jpy": (
                Field.derived(remaining_month)
                if remaining_month is not None
                else Field.unavailable("no config/events")
            ),
        }
    ]
    return _result(
        "WQ-14",
        now,
        {"project_root": str(project_root), "account_root": str(account_root)},
        items,
        problems,
    )

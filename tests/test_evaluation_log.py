"""Append-only evaluation-domain fact log tests (TASK-028 / ADR-0034).

Covers the record model (fixed payload key sets, value domains, deterministic
record_id, target version binding, actor), the envelope codec, and the
append-only log's write/read/dedup/torn-tail/immutability behaviour. No
provider, no network, no payment; a temp project root only.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ai_video_workflow.errors import (
    FieldTypeError,
    InvariantViolationError,
    MissingFieldError,
)
from ai_video_workflow.evaluation import (
    CorruptEvaluationLogError,
    EvaluationActor,
    EvaluationLogError,
    EvaluationRecordType,
    append_record,
    build_creative_decision_record,
    build_evaluation_record,
    build_experiment_record,
    log_path,
    read_records,
    record_from_envelope,
)

_AT = datetime(2026, 8, 3, 12, 0, 0, tzinfo=timezone.utc)
_DIGEST = "a" * 64
_DIGEST2 = "b" * 64


def _target(ref="shot-1", version=1, digest=_DIGEST):
    return {"ref": ref, "version": version, "content_digest": digest}


def _evaluation(evaluation_id="e-1", actor=EvaluationActor.USER, passed=True):
    return build_evaluation_record(
        project_id="proj-demo",
        actor=actor,
        target=_target(),
        goals_version=1,
        evaluation_id=evaluation_id,
        criterion="narrative clarity",
        score=4,
        tag="strong",
        passed=passed,
        rationale="reads clearly and matches the goals",
        occurred_at=_AT,
    )


def _experiment(experiment_id="x-1"):
    return build_experiment_record(
        project_id="proj-demo",
        actor=EvaluationActor.USER,
        target=_target(),
        goals_version=1,
        experiment_id=experiment_id,
        variants=[_target(version=1), _target(version=2, digest=_DIGEST2)],
        changed_factor="prompt wording",
        expected_improvement="tighter framing",
        actual_result="framing improved, motion unchanged",
        reuse_conclusion="keep v2 prompt",
        occurred_at=_AT,
    )


def _decision(decision_id="d-1", decision_type="select"):
    return build_creative_decision_record(
        project_id="proj-demo",
        actor=EvaluationActor.USER,
        target=_target(version=2, digest=_DIGEST2),
        goals_version=1,
        decision_id=decision_id,
        decision_type=decision_type,
        changed="switched to the v2 prompt",
        why="clearer framing without motion cost",
        expected="better composition",
        actual="confirmed on review",
        occurred_at=_AT,
    )


# --- record model + codec -----------------------------------------------------


def test_deterministic_record_id_and_roundtrip():
    for rec in (_evaluation(), _experiment(), _decision()):
        assert (
            rec.record_id
            == f"{rec.record_type.value}:proj-demo:{rec.record_id.split(':')[-1]}"
        )
        # envelope round-trips back to an equal record
        again = record_from_envelope(rec.to_envelope())
        assert again == rec


def test_target_binds_ref_version_digest():
    rec = _evaluation()
    assert rec.target == {"ref": "shot-1", "version": 1, "content_digest": _DIGEST}
    # a bad digest is rejected at construction
    with pytest.raises(InvariantViolationError):
        build_evaluation_record(
            project_id="proj-demo",
            actor=EvaluationActor.USER,
            target={"ref": "shot-1", "version": 1, "content_digest": "not-a-sha"},
            goals_version=1,
            evaluation_id="e-x",
            criterion="c",
            score=None,
            tag=None,
            passed=True,
            rationale="r",
            occurred_at=_AT,
        )
    # version must be a positive int
    with pytest.raises(InvariantViolationError):
        build_evaluation_record(
            project_id="proj-demo",
            actor=EvaluationActor.USER,
            target={"ref": "shot-1", "version": 0, "content_digest": _DIGEST},
            goals_version=1,
            evaluation_id="e-x",
            criterion="c",
            score=None,
            tag=None,
            passed=True,
            rationale="r",
            occurred_at=_AT,
        )


def test_experiment_requires_at_least_two_variants():
    with pytest.raises(InvariantViolationError):
        build_experiment_record(
            project_id="proj-demo",
            actor=EvaluationActor.USER,
            target=_target(),
            goals_version=1,
            experiment_id="x-bad",
            variants=[_target()],
            changed_factor="f",
            expected_improvement="e",
            actual_result=None,
            reuse_conclusion=None,
            occurred_at=_AT,
        )


def test_decision_type_domain_enforced():
    with pytest.raises(InvariantViolationError):
        _decision(decision_id="d-bad", decision_type="approve")  # not a decision type


def test_actor_and_goals_version_recorded():
    rec = _evaluation(actor=EvaluationActor.AI)
    env = rec.to_envelope()
    assert env["actor"] == "ai"
    assert env["goals_version"] == 1
    # goals_version must be a positive int
    with pytest.raises(InvariantViolationError):
        build_evaluation_record(
            project_id="proj-demo",
            actor=EvaluationActor.USER,
            target=_target(),
            goals_version=0,
            evaluation_id="e-x",
            criterion="c",
            score=None,
            tag=None,
            passed=True,
            rationale="r",
            occurred_at=_AT,
        )


def test_envelope_decode_rejects_unknown_type_and_bad_keys():
    env = _evaluation().to_envelope()
    env["record_type"] = "approval"  # not an evaluation-domain type
    with pytest.raises(InvariantViolationError):
        record_from_envelope(env)
    env2 = _evaluation().to_envelope()
    del env2["target"]
    with pytest.raises(InvariantViolationError):
        record_from_envelope(env2)


def test_envelope_decode_rejects_tampered_payload_keys():
    env = _evaluation().to_envelope()
    env["payload"] = dict(env["payload"])
    del env["payload"]["rationale"]
    with pytest.raises((MissingFieldError, InvariantViolationError)):
        record_from_envelope(env)


def test_clock_not_read_requires_tz_aware_utc():
    with pytest.raises((FieldTypeError, InvariantViolationError)):
        build_evaluation_record(
            project_id="proj-demo",
            actor=EvaluationActor.USER,
            target=_target(),
            goals_version=1,
            evaluation_id="e-x",
            criterion="c",
            score=None,
            tag=None,
            passed=True,
            rationale="r",
            occurred_at=datetime(2026, 8, 3, 12, 0, 0),  # naive
        )


def test_record_decoupled_from_caller_mutation(tmp_path: Path):
    """A caller mutating the dicts it passed cannot alter the validated fact."""
    target = _target()
    variants = [_target(version=1), _target(version=2, digest=_DIGEST2)]
    rec = build_experiment_record(
        project_id="proj-demo",
        actor=EvaluationActor.USER,
        target=target,
        goals_version=1,
        experiment_id="x-1",
        variants=variants,
        changed_factor="f",
        expected_improvement="e",
        actual_result=None,
        reuse_conclusion=None,
        occurred_at=_AT,
    )
    # mutate the caller-held structures after construction
    target["ref"] = "hacked"
    variants[0]["ref"] = "hacked"
    # the record kept its own deep copy — the persisted fact is unchanged
    assert rec.target["ref"] == "shot-1"
    assert rec.payload["variants"][0]["ref"] == "shot-1"
    # and the record's own mappings are read-only, recursively (nested too)
    with pytest.raises(TypeError):
        rec.payload["variants"] = []
    with pytest.raises(TypeError):
        rec.payload["variants"][0]["ref"] = "x"
    append_record(tmp_path, rec)
    assert read_records(tmp_path)[0].payload["variants"][0]["ref"] == "shot-1"


def test_schema_version_bool_is_rejected(tmp_path: Path):
    """A boolean schema_version must not pass as v1 (True == 1)."""
    env = _evaluation("e-1").to_envelope()
    env["schema_version"] = True
    with pytest.raises(InvariantViolationError):
        record_from_envelope(env)


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="os.mkfifo does not exist on Windows; the S_ISREG guard still "
    "refuses non-regular files, but a FIFO cannot be created to test it",
)
def test_append_and_read_refuse_a_fifo_log(tmp_path: Path):
    """A FIFO at the log path is refused both ways (no data leak, no DoS)."""
    import os

    events_dir = tmp_path / "evaluation" / "events"
    events_dir.mkdir(parents=True, exist_ok=True)
    os.mkfifo(events_dir / "log.jsonl")
    with pytest.raises(EvaluationLogError):
        append_record(tmp_path, _evaluation("e-1"))
    with pytest.raises(EvaluationLogError):
        read_records(tmp_path)  # O_NONBLOCK -> refuses instead of blocking


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="the st_nlink hard-link guard is POSIX-only; the Windows opener "
    "drops it (unreliable there) with a documented reduced guarantee — ADR-0049",
)
def test_append_and_read_refuse_hard_linked_log(tmp_path: Path):
    """A log hard-linked to an out-of-root file is refused (nlink != 1)."""
    import os

    events_dir = tmp_path / "evaluation" / "events"
    events_dir.mkdir(parents=True, exist_ok=True)
    outside = tmp_path.parent / "outside-hardlink.jsonl"
    outside.write_text("", encoding="utf-8")
    os.link(outside, events_dir / "log.jsonl")  # hard link, same inode
    with pytest.raises(EvaluationLogError):
        append_record(tmp_path, _evaluation("e-1"))
    with pytest.raises(EvaluationLogError):
        read_records(tmp_path)
    assert outside.read_text(encoding="utf-8") == ""  # untouched


def test_read_refuses_symlinked_log(tmp_path: Path):
    """The read path refuses a symlinked log component (read-side TOCTOU)."""
    from ai_video_workflow.errors import AiVideoWorkflowError

    events_dir = tmp_path / "evaluation" / "events"
    events_dir.mkdir(parents=True, exist_ok=True)
    outside = tmp_path.parent / "outside-read.jsonl"
    outside.write_text('{"leaked": true}\n', encoding="utf-8")
    (events_dir / "log.jsonl").symlink_to(outside)
    with pytest.raises(AiVideoWorkflowError):
        read_records(tmp_path)


# --- append-only log ----------------------------------------------------------


def test_append_and_read_all_types_in_order(tmp_path: Path):
    append_record(tmp_path, _evaluation("e-1"))
    append_record(tmp_path, _experiment("x-1"))
    append_record(tmp_path, _decision("d-1"))
    records = read_records(tmp_path)
    assert [r.record_type for r in records] == [
        EvaluationRecordType.EVALUATION,
        EvaluationRecordType.EXPERIMENT,
        EvaluationRecordType.CREATIVE_DECISION,
    ]
    assert [r.record_id for r in records] == [
        "evaluation:proj-demo:e-1",
        "experiment:proj-demo:x-1",
        "creative_decision:proj-demo:d-1",
    ]


def test_missing_log_reads_empty(tmp_path: Path):
    assert read_records(tmp_path) == ()


def test_duplicate_record_id_deduped_first_wins(tmp_path: Path):
    append_record(tmp_path, _evaluation("e-1", passed=True))
    # a replayed line with the same record_id: reader keeps the first
    append_record(tmp_path, _evaluation("e-1", passed=False))
    records = read_records(tmp_path)
    assert len(records) == 1
    assert records[0].payload["pass"] is True


def test_append_only_never_rewrites_history(tmp_path: Path):
    append_record(tmp_path, _evaluation("e-1"))
    first = log_path(tmp_path).read_bytes()
    append_record(tmp_path, _decision("d-1"))
    grown = log_path(tmp_path).read_bytes()
    # the original bytes are a strict prefix — old facts are never rewritten
    assert grown.startswith(first)
    assert len(grown) > len(first)


def test_torn_final_line_blocks_further_appends(tmp_path: Path):
    append_record(tmp_path, _evaluation("e-1"))
    path = log_path(tmp_path)
    with path.open("ab") as stream:
        stream.write(b'{"partial": true')  # a torn fragment, no newline
    with pytest.raises(CorruptEvaluationLogError):
        append_record(tmp_path, _decision("d-1"))
    # but the reader tolerates exactly the one torn tail and returns the good line
    records = read_records(tmp_path)
    assert [r.record_id for r in records] == ["evaluation:proj-demo:e-1"]


def test_corrupt_middle_line_raises_with_line_number(tmp_path: Path):
    append_record(tmp_path, _evaluation("e-1"))
    append_record(tmp_path, _decision("d-1"))
    path = log_path(tmp_path)
    lines = path.read_bytes().split(b"\n")
    lines[0] = b'{"not": "an envelope"}'  # corrupt the first complete line
    path.write_bytes(b"\n".join(lines))
    with pytest.raises(CorruptEvaluationLogError) as exc:
        read_records(tmp_path)
    assert "line 1" in str(exc.value)


def test_log_path_is_under_project_root(tmp_path: Path):
    assert log_path(tmp_path) == (tmp_path / "evaluation" / "events" / "log.jsonl")


def test_reader_reports_unhashable_record_type_as_corrupt(tmp_path: Path):
    """A malformed line whose record_type is unhashable fails closed, not crash."""
    path = log_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    env = _evaluation("e-1").to_envelope()
    env["record_type"] = []  # unhashable -> Enum lookup would raise TypeError
    import json

    path.write_bytes((json.dumps(env) + "\n").encode("utf-8"))
    with pytest.raises(CorruptEvaluationLogError):
        read_records(tmp_path)


def test_reader_reports_unhashable_decision_type_as_corrupt(tmp_path: Path):
    """An unhashable decision_type fails closed (no TypeError from set lookup)."""
    path = log_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    env = _decision("d-1").to_envelope()
    env["payload"] = dict(env["payload"])
    env["payload"]["decision_type"] = ["select"]  # unhashable
    import json

    path.write_bytes((json.dumps(env) + "\n").encode("utf-8"))
    with pytest.raises(CorruptEvaluationLogError):
        read_records(tmp_path)


def test_open_append_contained_refuses_symlinked_intermediate_dir(tmp_path: Path):
    """The dir-fd walk refuses a symlinked intermediate component (post-resolve
    TOCTOU): no directory or file is created outside the root through it."""
    import ai_video_workflow.evaluation.log as log_mod

    # 'evaluation' is a symlink to a would-be outside location
    (tmp_path / "evaluation").symlink_to(tmp_path.parent / "outside-eval")
    with pytest.raises(EvaluationLogError):
        log_mod._open_append_contained(tmp_path, ("evaluation", "events", "log.jsonl"))
    assert not (tmp_path.parent / "outside-eval").exists()


def test_append_refuses_symlinked_log_file(tmp_path: Path):
    """A pre-existing symlink at the log path is refused, nothing written out.

    First line of defence: resolve_within_root (ADR-0004) refuses a symlinked
    component at resolve time; O_NOFOLLOW + the fd re-check guard the residual
    TOCTOU window. A symlinked ``log.jsonl`` must never be written through.
    """
    from ai_video_workflow.errors import AiVideoWorkflowError

    events_dir = tmp_path / "evaluation" / "events"
    events_dir.mkdir(parents=True, exist_ok=True)
    outside = tmp_path.parent / "evade.jsonl"
    (events_dir / "log.jsonl").symlink_to(outside)
    with pytest.raises(AiVideoWorkflowError):
        append_record(tmp_path, _evaluation("e-1"))
    assert not outside.exists()  # nothing created/written through the symlink

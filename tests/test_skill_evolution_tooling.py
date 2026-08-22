"""skill-evolution 确定性 CLI 的行为合同（TASK-100 / ADR-0078）。

覆盖需求原文第 41 节的可脚本化场景：A（正常成功只留极短记录）、B/C（同 key
1 → 3 次触发复审）、D（severe 单次触发）、E（compact 后正常路径不加载
archive）、F（protect 落 index）、H（懒注册）、I（Full Sync 纳管未使用
Skill）、J（missing 保留历史）、K（rename 迁移不造两份历史）。
G（防膨胀）与 Proposal 批准边界是语义规则，住在 SKILL.md/references，
不在脚本层。
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / ".claude"
    / "skills"
    / "skill-evolution"
    / "scripts"
    / "evolution.py"
)
_SPEC = importlib.util.spec_from_file_location("skill_evolution_cli", _MODULE_PATH)
evo = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(evo)


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    for name in ("alpha", "beta"):
        skill = tmp_path / ".claude" / "skills" / name
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(f"---\nname: {name}\n---\nrules\n", "utf-8")
    return tmp_path


def _record(root: Path, skill: str, **overrides) -> dict:
    fields = {
        "category": "FRICTION",
        "severity": "medium",
        "key": "excessive-user-escalation",
        "note": "工程决定也回来问用户",
        "task": "TASK-100",
    }
    fields.update(overrides)
    return evo.record(root, skill, **fields)


def test_record_lazily_registers_an_unknown_skill(repo: Path) -> None:
    assert evo.status(repo, "alpha") == {"registered": False, "skill": "alpha"}
    result = _record(repo, "alpha")
    assert result["recorded"] and result["auto_registered"]
    assert result["id"] == "fb-alpha-0001"
    status = evo.status(repo, "alpha")
    assert status["registered"]
    assert status["entry"]["path"] == ".claude/skills/alpha"
    assert status["entry"]["revision"]
    assert (repo / "docs" / "skill-evolution" / "backlogs" / "alpha.jsonl").is_file()


def test_registration_does_not_touch_other_skills(repo: Path) -> None:
    _record(repo, "alpha")
    index = evo.load_index(repo)
    assert set(index["skills"]) == {"alpha"}


def test_positive_signal_never_becomes_a_review_reason(repo: Path) -> None:
    for _ in range(3):
        result = _record(
            repo,
            "alpha",
            category="POSITIVE_SIGNAL",
            severity="low",
            key="routing-first-works",
            note="路由先行有效",
        )
    assert not result["review_due"]
    assert evo.status(repo, "alpha")["entry"]["status"] == "OBSERVING"


def test_first_friction_only_observes(repo: Path) -> None:
    result = _record(repo, "alpha")
    assert result["recurrence_count"] == 1
    assert not result["review_due"]
    assert evo.status(repo, "alpha")["entry"]["status"] == "OBSERVING"


def test_third_repeat_of_one_key_is_review_due(repo: Path) -> None:
    _record(repo, "alpha")
    _record(repo, "alpha", note="又问了一次")
    result = _record(repo, "alpha", note="第三次")
    assert result["recurrence_count"] == 3
    assert result["review_due"]
    assert "excessive-user-escalation x3" in result["review_reasons"][0]
    assert evo.status(repo, "alpha")["entry"]["status"] == "REVIEW_CANDIDATE"


def test_a_single_severe_defect_is_review_due(repo: Path) -> None:
    result = _record(
        repo,
        "alpha",
        category="INCORRECT_BEHAVIOR",
        severity="severe",
        key="wrong-core-workflow",
        note="核心 workflow 指了相反的顺序",
    )
    assert result["review_due"]
    assert evo.status(repo, "alpha")["entry"]["severe_open"] == 1


def test_review_context_returns_only_the_target_problem(repo: Path) -> None:
    _record(repo, "alpha")
    _record(repo, "alpha", key="unrelated-noise", note="别的问题")
    _record(repo, "alpha", severity="severe", key="broken-trigger", note="严重")
    context = evo.review_context(repo, "alpha", key="excessive-user-escalation")
    keys = {entry["key"] for entry in context["entries"]}
    assert keys == {"excessive-user-escalation", "broken-trigger"}
    assert evo.status(repo, "alpha")["entry"]["last_review_at"]


def test_set_status_by_key_records_the_proposal(repo: Path) -> None:
    for _ in range(3):
        _record(repo, "alpha")
    result = evo.set_status(
        repo, "alpha", "PROPOSED", key="excessive-user-escalation", proposal="EP-001"
    )
    assert result["updated"] == 3
    entry = evo.status(repo, "alpha")["entry"]
    assert entry["pending_proposals"] == ["EP-001"]
    assert entry["status"] == "PROPOSAL_PENDING"
    evo.set_status(repo, "alpha", "RESOLVED", key="excessive-user-escalation")
    assert evo.status(repo, "alpha")["entry"]["status"] == "HEALTHY"


def test_protect_stores_a_protected_behavior(repo: Path) -> None:
    _record(repo, "alpha")
    result = evo.protect(repo, "alpha", "routing-first-works", "多次验证有效")
    assert result["protected"]
    protected = evo.status(repo, "alpha")["entry"]["protected"]
    assert protected[0]["key"] == "routing-first-works"


def test_compact_archives_terminal_entries_and_keeps_ids_monotonic(
    repo: Path,
) -> None:
    for _ in range(3):
        _record(repo, "alpha")
    evo.set_status(repo, "alpha", "RESOLVED", key="excessive-user-escalation")
    result = evo.compact(repo, "alpha")
    assert result == {"compacted": 3, "remaining_open": 0}
    assert evo.read_backlog(repo, "alpha") == []
    archived = (
        (repo / "docs" / "skill-evolution" / "archive" / "alpha.jsonl")
        .read_text("utf-8")
        .splitlines()
    )
    assert len(archived) == 3
    assert _record(repo, "alpha")["id"] == "fb-alpha-0004"


def test_sync_registers_a_never_used_skill(repo: Path) -> None:
    _record(repo, "alpha")
    result = evo.sync(repo)
    assert result["registered_new"] == ["beta"]
    assert result["missing"] == [] and result["renamed"] == []
    assert evo.status(repo, "beta")["entry"]["status"] == "REGISTERED"


def test_sync_marks_a_removed_skill_missing_and_keeps_history(repo: Path) -> None:
    _record(repo, "beta")
    skill_md = repo / ".claude" / "skills" / "beta" / "SKILL.md"
    skill_md.unlink()
    skill_md.parent.rmdir()
    result = evo.sync(repo)
    assert result["missing"] == ["beta"]
    entry = evo.load_index(repo)["skills"]["beta"]
    assert entry["status"] == "MISSING" and entry["missing_since"]
    assert len(evo.read_backlog(repo, "beta")) == 1


def test_sync_migrates_a_renamed_skill_instead_of_duplicating_it(repo: Path) -> None:
    _record(repo, "beta")
    old_dir = repo / ".claude" / "skills" / "beta"
    old_dir.rename(repo / ".claude" / "skills" / "beta-renamed")
    result = evo.sync(repo)
    assert result["renamed"] == [{"from": "beta", "to": "beta-renamed"}]
    # alpha 是首次被 sync 纳管的未使用 Skill；关键是 beta 没有变成第二份历史。
    assert result["registered_new"] == ["alpha"] and result["missing"] == []
    index = evo.load_index(repo)
    assert "beta" not in index["skills"]
    entry = index["skills"]["beta-renamed"]
    assert entry["previous_names"] == ["beta"]
    assert len(evo.read_backlog(repo, "beta-renamed")) == 1
    assert not (repo / "docs" / "skill-evolution" / "backlogs" / "beta.jsonl").exists()


def test_missing_status_clears_when_the_skill_returns(repo: Path) -> None:
    _record(repo, "beta")
    skill_dir = repo / ".claude" / "skills" / "beta"
    hidden = repo / "beta-parked"
    skill_dir.rename(hidden)
    evo.sync(repo)
    # 换过内容再回来：digest 不同，走的是「路径复活」而不是 rename 匹配。
    hidden.rename(skill_dir)
    (skill_dir / "SKILL.md").write_text("---\nname: beta\n---\nnew rules\n", "utf-8")
    evo.sync(repo)
    entry = evo.load_index(repo)["skills"]["beta"]
    assert entry["status"] != "MISSING" and "missing_since" not in entry


def test_cli_round_trip_emits_compact_json(repo: Path, capsys) -> None:
    code = evo.main(
        [
            "--root",
            str(repo),
            "record",
            "alpha",
            "--category",
            "FRICTION",
            "--severity",
            "low",
            "--key",
            "k1",
            "--note",
            "n",
        ]
    )
    payload = json.loads(capsys.readouterr().out)
    assert code == 0 and payload["recorded"]
    assert evo.main(["--root", str(repo), "status", "alpha"]) == 0


def test_unknown_skill_record_fails_closed(repo: Path) -> None:
    result = _record(repo, "no-such-skill")
    assert result == {
        "recorded": False,
        "error": "no SKILL.md found for 'no-such-skill'",
    }


def test_path_traversal_skill_names_are_rejected(repo: Path) -> None:
    # skill 名会嵌进可写路径；`../` 形状必须在任何文件操作之前被拒。
    evil = repo / "escape"
    evil.mkdir()
    (evil / "SKILL.md").write_text("---\nname: escape\n---\n", "utf-8")
    for name in ("../../escape", "..", "a/b", "a\\b", ".hidden", "", "alpha\n"):
        assert evo.record(repo, name, "FRICTION", "low", "k", "n") == {
            "recorded": False,
            "error": f"invalid skill name '{name}'",
        }
        assert not evo.register(repo, name)["registered"]
        # 每个带可写路径的入口都拒绝（整类关死，不依赖 index 门的传递保护）。
        assert "error" in evo.status(repo, name)
        assert "error" in evo.set_status(repo, name, "RESOLVED", key="k")
        assert "error" in evo.protect(repo, name, "k", "n")
        assert "error" in evo.review_context(repo, name)
        assert "error" in evo.compact(repo, name)
    assert not (repo / "docs" / "skill-evolution" / "backlogs" / "..").exists()


def test_a_pending_proposal_stops_counting_as_review_evidence(repo: Path) -> None:
    for _ in range(3):
        _record(repo, "alpha")
    assert evo.status(repo, "alpha")["review_due"]
    evo.set_status(
        repo, "alpha", "PROPOSED", key="excessive-user-escalation", proposal="EP-001"
    )
    status = evo.status(repo, "alpha")
    assert not status["review_due"]
    assert status["entry"]["status"] == "PROPOSAL_PENDING"
    # 提案挂起期间又来一条同类反馈：计 1，不再立即触发重复复审。
    result = _record(repo, "alpha", note="提案期间又发生")
    assert result["recurrence_count"] == 1 and not result["review_due"]


def test_status_refreshes_the_revision_after_a_skill_md_edit(repo: Path) -> None:
    _record(repo, "alpha")
    before = evo.status(repo, "alpha")["entry"]["revision"]
    skill_md = repo / ".claude" / "skills" / "alpha" / "SKILL.md"
    skill_md.write_text("---\nname: alpha\n---\nnew rules\n", "utf-8")
    after = evo.status(repo, "alpha")["entry"]["revision"]
    assert after != before
    assert evo.load_index(repo)["skills"]["alpha"]["revision"] == after


def test_compact_retry_does_not_duplicate_archived_entries(repo: Path) -> None:
    _record(repo, "alpha")
    evo.set_status(repo, "alpha", "RESOLVED", key="excessive-user-escalation")
    # 模拟「追加进 archive 后、backlog 重写前」中断：手工把同一条塞回 backlog。
    evo.compact(repo, "alpha")
    archive = repo / "docs" / "skill-evolution" / "archive" / "alpha.jsonl"
    line = archive.read_text("utf-8").splitlines()[0]
    backlog = repo / "docs" / "skill-evolution" / "backlogs" / "alpha.jsonl"
    backlog.write_text(line + "\n", "utf-8")
    evo.compact(repo, "alpha")
    assert len(archive.read_text("utf-8").splitlines()) == 1

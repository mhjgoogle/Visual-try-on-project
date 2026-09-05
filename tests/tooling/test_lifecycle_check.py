"""生命周期收敛守卫（ADR-0087 决策 7）必须**真的拦住**它声称要拦的东西。

本仓库反复吃过同一族亏：「守卫看起来加了，其实没接上」——注释把危害说得很准，
构造却造不出那个危害，于是测试永远绿（复审历史里三条真缺陷都是这个形状）。
所以每一条检查这里都写两个方向：**干净的树必须绿、被破坏的树必须红**。

真实仓库那一条（`test_the_real_repository_converges`）是把守卫接到现实上的那根线：
它一红，就说明某个改动把仓库带离了 ADR-0087 的形状。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_TOOL = _ROOT / ".claude" / "tools" / "lifecycle_check.py"


def _load():
    spec = importlib.util.spec_from_file_location("lifecycle_check", _TOOL)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def lc(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """守卫指向一棵**最小合规**的假仓库；每个用例只破坏自己那一处。"""
    mod = _load()
    docs = tmp_path / "docs"
    (docs / "tasks" / "active").mkdir(parents=True)
    (docs / "tasks" / "done").mkdir(parents=True)
    (docs / "tasks" / "backlog").mkdir(parents=True)
    (docs / "adr").mkdir()
    (docs / "requirements").mkdir()
    (docs / "requirements" / "index.md").write_text(
        "- [REQ-001](REQ-001-x.md) — CONFIRMED — x\n", "utf-8"
    )
    (docs / "requirements" / "REQ-001-x.md").write_text(
        "# REQ-001：x\n\n- 状态：CONFIRMED\n", "utf-8"
    )
    (docs / "tasks" / "active" / "TASK-001-x.md").write_text(
        "# TASK-001：x\n\n- 状态：进行中\n- 关联 Requirement：REQ-001\n", "utf-8"
    )
    (docs / "current-architecture.md").write_text("# 当前架构合同\n\n一行。\n", "utf-8")
    # 两份索引（ADR-0098）。指针指向假仓库里真实存在的那份文件 —— 断指针本身是
    # 被守的危害之一，基线不能自己先踩上去。
    (docs / "glossary.md").write_text(
        "# 术语表\n\n### 某词\n一句话指称。\n"
        "_Avoid_：别名甲 · 别名乙\n"
        "_权威_：[当前架构合同](current-architecture.md)\n",
        "utf-8",
    )
    (docs / "out-of-scope.md").write_text(
        "# 范围外记录\n\n| 不做什么 | 正式裁决 | 重访条件 |\n| --- | --- | --- |\n"
        "| 某事 | [当前架构合同](current-architecture.md) | 不重访 |\n",
        "utf-8",
    )
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    monkeypatch.setattr(mod, "DOCS", docs)
    monkeypatch.setattr(mod, "_CURRENT_ARCH", docs / "current-architecture.md")
    monkeypatch.setattr(mod, "_GLOSSARY", docs / "glossary.md")
    monkeypatch.setattr(mod, "_OUT_OF_SCOPE", docs / "out-of-scope.md")
    return mod


def _all(mod) -> list[str]:
    return [item for items in mod.run().values() for item in items]


def test_a_clean_tree_reports_nothing(lc) -> None:
    """基线。没有这一条，下面每个「变红」都可能是别处漏出来的噪声。"""
    assert _all(lc) == []


# --- 1. 做完却留在 active/ ----------------------------------------------------


def test_a_finished_card_left_in_active_turns_red(lc) -> None:
    (lc.DOCS / "tasks" / "active" / "TASK-002-y.md").write_text(
        "# TASK-002：y\n\n- 状态：完成（2026-08-26）\n", "utf-8"
    )
    assert any("TASK-002" in f for f in lc.check_no_finished_card_in_active())


def test_partially_done_stays_green(lc) -> None:
    """「部分完成」也是在办 —— 误杀它会把人赶去关掉守卫（ADR-0083）。"""
    (lc.DOCS / "tasks" / "active" / "TASK-003-z.md").write_text(
        "# TASK-003：z\n\n- 状态：部分完成（还有 §3 没做）\n", "utf-8"
    )
    assert lc.check_no_finished_card_in_active() == []


# --- 2. ADR 取代关系必须双向 ---------------------------------------------------


def _adr(lc, num: str, body: str) -> None:
    (lc.DOCS / "adr" / f"ADR-{num}-x.md").write_text(body, "utf-8")


def test_one_sided_supersede_turns_red(lc) -> None:
    """这正是 2026-08-26 在真仓库里查到的形状：旧 ADR 被取代四天，自己一字不提。"""
    _adr(lc, "0060", "# ADR-0060\n\n- 状态：Superseded by ADR-0080\n")
    _adr(lc, "0080", "# ADR-0080\n\n- 状态：Accepted\n")
    findings = lc.check_adr_supersede_links_are_bidirectional()
    assert findings and "ADR-0060" in findings[0]


def test_bidirectional_supersede_stays_green(lc) -> None:
    _adr(lc, "0060", "# ADR-0060\n\n- 状态：Superseded by ADR-0080\n")
    _adr(lc, "0080", "# ADR-0080\n\n- 取代：ADR-0060\n- 状态：Accepted\n")
    assert lc.check_adr_supersede_links_are_bidirectional() == []


def test_supersede_pointing_at_a_missing_adr_turns_red(lc) -> None:
    _adr(lc, "0060", "# ADR-0060\n\n- 状态：Superseded by ADR-0099\n")
    assert lc.check_adr_supersede_links_are_bidirectional()


def test_a_bare_mention_on_the_other_side_is_not_a_declaration(lc) -> None:
    """codex 轮 1 的 P1：反向只要**提到**这条 ADR 就算数的话，一段讨论历史的
    背景文字就能让单向关系过关 —— 而「讨论历史时引用旧 ADR」恰恰是最常见的提及
    方式。反向必须**自己也声明**。"""
    _adr(lc, "0060", "# ADR-0060\n\n- 状态：Superseded by ADR-0080\n")
    _adr(
        lc,
        "0080",
        "# ADR-0080\n\n- 状态：Accepted\n\n## 背景\n\nADR-0060 当时是这么定的。\n",
    )
    findings = lc.check_adr_supersede_links_are_bidirectional()
    assert findings and "ADR-0060" in findings[0]


def test_a_declaration_wrapped_across_lines_is_still_read(lc) -> None:
    """codex 轮 1 的 non-blocking：逐行读会让守卫取决于**谁在哪按了回车** ——
    换行的声明照样是声明，两侧都是。"""
    _adr(
        lc,
        "0060",
        "# ADR-0060\n\n- 状态：**Superseded**（2026-08-22）—— 由\n"
        "  [ADR-0080](ADR-0080-x.md) 取代\n",
    )
    _adr(
        lc,
        "0080",
        "# ADR-0080\n\n- **取代**：\n  [ADR-0060](ADR-0060-x.md) 的分档语义\n"
        "- 状态：Accepted\n",
    )
    assert lc.check_adr_supersede_links_are_bidirectional() == []


def test_prose_without_a_field_label_is_not_a_claim(lc) -> None:
    """ADR-0006 的真实形状：`Historical implementation note: TASK-010 后由
    TASK-016/017 取代；…由 ADR-0008/0009 延续` —— 关键词与 ADR 号同段共现，
    但被取代的是 TASK 不是 ADR。只有**带字段标签**的头部条目才算声明。"""
    _adr(
        lc,
        "0006",
        "# ADR-0006\n\n- 状态：Accepted\n"
        "- Historical implementation note: TASK-010 后由 TASK-016/017 取代；"
        "本 ADR 的付费边界由 ADR-0008 延续\n",
    )
    _adr(lc, "0008", "# ADR-0008\n\n- 状态：Accepted\n")
    assert lc.check_adr_supersede_links_are_bidirectional() == []


def test_a_no_decisions_superseded_note_is_not_a_claim(lc) -> None:
    """ADR-0051 的真实形状：「**无决策被取代。** 与 ADR-0066 的唯一交集是呈现位置」
    —— 一条**否定**句。误判它会让守卫去要求一个根本不存在的取代关系。"""
    _adr(
        lc,
        "0051",
        "# ADR-0051\n\n- 状态：Accepted\n\n"
        "**无决策被取代。** 与\n[ADR-0066](x.md)\n的交集只是呈现位置。\n",
    )
    _adr(lc, "0066", "# ADR-0066\n\n- 状态：Accepted\n")
    assert lc.check_adr_supersede_links_are_bidirectional() == []


def test_a_body_mention_is_not_a_claim(lc) -> None:
    """只有**头部**的声明才是取代关系；正文里提一句「取代」不该触发要求 ——
    否则守卫会对讨论历史的段落乱喊，而那正是让人关掉它的原因。"""
    _adr(
        lc,
        "0060",
        "# ADR-0060\n\n- 状态：Accepted\n\n## 背景\n\n它取代了 ADR-0080 的说法。\n",
    )
    _adr(lc, "0080", "# ADR-0080\n\n- 状态：Accepted\n")
    assert lc.check_adr_supersede_links_are_bidirectional() == []


def test_two_adrs_both_claiming_to_supersede_the_other_turn_red(lc) -> None:
    """codex 轮 2 的 P1：只查「双方都说了」的话，两份都写 `取代：对方` 也算通过 ——
    守卫会给一段自相矛盾的历史盖章。"""
    _adr(lc, "0060", "# ADR-0060\n\n- 取代：[ADR-0080](x.md)\n")
    _adr(lc, "0080", "# ADR-0080\n\n- 取代：[ADR-0060](x.md)\n")
    findings = lc.check_adr_supersede_links_are_bidirectional()
    assert findings and "方向矛盾" in findings[0]


def test_an_ambiguous_status_line_is_accepted_opposite_either_direction(lc) -> None:
    """`状态：…被 X 取代` 按句子可以两读，所以它不参与方向判定 —— 否则本仓库
    大量既有写法会被误杀，而误杀是让人关掉守卫的那条路。"""
    _adr(
        lc, "0060", "# ADR-0060\n\n- 状态：**Superseded** —— 由 [ADR-0080](x.md) 取代\n"
    )
    _adr(lc, "0080", "# ADR-0080\n\n- **取代**：[ADR-0060](x.md) 的分档语义\n")
    assert lc.check_adr_supersede_links_are_bidirectional() == []


# --- 3. REQ 索引与文件一致 -----------------------------------------------------


def test_req_missing_from_index_turns_red(lc) -> None:
    (lc.DOCS / "requirements" / "REQ-002-y.md").write_text(
        "# REQ-002：y\n\n- 状态：CONFIRMED\n", "utf-8"
    )
    assert any("REQ-002" in f for f in lc.check_requirement_index_matches_files())


def test_index_status_disagreeing_with_the_file_turns_red(lc) -> None:
    (lc.DOCS / "requirements" / "REQ-001-x.md").write_text(
        "# REQ-001：x\n\n- 状态：SUPERSEDED —— 被 REQ-002 取代\n", "utf-8"
    )
    findings = lc.check_requirement_index_matches_files()
    assert findings and "REQ-001" in findings[0]


def test_an_index_row_linking_to_another_existing_req_turns_red(lc) -> None:
    """codex 轮 1 的 P1：只比对 ID 的话，一条链到**别的** REQ 的行照样过 ——
    而索引行正是 Agent 走到需求的路，链错了它会读到另一份需求，
    表面上一切还是自洽的。"""
    (lc.DOCS / "requirements" / "REQ-002-y.md").write_text(
        "# REQ-002：y\n\n- 状态：CONFIRMED\n", "utf-8"
    )
    (lc.DOCS / "requirements" / "index.md").write_text(
        "- [REQ-001](REQ-001-x.md) — CONFIRMED — x\n"
        "- [REQ-002](REQ-001-x.md) — CONFIRMED — 链错了\n",
        "utf-8",
    )
    findings = lc.check_requirement_index_matches_files()
    assert any("REQ-002" in f and "REQ-001-x.md" in f for f in findings)


def test_an_index_row_escaping_the_requirements_directory_turns_red(lc) -> None:
    """codex 轮 3（非阻塞，同类一并修）：`../` 或绝对路径能落到目录之外一个恰好
    叫 `REQ-…` 的文件上 —— 「链到自己那份 REQ」的保证会当场作废。"""
    (lc.DOCS / "REQ-001-elsewhere.md").write_text("# 不在 requirements/ 里\n", "utf-8")
    (lc.DOCS / "requirements" / "index.md").write_text(
        "- [REQ-001](../REQ-001-elsewhere.md) — CONFIRMED — 越界\n", "utf-8"
    )
    findings = lc.check_requirement_index_matches_files()
    assert any("之外" in f for f in findings)


def test_index_pointing_at_a_missing_req_turns_red(lc) -> None:
    (lc.DOCS / "requirements" / "index.md").write_text(
        "- [REQ-001](REQ-001-x.md) — CONFIRMED — x\n"
        "- [REQ-009](REQ-009-ghost.md) — CONFIRMED — 不存在\n",
        "utf-8",
    )
    assert any("REQ-009" in f for f in lc.check_requirement_index_matches_files())


def test_an_index_row_without_a_status_turns_red(lc) -> None:
    """codex 轮 2 的 P1：没写状态的行此前被**跳过** —— 守卫恰好在记录残缺的地方沉默。"""
    (lc.DOCS / "requirements" / "index.md").write_text(
        "- [REQ-001](REQ-001-x.md) —— 没写状态的一行\n", "utf-8"
    )
    findings = lc.check_requirement_index_matches_files()
    assert any("没写状态" in f for f in findings)


def test_a_req_file_without_a_status_line_turns_red(lc) -> None:
    """codex 轮 2 的 P1：`if actual and …` 让「文件根本没有状态行」这种残缺通过。"""
    (lc.DOCS / "requirements" / "REQ-001-x.md").write_text(
        "# REQ-001：x\n\n没有状态行。\n", "utf-8"
    )
    findings = lc.check_requirement_index_matches_files()
    assert any("没有状态行" in f for f in findings)


def test_duplicate_index_rows_turn_red(lc) -> None:
    """codex 轮 2（非阻塞，同类一并修）：`dict()` 会把重复行悄悄折叠成最后一条 ——
    而两行就是两个要记得更新的地方，正是状态变陈旧的成因。"""
    (lc.DOCS / "requirements" / "index.md").write_text(
        "- [REQ-001](REQ-001-x.md) — CONFIRMED — x\n"
        "- [REQ-001](REQ-001-x.md) — DRAFT — 重复行\n",
        "utf-8",
    )
    assert any("重复" in f for f in lc.check_requirement_index_matches_files())


# --- 4/5. 临时产物与影子目录 ---------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "scratch-notes.md",
        "tmp-plan.md",
        "wip-migration.md",
        "debug-session.md",
        "plan-copy.md",
    ],
)
def test_temporary_artifacts_in_docs_turn_red(lc, name: str) -> None:
    (lc.DOCS / name).write_text("x\n", "utf-8")
    assert any(name in f for f in lc.check_no_temporary_artifacts_in_docs())


@pytest.mark.parametrize(
    "name",
    [
        "creator-system-contract.md",
        "current-architecture.md",
        "TASK-107-document-lifecycle.md",
    ],
)
def test_real_document_names_are_not_mistaken_for_scratch(lc, name: str) -> None:
    (lc.DOCS / name).write_text("x\n", "utf-8")
    assert lc.check_no_temporary_artifacts_in_docs() == []


@pytest.mark.parametrize(
    "name", ["old", "old2", "backup", "legacy-copy", "deprecated-but-kept"]
)
def test_shadow_directories_turn_red(lc, name: str) -> None:
    (lc.ROOT / "src" / name).mkdir(parents=True)
    assert any(name in f for f in lc.check_no_shadow_directories())


def test_an_archive_directory_is_not_a_shadow_implementation(lc) -> None:
    """`archive/` 是生命周期的一部分（归档），不是影子实现 —— 不得误杀。"""
    (lc.ROOT / "src" / "archive").mkdir(parents=True)
    assert lc.check_no_shadow_directories() == []


# --- 6. 当前架构合同 -----------------------------------------------------------


def test_a_missing_current_architecture_contract_turns_red(lc) -> None:
    (lc.DOCS / "current-architecture.md").unlink()
    assert lc.check_current_architecture_contract()


def test_a_bloated_current_architecture_contract_turns_red(lc) -> None:
    """它是索引不是副本：写成第二份 `architecture.md` 就失去了「精简」这个全部价值。"""
    (lc.DOCS / "current-architecture.md").write_text("x\n" * 400, "utf-8")
    assert lc.check_current_architecture_contract()


# --- 7. ORPHAN_TASK（说不出为什么做的卡）--------------------------------------


def test_a_card_with_no_requirement_and_no_technical_objective_turns_red(lc) -> None:
    """ADR-0088 决策 2：审查第 1 闸要对着判据核，卡上没有任何依据就无从核起。"""
    (lc.DOCS / "tasks" / "active" / "TASK-002-orphan.md").write_text(
        "# TASK-002：implement API\n\n- 状态：进行中\n- 目标：把接口做出来\n", "utf-8"
    )
    assert any("ORPHAN_TASK" in f for f in lc.check_no_orphan_task_in_active())


def test_a_technical_objective_is_enough_for_work_with_no_requirement(lc) -> None:
    """Bug / Refactor / Perf / 工装默认不建 REQ（ADR-0076）—— 它们写技术目标。"""
    (lc.DOCS / "tasks" / "active" / "TASK-003-refactor.md").write_text(
        "# TASK-003：拆掉重复的解析器\n\n- 状态：进行中\n"
        "- 技术目标：同一份 prompt 解析逻辑现在有三份，改一处必须改三处\n",
        "utf-8",
    )
    assert lc.check_no_orphan_task_in_active() == []


@pytest.mark.parametrize(
    "anchor",
    [
        "- 关联 Requirement：REQ-003 v1 判据 1",
        "- 依据：产品负责人 2026-08-26 —— 「…」",
        "- 起因：TASK-074 §1.5 的核查",
    ],
)
def test_any_of_the_accepted_anchors_satisfies_the_check(lc, anchor: str) -> None:
    """判据故意宽：目标是「什么都没说」的卡，不是措辞不同的卡。"""
    (lc.DOCS / "tasks" / "active" / "TASK-004-y.md").write_text(
        f"# TASK-004：y\n\n- 状态：进行中\n{anchor}\n", "utf-8"
    )
    assert lc.check_no_orphan_task_in_active() == []


def test_a_bare_adr_mention_is_not_a_basis(lc) -> None:
    """轮 1 的 P1：任何 `ADR-NNNN` 都算锚点 → 几乎每张卡都会在背景里引某条 ADR，
    于是这条检查等于不判。锚点必须是**带标签的**基础字段或显式 REQ-NNN。"""
    (lc.DOCS / "tasks" / "active" / "TASK-006-adr-only.md").write_text(
        "# TASK-006：改一下解析\n\n- 状态：进行中\n"
        "- 背景：见 ADR-0041 与 ADR-0066 的讨论\n",
        "utf-8",
    )
    assert any("ORPHAN_TASK" in f for f in lc.check_no_orphan_task_in_active())


def test_a_labelled_field_must_start_the_line(lc) -> None:
    """散文里出现「依据」二字不算声明 —— 和 ADR 取代关系同一条判据。"""
    (lc.DOCS / "tasks" / "active" / "TASK-007-prose.md").write_text(
        "# TASK-007：y\n\n- 状态：进行中\n- 目标：把这块整理干净，依据以后再补\n",
        "utf-8",
    )
    assert lc.check_no_orphan_task_in_active()


def test_an_empty_basis_field_is_a_label_not_a_basis(lc) -> None:
    """轮 2 的 P1：`- 依据：` 一行空标签也能过 —— 那是在检查拼写，不是检查内容。"""
    (lc.DOCS / "tasks" / "active" / "TASK-010-empty.md").write_text(
        "# TASK-010：y\n\n- 状态：进行中\n- 依据：\n- 技术目标：\n", "utf-8"
    )
    assert any("ORPHAN_TASK" in f for f in lc.check_no_orphan_task_in_active())


def test_the_guard_keeps_watching_a_new_card_after_it_moves_to_done(lc) -> None:
    """轮 1 的第二个 P1：Done 判定要求把卡搬进 `done/`，只看 `active/` 会正好在
    merge 那一刻看不见它。带 ADR-0088 字段集（`架构约束：`）的卡搬走后仍被检查。"""
    (lc.DOCS / "tasks" / "done" / "TASK-008-moved.md").write_text(
        "# TASK-008：z\n\n- 状态：完成\n- 架构约束：CA §4\n- 目标：z\n", "utf-8"
    )
    assert any("TASK-008" in f for f in lc.check_no_orphan_task_in_active())


def test_a_legacy_finished_card_is_grandfathered(lc) -> None:
    """存量已完成卡刻意豁免：给一百张已完成的卡回填依据，正是 ADR-0087 要避免的
    一次性整理；而给没人记得的旧工作编一条依据是虚构，不是追溯。"""
    (lc.DOCS / "tasks" / "done" / "TASK-009-legacy.md").write_text(
        "# TASK-009：老卡\n\n- 状态：完成\n- workflow：Migration\n", "utf-8"
    )
    assert lc.check_no_orphan_task_in_active() == []


def test_a_basis_buried_in_the_body_still_turns_red(lc) -> None:
    """**故意的边界**：只有头部算。基础写在第三节里，读者与 Review Package 都拿不到它
    —— 「信息其实在某处」这一族亏本仓库已经付过一次（ADR-0083 决策 3）。"""
    (lc.DOCS / "tasks" / "active" / "TASK-005-buried.md").write_text(
        "# TASK-005：z\n\n- 状态：进行中\n\n## 背景\n\n依据 REQ-001 的判据 2。\n",
        "utf-8",
    )
    assert lc.check_no_orphan_task_in_active()


# --- 索引文档不是第二份合同（ADR-0098）----------------------------------------


def _entry(
    defn: str = "一句话指称。", avoid: str = "别名甲", authority: str | None = None
) -> str:
    auth = (
        authority
        if authority is not None
        else "[当前架构合同](current-architecture.md)"
    )
    return f"# 术语表\n\n### 某词\n{defn}\n_Avoid_：{avoid}\n_权威_：{auth}\n"


def test_a_glossary_entry_without_avoid_turns_red(lc) -> None:
    """没有禁用叫法的条目只是普通名词解释 —— 收它不解决任何漂移。"""
    (lc.DOCS / "glossary.md").write_text(
        "# 术语表\n\n### 某词\n一句话。\n_权威_：[a](current-architecture.md)\n",
        "utf-8",
    )
    assert any("_Avoid_" in f for f in lc.check_index_docs_are_indexes())


def test_a_glossary_entry_without_a_pointer_turns_red(lc) -> None:
    """指针是这份文件的全部机制：没有出处的条目，内容只能是抄来的。"""
    (lc.DOCS / "glossary.md").write_text(_entry(authority="系统合同"), "utf-8")
    assert any("_权威_" in f for f in lc.check_index_docs_are_indexes())


def test_a_definition_carrying_a_rule_turns_red(lc) -> None:
    """**承重墙**（ADR-0098 决策 3）。抄合同的人会写「必须」；写不出「必须」时
    就只能写指称 —— 这条把「别抄」从自律变成语法约束。"""
    (lc.DOCS / "glossary.md").write_text(_entry("这一版必须由用户产生。"), "utf-8")
    assert any("必须" in f for f in lc.check_index_docs_are_indexes())


def test_an_overlong_definition_turns_red(lc) -> None:
    (lc.DOCS / "glossary.md").write_text(_entry("一\n二\n三"), "utf-8")
    assert any("定义" in f for f in lc.check_index_docs_are_indexes())


def test_a_broken_pointer_turns_red(lc) -> None:
    (lc.DOCS / "glossary.md").write_text(
        _entry(authority="[没这份](design/does-not-exist.md)"), "utf-8"
    )
    assert any("does-not-exist" in f for f in lc.check_index_docs_are_indexes())


def test_a_missing_index_doc_turns_red(lc) -> None:
    (lc.DOCS / "glossary.md").unlink()
    assert any("缺失" in f for f in lc.check_index_docs_are_indexes())


def test_an_index_growing_past_its_budget_turns_red(lc) -> None:
    """膨胀就是有人在往里抄合同 —— 与 current-architecture.md 的行数上限同款。"""
    (lc.DOCS / "out-of-scope.md").write_text("# 范围外\n" + "行\n" * 400, "utf-8")
    assert any("上限" in f for f in lc.check_index_docs_are_indexes())


def test_a_boundary_row_without_a_ruling_turns_red(lc) -> None:
    (lc.DOCS / "out-of-scope.md").write_text(
        "# 范围外记录\n\n| 不做什么 | 正式裁决 | 重访条件 |\n| --- | --- | --- |\n"
        "| 某事 | ADR-0010 说过 | 不重访 |\n",
        "utf-8",
    )
    assert any("正式裁决" in f for f in lc.check_index_docs_are_indexes())


def test_a_renamed_table_header_is_still_a_header(lc) -> None:
    """表头按**结构**认（分隔行的上一行），不按文案认。靠文案匹配的话，改一次列名
    表头就变成数据行，守卫会把表头自己报成「没有裁决的边界」—— 那是误报，
    而误报正是让人关掉守卫的那条路。"""
    (lc.DOCS / "out-of-scope.md").write_text(
        "# 范围外记录\n\n| 不做的事 | 裁决书 | 什么时候重看 |\n| --- | --- | --- |\n"
        "| 某事 | [当前架构合同](current-architecture.md) | 不重访 |\n",
        "utf-8",
    )
    assert lc.check_index_docs_are_indexes() == []


def test_the_guard_does_not_hunt_for_avoided_synonyms(lc) -> None:
    """**刻意不判，别把它「补上」**（ADR-0098「不做什么」）。全仓搜 `_Avoid_` 里的近义词
    会把每一次正常提及都报成漂移：守卫天天红，然后被关掉。这里钉住这条边界 ——
    仓库里到处写着「别名甲」，守卫照样保持绿。"""
    (lc.DOCS / "tasks" / "active" / "TASK-007-x.md").write_text(
        "# TASK-007：x\n\n- 状态：进行中\n- 技术目标：讨论别名甲与别名甲的用法\n",
        "utf-8",
    )
    assert lc.check_index_docs_are_indexes() == []


# --- 真实仓库 -----------------------------------------------------------------


def test_the_real_repository_converges() -> None:
    """守卫接到现实上的那根线。红了就是仓库离开了 ADR-0087 的形状，不是测试坏了。"""
    mod = _load()
    findings = {name: items for name, items in mod.run().items() if items}
    assert not findings, f"lifecycle_check 报出未收敛项：{findings}"

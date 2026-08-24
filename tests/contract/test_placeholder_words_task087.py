"""占位词名单：两个编译器必须逐字一致，且判据必须是**整串相等**（TASK-087 §4.4）。

`nonEmpty` 只做 `strip()`，于是模型写「无」「常规」时校验通过、内容进入 canon，
界面上显示成一个看起来有人填过的答案 —— 非空，但没有信息。

ADR-0067 的双编译器合同要求 `skillpkg.py` 与 `src/workflow/skills.js` 对同一份
输出给出**相同判定**。占位词名单是这条合同的一部分：一边加了词而另一边没加，
同一份 Skill 输出会在后端被拒、在前端通过（或者反过来），而两边都不会报错。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP = _REPO / "mockups" / "motv-workspace"
_SKILLS_JS = _MOCKUP / "src" / "workflow" / "skills.js"

sys.path.insert(0, str(_MOCKUP))
import skillpkg  # noqa: E402


def _js_words() -> set[str]:
    src = _SKILLS_JS.read_text(encoding="utf-8")
    start = src.index("const PLACEHOLDER_WORDS = new Set([")
    body = src[start : src.index("]);", start)]
    return set(re.findall(r'"([^"]*)"', body))


def test_both_lists_were_actually_read() -> None:
    """扫描面非空自检 —— 空集之间「相等」恒真。"""
    assert len(skillpkg._PLACEHOLDER_WORDS) >= 15
    assert len(_js_words()) >= 15


def test_the_two_compilers_share_one_placeholder_list() -> None:
    """一边加词、另一边没加 = 同一份输出两边判定不同，而且都不报错。"""
    py = set(skillpkg._PLACEHOLDER_WORDS)
    js = _js_words()
    assert py == js, (
        f"只在 Python 里：{sorted(py - js)}；只在 JS 里：{sorted(js - py)}。"
        "同一份 Skill 输出会在一边被拒、另一边通过（ADR-0067 双编译器合同）。"
    )


def test_a_placeholder_word_is_refused_when_nonEmpty_is_asked_for() -> None:
    schema = {"type": "string", "nonEmpty": True}
    for word in ("无", "常规", "N/A", "  待定  ", "TBD"):
        try:
            skillpkg.validate_output(schema, word, "字段")
        except skillpkg.SkillPackageError as exc:
            assert "占位词" in str(exc), (word, str(exc))
        else:
            raise AssertionError(f"占位词「{word}」被接受了")


def test_real_content_that_merely_contains_a_placeholder_word_survives() -> None:
    """**这条才是本次改动最该守住的东西。**

    判据是整串相等，不是子串包含。「无人机俯拍」「常规打光之外的处理」都是
    真答案，含占位词只是巧合 —— 子串匹配会把它们一起拒掉，那比放进无信息的
    内容**更糟**：前者是拒绝真内容，后者只是接受了空话。
    """
    schema = {"type": "string", "nonEmpty": True}
    for text in (
        "无人机俯拍，从屋顶掠过",
        "常规打光之外，加一盏侧逆光",
        "没有对白，全靠环境声",
        "略带沙哑的女声",
        "标准镜头 50mm，f/1.8",
        "暂无法确认的道具需要美术二次确认",
    ):
        skillpkg.validate_output(schema, text, "字段")  # 不抛即通过


def test_placeholder_screening_only_applies_when_nonEmpty_is_asked_for() -> None:
    """没要求 `nonEmpty` 的字段不受影响。

    一个可选字段填「无」可能正是创作者的本意（「这一镜没有音效」）。
    本次改动收紧的是「这个字段必须有内容」那个承诺，不是给所有字符串加审查。
    """
    skillpkg.validate_output({"type": "string"}, "无", "字段")


def _js_strip_chars() -> str:
    src = _SKILLS_JS.read_text(encoding="utf-8")
    m = re.search(r'const STRIP_CHARS = "([^"]*)";', src)
    assert m, "skills.js 里找不到 STRIP_CHARS"
    return m.group(1).encode().decode("unicode_escape")


def test_both_sides_strip_the_same_invisible_characters() -> None:
    """归一化也是合同的一部分 —— **词表一致不等于判定一致**。

    这条测试是补上的：原来只比对两份词表，于是 codex 复审报出一处真分歧 ——
    JS `trim()` 剥 U+FEFF，Python `strip()` 不剥（它 `isspace()` 为假），
    于是 `"﻿无﻿"` 在 JS 侧被拒、在 Python 侧通过。
    两份词表当时是完全一致的，而判定相反。
    """
    assert _js_strip_chars() == skillpkg._STRIP_CHARS, (
        f"JS {_js_strip_chars()!r} vs Python {skillpkg._STRIP_CHARS!r}"
    )
    assert "﻿" in skillpkg._STRIP_CHARS, "U+FEFF 正是引发这条测试的那个字符"


def test_invisible_characters_cannot_smuggle_a_placeholder_through() -> None:
    """不可见字符包着的占位词，仍然是占位词。

    交替排列的那一条（`"﻿ 无 ﻿"`）是故意的：单向剥一次的话，
    空白与不可见字符交替时会留下残余 —— 所以 `_normalise` 反复剥到不再变短。
    """
    schema = {"type": "string", "nonEmpty": True}
    for text in ("﻿无﻿", "​无", "﻿ 无 ﻿", "  无  ", "⁠无‍"):
        try:
            skillpkg.validate_output(schema, text, "字段")
        except skillpkg.SkillPackageError as exc:
            assert "占位词" in str(exc), (ascii(text), str(exc))
        else:
            raise AssertionError(f"{ascii(text)} 被接受了")


def test_a_string_of_only_invisible_characters_is_empty_not_a_placeholder() -> None:
    """只有不可见字符 = **空**，不是占位词。

    两种情况把创作者送到不同的地方：一个是没生成出来，一个是生成了但没内容。
    """
    schema = {"type": "string", "nonEmpty": True}
    try:
        skillpkg.validate_output(schema, "﻿ ​", "字段")
    except skillpkg.SkillPackageError as exc:
        assert "不能为空" in str(exc), str(exc)
        assert "占位词" not in str(exc), str(exc)
    else:
        raise AssertionError("全是不可见字符却通过了")

"""抓图工具镜像的那份别名表，必须和 `shell.js` 的权威表一致（TASK-087 §4.5）。

`src/ui-gap-audit/tools/capture_current.py` 里有一份 `LANDS_ON`，写的是「某个
历史键会落到哪一页」。权威是 `mockups/motv-workspace/src/ui/shell.js` 的
`MODULE_ALIAS`。登记时写的是：「守卫会在应用落到别处时喊，但**两份表本身不比对**」。

两份表不比对的后果不是「抓图会报错」，而是**抓图会安静地抓错页并自称成功**：
`LANDS_ON` 只被用来算 `expect`，`MODULE_ALIAS` 改了而它没改时，两边一起错到
同一个地方去，工具的自检当然通过。

根治是让工具直接从 `shell.js` 读（登记时就是这么写的），但那要给一个纯 Python
工具加 JS 解析。**这条测试是更小的那一半**：不改工具，只保证两份表说的是
同一件事 —— 漂了就红。
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_SHELL_JS = _REPO / "mockups" / "motv-workspace" / "src" / "ui" / "shell.js"
_CAPTURE = _REPO / "src" / "ui-gap-audit" / "tools" / "capture_current.py"


def _authoritative_alias() -> dict[str, str]:
    """`MODULE_ALIAS` 里每个键落到的**模块**（元组第一项）。

    值里可能是常量而不是字面量（`storage: [PROJECT_SETTINGS, "storage"]`），
    所以先把同文件里的 `export const X = "..."` 收集起来再解引用 —— 硬编码
    `projectsettings` 的话，常量改了这条测试就跟着错，而它的全部职责正是
    「别让两处各写各的」。
    """
    src = _SHELL_JS.read_text(encoding="utf-8")
    consts = dict(re.findall(r'export const ([A-Z_][A-Z0-9_]*) = "([^"]+)";', src))
    start = src.index("export const MODULE_ALIAS = Object.freeze({")
    body = src[start : src.index("});", start)]
    out: dict[str, str] = {}
    for key, first in re.findall(
        r'^\s*"?([A-Za-z_][A-Za-z0-9_:]*)"?:\s*\[\s*([A-Za-z_"][^,\]]*)', body, re.M
    ):
        first = first.strip()
        out[key] = (
            first.strip('"') if first.startswith('"') else consts.get(first, first)
        )
    return out


def _mirrored_alias() -> dict[str, str]:
    src = _CAPTURE.read_text(encoding="utf-8")
    start = src.index("LANDS_ON = {")
    body = src[start : src.index("}", start)]
    return dict(re.findall(r'"([^"]+)":\s*"([^"]+)"', body))


def test_both_alias_tables_were_actually_read() -> None:
    """扫描面非空的自检。

    两边都是正则挖源码。挖空了的话，下面「每一项都一致」在空集上恒真 ——
    一条永远绿的守卫比没有守卫更糟，因为它看起来像有人在看着。
    """
    authoritative = _authoritative_alias()
    mirrored = _mirrored_alias()
    assert len(authoritative) >= 10, f"MODULE_ALIAS 只挖出 {authoritative}"
    assert len(mirrored) >= 8, f"LANDS_ON 只挖出 {mirrored}"
    # 常量解引用真的发生了：`storage` 的值必须是解出来的字符串，不是常量名
    assert authoritative.get("storage") == "projectsettings", authoritative


def test_the_mirrored_table_says_the_same_thing_as_the_authority() -> None:
    """镜像表的每一项，都要和 `shell.js` 说的一致。

    不要求覆盖全部键 —— 镜像表只写「这个文件驱动到的那些」，那是它自己声明的
    范围。要求的是：**它写下的每一项都不许和权威冲突**。
    """
    authoritative = _authoritative_alias()
    mirrored = _mirrored_alias()

    unknown = sorted(set(mirrored) - set(authoritative))
    assert not unknown, (
        f"`LANDS_ON` 写了 `MODULE_ALIAS` 里根本没有的键：{unknown}。"
        "抓图会按一个不存在的历史键去等一个页面，而应用会落到 PAGES[0]。"
    )

    drifted = {
        k: (mirrored[k], authoritative[k])
        for k in mirrored
        if mirrored[k] != authoritative[k]
    }
    assert not drifted, (
        f"两份别名表对同一个键说了不同的话（镜像 / 权威）：{drifted}。"
        "后果不是抓图报错，而是**抓错页并自称成功** —— 工具的自检用的就是这份镜像。"
    )

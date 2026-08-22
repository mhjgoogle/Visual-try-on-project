"""motv 生产记忆库 / 本集制作 / 溯源创作主干 — TASK-061 / ADR-0058.

STRICTLY OFFLINE, no spend. What stays here is the style-token guard (the pure-
module behavior — usage derivation, reference plan, provenance graph, asset
library UI — is covered by the frontend suite ``tests/*.test.mjs``, run by the
frontend gate/CI):

- every CSS custom property used is actually defined.

The five app-level wiring contracts that live in DOM-bound closures inside
``app.js`` —— 临时上传必经唯一登记路径、手工路线记录同形 Generation、一次生成
因为它真的是生成才被记录、文件选择器不猜取消、声明的 kind 必须与字节一致 ——
已随 TASK-102 批次 E 移到
``tests/contract/test_frontend_write_path_invariants.py``。
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP_DIR = _REPO / "mockups" / "motv-workspace"


def test_every_css_custom_property_is_defined() -> None:
    """自查发现的一整类缺陷：`--card` / `--muted` / `--warn` / `--acc` / `--fg`
    从未在 tokens.css 里定义过，所以每个 background 都是透明的、每个 color 都
    继承了正文色。一个拼错的 token 不会报错，它只是安静地什么都不做。"""
    styles = _MOCKUP_DIR / "styles"
    defined = set(
        re.findall(r"(--[a-z0-9-]+)\s*:", (styles / "tokens.css").read_text("utf-8"))
    )
    for name in ("studio.css", "wfgraph.css"):
        css = (styles / name).read_text("utf-8")
        local = set(re.findall(r"(--[a-z0-9-]+)\s*:", css))
        # a var() WITH a fallback is a deliberate optional; a bare one is a bug
        used = set(re.findall(r"var\((--[a-z0-9-]+)\s*\)", css))
        missing = sorted(used - defined - local)
        assert not missing, f"{name} uses undefined tokens: {missing}"

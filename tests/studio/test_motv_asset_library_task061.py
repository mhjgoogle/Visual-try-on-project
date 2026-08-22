"""motv 生产记忆库 / 本集制作 / 溯源创作主干 — TASK-061 / ADR-0058.

STRICTLY OFFLINE, no spend. Guards the app-level wiring contracts that live in
DOM-bound closures inside ``app.js`` (the pure-module behavior — usage
derivation, reference plan, provenance graph, asset library UI — is covered by
the frontend suite ``tests/*.test.mjs``, run by the frontend gate/CI):

- 临时上传 goes through the ONE registration path — no code path can leave
  orphan media behind;
- the manual route records the same Generation shape via the one media write
  path, and a generation is recorded because it WAS one;
- the file picker never guesses at cancellation; the declared kind must agree
  with the file's bytes;
- every CSS custom property used is actually defined.
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP_DIR = _REPO / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


def _read(*parts: str) -> str:
    return (_SRC / Path(*parts)).read_text("utf-8")


def _code(*parts: str) -> str:
    """Source with comments stripped — so a rule can never be 'satisfied' by a
    comment that merely describes it."""
    src = _read(*parts)
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return "\n".join(ln.split("//")[0] for ln in src.splitlines())


def test_temp_upload_still_registers_and_cannot_orphan_media() -> None:
    """临时上传不是绕过登记的捷径 (ADR-0058 决策 5)。"""
    app = _code("app.js")
    block = app.split("uploadReference: async (shotId, kind)", 1)[1].split(
        "importResult:", 1
    )[0]
    # ONE import path, then a binding — no direct upload call anywhere in it
    assert "ctx.assets.importReference" in block
    assert "ctx.shot.addReference" in block
    assert "query.uploadAssetImage" not in block, (
        "the picker must not upload on its own"
    )
    # the same is true of the Reference Plan's gap action
    plan = app.split("uploadFor: async (kind, subjectId)", 1)[1].split("\n  },", 1)[0]
    assert "ctx.assets.importReference" in plan
    assert "query.uploadAssetImage" not in plan


def test_the_manual_route_records_the_same_generation_shape() -> None:
    """手工路线第一次拥有与自动路线同等的溯源：它走同一个唯一写路径，
    并把输入集合冻结进 Generation 记录。"""
    app = _code("app.js")
    imp = app.split("importResult: async (shotId, kind, file, promptText", 1)[1].split(
        "\n    },", 1
    )[0]
    assert "generationSeedFrom" in imp
    assert "ctx.media.importShotMedia" in imp, "the ONE media write path, not a new one"
    # importShotMedia consumes the seed when the caller assembled one
    media = app.split("importShotMedia: async", 1)[1].split("useAsFirstFrame:", 1)[0]
    assert "intent.seed" in media
    # …and the older prompt-only entry keeps working (no route was broken)
    assert "promptSnapshot: intent.prompt" in media


def test_a_generation_is_recorded_because_it_WAS_one_not_because_it_had_a_prompt() -> (
    None
):
    """codex review 轮 A4：以 prompt 为门槛，会让「从参考图与首帧出发、没有
    prompt 的外部生成」变成一次普通导入——它的参考与首帧是真实的溯源，被整个
    丢掉了。没有 intent 的导入仍然如实是普通导入。"""
    app = _code("app.js")
    media = app.split("importShotMedia: async", 1)[1].split("useAsFirstFrame:", 1)[0]
    assert (
        "intent.shotId === shotId && (intent.seed || intent.entry || intent.prompt)"
        in media
    )
    assert "intent && intent.prompt && intent.shotId" not in media, (
        "the prompt must not be the gate"
    )
    # …and the record is COMPLETED with its result in the same call — a record
    # left at 生成中 with no result would be worse than none (codex review 轮 A7
    # read the literal alone and reported exactly that; these two lines are why
    # the real acceptance run records status=success with a resultAssetId)
    branch = media.split("ctx.startGeneration(", 1)[1]
    assert "ctx.completeGeneration(gen.generationId, [ref.assetId])" in branch
    assert "ref.links.generationId = gen.generationId" in branch


def test_the_file_picker_never_guesses_at_cancellation() -> None:
    """codex review 轮 A4 → B4：先加了 focus 计时兜底当第二个取消信号，B4 指出
    它的代价——页面可以在选择器仍打开时重获焦点，计时器于是把这次操作判成取消，
    而随后真实的选择再也无法翻案，静默丢掉创作者确实选中的文件。

    两种失败不对等：在不触发 `cancel` 的浏览器上挂起，只是让一个什么都没改变的
    手势结束，屏幕上不留下任何过期内容；丢掉已选中的文件丢的是真实工作。所以
    只信浏览器自己的 `cancel`。"""
    app = _code("app.js")
    picker = app.split("function pickFile(accept)", 1)[1].split("\n}", 1)[0]
    assert "input.oncancel" in picker
    assert "input.onchange" in picker
    for guess in ('addEventListener("focus"', "setTimeout"):
        assert guess not in picker, f"{guess} would guess at cancellation"


def test_the_declared_kind_must_agree_with_the_file() -> None:
    """codex review 轮 A：`accept` 只是提示，选择器可以被要求忽略它。若不校验，
    在「图片」入口选一个 mp4 会把视频登记成 shot-image——一条被字节反驳的登记，
    正是 CP2 规则要防的那件事。"""
    app = _code("app.js")
    media = app.split("importShotMedia: async", 1)[1].split("useAsFirstFrame:", 1)[0]
    assert "mediaDomainOfFile(file)" in media
    assert "fileDomain !== domain" in media
    # …and it is checked BEFORE the upload, so a refusal leaves nothing on disk
    upload_at = media.index("query.uploadAssetImage")
    assert media.index("fileDomain !== domain") < upload_at, (
        "the mismatch must be refused before any byte is written"
    )


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

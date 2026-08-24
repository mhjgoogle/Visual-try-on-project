"""TASK-027 part-2b —— 并排媒体比较页，在**真浏览器**里跑真的 shell 前端。

切片 1 让 WQ-06 带上了 `media_path`，切片 3 让 Shots 视图**真的把候选并排放出来
比画面**。这份测试证的是后者：`renderShotAttempts` 真的把一个 attempt 渲成
`<video>`/`<img>`，而不是并排放两行文字。

**为什么必须用浏览器**：`workspace_shell/static/app.js` 是一个浏览器脚本 ——
没有 `export`，靠 `document` 活着。它没法被 `node --test` import；而
AGENTS.md §20 明确禁止「Python 测试对前端 JS 做源码文本断言」（断言源码里有没有
`renderShotAttempts` 这串字，证明不了它跑起来会渲出什么）。真浏览器是唯一
既不违规又真的验到东西的路子。

**这条测试不需要 ffmpeg**：资产由 `generate_batch` 的 local-stub 暂存，
它证的是「Studio 选了哪个元素、src 指向哪里」这个**渲染决策**。
「真 MP4 在 `<video>` 里解不解得出来」是另一回事，由
`tests/e2e/test_studio_real_media_task074.py` 用真 H.264 覆盖 —— 两条不重复。
"""

from __future__ import annotations

import socket
import threading
from pathlib import Path

import pytest

pytest.importorskip("playwright.sync_api", reason="Playwright 未安装")

from playwright.sync_api import sync_playwright  # noqa: E402

from workspace_shell.server import build_server  # noqa: E402


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture()
def shell(tmp_path, monkeypatch):
    """A real shell server over a real WFM1 episode with one attempt's media
    published through the authoritative generation chain."""
    from tests.wfm1_scenario import _paid_all_shots, _run, _setup

    root, catalog_dir, _ = _setup(tmp_path, monkeypatch)
    _paid_all_shots(root, catalog_dir)
    assert _run(root, catalog_dir, "compose") == 0

    port = _free_port()
    httpd = build_server(tmp_path, host="127.0.0.1", port=port)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}", tmp_path, root
    finally:
        httpd.shutdown()
        httpd.server_close()


def _publish_media_for_first_attempt(account_root: Path, project_root: Path) -> str:
    """Publish a real generated asset bound to the first attempt's operation.

    Goes through `generate_batch → record_selection → promote_selection` because
    `_verify_generation_provenance` refuses any asset whose bound media is not
    the selected candidate's staged file — a hand-built one would be a shape the
    product cannot produce.
    """
    from datetime import datetime, timezone

    from ai_video_workflow.media.batch import record_selection
    from ai_video_workflow.media.generation import generate_batch, promote_selection
    from ai_video_workflow.media.provider import default_media_registry
    from ai_video_workflow.workspace import WorkspaceQueryService

    fixed = datetime(2026, 8, 3, tzinfo=timezone.utc)
    svc = WorkspaceQueryService(account_root, clock=lambda: fixed)
    attempts = svc.shot_attempts(project_root, "shot-1")
    assert attempts.items, "夹具必须真的有 attempt"
    op_id = attempts.items[0]["operation_id"].value

    generate_batch(
        project_root,
        registry=default_media_registry(),
        provider_id="local-stub",
        operation_id=op_id,
        batch_id="batch-cmp",
        capability="text_to_image",
        media_kind="generated_image",
        prompt="p",
        model_id="m1",
        candidate_ids=["c1"],
        clock=lambda: fixed,
    )
    record_selection(
        project_root,
        selection_id="sel-cmp",
        batch_id="batch-cmp",
        selected_candidate_id="c1",
    )
    promote_selection(project_root, ref="cmp", version=1, selection_id="sel-cmp")
    return op_id


def test_the_shots_view_renders_each_attempts_footage_side_by_side(shell):
    """part-2b「并排媒体比较」：比较候选是**看画面**的事。

    合同 1.6 之前 Shots 视图只能并排放 id 与 provider 名 —— 那回答不了
    「这一条比那一条好在哪」。这条测试驱动真的 `renderShotAttempts`，
    要求带媒体的那个 attempt 渲出真正的媒体元素。
    """
    base, account, project = shell
    op_id = _publish_media_for_first_attempt(account, project)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        try:
            page.goto(
                f"{base}/#/p/{project.name}/shots/shot-1", wait_until="networkidle"
            )
            page.wait_for_selector(".attempts .attempt", timeout=10_000)
            verdict = page.evaluate(
                """() => {
                     const cards = [...document.querySelectorAll(".attempts .attempt")];
                     return {
                       cards: cards.length,
                       withMedia: cards.filter(
                         (c) => c.querySelector("figure.media img, figure.media video")
                       ).length,
                       saidNoMedia: cards.filter(
                         (c) => /no published media asset/i.test(c.textContent)
                       ).length,
                       emptySources: cards.filter((c) => {
                         const m = c.querySelector(
                           "figure.media img, figure.media video");
                         return m && !m.getAttribute("src");
                       }).length,
                       artifactUrls: [...document.querySelectorAll(
                         "figure.media img, figure.media video"
                       )].map((m) => m.getAttribute("src")),
                     };
                   }"""
            )
        finally:
            browser.close()

    assert verdict["cards"] >= 1, f"Shots 视图一张 attempt 卡都没渲出来：{verdict}"
    assert verdict["withMedia"] >= 1, (
        "发布了资产的那个 attempt 没有渲出媒体元素 —— "
        f"并排比较就退回成并排放文字：{verdict}"
    )
    # 媒体走的必须是壳自己的 /artifact 端点（含路径围栏），不是任何外部 URL
    for src in verdict["artifactUrls"]:
        assert src.startswith("/artifact?path="), f"媒体没走 /artifact：{src}"
    # 空 src 的 <video> 会显示成一个黑框，读起来像「这次生成失败了」
    assert verdict["emptySources"] == 0, f"渲出了 src 为空的媒体元素：{verdict}"
    assert op_id


def test_an_attempt_without_media_says_so_instead_of_an_empty_player(shell):
    """没有媒体的 attempt **说出来**，不渲一个空播放器。

    一个空的 `<video>` 在页面上是个黑框，读起来像「这次生成失败了」——
    而事实可能是「这次成功了，只是还没发布成资产」。两件不同的事，
    界面不能把它们显示成同一个样子。

    夹具里一个资产都不发布，于是**每一个** attempt 都该走这条路径。
    """
    base, _account, project = shell

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        try:
            page.goto(
                f"{base}/#/p/{project.name}/shots/shot-1", wait_until="networkidle"
            )
            page.wait_for_selector(".attempts .attempt", timeout=10_000)
            verdict = page.evaluate(
                """() => {
                     const cards = [...document.querySelectorAll(".attempts .attempt")];
                     return {
                       cards: cards.length,
                       mediaEls: document.querySelectorAll(
                         ".attempts figure.media img, .attempts figure.media video"
                       ).length,
                       saidNoMedia: cards.filter(
                         (c) => /no published media asset/i.test(c.textContent)
                       ).length,
                     };
                   }"""
            )
        finally:
            browser.close()

    assert verdict["cards"] >= 1, verdict
    assert verdict["mediaEls"] == 0, f"没有任何已发布资产，却渲出了媒体元素：{verdict}"
    assert verdict["saidNoMedia"] == verdict["cards"], (
        f"没有媒体的 attempt 必须逐个说明原因，而不是留白：{verdict}"
    )

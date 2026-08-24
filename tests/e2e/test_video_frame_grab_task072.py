"""TASK-072 §1.9 #10 —— 在真的浏览器里实测「抓第一帧会不会挂住」。

卡上的原话是：

> `"at"` 帧提取：`currentTime` 设到 0 ms 时若视频本来就停在 0，浏览器**不保证**
> 派发 `seeked` → 抓第一帧走到超时。**先在真实项目里实测**；复现不了就记
> 「未复现」并关闭，**不要凭报告改**。

所以这份测试的目的是**测量**，不是修复。它在 Playwright 的 Chromium 里加载
**真实的** `src/services/videoframe.js`（不是抄一份），对着 ffmpeg 生成的**真的
H.264 文件**调用，并把结论写进断言。

**为什么合成素材足以settle这一条**：`seeked` 派不派发是**浏览器与媒体元素的行为**，
与画面内容无关。真容器、真编码、真时长就够了 —— 这正是 AGENTS.md §20 禁 SVG
占位素材的理由的反面：那条规则针对的是「占位素材不像真媒体那样行为」，
而 ffmpeg 生成的 MP4 就是真媒体。

超时被压到 2 秒（生产是 20 秒）：这条测试要么很快过，要么就是复现了那个挂住 ——
让它红得快，而不是挂 20 秒（交接文档第 3 条的教训）。
"""

from __future__ import annotations

import http.server
import socket
import threading
from functools import partial
from pathlib import Path

import pytest

from tests.e2e.assets_synthetic import have_ffmpeg, make_video

_MOCKUP = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"

pytest.importorskip("playwright.sync_api", reason="Playwright 未安装")

from playwright.sync_api import sync_playwright  # noqa: E402

_PAGE = """<!doctype html><meta charset="utf-8"><title>frame grab</title>
<script type="module">
  import { grabVideoFrame } from "./src/services/videoframe.js";
  window.__grab = (opts) => grabVideoFrame("./clip.mp4", opts).then(
    (r) => ({ ok: true, timecodeMs: r.timecodeMs, width: r.width, height: r.height,
              bytes: r.file.size, type: r.file.type }),
    (e) => ({ ok: false, error: String(e && e.message || e) }),
  );
  // 报告说的那个**前提**：`loadedmetadata` 时视频本来就停在 0，于是
  // `currentTime = 0` 是一次空赋值。不证实这个前提，整条测试就可能在测另一件事
  // （「测试的构造恰好排除了要防的那件事」——TASK-087 §7）。
  window.__precondition = () => new Promise((res) => {
    const v = document.createElement("video");
    v.preload = "auto"; v.muted = true; v.playsInline = true;
    const out = { seekedFired: false };
    v.onloadedmetadata = () => {
      out.currentTimeAtMetadata = v.currentTime;
      v.currentTime = 0;
      out.currentTimeAfterSet = v.currentTime;
    };
    v.onseeked = () => { out.seekedFired = true; res(out); };
    setTimeout(() => res({ ...out, timedOut: true }), 3000);
    v.src = "./clip.mp4";
  });
  window.__ready = true;
</script>"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    """同源地伺服 `videoframe.js` 与一个真的 MP4。

    必须同源：`grabVideoFrame` 的注释写明它依赖同源以免 canvas 被污染，
    跨源的话 `toBlob` 会抛 —— 那会让这条测试测到另一件事。
    """
    if not have_ffmpeg():
        pytest.skip("ffmpeg 不在 PATH 上：这条测试要的是真的 H.264 文件")

    root = tmp_path_factory.mktemp("frame-grab")
    (root / "src" / "services").mkdir(parents=True)
    (root / "src" / "services" / "videoframe.js").write_bytes(
        (_MOCKUP / "src" / "services" / "videoframe.js").read_bytes()
    )
    # 一秒、24fps、320x320 的真 H.264；`+faststart` 让 moov 在前
    make_video(root / "clip.mp4", seconds=1.0, width=320, height=320, fps=24)
    (root / "harness.html").write_text(_PAGE, encoding="utf-8")

    handler = partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def _grab(page, base, opts, *, budget_ms=2000):
    page.goto(f"{base}/harness.html")
    page.wait_for_function("window.__ready === true")
    # 生产的上限是 20 秒；这里压到 2 秒 —— 复现了就**快速转红**，不是挂住
    return page.evaluate(
        """([opts, budget]) => Promise.race([
             window.__grab(opts),
             new Promise((r) => setTimeout(
               () => r({ ok: false, error: "HARNESS_TIMEOUT" }), budget)),
           ])""",
        [opts, budget_ms],
    )


def test_grabbing_the_first_frame_at_zero_does_not_hang(served):
    """**这就是 #10 那条报告。** 结论写在断言里，而不是写在注释里。"""
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        try:
            at_zero = _grab(page, served, {"pick": "at", "timecodeMs": 0})
            last = _grab(page, served, {"pick": "last"})
            at_mid = _grab(page, served, {"pick": "at", "timecodeMs": 500})
        finally:
            browser.close()

    # 报告说的那个情形：0 ms
    assert at_zero["ok"] is True, (
        f"抓第一帧失败：{at_zero.get('error')} —— 若是 HARNESS_TIMEOUT，"
        "则 §1.9 #10 **复现了**，那是一条真缺陷"
    )
    assert at_zero["timecodeMs"] == 0
    assert (at_zero["width"], at_zero["height"]) == (320, 320)
    assert at_zero["bytes"] > 0 and at_zero["type"] == "image/png"

    # 另外两条路径同时验一遍，免得「0 ms 能过」是因为整条路都没跑起来
    assert last["ok"] is True, last.get("error")
    assert last["timecodeMs"] > 0, "last 帧不该落在 0"
    assert at_mid["ok"] is True, at_mid.get("error")
    assert 400 <= at_mid["timecodeMs"] <= 600


def test_the_reported_precondition_really_does_hold(served):
    """**前提自证**：报告说的那个情形真的发生了，只是没有它说的后果。

    实测（Chromium / Playwright，2026-08-24）：

    * `loadedmetadata` 时 `currentTime` **确实是 0** —— 前提成立；
    * `v.currentTime = 0` **确实是空赋值**（赋完还是 0）；
    * 而 Chromium **照样派发了 `seeked`** —— 所以 §1.9 #10 **未复现**。

    卡上写的是「复现不了就记未复现并关闭，**不要凭报告改**」，所以
    `videoframe.js` 一个字节都没有因为这条报告而改动。

    这条测试留下来的价值是：如果哪天换了引擎、或 Chromium 改了行为，
    它会**先于创作者**发现 —— 那时 #10 就从「未复现」变成一条真缺陷。
    """
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        try:
            page.goto(f"{served}/harness.html")
            page.wait_for_function("window.__ready === true")
            probe = page.evaluate("window.__precondition()")
        finally:
            browser.close()

    assert probe.get("timedOut") is not True, (
        "前提探针超时 —— 那本身就是 §1.9 #10 复现了"
    )
    assert probe["currentTimeAtMetadata"] == 0, "前提：视频本来就停在 0"
    assert probe["currentTimeAfterSet"] == 0, "前提：设到 0 是一次空赋值"
    assert probe["seekedFired"] is True, (
        "Chromium 不再为空赋值派发 seeked —— §1.9 #10 从「未复现」变成真缺陷了"
    )

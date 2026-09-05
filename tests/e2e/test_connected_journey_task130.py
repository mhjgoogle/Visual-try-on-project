"""TASK-130 —— 在一个可重复的 Connected Project 上，用真浏览器走一遍旅程。

收敛审查 §5.E：「为“创建/连接项目 → 故事修改 → 分集制作 → 刷新恢复 → 审片 → 导出”
保存一条自动化 e2e」。这一条把四张卡各自挂到「切片 5」的人工走查项**先用机器走一遍**：

    TASK-127   故事核心里打的字经动作表（`uiAct` → `work.core`）落到作品，刷新后还在
    TASK-106   运行中的那一轮刷新后被接回（ADR-0095）：屏幕上是「正在想…」而不是空白；
               放行之后答案落进线程
    TASK-074   有阻断问题的候选「导出成片」不可点且理由可见 —— 阻断来自**真实测量**
               （生成媒体 320x320@24 vs 规格 1080x1920@30），不是种一条问题冒充
    TASK-074   撤回一版成片 = 归档（可逆），撤回后它不再出现在「已导出的成片」里

每一步断言的是**产品的选择**（渲染了什么、按钮能不能点、刷新后留下什么），不是 Chromium
的行为。素材是合成的，但不是占位的（真 H.264 / 真 PNG，见 `assets_synthetic.py`）。
没有 ffmpeg / playwright / node 就 skip 并说明。

「真实项目上产品负责人自己跑一集」仍然是另一件事 —— 这里保证的是他跑之前机器已经跑过。
"""

from __future__ import annotations

import json
import re
import socket
import sys
import threading
import time
from pathlib import Path
from urllib.parse import quote

import pytest

from tests.e2e.assets_synthetic import have_ffmpeg
from tests.e2e.connected_sample import build_connected_sample

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP = _REPO / "mockups" / "motv-workspace"

pytest.importorskip("playwright.sync_api", reason="Playwright 未安装")
from playwright.sync_api import sync_playwright  # noqa: E402

sys.path.insert(0, str(_MOCKUP))
import server as srv  # noqa: E402

WAITING = re.compile(r"正在想|排队中|状态未知")


@pytest.fixture()
def studio(tmp_path, monkeypatch):
    """一个真的后端，数据位置全部是丢弃的（与 task074 e2e 同一个夹具形状）。"""
    if not have_ffmpeg():
        pytest.skip("ffmpeg 不在 PATH 上：这条旅程要的是真媒体")
    monkeypatch.setattr(srv, "DATA_DIR", tmp_path / "legacy")
    monkeypatch.setattr(srv, "APP_DATA_DIR", tmp_path / "app-data")
    monkeypatch.setattr(srv, "_USER_FLOWS_DIR", tmp_path / "user-flows")
    monkeypatch.setattr(srv, "_USER_SKILLS_DIR", tmp_path / "user-skills")
    account = tmp_path / "MotvProjects"
    account.mkdir()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    httpd = srv.build_server(account, host="127.0.0.1", port=port)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}", account, httpd
    finally:
        httpd.shutdown()
        httpd.server_close()


def _wait_json(path, needle, timeout=20.0):
    r"""等到盘上那份 JSON 真的含有这段字 —— 而不是 sleep 一个猜出来的秒数。

    **先解码再找，不在原始字节里找。** 这份文件有两条写路径：PUT 的原样落盘，
    以及 Run 在跑时那条「不许覆盖运行进度」的合并重写（server.py 的 canvas 守卫）。
    后者会重新 json.dump，中文于是变成 \uXXXX 转义 —— 在原始文本里搜中文，
    命中与否取决于**当时是哪条路径写的**，而这正是这条用例要消掉的那种偶发。
    """
    end = time.time() + timeout
    size = -1
    while time.time() < end:
        try:
            raw = path.read_text("utf-8")
        except OSError:
            raw = ""
        size = len(raw)
        try:
            flat = json.dumps(json.loads(raw), ensure_ascii=False)
        except ValueError:
            flat = raw  # 半写状态：下一轮再看
        if needle in flat:
            return
        time.sleep(0.1)
    raise AssertionError(f"{path.name} 里等不到 {needle!r}（当前 {size} 字节）")


def _wait_text(page, selector, pattern, timeout=15.0):
    """等到某个元素的文字匹配 —— 用轮询而不是固定 sleep，慢机器也不误判。"""
    end = time.time() + timeout
    last = ""
    while time.time() < end:
        el = page.query_selector(selector)
        last = (el.inner_text() if el else "") or ""
        if pattern.search(last):
            return last
        time.sleep(0.2)
    raise AssertionError(
        f"等不到 {selector} 出现 {pattern.pattern!r}；最后看到的是 {last!r}"
    )


def _row_of(cut_id: str) -> str:
    """候选行 —— 从它的导出按钮往上找到那个 <li>。"""
    return f'[data-pc-export="{cut_id}"] >> xpath=ancestor::li[1]'


def test_connected_journey(studio, monkeypatch):
    base, account, _httpd = studio
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        try:
            page.goto(f"{base}/index.html", wait_until="domcontentloaded")
            sample = build_connected_sample(srv, monkeypatch, page, base, account)
            assert sample.media_files >= 60, sample.media_files
            ep = sample.active_episode_id
            project = quote(sample.name)

            # ---- 1. 连接：深链接打开项目，三栏在，左栏是四个故事入口 ----------
            page.goto(
                f"{base}/index.html#/{project}/story/brief",
                wait_until="domcontentloaded",
            )
            page.wait_for_selector("[data-core]", timeout=20000)
            rail = (
                page.inner_text("nav, .rail, aside")
                if page.query_selector("nav, .rail, aside")
                else page.inner_text("body")
            )
            for label in ("故事核心", "故事大纲", "结构规划", "正文创作"):
                assert label in rail, f"左栏缺「{label}」"

            # ---- 2. 运行中的那一轮：刷新前就该有形状（不是空白） ------------
            assert _wait_text(page, "body", WAITING)

            # ---- 3. 故事修改：打字经动作表落到作品 ----------------------
            # **按选择器调，不要握着 handle 跨动作。**
            #
            # 上一版先 `query_selector` 拿到编辑区，再依次 click / fill /
            # dispatch_event。而第 2 步刚等到的是**运行中的那一轮** —— 页面此刻有个
            # run 在轮询、随时可能重渲染；渲染一次，先前拿到的那个节点就从 DOM 上
            # 脱开，`click()` 报 "Element is not attached to the DOM"。
            # 并行会话 2026-09-05 的全量里红过一次（本机连跑 5 次没复现 ——
            # **偶发不等于不是缺陷**，AGENTS.md 第 20 条把 flaky 当普通缺陷办）。
            #
            # 选择器形式每次重新解析并自带等待，这一类竞态因此不存在 ——
            # 而不是靠重试把它压下去。
            sel = "[data-core]"
            before = page.input_value(sel)
            marker = "【旅程标记】雨夜，一个人走进了自己的旧屋。"
            page.click(sel)
            page.fill(sel, before + "\n\n" + marker)
            page.dispatch_event(sel, "input")
            # **发 `pagehide`，不是 `beforeunload`。** 产品这一侧监听的是
            # `pagehide` / `visibilitychange`（理由写在 `ui/fieldsync.js`：
            # bfcache 下 `beforeunload` 不可靠）。上一版发的 `beforeunload`
            # 没有任何监听者，那一步实际上只是在等 700ms 去抖自己烧完。
            page.evaluate("() => window.dispatchEvent(new Event('pagehide'))")
            # 然后等**盘上真的有了**，而不是 sleep 一个猜出来的秒数。
            #
            # 分成两处等是有原因的：刷新之后那句断言证的是**恢复**，这一句证的是
            # **写落地**。压成一句，红了说不清是哪一件 —— 而这条用例现在恰好
            # 稳定地红在这一句上（约 1/5，单跑就能复现，与并行无关）：屏幕上字还在、
            # 盘上整个账户目录里一个字都没有、控制台一条 `motv:` 警告都没有。
            # 那是**静默丢字**，不是等得不够久。已记进 TASK-087 §6.12，本卡不修。
            _wait_json(account / sample.name / "studio" / "canvas.json", marker)

            # ---- 4. 刷新恢复：字还在，那一轮也还在 ----------------------------------
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("[data-core]", timeout=20000)
            assert marker in page.input_value("[data-core]"), (
                "刷新后故事核心里没有刚打的字 —— 写没落到作品上"
            )
            _wait_text(page, "body", WAITING)

            # ---- 5. 放行：答案落进线程 ----------------------------------------
            sample.release()
            _wait_text(page, "body", re.compile(r"样本的回答"), timeout=30.0)

            # ---- 6. 交付：候选 vs 成片，阻断来自真实测量 ------------------
            page.goto(
                f"{base}/index.html#/{project}/episode/delivery/export?ep={quote(ep)}",
                wait_until="domcontentloaded",
            )
            page.wait_for_selector('[data-pc-tab="final"]', timeout=20000)
            page.click('[data-pc-tab="final"]')
            export_sel = f'[data-pc-export="{sample.cut_asset_id}"]'
            page.wait_for_selector(export_sel, timeout=10000)
            assert page.is_disabled(export_sel), "还没测量就能导出 —— 门槛 G4 没起作用"
            row = page.inner_text(_row_of(sample.cut_asset_id))
            assert re.search(r"没被测量|没测过|先对它跑", row), row

            # 对这一版跑质检：真 ffprobe 量真文件 → 规格行阻断
            page.click(f'[data-pc-qc="{sample.cut_asset_id}"]')
            _wait_text(
                page,
                _row_of(sample.cut_asset_id),
                re.compile(r"阻断|规格|G4"),
                timeout=60.0,
            )
            assert page.is_disabled(export_sel), "有阻断级质检问题的候选仍然可以导出"

            # 已导出的成片那一组：历史成片在，能撤回（归档 = 可逆）
            archive_sel = f'[data-pc-archive="{sample.final_asset_id}"]'
            assert page.query_selector(archive_sel) is not None, (
                "历史成片没有画在「已导出的成片」里"
            )
            # 按**选择器**点，不拿句柄：控制台在探测结果回来时会重绘，先拿到的句柄会失效
            page.click(archive_sel)
            end = time.time() + 10
            while time.time() < end and page.query_selector(archive_sel) is not None:
                time.sleep(0.2)
            assert page.query_selector(archive_sel) is None, (
                "撤回（归档）之后它仍然算作已导出的成片"
            )
        finally:
            browser.close()

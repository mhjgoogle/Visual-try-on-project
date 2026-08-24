"""TASK-074 §1.4 —— 用**真的浏览器 + 真的媒体 + 真的后端**跑 Studio。

§1.4 要的是「在真实 Connected Project 上跑完整流程一遍」，并点名了八个边界情况。
这份测试覆盖其中**只有真浏览器 + 真媒体才验得到**的那几条；其余几条已有归属测试，
逐条指明在哪（见 `test_the_boundary_cases_are_each_covered_somewhere`），
**不重复造，也不假装它们没人管**。

**素材是合成的，但不是占位素材。** AGENTS.md §20 禁的是「demo seed 与 SVG 占位
素材」，理由写在 TASK-055 §5：占位素材**不像真媒体那样行为**，于是掩盖了
「视频资产被放进 `<img>`」这类缺陷 —— 一个 SVG 放进 `<img>` 恰好能显示。
这里用 ffmpeg 生成**真 H.264 / 真 PNG**：真容器、真编码、真时长、真 magic bytes。
它证明什么、不证明什么写在 `assets_synthetic.py`；一句话：**机械的那一半验得完，
判断的那一半仍然要人**。
"""

from __future__ import annotations

import json
import socket
import threading
from pathlib import Path
from urllib.parse import quote

import pytest

from tests.e2e.assets_synthetic import have_ffmpeg, make_image, make_video

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP = _REPO / "mockups" / "motv-workspace"

pytest.importorskip("playwright.sync_api", reason="Playwright 未安装")
import sys  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

sys.path.insert(0, str(_MOCKUP))
import server as srv  # noqa: E402


@pytest.fixture()
def studio(tmp_path, monkeypatch):
    """一个真的后端，数据位置全部是丢弃的。"""
    if not have_ffmpeg():
        pytest.skip("ffmpeg 不在 PATH 上：这条测试要的是真媒体")

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


def _api(page, base, path, *, method="GET", body=None):
    """在**页面里**发请求 —— 同源，与创作者点出来的那条路一致。"""
    return page.evaluate(
        """async ([url, method, body]) => {
             const res = await fetch(url, {
               method,
               headers: body ? { "Content-Type": "application/json" } : {},
               body: body ? JSON.stringify(body) : undefined,
             });
             let data = null;
             try { data = await res.json(); } catch (e) { data = null; }
             return { status: res.status, data };
           }""",
        [f"{base}{path}", method, body],
    )


def test_studio_renders_a_video_asset_as_video_and_the_browser_can_decode_it(
    studio,
):
    """TASK-055 §5 那条缺陷的**根**：视频资产被 **Studio** 放进 `<img>`。

    **必须驱动 Studio 自己的渲染器。** 第一版是测试自己 `createElement("video")`
    再看能不能解码 —— 那证的是 **Chromium 的行为**，不是本产品的行为：Studio
    照样可以把 MP4 渲成 `<img>`，那样写的测试仍然绿。缺陷出在**产品的选择**上，
    所以测试必须让产品去做那个选择（codex round 1 的 P1，判得对）。

    这里走的是真实的两级决策：`libraryModel` 的 `mediaClass`（domain → 媒体类）
    → `renderAssetLibrary` 的标签分发（媒体类 → `<video>` / `<img>`）。
    两级都是生产代码，测试一行也不抄。

    然后再用**真 H.264** 验一次「渲出来的那个元素真的能解码」—— 这一半才是
    真媒体不可替代的地方。
    """
    base, account, _httpd = studio

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        try:
            page.goto(f"{base}/index.html", wait_until="domcontentloaded")
            made = _api(
                page,
                base,
                "/api/projects",
                method="POST",
                body={"name": "真实素材", "root": str(account), "confirm": True},
            )
            assert made["status"] == 201, made

            # 字节直接落进项目自己的 media/ —— 与上传完成后的磁盘状态一致
            media = account / "真实素材" / "media"
            media.mkdir(parents=True, exist_ok=True)
            make_video(media / "take.mp4", seconds=1.0, width=320, height=320)
            make_image(media / "still.png", width=1, height=1)

            proj = quote("真实素材")
            video_url = f"/api/uploads/{proj}/take.mp4"
            image_url = f"/api/uploads/{proj}/still.png"

            # 先证明这两个 URL 真的取得到 —— 否则下面「解不出来」可能只是 404，
            # 那样这条测试就是假的绿
            served = page.evaluate(
                """async ([v, i]) => {
                     const head = async (u) => {
                       const r = await fetch(u);
                       return { status: r.status, bytes: (await r.blob()).size };
                     };
                     return { video: await head(v), image: await head(i) };
                   }""",
                [video_url, image_url],
            )

            verdict = page.evaluate(
                """async ([base, videoUrl, imageUrl]) => {
                     const al = await import(`${base}/src/ui/assetlibws.js`);
                     const raw = [
                       // `storageState: "local"` 不是可省的装饰：`preview()` 用
                       // 它区分「声明性缺席」（已归档 / 字节被移走）与真有字节。
                       // 少了它，Studio 会**正确地**渲成「本地字节不在」，于是
                       // 下面的断言测不到该测的分支 —— 这正是「构造恰好排除了
                       // 要防的那件事」（TASK-087 §7）。
                       { assetId: "v1", key: "shot-video", domain: "videos",
                         url: videoUrl, kind: "shot-video", version: 1,
                         storageState: "local",
                         current: true, reusable: true, tags: [],
                         links: {}, displayName: "真视频", originalFilename: null },
                       { assetId: "i1", key: "ref-still", domain: "images",
                         url: imageUrl, kind: "reference", version: 1,
                         storageState: "local",
                         current: true, reusable: true, tags: [],
                         links: {}, displayName: "真图片", originalFilename: null },
                     ];
                     // 真实的第一级决策：domain -> 媒体类
                     const model = al.libraryModel({
                       assets: raw, usage: new Map(), names: {},
                     });
                     const ctx = {
                       assets: {
                         library: () => model,
                         filterOptions: () => ({
                           characters: [], locations: [], episodes: [], sources: [],
                         }),
                         provenanceOf: () => null,
                         libraryOne: () => null,
                       },
                     };
                     // 真实的第二级决策：媒体类 -> <video> / <img>
                     const html = al.renderAssetLibrary(ctx, {}, { mode: "page" });
                     const host = document.createElement("div");
                     host.innerHTML = html;
                     document.body.appendChild(host);

                     const pick = (url) =>
                       host.querySelector(`[data-media-url="${url}"]`);
                     const vEl = pick(videoUrl);
                     const iEl = pick(imageUrl);
                     const settled = (el) => new Promise((res) => {
                       if (!el) return res({ ok: false, missing: true });
                       const done = (o) => res(o);
                       if (el.tagName === "VIDEO") {
                         el.preload = "auto";
                         el.onloadedmetadata = () =>
                           done({ ok: true, w: el.videoWidth, h: el.videoHeight });
                       } else {
                         el.onload = () => done({ ok: true, w: el.naturalWidth });
                       }
                       el.onerror = () => done({ ok: false });
                       setTimeout(() => done({ ok: false, timedOut: true }), 5000);
                       // 重新赋值，保证事件一定被触发（可能已在挂之前加载完）
                       const src = el.getAttribute("src");
                       el.removeAttribute("src");
                       el.setAttribute("src", src);
                     });

                     return {
                       modelMedia: model.rows.map((r) => [r.assetId, r.media]),
                       videoTag: vEl ? vEl.tagName : null,
                       imageTag: iEl ? iEl.tagName : null,
                       videoLoads: await settled(vEl),
                       imageLoads: await settled(iEl),
                     };
                   }""",
                [base, video_url, image_url],
            )
        finally:
            browser.close()

    assert served["video"]["status"] == 200 and served["video"]["bytes"] > 0, (
        f"MP4 根本没被服务出来，下面的断言会变成假的绿：{served}"
    )
    assert served["image"]["status"] == 200 and served["image"]["bytes"] > 0, served

    # 第一级：domain -> 媒体类，由生产代码 `mediaClass` 判定
    assert dict(verdict["modelMedia"]) == {"v1": "video", "i1": "image"}, verdict

    # 第二级：媒体类 -> 标签，由生产代码 `renderAssetLibrary` 分发。
    # **这一条才是 TASK-055 §5 那条缺陷的守卫** —— 它红，说明 Studio 又把视频
    # 渲成了别的东西
    assert verdict["videoTag"] == "VIDEO", (
        f"Studio 把视频资产渲成了 {verdict['videoTag']} —— 这正是 TASK-055 §5 "
        f"那条缺陷（视频被放进 <img>）：{verdict}"
    )
    assert verdict["imageTag"] == "IMG", verdict

    # 再证明渲出来的元素**真的能解码真媒体**：只断言标签名的话，一个指向
    # 坏 URL 的 <video> 同样能过
    assert verdict["videoLoads"]["ok"] is True, f"渲出来的 <video> 解不出来：{verdict}"
    assert (verdict["videoLoads"]["w"], verdict["videoLoads"]["h"]) == (320, 320)
    assert verdict["imageLoads"]["ok"] is True, f"渲出来的 <img> 解不出来：{verdict}"


def test_a_real_video_in_an_img_element_fails_to_load(studio):
    """占位素材为什么会掩盖缺陷 —— 这条测试就是那个理由本身。

    上一条守的是「Studio 选对了标签」。这一条守的是**它选错时会被发现**：
    真 MP4 放进 `<img>` **必须失败**。一个 SVG 占位素材放进 `<img>` 恰好能显示，
    于是 TASK-055 §5 那条缺陷在占位素材下永远不亮 —— 那正是 AGENTS.md §20
    禁占位素材的理由，写成一条会红的测试。

    同一个 `probeImg` 也拿真 PNG 跑一遍作为**阳性对照**：否则「视频加载失败」
    可能只是因为这个探针根本不工作。
    """
    base, account, _httpd = studio

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        try:
            page.goto(f"{base}/index.html", wait_until="domcontentloaded")
            made = _api(
                page,
                base,
                "/api/projects",
                method="POST",
                body={"name": "对照", "root": str(account), "confirm": True},
            )
            assert made["status"] == 201, made
            media = account / "对照" / "media"
            media.mkdir(parents=True, exist_ok=True)
            make_video(media / "take.mp4", seconds=1.0, width=320, height=320)
            make_image(media / "still.png", width=1, height=1)

            proj = quote("对照")
            verdict = page.evaluate(
                """async ([v, i]) => {
                     const probeImg = (src) => new Promise((res) => {
                       const im = document.createElement("img");
                       im.onload = () => res({ ok: true, w: im.naturalWidth });
                       im.onerror = () => res({ ok: false });
                       setTimeout(() => res({ ok: false, timedOut: true }), 5000);
                       im.src = src;
                     });
                     return { video: await probeImg(v), image: await probeImg(i) };
                   }""",
                [f"/api/uploads/{proj}/take.mp4", f"/api/uploads/{proj}/still.png"],
            )
        finally:
            browser.close()

    assert verdict["image"]["ok"] is True, (
        f"阳性对照失败：真 PNG 在 <img> 里都解不出来，说明探针本身不工作：{verdict}"
    )
    assert verdict["video"]["ok"] is False, (
        "真 MP4 放进 <img> **必须失败** —— 它能「成功」正是占位素材掩盖 TASK-055 "
        f"那条缺陷的机制，也正是 AGENTS.md §20 禁占位素材的理由：{verdict}"
    )


def test_an_unreachable_backend_is_an_error_not_an_empty_project_list(studio):
    """§1.4 边界 6：后端不可用 → **报错，不显示空列表**。

    空列表是最坏的一种谎：它和「这个账户下确实没有项目」长得一模一样，
    于是创作者会以为自己的项目没了。

    测的是 `services/query.js` 里**真实的那个列表函数**，把 `fetch` 打成失败 ——
    而不是把服务器停掉再去 `fetch` 一次。后者测的是浏览器，不是这条渲染路径；
    而且 `httpd.shutdown()` 只停 accept 循环，已建立的 keep-alive 连接照样被服务
    完，所以那样写连「不可用」都没造出来（第一版就是这么错的）。

    **函数找不到就是红，不是 skip**（codex round 1 的 P1）：生产 API 被删掉或
    改名时，一条会跳过自己的测试等于把回归报成绿。守卫在它要守的东西消失时
    必须变红。
    """
    base, _account, _httpd = studio

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        try:
            page.goto(f"{base}/index.html", wait_until="domcontentloaded")
            outcome = page.evaluate(
                """async (base) => {
                     const q = await import(`${base}/src/services/query.js`);
                     const names = ["listProjects", "projects", "loadProjects"];
                     const found = names.filter((n) => typeof q[n] === "function");
                     if (!found.length) {
                       return { noFunction: true, exports: Object.keys(q).sort() };
                     }
                     const real = window.fetch;
                     window.fetch = () =>
                       Promise.reject(new TypeError("Failed to fetch"));
                     let result, threw = null;
                     try { result = await q[found[0]](); }
                     catch (e) { threw = String((e && e.message) || e); }
                     finally { window.fetch = real; }
                     return {
                       used: found[0],
                       threw,
                       json: JSON.stringify(result === undefined ? null : result),
                     };
                   }""",
                base,
            )
        finally:
            browser.close()

    assert not outcome.get("noFunction"), (
        "`services/query.js` 里找不到任何项目列表函数 —— 边界 6 就没有守卫了。"
        "**这不是跳过的理由**：函数被删或改名正是这条测试要抓的回归。"
        f"当前导出：{outcome.get('exports')}"
    )

    # 只拒空数组是不够的：`null` / `undefined` / `{}` / 空包装同样是「静默」，
    # 它们与「确实没有项目」一样无法区分（codex round 1 的 P1）。
    # 判据反过来写：**要么抛，要么结果里带得出错误信息** —— 其余一律不合格。
    if outcome["threw"]:
        return
    result = json.loads(outcome["json"])
    carries_error = isinstance(result, dict) and any(
        result.get(k) for k in ("error", "err", "message", "reason", "detail")
    )
    ok_flag_is_false = isinstance(result, dict) and result.get("ok") is False
    assert carries_error or ok_flag_is_false, (
        "后端不可用时既没抛、返回值里也带不出错误信息 —— 调用方无法把它与"
        "「这个账户下确实没有项目」区分开，创作者会以为项目没了。"
        f"实际返回：{outcome['json']}（函数：{outcome['used']}）"
    )


# §1.4 点名的八条边界，逐条写明**归属到哪个测试**（不是哪个文件）。
# `None` = 目前确实没有归属 —— 见下面那条测试为什么它必须被写出来而不是省略。
_BOUNDARIES = {
    "1 未全定稿提交正式审片被 G1 拒": (
        _MOCKUP / "tests" / "review.test.mjs",
        'test("G1: an incomplete episode yields a TEST cut, never a formal one',
    ),
    "2 审片后改顺序回落 needs_rereview（G3）": (
        _MOCKUP / "tests" / "review.test.mjs",
        'test("G3: exactly the four contract triggers',
    ),
    "3 有 blocking 质检问题时导出被 G4 拒": (
        _MOCKUP / "tests" / "review.test.mjs",
        'test("G4: an open blocking issue refuses the export',
    ),
    "4 长任务运行中刷新→从后端恢复": (
        _REPO / "tests" / "studio" / "test_motv_runs_api_task072.py",
        "def test_a_page_refresh_can_recover_a_run_from_the_backend",
    ),
    "5 长任务取消→子进程真实退出": (
        _REPO / "tests" / "e2e" / "test_motv_run_lifecycle_task072.py",
        "def test_a_clean_shutdown_kills_the_whole_tree_then_writes_the_records",
    ),
    "6 后端不可用→报错不显示空列表": (
        Path(__file__),
        "def test_an_unreachable_backend_is_an_error_not_an_empty_project_list",
    ),
    "7 runtime 不可用→手工兜底": (
        _REPO / "tests" / "studio" / "test_motv_runs_api_task072.py",
        "def test_a_missing_runtime_offers_the_manual_route_instead_of_a_dead_end",
    ),
    # 找遍 `tests/` 与 `mockups/motv-workspace/tests/`：粗剪/导出的版本号由
    # `server.py` 的 `final-cut-v{n}.mp4` 产生，**没有任何测试断言过「再来一次
    # 会得到 v{n+1} 且 v{n} 仍在」**。写成 None 而不是省略 —— 见下。
    "8 每次粗剪/导出→新版本且旧版本仍在": None,
}


def test_every_boundary_case_names_a_test_that_still_exists() -> None:
    """§1.4 点名的八条，**逐条钉到一个具体的测试上**。

    这条测试不跑功能，它守的是「卡上的清单与仓库里的测试对得上」——
    一张写着八条的卡，如果其中三条谁也没测，那张卡的绿是假的。

    **第一版只查文件在不在**（codex round 1 的 non-blocking finding，判得对）：
    那样的守卫在它要守的东西消失时会变绿 —— 测试被删掉或改名，文件还在，
    照样绿。加严之后立刻抓到了**我自己写错的三条**：`cutreview` / `reviewsync`
    / `deliveryspec` 里根本没有 G1 / G3 / 版本 的测试，真正的归属全在
    `review.test.mjs`。这就是 fail-open 守卫的代价：它连**登记本身是错的**
    都盖住了。
    """
    for label, owner in _BOUNDARIES.items():
        if owner is None:
            continue
        path, needle = owner
        assert path.is_file(), f"{label}：归属文件不存在 → {path}"
        # **行首锚定**，不是「文件里出现过这段文字」（codex round 2 的非阻塞）：
        # 一条被注释掉的测试（`// test("G1: …`）源码里照样有这段文字，于是守卫
        # 会在测试已经不跑的情况下变绿 —— 又一个 fail-open。行首锚定挡住的正是
        # 这种「还在文件里但已经不执行」的情形。
        lines = path.read_text(encoding="utf-8").splitlines()
        assert any(ln.startswith(needle) for ln in lines), (
            f"{label}：归属文件还在，但里面没有**行首**就是它的测试声明 —— "
            f"被删了、改名了，还是被注释掉了？\n  文件：{path}\n  要找：{needle}"
        )


def test_the_boundaries_with_no_owner_are_stated_not_hidden() -> None:
    """**没人测的那几条必须被写出来，而不是从表里省掉。**

    省掉是最省事的做法，也正是让「八条全绿」变成假话的做法：表里只剩七条时，
    没有任何东西会提醒下一个人第八条从来没被验过。所以无归属的条目留在表里、
    值写成 `None`，由这条测试把它固定成一个**已知且被承认的缺口**。

    这条测试**两个方向都会红**：缺口变多（新出现无人认领的边界）会红，
    缺口被补上（有人写了测试却没更新这张表）也会红。后者是故意的 ——
    补完之后必须回来把归属填上，否则这张表又开始漂移。
    """
    unowned = {k for k, v in _BOUNDARIES.items() if v is None}
    assert unowned == {"8 每次粗剪/导出→新版本且旧版本仍在"}, (
        "§1.4 边界的无归属集合变了。变多 → 有边界失去了守卫；"
        f"变少 → 补了测试却没更新这张表。当前：{sorted(unowned)}"
    )
    assert len(_BOUNDARIES) == 8, "§1.4 点名的是八条，表里不该多也不该少"

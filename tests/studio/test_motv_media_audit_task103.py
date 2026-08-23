"""服务端媒体审计路由 —— TASK-103 批次 C。

GAP-02 / TASK-083 §5.2 · TASK-087 §4.2 与 §4.3。

TASK-077 用前端 ``HEAD`` 探针解决了显示，代价是一个第三态 ``INCONCLUSIVE``：
服务器拒答、5xx、请求本身炸掉。那是关于**传输**的事实，不是关于项目的事实。
服务端读自己的目录之后，项目媒体只剩「在 / 不在」。

这里守的是那条边界的两端：
- 能答的一定答（含「项目根本没有 media 目录」这种也是答案）；
- **答不了的一个都不许乱答** —— 截断要如实报，ffprobe 缺失要如实报，
  绝不因为工具不在就把尺寸写成 0。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP_DIR))

import server as srv  # noqa: E402  - path injected above


def _app(tmp_path, name="proj-1"):
    app = srv._App(tmp_path / "account")
    root = tmp_path / "proj"
    (root / "media").mkdir(parents=True)
    app._projects[name] = root
    return app, root


def _get(app, path):
    resp = app.handle(path)
    return resp.status, json.loads(resp.body.decode())


def test_unknown_project_is_404_not_an_empty_audit(tmp_path):
    """不认识的项目回 404 —— 不是「审计过了，什么都没有」。

    空审计与「问的是个不存在的项目」长得一样却完全不同：前者会让界面理直气壮地
    说「媒体全丢了」。
    """
    app = srv._App(tmp_path / "account")
    status, body = _get(app, "/api/projects/nope/media-audit")
    assert status == 404
    assert body["error"]["category"] == "not_found"


def test_it_lists_what_is_actually_on_disk_with_real_sizes(tmp_path):
    app, root = _app(tmp_path)
    (root / "media" / "a.png").write_bytes(b"12345")
    (root / "media" / "b.mp4").write_bytes(b"x" * 11)
    (root / "media" / "sub").mkdir()  # 目录不是文件，不进清单

    status, body = _get(app, "/api/projects/proj-1/media-audit")
    assert status == 200
    assert body["dir"] is True
    assert body["truncated"] is False
    assert set(body["files"]) == {"a.png", "b.mp4"}
    assert body["files"]["a.png"]["bytes"] == 5
    assert body["files"]["b.mp4"]["bytes"] == 11


def test_no_media_folder_is_an_answer_not_a_shrug(tmp_path):
    """没有 media 目录 = 这个项目确实没有媒体。是答案，不是「问不出来」。"""
    app = srv._App(tmp_path / "account")
    root = tmp_path / "bare"
    root.mkdir()
    app._projects["proj-1"] = root
    status, body = _get(app, "/api/projects/proj-1/media-audit")
    assert status == 200
    assert body["dir"] is False
    assert body["files"] == {}


def test_truncation_is_reported_never_silent(tmp_path, monkeypatch):
    """超出上限时如实说截断了 —— 静默截断会让「都在」变成「前 N 个都在」。

    TASK-087 §7「no silent caps」：界限本身没问题，**不说**才有问题。
    """
    app, root = _app(tmp_path)
    for i in range(5):
        (root / "media" / f"f{i}.png").write_bytes(b"x")
    monkeypatch.setattr(srv._App, "_MEDIA_AUDIT_MAX", 3, raising=False)
    status, body = _get(app, "/api/projects/proj-1/media-audit")
    assert status == 200
    assert body["truncated"] is True
    assert len(body["files"]) == 3


def test_measure_refuses_a_name_that_is_not_a_plain_file(tmp_path):
    """穿越型文件名不落到磁盘上 —— 它读作「名字不对」，不是「去看看再说」。"""
    app, root = _app(tmp_path)
    (root / "media" / "a.png").write_bytes(b"x")
    for bad in ("../../secret.txt", "a/b.png", ""):
        status, body = _get(
            app,
            f"/api/projects/proj-1/media-audit?measure={bad}"
            if bad
            else "/api/projects/proj-1/media-audit?measure=",
        )
        assert status == 200
        if not bad:
            # 空 measure = 不探测，连 measured 字段都不该出现
            assert "measured" not in body
        else:
            assert body["measured"]["state"] in ("bad_name", "not_found"), body


def test_measure_says_which_way_it_failed(tmp_path):
    """探测的每种结局都有自己的名字。

    「未探测」「文件不在」「没装 ffprobe」「读不出来」会导向完全不同的下一步，
    塌成一个「失败」等于把这条信息扔掉。
    """
    app, root = _app(tmp_path)
    status, body = _get(app, "/api/projects/proj-1/media-audit?measure=ghost.mp4")
    assert status == 200
    assert body["measured"]["state"] == "not_found"

    # 一个存在但不是媒体的文件：ffprobe 在就 unreadable，不在就 no_ffprobe。
    # 两者都是**如实**，都不会给出 0×0。
    (root / "media" / "notmedia.png").write_bytes(b"not really a png")
    status, body = _get(app, "/api/projects/proj-1/media-audit?measure=notmedia.png")
    assert status == 200
    assert body["measured"]["state"] in ("unreadable", "no_ffprobe")
    assert "width" not in body["measured"] or body["measured"].get("width") is None


def test_a_real_file_reports_its_real_size_and_duration(tmp_path):
    """ok 这条路也要被实证 —— 只测失败路径的守卫会漏掉「永远不 ok」这种坏法。

    用 ffmpeg 合成一个 1 秒 320x240 的片子，所以断言的是**真实测量**，不是假件。
    工具缺失时跳过（ADR-0002 第 4 条：CI 不要求真实 FFmpeg）。
    """
    import shutil
    import subprocess

    import pytest

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None or shutil.which("ffprobe") is None:
        pytest.skip("需要真实 ffmpeg/ffprobe")

    app, root = _app(tmp_path)
    out = root / "media" / "clip.mp4"
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=320x240:d=1",
            "-pix_fmt",
            "yuv420p",
            str(out),
        ],
        capture_output=True,
        timeout=120,
    )
    if proc.returncode != 0 or not out.is_file():
        pytest.skip(f"ffmpeg 合成失败：{proc.stderr[:200]!r}")

    status, body = _get(app, "/api/projects/proj-1/media-audit?measure=clip.mp4")
    assert status == 200
    m = body["measured"]
    assert m["state"] == "ok", m
    assert (m["width"], m["height"]) == (320, 240)
    assert 0.5 < m["duration"] < 2.0, m
    # 同一次请求里，清单也给出了真实字节数
    assert body["files"]["clip.mp4"]["bytes"] == out.stat().st_size


def test_the_audit_writes_nothing(tmp_path):
    """只读，且是最强意义上的只读 —— 尤其不碰 ``storageState``。

    把声明与磁盘对齐是一次持久化改动，有它自己的归属（TASK-087 §4.1），
    不许从一个审计路由里顺手做掉。
    """
    app, root = _app(tmp_path)
    (root / "media" / "a.png").write_bytes(b"x")
    before = {p: p.stat().st_mtime_ns for p in root.rglob("*") if p.is_file()}
    _get(app, "/api/projects/proj-1/media-audit")
    _get(app, "/api/projects/proj-1/media-audit?measure=a.png")
    after = {p: p.stat().st_mtime_ns for p in root.rglob("*") if p.is_file()}
    assert before == after

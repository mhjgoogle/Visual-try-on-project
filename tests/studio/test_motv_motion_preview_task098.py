"""TASK-098 白膜视频 —— `/api/agent/motion-preview` 的闸门与真实渲染。

这张卡的两条硬纪律都落在这个文件里：

  §7.2  认不出的运镜**不静默输出一个不动的视频** —— 而明写「固定机位」时
        输出一个不动的视频**是对的**。两个方向都钉（TASK-097 §2.5d）。
  §7.4  FFmpeg 不可用时 fail-closed 并说明原因，**不产出空文件**。

「用生产那一份谓词」在这里的含义：本文件不重写任何判定，它把请求交给
`_agent_motion_preview`（以及它调用的 `_motion_contained`）—— 也就是真正会写文件的
那一份。测试里另写一个等价物，本身就是 §2.5d 点名的那条缝。
"""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

_SERVER_PATH = (
    Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace" / "server.py"
)

_FFMPEG = shutil.which("ffmpeg")
_FFPROBE = shutil.which("ffprobe")
_HAS_FFMPEG = bool(_FFMPEG and _FFPROBE)


@pytest.fixture(scope="module")
def server_module():
    spec = importlib.util.spec_from_file_location("motv_server_motion", _SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def app(server_module, tmp_path: Path, monkeypatch):
    monkeypatch.setattr(server_module, "DATA_DIR", tmp_path / "mockdata")
    account = tmp_path / "account"
    media = account / "proj" / "media"
    media.mkdir(parents=True)
    (account / "proj" / "project.json").write_text(
        json.dumps({"project_id": "proj", "name": "proj"}), "utf-8"
    )
    a = server_module._App(account)
    a._projects["proj"] = account / "proj"
    a._motion_media = media  # type: ignore[attr-defined]
    return a


def _post(app, payload) -> tuple[int, dict]:
    resp = app.handle_post(
        "/api/agent/motion-preview", json.dumps(payload).encode("utf-8")
    )
    return resp.status, json.loads(resp.body.decode("utf-8"))


def _keyframe(app, name: str = "kf-shot-1_v1.png", size: str = "1024x576") -> str:
    """A REAL image file, made with ffmpeg. Not a hand-written stub: the endpoint
    probes the source's pixel size and refuses to guess an aspect ratio, so a
    fake 12-byte 'png' would exercise the refusal path instead of the render."""
    target = app._motion_media / name
    subprocess.run(
        [
            _FFMPEG,
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size={size}:duration=1:rate=1",
            "-frames:v",
            "1",
            str(target),
        ],
        check=True,
        capture_output=True,
    )
    return name


def _spec(**over) -> dict:
    """一份**会动**的合法规格：推近 6 秒。"""
    spec = {
        "fps": 25,
        "frames": 150,
        "zoom": {"from": 1.0, "to": 1.3},
        "center": {"fromX": 0.5, "toX": 0.5, "fromY": 0.5, "toY": 0.5},
        "shake": None,
        "still": False,
    }
    spec.update(over)
    return spec


def _body(app, **over) -> dict:
    body = {
        "project": "proj",
        "slug": "motion-shot-1",
        "image": "kf-shot-1_v1.png",
        "spec": _spec(),
    }
    body.update(over)
    return body


def _outputs(app) -> list[str]:
    return sorted(p.name for p in app._motion_media.glob("motion-*.mp4"))


def _frame(out: Path, n: int, tag: str) -> Path:
    f = out.parent / f"probe-{tag}-{n}.png"
    subprocess.run(
        [
            _FFMPEG,
            "-y",
            "-v",
            "error",
            "-i",
            str(out),
            "-vf",
            r"select=eq(n\," + str(n) + ")",
            "-frames:v",
            "1",
            str(f),
        ],
        check=True,
        capture_output=True,
    )
    return f


def _psnr(a: Path, b: Path) -> float:
    """两张图的 PSNR（dB）。相同 → inf。

    **为什么不是「字节不相等」**：那是本文件第一版的写法，而它区分不了运动和编码
    噪声。实测（2026-08-22，夜班沉默三个真实镜头）：一段**明写固定机位**的预览，
    首帧与末帧的 PNG 字节**也不相等**（PSNR 56 dB —— 肉眼完全相同），而真的在动的
    两段是 10 dB 与 15 dB。所以字节断言对「画面根本没动」这件事**零区分力**：
    白膜静默输出一个不动的视频时，它照样是绿的 —— 正是本卡要防的那件事。
    """
    r = subprocess.run(
        [
            _FFMPEG,
            "-v",
            "info",
            "-i",
            str(a),
            "-i",
            str(b),
            "-lavfi",
            "psnr",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
    )
    text = r.stderr.decode("utf-8", "replace")
    m = re.search(r"average:([0-9.]+|inf)", text)
    assert m, f"psnr 没算出来：{text[-300:]}"
    return float("inf") if m.group(1) == "inf" else float(m.group(1))


def _min_psnr_from_first(out: Path, tag: str, others=(10, 40, 75, 149)) -> float:
    """首帧与若干后续帧之间**最小**的 PSNR —— 运动只要在任何一处出现就算出现。

    取最小值而不是只比首末两帧：微晃是正弦叠加，首帧与末帧**可能刚好都在零点**
    附近，只比这一对会把一段真的在抖的预览读成没动。
    """
    first = _frame(out, 0, tag + "-first")
    return min(_psnr(first, _frame(out, n, tag)) for n in others)


# --- 一、保留命名空间：两个方向 ------------------------------------------------ #


def test_the_preview_output_must_stay_inside_the_reserved_motion_namespace(app):
    """`motion-` 是保留前缀，所以人工上传抢不到白膜预览的版本化文件名。反方向
    同样要挡住：一段预览不许写进 `voice-…` / `final-cut…` 那些链上的版本号。"""
    for squat in ("voice-shot-1", "sfx-shot-1", "final-cut", "mix-shot-1", "anything"):
        status, body = _post(app, _body(app, slug=squat))
        assert status == 400, f"{squat} 被接受了"
        assert "motion-" in body["error"]["detail"]
    # …而一个合法的名字过得了**这一道**（它随后可能因为图不在而失败 —— 那是另一个
    # 诚实的失败，不是这一道闸门）
    status, body = _post(app, _body(app, slug="motion-shot-1"))
    assert status != 400 or "motion-" not in body.get("error", {}).get("detail", "")


def test_the_reserved_prefix_tuple_actually_contains_motion(server_module):
    """`_slug_reserved` 是上传路径读的那一份 —— 前缀加进列表却没被它认出来，
    等于这条命名空间保护从未生效。"""
    assert server_module._slug_reserved("motion-shot-1")
    assert not server_module._slug_reserved("kf-shot-1")


def test_the_route_is_covered_by_the_legacy_migration_gate(server_module):
    """它写 media/ 下的字节，所以未迁移项目的写入闸门必须覆盖它 —— 否则一段预览
    会落进一个 canvas 还在旧位置的项目里。"""
    assert "/api/agent/motion-preview" in server_module._MEDIA_WRITE_ROUTES


# --- 二、「不动」必须是一次声明，不能是一个巧合（§7.2 的服务端那一半）---------- #


def test_a_motionless_spec_that_does_not_declare_itself_still_is_refused(app):
    """**本卡最重要的那一条。**

    「认不出的运镜如实说认不出，不静默输出一个不动的视频」在前端解析器上钉过一次；
    只钉在那里，任何别的调用方都能绕过它 —— 而绕过的产物恰恰是最像成功的那一种：
    一段能播、时长正确、什么都不发生的 mp4。所以这一层再钉一次。"""
    status, body = _post(
        app,
        _body(
            app,
            spec=_spec(
                zoom={"from": 1.0, "to": 1.0},
                center={"fromX": 0.5, "toX": 0.5, "fromY": 0.5, "toY": 0.5},
                still=False,
            ),
        ),
    )
    assert status == 400
    assert "固定机位" in body["error"]["detail"]
    assert _outputs(app) == [], "拒绝的请求不许留下文件"


def test_a_spec_that_declares_itself_still_but_moves_is_refused(app):
    """反过来也是一次分叉：界面告诉创作者「画面不动是对的」，渲出来却在推近。"""
    status, body = _post(app, _body(app, spec=_spec(still=True)))
    assert status == 400
    assert "不动" in body["error"]["detail"]
    assert _outputs(app) == []


@pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
def test_an_explicitly_still_spec_really_does_render(app):
    """**放行那一半**（§2.5d：只钉「会拒绝」的一半，就是在造一个迟早被关掉的闸门）。

    明写「固定机位」时，一段不动的视频就是正确答案 —— 它必须真的渲得出来。"""
    _keyframe(app)
    status, body = _post(
        app,
        _body(
            app,
            spec=_spec(
                zoom={"from": 1.0, "to": 1.0},
                center={"fromX": 0.5, "toX": 0.5, "fromY": 0.5, "toY": 0.5},
                still=True,
            ),
        ),
    )
    assert status == 200, body
    assert body["duration"] == pytest.approx(6.0, abs=0.05)
    assert _outputs(app) == ["motion-shot-1_v1.mp4"]
    # …**而且它真的不动**。这是「会动」那条断言的反方向：两条一起，
    # 「不动」与「在动」才是两个可分辨的结论，而不是同一个恒真的字节比较。
    still = _min_psnr_from_first(app._motion_media / "motion-shot-1_v1.mp4", "still")
    assert still > 40.0, f"声明了固定机位，画面却在动（最小 PSNR {still:.1f}dB）"


# --- 三、包含性：越界不夹回去，直接拒 ----------------------------------------- #


def test_a_pan_wider_than_the_frame_headroom_is_refused_not_clamped(app):
    """越界的后果不是报错：ffmpeg 会把 x/y 静默夹在边界上，于是运动走到一半自己
    停下，而输出仍然是一个「成功」的 mp4。一段会说谎的画面比一次失败坏得多。"""
    status, body = _post(
        app,
        _body(
            app,
            spec=_spec(
                zoom={"from": 1.0, "to": 1.0},  # 没有余量
                center={"fromX": 0.30, "toX": 0.70, "fromY": 0.5, "toY": 0.5},
            ),
        ),
    )
    assert status == 400
    assert "夹住" in body["error"]["detail"]
    assert _outputs(app) == []


def test_the_containment_predicate_pins_both_directions(server_module):
    """`_motion_contained` 是**渲染路径上**那一份判定。两个方向：越界要拒，
    而按余量反算出来的正常幅度**必须放行** —— 挡住正常输入的守卫会被绕开。"""
    contained = server_module._App._motion_contained
    # 余量不足 → 不通过
    assert not contained(1.0, 1.0, 0.4, 0.6, 0.5, 0.5, 0.0)
    # 抖动也吃余量
    assert not contained(1.0, 1.0, 0.5, 0.5, 0.5, 0.5, 0.01)
    # 1/(1-2*0.11) ≈ 1.283，留 1% 安全边 → 通过
    assert contained(1.296, 1.296, 0.39, 0.61, 0.5, 0.5, 0.0)
    # 纯推近（无平移）在 z=1 起步也是合法的：窗口就是整幅画面
    assert contained(1.0, 1.3, 0.5, 0.5, 0.5, 0.5, 0.0)
    # zoom < 1 是放大不了的窗口，一律不通过
    assert not contained(0.9, 1.3, 0.5, 0.5, 0.5, 0.5, 0.0)


# --- 四、输入校验：越界拒绝，不静默替换默认值 --------------------------------- #


@pytest.mark.parametrize(
    "over",
    [
        {"fps": 0},
        {"fps": 61},
        {"frames": 1},
        {"frames": 10**6},
        {"zoom": {"from": 0.5, "to": 1.2}},
        {"zoom": {"from": 1.0, "to": 99.0}},
        {"center": {"fromX": -0.1, "toX": 0.5, "fromY": 0.5, "toY": 0.5}},
        {"shake": {"amp": 0.9}},
        {"shake": 3},
        {"still": "yes"},
        {"zoom": {"from": 10**400, "to": 1.0}},  # float 装不下的整数不许把 handler 打崩
    ],
)
def test_an_out_of_range_spec_field_is_refused(app, over):
    """越界一律拒绝，**不静默夹回范围内** —— 夹回去等于渲出一段与请求不同的运动，
    然后报告成功。

    断言必须指名 `spec.` 那个字段，不能只看 400：本文件第一版只断言状态码，而这些
    用例跑的时候项目里还没有关键帧，于是「把 frames 夹回合法区间」这个变异**照样
    全绿** —— 400 来自随后的「找不到关键帧」，不是这道闸门（TASK-097 §2.5k 第一条
    的同一形状：守卫的构造没让被防的那件事真的发生）。"""
    status, body = _post(app, _body(app, spec=_spec(**over)))
    assert status == 400, over
    assert body["error"]["category"] == "bad_request"
    assert body["error"]["detail"].startswith("spec."), (over, body["error"]["detail"])
    assert _outputs(app) == []


def test_the_length_cap_is_on_the_DURATION_not_on_fps_and_frames_separately(app):
    """codex 轮 2 的 P1：`fps ∈ [12,30]` 与 `frames ∈ [2,1800]` 各自合法，组合起来是
    **150 秒** —— 越过 60 秒那条合同，而且会长时间占住全局那把渲染锁。

    要守的不变量只有一条：`frames / fps <= 60`。两个方向都钉。"""
    # 12fps × 1800 帧 = 150s → 拒
    status, body = _post(app, _body(app, spec=_spec(fps=12, frames=1800)))
    assert status == 400
    assert "上限" in body["error"]["detail"]
    assert _outputs(app) == []
    # 12fps × 720 帧 = 60s → **必须放行**（挡住正常输入的守卫会被绕开）
    status, body = _post(app, _body(app, spec=_spec(fps=12, frames=720)))
    assert status != 400 or "上限" not in body["error"]["detail"], body
    # 25fps × 1501 帧 ≈ 60.04s 仍在容差内；1600 帧 = 64s → 拒
    status, body = _post(app, _body(app, spec=_spec(fps=25, frames=1600)))
    assert status == 400 and "上限" in body["error"]["detail"]


def test_a_missing_keyframe_is_refused_before_any_work(app):
    status, body = _post(app, _body(app, image="kf-does-not-exist_v9.png"))
    assert status == 400
    assert "关键帧" in body["error"]["detail"]
    assert _outputs(app) == []


def test_a_keyframe_path_outside_the_project_media_dir_is_refused(app):
    for bad in ("../secret_v1.png", "kf/../../x_v1.png", "kf_v1.exe", "kf_v1.mp4"):
        status, _ = _post(app, _body(app, image=bad))
        assert status == 400, bad
    assert _outputs(app) == []


# --- 五、FFmpeg 不可用 → fail-closed，不产出空文件（§7.4）--------------------- #


def test_missing_ffmpeg_fails_closed_with_a_reason_and_writes_nothing(
    app, server_module, monkeypatch
):
    """`shutil.which` 解析不到就是解析不到（ADR-0049 第 3 条）。**不裸名调用**，
    也不产出一个零字节的 mp4 让上层以为预览做好了。"""
    if _HAS_FFMPEG:
        _keyframe(app)
    monkeypatch.setattr(server_module.shutil, "which", lambda _n: None)
    status, body = _post(app, _body(app))
    assert status == 503
    assert body["error"]["category"] == "motion_preview_unavailable"
    assert "ffmpeg" in body["error"]["detail"]
    assert _outputs(app) == [], "fail-closed 的路径不许留下任何文件"


# --- 六、真实渲染 ------------------------------------------------------------- #


@pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
@pytest.mark.parametrize(
    ("label", "over"),
    [
        ("推近", {}),
        ("后拉", {"zoom": {"from": 1.3, "to": 1.0}}),
        (
            "向左摇",
            {
                "zoom": {"from": 1.296, "to": 1.296},
                "center": {"fromX": 0.61, "toX": 0.39, "fromY": 0.5, "toY": 0.5},
            },
        ),
        (
            "上摇",
            {
                "zoom": {"from": 1.296, "to": 1.296},
                "center": {"fromX": 0.5, "toX": 0.5, "fromY": 0.61, "toY": 0.39},
            },
        ),
        (
            "手持微晃",
            {
                "zoom": {"from": 1.031, "to": 1.031},
                "center": {"fromX": 0.5, "toX": 0.5, "fromY": 0.5, "toY": 0.5},
                "shake": {"amp": 0.01},
            },
        ),
    ],
)
def test_each_primitive_really_produces_a_moving_video_of_the_right_length(
    app, label, over
):
    """预览时长 == 该镜时长（§9），而且**画面真的在动** —— 一段时长正确但第一帧
    与最后一帧一模一样的视频，正是本卡不许输出的那一种。"""
    _keyframe(app)
    status, body = _post(app, _body(app, spec=_spec(**over)))
    assert status == 200, (label, body)
    out = app._motion_media / "motion-shot-1_v1.mp4"
    assert out.is_file() and out.stat().st_size > 0
    probe = subprocess.run(
        [
            _FFPROBE,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_frames,width,height",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(out),
        ],
        capture_output=True,
        check=True,
    )
    values = probe.stdout.decode("utf-8", "replace").split()
    assert int(values[2]) == 150, f"{label}: 帧数不是 150 → {values}"
    assert float(values[3]) == pytest.approx(6.0, abs=0.05), label
    assert body["duration"] == pytest.approx(6.0, abs=0.05)
    # 静音：白膜不带音轨（§6：配音对齐仍归 TASK-096）
    streams = subprocess.run(
        [
            _FFPROBE,
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(out),
        ],
        capture_output=True,
        check=True,
    )
    assert streams.stdout.decode().split() == ["video"], label
    # **画面真的在动** —— 用像素差衡量，不是字节不相等（见 `_psnr` 的注释：
    # 一段明写固定机位的预览首末帧字节也不相等，那条断言对「没动」零区分力）
    worst = _min_psnr_from_first(out, label)
    assert worst < 30.0, (
        f"{label}: 首帧与后续帧几乎一样（最小 PSNR {worst:.1f}dB）—— 这段预览没有动"
    )


@pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
def test_a_second_preview_appends_a_version_and_never_overwrites(app):
    """AGENTS.md 第 13 条：带版本的新路径，不静默覆盖已有产物。"""
    _keyframe(app)
    first = _post(app, _body(app))
    second = _post(app, _body(app))
    assert first[0] == 200 and second[0] == 200
    assert first[1]["version"] == 1 and second[1]["version"] == 2
    assert _outputs(app) == ["motion-shot-1_v1.mp4", "motion-shot-1_v2.mp4"]
    assert first[1]["url"].endswith("_v1.mp4")
    assert second[1]["url"].endswith("_v2.mp4")


@pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
def test_a_portrait_keyframe_keeps_its_aspect_ratio(app):
    """竖屏短剧：输出比例从**这张图**测出来，不猜一个 16:9 —— 猜错的后果是创作者
    看到的构图不是他那张图的构图。"""
    _keyframe(app, name="kf-portrait_v1.png", size="1080x1920")
    status, body = _post(app, _body(app, image="kf-portrait_v1.png"))
    assert status == 200, body
    assert body["height"] > body["width"], body
    assert body["height"] == 1280


def test_the_prescale_multiplies_both_edges_by_the_same_factor(server_module):
    """codex 轮 3 的 P1：预放尺寸原来是两条边**各自** `min(4096, …)`。zoom 上限 4.0、
    长边输出 1280 → `1280×4 = 5120` 被夹到 4096 而短边没被夹，画面被**横向压扁**。

    这条断言必须打在**判定**上，不能打在输出尺寸上：`width`/`height` 在两种写法下
    都是对的（压扁发生在画面内容里）—— 一条只能靠像素发现的缺陷，要让判定可测。
    两个方向都钉：比例必须守住，而尺寸也确实要被 4096 兜住。"""
    prescale = server_module._App._motion_prescale
    cases = [
        (1280, 544, 4.0),  # 2.35:1，会撞到 4096
        (1280, 720, 4.0),  # 16:9，会撞到
        (544, 1280, 4.0),  # 竖屏，会撞到
        (1280, 720, 1.3),  # 常见量级，撞不到
        (1280, 720, 1.0),
        (720, 1280, 2.35),
    ]
    for out_w, out_h, z_max in cases:
        pre_w, pre_h = prescale(out_w, out_h, z_max)
        want = out_w / out_h
        got = pre_w / pre_h
        # 容差只来自取偶（每条边 ±1px），不来自比例本身
        tol = 2.0 / min(pre_w, pre_h) * max(want, 1)
        assert abs(got - want) <= tol + 1e-9, (
            f"{out_w}x{out_h} @z{z_max}: 预放成 {pre_w}x{pre_h}，"
            f"比例 {got:.4f} != {want:.4f} —— 画面会被压扁"
        )
        # …而尺寸上限仍然生效（一份合法请求不许造出一张巨图）
        assert max(pre_w, pre_h) <= 4096, (out_w, out_h, z_max, pre_w, pre_h)
        # 撞不到上限时，最紧的那一帧应该正好是 1:1（不浪费也不模糊）
        if max(out_w, out_h) * z_max <= 4096:
            assert abs(pre_w - out_w * z_max) <= 2, (out_w, z_max, pre_w)


@pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
@pytest.mark.parametrize("zoom", [{"from": 1.0, "to": 1.3}, {"from": 1.0, "to": 4.0}])
def test_a_high_zoom_request_never_distorts_the_aspect_ratio(app, zoom):
    """codex 轮 3 的 P1：预放尺寸原来是两条边**各自** `min(4096, …)`。zoom 上限 4.0、
    长边输出 1280 → `1280×4 = 5120` 被夹到 4096 而短边没被夹，预览被**横向压扁**，
    而它看起来仍然是一次成功的渲染。一张几何上说谎的画面是本卡最不能出的东西。

    两个 zoom 都跑：一个在夹取门槛之下（前端实际会送的量级），一个在门槛之上。
    输出比例必须始终等于**源图**的比例。"""
    _keyframe(app, name="kf-wide_v1.png", size="1920x816")  # 2.35:1，明显非方
    status, body = _post(
        app,
        _body(app, image="kf-wide_v1.png", spec=_spec(zoom=zoom)),
    )
    assert status == 200, body
    src_ratio = 1920 / 816
    out_ratio = body["width"] / body["height"]
    # 容差来自输出尺寸取偶（±1px），不是来自比例本身
    assert abs(out_ratio - src_ratio) < 0.02, (
        f"输出 {body['width']}x{body['height']} 比例 {out_ratio:.3f}，"
        f"源图 {src_ratio:.3f} —— 预览被压扁了"
    )
    out = app._motion_media / "motion-shot-1_v1.mp4"
    probe = subprocess.run(
        [
            _FFPROBE,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(out),
        ],
        capture_output=True,
        check=True,
    )
    w, h = (int(x) for x in probe.stdout.decode().split()[:2])
    assert abs(w / h - src_ratio) < 0.02, f"文件里的比例也不对：{w}x{h}"


@pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
def test_a_hash_failure_leaves_no_unregistered_file_and_burns_no_version(
    app, server_module, monkeypatch
):
    """codex 轮 3 的 non-blocking：发布之后再算哈希时 `OSError`，`target` 已经在
    media/ 下了 —— 一个没人登记的 mp4 留在那儿，而它占掉的版本号让下一次重试跳号。

    顺序换成「先算哈希再发布」之后，失败时**什么都没发布**，版本号也没被占掉。"""
    _keyframe(app)
    real_open = server_module.open if hasattr(server_module, "open") else open
    calls = {"n": 0}

    def boom(path, *a, **kw):
        # 只让读产物那一次失败（模式是 "rb"），其它 open 照常
        if str(path).endswith("preview.mp4") or str(path).endswith(".mp4"):
            calls["n"] += 1
            raise OSError("simulated read failure")
        return real_open(path, *a, **kw)

    monkeypatch.setattr("builtins.open", boom)
    status, body = _post(app, _body(app))
    monkeypatch.undo()
    assert calls["n"] >= 1, "没有触发到读产物那一步"
    assert status == 502, body
    assert _outputs(app) == [], "失败之后留下了一个没人登记的文件"
    # 而下一次重试拿到的仍然是 v1（版本号没有被那次失败占掉）
    status, body = _post(app, _body(app))
    assert status == 200, body
    assert body["version"] == 1, "上一次失败占掉了 v1"


@pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
def test_a_source_whose_pixel_size_cannot_be_read_is_refused(app):
    """探不到尺寸 → 不渲染。「不知道」不许被当成「大概是 16:9 吧」。"""
    (app._motion_media / "kf-broken_v1.png").write_bytes(b"not a png at all")
    status, body = _post(app, _body(app, image="kf-broken_v1.png"))
    assert status == 502
    assert body["error"]["category"] == "probe_failed"
    assert _outputs(app) == []


# --- 七、「退出码 0」不等于产出了一段能看的视频 -------------------------------- #
#
# 这两条守卫都在 ffmpeg 之后，所以只有让 ffmpeg **真的骗一次**才构造得出被防的那件
# 事。方法论那条 habit 的直接应用：一条守卫的价值等于它的构造能否让被防的那件事真
# 的发生 —— 不等于它的注释说得多准确。


def _lying_ffmpeg(server_module, monkeypatch, *, size: int, probe_duration):
    """让 ffmpeg 报成功、写出一个 `size` 字节的文件；让核对用的 ffprobe 回答
    `probe_duration`。其余 subprocess 调用（尺寸探测）照常走真实进程。"""
    real = server_module.subprocess.run

    class _Fake:
        def __init__(self, code=0, out=b""):
            self.returncode = code
            self.stdout = out
            self.stderr = b""

    def fake(argv, *a, **kw):
        text = " ".join(str(x) for x in argv)
        if "preview.mp4" in text and "format=duration" in text:
            if probe_duration is None:
                return _Fake(1)
            return _Fake(0, str(probe_duration).encode())
        if "-frames:v" in argv:
            Path(argv[-1]).write_bytes(bytes(size))
            return _Fake(0)
        return real(argv, *a, **kw)

    monkeypatch.setattr(server_module.subprocess, "run", fake)


@pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
def test_a_zero_byte_output_is_never_reported_as_a_preview(
    app, server_module, monkeypatch
):
    """§7.4：不产出空文件。零字节的 mp4 同样会带着退出码 0 回来。"""
    _keyframe(app)
    _lying_ffmpeg(server_module, monkeypatch, size=0, probe_duration=6.0)
    status, body = _post(app, _body(app))
    assert status == 502
    assert body["error"]["category"] == "motion_preview_failed"
    assert _outputs(app) == [], "零字节的产物不许被登记成一段预览"


@pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
@pytest.mark.parametrize("got", [3.0, None])
def test_a_preview_whose_length_does_not_match_the_shot_is_not_delivered(
    app, server_module, monkeypatch, got
):
    """§7 / §9：预览时长 == 该镜时长。「给了 N 帧就一定得到 N 帧」是一个断言，
    不是一个事实 —— 核对一次，不对（或读不出）就不交付。"""
    _keyframe(app)
    _lying_ffmpeg(server_module, monkeypatch, size=4096, probe_duration=got)
    status, body = _post(app, _body(app))
    assert status == 502
    assert "时长" in body["error"]["detail"]
    assert _outputs(app) == []


# --- 八、原子替换的临时文件必须与目标同卷（ADR-0049 决策 2）------------------- #


@pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
def test_the_scratch_dir_is_created_inside_the_project_media_dir(
    app, server_module, monkeypatch
):
    """**真实项目抓到的那个缺陷**（2026-08-22）：第一版用系统临时目录，于是仓库在
    D: 而 TEMP 在 C: 的机器上 `os.replace` 直接 OSError —— 照见未明rev2 / 夜班沉默
    上三个真实镜头全部 502。

    测试抓不到它的原因值得记下：`tmp_path` 与被写入的目录在测试里**本来就同卷**，
    所以「渲得出来」在测试机上永远为真。所以这条守卫钉的是**结构**（临时目录建在
    哪儿），不是结果 —— 结果那一条在这台机器上没有区分力。"""
    _keyframe(app)
    seen = []
    real = server_module.tempfile.mkdtemp

    def spy(*a, **kw):
        seen.append(kw.get("dir"))
        return real(*a, **kw)

    monkeypatch.setattr(server_module.tempfile, "mkdtemp", spy)
    status, body = _post(app, _body(app))
    assert status == 200, body
    assert seen, "没有建临时目录？"
    assert seen[-1] == str(app._motion_media), (
        f"临时目录建在 {seen[-1]!r}，不在项目 media/ 下 —— 跨卷 os.replace 会失败"
    )


def test_every_ffmpeg_endpoint_keeps_its_scratch_dir_on_the_destination_volume():
    """**派生守卫**：不是「记得给这一处加 dir=」，而是「这个文件里的每一处都有」。

    五处 ffmpeg 端点里第一版只有本卡这一处漏了 `dir=`。手写清单会漏一项
    （TASK-097 §2.6.1），所以这条守卫扫的是文件本身。唯一的例外是 skill run 的
    工作目录：它不做原子替换、不写项目媒体，理由写在它旁边。"""
    src = _SERVER_PATH.read_text("utf-8")
    calls = [ln.strip() for ln in src.splitlines() if "tempfile.mkdtemp(" in ln]
    assert len(calls) >= 5, calls
    missing = [c for c in calls if "dir=" not in c and "motv-skill-" not in c]
    assert not missing, f"临时目录没落在目标目录里，跨卷 replace 会失败：{missing}"

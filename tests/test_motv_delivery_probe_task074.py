"""TASK-074 §1.2 接线：真实 ffprobe/ffmpeg 测量喂给交付质检。

`workflow/deliveryqc.js` 早就能判音画同步 / 音量 / 削波 / 黑帧 / 缺帧，缺的只是
数字——浏览器跑不了 ffmpeg，所以五项一直渲染成「未检查」。本模块测的是
`_build_delivery_probe`：它把 ffprobe 的 JSON 与 ebur128/blackdetect 的 stderr
翻译成前端要的 `probe`。

**这里的核心断言不是「能解析」，而是「测不出来的一律缺席」**：`deliveryqc` 把
缺失字段渲染成未检查并让 `passed` 保持 false，而编一个数会把「我们没测」变成
创作者屏幕上的「合格」——正是 §1.2 / ADR-0064 决策 6 要防的事。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]
_MOCKUP_DIR = _REPO / "mockups" / "motv-workspace"

_SPEC = importlib.util.spec_from_file_location(
    "motv_server_delivery_probe", _MOCKUP_DIR / "server.py"
)
assert _SPEC and _SPEC.loader
srv = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = srv
_SPEC.loader.exec_module(srv)


def _info(*, video=None, audio=None, fmt=None):
    streams = []
    if video is not None:
        streams.append({"codec_type": "video", **video})
    if audio is not None:
        streams.append({"codec_type": "audio", **audio})
    return {"streams": streams, "format": fmt or {}}


_FULL_VIDEO = {
    "r_frame_rate": "25/1",
    "nb_frames": "250",
    "width": 1920,
    "height": 1080,
    "bit_rate": "4000000",
    "start_time": "0.000000",
}
_FULL_AUDIO = {"bit_rate": "128000", "start_time": "0.000000"}
_EBUR128_TAIL = """
[Parsed_ebur128_0 @ 000] Summary:

  Integrated loudness:
    I:         -18.4 LUFS
    Threshold: -28.6 LUFS

  True peak:
    Peak:       -1.5 dBFS
"""


def test_a_complete_scan_yields_every_field_deliveryqc_reads() -> None:
    probe = srv._build_delivery_probe(
        _info(video=_FULL_VIDEO, audio=_FULL_AUDIO, fmt={"duration": "10.0"}),
        _EBUR128_TAIL,
    )

    assert probe["durationS"] == 10.0
    assert probe["fps"] == 25.0
    assert probe["frameCount"] == 250
    assert probe["resolution"] == "1920x1080"
    assert probe["videoBitrateKbps"] == 4000
    assert probe["audioBitrateKbps"] == 128
    assert probe["avOffsetMs"] == 0
    assert probe["lufs"] == -18.4
    assert probe["truePeakDbtp"] == -1.5
    assert probe["blackSpans"] == []


@pytest.mark.parametrize(
    ("field", "info", "stderr"),
    [
        # ffprobe emits "N/A" freely; it must not become 0.
        ("fps", _info(video={"r_frame_rate": "N/A"}, fmt={"duration": "5"}), ""),
        ("frameCount", _info(video={"nb_frames": "N/A"}, fmt={"duration": "5"}), ""),
        ("durationS", _info(video={"r_frame_rate": "25/1"}, fmt={}), ""),
        (
            "resolution",
            _info(video={"width": 0, "height": 0}, fmt={"duration": "5"}),
            "",
        ),
        # no ebur128 summary in the output at all
        ("lufs", _info(video=_FULL_VIDEO, audio=_FULL_AUDIO), "no summary here"),
        ("truePeakDbtp", _info(video=_FULL_VIDEO, audio=_FULL_AUDIO), "nothing"),
    ],
)
def test_an_unmeasured_field_is_absent_never_zero(field, info, stderr) -> None:
    """缺席 → deliveryqc 报「未检查」；填 0 → 报「合格」。两者天差地别。"""
    assert field not in srv._build_delivery_probe(info, stderr)


def test_a_missing_stream_leaves_the_offset_absent_rather_than_zero() -> None:
    """只有一条流时「偏移 0ms」是编的——没有第二条流可比。"""
    only_video = srv._build_delivery_probe(_info(video=_FULL_VIDEO), "")
    assert "avOffsetMs" not in only_video

    no_start = srv._build_delivery_probe(
        _info(video={"r_frame_rate": "25/1"}, audio={"bit_rate": "128000"}), ""
    )
    assert "avOffsetMs" not in no_start


def test_the_offset_is_signed_and_in_milliseconds() -> None:
    probe = srv._build_delivery_probe(
        _info(video={"start_time": "0.200000"}, audio={"start_time": "0.000000"}), ""
    )
    assert probe["avOffsetMs"] == 200


def test_fractional_frame_rates_are_divided_out_not_rounded_up() -> None:
    """29.97 与 30 的差别会被缺帧检查放大成「少了几十帧」。"""
    probe = srv._build_delivery_probe(
        _info(video={"r_frame_rate": "30000/1001"}, fmt={"duration": "10"}), ""
    )
    assert probe["fps"] == pytest.approx(29.97, abs=0.001)


def test_a_zero_denominator_frame_rate_is_absent_not_an_exception() -> None:
    assert "fps" not in srv._build_delivery_probe(
        _info(video={"r_frame_rate": "25/0"}, fmt={"duration": "10"}), ""
    )


def test_black_spans_are_parsed_with_their_durations() -> None:
    stderr = (
        "[blackdetect @ 0] black_start:1.5 black_end:3.0 black_duration:1.5\n"
        "[blackdetect @ 0] black_start:8.25 black_end:9.0 black_duration:0.75\n"
    )
    spans = srv._build_delivery_probe(_info(video=_FULL_VIDEO), stderr)["blackSpans"]

    assert [s["durationS"] for s in spans] == [1.5, 0.75]
    assert spans[0]["startS"] == 1.5
    assert spans[1]["endS"] == 9.0


def test_no_video_stream_means_unchecked_black_frames_not_a_clean_bill() -> None:
    """空列表是「测过，没黑帧」；没有视频流时那是「没得测」，不能说干净。"""
    assert "blackSpans" not in srv._build_delivery_probe(_info(audio=_FULL_AUDIO), "")


def test_the_integrated_summary_wins_over_ebur128_running_values() -> None:
    """ebur128 扫描途中会不断打印瞬时值，取第一个就会把中途某一刻当成整片响度。"""
    stderr = (
        "[Parsed_ebur128_0 @ 0] t: 1.0    I:         -30.0 LUFS\n"
        "[Parsed_ebur128_0 @ 0] t: 2.0    I:         -25.0 LUFS\n" + _EBUR128_TAIL
    )
    probe = srv._build_delivery_probe(_info(video=_FULL_VIDEO), stderr)

    assert probe["lufs"] == -18.4


def test_garbage_input_yields_an_empty_probe_rather_than_raising() -> None:
    """探测端点把它的结果直接交给这个函数；一个畸形的 ffprobe 输出应当变成
    「什么都没测出来」，而不是 500。"""
    for junk in (None, [], "nope", {"streams": "not a list"}, {"format": 7}):
        assert srv._build_delivery_probe(junk, None) == {}

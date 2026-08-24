"""合成但**真实**的媒体素材 —— 用 ffmpeg 生成真的容器与编码。

AGENTS.md §20 禁的是「demo seed 与 **SVG 占位素材**不作为主要验收依据」，
理由写得很具体（TASK-055 §5）：占位素材**不像真媒体那样行为**，于是它掩盖了
「视频资产被放进 `<img>`」这一类缺陷 —— 一个 SVG 放进 `<img>` 恰好能显示。

这个模块生成的不是占位素材，是**真的 MP4 / PNG / WAV**：真容器、真编码、真时长、
真尺寸、真 magic bytes。它们会走 magic-byte 嗅探、`ffprobe` 探测、`<video>` 解码
这些**只有真媒体才走得到**的代码路径。

**它证明什么、不证明什么，说清楚**：

| 能证 | 不能证 |
| --- | --- |
| 闸门与状态机（G1/G3/G4、审片回落、版本累积） | 产出好不好看 —— 那是产品负责人的判断 |
| 刷新恢复、取消真的杀掉子进程 | 创作流程用起来顺不顺手 |
| 浏览器媒体行为（`seeked` 派不派发） | 真素材才有的形状（怪码率、坏文件） |
| ffprobe 读出的时长/尺寸与登记是否一致 | 产品负责人自己那一集的真实数据 |

换句话说：**机械的那一半可以用它验完，判断的那一半仍然要人**。
"""

from __future__ import annotations

import functools
import shutil
import subprocess
from pathlib import Path

#: 一个 1x1 PNG 的真实字节（不是 SVG）——magic bytes 正确，解码得出来。
PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6360000002000100ffff03000006000557bfabd400"
    "00000049454e44ae426082"
)


def ffmpeg() -> str | None:
    """`shutil.which` 解析，失败即 None —— 不裸名调用（AGENTS.md §6）。"""
    return shutil.which("ffmpeg")


@functools.lru_cache(maxsize=1)
def have_ffmpeg() -> bool:
    """有没有 ffmpeg，**并且**它带得动 `libx264`。

    只查可执行文件存在是不够的（codex round 2 的非阻塞，判得对）：
    `make_video` 硬依赖 `libx264`，而**合法的 ffmpeg 构建可以不含它**
    （发行版为了许可证常这么切）。那样只查存在的话，测试不会诚实地跳过，
    而是在 ffmpeg 报错时以一个看不懂的方式失败 —— 把「这台机器造不出真媒体」
    误报成「产品坏了」。

    查得到编码器才算有。查不动（超时、旧版本不认这个子命令）时返回 False：
    **fail-closed** —— 宁可跳过并说清楚，也不要跑出一个含义不明的红。
    """
    exe = ffmpeg()
    if exe is None:
        return False
    try:
        out = subprocess.run(
            [exe, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return "libx264" in (out.stdout or "")


def make_video(
    path: Path,
    *,
    seconds: float = 1.0,
    width: int = 320,
    height: int = 320,
    fps: int = 24,
    colour: str = "black",
) -> Path:
    """一个真的 H.264 MP4。

    `+faststart` 让 moov 在前 —— 浏览器边下边播要的就是这个，而它也正是
    「真媒体与占位素材行为不同」的一个具体来源。
    """
    exe = ffmpeg()
    if exe is None:
        raise RuntimeError("ffmpeg 不在 PATH 上")
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            exe,
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c={colour}:s={width}x{height}:r={fps}:d={seconds}",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path


def make_audio(path: Path, *, seconds: float = 1.0, hz: int = 440) -> Path:
    """一个真的 WAV（真采样率、真时长）。"""
    exe = ffmpeg()
    if exe is None:
        raise RuntimeError("ffmpeg 不在 PATH 上")
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            exe,
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={hz}:duration={seconds}",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path


def make_image(path: Path, *, width: int = 320, height: int = 320) -> Path:
    """一个真的 PNG。1x1 那份常量够用时就用它，省一次进程。"""
    if width == 1 and height == 1:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(PNG_1X1)
        return path
    exe = ffmpeg()
    if exe is None:
        raise RuntimeError("ffmpeg 不在 PATH 上")
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            exe,
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c=gray:s={width}x{height}:d=1",
            "-frames:v",
            "1",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path

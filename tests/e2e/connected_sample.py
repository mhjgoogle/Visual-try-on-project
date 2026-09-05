"""可重复的 Connected Project 样本 —— 后端那一半（TASK-130 / 收敛审查 §5.E）。

§5.E 要「干净机器仅凭仓库内容就能复现主要 UI 状态」，并且「媒体应小而真实，不能用
SVG / 空 JSON 冒充」。这份模块在一个**真后端**上把样本项目造出来：

    1. `POST /api/projects` 创建 / 连接项目（与创作者点出来的那条路一致）；
    2. 让 node 跑 `fixtures/connected_sample.mjs` —— 画布由**前端自己的域 API** 造并
       自检，Python 不手写一个字节的画布；
    3. 生成器说要哪些媒体文件，就用 ffmpeg 生成**真 H.264 / 真 WAV / 真 PNG**
       （`assets_synthetic`），名字 = assetId，两边不用对表；
    4. `PUT /api/canvas/<项目>`；
    5. 账户级 feedback.json 里种一条**未决提案**（走服务端自己的
       `_load_feedback / _save_feedback`）；
    6. 把 `_run_executor` 换成一个**卡在 Event 上**的桩，然后发一句对话 —— 于是线程里
       有问没答、runs 注册表里有一条 running；`release()` 之后它才回答。这是「刷新之后
       接回还在跑的那一轮」（TASK-106 / ADR-0095）在真浏览器里能被验到的唯一办法：
       让它真的还在跑。

没有 ffmpeg / node 就 `skip` 并说明，不伪装（`CA §5.3`）。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

import pytest

from tests.e2e.assets_synthetic import have_ffmpeg, make_audio, make_image, make_video

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP = _REPO / "mockups" / "motv-workspace"
_GENERATOR = _MOCKUP / "fixtures" / "connected_sample.mjs"

SAMPLE_NAME = "样本 · 迷雾入城"
RUNTIME_HEADER = {"X-Motv-Runtime": "1"}


def api(page, base, path, *, method="GET", body=None, headers=None):
    """在**页面里**发请求 —— 同源，与创作者点出来的那条路一致。

    与 task074 e2e 用的是同一个帮手；多了 `headers`，因为对话那条路要 CSRF 头。
    """
    return page.evaluate(
        """async ([url, method, body, headers]) => {
             const res = await fetch(url, {
               method,
               headers: {
                 ...(body ? { "Content-Type": "application/json" } : {}),
                 ...(headers || {}),
               },
               body: body ? JSON.stringify(body) : undefined,
             });
             let data = null;
             try { data = await res.json(); } catch (e) { data = null; }
             return { status: res.status, data };
           }""",
        [f"{base}{path}", method, body, headers or {}],
    )


def _generate_canvas(name: str) -> dict:
    node = shutil.which("node")
    if not node:
        pytest.skip("node 不在 PATH 上：画布只能由拥有它的运行时造")
    url = _GENERATOR.resolve().as_uri()
    code = (
        f"import('{url}').then(m => process.stdout.write("
        f"JSON.stringify(m.buildConnectedSample({json.dumps(name)}))))"
        ".catch(e => { process.stderr.write(String(e && e.stack || e));"
        " process.exit(2); })"
    )
    out = subprocess.run(
        [node, "--input-type=module", "-e", code],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        cwd=str(_MOCKUP),
    )
    assert out.returncode == 0, f"样本画布造不出来：{out.stderr[-800:]}"
    return json.loads(out.stdout)


def _write_media(media_dir: Path, items: list[dict]) -> int:
    media_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    for it in items:
        target = media_dir / it["name"]
        domain = it["domain"]
        if domain == "images":
            make_image(target, width=320, height=320)
        elif domain == "audio":
            make_audio(target, seconds=float(it.get("seconds") or 1.0), hz=440)
        else:
            # videos / finals —— 320x320 @ 24fps：与样本 deliverySpec（1080x1920 @ 30）
            # **必然不符**，交付质检的「规格」行因此阻断 —— 旅程里 G4 拒绝导出的真实来源
            make_video(
                target, seconds=float(it.get("seconds") or 1.0), width=320, height=320
            )
        n += 1
    return n


@dataclass
class HeldExecutor:
    """一个卡在 Event 上的执行器桩。

    `release()` 之前它「还在想」，之后回一段合法 JSON。
    """

    gate: threading.Event = field(default_factory=threading.Event)
    calls: int = 0
    reply: str = '{"reply": "样本的回答：我看到了故事核心，先不改。", "edits": []}'

    def __call__(self, name, prompt, timeout, on_spawn=None):
        self.calls += 1
        # 真执行器会阻塞在子进程上；这里阻塞在 Event 上 —— 形状一样，可控。
        if not self.gate.wait(timeout=float(timeout or 120)):
            raise subprocess.TimeoutExpired(cmd=name, timeout=timeout)
        return (self.reply, "sample-executor")

    def release(self):
        self.gate.set()


@dataclass
class Sample:
    name: str
    root: Path
    media_dir: Path
    active_episode_id: str
    cut_asset_id: str
    final_asset_id: str
    run_id: str | None
    executor: HeldExecutor
    media_files: int
    shots: int

    def release(self):
        self.executor.release()


def build_connected_sample(
    srv, monkeypatch, page, base: str, account: Path, *, name: str = SAMPLE_NAME
) -> Sample:
    if not have_ffmpeg():
        pytest.skip("ffmpeg 不在 PATH 上：这份样本要的是真媒体")

    # 1. 连接项目
    made = api(
        page,
        base,
        "/api/projects",
        method="POST",
        body={"name": name, "root": str(account), "confirm": True},
    )
    assert made["status"] == 201, made

    # 2. 画布（前端造、前端自检）
    gen = _generate_canvas(name)
    canvas = gen["canvas"]
    root = account / name
    media_dir = root / "media"

    # 3. 真媒体，名字 = assetId
    media_files = _write_media(media_dir, gen["media"])

    # 4. 画布落盘（走 API，不直接写文件 —— 与页面保存走同一条路）
    put = api(page, base, f"/api/canvas/{quote(name)}", method="PUT", body=canvas)
    assert put["status"] in (200, 204), put

    finals = canvas["assets"]["finals"]
    cut = next(f for f in finals if f.get("kind") == "cut")
    final = next(f for f in finals if f.get("kind") == "final")

    # 5. 一条未决提案（账户级台账；服务端自己的读写函数，不手拼文件）
    doc = srv._load_feedback()
    doc["proposals"].append(
        {
            "id": len(doc["proposals"]) + 1,
            "createdAt": "2026-09-05T00:00:00+00:00",
            "title": "样本提案：把制作画布的镜头卡缩略图接上关键帧",
            "body": (
                "候选做法：卡片 poster 取该镜最新已批准的关键帧；"
                "没有关键帧时显示原因，不用通用图标。"
            ),
            "decision": None,
            "fromRun": None,
            "devRun": None,
            "pending": False,
        }
    )
    assert srv._save_feedback(doc), "feedback.json 写不进去"

    # 6. 一条**还在跑**的对话：执行器卡在 Event 上
    held = HeldExecutor()
    monkeypatch.setattr(srv, "_run_executor", held)
    sent = api(
        page,
        base,
        f"/api/projects/{quote(name)}/conversation",
        method="POST",
        # 线程按**页面**分（REQ-004 v3），键来自 `context.module`（`_conv_key`）——
        # 第一版写成 `page`，那一轮就落到了另一条线上，故事核心那一页看到的是
        # 「还没有对话」。
        body={
            "message": "帮我看一眼故事核心，先别改。",
            "context": {"module": "brief", "space": "story", "intent": "work"},
        },
        headers=RUNTIME_HEADER,
    )
    assert sent["status"] == 202, sent
    run_id = ((sent.get("data") or {}).get("run") or {}).get("run_id")

    return Sample(
        name=name,
        root=root,
        media_dir=media_dir,
        active_episode_id=gen["activeEpisodeId"],
        cut_asset_id=cut["assetId"],
        final_asset_id=final["assetId"],
        run_id=run_id,
        executor=held,
        media_files=media_files,
        shots=int(gen.get("draftShots") or 0),
    )

"""motv 音频生产 + 轻量时间线 + 最终导出 + 存储管理 — checkpoint M11.

Drives the mockup backend (``mockups/motv-workspace/server.py`` ``_App``)
directly — no sockets, no browser, STRICTLY OFFLINE, no spend (the render
path uses LOCAL ffmpeg only and is skipped when ffmpeg is absent).

Covers:

- the frontend units (voice identity rule, dialogue prompt, ambience/BGM as
  reused references, timeline reference-only clips + edit ops + reload,
  Remove-Local-Copy / permanent-delete semantics, v9 schema) via
  ``node --test tests/av.test.mjs``;
- the render endpoint's fail-closed validation: bad JSON/shape, clip caps,
  path traversal / symlink refusal on clip files, honest 503 without ffmpeg;
- a REAL local ffmpeg render (tiny lavfi clips) producing an atomically
  versioned ``render-ep-v<N>``: two renders never share a version number and
  nothing is overwritten;
- the delete-file endpoint: byte deletion only (registry semantics stay with
  the client), containment discipline, already-gone-is-done idempotency;
- reserved output namespaces (``final-cut``/``render-ep``) refused for
  ordinary uploads;
- the Core contract untouched (all of this is mockup-side).
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

import pytest

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"
_SERVER_PATH = _MOCKUP_DIR / "server.py"

PNG = b"\x89PNG\r\n\x1a\n" + b"png-payload"


@pytest.fixture(scope="module")
def server_module():
    spec = importlib.util.spec_from_file_location("motv_server_m11", _SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def data_dir(server_module, tmp_path: Path, monkeypatch) -> Path:
    d = tmp_path / "mockdata"
    d.mkdir()
    monkeypatch.setattr(server_module, "DATA_DIR", d)
    return d


def _post(app, path: str, payload) -> tuple[int, dict]:
    body = (
        payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
    )
    resp = app.handle_post(path, body)
    return resp.status, json.loads(resp.body.decode("utf-8"))


def _ffmpeg() -> str | None:
    return shutil.which("ffmpeg")


def _make_media(updir: Path) -> None:
    """Two tiny REAL clips via lavfi — a 1s video and a 1s sine wav."""
    updir.mkdir(parents=True, exist_ok=True)
    subprocess.run(  # noqa: S603 - fixed argv, local ffmpeg
        [
            _ffmpeg(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=1:size=160x90:rate=10",
            "-pix_fmt",
            "yuv420p",
            str(updir / "video-a_v1.mp4"),
        ],
        check=True,
        capture_output=True,
        timeout=120,
    )
    subprocess.run(  # noqa: S603
        [
            _ffmpeg(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            str(updir / "audio-d1_v1.wav"),
        ],
        check=True,
        capture_output=True,
        timeout=120,
    )


# --- frontend units ----------------------------------------------------------


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_frontend_av_units_via_node() -> None:
    """M11 音频/时间线/存储 域与 v9 schema 的前端单测。"""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--test", "tests/av.test.mjs"],
        cwd=str(_MOCKUP_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


# --- render endpoint: fail-closed validation ---------------------------------


def test_render_rejects_bad_payloads(server_module, data_dir, monkeypatch) -> None:
    # a fake ffmpeg path so validation is exercised even without ffmpeg —
    # every case below fails clip validation BEFORE any subprocess runs
    import shutil as _sh

    monkeypatch.setattr(_sh, "which", lambda _n: "/bin/false")
    app = server_module._App(None, None)
    status, j = _post(app, "/api/agent/render-episode", b"{not json")
    assert status == 400
    status, j = _post(
        app, "/api/agent/render-episode", {"project": "../evil", "clips": [{}]}
    )
    assert status == 400
    status, j = _post(
        app, "/api/agent/render-episode", {"project": "proj", "clips": []}
    )
    assert status == 400
    assert "1-120" in j["error"]["detail"]
    status, j = _post(
        app,
        "/api/agent/render-episode",
        {
            "project": "proj",
            "clips": [{"track": "hologram", "file": "x.mp4", "in": 0, "out": 1}],
        },
    )
    assert status == 400


@pytest.mark.skipif(_ffmpeg() is None, reason="ffmpeg not available")
def test_render_rejects_over_one_hour_total(
    server_module, data_dir, monkeypatch
) -> None:
    # total synthesized picture length is bounded to 1h — tpad materializes the
    # full planned duration of every segment, so a huge sum is a DoS vector.
    # The cap fires after file resolution but before any subprocess, so a fake
    # ffmpeg suffices (files must exist to pass resolution).
    import shutil as _sh

    updir = data_dir / "uploads" / "proj"
    _make_media(updir)
    monkeypatch.setattr(_sh, "which", lambda _n: "/bin/false")
    app = server_module._App(None, None)
    status, j = _post(
        app,
        "/api/agent/render-episode",
        {
            "project": "proj",
            "clips": [
                {"track": "video", "file": "video-a_v1.mp4", "in": 0, "out": 2000},
                {"track": "video", "file": "video-a_v1.mp4", "in": 0, "out": 2000},
            ],
        },
    )
    assert status == 400
    assert "1 小时" in j["error"]["detail"]
    # and the output-WORK budget (pixels × fps × seconds): 4K60 for the full
    # hour is refused even though each check above would pass individually
    status, j = _post(
        app,
        "/api/agent/render-episode",
        {
            "project": "proj",
            "settings": {"width": 3840, "height": 2160, "fps": 60, "format": "mp4"},
            "clips": [
                {"track": "video", "file": "video-a_v1.mp4", "in": 0, "out": 1800},
                {"track": "video", "file": "video-a_v1.mp4", "in": 0, "out": 1800},
            ],
        },
    )
    assert status == 400
    assert "渲染规模超限" in j["error"]["detail"]
    # out-of-range settings are REJECTED, never silently defaulted — the render
    # must never disagree with the settings the caller recorded (M11 review)
    status, j = _post(
        app,
        "/api/agent/render-episode",
        {
            "project": "proj",
            "settings": {"width": 99999, "height": 720, "fps": 25, "format": "mp4"},
            "clips": [{"track": "video", "file": "video-a_v1.mp4", "in": 0, "out": 1}],
        },
    )
    assert status == 400
    assert "invalid width" in j["error"]["detail"]
    status, j = _post(
        app,
        "/api/agent/render-episode",
        {
            "project": "proj",
            "settings": {"width": 1280, "height": 720, "fps": 100, "format": "mp4"},
            "clips": [{"track": "video", "file": "video-a_v1.mp4", "in": 0, "out": 1}],
        },
    )
    assert status == 400
    assert "invalid fps" in j["error"]["detail"]
    # present-but-invalid clip numeric fields are REJECTED, never silently
    # defaulted (else the render/provenance disagree with the snapshot)
    for field, val, tag in [
        ("volume", -1, "bad volume"),
        ("volume", 9, "bad volume"),
        ("start", "x", "bad start"),
        ("fadeIn", -0.5, "bad fadeIn"),
        ("in", float("inf"), "bad in"),
    ]:
        clip = {"track": "video", "file": "video-a_v1.mp4", "in": 0, "out": 1}
        clip[field] = val
        status, j = _post(
            app,
            "/api/agent/render-episode",
            {"project": "proj", "clips": [clip]},
        )
        assert status == 400, (field, val)
        assert tag in j["error"]["detail"], (field, val, j)


def test_render_refuses_traversal_and_symlinked_clip_files(
    server_module, data_dir, monkeypatch
) -> None:
    # same fake-ffmpeg trick: every refusal happens at file RESOLUTION,
    # before any subprocess — so this guard is tested even without ffmpeg
    import shutil as _sh

    monkeypatch.setattr(_sh, "which", lambda _n: "/bin/false")
    updir = data_dir / "uploads" / "proj"
    updir.mkdir(parents=True)
    secret = data_dir / "secret.mp4"
    secret.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"\x00" * 16)
    (updir / "link.mp4").symlink_to(secret)
    app = server_module._App(None, None)
    for name in (
        "../secret.mp4",
        "/etc/passwd",
        "link.mp4",
        "nope.mp4",
        "video-a_v1.txt",
    ):
        status, j = _post(
            app,
            "/api/agent/render-episode",
            {
                "project": "proj",
                "clips": [{"track": "video", "file": name, "in": 0, "out": 1}],
            },
        )
        assert status == 400, name
        assert "missing" in j["error"]["detail"] or "bad" in j["error"]["detail"]
    assert secret.exists()  # nothing outside the project dir was touched


def test_render_honest_503_without_ffmpeg(server_module, data_dir, monkeypatch) -> None:
    updir = data_dir / "uploads" / "proj"
    updir.mkdir(parents=True)
    import shutil as _sh

    monkeypatch.setattr(_sh, "which", lambda _n: None)
    app = server_module._App(None, None)
    status, j = _post(
        app,
        "/api/agent/render-episode",
        {
            "project": "proj",
            "clips": [{"track": "video", "file": "video-a_v1.mp4", "in": 0, "out": 1}],
        },
    )
    assert status == 503
    assert j["error"]["category"] == "render_unavailable"


# --- render endpoint: real local render, atomic versioning -------------------


@pytest.mark.skipif(_ffmpeg() is None, reason="ffmpeg not available")
def test_real_render_versions_atomically_and_never_overwrites(
    server_module, data_dir
) -> None:
    updir = data_dir / "uploads" / "proj"
    _make_media(updir)
    app = server_module._App(None, None)
    payload = {
        "project": "proj",
        "settings": {"width": 160, "height": 90, "fps": 10, "format": "mp4"},
        "clips": [
            {"track": "video", "file": "video-a_v1.mp4", "in": 0, "out": 1},
            {
                "track": "dialogue",
                "file": "audio-d1_v1.wav",
                "in": 0,
                "out": 1,
                "start": 0.2,
                "volume": 0.8,
                "fadeIn": 0.1,
                "fadeOut": 0.1,
            },
            # a muted clip is honestly skipped, never silently mixed
            {
                "track": "bgm",
                "file": "audio-d1_v1.wav",
                "in": 0,
                "out": 1,
                "muted": True,
            },
        ],
    }
    status, j1 = _post(app, "/api/agent/render-episode", payload)
    assert status == 200, j1
    assert j1["version"] == 1
    assert j1["clips"] == 2  # video + dialogue; muted bgm skipped
    out1 = updir / "render-ep-v1.mp4"
    assert out1.is_file() and out1.stat().st_size > 0
    bytes1 = out1.read_bytes()
    # second render claims v2 — v1 is never overwritten
    status, j2 = _post(app, "/api/agent/render-episode", payload)
    assert status == 200, j2
    assert j2["version"] == 2
    assert out1.read_bytes() == bytes1
    assert (updir / "render-ep-v2.mp4").is_file()
    # render workdir cleaned up
    assert not any(p.name.startswith("motv-render-") for p in updir.iterdir())


@pytest.mark.skipif(
    _ffmpeg() is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not available",
)
def test_render_forces_planned_segment_length_keeping_av_in_sync(
    server_module, data_dir
) -> None:
    """A video trimmed BEYOND its 1s source must still occupy its full planned
    window (tpad clones the last frame) so concat placement matches the audio
    delays — no A/V desync after short clips (M11 review)."""
    updir = data_dir / "uploads" / "proj"
    _make_media(updir)  # video-a_v1.mp4 is exactly 1s
    app = server_module._App(None, None)
    payload = {
        "project": "proj",
        "settings": {"width": 160, "height": 90, "fps": 10, "format": "mp4"},
        "clips": [
            # two segments, each PLANNED at 2s but sourced from a 1s clip
            {"track": "video", "file": "video-a_v1.mp4", "in": 0, "out": 2},
            {"track": "video", "file": "video-a_v1.mp4", "in": 0, "out": 2},
        ],
    }
    status, j = _post(app, "/api/agent/render-episode", payload)
    assert status == 200, j
    out = updir / f"render-ep-v{j['version']}.mp4"
    probe = subprocess.run(  # noqa: S603 - fixed argv, local ffprobe
        [
            shutil.which("ffprobe"),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            str(out),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    dur = float(probe.stdout.strip())
    # two 2s planned segments → ~4s, NOT the ~2s a naive concat of 1s sources
    # would produce; a wide tolerance keeps this robust to codec padding
    assert 3.5 <= dur <= 4.6, f"expected ~4s forced-length render, got {dur}"


# --- TTS voice-model selection (M11 voice-identity rule) ----------------------


def test_tts_voice_param_validated_and_falls_back_honestly(
    server_module, data_dir, monkeypatch
) -> None:
    """A `voice` names a per-character local model; a bad name is refused, and
    an absent model falls back to the default (response.voice=None) — never a
    fabricated claim of a voice it didn't render (M11 voice rule)."""
    # a fake piper that just writes a minimal WAV so the route reaches the end
    fake = data_dir / "fakepiper.sh"
    # emit a >44-byte WAV starting with RIFF (the route's validity check)
    fake.write_text(
        '#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do\n'
        ' [ "$1" = "-f" ] && out="$2";\n shift\ndone\n'
        'printf "RIFF" > "$out"\n'
        'dd if=/dev/zero bs=1 count=64 >> "$out" 2>/dev/null\n'
    )
    fake.chmod(0o755)
    (data_dir / "tts").mkdir(parents=True, exist_ok=True)
    (data_dir / "tts" / "zh_CN-huayan-medium.onnx").write_bytes(b"model")
    monkeypatch.setattr(
        server_module, "_TTS_MODEL", data_dir / "tts" / "zh_CN-huayan-medium.onnx"
    )
    import shutil as _sh

    monkeypatch.setattr(_sh, "which", lambda n: str(fake) if n == "piper" else None)
    app = server_module._App(None, None)
    # a bad voice name is refused (no path traversal into the model dir)
    status, j = _post(
        app,
        "/api/agent/tts",
        {
            "project": "proj",
            "slug": "audio-voice-v1-1",
            "text": "台词",
            "voice": "../evil",
        },
    )
    assert status == 400 and j["error"]["detail"] == "bad voice"
    # a voice with no local model → honest fallback, response.voice is null
    status, j = _post(
        app,
        "/api/agent/tts",
        {
            "project": "proj",
            "slug": "audio-voice-v1-1",
            "text": "台词",
            "voice": "no-such-voice",
        },
    )
    assert status == 200, j
    assert j["voice"] is None  # did NOT claim a voice it didn't render
    # a voice WITH a matching local model → that model is selected + reported
    (data_dir / "tts" / "vc-hero.onnx").write_bytes(b"model")
    status, j = _post(
        app,
        "/api/agent/tts",
        {
            "project": "proj",
            "slug": "audio-voice-v1-1",
            "text": "台词",
            "voice": "vc-hero",
        },
    )
    assert status == 200, j
    assert j["voice"] == "vc-hero"


# --- delete-file endpoint (storage management) --------------------------------


def test_delete_file_bytes_only_with_containment(server_module, data_dir) -> None:
    updir = data_dir / "uploads" / "proj"
    updir.mkdir(parents=True)
    target = updir / "audio-d1_v1.wav"
    target.write_bytes(b"RIFFxxxxWAVE")
    outside = data_dir / "outside.wav"
    outside.write_bytes(b"RIFFxxxxWAVE")
    (updir / "esc.wav").symlink_to(outside)
    app = server_module._App(None, None)
    # traversal / symlink / bad names refused
    for name in ("../outside.wav", "esc.wav", "no-extension", "x.exe"):
        status, j = _post(
            app, "/api/assets/delete-file", {"project": "proj", "file": name}
        )
        assert status == 400, name
    assert outside.exists()
    # real deletion removes ONLY the bytes
    status, j = _post(
        app, "/api/assets/delete-file", {"project": "proj", "file": "audio-d1_v1.wav"}
    )
    assert status == 200 and j["deleted"] is True
    assert not target.exists()
    # idempotent: already gone counts as done (goal state holds)
    status, j = _post(
        app, "/api/assets/delete-file", {"project": "proj", "file": "audio-d1_v1.wav"}
    )
    assert status == 200 and j["deleted"] is False


# --- reserved namespaces / core contract --------------------------------------


def test_render_output_namespace_reserved_for_uploads(server_module, data_dir) -> None:
    app = server_module._App(None, None)
    resp = app.handle_put("/api/uploads/proj/render-ep-extra", PNG, "image/png")
    assert resp.status == 400


def test_core_contracts_untouched_by_m11() -> None:
    core = Path(__file__).resolve().parents[1] / "src" / "ai_video_workflow"
    for needle in (
        "render-episode",
        "timelines",
        "ambienceAssetId",
        "removeAssetRecord",
    ):
        hits = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["grep", "-rl", needle, str(core)],
            capture_output=True,
            text=True,
        )
        assert hits.stdout.strip() == "", f"{needle} leaked into Core"

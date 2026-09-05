"""motv 音频生产 + 轻量时间线 + 最终导出 + 存储管理 — checkpoint M11.

Drives the mockup backend (``mockups/motv-workspace/server.py`` ``_App``)
directly — no sockets, no browser, STRICTLY OFFLINE, no spend (the render
path uses LOCAL ffmpeg only and is skipped when ffmpeg is absent).

Covers (the frontend units — voice identity rule, timeline, storage semantics,
v9 schema — live in ``tests/av.test.mjs``, run by the frontend gate/CI):

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
import sys
from pathlib import Path

import pytest

from tests._scan import core_files_containing
from tests.symlink_support import symlink_or_skip

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
# server.py imports its sibling `rootadmit`; without this the module only
# loads when some OTHER test file happens to put the mockup dir on sys.path
if str(_MOCKUP_DIR) not in sys.path:
    sys.path.insert(0, str(_MOCKUP_DIR))
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
    """Legacy scratch redirected into tmp; media now lives per project."""
    d = tmp_path / "mockdata"
    d.mkdir()
    monkeypatch.setattr(server_module, "DATA_DIR", d)
    monkeypatch.setattr(server_module, "APP_DATA_DIR", tmp_path / "app-data")
    account = tmp_path / "account"
    account.mkdir()
    return account


def _mkapp(server_module, account: Path, name: str = "proj"):
    """An app that knows about `name`, whose media is <account>/<name>/media
    (ADR-0053). Discovery needs the query service, which this unit-level suite
    does not spin up, so the mapping is registered directly."""
    (account / name).mkdir(parents=True, exist_ok=True)
    meta = account / name / "project.json"
    if not meta.exists():
        meta.write_text(json.dumps({"project_id": name, "name": name}), "utf-8")
    app = server_module._App(account)
    app._projects[name] = account / name
    return app


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


# --- render endpoint: fail-closed validation ---------------------------------


def test_render_rejects_bad_payloads(server_module, data_dir, monkeypatch) -> None:
    # a fake ffmpeg path so validation is exercised even without ffmpeg —
    # every case below fails clip validation BEFORE any subprocess runs
    import shutil as _sh

    monkeypatch.setattr(_sh, "which", lambda _n: "/bin/false")
    app = _mkapp(server_module, data_dir)
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

    updir = data_dir / "proj" / "media"
    _make_media(updir)
    monkeypatch.setattr(_sh, "which", lambda _n: "/bin/false")
    app = _mkapp(server_module, data_dir)
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
    updir = data_dir / "proj" / "media"
    updir.mkdir(parents=True)
    secret = data_dir / "secret.mp4"
    secret.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"\x00" * 16)
    symlink_or_skip(updir / "link.mp4", secret)
    app = _mkapp(server_module, data_dir)
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
    updir = data_dir / "proj" / "media"
    updir.mkdir(parents=True)
    import shutil as _sh

    monkeypatch.setattr(_sh, "which", lambda _n: None)
    app = _mkapp(server_module, data_dir)
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
    updir = data_dir / "proj" / "media"
    _make_media(updir)
    app = _mkapp(server_module, data_dir)
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
    updir = data_dir / "proj" / "media"
    _make_media(updir)  # video-a_v1.mp4 is exactly 1s
    app = _mkapp(server_module, data_dir)
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


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="fake piper needs a bare-name POSIX-executable shim; the "
    "voice-selection logic it exercises is platform-independent (ADR-0049)",
)
def test_tts_voice_param_validated_and_falls_back_honestly(
    server_module, data_dir, monkeypatch
) -> None:
    """A `voice` names a per-character local model; a bad name is refused, and
    an absent model falls back to the default (response.voice=None) — never a
    fabricated claim of a voice it didn't render (M11 voice rule)."""
    # a cross-platform fake piper: a Python script (shebang-executable on POSIX)
    # that writes a >44-byte RIFF WAV to its `-f` argument — no /bin/sh, dd or
    # /dev/zero. The server invokes it by resolved path (shell=False).
    fake = data_dir / "fakepiper.py"
    fake.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        "a = sys.argv\n"
        'out = a[a.index("-f") + 1] if "-f" in a else "out.wav"\n'
        'open(out, "wb").write(b"RIFF" + b"\\x00" * 64)\n',
        encoding="utf-8",
    )
    fake.chmod(0o755)
    # 语音模型住在服务端的 DATA_DIR 下 —— 不是 `data_dir` fixture 的返回值。
    # 那个 fixture 把 DATA_DIR 打到 tmp_path/"mockdata"，却返回 tmp_path/"account"
    # （ADR-0053 之后它的职责变成「账户根」，名字没跟着改）。把模型写进返回值里，
    # 服务端永远看不见：默认模型靠下面这次 `_TTS_MODEL` 打桩救了回来，
    # 而 per-character 那条查的是 DATA_DIR，于是它从来没被真正验证过。
    tts_dir = server_module.DATA_DIR / "tts"
    tts_dir.mkdir(parents=True, exist_ok=True)
    (tts_dir / "zh_CN-huayan-medium.onnx").write_bytes(b"model")
    monkeypatch.setattr(
        server_module, "_TTS_MODEL", tts_dir / "zh_CN-huayan-medium.onnx"
    )
    import shutil as _sh

    monkeypatch.setattr(_sh, "which", lambda n: str(fake) if n == "piper" else None)
    app = _mkapp(server_module, data_dir)
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
    (tts_dir / "vc-hero.onnx").write_bytes(b"model")
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
    updir = data_dir / "proj" / "media"
    updir.mkdir(parents=True)
    target = updir / "audio-d1_v1.wav"
    target.write_bytes(b"RIFFxxxxWAVE")
    outside = data_dir / "outside.wav"
    outside.write_bytes(b"RIFFxxxxWAVE")
    symlink_or_skip(updir / "esc.wav", outside)
    app = _mkapp(server_module, data_dir)
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
    app = _mkapp(server_module, data_dir)
    resp = app.handle_put("/api/uploads/proj/render-ep-extra", PNG, "image/png")
    assert resp.status == 400


def test_core_contracts_untouched_by_m11() -> None:
    core = Path(__file__).resolve().parents[2] / "src" / "ai_video_workflow"
    for needle in (
        "render-episode",
        "timelines",
        "ambienceAssetId",
        "removeAssetRecord",
    ):
        assert core_files_containing(needle, core) == [], f"{needle} leaked into Core"

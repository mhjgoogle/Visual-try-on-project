#!/usr/bin/env python3
"""Optional same-origin loopback backend for the motv workspace mockup.

Two things a plain ``python3 -m http.server`` cannot do, provided here so the
mockup can do REAL data interaction:

1. **Read real project data** through the accepted ADR-0031 read-only query
   contract — it imports the PUBLIC package ``ai_video_workflow.workspace`` (the
   same public surface ``src/workspace_shell/app.py`` consumes; NOT core internal
   types) and exposes a few read-only queries same-origin. A cross-port
   ``http.server`` page cannot read the production shell's ``/api/*`` (that shell
   sends no CORS and CORP=same-origin), which is exactly why this mockup needs
   its own same-origin backend.
2. **Persist the canvas's OWN editable state** (script drafts, node positions,
   edges) to ``data/<name>.json`` under this mockup dir — prototype-local
   scratch, never a projection of core facts and never written back to any
   ``<project>/`` core file.

Write paths (both Origin/CSRF-guarded, loopback-only):
- ``PUT /api/canvas/<name>`` — mockup-local canvas scratch (always available).
- ``POST /api/projects/<name>/{preflight,command}`` — the ADR-0041 generation
  write path, ONLY when started with ``--enable-paid``: every mutation goes
  through the Command Gateway → approved coordinator (ADR-0033 P1/P2); this
  server never calls a Provider or writes a business file itself. The paid
  command's registration is doubly gated (``authorized=True`` +
  ``AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1``), and real spend additionally
  requires ``WFM1_MINIMAX_API_KEY`` plus a human preflight-digest confirmation.

Host-guarded, strict same-origin CSP. This backend is deliberately kept OUT of
``src/workspace_shell/`` and imports only public/app-approved modules.
"""

from __future__ import annotations

import argparse
import atexit
import contextlib
import hashlib
import json
import math
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections import namedtuple
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

# Sibling modules. This file is loaded BOTH as a script and by path (tests use
# `spec_from_file_location`), and the second way does not put its directory on
# `sys.path` — so it is stated here rather than being inherited from whoever
# happened to import something else first.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import runstore  # noqa: E402 - needs the path line above
import skillpkg  # noqa: E402 - same
from rootadmit import RootRejected, admit_root  # noqa: E402 - same

# `serve.py` already solved «a narrow console cannot print this banner» — reuse
# THAT implementation rather than writing a second one. It is import-safe (module
# level holds only constants and defs).
from serve import _banner  # noqa: E402 - same path line

MOCKUP_DIR = Path(__file__).resolve().parent
REPO_ROOT = MOCKUP_DIR.parents[1]
DATA_DIR = MOCKUP_DIR / "data"
# A project name becomes a directory segment under the chosen root, so the same
# rule the studio applies client-side is enforced here as well — the page is
# never trusted. Windows refuses the reserved device names in any case, with or
# without an extension, and refuses a trailing dot or space (ADR-0049).
_NAME_FORBIDDEN_RE = re.compile(r'[\\/:*?"<>|]')
_WIN_RESERVED = frozenset(
    ["con", "prn", "aux", "nul"]
    + [f"com{i}" for i in range(1, 10)]
    + [f"lpt{i}" for i in range(1, 10)]
)


def _valid_project_name(name: str) -> bool:
    if not name or len(name) > 60 or name in (".", ".."):
        return False
    # Control characters (NUL above all) are not just invalid path segments:
    # a NUL reaches Path() and raises ValueError, which is NOT an OSError and
    # would escape as a dropped connection instead of a 400.
    if any(ch < " " or ch == "" for ch in name):
        return False
    if _NAME_FORBIDDEN_RE.search(name):
        return False
    if name[-1] in ". ":
        return False
    return name.split(".")[0].lower() not in _WIN_RESERVED


# --- project roots (ADR-0051) ---------------------------------------------- #
# The studio lets the creator pick WHERE a project lives, so the backend keeps a
# durable name -> root registry beside the canvas scratch. Prototype-local state,
# exactly like data/<name>.json: not a projection of any core fact, and never
# written back into a project's own files.


_REGISTRY_LOCK = threading.Lock()


def _registry_path() -> Path:
    return DATA_DIR / "projects.json"


def _empty_registry() -> dict:
    return {"version": 1, "projects": [], "confirmedRoots": []}


def _load_project_registry() -> dict:
    """{"version":1,"projects":[{name,root,created_at}],"confirmedRoots":[...]}"""
    try:
        raw = json.loads(_registry_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _empty_registry()
    if not isinstance(raw, dict):
        return _empty_registry()
    projects = [
        x
        for x in (raw.get("projects") or [])
        if isinstance(x, dict)
        and isinstance(x.get("name"), str)
        and x["name"]
        and isinstance(x.get("root"), str)
        and x["root"]
    ]
    confirmed = [
        x for x in (raw.get("confirmedRoots") or []) if isinstance(x, str) and x
    ]
    return {"version": 1, "projects": projects, "confirmedRoots": confirmed}


def _load_registry_projects() -> list[dict]:
    return _load_project_registry()["projects"]


def _save_project_registry(reg: dict) -> bool:
    DATA_DIR.mkdir(exist_ok=True)
    fd, tmpname = tempfile.mkstemp(dir=str(DATA_DIR), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(reg, ensure_ascii=False, indent=2))
        os.replace(tmpname, _registry_path())  # atomic
        return True
    except OSError:
        try:
            os.unlink(tmpname)
        except OSError:
            pass
        return False


# Static files this server will serve (same-origin). Everything else — data/,
# server.py, README, plans — is refused.
_STATIC_PREFIXES = ("src/", "styles/", "fixtures/")
# Transport ceiling (largest allowed write = a video upload); each route then
# enforces its own tighter bound so raising this never loosens JSON routes.
_MAX_BODY_BYTES = 60_000_000
_CANVAS_BODY_MAX = 2_000_000  # canvas JSON keeps its original tighter bound
_GATEWAY_BODY_MAX = 2_000_000  # agent JSON envelopes stay small
# Gateway command envelopes may inline per-shot first-frame images as data URLs
# (lock-draft-plan, ADR-0047: <=5.5MB original -> ~7.34MB base64 per shot). The
# planning contract allows up to 10 shots, so a fully legal image-heavy draft
# is ~74MB of JSON — size the ceiling to fit it with margin, or a draft that
# passes every per-shot cap would be 413-rejected at transport. Loopback-only +
# Origin-guarded, same as every write route.
_COMMAND_BODY_MAX = 80_000_000
_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")

# Manual media uploads (ADR pending for the CORE manual providers; this is the
# PROTOTYPE-LOCAL scratch path only — user-generated reference images / video
# clips / audio from e.g. the Gemini web app or a TTS tool, stored under
# data/uploads/, never core files). Per-class size caps.
_UPLOAD_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
}
# Images are the ONE媒体 a creator inserts by hand all day, and 8MB rejected
# ordinary camera / AI-generator output (产品 2026-08-13). Named once so the
# manual-upload table and the generated-image check below cannot drift apart.
_IMAGE_MAX = 20_000_000
_UPLOAD_MAX = {
    ".png": _IMAGE_MAX,
    ".jpg": _IMAGE_MAX,
    ".webp": _IMAGE_MAX,
    ".mp4": 60_000_000,
    ".webm": 60_000_000,
    ".mp3": 20_000_000,
    ".wav": 20_000_000,
}
# Stem allows a 64-char slug PLUS the ADR-0048 version suffix (_v<N>).
_UPLOAD_FILE_RE = re.compile(r"[A-Za-z0-9_-]{1,76}\.(?:png|jpg|webp|mp4|webm|mp3|wav)")

# Slug prefix reserved for compose OUTPUT (ADR-0044). No user-facing write path
# (manual upload / TTS / paid image) may claim it — otherwise an upload could
# silently replace a composed deliverable, and the same-slug other-extension
# cleanup in TTS/image-gen could even delete one.
# `mix-` joined in TASK-064 Phase 3: a Shot Mix is a DERIVED deliverable written
# by _agent_mix_shot, and a manual upload allowed to claim its slug could
# silently replace a mix (or have the same-slug cleanup delete one).
# TASK-098 加入 `motion-`：白膜预览走自己的链（`motion-<slot>`），保留前缀让人工
# 上传抢不到它的版本化文件名 —— 与 `mix-` 同一条理由。
_RESERVED_SLUG_PREFIXES = ("final-cut", "render-ep", "mix-", "motion-")

# Episode render is CPU/disk heavy: allow only ONE at a time (a second caller
# gets a busy response, never a pile-up), and bound the total output work by a
# pixel-seconds budget (≈ 1h of 1080p30) so no single request can synthesize an
# arbitrarily large file even within the 1h duration cap (M11 review).
_RENDER_LOCK = threading.Lock()
_RENDER_PIXEL_SECONDS_MAX = 1920 * 1080 * 30 * 3600

# ffprobe runs OUTSIDE _RENDER_LOCK, and it has to: every clip's requested window is
# validated against the source's real duration BEFORE any encoding starts, and holding
# the render lock across that validation would serialise callers behind work that
# produces no output. But a mix accepts up to 60 clips, so an unbounded probe phase let
# ONE request spawn 60 subprocesses — and several concurrent requests multiply it, which
# is resource exhaustion and makes 「作业串行化」 true only of the encode
# (TASK-074 §1.1b d). This bounds the probe phase itself, process-wide.
#
# A SEMAPHORE rather than the render lock: probes are cheap, read-only and safe to run a
# few at a time; the point is a ceiling, not exclusivity. It is acquired with a timeout
# so a saturated queue answers 503 instead of hanging the request forever.
_PROBE_MAX_CONCURRENT = 4
_PROBE_SEM = threading.BoundedSemaphore(_PROBE_MAX_CONCURRENT)
_PROBE_WAIT_SECONDS = 20


def _slug_reserved(slug: str) -> bool:
    return slug.startswith(_RESERVED_SLUG_PREFIXES)


def _bridge_creative_shot_ids(outcome, creative_shot_ids):
    """M4c: additively echo the client's creative shot identities onto each
    official locked record, zipped by SEQUENCE (authoritative at lock time —
    the client defined the order). The official ``shot_id`` is never touched;
    each record gains a separate ``creativeShotId`` field.

    Fail SAFE: duplicate creative ids, a length mismatch, or a sequence that
    doesn't line up all resolve to ``creativeShotId = None`` (the client then
    treats the record as unresolved, never guessing by position). Anything that
    isn't the expected shape is passed through unchanged.
    """
    if not isinstance(creative_shot_ids, list):
        return outcome
    if not isinstance(outcome, dict):
        return outcome
    shots = outcome.get("shots")
    if not isinstance(shots, list):
        return outcome
    if any(not isinstance(rec, dict) for rec in shots):
        return outcome  # unexpected shape — pass through untouched

    n = len(creative_shot_ids)
    conflict = False

    # creative id per 1-based sequence (client send order); drop non-strings.
    by_seq: dict[int, str] = {}
    seen: set[str] = set()
    for i, cid in enumerate(creative_shot_ids):
        if not isinstance(cid, str) or not cid:
            continue
        if cid in seen:  # same creative id twice → not a 1:1 bridge
            conflict = True
        seen.add(cid)
        by_seq[i + 1] = cid

    # The parallel array is aligned to the records ONLY if the record sequences
    # are exactly a 1..N permutation (unique, complete, in range) and the counts
    # match. Any duplicate/missing/out-of-range sequence is a malformed outcome
    # → null EVERY mapping (fail safe), never a partial bridge. (bool is an int
    # subclass, so exclude it explicitly.)
    seqs = sorted(
        s
        for s in (rec.get("sequence") for rec in shots)
        if isinstance(s, int) and not isinstance(s, bool)
    )
    if len(shots) != n or seqs != list(range(1, n + 1)):
        conflict = True

    bridged = []
    used: set[str] = set()
    for rec in shots:
        cid = None if conflict else by_seq.get(rec.get("sequence"))
        if cid is not None:
            if cid in used:  # would map one creative id to two records
                cid = None
            else:
                used.add(cid)
        bridged.append({**rec, "creativeShotId": cid})

    return {**outcome, "shots": bridged}


# Upload versioning (ADR-0048): every write to a slot APPENDS a new file
# ``<slug>_v<N>.<ext>`` — no write path deletes or overwrites an existing
# upload. Slugs ending in ``_v<N>`` are refused so the version namespace stays
# unambiguous (historically generated slugs are hyphen-separated, unaffected).
_VERSION_SUFFIX_RE = re.compile(r"_v[1-9][0-9]*$")


def _slug_versioned(slug: str) -> bool:
    return bool(_VERSION_SUFFIX_RE.search(slug))


def _existing_versions(d: Path, slug: str) -> set[int]:
    """Version numbers already present for a slot, across ALL extensions.

    A legacy un-suffixed ``<slug>.<ext>`` counts as v1 (ADR-0048 back-compat),
    so the next write on a pre-versioning slot becomes v2 and the old file is
    kept untouched.
    """
    versions: set[int] = set()
    exts = set(_UPLOAD_TYPES.values())
    if not d.is_dir():
        return versions
    if any((d / f"{slug}{ext}").exists() for ext in exts):
        versions.add(1)
    pat = re.compile(rf"^{re.escape(slug)}_v([1-9][0-9]*)$")
    for p in d.iterdir():
        if p.suffix not in exts:
            continue
        m = pat.match(p.name[: -len(p.suffix)])
        if m is not None:
            versions.add(int(m.group(1)))
    return versions


def _claim_version(d: Path, slug: str, ext: str) -> tuple[int, Path]:
    """Atomically claim the slot's next version file via O_CREAT|O_EXCL.

    Concurrent writers can never claim the same filename (the loop recomputes
    on FileExistsError); old versions are never touched. The pathological
    same-instant different-extension race can at worst mint two files sharing
    an N — both are preserved, nothing is overwritten (fail-safe direction).
    """
    while True:
        n = max(_existing_versions(d, slug), default=0) + 1
        target = d / f"{slug}_v{n}{ext}"
        try:
            os.close(os.open(str(target), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            return n, target
        except FileExistsError:
            continue


def _media_magic_ok(ext: str, body: bytes) -> bool:
    """Fail-closed content sniff: bytes must actually be the declared format."""
    if ext == ".png":
        return body.startswith(b"\x89PNG\r\n\x1a\n")
    if ext == ".jpg":
        return body.startswith(b"\xff\xd8\xff")
    if ext == ".webp":
        return body[:4] == b"RIFF" and body[8:12] == b"WEBP"
    if ext == ".mp4":
        return len(body) > 12 and body[4:8] == b"ftyp"
    if ext == ".webm":
        return body.startswith(b"\x1a\x45\xdf\xa3")
    if ext == ".mp3":
        return body.startswith(b"ID3") or body[:2] in (
            b"\xff\xfb",
            b"\xff\xf3",
            b"\xff\xf2",
        )
    if ext == ".wav":
        return body[:4] == b"RIFF" and body[8:12] == b"WAVE"
    return False


_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", ""}
_LOOPBACK_ORIGIN_HOSTS = {"127.0.0.1", "localhost", "::1"}

# style-src allows 'unsafe-inline' because the mockup uses inline style="..."
# attributes; script stays 'self' (external module only, no inline JS/handlers);
# connect-src 'self' permits same-origin fetch of /api/*.
_SECURITY_HEADERS = (
    (
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; "
        "frame-ancestors 'none'",
    ),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("Cache-Control", "no-store"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
)

# --- optional read-only query backend (public ADR-0031 contract) -------------
try:  # imported lazily so the server still serves static + persistence without it
    from ai_video_workflow.workspace import (  # type: ignore
        QUERY_CONTRACT_VERSION,
        AccountScopeError,
        WorkspaceError,
        WorkspaceQueryService,
        discover_projects,
        to_jsonable,
    )

    _QUERY_OK = True
except Exception:  # noqa: BLE001 - degrade to static/persistence-only if absent
    _QUERY_OK = False
    QUERY_CONTRACT_VERSION = "unavailable"

# Which Gateway commands are available WITHOUT `--enable-paid`, DERIVED from the
# core's own membership list rather than spelled out a second time here
# (TASK-103 批次 B). A hand-written copy is how a no-spend command gets added to
# the registry and then silently 403'd at this door — the two lists drift and
# nothing says so. `lock-draft-plan` is named explicitly because it is a single
# spec registered from its own module (ADR-0047), not part of a family.
#
# Its own try: a write-side import failure must not flip `_QUERY_OK` and take the
# read-only query backend down with it. If this import fails the Gateway cannot be
# built at all, and the route ahead of this check already answers 503.
try:
    from ai_video_workflow.app.gateway_commands import (  # type: ignore
        CREATIVE_LOOP_COMMANDS,
    )

    _NO_SPEND_COMMANDS = frozenset({"lock-draft-plan", *CREATIVE_LOOP_COMMANDS})
except Exception:  # noqa: BLE001 - no core, no Gateway; the route answers 503
    _NO_SPEND_COMMANDS = frozenset({"lock-draft-plan"})

# sub-path -> zero-arg query method (same shape as workspace_shell/app.py)
_QUERIES = {
    "plan": "project_plan",
    "status": "project_status",
    "budget": "budget_standing",
    "cost": "cost_breakdown",
    "problems": "recent_problems",
    "approvals": "approval_audit",
}

# POST routes that create, replace or delete a project's MEDIA (ADR-0053).
# Each carries the project name as `project` in its JSON envelope.
_MEDIA_WRITE_ROUTES = frozenset(
    {
        "/api/agent/tts",
        "/api/agent/compose",
        "/api/agent/image-gen",
        "/api/agent/adopt-paid",
        "/api/agent/render-episode",
        "/api/agent/mix-shot",
        # TASK-098: 白膜预览写 media/ 下的 mp4，所以它同样受未迁移项目的闸门约束
        "/api/agent/motion-preview",
        "/api/assets/delete-file",
    }
)


# --- 交付质检探测（TASK-074 §1.2 接线）------------------------------------- #
#
# ffmpeg writes both summaries to STDERR in fixed shapes. Parsing here is
# ALL-OR-NOTHING PER FIELD: a shape we do not recognise leaves that field absent,
# so `deliveryqc` renders 未检查 and keeps `passed` false. Guessing a number
# would turn 「我们没测」 into 「合格」 on the creator's screen — the exact failure
# §1.2 / ADR-0064 决策 6 exist to prevent.
_EBUR128_I_RE = re.compile(r"^\s*I:\s+(-?\d+(?:\.\d+)?)\s+LUFS\s*$", re.M)
_EBUR128_PEAK_RE = re.compile(r"^\s*Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS\s*$", re.M)
_BLACKDETECT_RE = re.compile(
    r"black_start:\s*(\d+(?:\.\d+)?)\s+"
    r"black_end:\s*(\d+(?:\.\d+)?)\s+"
    r"black_duration:\s*(\d+(?:\.\d+)?)"
)


def _probe_float(value):
    """A finite float, or None. ffprobe emits "N/A" and omits keys freely."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _probe_fps(rate):
    """`r_frame_rate` is a RATIONAL string ("25/1", "30000/1001").

    Dividing it out is the only way to get 29.97 instead of 30 — and the 缺帧
    check multiplies fps by duration, so a rounded-up fps invents missing frames.
    """
    if not isinstance(rate, str) or "/" not in rate:
        return _probe_float(rate)
    num, _, den = rate.partition("/")
    n, d = _probe_float(num), _probe_float(den)
    if n is None or d is None or d == 0:
        return None
    return round(n / d, 3)


def _build_delivery_probe(info, stderr):
    """Assemble the `probe` object `workflow/deliveryqc.js` reads.

    `info` is parsed ffprobe JSON, `stderr` the combined ebur128 + blackdetect
    scan. Every field is OPTIONAL and omitted when it could not be measured.
    """
    streams = info.get("streams") if isinstance(info, dict) else None
    streams = streams if isinstance(streams, list) else []
    fmt = info.get("format") if isinstance(info, dict) else None
    fmt = fmt if isinstance(fmt, dict) else {}
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    probe = {}

    duration = _probe_float(fmt.get("duration"))
    if duration is None and isinstance(video, dict):
        duration = _probe_float(video.get("duration"))
    if duration is not None and duration > 0:
        probe["durationS"] = round(duration, 3)

    if isinstance(video, dict):
        fps = _probe_fps(video.get("r_frame_rate"))
        if fps is not None and fps > 0:
            probe["fps"] = fps
        # `nb_frames` is absent in some containers. Counting frames for real
        # means decoding the file a THIRD time, so an absent count stays absent
        # and 缺帧 honestly reports 未检查.
        frames = _probe_float(video.get("nb_frames"))
        if frames is not None and frames > 0:
            probe["frameCount"] = int(frames)
        w, h = video.get("width"), video.get("height")
        if isinstance(w, int) and isinstance(h, int) and w > 0 and h > 0:
            probe["resolution"] = f"{w}x{h}"
        vbr = _probe_float(video.get("bit_rate"))
        if vbr is not None and vbr > 0:
            probe["videoBitrateKbps"] = round(vbr / 1000)
    if isinstance(audio, dict):
        abr = _probe_float(audio.get("bit_rate"))
        if abr is not None and abr > 0:
            probe["audioBitrateKbps"] = round(abr / 1000)

    # 音画同步：the CONTAINER-level start offset between the two streams.
    #
    # This is NOT lip-sync of the recorded content — ffmpeg has no reliable
    # content-level detector, and claiming one would be the fabricated-number
    # failure again. It IS the real failure mode for cuts we composed ourselves:
    # a concat/mix step that lands the audio at the wrong offset shows up here.
    # Both streams must report start_time, otherwise the field stays absent.
    if isinstance(video, dict) and isinstance(audio, dict):
        v0 = _probe_float(video.get("start_time"))
        a0 = _probe_float(audio.get("start_time"))
        if v0 is not None and a0 is not None:
            probe["avOffsetMs"] = round((v0 - a0) * 1000)

    text = stderr if isinstance(stderr, str) else ""
    # LAST match, not first: ebur128 prints running values during the scan and
    # the Summary block at the end. The final one is the integrated result.
    loud = _EBUR128_I_RE.findall(text)
    if loud:
        probe["lufs"] = round(float(loud[-1]), 1)
    peak = _EBUR128_PEAK_RE.findall(text)
    if peak:
        probe["truePeakDbtp"] = round(float(peak[-1]), 1)

    # blackdetect prints one line per span and NOTHING when the video is clean.
    # An empty list is therefore a real measurement (「未发现黑帧」), which is why
    # it is only set when the video stream itself was present: with no video
    # stream there was nothing to detect and the answer is 未检查, not 「干净」.
    if isinstance(video, dict):
        probe["blackSpans"] = [
            {
                "startS": round(float(m[0]), 3),
                "endS": round(float(m[1]), 3),
                "durationS": round(float(m[2]), 3),
            }
            for m in _BLACKDETECT_RE.findall(text)
        ]
    return probe


def _migration_required_json():
    """One refusal, used by every write path, so the message never drifts."""
    return _json(
        409,
        {
            "error": {
                "category": "migration_required",
                "detail": (
                    "这个项目的画布/媒体还在旧的仓库 scratch 目录里。"
                    "先迁移到项目目录（studio/canvas.json + media/）再编辑，"
                    "否则会出现「画布已迁移、媒体仍在仓库里」的半迁移状态。"
                ),
            }
        },
    )


_CTYPE = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
}


_CLAUDE_OUTPUT_CAP = 200_000  # hard ceiling on bytes ever accepted from the CLI

# Script drafting (Idea → Script vertical slice): bounds for the creative brief,
# a revision instruction, the base script sent for revision, and the returned
# script text. Draft-domain only (ADR-0042 pattern) — nothing written server-side.
_SCRIPT_IDEA_MAX = 4_000
_SCRIPT_INSTRUCTION_MAX = 4_000
_SCRIPT_BASE_MAX = 50_000
_SCRIPT_DRAFT_MAX = 20_000
# The reply must arrive inside this block; wrapper prose outside is discarded.
_SCRIPT_OUT_OPEN = "<剧本输出>"
_SCRIPT_OUT_CLOSE = "</剧本输出>"

# Local Piper TTS (ADR-0043): free offline draft voice-over. Model lives in
# data/tts/ (gitignored, downloaded locally); absent → the endpoint 503s with
# an install hint and the manual upload route is unaffected.
_TTS_MODEL = DATA_DIR / "tts" / "zh_CN-huayan-medium.onnx"
_TTS_TEXT_MAX = 2_000

# Paid image generation (ADR-0045): MiniMax image-01, narrow authorization.
# Catalog list price; the client must echo it back (confirm_usd) so a stale UI
# can never silently spend at a different price. Spend is logged locally.
_IMAGE_PRICE_USD = 0.0035
_IMAGE_API = "https://api.minimax.io/v1/image_generation"
_IMAGE_PROMPT_MAX = 1_500
_IMAGE_LOG = DATA_DIR / "paid-image-log.jsonl"


# `_run_claude` REMOVED (TASK-072 §1.8 / ADR-0065 决策 1).
#
# It was the second way to start an AI process: a hard-wired `claude` spawn with
# no executor choice, no manual fallback, no concurrency cap, no Skill Run and no
# provenance. Everything that used it now goes through the Runtime layer
# (`_run_executor`) and the Run registry, so there is exactly ONE path again.
#
# Deleted rather than left unused: a dormant second launcher is an invitation to
# call it, and the whole point of this change is that it cannot be called.


# --- Local AI Runtime (CP3 / ADR-0056) -------------------------------------
#
# A Film AI Runtime is a TEXT / STRUCTURED REASONING executor. It is NOT a code
# modification agent, and this module is where that is enforced:
#
#   * tools are disabled / the sandbox is read-only — the executor can only emit
#     text, so a crafted prompt cannot make the locally-authenticated CLI read
#     or exfiltrate anything;
#   * argv arrays, never a shell;
#   * a NEUTRAL cwd — never the project folder, never the repository;
#   * output is bounded at the source and a watchdog enforces the timeout;
#   * NO PATH is ever passed. The project context is inlined in the prompt as
#     data, which is also why nothing here has to translate between Windows and
#     WSL path conventions: no path crosses the boundary.
#
# Executor resolution order (ADR-0056 决策 3):
#   1. MOTV_RUNTIME_<NAME>_BIN — the executor's ABSOLUTE path in whatever
#      environment it lives in, optionally with
#      MOTV_RUNTIME_<NAME>_LAUNCHER — a PURE-TRANSPORT argv prefix saying how to
#      get there (e.g. ["wsl","-e","/home/u/.nvm/.../bin/node"]). WE own every
#      argument after the binary, so no configuration can drop `--tools ""` /
#      `--sandbox read-only`. A shell in the prefix is refused: it would swallow
#      the arguments we append.
#   2. shutil.which(<name>)    — ADR-0049: resolve, never invoke by bare name.
#   3. neither → `unavailable`, reported honestly. Never a fabricated "ready".
_SKILL_OUTPUT_CAP = 512_000
# 240s was too short for this product's MAIN use (2026-08-15, real project):
# 「AI 生成本集剧本」 on a 48-episode work failed with 「执行器超过 240 秒未返回」.
# Long-form generation — an episode script, an outline, a breakdown — is the
# normal case here, not the exception, so the DEFAULT has to cover it.
#
# The cost of a larger default is only paid by a run that is going to fail
# anyway: the creator waits longer for the error. That is the better trade —
# waiting 10 minutes for a script beats being told at 4 minutes that the thing
# which was still working has 「failed」.
#
# No caller currently passes an explicit `timeout`, so this value IS the timeout
# for every skill run (`skillctl.js` calls `runOnExecutor` without one). The MAX
# stays where it is: it bounds what a request may ask for, and nothing in the
# UI asks.
_SKILL_TIMEOUT_DEFAULT = 600
_SKILL_TIMEOUT_MAX = 900
_SKILL_PROMPT_MAX = 200_000
# Transport ceiling for /api/skill/run, enforced BEFORE the body is read. A
# prompt is UTF-8 text (up to 4 bytes/char) plus a small JSON envelope; this
# leaves generous headroom while keeping an oversized request from ever being
# buffered.
_SKILL_BODY_MAX = _SKILL_PROMPT_MAX * 4 + 8_192

# How many shots ONE EPISODE may hold. Enforced in two places that must agree —
# the shot-draft parser and the final-compose route — so the constant is shared
# rather than written twice (they were both `20`, and drifting them apart is how
# 「分镜生成通过了但合成拒绝」 would appear).
#
# WHY IT IS NOT 20 (2026-08-15, real project 「照见未明rev2」). 20 was a fixture-era
# number, and it silently made the product's MAIN path fail on real content: a
# 3 463-character episode script draws 30–60 shots, so `_parse_shots` rejected
# every single run. Five consecutive runs of `storyboard-director` burned 3–5
# minutes each and were all discarded AFTER the model had answered correctly —
# the creator saw only 「分镜生成失败」 and reasonably concluded the feature never
# started (it did, every time).
#
# 120 is derived, not guessed: an episode runs 5–10 minutes and every shot is
# 6 or 10 seconds, so 10 min ÷ 6 s ≈ 100 shots is the honest ceiling for one
# episode, plus ~20% headroom. It stays a REAL bound — a model that returns 500
# shots is still refused, which is what this check is for.
_MAX_SHOTS_PER_EPISODE = 120

#: The OPTIONAL directing facets a raw draft shot may carry, in the order
#: `storyboard-director`'s output schema declares them (TASK-078 §1.b/§2.1).
#:
#: MUST STAY A SUPERSET of the schema's optional string fields, and it mirrors
#: `ADDITIVE_SHOT_FIELDS` in `src/ui/shoteditor.js` — the client and the server
#: have to agree on what an additive shot field IS, or one of them silently
#: deletes what the other just saved. A guard test pins this list against the
#: package's `output.schema.json` rather than trusting this comment.
_SHOT_FACETS = (
    "shotSize",
    "angle",
    "cameraMotion",
    "lighting",
    "action",
    "expression",
    "emotion",
    "dialogue",
)

# name → (env var, default argv tail appended after the resolved binary).
# The tail is what makes each CLI headless AND tool-free.
_EXECUTORS: dict[str, dict] = {
    "claude-code": {
        "bin": "claude",
        "launcher_env": "MOTV_RUNTIME_CLAUDE_LAUNCHER",
        "bin_env": "MOTV_RUNTIME_CLAUDE_BIN",
        # --tools "" disables every tool (the ADR-0042 control, now the only one).
        # `-p` with no inline argument reads the prompt from stdin — see the
        # stdin note below for why the prompt never travels on argv.
        "args": ["-p", "--tools", ""],
        "probe": ["--version"],
    },
    "codex-cli": {
        "bin": "codex",
        "launcher_env": "MOTV_RUNTIME_CODEX_LAUNCHER",
        "bin_env": "MOTV_RUNTIME_CODEX_BIN",
        # `exec` is codex's non-interactive mode and `--sandbox read-only`
        # prevents WRITES — but codex has no tool-free mode, so the model can
        # still READ local files and echo them back in its answer. Our prompts
        # embed user-authored script text, which is exactly an injection vector,
        # so this executor is gated (see reads_filesystem below).
        "args": [
            "exec",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "-",  # read the prompt from stdin
        ],
        "probe": ["--version"],
        "reads_filesystem": True,
    },
}

# Executors that CANNOT be made tool-free are OFF unless the operator opts in.
#
# `claude -p --tools ""` genuinely has no tools: it can only emit text. `codex
# exec --sandbox read-only` only blocks writes — the agent may still read
# absolute paths and return their contents. Since a Film Skill prompt inlines
# user-authored script text, a crafted script could ask a read-capable executor
# to read a local secret and put it in the answer.
#
# The ADR-0056 posture is fail-closed, so such an executor is `unavailable` by
# default and the honest reason is reported. Setting this variable is an
# explicit, informed decision by whoever runs the backend.
_FS_READER_OPT_IN = "MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS"

# Concurrency cap for skill runs. Each run launches a real local CLI; without a
# cap, a page that can reach the backend could start an unbounded number of them
# and exhaust the machine (and the subscription). Exceeding the cap is a 429 —
# an honest "busy", never a silent queue that looks like a hang.
_SKILL_RUN_MAX_CONCURRENT = 2
# A custom header a cross-origin page cannot set without a CORS preflight this
# server never answers — the CSRF guard for the one route that starts a real
# local CLI (see _skill_run).
_SKILL_RUN_HEADER = "X-Motv-Runtime"

# Probes spawn `--version` subprocesses. The answer changes only when someone
# installs or reconfigures a CLI, so it is cached: an authorized page polling
# the runtime panel must not spawn a process per poll. (The route ALSO requires
# the custom header, so a hostile page cannot reach it at all — the cache is the
# second line, bounding cost even for legitimate callers.)
_PROBE_TTL_SECONDS = 30.0
_PROBE_CACHE: dict[str, tuple[float, dict]] = {}
_PROBE_LOCK = threading.Lock()
# The concurrency cap lives in the Run registry now (`RunStore.max_concurrent`),
# so that the synchronous route, the async route and the agent endpoints all draw
# from ONE pool. A second semaphore here would let mixed traffic run twice the
# configured number of local CLIs (codex review, round 11).


def _fs_readers_allowed() -> bool:
    return os.environ.get(_FS_READER_OPT_IN, "").strip().lower() in {"1", "true", "yes"}


# Programs that REINTERPRET the arguments handed to them. A launcher prefix
# must be pure TRANSPORT (`wsl -e …`, `docker exec …`): if a shell sits between
# us and the CLI, our safety arguments become `$0 $1 …` of a `-c` script instead
# of the executor's flags, and a prompt-injected agent runs with its tools on
# while we believe they are off.
_SHELLS = frozenset(
    {
        "sh",
        "bash",
        "zsh",
        "dash",
        "ksh",
        "fish",
        "csh",
        "tcsh",
        "cmd",
        "powershell",
        "pwsh",
    }
)
_SHELL_FLAGS = frozenset({"-c", "-lc", "-ic", "-lic", "--command", "/c", "/k"})


def _launcher_error(argv: list[str]) -> str | None:
    """Reject a launcher prefix that is not pure transport."""
    for a in argv:
        base = a.replace("\\", "/").rsplit("/", 1)[-1].lower()
        if base.endswith(".exe"):
            base = base[: -len(".exe")]
        if base in _SHELLS:
            return (
                f"启动前缀里不能出现 shell（{a}）：shell 会把我们追加的安全参数"
                "当成脚本的位置参数吞掉，执行器就会带着工具运行。"
                '请用纯传输前缀（如 ["wsl","-e"]）加上可执行体的绝对路径。'
            )
        if a.lower() in _SHELL_FLAGS:
            return f"启动前缀里不能出现 shell 命令参数（{a}）"
    return None


def _executor_argv(name: str) -> tuple[list[str] | None, str]:
    """Resolve an executor to a full argv, or (None, reason).

    STRUCTURED, not string-matched. The operator supplies at most two things:

        MOTV_RUNTIME_<NAME>_LAUNCHER  a pure-transport argv PREFIX, e.g.
                                      ["wsl","-e","/home/u/.../bin/node"]
        MOTV_RUNTIME_<NAME>_BIN       the executor's ABSOLUTE path in that
                                      environment

    and WE own every argument after the binary. That is what makes the mandatory
    safety flags un-droppable: there is no free-form command string to inspect,
    so there is nothing to get wrong. The prefix is checked for shells, because
    a shell between us and the CLI would swallow the arguments we append.
    """
    spec = _EXECUTORS.get(name)
    if spec is None:
        return None, f"unknown executor {name}"
    if spec.get("reads_filesystem") and not _fs_readers_allowed():
        return None, (
            f"{spec['bin']} 没有「完全无工具」模式："
            "它仍可读取本机文件并把内容写进回答。"
            "提示词里内嵌了用户撰写的剧本文本（注入面），因此默认停用。"
            f"确认接受这一风险后，设置 {_FS_READER_OPT_IN}=1 启用。"
        )
    launcher: list[str] = []
    raw_launcher = os.environ.get(spec["launcher_env"], "").strip()
    if raw_launcher:
        try:
            launcher = json.loads(raw_launcher)
        except ValueError:
            return None, f"{spec['launcher_env']} is not a JSON array"
        if not isinstance(launcher, list) or not all(
            isinstance(a, str) and a for a in launcher
        ):
            return None, f"{spec['launcher_env']} must be an array of non-empty strings"
        bad = _launcher_error(launcher)
        if bad:
            return None, bad
    configured_bin = os.environ.get(spec["bin_env"], "").strip()
    if configured_bin:
        # An absolute path INSIDE the launcher's environment. It is not resolved
        # here — the file lives over there, not on this host's filesystem.
        absolute = configured_bin.startswith("/") or re.fullmatch(
            r"[A-Za-z]:[\\/].*", configured_bin
        )
        if not absolute:
            return None, f"{spec['bin_env']} 必须是绝对路径"
        return [*launcher, configured_bin, *spec["args"]], "configured"
    if launcher:
        return None, (
            f"设置了 {spec['launcher_env']} 但没有 {spec['bin_env']}："
            "启动前缀只说明「怎么过去」，还需要可执行体在那边的绝对路径。"
        )
    exe = shutil.which(spec["bin"])
    if exe is None:
        return None, (
            f"{spec['bin']} not on PATH — set {spec['bin_env']} (absolute path) "
            f"and, when it lives in another environment, {spec['launcher_env']} "
            '(a pure-transport prefix such as ["wsl","-e","/abs/path/to/node"])'
        )
    return [exe, *spec["args"]], "path"


def _run_executor(
    name: str, prompt: str, timeout: int, on_spawn=None
) -> tuple[str, str | None]:
    """Run one executor on a prompt and return (text, model).

    Raises FileNotFoundError (unavailable), subprocess.TimeoutExpired (timeout)
    or OSError (execution error) — three distinct failures, because the creator's
    next action differs for each and collapsing them hides which one happened.

    ``on_spawn(proc)`` is handed the live Popen the moment it exists, so the Run
    registry can terminate a real process TREE on cancel or shutdown. It is a
    callback rather than a return value because the process must be reachable
    while this function is still blocked reading its output (TASK-072 §1.3).
    """
    argv, _why = _executor_argv(name)
    if argv is None:
        raise FileNotFoundError(_why)
    # THE PROMPT ALWAYS TRAVELS ON STDIN, never on argv. A real skill prompt
    # inlines the episode script, the scenes and the shots; on native Windows the
    # command line is capped around 32 KB, so an argv-borne prompt would make
    # perfectly valid contexts fail with an opaque spawn error. stdin has no such
    # limit and is uniform across executors.
    # A genuinely NEUTRAL working directory: a fresh EMPTY temp folder, created
    # per run and removed afterwards. The repository (and MOCKUP_DIR inside it)
    # is not neutral — a prompt-injected executor whose cwd is the repo can read
    # and echo back source, which is exactly the exfiltration the tool-free
    # posture exists to prevent. An empty folder has nothing to read.
    # Create the job BEFORE the first child of the process, on EVERY path that
    # spawns one. Hanging it off the Run registry's construction missed the
    # synchronous `/api/skill/run`, which spawns without ever touching the
    # registry — and job membership is not retroactive (codex review, round 10).
    _windows_job()
    workdir = tempfile.mkdtemp(prefix="motv-skill-")
    try:
        proc = subprocess.Popen(  # noqa: S603 - argv array, no shell
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,  # one bounded stream, no drain deadlock
            cwd=workdir,
            # POSIX: own session, so _kill_tree can signal the whole group.
            #
            # NOT `preexec_fn` (codex review, round 2). A `preexec_fn` runs
            # Python — including imports — in the forked child of a MULTITHREADED
            # server, where locks inherited from other threads can be held by
            # threads that do not exist after the fork. That deadlocks between
            # fork and exec, and a hung `Popen` would stall the run and every
            # queued run behind it. An occasional orphan on a `kill -9`ed Linux
            # backend is a far smaller problem than a spawn path that can hang,
            # and — unlike a deadlock — it is one we REPORT rather than hide
            # (`childExitVerified: false`, contract §5.9a).
            **({} if os.name == "nt" else {"start_new_session": True}),
        )
    except OSError:
        # the spawn itself failed (a bad configured launcher, most likely) — the
        # temp folder is ours and must not be left behind on every retry
        shutil.rmtree(workdir, ignore_errors=True)
        raise
    # Register BEFORE the first blocking read: a cancel that arrives while we are
    # waiting on stdout must still find something to kill. Registration also puts
    # the child in the shutdown guard where that is possible; where it is NOT,
    # the return value says so rather than letting us assume protection.
    proc.motv_kill_on_close = _guard_child(proc)
    if os.name != "nt":
        # Captured NOW, while the child is certainly alive: after it is reaped
        # `os.getpgid` raises and the whole group becomes unreachable.
        try:
            proc.motv_pgid = os.getpgid(proc.pid)
        except OSError:
            # `start_new_session=True` makes the child its own session AND group
            # leader, so its pgid IS its pid. Falling back to that keeps the
            # group reachable even when the leader exited before this lookup —
            # which is precisely the case where descendants are left behind
            # (codex review, round 9). `None` would have made them unkillable.
            proc.motv_pgid = proc.pid
    if on_spawn is not None:
        try:
            on_spawn(proc)
        except Exception:  # noqa: BLE001 - bookkeeping must not kill the run
            pass
    timed_out = False

    def _on_timeout() -> None:
        nonlocal timed_out
        timed_out = True
        _kill_tree(proc)  # the CLI behind a WSL/bash launcher too, not just it

    timer = threading.Timer(timeout, _on_timeout)
    timer.start()
    try:
        try:
            proc.stdin.write(prompt.encode("utf-8"))
        except OSError:
            pass  # the child may have exited already; the read below reports
        try:
            proc.stdin.close()
        except OSError:
            pass
        out = proc.stdout.read(_SKILL_OUTPUT_CAP + 1)
    finally:
        timer.cancel()
        # stops the child emitting once the cap is hit, and reaches a launcher's
        # forwarded grandchild the same way the timeout path does.
        #
        # This is ALSO the only reap: `_kill_tree` waits and marks the process
        # under `_REAP_LOCK`, so cleanup never frees the pid behind a concurrent
        # cancel's back (codex review, round 19).
        tree_gone = _kill_tree(proc)
        proc.stdout.close()
        # Registered only while a later kill could still DO something. Once the
        # direct child is reaped no future attempt can signal it, so holding the
        # record would just accumulate dead `Popen` objects for the life of the
        # server (codex review, round 22) — while discarding an unconfirmed,
        # still-reachable tree would hide it from shutdown (round 21).
        if tree_gone or getattr(proc, "motv_tree_reaped", False):
            with _JOB_LOCK:
                _LIVE_CHILDREN.discard(proc)
        shutil.rmtree(workdir, ignore_errors=True)
    if timed_out:
        raise subprocess.TimeoutExpired(argv[:1], timeout)
    text = out[:_SKILL_OUTPUT_CAP].decode("utf-8", "replace")
    if len(out) > _SKILL_OUTPUT_CAP:
        raise OSError("executor output exceeded size cap")
    if proc.returncode != 0:
        # An auth failure is its own actionable state — "log in" is a different
        # fix from "retry" or "reconfigure", so it must not collapse into a
        # generic execution error.
        if _looks_unauthenticated(text):
            raise PermissionError(f"{name} is not logged in: {text.strip()[:300]}")
        raise OSError(f"{name} exited {proc.returncode}: {text.strip()[:300]}")
    # The model is whatever the executor reports. We do not know it, and we do
    # NOT guess: an unreported model stays null rather than being filled in with
    # what we hoped was running.
    return text, None


# --- shutdown guard: children must not outlive this process ----------------- #
#
# The cheapest way to guarantee "no orphans after a restart" is to make orphans
# IMPOSSIBLE, rather than to hunt them down afterwards (contract §5.9a):
#
#   Windows  a Job Object with KILL_ON_JOB_CLOSE — when this process dies, for
#            ANY reason including a hard kill, the whole job dies with it;
#   POSIX    the exit hook signals each child's process group.
#
# THE POSIX GUARANTEE IS WEAKER, and saying so is the point. `atexit` covers only
# an orderly exit; `start_new_session` gives the child its own group (so `killpg`
# can target the tree without hitting us) but does NOT make it die with us. A
# `kill -9` of a Linux backend can therefore orphan an executor tree.
#
# We do NOT close that gap with `PR_SET_PDEATHSIG`, because the only way to set
# it is a `preexec_fn`, which runs Python in the forked child of a multithreaded
# server and can deadlock on inherited locks before `exec` (codex review round 2).
# A spawn path that can hang is worse than an orphan we honestly report. Closing
# it properly needs a cgroup or PID namespace, which is out of scope here.
#
# The residual gap is therefore RECORDED, not papered over: the sweep reports
# `childExitVerified: false` rather than claiming the child is gone.
#
# The sweep deliberately kills NOTHING: a pid from a previous process may have
# been reused by an unrelated program, and killing on a stale pid is the one
# operation here that could hurt something innocent.
_JOB_HANDLE = None
#: Whether THIS process is in the job. When it is, every descendant inherits
#: membership from birth and there is no assignment race; when it is not, each
#: child must be assigned individually and a fast launcher can outrun us.
_JOB_INHERITED = False
_JOB_LOCK = threading.Lock()
_LIVE_CHILDREN: set[subprocess.Popen] = set()
#: Set once shutdown starts. A worker already inside `_run_executor` can spawn
#: AFTER the children have been snapshotted and killed, and on POSIX that child
#: escapes the only cleanup there is (codex review, round 9). Registration checks
#: this flag and kills such a latecomer immediately.
_SHUTTING_DOWN = threading.Event()
#: Serialises "is this process still ours to signal?" with the reap that answers
#: it. Without it, cleanup can reap the child (freeing its pid) between the guard
#: check and the `taskkill`/`killpg`, and the signal lands on whatever inherited
#: that number (codex review, round 20).
_REAP_LOCK = threading.RLock()


def _kernel32():
    """kernel32 with the signatures DECLARED (codex review, round 3).

    ctypes defaults every return value to C `int`. A Win64 `HANDLE` is a 64-bit
    pointer, so the default TRUNCATES it: `CreateJobObjectW` and `OpenProcess`
    hand back a mangled handle, the assignment fails, and the backend silently
    loses the kill-on-close guarantee it believes it has. Declaring the types is
    what makes the guarantee real rather than probable.
    """
    import ctypes  # noqa: PLC0415 - Windows-only path
    from ctypes import wintypes  # noqa: PLC0415

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    k32.SetInformationJobObject.restype = wintypes.BOOL
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k32.AssignProcessToJobObject.restype = wintypes.BOOL
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.CloseHandle.restype = wintypes.BOOL
    k32.GetCurrentProcess.argtypes = []
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    k32.IsProcessInJob.argtypes = [
        wintypes.HANDLE,
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.BOOL),
    ]
    k32.IsProcessInJob.restype = wintypes.BOOL
    return k32


def _windows_job():
    """A kill-on-close Job Object, or None when it cannot be created."""
    global _JOB_HANDLE
    if os.name != "nt":
        return None
    with _JOB_LOCK:
        if _JOB_HANDLE is not None:
            return _JOB_HANDLE or None
        try:
            import ctypes  # noqa: PLC0415 - Windows-only path
            from ctypes import wintypes  # noqa: PLC0415

            k32 = _kernel32()
            job = k32.CreateJobObjectW(None, None)
            if not job:
                _JOB_HANDLE = False
                return None

            class _LIMIT(ctypes.Structure):
                _fields_ = [
                    ("PerProcessUserTimeLimit", ctypes.c_int64),
                    ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.POINTER(ctypes.c_ulong)),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD),
                ]

            class _IO(ctypes.Structure):
                _fields_ = [
                    ("ReadOperationCount", ctypes.c_uint64),
                    ("WriteOperationCount", ctypes.c_uint64),
                    ("OtherOperationCount", ctypes.c_uint64),
                    ("ReadTransferCount", ctypes.c_uint64),
                    ("WriteTransferCount", ctypes.c_uint64),
                    ("OtherTransferCount", ctypes.c_uint64),
                ]

            class _EXT(ctypes.Structure):
                _fields_ = [
                    ("BasicLimitInformation", _LIMIT),
                    ("IoInfo", _IO),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t),
                ]

            info = _EXT()
            info.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
            if not k32.SetInformationJobObject(
                job, 9, ctypes.byref(info), ctypes.sizeof(info)
            ):
                _JOB_HANDLE = False
                return None
            # PUT THIS PROCESS IN THE JOB. Job membership is INHERITED, so every
            # descendant — including one a fast launcher spawns before we could
            # have assigned it ourselves — is in the job from the instant it
            # exists. Assigning each child after `Popen` returns leaves exactly
            # that race open (codex review, round 6).
            #
            # Killing the job therefore also kills this process, which is the
            # correct semantic: the job closes when the backend's last handle
            # goes away, i.e. when the backend is already gone.
            # CHECK IT. If this process could not join the job, membership is
            # not inherited, and publishing the job as active would claim a
            # protection that does not exist (codex review, round 10). The job is
            # still kept — per-child assignment remains a real (if racier)
            # mechanism — but `_JOB_INHERITED` records which one we actually have,
            # and `_guard_child` reports the truth per child.
            global _JOB_INHERITED
            _JOB_INHERITED = bool(
                k32.AssignProcessToJobObject(job, k32.GetCurrentProcess())
            )
            _JOB_HANDLE = job
            return job
        except Exception:  # noqa: BLE001 - no job object is a degraded, honest mode
            _JOB_HANDLE = False
            return None


def _guard_child(proc: subprocess.Popen) -> bool:
    """Put a freshly spawned child under the shutdown guard.

    Returns whether the KILL-ON-CLOSE guarantee is actually in force for this
    child. A failed job assignment used to be swallowed, which left the backend
    claiming shutdown protection it did not have (codex review, round 2) — and
    that claim is exactly what the honesty rules in §5.9a are about.
    """
    with _JOB_LOCK:
        _LIVE_CHILDREN.add(proc)
    if _SHUTTING_DOWN.is_set():
        # It was spawned after the shutdown sweep. Kill it here, where we still
        # have the handle, rather than leaving it to a sweep that already ran.
        _kill_tree(proc)
        return False
    if os.name != "nt":
        return False  # POSIX: only the exit hook, and it does not survive SIGKILL
    job = _windows_job()
    if not job:
        return False
    if _JOB_INHERITED:
        # It was in the job from birth; nothing to assign and no race to lose.
        return True
    # The child is ALREADY in the job by inheritance (this process is in it), so
    # this call is a confirmation rather than the mechanism. It is kept because
    # an explicit success is what lets the caller distinguish "protected" from
    # "we hope so", and a nested-job refusal shows up here rather than silently.
    try:
        k32 = _kernel32()  # signatures declared: a Win64 HANDLE is not an int
        handle = k32.OpenProcess(0x001F0FFF, False, proc.pid)
        if not handle:
            return False
        try:
            if k32.AssignProcessToJobObject(job, handle):
                return True
            # The assignment failed — ASK whether it is in our job rather than
            # inferring it from the error code. `ERROR_ACCESS_DENIED` also comes
            # back when the process belongs to a DIFFERENT, non-breakaway job, and
            # treating that as success would report protection we do not have
            # (codex review, round 8).
            import ctypes  # noqa: PLC0415 - Windows-only path
            from ctypes import wintypes  # noqa: PLC0415

            inside = wintypes.BOOL()
            if k32.IsProcessInJob(handle, job, ctypes.byref(inside)):
                return bool(inside.value)
            return False
        finally:
            k32.CloseHandle(handle)
    except Exception:  # noqa: BLE001 - the exit hook remains as the fallback
        return False


def _kill_all_children() -> None:
    """Exit hook: terminate every child we started, tree and all.

    Runs BEFORE the Run records are finalised (see `_RUNS.close`): writing the
    records first and then dying mid-shutdown would leave "record says finished,
    process still running" — a lying journal plus a process still consuming
    subscription capacity.
    """
    _SHUTTING_DOWN.set()
    # Sweep REPEATEDLY: a worker that was mid-`Popen` when the flag went up may
    # register right after a pass. `_guard_child` also kills latecomers itself,
    # so this converges immediately in practice.
    for _ in range(3):
        with _JOB_LOCK:
            children = list(_LIVE_CHILDREN)
            _LIVE_CHILDREN.clear()
        if not children:
            break
        for proc in children:
            # No `poll()` gate (codex review, round 18): the direct child exiting
            # is precisely when its descendants are the thing still running, and
            # on POSIX the captured process group is how they are reached.
            # `_kill_tree` has its own tried-once guard.
            _kill_tree(proc)


def _kill_tree(proc: subprocess.Popen) -> bool:
    """Kill the executor AND everything it spawned.

    `proc.kill()` only reaches the process we launched. The documented WSL
    bridge launches `wsl.exe` → `bash` → the actual CLI, so killing the direct
    child on a timeout would leave the CLI running: still burning local
    resources and subscription capacity long after we reported 504.

    Windows: `taskkill /T /F` walks the tree. POSIX: the child is started in its
    own session (``start_new_session``) so the whole group can be signalled at
    once. Both paths are best-effort — a kill that fails must not mask the
    timeout the caller is already reporting.

    THE GROUP ID IS THE ONE CAPTURED AT SPAWN (codex review, round 7). Deriving
    it here with `os.getpgid(proc.pid)` fails once the leader has been reaped —
    and that is exactly the case that matters: the leader exits, its descendants
    do not, `getpgid` raises, the error is swallowed, and the grandchildren
    (the real CLI behind a wsl/node bridge) live on. A pgid recorded while the
    child was definitely alive stays usable afterwards.
    """
    # NEVER SIGNAL A PID WE HAVE ALREADY REAPED. Once `Popen` has collected the
    # exit status the number is free, and `taskkill /T /F` on it can terminate
    # something completely unrelated (codex review, round 16) — the very hazard
    # §5.9a bans for the restart sweep, reached here by a different road because
    # shutdown calls this twice (`_kill_all_children`, then `RunStore.close`).
    #
    # The first call's verdict is remembered on the object, so the second call
    # neither re-kills nor downgrades a confirmed kill to "unverified".
    # A CONFIRMED kill is remembered forever: there is nothing left to signal,
    # and re-running would risk a reaped pid.
    if getattr(proc, "motv_tree_killed", False) is True:
        return True
    _REAP_LOCK.acquire()
    held = True
    # A FAILED one is not (codex review, round 18). Caching the failure made
    # every later cancel attempt return immediately without retrying, so a
    # transient failure left the run permanently `cancelling` with descendants
    # possibly alive. Retry is allowed while the process is still ours to
    # signal, and refused once `Popen` has reaped it — after that the pid may
    # belong to something else entirely (§5.9a).
    if getattr(proc, "motv_tree_reaped", False):
        _REAP_LOCK.release()
        return False
    tree_killed = False
    try:
        if os.name == "nt":
            taskkill = shutil.which("taskkill")
            if taskkill:
                done = subprocess.run(  # noqa: S603 - fixed argv, no shell
                    [taskkill, "/T", "/F", "/PID", str(proc.pid)],
                    capture_output=True,
                    timeout=15,
                    check=False,
                )
                # ONLY rc 0 counts (codex review, round 12). rc 128 is "no such
                # process" — which happens when the direct child has already
                # exited, and that is precisely the case where taskkill could
                # NOT walk its tree: any descendant has been re-parented and is
                # still running. Reading 128 as success turned "we could not
                # check" into a durable `childExitVerified: true`.
                #
                # A process that finished normally therefore reports UNVERIFIED
                # here, which is the honest answer: nobody looked at its
                # descendants. Only the cancel and shutdown paths consult this
                # verdict, and there the child is alive, so taskkill returns 0.
                tree_killed = done.returncode == 0
        else:
            pgid = getattr(proc, "motv_pgid", None)
            if pgid is None:
                pgid = os.getpgid(proc.pid)
            os.killpg(pgid, signal.SIGKILL)
            tree_killed = True
    except ProcessLookupError:
        tree_killed = True  # the whole group is already gone
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        proc.kill()  # the direct child, in case the tree kill did not reach it
    except OSError:
        pass
    # DID IT ACTUALLY DIE? The kill paths above swallow their own errors on
    # purpose (a failed kill must not mask the timeout the caller is already
    # reporting), so "no exception" proves nothing. The caller needs a real
    # answer, because it writes `childExitVerified` into a durable record
    # (codex review, round 9).
    try:
        proc.wait(timeout=5)
    except (subprocess.TimeoutExpired, OSError):
        if held:
            _REAP_LOCK.release()
        return False  # still alive: a later attempt may still succeed
    # From here the direct child has been reaped, so its pid must not be
    # signalled again by a later attempt.
    proc.motv_tree_reaped = True
    if held:
        _REAP_LOCK.release()
        held = False
    if not tree_killed:
        # The direct child is gone but the TREE kill did not report success, so
        # a grandchild (the real CLI behind a wsl/node bridge) may still be
        # running. Verifying only `proc` and returning True here was how a
        # partially-failed termination became a durable `childExitVerified: true`
        # (codex review, round 11).
        return False
    if os.name != "nt":
        # …and on POSIX we can actually CHECK the group rather than trust it.
        pgid = getattr(proc, "motv_pgid", None) or proc.pid
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            proc.motv_tree_killed = True
            return True  # nothing left in the group
        except OSError:
            proc.motv_tree_killed = True
            return True  # not ours to signal any more
        return False  # something in the group is still alive
    proc.motv_tree_killed = True
    return True


def _looks_unauthenticated(blob: str) -> bool:
    """Does this output read as a login problem rather than a crash?"""
    low = (blob or "").lower()
    return any(
        w in low
        for w in (
            "not logged in",
            "please log in",
            "please login",
            "unauthenticated",
            "unauthorized",
            "authentication",
            "auth required",
            "run `codex login`",
            "run `claude login`",
            "invalid api key",
            "no credentials",
        )
    )


def _probe_executor_cached(name: str) -> dict:
    """`_probe_executor` behind a short TTL cache + a single-flight lock, so a
    burst of requests costs at most one subprocess per executor per window."""
    now = time.monotonic()
    with _PROBE_LOCK:
        hit = _PROBE_CACHE.get(name)
        if hit and now - hit[0] < _PROBE_TTL_SECONDS:
            return hit[1]
        res = _probe_executor(name)
        _PROBE_CACHE[name] = (now, res)
        return res


def _probe_executor(name: str) -> dict:
    """What we can PROVE about one executor. Read-only, no side effects.

    Deliberately NOT a readiness claim. A `--version` call succeeds on an
    installed-but-logged-out CLI, so reporting `ready` from it would assert
    something we did not check — and the creator would only discover the real
    state when a run failed. `installed` says exactly what was verified;
    `unauthenticated` is reported when a RUN actually comes back saying so.
    """
    spec = _EXECUTORS[name]
    argv, why = _executor_argv(name)
    if argv is None:
        return {"state": "unavailable", "detail": why}
    # A configured launcher's shape is ours to prefix but not to introspect
    # A configured executor IS probed: the contract is structured now (a
    # transport prefix + an absolute binary), so the version call is just that
    # argv with `--version` in place of our run arguments. Reporting `installed`
    # without trying would present a typo'd path or an unreachable WSL distro as
    # runnable, and the creator would only find out when a run failed.
    probe_argv = (
        [*argv[: -len(spec["args"])], *spec["probe"]]
        if why == "configured"
        else [argv[0], *spec["probe"]]
    )
    try:
        proc = subprocess.run(  # noqa: S603 - argv array, no shell
            probe_argv,
            capture_output=True,
            text=True,
            timeout=20,
            cwd=tempfile.gettempdir(),  # neutral, like the run path
        )
    except subprocess.TimeoutExpired:
        return {"state": "error", "detail": "版本探测超时"}
    except OSError as exc:
        return {"state": "error", "detail": str(exc)[:200]}
    blob = f"{proc.stdout}\n{proc.stderr}"
    if proc.returncode != 0:
        if _looks_unauthenticated(blob):
            return {"state": "unauthenticated", "detail": "执行器已安装但未登录"}
        return {"state": "error", "detail": (proc.stderr or proc.stdout).strip()[:200]}
    return {
        "state": "installed",
        "detail": "已安装（登录状态需一次真实运行才能确认）",
        "version": proc.stdout.strip()[:120],
    }


# --- the Run registry (TASK-072 批次一 / contract §5.0–§5.9) ----------------- #
#
# ONE registry for every long task. `runstore` owns the state machine, the queue,
# persistence and the cancel protocol and knows nothing about HTTP; this file owns
# the only thing it must not know — how to actually start and kill a process.
#
# WHERE IT LIVES (contract §5.5): beside `projects.json`, because it is the same
# CLASS of thing — account-level, cross-project, not source. It moves to the app
# data directory together with `projects.json` under TASK-056; it deliberately
# does NOT go into a project folder, because the restart sweep has to finish
# before any project is opened, and because project-less legacy runs exist.
_RUNS_PATH = DATA_DIR / "runs.json"

#: Which capability each legacy `/api/agent/*` creative endpoint IS. A STABLE
#: MACHINE KEY (contract §5.3) — deliberately not the user-facing task name,
#: which changes with copy and language. `skill.episode-plan` has no catalog
#: entry yet on purpose: the key is decoupled from that undecided design choice
#: (contract §5.9b), so TASK-073 can settle it without renaming history.
_AGENT_TASK_TYPES = {
    "story-develop": "skill.story-development",
    "episode-plan": "skill.episode-plan",
    "script-draft": "skill.script-writer",
    "shots-draft": "skill.storyboard-director",
    "bible-breakdown": "skill.script-breakdown",
}

#: Which Skill package each legacy endpoint runs (TASK-075 §1.6, decision A).
#: The endpoint keeps its URL and its response keys; what it ASKS comes from the
#: package now, so there is one definition of each capability rather than two.
_AGENT_SKILL_IDS = {
    "story-develop": "story-development",
    "episode-plan": "episode-planner",
    "script-draft": "script-writer",
    "shots-draft": "storyboard-director",
    "bible-breakdown": "script-breakdown",
}

#: Where Skill packages come from (ADR-0067 决策 2). The user source sits beside
#: `runs.json` / `projects.json` because it is the same class of thing:
#: account-level, cross-project, not source (TASK-056 / contract §5.5).
_USER_SKILLS_DIR = DATA_DIR / "skills"
_BUILTIN_SKILLS_DIR = REPO_ROOT / "product-skills" / "builtin"
_SKILL_INPUTS_PATH = REPO_ROOT / "product-skills" / "skill-inputs.json"

#: Input caps the legacy endpoints applied before splicing user text into their
#: prompts. `compile_prompt` has none, so switching to packages would have
#: silently dropped them (independent review, TASK-075 B1). Per CONTEXT KEY,
#: because that is what the compiler actually inlines.
_CONTEXT_CAPS = {
    "episodeScript": 50_000,
    # story-develop's `current` was 20 000 and episode-plan's `outline` was
    # 30 000. One key cannot carry two numbers, so take the SMALLER: raising a
    # cap as a side effect of a migration sends 50% more creator text to a model
    # than the endpoint ever promised to (independent review).
    "outline": 20_000,
    "instruction": 2_000,
    # the same 2 000 the legacy `instruction` steer carried; renaming the context
    # key must not raise a cap, so the number travels with it
    "revisionRequest": 2_000,
    # TASK-094 批次 A. A 12-episode plan with the seven facets the product owner
    # asked for is the biggest structure this endpoint sends, and it is bounded by
    # the SAME number the endpoint already admits for the plan it receives back
    # (`_agent_episode_plan`) — one plan-sized limit, not two that can drift.
    "currentPlan": 60_000,
    "characters": 30_000,
    # the asset list is names + keys + tags, never bytes (TASK-094 批次 E)
    "assets": 30_000,
}

#: Per-endpoint overrides, because two endpoints admitted different amounts of
#: the SAME context key: `script-draft` validates `instruction` up to 4 000 and
#: then silently had it cut to 2 000 (independent review).
_ENDPOINT_CONTEXT_CAPS = {
    "script-draft": {"revisionRequest": 4_000},
    # episode-plan admits a 30 000-char outline and spliced it WHOLE; capping it
    # at story-develop's 20 000 truncated legal input mid-string (independent
    # review). One key, two endpoints, two numbers — that is what this table is.
    "episode-plan": {"outline": 30_000},
}
_CONTEXT_CAP_DEFAULT = 50_000

#: Preference order when the caller names no executor. Creative work goes to
#: Claude Code; codex is NEVER defaulted into the creative seat (ADR-0065 决策 3).
_CREATIVE_EXECUTOR_ORDER = ("claude-code",)

#: Opt-in header for the async contract. A header rather than a new URL, so the
#: five legacy endpoints keep BOTH their path and their response shape for every
#: caller that has not migrated (contract §5.9c).
_ASYNC_HEADER = "X-Motv-Async"


def _str(value, default, prefix=""):
    """A non-empty string, optionally namespaced — else the default."""
    if isinstance(value, str) and value.strip():
        return f"{prefix}{value.strip()}" if prefix else value.strip()
    return default


def _run_view(run: dict) -> dict:
    """What a caller is told about a Run.

    `queuePosition` is present but DERIVED (contract §5.6) — the store computes
    it on read, because a stored position is wrong the moment another run ends.
    """
    return {
        "run_id": run["runId"],
        "status": run["status"],
        "queuePosition": run.get("queuePosition"),
        "kind": run.get("kind"),
        "taskType": run.get("taskType"),
        "projectId": run.get("projectId"),
        "executor": run.get("executor"),
        "provider": run.get("provider"),
        "model": run.get("model"),
        "progress": run.get("progress"),
        "cost": run.get("cost"),
        "sideEffect": run.get("sideEffect"),
        "outputs": run.get("outputs"),
        "startedAt": run.get("startedAt"),
        "endedAt": run.get("endedAt"),
        "createdAt": run.get("createdAt"),
        "failureReason": run.get("failureReason"),
        "cancelFailure": run.get("cancelFailure"),
        "cancelNote": run.get("cancelNote"),
        "confirmation": run.get("confirmation"),
        "retryOfRunId": run.get("retryOfRunId"),
        "note": run.get("note"),
    }


#: Run fields the BACKEND owns (contract §5.5). The canvas may carry a snapshot
#: of them for offline display, but it is never their source of truth.
#: Canvas-side terminal states. Reconciliation never moves a record out of one.
_CANVAS_TERMINAL_STATUSES = frozenset({"cancelled", "succeeded", "failed"})

_RUN_LIFECYCLE_FIELDS = (
    "status",
    "progress",
    "startedAt",
    "endedAt",
    "failureReason",
    "cost",
    "sideEffect",
    "outputs",
    "queueSeq",
)


def _reconcile_skill_runs(payload: dict, project: str | None = None) -> None:
    """Stop a canvas save from overwriting live Run progress.

    The page holds the state it LAST READ, while the task kept moving — so a
    perfectly ordinary save would write `running 60%` back to `running 20%`, or
    resurrect a finished run as `running`.

    The fix is ownership, not conflict detection: for any run the backend knows,
    its lifecycle fields are taken from the registry and the client's copy is
    dropped. Note what does NOT happen — the PUT is not REFUSED. The page was
    never the owner of these fields, and rejecting a legitimate canvas save would
    turn an ownership question into the user's problem (contract §5.5 rule 1).

    A run the backend does not know (local/demo mode, a purely front-end manual
    run) is left completely alone: there, the canvas IS the only truth.
    """
    store = None
    if _RUNS is not None:
        store = _RUNS
    elif _RUNS_PATH.exists():
        # A journal exists but nothing has touched the registry yet. Initialising
        # it HERE is what runs the restart sweep; returning early let the first
        # canvas save after a restart write stale lifecycle state back and skip
        # the sweep entirely (codex review, round 8).
        store = runs()
    if store is None:
        return  # no registry and no journal: the document is the only record
    records = payload.get("skillRuns")
    if not isinstance(records, list):
        return
    for rec in records:
        if not isinstance(rec, dict):
            continue
        run_id = rec.get("runId") or rec.get("skillRunId")
        if not isinstance(run_id, str) or not run_id:
            continue
        try:
            # SCOPED TO THE CANVAS'S OWN PROJECT. Looking the id up globally
            # would let a canvas that names another project's run id pull that
            # project's lifecycle fields — INCLUDING `outputs` — straight into
            # this document. Cross-project isolation is not only a read-API rule
            # (contract §5.5); it has to hold on every path that copies data.
            authoritative = store.get(run_id, project=project)
        except runstore.RunStoreError:
            continue  # not ours (or not this project's) -> not ours to correct
        for field in _RUN_LIFECYCLE_FIELDS:
            if (
                field == "status"
                and rec.get("status") in _CANVAS_TERMINAL_STATUSES
                and authoritative.get("executor") == "manual"
            ):
                # A terminal canvas state stands ONLY for a run the front end
                # owns — a manual one, which the creator can settle by abandoning
                # it (codex review, round 13). For anything a local executor is
                # running, the backend is the authority (contract §5.5): honouring
                # a client-supplied terminal state there would let a save report
                # 「已取消」 while the executor keeps running and keeps spending
                # (codex review, round 14).
                continue
            if field == "status":
                # THE CANVAS HAS ITS OWN INVARIANT, and reconciliation must not
                # push a record into a state that breaks it (codex review round 5).
                #
                # v15 requires `succeeded` to carry a proposal and the other
                # terminal states to carry none. The proposal is the FRONT END's
                # to write — it lands when the page reads `outputs` — so copying
                # a backend `succeeded` onto a record that has no proposal yet
                # would produce a document the validator rejects, i.e. a canvas
                # that can no longer be saved.
                #
                # The status is simply left for the page to advance. Everything
                # else (progress, outputs, timings, cost…) is copied regardless,
                # so nothing is lost — only the transition waits for its other half.
                nxt = authoritative.get("status")
                has_proposal = rec.get("proposal") is not None
                if nxt == "succeeded" and not has_proposal:
                    continue
                if nxt in ("failed", "cancelled") and has_proposal:
                    continue
                rec[field] = nxt
            elif field in authoritative:
                rec[field] = authoritative[field]


def _await_run(run_id: str, timeout: float = _SKILL_TIMEOUT_MAX + 60):
    """Block until a Run settles. Used ONLY by the synchronous compatibility
    path — the async path never waits.

    THE DEADLINE DOES NOT INCLUDE QUEUE TIME (codex review, round 2). A fixed
    wall-clock budget measured from submit means that with enough full-length
    runs ahead, the caller gets a 502 while its run is still queued — and then
    the run executes anyway. That is the worst of both: a reported failure AND
    the work happening, which for a paid kind is a charge nobody expects.

    So the clock starts when the run actually starts. Time spent waiting for a
    slot is not time the executor was given.
    """
    started = None
    while True:
        run = runs().get(run_id)
        if run["status"] in runstore.TERMINAL_STATUSES:
            return run
        if run["status"] == "running" and started is None:
            started = time.monotonic()
        if started is not None and time.monotonic() - started > timeout:
            return run
        time.sleep(0.05)


#: Failure category -> the HTTP status the five legacy endpoints have always
#: returned for it. Preserved exactly: the compatibility promise is about the
#: RESPONSE CONTRACT, not about the code path behind it.
_AGENT_STATUS_BY_CATEGORY = {
    "unavailable": (503, "agent_unavailable"),
    "unauthenticated": (503, "agent_unavailable"),
    "timeout": (504, "agent_timeout"),
    "invalid_output": (502, "agent_bad_output"),
    "execution_error": (502, "agent_failed"),
}


def _agent_sync_response(run: dict, key: str):
    """Render a settled Run in the pre-TASK-072 response shape."""
    if run["status"] == "succeeded":
        outputs = run.get("outputs") or {}
        executor = run.get("executor")
        body = {
            key: outputs.get(key),
            "draft": True,
            # `source` KEEPS ITS ESTABLISHED VALUE for the case that used to be
            # the only case. These endpoints always ran `claude -p`, so a caller
            # that compares or displays that string must keep seeing it — the
            # compatibility promise is additive-only, and silently changing an
            # existing value is not an addition (codex review, round 1).
            #
            # When some OTHER executor actually answered, the old string would be
            # a lie, so the real one is reported instead. `executor` below is the
            # precise field; `source` is the legacy one.
            "source": "claude -p" if executor == "claude-code" else executor,
            # additive, so an un-migrated caller ignores them harmlessly
            "run_id": run["runId"],
            "executor": executor,
            "model": run.get("model"),
        }
        return _json(200, body)
    if run["status"] == "cancelled":
        return _json(
            409,
            {
                "error": {
                    "category": "cancelled",
                    "detail": "这次运行已被取消",
                    "run_id": run["runId"],
                }
            },
        )
    reason = run.get("failureReason") or {}
    status, category = _AGENT_STATUS_BY_CATEGORY.get(
        reason.get("category"), (502, "agent_failed")
    )
    detail = reason.get("detail") or "运行失败"
    error = {"category": category, "detail": detail, "run_id": run["runId"]}
    # `raw_excerpt` is an EXISTING field of the bad-output response and callers
    # show it to the creator — dropping it would take away the only clue about
    # what the model actually said (codex review, round 1). The runner packs the
    # excerpt after a separator; it is split back out here rather than being left
    # buried in `detail`.
    if category == "agent_bad_output" and _EXCERPT_SEP in detail:
        error["detail"], _, error["raw_excerpt"] = detail.partition(_EXCERPT_SEP)
    return _json(status, {"error": error})


def _resolve_creative_executor(requested):
    """Which executor runs a creative task, or (None, reason).

    An explicit choice always wins (ADR-0056 决策 1). Otherwise the first
    RUNNABLE local one; `manual` is never auto-selected because it would silently
    turn "run this" into "here is a prompt, go do it yourself" — that has to be
    the creator's decision, and it is offered as a fallback instead.
    """
    if isinstance(requested, str) and requested:
        if not runstore.is_valid_executor(requested):
            return None, f"unknown executor {requested}"
        return requested, "explicit"
    for name in _CREATIVE_EXECUTOR_ORDER:
        argv, why = _executor_argv(name)
        if argv is not None:
            return name, why
    # Nobody is available. Report the REAL reason for the preferred executor
    # rather than a generic "unavailable" — "not on PATH, set X" is actionable.
    _argv, why = _executor_argv(_CREATIVE_EXECUTOR_ORDER[0])
    return None, why


#: Separates the human reason from the bounded raw excerpt inside a single
#: failure detail string, so `_agent_sync_response` can restore the legacy
#: `error.raw_excerpt` field the endpoints have always returned.
_EXCERPT_SEP = "｜原始输出片段："


class _BadAgentOutput(ValueError):
    """The executor answered, but not in the shape the contract requires.

    Its own type so the registry can classify it as `invalid_output` — "the model
    said something unusable" and "the process crashed" call for different next
    actions from the creator (fix/retry the prompt vs. fix the environment).

    The marker (rather than the type) is what the registry classifies on: an
    incidental ValueError from anywhere else in the runner must NOT be relabelled
    as bad model output, nor have its message forwarded.
    """

    motv_invalid_output = True


def _execute_run(run: dict, on_spawn, is_cancelled):
    """Execute one Run on a local executor. Injected into the registry.

    Returns ``(outputs, model)`` or raises — the registry turns both into a
    record. The prompt lives in `params` because it is an INPUT to this run, not
    a piece of durable canon.
    """
    params = run.get("params") or {}
    prompt = params.get("prompt") or ""
    timeout = params.get("timeout") or _SKILL_TIMEOUT_DEFAULT
    executor = run.get("executor")
    text, model = _run_executor(executor, prompt, timeout, on_spawn=on_spawn)
    parser = _AGENT_PARSERS.get(run.get("taskType"))
    if parser is None:
        return {"text": text}, model
    # The async and the sync response carry the SAME key for the same thing
    # (contract §5.9c rule 2): one thing under two names is the next parse bug.
    key, fn = parser
    try:
        # WHICH PACKAGE ANSWERED, from the run's own record — not re-derived from
        # `taskType`, which cannot tell a revision from a first draft (codex
        # 跨模型复审 2026-08-16). `params.skillId` was already written at launch
        # for exactly this class of question.
        value = fn(text, params.get("skillId"))
    except ValueError as exc:
        # A non-conforming answer is a FAILURE, never a partially-kept result.
        # The bounded excerpt travels with it because "it didn't parse" without
        # a sample of what came back is not actionable.
        raise _BadAgentOutput(f"{exc}{_EXCERPT_SEP}{text[:600]}") from exc
    return {key: value, "draft": True, "source": executor}, model


def _terminate_run(proc) -> bool:
    """How the registry kills something. The whole TREE, not the direct child:
    the documented WSL bridge is wsl.exe -> node -> CLI, so killing the bridge
    leaves the CLI running and still consuming subscription capacity.

    Returns whether the process was CONFIRMED gone — the registry records that
    verdict, so a guess would become a durable false claim.
    """
    return bool(proc is not None and _kill_tree(proc))


_RUNS: runstore.RunStore | None = None
_RUNS_INIT_LOCK = threading.Lock()


def runs() -> runstore.RunStore:
    """The process-wide registry, created on first use.

    Lazy so that importing this module (which the test suite does a lot) does not
    write a journal file as a side effect of the import itself.
    """
    global _RUNS
    if _RUNS is None:
        with _RUNS_INIT_LOCK:
            if _RUNS is None:
                # Create the job BEFORE anything can be spawned. Job membership
                # is inherited but NOT retroactive: a job created after the first
                # `Popen` never covers the descendants that launcher already made
                # (codex review, round 8).
                _windows_job()
                _RUNS = runstore.RunStore(
                    _RUNS_PATH,
                    max_concurrent=_SKILL_RUN_MAX_CONCURRENT,
                    runner=_execute_run,
                    terminator=_terminate_run,
                )
    return _RUNS


def _shutdown_runs() -> None:
    """Stop accepting, THEN kill, THEN finalise the records (contract §5.9a).

    The first step is not optional (codex review, round 6): killing the current
    snapshot of children while the queue is still being pumped lets a worker that
    finishes in between start the NEXT queued run — and that brand-new child was
    never in the snapshot, so it outlives the backend. Close the intake first and
    there is nothing left to start.
    """
    if _RUNS is not None:
        _RUNS.stop_accepting()
    _kill_all_children()
    if _RUNS is not None:
        _RUNS.close()


atexit.register(_shutdown_runs)


def _parse_shots(text: str) -> list[dict]:
    """Strictly parse the agent's output into a validated shot-draft list.

    Accepts optional markdown fences / prose around ONE JSON array — including
    the `{"shots": [...]}` envelope the Skill package declares, because slicing
    from the first `[` to the last `]` lands on that array either way. Every item
    must carry the draft fields with sane types. Raises ValueError with a precise
    reason otherwise (fail-closed — the caller reports, never invents).

    THE THREE FAILURES ARE REPORTED SEPARATELY (2026-08-15). They used to share
    one message, 「expected a JSON array of 1-20 shots」, which is what made the
    real defect so hard to see: the model was answering perfectly and the output
    was simply LONGER than a fixture-era cap, but the error named the shape.
    「太多了」 and 「形状不对」 are different answers and the creator acts on them
    differently.
    """
    start = text.find("[")
    end = text.rfind("]")
    if start < 0 or end <= start:
        raise ValueError("no JSON array in agent output")
    try:
        data = json.loads(text[start : end + 1])
    except ValueError as exc:
        raise ValueError(f"agent output is not valid JSON: {exc}") from exc
    if not isinstance(data, list):
        raise ValueError("expected a JSON array of shots")
    if not data:
        raise ValueError("agent returned no shots")
    if len(data) > _MAX_SHOTS_PER_EPISODE:
        raise ValueError(
            f"{len(data)} shots exceeds the {_MAX_SHOTS_PER_EPISODE}-shot "
            "ceiling for one episode"
        )
    shots: list[dict] = []
    for i, item in enumerate(data, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"shot {i} is not an object")
        title = item.get("title")
        desc = item.get("description")
        dur = item.get("duration_seconds")
        seq = item.get("sequence", i)
        if not isinstance(title, str) or not title.strip():
            raise ValueError(f"shot {i}: missing title")
        if not isinstance(desc, str) or not desc.strip():
            raise ValueError(f"shot {i}: missing description")
        # Per the generated-output contract the prompt states, duration is only
        # 6 or 10s. Enforcing membership (not just "finite positive") rejects
        # out-of-contract values like 0.1 or 999999 AND implicitly excludes
        # bool/NaN/Infinity, which are never == 6 or 10. Fail-closed: the caller
        # reports, never propagates an off-contract draft.
        if (
            isinstance(dur, bool)
            or not isinstance(dur, (int, float))
            or dur not in (6, 10)
        ):
            raise ValueError(f"shot {i}: duration_seconds must be 6 or 10")
        if not isinstance(seq, int) or isinstance(seq, bool) or seq <= 0:
            seq = i
        shot = {
            "sequence": seq,
            "title": title.strip()[:80],
            "description": desc.strip()[:500],
            "duration_seconds": float(dur),
        }
        # THE DIRECTING FACETS SURVIVE THE HTTP BOUNDARY (TASK-078 §1.b).
        #
        # This response was built from four keys, so every 景别 / 角度 / 运镜 /
        # 动作 / 情绪 the model produced was DISCARDED here — before the canvas,
        # before `normalizeShots`, before anything the frontend could preserve.
        # That is the real reason the live project reads 0/60 on all of them:
        # not only did the contract mark them optional, the transport dropped
        # them even when they were answered.
        #
        # Additive and non-destructive, exactly like the client-side rule: a
        # facet is carried when it is a non-empty string and OMITTED otherwise,
        # so a shot that never had one is byte-identical to before.
        for key in _SHOT_FACETS:
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                shot[key] = value.strip()[:500]
        shots.append(shot)
    shots.sort(key=lambda s: s["sequence"])
    return shots


def _parse_bible_breakdown(text: str) -> dict:
    """Strictly parse the agent's script-breakdown output (fail-closed).

    Accepts optional fences/prose around ONE JSON object holding
    ``characters`` / ``locations`` lists. Only shape is enforced here (dict
    entries with a non-empty string name, list sizes capped); the client's
    breakdown module re-sanitizes every field before anything is shown, and
    nothing is written server-side — the result is a PROPOSAL payload only.
    """
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in agent output")
    try:
        data = json.loads(text[start : end + 1])
    except ValueError as exc:
        raise ValueError(f"agent output is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("expected a JSON object")
    out: dict = {"characters": [], "locations": []}
    for key in ("characters", "locations"):
        items = data.get(key, [])
        if not isinstance(items, list) or len(items) > 20:
            raise ValueError(f"{key} must be a list of at most 20 entries")
        for i, item in enumerate(items, start=1):
            if not isinstance(item, dict):
                raise ValueError(f"{key} entry {i} is not an object")
            name = item.get("name")
            if not isinstance(name, str) or not name.strip():
                raise ValueError(f"{key} entry {i}: missing name")
            out[key].append(item)
    if not out["characters"] and not out["locations"]:
        raise ValueError("breakdown found no characters or locations")
    return out


def _parse_story_outline(text: str) -> dict:
    """Strictly parse the agent's story-development output (fail-closed).

    ONE JSON object with the outline facets. Shape-only here (the client's
    storydoc module re-sanitizes every field; nothing is written server-side —
    the result is a PROPOSAL payload). Requires at least ONE one-line statement of
    what the story is, so an empty non-answer never reads as a valid outline.

    `storyCore` is that statement since `story-development` v2 (TASK-089 §2.1):
    the product owner's first item. `premise` / `logline` stay accepted because
    this parser is ALSO the manual-submission sanitiser — a creator pasting an
    outline written in the old shape, and every outline already on disk, must keep
    working (TASK-089 §2.2: a field in use is never silently dropped).
    """
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in agent output")
    try:
        data = json.loads(text[start : end + 1])
    except ValueError as exc:
        raise ValueError(f"agent output is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("expected a JSON object")
    if not any(
        isinstance(data.get(key), str) and data[key].strip()
        for key in ("storyCore", "premise", "logline")
    ):
        raise ValueError("outline has no storyCore (nor a legacy premise/logline)")
    return data


def _parse_episode_plan(text: str) -> list[dict]:
    """Strictly parse the agent's episode-plan output (fail-closed).

    ONE JSON object holding an ``episodes`` list (1-50); every entry must be
    an object with a non-empty title. The client re-sanitizes fields.
    """
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in agent output")
    try:
        data = json.loads(text[start : end + 1])
    except ValueError as exc:
        raise ValueError(f"agent output is not valid JSON: {exc}") from exc
    episodes = data.get("episodes") if isinstance(data, dict) else None
    if not isinstance(episodes, list) or not (1 <= len(episodes) <= 50):
        raise ValueError("expected an 'episodes' list of 1-50 entries")
    for i, item in enumerate(episodes, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"episode {i} is not an object")
        title = item.get("title")
        if not isinstance(title, str) or not title.strip():
            raise ValueError(f"episode {i}: missing title")
    return episodes


def _data_embed(text: str) -> str:
    """Neutralize closing-tag sequences in user text embedded inside data tags.

    The prompts frame user content between markers like ``<剧本>…</剧本>`` and
    extract the reply from ``<剧本输出>…</剧本输出>``; a payload containing a
    literal ``</`` could close a data tag early (or forge the output block) and
    smuggle text past the "pure data" framing. Replacing ``</`` with its
    fullwidth look-alike keeps the content readable while making every ASCII
    closing tag inert.
    """
    return text.replace("</", "＜/")


def _parse_script_text(text: str) -> str:
    """Extract the script draft from the agent's output (fail-closed).

    The prompt requires the full script inside EXACTLY ONE
    ``<剧本输出>…</剧本输出>`` block; anything outside it (explanations,
    markdown fences) is discarded. Multiple blocks or stray markers are
    rejected outright — extracting across them would splice wrapper prose
    into the canonical draft. Missing/duplicated block, empty body or an
    over-cap body raises ValueError — the caller reports the error with a
    bounded excerpt, never fabricates or passes through wrapper prose as
    the canonical script.
    """
    if text.count(_SCRIPT_OUT_OPEN) != 1 or text.count(_SCRIPT_OUT_CLOSE) != 1:
        raise ValueError("expected exactly one <剧本输出> block in agent output")
    start = text.find(_SCRIPT_OUT_OPEN)
    end = text.find(_SCRIPT_OUT_CLOSE)
    if end <= start:
        raise ValueError("malformed <剧本输出> block in agent output")
    out = text[start + len(_SCRIPT_OUT_OPEN) : end].strip()
    if not out:
        raise ValueError("agent output is empty")
    if len(out) > _SCRIPT_DRAFT_MAX:
        raise ValueError("agent output exceeds script size cap")
    return out


# taskType -> (response key, strict parser). Defined here, after the parsers, and
# consulted by `_execute_run` at call time.
#
# THE KEY IS THE SAME on both paths (contract §5.9c rule 2): the synchronous
# response says `{"shots": …}` and `GET /api/runs/<id>.outputs` says `{"shots": …}`.
# Two names for one thing is how the next parsing bug gets written.
#: Product keys whose contract IS free text rather than a structure. Only these
#: may be submitted manually without going through a parser — everything else is
#: a JSON shape and is validated as one (codex review, round 19).
_TEXT_PRODUCT_KEYS = frozenset({"script"})

#: How each endpoint's payload maps onto its capability's declared context keys.
#: The endpoint keeps its OWN request shape (contract §5.9c) — only what it asks
#: the model changes — so the translation lives here rather than in the packages.
_PAYLOAD_TO_CONTEXT = {
    "shots-draft": lambda p: {"episodeScript": p.get("script")},
    # 「AI 需要根据现在的剧本和**已经上传的资产**来…」 (产品负责人 2026-08-17,
    # TASK-090 §2.2). `script-breakdown` declared `assets` as an optional input at
    # v2 and this is what supplies it: without the list, the capability cannot
    # connect what it reads in the script to a reference the creator already
    # uploaded, so it proposes a brand-new object every time.
    "bible-breakdown": lambda p: {
        "episodeScript": p.get("script"),
        "characters": p.get("characters"),
        "assets": p.get("assets"),
    },
    "story-develop": lambda p: (
        # TWO MODES, the same shape as `script-draft` and `episode-plan`
        # (TASK-089 §2.4 / TASK-094 批次 C). This endpoint always carried the
        # current outline, so 「AI 改」 was never as broken here as it was for the
        # plan — but the revision REQUEST travelled as a fenced steer, which is a
        # per-run add-on rather than something the capability declares it needs.
        # As a declared input of the reviser, `missingInputs` can refuse a revision
        # that asks for no revision.
        {
            "outline": p.get("current"),
            "revisionRequest": p.get("instruction"),
            "brief": p.get("idea"),
        }
        if _is_revision("story-develop", p)
        else {"brief": p.get("idea"), "outline": p.get("current")}
    ),
    "episode-plan": lambda p: (
        # TWO MODES, TWO CAPABILITIES — the same shape `script-draft` proved
        # (TASK-088 §2.2). Until TASK-094 批次 A this endpoint sent the OUTLINE
        # only, so 「用 AI 改规划」 handed the model no plan to change and it wrote a
        # fresh one every time: four versions of the real project came back with
        # four completely different EP01 titles, and every confirmation minted 12
        # more episodes (4 × 12 = the 48 the product owner found).
        #
        # The current plan is DOMAIN CONTEXT, not a steer: a steer is dropped by
        # `compile_prompt`, which is exactly how the script reviser silently lost
        # its base script once already.
        {
            "currentPlan": p.get("current_plan"),
            "revisionRequest": p.get("instruction"),
            "outline": p.get("outline"),
            "characters": p.get("characters"),
        }
        if _is_revision("episode-plan", p)
        else {"outline": p.get("outline"), "characters": p.get("characters")}
    ),
    "script-draft": lambda p: (
        # TWO MODES, TWO CAPABILITIES. Revising is not writing: the reviser is
        # told to keep everything the creator did not ask about, and the base
        # script is its DOMAIN CONTEXT, not a steer — so it goes through the
        # shared compiler's fence like any other context value.
        # The revision REQUEST is a declared input too (§1.4 blocker): while it
        # lived in `_EXTRA_FENCED` it existed only on this endpoint, so the same
        # capability offered in the page compiled a revision prompt with nothing
        # to revise toward. Declared means `missingInputs` refuses instead.
        {
            "episodeScript": p.get("base_script"),
            "revisionRequest": p.get("instruction"),
        }
        if _is_revision("script-draft", p)
        else {"brief": p.get("idea"), "episodePlan": p.get("episode")}
    ),
}


#: One endpoint, TWO capabilities: writing something, and revising it.
#:
#: A `namedtuple`, NOT a dataclass. This module is loaded by
#: `spec_from_file_location` in ~30 tests without being registered in
#: `sys.modules`, and `@dataclass` resolves its string annotations (this file has
#: `from __future__ import annotations`) through `sys.modules[cls.__module__]` —
#: which is None under that loader, so a dataclass here fails at IMPORT time and
#: takes every one of those tests with it. `namedtuple` evaluates no annotations.
_TwoModes = namedtuple("_TwoModes", "writer reviser steer_key base_key base_decides")
_TwoModes.__doc__ = """One endpoint, two capabilities: writing, and revising.

    THE SHAPE, DECLARED ONCE (TASK-094 §1.1). `script-draft` discovered it the
    hard way — 「Revising is not writing」, and the thing being revised is DOMAIN
    CONTEXT rather than a steer, because a steer is dropped by `compile_prompt`
    and the revision mode silently lost its base script until a test caught it.
    Two more endpoints need the same shape now, so it is a table rather than
    three copies of one `if`: three copies is how one of them ends up
    disagreeing with the other two.

    ``steer_key``  the payload key holding the creator's revision REQUEST
    ``base_key``   the payload key holding WHAT IS BEING REVISED
    ``base_decides``  whether an absent base means 「not a revision」.

    WHY THAT LAST FLAG IS NOT THE SAME FOR EVERY ENDPOINT, stated rather than
    smoothed over. On `script-draft` a non-empty instruction ALWAYS means
    revision: the initial mode takes `idea`, so there is no legitimate 「write a
    fresh script from an instruction」 request, and one arriving without a base
    script must be REFUSED loudly (`missingInputs` does it) instead of quietly
    writing a new script over the creator's draft. On the plan and outline
    endpoints the very same payload legitimately means 「generate a fresh one,
    with this steer」 — that is what 「重新规划」 sends today — so an absent base
    selects the writer instead of failing.
    """

#: Which endpoints have two modes. Registered here, consumed by `_is_revision`,
#: `_skill_id_for` and `_extra_fenced` — one rule, three readers.
_TWO_MODES: dict[str, _TwoModes] = {
    "script-draft": _TwoModes(
        writer="script-writer",
        reviser="script-reviser",
        steer_key="instruction",
        base_key="base_script",
        base_decides=False,
    ),
    # TASK-094 批次 A. `base_decides=True`: 「🪄 重新规划」 legitimately sends a steer
    # with no current plan, and that request means 「write a fresh plan, in this
    # direction」 — so an absent plan selects the PLANNER rather than failing.
    "episode-plan": _TwoModes(
        writer="episode-planner",
        reviser="episode-plan-reviser",
        steer_key="instruction",
        base_key="current_plan",
        base_decides=True,
    ),
    # TASK-094 批次 C. `base_decides=True` for the same reason: 「AI 发展故事」 on a
    # project that already has an outline legitimately means 「write a fresh one,
    # in this direction」, and there is no outline at all on the first run.
    "story-develop": _TwoModes(
        writer="story-development",
        reviser="story-reviser",
        steer_key="instruction",
        base_key="current",
        base_decides=True,
    ),
}


def _is_revision(slug: str, payload: dict) -> bool:
    """Revision mode, decided ONCE.

    `_agent_script_draft` branches on `instruction`; selecting the package on
    `base_script` instead meant a payload carrying BOTH took the initial branch
    and then ran the reviser with no revision requirement anywhere in the
    prompt (independent review). Two definitions of one mode is one too many.

    An endpoint that is not in `_TWO_MODES` has no revision mode at all, so it
    answers False rather than guessing from a key that happens to be present.
    """

    mode = _TWO_MODES.get(slug)
    if mode is None:
        return False
    steer = payload.get(mode.steer_key)
    if not (isinstance(steer, str) and steer.strip()):
        return False
    if not mode.base_decides:
        return True
    base = payload.get(mode.base_key)
    if isinstance(base, str):
        return bool(base.strip())
    # a plan or an outline arrives as a STRUCTURE; an empty one is not a base
    return bool(base)


def _cap_for(slug: str, key: str) -> int:
    """How much of one context value may reach a model, for THIS endpoint."""

    override = _ENDPOINT_CONTEXT_CAPS.get(slug, {})
    if key in override:
        return override[key]
    return _CONTEXT_CAPS.get(key, _CONTEXT_CAP_DEFAULT)


def _skill_id_for(slug: str, payload: dict) -> str:
    """Which package answers THIS request.

    Mode-dependent for every endpoint in `_TWO_MODES`. Pointing revision mode at
    `script-writer` asked the model to WRITE this episode's script while handing
    it the creator's draft — so a 5 000-word draft plus 「结尾加一个反转」 came
    back as a freshly invented script presented as the revision (independent
    review). The instruction that made the legacy prompt correct —— 「保留未被
    要求修改的部分」 —— had no home until this package existed.
    """

    mode = _TWO_MODES.get(slug)
    if mode is not None and _is_revision(slug, payload):
        return mode.reviser
    return _AGENT_SKILL_IDS[slug]


#: Per-run steers that are NOT domain context: they belong to this request, not
#: to the capability, so they are appended in the same fence instead of being
#: declared as inputs the capability would then appear to require.
#:
#: READ THROUGH `_extra_fenced`, NEVER DIRECTLY (TASK-094 §1.1): on a two-mode
#: endpoint the same key is a fenced steer in WRITER mode and a declared input of
#: the reviser in REVISION mode, and sending it twice would put the creator's
#: revision request into the prompt under two different headings.
_EXTRA_FENCED = {
    "story-develop": (("instruction", "修改要求"),),
    "episode-plan": (("instruction", "修改要求"),),
    # `script-draft` is NOT here. Both of its steers are now DECLARED inputs of
    # the reviser (`episodeScript` + `revisionRequest`), so both travel through
    # `compile_prompt`'s fence, which has behavioural coverage — and the capability
    # states what it needs, so the page can offer it without silently producing a
    # revision instruction that asks for no revision.
    #
    # Safe to drop entirely because `_is_revision` is DEFINED on a non-empty
    # `instruction`: a script-draft request carrying one is always revision mode,
    # so the initial-draft branch never had a steer to lose.
}


def _extra_fenced(slug: str, payload: dict) -> tuple[tuple[str, str], ...]:
    """The per-run steers to fence for THIS request.

    A two-mode endpoint's steer changes ROLE with the mode: in writer mode it is
    a per-run steer with no home among the writer's declared inputs (「重新规划，
    偏权谋」), and in revision mode it IS a declared input of the reviser. Fencing
    it in revision mode too would send the same creator text twice under two
    headings — and dropping the table entry outright, which is what
    `script-draft` could safely do, would silently discard the writer-mode steer
    on the endpoints where that mode legitimately carries one.
    """

    spec = _EXTRA_FENCED.get(slug, ())
    mode = _TWO_MODES.get(slug)
    if mode is not None and _is_revision(slug, payload):
        return tuple(x for x in spec if x[0] != mode.steer_key)
    return spec


#: taskType -> the Skill package that answers it (inverse of the slug map).
_TASK_TYPE_SKILL_IDS = {
    _AGENT_TASK_TYPES[slug]: skill_id for slug, skill_id in _AGENT_SKILL_IDS.items()
}


def _skill_answer(task_type: str, text: str, skill_id: str | None = None) -> dict:
    """Parse an executor's answer and hold it to the SKILL's own contract.

    TASK-075 §1.6 / decision A: the endpoints ask the package's question now, so
    the package's `output.schema.json` is what judges the answer. One definition
    of each capability instead of two.

    `skill_id` NAMES THE PACKAGE THAT ACTUALLY ANSWERED (codex 跨模型复审
    2026-08-16). Deriving it from `task_type` alone was wrong for the one slug
    that picks its package at request time: a REVISION runs `script-reviser`,
    while `task_type` stays `skill.script-writer` — so the answer was judged by
    a schema belonging to a package that was never asked. The two builtin
    schemas happen to be identical today, which is why nothing failed; a
    user-level `script-reviser` (the whole point of ADR-0067 决策 2) makes it
    live, and then a valid answer is rejected or an invalid one is returned as
    the product.

    Falls back to the task-type mapping when the caller does not know — a run
    recorded before `skillId` was carried has nothing better to offer.
    """

    skill_id = skill_id or _TASK_TYPE_SKILL_IDS.get(task_type)
    skill = _load_skill_catalog().skills.get(skill_id) if skill_id else None
    if skill is None:
        # fail closed: without the package there is no contract to judge by, and
        # accepting the answer anyway is exactly the "two truths" this removes
        raise ValueError(f"能力包不可用：{skill_id or task_type}")
    value = skillpkg.parse_skill_output(text)
    skillpkg.validate_output(skill.output_schema, value)
    return value


def _adapt_shots(text: str, skill_id: str | None = None) -> list[dict]:
    """`{shots:[…]}` -> the legacy shot-draft list.

    The legacy sanitiser is REUSED rather than reimplemented: it caps the list,
    fills `sequence`, enforces the 6/10s duration and truncates the strings, and
    the response contract is defined by exactly those rules (§1.6 「响应契约不变」).
    """

    answer = _skill_answer("skill.storyboard-director", text, skill_id)
    return _parse_shots(json.dumps(answer["shots"], ensure_ascii=False))


def _adapt_breakdown(text: str, skill_id: str | None = None) -> dict:
    answer = _skill_answer("skill.script-breakdown", text, skill_id)
    return _parse_bible_breakdown(json.dumps(answer, ensure_ascii=False))


def _adapt_outline(text: str, skill_id: str | None = None) -> dict:
    answer = _skill_answer("skill.story-development", text, skill_id)
    return _parse_story_outline(json.dumps(answer, ensure_ascii=False))


def _adapt_episodes(text: str, skill_id: str | None = None) -> list[dict]:
    answer = _skill_answer("skill.episode-plan", text, skill_id)
    return _parse_episode_plan(json.dumps(answer, ensure_ascii=False))


def _adapt_script(text: str, skill_id: str | None = None) -> str:
    """`{script, notes?}` -> the legacy script string.

    The `<剧本输出>` block is gone — the Skill answers JSON — so the block
    EXTRACTION is dropped while the rules that shape the response (strip, the
    size cap, empty is a failure) are kept exactly.
    """

    answer = _skill_answer("skill.script-writer", text, skill_id)
    out = answer["script"].strip()
    if not out:
        raise ValueError("agent output is empty")
    if len(out) > _SCRIPT_DRAFT_MAX:
        raise ValueError("agent output exceeds script size cap")
    return out


#: taskType -> the PRODUCT sanitiser, for manually submitted results. These are
#: the legacy parsers, unchanged: a creator submits the product itself, so the
#: contract it must meet is the product's, not the model answer's.
_MANUAL_SANITISERS = {
    "skill.storyboard-director": _parse_shots,
    "skill.script-breakdown": _parse_bible_breakdown,
    "skill.story-development": _parse_story_outline,
    "skill.episode-plan": _parse_episode_plan,
}

#: taskType -> (response key, adapter). The KEY is unchanged for all five, which
#: is what keeps every unmigrated caller working (contract §5.9c).
_AGENT_PARSERS = {
    "skill.storyboard-director": ("shots", _adapt_shots),
    "skill.script-breakdown": ("breakdown", _adapt_breakdown),
    "skill.story-development": ("outline", _adapt_outline),
    "skill.episode-plan": ("episodes", _adapt_episodes),
    "skill.script-writer": ("script", _adapt_script),
}


def _recorded_skill_digests() -> dict[tuple[str, int], str]:
    """Which ``(skillId, skillVersion)`` history already points at.

    This is what makes §1.2 real: a package whose CONTENT changed while its
    version did not is refused, because historical Runs claim to have used that
    exact version and letting the bytes move underneath them turns provenance
    into a guess. The loader stays storage-agnostic — it is told, not told where
    to look.
    """

    return runs().skill_digests()


def _load_skill_catalog(project_root: Path | None = None):
    """The merged capability catalog for this request.

    Loaded per call rather than cached: a creator can drop a package into
    `studio/skills/` while the server runs, and a catalog that went stale until
    restart would show them a capability list that is not the one being
    executed.
    """

    project_dir = None
    contain_within = None
    if project_root is not None:
        # CONTAINED IN THE PROJECT (ADR-0067 补记 / TASK-084 项 4). A junction at
        # `studio/skills` could point anywhere on the disk, and its packages then
        # loaded as 「这一部作品的」 Skill — their prompt text is inlined into what
        # is sent to the executor, and `source: "project"` is the field that
        # decides override priority. Cross-project sharing is the USER source's
        # job; it is not something a reparse point gets to arrange silently.
        contain_within = Path(project_root)
        project_dir = contain_within / "studio" / "skills"
    return skillpkg.load_catalog(
        [
            ("project", project_dir, contain_within),
            # The other two roots are OWNED BY THIS INSTALL, not by a project, so
            # they are their own containment boundary: `_package_dirs` still
            # requires every package to resolve inside the root it came from.
            ("user", _USER_SKILLS_DIR),
            ("builtin", _BUILTIN_SKILLS_DIR),
        ],
        known_digests=_recorded_skill_digests(),
    )


def _skill_input_labels() -> dict:
    try:
        return skillpkg.load_input_labels(_SKILL_INPUTS_PATH)
    except skillpkg.SkillPackageError:
        # fail closed: without labels the compiled prompt would silently differ
        # from the page's, which is the one thing acceptance #7 forbids
        return {}


def _host_is_loopback(host_header):
    if not host_header:
        return True
    host = host_header.strip()
    if host.startswith("["):
        host = host[1:].split("]", 1)[0]
    elif host.count(":") == 1:
        host = host.rsplit(":", 1)[0]
    return host.lower() in _LOOPBACK_HOSTS


class _App:
    """Transport-agnostic routing + read-only query/persistence logic.

    POST ``/api/projects/<name>/{preflight,command}`` routes to a per-project
    Command Gateway. Its registry always holds the no-spend ``lock-draft-plan``
    command (ADR-0047: canvas draft -> official versioned plan/records/packets,
    preview -> confirmed submit); with ``paid_catalog_dir`` set (server started
    with ``--enable-paid``) it additionally holds the authorized
    ``submit-video-generation`` command (ADR-0041). Paid registration is doubly
    gated (in-code ``authorized=True`` + the
    ``AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1`` deployment flag); a real
    provider call additionally needs ``WFM1_MINIMAX_API_KEY`` at submit time.
    The server never calls a Provider itself — every write goes through the
    Gateway → approved coordinator (ADR-0033 P1/P2).
    """

    def __init__(self, account_root: Path, paid_catalog_dir: Path | None = None):
        self.account_root = account_root
        self._svc = None
        self._projects: dict[str, Path] = {}
        self.paid_catalog_dir = paid_catalog_dir
        # lock-draft-plan (ADR-0047) spends nothing, so it is registered in
        # BOTH modes; it needs the same locked catalog the paid flow prices
        # against (default: <account-root>/catalog, the --catalog-dir default).
        self.lock_catalog_dir = (
            paid_catalog_dir
            if paid_catalog_dir is not None
            else (account_root / "catalog" if account_root is not None else None)
        )
        if _QUERY_OK and account_root is not None:
            try:
                self._svc = WorkspaceQueryService(
                    account_root, clock=lambda: datetime.now(timezone.utc)
                )
                self._projects = {
                    p.name: p.root for p in discover_projects(account_root)
                }
            except Exception:  # noqa: BLE001 - stay up; queries just return unavailable
                self._svc = None
        # ADR-0051: projects created through the studio may live under OTHER
        # roots. Merge the durable registry on top of the account-root scan so
        # they survive a restart. A registered project whose directory is gone
        # is dropped rather than served as a phantom.
        for entry in _load_registry_projects():
            root = Path(entry["root"])
            if not root.is_dir():
                continue  # gone: dropped rather than served as a phantom
            # The stored path was already RESOLVED when the project was
            # created, so it must still resolve to itself. If it no longer
            # does, something replaced the directory with a link since the last
            # run and following it would write outside the admitted root.
            try:
                if root.resolve() != root:
                    continue
            except OSError:
                continue
            self._projects.setdefault(entry["name"], root)

    @property
    def connected(self) -> bool:
        return self._svc is not None

    @property
    def paid(self) -> bool:
        return self.paid_catalog_dir is not None

    def _command_gateway(self, root: Path):
        """A per-project Gateway over the approved mockup command registry.

        ``lock-draft-plan`` (no-spend, ADR-0047) is always registered; the
        paid ``submit-video-generation`` command only in paid mode. Targets
        are resolved per command family: shot-plan refs bind the draft lock,
        shot-record refs bind paid generation.
        """
        from ai_video_workflow.app.gateway_commands import (
            register_creative_loop_commands,
        )
        from ai_video_workflow.app.lock_gateway import (
            ShotPlanTargetResolver,
            register_lock_draft_command,
        )
        from ai_video_workflow.app.paid_gateway import ShotRecordTargetResolver
        from ai_video_workflow.gateway import CommandGateway, CommandRegistry

        registry = CommandRegistry()
        register_lock_draft_command(
            registry,
            catalog_dir=self.lock_catalog_dir,
            account_root=self.account_root,
        )
        # TASK-103 批次 B: the evaluation / feedback / action loop (TASK-087 §1.2).
        # These four spend nothing and were already implemented and registered for
        # the workspace shell; the Studio simply never registered them, so the one
        # interface a creator actually uses could not reach them. Wiring, not a new
        # capability — and the SAME specs, imported rather than copied.
        register_creative_loop_commands(registry)
        if self.paid:
            from ai_video_workflow.app.media_fetch import UrllibMediaFetcher
            from ai_video_workflow.app.paid_gateway import (
                register_paid_video_command,
            )
            from ai_video_workflow.providers.registry import default_registry

            register_paid_video_command(
                registry,
                provider_registry=default_registry,
                fetcher=UrllibMediaFetcher,
                catalog_dir=self.paid_catalog_dir,
                authorized=True,  # --enable-paid; env flag enforced inside
                account_root=self.account_root,
            )

        plan_resolver = ShotPlanTargetResolver()
        shot_resolver = ShotRecordTargetResolver()

        class _RefDispatchResolver:
            """Route a target ref to its command family's resolver.

            Ref shapes are disjoint (``planning/shot_plan_v<N>.json`` vs a
            bare shot id / ``records/shots/<id>.json``); anything either
            resolver does not recognize reads as absent (fail-closed at the
            Gateway).
            """

            def resolve_target(self, project_root, *, ref, version):
                if isinstance(ref, str) and ref.startswith("planning/"):
                    return plan_resolver.resolve_target(
                        project_root, ref=ref, version=version
                    )
                return shot_resolver.resolve_target(
                    project_root, ref=ref, version=version
                )

        return CommandGateway(
            root,
            registry=registry,
            target_resolver=_RefDispatchResolver(),
            clock=lambda: datetime.now(timezone.utc),
        )

    # -- GET routing ------------------------------------------------------
    def handle(self, raw_path: str, headers=None):
        path = urlsplit(raw_path).path
        if path in ("/", "/index.html"):
            return self._static("index.html")
        if path == "/api/meta":
            return _json(
                200,
                {
                    "contract_version": QUERY_CONTRACT_VERSION,
                    "mode": "connected" if self.connected else "local",
                    "paid": self.paid,
                    "account_root": str(self.account_root)
                    if self.account_root
                    else None,
                },
            )
        if path == "/api/runtimes":
            # CP3/ADR-0056: honest availability. An executor that is not
            # installed and not configured is reported `unavailable` with the
            # exact env var that would wire it — never a fabricated "ready".
            #
            # Guarded by the SAME custom header as /api/skill/run (codex review,
            # round 8): this route spawns `--version` subprocesses, so a
            # cross-origin page must not be able to trigger them at all. Results
            # are cached besides, bounding the cost for legitimate callers.
            if (headers or {}).get(_SKILL_RUN_HEADER) != "1":
                return _json(
                    403,
                    {
                        "error": {
                            "category": "forbidden",
                            "detail": f"{_SKILL_RUN_HEADER}: 1 required",
                        }
                    },
                )
            return _json(
                200,
                {
                    "executors": {
                        name: _probe_executor_cached(name)
                        for name in sorted(_EXECUTORS)
                    }
                },
            )
        if path == "/api/runs" or path.startswith("/api/runs/"):
            # Same custom-header guard as the rest of the runtime surface: these
            # routes report on (and can cancel) real local processes.
            if (headers or {}).get(_SKILL_RUN_HEADER) != "1":
                return _json(
                    403,
                    {
                        "error": {
                            "category": "forbidden",
                            "detail": f"{_SKILL_RUN_HEADER}: 1 required",
                        }
                    },
                )
            return self._runs_get(raw_path)
        if path == "/api/skills":
            # The page cannot read a filesystem, so the backend is the loader
            # and this is the ONLY way the catalog reaches the browser
            # (TASK-075 §1.0). Problems travel with it: a capability that failed
            # to load must be visibly unavailable WITH ITS REASON, never just
            # absent from the list.
            q = parse_qs(urlsplit(raw_path).query)
            name = (q.get("project") or [""])[0]
            root = None
            if name:
                if not _valid_project_name(name) or name not in self._projects:
                    # 404, not 403 — a cross-project probe learns nothing about
                    # whether the project exists
                    return _json(
                        404,
                        {
                            "error": {
                                "category": "not_found",
                                "detail": "unknown project",
                            }
                        },
                    )
                root = self._project_root(name)
            catalog = _load_skill_catalog(root)
            try:
                body = skillpkg.catalog_payload(catalog, _SKILL_INPUTS_PATH)
            except skillpkg.SkillPackageError as exc:
                # The shared context tables are part of the contract the page
                # installs. Serving the catalog without them would look like a
                # success and quietly strip every input label and the shot-scoped
                # routing list, so this fails loudly instead (ADR-0067 决策 7).
                return _json(
                    503,
                    {"error": {"category": "unavailable", "detail": str(exc)}},
                )
            return _json(200, body)
        if path == "/api/fs/default":
            return _json(
                200,
                {
                    "root": str(self.account_root) if self.account_root else None,
                    "sep": os.sep,
                    "home": str(Path.home()),
                },
            )
        if path == "/api/fs/list":
            q = parse_qs(urlsplit(raw_path).query)
            return self._fs_list((q.get("path") or [""])[0])
        if path == "/api/projects":
            if not self.connected:
                return _json(200, {"projects": [], "mode": "local"})
            return _json(
                200, {"projects": [{"name": n} for n in sorted(self._projects)]}
            )
        if path.startswith("/api/projects/"):
            rest = path[len("/api/projects/") :]
            name, _, sub = rest.partition("/")
            if sub.startswith("generation-target"):
                params = parse_qs(urlsplit(raw_path).query)
                return self._generation_target(
                    unquote(name), (params.get("shot_id") or [""])[0]
                )
            if sub.startswith("media-audit"):
                params = parse_qs(urlsplit(raw_path).query)
                return self._media_audit(
                    unquote(name), (params.get("measure") or [""])[0]
                )
            if sub.startswith("review-target"):
                params = parse_qs(urlsplit(raw_path).query)
                return self._review_target(
                    unquote(name), (params.get("shot_id") or [""])[0]
                )
            if sub == "lock-target":
                return self._lock_target(unquote(name))
            if sub == "shots":
                return self._shots(unquote(name))
            return self._query(unquote(name), sub)
        if path.startswith("/api/paid-ops/"):
            return self._paid_ops(unquote(path[len("/api/paid-ops/") :]))
        if path.startswith("/api/canvas/"):
            return self._canvas_get(unquote(path[len("/api/canvas/") :]))
        if path.startswith("/api/uploads/"):
            rest = unquote(path[len("/api/uploads/") :])
            project, _, fname = rest.partition("/")
            return self._upload_get(project, fname)
        rel = path.lstrip("/")
        if any(rel.startswith(p) for p in _STATIC_PREFIXES):
            return self._static(rel)
        return _json(
            404, {"error": {"category": "not_found", "detail": "unknown route"}}
        )

    # -- PUT (mockup-local canvas save / manual image upload) ---------------
    def handle_put(self, raw_path: str, body: bytes, ctype: str = ""):
        path = urlsplit(raw_path).path
        if path.startswith("/api/canvas/"):
            return self._canvas_put(unquote(path[len("/api/canvas/") :]), body)
        if path.startswith("/api/uploads/"):
            rest = unquote(path[len("/api/uploads/") :])
            project, _, slug = rest.partition("/")
            if self._migration_required(project):
                return _migration_required_json()
            return self._upload_put(project, slug, ctype, body)
        return _json(
            404,
            {"error": {"category": "not_found", "detail": "unknown write route"}},
        )

    # -- POST (Gateway write path, ADR-0041/0047) ---------------------------
    def handle_post(self, raw_path: str, body: bytes, headers=None):
        path = urlsplit(raw_path).path
        # Agent routes carry small JSON envelopes only; the Gateway
        # preflight/command routes may inline first-frame data URLs
        # (lock-draft-plan) and share the transport ceiling instead.
        is_command_route = path.startswith("/api/projects/") and path.endswith(
            ("/preflight", "/command")
        )
        cap = _COMMAND_BODY_MAX if is_command_route else _GATEWAY_BODY_MAX
        if len(body) > cap:
            return _json(
                413,
                {
                    "error": {
                        "category": "too_large",
                        "detail": "request body too large",
                    }
                },
            )
        # ADR-0053: every route below that WRITES project media is refused while
        # the project still has unmigrated legacy data. Gating here rather than
        # in each handler means a new media-writing route cannot forget it and
        # silently strand bytes in a project whose canvas is still legacy.
        if path in _MEDIA_WRITE_ROUTES:
            try:
                project = json.loads(body.decode("utf-8")).get("project")
            except (ValueError, UnicodeDecodeError, AttributeError):
                project = None
            if (
                isinstance(project, str)
                and project
                and self._migration_required(project)
            ):
                return _migration_required_json()
        if path == "/api/skill/run":
            return self._skill_run(body, headers)
        if path.startswith("/api/runs/"):
            if (headers or {}).get(_SKILL_RUN_HEADER) != "1":
                return _json(
                    403,
                    {
                        "error": {
                            "category": "forbidden",
                            "detail": f"{_SKILL_RUN_HEADER}: 1 required",
                        }
                    },
                )
            return self._runs_post(raw_path, body)
        if path == "/api/agent/shots-draft":
            return self._agent_shots_draft(body, headers)
        if path == "/api/agent/bible-breakdown":
            return self._agent_bible_breakdown(body, headers)
        if path == "/api/agent/story-develop":
            return self._agent_story_develop(body, headers)
        if path == "/api/agent/episode-plan":
            return self._agent_episode_plan(body, headers)
        if path == "/api/agent/render-episode":
            return self._agent_render_episode(body)
        if path == "/api/agent/mix-shot":
            return self._agent_mix_shot(body)
        if path == "/api/agent/motion-preview":
            return self._agent_motion_preview(body)
        if path == "/api/assets/delete-file":
            return self._assets_delete_file(body)
        if path == "/api/agent/script-draft":
            return self._agent_script_draft(body, headers)
        if path == "/api/agent/tts":
            return self._agent_tts(body)
        if path == "/api/agent/compose":
            return self._agent_compose(body)
        if path == "/api/delivery/probe":
            return self._delivery_probe(body)
        if path == "/api/agent/image-gen":
            return self._agent_image(body)
        if path == "/api/agent/adopt-paid":
            return self._agent_adopt_paid(body)
        if path == "/api/projects":
            return self._create_project(body)
        if path == "/api/projects/migrate-legacy":
            return self._migrate_legacy(body)
        if not path.startswith("/api/projects/"):
            return _json(
                404,
                {"error": {"category": "not_found", "detail": "unknown write route"}},
            )
        rest = path[len("/api/projects/") :]
        name, _, sub = rest.partition("/")
        if sub not in ("preflight", "command"):
            return _json(
                404,
                {"error": {"category": "not_found", "detail": "unknown write route"}},
            )
        if not _QUERY_OK:
            return _json(
                503,
                {
                    "error": {
                        "category": "unavailable",
                        "detail": "command backend not available (run inside the venv)",
                    }
                },
            )
        root = self._projects.get(unquote(name))
        if root is None:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown project"}}
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "body must be object"}},
            )
        # The no-spend commands are available in both modes; every other Gateway
        # command (paid generation) still needs paid mode.
        #
        # DERIVED, not a second hand-written list (TASK-103 批次 B): the creative
        # loop's membership lives in `gateway_commands.CREATIVE_LOOP_COMMANDS`, so a
        # fifth no-spend command added there cannot be silently 403'd here by
        # someone forgetting this line. `lock-draft-plan` is spelled out because it
        # is registered from a different module with its own single spec.
        if not self.paid and payload.get("name") not in _NO_SPEND_COMMANDS:
            return _json(
                403,
                {
                    "error": {
                        "category": "forbidden",
                        "detail": "paid commands not enabled (--enable-paid)",
                    }
                },
            )
        from ai_video_workflow.errors import AiVideoWorkflowError
        from ai_video_workflow.gateway import CommandEnvelope, GatewayError

        # M4c bridge: the client sends creative shot identities as a PARALLEL
        # array separate from the shots core consumes. Strip it before building
        # the envelope so Core's contract is untouched (and the preflight digest
        # is computed over the same core params on both preflight and submit);
        # the server echoes it back onto each official record on submit.
        raw_params = payload.get("params") or {}
        creative_shot_ids = None
        if isinstance(raw_params, dict) and "creativeShotIds" in raw_params:
            creative_shot_ids = raw_params.get("creativeShotIds")
            raw_params = {k: v for k, v in raw_params.items() if k != "creativeShotIds"}

        try:
            envelope = CommandEnvelope(
                command_id=payload["command_id"],
                name=payload["name"],
                actor="user",  # forced server-side — no provenance forgery
                params=raw_params,
                occurred_at=datetime.now(timezone.utc),
                target=payload.get("target"),
            )
        except KeyError as exc:
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": f"missing command field: {exc.args[0]!r}",
                    }
                },
            )
        except AiVideoWorkflowError as exc:
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": f"invalid command: {type(exc).__name__}",
                    }
                },
            )
        confirmation = payload.get("confirmation")
        if confirmation is not None and not isinstance(confirmation, str):
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": "confirmation must be a string",
                    }
                },
            )
        try:
            gateway = self._command_gateway(root)
            if sub == "preflight":
                pf = gateway.preflight(envelope)
                return _json(
                    200,
                    {
                        "command_id": pf.command_id,
                        "name": pf.name,
                        "is_high_risk": pf.is_high_risk,
                        "preflight_digest": pf.preflight_digest,
                        "preview": {
                            "inputs": dict(pf.preview.inputs),
                            "estimated_cost": (
                                dict(pf.preview.estimated_cost)
                                if pf.preview.estimated_cost is not None
                                else None
                            ),
                            "downstream": list(pf.preview.downstream),
                            "blockers": list(pf.preview.blockers),
                        },
                    },
                )
            receipt = gateway.submit(envelope, confirmation=confirmation)
            outcome = _bridge_creative_shot_ids(receipt.outcome, creative_shot_ids)
            return _json(
                200,
                {
                    "command_id": receipt.command_id,
                    "name": receipt.name,
                    "status": receipt.status.value,
                    "outcome": outcome,
                    "reason": receipt.reason,
                    "occurred_at": receipt.occurred_at.isoformat(
                        timespec="microseconds"
                    ),
                },
            )
        except GatewayError as exc:
            # fail-closed admission refusal — safe, path-free message
            return _json(
                409, {"error": {"category": "command_refused", "detail": str(exc)}}
            )
        except AiVideoWorkflowError as exc:
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": type(exc).__name__}},
            )
        except Exception as exc:  # noqa: BLE001 - fail closed, never leak internals
            return _json(
                500,
                {
                    "error": {
                        "category": "command_failed",
                        "detail": f"unexpected {type(exc).__name__}",
                    }
                },
            )

    def _shots(self, name: str):
        """Read-only list of the project's authoritative shot records.

        Lets the canvas display the REAL locked shot plan instead of demo
        fixtures. Reads only ``records/shots/*.json`` inside the discovered
        project root (containment); unreadable records are skipped.
        """
        root = self._projects.get(name)
        if root is None:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown project"}}
            )
        shots = []
        shots_dir = (root / "records" / "shots").resolve()
        if root.resolve() not in shots_dir.parents:
            return _json(200, {"shots": []})
        if shots_dir.is_dir():
            for p in sorted(shots_dir.glob("*.json")):
                try:
                    # Only read REGULAR files that resolve to inside shots_dir:
                    # a symlink placed in records/shots must not be followed to
                    # expose JSON fields from outside the project (file-data
                    # disclosure). Skip symlinks and any escaping target.
                    if p.is_symlink():
                        continue
                    rp = p.resolve()
                    if shots_dir not in rp.parents or not rp.is_file():
                        continue
                    rec = json.loads(rp.read_text("utf-8"))
                except (OSError, ValueError):
                    continue
                shots.append(
                    {
                        "shot_id": rec.get("shot_id"),
                        "sequence": rec.get("sequence"),
                        "description": rec.get("description"),
                        "duration_seconds": rec.get("duration_seconds"),
                    }
                )
        shots.sort(key=lambda s: (s.get("sequence") or 0, str(s.get("shot_id"))))
        return _json(200, {"shots": shots})

    # -- creative agent: shots draft (ADR-0042) ----------------------------
    def _skill_run(self, body: bytes, headers=None):
        """POST /api/skill/run — run ONE compiled Skill prompt on ONE executor.

        Takes a prompt, returns text. It takes no project name, no path and no
        file list, and it writes nothing: this route cannot modify the canvas,
        the project, or the repository even if the model asks it to (ADR-0056
        决策 2). The four failure kinds are reported distinctly so the client can
        say something actionable instead of a generic error.

        CSRF: `_guard_origin` lets a request through when it carries NO Origin
        header, which is the right baseline for the read-only API but too weak
        for a route that starts a real local CLI and consumes subscription
        capacity. This route additionally requires a CUSTOM header: a
        cross-origin page cannot set one without a preflight, and this server
        answers no CORS preflight, so a hostile page cannot reach it at all.
        """
        if (headers or {}).get(_SKILL_RUN_HEADER) != "1":
            return _json(
                403,
                {
                    "error": {
                        "category": "forbidden",
                        "detail": f"{_SKILL_RUN_HEADER}: 1 required",
                    }
                },
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return _json(
                400, {"error": {"category": "bad_json", "detail": "invalid JSON body"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400, {"error": {"category": "bad_json", "detail": "expected an object"}}
            )
        name = payload.get("executor")
        prompt = payload.get("prompt")
        if not isinstance(name, str) or name not in _EXECUTORS:
            return _json(
                400,
                {
                    "error": {
                        "category": "unavailable",
                        "detail": "unknown executor",
                    }
                },
            )
        if not isinstance(prompt, str) or not prompt.strip():
            return _json(
                400,
                {"error": {"category": "invalid_output", "detail": "prompt is empty"}},
            )
        if len(prompt) > _SKILL_PROMPT_MAX:
            return _json(
                413,
                {
                    "error": {
                        "category": "invalid_output",
                        "detail": f"prompt exceeds {_SKILL_PROMPT_MAX} characters",
                    }
                },
            )
        raw_timeout = payload.get("timeout")
        timeout = _SKILL_TIMEOUT_DEFAULT
        # `math.isfinite` before `int()`: Python's json accepts `Infinity` and
        # `NaN`, and int(float("inf")) raises OverflowError — a crafted body must
        # not become an unhandled 500.
        if (
            isinstance(raw_timeout, (int, float))
            and not isinstance(raw_timeout, bool)
            and math.isfinite(raw_timeout)
            and raw_timeout > 0
        ):
            # floor at 1 second: `int(0.5)` is 0, which would kill the child
            # instantly and report a timeout for a request that asked for half
            # a second — a valid ask turned into an immediate failure.
            timeout = max(1, min(int(raw_timeout), _SKILL_TIMEOUT_MAX))
        # --- ASYNC path (contract §5.9c): identity now, result later --------- #
        #
        # Opt-in by header so the synchronous contract every current caller
        # depends on is untouched. Over the cap this QUEUES instead of 429-ing:
        # the caller already holds a `run_id`, so waiting costs it nothing.
        if (headers or {}).get(_ASYNC_HEADER) == "1":
            try:
                run = runs().create(
                    kind="skill",
                    task_type=_str(
                        payload.get("skillId"), "skill.unknown", prefix="skill."
                    ),
                    executor=name,
                    project_id=payload.get("project"),
                    legacy_no_project=not isinstance(payload.get("project"), str)
                    or not payload.get("project"),
                    skill_id=payload.get("skillId"),
                    command_id=payload.get("commandId"),
                    idempotency_key=payload.get("idempotencyKey"),
                    retry_of_run_id=payload.get("retryOfRunId"),
                    context=payload.get("context"),
                    params={"prompt": prompt, "timeout": timeout},
                    provider="local_subscription",
                )
            except runstore.RunStoreError as exc:
                return _json(
                    400,
                    {"error": {"category": exc.category, "detail": exc.detail}},
                )
            return _json(202, _run_view(run))
        # --- SYNC path: unchanged, including the 429 ------------------------- #
        #
        # One local CLI per slot. A synchronous caller that finds every slot busy
        # is told so IMMEDIATELY rather than having its connection held open:
        # parking it would be the opposite promise from "returns right away", and
        # the caller has no run_id to come back to. Queueing belongs to the async
        # path (TASK-072 §1.3 rule 2).
        # ONE pool, shared with the async path and the agent endpoints. A
        # separate semaphore here let mixed traffic run twice the configured
        # number of executors (codex review, round 11).
        if not runs().try_acquire_slot():
            return _json(
                429,
                {
                    "error": {
                        "category": "execution_error",
                        "detail": (
                            f"已有 {_SKILL_RUN_MAX_CONCURRENT} 个能力运行在进行中，"
                            "请等一个结束后再试"
                        ),
                    }
                },
            )
        try:
            text, model = _run_executor(name, prompt, timeout)
        except FileNotFoundError as exc:
            return _json(
                503, {"error": {"category": "unavailable", "detail": str(exc)[:300]}}
            )
        except PermissionError as exc:
            return _json(
                401,
                {
                    "error": {
                        "category": "unauthenticated",
                        "detail": str(exc)[:300],
                    }
                },
            )
        except subprocess.TimeoutExpired:
            return _json(
                504,
                {
                    "error": {
                        "category": "timeout",
                        "detail": f"executor exceeded {timeout}s",
                    }
                },
            )
        except OSError as exc:
            return _json(
                502,
                {
                    "error": {
                        "category": "execution_error",
                        "detail": str(exc)[:300],
                    }
                },
            )
        finally:
            # released on EVERY path, including the exception returns above —
            # a leaked slot would permanently shrink the runtime's capacity
            runs().release_slot()
        return _json(200, {"ok": True, "text": text, "model": model})

    # -- Run registry API (TASK-072 §1.3) ----------------------------------- #

    def _runs_get(self, raw_path: str):
        """GET /api/runs?project=… and GET /api/runs/<run_id>?project=…

        `project` is REQUIRED on the list route. "No project means everything" is
        precisely the path that lets another project's runs appear on this
        project's board (contract §5.5), so it is refused rather than defaulted.
        """
        path = urlsplit(raw_path).path
        params = parse_qs(urlsplit(raw_path).query)
        project = (params.get("project") or [None])[0]
        rest = path[len("/api/runs") :].strip("/")
        if not rest:
            # The legacy, project-less runs. ⚙ diagnostics only — they belong to
            # no project, so they appear on no project page.
            #
            # A SEPARATE PARAMETER, not a magic project name (codex review round
            # 2): `_valid_project_name` would happily accept a project literally
            # called `__unowned__`, and then that project's ordinary run-list
            # request would return every project-less run in the backend.
            # A sentinel that a user can type is not a sentinel.
            if (params.get("scope") or [None])[0] == "unowned":
                unowned = runs().list_unowned()
                return _json(200, {"runs": [_run_view(r) for r in unowned]})
            if not project:
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": "project is required — 运行列表必须按项目隔离",
                        }
                    },
                )
            status = (params.get("status") or [None])[0]
            task_type = (params.get("taskType") or [None])[0]
            found = runs().list(project=project, status=status, task_type=task_type)
            return _json(200, {"runs": [_run_view(r) for r in found]})
        try:
            run = runs().get(unquote(rest), project=project)
        except runstore.RunNotFound:
            # 404 even when it exists but belongs elsewhere: 403 would confirm
            # the id is real, which is itself the leak.
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown run"}}
            )
        return _json(200, _run_view(run))

    def _manual_outputs(self, run_id: str, outputs: dict, project):
        """Validate a manual answer and return the NORMALISED outputs, or an
        error response.

        The parser's return value is what gets stored (codex review, round 9).
        Keeping the raw submission meant valid JSON handed over as a *string*
        was accepted and then persisted as a string, where every consumer
        expects the parsed object — a durable result nothing can read.
        """
        """Hold a manual answer to the SAME output contract as a local one.

        A pasted result that does not carry the task's product key would be
        stored as a durable `succeeded` and then break every consumer that goes
        looking for `outline` / `shots` / … (codex review, round 6). The local
        path fails closed on a non-conforming answer; the manual path is the same
        capability run somewhere else, so it fails closed the same way — that is
        the whole promise of the fallback (ADR-0065 决策 2: 「走同一道输出契约」).
        """
        try:
            run = runs().get(run_id, project=project)
        except runstore.RunStoreError:
            return outputs, None  # the caller's own lookup will report it
        parser = _AGENT_PARSERS.get(run.get("taskType"))
        if parser is None:
            return outputs, None  # no declared product shape for this task type
        key, fn = parser
        value = outputs.get(key)
        if value in (None, "", [], {}):
            return outputs, _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": (
                            f"这个任务的产物键是「{key}」，提交的内容里没有它"
                            "（或者是空的）——手工结果走的是同一道输出契约"
                        ),
                    }
                },
            )
        # …and the VALUE goes through the SAME parser the local path uses
        # (codex review, round 7). Checking only that the key is non-empty let
        # `{"shots": 1}` become a durable `succeeded`, which every consumer then
        # chokes on. 「走同一道输出契约」 (ADR-0065 决策 2) means the same
        # validation, not a similar one.
        #
        # EXCEPT for a TEXT product (codex review, round 18). `_parse_script_text`
        # exists to pull a script out of a MODEL'S REPLY — it requires the
        # `<剧本输出>` wrapper that only a model emits. A creator submitting the
        # advertised product (`{"script": "…"}`) has no wrapper to give, so
        # running that parser rejected exactly the correct submission. For a text
        # product the contract IS the text, and it is checked as such.
        # …and ONLY for a key whose product really is text (codex review, round
        # 19). Exempting every string let a string-valued `outline` or `shots`
        # skip its parser entirely and be stored as a durable `succeeded`.
        if key in _TEXT_PRODUCT_KEYS and isinstance(value, str):
            text = value.strip()
            if not text:
                # stripped FIRST: a whitespace-only submission passed the
                # emptiness check above and became an empty successful result
                return outputs, _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": f"产物「{key}」是空白内容",
                        }
                    },
                )
            if len(text) > _SCRIPT_DRAFT_MAX:
                return outputs, _json(
                    400,
                    {
                        "error": {
                            "category": "too_large",
                            "detail": f"产物超过 {_SCRIPT_DRAFT_MAX} 字上限",
                        }
                    },
                )
            return {**outputs, key: text}, None
        # A MANUAL SUBMISSION IS A PRODUCT, NOT A MODEL'S ANSWER. The creator
        # submits `{"shots": [ … ]}` — the advertised product shape — so it is
        # judged by the PRODUCT sanitiser, exactly as it was before the Skill
        # packages arrived. Holding it to the model-answer contract instead
        # demanded the `{shots: […]}` envelope a person has no reason to type,
        # and closed the no-runtime recovery route that ADR-0065 决策 2 exists to
        # keep open (independent review: shots 200 -> 400, outline 200 -> 400).
        #
        # Deciding this by looking at the first character was worse: it also let
        # a MODEL answer opening with `[` skip the Skill contract, silently
        # undoing the episode-plan tightening this card advertises. The call
        # site knows which path it is; the text does not.
        sanitiser = _MANUAL_SANITISERS.get(run.get("taskType"), fn)
        try:
            as_text = json.dumps(value, ensure_ascii=False)
            normalised = sanitiser(as_text)
        except ValueError as exc:
            return outputs, _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": f"产物不符合这个任务的输出契约：{exc}",
                    }
                },
            )
        return {**outputs, key: normalised}, None

    def _runs_post(self, raw_path: str, body: bytes):
        """POST /api/runs/<run_id>/{cancel,confirm,submit}."""
        path = urlsplit(raw_path).path
        rest = path[len("/api/runs/") :].strip("/")
        run_id, _, action = rest.partition("/")
        run_id = unquote(run_id)
        payload = {}
        if body:
            try:
                loaded = json.loads(body.decode("utf-8"))
                payload = loaded if isinstance(loaded, dict) else {}
            except (ValueError, UnicodeDecodeError):
                return _json(
                    400, {"error": {"category": "bad_json", "detail": "invalid JSON"}}
                )
        project = payload.get("project")
        try:
            if action == "cancel":
                run = runs().cancel(run_id, project=project)
            elif action == "confirm":
                run = runs().confirm(
                    run_id, project=project, digest=payload.get("digest")
                )
            elif action == "submit":
                # The manual route home: an answer produced in an external tool
                # comes back through the SAME contract as a local run.
                #
                # AN EMPTY SUBMISSION IS NOT A RESULT. Coercing a missing,
                # falsey or non-object payload to `{}` turned a malformed request
                # into a durable, permanent "success" carrying nothing (codex
                # review, round 4) — the same fail-closed rule the local path
                # applies to a model answer that does not parse.
                outputs = payload.get("outputs")
                if not isinstance(outputs, dict) or not outputs:
                    return _json(
                        400,
                        {
                            "error": {
                                "category": "bad_request",
                                "detail": "outputs 必须是一个非空对象——空提交不是结果",
                            }
                        },
                    )
                outputs, bad = self._manual_outputs(run_id, outputs, project)
                if bad is not None:
                    return bad
                run = runs().submit_input(run_id, outputs, project=project)
            else:
                return _json(
                    404,
                    {
                        "error": {
                            "category": "not_found",
                            "detail": "unknown run action",
                        }
                    },
                )
        except runstore.RunNotFound:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown run"}}
            )
        except runstore.RunStoreError as exc:
            return _json(
                409, {"error": {"category": exc.category, "detail": exc.detail}}
            )
        return _json(200, _run_view(run))

    def _skill_prompt(self, slug: str, payload: dict) -> str:
        """Compile this endpoint's prompt FROM ITS SKILL PACKAGE.

        TASK-075 §1.6 / decision A: the endpoint no longer carries its own
        wording. It maps its payload onto the capability's declared context keys
        and the shared compiler does the rest, so the page and the endpoint ask
        one question (acceptance #7).

        The legacy per-endpoint size caps are carried over deliberately: the old
        prompts bounded user text before splicing it in and `compile_prompt`
        does not, so dropping them here would have removed a real limit as a
        side effect of the migration (independent review, batch B1).
        """

        skill_id = _skill_id_for(slug, payload)
        # NO PROJECT ROOT HERE. This route must never turn a project name into a
        # path (guarded by tests/studio/test_motv_skills_task059.py), so the five
        # endpoints resolve against the user and builtin sources only. Serving a
        # PROJECT-scoped package to them needs that path question settled first —
        # `GET /api/skills?project=` already does it safely for the catalog view
        # because it goes through the registry on a route without this rule.
        catalog = _load_skill_catalog()
        skill = catalog.skills.get(skill_id)
        if skill is None:
            raise skillpkg.SkillPackageError(f"能力包不可用：{skill_id}")

        context: dict[str, object] = {}
        for key, value in (_PAYLOAD_TO_CONTEXT[slug](payload) or {}).items():
            if value is None:
                continue
            cap = _cap_for(slug, key)
            if isinstance(value, str):
                value = value[:cap]
            else:
                # MEASURE WHAT IS ACTUALLY EMBEDDED. The cap was checked against
                # a COMPACT `json.dumps` while the compiler inlines the
                # pretty-printed form, so a value under the cap could still send
                # ~80% more creator text to the model than the endpoint ever
                # promised — the exact failure this table's own comment argues
                # against (independent review, round 3).
                rendered = skillpkg._inline(value)
                if len(rendered) > cap:
                    # TRUNCATE, like the legacy endpoints did. Raising turned a
                    # request that used to answer 200 into a 503 「能力不可用」 —
                    # the wrong actor blamed for the wrong thing.
                    value = rendered[:cap]
            context[key] = value

        prompt = skillpkg.compile_prompt(skill, context, _skill_input_labels())
        # PER-RUN STEERS, appended in the SAME fence. These are not domain
        # context and are not among the capability's declared inputs, so
        # `compile_prompt` would DROP them — which silently cost the revision
        # mode its base script until a test caught it. Smuggling them in as fake
        # input keys would be worse: a Skill's declared inputs are what
        # `missingInputs` gates on, and inventing keys there would make the gate
        # lie about what the capability needs.
        for key, label in _extra_fenced(slug, payload):
            value = payload.get(key)
            if not isinstance(value, str) or not value.strip():
                continue
            cap = _cap_for(slug, key)
            body = skillpkg.embed_data(value[:cap])
            prompt += f'\n\n### {label}\n<数据 键="{key}">\n{body}\n</数据>'
        return prompt

    def _creative_agent(self, slug: str, prompt: str, payload: dict, headers=None):
        """The ONE execution path for the five legacy creative endpoints.

        ADR-0065 决策 1 / TASK-072 §1.8: they no longer spawn `claude` themselves.
        They now get, for free, everything the Runtime layer already had —
        executor resolution, the concurrency cap, a real process-tree kill, and a
        durable Run with provenance. `_run_claude` is gone; there is no second
        way to start an AI process any more.

        COMPATIBILITY (contract §5.9c): by default this stays SYNCHRONOUS and
        returns the OLD response keys. `run_id` / `executor` / `model` are pure
        additions, so a caller that has not migrated is unaffected. With
        `X-Motv-Async: 1` it returns `202 {run_id}` and NO product keys — the
        product arrives via `GET /api/runs/<id>`, under the same key.
        """
        task_type = _AGENT_TASK_TYPES[slug]
        key, _parser = _AGENT_PARSERS[task_type]
        # WHICH PACKAGE ANSWERED, recorded on the run (ADR-0067 决策 3 / §1.2).
        # Without this the digest-conflict rule is inert: `skill_digests()` has
        # nothing to compare against, so a package could be edited under a
        # version historical runs already point at and nothing would notice.
        skill_meta: dict = {}
        _skill = _load_skill_catalog().skills.get(_skill_id_for(slug, payload))
        if _skill is not None:
            skill_meta = {
                "skillId": _skill.skill_id,
                "skillVersion": _skill.version,
                "skillDigest": _skill.digest,
            }
        project = payload.get("project")
        has_project = isinstance(project, str) and bool(project)
        requested = payload.get("executor")
        executor, why = _resolve_creative_executor(requested)
        # An EXPLICIT `manual` is the same situation as "no runtime available":
        # the work is going to be done by a person, so there is nothing to wait
        # for. Falling through would park the run in `awaiting_input` and then
        # block the HTTP request on `_await_run` — which never times out for that
        # state, so the request would hang forever (codex review, round 4).
        if executor == "manual":
            executor, why = None, "创作者选择了手工执行"
        if executor is None:
            # No runtime. This is NOT a dead end (ADR-0065 决策 2): the compiled
            # prompt is handed back so the creator can run it in any external
            # model and bring the answer to `/api/runs/<id>/submit`.
            try:
                run = runs().create(
                    kind="skill",
                    task_type=task_type,
                    executor="manual",
                    project_id=project if has_project else None,
                    legacy_no_project=not has_project,
                    params={"prompt": prompt, **skill_meta},
                    provider=None,
                )
                runs().await_input(run["runId"])
            except runstore.RunStoreError as exc:
                return _json(
                    400, {"error": {"category": exc.category, "detail": exc.detail}}
                )
            return _json(
                503,
                {
                    "error": {
                        "category": "agent_unavailable",
                        "detail": why,
                        # the manual route, spelled out rather than implied
                        "manual_fallback": {
                            "run_id": run["runId"],
                            "prompt": prompt,
                            "submit": f"/api/runs/{run['runId']}/submit",
                        },
                    }
                },
            )
        try:
            run = runs().create(
                kind="skill",
                task_type=task_type,
                executor=executor,
                project_id=project if has_project else None,
                legacy_no_project=not has_project,
                command_id=payload.get("commandId"),
                idempotency_key=payload.get("idempotencyKey"),
                retry_of_run_id=payload.get("retryOfRunId"),
                params={
                    "prompt": prompt,
                    "timeout": _SKILL_TIMEOUT_DEFAULT,
                    **skill_meta,
                },
                provider="local_subscription",
            )
        except runstore.RunStoreError as exc:
            return _json(
                400, {"error": {"category": exc.category, "detail": exc.detail}}
            )
        if (headers or {}).get(_ASYNC_HEADER) == "1":
            return _json(202, _run_view(run))
        # Synchronous compatibility: wait for THIS run to settle, then answer in
        # the old shape. The work still went through the registry, so a refresh
        # mid-flight can still recover it — which is the whole point.
        settled = _await_run(run["runId"])
        return _agent_sync_response(settled, key)

    def _agent_shots_draft(self, body: bytes, headers=None):
        """Turn the user's canvas script into a structured shot-list DRAFT.

        Runs the locally authenticated Claude Code CLI headless
        (``claude -p``, subscription-billed; no API key touches this app) and
        parses its output strictly. Draft-domain only: this endpoint writes
        NOTHING server-side — the draft lives in the canvas state. Fail-closed:
        a parse/CLI failure returns an error with a bounded raw-output excerpt,
        never a fabricated success.
        """
        # A valid agent body is a tiny JSON wrapper around a script capped at
        # 50 KB below. Reject anything larger BEFORE decode/parse so this path
        # never parses megabytes (the shared 2 MB transport cap also serves the
        # larger Gateway envelope; this tighter bound is specific to the agent).
        if len(body) > 100_000:
            return _json(
                413,
                {
                    "error": {
                        "category": "too_large",
                        "detail": "request body too large",
                    }
                },
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        script = payload.get("script") if isinstance(payload, dict) else None
        if not isinstance(script, str) or not script.strip():
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "missing 'script'"}},
            )
        if len(script) > 50_000:
            return _json(
                400, {"error": {"category": "too_large", "detail": "script too long"}}
            )
        try:
            prompt = self._skill_prompt("shots-draft", payload)
        except skillpkg.SkillPackageError as exc:
            # fail closed: no package, no question to ask (ADR-0067 决策 7)
            return _json(
                503,
                {"error": {"category": "skill_unavailable", "detail": str(exc)}},
            )
        return self._creative_agent("shots-draft", prompt, payload, headers)

    def _agent_bible_breakdown(self, body: bytes, headers=None):
        """Script breakdown → Production Bible PROPOSALS (M8).

        Same posture as shots-draft (ADR-0042): local ``claude -p``, free,
        draft-domain, fail-closed, writes NOTHING server-side. The client
        presents the result as proposals the creator explicitly applies —
        this endpoint never touches bible state.
        """
        if len(body) > 100_000:
            return _json(
                413,
                {
                    "error": {
                        "category": "too_large",
                        "detail": "request body too large",
                    }
                },
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        script = payload.get("script") if isinstance(payload, dict) else None
        if not isinstance(script, str) or not script.strip():
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "missing 'script'"}},
            )
        if len(script) > 50_000:
            return _json(
                400, {"error": {"category": "too_large", "detail": "script too long"}}
            )
        # The asset list and the cast are validated like any other request field
        # (TASK-094 批次 E). Bounded HERE as well as by the context cap: the cap
        # TRUNCATES, and a list cut off mid-entry would hand the model half an asset
        # key to 「connect」 an entity to.
        for key in ("assets", "characters"):
            value = payload.get(key)
            if value is None:
                continue
            ok = isinstance(value, list) and all(isinstance(x, dict) for x in value)
            if not ok:
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": f"'{key}' must be a list of objects",
                        }
                    },
                )
            if len(json.dumps(value, ensure_ascii=False)) > _cap_for(
                "bible-breakdown", key
            ):
                return _json(
                    400,
                    {"error": {"category": "too_large", "detail": f"{key} too long"}},
                )
        try:
            prompt = self._skill_prompt("bible-breakdown", payload)
        except skillpkg.SkillPackageError as exc:
            # fail closed: no package, no question to ask (ADR-0067 决策 7)
            return _json(
                503,
                {"error": {"category": "skill_unavailable", "detail": str(exc)}},
            )
        return self._creative_agent("bible-breakdown", prompt, payload, headers)

    def _agent_story_develop(self, body: bytes, headers=None):
        """Idea (+ optional current outline + instruction) → Story-Outline
        PROPOSAL (M9). Same posture as the other agent endpoints (ADR-0042):
        local ``claude -p``, free, draft-domain, fail-closed, zero writes."""
        if len(body) > 100_000:
            return _json(
                413,
                {
                    "error": {
                        "category": "too_large",
                        "detail": "request body too large",
                    }
                },
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid payload"}}
            )
        idea = payload.get("idea")
        if not isinstance(idea, str) or not idea.strip():
            return _json(
                400, {"error": {"category": "bad_request", "detail": "missing 'idea'"}}
            )
        if len(idea) > 10_000:
            return _json(
                400, {"error": {"category": "too_large", "detail": "idea too long"}}
            )
        try:
            prompt = self._skill_prompt("story-develop", payload)
        except skillpkg.SkillPackageError as exc:
            # fail closed: no package, no question to ask (ADR-0067 决策 7)
            return _json(
                503,
                {"error": {"category": "skill_unavailable", "detail": str(exc)}},
            )
        return self._creative_agent("story-develop", prompt, payload, headers)

    def _agent_episode_plan(self, body: bytes, headers=None):
        """Approved Story Outline → Episode-Plan PROPOSAL (M9). Same agent
        posture: local ``claude -p``, fail-closed, zero writes.

        TWO MODES since TASK-094 批次 A: with a `current_plan` AND an
        `instruction` this REVISES the plan it is given (`episode-plan-reviser`);
        otherwise it plans a fresh one (`episode-planner`). `_TWO_MODES` decides,
        so the choice is made in exactly one place.
        """
        if len(body) > 250_000:
            return _json(
                413,
                {
                    "error": {
                        "category": "too_large",
                        "detail": "request body too large",
                    }
                },
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        outline = payload.get("outline") if isinstance(payload, dict) else None
        if not isinstance(outline, dict):
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "missing 'outline'"}},
            )
        outline_json = json.dumps(outline, ensure_ascii=False)
        if len(outline_json) > 30_000:
            return _json(
                400, {"error": {"category": "too_large", "detail": "outline too long"}}
            )
        # THE PLAN BEING REVISED IS VALIDATED LIKE ANY OTHER REQUEST FIELD
        # (TASK-094 批次 A). Bounded HERE rather than relying on the context cap:
        # the cap TRUNCATES to keep a request answerable, and a plan cut off
        # mid-episode is a plan the reviser would 「keep」 a broken copy of. The
        # entry ceiling is the same 50 the answer parser enforces, so the request
        # and the response cannot admit different sizes.
        current_plan = payload.get("current_plan")
        if current_plan is not None:
            if not isinstance(current_plan, list) or not all(
                isinstance(x, dict) for x in current_plan
            ):
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": "'current_plan' must be a list of plan entries",
                        }
                    },
                )
            if len(current_plan) > 50:
                return _json(
                    400,
                    {
                        "error": {
                            "category": "too_large",
                            "detail": "current_plan has more than 50 episodes",
                        }
                    },
                )
            if len(json.dumps(current_plan, ensure_ascii=False)) > _cap_for(
                "episode-plan", "currentPlan"
            ):
                return _json(
                    400,
                    {
                        "error": {
                            "category": "too_large",
                            "detail": "current_plan too long",
                        }
                    },
                )
        characters = payload.get("characters")
        if characters is not None and not isinstance(characters, list):
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": "'characters' must be a list",
                    }
                },
            )
        try:
            prompt = self._skill_prompt("episode-plan", payload)
        except skillpkg.SkillPackageError as exc:
            # fail closed: no package, no question to ask (ADR-0067 决策 7)
            return _json(
                503,
                {"error": {"category": "skill_unavailable", "detail": str(exc)}},
            )
        return self._creative_agent("episode-plan", prompt, payload, headers)

    def _agent_script_draft(self, body: bytes, headers=None):
        """Idea → Script (and Script + instruction → revised Script) DRAFTS.

        Two modes, decided by the payload:

        - initial: ``{"idea": ...}`` — write a short-drama script from the
          creative brief;
        - revision: ``{"base_script": ..., "instruction": ...}`` — rewrite the
          given script per the user's revision instruction and return the FULL
          revised script.

        Same trust posture as ``_agent_shots_draft`` (ADR-0042): the locally
        authenticated Claude CLI runs with tools DISABLED; idea/base script are
        framed as pure data (a crafted script must not steer the agent); the
        instruction is the user's own revision request. Draft-domain only —
        this endpoint writes NOTHING server-side; versioning of the result is
        the canvas document's job. Fail-closed on CLI/parse errors.
        """
        if len(body) > 100_000:
            return _json(
                413,
                {
                    "error": {
                        "category": "too_large",
                        "detail": "request body too large",
                    }
                },
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        idea = payload.get("idea")
        base = payload.get("base_script")
        instruction = payload.get("instruction")
        if isinstance(instruction, str) and instruction.strip():
            # revision mode
            if not isinstance(base, str) or not base.strip():
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": "revision needs 'base_script'",
                        }
                    },
                )
            if (
                len(instruction) > _SCRIPT_INSTRUCTION_MAX
                or len(base) > _SCRIPT_BASE_MAX
            ):
                return _json(
                    400,
                    {
                        "error": {
                            "category": "too_large",
                            "detail": "instruction or base_script too long",
                        }
                    },
                )
        else:
            # initial mode
            if not isinstance(idea, str) or not idea.strip():
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": "missing 'idea' (or 'instruction'+'base_script')",
                        }
                    },
                )
            if len(idea) > _SCRIPT_IDEA_MAX:
                return _json(
                    400,
                    {"error": {"category": "too_large", "detail": "idea too long"}},
                )
        try:
            prompt = self._skill_prompt("script-draft", payload)
        except skillpkg.SkillPackageError as exc:
            # fail closed: no package, no question to ask (ADR-0067 决策 7)
            return _json(
                503,
                {"error": {"category": "skill_unavailable", "detail": str(exc)}},
            )
        return self._creative_agent("script-draft", prompt, payload, headers)

    # -- local TTS draft voice-over (ADR-0043) ------------------------------
    def _agent_tts(self, body: bytes):
        """Synthesize draft voice-over with LOCAL Piper TTS (free, offline).

        Output lands in the same prototype upload scratch as manual uploads
        (``data/uploads/<project>/<slug>.wav``) so manual and automatic routes
        share the slot. Fail-closed: missing piper/model → 503 with an install
        hint; over-long text → 400; synthesis failure → 502 (never fabricated).
        """
        if len(body) > 100_000:
            return _json(
                413,
                {"error": {"category": "too_large", "detail": "request too large"}},
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "body must be object"}},
            )
        project = payload.get("project")
        slug = payload.get("slug")
        text = payload.get("text")
        if not isinstance(project, str) or not isinstance(slug, str):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        d = self._upload_dir(project)
        if (
            d is None
            or not _NAME_RE.fullmatch(slug)
            or _slug_reserved(slug)
            or _slug_versioned(slug)
        ):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        if not isinstance(text, str) or not text.strip():
            return _json(
                400, {"error": {"category": "bad_request", "detail": "missing 'text'"}}
            )
        if len(text) > _TTS_TEXT_MAX:
            return _json(
                400,
                {"error": {"category": "too_large", "detail": "text too long (2000)"}},
            )
        import shutil as _shutil

        piper = _shutil.which("piper")
        if piper is None or not _TTS_MODEL.is_file():
            return _json(
                503,
                {
                    "error": {
                        "category": "tts_unavailable",
                        "detail": "piper 或语音模型缺失：pip install piper-tts 并将"
                        " zh_CN-huayan-medium.onnx(.json) 放入 data/tts/",
                    }
                },
            )
        # Optional per-character LOCAL voice model (M11 voice-identity rule):
        # a `voice` names a piper model `data/tts/<voice>.onnx` — used when that
        # model is present so a character's fixed base voice actually renders,
        # else an HONEST fallback to the default model (no fabrication, still
        # free/offline; multi-voice PAID providers stay out of scope, ADR-0043).
        voice = payload.get("voice")
        model = _TTS_MODEL
        voice_used = None
        if voice is not None:
            if not isinstance(voice, str) or not _NAME_RE.fullmatch(voice):
                return _json(
                    400,
                    {"error": {"category": "bad_request", "detail": "bad voice"}},
                )
            cand = (DATA_DIR / "tts" / f"{voice}.onnx").resolve()
            tts_dir = (DATA_DIR / "tts").resolve()
            if tts_dir in cand.parents and cand.is_file() and not cand.is_symlink():
                model = cand
                voice_used = voice
        # Optional fit-to-video (先视频后配音): when fit_slug names an uploaded
        # video slot, the voice is re-synthesized with a faster length-scale if
        # it runs longer than the clip, so narration fits the SHOT's duration.
        fit_slug = payload.get("fit_slug")
        fit_seconds = None
        if fit_slug:
            if not isinstance(fit_slug, str):
                return _json(
                    400,
                    {"error": {"category": "bad_request", "detail": "bad fit_slug"}},
                )
            vid = self._resolve_slot(d, fit_slug, (".mp4", ".webm"))
            ffprobe = _shutil.which("ffprobe")
            if vid is not None and ffprobe is not None:
                probe = subprocess.run(  # noqa: S603 - fixed argv, no shell
                    [
                        ffprobe,
                        "-v",
                        "error",
                        "-show_entries",
                        "format=duration",
                        "-of",
                        "default=nw=1:nk=1",
                        str(vid),
                    ],
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                try:
                    fs = float(probe.stdout.strip())
                    if probe.returncode == 0 and 0 < fs <= 600:
                        fit_seconds = fs
                except ValueError:
                    pass  # unfittable → synthesize normally (compose still cuts)

        def _wav_seconds(path: str) -> float | None:
            ffprobe = _shutil.which("ffprobe")
            if ffprobe is None:
                return None
            pr = subprocess.run(  # noqa: S603 - fixed argv, no shell
                [
                    ffprobe,
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=nw=1:nk=1",
                    path,
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
            try:
                v = float(pr.stdout.strip())
            except ValueError:
                return None
            return v if pr.returncode == 0 and v > 0 else None

        def _synth(dest: str, length_scale: float | None) -> None:
            cmd = [piper, "-m", str(model), "-f", dest]
            if length_scale is not None:
                cmd += ["--length-scale", f"{length_scale:.3f}"]
            proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
                cmd,
                input=text.encode("utf-8"),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=120,
            )
            out = Path(dest)
            ok = (
                proc.returncode == 0
                and out.is_file()
                and out.stat().st_size > 44
                and out.open("rb").read(4) == b"RIFF"
            )
            if not ok:
                raise OSError(f"piper exited {proc.returncode}")

        fitted = False
        try:
            d.mkdir(parents=True, exist_ok=True)
            fd, tmpname = tempfile.mkstemp(dir=str(d), suffix=".tmp")
            os.close(fd)
            target = None
            try:
                _synth(tmpname, None)
                if fit_seconds is not None:
                    adur = _wav_seconds(tmpname)
                    if adur is not None and adur > fit_seconds + 0.05:
                        # speak faster to fit; clamp so speech stays intelligible
                        scale = max(0.65, (fit_seconds / adur) * 0.98)
                        _synth(tmpname, scale)
                        fitted = True
                digest = hashlib.sha256(Path(tmpname).read_bytes()).hexdigest()
                # ADR-0048: a re-synth APPENDS a new version — the previous
                # take (any format) is kept and can be switched back to.
                n, target = _claim_version(d, slug, ".wav")
                os.replace(tmpname, target)
            except (OSError, subprocess.TimeoutExpired):
                for stale in [tmpname] + ([str(target)] if target else []):
                    try:
                        os.unlink(stale)  # our tmp + our claimed placeholder only
                    except OSError:
                        pass
                raise
        except subprocess.TimeoutExpired:
            return _json(
                504, {"error": {"category": "tts_timeout", "detail": "piper timed out"}}
            )
        except OSError:
            return _json(
                502, {"error": {"category": "tts_failed", "detail": "synthesis failed"}}
            )
        return _json(
            200,
            {
                "ok": True,
                "url": f"/api/uploads/{project}/{target.name}",
                "version": n,
                "sha256": digest,
                "source": "piper",
                "fitted": fitted,
                "fit_seconds": fit_seconds,
                # the voice model actually used: the requested per-character
                # voice when its local model was present, else null (default
                # model) — provenance never claims a voice it didn't render
                "voice": voice_used,
            },
        )

    def _lock_target(self, name: str):
        """Read-only lock coordinates for the UI (ADR-0047).

        The current shot-plan version + its file digest via the same resolver
        the Gateway uses, so the digest the UI binds is the digest the submit
        will verify. Available in BOTH modes — locking never spends.
        """
        if not _QUERY_OK:
            return _json(
                503,
                {
                    "error": {
                        "category": "unavailable",
                        "detail": "command backend not available (run inside the venv)",
                    }
                },
            )
        root = self._projects.get(name)
        if root is None:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown project"}}
            )
        from ai_video_workflow.app.lock_gateway import ShotPlanTargetResolver
        from ai_video_workflow.planning import latest_shot_plan_version

        try:
            version = latest_shot_plan_version(root)
        except Exception:  # noqa: BLE001 - fail closed, expose nothing
            version = None
        if version is None:
            return _json(
                404,
                {
                    "error": {
                        "category": "not_found",
                        "detail": "project has no shot plan",
                    }
                },
            )
        ref = f"planning/shot_plan_v{version}.json"
        resolved = ShotPlanTargetResolver().resolve_target(
            root, ref=ref, version=version
        )
        if not resolved.exists:
            return _json(
                404,
                {"error": {"category": "not_found", "detail": "shot plan not found"}},
            )
        return _json(
            200,
            {
                "target": {
                    "ref": ref,
                    "version": version,
                    "content_digest": resolved.content_digest,
                },
                "params": {"plan_version": version},
            },
        )

    #: How many media entries one audit will enumerate. A directory listing is
    #: cheap, but an unbounded response is still an unbounded response — and a
    #: SILENT cap would make 「都在」 mean 「前 N 个都在」. So it is capped AND the
    #: truncation is reported, per TASK-087 §7「no silent caps」.
    _MEDIA_AUDIT_MAX = 5000

    def _media_audit(self, name: str, measure: str):
        """Server-side media presence audit (GAP-02 / TASK-083 §5.2 · TASK-087 §4.2).

        WHY THIS EXISTS. TASK-077 answered 「这个文件还在吗」 from the browser with a
        ``HEAD`` per URL, which has a third outcome the filesystem does not have:
        `INCONCLUSIVE` — the server declined to answer (405/501), or the request
        itself blew up. That third state is honest for a cross-origin probe, but it
        is not a fact about the project; it is a fact about the transport. Here the
        server simply reads its own directory, so **for a project media URL there
        are only two answers**, and the creator stops being told 「问不出来」 about
        files sitting on their own disk.

        Read-only in the strongest sense: it lists a directory and (optionally)
        runs `ffprobe`. It writes nothing — in particular it does NOT reconcile the
        declared `storageState`, which is a persistence change with its own owner
        (TASK-087 §4.1, deliberately still open).

        ``measure=<filename>`` additionally probes ONE file for its real pixel size
        / duration (TASK-087 §4.3). Deliberately one file per request and
        **ffprobe-only** — no decode. `/api/delivery/probe` does a full ebur128 +
        blackdetect pass, which is an order of magnitude more work than 「这段多长」
        needs (TASK-087 §3.5.4). Missing ffprobe is reported as such, never as a
        zero.
        """
        root = self._projects.get(name)
        if root is None:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown project"}}
            )
        d = self._read_upload_dir(name)
        files: dict[str, dict] = {}
        truncated = False
        if d is not None and d.is_dir():
            for i, entry in enumerate(sorted(d.iterdir(), key=lambda e: e.name)):
                if i >= self._MEDIA_AUDIT_MAX:
                    truncated = True
                    break
                if not entry.is_file():
                    continue
                try:
                    files[entry.name] = {"bytes": entry.stat().st_size}
                except OSError:
                    # Present but unstat-able. NOT dropped: 「文件在，大小问不出来」
                    # is a different fact from 「文件不在」, and collapsing it into
                    # absence is exactly the confusion this route removes.
                    files[entry.name] = {"bytes": None}
        body: dict = {
            # `dir: false` is still an AUTHORITATIVE audit — a project with no
            # media folder genuinely has no media. It is not 「问不出来」.
            "dir": bool(d is not None and d.is_dir()),
            "files": files,
            "truncated": truncated,
        }
        if measure:
            body["measured"] = self._measure_media(d, measure)
        return _json(200, body)

    def _measure_media(self, media_dir, filename: str) -> dict:
        """ffprobe ONE file for width/height/duration. Never a fabricated number.

        Every outcome is named, because the review columns show whichever one
        happened: `ok` / `bad_name` / `not_found` / `no_ffprobe` / `unreadable`.
        A column that says 「未探测」 and a column that says 「探不到」 describe
        different situations and lead to different next steps.
        """
        if not _NAME_RE.fullmatch(Path(filename).stem) or not filename:
            return {"state": "bad_name"}
        if media_dir is None:
            return {"state": "not_found"}
        target = media_dir / filename
        try:
            if not target.is_file() or target.parent.resolve() != media_dir.resolve():
                return {"state": "not_found"}
        except OSError:
            return {"state": "not_found"}
        import shutil as _shutil

        ffprobe = _shutil.which("ffprobe")
        if ffprobe is None:
            # FAIL-CLOSED AND SAID OUT LOUD (AGENTS.md 第 2 节第 6 条). The column
            # must not read 「0×0」 because a tool is missing.
            return {"state": "no_ffprobe"}
        try:
            pr = subprocess.run(  # noqa: S603 - fixed argv, no shell
                [
                    ffprobe,
                    "-v",
                    "error",
                    "-show_entries",
                    "stream=width,height:format=duration",
                    "-of",
                    "json",
                    str(target),
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            return {"state": "unreadable"}
        # EXIT CODE 0 IS NOT PROOF — measured on this repo. Handed 16 bytes of text
        # named `.png`, ffprobe 9.0 returns rc=0 with `width: 0, height: 0` and
        # `duration: "0.040000"`: a garbage answer that survives every check made of
        # the parsed JSON alone. It does write the real verdict to stderr
        # (`Invalid PNG signature …`), and with `-v error` stderr stays silent unless
        # something genuinely failed — so stderr is the authoritative signal.
        #
        # This is the endpoint's whole reason to exist: a column reading 「0×0」
        # because the prober half-answered is worse than one reading 「探不到」.
        if pr.returncode != 0 or pr.stderr.strip():
            return {"state": "unreadable"}
        try:
            info = json.loads(pr.stdout)
        except ValueError:
            return {"state": "unreadable"}
        width = height = None
        for stream in info.get("streams") or []:
            if not isinstance(stream, dict):
                continue
            w, h = stream.get("width"), stream.get("height")
            # positive ints only — a `0` is ffprobe saying it does not know
            if isinstance(w, int) and isinstance(h, int) and w > 0 and h > 0:
                width, height = w, h
                break
        duration = _probe_float((info.get("format") or {}).get("duration"))
        if duration is not None and duration <= 0:
            duration = None
        if width is None and duration is None:
            # Probed fine and learned nothing usable — still not a zero.
            return {"state": "unreadable"}
        return {
            "state": "ok",
            "width": width,
            "height": height,
            "duration": duration,
        }

    def _review_target(self, name: str, shot_id: str):
        """Read-only target coordinates for a REVIEW write (TASK-103 批次 B).

        `record-evaluation` / `create-feedback` bind the same three-tuple every
        Gateway command does — ``{ref, version, content_digest}`` — and the digest
        is the sha256 of the authoritative shot-record bytes. **The browser cannot
        compute it and must never invent one**: an invented digest does not fail as
        「被拒」, it binds a command to a version that does not exist. So the same
        resolver the Gateway will verify against computes it here, and the UI just
        carries it.

        Available in BOTH modes, unlike ``generation-target``: reviewing spends
        nothing. That is the whole reason these four commands are LOW risk.

        Fail-closed and read-only: an unresolvable shot reads as 404, and 404 here
        is a real product answer — 「这一镜还没有正式镜头记录」 — which the review
        page states rather than swallowing.
        """
        if not _QUERY_OK:
            return _json(
                503,
                {
                    "error": {
                        "category": "unavailable",
                        "detail": "command backend not available (run inside the venv)",
                    }
                },
            )
        root = self._projects.get(name)
        if root is None:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown project"}}
            )
        if not shot_id or not _NAME_RE.fullmatch(shot_id):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "bad shot_id"}}
            )
        from ai_video_workflow.app.paid_gateway import ShotRecordTargetResolver

        resolved = ShotRecordTargetResolver().resolve_target(
            root, ref=shot_id, version=1
        )
        if not resolved.exists:
            return _json(
                404,
                {"error": {"category": "not_found", "detail": "shot record not found"}},
            )
        return _json(
            200,
            {
                "target": {
                    "ref": shot_id,
                    "version": 1,
                    "content_digest": resolved.content_digest,
                }
            },
        )

    def _generation_target(self, name: str, shot_id: str):
        """Read-only generation coordinates for the UI (ref/digest/params).

        Computed from the authoritative shot record via the same resolver the
        Gateway uses, so the digest the UI binds is the digest the submit will
        verify. Suggested params follow the recorded-task rule (initial id).
        """
        if not self.paid:
            return _json(
                403,
                {"error": {"category": "forbidden", "detail": "paid mode disabled"}},
            )
        root = self._projects.get(name)
        if root is None:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown project"}}
            )
        if not shot_id or not _NAME_RE.fullmatch(shot_id):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "bad shot_id"}}
            )
        from ai_video_workflow.app.bootstrap import initial_task_id
        from ai_video_workflow.app.paid_gateway import ShotRecordTargetResolver

        resolved = ShotRecordTargetResolver().resolve_target(
            root, ref=shot_id, version=1
        )
        if not resolved.exists:
            return _json(
                404,
                {"error": {"category": "not_found", "detail": "shot record not found"}},
            )
        # Suggest the LATEST compiled packet version for the shot (a fresh
        # lock-draft-plan compiles new versions); the Gateway re-verifies the
        # packet against the approved inputs at preflight/submit regardless.
        packets_dir = root / "planning" / "packets"
        packet_versions = []
        if packets_dir.is_dir():
            packet_re = re.compile(rf"^{re.escape(shot_id)}_v([1-9][0-9]*)\.json$")
            packet_versions = [
                int(m.group(1))
                for p in packets_dir.iterdir()
                if (m := packet_re.match(p.name)) is not None
            ]
        return _json(
            200,
            {
                "target": {
                    "ref": shot_id,
                    "version": 1,
                    "content_digest": resolved.content_digest,
                },
                "params": {
                    "task_id": initial_task_id(shot_id),
                    "shot_id": shot_id,
                    "packet_version": max(packet_versions, default=1),
                },
            },
        )

    # -- queries (read-only) ---------------------------------------------
    def _query(self, name: str, sub: str):
        method = _QUERIES.get(sub)
        if method is None:
            return _json(
                404,
                {
                    "error": {
                        "category": "not_found",
                        "detail": f"unknown query: {sub!r}",
                    }
                },
            )
        if not self.connected:
            return _json(
                503,
                {
                    "error": {
                        "category": "unavailable",
                        "detail": "query backend not available",
                    }
                },
            )
        root = self._projects.get(name)
        if root is None:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown project"}}
            )
        try:
            return _json(200, to_jsonable(getattr(self._svc, method)(root)))
        except AccountScopeError as exc:
            return _json(
                403, {"error": {"category": "account_scope", "detail": str(exc)}}
            )
        except WorkspaceError as exc:
            return _json(
                502, {"error": {"category": "query_failed", "detail": str(exc)}}
            )
        except Exception as exc:  # noqa: BLE001 - fail closed, expose type only
            return _json(
                500,
                {
                    "error": {
                        "category": "query_failed",
                        "detail": f"unexpected {type(exc).__name__}",
                    }
                },
            )

    # -- studio persistence, rooted in the PROJECT (ADR-0053) --------------
    #
    # <ProjectRoot>/
    #   project.json      core, unchanged — no second project schema
    #   studio/canvas.json  the studio's creative domain (story, bible,
    #                       episodes/scenes/shots, Asset + Generation
    #                       Registries, timelines)
    #   media/            every uploaded / generated project media file
    #
    # The old location (mockups/motv-workspace/data/) is READ-ONLY legacy:
    # connected mode never writes there again. A legacy project must be
    # explicitly migrated before it can be edited, so a half-migrated state —
    # canvas in the project, media still in the repo scratch — cannot exist.

    def _project_root(self, name: str):
        """The admitted root of a known project, or None.

        Containment here comes from the REGISTRY, not from the name's
        character set: the name is only ever a dictionary key, and the path is
        built from the admitted root it maps to, so nothing a caller types can
        become a path segment. That matters because project names are real
        creator-facing titles — `_NAME_RE` is ASCII-only, so requiring it would
        make every project with a Chinese name unopenable even though project
        creation accepts one.
        """
        if not isinstance(name, str) or not name:
            return None
        return self._projects.get(name)

    @staticmethod
    def _contained(root: Path, *parts: str):
        """`root/parts...`, but only if it is STILL inside `root` once resolved.

        The tail is a constant here, so this is not about traversal in the
        request — it is about the directory itself being a link. `studio` or
        `media` replaced by a symlink/junction would otherwise let a canvas
        write or a media read land anywhere on disk, because `resolve()`
        FOLLOWS the link (which is exactly what made the first version of this
        check vacuous). A path that does not exist yet resolves to where it
        would be created, so this also refuses to create through a link.
        """
        try:
            root_r = root.resolve()
            target = root_r
            for part in parts:
                target = target / part
            resolved = target.resolve()
        except OSError:
            return None
        if root_r not in resolved.parents:
            return None
        return resolved

    def _canvas_path(self, name: str):
        """Where this project's studio document lives NOW (project-rooted).

        None when the project is unknown, or when `studio/` has been replaced
        by a link pointing out of the project — the caller turns that into a
        404/400 rather than reading or writing outside the admitted root.
        """
        root = self._project_root(name)
        if root is None:
            return None
        return self._contained(root, "studio", "canvas.json")

    @staticmethod
    def _legacy_safe(name: str) -> bool:
        """A name that can be used as ONE path segment under the legacy scratch.

        Unlike `_NAME_RE` this allows non-ASCII (real project titles are
        Chinese here); what it refuses is anything that could leave the
        directory or break the path call itself.
        """
        return (
            isinstance(name, str)
            and bool(name)
            and name not in {".", ".."}
            and not any(c in name for c in ("/", "\\", "\x00"))
        )

    def _legacy_canvas_path(self, name: str):
        """The pre-ADR-0053 scratch save, read-only."""
        if not self._legacy_safe(name):
            return None
        p = (DATA_DIR / f"{name}.json").resolve()
        if p.parent != DATA_DIR.resolve():  # strict containment, unchanged
            return None
        return p

    def _legacy_upload_dir(self, project: str):
        """The pre-ADR-0053 media scratch, read-only."""
        if not self._legacy_safe(project):
            return None
        d = (DATA_DIR / "uploads" / project).resolve()
        if DATA_DIR.resolve() not in d.parents:
            return None
        return d

    def _legacy_state(self, name: str):
        """(has_legacy, migrated) for a project.

        `migrated` is decided by the PROJECT canvas existing: once it does, the
        legacy tree is ignored completely. That is what makes a half-migrated
        state impossible — reads never mix the two."""
        p = self._canvas_path(name)
        migrated = bool(p and p.is_file())
        if migrated:
            return (False, True)
        legacy_canvas = self._legacy_canvas_path(name)
        legacy_media = self._legacy_upload_dir(name)
        has_legacy = bool(
            (legacy_canvas and legacy_canvas.is_file())
            or (legacy_media and legacy_media.is_dir() and any(legacy_media.iterdir()))
        )
        return (has_legacy, False)

    def _migration_required(self, name: str) -> bool:
        """A write must be refused while unmigrated legacy data exists."""
        has_legacy, migrated = self._legacy_state(name)
        return has_legacy and not migrated

    def _backup_corrupt_canvas(self, p) -> bool:
        """Copy an unparseable canvas file aside (never move/delete the
        original). Named by content digest so repeated hits on the same corrupt
        file are idempotent, and ``.corrupt-*`` cannot collide with a canvas
        name (names disallow dots). Returns True when the backup exists."""
        try:
            data = p.read_bytes()
            backup = p.with_name(
                f"{p.name}.corrupt-{hashlib.sha256(data).hexdigest()[:12]}"
            )
            if not backup.is_file():
                backup.write_bytes(data)
            return True
        except OSError:
            return False

    def _canvas_get(self, name: str):
        p = self._canvas_path(name)
        if p is None:
            # unknown project — never fall back to a repo-scratch file
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown project"}}
            )
        if not p.is_file():
            # Not migrated yet: serve the legacy save READ-ONLY so the creator
            # can look at it and decide to migrate. Writes stay refused until
            # they do (see _canvas_put) — the studio must never end up with its
            # canvas here and its media still in the repo scratch.
            legacy = self._legacy_canvas_path(name)
            if legacy and legacy.is_file():
                try:
                    payload = json.loads(legacy.read_text("utf-8"))
                except OSError:
                    return _json(
                        500,
                        {
                            "error": {
                                "category": "read_failed",
                                "detail": "could not read legacy canvas",
                            }
                        },
                    )
                except ValueError:
                    self._backup_corrupt_canvas(legacy)
                    return _json(
                        409,
                        {
                            "error": {
                                "category": "corrupt_save",
                                "detail": "stored canvas is not valid JSON "
                                "(kept on disk, backup created)",
                            }
                        },
                    )
                if isinstance(payload, dict):
                    payload = {**payload, "_legacy": True}
                return _json(200, payload)
            return _json(200, {})
        try:
            return _json(200, json.loads(p.read_text("utf-8")))
        except OSError:
            # Never collapse a present-but-unreadable save into an "empty
            # project" — the client would offer a blank canvas whose next
            # autosave overwrites potentially recoverable creator data.
            return _json(
                500,
                {
                    "error": {
                        "category": "read_failed",
                        "detail": "could not read canvas",
                    }
                },
            )
        except ValueError:
            self._backup_corrupt_canvas(p)
            return _json(
                409,
                {
                    "error": {
                        "category": "corrupt_save",
                        "detail": "stored canvas is not valid JSON "
                        "(kept on disk, backup created)",
                    }
                },
            )

    def _canvas_put(self, name: str, body: bytes):
        p = self._canvas_path(name)
        if p is None:
            # unknown project — never fall back to a repo-scratch file
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown project"}}
            )
        if self._migration_required(name):
            return _migration_required_json()
        # Canvas JSON keeps its original 2 MB bound (transport now allows 8 MB
        # for image uploads only).
        if len(body) > _CANVAS_BODY_MAX:
            return _json(
                413,
                {
                    "error": {
                        "category": "too_large",
                        "detail": "request body too large",
                    }
                },
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": "body must be an object",
                    }
                },
            )
        # A canvas save must never roll a running task backwards (contract §5.5),
        # and must never import another project's results either.
        _reconcile_skill_runs(payload, project=name)
        # Overwriting an unparseable existing save would destroy the only copy
        # of possibly-recoverable creator data — secure a backup first, and
        # refuse the write if the backup cannot be created.
        if p.is_file():
            try:
                json.loads(p.read_text("utf-8"))
            except ValueError:
                if not self._backup_corrupt_canvas(p):
                    return _json(
                        500,
                        {
                            "error": {
                                "category": "write_failed",
                                "detail": "existing canvas is corrupt "
                                "and could not be backed up",
                            }
                        },
                    )
            except OSError:
                return _json(
                    500,
                    {
                        "error": {
                            "category": "write_failed",
                            "detail": "existing canvas could not be verified "
                            "before overwrite",
                        }
                    },
                )
        # The studio document lives in the PROJECT now, so the temp file must be
        # created there too: os.replace is only atomic within one filesystem,
        # and the project root can easily be on a different volume than the repo.
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            return _json(
                500,
                {
                    "error": {
                        "category": "write_failed",
                        "detail": "could not create the project's studio/ folder",
                    }
                },
            )
        # A unique temp file per write so concurrent saves for the same project
        # (multiple tabs) can't collide on a shared ``canvas.json.tmp``.
        fd, tmpname = tempfile.mkstemp(dir=str(p.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(payload, ensure_ascii=False))
            os.replace(tmpname, p)  # atomic within the project's own volume
        except OSError:
            try:
                os.unlink(tmpname)
            except OSError:
                pass
            return _json(
                500, {"error": {"category": "write_failed", "detail": "could not save"}}
            )
        return _json(200, {"ok": True})

    # -- legacy → project migration (ADR-0053) ------------------------------

    def _migrate_legacy(self, body: bytes):
        """Copy a project's legacy scratch into the project folder, ALL of it.

        Canvas and media move together or not at all: a project whose canvas
        had been migrated while its media still resolved out of the repo would
        render broken media the moment the legacy tree was cleaned up, and the
        creator would have no way to tell which half they were looking at.

        The legacy tree is COPIED, never moved or deleted — it stays as the
        read-only original until the creator removes it themselves (AGENTS.md
        §13: nothing of theirs is destroyed on our initiative).
        """
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        name = payload.get("project") if isinstance(payload, dict) else None
        if not isinstance(name, str) or not name:
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        root = self._project_root(name)
        if root is None:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown project"}}
            )
        has_legacy, migrated = self._legacy_state(name)
        if migrated:
            return _json(
                200,
                {"ok": True, "migrated": False, "detail": "已经在项目目录里"},
            )
        if not has_legacy:
            return _json(
                404,
                {
                    "error": {
                        "category": "not_found",
                        "detail": "这个项目没有可迁移的旧数据",
                    }
                },
            )

        canvas_src = self._legacy_canvas_path(name)
        media_src = self._legacy_upload_dir(name)
        canvas_dst = self._canvas_path(name)
        media_dst = self._upload_dir(name)
        copied: list[Path] = []
        with _REGISTRY_LOCK:
            try:
                # media first: if anything fails we can still leave the project
                # unmigrated, which keeps the write gate closed and the legacy
                # tree authoritative
                if media_src and media_src.is_dir():
                    media_dst.mkdir(parents=True, exist_ok=True)
                    for entry in sorted(media_src.iterdir()):
                        if entry.is_symlink() or not entry.is_file():
                            continue  # never follow a link out of the scratch
                        if not _UPLOAD_FILE_RE.fullmatch(entry.name):
                            continue
                        target = media_dst / entry.name
                        if target.exists():
                            continue  # never overwrite media already in the project
                        target.write_bytes(entry.read_bytes())
                        copied.append(target)
                # The project canvas existing is exactly what marks this project
                # migrated, so it is written LAST (never before its media) and
                # ALWAYS — a legacy project with media but no saved canvas would
                # otherwise stay "unmigrated" forever and be permanently
                # write-blocked despite a successful migration. An empty
                # document is the honest state there: nothing was ever saved.
                canvas_dst.parent.mkdir(parents=True, exist_ok=True)
                if canvas_src and canvas_src.is_file():
                    canvas_dst.write_bytes(canvas_src.read_bytes())
                else:
                    canvas_dst.write_text("{}", encoding="utf-8")
                copied.append(canvas_dst)
            except OSError as exc:
                for made in reversed(copied):
                    try:
                        made.unlink(missing_ok=True)
                    except OSError:
                        pass
                return _json(
                    500,
                    {
                        "error": {
                            "category": "write_failed",
                            "detail": f"迁移失败，已回滚：{exc}",
                        }
                    },
                )
        return _json(
            200,
            {
                "ok": True,
                "migrated": True,
                "files": len(copied),
                "canvas": str(canvas_dst),
                "media": str(media_dst),
                "legacy_kept": True,
            },
        )

    # -- project browse + creation (ADR-0051) -------------------------------

    def _fs_list(self, raw_path: str):
        """Read-only directory listing so the studio can OFFER a picker.

        Directories only. No file contents, no sizes, nothing but names and
        whether a child directory exists. Same loopback + Origin guards as
        every other route (ADR-0051 §4).
        """
        if not raw_path:
            base = self.account_root or Path.home()
        else:
            # A NUL (or any control character) reaches the filesystem calls below
            # and raises ValueError, which is NOT an OSError — it would escape as
            # a dropped connection instead of a 400. Same rule as project names.
            if "\x00" in raw_path:
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_path",
                            "detail": "path contains a NUL byte",
                        }
                    },
                )
            base = Path(raw_path)
        if not base.is_absolute():
            return _json(
                400,
                {"error": {"category": "bad_path", "detail": "path must be absolute"}},
            )
        try:
            base = base.resolve()
        except (OSError, ValueError) as exc:
            return _json(400, {"error": {"category": "bad_path", "detail": str(exc)}})
        if not base.is_dir():
            return _json(
                404,
                {"error": {"category": "not_found", "detail": "not a directory"}},
            )
        entries = []
        try:
            with os.scandir(base) as it:
                for e in it:
                    try:
                        if not e.is_dir(follow_symlinks=False):
                            continue
                    except OSError:
                        continue
                    if e.name.startswith("."):
                        continue  # hidden/system noise, never useful as a root
                    entries.append({"name": e.name, "path": str(base / e.name)})
        except PermissionError:
            return _json(
                403,
                {
                    "error": {
                        "category": "forbidden",
                        "detail": "directory not readable",
                    }
                },
            )
        except OSError as exc:
            return _json(400, {"error": {"category": "bad_path", "detail": str(exc)}})
        entries.sort(key=lambda x: x["name"].lower())
        parent = None if base == base.parent else str(base.parent)
        return _json(
            200,
            {
                "path": str(base),
                "parent": parent,
                "sep": os.sep,
                "entries": entries[:500],
                "truncated": len(entries) > 500,
            },
        )

    def _create_project(self, body: bytes):
        """POST /api/projects — admit a root, scaffold the project, register it."""
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return _json(
                400, {"error": {"category": "bad_json", "detail": "invalid JSON body"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400, {"error": {"category": "bad_json", "detail": "expected an object"}}
            )
        name = str(payload.get("name") or "").strip()
        root_in = str(payload.get("root") or "").strip()
        confirm = payload.get("confirm") is True
        if not _valid_project_name(name):
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_name",
                        "detail": (
                            "项目名不能为空、不能超过 60 字，"
                            '不能包含 \\ / : * ? " < > |，也不能以 . 或空格结尾'
                        ),
                    }
                },
            )
        with _REGISTRY_LOCK:
            # one writer at a time: read-modify-write of the registry is atomic
            # with respect to other create requests (ThreadingHTTPServer)
            reg = _load_project_registry()
            confirmed = set(reg.get("confirmedRoots") or [])
            try:
                admitted = admit_root(
                    root_in,
                    repo_root=REPO_ROOT,
                    confirmed_roots=confirmed,
                    confirm=confirm,
                )
            except RootRejected as exc:
                status = 409 if exc.code == "root_unconfirmed" else 400
                return _json(
                    status, {"error": {"category": exc.code, "detail": exc.detail}}
                )

            target = admitted.resolved / name
            # A pre-existing SYMLINK named like the project would pass an emptiness
            # check while pointing anywhere, and every later write would follow it
            # straight out of the admitted root. Refuse the link itself, and require
            # the resolved project directory to sit directly under the admitted
            # root (ADR-0004 containment, applied to this project's own root).
            if target.is_symlink():
                return _json(
                    400,
                    {
                        "error": {
                            "category": "symlink_escape",
                            "detail": f"这个位置已经有一个同名的符号链接：{target}",
                        }
                    },
                )
            if target.exists():
                real = target.resolve()
                if real.parent != admitted.resolved:
                    return _json(
                        400,
                        {
                            "error": {
                                "category": "symlink_escape",
                                "detail": f"同名文件夹解析后不在所选位置之内：{real}",
                            }
                        },
                    )
                if not target.is_dir():
                    return _json(
                        409,
                        {
                            "error": {
                                "category": "exists",
                                "detail": (f"这个位置已经有一个同名文件：{target}"),
                            }
                        },
                    )
                if any(target.iterdir()):
                    return _json(
                        409,
                        {
                            "error": {
                                "category": "exists",
                                "detail": (
                                    f"这个位置已经有一个非空的同名文件夹：{target}"
                                ),
                            }
                        },
                    )
            # Case-INSENSITIVELY: the landing page merges project names that way
            # (NTFS would collide anyway), so on a case-sensitive filesystem a
            # direct API call could otherwise create both `Foo` and `foo` and
            # leave one of them permanently invisible in the UI.
            lower = name.casefold()
            clash = next(
                (k for k in self._projects if k.casefold() == lower),
                None,
            )
            if clash is not None:
                return _json(
                    409,
                    {
                        "error": {
                            "category": "exists",
                            "detail": f"已有同名项目：{clash}",
                        }
                    },
                )
            # The link / emptiness checks above ran against the path as it was a
            # moment ago. Everything below therefore re-establishes safety at the
            # instant of writing, rather than trusting that earlier look:
            #   * mkdir with exist_ok=False fails outright if anything (including
            #     a symlink or junction swapped in since) now occupies the path;
            #   * the resolved parent is re-checked AFTER the directory exists;
            #   * project.json is created with O_EXCL (+ O_NOFOLLOW where the
            #     platform has it), which refuses to follow a link on the final
            #     component instead of writing through it.
            made_dir = False
            try:
                if not target.exists():
                    target.mkdir(parents=True, exist_ok=False)
                    made_dir = True
                if target.is_symlink() or target.resolve().parent != admitted.resolved:
                    raise OSError(f"项目目录在创建过程中被替换：{target}")
                flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
                flags |= getattr(os, "O_NOFOLLOW", 0)
                flags |= getattr(os, "O_BINARY", 0)
                fd = os.open(target / "project.json", flags, 0o644)
                with os.fdopen(fd, "wb") as fh:
                    fh.write(
                        json.dumps(
                            {
                                "created_at": datetime.now(timezone.utc).isoformat(),
                                "description": None,
                                "name": name,
                                "project_id": name,
                            },
                            ensure_ascii=False,
                            indent=2,
                        ).encode("utf-8")
                    )
                # ADR-0055 决策 5: the project's shape exists from the start —
                # studio/ (canvas.json) and media/ (every media byte). Both were
                # already created lazily on first write; creating them here means
                # a freshly-made project SHOWS its structure instead of looking
                # empty. Deliberately NO physical classification subfolders: the
                # Asset Registry is the classification source of truth, and a
                # second, physical one could only ever disagree with it.
                for sub in ("studio", "media"):
                    (target / sub).mkdir(exist_ok=True)
            except OSError as exc:
                # Same rule as the registry rollback below: never leave a partial
                # project behind, or every retry is rejected as "already exists".
                try:
                    (target / "project.json").unlink(missing_ok=True)
                    # the scaffolded subfolders are OURS too — an rmdir that
                    # trips over them would leave the half-made project behind
                    # and make every retry fail as "already exists"
                    for sub in ("studio", "media"):
                        with contextlib.suppress(OSError):
                            (target / sub).rmdir()
                    if made_dir:
                        target.rmdir()
                except OSError:
                    pass
                return _json(
                    500, {"error": {"category": "write_failed", "detail": str(exc)}}
                )

            reg["projects"] = [x for x in reg["projects"] if x.get("name") != name] + [
                {
                    "name": name,
                    "root": str(target),
                    "created_at": datetime.now(timezone.utc).isoformat(),
                }
            ]
            if str(admitted.resolved) not in confirmed:
                reg["confirmedRoots"] = sorted(confirmed | {str(admitted.resolved)})
            if not _save_project_registry(reg):
                # Roll back what WE created, so the failure is not half-applied:
                # otherwise a retry hits "非空的同名文件夹" while the project is
                # still unregistered and invisible after a restart.
                try:
                    (target / "project.json").unlink(missing_ok=True)
                    # the scaffolded subfolders are OURS too — an rmdir that
                    # trips over them would leave the half-made project behind
                    # and make every retry fail as "already exists"
                    for sub in ("studio", "media"):
                        with contextlib.suppress(OSError):
                            (target / sub).rmdir()
                    if made_dir:
                        target.rmdir()
                except OSError:
                    pass
                return _json(
                    500,
                    {
                        "error": {
                            "category": "write_failed",
                            "detail": "项目列表写入失败，已回滚刚创建的项目文件夹",
                        }
                    },
                )
            self._projects[name] = target
        return _json(
            201,
            {
                "ok": True,
                "name": name,
                "root": str(admitted.resolved),
                "project_path": str(target),
                "created_root": admitted.created,
            },
        )

    # -- local FFmpeg draft compose (ADR-0044) ------------------------------
    def _resolve_slot(self, d, slug: str, exts: tuple[str, ...]):
        """Resolve an upload slug to an existing regular file among exts."""
        if not isinstance(slug, str) or not _NAME_RE.fullmatch(slug):
            return None
        for ext in exts:
            p = d / f"{slug}{ext}"
            if p.is_file() and not p.is_symlink():
                rp = p.resolve()
                if d in rp.parents and rp.is_file():
                    return rp
        return None

    def _agent_compose(self, body: bytes):
        """Compose the draft's uploaded shot videos (+ optional voice/music)
        into a real MP4 with LOCAL ffmpeg (ADR-0044; free, prototype scratch).

        Per shot: normalize to 720p/25fps/AAC with the voice track mapped in
        (video duration governs); concat; optionally mix music underneath.
        Output ``final-cut-v<N>.mp4`` — versioned, never overwrites (§13).
        Fail-closed: missing ffmpeg → 503; missing/invalid slot files → 400;
        a failed step → 5xx naming the shot. Never a fabricated success.
        """
        if len(body) > 100_000:
            return _json(
                413,
                {"error": {"category": "too_large", "detail": "request too large"}},
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "body must be object"}},
            )
        project = payload.get("project")
        shots = payload.get("shots")
        music_slug = payload.get("music")
        if not isinstance(project, str):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        d = self._upload_dir(project)
        if d is None:
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        # SAME ceiling as the shot-draft parser, from the same constant. When
        # these were two literal `20`s, raising one without the other would have
        # produced a draft the compose route then refused — the failure would
        # land at the very end, after all the media had been made.
        if not isinstance(shots, list) or not (
            1 <= len(shots) <= _MAX_SHOTS_PER_EPISODE
        ):
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": f"1-{_MAX_SHOTS_PER_EPISODE} shots required",
                    }
                },
            )
        import shutil as _shutil

        ffmpeg = _shutil.which("ffmpeg")
        ffprobe = _shutil.which("ffprobe")
        if ffmpeg is None or ffprobe is None:
            return _json(
                503,
                {
                    "error": {
                        "category": "compose_unavailable",
                        "detail": "ffmpeg/ffprobe 缺失：请安装并加入 PATH",
                    }
                },
            )
        # resolve every input BEFORE any work (fail-closed on the first hole)
        resolved = []
        for i, item in enumerate(shots, start=1):
            if not isinstance(item, dict):
                return _json(
                    400,
                    {"error": {"category": "bad_request", "detail": f"shot {i} bad"}},
                )
            video = self._resolve_slot(d, item.get("video"), (".mp4", ".webm"))
            if video is None:
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": f"shot {i}: video missing/not uploaded",
                        }
                    },
                )
            voice = None
            if item.get("voice"):
                # Fail-closed: an EXPLICITLY requested voice slot that no longer
                # resolves is an error — never silently deliver a mute shot.
                voice = self._resolve_slot(d, item.get("voice"), (".wav", ".mp3"))
                if voice is None:
                    return _json(
                        400,
                        {
                            "error": {
                                "category": "bad_request",
                                "detail": f"shot {i}: voice slot missing/not uploaded",
                            }
                        },
                    )
            resolved.append((video, voice))
        music = None
        if music_slug:
            # Fail-closed: an EXPLICITLY requested music slot that no longer
            # resolves is an error — never silently deliver a musicless cut.
            music = self._resolve_slot(d, music_slug, (".mp3", ".wav"))
            if music is None:
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": "music slot missing/not uploaded",
                        }
                    },
                )
        # workdir creation is inside the fail-closed envelope too: an
        # unwritable/missing uploads dir or ENOSPC must yield JSON 5xx,
        # never an uncaught exception.
        try:
            work = Path(tempfile.mkdtemp(prefix="compose-", dir=str(d)))
        except OSError:
            return _json(
                500,
                {"error": {"category": "write_failed", "detail": "workdir failed"}},
            )
        try:
            parts = []
            for i, (video, voice) in enumerate(resolved, start=1):
                out = work / f"part{i:02d}.mp4"
                norm = (
                    "scale=1280:720:force_original_aspect_ratio=decrease,"
                    "pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=25"
                )
                if voice is not None:
                    # The VIDEO's probed duration governs the shot exactly:
                    # apad pads a shorter voice with silence and ``-t`` caps the
                    # output at the video length (deterministic — apad+-shortest
                    # alone is unreliable and can run long). A longer voice is
                    # likewise cut at the video's end.
                    probe = subprocess.run(  # noqa: S603 - fixed argv, no shell
                        [
                            ffprobe,
                            "-v",
                            "error",
                            "-show_entries",
                            "format=duration",
                            "-of",
                            "default=nw=1:nk=1",
                            str(video),
                        ],
                        capture_output=True,
                        text=True,
                        timeout=60,
                    )
                    try:
                        vdur = float(probe.stdout.strip())
                    except ValueError:
                        vdur = 0.0
                    if probe.returncode != 0 or not (0 < vdur <= 600):
                        return _json(
                            502,
                            {
                                "error": {
                                    "category": "compose_failed",
                                    "detail": f"shot {i}: probe failed",
                                }
                            },
                        )
                    cmd = [
                        ffmpeg,
                        "-y",
                        "-nostdin",
                        "-i",
                        str(video),
                        "-i",
                        str(voice),
                        "-map",
                        "0:v:0",
                        "-map",
                        "1:a:0",
                        "-af",
                        "apad",
                        "-t",
                        f"{vdur:.3f}",
                    ]
                else:  # silent track keeps concat streams uniform
                    cmd = [
                        ffmpeg,
                        "-y",
                        "-nostdin",
                        "-i",
                        str(video),
                        "-f",
                        "lavfi",
                        "-i",
                        "anullsrc=r=44100:cl=stereo",
                        "-map",
                        "0:v:0",
                        "-map",
                        "1:a:0",
                        "-shortest",
                    ]
                # Audio params are normalized IDENTICALLY in both branches
                # (-ac 2 -ar 44100): a mono TTS voice next to a stereo silent
                # track would otherwise produce mismatched parts that break
                # the stream-copy concat.
                cmd += [
                    "-vf",
                    norm,
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-ac",
                    "2",
                    "-ar",
                    "44100",
                    str(out),
                ]
                proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=300,
                )
                if proc.returncode != 0 or not out.is_file():
                    return _json(
                        502,
                        {
                            "error": {
                                "category": "compose_failed",
                                "detail": f"shot {i}: ffmpeg normalize failed",
                            }
                        },
                    )
                parts.append(out)
            listfile = work / "concat.txt"
            listfile.write_text("".join(f"file '{p.name}'\n" for p in parts), "utf-8")
            joined = work / "joined.mp4"
            proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
                [
                    ffmpeg,
                    "-y",
                    "-nostdin",
                    "-f",
                    "concat",
                    "-safe",
                    "0",
                    "-i",
                    str(listfile),
                    "-c",
                    "copy",
                    str(joined),
                ],
                cwd=str(work),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=300,
            )
            if proc.returncode != 0 or not joined.is_file():
                return _json(
                    502,
                    {
                        "error": {
                            "category": "compose_failed",
                            "detail": "concat failed",
                        }
                    },
                )
            final_src = joined
            if music is not None:
                mixed = work / "mixed.mp4"
                proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
                    [
                        ffmpeg,
                        "-y",
                        "-nostdin",
                        "-i",
                        str(joined),
                        "-stream_loop",
                        "-1",
                        "-i",
                        str(music),
                        "-filter_complex",
                        "[1:a]volume=0.22[m];[0:a][m]amix=inputs=2:duration=first[a]",
                        "-map",
                        "0:v:0",
                        "-map",
                        "[a]",
                        "-c:v",
                        "copy",
                        "-c:a",
                        "aac",
                        "-ar",
                        "44100",
                        str(mixed),
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=300,
                )
                if proc.returncode != 0 or not mixed.is_file():
                    return _json(
                        502,
                        {
                            "error": {
                                "category": "compose_failed",
                                "detail": "music mix failed",
                            }
                        },
                    )
                final_src = mixed
            # Versioned final name — never overwrite an earlier cut (§13).
            # The version number is claimed ATOMICALLY via O_CREAT|O_EXCL so two
            # concurrent composes can never pick the same N (check-then-replace
            # would race); once claimed, the placeholder is ours to replace.
            n = 1
            while True:
                target = d / f"final-cut-v{n}.mp4"
                try:
                    os.close(os.open(str(target), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                    break
                except FileExistsError:
                    n += 1
            try:
                os.replace(final_src, target)
            except OSError:
                try:
                    os.unlink(target)  # release the claimed slot on failure
                except OSError:
                    pass
                raise
        except subprocess.TimeoutExpired:
            return _json(
                504,
                {
                    "error": {
                        "category": "compose_timeout",
                        "detail": "ffmpeg timed out",
                    }
                },
            )
        except OSError:
            return _json(
                502,
                {"error": {"category": "compose_failed", "detail": "compose failed"}},
            )
        finally:
            _shutil.rmtree(work, ignore_errors=True)
        return _json(
            200,
            {
                "ok": True,
                "url": f"/api/uploads/{project}/final-cut-v{n}.mp4",
                "version": n,
                "shots": len(resolved),
                "music": music is not None,
            },
        )

    def _delivery_probe(self, body: bytes):
        """Measure a rendered cut with REAL ffprobe/ffmpeg (TASK-074 §1.2 接线).

        `workflow/deliveryqc.js` has judged 音画同步 / 音量 / 削波 / 黑帧 / 缺帧
        since §1.2, but it never had numbers: a browser cannot run ffmpeg, so all
        five rendered as 未检查. This endpoint supplies exactly the `probe` shape
        that module reads, measured from the file itself.

        READ-ONLY. It opens the cut and writes nothing, so it is deliberately NOT
        in _MEDIA_WRITE_ROUTES.

        **A measurement that did not happen is reported as ABSENT** — the field is
        omitted, never guessed. `deliveryqc` renders a missing field as 未检查 and
        keeps `passed` false; filling the screen green with invented numbers is
        exactly what §1.2 / ADR-0064 决策 6 forbid. So every parse below is
        all-or-nothing per field.

        Fail-closed: missing ffmpeg/ffprobe → 503 (same as compose), unresolvable
        file → 400, a failed/timed-out probe → 502/504.
        """
        if len(body) > 100_000:
            return _json(413, {"error": {"category": "too_large", "detail": "body"}})
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid json"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "body must be object"}},
            )
        project = payload.get("project")
        if not isinstance(project, str):
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "project required"}},
            )
        d = self._upload_dir(project)
        if d is None:
            return _json(
                400, {"error": {"category": "bad_request", "detail": "unknown project"}}
            )
        f = self._resolve_upload_file(d, payload.get("name"), (".mp4", ".webm"))
        if f is None:
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "成片文件无法解析"}},
            )

        # ADR-0049 / AGENTS.md 第 6 条：resolve, never invoke by bare name.
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if ffmpeg is None or ffprobe is None:
            return _json(
                503,
                {
                    "error": {
                        "category": "ffmpeg_missing",
                        "detail": "ffmpeg/ffprobe 缺失：请安装并加入 PATH",
                    }
                },
            )

        try:
            meta = subprocess.run(  # noqa: S603 - fixed argv, no shell
                [
                    ffprobe,
                    "-v",
                    "error",
                    "-show_streams",
                    "-show_format",
                    "-of",
                    "json",
                    str(f),
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
            if meta.returncode != 0:
                return _json(
                    502,
                    {"error": {"category": "probe_failed", "detail": "ffprobe failed"}},
                )
            info = json.loads(meta.stdout or "{}")
            # One decode pass produces BOTH loudness and black spans. Running the
            # file twice would double the wall clock for no extra information.
            scan = subprocess.run(  # noqa: S603 - fixed argv, no shell
                [
                    ffmpeg,
                    "-nostdin",
                    "-nostats",
                    "-i",
                    str(f),
                    "-af",
                    "ebur128=peak=true",
                    "-vf",
                    "blackdetect=d=0.5:pic_th=0.98",
                    "-f",
                    "null",
                    "-",
                ],
                capture_output=True,
                text=True,
                timeout=900,
            )
        except subprocess.TimeoutExpired:
            return _json(
                504,
                {"error": {"category": "probe_timeout", "detail": "probe timed out"}},
            )
        except (OSError, json.JSONDecodeError):
            return _json(
                502, {"error": {"category": "probe_failed", "detail": "probe failed"}}
            )

        # THE SCAN'S EXIT CODE DECIDES WHETHER ITS OUTPUT MEANS ANYTHING
        # (codex 跨模型复审, 2026-08-16). `subprocess.run` without `check=True`
        # raises nothing on a non-zero exit, so a decode that died half-way —
        # corrupt file, unsupported codec, disk error — still left `scan.stderr`
        # holding the ebur128/blackdetect lines it had printed so far, and this
        # returned them as `200 {"ok": true}`.
        #
        # That is worse than failing, and it is the exact inverse of this
        # feature's rule 「测不出即缺席」: a PARTIAL measurement is
        # indistinguishable from a complete one, and `blackSpans: []` from an
        # aborted scan reads as 「没有黑帧」 rather than 「没扫完」. The QC gate
        # then passes on it.
        #
        # ffprobe above already checked its own `returncode`; this one did not.
        if scan.returncode != 0:
            return _json(
                502,
                {
                    "error": {
                        "category": "probe_failed",
                        "detail": (
                            f"ffmpeg 扫描未正常结束（exit {scan.returncode}）"
                            "——本次测量不完整，不予采用"
                        ),
                    }
                },
            )
        probe = _build_delivery_probe(info, scan.stderr or "")
        return _json(200, {"ok": True, "probe": probe, "name": f.name})

    def _resolve_upload_file(self, d, name, exts):
        """Resolve an EXACT upload basename (incl. its ADR-0048 version
        suffix) to a regular file inside the project's upload dir. Same
        containment discipline as _resolve_slot: whitelist pattern, no
        symlinks, resolved path must stay under the directory."""
        if not isinstance(name, str) or not _UPLOAD_FILE_RE.fullmatch(name):
            return None
        if not name.endswith(exts):
            return None
        p = d / name
        if p.is_file() and not p.is_symlink():
            rp = p.resolve()
            if d in rp.parents and rp.is_file():
                return rp
        return None

    def _agent_mix_shot(self, body: bytes):
        """Shot Mix (ADR-0061 决策 6 / TASK-064 Phase 3 §38): one shot's audio
        clips → ONE derived audio file with LOCAL ffmpeg.

        Each clip is trimmed, volume-shaped (gain in dB, the unit the client
        stores), faded, delayed to its resolved start and mixed. Output
        ``mix-<slot>_v<N>.mp3`` — versioned atomically, never overwrites.

        THE SOURCES ARE NEVER TOUCHED. This endpoint reads them and writes a new
        file; the dialogue take, the ambience bed and every effect stay exactly
        where they were, which is the invariant the whole mix design rests on.

        Fail-closed at every step; never a fabricated success. Shares
        ``_RENDER_LOCK`` with the episode render on purpose — both are ffmpeg
        jobs on the same machine, and letting a mix start under a render is how
        a prototype box runs out of CPU."""
        if len(body) > 200_000:
            return _json(
                413, {"error": {"category": "too_large", "detail": "request too large"}}
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "body must be object"}},
            )
        project = payload.get("project")
        slug = payload.get("slug")
        clips = payload.get("clips")
        if not isinstance(project, str):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        d = self._upload_dir(project)
        if d is None:
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        # the output basename stem — same slug discipline as every other write
        if not isinstance(slug, str) or not _NAME_RE.fullmatch(slug):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid slug"}}
            )
        # …AND IT MUST STAY INSIDE ITS OWN NAMESPACE (TASK-074 §1.1b a).
        #
        # `mix-` is a RESERVED prefix (`_RESERVED_SLUG_PREFIXES`) precisely so a
        # manual upload cannot claim a mix's versioned filename. Every other write
        # path checks `_slug_reserved` to keep OUT of the namespace; this one writes
        # INTO it and never checked that it stays there. So a crafted request could
        # name its output `voice-shot-1` or `sfx-shot-1` and take over a filename
        # belonging to the dialogue or effects chain — namespace squatting in the
        # one direction nothing guarded.
        if not slug.startswith("mix-"):
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": "混音产物的名字必须以 mix- 开头（保留命名空间）",
                    }
                },
            )
        if not isinstance(clips, list) or not (1 <= len(clips) <= 60):
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "1-60 clips required"}},
            )

        import shutil as _shutil

        ffmpeg = _shutil.which("ffmpeg")
        # ffprobe is REQUIRED, not optional. Every clip's requested window is
        # checked against the source's real duration, because ffmpeg silently
        # shortens (or drops) a clip whose trim runs past the end of the file --
        # the mix would then disagree with the frozen provenance and still report
        # success. Same requirement as _agent_compose.
        ffprobe = _shutil.which("ffprobe")
        if ffmpeg is None or ffprobe is None:
            return _json(
                503,
                {
                    "error": {
                        "category": "mix_unavailable",
                        "detail": "ffmpeg/ffprobe 缺失：请安装并加入 PATH",
                    }
                },
            )

        def _probe_duration(path):
            """The real duration of an audio file, or None when it cannot be
            determined. NEVER a guess: a clip whose length cannot be read is
            refused, because substituting a default silently truncates the mix
            and still reports success.

            Bounded by ``_PROBE_SEM`` (TASK-074 §1.1b d): at most
            ``_PROBE_MAX_CONCURRENT`` probes run process-wide, so a 60-clip request —
            or several at once — cannot spawn an unbounded pile of subprocesses. A
            saturated queue returns None (reported as a mix failure with a reason),
            never an assumed duration.
            """
            if not _PROBE_SEM.acquire(timeout=_PROBE_WAIT_SECONDS):
                return None
            try:
                pr = subprocess.run(  # noqa: S603 - fixed argv, validated path
                    [
                        ffprobe,
                        "-v",
                        "error",
                        "-show_entries",
                        "format=duration",
                        "-of",
                        "default=noprint_wrappers=1:nokey=1",
                        str(path),
                    ],
                    capture_output=True,
                    timeout=30,
                )
            except (subprocess.TimeoutExpired, OSError):
                return None
            finally:
                # released on EVERY path, including the early `return None` above —
                # a leaked permit would permanently shrink the cap until restart
                _PROBE_SEM.release()
            if pr.returncode != 0:
                return None
            try:
                d = float((pr.stdout or b"").decode("utf-8", "replace").strip())
            except ValueError:
                return None
            return d if math.isfinite(d) and d > 0 else None

        # resolve + validate EVERY clip before any work (fail-closed)
        auds = []
        for i, c in enumerate(clips, start=1):
            if not isinstance(c, dict):
                return _json(
                    400,
                    {"error": {"category": "bad_request", "detail": f"clip {i} bad"}},
                )

            def _num(key, lo, hi, default, c=c, i=i):
                v = c.get(key)
                if v is None:
                    return default, None
                if (
                    isinstance(v, (int, float))
                    and not isinstance(v, bool)
                    # RANGE FIRST (TASK-074 §1.1b c). ``math.isfinite`` converts its
                    # argument to a float, and a JSON integer too large for a float
                    # raises OverflowError there — so a legitimately-sized request
                    # body carrying 10**400 CRASHED the handler instead of getting a
                    # 400. Comparing an arbitrarily large int against a float is
                    # safe, and it already rejects NaN and ±inf (all of whose
                    # comparisons are False). ``isfinite`` is kept after it as an
                    # explicit statement of intent, now that it can no longer throw.
                    and lo <= v <= hi
                    and math.isfinite(v)
                ):
                    return float(v), None
                return None, f"clip {i}: bad {key}"

            tin, e = _num("in", 0.0, 36000.0, 0.0)
            if e:
                return _json(400, {"error": {"category": "bad_request", "detail": e}})
            # An ABSENT `out` means 「到素材结束」, not a one-second clip. It is
            # resolved from the file itself below, after the file is validated;
            # `_num` would otherwise default it to tin+1.0 and silently truncate.
            open_end = c.get("out") is None
            # `maxOut` is a CAP, not a request (see app.js mixNow): the Rough Cut
            # arranger derives it from the SHOT's length, so a bed shorter than
            # the shot is normal and must clamp rather than refuse. A creator's
            # own trim arrives as `out` and is held to the file.
            max_out, e = _num("maxOut", 0.0, 36000.0, None)
            if e:
                return _json(400, {"error": {"category": "bad_request", "detail": e}})
            tout, e = _num("out", 0.0, 36000.0, tin + 1.0)
            if e:
                return _json(400, {"error": {"category": "bad_request", "detail": e}})
            # BOTH ENDS SHARE ONE BOUND (TASK-074 §1.1b b). `in` was admitted up to
            # 36000 INCLUSIVE while `out` was CLAMPED to 36000, so `in == 36000` with
            # no `out` produced a ZERO-LENGTH clip — which either fails the mix or
            # vanishes from it silently. Checked HERE, before the file is resolved,
            # because it depends only on the request: an input problem should not
            # wait behind a media read to be reported.
            if open_end and tin >= 36000.0:
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": (
                                f"clip {i}: 入点 {tin:.3f}s 已到上限 36000s，"
                                "开放式片段会变成零长度"
                            ),
                        }
                    },
                )
            if not open_end and not (tin < tout):
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": f"clip {i}: bad trim",
                        }
                    },
                )
            start, e = _num("start", 0.0, 3600.0, 0.0)
            if e:
                return _json(400, {"error": {"category": "bad_request", "detail": e}})
            # GAIN IS dB here — the unit workflow/shotaudio.js stores. Converting
            # on the client and sending a linear multiplier would put the
            # conversion in two places; ffmpeg takes dB directly.
            gain, e = _num("gainDb", -60.0, 12.0, 0.0)
            if e:
                return _json(400, {"error": {"category": "bad_request", "detail": e}})
            fade_in, e = _num("fadeInMs", 0.0, 30000.0, 0.0)
            if e:
                return _json(400, {"error": {"category": "bad_request", "detail": e}})
            fade_out, e = _num("fadeOutMs", 0.0, 30000.0, 0.0)
            if e:
                return _json(400, {"error": {"category": "bad_request", "detail": e}})
            if c.get("muted") is True:
                continue  # a muted clip is not IN the mix — skipped, not silenced
            f = self._resolve_upload_file(d, c.get("file"), (".mp3", ".wav"))
            if f is None:
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": f"clip {i}: audio file missing",
                        }
                    },
                )
            # EVERY clip is checked against the source's real length, not only the
            # open-ended ones: an explicit out point past the end of the file is
            # exactly as silent a truncation, and it arrives with a frozen
            # provenance record that says otherwise.
            dur = _probe_duration(f)
            if dur is None:
                return _json(
                    502,
                    {
                        "error": {
                            "category": "mix_failed",
                            "detail": f"clip {i}: 无法读取素材时长（ffprobe 失败）",
                        }
                    },
                )
            if tin >= dur:
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": f"clip {i}: 入点已超过素材长度",
                        }
                    },
                )
            if open_end:
                tout = min(dur, 36000.0)
                if tout <= tin:
                    return _json(
                        400,
                        {
                            "error": {
                                "category": "bad_request",
                                "detail": (
                                    f"clip {i}: 素材只有 {dur:.3f}s，入点 {tin:.3f}s "
                                    "之后没有内容"
                                ),
                            }
                        },
                    )
                if max_out is not None:
                    if max_out <= tin:
                        return _json(
                            400,
                            {
                                "error": {
                                    "category": "bad_request",
                                    "detail": f"clip {i}: 上限早于入点",
                                }
                            },
                        )
                    tout = min(tout, max_out)
            elif tout > dur + 0.05:
                # a 50 ms tolerance absorbs container/decoder rounding; anything
                # beyond that is audio the caller asked for and the file does not
                # have, so it is refused rather than quietly shortened
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": (
                                f"clip {i}: 出点 {tout:.3f}s 超过素材时长 {dur:.3f}s"
                            ),
                        }
                    },
                )
            else:
                tout = min(tout, dur)
            auds.append(
                {
                    "f": f,
                    "in": tin,
                    "out": tout,
                    "start": start,
                    "db": gain,
                    "fi": fade_in / 1000.0,
                    "fo": fade_out / 1000.0,
                }
            )
        if not auds:
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "no audible clips"}},
            )
        total = max(a["start"] + (a["out"] - a["in"]) for a in auds)
        if total > 3600:
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": "混音总时长超过 1 小时上限",
                    }
                },
            )

        args = [ffmpeg, "-y", "-nostdin"]
        for a in auds:
            args += ["-i", str(a["f"])]
        parts = []
        for j, a in enumerate(auds):
            dur = a["out"] - a["in"]
            fades = ""
            if a["fi"] > 0:
                fades += f",afade=t=in:st=0:d={min(a['fi'], dur):.3f}"
            if a["fo"] > 0:
                fo_st = max(0.0, dur - a["fo"])
                fades += f",afade=t=out:st={fo_st:.3f}:d={min(a['fo'], dur):.3f}"
            delay_ms = int(round(a["start"] * 1000))
            parts.append(
                f"[{j}:a]atrim=start={a['in']:.3f}:end={a['out']:.3f},asetpts=PTS-STARTPTS,"
                f"volume={a['db']:.3f}dB{fades},aresample=44100,adelay={delay_ms}:all=1[a{j}]"
            )
        parts.append(
            "".join(f"[a{j}]" for j in range(len(auds)))
            + f"amix=inputs={len(auds)}:duration=longest:normalize=0[aout]"
        )
        args += ["-filter_complex", ";".join(parts), "-map", "[aout]"]
        args += ["-t", f"{total:.3f}"]
        args += ["-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100"]

        if not _RENDER_LOCK.acquire(blocking=False):
            return _json(
                503,
                {
                    "error": {
                        "category": "render_busy",
                        "detail": "已有渲染/混音在进行中，请稍后再试",
                    }
                },
            )
        work = None
        try:
            work = Path(tempfile.mkdtemp(prefix="motv-mix-", dir=str(d)))
            out_tmp = work / "out.mp3"
            try:
                proc = subprocess.run(  # noqa: S603 - fixed argv, validated paths
                    args + [str(out_tmp)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    timeout=300,
                )
            except subprocess.TimeoutExpired:
                return _json(
                    504,
                    {
                        "error": {
                            "category": "mix_timeout",
                            "detail": "ffmpeg timed out",
                        }
                    },
                )
            if proc.returncode != 0 or not out_tmp.is_file():
                detail = (proc.stderr or b"")[-400:].decode("utf-8", "replace")
                return _json(
                    502,
                    {
                        "error": {
                            "category": "mix_failed",
                            "detail": f"ffmpeg failed: {detail}",
                        }
                    },
                )
            # atomic versioned claim — two concurrent mixes can never share N
            n = 1
            while True:
                target = d / f"{slug}_v{n}.mp3"
                try:
                    os.close(os.open(str(target), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                    break
                except FileExistsError:
                    n += 1
            try:
                os.replace(out_tmp, target)
            except OSError:
                try:
                    os.unlink(target)  # release the claimed slot on failure
                except OSError:
                    pass
                raise
            h = hashlib.sha256()
            with open(target, "rb") as fh:
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    h.update(chunk)
            sha = h.hexdigest()
        except OSError:
            return _json(
                502, {"error": {"category": "mix_failed", "detail": "mix failed"}}
            )
        finally:
            if work is not None:
                _shutil.rmtree(work, ignore_errors=True)
            _RENDER_LOCK.release()
        return _json(
            200,
            {
                "ok": True,
                "url": f"/api/uploads/{project}/{slug}_v{n}.mp3",
                "version": n,
                "sha256": sha,
                "clips": len(auds),
            },
        )

    # -- 白膜视频：关键帧 + 运镜 → 本地免费预览 (TASK-098) --------------------
    #
    # 成本阶梯里缺的那一格：Storyboard 便宜、Keyframe 贵、整镜生成最贵，而
    # 「运镜对不对」在此之前**只有花钱生成整镜才看得到**。真实项目 60 个镜头的
    # `cameraMotion` 填充率是 0/60 —— 本卡的假设是「填了也看不见效果」。
    #
    # 本端点**全程零花费**：一张既有的关键帧 + 本地 ffmpeg 的仿射变换。
    # 没有 provider、没有网络、没有 API key。
    #
    # 语义归属划得很清：**那句运镜怎么读，是前端 `workflow/motionpreview.js`
    # 一个人的事**（生产与测试共用同一份谓词，§2.5d）。本端点只收一份**数值规格**
    # 并且**再验一次同样的不变量** —— 因为它是真正要写文件的那一层
    # （§2.5b-2：fail-closed 必须落在对方真正读的那条路上）。
    _MOTION_TIMEOUT_SECONDS = 180
    # **时长上限是一条，帧数上限只是它的一个副产品。**
    #
    # 第一版把两者写成互不相关的两道：`fps ∈ [12,30]` 与 `frames ∈ [2,1800]`。
    # 两道各自合法的请求组合起来是 1800/12 = **150 秒** —— 越过了 60 秒这条合同，
    # 而且会长时间占住全局那把渲染锁（codex 轮 2 的 P1）。
    #
    # 所以真正要守的不变量是 `frames / fps <= 60`，帧数那道只留作一个粗的理智边界。
    # 与前端 `motionpreview.MAX_PREVIEW_SECONDS` 是同一个数：白膜是一次目视确认，
    # 不是成片。
    _MOTION_MAX_SECONDS = 60
    _MOTION_MAX_FRAMES = 1800  # 60s @ 30fps —— 上限仍由 _MOTION_MAX_SECONDS 兜住
    _MOTION_OUT_LONG_EDGE = 1280

    @staticmethod
    def _motion_even(n):
        """偶数边长（H.264 要 4:2:0，奇数边会被 ffmpeg 拒或悄悄改）。"""
        return max(16, int(n) // 2 * 2)

    @classmethod
    def _motion_prescale(cls, out_w, out_h, z_max, cap=4096):
        """预放到多大。**两条边乘同一个系数** —— 这是一条几何不变量，所以它有名字、
        可导出、生产与测试共用同一份（§2.5d）。

        第一版把两条边各自 `min(cap, …)`：zoom 上限 4.0、长边输出 1280，于是
        `1280×4 = 5120` 被夹到 4096 而短边没被夹 —— 预览被**横向压扁**，而它看起来
        仍然是一次成功的渲染（codex 轮 3 的 P1）。

        提成方法而不是留在函数体里，是因为**压扁看不出来**：输出尺寸
        （`width`/`height`）在两种写法下都是对的，被改变的是画面内容的比例。
        一条只能靠像素才能发现的缺陷，必须让判定本身可测。
        """
        scale = min(float(z_max), float(cap) / max(out_w, out_h))
        return cls._motion_even(out_w * scale), cls._motion_even(out_h * scale)

    @staticmethod
    def _motion_contained(zoom_from, zoom_to, cx0, cx1, cy0, cy1, amp):
        """裁切窗口在**任何一帧**都必须整个落在画面里。

        这是 `motionpreview.specContained` 的同一条，写在这一层是因为**这一层才是
        真的调 ffmpeg 的那一层**。越界的后果不是报错：ffmpeg 会把 x/y 静默夹在边界
        上，于是运动走到一半自己停下，而输出仍然是一个「成功」的 mp4 —— 一段会
        说谎的画面比一次失败坏得多。
        """
        z_min = min(zoom_from, zoom_to)
        if not z_min >= 1.0:
            return False
        half = 0.5 / z_min
        worst_x = max(abs(cx0 - 0.5), abs(cx1 - 0.5)) + amp
        worst_y = max(abs(cy0 - 0.5), abs(cy1 - 0.5)) + amp
        return worst_x + half <= 0.5 + 1e-9 and worst_y + half <= 0.5 + 1e-9

    def _agent_motion_preview(self, body: bytes):
        """白膜视频（TASK-098 §2 B1）：一张 Keyframe + 一份运动规格 → 一段与该镜
        `时长` 等长的**静音** MP4，本地、免费、确定性。

        输出 ``motion-<slot>_v<N>.mp4`` —— 版本化原子占位，永不覆盖（第 13 条）。
        它是**预览，不是产物**：登记为 `motionpreview`，走自己的链
        （`motion-<slot>`），因此不进 `mediaOf` 那条「这一镜有没有视频」的判定，
        也不接 `first_frame_image` 那条付费路（TASK-098 §5.4）。

        fail-closed 的每一处都说得出原因：缺 ffmpeg → 503；图不在 / 规格越界 →
        400；ffmpeg 失败或**输出时长与请求不符** → 502。**任何一条都不产出文件**。
        """
        if len(body) > 20_000:
            return _json(
                413, {"error": {"category": "too_large", "detail": "request too large"}}
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "body must be object"}},
            )
        project = payload.get("project")
        slug = payload.get("slug")
        image = payload.get("image")
        spec = payload.get("spec")
        if not isinstance(project, str):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        d = self._upload_dir(project)
        if d is None:
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        if not isinstance(slug, str) or not _NAME_RE.fullmatch(slug):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid slug"}}
            )
        # …并且必须留在自己的命名空间里（与 `_agent_mix_shot` 同一条纪律）。
        # `motion-` 是保留前缀（`_RESERVED_SLUG_PREFIXES`），所以人工上传抢不到
        # 这些文件名；反方向同样要挡住 —— 一个白膜预览不许写进 `voice-…` 或
        # `final-cut…`，否则它会顶掉别人那条链上的一个版本号。
        if not slug.startswith("motion-"):
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": "白膜预览的名字必须以 motion- 开头（保留命名空间）",
                    }
                },
            )
        if not isinstance(spec, dict):
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "spec must be object"}},
            )

        def _num(container, key, lo, hi, label=None):
            """一个**必填**的有限数字，且必须在范围内。

            越界一律拒绝，**不静默夹回范围内** —— 夹回去等于渲出一段与请求不同的
            运动，然后报告成功。范围比较放在 `isfinite` 之前：JSON 里一个大到装不进
            float 的整数会让 `isfinite` 抛 OverflowError（`_agent_mix_shot` 已经
            为这一条付过一次代价）。
            """
            v = container.get(key)
            if (
                isinstance(v, (int, float))
                and not isinstance(v, bool)
                and lo <= v <= hi
                and math.isfinite(v)
            ):
                return float(v), None
            return None, f"{label or f'spec.{key}'} 不是 [{lo}, {hi}] 里的数字"

        def _int(container, key, lo, hi):
            v = container.get(key)
            if isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi:
                return v, None
            return None, f"spec.{key} 不是 [{lo}, {hi}] 里的整数"

        fps, e = _int(spec, "fps", 12, 30)
        if e is None:
            frames, e = _int(spec, "frames", 2, self._MOTION_MAX_FRAMES)
        zoom = spec.get("zoom") if isinstance(spec.get("zoom"), dict) else {}
        center = spec.get("center") if isinstance(spec.get("center"), dict) else {}
        if e is None:
            z_from, e = _num(zoom, "from", 1.0, 4.0, "spec.zoom.from")
        if e is None:
            z_to, e = _num(zoom, "to", 1.0, 4.0, "spec.zoom.to")
        if e is None:
            cx0, e = _num(center, "fromX", 0.0, 1.0, "spec.center.fromX")
        if e is None:
            cx1, e = _num(center, "toX", 0.0, 1.0, "spec.center.toX")
        if e is None:
            cy0, e = _num(center, "fromY", 0.0, 1.0, "spec.center.fromY")
        if e is None:
            cy1, e = _num(center, "toY", 0.0, 1.0, "spec.center.toY")
        shake = spec.get("shake")
        amp = 0.0
        if e is None and shake is not None:
            if not isinstance(shake, dict):
                e = "spec.shake 要么缺省，要么是一个对象"
            else:
                amp, e = _num(shake, "amp", 0.0, 0.05, "spec.shake.amp")
        still = spec.get("still")
        if e is None and not isinstance(still, bool):
            e = "spec.still 必须显式说明这段预览是不是「画面不动」"
        if e:
            return _json(400, {"error": {"category": "bad_request", "detail": e}})

        # 时长那条不变量（不是 fps 与 frames 各自那两道 —— 见 _MOTION_MAX_SECONDS）
        if frames / float(fps) > self._MOTION_MAX_SECONDS + 0.05:
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": (
                            f"预览长 {frames / float(fps):.1f}s，超过上限 "
                            f"{self._MOTION_MAX_SECONDS}s —— 白膜是一次目视确认，"
                            "不是成片（它还会占住本机那把渲染锁）"
                        ),
                    }
                },
            )

        # **「不动」必须是一次声明，不能是一个巧合**（TASK-098 §7.2 的服务端那一半）。
        #
        # 「认不出的运镜不静默输出一个不动的视频」这条闸门在前端解析器上钉了一次；
        # 只钉在那里的话，任何别的调用方（今天的批量、明天的 Skill）都能绕过它 ——
        # 而它绕过的方式恰恰是最像成功的那一种：一段能播、时长正确、什么都不发生
        # 的 mp4。所以**两个方向都在这里再钉一次**：
        #
        #   声明了不动，规格却在动  → 拒（前端与后端对同一段预览的理解已经分叉）
        #   没声明不动，规格也不动  → 拒（这正是那段会说谎的视频）
        #
        # 明写「固定机位」时输出一个不动的视频**是对的**，所以放行那一半必须存在
        # ——只挡不放的闸门迟早会被关掉（§2.5d）。
        moving = (
            abs(z_from - z_to) > 1e-6
            or abs(cx0 - cx1) > 1e-6
            or abs(cy0 - cy1) > 1e-6
            or amp > 0
        )
        if still and moving:
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": "规格声明「画面不动」，但它带着运动 —— 不予渲染",
                    }
                },
            )
        if not still and not moving:
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": (
                            "这份规格没有任何运动，也没有声明「固定机位」——"
                            "白膜不会静默输出一段不动的视频冒充预览"
                        ),
                    }
                },
            )
        if not self._motion_contained(z_from, z_to, cx0, cx1, cy0, cy1, amp):
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": (
                            "这份规格的平移幅度超出了画幅余量 —— 渲出来运动会在中途"
                            "被夹住停下，而视频看起来仍然是成功的，所以不予渲染"
                        ),
                    }
                },
            )

        # 请求本身的问题**不排在一次媒体读取后面**（与 `_agent_render_episode`
        # 同一条纪律）：规格越界只取决于请求，先答完它，再去碰磁盘。
        src = self._resolve_upload_file(d, image, (".png", ".jpg", ".webp"))
        if src is None:
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": (
                            "找不到这一镜的关键帧图片"
                            "（或它不是本项目 media/ 下的普通文件）"
                        ),
                    }
                },
            )

        import shutil as _shutil

        # ADR-0049 第 3 条：按名解析，**绝不裸名调用**（`shell=False` 下裸名解析不到
        # `.cmd`/`.bat`），缺失即 fail-closed 并给安装提示。
        ffmpeg = _shutil.which("ffmpeg")
        ffprobe = _shutil.which("ffprobe")
        if ffmpeg is None or ffprobe is None:
            return _json(
                503,
                {
                    "error": {
                        "category": "motion_preview_unavailable",
                        "detail": (
                            "ffmpeg/ffprobe 缺失：请安装并加入 PATH"
                            "（白膜预览是本地渲染）"
                        ),
                    }
                },
            )

        # 关键帧的真实像素尺寸。**测不到就不渲** —— 猜一个 16:9 会让竖屏短剧的预览
        # 被拉变形，而那时创作者看到的构图不是他那张图的构图。
        if not _PROBE_SEM.acquire(timeout=_PROBE_WAIT_SECONDS):
            return _json(
                503,
                {
                    "error": {
                        "category": "busy",
                        "detail": "本机探测队列已满，请稍后再试",
                    }
                },
            )
        try:
            pr = subprocess.run(  # noqa: S603 - fixed argv, validated path
                [
                    ffprobe,
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-show_entries",
                    "stream=width,height",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(src),
                ],
                capture_output=True,
                timeout=30,
            )
        except (subprocess.TimeoutExpired, OSError):
            pr = None
        finally:
            _PROBE_SEM.release()
        dims = []
        if pr is not None and pr.returncode == 0:
            for line in (pr.stdout or b"").decode("utf-8", "replace").split():
                try:
                    dims.append(int(line))
                except ValueError:
                    dims = []
                    break
        if len(dims) != 2 or dims[0] < 16 or dims[1] < 16:
            return _json(
                502,
                {
                    "error": {
                        "category": "probe_failed",
                        "detail": "读不出关键帧的像素尺寸 —— 不猜一个比例，本次不渲染",
                    }
                },
            )
        src_w, src_h = dims

        _even = self._motion_even
        long_edge = self._MOTION_OUT_LONG_EDGE
        if src_w >= src_h:
            out_w, out_h = _even(long_edge), _even(long_edge * src_h / src_w)
        else:
            out_w, out_h = _even(long_edge * src_w / src_h), _even(long_edge)
        # zoompan 的裁切窗口是 `iw/zoom` —— 想让最紧的那一帧还是 1:1，输入就得预放到
        # 输出尺寸的 zoom 倍。4096 是为了不让一份合法请求造出一张巨图。
        #
        # **两条边必须乘同一个系数。** 第一版把两条边各自 `min(4096, …)`：
        # zoom 上限是 4.0，而长边输出 1280，于是 `1280×4 = 5120` 被夹到 4096、短边
        # 却没被夹 —— 预览被**横向压扁**，而它看起来仍然是一次成功的渲染
        # （codex 轮 3 的 P1）。一张几何上说谎的画面正是本卡最不能出的东西。
        #
        # 所以夹的是**系数**，不是边长：超过 4096 时最紧的那一帧会被略微放大
        # （清晰度的代价），但构图与比例仍然是真的 —— 那是正确的取舍方向。
        z_max = max(z_from, z_to)
        pre_w, pre_h = self._motion_prescale(out_w, out_h, z_max)

        last = max(1, frames - 1)
        prog = f"(on/{last})"
        z_expr = f"{z_from:.6f}+({z_to - z_from:.6f})*{prog}"
        cx_expr = f"{cx0:.6f}+({cx1 - cx0:.6f})*{prog}"
        cy_expr = f"{cy0:.6f}+({cy1 - cy0:.6f})*{prog}"
        if amp > 0:
            # 确定性抖动：两个不成整数比的正弦叠加，看起来不周期，而**同一份规格
            # 永远抖出同一段画面**。用 `random()` 会让「改一个字看效果变没变」这件
            # 事失去参照 —— 预览必须可复现。
            t = f"(on/{fps})"
            cx_expr += (
                f"+{amp:.6f}*(sin(6.283185*2.7*{t})+0.6*sin(6.283185*5.3*{t}))/1.6"
            )
            cy_expr += (
                f"+{amp:.6f}*(sin(6.283185*3.1*{t}+1.1)+0.6*sin(6.283185*4.7*{t}))/1.6"
            )
        vf = (
            f"scale={pre_w}:{pre_h}:flags=lanczos,"
            f"zoompan=z='{z_expr}'"
            f":x='iw*({cx_expr})-(iw/zoom)*0.5'"
            f":y='ih*({cy_expr})-(ih/zoom)*0.5'"
            f":d=1:s={out_w}x{out_h}:fps={fps},format=yuv420p"
        )

        if not _RENDER_LOCK.acquire(blocking=False):
            return _json(
                503,
                {
                    "error": {
                        "category": "busy",
                        "detail": "本机已有一个 ffmpeg 作业在跑，请等它结束",
                    }
                },
            )
        work = None
        try:
            # `dir=str(d)` 不是整洁，是**正确性**：ADR-0049 决策 2 要求原子替换的
            # 临时文件始终待在目标目录（同卷）。第一版用了系统临时目录，于是仓库在
            # D: 而 TEMP 在 C: 的这台机器上 `os.replace` 直接 `OSError` ——
            # 三个真实镜头全部 502。其余四处 ffmpeg 端点本来都传了 `dir=`；
            # 只有这一处漏了，而**只有在真实项目上跑才会暴露**（tmp_path 与被写入
            # 的目录在测试里同卷）。
            work = Path(tempfile.mkdtemp(prefix="motionpreview-", dir=str(d)))
            out_tmp = work / "preview.mp4"
            try:
                proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
                    [
                        ffmpeg,
                        "-nostdin",
                        "-v",
                        "error",
                        "-y",
                        "-loop",
                        "1",
                        "-i",
                        str(src),
                        "-frames:v",
                        str(frames),
                        "-vf",
                        vf,
                        "-c:v",
                        "libx264",
                        "-preset",
                        "veryfast",
                        "-crf",
                        "22",
                        "-pix_fmt",
                        "yuv420p",
                        # 白膜是静音的（§6：配音对齐仍归 TASK-096）
                        "-an",
                        "-movflags",
                        "+faststart",
                        str(out_tmp),
                    ],
                    capture_output=True,
                    timeout=self._MOTION_TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired:
                return _json(
                    504,
                    {
                        "error": {
                            "category": "motion_preview_failed",
                            "detail": "ffmpeg 超时 —— 本次没有产出文件",
                        }
                    },
                )
            except OSError as exc:
                return _json(
                    502,
                    {
                        "error": {
                            "category": "motion_preview_failed",
                            "detail": f"ffmpeg 起不来：{exc}",
                        }
                    },
                )
            # 「退出码 0」不等于产出了一段能看的视频：零字节文件同样会带着 0 回来。
            if (
                proc.returncode != 0
                or not out_tmp.is_file()
                or out_tmp.stat().st_size == 0
            ):
                detail = (proc.stderr or b"")[-400:].decode("utf-8", "replace")
                return _json(
                    502,
                    {
                        "error": {
                            "category": "motion_preview_failed",
                            "detail": f"ffmpeg 没有产出可用的预览：{detail}".strip(),
                        }
                    },
                )
            # **时长要核对**（§7 / §9：预览时长 == 该镜时长）。帧数是我们给的，
            # 但「给了 N 帧就一定得到 N 帧」是一个断言，不是一个事实 —— 核对一次，
            # 不对就不交付。
            want = frames / float(fps)
            try:
                vr = subprocess.run(  # noqa: S603 - fixed argv, validated path
                    [
                        ffprobe,
                        "-v",
                        "error",
                        "-show_entries",
                        "format=duration",
                        "-of",
                        "default=noprint_wrappers=1:nokey=1",
                        str(out_tmp),
                    ],
                    capture_output=True,
                    timeout=30,
                )
            except (subprocess.TimeoutExpired, OSError):
                vr = None
            got = None
            if vr is not None and vr.returncode == 0:
                try:
                    got = float((vr.stdout or b"").decode("utf-8", "replace").strip())
                except ValueError:
                    got = None
            if got is None or not math.isfinite(got) or abs(got - want) > 0.15:
                got_text = "读不出" if got is None else format(got, ".2f")
                return _json(
                    502,
                    {
                        "error": {
                            "category": "motion_preview_failed",
                            "detail": (
                                f"预览时长核对不过（要 {want:.2f}s，"
                                f"得到 {got_text}）"
                                "—— 不交付一个时长不对的预览"
                            ),
                        }
                    },
                )
            # 版本化原子占位：两个并发的预览永远不会共用同一个 N（第 13 条）
            n = 1
            while True:
                target = d / f"{slug}_v{n}.mp4"
                try:
                    os.close(os.open(str(target), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                    break
                except FileExistsError:
                    n += 1
            # 占住版本号之后的**每一条失败路径都要把它让出来**。
            #
            # 两层教训叠在这里（codex 轮 3 的 non-blocking + 修它时暴露的第二个洞）：
            #   一、先发布再算哈希 → 哈希失败时留下一个**没人登记**的 mp4；
            #   二、占位是一个**空文件** → 只把顺序换过来，哈希失败会留下一个
            #       **零字节**的 `_v1.mp4`，而它照样占着版本号让重试跳号。
            # 所以 `unlink` 要覆盖占位之后的全部失败，不只是 `os.replace` 那一步。
            try:
                h = hashlib.sha256()
                with open(out_tmp, "rb") as fh:
                    for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                        h.update(chunk)
                sha = h.hexdigest()
                # 被发布的永远是**已经算过哈希的那一个字节流**
                os.replace(out_tmp, target)
            except OSError:
                try:
                    os.unlink(target)  # 让出占住的版本号，别留一个零字节文件
                except OSError:
                    pass
                raise
        except OSError as exc:
            # **原因照带**。第一版把它咽掉了，于是那个跨卷 `os.replace` 只报出
            # 「写入失败」，排查全靠猜 —— 一条说不出原因的失败和一条假成功一样贵。
            return _json(
                502,
                {
                    "error": {
                        "category": "motion_preview_failed",
                        "detail": f"白膜预览写入失败：{exc}",
                    }
                },
            )
        finally:
            if work is not None:
                _shutil.rmtree(work, ignore_errors=True)
            _RENDER_LOCK.release()
        return _json(
            200,
            {
                "ok": True,
                "url": f"/api/uploads/{project}/{slug}_v{n}.mp4",
                "version": n,
                "sha256": sha,
                "duration": round(want, 3),
                "frames": frames,
                "fps": fps,
                "width": out_w,
                "height": out_h,
                "source": src.name,
            },
        )

    def _agent_render_episode(self, body: bytes):
        """Lightweight episode render (M11): timeline clips → ONE MP4/WebM
        with LOCAL ffmpeg. Video track = sequential trimmed clips (scaled/
        padded/fps-normalized, source audio deliberately dropped — dialogue/
        ambience/sfx/bgm come from their own clips); audio clips are trimmed,
        volume/fade-shaped, delayed to their startTime and mixed. Output
        ``render-ep-v<N>.<ext>`` — versioned atomically, never overwrites.
        Fail-closed at every step; never a fabricated success."""
        if len(body) > 1_000_000:
            return _json(
                413, {"error": {"category": "too_large", "detail": "request too large"}}
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "body must be object"}},
            )
        project = payload.get("project")
        clips = payload.get("clips")
        settings = (
            payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
        )
        if not isinstance(project, str):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        d = self._upload_dir(project)
        if d is None:
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        if not isinstance(clips, list) or not (1 <= len(clips) <= 120):
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": "1-120 clips required",
                    }
                },
            )

        # a PRESENT setting must be in range — REJECT out-of-range rather than
        # silently substitute a default, so the rendered output never disagrees
        # with the settings the caller (and the persisted timeline) recorded;
        # an ABSENT setting takes the default (M11 review).
        def _int(key, lo, hi, default):
            v = settings.get(key)
            if v is None:
                return default, None
            if isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi:
                return v, None
            return None, f"invalid {key}"

        width, e1 = _int("width", 16, 3840, 1280)
        height, e2 = _int("height", 16, 2160, 720)
        fps, e3 = _int("fps", 1, 60, 25)
        fmt_raw = settings.get("format")
        e4 = None if fmt_raw in (None, "mp4", "webm") else "invalid format"
        fmt = "webm" if fmt_raw == "webm" else "mp4"
        bad_setting = e1 or e2 or e3 or e4
        if bad_setting:
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": bad_setting}},
            )

        import shutil as _shutil

        ffmpeg = _shutil.which("ffmpeg")
        if ffmpeg is None:
            return _json(
                503,
                {
                    "error": {
                        "category": "render_unavailable",
                        "detail": "ffmpeg 缺失：请安装",
                    }
                },
            )

        # resolve + validate EVERY clip before any work (fail-closed)
        vids = []
        auds = []
        for i, c in enumerate(clips, start=1):
            if not isinstance(c, dict):
                return _json(
                    400,
                    {"error": {"category": "bad_request", "detail": f"clip {i} bad"}},
                )
            track = c.get("track")

            # a PRESENT numeric field must be valid + in range — REJECT rather
            # than silently substitute a default, so the rendered timeline (and
            # the recorded provenance snapshot) can never disagree with what the
            # caller supplied; an ABSENT field takes its default (M11 review).
            def _num(key, lo, hi, default, c=c, i=i):
                v = c.get(key)
                if v is None:
                    return default, None
                if (
                    isinstance(v, (int, float))
                    and not isinstance(v, bool)
                    # RANGE FIRST (TASK-074 §1.1b c). ``math.isfinite`` converts its
                    # argument to a float, and a JSON integer too large for a float
                    # raises OverflowError there — so a legitimately-sized request
                    # body carrying 10**400 CRASHED the handler instead of getting a
                    # 400. Comparing an arbitrarily large int against a float is
                    # safe, and it already rejects NaN and ±inf (all of whose
                    # comparisons are False). ``isfinite`` is kept after it as an
                    # explicit statement of intent, now that it can no longer throw.
                    and lo <= v <= hi
                    and math.isfinite(v)
                ):
                    return float(v), None
                return None, f"clip {i}: bad {key}"

            tin, e = _num("in", 0.0, 36000.0, 0.0)
            if e:
                return _json(400, {"error": {"category": "bad_request", "detail": e}})
            tout, e = _num("out", 0.0, 36000.0, tin + 1.0)
            if e:
                return _json(400, {"error": {"category": "bad_request", "detail": e}})
            if not (tin < tout):
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": f"clip {i}: bad trim",
                        }
                    },
                )
            start, e = _num("start", 0.0, 36000.0, 0.0)
            if e:
                return _json(400, {"error": {"category": "bad_request", "detail": e}})
            vol, e = _num("volume", 0.0, 2.0, 1.0)
            if e:
                return _json(400, {"error": {"category": "bad_request", "detail": e}})
            fade_in, e = _num("fadeIn", 0.0, 30.0, 0.0)
            if e:
                return _json(400, {"error": {"category": "bad_request", "detail": e}})
            fade_out, e = _num("fadeOut", 0.0, 30.0, 0.0)
            if e:
                return _json(400, {"error": {"category": "bad_request", "detail": e}})
            if track == "video":
                f = self._resolve_upload_file(d, c.get("file"), (".mp4", ".webm"))
                if f is None:
                    return _json(
                        400,
                        {
                            "error": {
                                "category": "bad_request",
                                "detail": f"clip {i}: video file missing",
                            }
                        },
                    )
                vids.append({"f": f, "in": tin, "out": tout})
            # TASK-064 Phase 3: `foley` and `vo` are their own tracks all the way
            # through (workflow/timeline.js TRACKS). Mapping them onto sfx /
            # dialogue here would make the render's own record disagree with the
            # timeline that produced it.
            elif track in ("dialogue", "vo", "ambience", "sfx", "foley", "bgm"):
                if c.get("muted") is True or vol <= 0:
                    continue  # a muted clip contributes nothing — skipped
                f = self._resolve_upload_file(d, c.get("file"), (".mp3", ".wav"))
                if f is None:
                    return _json(
                        400,
                        {
                            "error": {
                                "category": "bad_request",
                                "detail": f"clip {i}: audio file missing",
                            }
                        },
                    )
                auds.append(
                    {
                        "f": f,
                        "in": tin,
                        "out": tout,
                        "start": start,
                        "vol": vol,
                        "fi": fade_in,
                        "fo": fade_out,
                    }
                )
            else:
                return _json(
                    400,
                    {
                        "error": {
                            "category": "bad_request",
                            "detail": f"clip {i}: bad track",
                        }
                    },
                )
        if not vids:
            return _json(
                400, {"error": {"category": "bad_request", "detail": "no video clips"}}
            )
        # bound the TOTAL synthesized picture length: per-clip trims may reach
        # 36000s each, but tpad materializes every segment's full planned
        # duration, so 120 clips could demand hours of frames -> CPU/disk DoS.
        # An episode render is minutes; cap the sum at a generous 1 hour.
        video_total = sum(v["out"] - v["in"] for v in vids)
        if video_total > 3600:
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": "总时长超过 1 小时上限（本集渲染）",
                    }
                },
            )
        # bound the total OUTPUT work (pixels × fps × seconds), so a 1h render at
        # 4K60 — huge CPU/disk even under the duration cap — is refused
        if width * height * fps * video_total > _RENDER_PIXEL_SECONDS_MAX:
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": "渲染规模超限：请降低分辨率/帧率或缩短时长",
                    }
                },
            )

        # one ffmpeg pass: inputs in order (videos then audios)
        args = [ffmpeg, "-y", "-nostdin"]
        for v in vids:
            args += ["-i", str(v["f"])]
        for a in auds:
            args += ["-i", str(a["f"])]
        parts = []
        for idx, v in enumerate(vids):
            # FORCE each segment to EXACTLY its planned (out-in) length: clone
            # the last frame to fill a too-short source, then trim to length.
            # Without this, a video shorter than its trim window lets concat
            # start the next clip early while the audio track keeps its planned
            # delays -> A/V desync after short clips (M11 review). tpad must run
            # AFTER fps: a preceding trim breaks clone-frame propagation.
            seg = v["out"] - v["in"]
            parts.append(
                f"[{idx}:v]trim=start={v['in']:.3f}:end={v['out']:.3f},setpts=PTS-STARTPTS,"
                f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,fps={fps},setsar=1,"
                f"tpad=stop_mode=clone:stop_duration={seg:.3f},"
                f"trim=start=0:end={seg:.3f},setpts=PTS-STARTPTS[v{idx}]"
            )
        parts.append(
            "".join(f"[v{i}]" for i in range(len(vids)))
            + f"concat=n={len(vids)}:v=1:a=0[vout]"
        )
        maps = ["-map", "[vout]"]
        if auds:
            for j, a in enumerate(auds):
                k = len(vids) + j
                dur = a["out"] - a["in"]
                fades = ""
                if a["fi"] > 0:
                    fades += f",afade=t=in:st=0:d={min(a['fi'], dur):.3f}"
                if a["fo"] > 0:
                    fo_st = max(0.0, dur - a["fo"])
                    fades += f",afade=t=out:st={fo_st:.3f}:d={min(a['fo'], dur):.3f}"
                delay_ms = int(round(a["start"] * 1000))
                parts.append(
                    f"[{k}:a]atrim=start={a['in']:.3f}:end={a['out']:.3f},asetpts=PTS-STARTPTS,"
                    f"volume={a['vol']:.3f}{fades},aresample=44100,adelay={delay_ms}:all=1[a{j}]"
                )
            parts.append(
                "".join(f"[a{j}]" for j in range(len(auds)))
                + f"amix=inputs={len(auds)}:duration=longest:normalize=0[aout]"
            )
            maps += ["-map", "[aout]"]
        args += ["-filter_complex", ";".join(parts)] + maps
        # the PICTURE defines the episode length: cap the whole render to the
        # summed video duration (bounded to 1h above) so a far-delayed audio
        # clip (adelay up to 36000s) can never stretch the output past the
        # video / exhaust CPU/disk via amix=duration=longest (M11 review).
        args += ["-t", f"{video_total:.3f}"]
        if fmt == "webm":
            args += ["-c:v", "libvpx-vp9", "-b:v", "2M"]
            if auds:
                args += ["-c:a", "libopus"]
        else:
            args += ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"]
            if auds:
                args += ["-c:a", "aac", "-ar", "44100"]

        # one render at a time: a concurrent caller is turned away rather than
        # allowed to pile CPU/disk load on top of a render in flight
        if not _RENDER_LOCK.acquire(blocking=False):
            return _json(
                503,
                {
                    "error": {
                        "category": "render_busy",
                        "detail": "已有渲染在进行中，请稍后再试",
                    }
                },
            )
        work = None
        try:
            work = Path(tempfile.mkdtemp(prefix="motv-render-", dir=str(d)))
            out_tmp = work / f"out.{fmt}"
            try:
                proc = subprocess.run(  # noqa: S603 - fixed argv, validated paths
                    args + [str(out_tmp)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    timeout=600,
                )
            except subprocess.TimeoutExpired:
                return _json(
                    504,
                    {
                        "error": {
                            "category": "render_timeout",
                            "detail": "ffmpeg timed out",
                        }
                    },
                )
            if proc.returncode != 0 or not out_tmp.is_file():
                detail = (proc.stderr or b"")[-400:].decode("utf-8", "replace")
                return _json(
                    502,
                    {
                        "error": {
                            "category": "render_failed",
                            "detail": f"ffmpeg failed: {detail}",
                        }
                    },
                )
            # atomic versioned claim — two concurrent renders can never share N
            n = 1
            while True:
                target = d / f"render-ep-v{n}.{fmt}"
                try:
                    os.close(os.open(str(target), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                    break
                except FileExistsError:
                    n += 1
            try:
                os.replace(out_tmp, target)
            except OSError:
                try:
                    os.unlink(target)  # release the claimed slot on failure
                except OSError:
                    pass
                raise
            # hash in bounded chunks — a large permitted render must never be
            # slurped whole into memory (M11 review)
            h = hashlib.sha256()
            with open(target, "rb") as fh:
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    h.update(chunk)
            sha = h.hexdigest()
        except OSError:
            return _json(
                502, {"error": {"category": "render_failed", "detail": "render failed"}}
            )
        finally:
            if work is not None:
                _shutil.rmtree(work, ignore_errors=True)
            _RENDER_LOCK.release()
        return _json(
            200,
            {
                "ok": True,
                "url": f"/api/uploads/{project}/render-ep-v{n}.{fmt}",
                "version": n,
                "sha256": sha,
                "clips": len(vids) + len(auds),
            },
        )

    def _assets_delete_file(self, body: bytes):
        """Delete ONE uploaded media file's bytes (M11 storage management —
        Remove Local Copy / the byte half of a permanent delete). The CLIENT
        owns the registry semantics (storageState, record removal, reference
        checks); this endpoint only removes bytes, with the same containment
        discipline as every other file route. Composed/rendered deliverables
        (reserved prefixes) may also be removed — they are project scratch."""
        if len(body) > 10_000:
            return _json(
                413, {"error": {"category": "too_large", "detail": "request too large"}}
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        project = payload.get("project") if isinstance(payload, dict) else None
        name = payload.get("file") if isinstance(payload, dict) else None
        if not isinstance(project, str):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        d = self._upload_dir(project)
        if d is None:
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        p = self._resolve_upload_file(
            d, name, (".png", ".jpg", ".webp", ".mp4", ".webm", ".mp3", ".wav")
        )
        if p is None:
            # already gone counts as done — the goal state (no bytes) holds
            if (
                isinstance(name, str)
                and _UPLOAD_FILE_RE.fullmatch(name)
                and not (d / name).exists()
            ):
                return _json(200, {"ok": True, "deleted": False})
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid file"}}
            )
        try:
            p.unlink()
        except OSError:
            return _json(
                502,
                {
                    "error": {
                        "category": "delete_failed",
                        "detail": "could not delete file",
                    }
                },
            )
        return _json(200, {"ok": True, "deleted": True})

    # -- paid ops status (read-only projection of reservations/staging) -----
    def _paid_ops(self, name: str):
        """Per-operation paid generation status for the UI (READ-ONLY).

        Projects the budget reservation records plus staging artifact
        presence — enough for "生成情况" per shot without touching core code.
        """
        root = self._projects.get(name)
        if root is None:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unknown project"}}
            )
        ops = []
        resv = (root / "budget" / "reservations").resolve()
        rroot = root.resolve()
        if rroot in resv.parents and resv.is_dir():
            for p in sorted(resv.glob("*/*.json")):
                try:
                    if p.is_symlink():
                        continue
                    rp = p.resolve()
                    if resv not in rp.parents or not rp.is_file():
                        continue
                    rec = json.loads(rp.read_text("utf-8"))
                except (OSError, ValueError):
                    continue
                task_id = rec.get("task_id")
                art = None
                if isinstance(task_id, str) and _NAME_RE.fullmatch(task_id):
                    ap = (root / "staging" / "shots" / f"{task_id}.mp4").resolve()
                    if rroot in ap.parents and ap.is_file() and not ap.is_symlink():
                        art = ap.stat().st_size
                ops.append(
                    {
                        "task_id": task_id,
                        "shot_id": rec.get("shot_id"),
                        "operation_id": rec.get("operation_id"),
                        "status": rec.get("status"),
                        "model_id": rec.get("model_id"),
                        "quote": f"{rec.get('quote_currency', '')} "
                        f"{(rec.get('quote_minor_units') or 0) / 100:.2f}",
                        "created_at": rec.get("created_at"),
                        "resolved_at": rec.get("resolved_at"),
                        "artifact_bytes": art,
                    }
                )
        return _json(200, {"ops": ops})

    # -- adopt a PAID staging clip into a canvas slot (ADR-0046 §3) ---------
    def _agent_adopt_paid(self, body: bytes):
        """Copy a coordinator-produced staging clip into an upload slot.

        READ-ONLY towards core files (a copy, never a move); no spend. Lets the
        canvas/compose use a paid clip without manual bridging. Fail-closed on
        any invalid name, missing artifact, or non-mp4 content.
        """
        if len(body) > 100_000:
            return _json(
                413,
                {"error": {"category": "too_large", "detail": "request too large"}},
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "body must be object"}},
            )
        project = payload.get("project")
        slug = payload.get("slug")
        task_id = payload.get("task_id")
        if (
            not isinstance(project, str)
            or not isinstance(slug, str)
            or not isinstance(task_id, str)
        ):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        root = self._projects.get(project)
        d = self._upload_dir(project)
        if (
            root is None
            or d is None
            or not _NAME_RE.fullmatch(slug)
            or _slug_reserved(slug)
            or _slug_versioned(slug)
            or not _NAME_RE.fullmatch(task_id)
        ):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        src = (root / "staging" / "shots" / f"{task_id}.mp4").resolve()
        rroot = root.resolve()
        if rroot not in src.parents or src.is_symlink() or not src.is_file():
            return _json(
                404,
                {
                    "error": {
                        "category": "not_found",
                        "detail": "paid artifact not found in staging",
                    }
                },
            )
        try:
            data = src.read_bytes()
        except OSError:
            return _json(
                500, {"error": {"category": "read_failed", "detail": "could not read"}}
            )
        if len(data) > _UPLOAD_MAX[".mp4"] or not _media_magic_ok(".mp4", data):
            return _json(
                502,
                {
                    "error": {
                        "category": "bad_artifact",
                        "detail": "staging artifact is not a valid mp4",
                    }
                },
            )
        try:
            d.mkdir(parents=True, exist_ok=True)
            # ADR-0048: adopting into an occupied slot APPENDS a new version
            # (origin=adopted on the canvas side) instead of overwriting the
            # previous take; the anti-double-pay guard stays on the submit side.
            n, target = _claim_version(d, slug, ".mp4")
            fd, tmpname = tempfile.mkstemp(dir=str(d), suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(data)
                os.replace(tmpname, target)
            except OSError:
                for stale in (tmpname, str(target)):
                    try:
                        os.unlink(stale)  # our tmp + our claimed placeholder only
                    except OSError:
                        pass
                raise
        except OSError:
            return _json(
                500, {"error": {"category": "write_failed", "detail": "could not save"}}
            )
        return _json(
            200,
            {
                "ok": True,
                "url": f"/api/uploads/{project}/{target.name}",
                "version": n,
                "sha256": hashlib.sha256(data).hexdigest(),
            },
        )

    # -- paid image generation (ADR-0045, MiniMax image-01) -----------------
    def _agent_image(self, body: bytes):
        """Generate ONE draft asset image via MiniMax image-01 (PAID).

        Narrowly authorized by ADR-0045: same deployment gate as paid video
        (``--enable-paid`` + env flag), same credential, catalog price echoed
        back by the client (``confirm_usd``) so a stale UI can never spend at
        an unexpected price. Output lands in the manual-upload slot; each spend
        appends one line to ``data/paid-image-log.jsonl``. Fail-closed.
        """
        if len(body) > 100_000:
            return _json(
                413,
                {"error": {"category": "too_large", "detail": "request too large"}},
            )
        if (
            not self.paid
            or os.environ.get("AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS") != "1"
        ):
            return _json(
                403,
                {
                    "error": {
                        "category": "forbidden",
                        "detail": "paid image generation not enabled (--enable-paid)",
                    }
                },
            )
        api_key = os.environ.get("WFM1_MINIMAX_API_KEY", "")
        if not api_key:
            return _json(
                503,
                {
                    "error": {
                        "category": "image_unavailable",
                        "detail": "WFM1_MINIMAX_API_KEY missing",
                    }
                },
            )
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid JSON"}}
            )
        if not isinstance(payload, dict):
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "body must be object"}},
            )
        project = payload.get("project")
        slug = payload.get("slug")
        prompt = payload.get("prompt")
        confirm = payload.get("confirm_usd")
        if not isinstance(project, str) or not isinstance(slug, str):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        d = self._upload_dir(project)
        if (
            d is None
            or not _NAME_RE.fullmatch(slug)
            or _slug_reserved(slug)
            or _slug_versioned(slug)
        ):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        if not isinstance(prompt, str) or not prompt.strip():
            return _json(
                400,
                {"error": {"category": "bad_request", "detail": "missing 'prompt'"}},
            )
        if len(prompt) > _IMAGE_PROMPT_MAX:
            return _json(
                400,
                {
                    "error": {
                        "category": "too_large",
                        "detail": "prompt too long (1500)",
                    }
                },
            )
        # price echo — the human confirmation surface must match the catalog
        if (
            not isinstance(confirm, (int, float))
            or isinstance(confirm, bool)
            or abs(float(confirm) - _IMAGE_PRICE_USD) > 1e-9
        ):
            return _json(
                409,
                {
                    "error": {
                        "category": "price_mismatch",
                        "detail": f"confirm_usd must equal {_IMAGE_PRICE_USD}",
                    }
                },
            )
        import base64
        import binascii
        import urllib.error
        import urllib.request

        # base64 response: the image arrives INSIDE the API reply, so this
        # backend never fetches a provider-supplied URL — no SSRF surface.
        req = urllib.request.Request(  # noqa: S310 - fixed https endpoint
            _IMAGE_API,
            data=json.dumps(
                {
                    "model": "image-01",
                    "prompt": prompt,
                    "aspect_ratio": "16:9",
                    "n": 1,
                    "response_format": "base64",
                }
            ).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:  # noqa: S310
                raw = resp.read(16_000_000)  # ~12MB binary as base64
            j = json.loads(raw.decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            return _json(
                502,
                {
                    "error": {
                        "category": "image_failed",
                        "detail": f"provider HTTP {exc.code}",
                    }
                },
            )
        except (urllib.error.URLError, TimeoutError, ValueError):
            return _json(
                502,
                {
                    "error": {
                        "category": "image_failed",
                        "detail": "provider request failed",
                    }
                },
            )
        b64list = (
            (j.get("data") or {}).get("image_base64") if isinstance(j, dict) else None
        )
        if (
            not isinstance(b64list, list)
            or not b64list
            or not isinstance(b64list[0], str)
        ):
            detail = ""
            if isinstance(j, dict) and isinstance(j.get("base_resp"), dict):
                detail = str(j["base_resp"].get("status_msg") or "")[:120]
            return _json(
                502,
                {
                    "error": {
                        "category": "image_bad_output",
                        "detail": detail or "no image_base64 in provider response",
                    }
                },
            )
        try:
            img = base64.b64decode(b64list[0], validate=True)
        except (binascii.Error, ValueError):
            return _json(
                502,
                {
                    "error": {
                        "category": "image_bad_output",
                        "detail": "invalid base64 image payload",
                    }
                },
            )
        if len(img) > _IMAGE_MAX:
            return _json(
                502,
                {
                    "error": {
                        "category": "too_large",
                        "detail": f"image exceeds {_IMAGE_MAX // 1_000_000}MB",
                    }
                },
            )
        ext = next(
            (e for e in (".png", ".jpg", ".webp") if _media_magic_ok(e, img)), None
        )
        if ext is None:
            return _json(
                502,
                {
                    "error": {
                        "category": "image_bad_output",
                        "detail": "downloaded bytes are not an image",
                    }
                },
            )
        try:
            d.mkdir(parents=True, exist_ok=True)
            # ADR-0048: a slot re-generation APPENDS a new version — earlier
            # takes (any format) are preserved for comparison and 回切.
            n, target = _claim_version(d, slug, ext)
            fd, tmpname = tempfile.mkstemp(dir=str(d), suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(img)
                os.replace(tmpname, target)
            except OSError:
                for stale in (tmpname, str(target)):
                    try:
                        os.unlink(stale)  # our tmp + our claimed placeholder only
                    except OSError:
                        pass
                raise
        except OSError:
            return _json(
                500, {"error": {"category": "write_failed", "detail": "could not save"}}
            )
        # Local spend transparency (prototype-level, not the core ledger).
        # SEPARATE from the image write: the spend already happened and the
        # image is saved — a log failure must NOT 500 (a retry would double
        # the charge); it degrades to a warning in the response instead.
        log_warning = None
        try:
            with _IMAGE_LOG.open("a", encoding="utf-8") as fh:
                fh.write(
                    json.dumps(
                        {
                            "at": datetime.now(timezone.utc).isoformat(),
                            "project": project,
                            "slug": slug,
                            "usd": _IMAGE_PRICE_USD,
                            "prompt": prompt[:120],
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        except OSError:
            log_warning = "spend-log append failed (image saved, charge occurred)"
        result = {
            "ok": True,
            "url": f"/api/uploads/{project}/{target.name}",
            "version": n,
            "sha256": hashlib.sha256(img).hexdigest(),
            "usd": _IMAGE_PRICE_USD,
            "source": "minimax image-01",
        }
        if log_warning:
            result["warning"] = log_warning
        return _json(200, result)

    # -- project media (ADR-0053: <ProjectRoot>/media/) ---------------------
    # EVERY write path — manual upload, TTS, image generation, paid adoption,
    # compose and episode render — resolves its directory through here, so this
    # is the single place that decides where a project's media lives.
    def _upload_dir(self, project: str):
        root = self._project_root(project)
        if root is None:
            return None
        # `.resolve()` alone would FOLLOW a symlinked media/ straight out of the
        # project; containment has to be re-checked against the root
        return self._contained(root, "media")

    def _read_upload_dir(self, project: str):
        """Where to READ a media file from: the project's own media/ folder, or
        the legacy scratch while the project is still unmigrated. Never both —
        once migrated the legacy tree is invisible, so a file can never resolve
        half in the project and half in the repo."""
        d = self._upload_dir(project)
        if d is None:
            return None
        if self._migration_required(project):
            return self._legacy_upload_dir(project)
        return d

    def _upload_put(self, project: str, slug: str, ctype: str, body: bytes):
        """Store a user-uploaded media file (manual provider, prototype).

        Re-uploading the same slug APPENDS a new version ``<slug>_v<N>.<ext>``
        (ADR-0048): previous versions are never deleted or overwritten, so
        multiple takes can be kept, compared and switched in the canvas.
        Fail-closed: type allow-list + magic-byte sniff + size cap + containment.
        """
        d = self._upload_dir(project)
        if (
            d is None
            or not _NAME_RE.fullmatch(slug)
            or _slug_reserved(slug)
            or _slug_versioned(slug)
        ):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        ext = _UPLOAD_TYPES.get(ctype.partition(";")[0].strip().lower())
        if ext is None:
            return _json(
                415,
                {
                    "error": {
                        "category": "unsupported_type",
                        "detail": "type must be png/jpeg/webp, mp4/webm or mp3/wav",
                    }
                },
            )
        if len(body) > _UPLOAD_MAX[ext]:
            return _json(
                413,
                {
                    "error": {
                        "category": "too_large",
                        "detail": f"max {_UPLOAD_MAX[ext] // 1_000_000}MB for {ext}",
                    }
                },
            )
        if not body or not _media_magic_ok(ext, body):
            return _json(
                400,
                {
                    "error": {
                        "category": "bad_request",
                        "detail": "bytes are not a valid file of the declared type",
                    }
                },
            )
        try:
            d.mkdir(parents=True, exist_ok=True)
            # Claim the NEXT version slot atomically, then fill it (the claimed
            # empty placeholder is ours to replace — never an existing upload).
            n, target = _claim_version(d, slug, ext)
            fd, tmpname = tempfile.mkstemp(dir=str(d), suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(body)
                os.replace(tmpname, target)  # atomic, mockup-local only
            except OSError:
                for stale in (tmpname, str(target)):
                    try:
                        os.unlink(stale)  # release only OUR tmp/placeholder
                    except OSError:
                        pass
                raise
        except OSError:
            return _json(
                500, {"error": {"category": "write_failed", "detail": "could not save"}}
            )
        return _json(
            200,
            {
                "ok": True,
                "url": f"/api/uploads/{project}/{target.name}",
                "version": n,
                "sha256": hashlib.sha256(body).hexdigest(),
            },
        )

    def _upload_get(self, project: str, fname: str):
        d = self._read_upload_dir(project)
        if d is None or not _UPLOAD_FILE_RE.fullmatch(fname):
            return _json(
                400, {"error": {"category": "bad_request", "detail": "invalid name"}}
            )
        p = d / fname
        # Same symlink-safety class as the shots reader: never follow a link out.
        if p.is_symlink():
            return _json(
                404, {"error": {"category": "not_found", "detail": "not found"}}
            )
        rp = p.resolve()
        if d not in rp.parents or not rp.is_file():
            return _json(
                404, {"error": {"category": "not_found", "detail": "not found"}}
            )
        try:
            return _Resp(200, rp.read_bytes(), _CTYPE[rp.suffix])
        except OSError:
            return _json(
                500, {"error": {"category": "read_failed", "detail": "could not read"}}
            )

    # -- static ----------------------------------------------------------
    def _static(self, rel: str):
        try:
            resolved = (MOCKUP_DIR / rel).resolve()
        except OSError:
            return _json(
                404, {"error": {"category": "not_found", "detail": "bad path"}}
            )
        base = MOCKUP_DIR.resolve()
        if base not in resolved.parents and resolved != base:
            return _json(
                403,
                {"error": {"category": "forbidden", "detail": "outside mockup dir"}},
            )
        if not resolved.is_file():
            return _json(
                404, {"error": {"category": "not_found", "detail": "not found"}}
            )
        ctype = _CTYPE.get(resolved.suffix, "application/octet-stream")
        try:
            return _Resp(200, resolved.read_bytes(), ctype)
        except OSError:
            return _json(
                404, {"error": {"category": "not_found", "detail": "unreadable"}}
            )


class _Resp:
    __slots__ = ("status", "body", "content_type")

    def __init__(self, status, body, content_type="application/json; charset=utf-8"):
        self.status = status
        self.body = body
        self.content_type = content_type


def _json(status, payload):
    return _Resp(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"))


class _Handler(BaseHTTPRequestHandler):
    server_version = "motv-mockup"
    protocol_version = "HTTP/1.1"

    @property
    def _app(self) -> _App:
        return self.server.app  # type: ignore[attr-defined]

    def _guard_host(self) -> bool:
        if _host_is_loopback(self.headers.get("Host")):
            return True
        self._write(
            _json(
                403, {"error": {"category": "forbidden", "detail": "non-loopback host"}}
            )
        )
        return False

    def _guard_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        o = urlsplit(origin)
        host_hdr = urlsplit("//" + (self.headers.get("Host") or ""))
        try:
            same = (
                o.scheme == "http"
                and (o.hostname or "").lower() in _LOOPBACK_ORIGIN_HOSTS
                and (o.hostname or "").lower() == (host_hdr.hostname or "").lower()
                and o.port == host_hdr.port
            )
        except ValueError:
            same = False
        if same:
            return True
        self.close_connection = True
        self._write(
            _json(
                403,
                {
                    "error": {
                        "category": "forbidden",
                        "detail": "cross-origin write refused",
                    }
                },
            )
        )
        return False

    def do_GET(self):  # noqa: N802
        if not self._guard_host():
            return
        self._write(self._app.handle(self.path, self.headers))

    def do_HEAD(self):  # noqa: N802
        if not self._guard_host():
            return
        self._write(self._app.handle(self.path, self.headers), body=False)

    def _route_body_cap(self) -> int:
        """Per-route transport ceiling, enforced BEFORE the body is read: only
        the media-upload and Gateway-command routes may send large bodies
        (uploads / inline first-frame data URLs); every other JSON route is
        bounded at 2 MB so an oversized request is refused without buffering."""
        path = urlsplit(self.path).path
        if path.startswith("/api/uploads/"):
            return _MAX_BODY_BYTES
        if path.startswith("/api/projects/") and path.endswith(
            ("/preflight", "/command")
        ):
            return _COMMAND_BODY_MAX
        if path == "/api/skill/run":
            # A skill body is one prompt plus a tiny envelope. Bounding it HERE
            # means an oversized request is refused at transport, before the
            # body is buffered and parsed — the prompt-length check inside the
            # handler runs too late to protect memory (codex review, round 9).
            return _SKILL_BODY_MAX
        return _GATEWAY_BODY_MAX

    def do_PUT(self):  # noqa: N802
        if not self._guard_host() or not self._guard_origin():
            return
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._write(
                _json(
                    411,
                    {
                        "error": {
                            "category": "length_required",
                            "detail": "Content-Length required",
                        }
                    },
                )
            )
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > self._route_body_cap():
            self.close_connection = True
            self._write(
                _json(
                    413,
                    {
                        "error": {
                            "category": "too_large",
                            "detail": "request body too large",
                        }
                    },
                )
            )
            return
        body = self.rfile.read(length) if length else b""
        self._write(
            self._app.handle_put(
                self.path, body, self.headers.get("Content-Type") or ""
            )
        )

    def _reject(self):
        self.close_connection = True
        self._write(
            _json(
                405,
                {
                    "error": {
                        "category": "method_not_allowed",
                        "detail": "unsupported method",
                    }
                },
            )
        )

    def do_POST(self):  # noqa: N802 - Gateway write path (ADR-0041, paid mode only)
        if not self._guard_host() or not self._guard_origin():
            return
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._write(
                _json(
                    411,
                    {
                        "error": {
                            "category": "length_required",
                            "detail": "Content-Length required",
                        }
                    },
                )
            )
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > self._route_body_cap():
            self.close_connection = True
            self._write(
                _json(
                    413,
                    {
                        "error": {
                            "category": "too_large",
                            "detail": "request body too large",
                        }
                    },
                )
            )
            return
        body = self.rfile.read(length) if length else b""
        self._write(self._app.handle_post(self.path, body, self.headers))

    do_PATCH = _reject  # noqa: N815
    do_DELETE = _reject  # noqa: N815

    def _write(self, resp: _Resp, *, body: bool = True):
        self.send_response(resp.status)
        self.send_header("Content-Type", resp.content_type)
        self.send_header("Content-Length", str(len(resp.body)))
        for name, value in _SECURITY_HEADERS:
            self.send_header(name, value)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(resp.body)

    def log_message(self, *args):  # quiet
        pass


def build_server(account_root, host="127.0.0.1", port=8770, paid_catalog_dir=None):
    if ":" in host and not host.startswith("["):
        addr_family = socket.AF_INET6
    else:
        addr_family = socket.AF_INET

    class _Server(ThreadingHTTPServer):
        address_family = addr_family
        daemon_threads = True

    srv = _Server((host, port), _Handler)
    srv.app = _App(account_root, paid_catalog_dir)  # type: ignore[attr-defined]
    return srv


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="motv mockup loopback backend (read-only + canvas persistence)"
    )
    ap.add_argument(
        "--account-root",
        default=str(REPO_ROOT / "examples" / "projects"),
        help="parent dir whose children are projects (each with config/wfm1.json). "
        "Default: examples/projects",
    )
    ap.add_argument(
        "--host",
        default="127.0.0.1",
        help="loopback address only (127.0.0.1/localhost/::1)",
    )
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument(
        "--enable-paid",
        action="store_true",
        help="expose the ADR-0041 generation write path (POST → Command "
        "Gateway). Also requires AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1; a "
        "real provider call additionally needs WFM1_MINIMAX_API_KEY.",
    )
    ap.add_argument(
        "--catalog-dir",
        type=Path,
        default=None,
        help="locked provider catalog dir for paid mode "
        "(default: <account-root>/catalog)",
    )
    args = ap.parse_args(argv)

    # Loopback-only by design: this backend serves real project data and accepts
    # canvas writes with only a same-origin (not authenticated) guard, so it must
    # never bind a routable interface where a spoofed Host header could reach it.
    if args.host not in _LOOPBACK_ORIGIN_HOSTS:
        ap.error("--host must be a loopback address (127.0.0.1, localhost, or ::1)")

    account_root = Path(args.account_root).resolve()
    paid_catalog_dir = None
    if args.enable_paid:
        if os.environ.get("AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS") != "1":
            ap.error(
                "--enable-paid requires AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1 "
                "(the deployment opt-in for the real-spend command)"
            )
        if not _QUERY_OK:
            ap.error("--enable-paid requires the venv (ai_video_workflow importable)")
        paid_catalog_dir = (
            Path(args.catalog_dir).resolve()
            if args.catalog_dir is not None
            else account_root / "catalog"
        )
        if not paid_catalog_dir.is_dir():
            ap.error(f"catalog dir not found: {paid_catalog_dir}")
    srv = build_server(
        account_root,
        host=args.host,
        port=args.port,
        paid_catalog_dir=paid_catalog_dir,
    )
    app: _App = srv.app  # type: ignore[attr-defined]
    mode = (
        "connected (real read-only data)"
        if app.connected
        else "local (fixtures + persistence only)"
    )
    if not _QUERY_OK:
        mode += " — query package not importable; run inside the venv for real data"
    if app.paid:
        mode += " + PAID write path (Gateway; spend still needs key + confirmation)"
    # EVERY banner line goes through `_banner`, not `print`. A project named
    # 「夜班沉默」 or an account root with any CJK in it made this crash on a
    # cp932 / cp1252 console — BEFORE `serve_forever`, so the backend never came
    # up at all. Two sessions lost time to it, and one concluded from the crash
    # that the project was not on the machine. The banner is decoration; it must
    # never be able to stop the server.
    _banner(f"motv mockup backend → http://{args.host}:{args.port}/")
    _banner(f"  mode: {mode}")
    _banner(f"  account-root: {account_root}")
    if app.connected:
        _banner(
            f"  projects: {', '.join(sorted(app._projects)) or '(none discovered)'}"
        )
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()

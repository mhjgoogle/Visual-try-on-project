"""motv adopt-paid + first-frame joins by canonical Shot identity — M4d.

STRICTLY OFFLINE, no spend. The pure resolution logic (server shot_id → M4c
bridge → creativeShotId → slot; re-lock across plans; unresolved fail-safe) and
the unresolved-paid preservation are exercised by the frontend units in
``shotmap.test.mjs`` / ``assets.test.mjs`` (wrapped by the M4a/M3 python tests).
Here we guard the wiring: adopt/first-frame resolve through identity, not
sequence, and Core stays untouched.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

_MOCKUP_DIR = Path(__file__).resolve().parents[1] / "mockups" / "motv-workspace"
_SRC = _MOCKUP_DIR / "src"


def test_adopt_paid_resolves_by_identity_not_sequence() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    # adopt goes through the pure identity resolver…
    assert "resolveAdoptTarget" in app
    # …and no longer does its own positional lockedShotId(sequence) match inside
    # the adopt function (that logic now lives ONLY as the legacy fallback inside
    # resolveAdoptTarget in shotmap.js).
    body = app.split("async function adoptPaidIntoSlot", 1)[1]
    adopt = body[: body.index("\n}\n")]
    # strip line comments so the guard measures real code, not intent comments
    code = "\n".join(ln.split("//")[0] for ln in adopt.splitlines())
    assert "lockedShotId" not in code
    assert "sequence" not in code


def test_adopt_rechecks_identity_after_the_await_and_never_discards() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    body = app.split("async function adoptPaidIntoSlot", 1)[1]
    adopt = body[: body.index("\n}\n")]
    # the slot is re-resolved AFTER the awaited adopt (in-flight re-lock, M4d #3):
    # resolveAdoptSlot is consulted more than once
    assert adopt.count("resolveAdoptSlot(serverShotId)") >= 2
    # an in-flight change and a no-slot op are BOTH preserved, never dropped
    assert "shot-changed-while-in-flight" in adopt
    assert "no-current-slot" in adopt
    # every RESOLVABLE non-adopt preserves explicitly; the only bare
    # `return { adopted: false }` exits are the two transient-failure catches
    # (network fetch-not-ready, registration/render failure) — the task stays in
    # the queue in both, so nothing resolvable is discarded
    assert adopt.count("return { adopted: false }") == 2


def test_adopt_records_unresolved_paid_explicitly() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    assert "recordUnresolvedPaid" in app  # unresolved results are preserved
    shotmap = (_SRC / "workflow" / "shotmap.js").read_text("utf-8")
    # the resolver has an explicit unresolved outcome and never sequence-guesses
    assert "unresolved: true" in shotmap
    assert "byServer" in shotmap  # reverse bridge: server shot_id → creativeShotId


def test_lock_first_frame_resolves_via_creativeShotId() -> None:
    app = (_SRC / "app.js").read_text("utf-8")
    lock = app.split("async function lockDraftPlan")[1].split("\n}\n")[0]
    # the per-shot first frame resolves the slot through the identity resolver
    assert "slotForShotId(lockIdx" in lock


def test_core_contracts_untouched_by_m4d() -> None:
    core = Path(__file__).resolve().parents[1] / "src" / "ai_video_workflow"
    for needle in ("creativeShotId", "resolveAdoptTarget", "unresolvedPaid"):
        hits = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["grep", "-rl", needle, str(core)],
            capture_output=True,
            text=True,
        )
        assert hits.stdout.strip() == "", f"{needle} leaked into Core"

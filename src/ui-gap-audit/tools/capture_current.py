"""UI Audit Screenshot Flow — capture the CURRENT Studio UI, reproducibly.

Reuses the repo's existing Playwright install (`.venv`, chromium already
downloaded) rather than introducing a second automation framework; it is the
Python twin of the ad-hoc `_agent-tools/*.mjs` acceptance scripts, made
repeatable and named after the audit manifest instead of after a task card.

Runs against the REAL Connected Project (AGENTS.md 第 20 条: demo seed +
SVG placeholders are not acceptance evidence), so the backend must already be
serving:

    PYTHONIOENCODING=utf-8 .venv/Scripts/python mockups/motv-workspace/server.py \
        --account-root <account root> --port 8791

Then:

    .venv/Scripts/python src/ui-gap-audit/tools/capture_current.py \
        --port 8791 --project 照见未明rev2

Fixed capture conditions, so two runs are comparable:
  viewport 1440x900, deviceScaleFactor 1, no zoom, same project, same route
  order. Every shot is named `{order}-{workflow-step}-{state}.png` per the
  audit manifest.

Output: src/ui-gap-audit/screenshots/current/*.png plus a `capture.json`
sidecar recording port, project, commit and any page errors observed — a
screenshot with a swallowed JS exception behind it is misleading evidence.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / "src" / "ui-gap-audit" / "screenshots" / "current"

VIEWPORT = {"width": 1440, "height": 900}

# (module key, space, filename stem, settle ms)
#
# `space` is the top-bar segment that must be active first — the Studio has no
# URL routing, so a page is only reachable by clicking its way there (audit
# finding IA-1, still open — that is Phase 2, not Phase 0).
#
# IA-2 IS CLOSED (TASK-077 §1.5). 剧集制作 now renders the frozen IA's FIVE pages
# as a `[data-mod]` rail of its own, exactly like the other two spaces, so the
# five are captured first and by name. The ELEVEN legacy stage keys are kept
# below because the 「工作区 ▾」 dropdown still offers them (TASK-074 retires it),
# and a capture that stopped driving them would stop noticing if they broke.
ROUTES = [
    ("brief", "story", "02-brief", 1200),
    ("story", "story", "03-story-outline", 1200),
    ("settings", "story", "04-settings-bible", 1400),
    ("episodes", "story", "05-episode-plan", 1200),
    ("script", "story", "06-episode-script", 1400),
    # the FIVE pages of the frozen IA, now that a rail draws them
    ("board", "episode", "07a-episode-board", 1800),
    ("storyboard", "episode", "07b-storyboard-design", 2000),
    ("shotwork", "episode", "07c-shot-production", 2200),
    ("cutreview", "episode", "07d-cut-review", 1800),
    ("delivery", "episode", "07e-post-delivery", 2200),
    # …and the legacy stage keys, still reachable behind 「工作区 ▾」
    ("workbench", "episode", "07-episode-workbench", 2200),
    ("provenance", "episode", "08-provenance-graph", 2000),
    ("episode", "episode", "09-episode-overview", 1600),
    ("scenes", "episode", "10-scenes", 1600),
    ("shots", "episode", "11-storyboard-shots", 2000),
    ("refplan", "episode", "12-reference-plan", 1800),
    ("frames", "episode", "13-image-workspace", 2000),
    ("video", "episode", "14-video-workspace", 2000),
    ("audio", "episode", "15-audio-workspace", 2000),
    ("dailies", "episode", "16-dailies-review", 1800),
    ("edit", "episode", "17-edit-console", 2200),
    ("assets", "assets", "18-asset-library", 1600),
    ("storage", "assets", "19-storage-diagnostics", 1600),
]

SEG = {"story": "#seg-story", "episode": "#seg-episode", "assets": "#seg-assets"}

# How to reach a module inside each space.
CLICK_JS = """(m) => {
    // 1. a rail row / any [data-mod] entry (故事开发, 资产库, 制作台 back button)
    const b = document.querySelector(`[data-mod="${m}"]`);
    if (b) { b.click(); return "data-mod"; }
    // 2. 剧集制作's 「工作区 ▾」 dropdown — open it, then pick the stage
    const open = document.querySelector('[data-ep-wsopen]');
    if (open) {
        if (!document.querySelector(`[data-ep-ws="${m}"]`)) open.click();
        const s = document.querySelector(`[data-ep-ws="${m}"]`);
        if (s) { s.click(); return "data-ep-ws"; }
    }
    return null;
}"""


def _commit() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=REPO,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except Exception:  # noqa: BLE001 - evidence metadata, never fatal
        return "unknown"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--project", required=True, help="real connected project name")
    ap.add_argument("--only", default=None, help="comma-separated module keys")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    wanted = set(args.only.split(",")) if args.only else None
    errors: list[str] = []
    taken: list[dict] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport=VIEWPORT, device_scale_factor=1)
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(f"http://127.0.0.1:{args.port}/index.html", wait_until="networkidle")
        page.wait_for_selector("#projgrid button")
        page.screenshot(path=str(OUT / "01-landing-project-home.png"))
        taken.append({"file": "01-landing-project-home.png", "module": "(landing)"})

        clicked = page.evaluate(
            """(name) => {
                const b = [...document.querySelectorAll('#projgrid button')]
                    .find((c) => c.textContent.includes(name));
                if (!b) return false;
                b.click();
                return true;
            }""",
            args.project,
        )
        if not clicked:
            print(
                f"ERROR: project {args.project!r} not on the landing page",
                file=sys.stderr,
            )
            browser.close()
            return 2
        page.wait_for_timeout(3500)

        space_now = None
        for mod, space, stem, settle in ROUTES:
            if wanted and mod not in wanted:
                continue
            if space != space_now:
                page.click(SEG[space])
                page.wait_for_timeout(1500)
                space_now = space
            how = page.evaluate(CLICK_JS, mod)
            if not how:
                # An unreachable page is itself a finding — record it, do not
                # fabricate a screenshot for it.
                taken.append(
                    {
                        "file": None,
                        "module": mod,
                        "note": "unreachable: no entry in this space",
                    }
                )
                print(f"  MISS {mod}: no entry", file=sys.stderr)
                continue
            page.wait_for_timeout(settle)
            page.screenshot(path=str(OUT / f"{stem}.png"))
            taken.append({"file": f"{stem}.png", "module": mod, "reached_via": how})
            print(f"  {stem}.png  (via {how})")

        browser.close()

    (OUT / "capture.json").write_text(
        json.dumps(
            {
                "port": args.port,
                "project": args.project,
                "commit": _commit(),
                "viewport": VIEWPORT,
                "shots": taken,
                "page_errors": errors,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"JS exceptions: {len(errors)}")
    for e in errors[:10]:
        print("  !", e)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

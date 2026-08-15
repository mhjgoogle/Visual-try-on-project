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

    .venv/Scripts/python docs/ui-gap-audit/tools/capture_current.py \
        --port 8791 --project 照见未明rev2

Fixed capture conditions, so two runs are comparable:
  viewport 1440x900, deviceScaleFactor 1, no zoom, same project, same route
  order. Every shot is named `{order}-{workflow-step}-{state}.png` per the
  audit manifest.

Output: docs/ui-gap-audit/screenshots/current/*.png plus a `capture.json`
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
OUT = REPO / "docs" / "ui-gap-audit" / "screenshots" / "current"

VIEWPORT = {"width": 1440, "height": 900}

# (order, module key, space, filename stem, settle ms)
# `space` is the top-bar segment that must be active before the rail exposes
# the module — the Studio has no URL routing, so a page is only reachable by
# clicking its way there (see the audit report, IA-1).
ROUTES = [
    ("02", "brief", "story", "02-brief", 1200),
    ("03", "story", "story", "03-story-outline", 1200),
    ("04", "settings", "story", "04-settings-bible", 1400),
    ("05", "episodes", "story", "05-episode-plan", 1200),
    ("06", "script", "story", "06-episode-script", 1400),
    ("07", "board", "episode", "07-episode-board", 1600),
    ("08", "storyboard", "episode", "08-storyboard", 1800),
    ("09", "shotwork", "episode", "09-shot-workbench", 2200),
    ("10", "cutreview", "episode", "10-cut-review", 1600),
    ("11", "delivery", "episode", "11-delivery", 2000),
    ("12", "assets", "assets", "12-asset-library", 1600),
    ("13", "projectsettings", "story", "13-project-settings", 1400),
]

SEG = {"story": "#seg-story", "episode": "#seg-episode", "assets": "#seg-assets"}


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
            print(f"ERROR: project {args.project!r} not on the landing page", file=sys.stderr)
            browser.close()
            return 2
        page.wait_for_timeout(3500)

        space_now = None
        for _order, mod, space, stem, settle in ROUTES:
            if wanted and mod not in wanted:
                continue
            if space != space_now:
                page.click(SEG[space])
                page.wait_for_timeout(1500)
                space_now = space
            ok = page.evaluate(
                """(m) => {
                    const b = document.querySelector(`[data-mod="${m}"]`);
                    if (!b) return false;
                    b.click();
                    return true;
                }""",
                mod,
            )
            if not ok:
                # An unreachable page is itself a finding — record it, do not
                # fabricate a screenshot for it.
                taken.append({"file": None, "module": mod, "note": "no [data-mod] entry in this space's rail"})
                print(f"  MISS {mod}: no rail entry", file=sys.stderr)
                continue
            page.wait_for_timeout(settle)
            page.screenshot(path=str(OUT / f"{stem}.png"))
            taken.append({"file": f"{stem}.png", "module": mod})
            print(f"  {stem}.png")

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

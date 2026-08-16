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
from urllib.parse import quote

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / "src" / "ui-gap-audit" / "screenshots" / "current"

VIEWPORT = {"width": 1440, "height": 900}

# (module key, space, filename stem, settle ms)
#
# IA-1 IS CLOSED (TASK-081). The Studio has hash routing now, so every page is
# reached BY NAME — `#/<project>/<space>/<module>` — instead of by clicking a
# path to it. That change is what makes this tool trustworthy: it used to guess
# a route through `[data-mod]` rails and a 「工作区 ▾」 dropdown, so a page whose
# ENTRANCE broke was recorded as 「unreachable」 exactly like a page that was
# genuinely gone, and a page reached by an unexpected door was recorded as fine.
# Now the address states the intent and the resulting hash is captured as
# evidence beside the screenshot.
#
# `space` is still carried because it is part of the address a human reads; the
# application derives it from the module, so a mismatch here cannot send the
# capture to the wrong page.
#
# IA-2 IS CLOSED (TASK-077 §1.5). 剧集制作 renders the frozen IA's FIVE pages as a
# rail of its own. The ELEVEN legacy stage keys are kept below because they must
# stay resolvable (TASK-074 retires their entrance, never their address), and a
# capture that stopped driving them would stop noticing if they broke.
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


def route_hash(project: str, space: str, module: str) -> str:
    """The address of one page — the same shape `services/route.js` writes."""
    seg = "/".join(quote(s, safe="") for s in (project, space, module))
    return f"#/{seg}"


# Navigate by ADDRESS, not by clicking. Setting `location.hash` fires the
# application's own `hashchange` listener, which runs the very code path a pasted
# deep link takes — so this captures what a creator following a shared link sees,
# not what a synthetic click sequence produces.
GOTO_JS = """(h) => {
    if (window.location.hash === h) return "already";
    window.location.hash = h;
    return "hash";
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

        # Enter the project BY ADDRESS. A project the backend never listed lands
        # back on the landing page with a stated reason (TASK-081 §1.2 第 3 条),
        # which is exactly the check below.
        page.evaluate(GOTO_JS, f"#/{quote(args.project, safe='')}")
        page.wait_for_timeout(3500)
        on_canvas_js = (
            "() => document.querySelector('#canvas').style.display === 'block'"
        )
        if not page.evaluate(on_canvas_js):
            # the landing note carries the REASON (§1.2 第 3 条) — report it rather
            # than the tool's own guess about why
            why = page.evaluate(
                "() => { const n = document.querySelector('#landing-note');"
                " return n ? n.textContent : ''; }"
            )
            print(
                f"ERROR: project {args.project!r} did not open — {why}",
                file=sys.stderr,
            )
            browser.close()
            return 2

        for mod, space, stem, settle in ROUTES:
            if wanted and mod not in wanted:
                continue
            want = route_hash(args.project, space, mod)
            page.evaluate(GOTO_JS, want)
            page.wait_for_timeout(settle)
            # WHERE IT ACTUALLY LANDED, recorded beside the screenshot. The
            # application normalises the address it was given (the space segment is
            # derived, a historical key resolves to the page it now lives on), so
            # the landed hash is evidence rather than a failure — but a capture that
            # bounced back to the landing page is a real finding and says so.
            landed = page.evaluate("() => window.location.hash")
            on_canvas = page.evaluate(on_canvas_js)
            if not on_canvas:
                taken.append(
                    {
                        "file": None,
                        "module": mod,
                        "requested": want,
                        "landed": landed,
                        "note": "left the project: this address did not open a page",
                    }
                )
                print(f"  MISS {mod}: bounced to the landing page", file=sys.stderr)
                continue
            page.screenshot(path=str(OUT / f"{stem}.png"))
            taken.append(
                {
                    "file": f"{stem}.png",
                    "module": mod,
                    "reached_via": "url",
                    "requested": want,
                    "landed": landed,
                }
            )
            print(f"  {stem}.png  (url {landed})")

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

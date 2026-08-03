"""``python -m workspace_shell`` entry point (TASK-026)."""

from __future__ import annotations

from workspace_shell.server import main

if __name__ == "__main__":
    raise SystemExit(main())

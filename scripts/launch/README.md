# Product Launchers

- `studio.ps1` — authoritative native-Windows PowerShell launcher.
- `studio.bat` — double-click/CMD adapter that delegates to `studio.ps1`.
- `studio.sh` — Ubuntu / WSL2 counterpart.

All launchers resolve the repository root from their own location, change to
that directory, and then use repository-relative paths. They may be invoked
from any working directory.

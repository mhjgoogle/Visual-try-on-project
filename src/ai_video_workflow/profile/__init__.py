"""WFM1 project instance profile and reusable asset references (TASK-018).

Public API:

- project profile: versioned, digest-carrying creative-goal baseline
  (``profile/project_profile_v<N>.json``, immutable versions);
- reuse packs: account-level read-only immutable asset versions
  (``reuse/<asset_id>/v<N>.json``) referenced by projects with
  ``asset_id + version + content_digest`` (never "latest");
- typed errors under ``AiVideoWorkflowError``.

Everything is optional for existing projects: no M1/WFM1 flow requires a
profile, and nothing here reads or writes any frozen business state.
Paths are authorized by ADR-0011 and containment-checked (ADR-0004).
"""

from __future__ import annotations

from ai_video_workflow.profile.errors import (
    ProfileError,
    ProfileNotFoundError,
    ReuseError,
    ReuseRefError,
)
from ai_video_workflow.profile.project_profile import (
    PROFILE_DIR,
    PROFILE_SCHEMA_VERSION,
    ProjectProfile,
    load_project_profile,
    parse_project_profile,
    profile_digest,
    profile_relpath,
    write_project_profile,
)
from ai_video_workflow.profile.reuse import (
    REUSE_DIR,
    REUSE_KINDS,
    REUSE_REFS_RELPATH,
    ReuseAssetVersion,
    ReuseRef,
    add_reuse_ref,
    load_pack_version,
    load_reuse_refs,
    pack_relpath,
    parse_pack,
    publish_pack_version,
    resolve_reuse_refs,
)

__all__ = [
    "PROFILE_DIR",
    "PROFILE_SCHEMA_VERSION",
    "REUSE_DIR",
    "REUSE_KINDS",
    "REUSE_REFS_RELPATH",
    "ProfileError",
    "ProfileNotFoundError",
    "ProjectProfile",
    "ReuseAssetVersion",
    "ReuseError",
    "ReuseRef",
    "ReuseRefError",
    "add_reuse_ref",
    "load_pack_version",
    "load_project_profile",
    "load_reuse_refs",
    "pack_relpath",
    "parse_pack",
    "parse_project_profile",
    "profile_digest",
    "profile_relpath",
    "publish_pack_version",
    "resolve_reuse_refs",
    "write_project_profile",
]

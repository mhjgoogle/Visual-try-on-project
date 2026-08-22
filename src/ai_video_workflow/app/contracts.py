"""Stable M1 application-layer contract constants and digests (TASK-007).

This module is the sole owner of the M1 staging naming contract and the
generation input / config digest schema strings. No other component
spells these strings.
"""

from __future__ import annotations

from ai_video_workflow.digests import config_digest
from ai_video_workflow.models import Shot

STAGING_CONTRACT_VERSION = "m1-staging-v1"
M1_GENERATION_INPUT_SCHEMA = "m1-generation-input-v1"
M1_GENERATION_CONFIG_SCHEMA = "m1-generation-config-v1"


def staging_ref_for(task_id: str) -> str:
    """Return the fixed staging path for a task's media (ADR-0001)."""
    return f"staging/shots/{task_id}.mp4"


def generation_input_digest(shot: Shot) -> str:
    """Digest the generation-affecting shot inputs (no time, no paths)."""
    return config_digest(
        {
            "schema": M1_GENERATION_INPUT_SCHEMA,
            "shot_id": shot.shot_id,
            "scene_id": shot.scene_id,
            "character_ids": list(shot.character_ids),
            "prompt": shot.prompt,
            "description": shot.description,
            "duration_seconds": shot.duration_seconds,
            "width": shot.width,
            "height": shot.height,
            "frame_rate": shot.frame_rate,
        }
    )


def generation_config_digest(provider_id: str) -> str:
    """Digest the provider selection and staging contract version."""
    return config_digest(
        {
            "schema": M1_GENERATION_CONFIG_SCHEMA,
            "provider_id": provider_id,
            "staging_contract": STAGING_CONTRACT_VERSION,
        }
    )

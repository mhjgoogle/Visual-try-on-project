"""ProviderRequest construction port (TASK-007).

``ProviderRequestFactory`` is the formal, TASK-007-owned port that turns
the current public models into a ProviderRequest at prepare/submit
time. It reads no files, scans no directories, touches no executor, and
uses no cwd / environment / global registry; it does not mutate its
inputs. No parallel Project DTO is introduced — it consumes the existing
public ``Project`` / ``Shot`` / ``GenerationTask`` types.
"""

from __future__ import annotations

from typing import Protocol

from ai_video_workflow.app.contracts import staging_ref_for
from ai_video_workflow.models import GenerationTask, Project, Shot
from ai_video_workflow.providers.models import ProviderRequest


class ProviderRequestFactory(Protocol):
    """Formal request-construction port (pure; no IO, no discovery)."""

    def build(
        self,
        *,
        project: Project,
        shot: Shot,
        task: GenerationTask,
        provider_id: str,
    ) -> ProviderRequest: ...


class DefaultProviderRequestFactory:
    """The M1 default request factory (pure, side-effect-free)."""

    def build(
        self,
        *,
        project: Project,
        shot: Shot,
        task: GenerationTask,
        provider_id: str,
    ) -> ProviderRequest:
        del project  # not needed for the M1 request; part of the port contract
        return ProviderRequest(
            provider_id=provider_id,
            task_id=task.task_id,
            shot_id=shot.shot_id,
            prompt=shot.prompt,
            duration_seconds=shot.duration_seconds,
            width=shot.width,
            height=shot.height,
            frame_rate=shot.frame_rate,
            staging_ref=staging_ref_for(task.task_id),
            provider_parameters={},
        )

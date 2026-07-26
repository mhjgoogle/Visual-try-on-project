"""Abstract stateless contract every video provider must implement."""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime

from ai_video_workflow.errors import FieldTypeError
from ai_video_workflow.providers.errors import InvalidProviderRequestError
from ai_video_workflow.providers.models import (
    ArtifactReference,
    ProviderRequest,
    ProviderResult,
)
from ai_video_workflow.validation import validate_stable_id


class VideoProvider(ABC):
    """Stateless provider contract for one generation lifecycle.

    A provider never stores workflow state on itself: every call receives
    the request and, after prepare, the caller-supplied immutable snapshot
    of the previous ProviderResult. Providers only return structured
    results; they never write GenerationTask, VideoAsset, manifest, or QCD
    state, never touch the filesystem, and never read the current clock.
    """

    @property
    @abstractmethod
    def provider_id(self) -> str:
        """Return the stable non-empty identifier of this provider."""

    @abstractmethod
    def prepare(
        self,
        request: ProviderRequest,
        *,
        observed_at: datetime,
    ) -> ProviderResult:
        """Prepare generation inputs for one request.

        Returns a ProviderResult snapshot for the caller; providers with
        user-facing preparation may attach a ProviderInstruction on a
        not_submitted result.
        """

    @abstractmethod
    def submit(
        self,
        request: ProviderRequest,
        prepared: ProviderResult,
        *,
        observed_at: datetime,
    ) -> ProviderResult:
        """Start generation based on the prepared result snapshot."""

    @abstractmethod
    def poll(
        self,
        request: ProviderRequest,
        current: ProviderResult,
        *,
        observed_at: datetime,
        reported_artifact: ArtifactReference | None = None,
    ) -> ProviderResult:
        """Report progress based on the current snapshot.

        ``reported_artifact`` is caller-supplied artifact evidence; a
        provider must never discover artifacts on its own.
        """

    @abstractmethod
    def collect(
        self,
        request: ProviderRequest,
        current: ProviderResult,
        *,
        artifact: ArtifactReference | None = None,
        observed_at: datetime,
        completed_at: datetime | None = None,
    ) -> ProviderResult:
        """Return the final artifact reference for one finished request."""

    def _validate_alignment(
        self,
        request: ProviderRequest,
        result: ProviderResult,
    ) -> None:
        """Validate that request and result belong to this provider run.

        Checks provider, task, and shot identity only. It never modifies
        or replaces the given objects and never rewrites identifiers.
        When the result carries an instruction, its identity is
        defensively re-checked even though ProviderResult construction
        already enforces it: this guards against low-level corruption
        (``object.__setattr__``), non-standard construction, and damaged
        objects from future deserialization boundaries. Both layers stay
        in force; neither replaces the other.
        """
        provider_id = validate_stable_id(
            self.provider_id,
            field_name="provider_id",
        )
        if not isinstance(request, ProviderRequest):
            raise FieldTypeError(
                f"request: expected ProviderRequest, got {type(request).__name__}"
            )
        if not isinstance(result, ProviderResult):
            raise FieldTypeError(
                f"result: expected ProviderResult, got {type(result).__name__}"
            )
        if request.provider_id != provider_id:
            raise InvalidProviderRequestError(
                "request.provider_id: must match the provider identity"
            )
        if result.provider_id != provider_id:
            raise InvalidProviderRequestError(
                "result.provider_id: must match the provider identity"
            )
        if result.task_id != request.task_id:
            raise InvalidProviderRequestError(
                "result.task_id: must match request.task_id"
            )
        if result.shot_id != request.shot_id:
            raise InvalidProviderRequestError(
                "result.shot_id: must match request.shot_id"
            )
        instruction = result.instruction
        if instruction is None:
            return
        if (
            instruction.provider_id != provider_id
            or instruction.provider_id != request.provider_id
            or instruction.provider_id != result.provider_id
        ):
            raise InvalidProviderRequestError(
                "instruction.provider_id: must match the provider identity"
            )
        if (
            instruction.task_id != request.task_id
            or instruction.task_id != result.task_id
        ):
            raise InvalidProviderRequestError(
                "instruction.task_id: must match the request and result task_id"
            )
        if (
            instruction.shot_id != request.shot_id
            or instruction.shot_id != result.shot_id
        ):
            raise InvalidProviderRequestError(
                "instruction.shot_id: must match the request and result shot_id"
            )

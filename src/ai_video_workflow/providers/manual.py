"""Manual video provider that treats a human as the generation backend."""

from __future__ import annotations

from datetime import datetime

from ai_video_workflow.errors import FieldTypeError
from ai_video_workflow.providers.base import VideoProvider
from ai_video_workflow.providers.errors import (
    InvalidProviderRequestError,
    InvalidProviderStateError,
    MissingArtifactReferenceError,
)
from ai_video_workflow.providers.models import (
    ArtifactReference,
    ProviderInstruction,
    ProviderRequest,
    ProviderResult,
    ProviderStatus,
    _thaw_json_mapping,
)

_MANUAL_STEPS: tuple[str, ...] = (
    "Open the external video generation tool of your choice.",
    "Generate one video using the prompt and the expected output settings.",
    "Save the finished video at the staging location named by staging_ref.",
    "Report the artifact reference back to the calling workflow.",
)

_ALLOWED_PROGRESS_STATUSES = (
    ProviderStatus.WAITING_FOR_USER,
    ProviderStatus.ARTIFACT_AVAILABLE,
)

_IMPOSSIBLE_SNAPSHOT_FIELDS = (
    "external_task_ref",
    "message",
    "elapsed_seconds",
    "cost_observation",
)


class ManualVideoProvider(VideoProvider):
    """Stateless provider where a user generates the video externally.

    Every call works only from explicit caller input. The provider never
    calls an API, opens a browser, reads the clock, or touches the
    filesystem, and it never writes GenerationTask, VideoAsset, manifest,
    QCD, or instruction files.
    """

    __slots__ = ()

    @property
    def provider_id(self) -> str:
        return "manual"

    def prepare(
        self,
        request: ProviderRequest,
        *,
        observed_at: datetime,
    ) -> ProviderResult:
        """Build the manual instruction for one shot generation request."""
        _require_provider_request(request)
        if request.provider_id != self.provider_id:
            raise InvalidProviderRequestError(
                "request.provider_id: must match the provider identity"
            )
        if request.staging_ref is None:
            raise InvalidProviderRequestError(
                "request.staging_ref: required for manual video generation"
            )
        instruction = ProviderInstruction(
            provider_id=self.provider_id,
            task_id=request.task_id,
            shot_id=request.shot_id,
            prompt=request.prompt,
            expected_duration_seconds=request.duration_seconds,
            expected_width=request.width,
            expected_height=request.height,
            expected_frame_rate=request.frame_rate,
            staging_ref=request.staging_ref,
            steps=_MANUAL_STEPS,
            suggested_parameters=_thaw_json_mapping(request.provider_parameters),
        )
        return self._new_result(
            request,
            status=ProviderStatus.NOT_SUBMITTED,
            observed_at=observed_at,
            instruction=instruction,
        )

    def submit(
        self,
        request: ProviderRequest,
        prepared: ProviderResult,
        *,
        observed_at: datetime,
    ) -> ProviderResult:
        """Express that the manual task is published and awaits the user."""
        self._validate_alignment(request, prepared)
        _reject_impossible_snapshot_fields(prepared)
        if prepared.status is not ProviderStatus.NOT_SUBMITTED:
            raise InvalidProviderStateError(
                "prepared.status: submit requires a not_submitted snapshot"
            )
        if prepared.instruction is None:
            raise InvalidProviderStateError(
                "prepared.instruction: required to publish a manual task"
            )
        return self._new_result(
            request,
            status=ProviderStatus.WAITING_FOR_USER,
            observed_at=observed_at,
        )

    def poll(
        self,
        request: ProviderRequest,
        current: ProviderResult,
        *,
        observed_at: datetime,
        reported_artifact: ArtifactReference | None = None,
    ) -> ProviderResult:
        """Report the state confirmable from explicit caller input only."""
        self._validate_alignment(request, current)
        _reject_impossible_snapshot_fields(current)
        _require_optional_artifact(
            reported_artifact,
            field_name="reported_artifact",
        )
        _require_progress_status(current)
        if current.status is ProviderStatus.WAITING_FOR_USER:
            if reported_artifact is None:
                return self._new_result(
                    request,
                    status=ProviderStatus.WAITING_FOR_USER,
                    observed_at=observed_at,
                )
            return self._new_result(
                request,
                status=ProviderStatus.ARTIFACT_AVAILABLE,
                observed_at=observed_at,
                artifact=reported_artifact,
            )
        if reported_artifact is not None and reported_artifact != current.artifact:
            raise InvalidProviderRequestError(
                "reported_artifact: must match the known artifact reference"
            )
        return self._new_result(
            request,
            status=ProviderStatus.ARTIFACT_AVAILABLE,
            observed_at=observed_at,
            artifact=current.artifact,
        )

    def collect(
        self,
        request: ProviderRequest,
        current: ProviderResult,
        *,
        artifact: ArtifactReference | None = None,
        observed_at: datetime,
        completed_at: datetime | None = None,
    ) -> ProviderResult:
        """Return the single explicitly supplied artifact reference."""
        self._validate_alignment(request, current)
        _reject_impossible_snapshot_fields(current)
        _require_optional_artifact(artifact, field_name="artifact")
        _require_progress_status(current)
        if current.status is ProviderStatus.WAITING_FOR_USER:
            if artifact is None:
                raise MissingArtifactReferenceError(
                    "artifact: collect requires an explicitly supplied reference"
                )
            collected = artifact
        elif artifact is None or artifact == current.artifact:
            collected = current.artifact
        else:
            raise InvalidProviderRequestError(
                "artifact: must match the known artifact reference"
            )
        return self._new_result(
            request,
            status=ProviderStatus.SUCCEEDED,
            observed_at=observed_at,
            artifact=collected,
            completed_at=observed_at if completed_at is None else completed_at,
        )

    def _new_result(
        self,
        request: ProviderRequest,
        *,
        status: ProviderStatus,
        observed_at: datetime,
        artifact: ArtifactReference | None = None,
        instruction: ProviderInstruction | None = None,
        completed_at: datetime | None = None,
    ) -> ProviderResult:
        return ProviderResult(
            provider_id=self.provider_id,
            task_id=request.task_id,
            shot_id=request.shot_id,
            status=status,
            observed_at=observed_at,
            artifact=artifact,
            instruction=instruction,
            completed_at=completed_at,
        )


def _require_provider_request(request: object) -> None:
    if not isinstance(request, ProviderRequest):
        raise FieldTypeError(
            f"request: expected ProviderRequest, got {type(request).__name__}"
        )


def _reject_impossible_snapshot_fields(result: ProviderResult) -> None:
    for field_name in _IMPOSSIBLE_SNAPSHOT_FIELDS:
        if getattr(result, field_name) is not None:
            raise InvalidProviderRequestError(
                f"{field_name}: cannot originate from the manual provider"
            )


def _require_optional_artifact(value: object, *, field_name: str) -> None:
    if value is not None and not isinstance(value, ArtifactReference):
        raise FieldTypeError(
            f"{field_name}: expected ArtifactReference, got {type(value).__name__}"
        )


def _require_progress_status(result: ProviderResult) -> None:
    if result.status not in _ALLOWED_PROGRESS_STATUSES:
        raise InvalidProviderStateError(
            f"current.status: {result.status.value} does not allow this operation"
        )

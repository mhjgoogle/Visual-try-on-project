"""Application layer: bootstrap, request factory, workflow driver (TASK-007).

The caller-side of the Workflow Orchestrator role: it reads the clock
and mints identities (the core never does), assembles orchestration
contexts, and wires the validation and composition steps.
"""

from ai_video_workflow.app.bootstrap import (
    BootstrapError,
    BootstrapOutcome,
    TaskAlreadyExistsError,
    bootstrap_generation_tasks,
    create_redo_task,
    generation_manifest_path,
    initial_task_id,
    task_record_path,
)
from ai_video_workflow.app.clock import utc_now
from ai_video_workflow.app.contracts import (
    STAGING_CONTRACT_VERSION,
    generation_config_digest,
    generation_input_digest,
    staging_ref_for,
)
from ai_video_workflow.app.driver import (
    DriverOutcome,
    StagedFileMissingError,
    WorkflowDriver,
)
from ai_video_workflow.app.ids import (
    new_attempt_id,
    new_operation_id,
    new_rating_id,
)
from ai_video_workflow.app.requests import (
    DefaultProviderRequestFactory,
    ProviderRequestFactory,
)

__all__ = [
    "STAGING_CONTRACT_VERSION",
    "BootstrapError",
    "BootstrapOutcome",
    "DefaultProviderRequestFactory",
    "DriverOutcome",
    "ProviderRequestFactory",
    "StagedFileMissingError",
    "TaskAlreadyExistsError",
    "WorkflowDriver",
    "bootstrap_generation_tasks",
    "create_redo_task",
    "generation_config_digest",
    "generation_input_digest",
    "generation_manifest_path",
    "initial_task_id",
    "new_attempt_id",
    "new_operation_id",
    "new_rating_id",
    "staging_ref_for",
    "task_record_path",
    "utc_now",
]

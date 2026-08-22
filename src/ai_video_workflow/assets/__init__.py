"""Video-asset validation, registration, and the validation step (TASK-005).

``run_validation_step`` is the top-level, independently runnable and
resumable entry point; ``validate_artifact`` is the pure rule engine;
registration and reporting are the durable-write helpers.
"""

from ai_video_workflow.assets.policy import (
    M1_VALIDATION_CONFIG_SCHEMA,
    ValidationPolicy,
    policy_digest,
)
from ai_video_workflow.assets.registration import (
    AssetConflictError,
    AssetRegistrationError,
    ValidationFailedError,
    asset_id_for,
    import_media,
    media_relative_path,
    register_video_asset,
)
from ai_video_workflow.assets.reports import (
    report_json_bytes,
    report_markdown_bytes,
    report_to_json_dict,
)
from ai_video_workflow.assets.step import (
    ValidationStepOutcome,
    record_manual_quality_rating,
    run_validation_step,
    validation_manifest_path,
)
from ai_video_workflow.assets.validation import (
    REPORT_SCHEMA_VERSION,
    ValidationCheck,
    ValidationCheckStatus,
    ValidationCheckType,
    ValidationReport,
    validate_artifact,
)

__all__ = [
    "M1_VALIDATION_CONFIG_SCHEMA",
    "REPORT_SCHEMA_VERSION",
    "AssetConflictError",
    "AssetRegistrationError",
    "ValidationCheck",
    "ValidationCheckStatus",
    "ValidationCheckType",
    "ValidationFailedError",
    "ValidationPolicy",
    "ValidationReport",
    "ValidationStepOutcome",
    "asset_id_for",
    "import_media",
    "media_relative_path",
    "policy_digest",
    "record_manual_quality_rating",
    "register_video_asset",
    "report_json_bytes",
    "report_markdown_bytes",
    "report_to_json_dict",
    "run_validation_step",
    "validate_artifact",
    "validation_manifest_path",
]

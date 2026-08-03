"""Offline media generation orchestration (TASK-035 / ADR-0038).

Ties the capability registry to the staging + batch/selection + asset contract:
a generation operation runs the provider once per candidate, stages every result
atomically (retaining ALL candidates), and records a batch. A user selection is
then promoted to a formal :class:`~.assets.MediaAsset` bound to the selected
candidate's staged file — the unselected candidates stay on disk. The provider
is never asked to write business facts; only this authorized layer does. Default
runs use the offline stub (no network, no cost).
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Mapping, Sequence
from datetime import datetime
from pathlib import Path

from ai_video_workflow.assets.registration import publish_bytes
from ai_video_workflow.digests import file_sha256
from ai_video_workflow.errors import OverwriteRefusedError
from ai_video_workflow.media.assets import MediaAsset, build_asset, publish_asset
from ai_video_workflow.media.batch import (
    Candidate,
    GenerationBatch,
    build_batch,
    load_batch,
    load_selection,
    publish_batch,
)
from ai_video_workflow.media.errors import (
    MediaNotFoundError,
    MediaProviderError,
    MediaValidationError,
)
from ai_video_workflow.media.provider import (
    MEDIA_CAPABILITIES,
    MEDIA_KIND_EXT,
    MEDIA_KINDS,
    MediaProviderRegistry,
    MediaRequest,
    MediaStatus,
    capability_allows_kind,
)
from ai_video_workflow.security.paths import resolve_within_root

MEDIA_STAGING_DIR = "staging/media"
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def _result_bytes(result, fetcher, project_root: Path) -> tuple[bytes, bool]:
    """Resolve a successful result to (bytes, was_fetched): inline content, or a
    fetched external reference through the unified staging/collect boundary."""
    if result.content is not None:
        return result.content, False
    if result.external_ref is not None:
        if fetcher is None:
            raise MediaProviderError(
                "result carries an external_ref but no fetcher was provided"
            )
        if not (
            result.external_ref.startswith("https://")
            or result.external_ref.startswith("http://")
        ):
            raise MediaProviderError("external_ref must be an http(s) URL")
        # NOTE: the injected fetcher is the download security boundary (scheme
        # allowlist, post-redirect re-check, size cap) — the SAME boundary the
        # WFM1 video paid path uses. Connection-time SSRF hardening (blocking
        # loopback/private/metadata IPs) is a SHARED fetcher concern for both
        # video and media, tracked as a follow-up, not duplicated here.
        tmp_dir = resolve_within_root(project_root, f"{MEDIA_STAGING_DIR}/.fetch-tmp")
        tmp_dir.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=tmp_dir, prefix="fetch-")
        os.close(fd)
        tmp = Path(name)
        tmp.unlink()  # hand the fetcher a free path (it writes create-only)
        try:
            fetcher.fetch(result.external_ref, tmp)
            return tmp.read_bytes(), True
        finally:
            try:
                tmp.unlink()
            except OSError:  # pragma: no cover - best-effort temp cleanup
                pass
    raise MediaProviderError("result has neither content nor external_ref")


def _staging_relpath(batch_id: str, candidate_id: str, ext: str) -> str:
    # Keyed by the UNIQUE batch_id so two generations never share a staging path
    # (batch publish is create-only, so batch_ids are unique) — reusing an
    # operation/candidate id with different content can never collide.
    return f"{MEDIA_STAGING_DIR}/{batch_id}/{candidate_id}.{ext}"


def _stage_bytes(
    project_root: Path, batch_id: str, candidate_id: str, ext: str, content: bytes
) -> tuple[Candidate, bool]:
    """Stage bytes; return the candidate and whether THIS call wrote a new file.

    ``publish_bytes`` reuses an identical existing file; only a freshly WRITTEN
    file is safe to roll back on failure (a reused one belongs to an already
    published batch/asset and must never be destroyed).
    """
    relpath = _staging_relpath(batch_id, candidate_id, ext)
    dest = resolve_within_root(project_root, relpath)
    dest.parent.mkdir(parents=True, exist_ok=True)
    outcome = publish_bytes(dest, content)  # "written" | "reused"
    candidate = Candidate(
        candidate_id=candidate_id,
        staging_path=relpath,
        media_sha256=file_sha256(dest),
        size_bytes=dest.stat().st_size,
    )
    return candidate, outcome == "written"


def generate_batch(
    project_root: Path,
    *,
    registry: MediaProviderRegistry,
    provider_id: str,
    operation_id: str,
    batch_id: str,
    capability: str,
    media_kind: str,
    prompt: str,
    model_id: str,
    candidate_ids: Sequence[str],
    clock,
    parameters: Mapping[str, object] = {},
    input_refs: Sequence[Mapping] = (),
    fetcher=None,
) -> GenerationBatch:
    """Run the provider per candidate, stage all results, publish the batch.

    A provider returns either inline ``content`` (local synthesis) or an
    ``external_ref`` (a cloud download reference); the latter is fetched into
    staging via the injected ``fetcher`` (the unified staging/collect boundary),
    so a temporary URL is never a product identity. Offline stub runs need no
    fetcher.
    """
    if not candidate_ids:
        raise MediaValidationError("at least one candidate id is required")
    # Validate EVERY id/kind/capability BEFORE anything is staged, so a crafted
    # operation_id/candidate_id can never write a file outside staging/media.
    if media_kind not in MEDIA_KINDS:
        raise MediaValidationError(f"unknown media kind: {media_kind!r}")
    if capability not in MEDIA_CAPABILITIES:
        raise MediaValidationError(f"unknown media capability: {capability!r}")
    if not capability_allows_kind(capability, media_kind):
        raise MediaValidationError(
            f"capability {capability!r} cannot produce media kind {media_kind!r}"
        )
    for name, value in (
        ("operation_id", operation_id),
        ("batch_id", batch_id),
        ("provider_id", provider_id),
        ("model_id", model_id),
    ):
        if not (isinstance(value, str) and _ID_RE.match(value)):
            raise MediaValidationError(f"{name} invalid: {value!r}")
    for candidate_id in candidate_ids:
        if not (isinstance(candidate_id, str) and _ID_RE.match(candidate_id)):
            raise MediaValidationError(f"candidate id invalid: {candidate_id!r}")
    if len(set(candidate_ids)) != len(candidate_ids):
        raise MediaValidationError("candidate ids must be unique (nothing staged)")
    if not isinstance(parameters, Mapping):
        raise MediaValidationError("parameters must be an object")
    if not isinstance(input_refs, (list, tuple)):
        raise MediaValidationError("input_refs must be a list")
    from ai_video_workflow.media.assets import _parse_input_ref

    req_refs = [_parse_input_ref(r).to_dict() for r in input_refs]

    def _matches(existing: GenerationBatch) -> bool:
        return (
            existing.operation_id == operation_id
            and existing.provider_id == provider_id
            and existing.model_id == model_id
            and existing.capability == capability
            and existing.media_kind == media_kind
            and existing.prompt == prompt
            and [c.candidate_id for c in existing.candidates] == list(candidate_ids)
            and dict(existing.parameters) == dict(parameters)
            and [dict(r) for r in existing.input_refs] == req_refs
        )

    # Idempotent resume: a batch_id already published for the SAME request is
    # returned as-is (a completed generation step reruns safely after an
    # interruption); a different request under the same id is a conflict.
    try:
        existing = load_batch(project_root, batch_id)
    except MediaNotFoundError:
        existing = None
    if existing is not None:
        if not _matches(existing):
            raise MediaValidationError(
                f"batch_id {batch_id!r} already exists with a different request"
            )
        return existing
    provider = registry.resolve(provider_id, capability)  # fail-closed
    ext = MEDIA_KIND_EXT[media_kind]
    observed_at: datetime = clock()
    candidates: list[Candidate] = []
    staged: list[Path] = []
    try:
        for candidate_id in candidate_ids:
            # candidate index varies the request so the stub yields distinct bytes
            request = MediaRequest(
                provider_id=provider_id,
                operation_id=operation_id,
                capability=capability,
                media_kind=media_kind,
                prompt=prompt,
                model_id=model_id,
                parameters={**dict(parameters), "candidate_id": candidate_id},
                input_refs=list(input_refs),
            )
            result = provider.generate(request, observed_at=observed_at)
            if result.provider_id != provider_id or result.operation_id != operation_id:
                raise MediaProviderError(
                    "provider result identity does not match the request "
                    f"(got {result.provider_id!r}/{result.operation_id!r})"
                )
            if result.status is not MediaStatus.SUCCEEDED:
                raise MediaProviderError(
                    f"media generation did not succeed for candidate "
                    f"{candidate_id!r}: {result.status.value}"
                )
            content, was_fetched = _result_bytes(result, fetcher, project_root)
            candidate, wrote = _stage_bytes(
                project_root, batch_id, candidate_id, ext, content
            )
            candidates.append(candidate)
            media_path = resolve_within_root(project_root, candidate.staging_path)
            if wrote:  # only roll back files THIS call created, never reused ones
                staged.append(media_path)
            if was_fetched:
                # retain the trusted-download receipt beside the staged media so
                # cloud-download provenance stays auditable
                receipt = Path(str(media_path) + ".fetched.json")
                receipt.write_text(
                    json.dumps({"sha256": candidate.media_sha256}, sort_keys=True)
                    + "\n",
                    encoding="utf-8",
                )
                if wrote:
                    staged.append(receipt)
        batch = build_batch(
            batch_id=batch_id,
            operation_id=operation_id,
            provider_id=provider_id,
            model_id=model_id,
            capability=capability,
            media_kind=media_kind,
            prompt=prompt,
            candidates=[c.to_dict() for c in candidates],
            parameters=dict(parameters),
            input_refs=list(input_refs),
        )
        try:
            publish_batch(project_root, batch)
        except OverwriteRefusedError:
            # A concurrent/prior call already published this batch_id: the staged
            # files are now owned by ITS batch. Do NOT roll them back (that would
            # corrupt the winner's candidates); return the winner if it matches.
            winner = load_batch(project_root, batch_id)
            if not _matches(winner):
                raise MediaValidationError(
                    f"batch_id {batch_id!r} already exists with a different request"
                ) from None
            return winner
    except Exception:
        # A partial batch leaves no orphaned staging behind — a retry with the
        # same operation/candidate ids can freely re-stage.
        for path in staged:
            try:
                path.unlink()
            except OSError:  # pragma: no cover - best-effort cleanup
                pass
        raise
    return batch


def promote_selection(
    project_root: Path,
    *,
    ref: str,
    version: int,
    selection_id: str,
    input_refs: Sequence[Mapping] = (),
    parent_version: int | None = None,
    change_reason: str | None = None,
) -> MediaAsset:
    """Publish the SELECTED candidate as a formal media asset (batch retained).

    The generation's declared ``input_refs`` (recorded on the batch) are carried
    onto the asset — so a promoted asset never loses its upstream lineage — plus
    any extra refs the caller supplies. publish_asset resolves + digest-verifies
    all of them.
    """
    selection = load_selection(project_root, selection_id)
    batch = load_batch(project_root, selection.batch_id)
    candidate = batch.candidate(selection.selected_candidate_id)
    merged = [dict(r) for r in batch.input_refs] + [dict(r) for r in input_refs]
    asset = build_asset(
        media_kind=batch.media_kind,
        ref=ref,
        version=version,
        producer={
            "source": "generation",
            "operation_id": batch.operation_id,
            "provider_id": batch.provider_id,
            "model_id": batch.model_id,
            "parameters": dict(batch.parameters),
            # record WHICH user selection authorized this asset (a batch may have
            # several selections) so the lineage is unambiguously auditable.
            "selection_id": selection.selection_id,
            "candidate_id": selection.selected_candidate_id,
        },
        media_path=candidate.staging_path,
        media_sha256=candidate.media_sha256,
        size_bytes=candidate.size_bytes,
        input_refs=merged,
        batch_id=batch.batch_id,
        parent_version=parent_version,
        change_reason=change_reason,
    )
    publish_asset(project_root, asset)
    return asset

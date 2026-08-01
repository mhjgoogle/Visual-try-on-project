"""Pre-flight budget reservations (TASK-014 contract 4).

A reservation is a durable *operational hold* placed **before** a
generation call, so concurrent or replayed attempts cannot double-spend
and a crash cannot lose an in-flight commitment. It is **not** a cost
fact (cost facts live in the QCD log) and it is **not** derived from the
frozen ``ProviderCostObservation``.

- **Idempotent dedup**: a reservation is keyed by ``(task_id,
  operation_id)`` and stored at ``budget/reservations/<task_id>/
  <operation_id>.json``. Re-holding the same operation returns the
  existing record; re-holding with a different estimate/provider/model
  is a conflict.
- **Lifecycle**: ``held → committed`` (an authoritative cost was
  recorded) or ``held → released`` (definitively no charge). An
  indeterminate hold becomes ``needs_reconciliation`` for a human.
- **Pre-flight total**: outstanding holds (``held`` +
  ``needs_reconciliation``) are added to committed spend when the guard
  decides, so budget cannot be bypassed by concurrency.
- **Crash recovery**: ``reconcile_reservations`` resolves outstanding
  holds against known actual costs and known failures; anything else is
  flagged for manual reconciliation (never silently released).

No clock is read here: ``created_at`` / ``resolved_at`` are supplied by
the caller (the M1 time-authority rule).
"""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from ai_video_workflow.budget.errors import ReservationError
from ai_video_workflow.security.paths import resolve_within_root

RESERVATIONS_DIR = "budget/reservations"
RESERVATION_SCHEMA_VERSION = 3

HELD = "held"
COMMITTED = "committed"
RELEASED = "released"
NEEDS_RECONCILIATION = "needs_reconciliation"

_STATUSES = frozenset({HELD, COMMITTED, RELEASED, NEEDS_RECONCILIATION})
# Holds still counted against the budget in pre-flight decisions.
_OUTSTANDING = frozenset({HELD, NEEDS_RECONCILIATION})
# Reservation schema history. Older records on disk stay readable: a v1/v2
# record parses with its newer fields as None (no stored quote -> no
# automatic fixed-price booking, but media recovery and manual
# reconciliation still work). Any rewrite upgrades the record to the
# current version.
_V1_KEYS = frozenset(
    {
        "schema_version",
        "reservation_id",
        "project_id",
        "task_id",
        "operation_id",
        "shot_id",
        "provider_id",
        "model_id",
        "estimate_jpy",
        "status",
        "created_at",
        "resolved_at",
        "note",
    }
)
_V2_KEYS = _V1_KEYS | {"external_task_ref"}
_V3_KEYS = _V2_KEYS | {
    "resolution",
    "duration_seconds",
    "capability",
    "quote_minor_units",
    "quote_currency",
}
_KEYS_BY_VERSION = {1: _V1_KEYS, 2: _V2_KEYS, 3: _V3_KEYS}


@dataclass(frozen=True, slots=True)
class Reservation:
    """One durable pre-flight budget hold."""

    schema_version: int
    reservation_id: str
    project_id: str
    task_id: str
    operation_id: str
    shot_id: str | None
    provider_id: str
    model_id: str
    estimate_jpy: int
    status: str
    created_at: str
    resolved_at: str | None
    note: str | None
    external_task_ref: str | None = None
    # The bound generation spec + original-currency quote, so a resumed
    # operation is booked from the record, never re-priced from re-entered
    # CLI parameters.
    resolution: str | None = None
    duration_seconds: int | None = None
    capability: str | None = None
    quote_minor_units: int | None = None
    quote_currency: str | None = None

    @property
    def is_outstanding(self) -> bool:
        return self.status in _OUTSTANDING


@dataclass(frozen=True, slots=True)
class HeldSummary:
    """Outstanding hold totals, in yen."""

    total_jpy: int
    per_shot_jpy: dict[str, int]

    def shot_held(self, shot_id: str) -> int:
        return self.per_shot_jpy.get(shot_id, 0)


@dataclass(frozen=True, slots=True)
class ReconcileResult:
    """Outcome of a reservation reconciliation pass."""

    committed: tuple[tuple[str, str], ...]
    released: tuple[tuple[str, str], ...]
    needs_reconciliation: tuple[tuple[str, str], ...]


def reservation_relpath(task_id: str, operation_id: str) -> str:
    """Return the project-relative path of a reservation record."""
    _require_key_component(task_id, "task_id")
    _require_key_component(operation_id, "operation_id")
    return f"{RESERVATIONS_DIR}/{task_id}/{operation_id}.json"


def reservation_id_for(task_id: str, operation_id: str) -> str:
    return f"resv:{task_id}:{operation_id}"


def hold_reservation(
    project_root: Path,
    *,
    project_id: str,
    task_id: str,
    operation_id: str,
    shot_id: str | None,
    provider_id: str,
    model_id: str,
    estimate_jpy: int,
    created_at: str,
    note: str | None = None,
    resolution: str | None = None,
    duration_seconds: int | None = None,
    capability: str | None = None,
    quote_minor_units: int | None = None,
    quote_currency: str | None = None,
) -> Reservation:
    """Place a pre-flight hold, idempotently.

    Returns the existing reservation if one already exists for
    ``(task_id, operation_id)`` with matching estimate/provider/model
    (dedup); raises ``ReservationError`` on a conflicting re-hold.
    """
    _require_non_negative_int(estimate_jpy, "estimate_jpy")
    existing = load_reservation(project_root, task_id, operation_id)
    if existing is not None:
        if (
            existing.estimate_jpy != estimate_jpy
            or existing.provider_id != provider_id
            or existing.model_id != model_id
        ):
            raise ReservationError(
                f"conflicting re-hold for ({task_id!r}, {operation_id!r}): "
                "estimate/provider/model differ from the existing reservation"
            )
        return existing

    reservation = Reservation(
        schema_version=RESERVATION_SCHEMA_VERSION,
        reservation_id=reservation_id_for(task_id, operation_id),
        project_id=_require_str(project_id, "project_id"),
        task_id=task_id,
        operation_id=operation_id,
        shot_id=None if shot_id is None else _require_str(shot_id, "shot_id"),
        provider_id=_require_str(provider_id, "provider_id"),
        model_id=_require_str(model_id, "model_id"),
        estimate_jpy=estimate_jpy,
        status=HELD,
        created_at=_require_str(created_at, "created_at"),
        resolved_at=None,
        note=note,
        external_task_ref=None,
        resolution=resolution,
        duration_seconds=duration_seconds,
        capability=capability,
        quote_minor_units=quote_minor_units,
        quote_currency=quote_currency,
    )
    _write(project_root, reservation, overwrite=False)
    return reservation


def record_external_task_ref(
    project_root: Path, task_id: str, operation_id: str, external_task_ref: str
) -> Reservation:
    """Persist the provider's external task id onto a held reservation.

    Called immediately after a successful submit so a crash before the
    media is collected never loses the external task id (the media can be
    re-polled/collected later without re-submitting or re-paying).
    """
    reservation = load_reservation(project_root, task_id, operation_id)
    if reservation is None:
        raise ReservationError(f"no reservation for ({task_id!r}, {operation_id!r})")
    updated = _with_fields(
        reservation,
        external_task_ref=_require_str(external_task_ref, "external_task_ref"),
    )
    _write(project_root, updated, overwrite=True)
    return updated


def load_reservation(
    project_root: Path, task_id: str, operation_id: str
) -> Reservation | None:
    """Return a reservation, or ``None`` if it does not exist."""
    path = resolve_within_root(project_root, reservation_relpath(task_id, operation_id))
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError) as exc:
        raise ReservationError(f"unable to read reservation: {path}") from exc
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise ReservationError(f"reservation is not valid JSON: {path}") from exc
    return parse_reservation(raw)


def commit_reservation(
    project_root: Path, task_id: str, operation_id: str, *, resolved_at: str
) -> Reservation:
    """Transition a hold to ``committed`` (an authoritative cost exists)."""
    return _resolve(project_root, task_id, operation_id, COMMITTED, resolved_at, None)


def release_reservation(
    project_root: Path,
    task_id: str,
    operation_id: str,
    *,
    resolved_at: str,
    note: str | None = None,
) -> Reservation:
    """Transition a hold to ``released`` (definitively no charge)."""
    return _resolve(project_root, task_id, operation_id, RELEASED, resolved_at, note)


def mark_needs_reconciliation(
    project_root: Path,
    task_id: str,
    operation_id: str,
    *,
    note: str,
) -> Reservation:
    """Flag an indeterminate hold for manual reconciliation."""
    return _resolve(
        project_root, task_id, operation_id, NEEDS_RECONCILIATION, None, note
    )


def list_reservations(project_root: Path) -> tuple[Reservation, ...]:
    """Return every reservation under the project, sorted by path."""
    root = resolve_within_root(project_root, RESERVATIONS_DIR)
    if not root.is_dir():
        return ()
    records: list[Reservation] = []
    for path in sorted(root.glob("*/*.json")):
        try:
            text = path.read_text(encoding="utf-8")
            raw = json.loads(text)
        except (OSError, UnicodeError, ValueError) as exc:
            raise ReservationError(f"unable to read reservation: {path}") from exc
        records.append(parse_reservation(raw))
    return tuple(records)


def outstanding_holds(project_root: Path) -> HeldSummary:
    """Sum outstanding holds (held + needs_reconciliation), overall and per shot."""
    total = 0
    per_shot: dict[str, int] = {}
    for reservation in list_reservations(project_root):
        if not reservation.is_outstanding:
            continue
        total += reservation.estimate_jpy
        if reservation.shot_id is not None:
            per_shot[reservation.shot_id] = (
                per_shot.get(reservation.shot_id, 0) + reservation.estimate_jpy
            )
    return HeldSummary(total_jpy=total, per_shot_jpy=per_shot)


def shot_consecutive_failures(project_root: Path, shot_id: str) -> int:
    """Count a shot's consecutive released (clean-failed) reservations.

    Derived from persisted reservations only (never a caller-supplied
    number): the run of ``released`` reservations for the shot ending at
    the most recent one, reset by any ``committed`` (successful) attempt.
    Ordered by ``created_at`` then ``operation_id``.
    """
    shot_res = [r for r in list_reservations(project_root) if r.shot_id == shot_id]
    shot_res.sort(key=lambda r: (r.created_at, r.operation_id))
    count = 0
    for reservation in reversed(shot_res):
        if reservation.status == COMMITTED:
            break
        if reservation.status == RELEASED:
            count += 1
    return count


def reconcile_reservations(
    project_root: Path,
    *,
    committed_operations: Iterable[tuple[str, str]],
    failed_operations: Iterable[tuple[str, str]],
    resolved_at: str,
) -> ReconcileResult:
    """Resolve outstanding holds after a crash.

    A held operation with a known authoritative cost is committed; one
    known to have failed with no charge is released; anything else is
    flagged ``needs_reconciliation`` (never silently released).
    """
    committed_set = {tuple(op) for op in committed_operations}
    failed_set = {tuple(op) for op in failed_operations}
    committed: list[tuple[str, str]] = []
    released: list[tuple[str, str]] = []
    flagged: list[tuple[str, str]] = []

    for reservation in list_reservations(project_root):
        if reservation.status != HELD:
            continue
        key = (reservation.task_id, reservation.operation_id)
        if key in committed_set:
            commit_reservation(project_root, key[0], key[1], resolved_at=resolved_at)
            committed.append(key)
        elif key in failed_set:
            release_reservation(
                project_root,
                key[0],
                key[1],
                resolved_at=resolved_at,
                note="reconcile: operation failed with no charge",
            )
            released.append(key)
        else:
            mark_needs_reconciliation(
                project_root,
                key[0],
                key[1],
                note="reconcile: outstanding hold with no known outcome",
            )
            flagged.append(key)

    return ReconcileResult(
        committed=tuple(committed),
        released=tuple(released),
        needs_reconciliation=tuple(flagged),
    )


def parse_reservation(raw: object) -> Reservation:
    """Build a ``Reservation`` from already-parsed JSON data.

    Accepts every historical schema version (1..current); fields a version
    did not have parse as ``None``, so pre-existing holds stay readable,
    budget scans never fail on old records, and a persisted
    ``external_task_ref`` from a v2 record remains recoverable.
    """
    if not isinstance(raw, dict):
        raise ReservationError(
            f"reservation: expected a JSON object, got {type(raw).__name__}"
        )
    version = raw.get("schema_version")
    if isinstance(version, bool) or not isinstance(version, int):
        raise ReservationError("reservation: schema_version must be an int")
    allowed = _KEYS_BY_VERSION.get(version)
    if allowed is None:
        raise ReservationError(f"reservation: unsupported version {version}")

    actual = frozenset(raw)
    missing = allowed - actual
    if missing:
        raise ReservationError(f"reservation: missing keys {sorted(missing)}")
    unknown = actual - allowed
    if unknown:
        raise ReservationError(f"reservation: unknown keys {sorted(unknown)}")

    status = raw["status"]
    if status not in _STATUSES:
        raise ReservationError(f"reservation: unknown status {status!r}")
    estimate = raw["estimate_jpy"]
    _require_non_negative_int(estimate, "estimate_jpy")

    return Reservation(
        schema_version=version,
        reservation_id=_require_str(raw["reservation_id"], "reservation_id"),
        project_id=_require_str(raw["project_id"], "project_id"),
        task_id=_require_str(raw["task_id"], "task_id"),
        operation_id=_require_str(raw["operation_id"], "operation_id"),
        shot_id=_optional_str(raw["shot_id"], "shot_id"),
        provider_id=_require_str(raw["provider_id"], "provider_id"),
        model_id=_require_str(raw["model_id"], "model_id"),
        estimate_jpy=estimate,
        status=status,
        created_at=_require_str(raw["created_at"], "created_at"),
        resolved_at=_optional_str(raw["resolved_at"], "resolved_at"),
        note=_optional_str(raw["note"], "note"),
        external_task_ref=_optional_str(
            raw.get("external_task_ref"), "external_task_ref"
        ),
        resolution=_optional_str(raw.get("resolution"), "resolution"),
        duration_seconds=_optional_int(raw.get("duration_seconds"), "duration_seconds"),
        capability=_optional_str(raw.get("capability"), "capability"),
        quote_minor_units=_optional_int(
            raw.get("quote_minor_units"), "quote_minor_units"
        ),
        quote_currency=_optional_str(raw.get("quote_currency"), "quote_currency"),
    )


# --- internals ------------------------------------------------------------


def _with_fields(reservation: Reservation, **overrides) -> Reservation:
    fields = _to_dict(reservation)
    fields.pop("schema_version")
    fields.update(overrides)
    # Any rewrite serializes every current field, so the stored record is
    # upgraded to the current schema version (older versions stay readable
    # via parse_reservation's multi-version key sets).
    return Reservation(schema_version=RESERVATION_SCHEMA_VERSION, **fields)


def _resolve(
    project_root: Path,
    task_id: str,
    operation_id: str,
    target_status: str,
    resolved_at: str | None,
    note: str | None,
) -> Reservation:
    reservation = load_reservation(project_root, task_id, operation_id)
    if reservation is None:
        raise ReservationError(
            f"no reservation for ({task_id!r}, {operation_id!r}) to "
            f"transition to {target_status!r}"
        )
    if reservation.status == target_status:
        return reservation  # idempotent
    # Legal transitions are only from an outstanding hold.
    if reservation.status in (COMMITTED, RELEASED):
        raise ReservationError(
            f"reservation ({task_id!r}, {operation_id!r}) is already "
            f"{reservation.status!r}; cannot transition to {target_status!r}"
        )
    updated = _with_fields(
        reservation,
        status=target_status,
        resolved_at=resolved_at,
        note=note if note is not None else reservation.note,
    )
    _write(project_root, updated, overwrite=True)
    return updated


def _to_dict(reservation: Reservation) -> dict:
    return {
        "schema_version": reservation.schema_version,
        "reservation_id": reservation.reservation_id,
        "project_id": reservation.project_id,
        "task_id": reservation.task_id,
        "operation_id": reservation.operation_id,
        "shot_id": reservation.shot_id,
        "provider_id": reservation.provider_id,
        "model_id": reservation.model_id,
        "estimate_jpy": reservation.estimate_jpy,
        "status": reservation.status,
        "created_at": reservation.created_at,
        "resolved_at": reservation.resolved_at,
        "note": reservation.note,
        "external_task_ref": reservation.external_task_ref,
        "resolution": reservation.resolution,
        "duration_seconds": reservation.duration_seconds,
        "capability": reservation.capability,
        "quote_minor_units": reservation.quote_minor_units,
        "quote_currency": reservation.quote_currency,
    }


def _write(project_root: Path, reservation: Reservation, *, overwrite: bool) -> None:
    path = resolve_within_root(
        project_root,
        reservation_relpath(reservation.task_id, reservation.operation_id),
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (
        json.dumps(
            _to_dict(reservation),
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")
    raw_fd, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(raw_fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        if overwrite:
            os.replace(temporary_path, path)
        else:
            try:
                os.link(temporary_path, path)
            except FileExistsError as exc:
                raise ReservationError(
                    f"refusing to overwrite existing reservation: {path}"
                ) from exc
    finally:
        try:
            temporary_path.unlink()
        except OSError:
            pass


def _require_key_component(value: object, name: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ReservationError(f"{name}: expected a non-empty, trimmed string")
    if "/" in value or "\\" in value or value in (".", ".."):
        raise ReservationError(f"{name}: {value!r} is not a valid path component")
    return value


def _require_str(value: object, name: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ReservationError(f"{name}: expected a non-empty, trimmed string")
    return value


def _optional_str(value: object, name: str) -> str | None:
    if value is None:
        return None
    return _require_str(value, name)


def _optional_int(value: object, name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ReservationError(f"{name}: expected an int or null")
    return value


def _require_non_negative_int(value: object, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ReservationError(f"{name}: expected a non-negative int")
    if value < 0:
        raise ReservationError(f"{name}: must not be negative")

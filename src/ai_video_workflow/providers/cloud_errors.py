"""Typed errors for cloud video providers (TASK-016).

New file (the frozen ``providers/errors.py`` is not modified): a small
error tree under the existing ``ProviderError`` so callers keep the
project's typed-error discipline and can distinguish *technical* failures
(network, timeout, auth, vendor) — which may trigger a fallback — from
contract failures.

Credential material must never appear in any of these messages.
"""

from __future__ import annotations

from ai_video_workflow.providers.errors import ProviderError


class CloudProviderError(ProviderError):
    """Base error for cloud provider failures."""


class ProviderNetworkError(CloudProviderError):
    """Raised on a network failure whose remote side-effect is *unknown*.

    A generic network error does NOT prove the request was never received,
    so the coordinator treats a submit-phase ``ProviderNetworkError`` as an
    ambiguous (possibly-charged) result, not a safe retry. Use
    ``ProviderNotDispatchedError`` only when it is provable the request was
    never sent or accepted.
    """


class ProviderNotDispatchedError(ProviderNetworkError):
    """Raised only when the request provably never reached the provider.

    E.g. a connection that was never established (DNS failure, connection
    refused) *before* any bytes were sent. This is the only network
    condition that proves no remote side-effect, so it is safe to release
    a reservation and fall back.
    """


class ProviderTimeoutError(CloudProviderError):
    """Raised when a provider request exceeds its deadline.

    A timeout is ambiguous: the request may have been received and the job
    may be charged. It never proves no side-effect.
    """


class ProviderAuthError(CloudProviderError):
    """Raised when credentials are missing, rejected, or unauthorized.

    Auth is rejected *before* a job is created, so it proves no charge.
    """


class ProviderVendorError(CloudProviderError):
    """Raised when the provider reports a generation/vendor-side failure.

    By default the charge state is *unknown*: a failed job may or may not
    be billed depending on the vendor, so the generic vendor error is
    ambiguous. Only ``ProviderNoChargeFailureError`` asserts no charge.
    """


class ProviderNoChargeFailureError(ProviderVendorError):
    """A vendor failure the provider *definitively* knows was not charged.

    Providers must raise this (instead of the generic vendor error) only
    when the vendor contract guarantees no charge for this failure, making
    it safe to release the reservation and fall back.
    """


class ProviderResponseError(CloudProviderError):
    """Raised when the provider returns a malformed or unusable response.

    After submit, a malformed response leaves the charge state unknown."""


class ProviderRequestRejectedError(CloudProviderError):
    """The provider rejected the request pre-generation (no job, no charge).

    E.g. invalid parameters or insufficient balance. No remote job was
    created, so there is nothing to reconcile — but the request is bad or
    unpayable, so it must NOT fall back to another paid provider. The
    coordinator releases the reservation and stops.
    """

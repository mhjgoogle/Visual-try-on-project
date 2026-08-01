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
    """Raised when the provider cannot be reached (connection failure)."""


class ProviderTimeoutError(CloudProviderError):
    """Raised when a provider request exceeds its deadline."""


class ProviderAuthError(CloudProviderError):
    """Raised when credentials are missing, rejected, or unauthorized."""


class ProviderVendorError(CloudProviderError):
    """Raised when the provider reports a generation/vendor-side failure."""


class ProviderResponseError(CloudProviderError):
    """Raised when the provider returns a malformed or unusable response."""

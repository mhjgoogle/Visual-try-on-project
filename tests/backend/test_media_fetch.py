"""Tests for the hardened media fetcher (TASK-017 review)."""

from __future__ import annotations

import urllib.error
from pathlib import Path

import pytest

from ai_video_workflow.app.media_fetch import MediaFetchError, UrllibMediaFetcher


class _FakeHTTP:
    def __init__(
        self, data: bytes, *, url="https://x/out.mp4", content_type="video/mp4"
    ):
        self._data = data
        self._pos = 0
        self._url = url
        self.headers = {"Content-Type": content_type}

    def read(self, size=-1):
        if size is None or size < 0:
            chunk = self._data[self._pos :]
            self._pos = len(self._data)
            return chunk
        chunk = self._data[self._pos : self._pos + size]
        self._pos += len(chunk)
        return chunk

    def geturl(self):
        return self._url

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _patch(monkeypatch, resp=None, raises=None):
    def _fake(reference, timeout=None):
        if raises is not None:
            raise raises
        return resp

    monkeypatch.setattr("urllib.request.urlopen", _fake)


def test_fetch_writes_media(tmp_path: Path, monkeypatch) -> None:
    _patch(monkeypatch, resp=_FakeHTTP(b"video-bytes"))
    dest = tmp_path / "staging" / "out.mp4"
    UrllibMediaFetcher().fetch("https://x/out.mp4", dest)
    assert dest.read_bytes() == b"video-bytes"


def test_non_http_scheme_rejected(tmp_path: Path) -> None:
    with pytest.raises(MediaFetchError, match="scheme"):
        UrllibMediaFetcher().fetch("file:///etc/passwd", tmp_path / "x.mp4")


def test_refuses_to_overwrite(tmp_path: Path, monkeypatch) -> None:
    _patch(monkeypatch, resp=_FakeHTTP(b"new"))
    dest = tmp_path / "out.mp4"
    dest.write_bytes(b"existing film")
    with pytest.raises(MediaFetchError, match="overwrite"):
        UrllibMediaFetcher().fetch("https://x/out.mp4", dest)
    assert dest.read_bytes() == b"existing film"  # untouched


def test_redirect_to_non_http_rejected(tmp_path: Path, monkeypatch) -> None:
    _patch(monkeypatch, resp=_FakeHTTP(b"x", url="ftp://evil/x"))
    with pytest.raises(MediaFetchError, match="redirected"):
        UrllibMediaFetcher().fetch("https://x/out.mp4", tmp_path / "out.mp4")


def test_bad_content_type_rejected(tmp_path: Path, monkeypatch) -> None:
    _patch(monkeypatch, resp=_FakeHTTP(b"<html>", content_type="text/html"))
    with pytest.raises(MediaFetchError, match="content type"):
        UrllibMediaFetcher().fetch("https://x/out.mp4", tmp_path / "out.mp4")


def test_size_cap_enforced(tmp_path: Path, monkeypatch) -> None:
    _patch(monkeypatch, resp=_FakeHTTP(b"x" * 100))
    dest = tmp_path / "out.mp4"
    with pytest.raises(MediaFetchError, match="size cap"):
        UrllibMediaFetcher(max_bytes=10).fetch("https://x/out.mp4", dest)
    assert not dest.exists()  # partial download never published


def test_network_error_wrapped(tmp_path: Path, monkeypatch) -> None:
    _patch(monkeypatch, raises=urllib.error.URLError("down"))
    with pytest.raises(MediaFetchError, match="failed to fetch"):
        UrllibMediaFetcher().fetch("https://x/out.mp4", tmp_path / "out.mp4")


def test_empty_download_rejected(tmp_path: Path, monkeypatch) -> None:
    _patch(monkeypatch, resp=_FakeHTTP(b""))
    dest = tmp_path / "out.mp4"
    with pytest.raises(MediaFetchError, match="empty"):
        UrllibMediaFetcher().fetch("https://x/out.mp4", dest)
    assert not dest.exists()

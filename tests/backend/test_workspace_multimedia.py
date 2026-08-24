"""Tests for the WFM2 multimedia Workspace projection (WQ-19 / TASK-039)."""

from __future__ import annotations

import hashlib
import json

from ai_video_workflow.media import assets as media_assets
from ai_video_workflow.postproduction import index as pp
from ai_video_workflow.workspace import queries
from ai_video_workflow.workspace.envelope import Provenance

NOW = "2026-08-04T10:00:00+00:00"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _media(root, kind, ref, body=b"bytes"):
    rel = f"media/imported/{kind}/{ref}.bin"
    (root / rel).parent.mkdir(parents=True, exist_ok=True)
    (root / rel).write_bytes(body + ref.encode())
    asset = media_assets.build_asset(
        media_kind=kind,
        ref=ref,
        version=1,
        producer={"source": "external", "note": "n"},
        media_path=rel,
        media_sha256=_sha((root / rel).read_bytes()),
        size_bytes=(root / rel).stat().st_size,
    )
    media_assets.publish_asset(root, asset)
    return asset


def _seed(root):
    _media(root, "keyframe", "kf1")
    _media(root, "voiceover", "vo1")
    _media(root, "subtitle", "sub1")
    _media(root, "master", "m1")
    art = pp.build_artifact(
        stage="s5", step_id="S5-T01", kind="assembly_timeline", ref="t", version=1
    )
    pp.publish_artifact(root, art)
    # a not_applicable S7 outcome (missing != zero) should be observable as such
    kp = pp.build_artifact(
        stage="s7",
        step_id="S7-T05",
        kind="knowledge_promotion",
        ref="kp",
        version=1,
        status="not_applicable",
        status_reason="nothing to promote",
    )
    pp.publish_artifact(root, kp)


def test_multimedia_projection_makes_media_observable(tmp_path) -> None:
    _seed(tmp_path)
    res = queries.project_multimedia(tmp_path, NOW)
    assert res.query_id == "WQ-19"
    assert res.contract_version == "1.6"
    # every field is AUTHORITATIVE (derived from the digest-bound indices) — no
    # media type is an "unavailable" WFM1 placeholder anymore
    for item in res.items:
        for f in item.values():
            assert f.provenance is Provenance.AUTHORITATIVE
    kinds = {
        item["media_kind"].value
        for item in res.items
        if item["domain"].value == "media_asset"
    }
    assert {"keyframe", "voiceover", "subtitle", "master"} <= kinds
    # the not_applicable S7 fact is projected with its status intact (P7)
    kp = [
        item
        for item in res.items
        if item["domain"].value == "postproduction" and item["ref"].value == "kp"
    ]
    assert kp and kp[0]["status"].value == "not_applicable"
    assert res.scope["media_asset_count"] == 4
    assert not res.problems


def test_multimedia_projection_is_deterministic(tmp_path) -> None:
    _seed(tmp_path)
    a = queries.project_multimedia(tmp_path, NOW)
    b = queries.project_multimedia(tmp_path, NOW)
    assert queries._comparable(a) == queries._comparable(b)


def test_corrupt_postproduction_fails_closed(tmp_path) -> None:
    _seed(tmp_path)
    # tamper a post-production index so its self-digest no longer matches
    path = tmp_path / pp.index_relpath("s5", "t", 1)
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["kind"] = "rough_cut"
    path.write_text(json.dumps(raw))
    res = queries.project_multimedia(tmp_path, NOW)
    assert res.readiness_failed
    assert any(p.category.value == "source_corrupt" for p in res.problems)


def test_corrupt_media_asset_fails_closed(tmp_path) -> None:
    _seed(tmp_path)
    # mutate a bound media file after registration -> digest mismatch on load
    (tmp_path / "media" / "imported" / "master" / "m1.bin").write_bytes(b"tampered")
    res = queries.project_multimedia(tmp_path, NOW)
    assert res.readiness_failed
    assert any(p.category.value == "source_corrupt" for p in res.problems)


def test_empty_project_has_no_media_but_does_not_fail(tmp_path) -> None:
    res = queries.project_multimedia(tmp_path, NOW)
    assert res.items == ()
    assert not res.problems
    assert res.scope["media_asset_count"] == 0


def test_only_generation_assets_carry_an_operation_id(tmp_path) -> None:
    """`producer_operation_id` 只属于 generation 来源（TASK-027 part-2b）。

    WQ-06 用它把媒体绑到 attempt 上 —— 那是一条**身份**绑定。绑错了，创作者
    在判断某个镜头时看到的是另一次操作产出的画面。

    今天 `_validate_producer` 的非 generation 分支构造的是**只含 `source` 与
    `note` 的新字典**（白名单，不是透传），所以这里本来就带不出 operation_id；
    这条测试把那个前提**钉住**，将来白名单被放宽时它会先红。
    """
    _media(tmp_path, "keyframe", "kf-manual")
    src = queries.multimedia.read_multimedia(tmp_path)
    assert src.media, "夹具必须真的有资产"
    for view in src.media:
        assert view.producer_source == "external"
        assert view.producer_operation_id is None, (
            f"非 generation 来源却带出了 operation_id：{view}"
        )


def test_a_non_generation_producer_cannot_smuggle_an_operation_id() -> None:
    """就算原始 JSON 里塞了 operation_id，非 generation 来源也**带不出来**。

    上一条测的是正常路径；这一条直接把字段塞进去，证明拦它的是**校验**，
    不是「没人往里写」。两条分开写：只有正常路径的话，任何一天有人开始写这个
    字段，绑定就会悄悄开始生效。
    """
    from ai_video_workflow.workspace.adapters.multimedia import _generation_operation

    smuggled = {"source": "external", "note": "n", "operation_id": "op-not-mine"}
    assert _generation_operation(smuggled) is None
    # 反向对照：generation 来源的确带得出来，否则上面的 None 可能只是函数坏了
    real = {"source": "generation", "operation_id": "op-1"}
    assert _generation_operation(real) == "op-1"

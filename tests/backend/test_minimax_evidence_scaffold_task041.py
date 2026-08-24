"""TASK-041 §4：真跑证据的**离线**前置。不花一分钱。

卡上第 4 项要的是「造一个含 minimax 的目录 + 给证据项目 re-lock digest」，
好让 coordinator 的前置能全绿。它是**离线搭建**，与第 3 项（真实付费调用）
是两件事 —— 后者要产品负责人放行（AGENTS.md §1：花钱是唯一必须问的）。

这份测试钉住的是那个搭建**真的成立**，而不是「文件写出来了」：

* 目录锁能验过（id / version / digest 三者一致）；
* `credential_env_vars` 恰好是那一个 —— registry 对其它任何写法 fail-closed；
* 价目就是卡上那个数（USD 0.28 / 768P / 6s）；
* **冻结的 `wfm1-demo` 一个字节没动**。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ai_video_workflow.budget.estimate import estimate_generation_cost
from ai_video_workflow.config.catalog import compute_catalog_digest
from ai_video_workflow.config.catalog_lock import load_locked_catalog
from ai_video_workflow.config.project_config import load_project_config
from ai_video_workflow.providers.cloud_minimax import (
    MINIMAX_CREDENTIAL_ENV,
    MINIMAX_PROVIDER_ID,
)
from ai_video_workflow.providers.registry import ProviderRegistryError, default_registry

_REPO = Path(__file__).resolve().parents[2]
_CATALOG_DIR = _REPO / "config" / "providers"
_CATALOG = _CATALOG_DIR / "wfm1-minimax.json"
_EVIDENCE = _REPO / "examples" / "projects" / "wfm1-minimax-evidence"
_FROZEN_DEMO = _REPO / "examples" / "projects" / "wfm1-demo"


@pytest.fixture(scope="module")
def catalog():
    config = load_project_config(_EVIDENCE)
    return config, load_locked_catalog(config, _CATALOG_DIR)


def test_the_evidence_project_locks_the_minimax_catalog(catalog) -> None:
    """锁验过 = id、version、digest 三者一致。任何一项对不上都会 raise。"""
    config, loaded = catalog
    assert config.catalog_id == "wfm1-minimax"
    assert config.default_provider == MINIMAX_PROVIDER_ID
    assert MINIMAX_PROVIDER_ID in loaded.providers


def test_the_recorded_digest_is_the_one_the_file_actually_hashes_to() -> None:
    """digest 是**从文件现算**的，不是抄下来的一串。

    这条会在有人改了目录却没重新 lock 时转红 —— 那正是目录锁存在的理由。
    """
    raw = json.loads(_CATALOG.read_text(encoding="utf-8"))
    config = load_project_config(_EVIDENCE)
    assert config.catalog_digest == compute_catalog_digest(raw)


def test_the_credential_env_var_is_exactly_the_sanctioned_one(catalog) -> None:
    """registry 对其它任何写法 fail-closed，免得一份配错的目录让 provider
    去读别的环境变量当令牌。"""
    _config, loaded = catalog
    entry = loaded.providers[MINIMAX_PROVIDER_ID]
    assert tuple(entry.credential_env_vars) == (MINIMAX_CREDENTIAL_ENV,)


def test_the_price_is_the_one_the_task_card_names(catalog) -> None:
    """USD 0.28 / 768P / 6s —— 卡上写死的那个数。

    它是**预检报价**的来源，也是要产品负责人放行的那笔钱的金额。
    """
    _config, loaded = catalog
    model = loaded.providers[MINIMAX_PROVIDER_ID].models["MiniMax-Hailuo-02"]
    assert model.billing_mode == "per_clip"
    assert model.currency == "USD"
    prices = [
        (p.resolution, p.duration_seconds, p.amount_minor_units)
        for p in model.clip_prices
    ]
    assert prices == [("768P", 6, 28)]


def test_the_model_declares_it_takes_no_reference_images(catalog) -> None:
    """ADR-0071 决策 4：**声明可选，规则不可选**。不声明 = max 0（fail-closed），
    这里显式写出来，因为 `cloud_minimax` 的 video_generation 本来就不收参考图 ——
    让目录说出这件事，而不是让读者去推断。"""
    _config, loaded = catalog
    model = loaded.providers[MINIMAX_PROVIDER_ID].models["MiniMax-Hailuo-02"]
    assert model.reference_images.max_images == 0
    assert model.reference_images.accepts_reference_images is False


def test_the_registry_builds_a_real_provider_from_the_locked_entry(catalog) -> None:
    """整条离线链走通：锁过的目录 → registry → 真的 provider 对象。

    **构造它不发任何请求，也不读任何 key** —— 花钱要等到有人真的调用它，
    而那一步需要产品负责人放行（TASK-041 增量 3）。
    """
    _config, loaded = catalog
    provider = default_registry().build(
        MINIMAX_PROVIDER_ID, loaded.providers[MINIMAX_PROVIDER_ID]
    )
    assert type(provider).__name__ == "MinimaxVideoProvider"


def test_a_catalog_naming_the_wrong_credential_var_is_refused(catalog) -> None:
    """反方向：把守卫本身试一次。目录写了别的环境变量 → registry 拒绝，
    而不是拿那个变量的值去当令牌。"""
    _config, loaded = catalog
    entry = loaded.providers[MINIMAX_PROVIDER_ID]
    tampered = type(entry)(
        **{
            **{f: getattr(entry, f) for f in entry.__dataclass_fields__},
            "credential_env_vars": ("SOMEONE_ELSES_TOKEN",),
        }
    )
    with pytest.raises(ProviderRegistryError):
        default_registry().build(MINIMAX_PROVIDER_ID, tampered)


def test_the_frozen_demo_project_was_not_touched() -> None:
    """卡上原话：用一份**副本**项目，不改冻结的 `wfm1-demo` 原文（除非用户同意）。

    钉住的是它仍然锁着原来那份目录 —— 证据项目换了目录，它不该跟着换。
    """
    demo = load_project_config(_FROZEN_DEMO)
    assert demo.catalog_id == "wfm1-default"
    assert demo.default_provider == "cloud-a"


def test_every_shot_in_the_evidence_project_actually_prices(catalog) -> None:
    """卡上第 4 项要的是「使 coordinator 前置全绿」，而**能不能报出价来**就是
    那句话的意思。

    上一版的守卫只查了「目录本身对不对」：锁验得过、provider 造得出来，
    而每一镜仍然写着旧目录的 `std-6s` @ `512p` —— 新目录里根本没有那个型号，
    真正要报价的那一步会拒（codex 审查轮 2 的 blocking）。
    「目录是对的」不等于「这个项目在这份目录里跑得起来」。
    """
    config, loaded = catalog
    plan = json.loads(
        (_EVIDENCE / "planning" / "shot_plan_v1.json").read_text(encoding="utf-8")
    )
    assert plan["shots"], "前提：这个项目真的有镜头"

    for shot in plan["shots"]:
        estimate = estimate_generation_cost(
            loaded,
            config.fx,
            config.default_provider,
            shot["model_id"],
            resolution=shot["resolution"],
            duration_seconds=shot["duration_seconds"],
        )
        # USD 0.28 —— 目录里那一条价目，逐镜都报得出来
        assert estimate.original_amount_minor_units == 28, shot["shot_id"]
        assert estimate.original_currency == "USD"
        # 换算成记账货币也得出得来（fx 里有 USD 汇率），否则预算前置照样过不去
        assert estimate.jpy > 0, shot["shot_id"]


def test_the_resolution_is_the_same_fact_in_all_three_places(catalog) -> None:
    """分辨率在镜头上有三处表示（字符串 + 宽 + 高）。三处岔开的后果是安静的：
    报价按字符串走，渲染按宽高走。"""
    plan = json.loads(
        (_EVIDENCE / "planning" / "shot_plan_v1.json").read_text(encoding="utf-8")
    )
    for shot in plan["shots"]:
        assert shot["resolution"] == "768P", shot["shot_id"]
        assert shot["height"] == 768, shot["shot_id"]


def test_the_copy_carries_its_own_identity_everywhere() -> None:
    """副本不得在**任何一处**还写着被复制者的身份。

    轮 3 我只改了 `project.json`，`records/scenes/` 里仍写着 `wfm1-demo` ——
    归属校验会拒，或者谱系被记到那个冻结的 demo 头上（codex 审查轮 4）。
    教训是「我改了那个字段」不等于「这个项目自洽了」，所以这条守卫**扫全项目**
    而不是再钉一个具体文件。
    """
    stale = [
        str(path.relative_to(_EVIDENCE))
        for path in _EVIDENCE.rglob("*.json")
        if '"project_id": "wfm1-demo"' in path.read_text(encoding="utf-8")
    ]
    assert not stale, f"这些文件还指着冻结的 demo：{stale}"


def test_shot_records_and_the_shot_plan_agree_on_geometry() -> None:
    """镜头记录与镜头计划是**同一个事实的两处表示**。岔开的后果是安静的：
    一边按记录渲染、一边按计划报价。"""
    plan = json.loads(
        (_EVIDENCE / "planning" / "shot_plan_v1.json").read_text(encoding="utf-8")
    )
    planned = {s["shot_id"]: (s["width"], s["height"]) for s in plan["shots"]}
    assert planned, "前提：计划里真的有镜头"

    for path in sorted((_EVIDENCE / "records" / "shots").glob("*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        want = planned.get(record["shot_id"])
        assert want is not None, record["shot_id"]
        assert (record["width"], record["height"]) == want, record["shot_id"]


def test_the_evidence_geometry_honours_the_project_profile() -> None:
    """profile 说 `1:1`，那八镜就得是正方形。

    目录按**分辨率字符串**定价，profile 按**比例**约束几何 —— 两者不是一回事，
    上一轮我盯着前者，把后者破坏了（codex 审查轮 3）。
    """
    profile = json.loads(
        (_EVIDENCE / "profile" / "project_profile_v1.json").read_text(encoding="utf-8")
    )
    assert profile["aspect_ratio"] == "1:1"
    plan = json.loads(
        (_EVIDENCE / "planning" / "shot_plan_v1.json").read_text(encoding="utf-8")
    )
    for shot in plan["shots"]:
        assert shot["width"] == shot["height"], shot["shot_id"]

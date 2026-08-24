"""TASK-074 §1.4 边界 8 —— 粗剪 / 导出**在真实写路径上**只追加，绝不覆盖。

**这份文件被 codex 连着改了两轮，两轮都判得对，值得记：**

- 轮 1：最早的守卫写在 `fullpipeline.test.mjs` 里，只在**内存的数字数组**上跑
  `g5Append`。生产代码完全可以绕开 G5 直接覆盖文件而它照样绿 ——
  **闸对不等于闸接上了**。
- 轮 2：于是我改到服务端，但**照搬**了 `_agent_compose` 里占版本号的那一段，
  外加一条源码字符串断言。codex 再次点破：照搬的代码证明不了**生产路径真的
  执行了那段逻辑**。

所以这一版**真的调 `_agent_compose`** —— 真 ffmpeg、真镜头视频、真写盘，
然后在**磁盘上**数：旧的那几版还在不在、内容有没有被改写。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_MOCKUP = _REPO / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP))
import server as srv  # noqa: E402

from tests.e2e.assets_synthetic import have_ffmpeg, make_video  # noqa: E402

PROJECT = "成片版本"


@pytest.fixture()
def composed(tmp_path, monkeypatch):
    """一个真项目，media/ 里放着两条真的 H.264，随时可以合成。"""
    if not have_ffmpeg():
        pytest.skip("这条测试要真的跑 ffmpeg 合成")
    monkeypatch.setattr(srv, "DATA_DIR", tmp_path / "legacy")
    monkeypatch.setattr(srv, "APP_DATA_DIR", tmp_path / "app-data")
    monkeypatch.setattr(srv, "_USER_FLOWS_DIR", tmp_path / "user-flows")
    monkeypatch.setattr(srv, "_USER_SKILLS_DIR", tmp_path / "user-skills")
    account = tmp_path / "MotvProjects"
    account.mkdir()
    app = srv._App(account)
    resp = app._create_project(
        json.dumps({"name": PROJECT, "root": str(account), "confirm": True}).encode()
    )
    assert resp.status == 201, resp.body

    media = account / PROJECT / "media"
    media.mkdir(parents=True, exist_ok=True)
    for slug in ("shot-a", "shot-b"):
        make_video(media / f"{slug}.mp4", seconds=0.4, width=160, height=120)

    def compose():
        """跑一次**真的**合成，返回 (status, body)。"""
        return app._agent_compose(
            json.dumps(
                {
                    "project": PROJECT,
                    "shots": [{"video": "shot-a"}, {"video": "shot-b"}],
                }
            ).encode()
        )

    return compose, media


def _cuts(media: Path) -> list[str]:
    return sorted(p.name for p in media.glob("final-cut-v*.mp4"))


def test_each_real_compose_appends_and_the_earlier_cuts_survive(composed):
    """连跑三次**真合成**：号只前进，旧成片一个不少、一个字节没变。

    这一条走的是生产的 `_agent_compose`，不是照搬的逻辑 —— 它证明的是
    「那条写盘的路真的只追加」，而不是「有一段代码看起来只追加」。
    """
    compose, media = composed

    made = {}
    for i in (1, 2, 3):
        resp = compose()
        assert resp.status == 200, resp.body
        name = f"final-cut-v{i}.mp4"
        assert (media / name).is_file(), f"第 {i} 次合成没有落到 {name}"
        assert json.loads(resp.body)["url"].endswith(name), "回执里的 url 要指向这一版"
        made[name] = (media / name).read_bytes()
        # 之前每一版都还在，且**字节没变**
        for earlier, blob in made.items():
            assert (media / earlier).read_bytes() == blob, f"{earlier} 被改写了"

    assert _cuts(media) == [
        "final-cut-v1.mp4",
        "final-cut-v2.mp4",
        "final-cut-v3.mp4",
    ]


def test_a_real_compose_never_deletes_or_shrinks_the_set_of_cuts(composed):
    """再强一层：合成**只增不减**。

    上一条按名字逐个查；这一条查的是**集合**本身没缩过 —— 一次「先删再写」的
    实现会在中间某一刻让集合变小，而按名字查的断言可能恰好错过它。
    """
    compose, media = composed
    seen: set[str] = set()
    for _ in range(3):
        assert compose().status == 200
        now = set(_cuts(media))
        assert seen <= now, f"有成片消失了：{sorted(seen - now)}"
        assert len(now) == len(seen) + 1, "每次合成应当恰好多出一版"
        seen = now


def test_a_deleted_middle_version_is_never_reused(composed):
    """删掉中间某一版之后，新成片**续在最高版之后**，不回头填坑。

    **这一条最早是反着写的，而 codex 复审拦下了它。** 我当时把「服务端填坑」
    当成现状钉住，还在旁边写了一段「往哪边统一需要一次判断」—— 但这不是两种
    都成立的设计：

      服务端从 1 往上找第一个空位 → 删掉 v2 之后新成片落回 **v2**；
      而前端 G5（`g5Append`）明确拒绝 `nextVersion <= max`（「版本只前进」）。

    两条规则相反，而后果是实的：按「最高版本 = 当前成片」认产物的下游会把
    **刚做出来的那一版**当成旧结果。所以这是缺陷，不是选择 —— 已把服务端改成
    从 `max + 1` 起算，两边一致。

    §1.4 的原话是「发现真实数据问题时**优先如实报告**」。报告之后该修的就修，
    而**把缺陷钉成期望值**是最不该做的一种「报告」。
    """
    compose, media = composed

    for _ in range(3):
        assert compose().status == 200  # v1 / v2 / v3
    v1 = (media / "final-cut-v1.mp4").read_bytes()
    v3 = (media / "final-cut-v3.mp4").read_bytes()
    (media / "final-cut-v2.mp4").unlink()  # 创作者删掉了中间那一版

    assert compose().status == 200
    assert (media / "final-cut-v4.mp4").is_file(), "新成片必须续在最高版之后"
    assert not (media / "final-cut-v2.mp4").exists(), (
        "删掉的那一版不该被新成片顶替 —— 否则最新产物的版本号会低于 v3，"
        "而按「最高版本」认当前成片的下游会把它当成旧结果"
    )
    # 已有的两版一个字节都没动
    assert (media / "final-cut-v1.mp4").read_bytes() == v1
    assert (media / "final-cut-v3.mp4").read_bytes() == v3


def test_the_server_and_G5_now_agree_that_versions_only_advance(composed):
    """服务端算出的下一个号，**必须能过前端 G5 那一关**。

    这两条规则曾经相反（见上一条）。这里把「它们一致」变成可执行的断言：
    拿服务端真的产出的版本序列去喂 `g5Append` 的判据 —— 只前进、不重号。
    """
    compose, media = composed
    for _ in range(3):
        assert compose().status == 200
    (media / "final-cut-v2.mp4").unlink()
    assert compose().status == 200

    nums = sorted(
        int(p.name[len("final-cut-v") : -len(".mp4")])
        for p in media.glob("final-cut-v*.mp4")
    )
    assert nums == [1, 3, 4], f"实际版本序列：{nums}"
    # G5 的判据：新号必须严格大于当前最高
    assert max(nums) == 4
    assert len(nums) == len(set(nums)), "不许有重号"


def test_a_weird_filename_in_media_cannot_break_composing(composed):
    """**media/ 里的文件名是创作者可控的，不能让它把合成打死**（codex 复审）。

    `"²".isdigit()` 是 `True`，而 `int("²")` 抛 `ValueError` —— 只用 `isdigit()`
    的话，一个叫 `final-cut-v².mp4` 的文件会让**每一次**合成都 500，
    而且那个文件不删掉就一直 500。这不是理论：上传是用户可控的写入面。
    """
    compose, media = composed
    assert compose().status == 200  # v1

    # 各种「看起来像版本号但不是」的名字，一个都不许把合成打死。
    # 最后那个是**位数超过上限的全 9**（codex 复审）：它 `isascii()` 且
    # `isdigit()`，一旦被算进 `max`，`max + 1` 会进位成一个更长的名字 ——
    # 极端情况下创建时 ENAMETOOLONG，于是每一次合成都失败，且那个文件删不掉
    # 就一直失败。`_MAX_CUT_DIGITS` 把这一整类挡在外面。
    #
    # 用 7 位而不是 200 位：200 位在 Windows 上**根本建不出来**（路径超长），
    # 测不到守卫。7 位刚好越过上限，是这台机器上真能造出来的那个形状。
    for weird in ("²", "١٢", "", "abc", "1.5", "-1", " 2", "9" * 7):
        (media / f"final-cut-v{weird}.mp4").write_bytes(b"x")

    resp = compose()
    assert resp.status == 200, f"被一个奇怪的文件名打死了：{resp.body}"
    assert (media / "final-cut-v2.mp4").is_file(), "正常的版本推进不该受影响"
    # 那些奇怪的文件原样留着 —— 不是我们写的，也不该由我们删
    for weird in ("²", "١٢", "abc", "9" * 7):
        assert (media / f"final-cut-v{weird}.mp4").is_file()


def test_the_server_number_really_passes_the_frontend_gate(composed):
    """把「服务端与 G5 一致」**真的拿 G5 去验**（codex 复审非阻塞）。

    上一版只在 Python 侧查了「递增 + 不重号」，那证明不了前端那道闸会接受它 ——
    比如 G5 若哪天开始拒绝 `[1, 3, 4]` 这种**稀疏**历史，服务端产出的号就过不了
    闸，而纯 Python 的断言看不见。这里通过 `node` 直接调真的 `g5Append`。
    """
    import json as _json
    import shutil
    import subprocess

    node = shutil.which("node")
    if node is None:
        pytest.skip("需要 node 才能调用真的 g5Append")

    compose, media = composed
    for _ in range(3):
        assert compose().status == 200
    (media / "final-cut-v2.mp4").unlink()
    assert compose().status == 200

    nums = sorted(
        int(p.name[len("final-cut-v") : -len(".mp4")])
        for p in media.glob("final-cut-v*.mp4")
    )
    assert nums == [1, 3, 4], f"实际版本序列：{nums}"

    gates = (_MOCKUP / "src" / "workflow" / "gates.js").as_uri()
    script = (
        f"const g = await import({_json.dumps(gates)});"
        f"const have = {_json.dumps(nums[:-1])};"
        f"const got = {nums[-1]};"
        "const r = g.g5Append(have, got);"
        "console.log(JSON.stringify({ ok: r.ok, next: g.nextVersionFor(have) }));"
    )
    out = subprocess.run(
        [node, "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert out.returncode == 0, out.stderr
    verdict = _json.loads(out.stdout.strip())
    assert verdict["ok"] is True, (
        f"服务端产出的第 {nums[-1]} 版过不了前端 G5 那一关 —— 两边又不一致了"
    )
    assert verdict["next"] == nums[-1], "G5 自己算出的下一版应当与服务端一致"

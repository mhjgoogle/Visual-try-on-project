"""TASK-105 第二刀 —— 从一个已完成的项目导出模板。

第二刀清单里剩下的两条其实是同一件事：「项目源 / 用户源目录没有内容」
（后端早就支持三级来源）与「从已完成项目导出模板」—— **后者就是内容出现的方式**。

导出携带什么、不携带什么是这一条的全部设计，所以这份测试逐条钉：

| 来源 | 内容 |
| --- | --- |
| 起步用的那份流程 | `steps`，**原样 carry，不重新发明** |
| 这个项目最后长成什么样 | `conventions.episodeCount`，**从结果学到的**真事实 |
| 创作者写的内容 | **一个字都不带** |
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_MOCKUP = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP))
import server as srv  # noqa: E402


@pytest.fixture()
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "DATA_DIR", tmp_path / "legacy")
    monkeypatch.setattr(srv, "APP_DATA_DIR", tmp_path / "app-data")
    monkeypatch.setattr(srv, "_USER_FLOWS_DIR", tmp_path / "user-flows")
    monkeypatch.setattr(srv, "_USER_SKILLS_DIR", tmp_path / "user-skills")
    account = tmp_path / "MotvProjects"
    account.mkdir()
    return srv._App(account), account, tmp_path / "user-flows"


def _make(app, account, name: str, *, flow: str | None, episodes: int | None):
    payload = {"name": name, "root": str(account), "confirm": True}
    if flow:
        payload["flow"] = flow
    resp = app._create_project(json.dumps(payload).encode())
    assert resp.status == 201, resp.body
    if episodes is not None:
        canvas = account / name / "studio" / "canvas.json"
        canvas.parent.mkdir(parents=True, exist_ok=True)
        canvas.write_text(
            json.dumps(
                {
                    "production": {
                        "episodes": [{"episodeId": f"ep{i}"} for i in range(episodes)]
                    }
                }
            ),
            encoding="utf-8",
        )
    return account / name


def _export(app, name: str, payload=None):
    return app.handle_post(
        f"/api/projects/{name}/flow/export",
        json.dumps(payload or {}).encode(),
    )


def test_a_project_that_never_used_a_template_cannot_export_one(app):
    """**没有起步流程的项目导不出模板 —— 明确拒绝，不是导出一个空壳。**

    `steps` 必须非空（flowpkg：「没有步骤的流程不是流程」），而一个从零手搓的
    项目没有任何地方记录过它走的是什么顺序。编一条出来就是发明 —— 而那份模板
    会声称自己是这个项目走过的路。
    """
    a, account, _flows = app
    _make(a, account, "手搓", flow=None, episodes=3)
    resp = _export(a, "手搓")
    assert resp.status == 409, resp.body
    body = json.loads(resp.body)
    assert body["error"]["category"] == "no_origin_flow"
    # 拒绝的话必须说清是**为什么**，否则创作者只会以为功能坏了
    assert "顺序" in body["error"]["detail"]


def test_export_carries_the_steps_and_learns_the_episode_count(app):
    """步骤原样 carry；集数是**从结果学到的**，也是导出比原模板多出来的唯一东西。"""
    a, account, flows = app
    _make(a, account, "从模板", flow="episode-from-scratch", episodes=12)
    resp = _export(a, "从模板")
    assert resp.status == 201, resp.body
    out = json.loads(resp.body)
    assert out["episodeCount"] == 12
    assert out["steps"] >= 1

    landed = flows / out["flowId"] / "manifest.json"
    assert landed.is_file(), "导出的包没落到用户流程目录里"
    manifest = json.loads(landed.read_text(encoding="utf-8"))

    # flowId 必须等于目录名 —— flowpkg 会拒绝不一致的包，
    # 也就是说导出来的包必须**真的加载得回来**
    assert manifest["flowId"] == out["flowId"] == landed.parent.name
    assert manifest["kind"] == "flow"
    assert manifest["conventions"]["episodeCount"] == 12
    assert manifest["steps"], "没有步骤的流程不是流程"

    builtin = json.loads(
        (
            Path(__file__).resolve().parents[2]
            / "product-flows"
            / "builtin"
            / "episode-from-scratch"
            / "manifest.json"
        ).read_text(encoding="utf-8")
    )
    got = [(s["stepKey"], s["skillId"], s["skillVersion"]) for s in manifest["steps"]]
    want = [(s["stepKey"], s["skillId"], s["skillVersion"]) for s in builtin["steps"]]
    assert got == want, "步骤必须原样 carry —— 不重新发明顺序，也不丢版本"


def test_the_exported_template_really_loads_back(app):
    """导出的包必须**真的能被加载器读回来**。

    只断言文件写出去了是不够的：一份加载不回来的模板等于没导出，而创作者会以为
    导出成功了。这条走真实的 `flowpkg.load_flow`，与产品加载它时同一条路。
    """
    a, account, flows = app
    _make(a, account, "回读", flow="episode-from-scratch", episodes=5)
    out = json.loads(_export(a, "回读").body)

    import flowpkg

    loaded = flowpkg.load_flow(flows / out["flowId"], "user")
    assert loaded.flow_id == out["flowId"]
    assert loaded.conventions["episodeCount"] == 5
    assert len(loaded.steps) == out["steps"]


def test_exporting_twice_never_overwrites_the_first_one(app):
    """AGENTS.md 第 13 条：**不静默覆盖**。

    两条合规路径里选**带版本的新路径**，而不是停下来问 —— 「第二次导出把第一次
    盖掉」是不可逆的，换个名字是可逆的。
    """
    a, account, flows = app
    _make(a, account, "两次", flow="episode-from-scratch", episodes=2)
    first = json.loads(_export(a, "两次").body)["flowId"]
    second = json.loads(_export(a, "两次").body)["flowId"]
    assert first != second, "第二次导出必须落到一个新目录"
    assert (flows / first / "manifest.json").is_file(), "第一次的包必须还在"
    assert (flows / second / "manifest.json").is_file()


def test_the_export_carries_no_creative_content(app):
    """创作者写下的东西**一个字都不带**。

    这不只是「seed 是空的」：ADR-0084 决策 3 拒绝带资产 / 生成 / 媒体的 seed，
    所以一份带内容的导出会在**加载时**被拒 —— 导出成功、加载失败，是最糟的组合。
    """
    a, account, flows = app
    root = _make(a, account, "有内容", flow="episode-from-scratch", episodes=2)
    canvas = root / "studio" / "canvas.json"
    canvas.write_text(
        json.dumps(
            {
                "production": {
                    "episodes": [{"episodeId": "ep0", "title": "第一集：雨夜"}],
                    "characters": [{"name": "林默", "bio": "私家侦探"}],
                },
                "assets": [{"assetId": "a1", "url": "/api/uploads/x/y.mp4"}],
            }
        ),
        encoding="utf-8",
    )
    out = json.loads(_export(a, "有内容").body)
    pkg = flows / out["flowId"]
    blob = (pkg / "manifest.json").read_text(encoding="utf-8") + (
        pkg / "seed.json"
    ).read_text(encoding="utf-8")
    for leaked in ("林默", "私家侦探", "雨夜", "a1", "y.mp4"):
        assert leaked not in blob, f"导出里泄漏了创作内容：{leaked}"


def test_an_unreadable_episode_count_is_absent_not_zero(app):
    """集数读不出来就**不写这个约定** —— 不补 0，也不猜 1。

    一个写着 `episodeCount: 0` 的模板会让下一个项目一集都长不出来；
    猜 1 则是把「不知道」显示成一个具体答案。缺席是这里唯一诚实的选择。
    """
    a, account, flows = app
    root = _make(a, account, "读不出", flow="episode-from-scratch", episodes=None)
    (root / "studio").mkdir(parents=True, exist_ok=True)
    (root / "studio" / "canvas.json").write_text("{ 不是 JSON", encoding="utf-8")
    resp = _export(a, "读不出")
    assert resp.status == 201, resp.body
    out = json.loads(resp.body)
    assert out["episodeCount"] is None
    manifest = json.loads(
        (flows / out["flowId"] / "manifest.json").read_text(encoding="utf-8")
    )
    assert "conventions" not in manifest, "读不出来就不该写这个约定"


@pytest.mark.parametrize(
    ("episodes", "why"),
    [
        ([], "一集都没有"),
        ([{"episodeId": "e", "archivedAt": "2026-08-24"}], "全部归档了"),
        ([{"episodeId": f"e{i}"} for i in range(500)], "多到不像真的"),
    ],
)
def test_an_out_of_range_episode_count_is_absent_too(app, episodes, why):
    """**变异测试补上的一条。**

    上一条走的是「canvas 读不出来」那条路，它在更早的地方就 return None 了 ——
    于是「集数出界时补一个数」这个变异**活了下来**：把 `else None` 改成
    `else 1`，六条测试全绿。

    出界的三种形状各自的危害不同：0 集会让下一个项目一集都长不出来；
    全归档等于 0；500 集则是一份能把新项目挂住的模板。三种都必须是**缺席**。
    """
    a, account, flows = app
    name = f"出界-{len(episodes)}"
    root = _make(a, account, name, flow="episode-from-scratch", episodes=None)
    (root / "studio").mkdir(parents=True, exist_ok=True)
    (root / "studio" / "canvas.json").write_text(
        json.dumps({"production": {"episodes": episodes}}), encoding="utf-8"
    )
    out = json.loads(_export(a, name).body)
    assert out["episodeCount"] is None, why
    manifest = json.loads(
        (flows / out["flowId"] / "manifest.json").read_text(encoding="utf-8")
    )
    assert "conventions" not in manifest, why


def test_a_failed_write_leaves_no_half_package_behind(app, monkeypatch):
    """**写失败不许在用户流程目录里留下半份包**（codex 轮 1 的 P1）。

    留着的后果不是「导出失败」——那是可接受的；是用户流程目录里从此多了一个
    加载不了的包，而重试只会造一个带序号的新目录，**永远不修那个半份的**。
    """
    a, account, flows = app
    _make(a, account, "写失败", flow="episode-from-scratch", episodes=3)

    real = Path.write_bytes
    calls = {"n": 0}

    def boom(self, data):
        calls["n"] += 1
        if calls["n"] == 2:  # 第一份写成功，第二份炸 —— 正是「半份」那个形状
            raise OSError("disk full")
        return real(self, data)

    monkeypatch.setattr(Path, "write_bytes", boom)
    resp = _export(a, "写失败")
    monkeypatch.undo()

    assert resp.status == 500, resp.body
    leftovers = list(flows.iterdir()) if flows.exists() else []
    assert leftovers == [], f"失败之后留下了：{[p.name for p in leftovers]}"


def test_an_unencodable_title_is_refused_not_a_crash(app):
    """孤立代理项让编码抛 `UnicodeEncodeError`（一个 `ValueError`），
    而不是 `OSError` —— 只接 `OSError` 会让请求整个炸掉并留下孤儿目录。

    **这个仓库已经修过一次同样的 bug**（`_create_project` 里 codex 轮 10 那条：
    「`ValueError` too, not just `OSError`」）。这条测试让它不会有第三次。
    """
    a, account, flows = app
    _make(a, account, "坏标题", flow="episode-from-scratch", episodes=1)
    lone_surrogate = "标题" + chr(0xD800)
    resp = _export(a, "坏标题", {"title": lone_surrogate})
    assert resp.status == 400, resp.body
    assert json.loads(resp.body)["error"]["category"] == "unencodable"
    leftovers = list(flows.iterdir()) if flows.exists() else []
    assert leftovers == [], f"拒绝之后留下了孤儿目录：{[p.name for p in leftovers]}"


def test_a_reserved_windows_device_name_can_still_be_exported(app):
    """`CON` / `NUL` / `COM1` 建不出目录，而权威环境就是 Windows（ADR-0062）。

    **加前缀而不是拒绝**：导出不该因为源模板的名字碰巧撞上 DOS 的历史包袱
    而做不了。
    """
    a, account, flows = app
    root = _make(a, account, "设备名", flow="episode-from-scratch", episodes=2)
    flow_json = root / "studio" / "flow.json"
    doc = json.loads(flow_json.read_text(encoding="utf-8"))
    doc["createdFrom"]["flowId"] = "con"
    flow_json.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")

    resp = _export(a, "设备名")
    assert resp.status == 201, resp.body
    made = json.loads(resp.body)["flowId"]
    assert made.upper() != "CON", "目录名不能是保留设备名"
    assert (flows / made / "manifest.json").is_file()


def test_the_project_name_never_reaches_the_template(app):
    """**项目名也是创作者写的内容**（codex 轮 2 的 P1）。

    模板是拿出去复用的东西。一个叫「客户A-机密企划」的项目，如果默认标题写成
    「…（来自「客户A-机密企划」）」，这个名字就跟着每一份导出跑到别处去。

    我第一版的泄漏测试只查了 canvas 里的内容，没查项目名 —— 于是这条泄漏
    从我自己声明的合同底下走过去了。
    """
    a, account, flows = app
    secret = "客户A-机密企划"
    _make(a, account, secret, flow="episode-from-scratch", episodes=3)
    out = json.loads(_export(a, secret).body)
    pkg = flows / out["flowId"]
    blob = "".join(
        (pkg / f).read_text(encoding="utf-8")
        for f in ("manifest.json", "seed.json", "flow.md")
    )
    assert secret not in blob, "项目名泄漏进了模板"
    assert "客户A" not in blob and "机密" not in blob
    # 目录名也不许带
    assert "机密" not in out["flowId"]


def test_the_creator_can_still_put_the_project_name_in_on_purpose(app):
    """**创作者自己写进标题是他的决定，不是泄漏。**

    上一条禁的是「我们替他把项目名塞进去」。他显式传 `title` 时照写不误 ——
    否则就成了产品替创作者决定他能给自己的模板起什么名字。
    """
    a, account, flows = app
    _make(a, account, "有名字", flow="episode-from-scratch", episodes=1)
    out = json.loads(_export(a, "有名字", {"title": "我的「有名字」模板"}).body)
    manifest = json.loads(
        (flows / out["flowId"] / "manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["title"] == "我的「有名字」模板"


def test_a_partial_package_is_never_visible_in_the_catalog(app, monkeypatch):
    """**包要么完整地出现，要么根本不出现**（codex 轮 2 的 P1）。

    轮 1 修的是「失败之后留下垃圾」；这是另一个机理：即使最终成功，
    「目录已出现、文件还没写完」之间有一个窗口，此刻扫目录的人会读到半份包。

    做法是先在扫描面之外写好，再**原子改名**进去。这条测试在写第二个文件时
    炸掉，然后要求扫描面上**一个条目都没有** —— 包括那个暂存目录。
    """
    a, account, flows = app
    _make(a, account, "原子", flow="episode-from-scratch", episodes=2)

    real = Path.write_bytes
    calls = {"n": 0}

    def boom(self, data):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("disk full")
        return real(self, data)

    monkeypatch.setattr(Path, "write_bytes", boom)
    resp = _export(a, "原子")
    monkeypatch.undo()

    assert resp.status == 500, resp.body
    assert not flows.exists() or list(flows.iterdir()) == []
    # 暂存目录住在同级，也不许留下
    siblings = [
        p.name for p in flows.parent.iterdir() if p.name.startswith(".flow-export-")
    ]
    assert siblings == [], f"暂存目录没清干净：{siblings}"


def test_no_directory_ever_looks_like_a_valid_flow_until_it_is_complete(
    app, monkeypatch
):
    """**直接看那个窗口**，不看事后的残留。

    第一版只断言了失败之后目录是干净的 —— 于是「把暂存目录放进扫描面里」这个
    变异**活了下来**：`finally` 里的清理让事后看起来一样干净，而 codex 指出的
    风险是**写的过程中**有人扫到半份包。

    这一版守的是那个真正保护创作者的性质，而不是「扫描面上一个条目都没有」
    （占名之后那条不再成立，也不需要成立）：

      **任何时刻，扫描面上的目录要么没有 `manifest.json`，要么是完整的。**

    `read_package_files` 对缺 manifest 的目录抛「缺少 manifest.json」，加载器
    把它报成一条 problem —— 所以窗口里最坏也只是一条**被报出来的**问题，
    永远不是一份「读得进去但残缺」的模板。后者才是会骗到人的东西。
    """
    a, account, flows = app
    _make(a, account, "窗口", flow="episode-from-scratch", episodes=2)

    real = Path.write_bytes
    violations: list[str] = []

    def watch(self, data):
        out = real(self, data)  # 写完之后再看 —— 看的是每一次写**落地后**的状态
        if flows.exists():
            for pkg in flows.iterdir():
                # **扫描目录里唯一允许出现的东西，是一份完整的包。**
                # 第一版只查「有 manifest 就得有另外两份」—— 那漏掉了「暂存目录
                # 就建在扫描目录里」这个变异：manifest 最后写，所以那个暂存目录
                # 一直没有 manifest，检查通过；而它在进程被强杀时会永久留下，
                # 被扫描器报成一份坏流程（轮 4 / 轮 5 报的正是这个）。
                missing = [
                    f
                    for f in ("manifest.json", "seed.json", "flow.md")
                    if not (pkg / f).exists()
                ]
                if missing:
                    violations.append(f"{pkg.name} 缺 {missing}")
        return out

    monkeypatch.setattr(Path, "write_bytes", watch)
    resp = _export(a, "窗口")
    monkeypatch.undo()

    assert resp.status == 201, resp.body
    assert violations == [], (
        f"窗口里出现了「读得进去但残缺」的包：{violations} —— "
        "manifest 必须最后写，它落地那一刻这个包才成为一份合法流程"
    )


@pytest.mark.parametrize(
    ("broken", "why"),
    [
        ("not-an-object", "整条不是对象"),
        ({"stepKey": "", "skillId": "x", "skillVersion": 1}, "stepKey 空"),
        ({"stepKey": "k", "skillId": "x", "skillVersion": 0}, "skillVersion 是 0"),
        (
            {"stepKey": "k", "skillId": "x", "skillVersion": True},
            "skillVersion 是 bool",
        ),
        ({"stepKey": "k", "skillVersion": 1}, "缺 skillId"),
    ],
)
def test_one_malformed_step_refuses_the_whole_export(
    app, flows_broken_step, broken, why
):
    """**一条形状不对就整个拒绝，不静默跳过**（codex 轮 3 的 P1）。

    跳过的后果是：导出的模板**少了几步而没有人说过**，而这个端点自己声称
    「步骤原样 carry」。少一步的流程不是「差不多的流程」，它是**另一条流程**
    —— 而它会顶着「这是那个项目走过的路」的名义被复用。
    """
    a, flows, export = flows_broken_step
    resp = export(broken)
    assert resp.status == 409, f"{why}：期望拒绝，得到 {resp.status}"
    body = json.loads(resp.body)
    assert body["error"]["category"] == "unreadable_origin", why
    # 拒绝要说清是**哪一条**不对，否则创作者无从下手
    detail = body["error"]["detail"]
    assert "少几步" in detail or "一条步骤都没有" in detail
    # 而且**什么都不许落地**
    assert not flows.exists() or list(flows.iterdir()) == [], why


@pytest.fixture()
def flows_broken_step(app):
    """一个从模板起步的项目，外加一个「往它的 flow.json 里塞一条坏步骤」的开关。"""
    a, account, flows = app
    root = _make(a, account, "坏步骤", flow="episode-from-scratch", episodes=2)
    flow_json = root / "studio" / "flow.json"
    pristine = json.loads(flow_json.read_text(encoding="utf-8"))

    def export(broken_step):
        doc = json.loads(json.dumps(pristine))
        # 好步骤仍然在 —— 证的正是「还剩合法的也不许静默跳过」
        doc["steps"].append(broken_step)
        flow_json.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        return _export(a, "坏步骤")

    return a, flows, export


def test_a_failed_export_leaves_nothing_in_the_catalog_at_all(app, monkeypatch):
    """写失败之后，扫描目录里**一个条目都没有**。

    这条守的是审查围着打转四轮的那个主题的最终形态：**扫描目录里唯一会出现的
    东西，是一份完整的包**。现在的实现里根本不在扫描目录中创建任何东西 ——
    只做一次 rename —— 所以失败时那里本来就什么都不该有。

    （它曾经叫「占名被放回去」：上一版用 `mkdir` 占名，于是失败时要记得把那个空
    目录删掉。占名这一步已经去掉了，因为它在**进程被强杀**时 `finally` 跑不到，
    那个空目录就永久留下并被扫描器报成坏流程 —— 轮 5 报的正是这个。）
    """
    a, account, flows = app
    _make(a, account, "放回去", flow="episode-from-scratch", episodes=2)

    real = Path.write_bytes

    def boom(self, data):
        raise OSError("disk full")

    monkeypatch.setattr(Path, "write_bytes", boom)
    resp = _export(a, "放回去")
    monkeypatch.setattr(Path, "write_bytes", real)

    assert resp.status == 500, resp.body
    left = sorted(p.name for p in flows.iterdir()) if flows.exists() else []
    assert left == [], f"探到的名字没放回去：{left}"
    siblings = [
        p.name for p in flows.parent.iterdir() if p.name.startswith(".flow-export-")
    ]
    assert siblings == [], f"暂存目录没清干净：{siblings}"


def test_a_malformed_episode_entry_is_not_counted(app):
    """一集必须**真的像一集**（codex 轮 4 非阻塞）。

    `{}` 或缺 id 的条目照样算数的话，一份畸形数据会导出一个**看起来合理但是
    错的** `episodeCount` —— 而这个数会决定下一个项目长出几集。
    """
    a, account, flows = app
    root = _make(a, account, "畸形集", flow="episode-from-scratch", episodes=None)
    (root / "studio").mkdir(parents=True, exist_ok=True)
    (root / "studio" / "canvas.json").write_text(
        json.dumps(
            {
                "production": {
                    "episodes": [
                        {"episodeId": "ep1"},
                        {},  # 不像一集
                        {"title": "缺 id"},  # 也不像
                        {"episodeId": "ep2"},
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    out = json.loads(_export(a, "畸形集").body)
    assert out["episodeCount"] == 2, "只有两条真的像一集"


def test_a_rename_failure_that_is_not_a_collision_fails_fast(app, monkeypatch):
    """**换名字解决不了的错误，不许换 999 次名字**（codex 轮 5 非阻塞）。

    权限 / 只读卷 / 磁盘满换个名字也不会好。盲目重试的代价有两个：白写 999 遍，
    以及**把真正的失败原因埋掉** —— 创作者最后看到的是「同名条目太多」，
    而真相是这个卷是只读的。
    """
    a, account, _flows = app
    _make(a, account, "只读卷", flow="episode-from-scratch", episodes=1)

    attempts = {"n": 0}
    real = Path.rename

    def denied(self, target):
        attempts["n"] += 1
        raise PermissionError("read-only file system")

    monkeypatch.setattr(Path, "rename", denied)
    resp = _export(a, "只读卷")
    monkeypatch.setattr(Path, "rename", real)

    assert resp.status == 500, resp.body
    assert attempts["n"] == 1, f"换名字解决不了的错误重试了 {attempts['n']} 次"
    # 报出来的必须是**真正的原因**，不是「同名条目太多」
    detail = json.loads(resp.body)["error"]["detail"]
    assert "read-only" in detail, detail


@pytest.mark.parametrize(
    ("broken", "why"),
    [
        ({"stepKey": "   ", "skillId": "x", "skillVersion": 1}, "stepKey 全是空白"),
        ({"stepKey": "k", "skillId": "   ", "skillVersion": 1}, "skillId 全是空白"),
        ({"stepKey": "story", "skillId": "x", "skillVersion": 1}, "stepKey 与前面重复"),
    ],
)
def test_export_rules_match_the_loader_exactly(app, flows_broken_step, broken, why):
    """**导出的判据必须与加载器逐字一致**（codex 轮 6 非阻塞）。

    松一点的后果不是「导出宽容」，而是**导出成功但加载失败** —— 创作者以为存
    下来了，用的时候才发现这份模板读不进去。这是所有组合里最糟的一种，
    因为失败被推迟到了他最不设防的时刻。

    `flowpkg` 的规则是 `.strip()` 后非空、`stepKey` 在一份流程里唯一。
    `story` 是内置模板的第一个 stepKey，所以第三条真的构成重复。
    """
    a, flows, export = flows_broken_step
    resp = export(broken)
    assert resp.status == 409, f"{why}：期望拒绝，得到 {resp.status}"
    assert json.loads(resp.body)["error"]["category"] == "unreadable_origin", why
    assert not flows.exists() or list(flows.iterdir()) == [], why

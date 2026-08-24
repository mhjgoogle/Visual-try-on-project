"""TASK-105：`GET /api/flows` 与「新建项目时选一份模板」。

页面读不到文件系统，所以后端就是加载器 —— 与 `/api/skills` 同一条理由，
也是同一条纪律：**加载不了的模板必须带着原因出现在列表里**，不能只是不见了。
"""

from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

import pytest

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP_DIR))

import server as srv  # noqa: E402 - path injected above


@pytest.fixture()
def backend(tmp_path, monkeypatch):
    """A loopback server whose data locations are all throwaway."""
    data_dir = tmp_path / "repo-scratch"
    data_dir.mkdir()
    monkeypatch.setattr(srv, "DATA_DIR", data_dir)
    app_data = tmp_path / "app-data"
    app_data.mkdir()
    monkeypatch.setattr(srv, "APP_DATA_DIR", app_data)
    # 用户来源指向空目录：这些测试要的是「内置那一份」加上它们自己造的，
    # 不是开发机上碰巧装了什么。**两个来源都要**（codex 审查轮 9）——
    # flow 的每一步都要对着能力目录解析，所以一份装在本机的用户 Skill 覆盖了
    # 内置的同名能力，就足以让这些测试的结论随机器而变。
    monkeypatch.setattr(srv, "_USER_FLOWS_DIR", tmp_path / "user-flows")
    monkeypatch.setattr(srv, "_USER_SKILLS_DIR", tmp_path / "user-skills")
    account_root = tmp_path / "MotvProjects"
    account_root.mkdir()

    httpd = srv.build_server(account_root, host="127.0.0.1", port=0)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{port}", tmp_path, account_root
    finally:
        httpd.shutdown()
        httpd.server_close()


def _req(base, path, *, method="GET", body=None):
    url = f"{base}{quote(path, safe='/?=&%')}"
    data = None
    headers = {"Host": base.split("//", 1)[1]}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Origin"] = base
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


# --- 只读路由 ----------------------------------------------------------------- #


def test_the_builtin_flow_reaches_the_page(backend):
    """页面读不到文件系统，这条路由是模板到达浏览器的唯一通道。"""
    base, _tmp, _account = backend
    status, body = _req(base, "/api/flows")

    assert status == 200
    ids = [f["flowId"] for f in body["flows"]]
    assert "episode-from-scratch" in ids
    flow = next(f for f in body["flows"] if f["flowId"] == "episode-from-scratch")
    assert flow["source"] == "builtin"
    assert flow["digest"].startswith("sha256:")
    assert len(flow["steps"]) == 7
    assert flow["steps"][0]["skillId"] == "story-development"


def test_the_listing_carries_no_seed_and_no_full_narrative(backend):
    """列表页要的是「有哪些、几步、干什么用」。把骨架和整篇说明塞进列表只会让它
    变慢，而两者都有各自该被读到的时候。"""
    base, _tmp, _account = backend
    _status, body = _req(base, "/api/flows")
    flow = body["flows"][0]
    assert "seed" not in flow
    assert "narrative" not in flow


def test_a_broken_flow_is_listed_as_a_problem_not_silently_dropped(backend, tmp_path):
    """一个装了却没生效的模板，沉默地消失比报错难查得多。"""
    base, _tmp, _account = backend
    broken = tmp_path / "user-flows" / "broken"
    broken.mkdir(parents=True)
    (broken / "manifest.json").write_text("{ not json", encoding="utf-8")
    (broken / "seed.json").write_text("{}", encoding="utf-8")
    (broken / "flow.md").write_text("说明\n", encoding="utf-8")

    _status, body = _req(base, "/api/flows")

    assert [p["flowId"] for p in body["problems"]] == ["broken"]
    assert "manifest.json" in body["problems"][0]["detail"]
    assert "broken" not in [f["flowId"] for f in body["flows"]]


def test_an_unknown_project_is_404_not_403(backend):
    """跨项目探测学不到这个项目存不存在 —— 与 `/api/skills` 同。"""
    base, _tmp, _account = backend
    status, _body = _req(base, "/api/flows?project=nope")
    assert status == 404


# --- 创建项目时选一份 ---------------------------------------------------------- #


def test_creating_with_a_flow_records_all_three_provenance_fields(backend):
    """ADR-0084 决策 5：三个字段一个不少。`flowVersion` 回答「作者说这是第几版」，
    `flowDigest` 回答「那一版到底是什么」。"""
    base, _tmp, account = backend
    status, _body = _req(
        base,
        "/api/projects",
        method="POST",
        body={
            "name": "雨夜",
            "root": str(account),
            "confirm": True,
            "flow": "episode-from-scratch",
        },
    )
    assert status == 201

    record = json.loads((account / "雨夜" / "project.json").read_text("utf-8"))
    assert set(record["createdFrom"]) == {"flowId", "flowVersion", "flowDigest"}
    assert record["createdFrom"]["flowId"] == "episode-from-scratch"
    assert record["createdFrom"]["flowDigest"].startswith("sha256:")


def test_creating_without_a_flow_stays_exactly_as_it_was(backend):
    """模板是可复用物，**不是必经之路**。没选就不该出现这个字段 ——
    它是加法字段，老项目照常读。"""
    base, _tmp, account = backend
    status, _body = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "空项目", "root": str(account), "confirm": True},
    )
    assert status == 201

    record = json.loads((account / "空项目" / "project.json").read_text("utf-8"))
    assert "createdFrom" not in record


def test_an_unknown_flow_is_refused_rather_than_silently_ignored(backend):
    """静默忽略会造出一个「以为是从模板起步、其实不是」的项目，而
    `createdFrom` 正是用来回答那个问题的字段。"""
    base, _tmp, account = backend
    status, body = _req(
        base,
        "/api/projects",
        method="POST",
        body={
            "name": "雨夜",
            "root": str(account),
            "confirm": True,
            "flow": "no-such-flow",
        },
    )
    assert status == 404
    assert "no-such-flow" in body["error"]["detail"]
    assert not (account / "雨夜").exists(), "拒绝时不得留下半个项目"


def test_a_non_string_flow_is_a_bad_request(backend):
    base, _tmp, account = backend
    status, body = _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "雨夜", "root": str(account), "confirm": True, "flow": 7},
    )
    assert status == 400
    assert body["error"]["category"] == "bad_request"


def test_a_flow_whose_capability_is_missing_cannot_be_chosen(backend, tmp_path):
    """ADR-0084 决策 6 在**创建这条路径上**也成立：加载不了的模板选不了。

    否则「fail-closed」只是列表页的一句话，而真正会造出项目的那条路还是通的。
    """
    base, _tmp, account = backend
    bad = tmp_path / "user-flows" / "needs-missing"
    bad.mkdir(parents=True)
    (bad / "manifest.json").write_text(
        json.dumps(
            {
                "flowId": "needs-missing",
                "flowVersion": 1,
                "kind": "flow",
                "title": "缺能力的",
                "purpose": "测试用",
                "steps": [
                    {"stepKey": "a", "skillId": "does-not-exist", "skillVersion": 1}
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (bad / "seed.json").write_text("{}", encoding="utf-8")
    (bad / "flow.md").write_text("说明\n", encoding="utf-8")

    status, _body = _req(
        base,
        "/api/projects",
        method="POST",
        body={
            "name": "雨夜",
            "root": str(account),
            "confirm": True,
            "flow": "needs-missing",
        },
    )
    assert status == 404
    assert not (account / "雨夜").exists()


def test_a_user_flow_overrides_the_builtin_one_wholesale(backend, tmp_path):
    """同 id 由更靠前的来源整体覆盖，不做字段级合并（ADR-0067 决策 2）。"""
    base, _tmp, _account = backend
    mine = tmp_path / "user-flows" / "episode-from-scratch"
    mine.mkdir(parents=True)
    (mine / "manifest.json").write_text(
        json.dumps(
            {
                "flowId": "episode-from-scratch",
                "flowVersion": 9,
                "kind": "flow",
                "title": "我自己的",
                "purpose": "覆盖内置那一份",
                "steps": [
                    {
                        "stepKey": "only",
                        "skillId": "story-development",
                        "skillVersion": 2,
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (mine / "seed.json").write_text("{}", encoding="utf-8")
    (mine / "flow.md").write_text("说明\n", encoding="utf-8")

    _status, body = _req(base, "/api/flows")
    flow = next(f for f in body["flows"] if f["flowId"] == "episode-from-scratch")

    assert flow["source"] == "user"
    assert flow["title"] == "我自己的"
    assert len(flow["steps"]) == 1, "整体覆盖 —— 不是内置七步里换掉一步"


def test_choosing_a_flow_actually_lands_it_in_the_project(backend):
    """选了模板必须**真的落下东西**。

    上一版只盖了个 `createdFrom` 的章：每一份模板造出来的项目完全一样，只有
    溯源元数据不同（codex 审查轮 1 的 blocking）—— 那是「亮着但点进去什么也没
    发生」，而且让第一刀不成其为垂直切片。
    """
    base, _tmp, account = backend
    status, _body = _req(
        base,
        "/api/projects",
        method="POST",
        body={
            "name": "雨夜",
            "root": str(account),
            "confirm": True,
            "flow": "episode-from-scratch",
        },
    )
    assert status == 201

    landed = json.loads((account / "雨夜" / "studio" / "flow.json").read_text("utf-8"))
    assert landed["createdFrom"]["flowId"] == "episode-from-scratch"
    assert [s["stepKey"] for s in landed["steps"]][:2] == ["story", "world"]
    assert landed["conventions"]["episodeCount"] == 12
    assert "story" in landed["seed"]


def test_a_project_created_without_a_flow_gets_no_flow_file(backend):
    """加法：没选模板的项目里它根本不存在，读侧不必去分辨「空的」和「没有」。"""
    base, _tmp, account = backend
    _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "空项目", "root": str(account), "confirm": True},
    )
    assert not (account / "空项目" / "studio" / "flow.json").exists()


def test_a_failed_create_leaves_no_half_project_behind(backend, monkeypatch):
    """回滚要带上 `studio/flow.json` —— 不删它，`studio` 的 rmdir 会因为目录非空
    而失败，半个项目留在原地，每次重试都答「已存在」。"""
    base, _tmp, account = backend
    real_save = srv._save_project_registry
    monkeypatch.setattr(srv, "_save_project_registry", lambda reg: False)
    try:
        status, _body = _req(
            base,
            "/api/projects",
            method="POST",
            body={
                "name": "雨夜",
                "root": str(account),
                "confirm": True,
                "flow": "episode-from-scratch",
            },
        )
    finally:
        monkeypatch.setattr(srv, "_save_project_registry", real_save)

    assert status == 500
    assert not (account / "雨夜").exists(), "回滚必须把 flow.json 一起带走"


def test_the_landed_flow_can_be_read_back(backend):
    """页面在初始化一张全新画布时读它一次 —— 没有这条路由，落下的那份流程
    没有任何人读得到，「选模板」还是点了没反应（codex 审查轮 3）。"""
    base, _tmp, account = backend
    _req(
        base,
        "/api/projects",
        method="POST",
        body={
            "name": "雨夜",
            "root": str(account),
            "confirm": True,
            "flow": "episode-from-scratch",
        },
    )
    status, body = _req(base, "/api/projects/雨夜/flow")

    assert status == 200
    assert body["flow"]["createdFrom"]["flowId"] == "episode-from-scratch"
    assert body["flow"]["conventions"]["episodeCount"] == 12


def test_a_project_without_a_flow_answers_200_and_null(backend):
    """没用模板是**正常状态**，不是错误：读侧不必去分辨「请求失败」和
    「这个项目本来就没有模板」。"""
    base, _tmp, account = backend
    _req(
        base,
        "/api/projects",
        method="POST",
        body={"name": "空项目", "root": str(account), "confirm": True},
    )
    status, body = _req(base, "/api/projects/空项目/flow")

    assert status == 200
    assert body["flow"] is None


def test_an_unknown_project_flow_is_404(backend):
    base, _tmp, _account = backend
    status, _body = _req(base, "/api/projects/nope/flow")
    assert status == 404

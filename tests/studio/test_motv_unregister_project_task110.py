"""REQ-005 / ADR-0090 —— 「删除项目」= 只从列表移除，应用永不删他的文件。

守的是这条路径最容易出的三种错：

1. **它悄悄删了文件。** 产品负责人明确划了界：「删除前端。后端的文件留下就好了啊。」
   所以这里断言的不是「删得干净」，而是**目录、canvas、媒体一个字节都没动**。
2. **它说成功了，卡片还在。** 他已经吃过反方向的亏（删了文件夹、卡片还在），
   所以移除之后列表里必须真的没有它。
3. **它默默什么都没干。** 注册表里根本没有那个名字时要说出来，不能回一个 200。
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SERVER = _REPO / "mockups" / "motv-workspace" / "server.py"


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location("motv_server_unreg_110", _SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def app(srv, tmp_path: Path, monkeypatch):
    monkeypatch.setattr(srv, "DATA_DIR", tmp_path / "legacy")
    monkeypatch.setattr(srv, "APP_DATA_DIR", tmp_path / "app-data")
    monkeypatch.setattr(srv, "_RUNS", None)
    account = tmp_path / "account"
    for name in ("夜班沉默", "照见未明rev2"):
        root = account / name
        (root / "studio").mkdir(parents=True)
        (root / "media").mkdir()
        (root / "project.json").write_text(json.dumps({"name": name}), "utf-8")
        (root / "studio" / "canvas.json").write_text('{"v": 19}', "utf-8")
        (root / "media" / "shot.png").write_bytes(b"not really a png")
    (tmp_path / "app-data").mkdir(parents=True, exist_ok=True)
    (tmp_path / "app-data" / "projects.json").write_text(
        json.dumps(
            {
                "version": 1,
                "projects": [
                    {"name": "夜班沉默", "root": str(account / "夜班沉默")},
                    {"name": "照见未明rev2", "root": str(account / "照见未明rev2")},
                ],
                "confirmedRoots": [str(account)],
            },
            ensure_ascii=False,
        ),
        "utf-8",
    )
    a = srv._App(account)
    a._projects["夜班沉默"] = account / "夜班沉默"
    a._projects["照见未明rev2"] = account / "照见未明rev2"
    return a


def _post(app, srv, name, header=True):
    headers = {srv._SKILL_RUN_HEADER: "1"} if header else {}
    resp = app.handle_post(f"/api/projects/{name}/unregister", b"{}", headers=headers)
    return resp.status, json.loads(resp.body.decode("utf-8"))


def _list(app):
    resp = app.handle("/api/projects")
    return json.loads(resp.body.decode("utf-8"))


def test_removal_does_not_touch_one_byte_on_disk(app, srv):
    """产品负责人 2026-08-27:「后端的文件我可以手动删除。」"""
    root = app._projects["照见未明rev2"]
    before = sorted(p.relative_to(root).as_posix() for p in root.rglob("*"))
    canvas = (root / "studio" / "canvas.json").read_bytes()

    status, out = _post(app, srv, "照见未明rev2")
    assert status == 200, out
    assert out["filesDeleted"] is False
    assert out["filesKeptAt"] == str(root)

    assert root.is_dir(), "项目目录被删了 —— 这条路径永远不许删他的文件"
    after = sorted(p.relative_to(root).as_posix() for p in root.rglob("*"))
    assert after == before
    assert (root / "studio" / "canvas.json").read_bytes() == canvas


def test_the_list_actually_stops_reporting_it(app, srv):
    """他吃过的那个亏的反面：说了成功，列表里就不许再有它（判据 5）。"""
    assert "照见未明rev2" in [p["name"] for p in _list(app)["projects"]]
    _post(app, srv, "照见未明rev2")
    assert [p["name"] for p in _list(app)["projects"]] == ["夜班沉默"]


def test_the_registry_file_loses_exactly_that_row(app, srv):
    _post(app, srv, "照见未明rev2")
    reg = json.loads((srv.APP_DATA_DIR / "projects.json").read_text("utf-8"))
    assert [p["name"] for p in reg["projects"]] == ["夜班沉默"]
    # confirmedRoots 是「允许在哪儿建项目」，与某个项目是否还在无关
    assert reg["confirmedRoots"]


def test_an_unknown_name_says_so_instead_of_reporting_success(app, srv):
    status, out = _post(app, srv, "根本没有这个项目")
    assert status == 404
    assert "根本没有这个项目" in out["error"]["detail"]


def test_it_needs_the_csrf_header(app, srv):
    status, out = _post(app, srv, "夜班沉默", header=False)
    assert status == 403
    assert out["error"]["category"] == "forbidden"


def test_removing_one_leaves_the_other_alone(app, srv):
    _post(app, srv, "照见未明rev2")
    other = app._projects["夜班沉默"]
    assert other.is_dir()
    assert (other / "studio" / "canvas.json").is_file()

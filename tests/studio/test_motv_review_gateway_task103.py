"""审片结论进核心：Studio 的 Command Gateway 接上评价 / 反馈 / 行动闭环。

TASK-103 批次 B（TASK-087 §1.2 / TASK-083 §5.1）。

四个 LOW-risk 命令 2026-07 就实现好了，只注册在 ``workspace_shell`` ——
而那个界面看不见创作者的 Studio 项目（GAP-05 / C-020）。于是 Studio 审片页的
「✓ 通过」写完画布就到头了，核心项目对此一无所知。本卡接的是注册表，不是新能力。

这里守三件事：
1. 四个命令**在 Studio 的注册表里**（不是只在 shell 里）；
2. 非付费模式下它们**过得了那道门**（它们不花钱，和 ``lock-draft-plan`` 同级），
   而付费命令仍然过不了；
3. 允许名单是**派生**的 —— 核心加第五个无花费命令时，这道门不会因为有人忘了
   改一行而把它 403 掉。
"""

from __future__ import annotations

import sys
from pathlib import Path

_MOCKUP_DIR = Path(__file__).resolve().parents[2] / "mockups" / "motv-workspace"
sys.path.insert(0, str(_MOCKUP_DIR))

import server as srv  # noqa: E402  - path injected above

from ai_video_workflow.app.gateway_commands import (  # noqa: E402
    ACTION_TRANSITION,
    CREATE_ACTION,
    CREATE_FEEDBACK,
    CREATIVE_LOOP_COMMANDS,
    RECORD_EVALUATION,
)

_LOOP = (RECORD_EVALUATION, CREATE_FEEDBACK, CREATE_ACTION, ACTION_TRANSITION)


def test_the_four_commands_are_registered_in_the_studio_gateway(tmp_path):
    """Studio 的网关认识这四个命令 —— 不再只有 shell 认识。"""
    app = srv._App(tmp_path / "account")
    root = tmp_path / "proj"
    root.mkdir()
    gateway = app._command_gateway(root)
    names = gateway._registry.names()
    for name in _LOOP:
        assert name in names, f"{name} 没有注册进 Studio 网关"
    # 既有的那条没有被挤掉
    assert "lock-draft-plan" in names


def test_they_are_low_risk_and_need_no_confirmation(tmp_path):
    """它们不花钱，所以不该要金额确认 —— 风险等级取自核心的同一份 spec。"""
    from ai_video_workflow.gateway.commands import CommandRisk

    app = srv._App(tmp_path / "account")
    root = tmp_path / "proj"
    root.mkdir()
    registry = app._command_gateway(root)._registry
    for name in _LOOP:
        assert registry.get(name).risk is CommandRisk.LOW, name


def test_the_no_spend_door_is_derived_from_the_core_list():
    """允许名单来自核心的成员列表，不是这边手抄的第二份。

    手抄的那份会在核心加第五个无花费命令时静默落后：命令注册进去了，门却把它
    403 掉，而两边都不会喊。所以这里断言的是**派生关系**本身。
    """
    assert set(CREATIVE_LOOP_COMMANDS) <= srv._NO_SPEND_COMMANDS
    assert "lock-draft-plan" in srv._NO_SPEND_COMMANDS
    # 付费命令不在里面 —— 这道门存在的理由
    assert "submit-video-generation" not in srv._NO_SPEND_COMMANDS


def test_non_paid_mode_lets_them_through_and_still_refuses_paid(tmp_path):
    """非付费模式：四个命令过门，付费生成仍被拒。

    走的是真正的写入路由，所以断的是这道门的实际行为，不是名单的形状。
    """
    import json

    app = srv._App(tmp_path / "account")
    assert app.paid is False
    root = tmp_path / "proj"
    root.mkdir()
    app._projects["proj-1"] = root

    def post(name):
        body = json.dumps(
            {
                "command_id": f"c-{name}",
                "name": name,
                "target": {"ref": "sh-1", "version": 1, "content_digest": "a" * 64},
                "params": {},
            }
        ).encode()
        return app.handle_post("/api/projects/proj-1/preflight", body)

    for name in _LOOP:
        resp = post(name)
        # 不是 403：它们过了这道门。后面因为项目没有 WFM1 身份而被网关 fail-closed
        # 拒绝是**另一回事**，且那正是它该有的诚实行为。
        assert resp.status != 403, f"{name} 被无花费门挡住了"

    resp = post("submit-video-generation")
    assert resp.status == 403
    assert json.loads(resp.body.decode())["error"]["category"] == "forbidden"


def test_an_unresolvable_shot_is_refused_with_the_reason_not_a_fake_success(tmp_path):
    """镜头没有正式记录时：拒绝，并说出拒的是什么。

    这是 Studio 项目的常态 —— 分镜还没锁定成正式版本，就没有可绑的记录。
    **实测出来的顺序值得记下来**：网关在 target 绑定这一步就 fail closed（409
    ``command_refused``），比 preview 的 blockers 更早，所以「缺项目身份」那条
    blocker 在这种项目上根本轮不到出场。我原本假设的是后者，实跑推翻了它 ——
    这里钉的是**真实行为**，不是我以为的行为。

    关键性质：它绝不静默成功。评价不会被写到一个猜出来的目标上。
    """
    import json

    app = srv._App(tmp_path / "account")
    root = tmp_path / "proj"
    root.mkdir()
    app._projects["proj-1"] = root
    body = json.dumps(
        {
            "command_id": "c-1",
            "name": RECORD_EVALUATION,
            "target": {"ref": "sh-1", "version": 1, "content_digest": "a" * 64},
            "params": {
                "evaluation_id": "e-1",
                "criterion": "dailies-review",
                "pass": True,
                "rationale": "看过了",
            },
        }
    ).encode()
    resp = app.handle_post("/api/projects/proj-1/preflight", body)
    assert resp.status == 409, resp.body
    err = json.loads(resp.body.decode())["error"]
    assert err["category"] == "command_refused"
    # 说得出拒的是哪个目标 —— 界面靠这句话告诉创作者下一步该补什么
    assert "sh-1" in err["detail"]
    assert "missing target" in err["detail"]


def test_review_target_is_readable_in_both_modes_and_404s_honestly(tmp_path):
    """审片目标由后端算，且非付费模式也拿得到 —— 审片不花钱。

    这条路由存在的理由：``CommandEnvelope`` 要求 target 带一个真实的 sha256，
    浏览器算不出来。它编一个的后果不是被拒，是把命令绑在一个不存在的版本上。

    没有正式镜头记录时回 404 —— 那是一个**产品答案**（「这一镜还没锁定正式分镜」），
    界面据此如实说明，而不是把评价写到一个猜出来的目标上。
    """
    import json

    app = srv._App(tmp_path / "account")
    assert app.paid is False
    root = tmp_path / "proj"
    root.mkdir()
    app._projects["proj-1"] = root

    resp = app.handle("/api/projects/proj-1/review-target?shot_id=sh-1")
    assert resp.status == 404, resp.body
    assert json.loads(resp.body.decode())["error"]["category"] == "not_found"

    # 付费专用的那条仍然被付费模式挡着 —— 本卡没有放宽它
    assert (
        app.handle("/api/projects/proj-1/generation-target?shot_id=sh-1").status == 403
    )

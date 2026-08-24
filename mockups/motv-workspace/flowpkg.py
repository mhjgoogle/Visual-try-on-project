#!/usr/bin/env python3
"""Flow packages — 「整条流程」这一级的可复用物（ADR-0084 / TASK-105 第一刀）。

我们有二十几个单步 Skill，**没有「整条流程」这一级的可复用物**，新项目从空白开始
（GAP-21）。一个 Flow 包就是那一级：它说「先做哪一步、每一步用哪个版本的能力、
这部作品的约定是什么」。

**它是 `skillpkg` 的第二个 kind，不是第二套机制**（ADR-0084 决策 1）。包机制已经
付过代价解决的四件事，对模板逐条同样必要，所以这里**复用**而不是重写：

| 复用的 | 从哪来 |
| --- | --- |
| 读包文件 + 「文件不得链到包外」围栏 | `skillpkg.read_package_files`（同一份代码） |
| 内容散列（跨平台、跨路径、跨行尾稳定） | `skillpkg.compute_digest`（同一份代码） |
| 三级来源与整体覆盖、目录围栏 | `skillpkg._package_dirs` 与 `load_catalog` 同形 |
| **跨来源不回退的两种粒度** | `skillpkg._shadowed_by_broken`（同一份代码） |
| 加载失败 fail-closed，绝不「尽力加载一部分」 | ADR-0067 决策 7，这里逐字适用 |
| 错误类型 | `SkillPackageError` —— 调用方的 `except ValueError` 一处不用改 |

**本模块不执行任何东西。** 它读、校验、返回一个冻结的 `Flow`。谁在什么时候按哪一步
是应用层的事；套用模板**不获得**付费、定稿、锁定、导出中的任何一种（ADR-0084 决策 4
＝ ADR-0066 决策 6 的四条禁令落到模板层）。
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from skillpkg import (
    SOURCE_ORDER,
    Catalog,
    SkillPackageError,
    SkillProblem,
    _package_dirs,
    _shadowed_by_broken,
    compute_digest,
    read_package_files,
)

#: 三个文件就是这个包。全都必需 —— 缺一个不是「能用一半的包」，是无效的包。
#: 与 Skill 包的三件套一一对应（ADR-0084 决策 2）：manifest 是机器读的契约，
#: `flow.md` 是要被人读、被人改、被 diff 审阅的散文，`seed.json` 是结构。
FLOW_FILES = ("manifest.json", "flow.md", "seed.json")

#: `kind` 的值。写进 manifest 而不是靠目录位置推断：一个包搬到哪里都还是它自己。
FLOW_KIND = "flow"

#: 自己遍历时的深度上限。JSON 本身没有深度限制，而**我们**有：一份嵌套两万层的
#: 包会在遍历时打爆解释器栈，而那是一个 `RecursionError`，不是一条 problem。
#: 100 层远超任何真实模板（集 → 场 → 镜 大约四层）。
_MAX_JSON_DEPTH = 100

_REQUIRED = ("flowId", "flowVersion", "kind", "title", "purpose", "steps")
_OPTIONAL = ("conventions", "deprecated")
_REQUIRED_STEP = ("stepKey", "skillId", "skillVersion")
_OPTIONAL_STEP = ("note",)


def _no_constants(name: str):
    """`NaN` / `Infinity` / `-Infinity` 这三个**字面量**不是 JSON，这里不收。"""
    raise SkillPackageError(f"不是合法 JSON：{name}（JSON 没有这个字面量）")


def _reject_unwritable(node: object, where: str, depth: int = 0) -> None:
    """任何一处**编码不出去的值**都拒绝，并说出它在哪一层。

    两类，来源不同、后果一样 —— 都会让 `json.dumps` 吐出别人读不了的东西，
    于是**一个包坏掉，整条 `/api/flows` 对所有客户端都坏掉**：

    * **非有限浮点**。只挡 `NaN` / `Infinity` 字面量是不够的（审查轮 3 → 轮 6）：
      `1e400` 是完全合法的 JSON 数字**字面量**，`json.loads` 把它算成 `inf`，
      `parse_constant` 根本不会被调用。挡「非有限」这个**性质**，不挡某一种写法。
    * **编码不出 UTF-8 的字符串**（孤立代理项）。语法合法、Python 收得下，但写
      `studio/flow.json` 时 `.encode("utf-8")` 抛 `UnicodeEncodeError`，那是一个
      `ValueError` 不是 `OSError`，会绕过只接 `OSError` 的回滚，留下半个项目，
      之后每次重试都答「已存在」（审查轮 10）。

    两者都在**读入的那一刻**拒绝，别让它们走到写出那一步。深度在同一趟里检查，
    因为遍历本身就是会爆栈的那件事。
    """
    if depth > _MAX_JSON_DEPTH:
        raise SkillPackageError(
            f"{where} 嵌套过深（超过 {_MAX_JSON_DEPTH} 层）—— 模板是结构骨架，"
            "不该有这种深度"
        )
    if isinstance(node, float) and not math.isfinite(node):
        raise SkillPackageError(
            f"{where or '顶层'} 不是合法 JSON：{node}（JSON 只有有限数字）"
        )
    if isinstance(node, str):
        try:
            node.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise SkillPackageError(
                f"{where or '顶层'} 含无法编码为 UTF-8 的字符（孤立代理项）"
            ) from exc
    if isinstance(node, dict):
        for key, value in node.items():
            _reject_unwritable(
                value, f"{where}.{key}" if where else str(key), depth + 1
            )
    elif isinstance(node, list):
        for i, value in enumerate(node):
            _reject_unwritable(value, f"{where}[{i}]", depth + 1)


def _loads(text: str, what: str):
    """本模块**唯一**的 JSON 入口 —— 两个文件都走它，免得只有一个被加固。

    出门的只有 `SkillPackageError`：解析器的 `RecursionError` 也在这里被翻译成
    「这个包坏了」，否则 `load_flow_catalog` 只接 `SkillPackageError`，一个写坏的
    用户包就能把列表路由和「新建项目」一起打崩（审查轮 6）。
    """
    try:
        parsed = json.loads(text, parse_constant=_no_constants)
    except json.JSONDecodeError as exc:
        raise SkillPackageError(f"{what} 不是合法 JSON：{exc}") from exc
    except RecursionError as exc:
        raise SkillPackageError(f"{what} 嵌套过深，解析不了") from exc
    try:
        _reject_unwritable(parsed, "")
    except RecursionError as exc:
        raise SkillPackageError(f"{what} 嵌套过深，检查不了") from exc
    return parsed


@dataclass(frozen=True)
class FlowStep:
    """一步。引用的是**版本化的能力**，不是能力的名字。

    带版本是 ADR-0084 决策 2 的原话，理由是：只写 `skillId` 的话，模板会随着
    Skill 演进悄悄换了含义 —— 一年后同一份模板做的是另一件事，而没有任何地方
    记着它变过。
    """

    step_key: str
    skill_id: str
    skill_version: int
    note: str = ""


@dataclass(frozen=True)
class Flow:
    """一份加载好的流程模板。冻结：套用它的人读它，没有人写回去。"""

    flow_id: str
    version: int
    title: str
    purpose: str
    steps: tuple[FlowStep, ...]
    conventions: Mapping[str, object]
    seed: Mapping[str, object]
    narrative: str
    deprecated: bool
    digest: str
    source: str
    path: str

    def created_from(self) -> dict:
        """新项目记的那三个字段（ADR-0084 决策 5）。

        三个一个不少，理由与 ADR-0067 决策 3 逐字相同：`flowVersion` 回答
        「作者说这是第几版」，`flowDigest` 回答「那一版到底是什么」。
        只有后者能让一年后的溯源链闭合。
        """
        return {
            "flowId": self.flow_id,
            "flowVersion": self.version,
            "flowDigest": self.digest,
        }


@dataclass(frozen=True)
class FlowCatalog:
    """加载结果：能用的流程，以及每一个不能用的**为什么**不能用。"""

    flows: Mapping[str, Flow]
    problems: tuple[SkillProblem, ...]

    def get(self, flow_id: str) -> Flow | None:
        return self.flows.get(flow_id)


def _read_manifest(raw: object, directory: Path) -> dict:
    """校验 manifest，返回规范化后的 dict。任何一处不合法都 raise。"""

    if not isinstance(raw, dict):
        raise SkillPackageError("manifest.json 必须是一个对象")
    missing = [k for k in _REQUIRED if k not in raw]
    if missing:
        raise SkillPackageError(f"manifest.json 缺少：{'、'.join(missing)}")
    unknown = [k for k in raw if k not in _REQUIRED + _OPTIONAL]
    if unknown:
        # 不认识的字段一律拒绝，不静默忽略：一个拼错的 `covnentions` 被忽略掉，
        # 表现是「约定没生效」，而没有任何地方说过它没生效。
        raise SkillPackageError(f"manifest.json 有无法识别的字段：{'、'.join(unknown)}")

    if raw["kind"] != FLOW_KIND:
        raise SkillPackageError(
            f"kind 必须是 {FLOW_KIND!r}，这个包写的是 {raw['kind']!r}"
        )
    for key in ("flowId", "title", "purpose"):
        if not isinstance(raw[key], str) or not raw[key].strip():
            raise SkillPackageError(f"{key} 必须是非空字符串")
    version = raw["flowVersion"]
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        # `bool` 先挡掉：Python 里 `True == 1`，一个 `"flowVersion": true`
        # 会安静地变成第 1 版。
        raise SkillPackageError("flowVersion 必须是 >= 1 的整数")
    if raw["flowId"] != directory.name:
        # 目录名就是这个包在磁盘上的地址；两者不一致 = 「这是哪个流程」有两个答案。
        raise SkillPackageError(
            f"manifest.json 的 flowId（{raw['flowId']}）"
            f"与目录名（{directory.name}）不一致"
        )

    steps = raw["steps"]
    if not isinstance(steps, list) or not steps:
        raise SkillPackageError("steps 必须是非空数组 —— 没有步骤的流程不是流程")
    seen_keys: set[str] = set()
    parsed: list[FlowStep] = []
    for i, step in enumerate(steps):
        where = f"steps[{i}]"
        if not isinstance(step, dict):
            raise SkillPackageError(f"{where} 必须是一个对象")
        step_missing = [k for k in _REQUIRED_STEP if k not in step]
        if step_missing:
            raise SkillPackageError(f"{where} 缺少：{'、'.join(step_missing)}")
        step_unknown = [k for k in step if k not in _REQUIRED_STEP + _OPTIONAL_STEP]
        if step_unknown:
            raise SkillPackageError(
                f"{where} 有无法识别的字段：{'、'.join(step_unknown)}"
            )
        for key in ("stepKey", "skillId"):
            if not isinstance(step[key], str) or not step[key].strip():
                raise SkillPackageError(f"{where}.{key} 必须是非空字符串")
        sv = step["skillVersion"]
        if isinstance(sv, bool) or not isinstance(sv, int) or sv < 1:
            raise SkillPackageError(f"{where}.skillVersion 必须是 >= 1 的整数")
        note = step.get("note", "")
        if not isinstance(note, str):
            raise SkillPackageError(f"{where}.note 必须是字符串")
        if step["stepKey"] in seen_keys:
            # 步骤键是这一步在流程里的身份（界面用它定位）。重复 = 两步同名 =
            # 引用指向哪一步说不清。
            raise SkillPackageError(f"{where}.stepKey 重复：{step['stepKey']}")
        seen_keys.add(step["stepKey"])
        parsed.append(
            FlowStep(
                step_key=step["stepKey"],
                skill_id=step["skillId"],
                skill_version=sv,
                note=note,
            )
        )

    conventions = raw.get("conventions", {})
    if not isinstance(conventions, dict):
        raise SkillPackageError("conventions 必须是一个对象")
    deprecated = raw.get("deprecated", False)
    if not isinstance(deprecated, bool):
        raise SkillPackageError("deprecated 必须是布尔值")

    return {
        "flowId": raw["flowId"],
        "flowVersion": version,
        "title": raw["title"],
        "purpose": raw["purpose"],
        "steps": tuple(parsed),
        "conventions": conventions,
        "deprecated": deprecated,
    }


#: 「结构」与「内容」的分界里**机器能执行的那一半**（ADR-0084 决策 3）。
_FORBIDDEN_SEED_KEYS = {
    "assetRegistry": "资产登记表",
    "generationRegistry": "生成登记表",
    "skillRuns": "Run 记录",
    "media": "媒体",
    "timelines": "时间线",
}


def _scan_seed(node: object, where: str, depth: int = 0) -> None:
    """递归找禁止字段。

    **只查顶层是不够的**（审查轮 1）：`{"episodes": [{"media": [...]}]}` 在顶层
    完全干净，而它带的正是这条边界要挡住的东西 —— 而且 seed 天生是嵌套的
    （集 → 场 → 镜），顶层检查等于只挡住最不可能出现的那一层。
    """

    if depth > _MAX_JSON_DEPTH:
        # `_loads` 已经在同一份数据上先走过一遍并拒掉了这种深度；这一条是
        # 「不依赖调用顺序」——一趟无界的递归不该靠另一趟来保护。
        raise SkillPackageError(f"seed.json 的 {where} 嵌套过深")
    if isinstance(node, dict):
        present = [label for key, label in _FORBIDDEN_SEED_KEYS.items() if key in node]
        if present:
            raise SkillPackageError(
                f"seed.json 的 {where} 不得包含{('、'.join(present))} —— "
                "模板带结构不带内容，更不带媒体字节（ADR-0084 决策 3）"
            )
        for key, value in node.items():
            _scan_seed(value, f"{where}.{key}" if where else key, depth + 1)
    elif isinstance(node, list):
        for i, value in enumerate(node):
            _scan_seed(value, f"{where}[{i}]", depth + 1)


def _check_seed(raw: object) -> dict:
    """`seed.json` 是**结构骨架**，不是内容（ADR-0084 决策 3 的硬边界）。

    这里执行那条边界里可以被机器执行的那一半：媒体、登记表、Run **一律不许出现**，
    **在任何深度上**。「不带剧本内容」那半是人的判断（一个 `title` 字段里可以塞进
    整本剧本），机器拦不住，所以 ADR 把它写成了硬边界而不是校验规则 ——
    这里如实只拦住能拦的。
    """

    if not isinstance(raw, dict):
        raise SkillPackageError("seed.json 必须是一个对象")
    _scan_seed(raw, "")
    return raw


def load_flow(directory: Path, source: str) -> Flow:
    """加载并校验**一个** Flow 包。不合法就 raise ``SkillPackageError``。"""

    files = read_package_files(directory, FLOW_FILES, what="Flow 包")

    manifest_raw = _loads(files["manifest.json"], "manifest.json")
    seed_raw = _loads(files["seed.json"], "seed.json")

    manifest = _read_manifest(manifest_raw, directory)
    seed = _check_seed(seed_raw)

    narrative = files["flow.md"]
    if not narrative.strip():
        # 空的 `flow.md` 意味着这个流程没有任何人读得懂的说明。它是三件套里
        # 唯一写给人的那一份，空着等于这个包只剩机器能用。
        raise SkillPackageError("flow.md 为空 —— 它是三件套里写给人的那一份")

    return Flow(
        flow_id=manifest["flowId"],
        version=manifest["flowVersion"],
        title=manifest["title"],
        purpose=manifest["purpose"],
        steps=manifest["steps"],
        conventions=manifest["conventions"],
        seed=seed,
        narrative=narrative.rstrip("\n"),
        deprecated=manifest["deprecated"],
        digest=compute_digest(files),
        source=source,
        path=str(directory),
    )


def resolve_steps(flow: Flow, catalog: Catalog) -> list[str]:
    """`flow` 的每一步在 `catalog` 里都找得到吗？返回**缺什么**的说明列表。

    ADR-0084 决策 6：缺任何一个 → 这份模板不可用，**并说出缺的是哪一个**，
    不静默跳过那一步。理由与 ADR-0067 决策 7 是同一个失效形状 —— 跳过一步的
    流程会安静地少做一件事，而少做的那件事**在结果上看不出来**。

    版本也要对得上：能力还在但版本变了，模板引用的就不是它当初引用的那个东西。
    """

    missing: list[str] = []
    for step in flow.steps:
        skill = catalog.skills.get(step.skill_id)
        if skill is None:
            missing.append(f"{step.step_key}：缺能力 {step.skill_id}")
        elif skill.version != step.skill_version:
            missing.append(
                f"{step.step_key}：{step.skill_id} 需要 v{step.skill_version}，"
                f"本机是 v{skill.version}"
            )
    return missing


def load_flow_catalog(
    roots: Sequence[tuple[str, Path | None] | tuple[str, Path | None, Path | None]],
    *,
    skills: Catalog | None = None,
) -> FlowCatalog:
    """按 ``SOURCE_ORDER`` 发现并合并所有 Flow 包。

    形状与 `skillpkg.load_catalog` 一致（同一套三级来源、同一个「更靠前的来源
    整体覆盖」、同一个目录围栏），因为 ADR-0084 决策 1 说的就是复用这套机制。

    `skills` 给了就顺带做 ADR-0084 决策 6 的步骤解析：解析不了的 Flow **不进
    结果**，而是变成一条说明它缺什么的 problem。不给（还没装能力目录时）就只做
    包自身的校验。
    """

    by_source: dict[str, dict[str, Flow]] = {}
    problems: list[SkillProblem] = []
    unreadable_sources: set[str] = set()

    for root_spec in roots:
        source, directory = root_spec[0], root_spec[1]
        contain_within = root_spec[2] if len(root_spec) > 2 else None
        if source not in SOURCE_ORDER:
            raise ValueError(f"unknown flow source: {source}")
        if source in by_source:
            raise ValueError(f"duplicate flow source: {source}")
        found: dict[str, Flow] = {}
        by_source[source] = found
        if directory is None:
            continue
        entries, unreadable = _package_dirs(directory, contain_within)
        if unreadable:
            # 整个来源读不出来时，我们**不知道**它本来有哪些 id，所以它遮蔽
            # 下面每一个 id —— 与 skillpkg 同一条理由（codex 跨模型复审）。
            problems.append(SkillProblem("", source, str(directory), unreadable))
            unreadable_sources.add(source)
            continue
        for entry in entries:
            try:
                flow = load_flow(entry, source)
            except SkillPackageError as exc:
                problems.append(SkillProblem(entry.name, source, str(entry), str(exc)))
                continue
            if skills is not None:
                gaps = resolve_steps(flow, skills)
                if gaps:
                    problems.append(
                        SkillProblem(
                            flow.flow_id,
                            source,
                            str(entry),
                            "这份流程引用的能力本机没有：" + "；".join(gaps),
                        )
                    )
                    continue
            found[flow.flow_id] = flow

    merged: dict[str, Flow] = {}
    # PER SOURCE（与 skillpkg 同）：把所有 problem 的 id 混成一个集合，会让某个
    # 来源里的一个坏包把**别的来源**的同名 id 也标成坏的。
    broken_by_source: dict[str, set[str]] = {}
    for problem in problems:
        broken_by_source.setdefault(problem.source, set()).add(problem.skill_id)
    for source in SOURCE_ORDER:
        for flow_id, flow in by_source.get(source, {}).items():
            if flow_id in merged:
                continue
            # 跨来源**不回退**（ADR-0067 决策 7，逐字适用于 flow）。上一版这里
            # 只是「跳过读不出来的那个来源」，于是更低优先级的同名流程照常合进来
            # —— 那正是这条规则要禁的：创作者以为自己的定制在生效，实际生效的是
            # 内置那一份（审查轮 1，两条 blocking 是它的两种粒度）。
            #
            #   * 那个来源里**这一个包**坏了 → 只有这个 id 被遮蔽；
            #   * 那个来源的**根读不出来** → 每一个 id 都被遮蔽，因为我们不知道
            #     它本来会覆盖哪些。
            if _shadowed_by_broken(
                flow_id, source, broken_by_source, unreadable_sources
            ):
                continue
            merged[flow_id] = flow

    return FlowCatalog(flows=merged, problems=tuple(problems))

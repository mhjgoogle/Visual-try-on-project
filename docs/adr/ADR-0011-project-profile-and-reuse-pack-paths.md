# ADR-0011: 项目实例 Profile 与账户级复用包的目录、所有权与迁移规则

- Status: Accepted
- Date: 2026-08-01
- Scope tasks: TASK-018
- Amends: ADR-0001（WFM1 增补——仅新增路径，不改既有条目）
- Preserves: TASK-014 合同 4 / ADR-0001 WFM1 增补的**账户根规则**
  （账户根 = 项目根父目录；直接子目录含 `config/wfm1.json` 者为项目），
  该规则被 `budget/account.py` 的月度守门与 `.wfm1-budget.lock` 依赖，
  本 ADR **不改变**它。

## Context

TASK-018 需要把"一集一次的项目实例"与"跨项目复用的资产版本"分开。项目
实例需要一份带版本与 digest 的 profile（创作目标基准）；复用资产需要
账户级、只读、不可变版本的存放位置，并被项目以
`asset_id + version + content_digest` 引用。任何新增物理路径按 ADR-0007
§7 必须先经 ADR 授权。

## Decision — 目录与路径

**项目内（相对项目根，经 ADR-0004 `resolve_within_root` 准入）：**

- `profile/project_profile_v<N>.json` — 项目实例 profile 的第 N 个
  **不可变版本**（v1 起；修订=新版本文件，旧版本保留，绝不覆盖）。
- `profile/reuse_refs.json` — 项目对复用资产的引用表：
  `{asset_id, version, content_digest}` 列表。原子重写，仅允许**新增**
  条目；同一 `asset_id` 已存在即拒绝（替换属显式后续操作，非本任务）。

**账户级（相对账户根；账户根沿用既有规则）：**

- `reuse/<asset_id>/v<N>.json` — 一个复用资产的第 N 个**不可变已发布
  版本**（完整 JSON 文档：schema_version/asset_id/version/kind/content）。
  发布即创建，已存在即拒绝；任何"更新"= 发布新版本号。
- `reuse/` 目录本身**不含** `config/wfm1.json`，因此被
  `budget/account.py::_project_dirs` 的项目发现规则自然跳过——月度账本
  与账户预算锁语义不受影响（本 ADR 的兼容性要点）。
- `asset_id` 与版本号是路径组件：`asset_id` 必须是安全路径组件
  （非空、无 `/`、`\`、`..`、不以 `.` 开头），版本为正整数；所有读写
  经 containment 校验，路径逃逸 fail-closed。

## Decision — 所有权（唯一写入者）

- `profile/project_profile_v<N>.json`：TASK-018 profile 模块的写入器是
  唯一写入者（创建型，防覆盖）。
- `profile/reuse_refs.json`：TASK-018 reuse 模块的 add-ref 操作是唯一
  写入者（原子重写、只增条目）。
- `reuse/<asset_id>/v<N>.json`：TASK-018 的 publish 操作是唯一写入者
  （创建型，防覆盖）；对项目侧永远只读。
- Provider、Orchestrator、budget、approval 等既有组件**不读不写**这些
  文件；反向地，profile/reuse 模块不写任何既有业务状态文件。

## Decision — digest 与引用语义

- 复用版本的 `content_digest` = 该版本完整文档的 canonical-JSON SHA-256
  （复用 `digests.config_digest`，与 catalog digest 同一规范）。
- 项目引用必须同时锁定 `asset_id + version + content_digest`；解析时
  重新计算 digest 并比对，缺失/版本漂移/digest 漂移一律 fail-closed。
  **禁止**任何"latest"式可变引用。
- profile 的 digest 同样由 canonical-JSON 计算，`(version, digest)`
  构成后续评价的精确基准。

## Decision — 迁移

无迁移：全部为新增路径。既有项目与原 M1 项目不含这些文件时**一切照常**
（profile 完全可选，任何既有流程不读取它）；不把跨项目绝对路径写入项目
文件（引用只含 `asset_id/version/digest`，账户根由运行时规则解析）。

## Consequences

- 项目实例与复用资产获得分离的所有权与生命周期，引用可审计、不可漂移；
- 账户根规则与月度预算守门零改动（`reuse/` 被项目发现规则自动忽略）；
- 未来只读 projection 可以从 `profile/` 与 `reuse/` 的权威 JSON 派生项目
  清单与复用来源，无需按文件名猜测。

## Not decided here

- 复用包的远程存储/同步、自动选材与推荐（后续任务）；
- 阶段审批对 profile/复用引用的失效联动（TASK-019）；
- 复用引用的显式替换/升级流程（后续任务）。

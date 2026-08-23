# TASK-062：Integration / Production Graph

- 状态：**实现已完成并在基线内（2026-08-23 复查）；产品验收待用户在真实 Connected Project 上确认**
  —— ~~进行中~~ 是状态漂移。证据：canvas 迁移 `v13 → v14` 在位；生成登记 linkage 贯穿 `app.js` / `ui/cutreview.js` / `ui/production.js`。
  当前 `CANVAS_SCHEMA_VERSION = 18`，本卡那一级迁移之上又叠了四个版本 —— 到不了 v18
  而这一级没落地。**未代签的部分**：本卡验收清单要求在真实项目上逐条确认，那是
  AGENTS.md §1 归产品负责人的判断，本 Agent 不代签
- ADR：[ADR-0059](../adr/ADR-0059-production-graph-identity-contract.md)
- baseline：`05c3f5d`
- 风险级别：**高**（schema v13→v14 迁移 + 生成登记 linkage）→ 全量 pytest + 全量前端 + ruff + Codex 独立审查

## 1. 目标

不新增页面功能。把已经完成的七层用**真实 ID/reference contract** 贯通：

    Story/Canon → AI Director → Skill Run → Proposal → Generation Input
    → Generation → Asset → Shot QC/Approval → Timeline/Final → Workflow Provenance

## 2. 要求对照（用户 10 条）

| # | 要求 | 现状 | 本任务 |
| --- | --- | --- | --- |
| 1 | Director 的 observation/decision 可追溯到真实 context | 每 module 各读各的，不暴露 id | 统一 `productionModel`，返回 `context` id |
| 2 | Skill Run 记录 skill / version / runtime-model / target context / resulting Proposal | 前三项已有；context 只是人读字符串；proposal 无 id | 加 `context` id + `proposalId` |
| 3 | Proposal 接受后触发的 action 能关联该 Generation | 无 | `generation.origin = {skillRunId, proposalId}`，**仅显式路径** |
| 4 | Generation → Asset canonical linkage | ✅ 已有 | 不回归 |
| 5 | QC/approval 绑定具体 media asset/take | ✅ ADR-0057 | 不回归 |
| 6 | Provenance 覆盖 Story/Canon → Director/Skill/Proposal → Generation → Asset → QC → Final | 缺左半边 | 新增 canon/skillRun/proposal 节点与边 |
| 7 | graph 仍是 derived read model，不 persist topology | ✅ | 不回归 |
| 8 | canonical story 不复制进 Asset/Skill/Workflow | ✅ | 不回归 |
| 9 | Director 统一 Production read model（8 个来源） | 部分 | 新建 |
| 10 | 旧记录诚实显示 unknown，不猜测 | 无 | 迁移写 null + 界面「未记录」 |

## 3. 文件归属（AGENTS.md 规则 14/15）

    mockups/motv-workspace/src/services/canvasschema.js     v13→v14 迁移 + 校验
    mockups/motv-workspace/src/workflow/skillrun.js         context / proposalId
    mockups/motv-workspace/src/workflow/genlib.js           origin
    mockups/motv-workspace/src/workflow/provenance.js       canon/skillRun/proposal 节点
    mockups/motv-workspace/src/workflow/prodgraph.js        （新）统一 Production 读模型
    mockups/motv-workspace/src/ui/director.js               改为在统一模型上取数
    mockups/motv-workspace/src/ui/wfgraph.js                渲染 + Inspector
    mockups/motv-workspace/src/app.js                       控制器接线
    mockups/motv-workspace/styles/wfgraph.css
    mockups/motv-workspace/tests/prodgraph.test.mjs         （新）
    tests/test_motv_prodgraph_task062.py                    （新）

**不属于本任务**：TASK-049/050/052 工装、`gate.*`、`workspace_shell`、
`server.py` 的上传端点。

## 4. 验收

真实 Connected Project「夜班沉默」，至少证明一条真实链：

    Episode/Shot → Skill/Proposal → manual Generation → uploaded Asset
    → Shot review → Workflow lineage

并证明 **Final 的既有 render lineage 不回归**。

### 4.1 结果（2026-08-12）

Playwright 驱动**真实 studio → 真实后端 → 真实项目**。项目每次运行前还原到
v13 基线，因此 v13→v14 迁移是在真实数据上跑的，不是构造出来的。

| 步骤 | 结果 |
| --- | --- |
| v13 真实项目在 v14 应用中打开 | ✅ 迁移后保存为 v14 |
| 「建立当前基线」（真实 UI 动作）→ canon 基线 | ✅ `{outline: 1}`，图上出现「作品基线」节点 |
| Skill Run → Proposal → Generation(origin) | ✅ 三个 id 全部持久化并可重读 |
| context 落地 | ✅ `{episodeId, sceneId, shotId}` 三层齐全 |
| origin 落地 | ✅ `{skillRunId, proposalId}` |
| **8 条既有 generation 迁移后 `origin = null`** | ✅ 未回填、未推断 |
| Workflow 显示 作品基线 / 能力运行 / 提案 | ✅ 完整链路高亮，其余变暗 |
| 提案 Inspector：由它发起的生成 + 「不是被生成出来的」 | ✅ |
| 运行 Inspector：能力 v1 · local · claude_code · **模型 未记录** · 读取的上下文 | ✅ |
| 审片「通过」（真实 UI 动作）→ 绑定具体 take | ✅ `approved take = asset-faea54c1…` |
| 成片链路仍然渲染 | ✅ 无回归 |
| JS 异常 | **0** |
| 失败请求 | 1 个，已知的 `account_scope` 403（见 TASK-061 §3.1） |

### 4.2 诚实的缺口：Skill 层没有 UI 入口

`ctx.skills.*`（run / submitManual / accept / reject / originOf）在 `app.js`
之外**没有任何调用者**——CP3 建成了运行时、技能表与控制器，但 studio 里从来
没有发起一次 Skill 运行的界面。因此：

- 本次验收中的 Skill Run / Proposal 是用**真实 domain 模块**构造并经**真实后端**
  持久化的，不是点出来的。链路本身是真的，入口不存在是真的。
- 同理，`ctx.episode.importResult(..., fromSkillRunId)` 的第 5 个参数
  （origin 来源）目前没有 UI 调用者：没有提案界面，就没有「从这份提案发起生成」
  这个动作可点。

本任务**不新增页面功能**（用户明确边界），因此这两个入口留给下一阶段。合同、
持久化与图上的呈现都已就位，接上界面时无需再改数据层。

## 5. Scope guard

**不做**：Media API Provider、global/shared Asset Library、project rename/move/
export、TASK-056、asset path migration、TASK-049/050/052。**不新增页面功能。**

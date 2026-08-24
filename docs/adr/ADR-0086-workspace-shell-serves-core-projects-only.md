# ADR-0086：`workspace_shell` 只服务 WFM1 核心项目 —— Portfolio 对 Studio 项目为空是**正确行为**

- 状态：**Accepted**（实施 Agent 自行 Accept，2026-08-24）
- 依据：AGENTS.md §1 —— 这是纯技术范围决策，不涉付费、不动用户数据。
  它欠了两张卡：[TASK-083](../tasks/done/TASK-083-phase3-adrs-first.md) §5.1 要求
  「顺带在文档里明确它的去留」，[TASK-103](../tasks/done/TASK-103-frontback-and-ui-residuals.md)
  批次 B 声明会做 —— **2026-08-24 全仓 grep 找不到任何记下来的结论**。
  本 ADR 就是那个结论。
- 日期：2026-08-24
- 相关：[ADR-0032](ADR-0032-workspace-runtime-and-ui-topology.md)（只读边界）、
  [ADR-0033](ADR-0033-command-gateway-contract.md)（Gateway 合同）、
  [ADR-0053](ADR-0053-project-rooted-studio-storage.md)（Studio 项目的形状）、
  GAP-05 / C-020（[UI 差距分析](../../src/ui-gap-audit/reports/ui-gap-analysis.md)）

## 背景

C-020 实测：`workspace_shell` 打开真实的 Studio 项目时，**Portfolio 全空**。
原因很具体 —— `discover_projects` 认的是 `config/wfm1.json`，而 Studio 建的项目
只有 `project.json`（四个字段）+ `studio/canvas.json` + `media/`。

GAP-05 把这件事记成了一个待决问题，并给了两条路：

> 决定 `workspace_shell` 的去留 —— 要么让它能发现 Studio 项目，要么明确它只服务
> WFM1 核心项目并在文档里说清。

GAP-05 的另外两项（四个 LOW-risk 命令注册进 Studio、审片页接 `record-evaluation`）
已由 TASK-103 批次 B 完成。**只剩这一条**，而它挡着 [TASK-027](../tasks/done/TASK-027-workspace-lineage-comparison-and-cost.md)
part-2b —— 那两个页面要加在哪个壳里，取决于这个答案。

## 决策

### 决策 1：保留 `workspace_shell`，并明确它的主语是 **WFM1 核心项目**

它是**核心事实的只读观察面**：谱系、成本、任务包、审批、评价/反馈/行动。
这些事实住在核心项目的 `config/` `records/` `manifests/` 里，而那正是
`config/wfm1.json` 标识的那种项目。

### 决策 2：**不**让 `discover_projects` 接纳 Studio 项目

这是本 ADR 真正要拒绝的那条路，理由不是「工作量」，是**它会让壳开始说谎**：

Studio 项目里**没有**核心事实。让它出现在 Portfolio 里，创作者点进去看到的是
每一页都空的谱系、空的成本、空的任务包 —— 而这一次它看起来是「功能坏了」，
而不是「这个项目不归这里管」。

**「Portfolio 不空了，但每一页都是空的」严格劣于一个诚实的空 Portfolio。**
后者说的是真话；前者把一个范围问题伪装成了一堆缺陷。这与 ADR-0032 的 fail-closed
是同一条：查询失败要给出结构化的问题，**绝不给空结果**。

### 决策 3：因此「Portfolio 对 Studio 项目为空」**不是缺陷**，C-020 就地结案

它是决策 1 的直接推论。**但空得要说话**：壳在账户根下一个核心项目都没发现时，
应当说明它找的是什么（`config/wfm1.json`），而不是渲染一个没有解释的空列表 ——
「装了却没生效必须可见」在这里同样适用。这一条记为
[TASK-087](../tasks/active/TASK-087-followup-ledger.md) §6.8，不阻塞本决策。

### 决策 4：创作者面的归属没有变，也不会因为本 ADR 变

创作者做片子的整个闭环在 **Studio**：四个 LOW-risk 命令已经注册在它的 Gateway
里（TASK-103 批次 B），审片页的「✓ 通过」落 `record-evaluation`。
**`workspace_shell` 不是创作者的第二个入口**，它是观察面。

两者共用同一份**公开**查询包 `ai_video_workflow.workspace`，也共用同一个 Command
Gateway 合同 —— 共用的是**能力**，不是界面。

### 决策 5：TASK-027 part-2b 落在 `workspace_shell`，验收环境是真实的**核心**项目

part-2b（候选/选中并排媒体比较、`reuse_usage` 下游使用页）的主语是谱系与复用，
是核心事实，所以它属于观察面。

AGENTS.md §20「真实 Connected Project 是主要验收环境」**照常适用，但要读对**：
那条规则要的是「别拿 demo seed 和 SVG 占位素材当验收依据」。对 Studio 功能，
真实环境是一个真实的 Studio 项目；对 `workspace_shell` 的功能，真实环境是一个
**真实的核心项目**。拿 Studio 项目去验观察面，验的是决策 2 已经拒绝的那件事。

## 后果

### 正面

- 两张卡欠了很久的那个结论有了，`workspace_shell` 的边界写下来了。
- C-020 从「一个没人敢动的缺陷」变成「一条已解释的范围事实」。
- TASK-027 part-2b 解除阻塞：知道加在哪、拿什么验。

### 代价（已接受）

- **两个壳并存**，而且会长期并存。代价是创作者要知道「做片子在 Studio，
  看谱系与成本在观察面」。接受它，因为替代方案（合成一个壳）要么让观察面开始
  说谎（决策 2），要么把 Studio 变成核心项目的编辑器 —— 那是另一个数量级的决定。
- **两个壳各有一份前端**。共用的是查询包与 Gateway 合同，不是 UI 代码。

## 明确不做

- 不让 `discover_projects` 认 Studio 项目（决策 2）。
- 不把 `workspace_shell` 删掉。
- 不把创作者流程搬进 `workspace_shell`（决策 4）。
- 不改 ADR-0032 的只读边界、不改 ADR-0033 的 Gateway 合同。
- 不做「一个壳统管两种项目」——那需要先有一个统一的项目形状，而那是它自己的 ADR。

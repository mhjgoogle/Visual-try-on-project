# ADR-0097：技能只有一份源，客户端入口是生成物

- 状态：**Accepted**（2026-09-05，实施 Agent 依 [AGENTS.md](../../AGENTS.md) §1
  自行 Accept —— 纯技术决策：文件所有权、生成方向、清单格式。不动产品行为，不花钱）
- 关联：[TASK-131](../tasks/active/TASK-131-agent-harness-discovery-and-runtime-evidence.md)
  切片 B · [ADR-0077](ADR-0077-repository-path-ownership.md)（仓库路径所有权）·
  [ADR-0087](ADR-0087-document-lifecycle-and-default-agent-context.md) 决策 6（不留影子实现）

## 背景

同一套开发技能，两个客户端从**不同路径**发现：

| 客户端 | 发现路径 | 今天 |
| --- | --- | --- |
| Claude Code | `.claude/skills/<name>/SKILL.md` | 5 个都在 |
| Codex | `.agents/skills/<name>/SKILL.md`（官方 Build skills 文档） | 目录不存在，**一个也发现不了** |

后果不是报错，是**静默的不对称**：同一个仓库里，Claude 会话按 dev-workflow 走
四闸和轮次协议，Codex 会话什么也没加载，凭默认行为干活 —— 而两边的产出都会
进同一个分支。`agent_harness.py doctor`（切片 A）现在把这个差异摆出来了，
本 ADR 决定**怎么补**。

补的办法有两条，选哪条决定了往后每一次改技能的代价：

- **复制整个技能目录到 `.agents/skills/`** —— 上游 `sync_skills_to_codex.py` 的做法。
  代价是仓库里从此有两份 SKILL.md、两份 references，而它们必然会漂移。这正是
  ADR-0087 决策 6 禁止的「影子实现」，也是本仓库反复吃亏的那个形状（2026-08-23
  一天查出五处过期状态，全是同一份事实存在两处）。
- **只生成一个薄入口，指回唯一那份源** —— 本 ADR 选的。

## 决策

### 1. `.claude/skills/` 是唯一实现源，`.agents/skills/` 只放生成的薄入口

薄入口里**只有**：frontmatter 的 `name` / `description`、规范源的仓库相对路径、
以及一句「先读那份文件再执行」。**不复制** `scripts/`、`references/`，也不复制
治理正文 —— 复制多少字，就是往后要对齐多少字。

因此 `.agents/skills/` 是**生成产物**，不是第二份实现。ADR-0077 的路径所有权表
增加这一行；`docs/current-architecture.md` §1 的「Agent 工装」一行同步。

### 2. 生成方向是单向的，且由 `agent_harness.py` 一个工具管

`check`（默认，只读，转红即为不同步）与 `apply`（显式写）。方向永远是
`.claude/skills/` → `.agents/skills/`，**没有反向同步** —— 反向存在的那一刻，
「哪份是源」就重新变成一个要靠人记住的问题。

### 3. 只管自己生成的东西，别人的一律不碰

生成的每个入口在清单 `.claude/agent-entries.json` 里登记：入口路径、来源、
渲染器版本、**规范源的内容摘要**。`apply` 之前逐个核对：

| 遇到 | 动作 |
| --- | --- |
| 入口不在清单里（别人的同名文件） | **不写**，报差异 |
| 入口在清单里但内容被手改过 | **不写**，报差异（手改是信息，不是障碍） |
| 目标是 symlink / junction，或解析后跑出 `.agents/skills/` | **不写**，报差异 |
| 源没了、入口还在 | 报为孤儿，`--prune` 才删 |

「不写并报差异」而不是「覆盖」——AGENTS.md 第 13 条：不静默覆盖用户文件。

### 4. 摘要按内容算，不按 mtime，且行尾归一

文本文件按 `\r\n` → `\n` 归一后再哈希，二进制原字节。理由是 ADR-0062：Windows
是权威环境而 Ubuntu 是受支持目标，**同样的内容在两个平台上必须得到同一个摘要**，
否则 CI 会为了行尾报一个假的「不同步」。

摘要覆盖 SKILL.md **以及**技能目录下实际参与运行的资产（`references/`、
`scripts/`），不是只哈希 SKILL.md —— 只哈希 SKILL.md 的话，改了 references 却
不改正文时 `check` 是绿的，而那恰恰是最容易漂的一种改动。

**不复用 `skill-evolution` 的 `_revision`**：它只哈希 SKILL.md，服务的是「技能
正文变了没有」这个别的问题。共用一个字段会让两边都说不清自己在保证什么。
它的格式与既有数据一字不动。

### 5. 零输入与坏输入必须非零退出

源集合为空、根目录无效 → 退出码非零。理由同切片 A：一个查错了地方的检查不会
报错，只会一路绿。

## 代价（已接受）

- **薄入口能不能被 Codex 真正加载，本 ADR 不能凭生成成功来断言。** 文件写出来
  只证明文件写出来了。真实加载证据要一次真实 Codex 会话；拿不到时如实记
  `NOT_EVIDENCED`，不改成 PASS。
- 多一个生成物就多一次「忘了 apply」的机会。对策是 `check` 挂在 `tests/tooling/`
  里，因而自动出现在提交闸门与合并前全量中 —— 不靠谁记得。

## 不做什么

- 不全局安装、不往用户目录写、不同步上游仓库的技能。
- 不改任何既有技能的正文与治理规则；本 ADR 只谈**发现入口**。
- 不新增第二套任务状态机、审查轮次或人工闸。

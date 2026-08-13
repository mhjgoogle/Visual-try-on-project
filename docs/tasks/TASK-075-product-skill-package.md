# TASK-075：Product Skill Package —— Skill 从源码常量变成可加载的产品资产

- 状态：**已解锁，可开工**
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：[ADR-0067](../adr/ADR-0067-product-skill-package.md)
- 前置：**已满足** —— TASK-072 批次一已提交（`70dab40`），运行链路与
  `taskType` 已稳定；`skill.episode-plan` 已与目录条目解耦（合同 §5.9b）
- 实施基线：`70dab40`
- 排期：**在 TASK-072 批次二之前**（产品负责人 2026-08-13 指定），单独审查、单独提交
- 后续：TASK-072 批次二 / 三

## 0. 本轮边界

**只做能力的定义、加载与编译。运行链路不动，IA 不动。**

不做：新页面、新导航、Skill 市场 / 远程安装、付费能力、自动化级别提升。

## 1. 交付

### 1.1 包格式与目录

```
product-skills/builtin/<skill-id>/
  manifest.json        skillId · skillVersion · taskName · work · scope
                       · inputs · optionalInputs · cost · produces
                       · recommendedRuntime · deprecated?
  prompt.md            指令正文
  output.schema.json   输出契约
```

三个来源，**加载优先级：项目 → 用户 → 内置**（ADR-0067 决策 2）：

| 来源 | 位置 |
| --- | --- |
| 项目 | `<ProjectRoot>/studio/skills/` |
| 用户 | `<应用数据根>/skills/`（与 `runs.json` / `projects.json` 同根，TASK-056） |
| 内置 | `<RepoRoot>/product-skills/builtin/` |

同 `skillId` **整体覆盖，不做字段级合并**。

### 1.2 `skillDigest` 与不可原地覆盖

- Run 记录 `skillId` · `skillVersion` · **`skillDigest`**（三文件内容的稳定散列，
  与平台、路径、文件顺序无关）。
- 加载时：某个 `(skillId, skillVersion)` 已被历史 Run 引用，而磁盘 digest 不同
  → **拒绝加载并指出冲突**（要求升版本号）。
- 守卫：改 `prompt.md` 而不升版本 → 加载失败且原因可读；升版本后两版并存，
  历史 Run 仍指向旧 digest。

### 1.3 迁移二十个既有定义

`src/workflow/skills.js` 的 `SKILLS` 数组逐个搬进 `product-skills/builtin/`。

- **逐字迁移**：`instruction` → `prompt.md`，`outputSchema` → `output.schema.json`，
  其余 → `manifest.json`。本轮**不改任何 Prompt 的措辞**，否则迁移与修订混在一起，
  出问题时分不清是搬错了还是改坏了。
- 守卫：迁移前后 `compilePrompt` 对同一 context 的输出**逐字节相同**。
- `prompt-director` 标 `deprecated: true`（ADR-0067 决策 5）：仍可加载、仍可被历史
  Run 指向、**不出现在任何能力列表里**。

### 1.4 `skills.js` 降为加载器与兼容层

保留公开函数（`findSkill` / `missingInputs` / `compilePrompt` / `SKILL_INPUTS` /
`isShotScoped` / `readSkillAnswer` / `validateOutput`），改为从加载结果读取。
**调用点不改**——这是本轮能安全做的前提。

### 1.5 新增 `episode-planner`

`skill.episode-plan` 的目录条目。输出契约即 `_parse_episode_plan` 今天强制的形状
（`{ episodes: [{ epNumber, title, synopsis, purpose, hook, endingBeat, duration }] }`）。
**taskType 不变**（合同 §5.9b 已为此解耦）。

### 1.6 五个旧端点共用同一套定义与编译器

`/api/agent/{story-develop, episode-plan, script-draft, shots-draft, bible-breakdown}`
不再自带 Prompt 与解析器，改为读同一批 Skill 包。

- Python 侧需要一个**最小加载器**（读同一组文件、同一套校验），与前端加载器
  共用同一份包格式与同一份 `output.schema.json`。
- **响应契约不变**（TASK-072 §1.3b 的兼容层继续有效）。
- 守卫：同一输入下，端点产出的 Prompt 与前端 `compilePrompt` 的输出一致。

### 1.7 fail-closed

manifest / schema 不合法、digest 冲突、缺文件 → 该 Skill **不可用并说明原因**；
**不部分加载**，**不回退到低优先级的同名 Skill**（ADR-0067 决策 7）。

### 1.8 权限边界

Skill 只产生 Proposal。守卫测试断言：`skillapply` 的动作词汇表里没有定稿 / 锁定 /
付费 / 导出；Skill Run 的 `kind` 恒为 `skill`。

## 2. 依赖

```
ADR-0067 Accepted
   ↓
1.1 包格式与加载优先级 ──→ 1.2 digest 与不可覆盖
   ↓
1.3 迁移二十个定义 ──→ 1.4 skills.js 降级
   ↓
1.5 episode-planner ──→ 1.6 五个端点共用
1.7 fail-closed / 1.8 权限边界（贯穿）
```

## 3. 验收标准

| # | 标准 | 验证 |
| --- | --- | --- |
| 1 | 迁移前后 `compilePrompt` 逐字节相同 | 二十个 Skill × 固定 context 的快照测试 |
| 2 | 项目 → 用户 → 内置 优先级正确，且整体覆盖 | 三来源同名 Skill 的加载测试 |
| 3 | 改内容不升版本 → 拒绝加载并指出冲突 | digest 冲突守卫 |
| 4 | 历史 Run 仍能指向旧 `(skillId, skillVersion, skillDigest)` | 升版本后的并存测试 |
| 5 | 任一文件不合法 → 该 Skill 不可用且原因可读，**不部分加载** | 逐类损坏的 fail-closed 测试 |
| 6 | 高优先级来源损坏时**不回退**到低优先级同名 Skill | 定向测试 |
| 7 | 五个端点与前端产出同一份 Prompt | 同输入比对测试 |
| 8 | `episode-planner` 可用且 `taskType` 仍是 `skill.episode-plan` | 端点测试 |
| 9 | `prompt-director` 可加载但不出现在能力列表 | 列表快照 |
| 10 | Skill 无法定稿 / 锁定 / 付费 / 导出 | 动作词汇表守卫 |
| 11 | 无页面 / 导航变更 | `NAV` / `EPISODE_NAV` / `ASSET_NAV` 快照不变 |

**风险等级：高**（新增加载路径 + 迁移 + 溯源身份）→ AGENTS.md 第 20 条：
**全量 pytest + 全量前端 + ruff + Codex 独立审查**。

## 4. 已知风险

1. **迁移与修订必须分开。** 本轮逐字搬运；任何措辞改动另起一次修订。
2. **用户 / 项目 Prompt 是用户撰写的文本**，会被内联进发给执行器的提示词 ——
   与今天内联剧本文本同一个注入面。安全姿态不变（工具全关、中立 cwd、无路径跨界），
   **不因为「这是本地文件」而放松**。
3. **两个加载器（JS 与 Python）必须读同一份格式**。它们各自实现，但共用包格式与
   `output.schema.json`；守卫测试比对两者对同一输入的产出，防止第二次分叉。

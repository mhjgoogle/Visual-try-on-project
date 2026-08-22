# Requirement Record 与 Change Record

## Requirement Record（`docs/requirements/REQ-*.md`）

一个需求一个文件，命名 `REQ-NNN-short-slug.md`，编号取
`docs/requirements/` 下现有最大号 +1。索引在 `docs/requirements/README.md`
（一行一条，Agent 建 REQ 时同步加行）。

记录**为什么要做、用户真正要什么**。实现方案不写这里（写任务卡/ADR）。
只有产品需求建 REQ：Bug / Refactor / Perf 默认不建（见 SKILL.md 第 3 步）。

```markdown
# REQ-001：<一句话标题>

- 状态：CONFIRMED            # 整体状态 = 最新版本的状态
- 相关 Change：TASK-0XX · <commit>   # Agent 随实施追加

## v1 — CONFIRMED（2026-08-22）

- 来源：产品负责人 2026-08-22 —— 「<原话>」
- 用户真正需要什么：<一两句>
- 为什么：<一两句>
- 验收判据（产品视角，非测试清单）：<一两条>
```

### 状态机

- `DRAFT` —— Agent 从探索/证据中**推断**的需求。转 CONFIRMED 的路径是
  **做出来给用户看**（CLAUDE.md 决策模式），不是中途提问。
- `CONFIRMED` —— 用户明确提出（原话即确认），或看到可运行结果后认可。
- `SUPERSEDED` —— 被同文件更高版本或另一 REQ 取代（写明被谁取代）。

### 版本修订（真实使用后需求变化）

**不篡改已 CONFIRMED 的旧版本。** 同文件追加：

```markdown
## v2 — CONFIRMED（YYYY-MM-DD）· supersedes v1

- 来源：<原话/依据>
- 相对 v1 的 delta：<只写变化，不重抄全文>
```

后续实施只处理 **v1→v2 delta**，不从头重做整个功能。
v1 标题行就地补 `（superseded by v2）`，内容一字不动。

### 与存量机制的关系

存量需求已由 `docs/product_spec.md`、两份顶层需求文档、任务卡「依据」行
承载——**不回填成 REQ**。改到某条存量需求时，才为它建 REQ 并在 v1 里
指回原始出处；从那一刻起该需求的演化以 REQ 文件为准。

## Change Record

**一个任务一个，Agent 自动创建自动维护，用户不填。**

- **QUICK 深度**：提交信息即记录。首行写意图，正文写关联
  （`REQ-NNN`/`TASK-NNN`，如有）、做了什么验证。不建卡。
- **STANDARD / DEEP 深度**：任务卡 `docs/tasks/TASK-NNN-slug.md`
  （编号顺延现有最大号），沿用本仓库既有卡风格，最小字段集：

```markdown
# TASK-NNN：<标题>

- 状态：未开工 | 进行中 | 完成 | 中止
- Workflow：Feature | Bug | Refactor | Perf | Migration · 深度：STANDARD | DEEP
- 关联 Requirement：REQ-NNN（可多条；存量需求写「依据」行原话）
- 目标：<一两句>

## IN SCOPE / OUT OF SCOPE
## Impact Analysis        # 受影响模块 / API·合同 / 数据 / 依赖 / 测试 / 文档
## 架构影响               # 无，或触发了 architecture.md 哪条 + 结论/ADR 链接
## 实施摘要               # 完成时补：改了什么，在哪
## 验证                   # 实际跑了什么（命令+结果），审查轮次与结论
## Follow-up              # 未解决项；跨任务的挪 TASK-087 总账
```

卡保持轻量——上面每节几行即可，不写几十页。

## 追溯链

`REQ-NNN → TASK-NNN（或提交信息）→ 代码 → 测试 → 验证记录`。
双向：REQ 里追加「相关 Change」，卡里写「关联 Requirement」，
提交信息里引用两者之一。

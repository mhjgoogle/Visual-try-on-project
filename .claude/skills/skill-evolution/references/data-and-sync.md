# 数据模型与 Registry 同步（需要时才读）

数据都在 `docs/skill-evolution/`（放 docs/ 的理由见 ADR-0078 决策 2：
仓库先例 + commit gate 把 docs/ 归 lint 档，feedback 追加不背全量测试）。

## Global Index —— `index.json`

只是快速定位表，不是 feedback 数据库。每个 Skill 一个条目：

| 字段 | 含义 |
| --- | --- |
| `path` / `backlog` | 仓库相对路径（POSIX 斜杠） |
| `registered_at` / `last_seen_at` / `last_feedback_at` / `last_review_at` | 时间戳（UTC） |
| `revision` | SKILL.md 内容 sha256 前 12 位（register/status/sync 时刷新） |
| `feedback_seq` | 反馈 id 计数器（compact 后 id 不回卷） |
| `open` / `severe_open` | 开放条目数 / 其中 severe 数 |
| `repeated` | 开放 key → 计数（只列 >=2；POSITIVE_SIGNAL 不计入） |
| `pending_proposals` | PROPOSED/APPROVED 条目引用的 EP 编号 |
| `protected` | Protected Behavior 列表 `{key, note, since}` |
| `status` | 派生：REGISTERED / OBSERVING / REVIEW_CANDIDATE / PROPOSAL_PENDING / HEALTHY；MISSING 由 sync 显式设置 |
| `previous_names` / `missing_since` / `archived` | rename 史 / 失踪时间 / 已归档条数 |

派生字段每次写入都从 backlog 重算，不会漂移；禁止为读 index 顺便读 backlog。

## Per-Skill Backlog —— `backlogs/<skill>.jsonl`

一行一条：`id, ts, category, severity, key, note, status[, task, proposal]`。
条目状态机：`OBSERVING → CANDIDATE → PROPOSED → APPROVED → RESOLVED`，
任何点可 `REJECTED`；`ARCHIVED` 只由人为标记。终态（RESOLVED / REJECTED /
ARCHIVED）不参与阈值计数，`compact` 把它们移进 `archive/<skill>.jsonl`。

### recurrence key

- kebab-case 短语，描述**根因**不是表象（例：`excessive-user-escalation`，
  而不是 `asked-me-about-tests`）。
- 复用判据：语义上明显同一根问题才共用；模糊相似 → 开新 key（保守归组，
  错误合并比错误拆分更难回滚——合并会提前触发 Review）。
- 阈值：同 key 开放条目 >= 3 → review_due；severe 单条即 due。
- POSITIVE_SIGNAL 也带 key；同一 key 多次出现后用
  `protect <skill> --key K --note "…"` 升级为 Protected Behavior。

## Lazy Auto-Registration

`record` 对未注册 Skill 自动执行 `register`：只取 skill_id（目录名）、path、
revision、时间戳，建空 backlog + index 条目。**不读 references、不做质量
审查、不扫描其他 Skill。** 深度分析只在达到阈值后发生。

## Manual Full Sync（`sync`，仅用户显式要求）

1. 扫描 Skill roots（当前 `.claude/skills/`）找合法 `SKILL.md`；
2. 未注册 → 注册；已注册 → 刷新 last_seen / revision / 派生字段；
3. index 有、盘上无 → 先用 revision 摘要在新目录里找同内容者：
   命中 = rename/move → 迁移条目 + backlog/archive 文件名，记
   `previous_names`，**不造两份历史**；未命中 → 标 `MISSING`（保留全部
   backlog / archive，绝不删）；下次 sync 若路径复活自动清除 MISSING。
4. 不读 references、不做 Review、不生成反馈——registry 同步 ≠ 质量审计。

局限（v0.1 已知）：rename 检测靠「上次记录的 revision == 新位置当前摘要」，
先改内容再改名的一次 sync 会退化成 MISSING + 新注册；此时人工用 git log
确认后手改 index（把新条目并回旧条目）即可，历史仍在 git 里。

## 平台与安全

脚本只用 pathlib / UTF-8 / `os.replace`（先写 tmp 再原子替换），路径存
POSIX 斜杠，Windows/Ubuntu 行为一致；出错 fail-closed（非零退出 + error
字段），绝不静默删数据——MISSING/ARCHIVED 都是软删除。

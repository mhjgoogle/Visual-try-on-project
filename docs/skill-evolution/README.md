# Skill Evolution 数据（TASK-100 / ADR-0078）

`skill-evolution` Skill（`.claude/skills/skill-evolution/`）维护的运行数据。
**Agent 自动维护，用户不填**；人只在两处出现：对每条反馈草稿的轻量确认
（默认 ACCEPT），和对 Evolution Proposal 的批准/否决。

| 内容 | 位置 |
| --- | --- |
| 全局轻量索引（哪个 Skill 健康/在观察/该复审） | `index.json` |
| 每 Skill 反馈 backlog（一行一条 JSONL） | `backlogs/<skill>.jsonl` |
| 压缩归档（终态条目；正常使用不加载） | `archive/<skill>.jsonl` |
| Evolution Proposal（改 Skill 前的提案，待批准） | `proposals/EP-NNN-slug.md` |

放在 `docs/` 而不是 `.claude/`：与待复审清单、follow-up 总账同一先例
（agent 维护的持久运营记录进 docs/，AGENTS.md 第 18 条），同时 commit gate
把 `docs/` 归 lint 档——高频的反馈追加提交不触发全量测试（ADR-0078 决策 2）。

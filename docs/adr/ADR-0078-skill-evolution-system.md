# ADR-0078：skill-evolution —— 证据驱动、受控、低 Token 的 Skill 演化系统

- 状态：Accepted（依 CLAUDE.md「ADR 的 Accept 权」由实施 Agent 接受；
  不涉付费、不涉不可逆动用户数据。核心行为变更的批准权本 ADR 本身就交还
  给用户——见决策 6）
- 日期：2026-08-22
- 决策者：实施 Agent（需求方：产品负责人 2026-08-22 完整指令，TASK-100）

## 背景

Skill 数量在增长（dev-workflow、codex-review-loop、未来更多）。Skill 会过时、
起摩擦、缺能力、越写越长；人工定期全量检查太贵，每次使用后全量读取更贵。
需要一个闭环：真实使用 → 极短反馈 → 证据累积 → 达阈值才复审 → 提案 →
批准 → 修改 → 验证，且 Token 成本不随 Skill 数量线性爆炸。

## 决策

1. **单一归属**：演化逻辑只住在 `.claude/skills/skill-evolution/`。其他 Skill
   不复制 feedback/threshold/index 逻辑，只在任务收口时调用统一入口
   （dev-workflow 第 10 步一行挂接；其余 Skill 不改）。

2. **数据放 `docs/skill-evolution/`，不放 `.claude/`**：
   `index.json`（全局轻量索引）+ `backlogs/<skill>.jsonl`（每 Skill 独立
   backlog）+ `archive/<skill>.jsonl`（压缩归档）+ `proposals/EP-NNN-*.md`。
   理由一：仓库先例——agent 维护的运营记录（待复审清单、follow-up 总账）
   都在 `docs/`，且 AGENTS.md 第 18 条要求持久记录进 `docs/`。
   理由二：gate 经济学——commit gate 把 `docs/` 整个前缀归 lint 档，而
   `.claude/` 下非 `.md` 文件 fail-closed 触发全量 pytest（约 3 分钟）；
   feedback 是高频小追加，放 `.claude/` 会让每条反馈背一次全量测试，
   直接违反「低 Token/低成本」这条最高优先级。

3. **确定性操作用一个 Python CLI**（`scripts/evolution.py`），不做 ps1+sh
   双实现。ADR-0062 决策 3 要求双 shell 行为一致，其风险正是两份实现漂移；
   单一 Python 脚本从构造上零漂移，两个 shell 以同一条命令调用
   （`python .claude/skills/skill-evolution/scripts/evolution.py …`），Python
   也是本仓库主语言。语义判断（反馈措辞、recurrence 语义归组、severe 判定、
   提案内容）留给模型；registry/计数/状态机/同步是脚本。

4. **触发点适配本仓库**：需求原文写「push 成功后」，但本仓库 push 由用户
   显式触发、日常交付点是 commit（AGENTS.md 第 22 条）。因此 Post-Use
   Feedback 的触发点 = 「任务完成且提交成功之后」；发生 push 的场合同样适用。
   不建 daemon/watcher/定时器。

5. **身份与版本**：skill_id = Skill 目录名；revision = SKILL.md 内容
   sha256 前 12 位。Full Sync 时用 revision 摘要匹配识别 rename/move
   （摘要相同 → 同一 Skill 换了路径：迁移 index 条目与 backlog 文件名，
   记 `previous_names`，不制造两份历史）；找不到又匹配不上 → 标 `MISSING`，
   历史数据一律保留。深度版本史交给 git，不自建 version framework。

6. **权限边界**：Evolution Review 达阈值（同一 recurrence key 开放条目
   >= 3，或单次 severe）才做，且只读目标 Skill + 目标问题的上下文。Review
   产出 Proposal 文件——写 Proposal 不需要批准；**应用**到其他 Skill 的核心
   行为（workflow、trigger、description、默认行为、输出格式、escalation、
   删能力、安全边界、工具使用逻辑）必须先获用户批准。问法按 CLAUDE.md：
   「打算按 EP-NNN 改 X，因为证据 Y，回归风险 Z——要拦吗？」低风险修
   （断链/错路径/重复措辞）同样过 Proposal，走轻量批准。这是需求方 2026-08-22
   的显式要求，是 CLAUDE.md「技术决策不问」的一个**有意例外**：Skill 行为
   是用户直接依赖的工作方式，不是纯实现细节。

7. **反膨胀是复审的必答项**：每次 Evolution Review 必须先考虑删除/合并/
   下沉到 reference，Proposal 里写明净增减；SKILL_BLOAT 是一等 category。
   Protected Behavior（多次 POSITIVE_SIGNAL 后显式 protect）记录在 index
   条目里，动它的 Proposal 必须标高回归风险并要求更严验证。

## 后果

- 每次任务收口的额外成本 ≈ 2 次脚本调用 + 一条 50–150 字反馈 + 用户一次
  轻量确认（默认记下并展示，用户可否决/修改——与决策模式一致，不堵路）。
- 正常使用永不全量扫描；Full Sync 只在用户显式要求时做 registry 同步，
  不做质量审计。
- 未被使用过的新 Skill 在第一次真实使用时自动注册（懒注册），或被
  Full Sync 纳管；注册只取最小 metadata，不读 references。
- v0.2+ 留白：定时任务、telemetry、eval 集成、跨 Skill 重构（TASK-100 卡
  OUT OF SCOPE 节）。

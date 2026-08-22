---
name: skill-evolution
description: >-
  Controlled Skill Evolution — collect ultra-short evidence after real skill
  usage, accumulate it per skill, and evolve skills only on repeated evidence
  or a severe defect, with human approval. INVOKE in exactly three cases:
  (1) Post-Use Feedback — a development task that used any skill has just
  completed and its work is committed (or pushed): capture one 50–150 char
  feedback via two cheap script calls; (2) the user says "Sync Skills" /
  「同步 skills」: run the manual full registry sync; (3) a record call
  returned review_due=true and the current task is closed: run the Evolution
  Review and write a proposal. DO NOT invoke: mid-task, per message, to audit
  or rewrite all skills, to scan every skill, or to change another skill's
  core behavior without an approved proposal.
---

# skill-evolution — 受控 Skill 演化（v0.1）

不是「每次使用就重写 Skill」，而是：每次使用 → 极短反馈；证据重复（同 key
>= 3）或单次 severe → Evolution Review → Proposal → **用户批准** → 修改 →
定向验证。优先级：低 Token > 安全 > 基于证据 > 可追溯 > 演进 > 自动化。
机制决策见 ADR-0078；数据在 `docs/skill-evolution/`（index.json +
backlogs/*.jsonl，git 即版本史）。

所有确定性操作走一个脚本（双 shell 同一条命令，输出单行 JSON）：

```
python .claude/skills/skill-evolution/scripts/evolution.py <cmd> …
```

## Fast Loop — Post-Use Feedback（任务提交后，每次）

**成本上限：2 次脚本调用 + 一条 50–150 字反馈。不读任何 Skill 全文。**

1. 确定本任务真正使用过的 Skill（通常是 dev-workflow / codex-review-loop）。
2. `status <skill>` —— 一次调用回答：注册了吗、已有哪些 recurrence key、
   是否已到复审点。未注册也**不要手动 register**：第 4 步的 record 会懒注册
   （新 Skill 第一次真实使用即自动纳管，不扫描其他 Skill）。
3. 从执行结果起草反馈（不问用户）：WHAT WORKED / FRICTION / MISSING
   CAPABILITY / 值不值得进 backlog。四者多数时候只有一条值得记；**没有真
   信号就记一条 POSITIVE_SIGNAL 或什么都不记**，禁止凑数。
   - category：FRICTION · MISSING_CAPABILITY · INCORRECT_BEHAVIOR ·
     TOKEN_WASTE · WORKFLOW_GAP · OUTPUT_QUALITY · REGRESSION ·
     POSITIVE_SIGNAL · SKILL_BLOAT · OTHER
   - severity：low / medium / high / severe（severe 判据见 references）
   - key：**先复用** `status` 返回的既有 key；语义上明显同一根因才共用
     （Conservative Semantic Grouping），拿不准就开新 key（kebab-case）。
4. `record <skill> --category X --severity Y --key K --note "…" --task TASK-NNN`
5. 在收口消息里给用户看这一行草稿（默认已记录 = ACCEPT）：
   「已记 Skill 反馈：<一句话>。回 EDIT/IGNORE 可改或撤。」**不追问、不阻塞。**
   用户要求撤 → `set-status --ids <id> --status REJECTED`。
6. record 返回 `review_due: true` → **本任务内不展开分析**，只在收口消息加一句
   「<skill> 已达复审条件（<reasons>），下次空闲可做 Evolution Review」。

禁止：长复盘、execution transcript、每次使用改 Skill、把 Fast/Slow 混跑。

## Slow Loop — Evolution Review（只在 review_due 后）

流程、Proposal 模板、Protected Behavior、批准边界、修改后验证、收敛检查
→ 读 [references/review-and-proposal.md](references/review-and-proposal.md)。
硬规则先记住三条：

- 只读**目标 Skill + 目标问题**：入口是 `review-context <skill> --key K`，
  不加载整个 backlog / archive / 其他 Skill。
- Review 产出 Proposal 文件（`docs/skill-evolution/proposals/EP-NNN-slug.md`）
  ——写提案不需要批准；**应用**改动到别的 Skill 的核心行为必须先获用户批准
  （veto 式问法：「打算按 EP-NNN 改 X，证据 Y，风险 Z——要拦吗？」）。
  低风险修（断链/错路径/重复措辞）同样过 Proposal + 轻量批准。
- 每次 Review 必答收敛项：能否删/合并/下沉规则？Skill 要变好，不是变长。

## Sync Skills — 手动全量同步（仅用户显式要求）

`sync` 一条命令：扫 Skill roots → 注册缺失 → 摘要匹配识别 rename（迁移
条目与 backlog，不造两份历史）→ 找不到的标 MISSING（**保留全部历史**）。
它是 registry 同步，不是质量审计：不读 references、不做 Review、不生成反馈。

## Token 纪律（硬约束）

- 正常使用**永不**：扫描全部 Skill、读全部 SKILL.md/references/backlog、
  做全局相似度或全局 Review。
- 渐进加载顺序：当前 Skill 身份 → `status` → 需要时 `review-context` →
  只有 Review 需要时才读该 Skill 文件 → 只有改动需要时才读对应 reference。
- backlog 变大（open + 终态 > ~40 条）→ `compact <skill>`（终态入 archive，
  正常使用不加载 archive）。
- 数据模型、状态机、rename/missing 细节：
  [references/data-and-sync.md](references/data-and-sync.md)（需要时才读）。

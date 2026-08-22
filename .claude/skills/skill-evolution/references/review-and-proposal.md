# Evolution Review 与 Proposal（Slow Loop 细则）

只在两种证据下进入：同一 recurrence key 开放条目 >= 3，或单次 severe。
普通单次问题只记录，不改 Skill。

## Severe Defect 判据（单次即可触发 Review）

Skill 给出明显错误 workflow / 导致危险或高风险错误操作 / 核心规则互相冲突 /
无法执行自己的核心职责 / trigger 明显错误 / 导致大量错误修改 / 破坏用户明确
依赖的行为 / 输出与声明用途严重不一致。
**警惕 Self-Reinforcing Mistakes**：如果错误判断是 Agent 自己做的而不是
Skill 规则导致的，severity 不该是 severe，反馈也应写明「疑似 Agent 误判」。

## Review 步骤

1. `review-context <skill> --key K` —— 只拿目标问题 + severe 的开放条目
   与 protected 清单。**不读整个 backlog，不读 archive，不读其他 Skill。**
2. 读目标 Skill 的 SKILL.md（此刻才读）；只有嫌疑落在某个 reference/script
   时才读那一个文件。
3. 回答十个问题：问题真的重复吗？是 Skill 的问题还是任务特例/Agent 误判？
   哪条现有规则导致？规则之间冲突吗？是结构问题吗？有没有更小的修法？
   改了会破坏什么？影响 Protected Behavior 吗？该改 SKILL.md / reference /
   script / metadata / tests，还是**什么都不改**？
4. **收敛必答**（Minimum Necessary Evolution + 反膨胀）：能否删除重复规则、
   合并相似规则、删过时 guidance、把条件性规则下沉到 reference、缩短
   SKILL.md？Proposal 里写明预计**净增减行数**。SKILL_BLOAT 类反馈达阈值时，
   Review 以收敛为主目标——merge / delete / move-to-reference 优先于 append。
5. 结论是「任务特例/证据不足/什么都不改」也是合法产出：把相关条目
   `set-status --key K --status REJECTED` 并在收口消息一句话说明。

## Proposal（`docs/skill-evolution/proposals/EP-NNN-slug.md`）

编号取 proposals/ 下现有最大号 +1。必须简洁（一屏内），字段：

```markdown
# EP-NNN：<一句话>

- Skill：<name> @ <revision> · 证据：fb-…, fb-…（key，count）
- Problem / Root Cause Hypothesis：<两三句>
- Proposed Change：<最小修改；写明净增减>
- Expected Benefit / 为什么现在值得改：<必须指向真实使用证据；
  「更优雅/更先进/我觉得更好」不是理由>
- Regression Risk：<低/中/高 + 一句为什么>
- Protected Behavior Impact：<无，或列出触碰的 protected key —— 有则
  regression risk 至少「高」，验证必须覆盖该行为>
- Files Likely Affected：<清单>
- Validation Plan：<重放哪个 scenario、跑哪些定向测试>
- 状态：PENDING → APPROVED / VETOED（记用户答复日期）
```

写完 Proposal：`set-status <skill> --key K --status PROPOSED --proposal EP-NNN`
（index 自动进入 PROPOSAL_PENDING）。

## 批准边界（ADR-0078 决策 6）

改另一个 Skill 的核心 workflow、trigger、description、默认行为、用户依赖的
输出格式、escalation policy、删除能力、安全边界、主要工具逻辑 → **必须先获
用户批准**。问法是 veto 式一句话，不是选择题。低风险修（断内链、错路径、
重复措辞、明显过时注记、轻微结构清理）同样过 Proposal，但可以和其他收口
消息合并做轻量批准；**Low Risk ≠ No Validation**。

## 批准后：修改 + 验证

1. 修改按 dev-workflow 正常执行（深度通常 QUICK：提交信息即记录，引用
   EP-NNN；动 script 则跑其测试）。
2. 验证（Target Skill + Affected Behavior，不跑全生态）：
   - 重放导致 Evolution 的典型 scenario（口头重放或最小实操）；
   - 确认原问题的规则已消除/修正；
   - 逐条核对 protected key 的行为仍成立；
   - Skill 结构仍合法（frontmatter 完整、内链有效）；
   - 涉及 evolution.py 时跑 `tests/tooling/test_skill_evolution_tooling.py`。
3. 收口：`set-status <skill> --key K --status RESOLVED`；在 EP 文件补
   validation result 与日期。revision 由下次 status/sync 自动更新；
   变更历史 = git log（不自建 version framework）。
4. 用户否决 → `--status REJECTED`，EP 标 VETOED，原文保留。

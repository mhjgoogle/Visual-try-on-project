# 待补 codex 复审清单（降级审查模式的债务）

- 依据：[ADR-0068 补记](../adr/ADR-0068-continuous-modification-chain.md#补记降级审查模式2026-08-13--2026-08-18)
- 起因：codex 触到 workspace spend cap，2026-08-18 之前不可用；`claude` CLI 未安装
- 规则：**本清单清空之前，不得 push / merge / 交接 / 宣告最终验收**

## 怎么用

每一个在降级模式下通过的中/高风险检查点，在这里加一行。补完 codex 复审后
划掉该行并注明复审提交，**不要删除行** —— 删掉就看不出这段时间发生过什么。

## 待复审

| 提交 | 内容 | 风险 | 降级模式下的审查者 | 状态 |
| --- | --- | --- | --- | --- |
| `70dab40` | TASK-072 批次一（Run 注册表 / 八态 / v15 迁移 / 五端点收口） | 高 | codex 23 轮**已审**；仅**第 23 轮的 3 个修复**未复审（第 24 轮撞上 spend cap） | **待 codex 复审**（范围：那 3 处） |
| TASK-075 批次 B1 / B2（`git log --grep "TASK-075"`） | 数据围栏 + `episode-planner` + `script-reviser` + 五个端点改跑 Skill 包 + `/api/skills` | 高（改的是五个在用端点真实问模型的问题） | 独立 Claude Opus 会话：B1 3 轮、B2 3 轮（同模型族，**无跨模型独立性**）；**B2 第三轮仍 fail**，两项已修、七项登记为债务 | **待 codex 复审**（范围：全批次 + 卡内七项债务） |
| TASK-075 批次 A（`git log --grep "TASK-075"`） | Skill 包格式 + 二十个定义逐字迁移 + 后端加载器（digest / 优先级 / fail-closed / JS 编译器镜像） | 高（新增加载路径 + 迁移 + 溯源身份） | 独立 Claude Opus 会话 3 轮，第 2、3 轮 pass（同模型族，**无跨模型独立性**） | **待 codex 复审**（范围：全批次） |
| 未提交（工作树） | TASK-075 §1.4（`skills.js` 降为消费方 + `/api/skills` 补送共享表 + `script-reviser` v2）、TASK-072 批次二**部分**（`apiclient.js` + 24/30 调用点）、TASK-072 批次三**部分**（§1.7 六态派生视图 + §1.9 十条缺陷中的六条，含 blocking 的 #1 与 #8） | 高 | **无审查者**：产品负责人 2026-08-14 明确要求去掉测试与审查环节以换取进度 | **待 codex 复审**（范围：三批全部改动；**尤其** #8 的候选集围栏与 #1 的写前校验——两者都改的是安全边界，且都没有跨模型独立审查） |
| `c1edb00` (TASK-076) | 连续修改链在 commit gate 上真实生效：令牌改从命令文本读取、`continuous-chain` 层级、两 shell 不再各自匹配 | 中～高（改的是质量门本身） | 独立 Claude Opus 会话 5 轮，第 5 轮 pass（同模型族，**无跨模型独立性**） | **待 codex 复审**（范围：全卡） |
| `a187cc8` + 后续文档提交（ADR-0069 / 交付流程恢复） | 审查轮次预算、P2 不再触发再审、审查不阻塞提交、分级取最高档、决策自主权、WIP=1；**改的是质量门规则本身** | 高 | codex 2 轮（round 1/2，跨模型独立）+ claude fallback 1 轮（round 3，同模型族）。5 个 blocking 全部已修，但 **round 3 的 P1 修复（`CLAUDE.md:94` 矛盾消除）未复审**——预算 3 轮耗尽且 codex 再次不可用，按 ADR-0069 决策 d 选 escalate | **待 codex 复审**（范围：**只需** round 3 的那一处 P1 修复 + 4 处 P2 修复；前两轮的修复已由 codex 复审过） |
| 未提交（工作树，见[待提交记录](pending-speedup-and-gate-fix.md)） | pytest 两阶段并行（`pyproject.toml` / `gate.ps1` / `gate.sh` / `ci.yml`）+ commit gate 两处分类缺陷（`_DOC_FILES` 漏 CLAUDE.md、`_normalise` 的 `lstrip` 吃掉 `.claude/` 与 `../`） | 高（改的是质量门与路径规范化） | **无独立审查**：codex spend cap，round 3 时只剩同模型 fallback | **待 codex 复审**（范围：全批；**尤其** `_normalise` 的路径穿越语义变化） |

## 已补完

（暂无）

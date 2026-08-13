# TASK-068：把旧 `/api/agent/*` 创作端点收进 Runtime 层

- 状态：**规划中，未开工**（等 ADR-0065 Accepted）
- 负责 Agent：待定（单一实施 Agent）
- 前置：[TASK-067](TASK-067-ai-director-operationalization.md) 已实施完成
- 依据：[ADR-0065](../adr/ADR-0065-every-ai-action-through-the-runtime-layer.md)
- 产品要求（2026-08-13）：
  1. 「这个项目所有需要 AI 来调整的背后都是要用现在这个订阅账号来完成的」
  2. 「不单单要接 Claude Code，还要接 Codex。Claude Code 主要是执行，Codex 要做审阅
     然后给出意见」

## 0. 为什么立这张卡

2026-08-13 产品在「故事开发 → AI 发展故事」上撞到 `claude CLI not found`。诊断结果是
**两条路径**：

- 这个按钮走 `/api/agent/story-develop`，**写死 spawn `claude`**，没有任何手工兜底；
- 同一个能力 `story-development` 在 Skill 目录里，Runtime 层给它 claude-code /
  codex-cli / manual 三条路。

于是同一件事，从一个入口点做不了、从另一个入口点做得了。这正是本仓库反复付出代价的重复。

**TASK-067 已经解决的部分**（不在本卡范围）：`run-windows.ps1` 现在会在启动后端前把订阅
CLI 放上 PATH（找不到就如实报并给安装命令），并用 `-AllowCodexReview` 显式开启 codex；
`skills.work` / `EXECUTORS[].suits` / `suggestExecutor` 已经实现「Claude Code 执行 /
Codex 审阅」的默认分工。**装上 CLI 之后旧端点也能工作了** —— 但它们仍然没有手工兜底、
没有 Skill Run、没有 provenance。

## 1. 范围

### 改造（5 个）

| 旧端点 | 目标能力 | 前端调用点 |
| --- | --- | --- |
| `/api/agent/story-develop` | `story-development` | `ctx.story.develop("outline", …)` |
| `/api/agent/episode-plan` | `story-development`（plan 分支）或新增能力 | `ctx.story.develop("plan", …)` |
| `/api/agent/script-draft` | `script-writer` | `ctx.script.generate(…)` |
| `/api/agent/shots-draft` | `storyboard-director` | `ctx.shots.generateDraft()` |
| `/api/agent/bible-breakdown` | `script-breakdown` | `ctx.breakdown.run()` |

### 不动

`render-episode` / `mix-shot` / `compose`（ffmpeg/piper，不是 AI）；
`tts` / `image-gen` / `adopt-paid`（付费 Provider 边界，各自 ADR 管辖）。

## 2. 交付清单（待实施）

- [ ] 五个端点改为经 Runtime 层解析执行器（或前端直接改走 `ctx.skills.run`，二选一，
      在实施前定）
- [ ] 每个动作都获得 **手工兜底**：执行器缺席时仍可复制 Prompt → 外部跑 → 粘回
- [ ] 每个动作都产生 **Skill Run + Proposal + provenance**（今天「AI 生成的剧本 v3」
      在溯源图上没有任何运行记录可指）
- [ ] 响应形状变更的迁移：五个端点各有各的解析器，统一到 outputSchema 之后前端解析要跟着改
- [ ] 「AI 发展故事」等按钮在执行器不可用时**显示可用的替代路线**，而不是死路
- [ ] 守卫测试 + 真实项目「夜班沉默」Connected 验收
- [ ] codex 独立审查

## 3. 已知风险

1. **这是真实的行为变更**，不是重构：五个端点的响应形状会变，四个前端控制器要跟着改。
   必须有守卫测试，不能顺手改。
2. `episode-plan` 在 Skill 目录里**没有精确对应的能力** —— 要么给 `story-development`
   加 plan 分支（它的 outputSchema 已含 `episodeCount`），要么新增一个能力。这是一个
   设计决定，实施前定。
3. 旧端点**并存还是删除**：ADR-0065 倾向直接改造而不并存，因为并存正是要消除的东西。
   但那会让任何仍指向旧端点的调用方立刻失败，需要先确认没有遗漏的调用方。

## 4. 明确不做

付费 Provider 边界、自动化级别（`CURRENT_LEVEL` 保持 `suggest`）、把能力绑定到某个
执行器（ADR-0056 决策 1 不变：分工是建议，创作者的选择永远优先）。
